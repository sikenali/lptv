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
# 内容来源（按优先级）：
#   1) LZC_SKELETON=/path/to/extracted/content   显式指定已解包的骨架目录（外部覆盖）
#   2) CHROME_LPK=/path/to/...chrome.lpk         从 chrome lpk 解出骨架再叠加 LPTV 文件
#   3) 默认：lzc/content/ 自身已是完整内容源（CDE 骨架已并入本目录，无独立 skeleton 目录）
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
# rim rlptv 安装器（lptv_install.go）按 LPTV.AppImage 固定名读取安装；
# Electron 官方构建自带 H.264，YSP 直接能播，无需真 Chrome 引擎。
# 产物名带上版本号并默认存到 lzc/：lzc/cloud.lazycat.catlink.lptv-<version>.lpk
LPTV_VERSION="$(grep -m1 '^version:' "$LPTV_LZC/package.yml" | awk '{print $2}')"
OUT="${OUT:-$LPTV_LZC/cloud.lazycat.catlink.lptv-${LPTV_VERSION:-dev}.lpk}"
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac   # cd 进 STAGE 前固化绝对路径
ICON_SRC="${LPTV_LZC}/icon.png"
[ -f "$ICON_SRC" ] || ICON_SRC="${LPTV_ROOT}/frontend/icon.png"

find_app() {
  if [ -n "$APP" ] && [ -f "$APP" ]; then echo "$APP"; return 0; fi
  # 唯一产物来源：electron/dist/LPTV-<os>-<arch>-<version>.AppImage（build_electron.sh）。
  # 按 mtime 取最新构建的（ls -t），避免 ls 默认按文件名排序误选旧版本；再兜底固定名。
  local c
  c="$(ls -t "$LPTV_ROOT/electron/dist"/LPTV-*.AppImage 2>/dev/null | head -1 || true)"
  [ -f "$c" ] || c="$LPTV_ROOT/electron/dist/LPTV.AppImage"
  [ -f "$c" ] && { echo "$c"; return 0; }
  return 1
}

echo "==> [1/4] 准备 content"
mkdir -p "$STAGE/content"
# 内容来源（按优先级）：LZC_SKELETON 外部骨架 > CHROME_LPK 解包 > 默认 lzc/content 自身。
# lzc/content 已并入完整 CDE 骨架（rim/cde-supervisor/drop/dummyscreen/gtk-bookmark/
# qt-bookmark.ini 等），不再依赖独立的 lzc/skeleton 目录。

# ---- 可选：rim 源码比预编译二进制新时，自动重编译（避免沿用过期二进制）----
# 适用场景：回到 Linux x86_64 上改了 lzc-cde/lpk/rim 源码后重新出包。
# 条件：本机有 go，且能找到 rim 源码（默认 ../lzc-cde/lpk/rim，可用 RIM_SRC 覆盖）。
# 产物：lzc/content/rim + lzc/content/cde-supervisor（linux/amd64 静态）。
# 任何失败都回退到 lzc/content 下已有的预编译二进制，不影响出包。
rebuild_rlptv_binaries() {
  local rim_src="${RIM_SRC:-$LPTV_LZC/../lzc-cde/lpk/rim}"
  if [ ! -f "$rim_src/go.mod" ] || ! command -v go >/dev/null 2>&1; then
    return 0
  fi
  if [ -x "$HERE/rim" ] && ! find "$rim_src" -name '*.go' -newer "$HERE/rim" 2>/dev/null | grep -q .; then
    return 0   # 预编译二进制已是最新，跳过
  fi
  echo "==> [0/4] 检测到 rim 源码更新，重新编译 linux/amd64 静态二进制"
  # 必须在 rim 源码目录内编译（go 需模块上下文，传绝对路径会从 cwd 找模块而失败）
  if ( cd "$rim_src" && \
       CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$HERE/rim" . ) 2>/dev/null \
     && ( cd "$rim_src" && \
       CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
         -o "$HERE/cde-supervisor" ./cmd/cde-supervisor ) 2>/dev/null; then
    chmod +x "$HERE/rim" "$HERE/cde-supervisor"
    echo "    已更新：$HERE/rim, $HERE/cde-supervisor"
  else
    echo "    警告：rim 重编译失败，将沿用 lzc/content 下的预编译二进制" >&2
  fi
}
rebuild_rlptv_binaries
if [ -n "${LZC_SKELETON:-}" ]; then
  echo "    内容来源：LZC_SKELETON=$LZC_SKELETON"
  cp -a "$LZC_SKELETON/." "$STAGE/content/"
elif [ -n "$CHROME_LPK" ] && [ -f "$CHROME_LPK" ]; then
  echo "    内容来源：$CHROME_LPK"
  tar -xf "$CHROME_LPK" -C "$STAGE" content.tar
  tar -xf "$STAGE/content.tar" -C "$STAGE/content"
else
  echo "    内容来源：lzc/content/（CDE 骨架已并入，无独立 skeleton 目录）"
  cp -a "$HERE/." "$STAGE/content/"
  # 构建脚本/中间产物不入包
  rm -f "$STAGE/content/assemble_lpk.sh" "$STAGE/content/content.tar"
fi

# 骨架里 chrome 专用资产处理：
# - 本包只带 LPTV（Electron）单 AppImage，不携带真 Chrome 引擎（Electron 官方构建
#   自带 H.264 编解码器，YSP直接能播，无需外部 Chrome）。清掉骨架里任何残留
#   AppImage，稍后仅以 LPTV.AppImage 名提供 LPTV 二进制，供 rim rlptv 安装。
# - 微信/WPS 的启动脚本对本包无用，删掉。
echo "    精简骨架：仅 LPTV（Electron），移除残留 Chrome/微信/WPS 资产"
rm -f "$STAGE/content/appimage/"*.AppImage \
      "$STAGE/content/launch_chrome.sh" \
      "$STAGE/content/launch_wechat.sh" "$STAGE/content/launch_wps.sh" \
      "$STAGE/content/setup_wechat_lan.sh" "$STAGE/content/start_default_app.sh"

echo "==> [2/4] 叠加 LPTV 专属文件"
APP="$(find_app || { echo "缺少 LPTV AppImage：先跑 bash build/build_electron.sh" >&2; exit 1; })"
echo "    AppImage：$APP"
cp "$LPTV_LZC/manifest.yml"  "$STAGE/manifest.yml"
cp "$LPTV_LZC/package.yml"   "$STAGE/package.yml"
cp "$HERE/run.sh"            "$STAGE/content/run.sh"
cp "$HERE/launch_lptv.sh"    "$STAGE/content/launch_lptv.sh"
cp "$HERE/90_lzc.conf"       "$STAGE/content/90_lzc.conf"
# rlptv 任务栏图标（hicolor 各尺寸），run.sh 安装到 /usr/share/icons/hicolor/*/apps/
if [ -d "$HERE/icons" ]; then
  echo "    叠加任务栏图标：$HERE/icons"
  cp -a "$HERE/icons" "$STAGE/content/icons"
fi
# 覆盖骨架自带的 catlink SPA（web/）：改远程 Chrome 文案/LPTV 标题/客户端 quality 等
if [ -d "$HERE/web" ]; then
  echo "    叠加自定义 web/（覆盖骨架 SPA）：$HERE/web"
  cp -a "$HERE/web/." "$STAGE/content/web/"
  # 清理骨架 SPA 残留的 chrome/rwx/rwps 资产（我们的 index.html 不引用，纯冗余）
  rm -f "$STAGE/content/web/assets/chrome-CS-wuLhD.png" \
        "$STAGE/content/web/assets/index-Bq9TiW7R.js" \
        "$STAGE/content/web/assets/wechat-remote-logo@4x-4RPD-0qC.png" \
        "$STAGE/content/web/assets/wps-BA1xOMU5.png"
fi
# 覆盖骨架自带的 rim / cde-supervisor：必须用我们重新编译的、认得 rlptv 的版本，
# 否则官方 rim 遇到 CATLINK_APP_ID=rlptv 会直接退出或路由 404，SPA 永远 not ready。
for bin in rim cde-supervisor; do
  if [ -f "$HERE/$bin" ]; then
    echo "    覆盖二进制：$bin（rlptv-aware）"
    cp "$HERE/$bin" "$STAGE/content/$bin"
  fi
done
# LPTV 以固定名 LPTV.AppImage 进包：rim rlptv 安装器（lptv_install.go）按
# /lzcapp/pkg/content/appimage/LPTV.AppImage 读取并安装，无 chrome 符号链接。
# launch_lptv.sh 按 LPTV*.AppImage 前缀匹配，固定名也能命中。
LPTV_APPIMAGE_NAME="LPTV.AppImage"
mkdir -p "$STAGE/content/appimage"
cp "$APP"                    "$STAGE/content/appimage/$LPTV_APPIMAGE_NAME"
chmod +x "$STAGE/content/run.sh" "$STAGE/content/launch_lptv.sh" \
         "$STAGE/content/rim" "$STAGE/content/cde-supervisor" \
         "$STAGE/content/appimage/$LPTV_APPIMAGE_NAME"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$STAGE/icon.png"
else
  [ -f "$STAGE/icon.png" ] || echo "警告：无图标可用，LPK 将缺 icon.png" >&2
fi

echo "==> [3/4] 打包 content.tar"
# 注意：Windows NTFS 不认 Unix 可执行位，`chmod +x` 在打包前可能不生效，
# 因此这里用 tar --mode=0755 强制把容器内文件设为可执行（rim/cde-supervisor/
# run.sh 等必须可执行，否则盒子端 rim 无法启动）。data 文件 755 无害。
( cd "$STAGE/content" && tar --mode=0755 -cf "$STAGE/content.tar" . )

echo "==> [4/4] 打包外层 LPK"
( cd "$STAGE" && tar -cf "$OUT" content.tar icon.png manifest.yml package.yml )

ls -lh "$OUT"
echo "完成：$OUT"
