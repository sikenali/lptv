#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# run.sh — 源码一键运行 LPTV（Electron 版，不需要先打 AppImage）
#
# 用法：
#   bash run.sh                       # 首次会自动 npm install，然后启动
#   SKIP_INSTALL=1 bash run.sh        # 已装过依赖，直接启动
#
# 前置（x86_64 Debian/Ubuntu 为例）：
#   sudo apt install -y nodejs npm libgtk-3-0 libnss3 libasound2 libatk1.0-0 \
#        libcups2 libxss1 libdrm2 libgbm1 libxkbcommon0
#
# 注意：央视频是 H.264-over-MSE，Electron 官方构建自带 H.264 编解码器可直接播；
# 不再需要真 Chrome/CDP 后端。root 下需 --no-sandbox（electron . 已带）。
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/electron"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js ≥18：" >&2
  echo "  sudo apt install -y nodejs npm" >&2
  exit 1
fi

if [ "${SKIP_INSTALL:-0}" != "1" ] && [ ! -d node_modules ]; then
  echo "==> 首次运行：npm install（拉取 Electron 二进制，约 90MB）"
  npm install
fi

echo "==> 启动 LPTV (Electron) ..."
exec npx electron . --no-sandbox "$@"
