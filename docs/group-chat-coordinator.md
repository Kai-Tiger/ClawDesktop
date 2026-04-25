# Group Chat 协调者功能开发记录

## 功能概述

在 Group Chat 中引入一个隐形的"协调者"（Coordinator）Agent。当用户 @mention 两个或更多 worker 时，协调者会分析用户意图，生成带依赖关系的执行计划（DAG），由 Renderer 按顺序调用各 worker，并将前置任务的输出自动传递给后续任务。

---

## 架构设计

```
用户发消息（@workerA @workerB）
        │
        ▼
  Renderer 检测到 2+ @mention
        │
        ▼
  coordinatorPlan（IPC → main → OpenRouter/gateway）
  返回 JSON 执行计划
        │
        ▼
  Renderer 按 DAG 顺序执行
  ├─ task1 → chatSend(workerA, message)
  │           ↓ result
  └─ task2 → chatSend(workerB, message + "前置任务结果：" + result)
```

**关键原则：**
- Worker 之间不能互相通信，协调和传递结果完全由 Renderer 负责
- 协调者是隐形的，不在 worker 列表里，不占用 agent session
- 协调者只做规划，不做执行

---

## 涉及文件

| 文件 | 改动内容 |
|------|----------|
| `main/index.ts` | 新增 `coordinatorPlan`、`getCoordinatorModel`、`setCoordinatorModel` 方法；新增 IPC handler |
| `preload/index.ts` | 新增 `coordinatorGetModel`、`coordinatorSetModel`、`coordinatorPlan` IPC bridge |
| `renderer/src/api/gateway.ts` | 新增对应 export |
| `renderer/src/types/index.ts` | 新增 `CoordinatorTask`、`CoordinatorPlan` 类型；`GroupMessage.role` 加入 `'debug'` |
| `renderer/src/store/chatStore.ts` | 新增 `clearGroupMessages` action |
| `renderer/src/components/Chat/GroupChatPanel.tsx` | 主要实现文件 |
| `renderer/src/components/Chat/GroupChatPanel.module.css` | 调试消息样式、协调者按钮样式 |

---

## 核心实现

### 1. 协调者执行计划（main/index.ts）

`coordinatorPlan` 方法向 LLM 发送 system prompt，要求输出 JSON 格式的执行计划：

```json
{
  "analysis": "简要分析任务拆解和顺序",
  "tasks": [
    { "id": "t1", "workerId": "intern2", "message": "写一段Python脚本获取今天的日期", "after": [] },
    { "id": "t2", "workerId": "intern4", "message": "请执行前置任务结果中的Python脚本", "after": ["t1"] }
  ]
}
```

**模型选择逻辑：**
- 配置了协调者专属模型 → 直接调 OpenRouter API（绕过 gateway）
- 未配置 → 走本地 gateway，使用默认模型

```ts
if (coordinatorModel && openRouterKey) {
  url = 'https://openrouter.ai/api/v1/chat/completions';
  model = coordinatorModel;  // 如 "anthropic/claude-sonnet-4.6"
} else {
  url = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
  model = 'openclaw';  // gateway 通用标识
}
```

**注意：** gateway 只接受 `'openclaw'` 或 `'openclaw/worker-id'` 作为 model 字段，不接受完整的 OpenRouter 模型名（否则返回 HTTP 400）。

### 2. System Prompt 关键规则

```
- 必须为每个 listed worker 各创建至少一个 task，不能跳过或合并
- 遵守用户请求中隐含的顺序（"A 做完交给 B" → B.after = ["A的id"]）
- 绝对不能让任何 worker 调用或联系另一个 worker
- 消息要简短直接，只说意图，不加实现细节、路径、命令示例
- 每个 worker 有自己的 skill，知道怎么处理任务
- 依赖任务的消息写法示例："请执行前置任务结果中的Python脚本"
- 前置结果由系统自动注入到消息末尾（"前置任务结果："），不需要 worker 主动获取
```

### 3. DAG 执行（GroupChatPanel.tsx `runCoordinator`）

```ts
const results = new Map<string, string>();
const pending = new Set(plan.tasks.map(t => t.id));

while (pending.size > 0) {
  // 找出所有前置依赖已完成的 task
  const ready = plan.tasks.filter(
    t => pending.has(t.id) && t.after.every(dep => !pending.has(dep))
  );
  if (ready.length === 0) break;

  // 并行执行所有就绪的 task
  await Promise.all(ready.map(async (task) => {
    pending.delete(task.id);
    const priorResults = task.after.map(dep => results.get(dep)).filter(Boolean).join('\n\n');
    const fullMessage = priorResults
      ? `${task.message}\n\n前置任务结果：\n${priorResults}`
      : task.message;
    const result = await chatSend(worker.id, fullMessage, undefined, history);
    results.set(task.id, result.reply);
  }));
}
```

### 4. 消息类型

`GroupMessage.role` 扩展了 `'debug'` 类型，仅在调试模式下显示：

```ts
type Role = 'user' | 'worker' | 'system' | 'debug';
```

调试消息内容包括：
- 协调者原始输出（LLM 返回的 JSON）
- 解析结果摘要（任务数量、分析文字）
- 每个任务实际发给 worker 的完整消息

### 5. JSON 解析容错

```ts
// 尝试 1：去掉 markdown fence 后解析
const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
JSON.parse(cleaned);

// 尝试 2：从回复中提取第一个 {...} 对象
const match = raw.match(/\{[\s\S]*\}/);
JSON.parse(match[0]);

// fallback：所有 worker 并行处理，不依赖
```

---

## 协调者模型配置

**存储位置：**
```
{app.userData}/coordinator-config.json
// macOS 实际路径：
~/Library/Application Support/Clawin Desktop/coordinator-config.json
```

**格式：**
```json
{ "model": "anthropic/claude-sonnet-4.6" }
```

**UI：** Group Chat header → "协调者"按钮 → 下拉选择器，支持内置模型列表，保留"使用默认模型"选项。

---

## 解决过的问题

### HTTP 400 错误

**原因：** `coordinatorPlan` 使用了 `getConfiguredModelFull()` 返回的完整 OpenRouter 模型名（如 `anthropic/claude-...`），但 gateway 只接受 `'openclaw'` 格式。

**修复：** 改为硬编码 `model: 'openclaw'`（后续扩展为配置化）。

### Worker 试图调用另一个 Worker

**现象：** intern4 收到指令后尝试将 intern2 作为 subagent 调用，触发白名单报错。

**原因：** Coordinator 生成的计划中，intern4 的消息写成了"获取 intern2 的脚本并执行"，intern4（agent 模式）将其理解为工具调用。

**修复：** System prompt 明确禁止让 worker 调用其他 worker，并说明前置结果由系统自动注入。

### 协调者只生成一个任务

**现象：** 用户 @intern2 和 @intern4，但计划里只有 intern4 的任务（协调者"聪明过头"跳过了 intern2）。

**修复：** System prompt 加规则：必须为每个 listed worker 各分配至少一个任务。

### 消息内容过多

**现象：** 协调者在发给 worker 的消息里加了文件路径、命令示例等实现细节。

**修复：** System prompt 改为"只传意图，信任 worker 的 skill"，删除"include all context needed"相关要求。

### 协调者设置下拉框闪烁关闭

**原因：** 点击 `<select>` 时事件冒泡到最外层 `div`，触发了关闭逻辑。

**修复：** 在下拉面板上加 `onClick={(e) => e.stopPropagation()}`。

---

## 单 Worker 模式

当只 @mention 一个 worker 时，不走协调者，走简单路径：

- **无 CSV：** 直接 `chatSend`，进入 per-worker 串行队列（`chains`）
- **有 CSV：** 读取文件全文，拼接到消息末尾，一次性发给该 worker（`以下是文件内容：\n${csvText}`）

## Clear 功能

点击 `/Clear` 按钮：
1. `clearGroupMessages(groupId)` — 清空 Zustand store 里的 UI 消息
2. `clearWorkerSessions(workerIds)` — 调用 `clearAgentSessionSnapshot`，清除 openclaw 底层的 session 快照，下次对话不携带历史上下文
