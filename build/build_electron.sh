#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build_electron.sh — 用 electron-builder 把 LPTV 打成单 AppImage（替代旧
# pywebview 两包方案 build_appimage.sh）。
#
# 产物：dist/LPTV.AppImage（Electron 官方构建自带 H.264 编解码器，央视频直接能播）
# 然后拷贝到 lzc/content/appimage/LPTV.AppImage 供 launch_lptv.sh 使用。
#
# 前置（x86_64 Debian/Ubuntu 为例）：
#   sudo apt install -y nodejs npm libgtk-3-0 libnss3 libasound2 libatk1.0-0 \
#        libcups2 libxss1 libdrm2 libgbm1 libxkbcommon0
#
# 用法：
#   bash build/build_electron.sh          # 安装依赖 + 打包
#   SKIP_INSTALL=1 bash build/build_electron.sh   # 已 npm install 过，只打包
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LPTV_ROOT="$(cd "$HERE/.." && pwd)"
ELECTRON_DIR="$LPTV_ROOT/electron"
OUT_DIR="$ELECTRON_DIR/dist"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js ≥18：" >&2
  echo "  sudo apt install -y nodejs npm" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未找到 npm。" >&2
  exit 1
fi

echo "==> [1/3] 安装 Electron 依赖（首次拉取 electron 二进制 ~90MB，之后走缓存）"
cd "$ELECTRON_DIR"
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  if [ -d node_modules ]; then
    echo "    复用已有 node_modules（重新解析用：rm -rf electron/node_modules）"
    npm install --silent
  else
    npm install
  fi
fi

echo "==> [2/3] electron-builder 打 AppImage"
npm run dist

echo "==> [3/3] 拷贝到 lzc/content/appimage/LPTV.AppImage"
mkdir -p "$LPTV_ROOT/lzc/content/appimage"
cp "$OUT_DIR/LPTV.AppImage" "$LPTV_ROOT/lzc/content/appimage/LPTV.AppImage"
chmod +x "$LPTV_ROOT/lzc/content/appimage/LPTV.AppImage"

ls -lh "$OUT_DIR/LPTV.AppImage" "$LPTV_ROOT/lzc/content/appimage/LPTV.AppImage"
echo "完成：$LPTV_ROOT/lzc/content/appimage/LPTV.AppImage"
echo "下一步：bash lzc/content/assemble_lpk.sh（重打 LPK）"
