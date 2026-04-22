#!/usr/bin/env bash
set -euo pipefail

# 把 Phase 2 所需 runtime 填充到 ./runtime
# 用法：
#   ./scripts/fill-runtime.sh \
#     --node /path/to/node-vXX-darwin-arm64 \
#     --openclaw /path/to/openclaw-install-root \
#     --workspace /Users/likai.lear/.openclaw/workspace-red-note-helper

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime"

NODE_SRC=""
OPENCLAW_SRC=""
WORKSPACE_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)
      NODE_SRC="$2"
      shift 2
      ;;
    --openclaw)
      OPENCLAW_SRC="$2"
      shift 2
      ;;
    --workspace)
      WORKSPACE_SRC="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$NODE_SRC" || -z "$OPENCLAW_SRC" || -z "$WORKSPACE_SRC" ]]; then
  echo "缺少参数。"
  echo "示例:"
  echo "  ./scripts/fill-runtime.sh --node /path/to/node-dist --openclaw /path/to/openclaw-root --workspace /Users/likai.lear/.openclaw/workspace-red-note-helper"
  exit 1
fi

mkdir -p "$RUNTIME_DIR"
rm -rf "$RUNTIME_DIR/node" "$RUNTIME_DIR/openclaw" "$RUNTIME_DIR/workspace-template"

echo "[1/3] 复制内置 Node -> runtime/node"
cp -R "$NODE_SRC" "$RUNTIME_DIR/node"

if [[ ! -x "$RUNTIME_DIR/node/bin/node" ]]; then
  echo "ERROR: runtime/node/bin/node 不存在或不可执行"
  exit 1
fi

# 允许 OPENCLAW_SRC 直接传 package 根目录，或包含 openclaw 子目录的父目录
if [[ -f "$OPENCLAW_SRC/bin/openclaw.js" ]]; then
  OPENCLAW_REAL="$OPENCLAW_SRC"
elif [[ -f "$OPENCLAW_SRC/openclaw/bin/openclaw.js" ]]; then
  OPENCLAW_REAL="$OPENCLAW_SRC/openclaw"
else
  echo "ERROR: 找不到 OpenClaw CLI 入口（bin/openclaw.js）"
  exit 1
fi

echo "[2/3] 复制 OpenClaw 运行时 -> runtime/openclaw"
cp -R "$OPENCLAW_REAL" "$RUNTIME_DIR/openclaw"

echo "[3/3] 同步 workspace 模板 -> runtime/workspace-template"
mkdir -p "$RUNTIME_DIR/workspace-template"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.openclaw/' \
  --exclude '.DS_Store' \
  --exclude 'skills/login-manager/browser-data/' \
  --exclude 'memory/*.log' \
  "$WORKSPACE_SRC/" "$RUNTIME_DIR/workspace-template/"

echo "完成 ✅"
echo "- Node:      $RUNTIME_DIR/node"
echo "- OpenClaw:  $RUNTIME_DIR/openclaw"
echo "- Workspace: $RUNTIME_DIR/workspace-template"