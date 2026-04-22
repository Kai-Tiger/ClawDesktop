# 首次启动 Bootstrap 流程

## 触发条件

- `userData/runtime/state/runtime-version.json` 不存在
- 或其版本与当前应用内置 runtime 版本不一致

## 流程

1. 创建目录结构（workspace/logs/state）
2. 从 `resources/runtime/workspace-template` 复制到 `userData/runtime/workspace`（仅初始化）
3. 执行迁移（如有）
4. 校验 Playwright 浏览器依赖（存在则跳过，不存在则安装）
5. 执行 `openclaw gateway status`，必要时 `gateway start`
6. 写入版本锁与初始化时间

## 失败处理

- 在 UI 展示可读错误
- 提供“重试初始化”按钮
- 记录日志到 `userData/runtime/logs/bootstrap.log`
