import { useState, useEffect, useCallback, useRef } from 'react';
import { telegramList, telegramAdd, telegramRemove } from '../../api/gateway';
import type { TelegramChannel } from '../../types';
import { useChatStore } from '../../store/chatStore';
import styles from './ChannelSection.module.css';

// 模块级缓存，跨渲染保留
let botsCache: TelegramChannel[] | null = null;

export function ChannelSection() {
  const workers = useChatStore((s) => s.workers);
  const [tgExpanded, setTgExpanded] = useState(false);
  const [bots, setBots] = useState<TelegramChannel[]>(botsCache ?? []);
  const [refreshing, setRefreshing] = useState(false);
  const fetchingRef = useRef(false);
  const [adding, setAdding] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const noCache = botsCache === null;

  const loadBots = useCallback(async (background = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    if (!background) setRefreshing(true);
    try {
      const list = await telegramList();
      botsCache = list;
      setBots(list);
    } catch {
      // ignore
    } finally {
      fetchingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!tgExpanded) return;
    // 有缓存直接显示，后台刷新；无缓存才阻塞等待
    loadBots(botsCache !== null);
  }, [tgExpanded, loadBots]);

  async function handleConfirm() {
    const token = inputVal.trim();
    if (!token || saving) return;
    setSaving(true);
    setStatus('验证中…');
    try {
      const result = await telegramAdd(token);
      if (result.ok) {
        setStatus('');
        setInputVal('');
        setAdding(false);
        await loadBots();
      } else {
        setStatus(result.error ?? '添加失败');
      }
    } catch {
      setStatus('添加失败');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setInputVal('');
    setStatus('');
    setAdding(false);
  }

  async function handleRemove(accountId: string) {
    try {
      await telegramRemove(accountId);
      await loadBots();
    } catch {
      // ignore
    }
  }

  return (
    <div className={styles.wrap}>
      <button
        className={styles.tgHeader}
        onClick={() => setTgExpanded((v) => !v)}
      >
        <span className={styles.arrow}>{tgExpanded ? '▾' : '▸'}</span>
        <span>Telegram</span>
        {bots.length > 0 && (
          <span className={styles.badge}>{bots.length}</span>
        )}
      </button>

      {tgExpanded && (
        <div className={styles.tgBody}>
          {noCache && refreshing && <p className={styles.empty}>加载中…</p>}

          {!noCache && bots.length === 0 && !adding && (
            <p className={styles.empty}>暂无连接的 Bot</p>
          )}

          {bots.map((ch) => {
            const agentName = ch.agentId
              ? (workers.find((w) => w.id === ch.agentId)?.name ?? ch.agentId)
              : null;
            return (
              <div key={ch.accountId} className={styles.botRow}>
                <span className={styles.botDot} />
                <span className={styles.botInfo}>
                  <span className={styles.botName}>
                    {ch.bot ? `@${ch.bot.username}` : ch.accountId}
                  </span>
                  {agentName && (
                    <span className={styles.botAgent}>→ {agentName}</span>
                  )}
                </span>
                <button
                  className={styles.removeBtn}
                  onClick={() => handleRemove(ch.accountId)}
                  title="移除"
                >
                  ×
                </button>
              </div>
            );
          })}

          {adding ? (
            <div className={styles.addBlock}>
              <div className={styles.addRow}>
                <input
                  className={styles.input}
                  placeholder="Bot Token"
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConfirm();
                    if (e.key === 'Escape') handleCancel();
                  }}
                  disabled={saving}
                  autoFocus
                />
                <button className={styles.confirmBtn} onClick={handleConfirm} disabled={saving}>
                  确定
                </button>
                <button className={styles.cancelBtn} onClick={handleCancel} disabled={saving}>
                  取消
                </button>
              </div>
              {status && <p className={styles.statusMsg}>{status}</p>}
            </div>
          ) : (
            !noCache && (
              <button className={styles.addBtn} onClick={() => { setStatus(''); setAdding(true); }}>
                + 添加
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
