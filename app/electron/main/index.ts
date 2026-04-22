import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

type ExecResult = { code: number | null; stdout: string; stderr: string; cmd: string };
type GatewayStatus = {
  rpc: { ok: boolean; error?: string; url: string };
  gateway: { port: number; bindHost: string; bindMode: string };
  port: { status: string };
  service: { loaded: boolean; runtime: { status: string; missingUnit?: boolean } };
  logFile: string;
};
type ChatResult = ExecResult & { reply: string };
type WorkerMeta = { id: string; name: string; description?: string; path: string; mode?: string };
type SaveKeyResult = { ok: boolean; detail: ExecResult; modelDetail: ExecResult };
type SkillMeta = { id?: string; name: string; description: string };
type TelegramBotInfo = { id: number; username: string; firstName: string };
type TelegramChannel = { accountId: string; bot: TelegramBotInfo | null; agentId?: string };
type TelegramAddResult = { ok: boolean; bot?: TelegramBotInfo; error?: string };
type WorkerExportResult = { ok: boolean; error?: string; canceled?: boolean; savedPath?: string };
type SkillContentResult = { ok: boolean; error?: string; content?: string };
type AgentBindResult = { added?: string[]; updated?: string[]; skipped?: string[]; conflicts?: string[] };
type ImageInput = { mediaType: string; data: string };
type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };
type MessageContent = string | MessageContentBlock[];
type MessageItem = { role: string; content: MessageContent };
type GroupData = { id: string; name: string; workerIds: string[] };

class OpenClawService {
  private readonly runtimeVersion = '0.2.0';
  private gatewayProcess: ChildProcess | null = null;
  gatewayPort = 18789;

  private get isDev() {
    return !app.isPackaged;
  }

  private get projectRoot() {
    // app/electron/dist/main or app/electron/main -> app/electron
    return path.resolve(__dirname, '../..');
  }

  private get resourcesRuntime() {
    return this.isDev
      ? path.resolve(this.projectRoot, '../../runtime')
      : path.join(process.resourcesPath, 'runtime');
  }

  private get userRuntimeRoot() {
    return path.join(app.getPath('userData'), 'runtime');
  }

  /** openclaw 默认 main agent 的工作区（向后兼容） */
  private get userWorkspace() {
    return path.join(this.userOpenClawHome, '.openclaw', `workspace-${this.openclawProfile}`);
  }

  /** 每个 worker 专属的 openclaw agent 工作区 */
  private workerAgentWorkspacePath(workerId: string) {
    return path.join(this.userOpenClawHome, '.openclaw', `workspace-${workerId}`);
  }

  private get userOpenClawHome() {
    return path.join(this.userRuntimeRoot, 'openclaw-home');
  }

  private get userTelegramOpenClawHome() {
    return path.join(this.userRuntimeRoot, 'openclaw-home-telegram');
  }

  private get openclawProfile() {
    return 'desktop';
  }

  private get telegramOpenclawProfile() {
    return 'desktop-telegram';
  }

  private get workersRoot() {
    return this.isDev
      ? path.resolve(this.projectRoot, '../../workers')
      : path.join(process.resourcesPath, 'workers');
  }

  private get userImportedWorkersRoot() {
    return path.join(app.getPath('userData'), 'workers');
  }

  private get defaultWorkerId() {
    return '';
  }

  private get embeddedNodePath() {
    return path.join(this.resourcesRuntime, 'node', 'bin', 'node');
  }

  private get openclawCliPath() {
    const modern = path.join(this.resourcesRuntime, 'openclaw', 'openclaw.mjs');
    const legacy = path.join(this.resourcesRuntime, 'openclaw', 'bin', 'openclaw.js');
    return fs.existsSync(modern) ? modern : legacy;
  }

  private ensureExecutable(pathToBin: string) {
    if (!fs.existsSync(pathToBin)) {
      throw new Error(`可执行文件不存在: ${pathToBin}`);
    }
    try {
      fs.chmodSync(pathToBin, 0o755);
    } catch {
      // no-op
    }
  }

  private ensurePathExists(p: string, label: string) {
    if (!fs.existsSync(p)) throw new Error(`${label} 不存在: ${p}`);
  }

  private openclawConfigPath(homePath: string): string {
    return path.join(homePath, '.openclaw', 'openclaw.json');
  }

  /** 检查配置文件中是否已存在 telegram channel（表示用户已配置过 token） */
  private hasTelegramChannelConfigured(): boolean {
    const configPath = this.openclawConfigPath(this.userOpenClawHome);
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

  private maybeMigrateTelegramConfigToPrimaryHome(): void {
    const primaryConfig = this.openclawConfigPath(this.userOpenClawHome);
    const telegramConfig = this.openclawConfigPath(this.userTelegramOpenClawHome);
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

  async bootstrap(): Promise<void> {
    const stateDir = path.join(this.userRuntimeRoot, 'state');
    const logsDir = path.join(this.userRuntimeRoot, 'logs');
    const homeStateDir = path.join(this.userOpenClawHome, 'state');
    const homeLogsDir = path.join(this.userOpenClawHome, 'logs');
    const telegramHomeStateDir = path.join(this.userTelegramOpenClawHome, 'state');
    const telegramHomeLogsDir = path.join(this.userTelegramOpenClawHome, 'logs');
    const versionFile = path.join(stateDir, 'runtime-version.json');

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(homeStateDir, { recursive: true });
    fs.mkdirSync(homeLogsDir, { recursive: true });
    fs.mkdirSync(telegramHomeStateDir, { recursive: true });
    fs.mkdirSync(telegramHomeLogsDir, { recursive: true });
    fs.mkdirSync(this.userWorkspace, { recursive: true });

    this.maybeMigrateTelegramConfigToPrimaryHome();

    this.ensurePathExists(this.resourcesRuntime, 'runtime 根目录');
    this.ensureExecutable(this.embeddedNodePath);
    this.ensurePathExists(this.openclawCliPath, 'OpenClaw CLI 入口');

    let installedVersion = '';
    if (fs.existsSync(versionFile)) {
      try {
        installedVersion = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version || '';
      } catch {
        installedVersion = '';
      }
    }

    // 桌面版必要配置：loopback-only，无认证，开启 HTTP chat 接口
    // 同时清除旧的 skills.load.extraDirs（迁移遗留）
    // telegram 插件仅在用户已添加 channel 时启用，避免未配置时触发 loader 的
    // setup-entry 加载路径导致 PluginLoadFailureError
    const configBatch: Array<{ path: string; value: unknown }> = [
      { path: 'gateway.mode', value: 'local' },
      { path: 'gateway.auth.mode', value: 'none' },
      { path: 'gateway.http.endpoints.chatCompletions.enabled', value: true },
      { path: 'skills.load.extraDirs', value: [] },
    ];
    if (this.hasTelegramChannelConfigured()) {
      configBatch.push({ path: 'plugins.entries.telegram.enabled', value: true });
    }
    await this.runOpenClaw([
      'config', 'set', '--batch-json',
      JSON.stringify(configBatch)
    ]);

    // 为每个 worker 创建/同步专属 openclaw agent
    const workers = this.listWorkers();
    await Promise.all(workers.map((w) => this.bootstrapWorkerAgent(w).catch((err) => {
      console.error(`[bootstrap] worker agent ${w.id} failed:`, err);
    })));

    // 版本变更时仅写版本锁，不覆盖用户数据
    if (installedVersion !== this.runtimeVersion) {
      fs.writeFileSync(
        versionFile,
        JSON.stringify(
          {
            version: this.runtimeVersion,
            initializedAt: new Date().toISOString(),
            packaged: app.isPackaged
          },
          null,
          2
        ),
        'utf8'
      );
    }
  }

  private get embeddedNpmPath() {
    return path.join(path.dirname(this.embeddedNodePath), 'npm');
  }

  /** 在指定工作区执行 npm install（幂等，package.json 存在时运行）*/
  private npmInstallWorkspace(workspacePath: string): Promise<void> {
    const pkgJson = path.join(workspacePath, 'package.json');
    if (!fs.existsSync(pkgJson) || !fs.existsSync(this.embeddedNpmPath)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const child = spawn(
        this.embeddedNodePath,
        [this.embeddedNpmPath, 'install', '--prefer-offline'],
        {
          cwd: workspacePath,
          env: {
            ...process.env,
            PATH: `${path.dirname(this.embeddedNodePath)}:${process.env.PATH || ''}`
          }
        }
      );
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
  }

  /** 将 worker 定义文件同步到其 agent 工作区 */
  private syncWorkerToAgentWorkspace(
    workerPath: string,
    workspacePath: string,
    opts?: { forceSkills?: boolean }
  ) {
    fs.mkdirSync(workspacePath, { recursive: true });

    // agent 定义文件（由 app 管理，始终覆写）
    for (const f of ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md']) {
      const src = path.join(workerPath, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(workspacePath, f));
      }
    }

    // package.json（仅首次，不覆盖用户已有）
    const pkgSrc = path.join(workerPath, 'package.json');
    const pkgDst = path.join(workspacePath, 'package.json');
    if (fs.existsSync(pkgSrc) && !fs.existsSync(pkgDst)) {
      fs.copyFileSync(pkgSrc, pkgDst);
    }

    // skills：
    // - 常规 bootstrap：仅在 skills/ 不存在时整体复制（不覆盖用户自定义）
    // - import（forceSkills=true）：逐个 skill 复制/覆盖，保留用户新增的 skill
    const skillsSrc = path.join(workerPath, 'skills');
    const skillsDst = path.join(workspacePath, 'skills');
    if (fs.existsSync(skillsSrc)) {
      if (!fs.existsSync(skillsDst)) {
        fs.cpSync(skillsSrc, skillsDst, { recursive: true });
      } else if (opts?.forceSkills) {
        for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          fs.cpSync(
            path.join(skillsSrc, entry.name),
            path.join(skillsDst, entry.name),
            { recursive: true }
          );
        }
      }
    }
  }

  /** 读取 agent 工作区的 skills 列表（解析 SKILL.md frontmatter） */
  readWorkspaceSkills(agentId: string): SkillMeta[] {
    const skillsDir = path.join(this.workerAgentWorkspacePath(agentId), 'skills');
    if (!fs.existsSync(skillsDir)) return [];
    const results: SkillMeta[] = [];
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      try {
        const content = fs.readFileSync(skillMdPath, 'utf8');
        const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
        const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.name;
        const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
        results.push({ id: entry.name, name, description });
      } catch { /* skip unreadable */ }
    }
    return results;
  }

  private resolveSkillMdPath(agentId: string, skillId: string): string {
    const trimmedSkillId = (skillId || '').trim();
    if (!trimmedSkillId) throw new Error('skillId 不能为空');
    const workspacePath = this.workerAgentWorkspacePath(agentId);
    const skillPath = path.resolve(workspacePath, 'skills', trimmedSkillId, 'SKILL.md');
    const expectedRoot = path.resolve(workspacePath, 'skills') + path.sep;
    if (!skillPath.startsWith(expectedRoot)) {
      throw new Error('非法的 skillId');
    }
    return skillPath;
  }

  readSkillContent(agentId: string, skillId: string): SkillContentResult {
    try {
      const skillMdPath = this.resolveSkillMdPath(agentId, skillId);
      if (!fs.existsSync(skillMdPath)) {
        return { ok: false, error: '未找到 SKILL.md' };
      }
      return { ok: true, content: fs.readFileSync(skillMdPath, 'utf8') };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  saveSkillContent(agentId: string, skillId: string, content: string): SkillContentResult {
    try {
      const skillMdPath = this.resolveSkillMdPath(agentId, skillId);
      if (!fs.existsSync(skillMdPath)) {
        return { ok: false, error: '未找到 SKILL.md' };
      }
      fs.writeFileSync(skillMdPath, content, 'utf8');
      // 立刻生效：清空该 agent 的会话快照，下一次对话会按最新 skill 重新建会话
      this.clearAgentSessionSnapshot(agentId);
      return { ok: true, content };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 清除指定 agent 的 session 快照，强制下次运行时重新发现 skills */
  private clearAgentSessionSnapshot(agentId: string): void {
    const sessionsJson = path.join(
      this.userOpenClawHome, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json'
    );
    if (fs.existsSync(sessionsJson)) {
      fs.writeFileSync(sessionsJson, '{}', 'utf8');
    }
  }

  /** 清除所有 agent 的会话快照，强制下次按最新配置建会话 */
  private clearAllAgentSessionSnapshots(): void {
    const agentsRoot = path.join(this.userOpenClawHome, '.openclaw', 'agents');
    if (!fs.existsSync(agentsRoot)) return;
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionsJson = path.join(agentsRoot, entry.name, 'sessions', 'sessions.json');
      if (fs.existsSync(sessionsJson)) {
        fs.writeFileSync(sessionsJson, '{}', 'utf8');
      }
    }
  }

  /** 为单个 worker 创建/同步专属 openclaw agent */
  private async bootstrapWorkerAgent(
    worker: WorkerMeta,
    opts?: { forceSkills?: boolean }
  ): Promise<void> {
    const workspacePath = this.workerAgentWorkspacePath(worker.id);

    // 创建 openclaw agent（已存在时静默跳过）
    await this.runOpenClaw([
      'agents', 'add', worker.id,
      '--workspace', workspacePath,
      '--non-interactive', '--json'
    ]);
    // exit code 1 = "already exists"，属正常情况，不需要处理

    // 同步 worker 定义到 agent 工作区
    this.syncWorkerToAgentWorkspace(worker.path, workspacePath, opts);

    // 安装依赖
    await this.npmInstallWorkspace(workspacePath);
  }

  private writeChatLog(line: string): void {
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(this.userRuntimeRoot, 'logs', `chat-${date}.log`);
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* ignore write errors */ }
  }

  runOpenClaw(args: string[], opts?: { cwd?: string; homeOverride?: string; profileOverride?: string }): Promise<ExecResult> {
    return new Promise((resolve) => {
      const home = opts?.homeOverride || this.userOpenClawHome;
      const profile = opts?.profileOverride || this.openclawProfile;
      const cmd = `${this.embeddedNodePath} ${this.openclawCliPath} ${args.join(' ')}`;
      const child = spawn(this.embeddedNodePath, [this.openclawCliPath, ...args], {
        cwd: opts?.cwd || this.userWorkspace,
        env: {
          ...process.env,
          // 强制桌面版使用独立 HOME 与 profile，避免污染/依赖用户全局 OpenClaw 与 nvm
          OPENCLAW_HOME: home,
          OPENCLAW_PROFILE: profile,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.gateway.${profile}`,
          PATH: `${path.dirname(this.embeddedNodePath)}:${process.env.PATH || ''}`
        }
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        stderr += `\n[spawn error] ${err.message}`;
        resolve({ code: -1, stdout, stderr, cmd });
      });
      child.on('close', (code) => resolve({ code, stdout, stderr, cmd }));
    });
  }

  private runOpenClawTelegram(args: string[], opts?: { cwd?: string }): Promise<ExecResult> {
    return this.runOpenClaw(args, { cwd: opts?.cwd });
  }

  status() {
    return this.runOpenClaw(['gateway', 'status']);
  }

  async statusJson(): Promise<GatewayStatus> {
    // Gateway is started via direct spawn (not launchd), so `openclaw gateway status`
    // can't detect it. Use the process reference + HTTP ping as source of truth.
    if (this.gatewayProcess !== null) {
      // Process is alive if exitCode is still null
      const processAlive = this.gatewayProcess.exitCode === null;
      let httpOk = false;
      if (processAlive) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 1500);
          // Accept any HTTP response (incl. 4xx/5xx) — if gateway replies at all it's up
          await fetch(`http://127.0.0.1:${this.gatewayPort}/v1/models`, { signal: controller.signal });
          clearTimeout(t);
          httpOk = true;
        } catch { /* port not bound yet — process is starting */ }
      }

      const running = processAlive && httpOk;
      return {
        rpc: { ok: running, url: `http://127.0.0.1:${this.gatewayPort}` },
        gateway: { port: this.gatewayPort, bindHost: '127.0.0.1', bindMode: 'local' },
        port: { status: running ? 'open' : processAlive ? 'starting' : 'closed' },
        service: { loaded: processAlive, runtime: { status: running ? 'running' : processAlive ? 'starting' : 'stopped' } },
        logFile: ''
      };
    }

    // No owned process — try HTTP ping first (catches orphaned gateway from previous session)
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      await fetch(`http://127.0.0.1:${this.gatewayPort}/v1/models`, { signal: ctrl.signal });
      clearTimeout(t);
      return {
        rpc: { ok: true, url: `http://127.0.0.1:${this.gatewayPort}` },
        gateway: { port: this.gatewayPort, bindHost: '127.0.0.1', bindMode: 'local' },
        port: { status: 'open' },
        service: { loaded: true, runtime: { status: 'running' } },
        logFile: ''
      };
    } catch { /* not reachable — fall through to CLI */ }

    // Fall back to CLI status (handles launchd-managed gateways)
    const res = await this.runOpenClaw(['gateway', 'status', '--json']);
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
        this.embeddedNodePath,
        [this.openclawCliPath, 'gateway', 'run', '--allow-unconfigured', '--auth', 'none'],
        {
          cwd: this.userWorkspace,
          env: {
            ...process.env,
            OPENCLAW_HOME: this.userOpenClawHome,
            OPENCLAW_PROFILE: this.openclawProfile,
            OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.gateway.${this.openclawProfile}`,
            PATH: `${path.dirname(this.embeddedNodePath)}:${process.env.PATH || ''}`
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

      // 5 秒内没看到 ready 信号也认为启动中（后台继续跑）
      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: true, message: 'Gateway 正在启动…' });
        }
        // 读取实际端口
        try {
          const st = await this.statusJson();
          if (st.gateway?.port) this.gatewayPort = st.gateway.port;
        } catch { /* ignore */ }
      }, 5000);
    });
  }

  stopGateway(): { ok: boolean; message: string } {
    if (!this.gatewayProcess) {
      return { ok: false, message: 'Gateway 未运行' };
    }
    this.gatewayProcess.kill('SIGTERM');
    this.gatewayProcess = null;
    return { ok: true, message: 'Gateway 已停止' };
  }

  private readWorkersFromDir(root: string): WorkerMeta[] {
    if (!fs.existsSync(root)) return [];

    const workers: WorkerMeta[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(root, entry.name);
      const metaPath = path.join(dirPath, 'worker.json');

      let id = entry.name;
      let name = entry.name;
      let description = '';
      let mode = '';

      if (fs.existsSync(metaPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          id = raw.id || id;
          name = raw.name || name;
          description = raw.description || '';
          mode = raw.mode || '';
        } catch { /* ignore invalid meta */ }
      }

      workers.push({ id, name, description, path: dirPath, mode });
    }
    return workers;
  }

  private get groupsFilePath() {
    return path.join(app.getPath('userData'), 'groups.json');
  }

  listGroups(): GroupData[] {
    try {
      if (!fs.existsSync(this.groupsFilePath)) return [];
      return JSON.parse(fs.readFileSync(this.groupsFilePath, 'utf8'));
    } catch { return []; }
  }

  createGroup(name: string, workerIds: string[]): GroupData {
    const groups = this.listGroups();
    const group: GroupData = { id: `group-${Date.now()}`, name, workerIds };
    groups.push(group);
    fs.writeFileSync(this.groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
    return group;
  }

  deleteGroup(id: string): { ok: boolean } {
    const groups = this.listGroups().filter((g) => g.id !== id);
    fs.writeFileSync(this.groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
    return { ok: true };
  }

  listWorkers(): WorkerMeta[] {
    const builtin = this.readWorkersFromDir(this.workersRoot);
    const imported = this.readWorkersFromDir(this.userImportedWorkersRoot);
    // imported overrides builtin if same id
    const map = new Map<string, WorkerMeta>();
    for (const w of [...builtin, ...imported]) map.set(w.id, w);
    return [...map.values()];
  }

  private getGatewayToken(): string {
    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return raw?.gateway?.auth?.token ?? '';
    } catch {
      return '';
    }
  }

  private readWorkerFile(workerPath: string, filename: string): string {
    const p = path.join(workerPath, filename);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  private getDesktopSessionId(agentId: string): string {
    const model = this.getModel() || 'default';
    const safeModel = model.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64);
    const safeAgent = (agentId || 'agent').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64);
    return `desktop-ui-${safeAgent}-${safeModel}`;
  }

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
    const usageKeys = usage ? Object.keys(usage).slice(0, 6).join(',') : 'none';

    return [
      `keys=${keys}`,
      `choices=${choices.length}`,
      `msgContentType=${msgContentType}`,
      `outputItems=${output.length}`,
      `hasOutputText=${typeof root.output_text === 'string'}`,
      `usageKeys=${usageKeys}`,
    ].join(' ');
  }

  private async chatHttp(
    gatewayModel: string,
    workerPath: string,
    message: string,
    images: ImageInput[],
    history: MessageItem[],
    onLog?: (step: string) => void
  ): Promise<string> {
    const soul   = this.readWorkerFile(workerPath, 'SOUL.md');
    const agents = this.readWorkerFile(workerPath, 'AGENTS.md');
    const systemContent = [
      soul   && `# Soul\n${soul}`,
      agents && `# Workspace\n${agents}`,
    ].filter(Boolean).join('\n\n');

    const userContent: MessageContent = images.length === 0
      ? message
      : [
          { type: 'text', text: message || '请描述这张图片的主要内容。' },
          ...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
        ];

    const messages = [
      ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
      ...history.map((item) => ({ role: item.role, content: this.toOpenAIContent(item.content) })),
      { role: 'user', content: this.toOpenAIContent(userContent) },
    ];

    const configuredModel = this.getConfiguredModelFull() || '(unset)';
    onLog?.(
      `req meta gatewayModel=${gatewayModel} configuredModel=${configuredModel} textLen=${message.length} images=${images.length} history=${history.length} mimes=${images.map((i) => i.mediaType).join('|') || '-'} sizes=${images.map((i) => i.data.length).join('|') || '-'}`
    );

    const url = `http://127.0.0.1:${this.gatewayPort}/v1/chat/completions`;
    onLog?.('fetch → POST /v1/chat/completions');
    const t = Date.now();
    const gatewayToken = this.getGatewayToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: gatewayModel, messages }),
    });
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
    onStatus?: (line: string) => void,
    onLog?: (step: string) => void
  ): Promise<string> {
    return new Promise((resolve) => {
      const agentWorkspace = this.workerAgentWorkspacePath(agentId);
      const sessionId = this.getDesktopSessionId(agentId);
      const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message', message, '--json'];

      const child = spawn(this.embeddedNodePath, [this.openclawCliPath, ...args], {
        cwd: agentWorkspace,
        env: {
          ...process.env,
          OPENCLAW_HOME: this.userOpenClawHome,
          OPENCLAW_PROFILE: this.openclawProfile,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.gateway.${this.openclawProfile}`,
          PATH: `${path.dirname(this.embeddedNodePath)}:${process.env.PATH || ''}`
        }
      });

      const spawnAt = Date.now();
      const ms = () => `${Date.now() - spawnAt}ms`;
      onLog?.(`spawn pid=${child.pid} session=${sessionId}`);

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
      const handleLine = (line: string) => {
        const clean = stripAnsi(line).trim();
        if (!clean || clean.startsWith('{') || NOISE.test(clean)) return;
        onLog?.(`[${ms()}] status: ${clean}`);
        onStatus?.(clean);
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
        onLog?.(`[${ms()}] spawn error: ${err.message}`);
        resolve(`[启动失败] ${err.message}`);
      });

      child.on('close', (code) => {
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

  async chat(workerId: string, message: string, images?: ImageInput[], history?: MessageItem[]): Promise<ChatResult> {
    const t0 = Date.now();
    const ms = () => `+${Date.now() - t0}ms`;
    const tag = `[chat:${workerId}]`;
    const log = (step: string) => this.writeChatLog(`${tag} ${ms().padEnd(8)} ${step}`);

    const trimmed = (message || '').trim();
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!trimmed && !hasImages) {
      return { code: -1, stdout: '', stderr: '消息不能为空', cmd: '', reply: '消息不能为空' };
    }

    log(`START msg="${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}"`);

    const workers = this.listWorkers();
    const selected =
      workers.find((w) => w.id === workerId) ||
      workers.find((w) => w.id === this.defaultWorkerId) ||
      workers[0];

    if (!selected) {
      return {
        code: -1, stdout: '', stderr: '', cmd: '',
        reply: '未找到可用 worker。'
      };
    }

    log(`worker=${selected.id} mode=${selected.mode ?? 'default'}`);

    if (!this.gatewayProcess) {
      // No owned process — ping HTTP before giving up (handles external/restarted gateways)
      log('gateway-ping start');
      let reachable = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 800);
        const r = await fetch(`http://127.0.0.1:${this.gatewayPort}/v1/models`, { signal: ctrl.signal });
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

    if (selected.mode === 'agent' && hasImages) {
      log('HTTP-vision(agent) start');
      try {
        const reply = await this.chatHttp(`openclaw/${selected.id}`, selected.path, trimmed, images ?? [], history ?? [], (step) => log(`HTTP ${step}`));
        log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: reply, stderr: '', cmd: `POST /v1/chat/completions`, reply };
      } catch (httpErr) {
        log(`HTTP-vision(agent) failed: ${httpErr}`);
        return {
          code: -1,
          stdout: '',
          stderr: String(httpErr),
          cmd: `POST /v1/chat/completions`,
          reply: `图片请求失败: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`,
        };
      }
    }

    if (selected.mode === 'agent') {
      log('CLI-agent start');
      const win = BrowserWindow.getAllWindows()[0];
      const reply = await this.chatCliAgent(
        selected.id, trimmed,
        win ? (status) => win.webContents.send('chat:status', { workerId, status }) : undefined,
        (step) => log(`CLI-agent ${step}`)
      );
      log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
      return { code: 0, stdout: reply, stderr: '', cmd: `openclaw agent --agent ${selected.id}`, reply };
    } else {
      log('HTTP start');
      try {
        const reply = await this.chatHttp('openclaw', selected.path, trimmed, images ?? [], history ?? [], (step) => log(`HTTP ${step}`));
        log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
        return { code: 0, stdout: reply, stderr: '', cmd: `POST /v1/chat/completions`, reply };
      } catch (httpErr) {
        log(`HTTP failed: ${httpErr}`);
        console.warn('[chat] HTTP API failed, falling back to CLI:', httpErr);
      }
    }

    // CLI fallback（仅在 HTTP 失败时使用）
    log('CLI-fallback start');
    const agentWorkspace = this.workerAgentWorkspacePath(selected.id);
    const sessionId = this.getDesktopSessionId(selected.id);
    const res = await this.runOpenClaw(
      ['agent', '--agent', selected.id, '--session-id', sessionId, '--message', trimmed, '--json'],
      { cwd: agentWorkspace }
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
    log(`DONE reply-len=${reply.length} total=${Date.now() - t0}ms`);
    return { ...res, reply };
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
    const configPath = this.openclawConfigPath(this.userOpenClawHome);
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const key = accountId === 'default' ? 'telegram' : `telegram:${accountId}`;
      return raw?.channels?.[key]?.botToken ?? '';
    } catch {
      return '';
    }
  }

  private readTelegramBinding(accountId: string): string | undefined {
    const configPath = this.openclawConfigPath(this.userOpenClawHome);
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
    const res = await this.runOpenClawTelegram(['channels', 'list', '--json']);
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

  // ── Worker import ────────────────────────────────────────────────────────

  async openFileDialog(): Promise<string | null> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Worker Package', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  }

  async openSkillDirDialog(): Promise<string | null> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  }

  installSkillFromDir(workerId: string, skillDirPath: string): { ok: boolean; error?: string; skills?: SkillMeta[] } {
    try {
      const workspacePath = this.workerAgentWorkspacePath(workerId);
      const skillsDst = path.join(workspacePath, 'skills');
      fs.mkdirSync(skillsDst, { recursive: true });

      const skillName = path.basename(skillDirPath);
      const destPath = path.join(skillsDst, skillName);
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
      fs.cpSync(skillDirPath, destPath, { recursive: true });

      this.clearAgentSessionSnapshot(workerId);
      const skills = this.readWorkspaceSkills(workerId);
      return { ok: true, skills };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getInternZipPath(): string {
    return this.isDev
      ? path.resolve(this.projectRoot, 'intern.zip')
      : path.join(process.resourcesPath, 'intern.zip');
  }

  private extractZip(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      const [cmd, args] = isWindows
        ? ['tar', ['-xf', zipPath, '-C', destDir]]
        : ['unzip', ['-q', zipPath, '-d', destDir]];
      const child = spawn(cmd, args);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
      child.on('error', reject);
    });
  }

  private zipDir(sourceParentDir: string, dirName: string, outputZipPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'tar' : 'zip';
      const args = isWindows
        ? ['-a', '-c', '-f', outputZipPath, '-C', sourceParentDir, dirName]
        : ['-qr', outputZipPath, dirName];
      const child = spawn(cmd, args, isWindows ? undefined : { cwd: sourceParentDir });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
      });
      child.on('error', reject);
    });
  }

  async exportWorker(workerId: string): Promise<WorkerExportResult> {
    const selected = this.listWorkers().find((w) => w.id === workerId);
    if (!selected) return { ok: false, error: '未找到要导出的 worker' };

    const workspacePath = this.workerAgentWorkspacePath(selected.id);
    const workerPath = selected.path;
    const displayName = (selected.name || selected.id || 'worker').trim();
    const safeName = displayName.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || selected.id;
    const tempRoot = path.join(os.tmpdir(), `openclaw-export-${Date.now()}-${selected.id}`);
    const exportDir = path.join(tempRoot, safeName);
    const exportMdFiles = ['AGENTS.md', 'BOOTSTRAP.md', 'SOUL.md', 'IDENTITY.md', 'TOOLS.md'];

    try {
      fs.mkdirSync(exportDir, { recursive: true });

      let copiedCount = 0;
      for (const filename of exportMdFiles) {
        for (const srcRoot of [workspacePath, workerPath]) {
          const src = path.join(srcRoot, filename);
          if (!fs.existsSync(src)) continue;
          fs.copyFileSync(src, path.join(exportDir, filename));
          copiedCount += 1;
          break;
        }
      }

      const skillsSrc = [
        path.join(workspacePath, 'skills'),
        path.join(workerPath, 'skills'),
      ].find((p) => fs.existsSync(p));

      if (skillsSrc) {
        fs.cpSync(skillsSrc, path.join(exportDir, 'skills'), { recursive: true });
      }

      if (copiedCount === 0 && !skillsSrc) {
        return { ok: false, error: '当前 worker 没有可导出的文件' };
      }

      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: '主窗口不可用' };

      const saveResult = await dialog.showSaveDialog(win, {
        title: '导出 Worker',
        defaultPath: path.join(app.getPath('documents'), `${safeName}.zip`),
        filters: [{ name: 'Worker Package', extensions: ['zip'] }],
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, canceled: true };
      }

      const savePath = saveResult.filePath.toLowerCase().endsWith('.zip')
        ? saveResult.filePath
        : `${saveResult.filePath}.zip`;

      await this.zipDir(tempRoot, safeName, savePath);
      return { ok: true, savedPath: savePath };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async probeWorkerZip(zipPath: string): Promise<{
    tempDir: string; rootDir: string;
    suggestedId: string; suggestedName: string; suggestedDescription: string;
  }> {
    const tempDir = path.join(os.tmpdir(), `openclaw-import-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    await this.extractZip(zipPath, tempDir);

    // Remove macOS metadata directory if present
    const macosxDir = path.join(tempDir, '__MACOSX');
    if (fs.existsSync(macosxDir)) fs.rmSync(macosxDir, { recursive: true, force: true });

    // Find root: zip may wrap content in one subdirectory
    let rootDir = tempDir;
    if (!fs.existsSync(path.join(tempDir, 'SOUL.md'))) {
      const sub = fs.readdirSync(tempDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '__MACOSX');
      if (sub.length === 1) rootDir = path.join(tempDir, sub[0].name);
    }

    // Extract name/description from IDENTITY.md
    let suggestedName = path.basename(zipPath, '.zip');
    let suggestedDescription = '';
    const identityPath = path.join(rootDir, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      const content = fs.readFileSync(identityPath, 'utf8');
      const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
      if (nameMatch) suggestedName = nameMatch[1].trim();
      const roleMatch = content.match(/\*\*Role:\*\*\s*(.+)/);
      if (roleMatch) suggestedDescription = roleMatch[1].trim();
    }

    const suggestedId = suggestedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { tempDir, rootDir, suggestedId, suggestedName, suggestedDescription };
  }

  deleteWorker(workerId: string): { ok: boolean; error?: string } {
    const importedPath = path.join(this.userImportedWorkersRoot, workerId);
    if (!fs.existsSync(importedPath)) {
      return { ok: false, error: '内置 worker 无法删除' };
    }
    fs.rmSync(importedPath, { recursive: true, force: true });
    return { ok: true };
  }

  async installWorkerFromTemp(
    tempDir: string, rootDir: string,
    id: string, name: string, description: string
  ): Promise<{ ok: boolean; error?: string; skills?: SkillMeta[] }> {
    try {
      fs.mkdirSync(this.userImportedWorkersRoot, { recursive: true });
      const destPath = path.join(this.userImportedWorkersRoot, id);
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
      fs.cpSync(rootDir, destPath, { recursive: true });
      fs.writeFileSync(
        path.join(destPath, 'worker.json'),
        JSON.stringify({ id, name, description, mode: 'agent' }, null, 2),
        'utf8'
      );

      // 导入新 zip 时，直接清空 agent workspace 的 skills 目录，确保 zip 是权威来源
      const workspacePath = this.workerAgentWorkspacePath(id);
      const skillsDst = path.join(workspacePath, 'skills');
      if (fs.existsSync(skillsDst)) {
        fs.rmSync(skillsDst, { recursive: true, force: true });
      }

      await this.bootstrapWorkerAgent({ id, name, description, path: destPath, mode: 'agent' }, { forceSkills: true });
      // 清除旧 session 快照，确保下次运行时重新扫描并注册 skills
      this.clearAgentSessionSnapshot(id);
      const skills = this.readWorkspaceSkills(id);
      return { ok: true, skills };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── Telegram ──────────────────────────────────────────────────────────────

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

    const res = await this.runOpenClawTelegram(['channels', 'add', '--channel', 'telegram', '--token', trimmed]);
    if (res.code !== 0) {
      return { ok: false, error: res.stderr || '写入配置失败' };
    }

    const afterAccounts = await this.listTelegramAccountIds();
    const addedAccount = afterAccounts.find((id) => !beforeAccounts.includes(id));

    // 将 Telegram channel 绑定到指定 worker（若未指定则回退到首个 agent worker）
    const workers = this.listWorkers();
    const targetAgent =
      (workerId ? workers.find((w) => w.id === workerId) : undefined) ??
      workers.find((w) => w.mode === 'agent') ??
      workers[0];
    if (targetAgent) {
      const ensureAgentRes = await this.runOpenClawTelegram([
        'agents', 'add', targetAgent.id,
        '--workspace', this.workerAgentWorkspacePath(targetAgent.id),
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
      let bindRes = await this.runOpenClawTelegram(bindArgs);
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
          const unbindRes = await this.runOpenClawTelegram([
            'agents', 'unbind',
            '--agent', conflictAgent,
            '--bind', conflictBind,
            '--json'
          ]);
          if (unbindRes.code !== 0) {
            return { ok: false, error: unbindRes.stderr || unbindRes.stdout || '解绑旧 Worker 失败' };
          }
        }

        bindRes = await this.runOpenClawTelegram(bindArgs);
        if (bindRes.code !== 0) {
          return { ok: false, error: bindRes.stderr || bindRes.stdout || '绑定 Worker 失败' };
        }
        bindJson = this.parseJsonFromExec<AgentBindResult>(bindRes);
        if ((bindJson?.conflicts ?? []).length > 0) {
          return { ok: false, error: `绑定冲突: ${(bindJson?.conflicts ?? []).join(', ')}` };
        }
      }
    }

    // channel 添加成功，确保 telegram 插件已启用
    await this.runOpenClaw([
      'config', 'set', 'plugins.entries.telegram.enabled', 'true'
    ]);

    const bot = await this.fetchTelegramBotInfo(trimmed);
    return { ok: true, bot: bot ?? undefined };
  }

  async removeTelegramChannel(accountId: string): Promise<{ ok: boolean; error?: string }> {
    const args = ['channels', 'remove', '--channel', 'telegram', '--delete'];
    if (accountId !== 'default') args.push('--account', accountId);
    const res = await this.runOpenClawTelegram(args);
    if (res.code !== 0) return { ok: false, error: res.stderr };

    // 如果已无 telegram channel，禁用插件以避免下次启动触发 setup-entry 加载错误
    if (!this.hasTelegramChannelConfigured()) {
      await this.runOpenClaw([
        'config', 'set', 'plugins.entries.telegram.enabled', 'false'
      ]);
    }
    return { ok: true };
  }

  getModel(): string {
    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
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
    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
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

  private getConfiguredModelFull(): string {
    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const full: string = raw?.agents?.defaults?.model ?? '';
      return typeof full === 'string' ? full : '';
    } catch {
      return '';
    }
  }

  async setModel(model: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.runOpenClaw(['config', 'set', 'agents.defaults.model', `openrouter/${model}`]);
    if (res.code !== 0) return { ok: false, error: res.stderr };
    // Verify the config was actually persisted (CLI may return 0 but not write)
    const saved = this.getModel();
    if (saved !== model) {
      return { ok: false, error: `配置未能写入：期望 ${model}，实际读到 ${saved || '(空)'}` };
    }
    this.clearAllAgentSessionSnapshots();
    if (this.gatewayProcess) {
      // Wait for old process to actually exit before starting new one to avoid port conflict
      await new Promise<void>((resolve) => {
        const old = this.gatewayProcess!;
        old.once('close', () => resolve());
        old.kill('SIGTERM');
        this.gatewayProcess = null;
      });
    }
    await this.startGateway();
    return { ok: true };
  }

  async setWorkerModel(workerId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const id = (workerId || '').trim();
    const selected = (model || '').trim();
    if (!id) return { ok: false, error: 'workerId 不能为空' };
    if (!selected) return { ok: false, error: 'model 不能为空' };

    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
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

      this.clearAgentSessionSnapshot(id);
      if (this.gatewayProcess) {
        await new Promise<void>((resolve) => {
          const old = this.gatewayProcess!;
          old.once('close', () => resolve());
          old.kill('SIGTERM');
          this.gatewayProcess = null;
        });
      }
      await this.startGateway();
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getOpenRouterKey(): string {
    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
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

    // schema 要求 baseUrl 和 models 与 apiKey 同时存在，用 batch-json 一次性写入
    const batchJson = JSON.stringify([
      { path: 'models.providers.openrouter.baseUrl', value: 'https://openrouter.ai/api/v1' },
      { path: 'models.providers.openrouter.apiKey', value: key },
      { path: 'models.providers.openrouter.models', value: [] }
    ]);
    const detail = await this.runOpenClaw(['config', 'set', '--batch-json', batchJson]);

    const modelDetail = await this.runOpenClaw(['config', 'set', 'agents.defaults.model', 'openrouter/openai/gpt-5-nano']);

    return {
      ok: detail.code === 0 && modelDetail.code === 0,
      detail,
      modelDetail
    };
  }

  getChatHistory(): { messages: Record<string, unknown[]>; groupMessages: Record<string, unknown[]> } {
    const p = path.join(app.getPath('userData'), 'chat-history.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { messages: {}, groupMessages: {} };
    }
  }

  saveChatHistory(data: { messages: Record<string, unknown[]>; groupMessages: Record<string, unknown[]> }): void {
    const p = path.join(app.getPath('userData'), 'chat-history.json');
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

  debugInfo() {
    return {
      isDev: this.isDev,
      resourcesRuntime: this.resourcesRuntime,
      embeddedNodePath: this.embeddedNodePath,
      openclawCliPath: this.openclawCliPath,
      userRuntimeRoot: this.userRuntimeRoot,
      userWorkspace: this.userWorkspace,
      userOpenClawHome: this.userOpenClawHome,
      openclawProfile: this.openclawProfile,
      launchdLabel: `ai.openclaw.gateway.${this.openclawProfile}`,
      runtimeVersion: this.runtimeVersion,
      embeddedNodeExists: fs.existsSync(this.embeddedNodePath),
      openclawCliExists: fs.existsSync(this.openclawCliPath)
    };
  }
}

const service = new OpenClawService();

app.on('before-quit', () => service.stopGateway());

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js')
    }
  });
  mainWindow = win;

  if (!app.isPackaged) {
    win.loadURL('http://localhost:5173');
    // win.webContents.openDevTools();
  } else {
    win.loadFile(path.resolve(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  try {
    await service.bootstrap();
  } catch (error) {
    console.error('[bootstrap failed]', error);
  }
  service.startGateway().catch((err) => console.error('[auto-start gateway failed]', err));
  createWindow();
});

ipcMain.handle('gateway:status', async () => service.statusJson());
ipcMain.handle('gateway:start', async () => service.startGateway());
ipcMain.handle('gateway:stop', () => service.stopGateway());
ipcMain.handle('gateway:debug', async () => service.debugInfo());
ipcMain.handle('settings:getOpenRouterKey', () => service.getOpenRouterKey());
ipcMain.handle('settings:saveOpenRouterKey', async (_evt, apiKey: string) => service.saveOpenRouterKey(apiKey));
ipcMain.handle('settings:getModel', () => service.getModel());
ipcMain.handle('settings:setModel', async (_evt, model: string) => service.setModel(model));
ipcMain.handle('settings:getWorkerModel', (_evt, workerId: string) => service.getWorkerModel(workerId));
ipcMain.handle('settings:setWorkerModel', async (_evt, workerId: string, model: string) => service.setWorkerModel(workerId, model));
ipcMain.handle('workers:list', async () => service.listWorkers());
ipcMain.handle('channels:telegram:list', async () => service.listTelegramChannels());
ipcMain.handle('channels:telegram:add', async (_evt, token: string, workerId?: string) => service.addTelegramChannel(token, workerId));
ipcMain.handle('channels:telegram:remove', async (_evt, accountId: string) => service.removeTelegramChannel(accountId));
ipcMain.handle('chat:send', async (_evt, payload: { workerId: string; message: string; images?: ImageInput[]; history?: MessageItem[] }) => {
  return service.chat(payload?.workerId || '', payload?.message || '', payload?.images, payload?.history);
});
ipcMain.handle('chat:getHistory', () => service.getChatHistory());
ipcMain.on('chat:saveHistory', (_evt, data) => service.saveChatHistory(data));
ipcMain.handle('workers:open-file-dialog', () => service.openFileDialog());
ipcMain.handle('workers:open-skill-dir-dialog', () => service.openSkillDirDialog());
ipcMain.handle('workers:get-intern-zip-path', () => service.getInternZipPath());
ipcMain.handle('workers:install-skill-from-dir', (_evt, workerId: string, skillDirPath: string) =>
  service.installSkillFromDir(workerId, skillDirPath)
);
ipcMain.handle('workers:probe-zip', async (_evt, zipPath: string) => service.probeWorkerZip(zipPath));
ipcMain.handle('workers:install-from-temp', async (_evt, tempDir: string, rootDir: string, id: string, name: string, description: string) =>
  service.installWorkerFromTemp(tempDir, rootDir, id, name, description)
);
ipcMain.handle('workers:export', async (_evt, workerId: string) => service.exportWorker(workerId));
ipcMain.handle('workers:list-skills', (_evt, workerId: string) => service.readWorkspaceSkills(workerId));
ipcMain.handle('workers:read-skill', (_evt, workerId: string, skillId: string) => service.readSkillContent(workerId, skillId));
ipcMain.handle('workers:save-skill', (_evt, workerId: string, skillId: string, content: string) =>
  service.saveSkillContent(workerId, skillId, content)
);
ipcMain.handle('workers:delete', (_evt, workerId: string) => service.deleteWorker(workerId));
ipcMain.handle('groups:list', () => service.listGroups());
ipcMain.handle('groups:create', (_evt, name: string, workerIds: string[]) => service.createGroup(name, workerIds));
ipcMain.handle('groups:delete', (_evt, id: string) => service.deleteGroup(id));
ipcMain.handle('debug:toggle-devtools', () => { mainWindow?.webContents.toggleDevTools(); });
ipcMain.handle('debug:open-dashboard', () => { shell.openExternal(`http://127.0.0.1:${service.gatewayPort}`); });
