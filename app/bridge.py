# -*- coding: utf-8 -*-
"""
WebView 后端 Bridge：供前端 JS 调用的 Python 接口（Linux 移植版）。

原始 Windows 版 bridge.py 是 45KB 的 Win32 ctypes 实现（最大化/全屏/浮窗靠
SetWindowPos + DWM 剥边框）。Linux 版不再需要这些——pywebview 的 Qt 后端窗口
本身就是 X11 顶层窗口，Xpra seamless 会去抓它；窗口控制改用 pywebview Window API，
浮窗/最大化/全屏在 Xpra 环境下依然有意义（用户操作的是浏览器里的远端窗口）。

铁律（与 Windows 版一致，违反会翻车）：
- 新增**实例属性**必须下划线开头（self._xxx），否则 pywebview 枚举公开属性时
  递归进 webview 内部对象无限链，loaded 事件永不触发、注入卡死。
- 新增**公开方法**不要加下划线（加下划线不会被暴露给 JS）。
- 返回值都是 JSON 可序列化 dict，约定 {"ok": bool, ...}，失败附 "error"。
"""
import base64
import json
import os
import threading
import time
import uuid

import webview

from . import __version__
from .channels import all_channels_dict, get_channel_by_pid

# ---------------------------------------------------------------------------
# 路径解析（替代 Windows 的 LOCALAPPDATA / Videos）
# ---------------------------------------------------------------------------
def _xdg_data() -> str:
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share"
    )
    p = os.path.join(base, "lptv")
    os.makedirs(p, exist_ok=True)
    return p


def _xdg_config() -> str:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config"
    )
    return base


def _videos_dir() -> str:
    # 系统用户视频文件夹（Linux 一般 ~/Videos；不存在则回退 Pictures）
    for cand in ("~/Videos", "~/Pictures"):
        p = os.path.expanduser(cand)
        if os.path.isdir(p):
            return p
    return os.path.expanduser("~/Videos")


# 可写数据根：~/.local/share/lptv（系统标准应用数据位置）
_DATA_DIR = _xdg_data()
_STATE_FILE = os.path.join(_DATA_DIR, "lx.state.json")
_RECDIR_FILE = os.path.join(_DATA_DIR, "lx.recdir.json")
_LOG_FILE = os.path.join(_DATA_DIR, "lx.log")

# 跨启动 UI 状态白名单字段
_STATE_WHITELIST = ("lastPid", "favs", "resumeLast", "res", "autoFullscreen", "fit")

# 默认保存目录（设置面板显示）
_DEFAULT_REC_DIR = os.path.join(_videos_dir(), "LPTV", "录制")
_DEFAULT_SHOT_DIR = os.path.join(_videos_dir(), "LPTV", "截图")

# get_asset_image 白名单（关于弹窗二维码等）。页面跨域引不了本地文件，经桥转 data URI。
_ASSET_WHITELIST = ("icon.png", "wechat_qr.jpg")

# frontend 目录（随包发布；AppImage 下在 APPDIR，源码下在项目根）
def _frontend_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "frontend"),                 # 源码: app/../frontend
        os.environ.get("LPTV_FRONTEND", ""),                  # 显式覆盖
        os.path.join(os.environ.get("APPDIR", ""), "frontend") if os.environ.get("APPDIR") else "",
    ]
    for c in candidates:
        if c and os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.abspath(os.path.join(here, "..", "frontend"))


_FRONTEND_DIR = _frontend_dir()

# 浮窗几何（16:9 小窗）
_FLOAT_W, _FLOAT_H = 480, 270
# 浮窗贴右下角的屏幕基准（Xpra/Xdummy 默认多为 1920x1080，可用 env 覆盖）
def _screen_size():
    try:
        w = int(os.environ.get("LPTV_SCREEN_W", "1920"))
        h = int(os.environ.get("LPTV_SCREEN_H", "1080"))
    except ValueError:
        w, h = 1920, 1080
    return w, h


class Bridge:
    """JS<->Python 桥。公开方法即 JS 可调接口；私有属性/方法均下划线开头。"""

    def __init__(self):
        self._win = None                 # 由 main.py 注入 webview Window
        self._lock = threading.Lock()    # 状态文件 / 录制句柄并发保护
        self._rec_seq = 0
        self._rec_files = {}             # rid -> (path, fileobj)
        # 窗口状态（pywebview 的 win.maximized/fullscreen 在某些版本不可靠，自己跟踪）
        self._max = False
        self._fs = False
        self._float = False
        self._pin = False
        self._float_saved = None         # (x, y, w, h, was_on_top)
        self._state_load()

    # ------------------------------------------------------------------
    # 窗口引用
    # ------------------------------------------------------------------
    def _window(self):
        if self._win is not None:
            return self._win
        if webview.windows:
            self._win = webview.windows[0]
        return self._win

    @staticmethod
    def _float_dict(ok=True, floating=None):
        """浮窗状态返回体。

        inject.js 读的是 r.floating（见 inject.js:2272/2311/2338），不是 r.float。
        两个字段都带上：floating 给前端，float 保留内部语义别名。
        """
        return {"ok": ok, "floating": bool(floating), "float": bool(floating)}

    # ------------------------------------------------------------------
    # 状态持久化
    # ------------------------------------------------------------------
    def _state_load(self):
        self._state = {}
        try:
            if os.path.isfile(_STATE_FILE):
                with open(_STATE_FILE, "r", encoding="utf-8") as f:
                    self._state = json.load(f)
        except Exception:
            self._state = {}

    def _state_save(self):
        try:
            with open(_STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(self._state, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 基础信息
    # ------------------------------------------------------------------
    def get_version(self):
        return __version__

    def get_channels(self):
        return all_channels_dict()

    def get_asset_image(self, name):
        if name not in _ASSET_WHITELIST:
            return {"ok": False, "error": "asset not allowed", "src": ""}
        path = os.path.join(_FRONTEND_DIR, name)
        if not os.path.isfile(path):
            return {"ok": False, "error": "asset missing", "src": ""}
        try:
            with open(path, "rb") as f:
                data = f.read()
        except Exception as e:
            return {"ok": False, "error": str(e), "src": ""}
        ext = os.path.splitext(name)[1].lower()
        mime = "image/png" if ext in (".png",) else (
            "image/jpeg" if ext in (".jpg", ".jpeg") else "application/octet-stream"
        )
        b64 = base64.b64encode(data).decode("ascii")
        return {"ok": True, "src": f"data:{mime};base64,{b64}"}

    # ------------------------------------------------------------------
    # 状态持久化接口
    # ------------------------------------------------------------------
    def get_ui_state(self):
        # inject.js 用 st.ok 判断是否应用跨启动状态（见 inject.js:1910 / 2862）
        out = {"ok": True}
        out.update({k: self._state.get(k) for k in _STATE_WHITELIST if k in self._state})
        return out

    def set_ui_state(self, patch):
        # patch 是 JSON 字符串（不是对象！），前端节流合并后传过来
        try:
            p = json.loads(patch) if isinstance(patch, str) else patch
        except Exception:
            return {"ok": False, "error": "bad patch"}
        with self._lock:
            for k in _STATE_WHITELIST:
                if k in p:
                    self._state[k] = p[k]
            self._state_save()
        return {"ok": True}

    # ------------------------------------------------------------------
    # 频道与取流
    # ------------------------------------------------------------------
    def play_channel(self, pid):
        ch = get_channel_by_pid(pid)
        if not ch:
            return {"ok": False, "error": "no such pid"}
        win = self._window()
        if win is None:
            return {"ok": False, "error": "no window"}
        # 页面内跳转到官方 SPA 频道路由（非 iframe 换源）
        win.evaluate_js("window.__lxCctv.switchChannel('%s')" % pid)
        return {"ok": True}

    def copy_m3u8(self, pid):
        win = self._window()
        if win is None:
            return {"ok": False, "error": "no window"}
        url = win.evaluate_js("window.__lxCctv.getPlayUrl()") or ""
        if not url:
            # 没拿到就先切台再取（兜底）
            if pid:
                win.evaluate_js("window.__lxCctv.switchChannel('%s')" % pid)
                time.sleep(1.0)
                url = win.evaluate_js("window.__lxCctv.getPlayUrl()") or ""
        if url:
            self._clipboard_write(url)
        return {"ok": bool(url), "url": url}

    def _clipboard_write(self, text):
        # 远端盒子的剪贴板（非用户本机）。尽力而为，失败不报错。
        try:
            import pyperclip  # type: ignore
            pyperclip.copy(text)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 窗口控制（pywebview Window API，替代 Win32 SetWindowPos/DWM）
    # ------------------------------------------------------------------
    def minimize(self):
        win = self._window()
        if win:
            win.minimize()
        return {"ok": True}

    def maximize_toggle(self):
        win = self._window()
        if not win:
            return {"ok": False, "maximized": self._max}
        if self._max:
            win.restore()
            self._max = False
        else:
            win.maximize()
            self._max = True
        return {"ok": True, "maximized": self._max}

    def is_maximized(self):
        return {"ok": True, "maximized": self._max}

    def fullscreen_toggle(self):
        win = self._window()
        if not win:
            return {"ok": False, "fullscreen": self._fs}
        win.toggle_fullscreen()
        self._fs = not self._fs
        return {"ok": True, "fullscreen": self._fs}

    def is_fullscreen(self):
        return {"ok": True, "fullscreen": self._fs}

    def float_toggle(self):
        win = self._window()
        if not win:
            return self._float_dict(ok=False, floating=self._float)
        if self._float:
            # 还原
            if self._float_saved:
                x, y, w, h, was_on_top = self._float_saved
                win.resize(w, h)
                win.move(x, y)
                if not was_on_top:
                    win.set_on_top(False)
                self._float_saved = None
            self._float = False
        else:
            # 缩为 16:9 小窗贴右下角 + 自动置顶
            try:
                x, y, w, h = win.x, win.y, win.width, win.height
            except Exception:
                x, y, w, h = 0, 0, 1280, 720
            self._float_saved = (x, y, w, h, self._pin)
            sw, sh = _screen_size()
            win.resize(_FLOAT_W, _FLOAT_H)
            win.move(max(0, sw - _FLOAT_W - 10), max(0, sh - _FLOAT_H - 10))
            win.set_on_top(True)
            self._float = True
        return self._float_dict(ok=True, floating=self._float)

    def is_float(self):
        return self._float_dict(ok=True, floating=self._float)

    def pin_toggle(self):
        win = self._window()
        self._pin = not self._pin
        if win:
            win.set_on_top(self._pin)
        return {"ok": True, "pinned": self._pin}

    def pin_state(self):
        return {"ok": True, "pinned": self._pin}

    def resize_win(self, w, h):
        win = self._window()
        if win:
            win.resize(max(int(w), 360), max(int(h), 220))
        return {"ok": True}

    def drag_win(self):
        win = self._window()
        if win:
            win.start_drag()
        return {"ok": True}

    def win_pos(self):
        win = self._window()
        if not win:
            return {"ok": False}
        try:
            return {"ok": True, "x": int(win.x), "y": int(win.y)}
        except Exception:
            return {"ok": False}

    def move_win(self, x, y):
        win = self._window()
        if win:
            win.move(int(x), int(y))
        return {"ok": True}

    def close_window(self):
        win = self._window()
        if win:
            win.destroy()
        return {"ok": True}

    # ------------------------------------------------------------------
    # 录制 / 截图
    # ------------------------------------------------------------------
    def _dir_for(self, kind):
        # kind: 'rec'|'shot' -> 实际目录（自定义优先, 默认兜底）
        custom = {}
        try:
            if os.path.isfile(_RECDIR_FILE):
                with open(_RECDIR_FILE, "r", encoding="utf-8") as f:
                    custom = json.load(f)
        except Exception:
            custom = {}
        if kind == "rec":
            return custom.get("rec") or _DEFAULT_REC_DIR
        return custom.get("shot") or _DEFAULT_SHOT_DIR

    def rec_open(self, chname):
        with self._lock:
            self._rec_seq += 1
            rid = "%s_%d" % (time.strftime("%Y%m%d_%H%M%S"), self._rec_seq)
            d = self._dir_for("rec")
            try:
                os.makedirs(d, exist_ok=True)
            except Exception:
                d = _DATA_DIR
            path = os.path.join(d, "%s.webm" % rid)
            try:
                fo = open(path, "wb")
            except Exception as e:
                return {"ok": False, "error": str(e)}
            self._rec_files[rid] = (path, fo)
        # inject.js 读取 r.id（不是 rec_id）
        return {"ok": True, "id": rid}

    def rec_append(self, rid, b64):
        with self._lock:
            ent = self._rec_files.get(rid)
            if not ent:
                return {"ok": False, "error": "no such rec"}
            path, fo = ent
            try:
                # 前端 MediaRecorder timeslice 产出 base64 分块，可能带 data: 前缀
                if "," in b64:
                    b64 = b64.split(",", 1)[1]
                # validate=True：非法字符直接报错，而不是静默丢弃——否则损坏的分块
                # 会被悄悄截断成坏 webm 且前端毫无感知。
                fo.write(base64.b64decode(b64, validate=True))
            except Exception as e:
                return {"ok": False, "error": str(e)}
        return {"ok": True}

    def rec_close(self, rid):
        with self._lock:
            ent = self._rec_files.pop(rid, None)
            if not ent:
                return {"ok": False, "error": "no such rec"}
            path, fo = ent
            try:
                fo.close()
            except Exception:
                pass
        return {"ok": True, "path": path}

    def rec_list(self):
        d = self._dir_for("rec")
        items = []
        try:
            for fn in os.listdir(d):
                if fn.endswith(".webm"):
                    fp = os.path.join(d, fn)
                    items.append(
                        {"name": fn, "size": os.path.getsize(fp),
                         "mtime": os.path.getmtime(fp)}
                    )
        except Exception:
            pass
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return {"ok": True, "items": items}

    def shot_save(self, chname, b64):
        # 保存一张 PNG 截图（前端 canvas.toDataURL 产出）, 返回文件名
        if not b64:
            return {"ok": False, "error": "empty image"}
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            data = base64.b64decode(b64, validate=True)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not data:
            return {"ok": False, "error": "empty image"}
        d = self._dir_for("shot")
        try:
            os.makedirs(d, exist_ok=True)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        name = "LPTV_%s_%s.png" % (
            (chname or "直播").replace("/", "_"),
            time.strftime("%Y%m%d_%H%M%S"),
        )
        path = os.path.join(d, name)
        try:
            with open(path, "wb") as f:
                f.write(data)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "name": name, "path": path}

    def get_save_dirs(self):
        return {"ok": True, "rec": self._dir_for("rec"), "shot": self._dir_for("shot")}

    def pick_save_dir(self, kind):
        # 弹出文件夹选择对话框, kind: rec|shot, 选完即持久化。
        # 远端/无显示环境下没有原生对话框，回退为保持当前目录。
        win = self._window()
        cur = self._dir_for(kind)
        new_dir = None
        if win is not None:
            try:
                sel = win.create_file_dialog(webview.FOLDER_DIALOG)
                if sel:
                    new_dir = sel if isinstance(sel, str) else sel[0]
            except Exception:
                new_dir = None
        if not new_dir:
            new_dir = cur
        custom = {}
        try:
            if os.path.isfile(_RECDIR_FILE):
                with open(_RECDIR_FILE, "r", encoding="utf-8") as f:
                    custom = json.load(f)
        except Exception:
            custom = {}
        custom[kind] = new_dir
        try:
            with open(_RECDIR_FILE, "w", encoding="utf-8") as f:
                json.dump(custom, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return {"ok": True, "dir": new_dir}

    def open_save_dir(self, kind):
        d = self._dir_for(kind)
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass
        # 远端盒子无法打开用户本机资源管理器；尽力用 xdg-open（盒子侧）。
        try:
            import subprocess
            subprocess.Popen(["xdg-open", d], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        except Exception:
            pass
        return {"ok": True, "dir": d}

    # ------------------------------------------------------------------
    # 自启动（Linux: XDG autostart，替代 Windows 注册表 Run 键）
    # ------------------------------------------------------------------
    def _autostart_desktop_path(self):
        return os.path.join(_xdg_config(), "autostart", "lptv.desktop")

    def _self_exec(self):
        # 打包 AppImage 直接指向自身；源码运行时指向 python -m app.main
        exe = os.environ.get("APPIMAGE") or os.path.abspath(sys_argv0())
        if exe.lower().endswith(".py") or os.path.isdir(exe):
            # 源码：用 python -m app.main
            py = _which_python()
            root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            return '%s -m app.main' % py, root
        return exe, os.path.dirname(exe)

    def autostart_state(self):
        on = os.path.isfile(self._autostart_desktop_path())
        # inject.js 读的是 r.enabled（见 inject.js:1915），on 是内部语义别名，两个都返回
        return {"ok": True, "enabled": on, "on": on}

    def autostart_set(self, on):
        dp = self._autostart_desktop_path()
        if on:
            os.makedirs(os.path.dirname(dp), exist_ok=True)
            exe, cwd = self._self_exec()
            content = (
                "[Desktop Entry]\n"
                "Type=Application\n"
                "Name=LPTV\n"
                "Comment=LPTV 远程电视\n"
                "Exec=%s\n"
                "Path=%s\n"
                "Terminal=false\n"
                "X-GNOME-Autostart-enabled=true\n"
                % (exe, cwd)
            )
            try:
                with open(dp, "w", encoding="utf-8") as f:
                    f.write(content)
            except Exception as e:
                return {"ok": False, "on": False, "error": str(e)}
            return {"ok": True, "on": True}
        else:
            try:
                if os.path.isfile(dp):
                    os.remove(dp)
            except Exception as e:
                return {"ok": False, "on": True, "error": str(e)}
            return {"ok": True, "on": False}


# 与 autostart 相关的辅助（放模块级，避免污染 js_api 公开方法）
def sys_argv0():
    import sys
    return sys.argv[0]


def _which_python():
    import sys
    return sys.executable or "python3"


if __name__ == "__main__":
    b = Bridge()
    print("version:", b.get_version())
    print("channels:", len(b.get_channels()))
    print("save dirs:", b.get_save_dirs())
