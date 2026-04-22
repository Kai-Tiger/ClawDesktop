import type {
  WorkerMeta,
  ChatResult,
  SaveKeyResult,
  ExecResult,
  GatewayStatus,
  TelegramChannel,
  TelegramAddResult,
  WorkerZipProbe,
  WorkerInstallResult,
  WorkerExportResult,
  SkillContentResult,
  SkillInstallResult,
  SkillMeta,
  GroupChannel,
  ImageInput,
  MessageContent,
} from '../types';

interface ChatHistory {
  messages: Record<string, { role: string; content: MessageContent }[]>;
  groupMessages: Record<string, { id: string; role: string; workerId?: string; workerName?: string; content: string }[]>;
}

interface GatewayApi {
  status: () => Promise<GatewayStatus>;
  start: () => Promise<{ ok: boolean; message: string }>;
  stop: () => Promise<{ ok: boolean; message: string }>;
  debug: () => Promise<unknown>;
  getOpenRouterKey: () => Promise<string>;
  saveOpenRouterKey: (apiKey: string) => Promise<SaveKeyResult>;
  workersList: () => Promise<WorkerMeta[]>;
  chatSend: (workerId: string, message: string, images?: ImageInput[], history?: { role: string; content: MessageContent }[]) => Promise<ChatResult>;
  telegramList: () => Promise<TelegramChannel[]>;
  telegramAdd: (token: string, workerId?: string) => Promise<TelegramAddResult>;
  telegramRemove: (accountId: string) => Promise<{ ok: boolean; error?: string }>;
  workerOpenFileDialog: () => Promise<string | null>;
  workerOpenSkillDirDialog: () => Promise<string | null>;
  workerGetInternZipPath: () => Promise<string>;
  workerProbeZip: (zipPath: string) => Promise<WorkerZipProbe>;
  workerInstallFromTemp: (tempDir: string, rootDir: string, id: string, name: string, description: string) => Promise<WorkerInstallResult>;
  workerExport: (workerId: string) => Promise<WorkerExportResult>;
  workerListSkills: (workerId: string) => Promise<SkillMeta[]>;
  workerReadSkill: (workerId: string, skillId: string) => Promise<SkillContentResult>;
  workerSaveSkill: (workerId: string, skillId: string, content: string) => Promise<SkillContentResult>;
  workerInstallSkillFromDir: (workerId: string, skillDirPath: string) => Promise<SkillInstallResult>;
  groupsList: () => Promise<GroupChannel[]>;
  groupsCreate: (name: string, workerIds: string[]) => Promise<GroupChannel>;
  groupsDelete: (id: string) => Promise<{ ok: boolean }>;
  toggleDevTools: () => Promise<void>;
  openDashboard: () => Promise<void>;
  getModel: () => Promise<string>;
  setModel: (model: string) => Promise<{ ok: boolean; error?: string }>;
  getWorkerModel: (workerId: string) => Promise<string>;
  setWorkerModel: (workerId: string, model: string) => Promise<{ ok: boolean; error?: string }>;
  workerDelete: (workerId: string) => Promise<{ ok: boolean; error?: string }>;
  getChatHistory: () => Promise<ChatHistory>;
  saveHistory: (data: ChatHistory) => void;
  onChatChunk: (cb: (data: { workerId: string; chunk: string }) => void) => () => void;
  onChatStatus: (cb: (data: { workerId: string; status: string }) => void) => () => void;
}

const api = () => (window as unknown as { gatewayApi: GatewayApi }).gatewayApi;

export const gatewayStatus = () => api().status();
export const gatewayStart = () => api().start();
export const gatewayStop = () => api().stop();
export const gatewayDebug = () => api().debug();
export const getOpenRouterKey = () => api().getOpenRouterKey();
export const saveOpenRouterKey = (key: string) => api().saveOpenRouterKey(key);
export const workersList = () => api().workersList();
export const chatSend = (
  workerId: string,
  message: string,
  images?: ImageInput[],
  history?: { role: string; content: MessageContent }[]
) => api().chatSend(workerId, message, images, history);
export const telegramList = () => api().telegramList();
export const telegramAdd = (token: string, workerId?: string) => api().telegramAdd(token, workerId);
export const telegramRemove = (accountId: string) => api().telegramRemove(accountId);
export const workerOpenFileDialog = () => api().workerOpenFileDialog();
export const workerOpenSkillDirDialog = () => api().workerOpenSkillDirDialog();
export const workerGetInternZipPath = () => api().workerGetInternZipPath();
export const workerProbeZip = (zipPath: string) => api().workerProbeZip(zipPath);
export const workerInstallFromTemp = (tempDir: string, rootDir: string, id: string, name: string, description: string) =>
  api().workerInstallFromTemp(tempDir, rootDir, id, name, description);
export const workerExport = (workerId: string) => api().workerExport(workerId);
export const workerListSkills = (workerId: string) => api().workerListSkills(workerId);
export const workerReadSkill = (workerId: string, skillId: string) => api().workerReadSkill(workerId, skillId);
export const workerSaveSkill = (workerId: string, skillId: string, content: string) => api().workerSaveSkill(workerId, skillId, content);
export const workerInstallSkillFromDir = (workerId: string, skillDirPath: string) => api().workerInstallSkillFromDir(workerId, skillDirPath);
export const groupsList = () => api().groupsList();
export const groupsCreate = (name: string, workerIds: string[]) => api().groupsCreate(name, workerIds);
export const groupsDelete = (id: string) => api().groupsDelete(id);
export const toggleDevTools = () => api().toggleDevTools();
export const openDashboard = () => api().openDashboard();
export const getModel = () => api().getModel();
export const setModel = (model: string) => api().setModel(model);
export const getWorkerModel = (workerId: string) => api().getWorkerModel(workerId);
export const setWorkerModel = (workerId: string, model: string) => api().setWorkerModel(workerId, model);
export const workerDelete = (workerId: string) => api().workerDelete(workerId);
export const getChatHistory = () => api().getChatHistory();
export const saveHistory = (data: ChatHistory) => api().saveHistory(data);
export const onChatChunk = (cb: (data: { workerId: string; chunk: string }) => void) =>
  api().onChatChunk(cb);
export const onChatStatus = (cb: (data: { workerId: string; status: string }) => void) =>
  api().onChatStatus(cb);
