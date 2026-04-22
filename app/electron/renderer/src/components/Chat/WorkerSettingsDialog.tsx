import { useEffect, useState } from "react";
import {
  telegramAdd,
  telegramList,
  telegramRemove,
  getWorkerModel,
  setWorkerModel,
} from "../../api/gateway";
import { useChatStore } from "../../store/chatStore";
import type { TelegramChannel } from "../../types";
import styles from "./WorkerSettingsDialog.module.css";

const MODELS = [
  { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "xiaomi/mimo-v2-pro", label: "MiMo v2 Pro" },
  { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "openai/gpt-5-nano", label: "GPT-5 Nano" },
];

interface Props {
  open: boolean;
  workerId: string;
  workerName: string;
  onClose: () => void;
}

export function WorkerSettingsDialog({
  open,
  workerId,
  workerName,
  onClose,
}: Props) {
  const workers = useChatStore((s) => s.workers);
  const [bots, setBots] = useState<TelegramChannel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingAccountId, setRemovingAccountId] = useState("");
  const [inputVal, setInputVal] = useState("");
  const [status, setStatus] = useState("");
  const [modelCurrent, setModelCurrent] = useState("");
  const [modelSelected, setModelSelected] = useState("");
  const [modelSaving, setModelSaving] = useState(false);

  const loadBots = async () => {
    setRefreshing(true);
    try {
      const list = await telegramList();
      setBots(list);
      return list;
    } catch {
      setStatus("加载 Telegram 列表失败");
      return [] as TelegramChannel[];
    } finally {
      setRefreshing(false);
    }
  };

  const loadModel = async () => {
    try {
      const m = await getWorkerModel(workerId);
      const model = m || MODELS[0].id;
      setModelCurrent(model);
      setModelSelected(model);
    } catch {
      const fallback = MODELS[0].id;
      setModelCurrent(fallback);
      setModelSelected(fallback);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStatus("");
    setInputVal("");
    loadBots();
    loadModel();
  }, [open, workerId]);

  if (!open) return null;

  const renderChannelLabel = (ch: TelegramChannel) => {
    const account = ch.accountId || "default";
    if (ch.bot?.username) {
      return `@${ch.bot.username} (${account})`;
    }
    return account === "default" ? "default" : account;
  };

  const boundBots = bots.filter((b) => b.agentId === workerId);
  const isModelDirty = modelSelected !== modelCurrent;

  const handleBind = async () => {
    const token = inputVal.trim();
    if (!token || saving) return;
    setSaving(true);
    setStatus("绑定中…");
    try {
      const result = await telegramAdd(token, workerId);
      if (!result.ok) {
        setStatus(result.error ?? "绑定失败");
        return;
      }
      setInputVal("");
      const latest = await loadBots();
      const accountId = latest.find((b) => b.agentId === workerId)?.accountId || "default";
      setStatus(`绑定成功（账号：${accountId}）`);
    } catch {
      setStatus("绑定失败");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (accountId: string) => {
    if (removingAccountId) return;
    setRemovingAccountId(accountId);
    try {
      await telegramRemove(accountId);
      await loadBots();
    } catch {
      setStatus("移除失败");
    } finally {
      setRemovingAccountId("");
    }
  };

  const handleSaveModel = async () => {
    if (!workerId || !modelSelected || modelSaving || !isModelDirty) return;
    setModelSaving(true);
    setStatus("保存模型中…");
    try {
      const res = await setWorkerModel(workerId, modelSelected);
      if (!res.ok) {
        setStatus(res.error ?? "保存模型失败");
        return;
      }
      setModelCurrent(modelSelected);
      setStatus("模型已生效");
    } catch (err: unknown) {
      setStatus(
        `保存模型失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setModelSaving(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h3 className={styles.title}>Worker 设置</h3>
          <span className={styles.worker}>{workerName}</span>
        </div>

        <div className={styles.section}>
          <div className={styles.label}>底层模型</div>
          <div className={styles.inputRow}>
            <select
              className={styles.select}
              value={modelSelected}
              onChange={(e) => setModelSelected(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              className={styles.bindBtn}
              onClick={handleSaveModel}
              disabled={!isModelDirty || modelSaving}
            >
              {modelSaving ? "..." : "保存"}
            </button>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.label}>当前已绑定 Telegram</div>
          {refreshing ? (
            <div className={styles.empty}>加载中…</div>
          ) : boundBots.length === 0 ? (
            <div>
              <div className={styles.empty}>当前 Worker 尚未绑定 Telegram</div>
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  placeholder="123456:ABCDEF..."
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleBind()}
                  disabled={saving}
                  autoFocus
                />
                <button
                  className={styles.bindBtn}
                  onClick={handleBind}
                  disabled={saving || !inputVal.trim()}
                >
                  绑定
                </button>
              </div>
            </div>
          ) : (
            boundBots.map((ch) => (
              <div key={ch.accountId} className={styles.row}>
                <span>{renderChannelLabel(ch)}</span>
                <button
                  className={styles.removeBtn}
                  onClick={() => handleRemove(ch.accountId)}
                  disabled={!!removingAccountId}
                >
                  {removingAccountId === ch.accountId ? "移除中..." : "移除"}
                </button>
              </div>
            ))
          )}
        </div>

        {/* <div className={styles.section}>
          <div className={styles.label}>输入 Bot Token 绑定到当前 Worker</div>
          <div className={styles.inputRow}>
            <input
              className={styles.input}
              placeholder="123456:ABCDEF..."
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleBind()}
              disabled={saving}
              autoFocus
            />
            <button
              className={styles.bindBtn}
              onClick={handleBind}
              disabled={saving || !inputVal.trim()}
            >
              绑定
            </button>
          </div>
        </div> */}

        <div className={styles.section}>
          <div className={styles.label}>其他已连接 Bot</div>
          {bots.filter((b) => b.agentId !== workerId).length === 0 ? (
            <div className={styles.empty}>暂无</div>
          ) : (
            bots
              .filter((b) => b.agentId !== workerId)
              .map((ch) => {
                const agentName = ch.agentId
                  ? (workers.find((w) => w.id === ch.agentId)?.name ??
                    ch.agentId)
                  : "未绑定";
                return (
                  <div key={ch.accountId} className={styles.rowMuted}>
                    <span>{renderChannelLabel(ch)}</span>
                    <span>→ {agentName}</span>
                  </div>
                );
              })
          )}
        </div>

        {status && <div className={styles.status}>{status}</div>}

        <div className={styles.actions}>
          <button className={styles.closeBtn} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
