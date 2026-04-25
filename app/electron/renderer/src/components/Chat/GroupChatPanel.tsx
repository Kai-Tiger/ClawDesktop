import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useChatStore } from '../../store/chatStore';
import { chatSend, clearWorkerSessions, groupsUpdate, coordinatorPlan, coordinatorGetModel, coordinatorSetModel } from '../../api/gateway';
import type { GroupMessage, WorkerMeta, CoordinatorPlan } from '../../types';
import styles from './GroupChatPanel.module.css';

const PALETTE = ['#5b8cff', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

const BUILTIN_MODELS = [
  { id: 'minimax/minimax-m2.5', label: 'MiniMax M2.5' },
  { id: 'xiaomi/mimo-v2-pro', label: 'MiMo v2 Pro' },
  { id: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'openai/gpt-5-nano', label: 'GPT-5 Nano' },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
];
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

function normalizeNewlines(text: string) {
  return text.replace(/\n{2,}/g, '\n');
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
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [showCoordSettings, setShowCoordSettings] = useState(false);
  const [coordModel, setCoordModel] = useState('');
  const [coordModelSaving, setCoordModelSaving] = useState(false);
  const [coordModelStatus, setCoordModelStatus] = useState('');
  const setGroups = useChatStore((s) => s.setGroups);
  const groups2 = useChatStore((s) => s.groups);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Per-worker sequential processing chains: key = `${groupId}:${workerId}`
  const chains = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [currentGroupId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    coordinatorGetModel().then(setCoordModel).catch(() => {});
  }, []);

  const handleSaveCoordModel = async () => {
    if (coordModelSaving) return;
    setCoordModelSaving(true);
    setCoordModelStatus('保存中…');
    try {
      const res = await coordinatorSetModel(coordModel);
      setCoordModelStatus(res.ok ? '已生效' : (res.error ?? '保存失败'));
    } catch {
      setCoordModelStatus('保存失败');
    } finally {
      setCoordModelSaving(false);
    }
  };

  const buildHistory = (gid: string) =>
    (useChatStore.getState().groupMessages[gid] ?? [])
      .filter((m) => m.content !== '思考中...' && m.role !== 'system')
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.role === 'worker' ? `[${m.workerName}]: ${m.content}` : m.content,
      }));

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

      const history = buildHistory(gid);

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
            addGroupMessage(gid, {
              id: pid,
              role: 'worker',
              workerId: worker.id,
              workerName: worker.name || worker.id,
              content: '思考中...',
            });

            try {
              const history = buildHistory(gid);
              const result = await chatSend(worker.id, fullMessage, undefined, history);
              results.set(task.id, result.reply);
              useChatStore.getState().updateGroupMessage(gid, pid, result.reply);
            } catch {
              useChatStore.getState().updateGroupMessage(gid, pid, '(处理失败)');
            }
          })
        );
      }
    } finally {
      setPipelineRunning(false);
      setCsvFile(null);
    }
  };

  const handleSend = () => {
    const text = inputRef.current?.value.trim() ?? '';
    if (!currentGroupId || !group) return;
    if (!text && !csvFile) return;

    const targets = parseMentionedWorkers(text, groupWorkers);

    // 协作者模式：CSV + @mention 2+ workers
    if (csvFile && targets.length >= 2) {
      inputRef.current!.value = '';
      addGroupMessage(currentGroupId, {
        id: makeId('u', 'user'),
        role: 'user',
        content: `${text}\n[CSV: ${csvFile.name}]`,
      });
      const file = csvFile;
      setCsvFile(null);
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
    if (!csvFile && targets.length >= 2) {
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
    if (csvFile && targets.length === 1) {
      inputRef.current!.value = '';
      const [worker] = targets;
      const gid = currentGroupId;
      const file = csvFile;
      addGroupMessage(gid, {
        id: makeId('u', 'user'),
        role: 'user',
        content: `${text}\n[CSV: ${file.name}]`,
      });
      setCsvFile(null);
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      }).then((csvText) => {
        const pid = makeId('w', worker.id);
        addGroupMessage(gid, {
          id: pid,
          role: 'worker',
          workerId: worker.id,
          workerName: worker.name || worker.id,
          content: '思考中...',
        });
        const history = buildHistory(gid);
        const prompt = text ? `${text}\n\n以下是文件内容：\n${csvText}` : csvText;
        return chatSend(worker.id, prompt, undefined, history).then((result) => {
          useChatStore.getState().updateGroupMessage(gid, pid, result.reply);
        }).catch(() => {
          useChatStore.getState().updateGroupMessage(gid, pid, '(处理失败)');
        });
      }).catch(console.error);
      return;
    }

    // CSV 有附件但没有 @mention
    if (csvFile && targets.length === 0) {
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

  const handleClear = () => {
    if (!currentGroupId) return;
    clearGroupMessages(currentGroupId);
    clearWorkerSessions(groupWorkers.map((w) => w.id)).catch(console.error);
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
    <div className={styles.panel} onClick={() => { if (showAddWorker) setShowAddWorker(false); if (showCoordSettings) setShowCoordSettings(false); }}>
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
        <div className={styles.addWorkerWrap}>
          <button
            className={styles.debugToggle}
            onClick={() => { setShowCoordSettings((v) => !v); setCoordModelStatus(''); }}
            title="协调者模型设置"
          >
            协调者
          </button>
          {showCoordSettings && (
            <div className={styles.addWorkerDropdown} style={{ minWidth: 260 }} onClick={(e) => e.stopPropagation()}>
              <div className={styles.addWorkerTitle}>协调者模型</div>
              <div style={{ padding: '4px 12px 8px' }}>
                <select
                  style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb', marginBottom: 6 }}
                  value={coordModel}
                  onChange={(e) => { setCoordModel(e.target.value); setCoordModelStatus(''); }}
                >
                  <option value="">— 使用默认模型 —</option>
                  {BUILTIN_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button
                  className={styles.sendBtn}
                  style={{ width: '100%', padding: '5px 0', fontSize: 12 }}
                  onClick={handleSaveCoordModel}
                  disabled={coordModelSaving}
                >
                  {coordModelSaving ? '保存中…' : '保存'}
                </button>
                {coordModelStatus && (
                  <div style={{ marginTop: 6, fontSize: 11, color: coordModelStatus === '已生效' ? '#22c55e' : '#ef4444' }}>
                    {coordModelStatus}
                  </div>
                )}
              </div>
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
            <div key={msg.id} className={styles.systemMsg}>{msg.content}</div>
          ) : msg.role === 'debug' ? (
            debugMode ? (
              <div key={msg.id} className={styles.debugMsg}>
                <span className={styles.debugMsgLabel}>调试</span>
                <pre className={styles.debugMsgContent}>{msg.content}</pre>
              </div>
            ) : null
          ) : (
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
                {msg.content === '思考中...' ? msg.content : (
                  <div className={styles.markdown}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {normalizeNewlines(msg.content)}
                    </ReactMarkdown>
                  </div>
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
            {csvFile ? '上传 CSV 后需要 @mention 至少一个 worker' : '请用 @worker名 来指定消息接收者'}
          </div>
        )}
        {csvFile && (
          <div className={styles.csvChip}>
            <span>📄 {csvFile.name}</span>
            <button className={styles.csvChipRemove} onClick={() => setCsvFile(null)}>×</button>
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
            accept=".csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setCsvFile(f);
              e.target.value = '';
            }}
          />
          <button
            className={styles.attachBtn}
            title="上传 CSV"
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
    </div>
  );
}
