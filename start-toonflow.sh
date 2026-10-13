#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Toonflow 启动脚本（源码部署，无需 Docker）
#
# 用法：
#   ./start-toonflow.sh            前台运行，Ctrl+C 停止
#   ./start-toonflow.sh --bg       后台运行，日志 logs/toonflow.log
#   ./start-toonflow.sh --force-build   强制重新构建
#
# 首次运行自动：装 Bun（若缺失）→ bun install → 构建 → 起服务
# 之后运行只检查 + 起服务，不重复构建。
#
# ⚠️ 端口固定 3000：上游把端口硬编码为 const realPort = 3000（apps/server/src/index.ts），
#    TOONFLOW_PORT 环境变量对它无效。要换端口需改那一行。
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

DATA_DIR="$APP_DIR/data"
BUILD_DIR="$APP_DIR/build"
LOG_DIR="$APP_DIR/logs"
BUN_VERSION="1.3.14"
DAEMON=0
FORCE_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bg|--background) DAEMON=1; shift ;;
    --force-build)     FORCE_BUILD=1; shift ;;
    -h|--help)         sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;36m[toonflow]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[toonflow] 错误：%s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Bun（上游锁定 1.3.14）--------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  log "未检测到 Bun，正在安装 bun-v${BUN_VERSION} …"
  export BUN_INSTALL="$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" >/dev/null
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || die "Bun 安装失败，请手动安装：https://bun.sh"
log "Bun $(bun --version)"

# --- 2. ffmpeg（可选，仅视频合成需要）-----------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  log "提示：未检测到 ffmpeg，视频合成/音频处理功能将不可用（出图不受影响）"
  log "      Ubuntu/Debian：sudo apt-get install -y ffmpeg   macOS：brew install ffmpeg"
fi

# --- 3. 依赖 --------------------------------------------------------------
if [[ ! -d "node_modules/.bun" ]]; then
  log "安装依赖（bun install --frozen-lockfile），约 1–3 分钟 …"
  bun install --frozen-lockfile
fi

# --- 4. 构建 --------------------------------------------------------------
# buildStandalone.ts 会清空并重建 nodes/tools/ext + web + server，无法增量，
# 因此只在缺产物或显式要求时才跑，3–8 分钟是正常的。
NEED_BUILD=$FORCE_BUILD
if [[ ! -f "$BUILD_DIR/server/index.js" ]]; then NEED_BUILD=1; fi
if [[ ! -d "$BUILD_DIR/web" ]]; then NEED_BUILD=1; fi
if [[ ! -d "$BUILD_DIR/nodes" || ! -d "$BUILD_DIR/tools" || ! -d "$BUILD_DIR/ext" ]]; then NEED_BUILD=1; fi

if [[ "$NEED_BUILD" == "1" ]]; then
  log "开始构建（首次 3–8 分钟，请勿中断）…"
  log "  依次构建：nodes/tools/ext → web → server"
  bun apps/server/scripts/buildStandalone.ts
  [[ -f "$BUILD_DIR/server/index.js" ]] || die "构建失败：未生成 build/server/index.js，请看上方日志"
  log "构建完成"
else
  log "已存在构建产物，跳过构建（重新构建用 --force-build）"
fi

# --- 5. 数据目录 ----------------------------------------------------------
mkdir -p "$DATA_DIR/workspaces/myProject"
log "数据目录：$DATA_DIR（项目和配置都存在这里，别删）"

export NODE_ENV=production
export TOONFLOW_DATA_DIR="$DATA_DIR"
URL="http://127.0.0.1:3000"

if [[ "$DAEMON" == "1" ]]; then
  mkdir -p "$LOG_DIR"
  if curl -s -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
    die "3000 端口已有 Toonflow 在跑。先执行 ./stop-toonflow.sh"
  fi
  LOG_FILE="$LOG_DIR/toonflow.log"
  # 用 exec 让 bun 直接成为该进程（否则 $! 是外层 bash 的 PID，退出后 stop 找不到它）
  setsid nohup bash -c "exec bun '$BUILD_DIR/server/index.js'" >"$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$LOG_DIR/toonflow.pid"
  log "后台已启动，PID $(cat "$LOG_DIR/toonflow.pid")，日志 $LOG_FILE"
  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "$URL" 2>/dev/null && break
    sleep 1
  done
  curl -s -o /dev/null --max-time 2 "$URL" || die "服务没起来，看日志：tail -50 $LOG_FILE"
else
  log "启动服务（Ctrl+C 停止）…"
  log "构建产物在 $BUILD_DIR，数据在 $DATA_DIR"
  exec bun "$BUILD_DIR/server/index.js"
fi

log "──────────────────────────────────────────────"
log "浏览器打开：$URL"
log "首次进入请到「设置 → 媒体模型」配置模型供应商（ComfyUI 已内置）"
log "停止：./stop-toonflow.sh    日志：tail -f $LOG_DIR/toonflow.log"
log "──────────────────────────────────────────────"
