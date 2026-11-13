#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# lzc/build.sh — 组装 LPTV content 供 lzc-cli project build 打包成 .lpk
#
# content 来源：git 历史 8ba5558^:lzc/content/（LPTV 专用，含支持 rlptv 的 rim、
#   launch_lptv.sh、run.sh 接受 rlptv、web/icons），不依赖外部仓库 —— 本地与
#   GitHub Actions 行为一致，可复现。
# AppImage：electron/dist 最新 LPTV-*.AppImage → content/appimage/LPTV.AppImage
#   （固定名，rim rlptv 安装器按 LPTV.AppImage 读取安装）。
#
# 用法（lzc-build.yml 的 buildscript，由 lzc-cli project build 执行）：
#   cd lzc && lzc-cli project build -f lzc-build.yml
# 仅准备 content（不打包）：bash lzc/build.sh
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # lzc/
LPTV_ROOT="$(cd "$HERE/.." && pwd)"                       # lptv/
CONTENT="$HERE/content"                                   # 目标 content（lzc/content/）
CONTENT_GIT="8ba5558^"                                    # LPTV 专用 content 的 git 提交
APPIMAGE_DIR="$LPTV_ROOT/electron/dist"                   # AppImage 源

echo "==> [1/3] 从 git $CONTENT_GIT 提取完整 LPTV content → $CONTENT"
rm -rf "$CONTENT"
mkdir -p "$CONTENT"
# git archive 输出路径带 lzc/content/ 前缀，strip 两层落到 CONTENT 根
git -C "$LPTV_ROOT" archive "$CONTENT_GIT" lzc/content/ | tar -x -C "$CONTENT" --strip-components=2
rm -f "$CONTENT/assemble_lpk.sh"          # 旧打包脚本不再需要
chmod +x "$CONTENT/run.sh" "$CONTENT/launch_lptv.sh" \
         "$CONTENT/launch_chrome.sh" "$CONTENT/launch_wechat.sh" \
         "$CONTENT/launch_wps.sh" "$CONTENT/start_default_app.sh" \
         "$CONTENT/dummyscreen.sh" "$CONTENT/diag_lptv.sh" \
         "$CONTENT/rim" "$CONTENT/cde-supervisor" "$CONTENT/drop" 2>/dev/null || true

echo "==> [2/3] 放入最新 LPTV.AppImage（固定名 LPTV.AppImage，rim rlptv 安装器期望）"
mkdir -p "$CONTENT/appimage"
rm -f "$CONTENT"/appimage/*.AppImage
APP="$(ls -t "$APPIMAGE_DIR"/LPTV-*.AppImage 2>/dev/null | head -1 || true)"
if [ -z "$APP" ]; then
  echo "错误: 未在 $APPIMAGE_DIR 找到 LPTV-*.AppImage，请先跑 bash build/build_electron.sh" >&2
  exit 1
fi
cp "$APP" "$CONTENT/appimage/LPTV.AppImage"
chmod +x "$CONTENT/appimage/LPTV.AppImage"
echo "    使用: $APP"

echo "==> [3/3] content 就绪：$CONTENT"
ls -la "$CONTENT" | head -20
echo "    appimage/: $(ls "$CONTENT"/appimage/)"
