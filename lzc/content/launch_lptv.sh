#!/bin/bash
# launch_lptv.sh — 启动 LPTV（Electron 单 AppImage 央视频壳）。
#
# 迁移自「pywebview + 真 Chrome/CDP 两包」方案（见 electron-migration.md）：
#   Electron 官方构建自带 H.264 专有编解码器（ffmpeg_branding=Chrome），
#   央视频（H.264-over-MSE）直接能播，无需再驱动外部真 Chrome。
#   content/appimage/ 下现在是唯一的 LPTV.AppImage（Electron），不再有 Chrome AppImage。
#
# 启动路径（按优先级）：
#   1) rim 自己解包好的 LPTV 副本：/lzcapp/var/apps/chrome/AppRun
#      （rim 在浏览器连上会话时，把 content/appimage 下那份 AppImage
#        安装/解包到 /lzcapp/var/apps/chrome/，这是骨架的官方流程）
#   2) 兜底：自己把 content 里的 AppImage 解包到 /lzcapp/var/lptv/app 再跑
#
# 兜底解包必须带完成标记：AppImage 运行时是逐文件落盘的，被 kill 后会留下
# 只有 AppRun 的半棵树；只判断 AppRun 存在会一直复用残骸，然后崩出
# 各种 "No such file" 半启动错误。用深层哨兵文件 + 失败即清理来防这个。
set -e

CONTENT=/lzcapp/pkg/content
LPTV_APPIMAGE="$CONTENT/appimage/LPTV.AppImage"
RIM_APPS=/lzcapp/var/apps/chrome
SELF_EXTRACT=/lzcapp/var/lptv/app
# 哨兵：AppDir 最底层的应用资源文件，解包必须完整才会出现
SENTINEL="resources/frontend/inject.js"

# xpra 是本容器唯一的 X server，display 号看 /run/xpra/<n>/socket。
# 宿主或 run.sh 可能把 DISPLAY 设成 :100（没有对应 X server），不修正的话
# Electron 连不上显示直接退出（"Missing X server or $DISPLAY"）。
if [ -z "${LPTV_DISPLAY:-}" ]; then
    for d in /run/xpra/*/socket; do
        [ -e "$d" ] || continue
        LPTV_DISPLAY=":${d#/run/xpra/}"; LPTV_DISPLAY="${LPTV_DISPLAY%%/*}"
        break
    done
fi
export DISPLAY="${LPTV_DISPLAY:-:0}"

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
        if [ "$ST" != "Z" ] && echo "$CM" | grep -qE "app\.asar|lptv"; then
            echo "[LPTV] 已有实例在运行 pid=$OLD_PID，跳过重复启动" >&2
            exit 0
        fi
    fi
    rm -f "$PID_FILE"
fi
printf '%s\n' "$$" > "$PID_FILE"

launch_rim_copy() {
    # rim 把 AppImage 解到 /lzcapp/var/apps/chrome/；用哨兵确认确实是 LPTV。
    if [ -x "$RIM_APPS/AppRun" ] && [ -f "$RIM_APPS/$SENTINEL" ]; then
        echo "[LPTV] 使用 rim 安装的 LPTV 副本：$RIM_APPS/AppRun" >&2
        # 必须显式设 APPDIR：electron-builder 生成的 AppRun 用 $1（首个参数）探测
        # AppDir，传 --no-sandbox 时 $1=--no-sandbox 探测失败 → BIN 解析成 /lptv
        # 直接报 "No such file"。导出 APPDIR 后 AppRun 跳过探测。
        export APPDIR="$RIM_APPS"
        exec "$RIM_APPS/AppRun" --no-sandbox
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
        export APPDIR="$SELF_EXTRACT"
        exec "$SELF_EXTRACT/AppRun" --no-sandbox
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
    export APPDIR="$SELF_EXTRACT"
    exec "$SELF_EXTRACT/AppRun" --no-sandbox
}

launch_rim_copy || launch_self_extract

echo "[LPTV] 两条启动路径都不可用" >&2
exit 1
