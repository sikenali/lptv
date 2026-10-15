#!/bin/sh
set -e

# LPTV lzmail-style build: content-only LPK (no docker image).
# backend/server.py (Python, zero dep) -> _lpk_content/backend/server.py
# content/ (static player SPA)          -> _lpk_content/frontend

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LPK_TAG="${LPK_VERSION:-}"
LPK_TAG="${LPK_TAG#v}"
VERSION="${LPK_TAG:-$(cd "$PROJECT_ROOT" && git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)}"
VERSION="${VERSION:-1.0.1}"
echo "Building version: $VERSION"

# 动态写入 package.yml（版本号跟随 tag）
cat > "$SCRIPT_DIR/package.yml" <<PKGEOF
package: cloud.lazycat.app.lptv
version: ${VERSION}
name: LPTV
description: LPTV，Web端的频道直播工具
author: sikenali
license: MIT
homepage: https://github.com/sikenali/lptv
min_os_version: 1.5.0
unsupported_platforms:
  - ios
locales:
  zh-CN:
    name: 懒猫微视
    description: 懒猫微视，IPTV 直播频道聚合播放，789IPTV 直连解析播放
  en:
    name: LPTV
    description: IPTV live channel player with stream resolving and direct playback
permissions:
  required:
    - net.internet
PKGEOF

# 准备 content 目录（后端 + 前端静态文件）
echo "[build] Preparing _lpk_content..."
rm -rf "$SCRIPT_DIR/_lpk_content"
mkdir -p "$SCRIPT_DIR/_lpk_content/backend"
mkdir -p "$SCRIPT_DIR/_lpk_content/frontend"

# 复制 Python 后端
cp "$PROJECT_ROOT/backend/server.py" "$SCRIPT_DIR/_lpk_content/backend/server.py"
chmod +x "$SCRIPT_DIR/_lpk_content/backend/server.py"
if [ ! -f "$SCRIPT_DIR/_lpk_content/backend/server.py" ]; then
  echo "[build] ERROR: backend/server.py not found"
  exit 1
fi

# 复制前端（静态 SPA 文件）
cp -a "$PROJECT_ROOT/content/." "$SCRIPT_DIR/_lpk_content/frontend/"
if [ ! -f "$SCRIPT_DIR/_lpk_content/frontend/index.html" ]; then
  echo "[build] ERROR: frontend index.html missing"
  exit 1
fi
# 复制频道列表（后端启动时通过 --channels 指定，必须存在于 frontend/）
cp "$PROJECT_ROOT/channels.json" "$SCRIPT_DIR/_lpk_content/frontend/channels.json"
# 写入版本文件，供前端"关于"读取
echo "{\"version\":\"${VERSION}\"}" > "$SCRIPT_DIR/_lpk_content/frontend/version.json"

# 启动脚本（平台执行 content 包时拉起后端）
mkdir -p "$SCRIPT_DIR/_lpk_content/scripts"
cat > "$SCRIPT_DIR/_lpk_content/scripts/start.sh" << 'STARTSCRIPT'
#!/bin/sh
set -e

mkdir -p "${DATA_DIR:-/lzcapp/var/data}" /app/logs 2>/dev/null || true

# Alpine base image: install python3 if missing
if ! command -v python3 >/dev/null 2>&1; then
  echo "installing python3..." >> /app/logs/backend.log
  apk add --no-cache python3 >> /app/logs/backend.log 2>&1
fi

PORT="${BACKEND_PORT:-8080}"
DATA_DIR="${DATA_DIR:-/lzcapp/var/data}" python3 \
  /lzcapp/pkg/content/backend/server.py \
  --port "$PORT" \
  --content /lzcapp/pkg/content/frontend \
  --channels /lzcapp/pkg/content/frontend/channels.json \
  >>/app/logs/backend.log 2>&1 &
BACKEND_PID=$!

for i in $(seq 1 30); do
  sleep 2
  if wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "backend healthy after ${i}x2s"
    break
  fi
  if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "backend exited, logs:"
    cat /app/logs/backend.log
    exit 1
  fi
done

while kill -0 $BACKEND_PID 2>/dev/null; do
  sleep 2
done

echo "container stopped: backend=$BACKEND_PID"
cat /app/logs/backend.log
exit 0
STARTSCRIPT
chmod +x "$SCRIPT_DIR/_lpk_content/scripts/start.sh"

echo "[build] Build complete: backend + frontend + scripts"
