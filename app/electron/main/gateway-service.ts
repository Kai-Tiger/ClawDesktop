import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { createPublicKey, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import type { GatewayStatus, WsInstance, WorkerMeta } from './types';
import type { OpenClawPaths } from './paths';

export class GatewayService {
  private gatewayProcess: ChildProcess | null = null;
  private wsClient: WsInstance | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wsProgressDedupe = new Map<string, { text: string; ts: number }>();
  private readonly workerEventListeners: Array<(event: { workerId: string; content: string; role: string }) => void> = [];

  constructor(
    private readonly paths: OpenClawPaths,
    private readonly listWorkers: () => WorkerMeta[]
  ) {}

  addWorkerEventListener(cb: (event: { workerId: string; content: string; role: string }) => void) {
    this.workerEventListeners.push(cb);
  }

  get gatewayPort() {
    return this.paths.gatewayPort;
  }

  get isRunning() {
    return this.gatewayProcess !== null;
  }

  async statusJson(): Promise<GatewayStatus> {
    if (this.gatewayProcess !== null) {
      const processAlive = this.gatewayProcess.exitCode === null;
      let httpOk = false;
      if (processAlive) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 1500);
          await fetch(`http://127.0.0.1:${this.paths.gatewayPort}/v1/models`, { signal: controller.signal });
          clearTimeout(t);
          httpOk = true;
        } catch { /* port not bound yet */ }
      }

      const running = processAlive && httpOk;
      return {
        rpc: { ok: running, url: `http://127.0.0.1:${this.paths.gatewayPort}` },
        gateway: { port: this.paths.gatewayPort, bindHost: '127.0.0.1', bindMode: 'local' },
        port: { status: running ? 'open' : processAlive ? 'starting' : 'closed' },
        service: { loaded: processAlive, runtime: { status: running ? 'running' : processAlive ? 'starting' : 'stopped' } },
        logFile: ''
      };
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      await fetch(`http://127.0.0.1:${this.paths.gatewayPort}/v1/models`, { signal: ctrl.signal });
      clearTimeout(t);
      return {
        rpc: { ok: true, url: `http://127.0.0.1:${this.paths.gatewayPort}` },
        gateway: { port: this.paths.gatewayPort, bindHost: '127.0.0.1', bindMode: 'local' },
        port: { status: 'open' },
        service: { loaded: true, runtime: { status: 'running' } },
        logFile: ''
      };
    } catch { /* not reachable */ }

    const res = await this.paths.runOpenClaw(['gateway', 'status', '--json']);
    for (const raw of [res.stdout, res.stderr]) {
      if (!raw?.trim()) continue;
      try { return JSON.parse(raw.trim()) as GatewayStatus; } catch { continue; }
    }
    return {
      rpc: { ok: false, error: res.stderr || res.stdout || 'parse error', url: '' },
      gateway: { port: 0, bindHost: '', bindMode: '' },
      port: { status: 'unknown' },
      service: { loaded: false, runtime: { status: 'unknown' } },
      logFile: ''
    };
  }

  startGateway(): Promise<{ ok: boolean; message: string }> {
    if (this.gatewayProcess) {
      return Promise.resolve({ ok: false, message: 'Gateway 已在运行中' });
    }

    return new Promise((resolve) => {
      const child = spawn(
        this.paths.embeddedNodePath,
        [this.paths.openclawCliPath, 'gateway', 'run', '--allow-unconfigured', '--auth', 'none'],
        {
          cwd: this.paths.userWorkspace,
          env: {
            ...process.env,
            OPENCLAW_HOME: this.paths.userOpenClawHome,
            HOME: this.paths.userOpenClawHome,
            OPENCLAW_PROFILE: this.paths.openclawProfile,
            OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.gateway.${this.paths.openclawProfile}`,
            PATH: `${path.dirname(this.paths.embeddedNodePath)}:${process.env.PATH || ''}`
          }
        }
      );

      this.gatewayProcess = child;
      let resolved = false;

      const tryResolve = (text: string) => {
        if (!resolved && /listening|ready|started/i.test(text)) {
          resolved = true;
          resolve({ ok: true, message: 'Gateway 已启动' });
        }
      };

      child.stdout?.on('data', (d) => tryResolve(d.toString()));
      child.stderr?.on('data', (d) => tryResolve(d.toString()));

      child.on('close', (code) => {
        if (this.gatewayProcess === child) this.gatewayProcess = null;
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, message: `Gateway 退出，code=${code}` });
        }
      });

      child.on('error', (err) => {
        if (this.gatewayProcess === child) this.gatewayProcess = null;
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, message: `启动失败: ${err.message}` });
        }
      });

      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: true, message: 'Gateway 正在启动…' });
        }
        try {
          const st = await this.statusJson();
          if (st.gateway?.port) this.paths.gatewayPort = st.gateway.port;
        } catch { /* ignore */ }
      }, 5000);
    });
  }

  stopGateway(): { ok: boolean; message: string } {
    if (!this.gatewayProcess) {
      return { ok: false, message: 'Gateway 未运行' };
    }
    this.stopGatewayWsClient();
    this.gatewayProcess.kill('SIGTERM');
    this.gatewayProcess = null;
    return { ok: true, message: 'Gateway 已停止' };
  }

  async restartGateway(): Promise<{ ok: boolean; message: string }> {
    if (this.gatewayProcess) {
      await new Promise<void>((resolve) => {
        const old = this.gatewayProcess!;
        old.once('close', () => resolve());
        old.kill('SIGTERM');
        this.gatewayProcess = null;
      });
    }
    return this.startGateway();
  }

  startGatewayWsClient(): void {
    if (this.wsClient) return;
    this.connectGatewayWs();
  }

  stopGatewayWsClient(): void {
    if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    if (this.wsClient) { try { this.wsClient.close(); } catch { /* ignore */ } this.wsClient = null; }
  }

  private loadDeviceIdentity(): { deviceId: string; privateKeyPem: string; publicKeyPem: string } | null {
    const p = path.join(this.paths.userOpenClawHome, '.openclaw', 'identity', 'device.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  private wsBase64Url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  private wsPublicKeyRaw(publicKeyPem: string): Buffer {
    const key = createPublicKey(publicKeyPem);
    const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
    return der.subarray(-32);
  }

  private wsSign(privateKeyPem: string, payload: string): string {
    const key = createPrivateKey(privateKeyPem);
    return this.wsBase64Url(cryptoSign(null, Buffer.from(payload, 'utf8'), key) as Buffer);
  }

  private buildDevicePayloadV3(p: {
    deviceId: string; clientId: string; clientMode: string;
    role: string; scopes: string[]; signedAtMs: number; nonce: string;
  }): string {
    return ['v3', p.deviceId, p.clientId, p.clientMode, p.role,
      p.scopes.join(','), String(p.signedAtMs), '', p.nonce, 'darwin', ''].join('|');
  }

  private connectGatewayWs(): void {
    const identity = this.loadDeviceIdentity();
    if (!identity) { console.warn('[gateway-ws] no device identity, skipping WS client'); return; }

    const wsPath = path.join(this.paths.resourcesRuntime, 'openclaw', 'node_modules', 'ws');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WS = require(wsPath) as { new(url: string, opts?: object): WsInstance };
    const wsUrl = `ws://127.0.0.1:${this.paths.gatewayPort}`;
    let ws: WsInstance;
    try {
      ws = new WS(wsUrl, { headers: { Origin: `http://127.0.0.1:${this.paths.gatewayPort}` } });
    } catch (err) {
      console.error('[gateway-ws] failed to create WS:', err);
      return;
    }
    this.wsClient = ws;
    let msgId = 1;
    let connected = false;
    let subscribedSessionEvents = false;
    const subscribedMessageKeys = new Set<string>();

    const sendReq = (method: string, params: Record<string, unknown> = {}) => {
      if (!connected) return;
      try {
        ws.send(JSON.stringify({ type: 'req', id: String(msgId++), method, params }));
      } catch {
        // ignore ws send errors
      }
    };

    const ensureWsSessionSubscriptions = () => {
      if (!connected) return;
      if (!subscribedSessionEvents) {
        sendReq('sessions.subscribe', {});
        subscribedSessionEvents = true;
      }
      for (const worker of this.listWorkers()) {
        const key = `agent:${worker.id}:main`;
        if (subscribedMessageKeys.has(key)) continue;
        sendReq('sessions.messages.subscribe', { key });
        subscribedMessageKeys.add(key);
      }
    };

    const workerIdFromSessionKey = (sessionKey: string): string | null => {
      const m = /^agent:([^:]+):/.exec(sessionKey || '');
      return m?.[1] ?? null;
    };

    const extractAssistantMessage = (msg: unknown): { text: string; hasToolCall: boolean } => {
      if (!msg || typeof msg !== 'object') return { text: '', hasToolCall: false };
      const root = msg as Record<string, unknown>;
      if (root.type !== 'message') return { text: '', hasToolCall: false };
      const payload = root.message as Record<string, unknown> | undefined;
      if (!payload || payload.role !== 'assistant') return { text: '', hasToolCall: false };
      const content = payload.content;
      if (typeof content === 'string') return { text: content.trim(), hasToolCall: false };
      if (!Array.isArray(content)) return { text: '', hasToolCall: false };
      let hasToolCall = false;
      const parts = content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const block = item as Record<string, unknown>;
          if (block.type === 'toolCall') hasToolCall = true;
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
          return '';
        })
        .filter(Boolean);
      return { text: parts.join('\n').trim(), hasToolCall };
    };

    const extractToolOutput = (msg: unknown): string => {
      if (!msg || typeof msg !== 'object') return '';
      const root = msg as Record<string, unknown>;
      if (root.type !== 'message') return '';
      const payload = root.message as Record<string, unknown> | undefined;
      if (!payload || (payload.role !== 'toolResult' && payload.role !== 'tool')) return '';
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
      if (toolName === 'read' || toolName === 'write' || toolName === 'readFile' || toolName === 'writeFile') return '';
      const content = payload.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return (content as unknown[])
          .map((item) => {
            if (!item || typeof item !== 'object') return '';
            const block = item as Record<string, unknown>;
            if (block.type === 'text' && typeof block.text === 'string') return block.text;
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      return '';
    };

    ws.on('message', (data: unknown) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }

      if (parsed.event === 'connect.challenge') {
        const nonce = (parsed.payload as Record<string, unknown>)?.nonce as string | undefined;
        if (!nonce) return;
        const signedAtMs = Date.now();
        const role = 'operator';
        const scopes = ['operator.admin'];
        const clientId = 'webchat-ui';
        const clientMode = 'webchat';
        const payload = this.buildDevicePayloadV3({ deviceId: identity.deviceId, clientId, clientMode, role, scopes, signedAtMs, nonce });
        try {
          ws.send(JSON.stringify({
            type: 'req', id: String(msgId++), method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: clientId, version: this.paths.runtimeVersion, platform: process.platform, mode: clientMode },
              caps: [], role, scopes,
              device: {
                id: identity.deviceId,
                publicKey: this.wsBase64Url(this.wsPublicKeyRaw(identity.publicKeyPem)),
                signature: this.wsSign(identity.privateKeyPem, payload),
                signedAt: signedAtMs, nonce
              }
            }
          }));
        } catch (err) { console.error('[gateway-ws] send connect error:', err); }
        return;
      }

      if (parsed.type === 'res' && parsed.ok === true) {
        connected = true;
        ensureWsSessionSubscriptions();
        return;
      }

      if (parsed.event === 'session.message' && connected) {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        const sessionKey = typeof payload?.sessionKey === 'string' ? payload.sessionKey : '';
        if (!sessionKey) return;
        const workerId = workerIdFromSessionKey(sessionKey);
        if (!workerId) return;
        const message = payload?.message;
        const { text: assistantText } = extractAssistantMessage(message);
        const toolText = extractToolOutput(message);
        const text = assistantText || toolText;
        if (!text) return;

        const compact = text.replace(/\s+/g, ' ').trim();
        if (!compact) return;
        const now = Date.now();
        const prev = this.wsProgressDedupe.get(workerId);
        if (prev && prev.text === compact && now - prev.ts < 15000) return;
        this.wsProgressDedupe.set(workerId, { text: compact, ts: now });

        const content = compact.length > 260 ? `${compact.slice(0, 259)}…` : compact;

        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('cron:message', { workerId, content: `🟡 进度: ${content}`, role: 'assistant' });
        for (const listener of this.workerEventListeners) listener({ workerId, content: `🟡 进度: ${content}`, role: 'assistant' });
        return;
      }

      if (parsed.event === 'cron' && connected) {
        const p = parsed.payload as Record<string, unknown> | undefined;
        if (!p || p.action !== 'finished') return;
        const sessionKey = p.sessionKey as string | undefined;
        const summary = p.summary as string | undefined;
        if (!sessionKey || !summary) return;
        const m = /^agent:([^:]+):/.exec(sessionKey);
        const agentId = m?.[1];
        if (!agentId) return;

        const content = summary;

        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('cron:message', { workerId: agentId, content, role: 'assistant' });
        for (const listener of this.workerEventListeners) listener({ workerId: agentId, content, role: 'assistant' });
      }

      if (connected && parsed.type === 'event') {
        ensureWsSessionSubscriptions();
      }
    });

    ws.on('error', (err: unknown) => {
      console.error('[gateway-ws] error:', (err as Error)?.message ?? err);
    });

    ws.on('close', () => {
      connected = false;
      if (this.wsClient === ws) {
        this.wsClient = null;
        if (this.gatewayProcess) {
          this.wsReconnectTimer = setTimeout(() => { this.wsReconnectTimer = null; this.connectGatewayWs(); }, 5000);
        }
      }
    });
  }

  async probeGatewayHealth(): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    try {
      const res = await fetch(`http://127.0.0.1:${this.paths.gatewayPort}/v1/models`, { signal: ctrl.signal });
      return `models_status=${res.status}`;
    } catch (probeErr) {
      return `models_probe_failed ${this.formatNetworkErrorDetails(probeErr)}`;
    } finally {
      clearTimeout(t);
    }
  }

  formatNetworkErrorDetails(err: unknown): string {
    const toPairs = (prefix: string, obj: unknown): string[] => {
      if (!obj || typeof obj !== 'object') return [];
      const rec = obj as Record<string, unknown>;
      const fields = ['name', 'message', 'code', 'errno', 'syscall', 'address', 'port', 'type'];
      return fields
        .filter((k) => rec[k] !== undefined && rec[k] !== null)
        .map((k) => `${prefix}${k}=${String(rec[k]).replace(/\s+/g, ' ').trim()}`);
    };

    const parts: string[] = [];
    if (err instanceof Error) {
      parts.push(`error=${err.name}:${err.message.replace(/\s+/g, ' ').trim()}`);
      parts.push(...toPairs('', err));
      const withCause = err as Error & { cause?: unknown };
      if (withCause.cause) {
        parts.push(...toPairs('cause.', withCause.cause));
        if (withCause.cause instanceof Error) {
          const c = withCause.cause as Error & { cause?: unknown };
          parts.push(`cause.error=${c.name}:${c.message.replace(/\s+/g, ' ').trim()}`);
          if (c.cause) parts.push(...toPairs('cause2.', c.cause));
        }
      }
    } else {
      parts.push(`error=${String(err).replace(/\s+/g, ' ').trim()}`);
      parts.push(...toPairs('', err));
    }

    return parts.length > 0 ? parts.join(' ') : 'unavailable';
  }
}
