# Runtime 准备指南（Node + OpenClaw + Workspace）

这个文档用于准备 `runtime/` 目录，供 Electron 打包时通过 `extraResources` 一起带入安装包。

## 目标结构

```text
runtime/
  node/
    bin/node
  openclaw/
    bin/openclaw.js
    ...
  workspace-template/
    skills/
    SOUL.md
    AGENTS.md
    ...
```

## 一键准备（推荐）

```bash
cd /Users/likai.lear/Desktop/openclaw-electron-phase2
./scripts/prepare-embedded-runtime.sh \
  --node-version v24.13.1 \
  --openclaw-version latest \
  --workspace /Users/likai.lear/.openclaw/workspace-red-note-helper
```

## 参数说明

- `--node-version`：Node 版本（如 `v24.13.1`）
- `--openclaw-version`：npm 版本号或 `latest`
- `--workspace`：你的工作区目录，会同步为 `workspace-template`

## 兼容方式（手工填充）

如果你已有离线产物，也可以用旧脚本：

```bash
./scripts/fill-runtime.sh --node <node-dir> --openclaw <openclaw-dir> --workspace <workspace-dir>
```

## 注意事项

- `workspace-template` 不应包含用户私有登录态
- `skills/login-manager/browser-data/` 已在脚本中排除
- 建议在 CI 中固定 Node/OpenClaw 版本，确保可复现
