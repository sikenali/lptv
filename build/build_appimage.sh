#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build_appimage.sh — 把 LPTV 打成完全自包含的 LPTV-x86_64.AppImage
#
# 适用：x86_64 Linux（构建可无显示器；运行需 X11/Wayland 或 Xvfb）。
#
# 原理（自包含方案，2026 修订）：
#   - linuxdeploy-plugin-python 已停止维护（niess 仓库 releases 404），
#     linuxdeploy-plugin-qt 需要 qmake 而 PyQt6 wheel 不带 → 两者弃用。
#   - 本脚本改为手工组织 AppDir：
#       1) 内嵌 Python（CPython 二进制 + 标准库 + pip 依赖，PYTHONHOME 重定位）
#       2) PyQt6 wheel 自带完整 QtWebEngine 运行时（lib/libexec/plugins）
#       3) 用 ldd 闭包收集 Qt/Python 的非基础系统库到 usr/lib-local
#       4) AppRun 设置 LD_LIBRARY_PATH / PYTHONHOME / WebEngine 路径
#       5) appimagetool（--appimage-extract-and-run，免 fuse）生成最终 AppImage
#
 # 重要（引擎，见 README「浏览器引擎」一节）：
 #   pywebview 在 Linux 上只有 qt(QtWebEngine) / gtk(WebKit2)，两者都没有 H.264 解码器，
 #   央视频（纯 H.264-over-MSE，无 DRM）在其上必然黑屏。
 #   所以本包自研了 webview/platforms/chromium.py（CDP 驱动真 Chrome），
 #   并在下面 [3/6] 注入 + patch_guilib.py，AppRun 默认 LPTV_GUI=chromium。
 #   运行期真 Chrome 的发现/解包由 chromium.py 自己做，不依赖本脚本。
 # -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LPTV_ROOT="$(cd "$HERE/.." && pwd)"          # LPTV/ 根
APPID="lptv"
WORK="$LPTV_ROOT/build/_appimage_work"
APPDIR="$WORK/AppDir"
mkdir -p "$WORK"

PYTHON="${PYTHON:-python3}"
PYVER="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"

echo "==> [1/6] 组织 pip 依赖（--target 独立收集，不建 venv）"
SITE="$WORK/site"
rm -rf "$SITE"
"$PYTHON" -m pip install --target "$SITE" -r "$LPTV_ROOT/build/requirements.txt"

echo "==> [2/6] 布置 AppDir 骨架（内嵌 Python + QtWebEngine 运行时）"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib/python$PYVER" \
         "$APPDIR/usr/share/$APPID" \
         "$APPDIR/usr/share/icons/hicolor/256x256/apps" \
         "$APPDIR/usr/lib-local"

# (a) Python 解释器本体（cp -L 取真身，避开 symlink 导致 pyvenv 定位失败）
cp -L "$(command -v "$PYTHON")" "$APPDIR/usr/bin/python"
chmod +x "$APPDIR/usr/bin/python"

# (b) Python 标准库（剔除用不到的大件，减瘦身）
# 注意：目标目录已存在，必须用 `src/.` 形式，否则内容会嵌套进同名子目录
STDLIB_SRC="/usr/lib/python$PYVER"
mkdir -p "$APPDIR/usr/lib/python$PYVER"
cp -r "$STDLIB_SRC/." "$APPDIR/usr/lib/python$PYVER/"
rm -rf "$APPDIR/usr/lib/python$PYVER/__pycache__"
find "$APPDIR/usr/lib/python$PYVER" -maxdepth 2 -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
for prune_dir in idlelib test tkinter; do
  rm -rf "$APPDIR/usr/lib/python$PYVER/$prune_dir"
done

# (c) pip 依赖 → site-packages（含 PyQt6 自带 QtWebEngine 运行时）
mkdir -p "$APPDIR/usr/lib/python$PYVER/site-packages"
cp -r "$SITE/." "$APPDIR/usr/lib/python$PYVER/site-packages/"
QT_DIR="$APPDIR/usr/lib/python$PYVER/site-packages/PyQt6/Qt6"

# Chromium 后端：pywebview 官方在 Linux 上只有 qt(QtWebEngine) / gtk(WebKit2)，
# 两者都没有 H.264 解码器（QtWebEngine 的 MediaSource.isTypeSupported('video/mp4;...')
# 返回 false，WebKit2 所有 codec 串返回 ""），央视频是纯 H.264/MSE 直播，必然黑屏。
# 所以注入自研的 webview.platforms.chromium（走真 Chrome + DevTools Protocol），
# 并给 guilib.py 打补丁让 webview.start(gui='chromium') 可路由到它。
CRDIR="$LPTV_ROOT/libexec/pywebview_chromium"
if [ -f "$CRDIR/chromium.py" ]; then
  echo "    注入 chromium 后端 + guilib 补丁"
  cp "$CRDIR/chromium.py" "$APPDIR/usr/lib/python$PYVER/site-packages/webview/platforms/chromium.py"
  "$PYTHON" "$CRDIR/patch_guilib.py" "$APPDIR/usr/lib/python$PYVER/site-packages" || {
    echo "错误：chromium 后端注入失败" >&2; exit 1;
  }
fi

# Qt 不做裁剪：QtWebEngineCore 的间接依赖链（WebChannel 等）删不准会静默崩，
# wheel 体积换运行稳定性更划算。

# 应用本体
cp -r "$LPTV_ROOT/app"      "$APPDIR/usr/share/$APPID/app"
cp -r "$LPTV_ROOT/frontend" "$APPDIR/usr/share/$APPID/frontend"
rm -rf "$APPDIR/usr/share/$APPID/app/__pycache__"

echo "==> [3/6] ldd 闭包收集系统依赖 → usr/lib-local"
# 基础库不能也不该打包（glibc 全家桶），其余一起带走
BASE_LIBS_RE='libc\.|libm\.|ld-linux|libdl\.|libpthread\.|librt\.|libresolv\.|libnsl\.|libutil\.|libcrypt\.|libanl\.|libstdc\+\+|libgcc_s'
collect_ldd() {
  local f="$1" lib base
  [ -f "$f" ] || return 0
  # 提取 ldd 输出里所有 .so 路径（不用 while read，规避 set -e 下 EOF 返回 1）
  local libs
  libs="$(ldd "$f" 2>/dev/null | grep -oE '(/[[:alnum:]_./+-]+\.so[^ (]*)' | sort -u)" || true
  for lib in $libs; do
    base="$(basename "$lib")"
    if echo "$base" | grep -qEv "$BASE_LIBS_RE"; then
      if [ ! -e "$APPDIR/usr/lib-local/$base" ]; then
        cp -L "$lib" "$APPDIR/usr/lib-local/$base" 2>/dev/null || true
      fi
    fi
  done
  return 0
}

PYTHONMod="$APPDIR/usr/lib/python$PYVER/site-packages"
collect_ldd "$APPDIR/usr/bin/python"
# Qt 全量：库 / 进程 / 所有插件目录都收（Qt 动态加载插件，漏一个就是静默黑窗）
for f in "$QT_DIR/lib/"*.so? "$QT_DIR/libexec/"* "$QT_DIR"/plugins/*/*.so; do
  collect_ldd "$f"
done
# PyQt6 绑定 .so 入口（QtWebEngine 组件加载时引用）
find "$PYTHONMod/PyQt6" -maxdepth 1 -name '*.so' | while read -r f; do collect_ldd "$f"; done
# 递归：已收集的库自身还依赖的东西（两轮足够）
for pass in 1 2; do
  for f in "$APPDIR"/usr/lib-local/*; do collect_ldd "$f"; done
done
# 保险：把 WebEngine 资源文件必须的 icudtl 之类确认存在
ls "$QT_DIR/libexec/" >/dev/null

echo "==> [4/6] 写 AppRun / 入口 / desktop / 图标"
sed "s/PYVER_PLACEHOLDER/$PYVER/g" > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
APP_DIR="$(dirname "$SELF")"
export APPDIR="${APPDIR:-$APP_DIR}"
export APPIMAGE="${APPIMAGE:-$SELF}"

# 内嵌 Python 重定位：PYTHONHOME 指 AppDir/usr（lib/pythonX.Y 相对定位）
# 注意：Debian 编译出的 site-packages 路径在编译期写死为 /usr/...，必须显式 PYTHONPATH
export PYTHONHOME="$APP_DIR/usr"
export PYTHONPATH="$APP_DIR/usr/lib/pythonPYVER_PLACEHOLDER/site-packages"
export PYTHONNOUSERSITE=1          # 隔离宿主 ~/.local，避免依赖串味
export PATH="$APP_DIR/usr/bin:$PATH"
QTLIB="$APP_DIR/usr/lib/pythonPYVER_PLACEHOLDER/site-packages/PyQt6/Qt6/lib"
export LD_LIBRARY_PATH="$APP_DIR/usr/lib-local:$QTLIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export QTWEBENGINE_DISABLE_SANDBOX=1

# Widevine CDM（打包时若存在则随包注入；仅供 qt 调试路径，默认 chromium 用真 Chrome）
if [ -f "$APP_DIR/usr/libexec/widevinecdm.so" ]; then
  export QTWEBENGINE_CDM_PATH="$APP_DIR/usr/libexec/widevinecdm.so"
  if [ -d "$APP_DIR/usr/share/lptv/frontend" ] && [ -d "$APP_DIR/usr/lib/pythonPYVER_PLACEHOLDER/site-packages/PyQt6/Qt6/resources" ]; then
    export QTWEBENGINE_RESOURCES_PATH="$APP_DIR/usr/lib/pythonPYVER_PLACEHOLDER/site-packages/PyQt6/Qt6/resources"
  fi
fi

export LPTV_FRONTEND="$APP_DIR/usr/share/lptv/frontend"
export PYTHONUTF8=1

# 默认后端：真 Chrome（libexec/pywebview_chromium 注入的 chromium.py）。
# QtWebEngine 没有 H.264 解码器，央视频在其上必然黑屏；
# 只有需要调试 Qt 路径时才显式 LPTV_GUI=qt。
export LPTV_GUI="${LPTV_GUI:-chromium}"
# 资源目录必须存在：AppImage 解包不完整时直接报错，不要 cd 到错误目录再崩出
# 难以理解的 "No module named 'types'"
cd "$APP_DIR/usr/share/lptv" || {
  echo "[LPTV] 资源目录缺失: $APP_DIR/usr/share/lptv（AppImage 解包可能不完整）" >&2
  exit 1
}
# 注意不要透传 "$@"：rim 的 launch_chrome.sh 会把 Chrome 命令行参数传进来，
# python -m 无法解析，收到就会崩
exec "$APP_DIR/usr/bin/python" -m app.main
EOF
chmod +x "$APPDIR/AppRun"

# 内嵌 widevine（仅 qt 调试路径用；默认 chromium 后端走真 Chrome，自带 WidevineCdm）
if [ -f "$LPTV_ROOT/libexec/widevinecdm.so" ]; then
  mkdir -p "$APPDIR/usr/libexec"
  cp "$LPTV_ROOT/libexec/widevinecdm.so" "$APPDIR/usr/libexec/"
  [ -f "$LPTV_ROOT/libexec/widevinecdm.xml" ] && \
    cp "$LPTV_ROOT/libexec/widevinecdm.xml" "$APPDIR/usr/libexec/"
fi

# _NET_WM_ICON 写入助手（C）：libX11 的 XChangeProperty 把数据当 8 字节
# XValue 读，ctypes 数组会错位损坏；xprop -set 只认前 64 个元素（大图标
# "List truncated"）。只能内嵌原生 C 程序。优先用预编译二进制，否则现场 gcc。
if [ -f "$LPTV_ROOT/libexec/lptv_icon.c" ]; then
  mkdir -p "$APPDIR/usr/libexec"
  if [ -x "$LPTV_ROOT/libexec/lptv_icon" ]; then
    cp "$LPTV_ROOT/libexec/lptv_icon" "$APPDIR/usr/libexec/lptv_icon"
  elif command -v gcc >/dev/null 2>&1 && [ -f /usr/include/X11/Xlib.h ]; then
    gcc -O2 -o "$APPDIR/usr/libexec/lptv_icon" "$LPTV_ROOT/libexec/lptv_icon.c" -lX11
  fi
  [ -f "$APPDIR/usr/libexec/lptv_icon" ] && chmod +x "$APPDIR/usr/libexec/lptv_icon"
fi

# .desktop + 图标（appimagetool 需要 desktop 里 Exec 名与 AppRun 同目录可见）
cp "$LPTV_ROOT/build/lptv.desktop" "$APPDIR/$APPID.desktop"
cp "$LPTV_ROOT/frontend/icon.png"  "$APPDIR/usr/share/icons/hicolor/256x256/apps/$APPID.png"
ln -sf "usr/share/icons/hicolor/256x256/apps/$APPID.png" "$APPDIR/$APPID.png"

echo "==> [5/6] appimagetool 生成 AppImage"
# appimagetool 强依赖 `file`；无 root 时从 Debian 包池用户态解包引入
if ! command -v file >/dev/null 2>&1; then
  echo "    'file' 缺失 → 下载 Debian file/libmagic 解包到 tools/（无需 root）"
  TOOLS="$WORK/tools"
  mkdir -p "$TOOLS"
  DEBMIRROR="${DEBMIRROR:-https://deb.debian.org/debian/pool/main/f/file}"
  for deb in "file_5.46-5_amd64.deb" "libmagic1t64_5.46-5_amd64.deb" "libmagic-mgc_5.46-5_amd64.deb"; do
    [ -s "$TOOLS/$deb" ] || wget -q "$DEBMIRROR/$deb" -O "$TOOLS/$deb"
    dpkg-deb -x "$TOOLS/$deb" "$TOOLS/root"
  done
  export PATH="$TOOLS/root/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$TOOLS/root/usr/lib/x86_64-linux-gnu:$TOOLS/root/usr/lib/file${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  file --version >/dev/null 2>&1 || { echo "错误：file 仍不可用，请手动安装 file/libmagic1"; exit 1; }
fi
APPIMAGETOOL="$WORK/appimagetool-x86_64.AppImage"
if [ ! -s "$APPIMAGETOOL" ]; then
  wget -nc -q "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" \
    -O "$APPIMAGETOOL" || rm -f "$APPIMAGETOOL"
fi
chmod +x "$APPIMAGETOOL" 2>/dev/null || true
cd "$WORK"
# --appimage-extract-and-run：无 fuse / 非 root 环境下也能打包
"$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" "LPTV-x86_64.AppImage"

echo "==> [6/6] 完成"
ls -lh "$WORK/LPTV-x86_64.AppImage" 2>/dev/null || true
echo "产物：$WORK/LPTV-x86_64.AppImage"
echo "把它放到懒猫 LPK 的 content/appimage/ 下，由 launch_lptv.sh 启动（见 lzc/ 目录）。"
