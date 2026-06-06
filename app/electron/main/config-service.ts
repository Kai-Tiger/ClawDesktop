import path from 'node:path';
import fs from 'node:fs';
import { app, shell } from 'electron';
import type { SaveKeyResult } from './types';
import type { OpenClawPaths } from './paths';
import type { SessionService } from './session-service';
import type { GatewayService } from './gateway-service';

export class ConfigService {
  private readonly imagePresetModel = 'openai/gpt-5.4-image-2';

  private readonly workerToolCatalog = [
    'cron',
    'browser',
    'message',
    'read',
    'edit',
    'write',
    'exec',
    'process',
    'canvas',
    'nodes',
    'gateway',
    'tts',
    'web_fetch',
    'web_search',
    'webfetch',
    'memory_search',
    'memory_get',
    'memory_set',
    'memory_list',
    'memory_delete',
    'agents_list',
    'sessions_list',
    'sessions_history',
    'sessions_send',
    'sessions_yield',
    'sessions_spawn',
    'subagents',
    'session_status',
  ];

  private readonly imagePresetToolDeny = [
    'read',
    'edit',
    'write',
    'exec',
    'process',
    'canvas',
    'nodes',
    'message',
    'tts',
    'memory_get',
    'memory_set',
    'memory_list',
    'memory_delete',
    'session_status',
    'web_search',
    'web_fetch',
    'webfetch',
    'sessions_spawn',
    'sessions_yield',
  ];

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

  getWorkerConfiguredModelFull(workerId: string): string {
    const id = (workerId || '').trim();
    if (!id) return this.getConfiguredModelFull();
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const agents = Array.isArray(raw?.agents?.list) ? raw.agents.list : [];
      const idLower = id.toLowerCase();
      const found = agents.find((a: { id?: string; model?: string }) => (a?.id || '').toLowerCase() === idLower);
      const full = typeof found?.model === 'string' ? found.model : '';
      return full || this.getConfiguredModelFull();
    } catch {
      return this.getConfiguredModelFull();
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
      const idLower = id.toLowerCase();
      const found = agents.find((a: { id?: string; model?: string }) => (a?.id || '').toLowerCase() === idLower);
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
      const idLower = id.toLowerCase();
      const idx = raw.agents.list.findIndex((a: { id?: string }) => (a?.id || '').toLowerCase() === idLower);
      const existing = idx >= 0 ? { ...raw.agents.list[idx] } : { id };
      existing.model = full;
      // If image preset tools were active (profile: 'minimal'), restore default tool restrictions
      const existingTools = existing.tools as Record<string, unknown> | undefined;
      if (existingTools && existingTools.profile === 'minimal') {
        existing.tools = { deny: [...this.paths.deniedSubagentTools] };
      }
      if (idx >= 0) {
        raw.agents.list[idx] = existing;
      } else {
        raw.agents.list.push(existing);
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

  getWorkerTools(workerId: string): { tools: Array<{ id: string; enabled: boolean }> } {
    const id = (workerId || '').trim();
    if (!id) return { tools: this.workerToolCatalog.map((toolId) => ({ id: toolId, enabled: true })) };

    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : {};
      const agents = Array.isArray(raw?.agents?.list) ? raw.agents.list : [];
      const idLower = id.toLowerCase();
      const found = agents.find((a: { id?: string; tools?: unknown }) => (a?.id || '').toLowerCase() === idLower);
      const toolsObj = found?.tools && typeof found.tools === 'object'
        ? (found.tools as Record<string, unknown>)
        : {};
      const denyList = Array.isArray(toolsObj.deny)
        ? toolsObj.deny.filter((v: unknown): v is string => typeof v === 'string')
        : [];
      const denySet = new Set(denyList);
      return {
        tools: this.workerToolCatalog.map((toolId) => ({ id: toolId, enabled: !denySet.has(toolId) })),
      };
    } catch {
      return { tools: this.workerToolCatalog.map((toolId) => ({ id: toolId, enabled: true })) };
    }
  }

  async setWorkerToolEnabled(workerId: string, toolId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const id = (workerId || '').trim();
    const tool = (toolId || '').trim();
    if (!id) return { ok: false, error: 'workerId 不能为空' };
    if (!tool) return { ok: false, error: 'toolId 不能为空' };
    if (!this.workerToolCatalog.includes(tool)) return { ok: false, error: `不支持的工具: ${tool}` };

    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : {};
      raw.agents = raw.agents || {};
      raw.agents.list = Array.isArray(raw.agents.list) ? raw.agents.list : [];

      const idLower = id.toLowerCase();
      const idx = raw.agents.list.findIndex((a: { id?: string }) => (a?.id || '').toLowerCase() === idLower);
      const existing = idx >= 0 ? { ...raw.agents.list[idx] } : { id };

      const toolsObj = existing.tools && typeof existing.tools === 'object'
        ? { ...(existing.tools as Record<string, unknown>) }
        : {};
      const denyList = Array.isArray(toolsObj.deny)
        ? toolsObj.deny.filter((v: unknown): v is string => typeof v === 'string')
        : [];
      const denySet = new Set(denyList);

      if (enabled) {
        denySet.delete(tool);
      } else {
        denySet.add(tool);
      }

      toolsObj.deny = [...denySet];
      if (toolsObj.profile === 'minimal') {
        toolsObj.profile = 'custom';
      }
      existing.tools = toolsObj;

      if (idx >= 0) {
        raw.agents.list[idx] = existing;
      } else {
        raw.agents.list.push(existing);
      }

      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
      this.sessions.clearAgentSessionSnapshot(id);
      await this.gateway.restartGateway();
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async applyWorkerImagePreset(workerId: string, model?: string): Promise<{ ok: boolean; error?: string; model?: string }> {
    const id = (workerId || '').trim();
    if (!id) return { ok: false, error: 'workerId 不能为空' };

    const targetModel = (model || '').trim() || this.imagePresetModel;
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : {};
      raw.agents = raw.agents || {};
      raw.agents.list = Array.isArray(raw.agents.list) ? raw.agents.list : [];

      const fullModel = `openrouter/${targetModel}`;
      const idLower = id.toLowerCase();
      const idx = raw.agents.list.findIndex((a: { id?: string }) => (a?.id || '').toLowerCase() === idLower);
      const nextTools = {
        profile: 'minimal',
        allow: [],
        deny: [...this.imagePresetToolDeny],
      };
      if (idx >= 0) {
        raw.agents.list[idx] = {
          ...raw.agents.list[idx],
          model: fullModel,
          tools: nextTools,
        };
      } else {
        raw.agents.list.push({ id, model: fullModel, tools: nextTools });
      }

      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
      const saved = this.getWorkerModel(id);
      if (saved !== targetModel) {
        return {
          ok: false,
          error: `配置未能写入：期望 ${targetModel}，实际读到 ${saved || '(空)'}`,
        };
      }

      this.sessions.clearAgentSessionSnapshot(id);
      await this.gateway.restartGateway();
      return { ok: true, model: targetModel };
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

    const modelDetail = await this.paths.runOpenClaw(['config', 'set', 'agents.defaults.model', 'openrouter/xiaomi/mimo-v2.5-pro']);

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
