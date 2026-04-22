import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { chatSend } from '../../api/gateway';
import type { GroupMessage, WorkerMeta } from '../../types';
import styles from './GroupChatPanel.module.css';

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

function makeId(prefix: string, workerId: string) {
  return `${prefix}-${Date.now()}-${workerId}-${Math.random().toString(36).slice(2)}`;
}

export function GroupChatPanel() {
  const groups = useChatStore((s) => s.groups);
  const currentGroupId = useChatStore((s) => s.currentGroupId);
  const groupMessages = useChatStore((s) => s.groupMessages);
  const addGroupMessage = useChatStore((s) => s.addGroupMessage);
  const allWorkers = useChatStore((s) => s.workers);

  const group = groups.find((g) => g.id === currentGroupId);
  const groupWorkers = (group?.workerIds ?? [])
    .map((id) => allWorkers.find((w) => w.id === id))
    .filter(Boolean) as WorkerMeta[];

  const messages: GroupMessage[] = currentGroupId ? (groupMessages[currentGroupId] ?? []) : [];

  const [noTarget, setNoTarget] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Per-worker sequential processing chains: key = `${groupId}:${workerId}`
  const chains = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const enqueue = (params: {
    gid: string;
    groupName: string;
    worker: WorkerMeta;
    text: string;
    placeholderId: string;
  }) => {
    const { gid, groupName, worker, text, placeholderId } = params;
    const key = `${gid}:${worker.id}`;
    const workerLabel = worker.name || worker.id;
    const prior = chains.current.get(key) ?? Promise.resolve();

    const next = prior.then(async () => {
      console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] → ${workerLabel} 开始处理`);

      // Build history at processing time so prior responses in this queue are included.
      const allMsgs = useChatStore.getState().groupMessages[gid] ?? [];
      const history = allMsgs
        .filter((m) => m.content !== '思考中...' && m.id !== placeholderId)
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.role === 'worker' ? `[${m.workerName}]: ${m.content}` : m.content,
        }));

      try {
        const result = await chatSend(worker.id, text, undefined, history);
        useChatStore.getState().updateGroupMessage(gid, placeholderId, result.reply);
        console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] ← ${workerLabel}: ${result.reply}`);
      } catch (err) {
        useChatStore.getState().updateGroupMessage(gid, placeholderId, '(发送失败)');
        console.error(`[GroupChat][${groupName}][${new Date().toISOString()}] ← ${workerLabel} 失败:`, err);
      }
    });

    chains.current.set(key, next);
  };

  const handleSend = () => {
    const text = inputRef.current?.value.trim() ?? '';
    if (!text || !currentGroupId || !group) return;

    const targets = parseMentionedWorkers(text, groupWorkers);
    if (targets.length === 0) {
      setNoTarget(true);
      setTimeout(() => setNoTarget(false), 2500);
      return;
    }

    inputRef.current!.value = '';
    setNoTarget(false);

    const gid = currentGroupId;
    const groupName = group.name;

    const userMsg: GroupMessage = {
      id: makeId('u', 'user'),
      role: 'user',
      content: text,
    };
    addGroupMessage(gid, userMsg);
    console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] 用户: ${text}`);

    targets.forEach((worker) => {
      const placeholderId = makeId('w', worker.id);
      addGroupMessage(gid, {
        id: placeholderId,
        role: 'worker',
        workerId: worker.id,
        workerName: worker.name || worker.id,
        content: '思考中...',
      });
      console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] → ${worker.name || worker.id} (已入队)`);
      enqueue({ gid, groupName, worker, text, placeholderId });
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend();
  };

  const insertMention = (workerName: string) => {
    const el = inputRef.current;
    if (!el) return;
    const mention = `@${workerName} `;
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

  if (!group) {
    return (
      <div className={styles.panel}>
        <div className={styles.messages}>
          <div className={styles.empty}>选择一个 Group 开始聊天</div>
        </div>
      </div>
    );
  }

  const workerIds = group.workerIds;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Group</span>
        <span className={styles.groupName}>{group.name}</span>
        <div className={styles.workerBadges}>
          {groupWorkers.map((w) => (
            <span
              key={w.id}
              className={styles.workerBadge}
              style={{ background: workerColor(w.id, workerIds), cursor: 'pointer' }}
              title={`点击插入 @${w.name || w.id}`}
              onClick={() => insertMention(w.name || w.id)}
            >
              {w.name || w.id}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.messages}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            <div>Group 聊天室</div>
            <div className={styles.emptyHint}>
              使用 @{groupWorkers[0]?.name || groupWorkers[0]?.id || 'worker'} 来给指定 worker 发消息
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`${styles.msg} ${styles[msg.role]}`}>
            {msg.role === 'user' ? (
              <div className={styles.msgLabel}>你</div>
            ) : (
              <div className={styles.msgLabel}>
                <span
                  className={styles.workerLabel}
                  style={{ color: workerColor(msg.workerId ?? '', workerIds) }}
                >
                  {msg.workerName}
                </span>
              </div>
            )}
            <div className={`${styles.bubble} ${msg.content === '思考中...' ? styles.thinking : ''}`}>
              {msg.content}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
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
            placeholder={`@${groupWorkers[0]?.name || 'worker'} 你好… (⌘Enter 发送)`}
            onKeyDown={handleKeyDown}
          />
          <button className={styles.sendBtn} onClick={handleSend}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
