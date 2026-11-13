#!/usr/bin/env python3
"""send_moveresize.py — 用 ctypes+libX11 发送 _NET_WM_MOVERESIZE，触发 xpra 客户端窗口拖动。

背景：xpra 无真实 WM，Electron -webkit-app-region:drag 不落 _NET_WM_MOVERESIZE（Chromium
在 xpra 的 X 服务器上不走该路径），JS setBounds 又受 winOrigin 偏移影响不可靠。唯一稳的
是应用主动发 _NET_WM_MOVERESIZE —— 这正是 rwx(微信/Chromium CSD) 的拖动方式，xpra 服务端
(x11/models/base.py process_client_message_event) 收到后转发给客户端(Windows)执行
begin_move_drag，客户端随后跟踪鼠标完成拖动。

用法: python3 send_moveresize.py <window_xid_hex> <x_root> <y_root> <button>
  - window_xid_hex: LPTV 窗口 XID（getNativeWindowHandle 拿到的原生句柄）
  - x_root/y_root : 当前指针在根窗口的坐标（EWMH 要求，客户端用它定位起始）
  - button        : 按下的鼠标键（左=1）
按 EWMH _NET_WM_MOVERESIZE 发送到根窗口，data = {x_root, y_root, direction=0(MOVE),
button, source_indication=0(application)}。
"""
import sys
import os
import ctypes
from ctypes import c_int, c_uint, c_ulong, c_void_p, c_long, Structure, Union, byref

# X11 常量
ClientMessage = 33
SubstructureRedirectMask = 1 << 20
SubstructureNotifyMask = 1 << 19
# _NET_WM_MOVERESIZE direction: xpra 的 MoveResize.MOVE=8（注意：EWMH 规范里 MOVE=0，
# 但 xpra 客户端 (gtk3/window/base.py) 直接用 raw direction 对照 MoveResize 枚举：
#   if direction in (MoveResize.MOVE=8, MoveResize.MOVE_KEYBOARD=10) -> begin_move_drag
#   else -> begin_resize_drag（direction=0 会被当成 SIZE_TOPLEFT=左上角缩放！）
# 所以必须发 8，否则窗口会"缩放"而不是"移动"。xpra 自带示例
# (gtk/examples/initiate_moveresize.py) 也是 sendClientMessage(..., MoveResize.MOVE=8)。
MoveResizeMove = 8
SourceIndicationApplication = 0


class XClientMessageEvent(Structure):
    _fields_ = [
        ("type", c_int),
        ("serial", c_ulong),
        ("send_event", c_int),
        ("display", c_void_p),
        ("window", c_ulong),
        ("message_type", c_ulong),
        ("format", c_int),
        ("data", c_long * 5),
    ]


class XEvent(Union):
    # 足够容纳 XEvent（long pad[24] = 192 字节 @64位）
    _fields_ = [("xclient", XClientMessageEvent), ("pad", c_long * 24)]


def main():
    if len(sys.argv) != 5:
        print("usage: send_moveresize.py <window_xid_hex> <x_root> <y_root> <button>",
              file=sys.stderr)
        return 2
    try:
        wid = int(sys.argv[1], 16)
        button = int(sys.argv[4])
    except ValueError as e:
        print("bad arg: %s" % e, file=sys.stderr)
        return 2

    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = c_void_p
    dpy = x11.XOpenDisplay(None)  # 用 DISPLAY 环境变量
    if not dpy:
        print("cannot open display (DISPLAY=%r)" % os.environ.get("DISPLAY"),
              file=sys.stderr)
        return 1
    x11.XDefaultRootWindow.restype = c_ulong
    root = x11.XDefaultRootWindow(c_void_p(dpy))
    x11.XInternAtom.restype = c_ulong
    atom = x11.XInternAtom(c_void_p(dpy), b"_NET_WM_MOVERESIZE", 0)
    if not atom:
        print("_NET_WM_MOVERESIZE atom missing", file=sys.stderr)
        x11.XCloseDisplay(c_void_p(dpy))
        return 1

    # 用 XQueryPointer 取真实指针位置（xpra 下 renderer 的 screenX/screenY 不可靠）
    x11.XQueryPointer.restype = c_int
    rr = c_ulong(0)
    cr = c_ulong(0)
    rx = c_int(0)
    ry = c_int(0)
    wx = c_int(0)
    wy = c_int(0)
    bmask = c_uint(0)
    qok = x11.XQueryPointer(c_void_p(dpy), c_ulong(root),
                            byref(rr), byref(cr), byref(rx), byref(ry),
                            byref(wx), byref(wy), byref(bmask))
    x_root = rx.value if qok else int(sys.argv[2])
    y_root = ry.value if qok else int(sys.argv[3])

    ev = XEvent()
    ev.xclient.type = c_int(ClientMessage)
    ev.xclient.serial = c_ulong(0)
    ev.xclient.send_event = c_int(1)
    ev.xclient.display = c_void_p(dpy)
    ev.xclient.window = c_ulong(wid)  # 目标窗口
    ev.xclient.message_type = c_ulong(atom)
    ev.xclient.format = c_int(32)
    ev.xclient.data[0] = c_long(x_root)
    ev.xclient.data[1] = c_long(y_root)
    ev.xclient.data[2] = c_long(MoveResizeMove)
    ev.xclient.data[3] = c_long(button)
    ev.xclient.data[4] = c_long(SourceIndicationApplication)

    mask = SubstructureRedirectMask | SubstructureNotifyMask
    x11.XSendEvent.restype = c_int
    res = x11.XSendEvent(c_void_p(dpy), c_ulong(root), c_int(0), c_long(mask),
                         byref(ev))
    x11.XFlush(c_void_p(dpy))
    print("OK wid=0x%x root=0x%x pos=(%d,%d) button=%d res=%d"
          % (wid, root, x_root, y_root, button, res), file=sys.stderr)
    x11.XCloseDisplay(c_void_p(dpy))
    return 0


if __name__ == "__main__":
    sys.exit(main())
