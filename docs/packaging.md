# 打包说明

## electron-builder 关键点

- 使用 `extraResources` 打入 `runtime/`
- `asar: true`（应用代码）
- runtime 大文件与二进制在 asar 外

## 资源布局（安装后）

```text
MyApp.app/
  Contents/
    Resources/
      app.asar
      runtime/
        node/
        openclaw/
        workspace-template/
```

## 构建建议

- 先做 macOS arm64 单平台发布
- 后续再做 x64 / Windows / Linux 分发
