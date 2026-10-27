# -*- coding: utf-8 -*-
"""
test_bridge.py — LPTV 桥逻辑的可复现离线验证

为什么需要它：
  LPTV 真正的功能验证需要 Linux 桌面 + X 显示 + Widevine + 央视频页面，
  这些在 CI / 无头 / 非 Linux 环境里都跑不了。本脚本把**不依赖 GUI 的部分**
  全部覆盖：频道数据、状态持久化、录制/截图落盘、资源图、自启动、窗口控制的
  无窗口优雅降级 —— 以及最重要的**桥契约**（inject.js 读哪些字段、桥返回哪些
  字段）。桥契约一旦错位，前端就是静默失效（图标不亮、状态不回填、功能失效），
  且不会报错，这正是本测试要防的。

运行（无需 GUI、无需显示器、无需 pywebview，会自动 mock）：
    cd LPTV && python3 tests/test_bridge.py
    cd LPTV && python3 -m pytest tests/ -q     # 也兼容 pytest

不写任何东西到真实用户目录：所有 XDG 路径被重定向到临时目录，退出即清理。
"""
import base64
import os
import shutil
import sys
import tempfile
import types

# ---------------------------------------------------------------------------
# 环境准备：必须在 import app.bridge 之前完成
#   1) 把 XDG 路径指到临时目录，避免污染真实用户数据
#   2) mock webview（bridge.py 顶层 import webview，但逻辑路径不需要它）
# ---------------------------------------------------------------------------
_TMP = tempfile.mkdtemp(prefix="lptv-test-")
os.environ["XDG_DATA_HOME"] = os.path.join(_TMP, "data")
os.environ["XDG_CONFIG_HOME"] = os.path.join(_TMP, "cfg")

if "webview" not in sys.modules:
    _wv = types.ModuleType("webview")
    _wv.__version__ = "mock"
    _wv.windows = []
    _wv.FOLDER_DIALOG = "folder"
    sys.modules["webview"] = _wv

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import bridge as bridge_mod  # noqa: E402
from app import channels as channels_mod  # noqa: E402

# 前端 MediaRecorder / canvas 产出的真实 base64 片段（带 data: 前缀，模拟实际入参）
_PNG_B64 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

_checks = []


def check(name, cond, detail=""):
    _checks.append((name, bool(cond), detail))


def main():
    b = bridge_mod.Bridge()

    # -- 频道数据库 -------------------------------------------------------
    chs = b.get_channels()
    check("频道总数 59", len(chs) == 59, "实际 %d" % len(chs))
    check("频道字段齐全", set(chs[0]) >= {"name", "pid", "cnlid", "category", "official"}, str(set(chs[0])))
    cats = {c: len(channels_mod.channels_by_category(c)) for c in channels_mod.CATEGORIES}
    check("分类 央视21/CGTN6/卫视32", cats == {"央视": 21, "CGTN": 6, "卫视": 32}, str(cats))

    c14 = channels_mod.get_channel_by_pid("600001809")
    check("CCTV-14 无 cnlid", c14 is not None and c14.cnlid == "", repr(getattr(c14, "cnlid", None)))
    c16 = channels_mod.get_channel_by_pid("600098637")
    check("CCTV-16 消歧 official=CCTV16",
          c16 is not None and c16.official == "CCTV16", repr(getattr(c16, "official", None)))
    check("未知 pid 返回 None", channels_mod.get_channel_by_pid("000000000") is None)

    # -- 版本 -------------------------------------------------------------
    v = b.get_version()
    check("版本字符串", isinstance(v, str) and v.startswith("1."), repr(v))

    # -- 状态持久化：跨启动白名单 + ok 字段 ------------------------------
    ok = b.set_ui_state('{"lastPid":"600001859","favs":["600001859"],"fit":"cover",'
                        '"autoFullscreen":true,"resumeLast":false,"res":[],"evil":1}')
    check("set_ui_state 接受 JSON 字符串", ok.get("ok") is True, str(ok))
    st = b.get_ui_state()
    check("get_ui_state 含 ok（inject.js:1910/2862 靠它判活）", st.get("ok") is True, str(st))
    check("状态白名单字段落盘", st.get("lastPid") == "600001859", str(st))
    check("fit 在白名单内（否则画面模式无法跨启动恢复）", st.get("fit") == "cover", str(st))
    check("白名单外的 key 被丢弃", "evil" not in st, str(st))
    check("set_ui_state 坏 JSON 返回 ok=False",
          b.set_ui_state("{not json").get("ok") is False)
    b2 = bridge_mod.Bridge()  # 新实例重新读盘，验证真的落盘了
    check("状态跨实例持久化", b2.get_ui_state().get("lastPid") == "600001859")

    # -- 资源图白名单 -----------------------------------------------------
    check("get_asset_image 拒绝未授权资源", b.get_asset_image("/etc/passwd").get("ok") is False)
    ai = b.get_asset_image("icon.png")
    check("get_asset_image 返回 data URI", ai.get("ok") and ai.get("src", "").startswith("data:image/png;base64,"),
          str(len(ai.get("src", ""))))
    check("get_asset_image 白名单外图片名被拒", b.get_asset_image("evil.png").get("ok") is False)

    # -- 保存目录 ---------------------------------------------------------
    d = b.get_save_dirs()
    check("get_save_dirs 返回 rec/shot", d.get("ok") and "rec" in d and "shot" in d, str(d))
    check("rec/shot 目录互不相同", d["rec"] != d["shot"])
    pd = b.pick_save_dir("rec")
    check("pick_save_dir 无窗口仍 ok（回退当前目录）", pd.get("ok") and "dir" in pd, str(pd))
    od = b.open_save_dir("shot")
    check("open_save_dir 无 xdg-open 仍 ok", od.get("ok") and "dir" in od, str(od))

    # -- 录制管线 ---------------------------------------------------------
    ro = b.rec_open("CCTV-1")
    check("rec_open 返回 ok+id（inject.js 读 r.id）", ro.get("ok") and ro.get("id"), str(ro))
    rid = ro["id"]
    check("rec_append 未知 rid 报错", b.rec_append("nope", "AA==").get("ok") is False)
    check("rec_append 首块 ok", b.rec_append(rid, _PNG_B64).get("ok") is True)
    check("rec_append 纯 base64（无 data: 前缀）也 ok", b.rec_append(rid, "AA==").get("ok") is True)
    check("rec_append 坏 base64 返回 ok=False", b.rec_append(rid, "!!!").get("ok") is False)
    rc = b.rec_close(rid)
    check("rec_close 返回 ok+path", rc.get("ok") and os.path.isfile(rc["path"]), str(rc))
    check("录制文件有内容", os.path.getsize(rc["path"]) > 0, str(os.path.getsize(rc["path"])))
    check("rec_close 重复调用报错", b.rec_close(rid).get("ok") is False)
    lst = b.rec_list()
    check("rec_list 列出已录制文件", lst.get("ok") and len(lst["items"]) >= 1, str(len(lst.get("items", []))))

    # -- 截图 -------------------------------------------------------------
    ss = b.shot_save("CCTV-1", _PNG_B64)
    check("shot_save 返回 ok+name+path（inject.js 读 r.name）",
          ss.get("ok") and ss.get("name") and os.path.isfile(ss["path"]), str(ss))
    check("shot_save 空图报错", b.shot_save("x", "").get("ok") is False)
    check("shot_save 坏 base64 报错", b.shot_save("x", "!!!").get("ok") is False)

    # -- 自启动 -----------------------------------------------------------
    a0 = b.autostart_state()
    check("autostart_state 初始 off", a0.get("ok") and a0.get("enabled") is False, str(a0))
    check("autostart_state 返回 enabled（inject.js:1915 读 r.enabled）", "enabled" in a0, str(a0))
    check("autostart_set(True) ok", b.autostart_set(True).get("ok") is True)
    a1 = b.autostart_state()
    check("autostart 状态回填为 on", a1.get("enabled") is True and a1.get("on") is True, str(a1))
    check("autostart 写入 .desktop 文件",
          os.path.isfile(os.path.join(os.environ["XDG_CONFIG_HOME"], "autostart", "lptv.desktop")))
    check("autostart_set(False) 移除", b.autostart_set(False).get("ok") is True)
    check("autostart 再次关闭后 off", b.autostart_state().get("enabled") is False)

    # -- 窗口控制：无窗口必须优雅降级（不能抛异常）------------------------
    win_methods = [
        ("minimize", {}), ("maximize_toggle", {}), ("is_maximized", {}),
        ("fullscreen_toggle", {}), ("is_fullscreen", {}),
        ("float_toggle", {}), ("is_float", {}),
        ("pin_toggle", {}), ("pin_state", {}),
        ("resize_win", {"w": 640, "h": 360}), ("drag_win", {}), ("close_window", {}),
        ("play_channel", {"pid": "600001859"}), ("copy_m3u8", {"pid": "600001859"}),
    ]
    for name, kw in win_methods:
        try:
            r = getattr(b, name)(**kw)
            check("窗口方法无窗口不抛异常: %s" % name, isinstance(r, dict), str(r))
        except Exception as e:
            check("窗口方法无窗口不抛异常: %s" % name, False, "抛异常 %r" % (e,))

    f = b.is_float()
    check("is_float 同时返回 floating/float（inject.js 读 r.floating）",
          "floating" in f and "float" in f, str(f))

    # -- 汇总 ------------------------------------------------------------
    passed = [c for c in _checks if c[1]]
    failed = [c for c in _checks if not c[1]]
    print("=" * 62)
    print("LPTV 桥离线验证：%d/%d 通过" % (len(passed), len(_checks)))
    print("=" * 62)
    for name, ok_flag, detail in _checks:
        print("  [%s] %s%s" % ("PASS" if ok_flag else "FAIL", name,
                               "" if not detail else "  |  " + detail))
    if failed:
        print("\n失败项：")
        for name, _, detail in failed:
            print("  FAIL %s  %s" % (name, detail))
    shutil.rmtree(_TMP, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
