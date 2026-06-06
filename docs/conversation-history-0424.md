# 开发会话记录 2026-04-24

## 1. WorkerSettingsDialog 新增模型

**需求**：在 `WorkerSettingsDialog.tsx` 的 `MODELS` 列表中新增三个模型。

**新增内容**：

- `moonshotai/kimi-k2.6` — Kimi K2.6
- `anthropic/claude-sonnet-4.6` — Claude Sonnet 4.6
- `google/gemini-3-flash-preview` — Gemini 3 Flash Preview

---

## 2. 支持用户自定义 OpenRouter 模型

**需求**：用户可以手动输入 OpenRouter 上的模型 ID 并添加到列表。

**实现方案**：

- 将内置模型常量重命名为 `BUILTIN_MODELS`
- 自定义模型存储在 `localStorage`（key: `openclaw_custom_models`），页面刷新后保留
- 下拉框用 `<optgroup>` 分组，分为「内置模型」和「自定义模型」
- 模型管理区显示在底层模型 section 内，包含：输入框、添加按钮、已添加模型列表及移除按钮
- 移除当前选中的自定义模型时，自动回退到默认模型

---

## 3. Worker 默认模型改为 mimo-v2-pro

**需求**：将 worker 的默认模型从 `BUILTIN_MODELS[0]`（MiniMax M2.5）改为 `xiaomi/mimo-v2.5-pro`。

**修改位置**：`WorkerSettingsDialog.tsx` 中 `loadModel` 的 fallback 值，以及移除自定义模型时的回退值。

---

## 4. 切换 Worker 时消息列表不再平滑滚动

**问题**：切换 worker 时，消息列表会 smooth 滚动到底部，体验不好。

**根因**：`MessageList.tsx` 的 `useEffect` 对 `messages` 和 `currentWorkerId` 变化都用了 `behavior: 'smooth'`。

**修复**：用 `useRef` 记录上一次的 `currentWorkerId`，切换 worker 时用 `behavior: 'instant'` 直接定位，同一 worker 收到新消息时仍保持 `smooth`。

---

## 5. CSV 文件在消息气泡中只展示前 10 行

**需求**：发送 CSV 文件时，聊天气泡里只显示文件前 10 行，后面用 `...` 代替，但发送给 AI 的内容不受影响。

**实现**：在 `MessageBubble.tsx` 中新增 `truncateFileBlocks` 函数，渲染前对消息文本中所有代码块做截断处理（正则匹配 ` ```lang\n...\n``` ` 块），超过 10 行的追加 `...`。存储在 store 里的原始内容不变。

---

## 6. 消息 Token 展示（已放弃）

**需求**：在消息气泡右下角展示本次对话消耗的 token 数。

**调研结论**：

Worker 发送消息的路由逻辑（`main/index.ts`）：

| mode           | 文本路径        | 能拿到 token？    |
| -------------- | --------------- | ----------------- |
| 默认           | HTTP → CLI 兜底 | ○ 正常 / × 兜底时 |
| `agent`        | CLI             | ×                 |
| `agent` + 图片 | HTTP            | ○                 |

用户使用的都是 zip 包导入的 worker（`mode === 'agent'`），全部走 CLI 模式，CLI 输出没有结构化的 usage 数据，**该功能无法实现，已放弃**。

---

## 7. CLI 模式 vs HTTP 模式

**CLI 模式（`mode === 'agent'`）的优势**：

- **持久 Session**：每个 worker 有固定 `session-id`，跨对话保留上下文，无需每次传完整历史
- **独立 Workspace**：每个 worker 有自己的工作目录（`workspace-{workerId}`），可存文件、配置、状态
- **Skills 系统**：workspace 下有 `skills/` 目录，worker 随 zip 包携带自己的工具能力
- **完整 Agent 运行时**：直接调用 openclaw agent，而非 stateless 的 HTTP 对话

**代价**：无结构化返回值（token、耗时等元数据拿不到）；子进程启动比 HTTP 请求慢。

---

## 8. 修改 SOUL.md 是否需要重启

**结论**：CLI 模式下，修改 workspace 的 `SOUL.md` 后需要在界面上点「清除会话」才能保险生效。

**原因**：CLI agent 使用持久 session（`sessions.json`），系统提示可能被缓存在 session 快照中。每次重新导入 worker zip 时代码都会调用 `clearAgentSessionSnapshot`，说明 workspace 文件变更后必须清 session 才能确保生效。

HTTP 模式每次请求都现读 SOUL.md，改了立即生效。

---

## 9. 修复导入 Worker 后模型仍显示 gpt-5-nano

**问题**：导入新 worker 后，模型显示为全局默认的 `gpt-5-nano`。

**根因**：`installWorkerFromTemp` 导入流程只写 `worker.json`，从不在 `openclaw.json` 里给新 worker 设置 model。`getWorkerModel` 找不到 worker 专属 model 就回退到全局默认（`agents.defaults.model`），即 `gpt-5-nano`。

**修复**：在 `installWorkerFromTemp` 完成后，直接将 `openrouter/xiaomi/mimo-v2.5-pro` 写入 `openclaw.json` 的 `agents.list`。逻辑：若该 worker 已有 model（重新导入时）则不覆盖，若是新 worker 或无 model 则写入默认值。
