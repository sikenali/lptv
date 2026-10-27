#!/bin/bash
# launch_lptv.sh — 启动 LPTV（pywebview + 真 Chrome / CDP 后端的央视频壳）。
#
# 为什么必须用真 Chrome：
#   pywebview 在 Linux 上只有 qt(QtWebEngine) 与 gtk(WebKit2) 两个后端，
#   两者的 H.264 支持都不完整——QtWebEngine 的
#   MediaSource.isTypeSupported('video/mp4;codecs="avc1.42E01E,mp4a.40.2"') 返回 false，
#   WebKit2 对所有 codec 串返回 ""。央视频是纯 H.264-over-MSE 直播流，
#   在 QtWebEngine 上必然黑屏（已实测：video 恒为 0x0 / readyState=0）。
#   所以本包自带 webview.platforms.chromium，走 DevTools Protocol 驱动真 Chrome。
#
# 两条启动路径，按优先级：
#   1) rim 自己解包好的 LPTV 副本：/lzcapp/var/apps/chrome/AppRun
#      （rim 在浏览器连上会话时，会把 content/appimage 下那份 AppImage
#        安装/解包到 /lzcapp/var/apps/chrome/，这是骨架的官方流程）
#   2) 兜底：自己把 content 里的 AppImage 解包到 /lzcapp/var/lptv/app 再跑
#
# 兜底解包必须带完成标记：AppImage 运行时是逐文件落盘的，被 kill 后会留下
# 只有 AppRun 的半棵树；只判断 AppRun 存在会一直复用残骸，然后崩出
# "No module named 'types'"。用深层哨兵文件 + 失败即清理来防这个。
set -e

CONTENT=/lzcapp/pkg/content
LPTV_APPIMAGE="$CONTENT/appimage/LPTV-x86_64.AppImage"
# rim 硬编码只认这个文件名（rim/bundled_app_install.go）；骨架里它装的是真 Chrome，
# 供 launch_lptv.sh 里的 chromium 后端当引擎用。
CHROME_APPIMAGE="$CONTENT/appimage/Google-Chrome-stable-155.0.8059.39-1-x86_64.AppImage"
RIM_APPS=/lzcapp/var/apps/chrome
SELF_EXTRACT=/lzcapp/var/lptv/app
# 哨兵：AppDir 最底层的应用资源文件，解包必须完整才会出现
SENTINEL="usr/share/lptv/frontend/inject.js"

export QT_QPA_PLATFORM=xcb

# xpra 是本容器唯一的 X server，display 号看 /run/xpra/<n>/socket。
# 宿主或 run.sh 可能把 DISPLAY 设成 :100（没有对应 X server），不修正的话
# Chrome 连不上显示直接退出（"Missing X server or $DISPLAY"）。
if [ -z "${LPTV_DISPLAY:-}" ]; then
    for d in /run/xpra/*/socket; do
        [ -e "$d" ] || continue
        LPTV_DISPLAY=":${d#/run/xpra/}"; LPTV_DISPLAY="${LPTV_DISPLAY%%/*}"
        break
    done
fi
export DISPLAY="${LPTV_DISPLAY:-:0}"

# ---- 后端选择 --------------------------------------------------------------
# 默认真 Chrome 后端。只有显式 LPTV_GUI=qt 才退回 QtWebEngine（预期黑屏）。
export LPTV_GUI="${LPTV_GUI:-chromium}"

# Chrome 引擎发现顺序。本包不再自带 Chrome AppImage（省 ~200MB），按以下优先级找：
#   1) rim 解包副本里的 chrome 二进制（免二次解包）
#   2) 盒子上已有的 Chrome：chrome 应用的安装目录 / 系统 Chrome
#   3) 随包 Chrome AppImage（仅老包残留时命中，后端自动解包到缓存目录）
#   4) 都没有 → 首次启动下载 Google 官方 Chrome deb 解压到缓存目录（约 115MB）
# 说明：deb 解压后就是 opt/google/chrome/chrome 布局，与 AppImage 解包结果同构，
#       chromium 后端只认可执行二进制，不需要 AppImage 这个格式。
CHROME_DEB_DIR=/lzcapp/var/lptv/chrome-deb
CHROME_DEB_BIN="$CHROME_DEB_DIR/opt/google/chrome/chrome"
CHROME_DEB_URL="${LPTV_CHROME_DEB_URL:-https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb}"

install_chrome_deb() {
    echo "[LPTV] 未找到任何 Chrome，下载官方 deb → $CHROME_DEB_DIR" >&2
    mkdir -p "$CHROME_DEB_DIR" || return 1
    local deb=/lzcapp/var/lptv/chrome.deb
    wget -q --tries=3 --timeout=60 -O "$deb" "$CHROME_DEB_URL" || { echo "[LPTV] Chrome 下载失败：$CHROME_DEB_URL" >&2; return 1; }
    dpkg-deb -x "$deb" "$CHROME_DEB_DIR" 2>/dev/null || { echo "[LPTV] Chrome deb 解压失败" >&2; rm -f "$deb"; return 1; }
    rm -f "$deb"
    if [ ! -x "$CHROME_DEB_BIN" ]; then
        echo "[LPTV] deb 解压后未找到 chrome 二进制" >&2
        return 1
    fi
    export LPTV_CHROME="$CHROME_DEB_BIN"
    echo "[LPTV] Chrome 下载解压完成：$CHROME_DEB_BIN" >&2
}

if [ -z "${LPTV_CHROME:-}" ]; then
    for c in "$RIM_APPS/opt/google/chrome/chrome" "$RIM_APPS/chrome" \
             /opt/google/chrome/chrome /usr/bin/google-chrome \
             /usr/bin/chromium /usr/bin/chromium-browser; do
        if [ -x "$c" ]; then export LPTV_CHROME="$c"; break; fi
    done
    if [ -z "${LPTV_CHROME:-}" ] && [ -x "$CHROME_DEB_BIN" ]; then
        export LPTV_CHROME="$CHROME_DEB_BIN"
    fi
    if [ -z "${LPTV_CHROME:-}" ] && [ -x "$CHROME_APPIMAGE" ]; then
        export LPTV_CHROME="$CHROME_APPIMAGE"
    fi
fi
[ -n "${LPTV_CHROME:-}" ] || install_chrome_deb
# 解包缓存放在 /lzcapp/var 下，容器重建后可见、便于排查
export LPTV_CHROME_DIR="${LPTV_CHROME_DIR:-/lzcapp/var/lptv/chrome}"

# ---- 幂等 ------------------------------------------------------------------
# xpra 的 start-child-after-connect 和 rim 的 launch_chrome.sh 可能都会拉起这个脚本。
# 已有实例在跑就直接退出，避免同一个 App 开两个窗口。
PID_FILE=/tmp/catlink/lptv.pid
mkdir -p /tmp/catlink 2>/dev/null || true
if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || echo "")"
    # 必须确认 pid 既活着、cmdline 又是我们的 app：容器内 xpra 退出后子进程
    # 会留成 zombie，/proc/$pid 目录还在但进程已死；只信任 pidfile 会让后面
    # 每次启动都被当成"重复"而静默跳过。
    if [ -n "$OLD_PID" ] && [ -d "/proc/$OLD_PID" ]; then
        ST="$(awk "{print \$3}" "/proc/$OLD_PID/stat" 2>/dev/null || echo "")"
        CM="$(cat "/proc/$OLD_PID/cmdline" 2>/dev/null | tr "\000" " " || echo "")"
        if [ "$ST" != "Z" ] && echo "$CM" | grep -q "app.main"; then
            echo "[LPTV] 已有实例在运行 pid=$OLD_PID，跳过重复启动" >&2
            exit 0
        fi
    fi
    rm -f "$PID_FILE"
fi
printf '%s\n' "$$" > "$PID_FILE"

launch_rim_copy() {
    # rim 把哪个 AppImage 解到 /lzcapp/var/apps/chrome/ 取决于它的硬编码文件名；
    # 现在那个位置装的是真 Chrome，不是 LPTV，所以要用哨兵确认。
    if [ -x "$RIM_APPS/AppRun" ] && [ -f "$RIM_APPS/$SENTINEL" ]; then
        echo "[LPTV] 使用 rim 安装的 LPTV 副本：$RIM_APPS/AppRun" >&2
        exec "$RIM_APPS/AppRun"
    fi
    return 1
}

launch_self_extract() {
    if [ ! -x "$LPTV_APPIMAGE" ]; then
        echo "[LPTV] AppImage 缺失: $LPTV_APPIMAGE" >&2
        return 1
    fi
    # 用 AppImage 的 mtime 作版本标记：升级后 mtime 变了就强制重新解包，
    # 否则会一直复用 /lzcapp/var 下上一次的旧树（旧包修复全不生效）。
    MARKER="$SELF_EXTRACT/.lptv-appimage-mtime"
    MTIME="$(stat -c %Y "$LPTV_APPIMAGE" 2>/dev/null || echo 0)"
    if [ -x "$SELF_EXTRACT/AppRun" ] && [ -f "$SELF_EXTRACT/$SENTINEL" ] \
       && [ "$(cat "$MARKER" 2>/dev/null || echo 0)" = "$MTIME" ]; then
        echo "[LPTV] 复用已解包 $SELF_EXTRACT" >&2
        exec "$SELF_EXTRACT/AppRun"
    fi
    echo "[LPTV] 解包 AppImage → $SELF_EXTRACT (mtime=$MTIME)" >&2
    rm -rf "$SELF_EXTRACT"
    TMP="$(mktemp -d /tmp/lptv.XXXXXX)"
    ( cd "$TMP" && "$LPTV_APPIMAGE" --appimage-extract >/dev/null 2>&1 ) || true
    if [ ! -f "$TMP/squashfs-root/$SENTINEL" ]; then
        echo "[LPTV] AppImage 解包不完整，放弃本次启动" >&2
        rm -rf "$TMP" "$SELF_EXTRACT"
        return 1
    fi
    mkdir -p "$(dirname "$SELF_EXTRACT")"
    mv "$TMP/squashfs-root" "$SELF_EXTRACT"
    printf '%s\n' "$MTIME" > "$SELF_EXTRACT/.lptv-appimage-mtime"
    rm -rf "$TMP"
    exec "$SELF_EXTRACT/AppRun"
}

launch_rim_copy || launch_self_extract

echo "[LPTV] 两条启动路径都不可用" >&2
exit 1
