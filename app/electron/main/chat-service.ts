import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BrowserWindow } from 'electron';
import type { ChatResult, ImageInput, MessageContent, MessageContentBlock, MessageItem } from './types';
import type { OpenClawPaths } from './paths';
import type { GatewayService } from './gateway-service';
import type { SessionService } from './session-service';
import type { WorkerService } from './worker-service';

export class ChatService {
  private readonly wsProgressDedupe = new Map<string, { text: string; ts: number }>();

  constructor(
    private readonly paths: OpenClawPaths,
    private readonly gateway: GatewayService,
    private readonly sessions: SessionService,
    private readonly workers: WorkerService,
    private readonly getConfiguredModelFull: () => string,
    private readonly getModel: () => string
  ) {}

  private toOpenAIContent(content: MessageContent): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
    if (typeof content === 'string') return content;
    return content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      return {
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      };
    });
  }

  private sanitizeHistoryMessageContent(content: unknown): unknown {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content;

    return content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const entry = block as Record<string, unknown>;
      if (entry.type === 'image' && typeof entry.mediaType === 'string' && typeof entry.data === 'string') {
        return {
          type: 'text',
          text: `[image:${entry.mediaType},size=${entry.data.length}]`,
        };
      }
      return block;
    });
  }

  private extractReplyText(json: unknown): string {
    if (!json || typeof json !== 'object') return '';
    const root = json as {
      choices?: Array<{ message?: { content?: unknown; text?: unknown }; delta?: { content?: unknown }; text?: unknown }>;
      output_text?: unknown;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; text?: string }>;
    };

    if (typeof root.output_text === 'string' && root.output_text.trim()) {
      return root.output_text;
    }

    const messageContent = root.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string' && messageContent.trim()) {
      return messageContent;
    }
    if (Array.isArray(messageContent)) {
      const text = messageContent
        .map((block) => {
          if (!block || typeof block !== 'object') return '';
          const entry = block as Record<string, unknown>;
          if (typeof entry.text === 'string') return entry.text;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }

    const choiceText = root.choices?.[0]?.message?.text ?? root.choices?.[0]?.text ?? root.choices?.[0]?.delta?.content;
    if (typeof choiceText === 'string' && choiceText.trim()) {
      return choiceText;
    }

    if (Array.isArray(root.output)) {
      const text = root.output
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          if (typeof item.text === 'string') return item.text;
          if (!Array.isArray(item.content)) return '';
          return item.content
            .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
            .filter(Boolean)
            .join('\n');
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }

    return '';
  }

  private extractCliErrorText(raw: string): string {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const explicit = lines.find((l) => l.includes('Failed to start CLI:'));
    if (explicit) return explicit.replace(/^\[openclaw\]\s*/, '');

    const plugin = lines.find((l) => /PluginLoadFailureError|plugin load failed/i.test(l));
    if (plugin) return plugin.replace(/^\[openclaw\]\s*/, '');

    const errorLine = lines.find((l) => /^\[error\]|^Error:|\berror\b/i.test(l));
    if (errorLine) return errorLine;

    return '';
  }

  private summarizeResponseShape(json: unknown): string {
    if (!json || typeof json !== 'object') return 'json=non-object';
    const root = json as Record<string, unknown>;
    const keys = Object.keys(root).slice(0, 12).join(',') || '(none)';

    const choices = Array.isArray(root.choices) ? root.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
    const firstMsg = firstChoice?.message && typeof firstChoice.message === 'object'
      ? (firstChoice.message as Record<string, unknown>)
      : null;
    const msgContent = firstMsg?.content;
    const msgContentType = Array.isArray(msgContent)
      ? `array(${msgContent.length})`
      : typeof msgContent;

    const output = Array.isArray(root.output) ? root.output : [];
    const usage = root.usage && typeof root.usage === 'object' ? (root.usage as Record<string, unknown>) : null;
    const usagePayload = usage ? JSON.stringify(usage) : 'none';

    return [
      `keys=${keys}`,
      `choices=${choices.length}`,
      `msgContentType=${msgContentType}`,
      `outputItems=${output.length}`,
      `hasOutputText=${typeof root.output_text === 'string'}`,
      `usage=${usagePayload}`,
    ].join(' ');
  }

  private buildHttpPreflightDump(
    workerPath: string,
    gatewayModel: string,
    configuredModel: string,
    message: string,
    images: ImageInput[],
    history: MessageItem[],
    traceId?: string
  ): Record<string, unknown> {
    const soulPath = path.join(workerPath, 'SOUL.md');
    const agentsPath = path.join(workerPath, 'AGENTS.md');
    const toolsPath = path.join(workerPath, 'TOOLS.md');
    const soul = this.paths.readWorkerFile(workerPath, 'SOUL.md');
    const agents = this.paths.readWorkerFile(workerPath, 'AGENTS.md');
    const tools = this.paths.readWorkerFile(workerPath, 'TOOLS.md');

    const skillsDir = path.join(workerPath, 'skills');
    const skillFiles: Array<Record<string, unknown>> = [];
    try {
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;
          let chars = -1;
          try {
            chars = fs.readFileSync(skillMdPath, 'utf8').length;
          } catch {
            chars = -1;
          }
          skillFiles.push({ name: entry.name, skillMdPath, skillMdChars: chars });
        }
      }
    } catch {
      // ignore debug scan errors
    }

    const memoryDir = path.join(workerPath, 'memory');
    const memoryEntries: Array<Record<string, unknown>> = [];
    let memoryTotalFiles = 0;
    const MAX_MEMORY_ENTRIES = 200;
    const walkMemory = (dir: string, relBase = '') => {
      if (memoryEntries.length >= MAX_MEMORY_ENTRIES) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (memoryEntries.length >= MAX_MEMORY_ENTRIES) return;
        const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkMemory(fullPath, relPath);
          continue;
        }
        memoryTotalFiles += 1;
        let size = -1;
        let mtime = '';
        try {
          const stat = fs.statSync(fullPath);
          size = stat.size;
          mtime = stat.mtime.toISOString();
        } catch {
          // ignore stat errors
        }
        memoryEntries.push({ relPath, size, mtime });
      }
    };
    if (fs.existsSync(memoryDir)) {
      walkMemory(memoryDir);
    }

    const extractText = (content: MessageContent): string => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content
        .map((blk) => (blk?.type === 'text' && typeof blk.text === 'string' ? blk.text : ''))
        .filter(Boolean)
        .join('\n');
    };
    const refSet = new Set<string>();
    const refRegex = /(?:^|[\s`"'])((?:\.\/)?memory\/[^\s`"']+)/g;
    const pushRefs = (text: string) => {
      if (!text) return;
      for (const m of text.matchAll(refRegex)) {
        const p = (m[1] || '').replace(/[),.;:]+$/g, '');
        if (p) refSet.add(p);
      }
    };
    pushRefs(message);
    for (const item of history) {
      pushRefs(extractText(item.content));
    }

    return {
      generatedAt: new Date().toISOString(),
      traceId: traceId || null,
      source: 'chatHttp.preflight',
      note: 'This dump captures prompt context visible in desktop client before gateway request. Final runtime tool JSON schema is assembled inside gateway/agent runtime.',
      model: { gatewayModel, configuredModel },
      requestMeta: {
        textLen: message.length,
        historyCount: history.length,
        imageCount: images.length,
        imageMimeTypes: images.map((i) => i.mediaType),
      },
      injectedFiles: {
        soulPath,
        soulChars: soul.length,
        agentsPath,
        agentsChars: agents.length,
        toolsPath,
        toolsChars: tools.length,
        toolsContent: tools,
      },
      skills: {
        skillsDir,
        count: skillFiles.length,
        entries: skillFiles,
      },
      memory: {
        memoryDir,
        exists: fs.existsSync(memoryDir),
        totalFiles: memoryTotalFiles,
        dumpedFiles: memoryEntries.length,
        files: memoryEntries,
        referencedPaths: Array.from(refSet),
      },
    };
  }

  private async chatHttp(
    gatewayModel: string,
    promptContextPath: string,
    message: string,
    images: ImageInput[],
    history: MessageItem[],
    onLog?: (step: string) => void,
    traceId?: string
  ): Promise<string> {
    const userContent: MessageContent = images.length === 0
      ? message
      : [
          { type: 'text', text: message || '请描述这张图片的主要内容。' },
          ...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
        ];

    const messages = [
      ...history.map((item) => ({ role: item.role, content: this.toOpenAIContent(item.content) })),
      { role: 'user', content: this.toOpenAIContent(userContent) },
    ];

    const configuredModel = this.getConfiguredModelFull() || '(unset)';
    const schemaDump = this.buildHttpPreflightDump(
      promptContextPath,
      gatewayModel,
      configuredModel,
      message,
      images,
      history,
      traceId
    );
    this.paths.writeToolSchemaDump(schemaDump, traceId);
    const memoryMeta = schemaDump.memory as Record<string, unknown> | undefined;
    if (memoryMeta) {
      const refs = Array.isArray(memoryMeta.referencedPaths) ? memoryMeta.referencedPaths.length : 0;
      const totalFiles = typeof memoryMeta.totalFiles === 'number' ? memoryMeta.totalFiles : 0;
      onLog?.(`memory preflight totalFiles=${totalFiles} referenced=${refs}`);
    }
    onLog?.(
      `req meta gatewayModel=${gatewayModel} configuredModel=${configuredModel} textLen=${message.length} images=${images.length} history=${history.length} mimes=${images.map((i) => i.mediaType).join('|') || '-'} sizes=${images.map((i) => i.data.length).join('|') || '-'}`
    );

    const url = `http://127.0.0.1:${this.gateway.gatewayPort}/v1/chat/completions`;
    onLog?.(`fetch → POST /v1/chat/completions timeout=${this.paths.httpTimeoutMs}ms`);
    const t = Date.now();
    const gatewayToken = this.paths.getGatewayToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.paths.httpTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: gatewayModel, messages }),
        signal: ctrl.signal,
      });
    } catch (err) {
      const elapsed = Date.now() - t;
      if (err instanceof Error && err.name === 'AbortError') {
        onLog?.(`fetch × timeout (${elapsed}ms)`);
        throw new Error(`HTTP 请求超时（>${this.paths.httpTimeoutMs}ms）`);
      }
      onLog?.(`fetch × failed (${elapsed}ms) ${err}`);
      onLog?.(`fetch err detail ${this.gateway.formatNetworkErrorDetails(err)}`);
      onLog?.(`fetch err probe ${await this.gateway.probeGatewayHealth()}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    onLog?.(`fetch ← ${res.status} (${Date.now() - t}ms)`);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as unknown;
    onLog?.(`resp shape ${this.summarizeResponseShape(json)}`);
    const content = this.extractReplyText(json) || '(无回复内容)';
    onLog?.(`reply len=${content.length}`);
    return content;
  }

  private chatCliAgent(
    agentId: string,
    message: string,
    onLog?: (step: string) => void,
    groupId?: string
  ): Promise<string> {
    return new Promise((resolve) => {
      const agentWorkspace = this.paths.workerAgentWorkspacePath(agentId);
      const sessionId = this.sessions.getDesktopSessionId(agentId, groupId, this.getModel());
      const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message', message, '--json'];

      const child = spawn(this.paths.embeddedNodePath, [this.paths.openclawCliPath, ...args], {
        cwd: agentWorkspace,
        env: {
          ...process.env,
          OPENCLAW_HOME: this.paths.userOpenClawHome,
          HOME: this.paths.userOpenClawHome,
          OPENCLAW_PROFILE: this.paths.openclawProfile,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.gateway.${this.paths.openclawProfile}`,
          PATH: `${path.dirname(this.paths.embeddedNodePath)}:${process.env.PATH || ''}`
        }
      });

      const spawnAt = Date.now();
      const ms = () => `${Date.now() - spawnAt}ms`;
      onLog?.(`spawn pid=${child.pid} session=${sessionId}`);
      let cliTimedOut = false;
      const timer = setTimeout(() => {
        cliTimedOut = true;
        onLog?.(`[${ms()}] CLI timeout (${this.paths.cliTimeoutMs}ms)`);
        child.kill('SIGTERM');
      }, this.paths.cliTimeoutMs);

      let stdout = '';
      let stderr = '';
      let stdoutBuf = '';
      let stderrBuf = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      // eslint-disable-next-line no-control-regex
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

      // eslint-disable-next-line no-control-regex
      const NOISE = /^(bind:|listen|gateway|server|port \d|starting|started|ready|\[debug\]|\[info\]|\[warn\]|\[error\]|›|✓)/i;
      const emitProgress = (raw: string) => {
        let compact = stripAnsi(raw).replace(/\s+/g, ' ').trim();
        if (!compact) return;
        const textField = compact.match(/^"text":\s*"(.*)",?$/);
        if (textField) {
          compact = textField[1]
            .replace(/\\n/g, ' ')
            .replace(/\\t/g, ' ')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\s+/g, ' ')
            .trim();
        }
        const progressHint = /(开始|执行|处理中|进度|完成|导出|第\d+条|batch|step|progress|running)/i;
        const noisyHint = /(\*\*Prompt\s*\d+|Prompt\s*\d+|Subject:|Dear\s|```|rawChars|schemaChars|propertiesCount|injectedChars|finalPromptText|finalAssistantRawText)/i;
        if (!progressHint.test(compact) || noisyHint.test(compact)) return;
        if (compact.length > 180 && !/(进度|完成|导出|第\d+条|开始执行|批量)/i.test(compact)) return;
        const now = Date.now();
        const prev = this.wsProgressDedupe.get(agentId);
        if (prev && prev.text === compact && now - prev.ts < 4000) return;
        this.wsProgressDedupe.set(agentId, { text: compact, ts: now });
        const content = compact.length > 260 ? `${compact.slice(0, 259)}…` : compact;
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('cron:message', { workerId: agentId, content: `🟡 进度: ${content}`, role: 'assistant' });
      };
      const handleLine = (line: string) => {
        const clean = stripAnsi(line).trim();
        if (!clean || clean.startsWith('{') || /^[\[\]{}],?$/.test(clean) || NOISE.test(clean)) return;
        onLog?.(`[${ms()}] status: ${clean}`);
        emitProgress(clean);
      };

      child.stdout.on('data', (d: Buffer) => {
        const text = stdoutDecoder.write(d);
        stdout += text;
        stdoutBuf += text;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        lines.forEach(handleLine);
      });

      child.stderr.on('data', (d: Buffer) => {
        const text = stderrDecoder.write(d);
        stderr += text;
        stderrBuf += text;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        lines.forEach(handleLine);
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        onLog?.(`[${ms()}] spawn error: ${err.message}`);
        resolve(`[启动失败] ${err.message}`);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (cliTimedOut || code === null) {
          resolve(`调用失败: CLI 执行超时（>${this.paths.cliTimeoutMs}ms）`);
          return;
        }
        onLog?.(`[${ms()}] CLI exit code=${code}`);
        const combined = [stderr, stdout].filter(Boolean).join('\n');
        const stripped = stripAnsi(combined);
        let reply = '';
        const lines = stripped.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trimStart().startsWith('{')) continue;
          try {
            const parsed = JSON.parse(lines.slice(i).join('\n'));
            const result = parsed?.result ?? parsed;
            const payloads = result?.payloads;
            reply =
              result?.meta?.finalAssistantVisibleText ??
              (Array.isArray(payloads) ? payloads[payloads.length - 1]?.text : undefined) ??
              result?.reply?.text ??
              result?.reply ??
              result?.message ??
              result?.output ??
              '';
            if (reply) break;
          } catch { continue; }
        }
        onLog?.(`[${ms()}] reply parsed len=${reply.length}`);
        if (reply) {
          resolve(reply);
          return;
        }
        const errorText = this.extractCliErrorText(stripped);
        if (errorText) {
          resolve(`调用失败: ${errorText}`);
          return;
        }
        resolve('(无回复内容)');
      });
    });
  }

  private shouldPreferCliForLargeTask(message: string, history?: MessageItem[], images?: ImageInput[]): { prefer: boolean; reason: string } {
    if (Array.isArray(images) && images.length > 0) {
      return { prefer: false, reason: 'has-images' };
    }

    const text = (message || '').trim();
    if (!text) return { prefer: false, reason: 'empty' };

    if (text.length >= 700) {
      return { prefer: true, reason: `message-len=${text.length}` };
    }

    const scheduleHint = /(\bcron\b|定时|定时任务|每\s*\d+\s*(秒|分钟|小时|天)|每分钟|每小时|提醒我|准点)/i;
    if (scheduleHint.test(text)) {
      return { prefer: true, reason: 'schedule-intent' };
    }

    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 30) {
      return { prefer: true, reason: `line-count=${lines.length}` };
    }

    const batchHint = /(执行下这个文件|逐行执行|批量|promptexec|---文件:|```csv|csv文件|按顺序执行|依次执行)/i;
    if (batchHint.test(text)) {
      return { prefer: true, reason: 'batch-hint' };
    }

    const toolHeavyMatches = text.match(/(创建|读取|删除|修改|运行|安装|脚本|文件|curl|pip\s+install|python3?\s)/gi) || [];
    if (toolHeavyMatches.length >= 8 && text.length >= 300) {
      return { prefer: true, reason: `tool-heavy=${toolHeavyMatches.length}` };
    }

    const historyCount = Array.isArray(history) ? history.length : 0;
    if (historyCount >= 40 && text.length >= 300) {
      return { prefer: true, reason: `history-count=${historyCount}` };
    }

    return { prefer: false, reason: 'small-task' };
  }

  async chat(workerId: string, message: string, images?: ImageInput[], history?: MessageItem[], traceId?: string, groupId?: string): Promise<ChatResult> {
    const t0 = Date.now();
    const ms = () => `+${Date.now() - t0}ms`;
    const tag = traceId ? `[chat:${workerId}][${traceId}]` : `[chat:${workerId}]`;
    const log = (step: string) => this.paths.writeChatLog(`${tag} ${ms().padEnd(8)} ${step}`);

    const trimmed = (message || '').trim();
    const hasImages = Array.isArray(images) && images.length > 0;
    let timeoutNotice = '';
    const markTimeoutNotice = (err: unknown, source: string) => {
      const text = err instanceof Error ? err.message : String(err);
      if (!/超时|timeout/i.test(text)) return;
      timeoutNotice = `⚠️ ${source}请求超时（>${this.paths.httpTimeoutMs}ms），已切换到 CLI 继续处理。`;
    };
    if (!trimmed && !hasImages) {
      return { code: -1, stdout: '', stderr: '消息不能为空', cmd: '', reply: '消息不能为空' };
    }

    log(`START msg="${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}"`);

    const workerList = this.workers.listWorkers();
    const selected =
      workerList.find((w) => w.id === workerId) ||
      workerList.find((w) => w.id === this.paths.defaultWorkerId) ||
      workerList[0];

    if (!selected) {
      return {
        code: -1, stdout: '', stderr: '', cmd: '',
        reply: '未找到可用 worker。'
      };
    }

    log(`worker=${selected.id} mode=${selected.mode ?? 'default'}`);

    if (!this.gateway.isRunning) {
      log('gateway-ping start');
      let reachable = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 800);
        const r = await fetch(`http://127.0.0.1:${this.gateway.gatewayPort}/v1/models`, { signal: ctrl.signal });
        clearTimeout(t);
        reachable = r.status < 500;
      } catch { /* not reachable */ }
      log(`gateway-ping result=${reachable}`);
      if (!reachable) {
        return {
          code: -1, stdout: '', stderr: '', cmd: '',
          reply: 'Gateway 未运行，请先点击 Start 启动 Gateway。'
        };
      }
    }

    if (selected.mode === 'agent') {
      const cliPreference = this.shouldPreferCliForLargeTask(trimmed, history, images);
      if (cliPreference.prefer) {
        log(`CLI-agent preferred: ${cliPreference.reason}`);
        const reply = await this.chatCliAgent(
          selected.id,
          trimmed,
          (step) => log(`CLI-agent ${step}`),
          groupId
        );
        log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: reply, stderr: '', cmd: `openclaw agent --agent ${selected.id}`, reply };
      }

      log(`HTTP-agent${hasImages ? '-vision' : ''} start`);
      try {
        const reply = await this.chatHttp(
          `openclaw/${selected.id}`,
          this.paths.workerAgentWorkspacePath(selected.id),
          trimmed,
          images ?? [],
          history ?? [],
          (step) => log(`HTTP ${step}`),
          traceId
        );
        log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: reply, stderr: '', cmd: `POST /v1/chat/completions`, reply };
      } catch (httpErr) {
        log(`HTTP-agent${hasImages ? '-vision' : ''} failed: ${httpErr}`);
        markTimeoutNotice(httpErr, 'HTTP-agent ');
        if (hasImages) {
          return {
            code: -1,
            stdout: '',
            stderr: String(httpErr),
            cmd: `POST /v1/chat/completions`,
            reply: `图片请求失败: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`,
          };
        }
      }

      log('CLI-agent fallback start');
      const reply = await this.chatCliAgent(
        selected.id, trimmed,
        (step) => log(`CLI-agent ${step}`),
        groupId
      );
      const finalReply = timeoutNotice ? `${timeoutNotice}\n\n${reply}` : reply;
      log(`DONE reply-len=${finalReply.length} total=${Date.now() - t0}ms`);
      return { code: 0, stdout: finalReply, stderr: '', cmd: `openclaw agent --agent ${selected.id}`, reply: finalReply };
    } else {
      log('HTTP start');
      try {
        const reply = await this.chatHttp(
          'openclaw',
          this.paths.workerAgentWorkspacePath(selected.id),
          trimmed,
          images ?? [],
          history ?? [],
          (step) => log(`HTTP ${step}`),
          traceId
        );
        log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: reply, stderr: '', cmd: `POST /v1/chat/completions`, reply };
      } catch (httpErr) {
        log(`HTTP failed: ${httpErr}`);
        markTimeoutNotice(httpErr, 'HTTP ');
        console.warn('[chat] HTTP API failed, falling back to CLI:', httpErr);
      }
    }

    // CLI fallback
    log('CLI-fallback start');
    const agentWorkspace = this.paths.workerAgentWorkspacePath(selected.id);
    const sessionId = this.sessions.getDesktopSessionId(selected.id, groupId, this.getModel());
    const res = await this.paths.runOpenClaw(
      ['agent', '--agent', selected.id, '--session-id', sessionId, '--message', trimmed, '--json'],
      { cwd: agentWorkspace, timeoutMs: this.paths.cliTimeoutMs }
    );
    log(`CLI-fallback exit code=${res.code}`);

    const combined = [res.stderr, res.stdout].filter(Boolean).join('\n');
    // eslint-disable-next-line no-control-regex
    const stripped = combined.replace(/\x1b\[[0-9;]*m/g, '');

    let reply = '';
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trimStart().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(lines.slice(i).join('\n'));
        const payloads = parsed?.payloads;
        reply =
          parsed?.meta?.finalAssistantVisibleText ??
          (Array.isArray(payloads) ? payloads[payloads.length - 1]?.text : undefined) ??
          parsed?.reply?.text ??
          parsed?.reply ??
          parsed?.message ??
          parsed?.output ??
          '';
        if (reply) break;
      } catch {
        continue;
      }
    }

    if (!reply) {
      const cliError = this.extractCliErrorText(stripped);
      reply = cliError ? `调用失败: ${cliError}` : '(无回复内容)';
    }
    if (timeoutNotice) {
      reply = `${timeoutNotice}\n\n${reply}`;
    }
    log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
    return { ...res, reply };
  }

  getChatHistory(): { messages: Record<string, unknown[]>; groupMessages: Record<string, unknown[]> } {
    const p = path.join(require('electron').app.getPath('userData'), 'chat-history.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { messages: {}, groupMessages: {} };
    }
  }

  saveChatHistory(data: { messages: Record<string, unknown[]>; groupMessages: Record<string, unknown[]> }): void {
    const p = path.join(require('electron').app.getPath('userData'), 'chat-history.json');
    const sanitizedMessages: Record<string, unknown[]> = {};
    for (const [workerId, list] of Object.entries(data?.messages ?? {})) {
      sanitizedMessages[workerId] = (Array.isArray(list) ? list : []).map((item) => {
        if (!item || typeof item !== 'object') return item;
        const row = item as Record<string, unknown>;
        return {
          ...row,
          content: this.sanitizeHistoryMessageContent(row.content),
        };
      });
    }
    fs.writeFileSync(
      p,
      JSON.stringify({
        messages: sanitizedMessages,
        groupMessages: data?.groupMessages ?? {},
      }),
      'utf8'
    );
  }
}
