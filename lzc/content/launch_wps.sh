#!/bin/bash

# BEGIN CATLINK MANAGED BLOCK
# Changes inside this block are managed by CatLink and will be overwritten.

export LANGUAGE="__CATLINK_LANGUAGE__"

WPS_ROOT=/lzcapp/var/apps/wps
WPS_APPRUN=$WPS_ROOT/AppRun
#WPS_APPRUN_ORIG=$WPS_ROOT/AppRun.orig
WPS_CONF=/lzcapp/var/.config/Kingsoft/Office.conf
WPS_FONT_LINK=/usr/local/share/fonts/wps-office
WPS_WINDOW_X=0
WPS_WINDOW_Y=0
WPS_WINDOW_WIDTH=1280
WPS_WINDOW_HEIGHT=800
DOCUMENT_SHORTCUT_LINK="/lzcapp/var/Documents/!快捷访问"
DOCUMENT_SHORTCUT_TARGET="/lzcapp/var/shortcuts"

log_launch() {
    printf '[launch_wps] %s pid=%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$1" >&2
}

log_args() {
    printf '[launch_wps] argc=%s\n' "$#" >&2
    local i=0
    local arg
    for arg in "$@"; do
        printf '[launch_wps] argv[%s]=%q\n' "$i" "$arg" >&2
        i=$((i + 1))
    done
}

ensure_document_shortcut_link() {
    mkdir -p "$(dirname "$DOCUMENT_SHORTCUT_LINK")" "$DOCUMENT_SHORTCUT_TARGET"
    if [ -e "$DOCUMENT_SHORTCUT_LINK" ] && [ ! -L "$DOCUMENT_SHORTCUT_LINK" ]; then
        log_launch "skip document shortcut link: $DOCUMENT_SHORTCUT_LINK exists and is not a symlink"
    elif [ "$(readlink "$DOCUMENT_SHORTCUT_LINK")" != "$DOCUMENT_SHORTCUT_TARGET" ]; then
        rm -f "$DOCUMENT_SHORTCUT_LINK"
        ln -s "$DOCUMENT_SHORTCUT_TARGET" "$DOCUMENT_SHORTCUT_LINK"
    fi
}

log_launch "wrapper entered"
log_launch "LANGUAGE=${LANGUAGE:-}"
log_args "$@"

ensure_document_shortcut_link

mkdir -p "$(dirname "$WPS_CONF")"
crudini --set "$WPS_CONF" "6.0" "wpsoffice\\Application%20Settings\\AppComponentMode" "prome_fushion"
crudini --set "$WPS_CONF" "6.0" "wpsoffice\\Application%20Settings\\AppComponentModeInstall" "prome_fushion"
#crudini --set "$WPS_CONF" "6.0" "common\\Backup\\EnableBackup" "0"
#crudini --set "$WPS_CONF" "6.0" "wps\\Application%20Settings\\AutoBackupEnabled" "0"
#crudini --set "$WPS_CONF" "6.0" "wps\\Application%20Settings\\ForceAutoBackupEnabled" "0"
crudini --set "$WPS_CONF" "6.0" "common\\do_not_detect_file_association_while_startup" "true"

# workaround: prevent black background
for app in wpsoffice wps et pdf wpp; do
    crudini --set "$WPS_CONF" "6.0" "$app\\Application%20Settings\\WindowPosX" "$WPS_WINDOW_X"
    crudini --set "$WPS_CONF" "6.0" "$app\\Application%20Settings\\WindowPosY" "$WPS_WINDOW_Y"
    crudini --set "$WPS_CONF" "6.0" "$app\\Application%20Settings\\WindowWidth" "$WPS_WINDOW_WIDTH"
    crudini --set "$WPS_CONF" "6.0" "$app\\Application%20Settings\\WindowHeight" "$WPS_WINDOW_HEIGHT"
    crudini --set "$WPS_CONF" "6.0" "$app\\Application%20Settings\\WindowIsMaximized" "false"
done

## fix pdf open
#if [ ! -e "$WPS_ROOT/usr/lib/x86_64-linux-gnu/libtiff.so.5" ]; then
#    sudo ln -s "$WPS_ROOT/usr/lib/x86_64-linux-gnu/libtiff.so.6" "$WPS_ROOT/usr/lib/x86_64-linux-gnu/libtiff.so.5"
#fi

sudo mkdir -p "$(dirname "$WPS_FONT_LINK")"
if [ -e "$WPS_FONT_LINK" ] && [ ! -L "$WPS_FONT_LINK" ]; then
    log_launch "skip font link: $WPS_FONT_LINK exists and is not a symlink"
elif [ "$(readlink "$WPS_FONT_LINK")" != "$WPS_ROOT/usr/share/fonts/wps-office" ]; then
    sudo rm -f "$WPS_FONT_LINK"
    sudo ln -s "$WPS_ROOT/usr/share/fonts/wps-office" "$WPS_FONT_LINK"
fi

# chmod -x
sudo chmod +x $WPS_ROOT/opt/kingsoft/wps-office/office6/wpscloudsvr

#if grep -q '^export QT_FONT_DPI=' "$WPS_APPRUN"; then
#    log_launch "remove QT_FONT_DPI from AppRun"
#    cp "$WPS_APPRUN" "$WPS_APPRUN_ORIG"
#    sed -i '/^export QT_FONT_DPI=/d' "$WPS_APPRUN"
#fi

# fix LC-03 freeze
ulimit -n 65535

log_launch "exec AppRun=$WPS_APPRUN exists=$(test -e "$WPS_APPRUN"; echo $?) executable=$(test -x "$WPS_APPRUN"; echo $?)"
exec "$WPS_APPRUN" "$@"
status=$?
log_launch "exec failed status=$status"
exit "$status"

# END CATLINK MANAGED BLOCK
