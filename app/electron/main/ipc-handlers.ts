import { ipcMain, shell, app, BrowserWindow } from 'electron';
import path from 'node:path';
import type { GatewayService } from './gateway-service';
import type { ConfigService } from './config-service';
import type { WorkerService } from './worker-service';
import type { ChatService } from './chat-service';
import type { TelegramService } from './telegram-service';
import type { GroupService } from './group-service';
import type { SessionService } from './session-service';
import type { CoordinatorService } from './coordinator-service';
import type { ImageInput, MessageItem } from './types';

export function registerIpcHandlers(opts: {
  gateway: GatewayService;
  config: ConfigService;
  workers: WorkerService;
  chat: ChatService;
  telegram: TelegramService;
  groups: GroupService;
  sessions: SessionService;
  coordinator: CoordinatorService;
  mainWindowRef: { current: BrowserWindow | null };
}) {
  const { gateway, config, workers, chat, telegram, groups, sessions, coordinator, mainWindowRef } = opts;

  ipcMain.handle('gateway:status', async () => gateway.statusJson());
  ipcMain.handle('gateway:start', async () => gateway.startGateway());
  ipcMain.handle('gateway:stop', () => gateway.stopGateway());
  ipcMain.handle('gateway:debug', async () => config.debugInfo());
  ipcMain.handle('settings:getOpenRouterKey', () => config.getOpenRouterKey());
  ipcMain.handle('settings:saveOpenRouterKey', async (_evt, apiKey: string) => config.saveOpenRouterKey(apiKey));
  ipcMain.handle('settings:getModel', () => config.getModel());
  ipcMain.handle('settings:setModel', async (_evt, model: string) => config.setModel(model));
  ipcMain.handle('settings:getWorkerModel', (_evt, workerId: string) => config.getWorkerModel(workerId));
  ipcMain.handle('settings:setWorkerModel', async (_evt, workerId: string, model: string) => config.setWorkerModel(workerId, model));
  ipcMain.handle('workers:list', async () => workers.listWorkers());
  ipcMain.handle('channels:telegram:list', async () => telegram.listTelegramChannels());
  ipcMain.handle('channels:telegram:add', async (_evt, token: string, workerId?: string) => telegram.addTelegramChannel(token, workerId));
  ipcMain.handle('channels:telegram:remove', async (_evt, accountId: string) => telegram.removeTelegramChannel(accountId));
  ipcMain.handle('chat:send', async (_evt, payload: { workerId: string; message: string; images?: ImageInput[]; history?: MessageItem[]; traceId?: string; groupId?: string }) => {
    return chat.chat(payload?.workerId || '', payload?.message || '', payload?.images, payload?.history, payload?.traceId, payload?.groupId);
  });
  ipcMain.handle('chat:getHistory', () => chat.getChatHistory());
  ipcMain.on('chat:saveHistory', (_evt, data) => chat.saveChatHistory(data));
  ipcMain.handle('workers:open-file-dialog', () => workers.openFileDialog());
  ipcMain.handle('workers:open-skill-dir-dialog', () => workers.openSkillDirDialog());
  ipcMain.handle('workers:get-intern-zip-path', () => workers.getInternZipPath());
  ipcMain.handle('workers:get-blank-zip-path', () => workers.getBlankZipPath());
  ipcMain.handle('workers:install-skill-from-dir', (_evt, workerId: string, skillDirPath: string) =>
    workers.installSkillFromDir(workerId, skillDirPath)
  );
  ipcMain.handle('workers:probe-zip', async (_evt, zipPath: string) => workers.probeWorkerZip(zipPath));
  ipcMain.handle('workers:install-from-temp', async (_evt, tempDir: string, rootDir: string, id: string, name: string, description: string) =>
    workers.installWorkerFromTemp(tempDir, rootDir, id, name, description)
  );
  ipcMain.handle('workers:export', async (_evt, workerId: string) => workers.exportWorker(workerId));
  ipcMain.handle('workers:list-skills', (_evt, workerId: string) => workers.readWorkspaceSkills(workerId));
  ipcMain.handle('workers:read-skill', (_evt, workerId: string, skillId: string) => workers.readSkillContent(workerId, skillId));
  ipcMain.handle('workers:save-skill', (_evt, workerId: string, skillId: string, content: string) =>
    workers.saveSkillContent(workerId, skillId, content)
  );
  ipcMain.handle('workers:delete', (_evt, workerId: string) => workers.deleteWorker(workerId));
  ipcMain.handle('groups:list', () => groups.listGroups());
  ipcMain.handle('groups:create', (_evt, name: string, workerIds: string[]) => groups.createGroup(name, workerIds));
  ipcMain.handle('groups:delete', (_evt, id: string) => groups.deleteGroup(id));
  ipcMain.handle('groups:update', (_evt, id: string, workerIds: string[]) => groups.updateGroup(id, workerIds));
  ipcMain.handle('chat:clearWorkerSessions', (_evt, workerIds: string[], groupId?: string) => {
    if (groupId) {
      (workerIds || []).forEach((id) => {
        sessions.clearGroupSession(id, groupId);
        sessions.clearAgentSessionSnapshot(id);
      });
    } else {
      (workerIds || []).forEach((id) => sessions.clearAgentSessionSnapshot(id));
    }
  });
  ipcMain.handle('coordinator:getModel', () => config.getCoordinatorModel());
  ipcMain.handle('coordinator:setModel', async (_evt, model: string) => config.setCoordinatorModel(model));
  ipcMain.handle('coordinator:plan', async (_evt, payload: {
    userMessage: string;
    workers: { id: string; name: string; description?: string }[];
    fileContext?: string;
  }) => coordinator.coordinatorPlan(payload.userMessage, payload.workers, payload.fileContext));
  ipcMain.handle('logs:openDir', () => shell.openPath(path.join(app.getPath('userData'), 'runtime', 'logs')));
  ipcMain.handle('debug:toggle-devtools', () => { mainWindowRef.current?.webContents.toggleDevTools(); });
  ipcMain.handle('debug:open-dashboard', () => { shell.openExternal(`http://127.0.0.1:${gateway.gatewayPort}`); });
  ipcMain.handle('workers:open-openclaw-dir', () => workers.openOpenClawDir());
  ipcMain.handle('workers:open-worker-dir', (_evt, workerId: string) => workers.openWorkerDir(workerId));
  ipcMain.handle('workers:open-file-location', (_evt, workerId: string, filePath: string) => workers.openFileLocation(workerId, filePath));
  ipcMain.handle('chat:trace-message-chain', (_evt, messageId: string) => workers.traceMessageChain(messageId));
  ipcMain.handle('workers:update-meta', (_evt, workerId: string, name: string, description: string) => workers.updateWorkerMeta(workerId, name, description));
}
