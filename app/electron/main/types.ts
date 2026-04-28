export type ExecResult = { code: number | null; stdout: string; stderr: string; cmd: string };
export type GatewayStatus = {
  rpc: { ok: boolean; error?: string; url: string };
  gateway: { port: number; bindHost: string; bindMode: string };
  port: { status: string };
  service: { loaded: boolean; runtime: { status: string; missingUnit?: boolean } };
  logFile: string;
};
export type ChatResult = ExecResult & { reply: string };
export type WorkerMeta = { id: string; name: string; description?: string; path: string; mode?: string };
export type SaveKeyResult = { ok: boolean; detail: ExecResult; modelDetail: ExecResult };
export type SkillMeta = { id?: string; name: string; description: string };
export type TelegramBotInfo = { id: number; username: string; firstName: string };
export type TelegramChannel = { accountId: string; bot: TelegramBotInfo | null; agentId?: string };
export type TelegramAddResult = { ok: boolean; bot?: TelegramBotInfo; error?: string };
export type WorkerExportResult = { ok: boolean; error?: string; canceled?: boolean; savedPath?: string };
export type SkillContentResult = { ok: boolean; error?: string; content?: string };
export type AgentBindResult = { added?: string[]; updated?: string[]; skipped?: string[]; conflicts?: string[] };
export type ImageInput = { mediaType: string; data: string };
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };
export type MessageContent = string | MessageContentBlock[];
export type MessageItem = { role: string; content: MessageContent };
export type GroupData = { id: string; name: string; workerIds: string[] };

export interface WsInstance {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}
