import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ExecResult } from './types';

export class OpenClawPaths {
  readonly runtimeVersion = '0.2.0';
  readonly httpTimeoutMs = 600000;
  readonly cliTimeoutMs = 600000;
  readonly deniedSubagentTools = ['sessions_spawn', 'cron'];
  gatewayPort = 18789;

  get isDev() {
    return !app.isPackaged;
  }

  get projectRoot() {
    return path.resolve(__dirname, '../..');
  }

  get resourcesRuntime() {
    return this.isDev
      ? path.resolve(this.projectRoot, '../../runtime')
      : path.join(process.resourcesPath, 'runtime');
  }

  get userRuntimeRoot() {
    return path.join(app.getPath('userData'), 'runtime');
  }

  get userWorkspace() {
    return path.join(this.userOpenClawHome, '.openclaw', `workspace-${this.openclawProfile}`);
  }

  workerAgentWorkspacePath(workerId: string) {
    return path.join(this.userOpenClawHome, '.openclaw', `workspace-${workerId}`);
  }

  get userOpenClawHome() {
    return path.join(this.userRuntimeRoot, 'openclaw-home');
  }

  get userTelegramOpenClawHome() {
    return path.join(this.userRuntimeRoot, 'openclaw-home-telegram');
  }

  get openclawProfile() {
    return 'desktop';
  }

  get telegramOpenclawProfile() {
    return 'desktop-telegram';
  }

  get workersRoot() {
    return this.isDev
      ? path.resolve(this.projectRoot, '../../workers')
      : path.join(process.resourcesPath, 'workers');
  }

  get userImportedWorkersRoot() {
    return path.join(app.getPath('userData'), 'workers');
  }

  get defaultWorkerId() {
    return '';
  }

  get embeddedNodePath() {
    return path.join(this.resourcesRuntime, 'node', 'bin', 'node');
  }

  get openclawCliPath() {
    const modern = path.join(this.resourcesRuntime, 'openclaw', 'openclaw.mjs');
    const legacy = path.join(this.resourcesRuntime, 'openclaw', 'bin', 'openclaw.js');
    return fs.existsSync(modern) ? modern : legacy;
  }

  get embeddedNpmPath() {
    return path.join(path.dirname(this.embeddedNodePath), 'npm');
  }

  ensureExecutable(pathToBin: string) {
    if (!fs.existsSync(pathToBin)) {
      throw new Error(`可执行文件不存在: ${pathToBin}`);
    }
    try {
      fs.chmodSync(pathToBin, 0o755);
    } catch {
      // no-op
    }
  }

  ensurePathExists(p: string, label: string) {
    if (!fs.existsSync(p)) throw new Error(`${label} 不存在: ${p}`);
  }

  openclawConfigPath(homePath: string): string {
    return path.join(homePath, '.openclaw', 'openclaw.json');
  }

  getGatewayToken(): string {
    const configPath = path.join(this.userOpenClawHome, '.openclaw', 'openclaw.json');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return raw?.gateway?.auth?.token ?? '';
    } catch {
      return '';
    }
  }

  readWorkerFile(workerPath: string, filename: string): string {
    const p = path.join(workerPath, filename);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  writeChatLog(line: string): void {
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(this.userRuntimeRoot, 'logs', `chat-${date}.log`);
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* ignore write errors */ }
  }

  writeToolSchemaDump(payload: Record<string, unknown>, traceId?: string): void {
    const logsDir = path.join(this.userRuntimeRoot, 'logs');
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'tool-schema-dump.json'), JSON.stringify(payload, null, 2), 'utf8');
      fs.appendFileSync(path.join(logsDir, 'tool-schema-dump.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
      if (traceId) {
        fs.writeFileSync(path.join(logsDir, `tool-schema-dump-${traceId}.json`), JSON.stringify(payload, null, 2), 'utf8');
      }
    } catch (err) {
      this.writeChatLog(`[tool-schema-dump] write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeGatewayRuntimeUsageByTrace(payload: Record<string, unknown>, traceId?: string): void {
    const logsDir = path.join(this.userRuntimeRoot, 'logs');
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(path.join(logsDir, 'gateway-runtime-usage-by-trace.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
      fs.writeFileSync(path.join(logsDir, 'gateway-runtime-usage-by-trace.latest.json'), JSON.stringify(payload, null, 2), 'utf8');
      if (traceId) {
        fs.writeFileSync(path.join(logsDir, `gateway-runtime-usage-${traceId}.json`), JSON.stringify(payload, null, 2), 'utf8');
      }
    } catch (err) {
      this.writeChatLog(`[gateway-runtime-usage] write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  runOpenClaw(args: string[], opts?: { cwd?: string; homeOverride?: string; profileOverride?: string; timeoutMs?: number }): Promise<ExecResult> {
    return new Promise((resolve) => {
      const home = opts?.homeOverride || this.userOpenClawHome;
      const profile = opts?.profileOverride || this.openclawProfile;
      const cmd = `${this.embeddedNodePath} ${this.openclawCliPath} ${args.join(' ')}`;
      const child = spawn(this.embeddedNodePath, [this.openclawCliPath, ...args], {
        cwd: opts?.cwd || this.userWorkspace,
        env: {
          ...process.env,
          OPENCLAW_HOME: home,
          HOME: home,
          OPENCLAW_PROFILE: profile,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.gateway.${profile}`,
          PATH: `${path.dirname(this.embeddedNodePath)}:${process.env.PATH || ''}`
        }
      });

      let settled = false;
      let stdout = '';
      let stderr = '';
      const timeoutMs = opts?.timeoutMs;
      const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            stderr += `\n[timeout] command timed out after ${timeoutMs}ms`;
            child.kill('SIGTERM');
            resolve({ code: -1, stdout, stderr, cmd });
          }, timeoutMs)
        : null;
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        if (timeout) clearTimeout(timeout);
        if (settled) return;
        settled = true;
        stderr += `\n[spawn error] ${err.message}`;
        resolve({ code: -1, stdout, stderr, cmd });
      });
      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (settled) return;
        settled = true;
        resolve({ code, stdout, stderr, cmd });
      });
    });
  }

  runOpenClawTelegram(args: string[], opts?: { cwd?: string }): Promise<ExecResult> {
    return this.runOpenClaw(args, { cwd: opts?.cwd });
  }
}
