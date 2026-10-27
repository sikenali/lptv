#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build_chrome_appimage.sh — 把 google-chrome-stable .deb 打成 AppImage
#
# 用途：LPTV 的 chromium 后端要驱动真 Chrome 才能解码央视频的 H.264（QtWebEngine
# 没有 H.264 解码器，见 build/build_appimage.sh）。rim 只认
# appimage/Google-Chrome-stable-155.0.8059.39-1-x86_64.AppImage 这个硬编码文件名，
# 所以产物同时保留真版本号与 155 兼容名（硬链接，tar 只存一份）。
#
# 用法：
#   bash build/build_chrome_appimage.sh [chrome.deb]
# 产物：build/_chrome/Google-Chrome-stable-<ver>-1-x86_64.AppImage
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LPTV_ROOT="$(cd "$HERE/.." && pwd)"
WORK="$LPTV_ROOT/build/_chrome"
DEB="${1:-$WORK/google-chrome-stable_current_amd64.deb}"
APPDIR="$WORK/AppDir"
TOOL="$LPTV_ROOT/build/_appimage_work/appimagetool-x86_64.AppImage"

[ -f "$DEB" ] || { echo "缺少 $DEB" >&2; exit 1; }
[ -x "$TOOL" ] || { echo "缺少 appimagetool: $TOOL" >&2; exit 1; }

echo "==> [1/5] 解包 deb"
rm -rf "$WORK/root" "$APPDIR"
mkdir -p "$WORK/root"
dpkg-deb -x "$DEB" "$WORK/root"
CHROME_DIR="$WORK/root/opt/google/chrome"
[ -x "$CHROME_DIR/chrome" ] || { echo "解包结果里没有 chrome 二进制" >&2; exit 1; }
VER="$("$CHROME_DIR/chrome" --version 2>/dev/null | awk '{print $3}')"
VER="${VER:-unknown}"
echo "    Google Chrome $VER"

echo "==> [2/5] 精简（容器内用不到的组件）"
rm -rf "$CHROME_DIR/chrome-management-service" "$CHROME_DIR/chrome-sandbox" \
       "$CHROME_DIR/cron" "$CHROME_DIR/apparmor.d" \
       "$CHROME_DIR/.pinned" 2>/dev/null || true
du -sh "$CHROME_DIR"

echo "==> [3/5] 组织 AppDir"
mkdir -p "$APPDIR/opt/google"
cp -a "$CHROME_DIR" "$APPDIR/opt/google/chrome"

ICON_SRC=""
for c in "$CHROME_DIR/product_logo_256.png" \
         "$WORK/root/usr/share/icons/hicolor/256x256/apps/google-chrome.png" \
         "$WORK/root/usr/share/pixmaps/google-chrome.png"; do
  [ -f "$c" ] && { ICON_SRC="$c"; break; }
done
if [ -n "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APPDIR/chrome.png"
  ln -sf chrome.png "$APPDIR/.DirIcon"
else
  echo "    警告：找不到图标，AppImage 将无 .DirIcon（不影响运行）" >&2
fi

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
DIR="$(dirname "$SELF")"
export CHROME_DEVEL_SANDBOX="${CHROME_DEVEL_SANDBOX:-}"
exec "$DIR/opt/google/chrome/chrome" "$@"
EOF
chmod +x "$APPDIR/AppRun"

cat > "$APPDIR/chrome.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Google Chrome
Exec=AppRun
Icon=chrome
Terminal=false
Categories=Network;WebBrowser;
EOF
echo "    AppDir ready"

echo "==> [4/5] 生成 AppImage"
OUT="$WORK/Google-Chrome-stable-$VER-1-x86_64.AppImage"
rm -f "$OUT"
# appimagetool 强依赖 `file`；无 root 时用已解包的 Debian 包（build_appimage.sh 同款）
if ! command -v file >/dev/null 2>&1; then
  T="$LPTV_ROOT/build/_appimage_work/tools"
  if [ -x "$T/root/usr/bin/file" ]; then
    export PATH="$T/root/usr/bin:$PATH"
    export LD_LIBRARY_PATH="$T/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  else
    echo "错误：file 不可用，且 build/_appimage_work/tools 未解包（先跑 build_appimage.sh）" >&2
    exit 1
  fi
fi
( cd "$WORK" && "$TOOL" --appimage-extract-and-run "$APPDIR" "$(basename "$OUT")" )

echo "==> [5/5] 兼容名（rim 硬编码 155 文件名）"
COMPAT="$WORK/Google-Chrome-stable-155.0.8059.39-1-x86_64.AppImage"
rm -f "$COMPAT"
ln -f "$OUT" "$COMPAT"

ls -lh "$WORK"/*.AppImage
echo "完成"
