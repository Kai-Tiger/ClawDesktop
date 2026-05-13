import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { WorkerService } from './worker-service';
import type { ChatService } from './chat-service';
import type { GroupService } from './group-service';
import type { CoordinatorService } from './coordinator-service';
import type { OpenClawPaths } from './paths';
import type { WsInstance, MessageItem } from './types';

interface WsServerInstance {
  handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer, cb: (ws: WsInstance) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export type MobileBridgeEvent = { workerId: string; content: string; role: string };

export class MobileBridgeService {
  private server: ReturnType<typeof createServer> | null = null;
  private wss: WsServerInstance | null = null;
  private readonly wsClients = new Set<WsInstance>();
  private _token = '';
  private _port = 18788;
  private _running = false;

  constructor(
    private readonly workers: WorkerService,
    private readonly chat: ChatService,
    private readonly groups: GroupService,
    private readonly coordinator: CoordinatorService,
    private readonly paths: OpenClawPaths
  ) {
    this._token = this.loadOrCreateToken();
  }

  get token() { return this._token; }
  get port() { return this._port; }
  get isRunning() { return this._running; }

  getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const alias of iface) {
        if (alias.family === 'IPv4' && !alias.internal) return alias.address;
      }
    }
    return '127.0.0.1';
  }

  connectionInfo() {
    return { ip: this.getLocalIP(), port: this._port, token: this._token, running: this._running };
  }

  private get tokenPath() {
    return path.join(this.paths.userOpenClawHome, '.openclaw', 'mobile-token.json');
  }

  private loadOrCreateToken(): string {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8')) as { token?: unknown };
      if (typeof data.token === 'string' && data.token.length > 8) return data.token;
    } catch { /* create new */ }
    const token = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    fs.writeFileSync(this.tokenPath, JSON.stringify({ token }));
    return token;
  }

  broadcast(event: MobileBridgeEvent) {
    const msg = JSON.stringify({ type: 'worker_event', ...event });
    for (const client of this.wsClients) {
      try { client.send(msg); } catch { /* ignore dead clients */ }
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers['authorization'] || '';
    return auth === `Bearer ${this._token}`;
  }

  private sendJson(res: ServerResponse, status: number, data: unknown) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    res.end(body);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this._port}`);
    const routePath = url.pathname;

    if (routePath === '/api/ping') {
      this.sendJson(res, 200, { ok: true, version: '1' });
      return;
    }

    if (!this.checkAuth(req)) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (routePath === '/api/workers' && req.method === 'GET') {
      this.sendJson(res, 200, this.workers.listWorkers());
      return;
    }

    if (routePath === '/api/groups' && req.method === 'GET') {
      this.sendJson(res, 200, this.groups.listGroups());
      return;
    }

    if (routePath === '/api/history' && req.method === 'GET') {
      const history = this.chat.getChatHistory();
      const workerId = url.searchParams.get('workerId');
      if (workerId && Array.isArray(history)) {
        const filtered = (history as Array<{ workerId?: string }>).filter((h) => h.workerId === workerId);
        this.sendJson(res, 200, filtered);
        return;
      }
      this.sendJson(res, 200, history);
      return;
    }

    if (routePath === '/api/chat' && req.method === 'POST') {
      const body = await this.readBody(req);
      let payload: { workerId?: string; message?: string; history?: MessageItem[]; traceId?: string; groupId?: string };
      try { payload = JSON.parse(body) as typeof payload; } catch { this.sendJson(res, 400, { error: 'Invalid JSON' }); return; }
      if (!payload.workerId || !payload.message) {
        this.sendJson(res, 400, { error: 'workerId and message required' });
        return;
      }
      try {
        const result = await this.chat.chat(payload.workerId, payload.message, undefined, payload.history, payload.traceId, payload.groupId);
        this.sendJson(res, 200, result);
      } catch (err: unknown) {
        this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (routePath === '/api/coordinator' && req.method === 'POST') {
      const body = await this.readBody(req);
      let payload: { message?: string; workerIds?: string[]; fileContext?: string };
      try { payload = JSON.parse(body) as typeof payload; } catch { this.sendJson(res, 400, { error: 'Invalid JSON' }); return; }
      if (!payload.message) { this.sendJson(res, 400, { error: 'message required' }); return; }
      const allWorkers = this.workers.listWorkers();
      const workerList = (payload.workerIds || [])
        .map((id) => allWorkers.find((w) => w.id === id))
        .filter((w): w is NonNullable<typeof w> => Boolean(w));
      try {
        const plan = await this.coordinator.coordinatorPlan(payload.message, workerList, payload.fileContext);
        this.sendJson(res, 200, { plan });
      } catch (err: unknown) {
        this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    this.sendJson(res, 404, { error: 'Not Found' });
  }

  start(port = 18788): Promise<{ ok: boolean; error?: string }> {
    if (this._running) return Promise.resolve({ ok: true });
    this._port = port;

    const wsModulePath = path.join(this.paths.resourcesRuntime, 'openclaw', 'node_modules', 'ws');
    let WebSocketServer: new(opts: object) => WsServerInstance;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wsModule = require(wsModulePath) as { WebSocketServer?: new(opts: object) => WsServerInstance; Server?: new(opts: object) => WsServerInstance };
      const Ctor = wsModule.WebSocketServer || wsModule.Server;
      if (!Ctor) throw new Error('WebSocketServer not found in ws module');
      WebSocketServer = Ctor;
    } catch (err) {
      return Promise.resolve({ ok: false, error: `Failed to load ws: ${String(err)}` });
    }

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    wss.on('connection', (ws: WsInstance, req: IncomingMessage) => {
      const upgradeUrl = new URL(req.url || '/', `http://127.0.0.1:${this._port}`);
      const token = upgradeUrl.searchParams.get('token');
      if (token !== this._token) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        ws.close();
        return;
      }
      this.wsClients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', workers: this.workers.listWorkers().map((w) => w.id) }));
      ws.on('close', () => { this.wsClients.delete(ws); });
      ws.on('error', () => { this.wsClients.delete(ws); });
    });

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.sendJson(res, 500, { error: String(err) });
      });
    });

    server.on('upgrade', (req, socket, head) => {
      const upgradeUrl = new URL(req.url || '/', `http://127.0.0.1:${this._port}`);
      if (upgradeUrl.pathname === '/api/events') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        (socket as { destroy(): void }).destroy();
      }
    });

    return new Promise((resolve) => {
      server.listen(port, '0.0.0.0', () => {
        this._running = true;
        this.server = server;
        resolve({ ok: true });
      });
      server.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
    });
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    for (const client of this.wsClients) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    this.server?.close();
    this.server = null;
    this.wss = null;
  }
}
