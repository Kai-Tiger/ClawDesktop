import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { GroupData } from './types';
import type { OpenClawPaths } from './paths';

const GROUP_SHARED_MARKER_PREFIX = '<!-- GROUP_SHARED_PATH:';
const GROUP_SHARED_MARKER_SUFFIX = '<!-- /GROUP_SHARED_PATH -->';

export class GroupService {
  constructor(private readonly paths: OpenClawPaths) {}

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
    this.ensureGroupDirs(group.id);
    for (const wid of workerIds) {
      this.addWorkerToGroupShared(group.id, wid);
    }
    return group;
  }

  deleteGroup(id: string): { ok: boolean } {
    const group = this.listGroups().find((g) => g.id === id);
    if (group) {
      for (const wid of group.workerIds) {
        this.removeWorkerFromGroupShared(id, wid);
      }
    }
    const groups = this.listGroups().filter((g) => g.id !== id);
    fs.writeFileSync(this.groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
    return { ok: true };
  }

  updateGroup(id: string, workerIds: string[]): { ok: boolean; error?: string } {
    const groups = this.listGroups();
    const idx = groups.findIndex((g) => g.id === id);
    if (idx === -1) return { ok: false, error: 'group 不存在' };

    const prev = new Set(groups[idx].workerIds);
    const next = new Set(workerIds);

    for (const wid of workerIds) {
      if (!prev.has(wid)) this.addWorkerToGroupShared(id, wid);
    }
    for (const wid of groups[idx].workerIds) {
      if (!next.has(wid)) this.removeWorkerFromGroupShared(id, wid);
    }

    groups[idx] = { ...groups[idx], workerIds };
    fs.writeFileSync(this.groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
    return { ok: true };
  }

  // ── Group directory helpers ──────────────────────────────────────────────

  private ensureGroupDirs(groupId: string): void {
    fs.mkdirSync(this.paths.groupMemoryDir(groupId), { recursive: true });
    fs.mkdirSync(this.paths.groupSharedDir(groupId), { recursive: true });
  }

  // ── Shared directory path permission management ──────────────────────────

  private sharedBlock(groupId: string): string {
    const sharedDir = this.paths.groupSharedDir(groupId);
    return [
      `${GROUP_SHARED_MARKER_PREFIX} ${groupId} -->`,
      '## Group Shared Directory (Clawin Desktop)',
      `- Group shared path: ${sharedDir}`,
      '- Workers in this group are authorized to read and write files in the shared directory.',
      '- Always use the absolute path shown above when referencing shared files.',
      '- Wrap paths in double quotes in shell commands if they contain spaces.',
      GROUP_SHARED_MARKER_SUFFIX,
    ].join('\n');
  }

  private addWorkerToGroupShared(groupId: string, workerId: string): void {
    this.ensureGroupDirs(groupId);
    const toolsMd = path.join(this.paths.workerAgentWorkspacePath(workerId), 'TOOLS.md');
    if (!fs.existsSync(toolsMd)) return;
    try {
      const current = fs.readFileSync(toolsMd, 'utf8');
      const marker = `${GROUP_SHARED_MARKER_PREFIX} ${groupId} -->`;
      if (current.includes(marker)) return;
      fs.writeFileSync(toolsMd, `${current}\n${this.sharedBlock(groupId)}\n`, 'utf8');
    } catch { /* ignore */ }
  }

  private removeWorkerFromGroupShared(groupId: string, workerId: string): void {
    const toolsMd = path.join(this.paths.workerAgentWorkspacePath(workerId), 'TOOLS.md');
    if (!fs.existsSync(toolsMd)) return;
    try {
      const current = fs.readFileSync(toolsMd, 'utf8');
      const marker = `${GROUP_SHARED_MARKER_PREFIX} ${groupId} -->`;
      if (!current.includes(marker)) return;
      const cleaned = current
        .split('\n')
        .reduce<{ out: string[]; skip: boolean }>((acc, line) => {
          if (line.includes(marker)) return { out: acc.out, skip: true };
          if (acc.skip && line === GROUP_SHARED_MARKER_SUFFIX) return { out: acc.out, skip: false };
          if (!acc.skip) acc.out.push(line);
          return acc;
        }, { out: [], skip: false })
        .out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(toolsMd, cleaned, 'utf8');
    } catch { /* ignore */ }
  }

  // ── Group memory CRUD ────────────────────────────────────────────────────

  listGroupMemory(groupId: string): string[] {
    const dir = this.paths.groupMemoryDir(groupId);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch { return []; }
  }

  readGroupMemory(groupId: string, filename: string): { ok: boolean; content?: string; error?: string } {
    const safe = this.safeFilename(filename);
    if (!safe) return { ok: false, error: '非法文件名' };
    const p = path.join(this.paths.groupMemoryDir(groupId), safe);
    try {
      return { ok: true, content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  writeGroupMemory(groupId: string, filename: string, content: string): { ok: boolean; error?: string } {
    const safe = this.safeFilename(filename);
    if (!safe) return { ok: false, error: '非法文件名' };
    const dir = this.paths.groupMemoryDir(groupId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, safe), content, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  deleteGroupMemory(groupId: string, filename: string): { ok: boolean; error?: string } {
    const safe = this.safeFilename(filename);
    if (!safe) return { ok: false, error: '非法文件名' };
    const p = path.join(this.paths.groupMemoryDir(groupId), safe);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private safeFilename(filename: string): string | null {
    const f = (filename || '').trim();
    if (!f || f.includes('/') || f.includes('\\') || f.startsWith('.')) return null;
    if (!f.endsWith('.md')) return null;
    return f;
  }
}
