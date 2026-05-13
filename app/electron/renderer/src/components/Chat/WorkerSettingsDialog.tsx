import React, { useEffect, useState } from "react";
import {
  telegramAdd,
  telegramList,
  telegramRemove,
  applyWorkerImagePreset,
  getWorkerModel,
  getWorkerTools,
  setWorkerToolEnabled,
  setWorkerModel,
} from "../../api/gateway";
import { useChatStore } from "../../store/chatStore";
import type { TelegramChannel } from "../../types";
import styles from "./WorkerSettingsDialog.module.css";

const IMAGE_MODELS = [
  { id: "openai/gpt-5.4-image-2", label: "GPT-5.4 Image 2" },
  { id: "google/gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash Image" },
];

const IMAGE_MODEL_IDS = new Set(IMAGE_MODELS.map((m) => m.id));

const BUILTIN_MODELS = [
  { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "xiaomi/mimo-v2-pro", label: "MiMo v2 Pro" },
  { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "openai/gpt-5-nano", label: "GPT-5 Nano" },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
];

const CUSTOM_MODELS_KEY = "openclaw_custom_models";

const TOOL_DESCRIPTIONS: Record<string, { purpose: string; impact: string }> = {
  cron: {
    purpose: "定时触发任务，按计划自动执行。",
    impact: "关闭后无法创建或运行定时任务。",
  },
  browser: {
    purpose: "浏览器自动化能力，用于打开网页、点击、抓取页面内容。",
    impact: "关闭后无法进行网页自动化操作。",
  },
  message: {
    purpose: "消息通道能力，用于发送/接收平台消息。",
    impact: "关闭后无法执行消息相关动作。",
  },
  read: {
    purpose: "读取本地文件内容。",
    impact: "关闭后无法查看文件。",
  },
  edit: {
    purpose: "编辑已有文件。",
    impact: "关闭后无法修改文件。",
  },
  write: {
    purpose: "创建或覆盖写入文件。",
    impact: "关闭后无法新建/写入文件。",
  },
  exec: {
    purpose: "执行 shell 命令。",
    impact: "关闭后无法运行命令行任务。",
  },
  process: {
    purpose: "进程管理能力（启动、查询、控制进程）。",
    impact: "关闭后无法管理外部进程。",
  },
  canvas: {
    purpose: "画布与图像处理能力。",
    impact: "关闭后无法执行画布相关任务。",
  },
  nodes: {
    purpose: "节点/流程编排能力。",
    impact: "关闭后无法使用节点流程工具。",
  },
  gateway: {
    purpose: "调用网关相关能力。",
    impact: "关闭后无法使用网关专用操作。",
  },
  tts: {
    purpose: "文本转语音能力。",
    impact: "关闭后无法生成语音输出。",
  },
  web_fetch: {
    purpose: "抓取网页内容并解析。",
    impact: "关闭后无法直接抓取网页。",
  },
  web_search: {
    purpose: "联网搜索信息。",
    impact: "关闭后无法进行在线搜索。",
  },
  webfetch: {
    purpose: "兼容别名：网页抓取能力。",
    impact: "关闭后相关别名调用也会失效。",
  },
  memory_search: {
    purpose: "检索记忆库内容。",
    impact: "关闭后无法从记忆库检索信息。",
  },
  memory_get: {
    purpose: "读取记忆条目。",
    impact: "关闭后无法读取记忆库详情。",
  },
  memory_set: {
    purpose: "写入或更新记忆条目。",
    impact: "关闭后无法保存新记忆。",
  },
  memory_list: {
    purpose: "列出记忆条目。",
    impact: "关闭后无法浏览记忆列表。",
  },
  memory_delete: {
    purpose: "删除记忆条目。",
    impact: "关闭后无法删除记忆。",
  },
  agents_list: {
    purpose: "列出可用 agent。",
    impact: "关闭后无法查询 agent 列表。",
  },
  sessions_list: {
    purpose: "查看会话列表。",
    impact: "关闭后无法浏览会话。",
  },
  sessions_history: {
    purpose: "读取会话历史。",
    impact: "关闭后无法查看历史消息。",
  },
  sessions_send: {
    purpose: "向会话发送消息。",
    impact: "关闭后无法投递会话消息。",
  },
  sessions_yield: {
    purpose: "等待并获取会话产出。",
    impact: "关闭后无法等待子会话结果。",
  },
  sessions_spawn: {
    purpose: "创建子会话/子任务。",
    impact: "关闭后无法拉起子会话。",
  },
  subagents: {
    purpose: "调用子代理执行任务。",
    impact: "关闭后无法委派子代理。",
  },
  session_status: {
    purpose: "查询会话状态。",
    impact: "关闭后无法读取运行状态。",
  },
};

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
  onModelApplied?: (model: string) => void;
}

export function WorkerSettingsDialog({
  open,
  workerId,
  workerName,
  onClose,
  onModelApplied,
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
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolSaving, setToolSaving] = useState<Record<string, boolean>>({});
  const [toolItems, setToolItems] = useState<Array<{ id: string; enabled: boolean }>>([]);

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

  const loadTools = async () => {
    if (!workerId) return;
    setToolsLoading(true);
    try {
      const data = await getWorkerTools(workerId);
      setToolItems(Array.isArray(data?.tools) ? data.tools : []);
    } catch {
      setStatus("加载工具开关失败");
      setToolItems([]);
    } finally {
      setToolsLoading(false);
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
    loadTools();
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

  const handleApplyImagePreset = async (model: string) => {
    if (!workerId || presetSaving) return;
    setPresetSaving(true);
    setStatus("应用生图配置中…");
    try {
      const res = await applyWorkerImagePreset(workerId, model);
      if (!res.ok) {
        setStatus(res.error ?? "应用生图配置失败");
        return;
      }
      if (res.model) {
        setModelCurrent(res.model);
        setModelSelected(res.model);
        onModelApplied?.(res.model);
      }
      setStatus("生图专用配置已生效（已切换模型并禁用工具调用）");
    } catch (err: unknown) {
      setStatus(
        `应用生图配置失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPresetSaving(false);
    }
  };

  const handleModelChange = (id: string) => {
    setModelSelected(id);
    if (IMAGE_MODEL_IDS.has(id)) {
      handleApplyImagePreset(id);
    }
  };

  const handleToggleTool = async (toolId: string, enabled: boolean) => {
    if (!workerId || toolSaving[toolId]) return;
    setToolSaving((prev) => ({ ...prev, [toolId]: true }));
    const prevItems = toolItems;
    setToolItems((prev) => prev.map((item) => (item.id === toolId ? { ...item, enabled } : item)));
    try {
      const res = await setWorkerToolEnabled(workerId, toolId, enabled);
      if (!res.ok) {
        setStatus(res.error ?? `更新工具 ${toolId} 失败`);
        setToolItems(prevItems);
        return;
      }
      setStatus(`工具 ${toolId} 已${enabled ? "开启" : "关闭"}`);
    } catch (err: unknown) {
      setToolItems(prevItems);
      setStatus(`更新工具失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setToolSaving((prev) => ({ ...prev, [toolId]: false }));
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
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <optgroup label="生图模型">
                {IMAGE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
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
              disabled={!isModelDirty || modelSaving || presetSaving}
            >
              {modelSaving || presetSaving ? "..." : "保存"}
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

        <div className={styles.section}>
          <div className={styles.label}>工具能力开关（影响底层 Agent 可调用工具）</div>
          {toolsLoading ? (
            <div className={styles.empty}>加载中…</div>
          ) : toolItems.length === 0 ? (
            <div className={styles.empty}>暂无可配置工具</div>
          ) : (
            <div className={styles.toolList}>
              {toolItems.map((tool) => {
                const savingNow = !!toolSaving[tool.id];
                const meta = TOOL_DESCRIPTIONS[tool.id] || {
                  purpose: "该工具用于执行对应的底层能力。",
                  impact: "关闭后依赖该工具的任务会失败或被跳过。",
                };
                return (
                  <label key={tool.id} className={styles.toolRow}>
                    <span className={styles.toolMeta}>
                      <span className={styles.toolName}>{tool.id}</span>
                      <span className={styles.infoIcon} tabIndex={0}>
                        i
                        <span className={styles.tooltip}>
                          <strong>用途：</strong>{meta.purpose}
                          <br />
                          <strong>关闭影响：</strong>{meta.impact}
                        </span>
                      </span>
                    </span>
                    <span className={styles.switchWrap}>
                      <input
                        type="checkbox"
                        className={styles.switchInput}
                        checked={tool.enabled}
                        disabled={savingNow}
                        onChange={(e) => void handleToggleTool(tool.id, e.target.checked)}
                      />
                      <span className={styles.switchSlider} />
                    </span>
                  </label>
                );
              })}
            </div>
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
