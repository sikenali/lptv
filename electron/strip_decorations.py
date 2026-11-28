#!/usr/bin/env python3
"""strip_decorations.py — 用 ctypes+libX11 给 LPTV 窗口写 _MOTIF_WM_HINTS(decorations=0)。

背景：CDE/xpra 服务端会读窗口的 _MOTIF_WM_HINTS.decorations 来决定是否给远程窗口
画标题栏（xpra x11/models/window.py `_handle_motif_wm_hints_change` →
window metadata "decorations"）。Electron frame:false 在部分 Xdummy/xpra 环境里仍被
当成"有装饰"，客户端于是给 LPTV 窗口画出 CDE 顶栏。这里显式写 decorations=0，
xpra 发给客户端的 metadata 就是 decorations=false，HTML5/原生客户端都不再画标题栏/
边框，只剩全屏应用画面。应用自身顶栏的拖动条仍走 begin_window_drag。

用法: python3 strip_decorations.py <window_xid_hex>
  - window_xid_hex: LPTV 窗口 XID（getNativeWindowHandle 拿到的原生句柄）
"""
import sys
import os
import ctypes
from ctypes import c_int, c_ulong, c_void_p, c_long, Structure, byref


class MotifWmHints(Structure):
    # mwmh.h: flags, functions, decorations, input_mode, status
    _fields_ = [
        ("flags", c_ulong),
        ("functions", c_ulong),
        ("decorations", c_ulong),
        ("input_mode", c_long),
        ("status", c_ulong),
    ]


def _log(line):
    print(line, file=sys.stderr)
    logpath = os.environ.get("LPTV_DECOR_LOG", "")
    if logpath:
        try:
            with open(logpath, "a") as f:
                f.write(line + "\n")
        except Exception:
            pass


def main():
    if len(sys.argv) != 2:
        _log("usage: strip_decorations.py <window_xid_hex>")
        return 2
    try:
        wid = int(sys.argv[1], 16)
    except ValueError as e:
        _log("bad arg: %s" % e)
        return 2

    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    dpy = x11.XOpenDisplay(None)
    if not dpy:
        _log("cannot open display (DISPLAY=%r)" % os.environ.get("DISPLAY"))
        return 1

    x11.XInternAtom.restype = c_ulong
    x11.XInternAtom.argtypes = [c_void_p, ctypes.c_char_p, c_int]
    atom = x11.XInternAtom(dpy, b"_MOTIF_WM_HINTS", 0)
    if not atom:
        _log("_MOTIF_WM_HINTS atom missing")
        x11.XCloseDisplay(dpy)
        return 1

    # flags: MWM_HINTS_DECORATIONS = 2。decorations=0 → 无标题栏/边框。
    hints = MotifWmHints()
    hints.flags = 2
    hints.functions = 0
    hints.decorations = 0
    hints.input_mode = 0
    hints.status = 0

    x11.XChangeProperty.restype = c_int
    x11.XChangeProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_ulong,
                                    c_int, c_int, c_void_p, c_int]
    # PropModeReplace = 0, format = 32, nelements = 5
    res = x11.XChangeProperty(dpy, c_ulong(wid), c_ulong(atom), c_ulong(atom),
                              c_int(32), c_int(0), byref(hints), c_int(5))
    x11.XFlush(dpy)
    _log("OK wid=0x%x flags=2 decorations=0 res=%d" % (wid, res))
    x11.XCloseDisplay(dpy)
    return 0


if __name__ == "__main__":
    sys.exit(main())
