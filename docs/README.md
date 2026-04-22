# OpenClaw Electron — 系统架构文档

桌面版 AI 助手，将 OpenClaw 框架 + 小红书 Worker + Playwright 浏览器自动化打包进 Electron macOS 应用。

---

## 目录结构

```
openclaw-electron-phase2/
├── app/electron/               # Electron 应用源码（主进程 / 预加载 / 渲染层）
│   ├── main/index.ts           # 主进程入口，OpenClawService 类
│   ├── preload/index.ts        # Context Bridge，暴露 IPC API 给渲染层
│   ├── renderer/src/           # React 前端
│   ├── dist/                   # 编译产物（.gitignore）
│   ├── tsconfig.main.json      # 主进程 / 预加载 TS 配置
│   ├── tsconfig.renderer.json  # 渲染层 TS 配置（jsx: react-jsx）
│   ├── vite.config.mts         # Vite 配置（渲染层打包）
│   └── package.json
├── runtime/                    # 只读内嵌运行时（发布时打入 Resources）
│   ├── node/bin/node           # 内嵌 Node.js v24（arm64）
│   ├── openclaw/               # OpenClaw CLI（openclaw.mjs）
│   └── workspace-template/     # 工作区模板（首启复制）
├── workers/
│   └── red-note-helper/        # 小红书助手 Worker 定义
├── scripts/
│   ├── prepare-embedded-runtime.sh  # 初始化 runtime/ 目录
│   └── clear-sessions.sh            # 清除 gateway session 缓存
├── docs/                       # 打包、签名、迁移说明
└── build/                      # 应用图标、签名资源
```

---

## 核心设计原则

| 原则 | 说明 |
|------|------|
| **运行时只读** | `runtime/` 随 app 发布，不可写；用户数据在 `userData/` |
| **内嵌 Node 隔离** | 所有子进程使用 `runtime/node/bin/node`，不依赖系统 Node / nvm |
| **Loopback-only Gateway** | `gateway.mode=local`，`auth.mode=none`，仅监听 127.0.0.1 |
| **升级不覆盖用户数据** | 版本变更只写版本锁，不重置登录态、memory、配置 |
| **HTTP 优先，CLI 兜底** | 聊天走 HTTP API，省去每次 spawn 的 1-2s 冷启动开销 |

---

## 组件架构

### 1. 主进程 (`main/index.ts`)

`OpenClawService` 单例，负责整个 OpenClaw 生命周期。

#### 路径解析

```
resourcesRuntime  → runtime/（开发）或 process.resourcesPath/runtime/（生产）
userRuntimeRoot   → ~/Library/Application Support/openclaw-electron-phase2/runtime/
userOpenClawHome  → userRuntimeRoot/openclaw-home/
userWorkspace     → userOpenClawHome/.openclaw/workspace-desktop/   ← 与 openclaw workspaceDir 对齐
embeddedNodePath  → resourcesRuntime/node/bin/node
openclawCliPath   → resourcesRuntime/openclaw/openclaw.mjs
```

#### 启动流程 `bootstrap()`

```
1. 创建目录：state/, logs/, openclaw-home/state/, openclaw-home/logs/
2. 校验 runtime（node binary、openclaw CLI、workspace-template 存在）
3. 初始化 workspace（首次全量复制模板；已存在则仅补充缺失的 skills/）
4. npm install（内嵌 Node 执行，安装 playwright 等依赖）
5. 写入 openclaw 配置（batch-json）：
   - gateway.mode = local
   - gateway.auth.mode = none
   - gateway.http.endpoints.chatCompletions.enabled = true
6. 写版本锁（runtime-version.json），非破坏性
```

#### IPC 处理器（8 个通道）

| 通道 | 处理 |
|------|------|
| `gateway:status` | `statusJson()` — 解析 `gateway status --json` |
| `gateway:start` | `startGateway()` — spawn gateway 进程 |
| `gateway:stop` | `stopGateway()` — SIGTERM |
| `gateway:debug` | `debugInfo()` — 路径 & 存在性诊断 |
| `settings:getOpenRouterKey` | 读 openclaw.json |
| `settings:saveOpenRouterKey` | 写 baseUrl + apiKey + models（batch-json）|
| `workers:list` | 扫描 `workers/` 目录，读 worker.json |
| `chat:send` | `chat(workerId, message, history?)` |

---

### 2. Gateway 生命周期

#### 启动 `startGateway()`

```bash
node openclaw.mjs gateway run --allow-unconfigured --auth none
```

- 监听 "listening / ready / started" 关键词（5s 超时后认为"启动中"）
- 成功后从 `statusJson()` 读取实际端口（默认 18789）
- 进程引用存入 `this.gatewayProcess`

#### 状态 `statusJson()`

```bash
node openclaw.mjs gateway status --json
```

返回结构：

```typescript
{
  rpc:     { ok: boolean; url: string; error?: string },
  gateway: { port: number; bindHost: string; bindMode: string },
  port:    { status: string },
  service: { loaded: boolean; runtime: { status: string } },
  logFile: string
}
```

#### 停止 `stopGateway()`

- SIGTERM → `gatewayProcess = null`
- 在 `app.on('before-quit')` 自动调用

---

### 3. 聊天流程

```
[Renderer] useChat.send(text)
    ↓
构建 history（过滤 "思考中…" 占位符）
    ↓
api/gateway.chatSend(workerId, message, history)
    ↓ IPC invoke('chat:send')
[Main] service.chat(workerId, message, history)
    │
    ├─ [HTTP 优先] chatHttp(workerPath, message, history)
    │   ├─ 读 workers/red-note-helper/SOUL.md
    │   ├─ 读 workers/red-note-helper/AGENTS.md
    │   ├─ 组装 system message：# Soul + # Workspace
    │   ├─ POST http://127.0.0.1:18789/v1/chat/completions
    │   │   Body: { model: "openclaw/default", messages: [system, ...history, user] }
    │   └─ 返回 choices[0].message.content
    │
    └─ [CLI 兜底] runOpenClaw(['agent', '--session-id', id, '--message', text, '--json'])
        ├─ cwd = selected.path（worker 目录）
        ├─ 解析 stderr/stdout JSON（逐行扫描，剥离 ANSI）
        └─ 提取 payloads[0].text / reply / message / output
```

**为什么用 HTTP 而非 CLI：**

| 方式 | 延迟组成 | 总计 |
|------|---------|------|
| CLI spawn（旧） | Node 冷启动 1-2s + LLM 推理 5-6s | ~7-8s |
| HTTP API（现） | HTTP 开销 <10ms + LLM 推理 5-6s | ~5-6s |

---

### 4. 预加载层 (`preload/index.ts`)

通过 `contextBridge` 暴露 `window.gatewayApi`：

```typescript
{
  status:            () => Promise<GatewayStatus>
  start:             () => Promise<{ ok: boolean; message: string }>
  stop:              () => Promise<{ ok: boolean; message: string }>
  debug:             () => Promise<unknown>
  getOpenRouterKey:  () => Promise<string>
  saveOpenRouterKey: (key: string) => Promise<SaveKeyResult>
  workersList:       () => Promise<WorkerMeta[]>
  chatSend:          (workerId, message, history?) => Promise<ChatResult>
}
```

---

### 5. 渲染层 (`renderer/src/`)

#### 组件树

```
App
├── Sidebar
│   ├── GatewayControls     # Status / Start / Stop 按钮 + 状态卡片
│   ├── WorkerList          # Worker 列表，点击切换
│   └── OpenRouterForm      # API Key 展示（已保存显示缩略）+ Edit
└── ChatPanel
    ├── MessageList         # 消息气泡列表
    │   └── MessageBubble   # user=蓝色，assistant=灰色
    └── Composer            # 输入框 + 发送（⌘Enter）
```

#### 状态管理（Zustand）

```typescript
useChatStore {
  workers:         WorkerMeta[]
  currentWorkerId: string
  messages:        Record<string, ChatMessage[]>   // 按 workerId 分桶

  setWorkers(workers)      // 初始化 worker 列表，设置默认欢迎消息
  selectWorker(id)         // 切换 worker，初始化消息桶
  pushMessage(id, msg)     // 追加消息（含 "思考中…" 占位）
  updateLastMessage(id, content)  // 替换最后一条（LLM 回复 / 错误）
}
```

#### Hooks

| Hook | 职责 |
|------|------|
| `useGateway()` | 调用 start / stop / refresh，维护 loading + lastAction |
| `useWorkers()` | 挂载时拉 workersList，调 setWorkers |
| `useChat()` | send(text)：构建 history，push 占位，调 chatSend，updateLastMessage |

---

### 6. Workers

Workers 是 **独立 AI Agent 定义**，与 gateway runtime 分离。

#### 结构

```
workers/
└── red-note-helper/
    ├── worker.json        # { id, name, description }
    ├── SOUL.md            # Agent 身份定义（注入 HTTP system message）
    ├── AGENTS.md          # 工作区规则、skill 使用约束（注入 system message）
    ├── TOOLS.md           # 可用工具说明
    ├── USER.md            # 用户上下文
    ├── memory/            # 每日日志 YYYY-MM-DD.md + MEMORY.md（长期记忆）
    └── skills/            # 与 workspace-template/skills/ 同步
        ├── login-manager/ # 小红书浏览器登录（Node.js .mjs）
        └── tg-search/     # Telegram 搜索集成（Node.js .mjs）
```

#### 聊天时的 Agent 上下文

每次 HTTP 调用注入 system message：

```
# Soul
（SOUL.md 内容 — 身份、能力边界、风格约束）

# Workspace
（AGENTS.md 内容 — 启动流程、skill 使用规则、内存读写）
```

AGENTS.md 明确规定：使用任何 skill 前必须先 `cat skills/<name>/SKILL.md`，所有脚本是 Node.js `.mjs`，禁止用 Python。

---

### 7. Skills

#### 注册机制

Skills 存放于 `userWorkspace/skills/`（= openclaw 的 `workspaceDir/skills/`）。

OpenClaw Gateway 在启动时自动扫描该目录，SKILL.md 存在的子目录即视为注册：

```
workspace-desktop/skills/
├── login-manager/    → openclaw-workspace 来源，eligible=true
└── tg-search/        → openclaw-workspace 来源，eligible=true
```

`openclaw skills list` 可以确认注册状态。

#### login-manager

| 项目 | 说明 |
|------|------|
| 脚本 | `login.mjs`（获取二维码）、`verify.mjs`（验证登录）、`check_login.mjs`（状态检测）|
| 浏览器服务 | `browser-service.mjs`（长驻，port 8888，懒启动）|
| 登录数据 | `browser-data/`（持久化 Cookies，跨会话复用）|
| 运行方式 | `node skills/login-manager/login.mjs` |

#### tg-search

| 项目 | 说明 |
|------|------|
| 脚本 | `search.mjs`（搜索）、`filter.mjs`（筛选）|
| 依赖 | login-manager（浏览器服务）、Playwright + Chromium |
| 触发 | Telegram Bot 消息以"搜索"开头时 |

#### 依赖安装

Bootstrap 时用内嵌 Node 执行 `npm install --prefer-offline`（安装 `playwright` npm 包）。  
Chromium 本体（~300MB）由 Agent 在首次使用时执行 `npx playwright install` 下载。

---

### 8. 数据路径（运行时）

```
~/Library/Application Support/openclaw-electron-phase2/
└── runtime/
    ├── state/
    │   └── runtime-version.json          # 版本锁
    ├── logs/
    └── openclaw-home/
        └── .openclaw/
            ├── openclaw.json             # 配置（API Key、gateway、model）
            ├── workspace-desktop/        # ← userWorkspace（主工作区）
            │   ├── SOUL.md / AGENTS.md
            │   ├── package.json + node_modules/
            │   ├── skills/
            │   │   ├── login-manager/browser-data/   # 浏览器登录态（持久化）
            │   │   └── tg-search/
            │   ├── memory/
            │   │   ├── YYYY-MM-DD.md
            │   │   └── MEMORY.md
            │   └── state/
            ├── agents/main/sessions/     # Gateway session 缓存
            │   ├── sessions.json         # session 索引
            │   └── *.jsonl               # session transcript
            └── skills/                   # managedSkillsDir（openclaw 管理的 skill）
```

**配置文件关键字段：**

```json
{
  "gateway": {
    "mode": "local",
    "auth": { "mode": "none" },
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "models": {
    "providers": {
      "openrouter": { "baseUrl": "...", "apiKey": "sk-or-v1-...", "models": [] }
    }
  },
  "agents": { "defaults": { "model": "openrouter/auto" } }
}
```

---

### 9. 开发 & 构建

#### 开发

```bash
# 准备 runtime（首次）
./scripts/prepare-embedded-runtime.sh \
  --node-version v24.13.1 \
  --openclaw-version latest \
  --workspace /path/to/source-workspace

# 启动开发模式
cd app/electron
npm install
npm run dev
# 同时启动：tsc -w（主进程）/ vite dev（渲染层）/ electron .
```

开发时渲染层加载 `http://localhost:5173`，DevTools 自动打开。

#### 构建

```bash
npm run build          # 编译主进程 + 打包渲染层
npm run dist:mac       # 输出 DMG
npm run dist:mac:zip   # 输出 ZIP
```

#### 实用脚本

```bash
# 清除 gateway session（上下文混乱时使用）
./scripts/clear-sessions.sh
# 列出并二次确认，清空 sessions.json + 删除 *.jsonl
# 执行后在 app 内 Stop → Start gateway
```

---

### 10. 环境变量（子进程）

所有 `runOpenClaw()` / `startGateway()` 调用统一注入：

```bash
OPENCLAW_HOME          = userData/runtime/openclaw-home
OPENCLAW_PROFILE       = desktop
OPENCLAW_LAUNCHD_LABEL = ai.openclaw.gateway.desktop
PATH                   = ${embeddedNodeDir}:${系统原有 PATH}
```

子进程完全隔离于系统 openclaw（`~/.openclaw/`），互不干扰。

---

### 11. 错误处理 & 降级

| 场景 | 行为 |
|------|------|
| Gateway 未启动 | chat 直接返回"请先点击 Start" |
| HTTP chatCompletions 失败 | 降级到 CLI spawn（带 session-id）|
| CLI spawn 无 JSON 输出 | 返回"(无回复内容)" |
| npm install 失败 | 忽略错误，不阻塞启动 |
| Bootstrap 关键文件缺失 | 抛出错误，app 控制台打印，窗口仍打开 |
| Gateway session 上下文混乱 | 运行 `clear-sessions.sh` 重置 |
