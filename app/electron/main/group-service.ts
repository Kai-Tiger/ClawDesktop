import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { GroupData } from './types';

export class GroupService {
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

  updateGroup(id: string, workerIds: string[]): { ok: boolean; error?: string } {
    const groups = this.listGroups();
    const idx = groups.findIndex((g) => g.id === id);
    if (idx === -1) return { ok: false, error: 'group 不存在' };
    groups[idx] = { ...groups[idx], workerIds };
    fs.writeFileSync(this.groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
    return { ok: true };
  }
}
