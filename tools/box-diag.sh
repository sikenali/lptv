#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# box-diag.sh — LPTV 盒子端白屏定位脚本（在懒猫盒子/LPTV 容器内执行）
#
# 用法：
#   bash box-diag.sh
# 或逐条手工执行。
# -----------------------------------------------------------------------------
set +e
PORT="${LPTV_PORT:-8888}"          # rim 端口，默认 8888（可按实际覆盖）
echo "==== 1. 进程：rim / cde-supervisor / LPTV 是否在跑 ===="
ps aux | grep -E 'rim|cde-supervisor|LPTV' | grep -v grep
echo
echo "==== 2. rim HTTP 路由自检（区分 502=rim没起 vs 404/200=rim已起）===="
for path in "rlptv/update-needed" "rlptv/state" "rlptv/install/status"; do
  code=$(curl -s -o /tmp/diag_body -w '%{http_code}' "http://localhost:${PORT}/${path}")
  echo "  GET /${path} -> HTTP ${code}"
  [ "$code" != "000" ] && head -c 200 /tmp/diag_body && echo
done
echo
echo "==== 3. 安装目录关键文件与权限（exec 位必须是 -rwxr-xr-x 即 755）===="
ls -l /lzcapp/pkg/content/rim /lzcapp/pkg/content/cde-supervisor \
      /lzcapp/pkg/content/appimage/LPTV.AppImage 2>&1
stat -c '%a %n' /lzcapp/pkg/content/rim /lzcapp/pkg/content/cde-supervisor 2>&1
echo
echo "==== 4. LPTV 自解包哨兵验证（须存在 resources/frontend/inject.js）===="
APPDIR=$(mktemp -d)
( cd "$APPDIR" && /lzcapp/pkg/content/appimage/LPTV.AppImage --appimage-extract >/dev/null 2>&1 )
ls -l "$APPDIR/squashfs-root/resources/frontend/inject.js" 2>&1
rm -rf "$APPDIR"
echo
echo "==== 5. 客户端侧线索（可选，浏览器 F12）===="
echo "  打开应用后按 F12 -> Network 看 /rim/rlptv/* 状态码（502=rim没起/未注册；200=正常；404=路由缺失）"
echo "  Console 是否有 JS 报错（区分接口 502 还是 SPA 自身崩溃）"
echo
echo "==== 判定提示 ===="
echo "  * ps 无 rim/cde-supervisor      -> 会话没起来（看 cde 日志）"
echo "  * curl /rim/rlptv/* 全 502      -> rim 没起或没注册 rlptv 路由"
echo "  * curl 404 但 200 到 /wechat/*  -> 盒端只认 rwx/rwps/rchrome，lptv 未接入"
echo "  * exec 位非 755                 -> 打包丢了权限（Windows lzc-cli 重打包的坑）"
echo "  * 哨兵缺失                       -> 装的是占位/dummy AppImage"
