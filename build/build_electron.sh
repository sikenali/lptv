#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build_electron.sh — 用 electron-builder 把 LPTV 打成单 AppImage（替代旧
# pywebview 两包方案 build_appimage.sh）。
#
# 产物：dist/LPTV-<os>-<arch>-<version>.AppImage（Electron 官方构建自带 H.264
# 编解码器，央视频直接能播）。assemble_lpk.sh 直接从 electron/dist 取此文件打包。
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

echo "==> [3/3] 校验 electron/dist 版本化 AppImage"
# electron-builder 的 artifactName = LPTV-${os}-${arch}-${version}.${ext}
# （package.json build.artifactName），产物形如 LPTV-linux-x64-1.0.0.AppImage。
# 唯一产物来源就是 electron/dist/（assemble_lpk.sh 直接从中取包），
# 不再维护 lzc/content/appimage/LPTV.AppImage 副本，避免两份产物漂移。
VER_APPIMAGE=$(ls "$OUT_DIR"/LPTV-*.AppImage 2>/dev/null | head -1 || true)
if [ -z "$VER_APPIMAGE" ]; then
  echo "错误：未在 $OUT_DIR 找到 LPTV-*.AppImage。请检查 electron-builder 输出。" >&2
  exit 1
fi
APPVER="$(basename "$VER_APPIMAGE")"
chmod +x "$VER_APPIMAGE"

ls -lh "$VER_APPIMAGE"
echo "完成：$OUT_DIR/$APPVER"
echo "下一步：bash lzc/content/assemble_lpk.sh（从 dist 取 $APPVER 重打 LPK）"
