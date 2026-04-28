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

  clearAllAgentSessionSnapshots(): void {
    const agentsRoot = path.join(this.paths.userOpenClawHome, '.openclaw', 'agents');
    if (!fs.existsSync(agentsRoot)) return;
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      this.clearAgentSessionSnapshot(entry.name);
    }
  }
}
