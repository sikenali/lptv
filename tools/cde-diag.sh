#!/bin/bash
# cde-diag.sh — 懒猫 cde 容器白屏一键诊断（只读，安全）。
# 用法：把本脚本拷到容器内（或直接粘贴逐段执行），bash cde-diag.sh
# 输出：应用/rim/xpra 进程、监听端口、窗口状态、应用诊断结论、版本。
#
# 关键判定：
#   ① 无 lptv/AppRun 进程        → 应用根本没启动（launch_lptv.sh / AppRun 问题）
#   ② 有进程但 lptv.diag 无文件  → 应用启动即崩（看下方日志/退出码）
#   ③ diag 里 page.finished=false→ YSP 页面在容器内没加载（网络/DNS/代理问题）
#   ④ diag 里 rootExists=false   → inject.js 未注入（inject 层问题）
#   ⑤ diag 里 gpu_compositing 非 disabled_software → 仍在用 GPU（旧版应用/未走
#      容器强制软合成，白屏主因候选；1.0.1+ 应为 disabled_software）
#   ⑥ ①②③④都正常但仍白屏        → xpra 捕获 / rim 转发链路问题（rim 重编译候选）
set -u

echo "==== LPTV cde 诊断 $(date '+%F %T') ===="

echo "---- 1. 相关进程 ----"
ps -eo pid,ppid,stat,etime,args | grep -iE "lptv|AppRun|rim|xpra|cde-supervisor" | grep -v grep | sed 's/\(.\{180\}\).*/\1.../'

echo ""
echo "---- 2. 监听端口 (rim:8888 / xpra:7890) ----"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E "8888|7890|8889" || echo "  (无法读取或端口未监听)"

echo ""
echo "---- 3. LPTV 应用版本 (容器内已装) ----"
for f in /lzcapp/var/apps/lptv/package.json /lzcapp/var/apps/lptv/resources/app.asar.unpacked/package.json; do
  [ -f "$f" ] && echo "  $f:" && grep -oE '"version"[^,]*' "$f" | head -1
done
ls -la /lzcapp/var/apps/lptv/AppRun 2>/dev/null || echo "  无 rim 副本 AppRun"
ls -la /lzcapp/var/lptv/app/AppRun 2>/dev/null || echo "  无自解包 AppRun"

echo ""
echo "---- 4. 应用诊断结论 (~/.local/share/lptv/lptv.diag.json) ----"
DIAG="${LPTV_DIAG:-$HOME/.local/share/lptv/lptv.diag.json}"
if [ -f "$DIAG" ]; then
  python3 - "$DIAG" <<'PY' 2>/dev/null || cat "$DIAG"
import json,sys
d=json.load(open(sys.argv[1]))
p=d.get('page',{}); g=d.get('gpuFeature',{}); f=d.get('fonts',{})
print("  isContainer :", d.get('isContainer'))
print("  env.CATLINK :", d.get('env',{}).get('CATLINK_APP_ID'))
print("  page.url    :", p.get('url'))
print("  page.finished:", p.get('finished'), " fail:", p.get('fail'))
print("  rootExists  :", f.get('rootExists'))
print("  gpu_compositing:", g.get('gpu_compositing'), " video_decode:", g.get('video_decode'))
print("  verdict     :", d.get('verdict'))
PY
else
  echo "  $DIAG 不存在 → 应用可能未启动或未到 3s 快照"
fi

echo ""
echo "---- 5. 窗口状态 (xpra X server 上的窗口) ----"
export DISPLAY="${DISPLAY:-$(ls /tmp/.X11-unix/ 2>/dev/null | head -1 | sed 's/^X//;s/^/:/')}"
for d in /run/xpra/*/socket; do
  [ -e "$d" ] && export DISPLAY=":${d#/run/xpra/}" && break
done
echo "  DISPLAY=$DISPLAY"
command -v xwininfo >/dev/null 2>&1 && xwininfo -root -children 2>&1 | grep -iE "lptv|children|child" | head -10 || echo "  (无 xwininfo)"
command -v xprop >/dev/null 2>&1 && xprop -root _NET_CLIENT_LIST 2>&1 | head -3 || true

echo ""
echo "---- 6. rim / xpra 日志线索 ----"
for f in /tmp/catlink/rim.log /tmp/catlink/xpra.log /var/log/xpra/*.log; do
  [ -f "$f" ] && echo "  $f (尾 10 行):" && tail -10 "$f" | sed 's/^/    /'
done
grep -rhoE "rim|rlptv" /lzcapp/var/.config/rim.json 2>/dev/null | head -3
echo "  rim.json:"; cat /lzcapp/var/.config/rim.json 2>/dev/null | head -20 || echo "  (无 rim.json)"

echo ""
echo "==== 诊断结束 ===="
echo "判定：见脚本头注释 ①-⑥"
