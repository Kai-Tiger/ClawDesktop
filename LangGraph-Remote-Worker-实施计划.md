# LangGraph TS + 跨机器 Worker 实施计划

## 1. 背景

当前系统已具备基础多 Agent 协作能力：

- 前端 `GroupChat` 已支持：
  - @mention 指定 worker
  - 通过协调者生成 `tasks + after` 的 DAG 计划
  - 按依赖执行任务，并将前置任务结果注入后续任务
- 现有关键实现：
  - 规划：`app/electron/main/coordinator-service.ts`
  - 编排执行（当前在前端）：`app/electron/renderer/src/components/Chat/GroupChatPanel.tsx`
  - 会话与执行通道：`chatSend(...)` + `groupId` 会话隔离
- 主要问题：
  1. 编排逻辑在前端，状态持久化与恢复能力弱
  2. 多机 worker 通信尚未标准化（路由、鉴权、重试、可观测）
  3. 前置结果目前以文本注入为主，缺少结构化 artifact 机制
  4. 缺乏统一任务生命周期状态机和可靠失败策略

目标是在不破坏现有功能的前提下，引入 **LangGraph TS（控制面）**，并支持 **跨机器 Worker（执行面）**，实现“可扩展、可观测、可恢复”的多 Agent 体系。

---

## 2. 目标与非目标

### 2.1 目标

- 引入 LangGraph TS 作为控制面编排引擎
- 保持现有 UI 体验，逐步迁移而非重写
- 支持本地/远端 worker 混合执行
- 建立统一任务协议、事件协议、状态模型
- 提供失败重试、超时、取消、回放与审计能力
- 可灰度、可回滚（feature flag）

### 2.2 非目标（本期不做）

- 不做一次性“全量替换”
- 不引入复杂多租户权限系统（先满足单租户/内网）
- 不在首期实现跨地域高可用部署
- 不强依赖 Python sidecar（优先 TS 方案）

---

## 3. 总体方案

采用“**控制面 / 执行面分离**”架构：

- 控制面（LangGraph TS）
  - 负责：任务规划、依赖调度、状态机、重试/超时、事件输出
- 执行面（Worker Adapter）
  - 负责：将 task 投递到本地或远程 worker，流式回传结果
- UI 层（GroupChat）
  - 负责：提交请求、订阅事件流、渲染状态，不直接做 DAG 编排

### 3.1 关键原则

1. **接口优先**：先抽象 Planner/Orchestrator/WorkerAdapter 接口
2. **双轨并行**：`builtin` 与 `langgraph` 并存，逐步切换
3. **协议稳定**：先定 task/event/schema，再做实现
4. **可回滚**：通过配置开关快速回退至原实现

---

## 4. 架构设计（目标态）

### 4.1 控制面（LangGraph TS）

建议新增 `app/electron/main/orchestrator/`：

- `interfaces.ts`
  - `PlanInput`, `TaskPlan`, `TaskSpec`, `TaskResult`, `RunState`, `RunEvent`
- `langgraph-orchestrator.ts`
  - LangGraph StateGraph 定义、节点/边、运行入口
- `builtin-orchestrator.ts`
  - 现有逻辑适配层（用于回退）
- `planner/coordinator-planner.ts`
  - 复用/增强现有 `coordinator-service.ts` 的计划能力
- `store/run-store.ts`
  - 运行态存储（首期内存+文件，后续可 Redis/SQLite）
- `events/event-bus.ts`
  - 统一事件分发（给 UI/SSE/日志）

LangGraph 建议节点：

1. `plan`：生成任务计划（tasks + after）
2. `schedule`：识别 ready tasks（依赖满足）
3. `execute`：通过 WorkerAdapter 执行 ready tasks
4. `merge`：写入结果、推进状态
5. `finalize`：汇总 run 结果并结束

---

### 4.2 执行面（本地 + 远端）

建议新增 `app/electron/main/worker-adapter/`：

- `types.ts`
  - `WorkerRef`, `ExecuteTaskRequest`, `ExecuteTaskResponse`, `ArtifactRef`
- `local-worker-adapter.ts`
  - 调现有 `chatSend` / ChatService 执行本地任务
- `remote-worker-adapter.ts`
  - 调远端 Worker Runtime（HTTPS + SSE）
- `adapter-registry.ts`
  - 根据 `workerRef.type` 路由 local/remote
- `worker-registry.ts`
  - worker 注册信息（id -> endpoint/capabilities/health）

---

### 4.3 通信协议

#### Task 协议（控制面 -> 执行面）

- `taskId`, `runId`, `groupId`, `workerId`
- `message`（主指令）
- `dependsOn`（依赖任务ID）
- `artifactsIn`（前置结构化产物）
- `timeoutMs`, `retryPolicy`
- `traceId`, `idempotencyKey`

#### Event 协议（执行面/控制面 -> UI）

- `run.started`
- `task.started`
- `task.chunk`
- `task.completed`
- `task.failed`
- `run.completed`
- `run.failed`
- `run.canceled`

事件公共字段：

- `timestamp`, `traceId`, `runId`, `groupId`, `taskId`, `workerId`, `seq`, `payload`

---

### 4.4 前置结果传递升级

从当前“拼接文本”升级为“双通道”：

1. **结构化通道**：`artifactsIn`（文本、JSON、文件引用）
2. **兼容文本通道**：仍可保留 `前置任务结果：...` 提示，保障兼容旧 worker

---

## 5. 代码改动点（按文件/模块）

### 5.1 现有文件改造

1. `app/electron/renderer/src/components/Chat/GroupChatPanel.tsx`
   - 移除前端 DAG 编排核心逻辑（保留 UI 与事件消费）
   - 改为：
     - 提交 run 请求
     - 订阅 run/task 事件
     - 渲染中间状态与最终结果
   - 增加取消任务、重试按钮（可选）

2. `app/electron/main/coordinator-service.ts`
   - 抽象为 Planner 实现之一
   - 输出结构与 `TaskPlan` 对齐
   - 增加 plan 校验（workerId 合法性、DAG 无环）

3. `app/electron/main/ipc-handlers.ts`
   - 新增 IPC：
     - `orchestrator:startRun`
     - `orchestrator:cancelRun`
     - `orchestrator:getRun`
     - `orchestrator:subscribe`（可通过主进程转发事件）

4. `app/electron/preload/index.ts`
   - 暴露 orchestrator API 给 renderer

5. `app/electron/renderer/src/api/gateway.ts`
   - 增加 orchestrator 的 API 封装
   - 保留原 `chatSend` 作为后备执行通道

6. `app/electron/renderer/src/store/chatStore.ts`
   - 增加 run/task 运行态字段
   - 增加事件驱动更新方法（append chunk、状态迁移）

### 5.2 新增文件（建议）

- `app/electron/main/orchestrator/*`
- `app/electron/main/worker-adapter/*`
- `app/electron/main/registry/worker-registry.ts`
- `app/electron/main/types/orchestration.ts`
- `app/electron/renderer/src/types/orchestration.ts`

---

## 6. 里程碑计划（6周）

### M1（第1周）：接口与骨架

交付：

- Orchestrator/Planner/Adapter 接口定义
- 统一 Task/Event schema
- feature flag 设计：`orchestrator=builtin|langgraph`、`transport=local|remote`
- 基础 run state 数据结构

验收：

- 编译通过
- 不改现有业务路径（默认 builtin）

---

### M2（第2周）：LangGraph 最小可运行（本地worker）

交付：

- LangGraph 状态图（plan/schedule/execute/finalize）
- local-worker-adapter 打通
- 单 group 基础流程可运行（无远程）

验收：

- 与当前 builtin 输出结果等价（核心场景）
- 失败可回退到 builtin

---

### M3（第3周）：远程 Worker 通道（HTTPS + SSE）

交付：

- remote-worker-adapter
- worker-registry（静态配置 + 心跳）
- 事件流打通到 UI（chunk/progress/completed）

验收：

- 1 本地 + 1 远程混合任务执行通过
- 断连重连不丢 run 状态（至少最终状态可恢复）

---

### M4（第4周）：可靠性能力

交付：

- timeout/retry/cancel
- 任务幂等键与重复执行保护
- 错误分类与重试策略（可配置）

验收：

- 模拟远程 worker 失败时可重试/可失败落盘
- 取消任务可中止后续依赖任务调度

---

### M5（第5周）：artifact 与依赖语义增强

交付：

- `artifactsIn/artifactsOut` 结构化传递
- 前置结果注入策略升级（结构化优先，文本兼容）
- 关键链路日志（traceId 打通）

验收：

- 至少 3 类 artifact（text/json/fileRef）贯通
- UI 可展示依赖来源与任务产物摘要

---

### M6（第6周）：灰度与切换

交付：

- A/B 灰度开关
- 监控面板（基础指标）
- 文档与运维手册（回滚、故障排查）

验收：

- 线上灰度稳定运行 >= 3 天
- 回滚步骤可在 5 分钟内完成

---

## 7. 风险与应对

1. **风险：前后端同时大改导致回归**
   - 应对：保留 builtin 路径 + 按开关灰度

2. **风险：远程 worker 不稳定**
   - 应对：超时+重试+熔断+降级到本地 worker

3. **风险：依赖任务产物格式不一致**
   - 应对：定义 artifact schema + 版本号 + 校验器

4. **风险：状态不同步（UI vs 主进程）**
   - 应对：主进程 run-store 作为单一事实源（SSOT）

5. **风险：安全风险（远程调用）**
   - 应对：mTLS/Token、最小权限、审计日志

---

## 8. 验收标准（Definition of Done）

- 功能：
  - LangGraph 路径可稳定运行 group DAG
  - 支持本地/远程 worker 混合执行
- 可靠性：
  - 支持 timeout/retry/cancel
  - 失败可恢复，可追踪
- 可观测：
  - 每个 task 有 traceId、耗时、状态、错误信息
- 可运维：
  - feature flag 一键切回 builtin
  - 有完整排障文档

---

## 9. 配置与发布策略

- 配置项（建议）：
  - `ORCHESTRATOR_MODE=builtin|langgraph`
  - `WORKER_TRANSPORT=local|remote|hybrid`
  - `REMOTE_WORKER_TIMEOUT_MS`
  - `REMOTE_WORKER_RETRY_MAX`
- 发布策略：
  1. dev 全量开启
  2. staging 混合压测
  3. production 小流量灰度（10% -> 30% -> 100%）

---

## 10. 回滚方案

- 开关回滚：
  - `ORCHESTRATOR_MODE=builtin`
  - `WORKER_TRANSPORT=local`
- 数据回滚：
  - run-store 使用版本化 schema，向后兼容读取
- 操作回滚时间目标：
  - 5 分钟内恢复至旧路径

---

## 11. 后续增强（本期外）

- 动态 worker 自动扩缩容
- 任务优先级队列与公平调度
- 成本优化（token预算、模型路由）
- 跨项目/跨租户隔离
