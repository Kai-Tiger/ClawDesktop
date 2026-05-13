import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { WorkerMeta, SkillMeta, SkillContentResult, WorkerExportResult } from './types';
import type { OpenClawPaths } from './paths';
import type { SessionService } from './session-service';

export class WorkerService {
  constructor(
    private readonly paths: OpenClawPaths,
    private readonly sessions: SessionService
  ) {}

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

  listWorkers(): WorkerMeta[] {
    const builtin = this.readWorkersFromDir(this.paths.workersRoot);
    const imported = this.readWorkersFromDir(this.paths.userImportedWorkersRoot);
    const map = new Map<string, WorkerMeta>();
    for (const w of [...builtin, ...imported]) map.set(w.id, w);
    return [...map.values()];
  }

  private npmInstallWorkspace(workspacePath: string): Promise<void> {
    const pkgJson = path.join(workspacePath, 'package.json');
    if (!fs.existsSync(pkgJson) || !fs.existsSync(this.paths.embeddedNpmPath)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const child = spawn(
        this.paths.embeddedNodePath,
        [this.paths.embeddedNpmPath, 'install', '--prefer-offline'],
        {
          cwd: workspacePath,
          env: {
            ...process.env,
            PATH: `${path.dirname(this.paths.embeddedNodePath)}:${process.env.PATH || ''}`
          }
        }
      );
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
  }

  private syncWorkerToAgentWorkspace(
    workerPath: string,
    workspacePath: string,
    opts?: { forceSkills?: boolean }
  ) {
    fs.mkdirSync(workspacePath, { recursive: true });
    const openclawDataRoot = path.join(this.paths.userOpenClawHome, '.openclaw');

    const normalizeLegacyPaths = (content: string): string => {
      return content
        .replace(/\/home\/node\/\.openclaw\/workspace\//g, `${workspacePath}${path.sep}`)
        .replace(/~\/\.openclaw\/workspace\//g, `${workspacePath}${path.sep}`)
        .replace(/\/home\/node\/\.openclaw\//g, `${openclawDataRoot}${path.sep}`)
        .replace(/~\/\.openclaw\//g, `${openclawDataRoot}${path.sep}`)
        .replace(/\/Users\/[^/\s]+\/\.openclaw\/workspace-[^/\s)]+/g, workspacePath);
    };

    const skillsPath = path.join(workspacePath, 'skills');
    const parentDir = path.dirname(workspacePath);
    const localPathOverride = [
      '',
      '## Local Workspace Override (Clawin Desktop)',
      `- Allowed root: ${workspacePath}`,
      `- Allowed skills dir: ${skillsPath}`,
      `- Never access sibling workspaces under ${parentDir}`,
      '- Never use ~/.openclaw paths or parent-directory traversal to find files.',
      '- Only operate on absolute paths that start with the allowed root.',
      '- In shell commands, any path containing spaces must be wrapped in double quotes.',
      '- If path scope is unclear, ask for an explicit absolute path first.',
    ].join('\n');

    const shellPathSafetyOverride = [
      '',
      '## Shell Path Safety (Clawin Desktop)',
      '- Paths under `/Users/likai.lear/Library/Application Support/Clawin Desktop/...` contain spaces.',
      '- In all shell commands, wrap every path containing spaces with double quotes.',
      '- Example (correct): `python "/Users/likai.lear/Library/Application Support/Clawin Desktop/runtime/openclaw-home/.openclaw/workspace-target/test.py"`',
      '- Example (wrong): `python /Users/likai.lear/Library/Application Support/Clawin Desktop/runtime/openclaw-home/.openclaw/workspace-target/test.py`',
    ].join('\n');

    for (const f of ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md']) {
      const src = path.join(workerPath, f);
      if (fs.existsSync(src)) {
        const dst = path.join(workspacePath, f);
        try {
          const content = fs.readFileSync(src, 'utf8');
          const normalized = normalizeLegacyPaths(content);
          const withOverride = f === 'USER.md'
            ? `${normalized}\n${localPathOverride}\n`
            : f === 'TOOLS.md'
              ? `${normalized}\n${shellPathSafetyOverride}\n`
              : normalized;
          fs.writeFileSync(dst, withOverride, 'utf8');
        } catch {
          fs.copyFileSync(src, dst);
        }
      }
    }

    const pkgSrc = path.join(workerPath, 'package.json');
    const pkgDst = path.join(workspacePath, 'package.json');
    if (fs.existsSync(pkgSrc) && !fs.existsSync(pkgDst)) {
      fs.copyFileSync(pkgSrc, pkgDst);
    }

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

  readWorkspaceSkills(agentId: string): SkillMeta[] {
    const skillsDir = path.join(this.paths.workerAgentWorkspacePath(agentId), 'skills');
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
    const workspacePath = this.paths.workerAgentWorkspacePath(agentId);
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
      this.sessions.clearAgentSessionSnapshot(agentId);
      return { ok: true, content };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  installSkillFromDir(workerId: string, skillDirPath: string, skillName?: string): { ok: boolean; error?: string; skills?: SkillMeta[] } {
    try {
      const selected = this.listWorkers().find((w) => w.id === workerId);
      if (!selected) {
        return { ok: false, error: `未找到 worker: ${workerId}` };
      }

      if (!fs.existsSync(skillDirPath)) {
        return { ok: false, error: '所选 skill 路径不存在' };
      }

      const sourceStat = fs.statSync(skillDirPath);
      const sourceBaseName = path.basename(skillDirPath);
      const isSkillFile = sourceStat.isFile() && sourceBaseName.toLowerCase() === 'skill.md';
      const normalizedSkillName = (skillName || '').trim();

      if (!sourceStat.isDirectory() && !isSkillFile) {
        return { ok: false, error: '请选择 Skill 文件夹或 SKILL.md 文件' };
      }

      if (isSkillFile && !normalizedSkillName) {
        return { ok: false, error: 'Skill 名称不能为空' };
      }

      if (normalizedSkillName && /[\\/]/.test(normalizedSkillName)) {
        return { ok: false, error: 'Skill 名称不能包含路径分隔符' };
      }

      const workspacePath = this.paths.workerAgentWorkspacePath(workerId);
      const targetSkillName = isSkillFile
        ? normalizedSkillName
        : sourceBaseName;
      const destinations = Array.from(
        new Set([
          path.join(workspacePath, 'skills'),
          path.join(selected.path, 'skills'),
        ])
      );

      for (const skillsDst of destinations) {
        fs.mkdirSync(skillsDst, { recursive: true });
        const destPath = path.join(skillsDst, targetSkillName);
        if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
        if (isSkillFile) {
          fs.mkdirSync(destPath, { recursive: true });
          fs.copyFileSync(skillDirPath, path.join(destPath, 'SKILL.md'));
        } else {
          fs.cpSync(skillDirPath, destPath, { recursive: true });
        }
      }

      this.sessions.clearAgentSessionSnapshot(workerId);
      const skills = this.readWorkspaceSkills(workerId);
      return { ok: true, skills };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getInternZipPath(): string {
    return this.paths.isDev
      ? path.resolve(this.paths.projectRoot, 'intern.zip')
      : path.join(process.resourcesPath, 'intern.zip');
  }

  getBlankZipPath(): string {
    return this.paths.isDev
      ? path.resolve(this.paths.projectRoot, 'blank.zip')
      : path.join(process.resourcesPath, 'blank.zip');
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

    const workspacePath = this.paths.workerAgentWorkspacePath(selected.id);
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

    const macosxDir = path.join(tempDir, '__MACOSX');
    if (fs.existsSync(macosxDir)) fs.rmSync(macosxDir, { recursive: true, force: true });

    let rootDir = tempDir;
    if (!fs.existsSync(path.join(tempDir, 'SOUL.md'))) {
      const sub = fs.readdirSync(tempDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '__MACOSX');
      if (sub.length === 1) rootDir = path.join(tempDir, sub[0].name);
    }

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

  updateWorkerMeta(workerId: string, name: string, description: string): { ok: boolean; error?: string } {
    const searchRoots = [this.paths.userImportedWorkersRoot, this.paths.workersRoot];
    for (const root of searchRoots) {
      const metaPath = path.join(root, workerId, 'worker.json');
      if (fs.existsSync(metaPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          fs.writeFileSync(metaPath, JSON.stringify({ ...raw, name, description }, null, 2));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
    }
    return { ok: false, error: 'worker 不存在' };
  }

  deleteWorker(workerId: string): { ok: boolean; error?: string } {
    const importedPath = path.join(this.paths.userImportedWorkersRoot, workerId);
    if (!fs.existsSync(importedPath)) {
      return { ok: false, error: '内置 worker 无法删除' };
    }
    fs.rmSync(importedPath, { recursive: true, force: true });
    return { ok: true };
  }

  async bootstrapWorkerAgent(
    worker: WorkerMeta,
    opts?: { forceSkills?: boolean }
  ): Promise<void> {
    const workspacePath = this.paths.workerAgentWorkspacePath(worker.id);
    await this.paths.runOpenClaw([
      'agents', 'add', worker.id,
      '--workspace', workspacePath,
      '--non-interactive', '--json'
    ]);
    this.syncWorkerToAgentWorkspace(worker.path, workspacePath, opts);
    await this.npmInstallWorkspace(workspacePath);
  }

  ensureSubagentToolsDenied(workerIds: string[]): void {
    const ids = Array.from(new Set((workerIds || []).map((id) => (id || '').trim()).filter(Boolean)));
    if (ids.length === 0) return;
    const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      raw.agents = raw.agents || {};
      raw.agents.list = Array.isArray(raw.agents.list) ? raw.agents.list : [];
      let changed = false;

      for (const id of ids) {
        const idx = raw.agents.list.findIndex((a: { id?: string }) => a?.id === id);
        if (idx < 0) {
          raw.agents.list.push({ id, tools: { deny: [...this.paths.deniedSubagentTools] } });
          changed = true;
          continue;
        }
        const entry = raw.agents.list[idx] || {};
        const tools = entry.tools && typeof entry.tools === 'object'
          ? ({ ...(entry.tools as Record<string, unknown>) } as Record<string, unknown>)
          : ({} as Record<string, unknown>);
        const deny = Array.isArray(tools.deny) ? tools.deny.filter((v: unknown) => typeof v === 'string') : [];
        const managedTools = new Set(['cron', 'sessions_spawn', 'sessions_yield']);
        const preserved = deny.filter((tool) => !managedTools.has(tool));
        const mergedDeny = Array.from(new Set([...preserved, ...this.paths.deniedSubagentTools]));
        if (JSON.stringify(mergedDeny) !== JSON.stringify(deny)) {
          tools.deny = mergedDeny;
          raw.agents.list[idx] = { ...entry, tools };
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
        for (const id of ids) this.sessions.clearAgentSessionSnapshot(id);
      }
    } catch {
      // ignore config patch errors
    }
  }

  async installWorkerFromTemp(
    tempDir: string, rootDir: string,
    id: string, name: string, description: string
  ): Promise<{ ok: boolean; error?: string; skills?: SkillMeta[] }> {
    try {
      fs.mkdirSync(this.paths.userImportedWorkersRoot, { recursive: true });
      const destPath = path.join(this.paths.userImportedWorkersRoot, id);
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
      fs.cpSync(rootDir, destPath, { recursive: true });
      fs.writeFileSync(
        path.join(destPath, 'worker.json'),
        JSON.stringify({ id, name, description, mode: 'agent' }, null, 2),
        'utf8'
      );

      const workspacePath = this.paths.workerAgentWorkspacePath(id);
      const skillsDst = path.join(workspacePath, 'skills');
      if (fs.existsSync(skillsDst)) {
        fs.rmSync(skillsDst, { recursive: true, force: true });
      }

      await this.bootstrapWorkerAgent({ id, name, description, path: destPath, mode: 'agent' }, { forceSkills: true });
      this.sessions.clearAgentSessionSnapshot(id);

      try {
        const configPath = path.join(this.paths.userOpenClawHome, '.openclaw', 'openclaw.json');
        const raw = fs.existsSync(configPath)
          ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
          : {};
        raw.agents = raw.agents || {};
        raw.agents.list = Array.isArray(raw.agents.list) ? raw.agents.list : [];
        const defaultModel = 'openrouter/xiaomi/mimo-v2-pro';
        const idx = raw.agents.list.findIndex((a: { id?: string }) => a?.id === id);
        if (idx >= 0) {
          if (!raw.agents.list[idx].model) {
            raw.agents.list[idx] = { ...raw.agents.list[idx], model: defaultModel };
          }
        } else {
          raw.agents.list.push({ id, model: defaultModel });
        }
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
        this.ensureSubagentToolsDenied([id]);
      } catch { /* 写入失败不影响导入结果 */ }

      const skills = this.readWorkspaceSkills(id);
      return { ok: true, skills };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async openFileDialog(): Promise<string | null> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Worker Package', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  }

  async openSkillDirDialog(): Promise<{ path: string; kind: 'directory' | 'skillFile'; suggestedName?: string } | null> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Skill', extensions: ['md'] }],
    });
    if (result.canceled) return null;
    const selectedPath = result.filePaths[0];
    if (!selectedPath || !fs.existsSync(selectedPath)) return null;

    const stat = fs.statSync(selectedPath);
    if (stat.isDirectory()) {
      return { path: selectedPath, kind: 'directory' };
    }

    const baseName = path.basename(selectedPath);
    if (!stat.isFile() || baseName.toLowerCase() !== 'skill.md') {
      throw new Error('请选择 Skill 文件夹或 SKILL.md 文件');
    }

    const firstFiveLines = fs.readFileSync(selectedPath, 'utf8').split(/\r?\n/).slice(0, 5);
    const nameLine = firstFiveLines.find((line) => /^\s*name\s*:/i.test(line));
    const suggestedName = nameLine?.replace(/^\s*name\s*:\s*/i, '').trim() || '';
    return { path: selectedPath, kind: 'skillFile', suggestedName };
  }

  openOpenClawDir(): Promise<string> {
    const dirPath = path.join(this.paths.userOpenClawHome, '.openclaw');
    fs.mkdirSync(dirPath, { recursive: true });
    return shell.openPath(dirPath);
  }

  openWorkerDir(workerId: string): Promise<string> {
    const dirPath = this.paths.workerAgentWorkspacePath(workerId);
    fs.mkdirSync(dirPath, { recursive: true });
    return shell.openPath(dirPath);
  }

  openWorkerDirInCursor(workerId: string): Promise<{ ok: boolean; error?: string }> {
    const dirPath = this.paths.workerAgentWorkspacePath(workerId);
    fs.mkdirSync(dirPath, { recursive: true });
    return new Promise((resolve) => {
      let settled = false;
      const augmentedPath = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`;
      const child = spawn('cursor', [dirPath], {
        shell: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: augmentedPath },
      });
      child.unref();
      child.on('error', (err) => {
        if (!settled) { settled = true; resolve({ ok: false, error: `无法启动 Cursor: ${err.message}` }); }
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          if (code === 0 || code === null) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `Cursor 启动失败，请确认已安装 cursor 命令行工具 (exit ${code})` });
          }
        }
      });
      // fallback: if cursor detaches without closing the wrapper shell
      setTimeout(() => {
        if (!settled) { settled = true; resolve({ ok: true }); }
      }, 3000);
    });
  }

  openFileLocation(workerId: string, filePath: string): Promise<string> {
    const workspacePath = this.paths.workerAgentWorkspacePath(workerId);
    const targetPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspacePath, filePath);
    const targetDir = path.dirname(targetPath);
    fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      shell.showItemInFolder(targetPath);
      return Promise.resolve('');
    }
    return shell.openPath(targetDir);
  }

  traceMessageChain(messageId: string): Promise<{ output: string; missingPython?: boolean }> {
    const trimmedMessageId = (messageId || '').trim();
    if (!trimmedMessageId) {
      return Promise.resolve({ output: 'messageId 不能为空' });
    }

    const scriptPath = path.resolve(this.paths.projectRoot, '../../trace-message-chain.py');
    if (!fs.existsSync(scriptPath)) {
      return Promise.resolve({ output: `未找到 trace-message-chain.py: ${scriptPath}` });
    }

    return new Promise((resolve) => {
      const child = spawn('python3', ['trace-message-chain.py', trimmedMessageId], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (err.code === 'ENOENT') {
          resolve({ output: '缺少python环境', missingPython: true });
          return;
        }
        resolve({ output: `执行失败: ${err.message || String(err)}` });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;

        if (code === 0) {
          const result = (stdout || '').trim();
          resolve({ output: result || '(无输出)' });
          return;
        }

        const errText = (stderr || '').trim();
        if (code === 127 || /command not found|not found/i.test(errText)) {
          resolve({ output: '缺少python环境', missingPython: true });
          return;
        }

        const fallback = [
          `执行失败 (code=${code ?? 'unknown'})`,
          errText || (stdout || '').trim() || '无错误输出',
        ]
          .filter(Boolean)
          .join('\n');
        resolve({ output: fallback });
      });
    });
  }
}
