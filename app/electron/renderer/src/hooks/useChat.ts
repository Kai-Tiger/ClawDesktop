import { useEffect } from 'react';
import { chatSend, onChatChunk } from '../api/gateway';
import { useChatStore } from '../store/chatStore';
import type { ImageInput, MessageContent } from '../types';

const isThinking = (content: MessageContent) =>
  typeof content === 'string' && (content === '思考中…' || content === '思考中...');

export function useChat() {
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const messagesMap = useChatStore((s) => s.messages);
  const sendingMap = useChatStore((s) => s.sending);
  const { pushMessage, updateMessageById, appendToLastMessage, setSending } = useChatStore();

  useEffect(() => {
    return onChatChunk(({ workerId, chunk }) => {
      appendToLastMessage(workerId, chunk);
    });
  }, [appendToLastMessage]);

  const sending = !!sendingMap[currentWorkerId];

  const send = async (text: string, images?: ImageInput[]) => {
    const trimmed = text.trim();
    const picked = images ?? [];
    if ((!trimmed && picked.length === 0) || !currentWorkerId || sending) return;

    const workerId = currentWorkerId;
    setSending(workerId, true);

    const existingMessages = messagesMap[workerId] ?? [];
    const history = existingMessages
      .filter((m) => !isThinking(m.content))
      .map((m) => ({ role: m.role as string, content: m.content }));

    pushMessage(workerId, {
      role: 'user',
      content: picked.length === 0
        ? trimmed
        : [
            ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
            ...picked.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
          ],
    });
    const msgId = Math.random().toString(16).slice(2, 10);
    pushMessage(workerId, { role: 'assistant', content: '思考中…', msgId });

    try {
      const res = await chatSend(workerId, trimmed, picked, history, msgId);
      const reply = typeof res.reply === 'string' && !res.reply.trim() ? '(无回复)' : res.reply;
      updateMessageById(workerId, msgId, reply);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateMessageById(workerId, msgId, `调用失败: ${msg}`);
    } finally {
      setSending(workerId, false);
    }
  };

  return { send, sending };
}
