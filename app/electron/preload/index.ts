import { contextBridge, ipcRenderer } from 'electron';

type PreloadContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };

type PreloadMessageItem = { role: string; content: string | PreloadContentBlock[] };

contextBridge.exposeInMainWorld('gatewayApi', {
  status: () => ipcRenderer.invoke('gateway:status'),
  start: () => ipcRenderer.invoke('gateway:start'),
  stop: () => ipcRenderer.invoke('gateway:stop'),
  debug: () => ipcRenderer.invoke('gateway:debug'),
  getOpenRouterKey: () => ipcRenderer.invoke('settings:getOpenRouterKey'),
  saveOpenRouterKey: (apiKey: string) => ipcRenderer.invoke('settings:saveOpenRouterKey', apiKey),
  workersList: () => ipcRenderer.invoke('workers:list'),
  chatSend: (
    workerId: string,
    message: string,
    images?: { mediaType: string; data: string }[],
    history?: PreloadMessageItem[],
    traceId?: string,
    groupId?: string
  ) => ipcRenderer.invoke('chat:send', { workerId, message, images, history, traceId, groupId }),
  telegramList: () => ipcRenderer.invoke('channels:telegram:list'),
  telegramAdd: (token: string, workerId?: string) => ipcRenderer.invoke('channels:telegram:add', token, workerId),
  telegramRemove: (accountId: string) => ipcRenderer.invoke('channels:telegram:remove', accountId),
  workerOpenFileDialog: () => ipcRenderer.invoke('workers:open-file-dialog'),
  workerOpenSkillDirDialog: () => ipcRenderer.invoke('workers:open-skill-dir-dialog'),
  workerGetInternZipPath: () => ipcRenderer.invoke('workers:get-intern-zip-path'),
  workerGetBlankZipPath: () => ipcRenderer.invoke('workers:get-blank-zip-path'),
  workerProbeZip: (zipPath: string) => ipcRenderer.invoke('workers:probe-zip', zipPath),
  workerInstallFromTemp: (tempDir: string, rootDir: string, id: string, name: string, description: string) =>
    ipcRenderer.invoke('workers:install-from-temp', tempDir, rootDir, id, name, description),
  workerExport: (workerId: string) => ipcRenderer.invoke('workers:export', workerId),
  workerListSkills: (workerId: string) => ipcRenderer.invoke('workers:list-skills', workerId),
  workerReadSkill: (workerId: string, skillId: string) => ipcRenderer.invoke('workers:read-skill', workerId, skillId),
  workerSaveSkill: (workerId: string, skillId: string, content: string) =>
    ipcRenderer.invoke('workers:save-skill', workerId, skillId, content),
  workerInstallSkillFromDir: (workerId: string, skillDirPath: string, skillName?: string) =>
    ipcRenderer.invoke('workers:install-skill-from-dir', workerId, skillDirPath, skillName),
  groupsList: () => ipcRenderer.invoke('groups:list'),
  groupsCreate: (name: string, workerIds: string[]) => ipcRenderer.invoke('groups:create', name, workerIds),
  groupsDelete: (id: string) => ipcRenderer.invoke('groups:delete', id),
  groupsUpdate: (id: string, workerIds: string[]) => ipcRenderer.invoke('groups:update', id, workerIds),
  openLogsDir: () => ipcRenderer.invoke('logs:openDir'),
  toggleDevTools: () => ipcRenderer.invoke('debug:toggle-devtools'),
  openDashboard: () => ipcRenderer.invoke('debug:open-dashboard'),
  workerOpenOpenClawDir: () => ipcRenderer.invoke('workers:open-openclaw-dir'),
  workerOpenWorkerDir: (workerId: string) => ipcRenderer.invoke('workers:open-worker-dir', workerId),
  workerOpenFileLocation: (workerId: string, filePath: string) => ipcRenderer.invoke('workers:open-file-location', workerId, filePath),
  workerOpenInCursor: (workerId: string) => ipcRenderer.invoke('workers:open-in-cursor', workerId),
  traceMessageChain: (messageId: string) => ipcRenderer.invoke('chat:trace-message-chain', messageId),
  workerUpdateMeta: (workerId: string, name: string, description: string) => ipcRenderer.invoke('workers:update-meta', workerId, name, description),
  getModel: () => ipcRenderer.invoke('settings:getModel'),
  setModel: (model: string) => ipcRenderer.invoke('settings:setModel', model),
  getWorkerModel: (workerId: string) => ipcRenderer.invoke('settings:getWorkerModel', workerId),
  setWorkerModel: (workerId: string, model: string) => ipcRenderer.invoke('settings:setWorkerModel', workerId, model),
  getWorkerTools: (workerId: string) => ipcRenderer.invoke('settings:getWorkerTools', workerId),
  setWorkerToolEnabled: (workerId: string, toolId: string, enabled: boolean) =>
    ipcRenderer.invoke('settings:setWorkerToolEnabled', workerId, toolId, enabled),
  applyWorkerImagePreset: (workerId: string, model?: string) => ipcRenderer.invoke('settings:applyWorkerImagePreset', workerId, model),
  workerDelete: (workerId: string) => ipcRenderer.invoke('workers:delete', workerId),
  workerCopy: (sourceId: string, newId: string, newName: string, newDescription: string) =>
    ipcRenderer.invoke('workers:copy', sourceId, newId, newName, newDescription),
  getChatHistory: () => ipcRenderer.invoke('chat:getHistory'),
  saveHistory: (data: unknown) => ipcRenderer.send('chat:saveHistory', data),
  saveChatImage: (msgId: string, dataUrl: string) => ipcRenderer.invoke('chat:saveImage', { msgId, dataUrl }),
  saveImageFromUrl: (url: string) => ipcRenderer.invoke('chat:saveImageFromUrl', url),
  clearWorkerSessions: (workerIds: string[], groupId?: string) => ipcRenderer.invoke('chat:clearWorkerSessions', workerIds, groupId),
  coordinatorGetModel: () => ipcRenderer.invoke('coordinator:getModel'),
  coordinatorSetModel: (model: string) => ipcRenderer.invoke('coordinator:setModel', model),
  coordinatorPlan: (payload: { userMessage: string; workers: { id: string; name: string; description?: string }[]; fileContext?: string }) =>
    ipcRenderer.invoke('coordinator:plan', payload),
  onChatChunk: (cb: (data: { workerId: string; chunk: string; groupId?: string | null; msgId?: string | null }) => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, data: { workerId: string; chunk: string; groupId?: string | null; msgId?: string | null }) => cb(data);
    ipcRenderer.on('chat:chunk', handler);
    return () => ipcRenderer.removeListener('chat:chunk', handler);
  },
  onCronMessage: (cb: (data: { workerId: string; content: string; role: string }) => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, data: { workerId: string; content: string; role: string }) => cb(data);
    ipcRenderer.on('cron:message', handler);
    return () => ipcRenderer.removeListener('cron:message', handler);
  },
  mobileConnectionInfo: () => ipcRenderer.invoke('mobile:connectionInfo'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  groupMemoryList: (groupId: string) => ipcRenderer.invoke('group:memory:list', groupId),
  groupMemoryRead: (groupId: string, filename: string) => ipcRenderer.invoke('group:memory:read', groupId, filename),
  groupMemoryWrite: (groupId: string, filename: string, content: string) => ipcRenderer.invoke('group:memory:write', groupId, filename, content),
  groupMemoryDelete: (groupId: string, filename: string) => ipcRenderer.invoke('group:memory:delete', groupId, filename),
});
