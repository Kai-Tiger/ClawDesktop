import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BrowserWindow, app, dialog, nativeImage, net } from 'electron';
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
    private readonly getConfiguredModelFull: (workerId: string) => string,
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

    const normalized = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const entry = block as Record<string, unknown>;
      if (entry.type === 'text' && typeof entry.text === 'string') {
        return {
          type: 'text',
          text: entry.text,
        };
      }
      if (entry.type === 'image' && typeof entry.mediaType === 'string' && typeof entry.data === 'string') {
        return {
          type: 'image',
          mediaType: entry.mediaType,
          data: entry.data,
        };
      }
      return block;
    });

    return normalized.filter((block) => {
      if (!block || typeof block !== 'object') return false;
      const entry = block as Record<string, unknown>;
      if (entry.type === 'text') return typeof entry.text === 'string';
      if (entry.type === 'image') {
        return typeof entry.mediaType === 'string' && typeof entry.data === 'string' && entry.data.length > 0;
      }
      return false;
    });
  }

  private isDirectImageModel(configuredModel: string): boolean {
    const m = (configuredModel || '').toLowerCase();
    return m.startsWith('openrouter/') && m.includes('image');
  }

  private getOpenRouterApiKey(): string {
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const key = raw?.models?.providers?.openrouter?.apiKey;
      return typeof key === 'string' ? key.trim() : '';
    } catch {
      return '';
    }
  }

  private async chatHttpDirectOpenRouter(
    configuredModel: string,
    messages: Array<{ role: string; content: unknown }>,
    onLog?: (step: string) => void,
    traceId?: string
  ): Promise<unknown> {
    const apiKey = this.getOpenRouterApiKey();
    if (!apiKey) {
      throw new Error('OpenRouter API Key 未配置');
    }
    const model = configuredModel.replace(/^openrouter\//, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (traceId) {
      headers['x-openclaw-trace-id'] = traceId;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.paths.httpTimeoutMs);
    const t = Date.now();
    onLog?.(`direct-openrouter fetch → /chat/completions model=${model} timeout=${this.paths.httpTimeoutMs}ms`);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages }),
        signal: ctrl.signal,
      });
      onLog?.(`direct-openrouter fetch ← ${res.status} (${Date.now() - t}ms)`);
      if (!res.ok) {
        throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`OpenRouter 请求超时（>${this.paths.httpTimeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private summarizeMessageContent(content: MessageContent): string {
    if (typeof content === 'string') return content;
    return content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return `[image:${block.mediaType},size=${block.data.length}]`;
      })
      .join('\n')
      .trim();
  }

  private parseDataUrl(url: string): { mediaType: string; data: string } | null {
    const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/);
    if (!match) return null;
    const mediaType = match[1] || 'image/png';
    const data = match[2] || '';
    if (!mediaType.startsWith('image/') || !data) return null;
    return { mediaType, data };
  }

  private async imageUrlToBlock(url: string): Promise<MessageContentBlock | null> {
    if (!url || typeof url !== 'string') return null;
    const dataUrl = this.parseDataUrl(url);
    if (dataUrl) {
      return { type: 'image', mediaType: dataUrl.mediaType, data: dataUrl.data };
    }
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const mediaType = (res.headers.get('content-type') || '').split(';')[0].trim() || 'image/png';
      if (!mediaType.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return { type: 'image', mediaType, data: buf.toString('base64') };
    } catch {
      return null;
    }
  }

  private loadGroupMemoryContext(groupId: string): string | null {
    const memDir = this.paths.groupMemoryDir(groupId);
    const sharedDir = this.paths.groupSharedDir(groupId);
    const parts: string[] = [];
    if (fs.existsSync(memDir)) {
      try {
        const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md')).sort();
        for (const f of files) {
          const content = fs.readFileSync(path.join(memDir, f), 'utf8').trim();
          if (content) parts.push(`--- ${f} ---\n${content}`);
        }
      } catch { /* ignore */ }
    }
    const memSection = parts.length > 0 ? `[Group Shared Memory]\n${parts.join('\n\n')}` : '';
    const sharedSection = `[Group Shared Directory]\n共享文件目录: ${sharedDir}\n该目录中的文件对 group 内所有 worker 可读写，使用文件工具时请使用上述绝对路径。`;
    const combined = [memSection, sharedSection].filter(Boolean).join('\n\n');
    return combined || null;
  }

  private stripImageData(content: MessageContent): unknown {
    if (typeof content === 'string') return content;
    return content.map((blk) => {
      if (blk.type === 'text') return { type: 'text', text: blk.text };
      return { type: 'image', _placeholder: true, mediaType: blk.mediaType, byteSize: blk.data.length };
    });
  }

  private buildHttpSessionJsonlRows(params: {
    history: MessageItem[];
    message: string;
    images: ImageInput[];
    assistantContent: MessageContent;
    responseJson: unknown;
    traceId: string;
  }): string[] {
    const now = new Date().toISOString();
    const rows: string[] = [];

    for (let i = 0; i < params.history.length; i++) {
      const item = params.history[i];
      rows.push(JSON.stringify({
        type: 'message',
        message: { role: item.role, content: this.stripImageData(item.content) },
        timestamp: now,
        id: `http-hist-${i}`,
      }));
    }

    const userContent: MessageContent = params.images.length === 0
      ? params.message
      : [
          { type: 'text' as const, text: params.message || '' },
          ...params.images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
        ];
    const userIdx = params.history.length;
    rows.push(JSON.stringify({
      type: 'message',
      message: { role: 'user', content: this.stripImageData(userContent) },
      timestamp: now,
      id: `http-msg-${userIdx}`,
    }));

    rows.push(JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: this.stripImageData(params.assistantContent) },
      timestamp: now,
      id: `http-msg-${userIdx + 1}`,
      parentId: `http-msg-${userIdx}`,
    }));

    const root = params.responseJson && typeof params.responseJson === 'object'
      ? (params.responseJson as Record<string, unknown>)
      : {};
    rows.push(JSON.stringify({
      type: 'custom',
      customType: 'http-run-complete',
      data: {
        runId: typeof root.id === 'string' ? root.id : null,
        traceId: params.traceId,
        sessionId: params.traceId,
        usage: root.usage ?? null,
      },
      timestamp: now,
      id: `http-custom-0`,
    }));

    return rows;
  }

  private normalizeReplyBlocks(blocks: MessageContentBlock[]): MessageContent {
    const normalized = blocks.filter((block) => block.type === 'image' || block.text.trim().length > 0);
    if (normalized.length === 0) return '';
    const hasImage = normalized.some((b) => b.type === 'image');
    if (!hasImage && normalized.every((b) => b.type === 'text')) {
      return normalized.map((b) => b.type === 'text' ? b.text : '').join('\n').trim();
    }
    return normalized;
  }

  private async extractReplyContent(json: unknown): Promise<MessageContent> {
    if (!json || typeof json !== 'object') return '';
    const root = json as {
      choices?: Array<{ message?: { content?: unknown; text?: unknown; images?: unknown }; delta?: { content?: unknown }; text?: unknown }>;
      output_text?: unknown;
      output?: Array<{ type?: string; content?: unknown; text?: unknown; image_url?: unknown; b64_json?: unknown }>;
    };

    const blocks: MessageContentBlock[] = [];
    const pushText = (text: unknown) => {
      if (typeof text !== 'string') return;
      blocks.push({ type: 'text', text });
    };
    const pushImageUrl = async (url: unknown) => {
      if (typeof url !== 'string') return;
      const imageBlock = await this.imageUrlToBlock(url);
      if (imageBlock) blocks.push(imageBlock);
    };
    const pushImageBase64 = (data: unknown, mediaType: unknown) => {
      if (typeof data !== 'string' || !data.trim()) return;
      const type = typeof mediaType === 'string' && mediaType.startsWith('image/') ? mediaType : 'image/png';
      blocks.push({ type: 'image', mediaType: type, data });
    };

    const parseContentArray = async (arr: unknown[]) => {
      for (const block of arr) {
        if (!block || typeof block !== 'object') continue;
        const entry = block as Record<string, unknown>;
        const entryType = typeof entry.type === 'string' ? entry.type : '';
        if (entryType === 'text' || entryType === 'output_text' || entryType === 'input_text') {
          pushText(entry.text);
          continue;
        }
        if (entryType === 'image_url') {
          if (entry.image_url && typeof entry.image_url === 'object') {
            await pushImageUrl((entry.image_url as Record<string, unknown>).url);
          } else {
            await pushImageUrl(entry.image_url);
          }
          await pushImageUrl(entry.url);
          continue;
        }
        if (entryType === 'image') {
          pushImageBase64(entry.b64_json ?? entry.data, entry.media_type ?? entry.mediaType ?? entry.mime_type);
          if (entry.image_url && typeof entry.image_url === 'object') {
            await pushImageUrl((entry.image_url as Record<string, unknown>).url);
          }
          await pushImageUrl(entry.url);
          continue;
        }
        if (typeof entry.text === 'string') pushText(entry.text);
        if (entry.image_url && typeof entry.image_url === 'object') {
          await pushImageUrl((entry.image_url as Record<string, unknown>).url);
        } else {
          await pushImageUrl(entry.image_url);
        }
        await pushImageUrl(entry.url);
        pushImageBase64(entry.b64_json, entry.media_type ?? entry.mediaType ?? entry.mime_type);
      }
    };

    pushText(root.output_text);

    const messageContent = root.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string') {
      pushText(messageContent);
    }
    if (Array.isArray(messageContent)) {
      await parseContentArray(messageContent);
    }
    const messageImages = root.choices?.[0]?.message?.images;
    if (Array.isArray(messageImages)) {
      await parseContentArray(messageImages);
    }

    if (Array.isArray(root.output)) {
      for (const item of root.output) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        pushText(entry.text);
        if (Array.isArray(entry.content)) {
          await parseContentArray(entry.content);
        }
        if (entry.image_url && typeof entry.image_url === 'object') {
          await pushImageUrl((entry.image_url as Record<string, unknown>).url);
        }
        await pushImageUrl(entry.url);
        pushImageBase64(entry.b64_json, entry.media_type ?? entry.mediaType ?? entry.mime_type);
      }
    }

    if (blocks.length > 0) {
      return this.normalizeReplyBlocks(blocks);
    }

    const choiceText = root.choices?.[0]?.message?.text ?? root.choices?.[0]?.text ?? root.choices?.[0]?.delta?.content;
    if (typeof choiceText === 'string' && choiceText.trim()) {
      return choiceText;
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
    const messageImages = firstMsg && Array.isArray(firstMsg.images)
      ? firstMsg.images
      : [];
    const usage = root.usage && typeof root.usage === 'object' ? (root.usage as Record<string, unknown>) : null;
    const usagePayload = usage ? JSON.stringify(usage) : 'none';

    return [
      `keys=${keys}`,
      `choices=${choices.length}`,
      `msgContentType=${msgContentType}`,
      `outputItems=${output.length}`,
      `messageImages=${messageImages.length}`,
      `hasOutputText=${typeof root.output_text === 'string'}`,
      `usage=${usagePayload}`,
    ].join(' ');
  }

  private flattenNumericFields(obj: unknown, prefix = ''): Record<string, number> {
    const out: Record<string, number> = {};
    if (obj === null || obj === undefined) return out;

    if (typeof obj === 'number' && Number.isFinite(obj)) {
      if (prefix) out[prefix] = Math.trunc(obj);
      return out;
    }
    if (typeof obj === 'string') {
      const trimmed = obj.trim();
      if (!trimmed) return out;
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && prefix) out[prefix] = Math.trunc(parsed);
      return out;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        const key = prefix ? `${prefix}[${idx}]` : `[${idx}]`;
        Object.assign(out, this.flattenNumericFields(item, key));
      });
      return out;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const key = prefix ? `${prefix}.${k}` : k;
        Object.assign(out, this.flattenNumericFields(v, key));
      }
      return out;
    }
    return out;
  }

  private pickMetricWithSource(flat: Record<string, number>, rules: Array<(pathLc: string) => number>): { value: number | null; source: string | null } {
    let bestScore = 0;
    let bestSource: string | null = null;
    let bestValue: number | null = null;
    for (const [path, value] of Object.entries(flat)) {
      const pathLc = path.toLowerCase();
      let score = 0;
      for (const rule of rules) {
        try {
          score = Math.max(score, Number(rule(pathLc)) || 0);
        } catch {
          // ignore bad rule
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestSource = path;
        bestValue = value;
      }
    }
    if (bestScore <= 0) return { value: null, source: null };
    return { value: bestValue, source: bestSource };
  }

  private inferWorkerIdFromGatewayModel(gatewayModel: string): string | null {
    const trimmed = (gatewayModel || '').trim();
    if (!trimmed.includes('/')) return null;
    const parts = trimmed.split('/').filter(Boolean);
    return parts.length > 1 ? parts[1] : null;
  }

  private buildRuntimeUsageByTraceRecord(params: {
    traceId?: string;
    gatewayModel: string;
    configuredModel: string;
    message: string;
    historyCount: number;
    imageCount: number;
    responseJson: unknown;
  }): Record<string, unknown> {
    const { traceId, gatewayModel, configuredModel, message, historyCount, imageCount, responseJson } = params;
    const root = responseJson && typeof responseJson === 'object' ? (responseJson as Record<string, unknown>) : {};
    const usage = root.usage && typeof root.usage === 'object' ? (root.usage as Record<string, unknown>) : {};
    const flat = this.flattenNumericFields(root);

    const systemPromptChars = this.pickMetricWithSource(flat, [
      (p) => (p.includes('systemprompt.chars') ? 100 : 0),
      (p) => (p.includes('system_prompt') && p.endsWith('chars') ? 90 : 0),
    ]);
    const projectContextChars = this.pickMetricWithSource(flat, [
      (p) => (p.includes('projectcontextchars') && !p.includes('nonprojectcontextchars') ? 100 : 0),
    ]);
    const nonProjectContextChars = this.pickMetricWithSource(flat, [
      (p) => (p.includes('nonprojectcontextchars') ? 100 : 0),
    ]);
    const toolsSchemaChars = this.pickMetricWithSource(flat, [
      (p) => (p.includes('tools.schemachars') ? 100 : 0),
      (p) => (p.includes('tool') && p.includes('schemachars') ? 80 : 0),
    ]);
    const skillsPromptChars = this.pickMetricWithSource(flat, [
      (p) => (p.includes('skills.promptchars') ? 100 : 0),
      (p) => (p.includes('skill') && p.includes('promptchars') ? 80 : 0),
    ]);
    const userTextChars = this.pickMetricWithSource(flat, [
      (p) => (p.includes('usertextchars') ? 100 : 0),
      (p) => (p.endsWith('requestmeta.textlen') ? 80 : 0),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      source: 'chatHttp.runtime',
      traceId: traceId || null,
      workerId: this.inferWorkerIdFromGatewayModel(gatewayModel),
      gatewayModel,
      configuredModel,
      runId: typeof root.id === 'string' ? root.id : null,
      requestMeta: {
        textLen: message.length,
        historyCount,
        imageCount,
      },
      usage,
      promptReport: {
        userTextChars: userTextChars.value,
        userTextCharsSource: userTextChars.source,
        systemPromptChars: systemPromptChars.value,
        systemPromptCharsSource: systemPromptChars.source,
        projectContextChars: projectContextChars.value,
        projectContextCharsSource: projectContextChars.source,
        nonProjectContextChars: nonProjectContextChars.value,
        nonProjectContextCharsSource: nonProjectContextChars.source,
        toolsSchemaChars: toolsSchemaChars.value,
        toolsSchemaCharsSource: toolsSchemaChars.source,
        skillsPromptChars: skillsPromptChars.value,
        skillsPromptCharsSource: skillsPromptChars.source,
      },
    };
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
    configuredModel: string,
    promptContextPath: string,
    message: string,
    images: ImageInput[],
    history: MessageItem[],
    onLog?: (step: string) => void,
    traceId?: string,
    groupId?: string,
    workerId?: string
  ): Promise<MessageContent> {
    const userContent: MessageContent = images.length === 0
      ? message
      : [
          { type: 'text', text: message || '请描述这张图片的主要内容。' },
          ...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
        ];

    const groupCtx = groupId ? this.loadGroupMemoryContext(groupId) : null;
    const messages = [
      ...(groupCtx ? [{ role: 'system', content: groupCtx }] : []),
      ...history.map((item) => ({ role: item.role, content: this.toOpenAIContent(item.content) })),
      { role: 'user', content: this.toOpenAIContent(userContent) },
    ];

    if (this.isDirectImageModel(configuredModel)) {
      const json = await this.chatHttpDirectOpenRouter(configuredModel, messages, onLog, traceId);
      const runtimeUsageRecord = this.buildRuntimeUsageByTraceRecord({
        traceId,
        gatewayModel,
        configuredModel,
        message,
        historyCount: history.length,
        imageCount: images.length,
        responseJson: json,
      });
      this.paths.writeGatewayRuntimeUsageByTrace(runtimeUsageRecord, traceId);
      onLog?.(`resp shape ${this.summarizeResponseShape(json)}`);
      const content = await this.extractReplyContent(json);
      const text = this.summarizeMessageContent(content) || '(无回复内容)';
      onLog?.(`reply len=${text.length}`);
      if (traceId) {
        const sessionRows = this.buildHttpSessionJsonlRows({ history, message, images, assistantContent: content || '(无回复内容)', responseJson: json, traceId });
        this.paths.writeHttpSessionJsonl(traceId, sessionRows);
      }
      return content || '(无回复内容)';
    }

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
    if (traceId) {
      headers['x-openclaw-trace-id'] = traceId;
    }
    const workerIdFromModel = gatewayModel.startsWith('openclaw/') ? gatewayModel.slice('openclaw/'.length) : null;
    if (workerIdFromModel) {
      const epoch = groupId ? this.sessions.getGroupSessionEpoch(workerIdFromModel, groupId) : 0;
      const sessionSuffix = groupId ? `g${groupId.slice(-8)}-e${epoch}` : `main`;
      headers['x-openclaw-session-key'] = `agent:${workerIdFromModel}:${sessionSuffix}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.paths.httpTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: gatewayModel, messages, stream: true }),
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

    const contentType = res.headers.get('content-type') ?? '';
    const isSSE = contentType.includes('text/event-stream');
    onLog?.(`resp content-type=${contentType} sse=${isSSE}`);

    let replyContent: MessageContent;

    if (isSSE) {
      const win = BrowserWindow.getAllWindows()[0];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let sseBuffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              const chunk = parsed.choices?.[0]?.delta?.content;
              if (chunk) {
                accumulated += chunk;
                if (win && !win.isDestroyed() && workerId) {
                  win.webContents.send('chat:chunk', { workerId, chunk, groupId: groupId ?? null, msgId: traceId ?? null });
                }
              }
            } catch { /* ignore malformed SSE lines */ }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      replyContent = accumulated || '(无回复内容)';
    } else {
      const json = await res.json() as unknown;
      const runtimeUsageRecord = this.buildRuntimeUsageByTraceRecord({
        traceId,
        gatewayModel,
        configuredModel,
        message,
        historyCount: history.length,
        imageCount: images.length,
        responseJson: json,
      });
      this.paths.writeGatewayRuntimeUsageByTrace(runtimeUsageRecord, traceId);
      onLog?.(`resp shape ${this.summarizeResponseShape(json)}`);
      const content = await this.extractReplyContent(json);
      const text = this.summarizeMessageContent(content) || '(无回复内容)';
      onLog?.(`reply len=${text.length}`);
      if (traceId) {
        const sessionRows = this.buildHttpSessionJsonlRows({ history, message, images, assistantContent: content || '(无回复内容)', responseJson: json, traceId });
        this.paths.writeHttpSessionJsonl(traceId, sessionRows);
      }
      replyContent = content || '(无回复内容)';
    }

    onLog?.(`reply len=${typeof replyContent === 'string' ? replyContent.length : replyContent.length}`);
    if (workerIdFromModel) {
      const epoch = groupId ? this.sessions.getGroupSessionEpoch(workerIdFromModel, groupId) : 0;
      const sessionSuffix = groupId ? `g${groupId.slice(-8)}-e${epoch}` : 'main';
      const sessionKey = `agent:${workerIdFromModel}:${sessionSuffix}`;
      setImmediate(() => this.sessions.compactAgentSession(workerIdFromModel!, sessionKey));
    }
    return replyContent;
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
        if (!compact) return;
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
        if (!clean || clean.startsWith('{') || /^[\[\]{}],?$/.test(clean)) return;
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
          this.getConfiguredModelFull(selected.id) || '(unset)',
          this.paths.workerAgentWorkspacePath(selected.id),
          trimmed,
          images ?? [],
          history ?? [],
          (step) => log(`HTTP ${step}`),
          traceId,
          groupId,
          selected.id
        );
        const replyText = this.summarizeMessageContent(reply) || '(无回复内容)';
        log(`DONE reply-len=${replyText.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: replyText, stderr: '', cmd: `POST /v1/chat/completions`, reply };
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
          this.getConfiguredModelFull(selected.id) || '(unset)',
          this.paths.workerAgentWorkspacePath(selected.id),
          trimmed,
          images ?? [],
          history ?? [],
          (step) => log(`HTTP ${step}`),
          traceId,
          groupId,
          selected.id
        );
        const replyText = this.summarizeMessageContent(reply) || '(无回复内容)';
        log(`DONE reply-len=${replyText.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: replyText, stderr: '', cmd: `POST /v1/chat/completions`, reply };
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
    const sanitizedGroupMessages: Record<string, unknown[]> = {};
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
    for (const [groupId, list] of Object.entries(data?.groupMessages ?? {})) {
      sanitizedGroupMessages[groupId] = (Array.isArray(list) ? list : []).map((item) => {
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
        groupMessages: sanitizedGroupMessages,
      }),
      'utf8'
    );
  }

  async saveImageFromUrl(url: string): Promise<{ ok: boolean; canceled?: boolean; savedPath?: string; error?: string }> {
    try {
      const resp = await net.fetch(url);
      if (!resp.ok) return { ok: false, error: `下载失败: ${resp.status} ${resp.statusText}` };
      const buffer = Buffer.from(await resp.arrayBuffer());

      const contentType = resp.headers.get('content-type') || '';
      let ext = 'png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
      else if (contentType.includes('gif')) ext = 'gif';
      else if (contentType.includes('webp')) ext = 'webp';
      else if (contentType.includes('svg')) ext = 'svg';
      else if (contentType.includes('bmp')) ext = 'bmp';
      const urlExt = url.split('/').pop()?.split('?')[0]?.split('.').pop()?.toLowerCase();
      if (urlExt && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(urlExt)) {
        ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
      }

      const rawName = url.split('/').pop()?.split('?')[0] || `image.${ext}`;
      const baseName = rawName.replace(/[\\/:*?"<>|]/g, '_');
      const defaultPath = path.join(app.getPath('documents'), baseName);

      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: '主窗口不可用' };

      const saveResult = await dialog.showSaveDialog(win, {
        title: '保存图片',
        defaultPath,
        filters: [{ name: 'Image', extensions: [ext, 'png', 'jpg', 'webp'] }],
      });
      if (saveResult.canceled || !saveResult.filePath) return { ok: false, canceled: true };

      fs.writeFileSync(saveResult.filePath, buffer);
      return { ok: true, savedPath: saveResult.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async saveImage(msgId: string, dataUrl: string): Promise<{ ok: boolean; canceled?: boolean; savedPath?: string; error?: string }> {
    const trimmed = (dataUrl || '').trim();
    if (!trimmed.startsWith('data:image/')) {
      return { ok: false, error: '图片数据无效' };
    }

    const image = nativeImage.createFromDataURL(trimmed);
    if (image.isEmpty()) {
      return { ok: false, error: '图片解码失败' };
    }

    const baseName = ((msgId || 'image').trim() || 'image').replace(/[\\/:*?"<>|]/g, '_');
    const defaultPath = path.join(app.getPath('documents'), `${baseName}.png`);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { ok: false, error: '主窗口不可用' };

    const saveResult = await dialog.showSaveDialog(win, {
      title: '保存图片',
      defaultPath,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, canceled: true };
    }

    const savePath = saveResult.filePath.toLowerCase().endsWith('.png')
      ? saveResult.filePath
      : `${saveResult.filePath}.png`;

    try {
      fs.writeFileSync(savePath, image.toPNG());
      return { ok: true, savedPath: savePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
