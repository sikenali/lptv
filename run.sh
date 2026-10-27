#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# run.sh — 源码一键运行 LPTV（Linux 桌面，不需要先打 AppImage）
#
# 用法：
#   bash run.sh                          # 首次会自动建 venv + 装依赖，走真 Chrome
#   LPTV_CHROME=/path/to/chrome bash run.sh
#   PYTHON=python3.12 bash run.sh
#   LPTV_GUI=qt bash run.sh              # QtWebEngine（央视频必黑，仅调试用）
#   LX_NO_INJECT=1 bash run.sh           # 跳过注入，调试官方页
#
# 前置（x86_64 Debian/Ubuntu 为例）：
#   sudo apt install -y python3-venv python3-pip \
#       libqt6gui6 libqt6widgets6 libqt6x11extras6 libnss3 libxkbcommon0
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PY="${PYTHON:-python3}"
VENV="$HERE/.venv"

# 1) 首次运行：建 venv + 装依赖 + 装 Chromium 后端
if [ ! -x "$VENV/bin/python" ]; then
  echo "==> [1/3] 首次运行：创建虚拟环境并安装依赖"
  if ! "$PY" -c "import venv" 2>/dev/null; then
    echo "    缺少 python3-venv，请先：sudo apt install -y python3-venv python3-pip" >&2
    exit 1
  fi
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r "$HERE/build/requirements.txt"
fi

# 后端：chromium（默认，唯一能解央视频 H.264 的）/ qt / gtk
export LPTV_GUI="${LPTV_GUI:-chromium}"

# 2) 装 Chromium 后端（若 site-packages 里还没有，从 libexec 装进来）
if ! "$VENV/bin/python" -c "import webview.platforms.chromium" 2>/dev/null; then
  echo "==> [2/3] 安装 Chromium 后端 ..."
  SP="$("$VENV/bin/python" -c 'import webview,os;print(os.path.dirname(webview.__file__))')"
  mkdir -p "$SP/platforms"
  cp -f "$HERE/libexec/pywebview_chromium/chromium.py" "$SP/platforms/"
  "$VENV/bin/python" "$HERE/libexec/pywebview_chromium/patch_guilib.py" "$SP/guilib.py"
fi

# 3) 找真 Chrome：LPTV_CHROME 显式 > venv 旁 > 常见路径 > PATH
if [ -z "${LPTV_CHROME:-}" ]; then
  for c in "$HERE/libexec/chrome/chrome" "$HERE/build/_chrome/root/opt/google/chrome/chrome" \
           /opt/google/chrome/chrome; do
    [ -x "$c" ] && LPTV_CHROME="$c" && break
  done
  if [ -z "${LPTV_CHROME:-}" ]; then
    LPTV_CHROME="$(command -v google-chrome || command -v google-chrome-stable || true)"
  fi
fi
export LPTV_CHROME
if [ -n "${LPTV_CHROME:-}" ]; then
  echo "==> 浏览器引擎：$LPTV_CHROME"
else
  echo "    ⚠ 未找到 Chrome。央视频（纯 H.264-over-MSE，无 DRM）在 qt/gtk 后端上"
  echo "      必然黑屏——真 Chrome 是唯一能解码的路径。"
  echo "      先跑：bash build/build_chrome_appimage.sh"
  echo "      或设：LPTV_CHROME=/path/to/chrome"
fi

# 4) 启动
export LPTV_FRONTEND="$HERE/frontend"
echo "==> [3/3] 启动 LPTV (gui=$LPTV_GUI) ..."
exec "$VENV/bin/python" -m app.main "$@"
