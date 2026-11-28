#!/usr/bin/env bash
# 全量模拟测试：Node 单测 + 无头 Chrome 功能/性能断言。
# 覆盖：CDE 窗口铺满/单视频层、桌面/智慧屏/移动端 UI、设置/主题/EPG/音量/静音/
# 全屏/数字键/版权提示/首页回切、20 次换台压力、卡死恢复、模式分类、窗口几何。
#
# 用法：bash scripts/test_all.sh
# 依赖：node、google-chrome（或 CHROME=/path/to/chrome）
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-google-chrome}"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS+1)); say "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); say "FAIL  $*"; }

run_node() {
  local name="$1"; shift
  local out
  out="$(cd "$ROOT" && node --test "$@" 2>&1)"
  if [ $? -eq 0 ]; then ok "$name"; else bad "$name"; printf '%s\n' "$out" | tail -30; fi
}

run_browser() {
  local name="$1" file="$2" size="$3" budget="$4"
  local out p trace
  out="$(timeout 120s "$CHROME" --headless=new --disable-gpu --no-sandbox \
    --window-size="$size" --virtual-time-budget="$budget" \
    --dump-dom "file://$ROOT/web/test/$file" 2>/dev/null)"
  rc=$?
  p="$(printf '%s\n' "$out" | grep -o 'data-pass="[^"]*"' | head -1 | sed 's/.*="//;s/"//')"
  trace="$(printf '%s\n' "$out" | grep -o 'data-test="[^"]*"' | head -1 | sed 's/&quot;/"/g')"
  if [ "$p" = "1" ]; then ok "$name ($size)"; else
    bad "$name ($size)"
    [ "$rc" = "124" ] && say "  timeout after 120s"
    [ -n "$trace" ] && printf '  %s\n' "$trace"
  fi
}

say "== Node tests =="
run_node "xpra 客户端模式分类" electron/xpra-client-info.test.js
run_node "Electron CDE/智慧屏窗口几何" electron/main-geometry.test.js
run_node "catlink-wrap 全屏策略" web/test/catlink-wrap.test.js

say ""
say "== CDE 窗口模式/视频层 =="
run_browser "CDE 窗口铺满 + 单视频层" cde-window.html 1623,1000 30000
run_browser "CDE 窗口铺满 + 单视频层" cde-window.html 1280,720 30000
run_browser "CDE 窗口铺满 + 单视频层" cde-window.html 1920,1080 30000

say ""
say "== CDE 全功能 =="
run_browser "CDE 主题/设置/频道/EPG/音量/静音/全屏/数字键/版权/首页/性能" cde-features.html 1623,1000 60000

say ""
say "== 桌面/智慧屏/移动端 UI =="
run_browser "桌面模式 UI" desktop-mode.html 1623,1000 30000
run_browser "智慧屏模式 UI" smart-mode.html 1280,720 30000
run_browser "移动端模式 UI（横屏）" mobile-mode.html 844,390 15000
run_browser "移动端模式 UI（竖屏引导）" mobile-mode.html 390,844 15000

say ""
say "== 性能/稳定性 =="
run_browser "智慧屏 20 次换台压力" smart-stress.html 1280,720 50000
run_browser "卡死/无画面恢复" stalled-test.html 1280,720 50000

say ""
say "== RESULT =="
say "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
