#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# find_widevine.sh — 定位 Widevine CDM 并放进 QtWebEngine 运行时目录
#
# 为什么需要它（DRM 一票否决项）：
#   PyQt6-WebEngine 出于开源许可**不随包分发** Widevine CDM。而央视频 CMG 播放器
#   用的是 Widevine DRM 流——没有 CDM，画面就是**纯黑屏**（页面能开、按钮能用、
#   只是没有任何画面）。所以这一步是 LPTV 在 Linux 上真正能看的前提。
#
#   QtWebEngine 按两个路径找 CDM：
#     1) QtWebEngineProcess 同目录下的 widevinecdm.so（主路径，本脚本主要做这个）
#     2) 环境变量 QTWEBENGINE_CDM_PATH 指向的目录
#   CDM 还需要同目录的 widevinecdm.xml 才能工作，两个文件要一起拷。
#
# 用法：
#   bash build/find_widevine.sh                 # 自动搜索系统里现成的 Chrome/Chromium
#   WIDEVINE_SRC=/path/to/widevinecdm.so bash build/find_widevine.sh   # 指定来源
#   VENV=.venv bash build/find_widevine.sh      # 指定虚拟环境
#
# 若系统里没有 Chrome/Chromium，请从**同架构**的官方 Chrome 安装包里取
#   Chrome-linux64/widevinecdm.so + widevinecdm.xml（或 arm64 版本）
#   然后用 WIDEVINE_SRC 指向 widevinecdm.so 所在目录。
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"

echo "==> 架构：$(uname -m)"

# ---------------------------------------------------------------------------
# 1) 找到 widevinecdm.so 来源
# ---------------------------------------------------------------------------
find_widevine() {
  # 用户显式指定优先
  if [ -n "${WIDEVINE_SRC:-}" ]; then
    if [ -f "$WIDEVINE_SRC" ]; then echo "$WIDEVINE_SRC"; return 0; fi
    if [ -f "$WIDEVINE_SRC/widevinecdm.so" ]; then echo "$WIDEVINE_SRC/widevinecdm.so"; return 0; fi
    echo "错误：WIDEVINE_SRC 指向的文件不存在：$WIDEVINE_SRC" >&2; return 1
  fi

  local cands=(
    # Chrome / Chromium / Brave / Vivaldi（x86_64 与 arm64 布局不同，全都列上）
    /opt/google/chrome/Chrome-linux64/widevinecdm.so
    /opt/chromium/chrome-linux/widevinecdm.so
    /opt/chromium/chrome-linux64/widevinecdm.so
    /opt/chromium/chromium/widevinecdm.so
    /opt/brave.com/brave/Brave-linux64/widevinecdm.so
    /usr/lib/chromium/chromium/widevinecdm.so
    /usr/lib/chromium-browser/chromium-browser/widevinecdm.so
    /usr/lib/x86_64-linux-gnu/libwidevinecdm.so
    /usr/lib/aarch64-linux-gnu/libwidevinecdm.so
    /usr/lib/chromium-browser/libwidevinecdm.so
    # snap 包装的 chromium / chrome
    /snap/chromium/current/usr/lib/chromium-browser/widevinecdm.so
    /snap/chromium/current/usr/lib/chromium-browser/libwidevinecdm.so
    /snap/google-chrome/stable/chrome-linux/widevinecdm.so
    # flatpak chrome
    /var/lib/flatpak/app/com.google.Chrome/current/x86_64/files/usr/lib/chrome-linux/widevinecdm.so
    # 用户自己的安装
    "$HOME/.cache/chromium.org/chromium/*/widevinecdm.so"
    "$HOME/.config/chromium/widevinecdm.so"
  )
  for c in "${cands[@]}"; do
    if [ -f "$c" ]; then echo "$c"; return 0; fi
  done

  # 最后一招：全盘范围有限查找
  for base in /opt /usr /home; do
    local hit
    hit="$(find "$base" -maxdepth 6 -name 'widevinecdm.so' -type f 2>/dev/null | head -1 || true)"
    if [ -n "$hit" ]; then echo "$hit"; return 0; fi
  done
  return 1
}

SRC="$(find_widevine)" || {
  echo ""
  echo "❌ 没找到 widevinecdm.so。"
  echo ""
  echo "   办法一：装个 Chromium，再重跑本脚本"
  echo "     sudo apt install -y chromium-browser     # Debian/Ubuntu"
  echo "     sudo dnf install -y chromium             # Fedora"
  echo ""
  echo "   办法二：从同架构 Chrome 安装包手动取，然后："
  echo "     WIDEVINE_SRC=/解压目录/Chrome-linux64/widevinecdm.so bash build/find_widevine.sh"
  echo ""
  echo "   注意：架构必须与本机一致（$(uname -m)）。从 Windows 版的 .exe 里解出的"
  echo "   widevine 模块是 .dll 形态，**不能**用于 Linux。"
  exit 1
}
echo "==> 找到 CDM 来源：$SRC"
SRC_DIR="$(cd "$(dirname "$SRC")" && pwd)"

# ---------------------------------------------------------------------------
# 2) 找到 QtWebEngineProcess（CDM 要放它旁边）
# ---------------------------------------------------------------------------
PROC=""
if [ -d "$VENV" ]; then
  PROC="$(find "$VENV" -name 'QtWebEngineProcess' -type f 2>/dev/null | head -1 || true)"
fi
PROC="${PROC:-$(find / -maxdepth 8 -name 'QtWebEngineProcess' -type f 2>/dev/null | head -1 || true)}"

if [ -z "$PROC" ]; then
  echo ""
  echo "❌ 找不到 QtWebEngineProcess —— 看起来还没装依赖。"
  echo "   请先跑：bash run.sh   （会建 venv 并安装 pywebview[qt]）"
  echo "   然后再跑本脚本。"
  exit 1
fi
PROC_DIR="$(cd "$(dirname "$PROC")" && pwd)"
echo "==> QtWebEngineProcess 目录：$PROC_DIR"

# ---------------------------------------------------------------------------
# 3) 复制 CDM + 必需的 xml
# ---------------------------------------------------------------------------
STAGE="$ROOT/build/widevine"
mkdir -p "$STAGE"
cp -f "$SRC" "$STAGE/"
cp -f "$SRC" "$PROC_DIR/" 2>/dev/null || true
echo "==> 已放入 QtWebEngine 运行目录"

# widevinecdm.xml 是 CDM 工作的必需伴随文件（缺了会静默失败）
if [ -f "$SRC_DIR/widevinecdm.xml" ]; then
  cp -f "$SRC_DIR/widevinecdm.xml" "$STAGE/"
  cp -f "$SRC_DIR/widevinecdm.xml" "$PROC_DIR/" 2>/dev/null || true
  echo "==> 已放入 widevinecdm.xml"
else
  echo "⚠ 来源目录没有 widevinecdm.xml：$SRC_DIR"
  echo "  CDM 没有 xml 可能无法工作，请确认取的是完整的 Chrome 目录。"
fi

# ---------------------------------------------------------------------------
# 4) 写运行时环境变量文件（run.sh / AppRun 会 source 它）
# ---------------------------------------------------------------------------
ENV_FILE="$ROOT/build/widevine.env"
cat > "$ENV_FILE" <<EOF
# 由 find_widevine.sh 生成：QtWebEngine 的 Widevine CDM 位置
export QTWEBENGINE_CDM_PATH="$PROC_DIR"
EOF
echo "==> 已写 $ENV_FILE"

echo ""
echo "完成。现在：bash run.sh  应能看到画面。"
echo "如果仍然黑屏，常见原因："
echo "  1) CDM 架构不匹配（应为 $(uname -m)）"
echo "  2) 缺 widevinecdm.xml"
echo "  3) QtWebEngine 版本与 CDM 版本差太远（换一份新一点的 Chrome 再试）"
