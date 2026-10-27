# -*- coding: utf-8 -*-
"""
LPTV 入口：Linux 版 LX TV（pywebview + 真 Chrome / DevTools Protocol）。

职责（与 Windows 版对齐）：
- 用 chromium 后端创建无边框窗口，加载央视频官方 TV 直播页
- 文档起始时注入 frontend/splash.js（LPTV 启动动画 + 品牌 favicon/标题），
  loaded 后注入 frontend/inject.js（前端全部 UI 层，零改动复用）
- 自带轻量看门狗线程监控渲染异常

与 Windows 版差异：
- 后端用自研 'chromium'（真 Chrome + CDP）替代 'edgechromium'（WebView2）。
  Linux 上 pywebview 只有 qt(QtWebEngine)/gtk(WebKit2) 两个后端，两者都没有
  H.264 解码器，央视频的 H.264/MSE 直播在其上必然黑屏 —— 所以必须驱动真 Chrome。
- 资源路径兼容 AppImage(APPDIR) / PyInstaller(_MEIPASS) / 源码三种形态
- 固定 Windows Chrome/132 UA：央视频 CMG 播放器按 UA 串判定环境，
  保留与 Windows 版一致的 UA 最稳（CMG 检测边界已单机验证）。

运行：
    python3 -m app.main            # 源码
    ./LPTV-x86_64.AppImage         # AppImage
环境变量：
    LX_NO_INJECT=1    跳过注入（调试官方页用）
    LPTV_WATCHDOG=0   关闭看门狗线程
    LPTV_GUI=chromium|qt  强制指定 pywebview 后端（Linux 默认 chromium）
    LPTV_CHROME       显式指定 Chrome 可执行文件或 .AppImage
"""
import os
import sys
import threading

import webview

from . import __version__
from .bridge import Bridge

# ---------------------------------------------------------------------------
# 资源路径
# ---------------------------------------------------------------------------
def _app_base():
    """应用根目录（app/ 与 frontend/ 的父目录）。

    兼容顺序：显式 LPTV_HOME → AppImage(APPDIR/usr/share/lptv 或 APPDIR) →
    PyInstaller(_MEIPASS) → 源码（app/ 的上一级）。AppImage 的 APPDIR 是解压根，
    应用装在 usr/share/lptv 下，直接拼 APPDIR/frontend 会静默注入失败。
    """
    explicit = os.environ.get("LPTV_HOME")
    if explicit and os.path.isdir(explicit):
        return explicit
    candidates = []
    appdir = os.environ.get("APPDIR")
    if appdir:
        candidates += [os.path.join(appdir, "usr", "share", "lptv"), appdir]
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        candidates.append(sys._MEIPASS)
    candidates.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, "frontend")):
            return c
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


APP_BASE = _app_base()
FRONTEND_DIR = os.path.join(APP_BASE, "frontend")
os.environ.setdefault("LPTV_FRONTEND", FRONTEND_DIR)

# 启动动画 + 品牌图标。chromium.py 读这两个环境变量，在文档起始时注入
# frontend/splash.js（LPTV 四字母注水），并把 icon.png 作为 favicon data URI
# 传进去 —— Chrome 据此生成窗口的 _NET_WM_ICON，远程端看到的就是 LPTV 的图标。
os.environ.setdefault("LPTV_SPLASH_JS", os.path.join(FRONTEND_DIR, "splash.js"))
os.environ.setdefault("LPTV_SPLASH_ICON", os.path.join(FRONTEND_DIR, "icon.png"))

# 央视频 TV 官方首页（?pid= 直达频道，启动竞态靠它修）
HOME_URL_BASE = "https://www.yangshipin.cn/tv/home?pid="
DEFAULT_PID = "600001859"  # CCTV-1 综合

# 固定 UA：Windows Chrome/132（与 Windows 版一致，CMG 环境判定最稳）
CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
)

# 注入前的保护包裹（防重入，inject.js 自身也有 __lxCctv 守卫）
INJECT_WRAP = "(function(){if(!window.__lxCctv){%s\n}})();"

LOG_FILE = os.path.join(
    os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"),
    "lptv", "lx.log",
)


def _has_chromium_backend():
    """自研 chromium 后端是否已注入（build_appimage.sh 会装进 site-packages）。"""
    try:
        import importlib.util
        return importlib.util.find_spec("webview.platforms.chromium") is not None
    except Exception:
        return False


def _read_state_pid():
    """读上次频道（与 bridge 共享同一状态文件）。"""
    import json
    state_file = os.path.join(
        os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"),
        "lptv", "lx.state.json",
    )
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            st = json.load(f)
        return st.get("lastPid") or DEFAULT_PID
    except Exception:
        return DEFAULT_PID


def _home_url():
    return HOME_URL_BASE + _read_state_pid()


def _load_inject_src():
    path = os.path.join(FRONTEND_DIR, "inject.js")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        print("[LX] read inject.js error:", e, file=sys.stderr)
        return ""


def _on_loaded(win):
    if os.environ.get("LX_NO_INJECT") == "1":
        print("[LX] LX_NO_INJECT=1, skip inject", file=sys.stderr)
        return
    src = _load_inject_src()
    if not src:
        return
    try:
        win.evaluate_js(INJECT_WRAP % src)
        print("[LX] inject attempt ok, len=", len(src), file=sys.stderr)
    except Exception as e:
        print("[LX] window.show error:", e, file=sys.stderr)


def _watchdog(win, stop):
    """轻量看门狗：周期性探测页面存活与视频尺寸，异常写日志。
    完整黑帧恢复逻辑在 inject.js 内（darkCount + 黑幕），这里只做旁路监控。"""
    import time
    while not stop.is_set():
        try:
            info = win.evaluate_js(
                "(function(){var v=document.querySelector('video');"
                "return v?{w:v.videoWidth,h:v.videoHeight,p:!v.paused}:null;})()"
            )
            if info is not None:
                with open(LOG_FILE, "a", encoding="utf-8") as f:
                    f.write(time.strftime("%Y-%m-%d %H:%M:%S") +
                            " watchdog " + str(info) + "\n")
        except Exception:
            pass
        stop.wait(30)


def main():
    # 保证 UTF-8
    os.environ.setdefault("PYTHONUTF8", "1")

    gui = os.environ.get("LPTV_GUI")
    if not gui:
        if sys.platform.startswith("win"):
            gui = "edgechromium"
        else:
            # Linux 默认走自研 chromium 后端（真 Chrome + DevTools Protocol）。
            # 不能默认 qt：QtWebEngine 没有 H.264 解码器，央视频在其上必然黑屏。
            gui = "chromium" if _has_chromium_backend() else "qt"

    api = Bridge()
    win = webview.create_window(
        title="LPTV",
        url=_home_url(),
        js_api=api,
        width=1280,
        height=720,
        min_size=(360, 220),
        frameless=True,
        easy_drag=True,   # inject.js 的 DRAG_GUARD 与 pywebview easy_drag 协作：非交互区可拖拽窗口
        text_select=False,
        background_color="#000000",
    )
    api._win = win

    win.events.loaded += lambda: _on_loaded(win)

    # 看门狗（默认开，LPTV_WATCHDOG=0 关闭）
    stop = threading.Event()
    wd = None
    if os.environ.get("LPTV_WATCHDOG", "1") != "0":
        wd = threading.Thread(target=_watchdog, args=(win, stop), daemon=True)
        wd.start()

    try:
        webview.start(gui=gui, debug=False)
    finally:
        stop.set()


if __name__ == "__main__":
    main()
