import path from 'node:path';
import fs from 'node:fs';
import { app, shell } from 'electron';
import type { SaveKeyResult } from './types';
import type { OpenClawPaths } from './paths';
import type { SessionService } from './session-service';
import type { GatewayService } from './gateway-service';

export class ConfigService {
  constructor(
    private readonly paths: OpenClawPaths,
    private readonly sessions: SessionService,
    private readonly gateway: GatewayService
  ) {}

  private get coordinatorConfigPath() {
    return path.join(app.getPath('userData'), 'coordinator-config.json');
  }

  getConfiguredModelFull(): string {
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const full: string = raw?.agents?.defaults?.model ?? '';
      return typeof full === 'string' ? full : '';
    } catch {
      return '';
    }
  }

  getModel(): string {
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const full: string = raw?.agents?.defaults?.model ?? '';
      return full.startsWith('openrouter/') ? full.slice('openrouter/'.length) : full;
    } catch {
      return '';
    }
  }

  getWorkerModel(workerId: string): string {
    const id = (workerId || '').trim();
    if (!id) return this.getModel();
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const agents = Array.isArray(raw?.agents?.list) ? raw.agents.list : [];
      const found = agents.find((a: { id?: string; model?: string }) => a?.id === id);
      const full = typeof found?.model === 'string' ? found.model : '';
      if (!full) return this.getModel();
      return full.startsWith('openrouter/') ? full.slice('openrouter/'.length) : full;
    } catch {
      return this.getModel();
    }
  }

  getCoordinatorModel(): string {
    try {
      const raw = JSON.parse(fs.readFileSync(this.coordinatorConfigPath, 'utf8'));
      return typeof raw?.model === 'string' ? raw.model : '';
    } catch {
      return '';
    }
  }

  async setCoordinatorModel(model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      fs.writeFileSync(this.coordinatorConfigPath, JSON.stringify({ model: model.trim() }, null, 2), 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async setModel(model: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.paths.runOpenClaw(['config', 'set', 'agents.defaults.model', `openrouter/${model}`]);
    if (res.code !== 0) return { ok: false, error: res.stderr };
    const saved = this.getModel();
    if (saved !== model) {
      return { ok: false, error: `配置未能写入：期望 ${model}，实际读到 ${saved || '(空)'}` };
    }
    this.sessions.clearAllAgentSessionSnapshots();
    await this.gateway.restartGateway();
    return { ok: true };
  }

  async setWorkerModel(workerId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const id = (workerId || '').trim();
    const selected = (model || '').trim();
    if (!id) return { ok: false, error: 'workerId 不能为空' };
    if (!selected) return { ok: false, error: 'model 不能为空' };

    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : {};
      raw.agents = raw.agents || {};
      raw.agents.list = Array.isArray(raw.agents.list) ? raw.agents.list : [];

      const full = `openrouter/${selected}`;
      const idx = raw.agents.list.findIndex((a: { id?: string }) => a?.id === id);
      if (idx >= 0) {
        raw.agents.list[idx] = { ...raw.agents.list[idx], model: full };
      } else {
        raw.agents.list.push({ id, model: full });
      }

      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
      const saved = this.getWorkerModel(id);
      if (saved !== selected) {
        return { ok: false, error: `配置未能写入：期望 ${selected}，实际读到 ${saved || '(空)'}` };
      }

      this.sessions.clearAgentSessionSnapshot(id);
      await this.gateway.restartGateway();
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getOpenRouterKey(): string {
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return raw?.models?.providers?.openrouter?.apiKey ?? '';
    } catch {
      return '';
    }
  }

  async saveOpenRouterKey(apiKey: string): Promise<SaveKeyResult> {
    const key = (apiKey || '').trim();
    if (!key) {
      return {
        ok: false,
        detail: { code: -1, stdout: '', stderr: 'API Key 不能为空', cmd: '' },
        modelDetail: { code: -1, stdout: '', stderr: 'API Key 不能为空', cmd: '' }
      };
    }

    const batchJson = JSON.stringify([
      { path: 'models.providers.openrouter.baseUrl', value: 'https://openrouter.ai/api/v1' },
      { path: 'models.providers.openrouter.apiKey', value: key },
      { path: 'models.providers.openrouter.models', value: [] }
    ]);
    const detail = await this.paths.runOpenClaw(['config', 'set', '--batch-json', batchJson]);

    const modelDetail = await this.paths.runOpenClaw(['config', 'set', 'agents.defaults.model', 'openrouter/xiaomi/mimo-v2-pro']);

    return {
      ok: detail.code === 0 && modelDetail.code === 0,
      detail,
      modelDetail
    };
  }

  debugInfo() {
    return {
      isDev: this.paths.isDev,
      resourcesRuntime: this.paths.resourcesRuntime,
      embeddedNodePath: this.paths.embeddedNodePath,
      openclawCliPath: this.paths.openclawCliPath,
      userRuntimeRoot: this.paths.userRuntimeRoot,
      userWorkspace: this.paths.userWorkspace,
      userOpenClawHome: this.paths.userOpenClawHome,
      openclawProfile: this.paths.openclawProfile,
      launchdLabel: `ai.openclaw.gateway.${this.paths.openclawProfile}`,
      runtimeVersion: this.paths.runtimeVersion,
      embeddedNodeExists: fs.existsSync(this.paths.embeddedNodePath),
      openclawCliExists: fs.existsSync(this.paths.openclawCliPath)
    };
  }
}
