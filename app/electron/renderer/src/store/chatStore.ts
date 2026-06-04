import { create } from 'zustand';
import type { WorkerMeta, ChatMessage, GroupChannel, GroupMessage, ThreadMessage, MessageContent } from '../types';
import { saveHistory } from '../api/gateway';

const isThinkingContent = (content: MessageContent | string) =>
  typeof content === 'string' && (content === '思考中…' || content === '思考中...');

interface ChatStore {
  workers: WorkerMeta[];
  currentWorkerId: string;
  messages: Record<string, ChatMessage[]>;
  sending: Record<string, boolean>;

  groups: GroupChannel[];
  currentGroupId: string | null;
  groupMessages: Record<string, GroupMessage[]>;

  currentView: 'worker' | 'group';
  sidebarVisible: boolean;

  setWorkers: (workers: WorkerMeta[]) => void;
  selectWorker: (id: string) => void;
  pushMessage: (workerId: string, msg: ChatMessage) => void;
  updateLastMessage: (workerId: string, content: MessageContent) => void;
  updateMessageById: (workerId: string, msgId: string, content: MessageContent) => void;
  appendToLastMessage: (workerId: string, chunk: string) => void;
  setSending: (workerId: string, value: boolean) => void;
  clearMessages: (workerId: string) => void;

  setGroups: (groups: GroupChannel[]) => void;
  selectGroup: (id: string) => void;
  addGroupMessage: (groupId: string, msg: GroupMessage) => void;
  updateGroupMessage: (groupId: string, msgId: string, content: MessageContent, completedAt?: number) => void;
  clearGroupMessages: (groupId: string) => void;
  addThreadMessage: (groupId: string, parentMsgId: string, msg: ThreadMessage) => void;
  updateThreadMessage: (groupId: string, parentMsgId: string, threadMsgId: string, content: MessageContent, completedAt?: number) => void;
  toggleSidebar: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  workers: [],
  currentWorkerId: '',
  messages: {},
  sending: {},

  groups: [],
  currentGroupId: null,
  groupMessages: {},

  currentView: 'worker',
  sidebarVisible: true,

  setWorkers: (workers) =>
    set((state) => {
      const first = workers[0];
      const currentWorkerId = state.currentWorkerId || first?.id || '';
      const messages = { ...state.messages };
      if (first && !messages[first.id]) {
        messages[first.id] = [
          { role: 'assistant', content: `你好，我是 ${first.name || first.id}。` },
        ];
      }
      return { workers, currentWorkerId, messages };
    }),

  selectWorker: (id) =>
    set({ currentWorkerId: id, currentView: 'worker', currentGroupId: null }),

  pushMessage: (workerId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [workerId]: [...(state.messages[workerId] ?? []), { ...msg, timestamp: msg.timestamp ?? Date.now() }],
      },
    })),

  updateLastMessage: (workerId, content) =>
    set((state) => {
      const list = [...(state.messages[workerId] ?? [])];
      if (list.length > 0) list[list.length - 1] = { ...list[list.length - 1], content, completedAt: Date.now() };
      return { messages: { ...state.messages, [workerId]: list } };
    }),

  updateMessageById: (workerId, msgId, content) =>
    set((state) => {
      const list = [...(state.messages[workerId] ?? [])];
      const idx = list.findIndex((m) => m.msgId === msgId);
      if (idx < 0) return {};
      list[idx] = { ...list[idx], content, completedAt: Date.now() };
      return { messages: { ...state.messages, [workerId]: list } };
    }),

  appendToLastMessage: (workerId, chunk) =>
    set((state) => {
      const list = [...(state.messages[workerId] ?? [])];
      if (list.length === 0) return {};
      const last = list[list.length - 1];
      const base = isThinkingContent(last.content) || typeof last.content !== 'string' ? '' : last.content;
      list[list.length - 1] = { ...last, content: base + chunk };
      return { messages: { ...state.messages, [workerId]: list } };
    }),

  setSending: (workerId, value) =>
    set((state) => ({ sending: { ...state.sending, [workerId]: value } })),

  clearMessages: (workerId) =>
    set((state) => ({ messages: { ...state.messages, [workerId]: [] } })),

  setGroups: (groups) => set({ groups }),

  selectGroup: (id) =>
    set((state) => {
      const groupMessages = { ...state.groupMessages };
      if (!groupMessages[id]) groupMessages[id] = [];
      return { currentGroupId: id, currentView: 'group', currentWorkerId: '', groupMessages };
    }),

  addGroupMessage: (groupId, msg) =>
    set((state) => ({
      groupMessages: {
        ...state.groupMessages,
        [groupId]: [...(state.groupMessages[groupId] ?? []), { ...msg, timestamp: msg.timestamp ?? Date.now() }],
      },
    })),

  updateGroupMessage: (groupId, msgId, content, completedAt) =>
    set((state) => {
      const list = [...(state.groupMessages[groupId] ?? [])];
      const idx = list.findIndex((m) => m.id === msgId);
      if (idx >= 0) list[idx] = { ...list[idx], content, ...(completedAt !== undefined ? { completedAt } : {}) };
      return { groupMessages: { ...state.groupMessages, [groupId]: list } };
    }),

  clearGroupMessages: (groupId) =>
    set((state) => ({ groupMessages: { ...state.groupMessages, [groupId]: [] } })),

  addThreadMessage: (groupId, parentMsgId, msg) =>
    set((state) => {
      const list = [...(state.groupMessages[groupId] ?? [])];
      const idx = list.findIndex((m) => m.id === parentMsgId);
      if (idx < 0) return {};
      list[idx] = {
        ...list[idx],
        threadMessages: [...(list[idx].threadMessages ?? []), { ...msg, timestamp: msg.timestamp ?? Date.now() }],
      };
      return { groupMessages: { ...state.groupMessages, [groupId]: list } };
    }),

  updateThreadMessage: (groupId, parentMsgId, threadMsgId, content, completedAt) =>
    set((state) => {
      const list = [...(state.groupMessages[groupId] ?? [])];
      const idx = list.findIndex((m) => m.id === parentMsgId);
      if (idx < 0) return {};
      const threads = [...(list[idx].threadMessages ?? [])];
      const tIdx = threads.findIndex((t) => t.id === threadMsgId);
      if (tIdx < 0) return {};
      threads[tIdx] = { ...threads[tIdx], content, ...(completedAt !== undefined ? { completedAt } : {}) };
      list[idx] = { ...list[idx], threadMessages: threads };
      return { groupMessages: { ...state.groupMessages, [groupId]: list } };
    }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
}));

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
useChatStore.subscribe((state) => {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const filteredMessages: Record<string, ChatMessage[]> = {};
    for (const [k, v] of Object.entries(state.messages)) {
      filteredMessages[k] = v.filter((m) => !isThinkingContent(m.content));
    }
    const filteredGroupMessages: Record<string, GroupMessage[]> = {};
    for (const [k, v] of Object.entries(state.groupMessages)) {
      filteredGroupMessages[k] = v
        .filter((m) => !isThinkingContent(m.content))
        .map((m) => ({
          ...m,
          threadMessages: m.threadMessages?.filter((t) => !isThinkingContent(t.content)),
        }));
    }
    saveHistory({ messages: filteredMessages, groupMessages: filteredGroupMessages });
  }, 500);
});
