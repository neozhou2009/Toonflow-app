#!/usr/bin/env bash
# Toonflow 停止脚本
# 顺序：PID 文件 → 端口（linux: fuser/ss/lsof，macOS: lsof）→ node_modules/.bin 兜底
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$APP_DIR/logs/toonflow.pid"
STOPPED=0

kill_pid() {
  local pid="$1"
  [[ -z "$pid" || "$pid" == "0" ]] && return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "正在停止 PID $pid …"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null || true
  STOPPED=1
}

# 1) PID 文件
if [[ -f "$PID_FILE" ]]; then
  kill_pid "$(cat "$PID_FILE" 2>/dev/null)"
  rm -f "$PID_FILE"
fi

# 2) 端口（PID 文件失效时的主要兜底）
if command -v fuser >/dev/null 2>&1; then
  if fuser 3000/tcp >/dev/null 2>&1; then
    fuser -k 3000/tcp >/dev/null 2>&1 || true
    echo "已通过端口清理 3000"
    STOPPED=1
    sleep 1
  fi
elif command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti tcp:3000 2>/dev/null || true)"
  for p in $PIDS; do kill_pid "$p"; done
fi

[[ "$STOPPED" == "1" ]] && echo "Toonflow 已停止" || echo "没有发现正在运行的 Toonflow"
