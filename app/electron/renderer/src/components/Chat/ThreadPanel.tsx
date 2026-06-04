import React, { useRef, useState, useEffect } from 'react';
import { useChatStore } from '../../store/chatStore';
import { chatSend } from '../../api/gateway';
import { MessageBubble } from './MessageBubble';
import type { GroupMessage, ContentBlock, MessageContent, WorkerMeta } from '../../types';
import styles from './ThreadPanel.module.css';

const PALETTE = ['#5b8cff', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

function workerColor(workerId: string, allIds: string[]) {
  return PALETTE[Math.max(0, allIds.indexOf(workerId)) % PALETTE.length];
}

function parseMentionedWorkers(text: string, workers: WorkerMeta[]): WorkerMeta[] {
  const regex = /@([\p{L}\p{N}\w\-]+)/gu;
  const targets: WorkerMeta[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const slug = m[1].toLowerCase();
    const w = workers.find(
      (x) =>
        x.name.toLowerCase().replace(/\s+/g, '') === slug ||
        x.id.toLowerCase() === slug
    );
    if (w && !targets.find((t) => t.id === w.id)) targets.push(w);
  }
  return targets;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeMsgId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function stripDirectiveTags(text: string): string {
  return text.replace(/\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+|audio_as_voice)\s*\]\]/gi, '').trim();
}

function isThinkingContent(content: MessageContent): boolean {
  return typeof content === 'string' && content === '思考中...';
}

function toPlainText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((b) => b.type === 'text' ? b.text : `[图片:${b.mediaType}]`).join('\n');
}

function stripDirectiveTagsInContent(content: MessageContent): MessageContent {
  if (typeof content === 'string') return stripDirectiveTags(content);
  const blocks: ContentBlock[] = content.map((block) =>
    block.type === 'text' ? { ...block, text: stripDirectiveTags(block.text) } : block
  );
  const hasImage = blocks.some((b) => b.type === 'image');
  const textBlocks = blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
  if (!hasImage) return textBlocks.map((b) => b.text).join('\n').trim();
  return blocks.filter((b) => b.type === 'image' || b.text.trim().length > 0);
}

function withWorkerPrefix(workerName: string | undefined, content: MessageContent): MessageContent {
  const prefix = `[${workerName || 'worker'}]: `;
  if (typeof content === 'string') return `${prefix}${content}`;
  return [{ type: 'text', text: prefix }, ...content];
}

function stripImages(content: MessageContent): MessageContent {
  if (typeof content === 'string') return content;
  const textOnly = content.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
  if (textOnly.length === 0) return '';
  if (textOnly.length === 1) return textOnly[0].text;
  return textOnly;
}

interface ThreadPanelProps {
  groupId: string;
  parentMsg: GroupMessage;
  groupWorkers: WorkerMeta[];
  workerIds: string[];
  onClose: () => void;
}

export function ThreadPanel({ groupId, parentMsg, groupWorkers, workerIds, onClose }: ThreadPanelProps) {
  const addThreadMessage = useChatStore((s) => s.addThreadMessage);
  // Selector must NOT return a new [] fallback — that causes an infinite re-render loop
  // because Zustand uses Object.is and a new [] is never === another new [].
  const rawThreadMessages = useChatStore(
    (s) => s.groupMessages[groupId]?.find((m) => m.id === parentMsg.id)?.threadMessages
  );
  const threadMessages = rawThreadMessages ?? [];

  const [noTarget, setNoTarget] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.min(720, Math.max(260, startWidth + delta)));
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  useEffect(() => {
    // Scroll to bottom on mount (panel open)
    const raf = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadMessages.length]);

  const buildThreadHistory = () => {
    // Always prepend the parent message as context so the worker knows
    // which message this thread is replying to.
    const parentEntry = {
      role: (parentMsg.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: stripImages(
        parentMsg.role === 'worker'
          ? withWorkerPrefix(parentMsg.workerName, parentMsg.content)
          : parentMsg.content
      ),
    };
    const threadEntries = threadMessages
      .filter((m) => !isThinkingContent(m.content) && m.role !== 'system')
      .map((m) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: stripImages(m.role === 'worker' ? withWorkerPrefix(m.workerName, m.content) : m.content),
      }));
    return [parentEntry, ...threadEntries];
  };

  const handleSend = async () => {
    const text = inputRef.current?.value.trim() ?? '';
    if (!text) return;

    const targets = parseMentionedWorkers(text, groupWorkers);
    if (targets.length === 0) {
      setNoTarget(true);
      setTimeout(() => setNoTarget(false), 2500);
      return;
    }

    inputRef.current!.value = '';

    addThreadMessage(groupId, parentMsg.id, {
      id: makeId('tu'),
      role: 'user',
      content: text,
    });

    await Promise.all(
      targets.map(async (worker) => {
        const pid = makeId('tw');
        const msgId = makeMsgId();
        addThreadMessage(groupId, parentMsg.id, {
          id: pid,
          msgId,
          role: 'worker',
          workerId: worker.id,
          workerName: worker.name || worker.id,
          content: '思考中...',
        });

        try {
          const history = buildThreadHistory();
          const result = await chatSend(worker.id, text, undefined, history, msgId, groupId);
          const reply = stripDirectiveTagsInContent(result.reply);
          useChatStore.getState().updateThreadMessage(groupId, parentMsg.id, pid, reply, Date.now());
        } catch {
          useChatStore.getState().updateThreadMessage(groupId, parentMsg.id, pid, '(发送失败)', Date.now());
        }
      })
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleSend();
  };

  const insertMention = (workerName: string) => {
    const el = inputRef.current;
    if (!el) return;
    const mention = `@${workerName.replace(/\s+/g, '')} `;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const inserted = (before.length > 0 && !before.endsWith(' ') ? ' ' : '') + mention;
    el.value = before + inserted + after;
    const cursor = start + inserted.length;
    el.setSelectionRange(cursor, cursor);
    el.focus();
  };

  return (
    <div className={styles.panel} style={{ width: panelWidth }}>
      <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
      <div className={styles.header}>
        <span className={styles.title}>Thread</span>
        <button className={styles.closeBtn} onClick={onClose} title="关闭 Thread">✕</button>
      </div>

      <div className={styles.contentArea}>
        <div className={styles.parentMsg}>
          <MessageBubble
            role={parentMsg.role === 'worker' ? 'assistant' : 'user'}
            content={parentMsg.content}
            msgId={parentMsg.msgId}
            timestamp={parentMsg.timestamp}
            completedAt={parentMsg.completedAt}
            workerName={parentMsg.role === 'worker' ? (parentMsg.workerName ?? parentMsg.workerId) : undefined}
            workerId={parentMsg.workerId}
            workerColor={parentMsg.role === 'worker' ? workerColor(parentMsg.workerId ?? '', workerIds) : undefined}
          />
          {threadMessages.length > 0 && (
            <div className={styles.replyCountLine}>
              {threadMessages.filter((m) => m.role !== 'system').length} 条回复
            </div>
          )}
        </div>

        <div className={styles.divider} />

        <div className={styles.messages}>
        {threadMessages.map((msg) => {
          if (msg.role === 'system') {
            return <div key={msg.id} className={styles.systemMsg}>{toPlainText(msg.content)}</div>;
          }
          return (
            <MessageBubble
              key={msg.id}
              role={msg.role === 'worker' ? 'assistant' : 'user'}
              content={msg.content}
              msgId={msg.msgId}
              timestamp={msg.timestamp}
              completedAt={msg.completedAt}
              workerName={msg.role === 'worker' ? (msg.workerName ?? msg.workerId) : undefined}
              workerId={msg.workerId}
              workerColor={msg.role === 'worker' ? workerColor(msg.workerId ?? '', workerIds) : undefined}
            />
          );
        })}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className={styles.composer}>
        <div className={styles.hint}>
          <span className={styles.hintLabel}>@</span>
          {groupWorkers.map((w) => (
            <span
              key={w.id}
              className={styles.hintChip}
              style={{ background: workerColor(w.id, workerIds), cursor: 'pointer' }}
              onClick={() => insertMention(w.name || w.id)}
            >
              {w.name || w.id}
            </span>
          ))}
        </div>
        {noTarget && (
          <div className={styles.noTarget}>请用 @worker名 来指定消息接收者</div>
        )}
        <div className={styles.inputRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            placeholder={`在 Thread 中回复… (⌘Enter 发送)`}
            onKeyDown={handleKeyDown}
          />
          <button className={styles.sendBtn} onClick={() => void handleSend()}>
            回复
          </button>
        </div>
      </div>
    </div>
  );
}
