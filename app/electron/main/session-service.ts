import path from 'node:path';
import fs from 'node:fs';
import type { OpenClawPaths } from './paths';

export class SessionService {
  private readonly agentSessionEpoch = new Map<string, number>();
  private readonly agentGroupSessionEpoch = new Map<string, number>();

  constructor(private readonly paths: OpenClawPaths) {}

  getDesktopSessionId(agentId: string, groupId?: string, model?: string): string {
    const safeModel = (model || 'default').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64);
    const safeAgent = (agentId || 'agent').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64);
    if (groupId) {
      const safeGroup = groupId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32);
      const epoch = this.agentGroupSessionEpoch.get(`${agentId}:${groupId}`) ?? 0;
      return `desktop-ui-${safeAgent}-${safeModel}-g${safeGroup}-e${epoch}`;
    }
    const epoch = this.agentSessionEpoch.get(agentId) ?? 0;
    return `desktop-ui-${safeAgent}-${safeModel}-e${epoch}`;
  }

  getGroupSessionEpoch(agentId: string, groupId: string): number {
    return this.agentGroupSessionEpoch.get(`${agentId}:${groupId}`) ?? 0;
  }

  clearGroupSession(agentId: string, groupId: string): void {
    const key = `${agentId}:${groupId}`;
    this.agentGroupSessionEpoch.set(key, (this.agentGroupSessionEpoch.get(key) ?? 0) + 1);
  }

  clearAgentSessionSnapshot(agentId: string): void {
    const sessionsDir = path.join(
      this.paths.userOpenClawHome, '.openclaw', 'agents', agentId, 'sessions'
    );
    const sessionsJson = path.join(sessionsDir, 'sessions.json');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(sessionsJson, '{}', 'utf8');
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.match(/\.jsonl(\..+)?$/)) continue;
      try {
        fs.rmSync(path.join(sessionsDir, entry.name), { force: true });
      } catch { /* ignore */ }
    }
    this.agentSessionEpoch.set(agentId, (this.agentSessionEpoch.get(agentId) ?? 0) + 1);
  }

  compactAgentSession(agentId: string, sessionKey: string): void {
    const sessionsDir = path.join(
      this.paths.userOpenClawHome, '.openclaw', 'agents', agentId, 'sessions'
    );
    if (!fs.existsSync(sessionsDir)) return;

    let targetFile: string | undefined;
    try {
      const smap = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
      const entry = smap[sessionKey];
      if (entry?.sessionFile) targetFile = entry.sessionFile;
    } catch { return; }

    if (!targetFile || !fs.existsSync(targetFile)) return;

    try {
      const lines = fs.readFileSync(targetFile, 'utf8').split('\n');
      const out: string[] = [];
      for (const line of lines) {
        if (!line.trim()) { out.push(line); continue; }
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { out.push(line); continue; }

        if (obj.type === 'message') {
          const msg = obj.message as Record<string, unknown>;
          const role = msg?.role as string;

          if (role === 'toolResult') continue;

          if (role === 'assistant') {
            const content = msg?.content;
            if (Array.isArray(content)) {
              const textBlocks = (content as Array<{ type: string }>).filter(b => b?.type === 'text');
              if (textBlocks.length === 0) continue;
              out.push(JSON.stringify({ ...obj, message: { ...msg, content: textBlocks } }));
              continue;
            }
          }
        }
        out.push(line);
      }
      fs.writeFileSync(targetFile, out.join('\n'), 'utf8');
    } catch { /* ignore */ }
  }

  clearAllAgentSessionSnapshots(): void {
    const agentsRoot = path.join(this.paths.userOpenClawHome, '.openclaw', 'agents');
    if (!fs.existsSync(agentsRoot)) return;
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      this.clearAgentSessionSnapshot(entry.name);
    }
  }
}
