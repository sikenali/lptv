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
#   APP=/path/to/LPTV.AppImage \
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
APP="${APP:-LPTV.AppImage}"
# 产物名带上版本号并默认存到 lzc/：lzc/cloud.lazycat.catlink.lptv-<version>.lpk
LPTV_VERSION="$(grep -m1 '^version:' "$LPTV_LZC/package.yml" | awk '{print $2}')"
OUT="${OUT:-$LPTV_LZC/cloud.lazycat.catlink.lptv-${LPTV_VERSION:-dev}.lpk}"
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac   # cd 进 STAGE 前固化绝对路径
ICON_SRC="${LPTV_LZC}/icon.png"
[ -f "$ICON_SRC" ] || ICON_SRC="${LPTV_ROOT}/frontend/icon.png"

find_app() {
  if [ -f "$APP" ]; then echo "$APP"; return 0; fi
  local c="$LPTV_ROOT/electron/dist/LPTV.AppImage"
  [ -f "$c" ] && { echo "$c"; return 0; }
  return 1
}

echo "==> [1/4] 准备 content 骨架"
mkdir -p "$STAGE/content"
# 默认骨架：项目内持久保存的 lzc/skeleton/（由本脚本的「保存骨架」步骤生成）。
# 没有它才回退到外部 CHROME_LPK / LZC_SKELETON / 纯内容模式。
DEFAULT_SKELETON="$LPTV_LZC/skeleton"
if [ -n "${LZC_SKELETON:-}" ]; then
  echo "    骨架来源：LZC_SKELETON=$LZC_SKELETON"
  cp -a "$LZC_SKELETON/." "$STAGE/content/"
elif [ -n "$CHROME_LPK" ] && [ -f "$CHROME_LPK" ]; then
  echo "    骨架来源：$CHROME_LPK"
  tar -xf "$CHROME_LPK" -C "$STAGE" content.tar
  tar -xf "$STAGE/content.tar" -C "$STAGE/content"
elif [ -f "$DEFAULT_SKELETON/cde-supervisor" ] && [ -f "$DEFAULT_SKELETON/rim" ]; then
  echo "    骨架来源：项目内 lzc/skeleton/"
  cp -a "$DEFAULT_SKELETON/." "$STAGE/content/"
else
  echo "    警告：未提供 CHROME_LPK / LZC_SKELETON，且 lzc/skeleton/ 不存在，按纯 LPTV 内容打包。" >&2
  echo "    （浏览器侧 catlink SPA/rim 层缺失时远程画面不可见，见 README。）" >&2
fi

# 骨架里 chrome 专用资产处理：
# - 本包只带 LPTV（Electron）单 AppImage，不携带真 Chrome 引擎（Electron 官方构建
#   自带 H.264 编解码器，央视频直接能播，无需外部 Chrome）。清掉骨架里任何残留
#   AppImage，避免 rim 误装成 chrome。
# - 微信/WPS 的启动脚本对本包无用，删掉。
echo "    精简骨架：仅 LPTV（Electron），移除残留 Chrome/微信/WPS 资产"
rm -f "$STAGE/content/appimage/"*.AppImage \
      "$STAGE/content/launch_wechat.sh" "$STAGE/content/launch_wps.sh" \
      "$STAGE/content/setup_wechat_lan.sh" "$STAGE/content/start_default_app.sh"

echo "==> [2/4] 叠加 LPTV 专属文件"
APP="$(find_app || { echo "缺少 LPTV AppImage：先跑 bash build/build_electron.sh" >&2; exit 1; })"
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
cp "$APP"                    "$STAGE/content/appimage/LPTV.AppImage"
chmod +x "$STAGE/content/run.sh" "$STAGE/content/launch_lptv.sh" \
         "$STAGE/content/launch_chrome.sh" \
         "$STAGE/content/appimage/LPTV.AppImage"
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
