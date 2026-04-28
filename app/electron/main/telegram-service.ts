import fs from 'node:fs';
import type { ExecResult, TelegramBotInfo, TelegramChannel, TelegramAddResult, AgentBindResult } from './types';
import type { OpenClawPaths } from './paths';
import type { WorkerService } from './worker-service';

export class TelegramService {
  constructor(
    private readonly paths: OpenClawPaths,
    private readonly workers: WorkerService
  ) {}

  hasTelegramChannelConfigured(): boolean {
    const configPath = this.paths.openclawConfigPath(this.paths.userOpenClawHome);
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const channels = raw.channels && typeof raw.channels === 'object'
        ? (raw.channels as Record<string, unknown>)
        : {};
      return Object.keys(channels).some((k) => k === 'telegram' || k.startsWith('telegram:'));
    } catch {
      return false;
    }
  }

  maybeMigrateTelegramConfigToPrimaryHome(): void {
    const primaryConfig = this.paths.openclawConfigPath(this.paths.userOpenClawHome);
    const telegramConfig = this.paths.openclawConfigPath(this.paths.userTelegramOpenClawHome);
    if (!fs.existsSync(primaryConfig) || !fs.existsSync(telegramConfig)) return;

    try {
      const primaryRaw = JSON.parse(fs.readFileSync(primaryConfig, 'utf8')) as Record<string, unknown>;
      const telegramRaw = JSON.parse(fs.readFileSync(telegramConfig, 'utf8')) as Record<string, unknown>;
      let changed = false;

      const telegramChannels =
        telegramRaw.channels && typeof telegramRaw.channels === 'object'
          ? (telegramRaw.channels as Record<string, unknown>)
          : {};
      const primaryChannels =
        primaryRaw.channels && typeof primaryRaw.channels === 'object'
          ? { ...(primaryRaw.channels as Record<string, unknown>) }
          : {};
      for (const [key, value] of Object.entries(telegramChannels)) {
        if (key !== 'telegram' && !key.startsWith('telegram:')) continue;
        if (JSON.stringify(primaryChannels[key]) === JSON.stringify(value)) continue;
        primaryChannels[key] = value;
        changed = true;
      }
      if (Object.keys(primaryChannels).length > 0) {
        primaryRaw.channels = primaryChannels;
      }

      const telegramBindings = Array.isArray(telegramRaw.bindings)
        ? telegramRaw.bindings.filter((b) => {
            const match = (b as { match?: { channel?: string } })?.match;
            return match?.channel === 'telegram';
          })
        : [];
      if (telegramBindings.length > 0) {
        const primaryBindings = Array.isArray(primaryRaw.bindings)
          ? [...primaryRaw.bindings]
          : [];
        const nextBindings = [
          ...primaryBindings.filter((b) => {
            const match = (b as { match?: { channel?: string } })?.match;
            return match?.channel !== 'telegram';
          }),
          ...telegramBindings,
        ];
        if (JSON.stringify(primaryBindings) !== JSON.stringify(nextBindings)) {
          primaryRaw.bindings = nextBindings;
          changed = true;
        }
      }

      const pluginRaw =
        primaryRaw.plugins && typeof primaryRaw.plugins === 'object'
          ? (primaryRaw.plugins as Record<string, unknown>)
          : {};
      const entriesRaw =
        pluginRaw.entries && typeof pluginRaw.entries === 'object'
          ? (pluginRaw.entries as Record<string, unknown>)
          : {};
      const telegramPlugin =
        entriesRaw.telegram && typeof entriesRaw.telegram === 'object'
          ? { ...(entriesRaw.telegram as Record<string, unknown>) }
          : {};
      if (telegramPlugin.enabled !== true) {
        telegramPlugin.enabled = true;
        entriesRaw.telegram = telegramPlugin;
        pluginRaw.entries = entriesRaw;
        primaryRaw.plugins = pluginRaw;
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(primaryConfig, `${JSON.stringify(primaryRaw, null, 2)}\n`, 'utf8');
      }
    } catch {
      // ignore migration errors
    }
  }

  private async fetchTelegramBotInfo(token: string): Promise<TelegramBotInfo | null> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const json = await res.json() as { ok: boolean; result?: { id: number; username: string; first_name: string } };
      if (!json.ok || !json.result) return null;
      return { id: json.result.id, username: json.result.username, firstName: json.result.first_name };
    } catch {
      return null;
    }
  }

  private readChannelToken(accountId: string): string {
    const configPath = this.paths.openclawConfigPath(this.paths.userOpenClawHome);
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const key = accountId === 'default' ? 'telegram' : `telegram:${accountId}`;
      return raw?.channels?.[key]?.botToken ?? '';
    } catch {
      return '';
    }
  }

  private readTelegramBinding(accountId: string): string | undefined {
    const configPath = this.paths.openclawConfigPath(this.paths.userOpenClawHome);
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const bindings: Array<{ agentId?: string; match?: { channel?: string; account?: string } }> = raw?.bindings ?? [];
      const binding = bindings.find((b) => {
        if (b.match?.channel !== 'telegram') return false;
        return accountId === 'default' ? !b.match?.account : b.match?.account === accountId;
      });
      return binding?.agentId;
    } catch {
      return undefined;
    }
  }

  private async listTelegramAccountIds(): Promise<string[]> {
    const res = await this.paths.runOpenClawTelegram(['channels', 'list', '--json']);
    for (const raw of [res.stdout, res.stderr]) {
      if (!raw?.trim()) continue;
      try {
        const parsed = JSON.parse(raw.trim()) as { chat?: { telegram?: string[] } };
        return parsed?.chat?.telegram ?? [];
      } catch {
        continue;
      }
    }
    return [];
  }

  private parseJsonFromExec<T>(res: ExecResult): T | null {
    for (const raw of [res.stdout, res.stderr]) {
      if (!raw?.trim()) continue;
      try {
        return JSON.parse(raw.trim()) as T;
      } catch {
        continue;
      }
    }
    return null;
  }

  async listTelegramChannels(): Promise<TelegramChannel[]> {
    const accountIds = await this.listTelegramAccountIds();

    return Promise.all(
      accountIds.map(async (accountId) => {
        const token = this.readChannelToken(accountId);
        const bot = token ? await this.fetchTelegramBotInfo(token) : null;
        const agentId = this.readTelegramBinding(accountId);
        return { accountId, bot, agentId };
      })
    );
  }

  async addTelegramChannel(token: string, workerId?: string): Promise<TelegramAddResult> {
    const trimmed = (token || '').trim();
    if (!trimmed) return { ok: false, error: 'Token 不能为空' };

    const beforeAccounts = await this.listTelegramAccountIds();

    const res = await this.paths.runOpenClawTelegram(['channels', 'add', '--channel', 'telegram', '--token', trimmed]);
    if (res.code !== 0) {
      return { ok: false, error: res.stderr || '写入配置失败' };
    }

    const afterAccounts = await this.listTelegramAccountIds();
    const addedAccount = afterAccounts.find((id) => !beforeAccounts.includes(id));

    const workerList = this.workers.listWorkers();
    const targetAgent =
      (workerId ? workerList.find((w) => w.id === workerId) : undefined) ??
      workerList.find((w) => w.mode === 'agent') ??
      workerList[0];
    if (targetAgent) {
      const ensureAgentRes = await this.paths.runOpenClawTelegram([
        'agents', 'add', targetAgent.id,
        '--workspace', this.paths.workerAgentWorkspacePath(targetAgent.id),
        '--non-interactive', '--json'
      ]);
      if (ensureAgentRes.code !== 0) {
        const ensureRaw = `${ensureAgentRes.stdout}\n${ensureAgentRes.stderr}`;
        if (!/already exists/i.test(ensureRaw)) {
          return { ok: false, error: ensureAgentRes.stderr || '初始化 Telegram Agent 失败' };
        }
      }

      const bindTarget = addedAccount && addedAccount !== 'default'
        ? `telegram:${addedAccount}`
        : 'telegram';
      const bindArgs = [
        'agents', 'bind',
        '--agent', targetAgent.id,
        '--bind', bindTarget,
        '--json'
      ];
      let bindRes = await this.paths.runOpenClawTelegram(bindArgs);
      if (bindRes.code !== 0) {
        return { ok: false, error: bindRes.stderr || bindRes.stdout || '绑定 Worker 失败' };
      }

      let bindJson = this.parseJsonFromExec<AgentBindResult>(bindRes);
      const conflicts = bindJson?.conflicts ?? [];
      if (conflicts.length > 0) {
        for (const line of conflicts) {
          const matched = line.match(/^([^\s]+)\s+\(agent=([^\)]+)\)$/);
          if (!matched) continue;
          const conflictBind = matched[1];
          const conflictAgent = matched[2];
          if (!conflictBind || !conflictAgent || conflictAgent === targetAgent.id) continue;
          const unbindRes = await this.paths.runOpenClawTelegram([
            'agents', 'unbind',
            '--agent', conflictAgent,
            '--bind', conflictBind,
            '--json'
          ]);
          if (unbindRes.code !== 0) {
            return { ok: false, error: unbindRes.stderr || unbindRes.stdout || '解绑旧 Worker 失败' };
          }
        }

        bindRes = await this.paths.runOpenClawTelegram(bindArgs);
        if (bindRes.code !== 0) {
          return { ok: false, error: bindRes.stderr || bindRes.stdout || '绑定 Worker 失败' };
        }
        bindJson = this.parseJsonFromExec<AgentBindResult>(bindRes);
        if ((bindJson?.conflicts ?? []).length > 0) {
          return { ok: false, error: `绑定冲突: ${(bindJson?.conflicts ?? []).join(', ')}` };
        }
      }
    }

    await this.paths.runOpenClaw([
      'config', 'set', 'plugins.entries.telegram.enabled', 'true'
    ]);

    const bot = await this.fetchTelegramBotInfo(trimmed);
    return { ok: true, bot: bot ?? undefined };
  }

  async removeTelegramChannel(accountId: string): Promise<{ ok: boolean; error?: string }> {
    const args = ['channels', 'remove', '--channel', 'telegram', '--delete'];
    if (accountId !== 'default') args.push('--account', accountId);
    const res = await this.paths.runOpenClawTelegram(args);
    if (res.code !== 0) return { ok: false, error: res.stderr };

    if (!this.hasTelegramChannelConfigured()) {
      await this.paths.runOpenClaw([
        'config', 'set', 'plugins.entries.telegram.enabled', 'false'
      ]);
    }
    return { ok: true };
  }
}
