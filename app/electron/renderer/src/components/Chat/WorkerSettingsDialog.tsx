import { useEffect, useState } from "react";
import {
  telegramAdd,
  telegramList,
  telegramRemove,
  applyWorkerImagePreset,
  getWorkerModel,
  setWorkerModel,
} from "../../api/gateway";
import { useChatStore } from "../../store/chatStore";
import type { TelegramChannel } from "../../types";
import styles from "./WorkerSettingsDialog.module.css";

const BUILTIN_MODELS = [
  {
    id: "google/gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image (生图)",
  },
  { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "xiaomi/mimo-v2-pro", label: "MiMo v2 Pro" },
  { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "openai/gpt-5-nano", label: "GPT-5 Nano" },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
];

const CUSTOM_MODELS_KEY = "openclaw_custom_models";
const IMAGE_PRESET_MODEL = "google/gemini-3.1-flash-image-preview";

function loadCustomModels(): { id: string; label: string }[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_MODELS_KEY) || "[]");
  } catch {
    return [];
  }
}

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
  const [presetSaving, setPresetSaving] = useState(false);
  const [customModels, setCustomModels] =
    useState<{ id: string; label: string }[]>(loadCustomModels);
  const [customInput, setCustomInput] = useState("");

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

  const allModels = [...BUILTIN_MODELS, ...customModels];

  const loadModel = async () => {
    try {
      const m = await getWorkerModel(workerId);
      const model = m || "xiaomi/mimo-v2-pro";
      setModelCurrent(model);
      setModelSelected(model);
    } catch {
      setModelCurrent("xiaomi/mimo-v2-pro");
      setModelSelected("xiaomi/mimo-v2-pro");
    }
  };

  const handleAddCustomModel = () => {
    const id = customInput.trim();
    if (!id) return;
    if (allModels.some((m) => m.id === id)) {
      setStatus("该模型已存在");
      return;
    }
    const label = id.includes("/") ? id.split("/").slice(1).join("/") : id;
    const updated = [...customModels, { id, label }];
    setCustomModels(updated);
    localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(updated));
    setModelSelected(id);
    setCustomInput("");
    setStatus(`已添加: ${id}`);
  };

  const handleRemoveCustomModel = (id: string) => {
    const updated = customModels.filter((m) => m.id !== id);
    setCustomModels(updated);
    localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(updated));
    if (modelSelected === id) setModelSelected("xiaomi/mimo-v2-pro");
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
      const accountId =
        latest.find((b) => b.agentId === workerId)?.accountId || "default";
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

  const handleApplyImagePreset = async () => {
    if (!workerId || presetSaving) return;
    setPresetSaving(true);
    setStatus("应用生图配置中…");
    try {
      const res = await applyWorkerImagePreset(workerId);
      if (!res.ok) {
        setStatus(res.error ?? "应用生图配置失败");
        return;
      }
      setModelCurrent(IMAGE_PRESET_MODEL);
      setModelSelected(IMAGE_PRESET_MODEL);
      setStatus("生图专用配置已生效（已切换模型并禁用工具调用）");
    } catch (err: unknown) {
      setStatus(`应用生图配置失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPresetSaving(false);
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
              {BUILTIN_MODELS.length > 0 && (
                <optgroup label="内置模型">
                  {BUILTIN_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {customModels.length > 0 && (
                <optgroup label="自定义模型">
                  {customModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              className={styles.bindBtn}
              onClick={handleSaveModel}
              disabled={!isModelDirty || modelSaving}
            >
              {modelSaving ? "..." : "保存"}
            </button>
            <button
              className={styles.bindBtn}
              onClick={handleApplyImagePreset}
              disabled={presetSaving}
            >
              {presetSaving ? "..." : "一键生图配置"}
            </button>
          </div>

          <div className={styles.customModelSection}>
            <div className={styles.customModelLabel}>
              添加 OpenRouter 自定义模型
            </div>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                placeholder="例如: meta-llama/llama-3.1-405b"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddCustomModel()}
              />
              <button
                className={styles.bindBtn}
                onClick={handleAddCustomModel}
                disabled={!customInput.trim()}
              >
                添加
              </button>
            </div>
            {customModels.length > 0 && (
              <div className={styles.customModelList}>
                {customModels.map((m) => (
                  <div key={m.id} className={styles.customModelRow}>
                    <span className={styles.customModelId}>{m.id}</span>
                    <button
                      className={styles.removeBtn}
                      onClick={() => handleRemoveCustomModel(m.id)}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}
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
