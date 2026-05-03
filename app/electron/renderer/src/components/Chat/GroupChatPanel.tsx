import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useChatStore } from '../../store/chatStore';
import { chatSend, clearWorkerSessions, groupsUpdate, coordinatorPlan, workerOpenFileLocation, openLogsDir, saveChatImage } from '../../api/gateway';
import type { GroupMessage, WorkerMeta, CoordinatorPlan, MessageContent, ContentBlock } from '../../types';
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

function makeMsgId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function normalizeNewlines(text: string) {
  return text.replace(/\n{2,}/g, '\n');
}

function formatMessageTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}:${ss}`;
}

const FILE_EXT_RE = /\.(ts|tsx|js|jsx|json|md|txt|py|css|html|htm|yaml|yml|sh|bash|env|toml|xml|csv|sql|go|rs|java|kt|swift|rb|php|c|cpp|h|vue|svelte|lock|log|conf|cfg)$/i;

function looksLikeFilePath(text: string): boolean {
  if (text.length > 300 || text.includes('\n')) return false;
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) return true;
  if (FILE_EXT_RE.test(text.trim())) return true;
  return false;
}

function perfLog(traceId: string, step: string, extra?: string) {
  console.log(`[perf][${traceId}] ${new Date().toISOString()} ${step}${extra ? ' ' + extra : ''}`);
}

function stripDirectiveTags(text: string): string {
  return text.replace(/\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+|audio_as_voice)\s*\]\]/gi, '').trim();
}

function isThinkingGroupContent(content: MessageContent): boolean {
  return typeof content === 'string' && content === '思考中...';
}

function toPlainText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : `[图片:${block.mediaType}]`))
    .join('\n');
}

function stripDirectiveTagsInContent(content: MessageContent): MessageContent {
  if (typeof content === 'string') return stripDirectiveTags(content);
  const blocks: ContentBlock[] = content.map((block) =>
    block.type === 'text' ? { ...block, text: stripDirectiveTags(block.text) } : block
  );
  const hasImage = blocks.some((block) => block.type === 'image');
  const textBlocks = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text');
  if (!hasImage) {
    return textBlocks.map((block) => block.text).join('\n').trim();
  }
  return blocks.filter((block) => block.type === 'image' || block.text.trim().length > 0);
}

function withWorkerPrefix(workerName: string | undefined, content: MessageContent): MessageContent {
  const prefix = `[${workerName || 'worker'}]: `;
  if (typeof content === 'string') return `${prefix}${content}`;
  return [{ type: 'text', text: prefix }, ...content];
}

function makeCodeComponents(workerId?: string) {
  return {
    code({ children, className, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
      const text = String(children).trim();
      const isBlock = !!className;
      if (!isBlock && workerId && looksLikeFilePath(text)) {
        return (
          <span
            className={styles.fileLink}
            onClick={() => void workerOpenFileLocation(workerId, text)}
            title={`定位文件: ${text}`}
          >
            <code className={styles.fileLinkCode}>{children}</code>
            <span className={styles.fileLinkIcon}>📂</span>
          </span>
        );
      }
      return <code className={className} {...props}>{children}</code>;
    },
  };
}


export function GroupChatPanel() {
  const groups = useChatStore((s) => s.groups);
  const currentGroupId = useChatStore((s) => s.currentGroupId);
  const groupMessages = useChatStore((s) => s.groupMessages);
  const addGroupMessage = useChatStore((s) => s.addGroupMessage);
  const clearGroupMessages = useChatStore((s) => s.clearGroupMessages);
  const allWorkers = useChatStore((s) => s.workers);

  const group = groups.find((g) => g.id === currentGroupId);
  const groupWorkers = (group?.workerIds ?? [])
    .map((id) => allWorkers.find((w) => w.id === id))
    .filter(Boolean) as WorkerMeta[];

  const messages: GroupMessage[] = currentGroupId ? (groupMessages[currentGroupId] ?? []) : [];

  const [noTarget, setNoTarget] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; width: number; height: number } | null>(null);
  const setGroups = useChatStore((s) => s.setGroups);
  const groups2 = useChatStore((s) => s.groups);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openImagePreview = (src: string, width: number, height: number) => {
    setPreviewImage({ src, width, height });
  };

  const handleSaveImage = async (msgId: string | undefined, src: string) => {
    const result = await saveChatImage(msgId || 'image', src);
    if (!result?.ok && !result?.canceled) {
      window.alert(result?.error || '保存图片失败');
    }
  };

  // Per-worker sequential processing chains: key = `${groupId}:${workerId}`
  const chains = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [currentGroupId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);


  const buildHistory = (gid: string) =>
    (useChatStore.getState().groupMessages[gid] ?? [])
      .filter((m) => !isThinkingGroupContent(m.content) && m.role !== 'system')
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.role === 'worker' ? withWorkerPrefix(m.workerName, m.content) : m.content,
      }));

  const enqueue = (params: {
    gid: string;
    groupName: string;
    worker: WorkerMeta;
    text: string;
    placeholderId: string;
    msgId: string;
  }) => {
    const { gid, groupName, worker, text, placeholderId, msgId } = params;
    const key = `${gid}:${worker.id}`;
    const workerLabel = worker.name || worker.id;
    const prior = chains.current.get(key) ?? Promise.resolve();

    const next = prior.then(async () => {
      console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] → ${workerLabel} 开始处理`);

      const history = buildHistory(gid);

      try {
        const t0 = Date.now();
        perfLog(msgId, 'IPC-send', `worker=${worker.id} msgLen=${text.length} historyLen=${history.length}`);
        const result = await chatSend(worker.id, text, undefined, history, msgId, gid);
        const reply = stripDirectiveTagsInContent(result.reply);
        perfLog(msgId, 'IPC-recv', `total=${Date.now() - t0}ms replyLen=${toPlainText(reply).length}`);
        useChatStore.getState().updateGroupMessage(gid, placeholderId, reply);
        console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] ← ${workerLabel}: ${toPlainText(reply)}`);
      } catch (err) {
        useChatStore.getState().updateGroupMessage(gid, placeholderId, '(发送失败)');
        console.error(`[GroupChat][${groupName}][${new Date().toISOString()}] ← ${workerLabel} 失败:`, err);
      }
    });

    chains.current.set(key, next);
  };

  const parseCoordinatorPlan = (raw: string, fallbackTargets: WorkerMeta[], fallbackText: string): CoordinatorPlan => {
    // 尝试 1：去掉 markdown fence 后直接解析
    try {
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as CoordinatorPlan;
      if (parsed.tasks && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) return parsed;
    } catch { /* try next */ }

    // 尝试 2：从回复中提取第一个 {...} JSON 对象
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as CoordinatorPlan;
        if (parsed.tasks && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) return parsed;
      }
    } catch { /* fallback */ }

    return {
      analysis: '（解析失败，所有 worker 并行处理）',
      tasks: fallbackTargets.map((w, i) => ({
        id: `t${i + 1}`,
        workerId: w.id,
        message: fallbackText,
        after: [],
      })),
    };
  };

  const runCoordinator = async (
    targets: WorkerMeta[],
    userText: string,
    fileContent?: string
  ) => {
    const gid = currentGroupId!;
    setPipelineRunning(true);

    try {
      // 调用协作者
      if (debugMode) {
        addGroupMessage(gid, {
          id: makeId('dbg', 'coord-start'),
          role: 'debug',
          content: '🤖 协作者分析中…',
        });
      }

      let plan: CoordinatorPlan;
      try {
        const raw = await coordinatorPlan({
          userMessage: userText,
          workers: targets.map((w) => ({ id: w.id, name: w.name, description: w.description })),
          // 不传文件内容，协调者只需要知道任务意图，文件内容由执行层直接注入
        });
        if (debugMode) {
          addGroupMessage(gid, {
            id: makeId('dbg', 'coord-raw'),
            role: 'debug',
            content: `🤖 协作者原始输出：\n${raw || '(空)'}`,
          });
        }
        plan = parseCoordinatorPlan(raw, targets, userText);
      } catch (err) {
        if (debugMode) {
          addGroupMessage(gid, {
            id: makeId('dbg', 'coord-err'),
            role: 'debug',
            content: `🤖 协作者调用失败：${String(err)}`,
          });
        }
        plan = parseCoordinatorPlan('', targets, userText);
      }

      if (debugMode) {
        addGroupMessage(gid, {
          id: makeId('dbg', 'coord-plan'),
          role: 'debug',
          content: `🤖 协作者分析：${plan.analysis}\n\n执行计划：${plan.tasks.length} 个任务`,
        });
      }

      // 按依赖关系顺序执行（DAG）
      const results = new Map<string, string>();
      const pending = new Set(plan.tasks.map((t) => t.id));

      while (pending.size > 0) {
        const ready = plan.tasks.filter(
          (t) => pending.has(t.id) && t.after.every((dep) => !pending.has(dep))
        );
        if (ready.length === 0) break;

        await Promise.all(
          ready.map(async (task) => {
            pending.delete(task.id);

            const worker = groupWorkers.find((w) => w.id === task.workerId);
            if (!worker) return;

            // 将前置任务结果追加到消息
            const priorResults = task.after
              .map((dep) => results.get(dep))
              .filter(Boolean)
              .join('\n\n');
            // 首批任务（无前置依赖）直接注入文件内容，不经过协调者
            const isFirstTask = task.after.length === 0;
            const fullMessage = [
              task.message,
              priorResults ? `前置任务结果：\n${priorResults}` : '',
              isFirstTask && fileContent ? `文件内容：\n${fileContent}` : '',
            ].filter(Boolean).join('\n\n');

            if (debugMode) {
              addGroupMessage(gid, {
                id: makeId('dbg', task.id),
                role: 'debug',
                content: `→ 发送给 ${worker.name || worker.id}：\n${fullMessage}`,
              });
            }

            const pid = makeId('w', worker.id);
            const msgId = makeMsgId();
            addGroupMessage(gid, {
              id: pid,
              msgId,
              role: 'worker',
              workerId: worker.id,
              workerName: worker.name || worker.id,
              content: '思考中...',
            });

            try {
              const history = buildHistory(gid);
              const t0 = Date.now();
              perfLog(msgId, 'IPC-send', `task=${task.id} worker=${worker.id} msgLen=${fullMessage.length} historyLen=${history.length}`);
              const result = await chatSend(worker.id, fullMessage, undefined, history, msgId, gid);
              const reply = stripDirectiveTagsInContent(result.reply);
              perfLog(msgId, 'IPC-recv', `total=${Date.now() - t0}ms replyLen=${toPlainText(reply).length}`);
              results.set(task.id, toPlainText(reply));
              useChatStore.getState().updateGroupMessage(gid, pid, reply);
            } catch {
              useChatStore.getState().updateGroupMessage(gid, pid, '(处理失败)');
            }
          })
        );
      }
    } finally {
      setPipelineRunning(false);
      setAttachedFile(null);
    }
  };

  const handleSend = () => {
    const text = inputRef.current?.value.trim() ?? '';
    if (!currentGroupId || !group) return;
    if (!text && !attachedFile) return;

    const targets = parseMentionedWorkers(text, groupWorkers);

    // 协作者模式：CSV + @mention 2+ workers
    if (attachedFile && targets.length >= 2) {
      inputRef.current!.value = '';
      addGroupMessage(currentGroupId, {
        id: makeId('u', 'user'),
        role: 'user',
        content: `${text}\n[文件: ${attachedFile.name}]`,
      });
      const file = attachedFile;
      setAttachedFile(null);
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      }).then((csvText) => {
        // 协调者只收到文件名提示，不收到内容；内容由执行层直接注入给首个任务
        const textWithHint = `${text}（附件：${file.name}）`;
        return runCoordinator(targets, textWithHint, csvText);
      }).catch(console.error);
      return;
    }

    // 协作者模式：无 CSV + @mention 2+ workers
    if (!attachedFile && targets.length >= 2) {
      inputRef.current!.value = '';
      addGroupMessage(currentGroupId, {
        id: makeId('u', 'user'),
        role: 'user',
        content: text,
      });
      runCoordinator(targets, text).catch(console.error);
      return;
    }

    // 单 worker 模式：CSV + @mention 一个 worker，整体发送
    if (attachedFile && targets.length === 1) {
      inputRef.current!.value = '';
      const [worker] = targets;
      const gid = currentGroupId;
      const file = attachedFile;
      addGroupMessage(gid, {
        id: makeId('u', 'user'),
        role: 'user',
        content: `${text}\n[文件: ${file.name}]`,
      });
      setAttachedFile(null);
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      }).then((csvText) => {
        const pid = makeId('w', worker.id);
        const msgId = makeMsgId();
        addGroupMessage(gid, {
          id: pid,
          msgId,
          role: 'worker',
          workerId: worker.id,
          workerName: worker.name || worker.id,
          content: '思考中...',
        });
        const history = buildHistory(gid);
        const prompt = text ? `${text}\n\n以下是文件内容：\n${csvText}` : csvText;
        const t0 = Date.now();
        perfLog(msgId, 'IPC-send', `worker=${worker.id} msgLen=${prompt.length} historyLen=${history.length}`);
        return chatSend(worker.id, prompt, undefined, history, msgId, gid).then((result) => {
          const reply = stripDirectiveTagsInContent(result.reply);
          perfLog(msgId, 'IPC-recv', `total=${Date.now() - t0}ms replyLen=${toPlainText(reply).length}`);
          useChatStore.getState().updateGroupMessage(gid, pid, reply);
        }).catch(() => {
          useChatStore.getState().updateGroupMessage(gid, pid, '(处理失败)');
        });
      }).catch(console.error);
      return;
    }

    // CSV 有附件但没有 @mention
    if (attachedFile && targets.length === 0) {
      setNoTarget(true);
      setTimeout(() => setNoTarget(false), 2500);
      return;
    }

    // 原有逻辑
    if (!text) return;
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
      const msgId = makeMsgId();
      addGroupMessage(gid, {
        id: placeholderId,
        msgId,
        role: 'worker',
        workerId: worker.id,
        workerName: worker.name || worker.id,
        content: '思考中...',
      });
      console.log(`[GroupChat][${groupName}][${new Date().toISOString()}] → ${worker.name || worker.id} (已入队) msgId=${msgId}`);
      enqueue({ gid, groupName, worker, text, placeholderId, msgId });
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend();
  };

  const handleClear = () => {
    if (!currentGroupId) return;
    clearGroupMessages(currentGroupId);
    clearWorkerSessions(groupWorkers.map((w) => w.id), currentGroupId).catch(console.error);
  };

  const handleAddWorker = async (workerId: string) => {
    if (!group || !currentGroupId) return;
    const newIds = [...group.workerIds, workerId];
    await groupsUpdate(currentGroupId, newIds);
    setGroups(groups2.map((g) => g.id === currentGroupId ? { ...g, workerIds: newIds } : g));
    setShowAddWorker(false);
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
    <div className={styles.panel} onClick={() => { if (showAddWorker) setShowAddWorker(false); }}>
      <div className={styles.header}>
        <span className={styles.title}>Group</span>
        <span className={styles.groupName}>{group.name}</span>
        <div className={styles.workerBadges}>
          {groupWorkers.map((w) => (
            <span
              key={w.id}
              className={styles.workerBadge}
              style={{ background: workerColor(w.id, workerIds), cursor: 'pointer' }}
              title={`点击插入 @${(w.name || w.id).replace(/\s+/g, '')}`}
              onClick={() => insertMention(w.name || w.id)}
            >
              {w.name || w.id}
            </span>
          ))}
        </div>
        <div className={styles.addWorkerWrap}>
          <button
            className={styles.addWorkerBtn}
            onClick={() => setShowAddWorker((v) => !v)}
            title="添加 Worker 到 Group"
          >
            +
          </button>
          {showAddWorker && (
            <div className={styles.addWorkerDropdown} onClick={(e) => e.stopPropagation()}>
              <div className={styles.addWorkerTitle}>添加 Worker</div>
              {allWorkers
                .filter((w) => !group.workerIds.includes(w.id))
                .map((w) => (
                  <button
                    key={w.id}
                    className={styles.addWorkerItem}
                    onClick={() => void handleAddWorker(w.id)}
                  >
                    {w.name || w.id}
                  </button>
                ))}
              {allWorkers.filter((w) => !group.workerIds.includes(w.id)).length === 0 && (
                <div className={styles.addWorkerEmpty}>所有 worker 已在 Group 中</div>
              )}
            </div>
          )}
        </div>
        <button
          className={`${styles.debugToggle} ${debugMode ? styles.debugToggleOn : ''}`}
          onClick={() => setDebugMode((v) => !v)}
          title="调试模式：显示协作者分析和发送给各 worker 的消息"
        >
          调试
        </button>
        <button
          className={styles.debugToggle}
          onClick={() => void openLogsDir()}
          title="打开日志文件夹（chat-YYYY-MM-DD.log）"
        >
          日志
        </button>
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
        {messages.map((msg) =>
          msg.role === 'system' ? (
            <div key={msg.id} className={styles.systemMsg}>{toPlainText(msg.content)}</div>
          ) : msg.role === 'debug' ? (
            debugMode ? (
              <div key={msg.id} className={styles.debugMsg}>
                <span className={styles.debugMsgLabel}>调试</span>
                <pre className={styles.debugMsgContent}>{toPlainText(msg.content)}</pre>
              </div>
            ) : null
          ) : (
            <div key={msg.id} className={`${styles.msg} ${styles[msg.role]}`}>
              <div className={styles.msgLabelRow}>
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
                {!!msg.timestamp && (
                  <span className={styles.msgTime}>{formatMessageTime(msg.timestamp)}</span>
                )}
              </div>
              <div className={`${styles.bubble} ${isThinkingGroupContent(msg.content) ? styles.thinking : ''}`}>
                {isThinkingGroupContent(msg.content) ? msg.content : (
                  typeof msg.content === 'string' ? (
                    <div className={styles.markdown}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={makeCodeComponents(msg.workerId)}>
                        {normalizeNewlines(msg.content)}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {msg.content.map((block, idx) => {
                        if (block.type === 'text') {
                          return (
                            <div key={`t-${msg.id}-${idx}`} className={styles.markdown}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={makeCodeComponents(msg.workerId)}>
                                {normalizeNewlines(block.text)}
                              </ReactMarkdown>
                            </div>
                          );
                        }
                        return (
                          <div key={`i-${msg.id}-${idx}`} className={styles.groupImageRow}>
                            <img
                              src={`data:${block.mediaType};base64,${block.data}`}
                              alt="群聊生成图片"
                              className={styles.groupImage}
                              onClick={(e) =>
                                openImagePreview(
                                  `data:${block.mediaType};base64,${block.data}`,
                                  e.currentTarget.naturalWidth,
                                  e.currentTarget.naturalHeight
                                )
                              }
                            />
                            <button
                              type="button"
                              className={styles.imageDownloadBtn}
                              onClick={() => void handleSaveImage(msg.msgId, `data:${block.mediaType};base64,${block.data}`)}
                              title="下载图片"
                              aria-label="下载图片"
                            >
                              <svg viewBox="0 0 20 20" fill="none" className={styles.imageDownloadIcon} aria-hidden="true">
                                <path d="M10 3v8m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M4 13.5v1a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0016 14.5v-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
                {msg.role === 'worker' && msg.msgId && (
                  <div className={styles.msgIdTag}>{msg.msgId}</div>
                )}
              </div>
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>

      <div className={styles.composer}>
        <div className={styles.composerToolbar}>
          <button
            className={styles.clearBtn}
            onClick={handleClear}
            disabled={pipelineRunning}
          >
            /Clear
          </button>
        </div>
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
          <div className={styles.noTarget}>
            {attachedFile ? '上传文件后需要 @mention 至少一个 worker' : '请用 @worker名 来指定消息接收者'}
          </div>
        )}
        {attachedFile && (
          <div className={styles.csvChip}>
            <span>📄 {attachedFile.name}</span>
            <button className={styles.csvChipRemove} onClick={() => setAttachedFile(null)}>×</button>
          </div>
        )}
        <div className={styles.inputRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            placeholder={`@${groupWorkers[0]?.name || 'worker'} 你好… (⌘Enter 发送)`}
            onKeyDown={handleKeyDown}
            disabled={pipelineRunning}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.md"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setAttachedFile(f);
              e.target.value = '';
            }}
          />
          <button
            className={styles.attachBtn}
            title="上传文件 (csv/txt/md)"
            disabled={pipelineRunning}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          <button className={styles.sendBtn} onClick={handleSend} disabled={pipelineRunning}>
            {pipelineRunning ? '运行中…' : '发送'}
          </button>
        </div>
      </div>
      {previewImage && (
        <div
          className={styles.imagePreviewOverlay}
          onClick={() => setPreviewImage(null)}
        >
          <div className={styles.imagePreviewStage} onClick={(e) => e.stopPropagation()}>
            <img
              src={previewImage.src}
              alt="预览图片"
              className={styles.imagePreviewImage}
              style={
                previewImage.width >= previewImage.height
                  ? { width: 'calc(100vw - 200px)', maxHeight: 'calc(100vh - 100px)' }
                  : { height: 'calc(100vh - 100px)', maxWidth: 'calc(100vw - 200px)' }
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
