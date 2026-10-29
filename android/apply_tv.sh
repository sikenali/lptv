#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# apply_tv.sh — 固化 Android TV 模式配置（幂等，可重复运行）
#
# android/android/ 原生工程被 .gitignore 忽略（Capacitor 生成），清单改动不会入库；
# 若将来重建原生工程（capacitor init / 全新 clone），此脚本重新应用 TV 配置：
#   1. 复制 tv_banner.png -> res/drawable/（TV 桌面 banner）
#   2. 补丁 AndroidManifest.xml：
#      - <activity> android:screenOrientation="landscape"（强制横屏）
#      - <activity> android:resizeableActivity="false"（TV 非分屏）
#      - <application> android:banner="@drawable/tv_banner"
#      - <uses-feature android.software.leanback> + <uses-feature android.hardware.touchscreen>
#        （声明支持 Android TV，不强制触屏，TV 用遥控器）
#
# 用法：在 android/ 下运行（build.sh 在 capacitor sync 后自动调用）
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AND="$HERE/android"
MF="$AND/app/src/main/AndroidManifest.xml"

if [ ! -f "$MF" ]; then
  echo "apply_tv: 未找到 AndroidManifest.xml（$MF），先 capacitor init/sync" >&2
  exit 1
fi

# 1) TV banner 图片
if [ -f "$HERE/tv_banner.png" ]; then
  mkdir -p "$AND/app/src/main/res/drawable"
  cp -f "$HERE/tv_banner.png" "$AND/app/src/main/res/drawable/tv_banner.png"
fi

# 2) 清单补丁（幂等：属性已存在则跳过）
python3 - "$MF" <<'EOF'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
orig = s

def inject_activity_attr(attr):
    global s
    if attr in s:
        return
    # 在 <activity ... 的首个属性后插入该属性
    m = re.search(r'(<activity\b[^>]*?\s)([a-zA-Z_:]+=")', s, re.S)
    if m:
        s = s[:m.end(1)] + attr + ' ' + s[m.end(1):]

def inject_app_attr(attr):
    global s
    if attr in s:
        return
    m = re.search(r'(<application\b[^>]*?\s)([a-zA-Z_:]+=")', s, re.S)
    if m:
        s = s[:m.end(1)] + attr + ' ' + s[m.end(1):]

def inject_features():
    global s
    if 'android.software.leanback' in s:
        return
    # 在 <!-- Permissions --> 之前插入 uses-feature 声明
    anchor = '<!-- Permissions -->'
    feat = ('    <!-- TV 模式：声明支持 Android TV（leanback），不强制触屏（TV 用遥控器） -->\n'
            '    <uses-feature android:name="android.software.leanback" android:required="false" />\n'
            '    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />\n\n')
    if anchor in s:
        s = s.replace(anchor, feat + anchor, 1)
    else:
        s = s.replace('</manifest>', feat + '</manifest>', 1)

inject_app_attr('android:banner="@drawable/tv_banner"')
inject_activity_attr('android:resizeableActivity="false"')
inject_activity_attr('android:screenOrientation="landscape"')
inject_features()

if s != orig:
    open(p, 'w', encoding='utf-8').write(s)
    print('apply_tv: 已补丁 ' + p)
else:
    print('apply_tv: 清单已就绪（无需改动）')
EOF

echo "apply_tv: 完成"
