#!/bin/bash

# export HTTP_PROXY="http://proxy.example:8080"
# export HTTPS_PROXY="http://proxy.example:8080"
# export ALL_PROXY="socks5://proxy.example:1080"

# CHROME_EXTRA_ARGS=(
#   --proxy-server=http://proxy.example:8080
# )

# BEGIN CATLINK MANAGED BLOCK
# Changes inside this block are managed by CatLink and will be overwritten.

export LANGUAGE="__CATLINK_LANGUAGE__"

CHROME_ROOT=/lzcapp/var/apps/chrome
CHROME_APPRUN=$CHROME_ROOT/AppRun

log_launch() {
    printf '[launch_chrome] %s pid=%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$1" >&2
}

log_args() {
    printf '[launch_chrome] argc=%s\n' "$#" >&2
    local i=0
    local arg
    for arg in "$@"; do
        printf '[launch_chrome] argv[%s]=%q\n' "$i" "$arg" >&2
        i=$((i + 1))
    done
}

log_launch "wrapper entered"
log_launch "LANGUAGE=${LANGUAGE:-}"
log_args "$@"

CHROME_POLICY_DIR=/etc/opt/chrome/policies/managed
CHROME_POLICY_FILE=$CHROME_POLICY_DIR/default_managed_policy.json
if mkdir -p "$CHROME_POLICY_DIR" 2>/dev/null; then
    if printf '%s\n' '{"CommandLineFlagSecurityWarningsEnabled": false, "DefaultBrowserSettingEnabled": false}' >"$CHROME_POLICY_FILE" 2>/dev/null; then
        log_launch "wrote Chrome policy=$CHROME_POLICY_FILE"
    else
        log_launch "failed to write Chrome policy=$CHROME_POLICY_FILE"
    fi
else
    log_launch "failed to create Chrome policy dir=$CHROME_POLICY_DIR"
fi

CHROME_FALLBACK_DOWNLOAD_DIR=/lzcapp/var/Downloads
CHROME_CLOUD_DOWNLOAD_DIR=/lzcapp/document/Downloads
CHROME_POLICY_DOWNLOAD_DIR="${CATLINK_CHROME_DEFAULT_DOWNLOAD_DIR:-$CHROME_FALLBACK_DOWNLOAD_DIR}"
case "$CHROME_POLICY_DOWNLOAD_DIR" in
    "$CHROME_FALLBACK_DOWNLOAD_DIR"|"$CHROME_CLOUD_DOWNLOAD_DIR") ;;
    *)
        log_launch "invalid download directory=$CHROME_POLICY_DOWNLOAD_DIR; using fallback=$CHROME_FALLBACK_DOWNLOAD_DIR"
        CHROME_POLICY_DOWNLOAD_DIR=$CHROME_FALLBACK_DOWNLOAD_DIR
        ;;
esac

CHROME_RECOMMENDED_POLICY_DIR=/etc/opt/chrome/policies/recommended
CHROME_DOWNLOAD_POLICY_FILE=$CHROME_RECOMMENDED_POLICY_DIR/catlink_download.json
if mkdir -p "$CHROME_RECOMMENDED_POLICY_DIR" 2>/dev/null; then
    download_policy_tmp="${CHROME_DOWNLOAD_POLICY_FILE}.tmp.$$"
    if printf '{"DefaultDownloadDirectory":"%s"}\n' "$CHROME_POLICY_DOWNLOAD_DIR" >"$download_policy_tmp" 2>/dev/null &&
        chmod 0644 "$download_policy_tmp" 2>/dev/null &&
        mv -f "$download_policy_tmp" "$CHROME_DOWNLOAD_POLICY_FILE" 2>/dev/null; then
        log_launch "wrote Chrome recommended download policy=$CHROME_POLICY_DOWNLOAD_DIR"
    else
        rm -f "$download_policy_tmp"
        log_launch "failed to write Chrome recommended download policy=$CHROME_DOWNLOAD_POLICY_FILE"
    fi
else
    log_launch "failed to create Chrome recommended policy dir=$CHROME_RECOMMENDED_POLICY_DIR"
fi

log_launch "exec AppRun=$CHROME_APPRUN exists=$(test -e "$CHROME_APPRUN"; echo $?) executable=$(test -x "$CHROME_APPRUN"; echo $?)"
chrome_args=(
    "$@"
    --no-sandbox
    --disable-dev-shm-usage
    --no-first-run
    --simulate-outdated-no-au='Tue, 31 Dec 2099 23:59:59 GMT'
)

if [ "${CATLINK_CHROME_HARDWARE_ACCELERATION:-0}" = "1" ]; then
    chrome_args+=(
        --use-angle=vulkan
        --enable-features=Vulkan,CanvasOopRasterization
        --enable-gpu-rasterization
        --enable-zero-copy
        --enable-native-gpu-memory-buffers
        --disable-vulkan-surface
#        --disable-gpu-vsync
#        --disable-frame-rate-limit
#        --run-all-compositor-stages-before-draw
    )
fi

chrome_args+=("${CHROME_EXTRA_ARGS[@]}")

log_args "${chrome_args[@]}"
exec "$CHROME_APPRUN" "${chrome_args[@]}"
status=$?
log_launch "exec failed status=$status"
exit "$status"

# END CATLINK MANAGED BLOCK
