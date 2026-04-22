# 架构设计（Phase 2）

## 目标

安装后开箱即用：内置 Node + OpenClaw + 小红书助手 workspace。

## 进程分层

- **Electron Main**
  - 管理 OpenClaw 进程生命周期
  - 做 Bootstrap 与健康检查
  - 提供 IPC 给前端
- **Electron Renderer**
  - 聊天 UI、状态面板、日志面板
- **Embedded Runtime**
  - `node` + `openclaw` + `workspace-template`

## 路径分层

### 只读（随应用版本）

`process.resourcesPath/runtime/`

- `node/`
- `openclaw/`
- `workspace-template/`

### 可写（用户数据）

`app.getPath('userData')/runtime/`

- `workspace/`
- `logs/`
- `state/runtime-version.json`
- `workspace/skills/login-manager/browser-data/`
- `workspace/memory/`

## 升级策略

1. 对比 `appRuntimeVersion`
2. 版本变化时执行迁移脚本
3. 保护登录态与 memory 数据
