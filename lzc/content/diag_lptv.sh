#!/bin/bash
# 诊断 LPTV 卡顿根因：采集 GPU/VA-API/GL/Vulkan/xpra编码 信息。
# 在容器内执行：bash /lzcapp/pkg/content/diag_lptv.sh
set +e

echo "===== [1] 容器 GPU 设备 ====="
ls -l /dev/dri 2>&1 || echo "no /dev/dri (无GPU透传)"
echo "===== [2] CPU / 内存 ====="
nproc 2>/dev/null
grep -m1 "model name" /proc/cpuinfo 2>/dev/null
free -h 2>/dev/null | head -3
echo "===== [3] VA-API (视频硬件编解码) ====="
if command -v vainfo >/dev/null 2>&1; then
    vainfo 2>&1 | head -25
else
    echo "vainfo 未安装"
fi
echo "===== [4] GL/GLX 渲染器 ====="
if command -v glxinfo >/dev/null 2>&1; then
    DISPLAY="${DISPLAY:-:0}" glxinfo -B 2>&1 | head -25
else
    echo "glxinfo 未安装"
fi
echo "===== [5] Vulkan ====="
if command -v vulkaninfo >/dev/null 2>&1; then
    vulkaninfo --summary 2>&1 | head -25
else
    echo "vulkaninfo 未安装"
fi
echo "===== [6] xpra 会话编码器/帧率 ====="
if command -v xpra >/dev/null 2>&1; then
    xpra info 2>&1 | grep -iE "encoder|video-encod|fps|frame-rate|resolution|width|height|damage|bandwidth" | head -40
else
    echo "xpra 不可用"
fi
echo "===== [7] 最近 xpra/容器 日志（编码相关） ====="
for f in /tmp/catlink/xpra.log /tmp/catlink/xpra-*.log /var/log/xpra/*.log /lzcapp/var/log/*.log; do
    [ -f "$f" ] || continue
    echo "--- $f ---"
    grep -iE "encoder|vaapi|video|fps|encode|glx|gl|vulkan|swiftshader" "$f" 2>/dev/null | tail -30
done
echo "===== [8] Electron 进程 (GPU 相关) ====="
ps aux 2>/dev/null | grep -iE "lptv|electron" | grep -v grep | head -10
echo "===== 诊断结束 ====="
