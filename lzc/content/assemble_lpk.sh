#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# assemble_lpk.sh — 组装最终 cloud.lazycat.catlink.lptv.lpk
#
# LPK 外层结构（懒猫约定）：
#   cloud.lazycat.catlink.lptv.lpk
#     ├── manifest.yml      包清单（懒猫平台读）
#     ├── package.yml       包元信息（名称/权限/版本）
#     ├── icon.png          应用图标
#     └── content.tar       容器内文件（run.sh / 90_lzc.conf / appimage/ …）
#
# 三种输入模式（按优先级）：
#   1) LZC_SKELETON=/path/to/extracted/content   直接用已解包的会话骨架目录
#   2) CHROME_LPK=/path/to/...chrome.lpk         解出骨架后叠加 LPTV 文件
#   3) 都没有                                     纯 LPTV 内容打包（浏览器侧 catlink
#                                                  SPA/rim 需另行叠加，见下方提示）
#
# 用法：
#   CHROME_LPK=/path/to/cloud.lazycat.catlink.chrome.lpk \
#   APP=/path/to/LPTV-x86_64.AppImage \
#   bash assemble_lpk.sh
# 产物：当前目录的 cloud.lazycat.catlink.lptv.lpk
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # content/
LPTV_LZC="$(cd "$HERE/.." && pwd)"                         # lzc/
LPTV_ROOT="$(cd "$LPTV_LZC/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

CHROME_LPK="${CHROME_LPK:-}"
APP="${APP:-LPTV-x86_64.AppImage}"
# 产物名带上版本号并默认存到 lzc/：lzc/cloud.lazycat.catlink.lptv-<version>.lpk
LPTV_VERSION="$(grep -m1 '^version:' "$LPTV_LZC/package.yml" | awk '{print $2}')"
OUT="${OUT:-$LPTV_LZC/cloud.lazycat.catlink.lptv-${LPTV_VERSION:-dev}.lpk}"
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac   # cd 进 STAGE 前固化绝对路径
ICON_SRC="${LPTV_LZC}/icon.png"
[ -f "$ICON_SRC" ] || ICON_SRC="${LPTV_ROOT}/frontend/icon.png"

find_app() {
  if [ -f "$APP" ]; then echo "$APP"; return 0; fi
  local c="$LPTV_ROOT/build/_appimage_work/LPTV-x86_64.AppImage"
  [ -f "$c" ] && { echo "$c"; return 0; }
  return 1
}

echo "==> [1/4] 准备 content 骨架"
mkdir -p "$STAGE/content"
if [ -n "${LZC_SKELETON:-}" ]; then
  echo "    骨架来源：LZC_SKELETON=$LZC_SKELETON"
  cp -a "$LZC_SKELETON/." "$STAGE/content/"
elif [ -n "$CHROME_LPK" ] && [ -f "$CHROME_LPK" ]; then
  echo "    骨架来源：$CHROME_LPK"
  tar -xf "$CHROME_LPK" -C "$STAGE" content.tar
  tar -xf "$STAGE/content.tar" -C "$STAGE/content"
else
  echo "    警告：未提供 CHROME_LPK / LZC_SKELETON，按纯 LPTV 内容打包。" >&2
  echo "    （浏览器侧 catlink SPA/rim 层缺失时远程画面不可见，见 README。）" >&2
fi

# 骨架里 chrome 专用资产处理：
# - 本包不再自带真 Chrome 引擎（省 ~200MB）。chromium 后端要驱动真 Chrome 才能解码
#   央视频的 H.264（QtWebEngine 没有 H.264，见 build/build_appimage.sh 注释），
#   但 Chrome 改为外部获取，见 launch_lptv.sh：优先复用盒子已有的
#   /lzcapp/var/apps/chrome/（chrome 应用安装），没有才首次启动下载 Google 官方 deb。
# - 微信/WPS 的启动脚本对本包无用，删掉。
# - rim 硬编码 /lzcapp/pkg/content/appimage/Google-Chrome-stable-<ver>-x86_64.AppImage
#   这个文件名用于"安装默认应用"；本包不携带它时 rim 会跳过该步，不影响会话启动。
#   如需回退到自带，构建时传 CHROME_APP_SRC 即可。
CHROME_APPIMAGE="Google-Chrome-stable-155.0.8059.39-1-x86_64.AppImage"
echo "    精简骨架：不携带真 Chrome 引擎，移除微信/WPS 资产"
rm -f "$STAGE/content/appimage/"*.AppImage \
      "$STAGE/content/launch_wechat.sh" "$STAGE/content/launch_wps.sh" \
      "$STAGE/content/setup_wechat_lan.sh" "$STAGE/content/start_default_app.sh"
if [ -n "${CHROME_APP_SRC:-}" ] && [ -f "${CHROME_APP_SRC:-}" ]; then
    echo "    （可选）放入真 Chrome 引擎：$CHROME_APP_SRC"
    mkdir -p "$STAGE/content/appimage"
    cp "$CHROME_APP_SRC" "$STAGE/content/appimage/$CHROME_APPIMAGE"
else
    echo "    不带真 Chrome 引擎：运行时复用盒子已有 Chrome 或首次启动下载 deb"
fi

echo "==> [2/4] 叠加 LPTV 专属文件"
APP="$(find_app || { echo "缺少 LPTV AppImage：先跑 bash build/build_appimage.sh" >&2; exit 1; })"
echo "    AppImage：$APP"
cp "$LPTV_LZC/manifest.yml"  "$STAGE/manifest.yml"
cp "$LPTV_LZC/package.yml"   "$STAGE/package.yml"
cp "$HERE/run.sh"            "$STAGE/content/run.sh"
cp "$HERE/launch_lptv.sh"    "$STAGE/content/launch_lptv.sh"
cp "$HERE/launch_chrome.sh"  "$STAGE/content/launch_chrome.sh"
cp "$HERE/90_lzc.conf"       "$STAGE/content/90_lzc.conf"
# 覆盖骨架自带的 catlink SPA（web/）：改远程 Chrome 文案/LPTV 标题/客户端 quality 等
if [ -d "$HERE/web" ]; then
  echo "    叠加自定义 web/（覆盖骨架 SPA）：$HERE/web"
  cp -a "$HERE/web/." "$STAGE/content/web/"
fi
mkdir -p "$STAGE/content/appimage"
cp "$APP"                    "$STAGE/content/appimage/LPTV-x86_64.AppImage"
# 注意：不能再把 LPTV AppImage 硬链接成 Chrome 的文件名——那个名字现在装的是
# 真 Chrome（rim 只认它，chromium 后端也靠它当引擎）。LPTV 自己走自己的名字。
chmod +x "$STAGE/content/run.sh" "$STAGE/content/launch_lptv.sh" \
         "$STAGE/content/launch_chrome.sh" \
         "$STAGE/content/appimage/LPTV-x86_64.AppImage"
[ -f "$STAGE/content/appimage/$CHROME_APPIMAGE" ] && \
  chmod +x "$STAGE/content/appimage/$CHROME_APPIMAGE"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$STAGE/icon.png"
else
  [ -f "$STAGE/icon.png" ] || echo "警告：无图标可用，LPK 将缺 icon.png" >&2
fi

echo "==> [3/4] 打包 content.tar"
( cd "$STAGE/content" && tar -cf "$STAGE/content.tar" . )

echo "==> [4/4] 打包外层 LPK"
( cd "$STAGE" && tar -cf "$OUT" content.tar icon.png manifest.yml package.yml )

ls -lh "$OUT"
echo "完成：$OUT"
