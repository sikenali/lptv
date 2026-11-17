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

# 3) 品牌名（懒猫微视）: Capacitor 重建工程会还原成 LPTV, 这里幂等改回
STR="$AND/app/src/main/res/values/strings.xml"
if [ -f "$STR" ]; then
  sed -i 's|<string name="app_name">[^<]*</string>|<string name="app_name">懒猫微视</string>|' "$STR"
  sed -i 's|<string name="title_activity_main">[^<]*</string>|<string name="title_activity_main">懒猫微视</string>|' "$STR"
fi

# 4) launcher 图标: 从 frontend/icon.png 重新生成各密度 mipmap（Capacitor 默认图标非 LPTV）
SRC_ICON="$HERE/../frontend/icon.png"
if [ -f "$SRC_ICON" ] && command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" 2>/dev/null; then
  python3 - "$SRC_ICON" "$AND/app/src/main/res" <<'EOF'
import sys, os
from PIL import Image, ImageDraw, ImageOps
src = sys.argv[1]; res = sys.argv[2]
base = Image.open(src).convert('RGBA')
sizes = {'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}
for dpi,s in sizes.items():
    d = f'{res}/mipmap-{dpi}'
    os.makedirs(d, exist_ok=True)
    ic = base.resize((s,s), Image.LANCZOS); ic.save(f'{d}/ic_launcher.png')
    mask = Image.new('L',(s,s),0); ImageDraw.Draw(mask).ellipse((0,0,s,s),fill=255)
    fit = ImageOps.fit(base,(s,s),Image.LANCZOS)
    out = Image.new('RGBA',(s,s),(0,0,0,0)); out.paste(fit,(0,0),mask)
    out.save(f'{d}/ic_launcher_round.png')
    fs = int(s*1.5); fg = Image.new('RGBA',(fs,fs),(0,0,0,0))
    inner = base.resize((int(fs*0.6),int(fs*0.6)), Image.LANCZOS)
    fg.paste(inner,((fs-inner.width)//2,(fs-inner.height)//2),inner)
    fg.save(f'{d}/ic_launcher_foreground.png')
print('apply_tv: launcher 图标已从 frontend/icon.png 生成')
EOF
else
  echo "apply_tv: 跳过图标生成（无 PIL 或缺 frontend/icon.png）" >&2
fi

echo "apply_tv: 完成"
