export type Role = 'user' | 'assistant';

export interface ImageInput {
  mediaType: string;
  data: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };

export type MessageContent = string | ContentBlock[];

export interface ChatMessage {
  role: Role;
  content: MessageContent;
  timestamp?: number;
  msgId?: string;
}

export interface WorkerMeta {
  id: string;
  name: string;
  description?: string;
  path: string;
  mode?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  cmd: string;
}

export interface GatewayStatus {
  rpc: { ok: boolean; error?: string; url: string };
  gateway: { port: number; bindHost: string; bindMode: string };
  port: { status: string };
  service: { loaded: boolean; runtime: { status: string; missingUnit?: boolean } };
  logFile: string;
}

export interface ChatResult extends ExecResult {
  reply: string;
}

export interface SaveKeyResult {
  ok: boolean;
  detail: ExecResult;
  modelDetail: ExecResult;
}

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramChannel {
  accountId: string;
  bot: TelegramBotInfo | null;
  agentId?: string;
}

export interface TelegramAddResult {
  ok: boolean;
  bot?: TelegramBotInfo;
  error?: string;
}

export interface WorkerZipProbe {
  tempDir: string;
  rootDir: string;
  suggestedId: string;
  suggestedName: string;
  suggestedDescription: string;
}

export interface SkillMeta {
  id?: string;
  name: string;
  description: string;
}

export interface WorkerInstallResult {
  ok: boolean;
  error?: string;
  skills?: SkillMeta[];
}

export interface WorkerExportResult {
  ok: boolean;
  error?: string;
  canceled?: boolean;
  savedPath?: string;
}

export interface SkillContentResult {
  ok: boolean;
  error?: string;
  content?: string;
}

export interface SkillInstallResult {
  ok: boolean;
  error?: string;
  skills?: SkillMeta[];
}

export interface GroupChannel {
  id: string;
  name: string;
  workerIds: string[];
}

export interface GroupMessage {
  id: string;
  msgId?: string;
  role: 'user' | 'worker' | 'system' | 'debug';
  workerId?: string;
  workerName?: string;
  content: string;
}

export interface CoordinatorTask {
  id: string;
  workerId: string;
  message: string;
  after: string[];
}

export interface CoordinatorPlan {
  analysis: string;
  tasks: CoordinatorTask[];
}
