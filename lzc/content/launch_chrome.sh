#!/bin/bash
# launch_chrome.sh — rim 硬编码从这里启动"默认应用"（rim/bundled_app_install.go）。
# 骨架里它是 chrome 的启动脚本；在 LPTV 包中改成转发到自己的启动器。
# 注意：rim 会把 AppImage 参数透传过来，launch_lptv.sh 内部不透传给 python。
exec /lzcapp/pkg/content/launch_lptv.sh
