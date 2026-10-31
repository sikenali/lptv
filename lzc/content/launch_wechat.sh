#!/bin/bash

# BEGIN CATLINK MANAGED BLOCK
# Changes inside this block are managed by CatLink and will be overwritten.
export LANGUAGE="__CATLINK_LANGUAGE__"
export LANG="C.UTF-8"
case "$LANGUAGE" in
    zh|zh_*) export LC_MESSAGES="zh_CN.UTF-8" ;;
    *) export LC_MESSAGES="en_US.UTF-8" ;;
esac
# END CATLINK MANAGED BLOCK

export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=KDE

WECHAT_ROOT=/lzcapp/var/apps/wechat

wechat_browser_real=$WECHAT_ROOT/opt/wechat/RadiumWMPF/runtime/WeChatAppEx.real
if [[ ! -f "$wechat_browser_real" ]]; then
    wechat_browser=$WECHAT_ROOT/opt/wechat/RadiumWMPF/runtime/WeChatAppEx
    mv -n "$wechat_browser" "$wechat_browser_real"
    cat > "$wechat_browser" <<'EOF'
#!/bin/bash
exec "$0.real" "$@" --no-sandbox --disable-dev-shm-usage
EOF
    chmod a+x "$wechat_browser"
fi

exec "$WECHAT_ROOT/AppRun" "$@"
