#!/usr/bin/env bash
# clear-sessions.sh — 清除 desktop app 的 gateway session 缓存
# 用途：session 上下文过期/混乱时重置，下次对话从干净状态开始
# 注意：不会删除 memory/ 日记文件，不会影响配置和 API Key

set -euo pipefail

OCLAW_HOME="${HOME}/Library/Application Support/openclaw-electron-phase2/runtime/openclaw-home/.openclaw"
SESSIONS_DIR="${OCLAW_HOME}/agents/main/sessions"
SESSIONS_JSON="${SESSIONS_DIR}/sessions.json"

# ── 检查目录是否存在 ──────────────────────────────────────────────────────────
if [[ ! -d "${SESSIONS_DIR}" ]]; then
  echo "Sessions 目录不存在，无需清理。"
  exit 0
fi

# ── 确认 ──────────────────────────────────────────────────────────────────────
SESSION_COUNT=0
JSONL_COUNT=0

if [[ -f "${SESSIONS_JSON}" ]]; then
  SESSION_COUNT=$(python3 -c "import json; d=json.load(open('${SESSIONS_JSON}')); print(len(d))" 2>/dev/null || echo 0)
fi
JSONL_COUNT=$(find "${SESSIONS_DIR}" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')

echo "┌──────────────────────────────────────────────────"
echo "│ Sessions 索引条目: ${SESSION_COUNT}"
echo "│ Transcript 文件数: ${JSONL_COUNT}"
echo "└──────────────────────────────────────────────────"

if [[ "${SESSION_COUNT}" -eq 0 && "${JSONL_COUNT}" -eq 0 ]]; then
  echo "已经是干净状态，无需清理。"
  exit 0
fi

read -r -p "确认清除所有 session？(y/N) " CONFIRM
if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
  echo "取消。"
  exit 0
fi

# ── 清除 sessions.json ────────────────────────────────────────────────────────
if [[ -f "${SESSIONS_JSON}" ]]; then
  # 备份原文件
  cp "${SESSIONS_JSON}" "${SESSIONS_JSON}.bak"
  echo "{}" > "${SESSIONS_JSON}"
  echo "✓ sessions.json 已清空（备份: sessions.json.bak）"
fi

# ── 删除所有 .jsonl transcript 文件 ───────────────────────────────────────────
DELETED=0
while IFS= read -r f; do
  rm -f "${f}"
  DELETED=$((DELETED + 1))
done < <(find "${SESSIONS_DIR}" -name "*.jsonl" 2>/dev/null)

echo "✓ 删除 ${DELETED} 个 transcript 文件"
echo ""
echo "完成。重启 gateway 后生效（在 app 内 Stop → Start）。"
