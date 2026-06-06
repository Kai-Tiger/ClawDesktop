# ClawDesktop

ClawDesktop 是一个基于 [OpenClaw](https://github.com/openclaw) 的桌面客户端，内置完整的 OpenClaw 运行时，无需额外安装即可直接使用。

OpenClaw 是一个多 Agent 编排框架，ClawDesktop 在此基础上提供了可视化界面，让你能够：

- 通过 GUI **快速新建和管理 Worker**（每个 Worker 是一个独立的 AI Agent，拥有自己的记忆、技能和工具）
- 在 **Group Chat** 中同时调度多个 Worker 协作，完成复杂任务
- 与 Worker 进行流式对话，实时查看 AI 的推理过程

---

## 运行方式

### 1. 安装依赖

```bash
./install.sh
```

```bash
cd app/electron
npm install
```

### 2. 启动开发模式

```bash
npm run dev
```

首次启动后在应用内点击 **Start** 启动本地 Gateway，即可开始对话。

### 3. 打包为 macOS App（可选）

```bash
# Apple Silicon
npm run mac

# Intel
npm run mac:x64
```

---

## 配置 OpenRouter Key

1. 打开应用，点击左侧边栏底部的 **设置** 图标
2. 在 **OpenRouter API Key** 输入框中填入你的 Key（从 [openrouter.ai](https://openrouter.ai/keys) 获取）
3. 保存后即可在 Worker 设置中选择模型

也可以在任意 Worker 的设置面板中单独配置该 Worker 使用的模型。

---

## 主要功能

### 单聊（Chat）
- 与单个 Worker 一对一实时对话
- 流式 token 输出，支持 Markdown / 代码高亮渲染
- 消息右键菜单：删除、收藏
- 可上传图片，支持多模态模型

### Group Chat
- 同时 @多个 Worker 协作完成任务
- 内置协调者（Coordinator）自动规划多 Worker 执行顺序
- Thread 面板：针对任意消息发起子对话，Worker 在 Thread 内流式回复
- 支持附件上传（csv / txt / md）

### Worker 管理
- 每个 Worker 可独立配置模型、工具权限
- 支持多种工具：定时任务（cron）、浏览器、代码执行等
- Worker 可绑定 Telegram 频道，实现消息自动转发

### 模型支持（通过 OpenRouter）
| 模型 | 说明 |
|------|------|
| MiMo v2.5 Pro | 小米 |
| MiniMax M2.5 | MiniMax |
| GPT-5.3 Codex / GPT-5 Nano | OpenAI |
| Kimi K2.6 | Moonshot |
| Claude Sonnet 4.6 | Anthropic |
| Gemini 3 Flash Preview | Google |

---

## 技术栈

- **Electron** + **React 19** + **TypeScript**
- **Tailwind CSS** + **Lucide React**
- **Zustand**（状态管理）
- **Vite**（构建）
- 本地 Gateway 作为 LLM 代理层
