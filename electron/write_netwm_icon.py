#!/usr/bin/env python3
"""write_netwm_icon.py — 用 ctypes+libX11 直写窗口 _NET_WM_ICON。

背景：xprop -set _NET_WM_ICON 有硬上限（"Maximum number of elements reached
(64). List truncated"），只能写 64 个 CARDINAL，而真实图标（如 128x128）
需要 16386 个。Electron setIcon 在 xpra 无 WM 下也不落 _NET_WM_ICON 属性，
导致 xpra 报 "corrupt _NET_WM_ICON, expected ... bytes but got ..."。

本脚本绕过 xprop：用 libX11 XChangeProperty 直写完整 ARGB32 数组，
让 xpra windowicon 读到窗口自身 _NET_WM_ICON 并作为 window-icon 发给客户端。

用法: python3 write_netwm_icon.py <window_xid_hex> <argb_file>
argb_file 格式: 第一行 width，第二行 height，后续每行一个 ARGB32 值（十进制，
按 A<<24|R<<16|G<<8|B 打包）。数据由 Electron 侧 nativeImage.toBitmap()
(BGRA) 转 ARGB 生成。
"""
import sys
import ctypes
from ctypes import c_void_p, c_ulong, c_int, POINTER


def main():
    if len(sys.argv) != 3:
        print("usage: write_netwm_icon.py <xid_hex> <argb_file>", file=sys.stderr)
        return 2
    try:
        wid = int(sys.argv[1], 16)
    except ValueError:
        print("bad xid: %s" % sys.argv[1], file=sys.stderr)
        return 2
    argb_file = sys.argv[2]

    with open(argb_file, "r") as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    if len(lines) < 2:
        print("bad argb file (need width,height + pixels)", file=sys.stderr)
        return 2
    w = int(lines[0])
    h = int(lines[1])
    n = w * h
    if len(lines) < n + 2:
        print("argb file too short: %s pixels declared, %s present" %
              (n, len(lines) - 2), file=sys.stderr)
        return 2

    # data = [w, h, pixel0, ...]，每像素 ARGB32
    data = (c_ulong * (n + 2))()
    data[0] = w
    data[1] = h
    for i in range(n):
        data[i + 2] = int(lines[i + 2]) & 0xFFFFFFFF

    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = c_void_p
    dpy = x11.XOpenDisplay(None)  # 用 DISPLAY 环境变量
    if not dpy:
        print("cannot open display (DISPLAY=%r)" % __import__("os").environ.get("DISPLAY"),
              file=sys.stderr)
        return 1
    x11.XInternAtom.restype = c_ulong
    atom_icon = x11.XInternAtom(c_void_p(dpy), b"_NET_WM_ICON", 0)
    atom_cardinal = x11.XInternAtom(c_void_p(dpy), b"CARDINAL", 1)
    x11.XChangeProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_ulong,
                                    c_int, c_int, POINTER(c_ulong), c_int]
    # PropModeReplace = 0
    x11.XChangeProperty(c_void_p(dpy), c_ulong(wid), c_ulong(atom_icon),
                        c_ulong(atom_cardinal), 32, 0, data, n + 2)
    x11.XFlush(c_void_p(dpy))
    print("OK %dx%d wid=0x%x" % (w, h, wid), file=sys.stderr)
    x11.XCloseDisplay(c_void_p(dpy))
    return 0


if __name__ == "__main__":
    sys.exit(main())
