#!/usr/bin/env bash
set -euo pipefail

# 下载并准备“内置运行时”：Node + OpenClaw + workspace-template
# 不依赖你机器上已安装的 OpenClaw。
#
# 用法：
#   ./scripts/prepare-embedded-runtime.sh \
#     --node-version v24.13.1 \
#     --openclaw-version latest \
#     --workspace /Users/likai.lear/.openclaw/workspace-red-note-helper

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime"
CACHE_DIR="$ROOT_DIR/.cache"

NODE_VERSION="v24.13.1"
OPENCLAW_VERSION="latest"
WORKSPACE_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-version)
      NODE_VERSION="$2"; shift 2 ;;
    --openclaw-version)
      OPENCLAW_VERSION="$2"; shift 2 ;;
    --workspace)
      WORKSPACE_SRC="$2"; shift 2 ;;
    *)
      echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$WORKSPACE_SRC" ]]; then
  echo "缺少 --workspace 参数"
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "当前脚本先支持 macOS（Darwin）"
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) echo "不支持架构: $ARCH"; exit 1 ;;
esac

mkdir -p "$RUNTIME_DIR" "$CACHE_DIR"
rm -rf "$RUNTIME_DIR/node" "$RUNTIME_DIR/openclaw" "$RUNTIME_DIR/workspace-template"

NODE_TAR="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"
NODE_CACHE_PATH="$CACHE_DIR/$NODE_TAR"

echo "[1/4] 下载 Node: $NODE_URL"
curl -fL "$NODE_URL" -o "$NODE_CACHE_PATH"

echo "[2/4] 解压 Node -> runtime/node"
mkdir -p "$RUNTIME_DIR/node"
tar -xzf "$NODE_CACHE_PATH" -C "$CACHE_DIR"
cp -R "$CACHE_DIR/node-${NODE_VERSION}-darwin-${NODE_ARCH}/"* "$RUNTIME_DIR/node/"
rm -rf "$CACHE_DIR/node-${NODE_VERSION}-darwin-${NODE_ARCH}"

if [[ ! -x "$RUNTIME_DIR/node/bin/node" ]]; then
  echo "ERROR: 内置 Node 准备失败（runtime/node/bin/node 不存在）"
  exit 1
fi

NODE_BIN="$RUNTIME_DIR/node/bin/node"
NPM_CLI_JS="$RUNTIME_DIR/node/lib/node_modules/npm/bin/npm-cli.js"

echo "[3/4] 用内置 Node 安装 OpenClaw -> runtime/openclaw"
TMP_NPM_PREFIX="$CACHE_DIR/npm-prefix"
rm -rf "$TMP_NPM_PREFIX"
mkdir -p "$TMP_NPM_PREFIX"

"$NODE_BIN" "$NPM_CLI_JS" install --prefix "$TMP_NPM_PREFIX" "openclaw@${OPENCLAW_VERSION}" --omit=dev

if [[ ! -d "$TMP_NPM_PREFIX/node_modules/openclaw" ]]; then
  echo "ERROR: OpenClaw 安装失败"
  exit 1
fi

cp -R "$TMP_NPM_PREFIX/node_modules/openclaw" "$RUNTIME_DIR/openclaw"

# 兼容新旧 OpenClaw 包结构：
# - 旧版可能是 bin/openclaw.js
# - 新版为 package.json#bin -> openclaw.mjs
if [[ -f "$RUNTIME_DIR/openclaw/openclaw.mjs" ]]; then
  :
elif [[ -f "$RUNTIME_DIR/openclaw/bin/openclaw.js" ]]; then
  :
else
  echo "ERROR: 未找到 OpenClaw CLI 入口（openclaw.mjs 或 bin/openclaw.js）"
  exit 1
fi

echo "[4/4] 同步 workspace 模板 -> runtime/workspace-template"
mkdir -p "$RUNTIME_DIR/workspace-template"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.openclaw/' \
  --exclude '.DS_Store' \
  --exclude 'skills/login-manager/browser-data/' \
  "$WORKSPACE_SRC/" "$RUNTIME_DIR/workspace-template/"

echo "完成 ✅"
echo "- Embedded Node:     $RUNTIME_DIR/node"
echo "- Embedded OpenClaw: $RUNTIME_DIR/openclaw"
echo "- Workspace tpl:     $RUNTIME_DIR/workspace-template"
