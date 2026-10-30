#!/bin/bash

set -ex

## uinput is a host-kernel module. Loading it here keeps the container usable
## on hosts that expose the device node but have not loaded the module yet.
#if command -v modprobe >/dev/null 2>&1; then
#    modprobe uinput || echo "warning: unable to load uinput; Xpra may use XTest" >&2
#else
#    echo "warning: modprobe is unavailable; Xpra may use XTest" >&2
#fi

case "${CATLINK_APP_ID:-}" in
    rwx|rwps|rchrome|rlptv) ;;
    *) echo "CATLINK_APP_ID must be rwx, rwps, rchrome, or rlptv" >&2; exit 1 ;;
esac

# 会话层 rim 的 app_id 校验 = /lzcapp/var/apps/<id> 目录存在（非硬编码白名单）。
# 预建注册目录，保证 rim 启动时不报 unsupported CATLINK_APP_ID。
if [ "$CATLINK_APP_ID" = "rlptv" ] || [ "$CATLINK_APP_ID" = "rchrome" ]; then
    mkdir -p "/lzcapp/var/apps/$CATLINK_APP_ID"
    # 装 LPTV 图标到 hicolor 主题：任务栏按 <appid>/WM_CLASS 查图标，
    # 可能命中 rchrome/chrome/rlptv/lptv 任一名字，全部铺一遍（内容同一 LPTV 图标）。
    if [ -d /lzcapp/pkg/content/icons ]; then
        for px in 16 24 32 48 64 128 256 512; do
            [ -f "/lzcapp/pkg/content/icons/rlptv-${px}.png" ] || continue
            mkdir -p "/usr/share/icons/hicolor/${px}x${px}/apps"
            for n in rchrome chrome rlptv; do
                cp -f "/lzcapp/pkg/content/icons/rlptv-${px}.png" "/usr/share/icons/hicolor/${px}x${px}/apps/$n.png"
            done
        done
        command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
        for px in 24 48 256; do
            [ -f "/usr/share/icons/hicolor/${px}x${px}/apps/rlptv.png" ] && cp -f "/usr/share/icons/hicolor/${px}x${px}/apps/rlptv.png" "/usr/share/icons/hicolor/${px}x${px}/apps/lptv.png"
        done
        echo "已安装 LPTV 图标 (rchrome/chrome/rlptv/lptv) 到 hicolor 主题" >&2
    fi
fi

WECHAT_OLD_ROOT=/lzcapp/var/wechat
WECHAT_ROOT=/lzcapp/var/apps/wechat

# 兼容历史路径：/lzcapp/var/wechat -> /lzcapp/var/apps/wechat
if [ -d "$WECHAT_OLD_ROOT" ] && [ ! -d "$WECHAT_ROOT" ]; then
    mkdir -p /lzcapp/var/apps
    mv "$WECHAT_OLD_ROOT" "$WECHAT_ROOT"
fi

# Make fonts mounted by the LPK immediately visible to GTK/Qt applications.
fc-cache -f

QT_SHORTCUTS_DIR="$HOME/shortcuts"
if [ ! -d "$QT_SHORTCUTS_DIR" ]; then
    mkdir -p "$QT_SHORTCUTS_DIR"
fi
if [ ! -e "$QT_SHORTCUTS_DIR/本地保存" ] && [ ! -L "$QT_SHORTCUTS_DIR/本地保存" ]; then
    ln -s /lzcapp/clientfs "$QT_SHORTCUTS_DIR/本地保存"
fi
if [ ! -e "$QT_SHORTCUTS_DIR/懒猫网盘" ] && [ ! -L "$QT_SHORTCUTS_DIR/懒猫网盘" ]; then
    ln -s /lzcapp/document "$QT_SHORTCUTS_DIR/懒猫网盘"
fi
if [ ! -e "$QT_SHORTCUTS_DIR/外接磁盘" ] && [ ! -L "$QT_SHORTCUTS_DIR/外接磁盘" ]; then
    ln -s /lzcapp/media "$QT_SHORTCUTS_DIR/外接磁盘"
fi

GTK_BOOKMARK=$HOME/.config/gtk-3.0/bookmarks
install -D /lzcapp/pkg/content/gtk-bookmark "$GTK_BOOKMARK"
QT_BOOKMARK=$HOME/.config/QtProject.conf
install -D /lzcapp/pkg/content/qt-bookmark.ini "$QT_BOOKMARK"
export QT_QPA_PLATFORMTHEME=gtk3

export XPRA_SCALING=false
export XPRA_DOWNSCALE=false
export XPRA_TEXT_USE_VIDEO=true
export XPRA_MIN_VIDEO_FPS=0
export XPRA_ENCODING_STRICT_MODE=true
export XPRA_DEFAULT_CONTENT_TYPE=video
export XPRA_CLIPBOARD_REMOTE_TIMEOUT=5000

RIM_CONFIG=/lzcapp/var/.config/rim.json
read_rim_bool() {
    python3 - "$RIM_CONFIG" "$1" "$2" <<'PY'
import json
import sys
path, key, default = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as f:
        value = json.load(f).get(key, default == "1")
except Exception:
    value = default == "1"
print("1" if bool(value) else "0")
PY
}

export CATLINK_IM_ENHANCED_MODE=0
export CATLINK_IM_CURSOR_ENHANCED_MODE=0
export CATLINK_VIDEO_ALPHA_FIX=0
if [ "$CATLINK_APP_ID" = "rwps" ] || [ "$CATLINK_APP_ID" = "rchrome" ] || [ "$CATLINK_APP_ID" = "rlptv" ]; then
    export CATLINK_IM_ENHANCED_MODE=1
    export CATLINK_IM_CURSOR_ENHANCED_MODE="$(read_rim_bool im_cursor_enhanced_mode $([ "$CATLINK_APP_ID" = "rwps" ] && echo 1 || echo 0))"
fi
if [ "$CATLINK_APP_ID" = "rchrome" ] || [ "$CATLINK_APP_ID" = "rlptv" ]; then
    export CATLINK_VIDEO_ALPHA_FIX="$(read_rim_bool disable_partial_transparency_for_performance 1)"
    export CATLINK_CHROME_HARDWARE_ACCELERATION="$(read_rim_bool chrome_hardware_acceleration_opt_in 0)"
fi

current_user="${USER:-${LOGNAME:-$(id -un 2>/dev/null || true)}}"
if [ -z "$current_user" ]; then current_user="$(getent passwd "$(id -u)" | cut -d: -f1)"; fi
export USER="$current_user"
export LOGNAME="$current_user"

if [ "$CATLINK_APP_ID" = "rchrome" ]; then
    CHROME_OLD_CACHE_DIR=/lzcapp/var/.cache/google-chrome
    CHROME_CACHE_HOME=/lzcapp/cache
    CHROME_CACHE_DIR=$CHROME_CACHE_HOME/google-chrome
    if mkdir -p "$CHROME_CACHE_HOME" && [ -d "$CHROME_CACHE_HOME" ] && [ -x "$CHROME_CACHE_HOME" ] && [ -w "$CHROME_CACHE_HOME" ]; then
        if [ -d "$CHROME_OLD_CACHE_DIR" ]; then
            if [ ! -e "$CHROME_CACHE_DIR" ]; then
                if ! mv "$CHROME_OLD_CACHE_DIR" "$CHROME_CACHE_DIR"; then
                    echo "warning: failed to migrate Chrome cache to $CHROME_CACHE_DIR" >&2
                fi
            elif ! rm -rf -- "$CHROME_OLD_CACHE_DIR"; then
                echo "warning: failed to remove stale Chrome cache at $CHROME_OLD_CACHE_DIR" >&2
            fi
        fi
        export XDG_CACHE_HOME="$CHROME_CACHE_HOME"
    else
        echo "warning: $CHROME_CACHE_HOME is unavailable; using the default Chrome cache" >&2
        unset XDG_CACHE_HOME
    fi

    CHROME_FALLBACK_DOWNLOAD_DIR=/lzcapp/var/Downloads
    CHROME_CLOUD_DOWNLOAD_DIR=/lzcapp/document/Downloads
    export CATLINK_CHROME_DEFAULT_DOWNLOAD_DIR="$CHROME_FALLBACK_DOWNLOAD_DIR"

    if [ ! -d "$CHROME_FALLBACK_DOWNLOAD_DIR" ] && ! mkdir -p "$CHROME_FALLBACK_DOWNLOAD_DIR" 2>/dev/null; then
        echo "warning: failed to prepare Chrome fallback download directory at $CHROME_FALLBACK_DOWNLOAD_DIR" >&2
    fi

    if [ -d /lzcapp/document ] && [ -x /lzcapp/document ]; then
        if [ ! -e "$CHROME_CLOUD_DOWNLOAD_DIR" ]; then
            mkdir "$CHROME_CLOUD_DOWNLOAD_DIR" 2>/dev/null || true
        fi
        if [ -d "$CHROME_CLOUD_DOWNLOAD_DIR" ] && [ -x "$CHROME_CLOUD_DOWNLOAD_DIR" ] && [ -w "$CHROME_CLOUD_DOWNLOAD_DIR" ]; then
            export CATLINK_CHROME_DEFAULT_DOWNLOAD_DIR="$CHROME_CLOUD_DOWNLOAD_DIR"
        else
            echo "warning: Chrome cloud download directory is unavailable; using $CHROME_FALLBACK_DOWNLOAD_DIR" >&2
        fi
    else
        echo "warning: /lzcapp/document is unavailable; using $CHROME_FALLBACK_DOWNLOAD_DIR" >&2
    fi
fi

if [ "$CATLINK_APP_ID" = "rlptv" ]; then
    CHROME_OLD_CACHE_DIR=/lzcapp/var/.cache/lptv
    CHROME_CACHE_HOME=/lzcapp/cache
    CHROME_CACHE_DIR=$CHROME_CACHE_HOME/lptv
    if mkdir -p "$CHROME_CACHE_HOME" && [ -d "$CHROME_CACHE_HOME" ] && [ -x "$CHROME_CACHE_HOME" ] && [ -w "$CHROME_CACHE_HOME" ]; then
        if [ -d "$CHROME_OLD_CACHE_DIR" ]; then
            if [ ! -e "$CHROME_CACHE_DIR" ]; then
                if ! mv "$CHROME_OLD_CACHE_DIR" "$CHROME_CACHE_DIR"; then
                    echo "warning: failed to migrate LPTV cache to $CHROME_CACHE_DIR" >&2
                fi
            elif ! rm -rf -- "$CHROME_OLD_CACHE_DIR"; then
                echo "warning: failed to remove stale LPTV cache at $CHROME_OLD_CACHE_DIR" >&2
            fi
        fi
        export XDG_CACHE_HOME="$CHROME_CACHE_HOME"
    else
        echo "warning: $CHROME_CACHE_HOME is unavailable; using the default LPTV cache" >&2
        unset XDG_CACHE_HOME
    fi

    CHROME_FALLBACK_DOWNLOAD_DIR=/lzcapp/var/Downloads
    CHROME_CLOUD_DOWNLOAD_DIR=/lzcapp/document/Downloads
    export CATLINK_CHROME_DEFAULT_DOWNLOAD_DIR="$CHROME_FALLBACK_DOWNLOAD_DIR"

    if [ ! -d "$CHROME_FALLBACK_DOWNLOAD_DIR" ] && ! mkdir -p "$CHROME_FALLBACK_DOWNLOAD_DIR" 2>/dev/null; then
        echo "warning: failed to prepare LPTV fallback download directory at $CHROME_FALLBACK_DOWNLOAD_DIR" >&2
    fi

    if [ -d /lzcapp/document ] && [ -x /lzcapp/document ]; then
        if [ ! -e "$CHROME_CLOUD_DOWNLOAD_DIR" ]; then
            mkdir "$CHROME_CLOUD_DOWNLOAD_DIR" 2>/dev/null || true
        fi
        if [ -d "$CHROME_CLOUD_DOWNLOAD_DIR" ] && [ -x "$CHROME_CLOUD_DOWNLOAD_DIR" ] && [ -w "$CHROME_CLOUD_DOWNLOAD_DIR" ]; then
            export CATLINK_CHROME_DEFAULT_DOWNLOAD_DIR="$CHROME_CLOUD_DOWNLOAD_DIR"
        else
            echo "warning: LPTV cloud download directory is unavailable; using $CHROME_FALLBACK_DOWNLOAD_DIR" >&2
        fi
    else
        echo "warning: /lzcapp/document is unavailable; using $CHROME_FALLBACK_DOWNLOAD_DIR" >&2
    fi
fi

# avoid chromium detect as "browser"
rm -rf /etc/xpra/content-*/

#export XPRA_ALPHA=false
export XPRA_USER_CONF_DIRS=/tmp/catlink/
export CATLINK_RESTORE_ACTIVE_TRANSIENT_ON_UNMAP="${CATLINK_RESTORE_ACTIVE_TRANSIENT_ON_UNMAP:-1}"
install -D /lzcapp/pkg/content/90_lzc.conf /tmp/catlink/xpra.conf
install -D /lzcapp/pkg/content/dummyscreen.sh /usr/bin/spectacle

# 预热解包 LPTV AppImage（后台）：客户端连接后启动零等待，首帧画面更快。
# 不阻塞主流程，失败也不影响正常启动。
# LPTV 二进制带版本号（LPTV-linux-x86_64-<version>.AppImage），用 glob 匹配不写死。
if [ "$CATLINK_APP_ID" = "rlptv" ] && [ -x /lzcapp/pkg/content/launch_lptv.sh ] \
   && compgen -G "/lzcapp/pkg/content/appimage/LPTV*.AppImage" >/dev/null; then
    LPTV_PREWARM=1 nohup /lzcapp/pkg/content/launch_lptv.sh >/dev/null 2>&1 &
fi

exec /lzcapp/pkg/content/cde-supervisor \
    xpra seamless --backend=gtk --bind-ws 0.0.0.0:7890 --daemon=no
