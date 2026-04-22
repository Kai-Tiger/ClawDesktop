### 🧑 用户 `04-19 19:49`

我希望group chat里的worker可以给另一个worker发消息，怎么设计这个架构比较好，先不要写代码

### 🤖 Claude `04-19 19:49`

让我先了解一下现有的架构。

### 🤖 Claude `04-19 19:50`

现有架构清楚了。以下是设计思路：

---

## 核心问题

Worker 目前是被动的——接收消息、返回响应，没有主动发起通信的能力。要让 Worker A 给 Worker B 发消息，需要解决三个问题：**触发机制、路由、终止条件**。

---

## 推荐方案：@mention 回显链（Response Relay）

**原理**：延伸现有的 @mention 解析逻辑——不只解析用户消息里的 @mention，也解析 worker 响应里的 @mention。

**流程**：

```
User → @workerA message
  → workerA 处理，响应包含 "@workerB 请帮我查一下..."
    → 系统检测到，将 workerA 的响应作为新消息路由给 workerB
      → workerB 响应，写入 groupMessages
        → 结束（或继续）
```

**优点**：

- 复用已有的 @mention 解析和消息队列逻辑，改动最小
- Worker 不需要感知自己是在跟谁说话，只需"写出"下一步

**关键设计点**：

| 问题     | 设计                                                               |
| -------- | ------------------------------------------------------------------ |
| 循环防止 | 每条消息携带 `hopCount`，超过阈值（如 5）强制终止                  |
| 消息来源 | `GroupMessage.role` 已有 `'worker'` 值，加 `fromWorkerId` 字段即可 |
| 上下文   | Worker B 收到完整的 group thread + workerA 的触发消息              |
| 并发     | 复用现有 promise 链队列，保持有序                                  |

---

## 另一个选项：Tool Call 显式路由

Worker 响应里用结构化 tool_call（`send_to_worker`），主进程拦截后路由。

更明确、可扩展，但需要每个 worker 的系统提示里声明这个 tool，改动较大，适合后期演进。

---

**建议先做 @mention 回显链**，因为它几乎不改现有架构，只需在 `OpenClawService` 的响应处理处加一层解析和递归路由，加上 hopCount 限制即可。你觉得方向对吗？

### 🧑 用户 `04-19 20:06`

如果使用推荐方案，worker A在什么情况下才会@workerB，需要我给workerA设置某些skill吗

### 🤖 Claude `04-19 20:06`

这个问题本质是**提示词工程**，不是代码层面的 skill。

---

## Worker A 何时 @mention Worker B？

完全取决于 Worker A 的系统提示（SOUL.md / system prompt）里有没有告诉它：

1. **其他 worker 存在**，以及他们能做什么
2. **@mention 是调用他们的方式**
3. **什么情况下应该转交**

如果系统提示里没有这些信息，Worker A 根本不会产生 @mention——它不知道有别人可以帮忙。

---

## 所以需要做什么

**方案：在 group 级别注入上下文**

不需要给每个 worker 单独配置 skill，而是在 group chat 发消息时，**动态把 group 里所有 worker 的简介注入到每个 worker 的系统提示里**：

```
你是 [workerA 的 SOUL.md]

当前协作组成员：
- @workerB：擅长代码审查，当需要检查代码质量时请 @workerB
- @workerC：擅长搜索资料，当需要外部信息时请 @workerC

如果你的任务需要上述成员协助，在回复中直接 @对应成员 并说明你的请求。
```

这段描述来自每个 worker 自己的 `description` 字段（`WorkerMeta.description` 已有），**不需要额外的 skill 配置**。

---

## 关键推论

| 问题                              | 答案                                                  |
| --------------------------------- | ----------------------------------------------------- |
| 需要给 Worker A 加 skill 文件吗？ | 不需要，description 字段就够                          |
| Worker A 会自动知道 @mention 吗？ | 不会，必须在 system prompt 里显式说明这个约定         |
| 谁来组装这段注入内容？            | 主进程在发给 gateway 之前动态拼接                     |
| Worker A 一定会 @mention 吗？     | 不一定，这是 LLM 自主判断的，你只是给它"权限"和"知识" |

---

简言之：**你给 Worker A 描述好 Worker B 是谁、能做什么、怎么叫他，剩下的让模型自己判断。** 这比硬编码触发规则更灵活。

### 🧑 用户 `04-19 20:12`

我需要设定一个主worker来发布任务吗

### 🤖 Claude `04-19 20:12`

不一定，取决于你的使用场景：

---

**需要主 worker（Orchestrator 模式）** 当任务复杂、需要规划和分解时。比如"帮我做竞品分析"——主 worker 把任务拆成子任务，分配给各专项 worker，最后汇总结果。优点是有序、可控；缺点是主 worker 的提示词要写得很好，否则分配质量差。

**不需要主 worker（Peer 模式）** 当用户自己知道要找谁、任务边界清晰时。用户直接 @workerA，workerA 如果需要就 @workerB，链式流转即可。更轻量，但控制权在用户手里。

---

**实际建议**：先做 Peer 模式，用户就是"主 worker"。如果发现用户经常需要手动协调多个 worker，再引入一个专门的 Orchestrator worker——它的 SOUL.md 只做一件事：理解需求、拆任务、分配给组里的其他人。

这样不需要在架构上区分"主/从"，Orchestrator 只是一个提示词写法特殊的普通 worker。

### 🧑 用户 `04-19`

基于对话内容，现在我要实现两个worker协作，workerA输出内容，workerB审查并反馈给workerA修改，然后这样循环直到输出最终结果，要怎么实现prompt的组装注入

### 🤖 Claude `04-19`

## Prompt 组装策略

### 关键洞察：用 `history` 数组承载循环状态

现有的 `chatHttp` 已经接受 `history: MessageItem[]`，不需要新机制——**把每轮的输出和反馈追加进 history，history 就是循环状态本身**。

---

### Worker A 的 System Prompt（每轮不变）

```typescript
const peerBlock = peers.map(p =>
  `- @${p.id}：${p.description}，负责审查你的输出`
).join('\n');

const systemContent = [
  soul   && `# Soul\n${soul}`,
  agents && `# Workspace\n${agents}`,
  `# 协作规则\n当前组成员：\n${peerBlock}\n` +
  `如果收到修改意见，请根据意见重新输出完整内容。`,
].filter(Boolean).join('\n\n');
```

### Worker A 的 History（每轮递增）

```
第1轮发给A：
  history: []
  user: "帮我写一篇产品介绍"

第2轮发给A（收到B的critique后）：
  history: [
    { role: 'assistant', content: 'A的第1次输出...' },
    { role: 'user',      content: '[来自@workerB的审查意见]\n...' },
  ]
  user: "请根据上述意见修改"
```

### Worker B 的 System Prompt（每轮不变）

```typescript
const reviewerSystem = [
  soul && `# Soul\n${soul}`,
  `# 审查角色\n` +
  `原始任务：${originalRequest}\n\n` +
  `你负责审查 @${workerAId} 的输出。\n` +
  `- 如果输出满足要求，回复第一行必须是：APPROVED\n` +
  `- 否则给出具体修改建议，不要输出 APPROVED`,
].filter(Boolean).join('\n\n');
```

### 循环控制（主进程新增方法）

```typescript
async runCritiqueLoop(
  workerAId: string,
  workerBId: string,
  originalRequest: string,
  maxIterations = 5
): Promise<string> {
  let historyA: MessageItem[] = [];
  let messageA = originalRequest;
  let latestOutput = '';

  for (let i = 0; i < maxIterations; i++) {
    latestOutput = await this.chatHttp(workerA.path, messageA, historyA);
    historyA.push({ role: 'assistant', content: latestOutput });

    const critique = await this.chatHttpWithSystem(
      workerB.path, `请审查以下内容：\n\n${latestOutput}`, [],
      `原始任务：${originalRequest}\n如果满意回复APPROVED，否则给出修改建议`
    );

    if (critique.trimStart().toUpperCase().startsWith('APPROVED')) break;

    historyA.push({ role: 'user', content: `[来自审查的修改意见]\n${critique}` });
    messageA = '请根据上述修改意见重新输出完整内容。';
  }

  return latestOutput;
}
```

**关键设计点**：A 的跨轮记忆靠累积 `historyA`；B 无状态每轮清空 history；终止信号为 B 响应首行 `APPROVED`；`maxIterations` 防死循环。

---

### 🧑 用户 `04-19`

我希望通过页面交互来实现上面的功能，怎么设计UI比较好，先不要写代码

### 🤖 Claude `04-19`

## UI 设计方案

### 推荐方案：Header 模式切换 + 消息线程内展示进度

**1. Header 区：模式切换**

在 group name 标签右侧加 pill 切换，点击"循环"后 header 下方出现配置栏：

```
Group  [设计小组]   ● 聊天  ○ 循环    [WorkerA] [WorkerB]

┌─────────────────────────────────────────────────────────┐
│  生成方 [WorkerA ▾]   审查方 [WorkerB ▾]   最多 [3 ▾] 轮  │
└─────────────────────────────────────────────────────────┘
```

**2. Composer 区：模式联动**

切换到"循环"模式后，placeholder 变为任务描述，发送按钮变为"开始循环"，@mention 提示条隐藏。

**3. 消息线程：折叠式迭代展示**

```
🔄  循环任务开始（最多 3 轮）
▶ 第 1 轮  已折叠（审查完成后自动折叠）
▼ 第 2 轮（当前进行中，展开）
  [WorkerA] 修改后的内容...
  [WorkerB] 已通过 ✓
✅ 最终结果（高亮气泡）
[复制结果]   [发送到聊天]
```

---

### 🧑 用户 `04-19`

A 的 system prompt 里静态注入 peers 的 description，这一步在 UI 上要怎么操作

### 🤖 Claude `04-19`

**不需要单独的 UI 操作**——这一步对用户完全透明。

当用户在循环配置栏里选好"生成方 = WorkerA，审查方 = WorkerB"，主进程在调用 `chatHttp` 时自动把 B 的 `description` 拼进 A 的 system prompt。

唯一需要注意的是 `description` 字段的质量。有两个处理方式：

**方案 A**：description 够用就直接用，不加 UI。要求 worker 包里的 `worker.json` 把 description 写清楚。

**方案 B**：在 group header 的 worker badge 上加 hover 内联编辑，用户可直接修改 worker 的 description，系统注入时用最新版。改动最小，但让用户有感知和控制权。

建议先走方案 A，遇到"A 不知道该怎么配合 B"的问题时再加方案 B。

---

### 🧑 用户 `04-19`

我还是选择方案B，先帮我记住

### 🤖 Claude `04-19`

已记住。方案 B：worker badge hover 内联编辑 description，循环启动时系统自动注入，无需额外配置步骤。

---

### 🧑 用户 `04-19`

这种模式可以定义为生产者+验证者，我认为可以用图形拖拽的方式来编排agent流程，你觉得怎么样

### 🤖 Claude `04-19`

方向对，但要小心范围膨胀。

图形编排视觉表达力很强，"生产者→验证者"天然适合节点连线表达。但完整的拖拽画布（React Flow 级别）本身就是一个独立的产品功能——需要解决节点定义、连线语义、执行引擎理解图结构、状态可视化，每一块都不小。

**建议的折中路径**：先做 2-3 个固定模式的"流程模板"（生产者+验证者、串行流水线、并行广播），用预设的可视化卡片而不是自由拖拽画布来选择和配置。等模式稳定、用户有需求时，再升级成真正的拖拽编排。

核心权衡：**先把一个模式做深做好，还是先把编排框架建起来**。

---

### 🧑 用户 `04-19`

折中方案的预设可视化卡片是什么样的交互流程，以上面workerA和workerB的例子详细说一下

### 🤖 Claude `04-19`

## 折中方案：预设模板的完整交互流程

**第一步：入口**

Group chat header 加模式切换，用户点击"流程"，消息区变成模板选择界面。

**第二步：选择模板**

展示 2-3 张模板卡片，每张内嵌静态小流程图：

```
┌──────────────────────────┐   ┌──────────────────────────┐
│  生产者 + 验证者           │   │  串行流水线               │
│                           │   │                           │
│  [A] ──→ [B]             │   │  [A] ──→ [B] ──→ [C]     │
│   ↑_______↩              │   │                           │
└──────────────────────────┘   └──────────────────────────┘
```

**第三步：配置流程**

页面中央展示可交互流程图，节点是空槽位，点击选择 worker，description 在节点下方内联显示可编辑：

```
  ┌────────────────────┐          ┌────────────────────┐
  │  WorkerA           │ ───────→ │  WorkerB           │
  │  小红书文案助手      │          │  内容审查专家        │
  │  负责生成初稿        │          │  检查逻辑和表达      │
  └────────────────────┘          └────────────────────┘
        ↑                                   │
        └───────────────────────────────────┘
                    最多  [3 ▾] 轮

任务描述
┌────────────────────────────────────────┐
│  帮我写一篇面向程序员的产品介绍…          │
└────────────────────────────────────────┘
                              [开始流程]
```

**第四步：执行可视化**

流程图变成实时状态指示器，当前活动节点高亮，已完成轮次折叠为摘要行。

**第五步：完成**

最终结果独立突出展示，提供"复制结果"和"发送到聊天"按钮。

---

### 🧑 用户 `04-19`

第四步，我希望状态还是可以在 group chat 里以对话的方式展开，因为这个软件强调的是真人agent员工

### 🤖 Claude `04-19`

很对，这个调整让流程感更自然。

**第四步（修订）：执行时回到群聊视图**

点击"开始流程"后，**视图自动切换回聊天模式**，流程以对话形式在 group chat 里展开：

```
─────────────────────────────────────
[系统]  🔄 已启动「生产者+验证者」流程
        WorkerA 生成 → WorkerB 审查，最多 3 轮
─────────────────────────────────────

WorkerA
这是第一版产品介绍：
面向程序员的 XXX 产品，核心功能是…

WorkerB  →  WorkerA
读完了，有两点需要修改：
1. 开头太官方，程序员更喜欢直接说痛点
2. 第三段逻辑跳跃，需要过渡句

WorkerA
好的，修改如下：
你有没有遇到过…（新版本）

WorkerB  →  WorkerA
通过了，这版表达自然多了 ✓

─────────────────────────────────────
[系统]  ✅ 流程完成（第 2 轮）
─────────────────────────────────────
```

WorkerB 的消息标注"→ WorkerA"，用户看着像在旁观两个同事协作。用户可以随时插话打断，流程暂停等待。
