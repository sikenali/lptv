# LPTV — Linux 版 LX TV（远程央视频电视客户端）

把原 Windows 版「LX TV」（pywebview + WebView2 的央视频直播壳）复刻成 **Linux 客户端**，
并提供两条交付路径：

1. **本地 AppImage**：`LPTV-x86_64.AppImage`，在任意 x86_64 Linux 桌面直接跑。
2. **懒猫远程应用（catlink）**：把上面的 AppImage 塞进 LPK，盒子上跑、浏览器里看/控
   （对标 `cloud.lazycat.catlink.chrome.lpk`）。

壳只做一件事：加载《央视频》官方 TV 直播页 + 注入增强 UI 层；播放永远由官方页面完成。

---

## 架构

 ```
 ┌──────────────────────────────────────────────────────────────────┐
 │ 本地模式（AppImage）                                                │
 │   LPTV (pywebview + 真 Chrome/CDP 后端) ── 加载央视频 + 注入 UI      │
 │   窗口直接显示在本地 X11/Wayland 桌面                                 │
 └──────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────┐
 │ 远程模式（catlink / LPK） —— 用户在浏览器里看"LPTV 窗口"              │
 │                                                                    │
 │   懒猫盒子容器 (lzc-cde)                                            │
 │   ┌───────────────────────────────────────────────────┐           │
 │   │ LPTV AppImage                                       │           │
 │   │   webview.platforms.chromium ──CDP──▶ 真 Chrome     │           │
 │   │   真 Chrome 加载央视频官方页（--app 模式，解码 H.264）│           │
 │   │     ↑ 页面 JS ── Runtime.addBinding ──▶ pywebview 桥 │           │
 │   │   inject.js 覆盖层 ──▶ X11 窗口                     │           │
 │   │        ↑ 抓窗口位图                                   │           │
 │   │ Xpra seamless (:7890) ── 视频编码 ── WS              │           │
 │   │ rim (:8888) ── 会话/输入/剪贴板                      │           │
 │   └───────────────────────────────────────────────────┘           │
 │             │ 反代                                                  │
 │   用户浏览器 → https://rlptv.<盒子名>/ → catlink SPA                 │
 └──────────────────────────────────────────────────────────────────┘
 ```

> **为什么必须是真 Chrome，而不是 pywebview 自带的后端**
>
> 央视频是纯 H.264-over-MSE 直播流（`hlsliveali-cdn.ysp.cctv.cn`，**无 EME/DRM**，
> 不加密）。pywebview 在 Linux 上只有两个后端，两者的 H.264 都不完整：
>
> | 后端 | `MediaSource.isTypeSupported('video/mp4;codecs="avc1.42E01E,mp4a.40.2"')` | 实测结果 |
> | --- | --- | --- |
> | `qt`（QtWebEngine 6.11.2 / Chrome 140） | `false` | `<video>` 恒为 `0×0`、`readyState=0`，纯黑 |
> | `gtk`（WebKit2GTK 2.54） | `""`（所有 codec 串） | 无 MSE、无 H.264，同样纯黑 |
> | 真 Chrome 156 | `true` | `1920×1080`、`readyState=4`、像素真实变化 |
>
> 所以 LPTV 自研了 `webview/platforms/chromium.py`：用 DevTools Protocol 驱动随包的真 Chrome，
> 并给 `webview/guilib.py` 打补丁（`build/_chrome/`、`libexec/pywebview_chromium/`）让
> `webview.start(gui='chromium')` 可路由过去。`app/main.py` 与 `app/bridge.py` **零改动**。
>
> Linux 上 pywebview 的 `window.external` 不存在，JS→Python 传输层改用
> CDP 的 `Runtime.addBinding`（事件字段是 `payload`，不是 `args`），
> 再复用 pywebview 自带的 `webview.util.js_bridge_call` 派发器。
>
> 顺带修正旧结论：之前把黑屏归因于"缺 Widevine CDM"是错的——
> 央视频根本不加密，真正的缺口是 H.264 解码器。

---

## 功能继承清单（对照 Windows 版 LX TV）

| 模块 | 状态 | 说明 |
|---|---|---|
| 频道表（59 频道：央视21/CGTN6/卫视32） | ✅ 完整 | 从 `channels.pyc` 逐条恢复，含 CCTV-14 无 cnlid、CCTV-16/4K/8K 的 `official` 消歧 |
| 注入层 UI（顶栏/控制栏/频道面板/EPG/设置/手势/浮窗） | ✅ 零改动 | `frontend/inject.js` 原样复用（2960 行，纯 DOM/JS） |
| 启动直达频道（`?pid=` 修竞态） | ✅ | `main.py _home_url()` |
| 频道切换 / 取流 | ✅ | `bridge.play_channel` / `copy_m3u8` → 页面 `window.__lxCctv` |
| 状态持久化（lastPid/favs/resumeLast/res/autoFullscreen） | ✅ | 白名单 + JSON 落盘（`~/.local/share/lptv/`） |
| 录制（webm 分块） | ✅ | `rec_open/append/close/list` |
| 截图（PNG） | ✅ | `shot_save` |
| 窗口控制（最大化/全屏/浮窗/置顶/缩放/拖拽/关闭） | ✅ 改写 | Win32 ctypes → **pywebview Window API**（Xpra 下依然有效） |
| 自启动 | ✅ 改写 | Windows 注册表 → **XDG autostart**（`~/.config/autostart/lptv.desktop`） |
| 资源图（关于二维码） | ✅ | `get_asset_image` 白名单 `icon.png`/`wechat_qr.jpg` |
| 看门狗（黑帧监控） | ✅ 轻量版 | `main.py _watchdog`；完整黑帧恢复逻辑在 inject.js 内 |
| E2E 自动化测试（`LX_E2E`） | ⚠️ 未移植 | 原是 Windows 专用开发工具，非用户功能；运行时特性均继承 |

**铁律**（与 Windows 版一致）：桥的实例属性必须下划线开头，否则 pywebview 枚举公开属性
时递归进 webview 内部对象无限链，`loaded` 永不触发、注入卡死。

---

## 目录结构

```
LPTV/
├── run.sh              # 一键运行：首次自动建 venv + 装依赖 + 选后端
 ├── app/
 │   ├── __init__.py     # 版本号
 │   ├── __main__.py     # 允许 `python -m app`
 │   ├── channels.py     # 频道表（从 pyc 恢复，59 频道）
 │   ├── bridge.py       # Linux 桥：pywebview Window API + 持久化 + 录制/截图 + 自启动
 │   └── main.py         # 入口：后端选择(LPTV_GUI)、注入 inject.js、看门狗
 ├── frontend/
 │   ├── inject.js       # 前端 UI 层（原样复用 LXTV，2960 行，零改动）
 │   ├── icon.png
 │   └── wechat_qr.jpg   # 关于页二维码
 ├── libexec/
 │   └── pywebview_chromium/
 │       ├── chromium.py      # ★ 自研 pywebview 平台：CDP 驱动真 Chrome
 │       └── patch_guilib.py  # 让 webview.start(gui='chromium') 可路由过去
 ├── tests/
 │   └── test_bridge.py  # 桥离线验证（55 项，含 inject.js↔桥契约字段核对）
 ├── docs/
 │   └── interface-preview.html  # 界面可视化预览（可交互，还原全部 #lx-* 区域）
 ├── build/
 │   ├── build_appimage.sh    # 手工 AppDir + 内嵌 Chrome → LPTV-x86_64.AppImage
 │   ├── build_chrome_appimage.sh  # google-chrome-stable .deb → Chrome AppImage
 │   ├── requirements.txt
 │   └── lptv.desktop
 └── lzc/                    # 懒猫 catlink 远程包装
     ├── manifest.yml
     ├── package.yml
     └── content/
         ├── run.sh
         ├── launch_lptv.sh   # 自动发现 Chrome 引擎 → 启动 LPTV（CDP 端口写 /tmp/catlink/lptv.port）
         ├── 90_lzc.conf
         ├── assemble_lpk.sh  # 保留真 Chrome + LPTV 独立文件，组装最终 LPK
        └── README.md
```

---

## 本地开发 / 运行

需要 Python 3.12+。**默认走真 Chrome 后端**（见「架构」一节，QtWebEngine 解不了央视频的 H.264）。

**一键运行**：

```bash
cd LPTV
LPTV_CHROME=/path/to/chrome bash run.sh     # 首次自动建 .venv + pip install，然后启动
```

后端选择（`run.sh` / `AppRun` 都读这个变量，默认 `chromium`）：

| `LPTV_GUI` | 说明 |
| --- | --- |
| `chromium`（默认） | 真 Chrome + CDP，唯一能解码央视频的路径 |
| `qt` | QtWebEngine，调试用；央视频必然黑屏 |

真 Chrome 的查找顺序：`LPTV_CHROME` 显式指定（可执行文件或 `.AppImage`）→
`APPDIR/{usr/share/chrome,opt/google/chrome}` → `/lzcapp/pkg/content/{chrome,appimage}` →
`/lzcapp/var/{chrome,apps/chrome}` → `/opt/chrome` → `which google-chrome{,-stable,chromium,chromium-browser}`。
AppImage 会自动解包到 `LPTV_CHROME_DIR`（默认 `~/.cache/lptv/chrome`）。

调试与等价入口：

```bash
LP_DEBUG=1 bash run.sh                # 打开 pywebview 控制台日志
python3 -m app.main                   # 手动激活 venv 后的等价入口
python3 -m app                        # 走 app/__main__.py，同上
LX_NO_INJECT=1 python3 -m app.main    # 跳过 inject.js，直接看央视频原生页
```

`APPDIR` / `_MEIPASS` / 源码 三种资源路径 main.py 都已兼容。
首次启动会自动创建 `~/.local/share/lptv/`（录制/截图）与
`~/.config/lptv/state.json`（UI 状态）。

## 运行测试

```bash
python3 -m unittest -v tests.test_bridge          # 单文件
python3 -m unittest discover -s tests -v          # 发现并跑全部
```

`tests/test_bridge.py` 用临时目录接管 `$HOME` 与 `XDG_DATA_HOME` /
`XDG_CONFIG_HOME`，**不需要网络、不需要 X11/Wayland、不需要真实 Qt**，
因此在 CI 与 Docker 构建阶段都能跑。55 项断言覆盖：

- 频道库数量与分类归属（59 条，与 channels.pyc 一致，含 CCTV-14 空 cnlid）
- 特殊频道字段（CCTV-16 的 `official=='CCTV16'` 消歧）
- UI 状态持久化：白名单过滤、非法 key 拒绝、往返一致、JSON 字符串入参
- 收藏增删改 + 持久化
- 录制/截图管线：严格 base64 校验、坏分块不写坏文件
- 自启动开关与 `.desktop` 内容校验
- 全部 14 个窗口方法在无窗口时不抛异常
- `get_version` 从 `build/version` 读取

## 桥契约核对（25 方法零缺口）

`inject.js` 2960 行原样复用，因此**桥契约是唯一跨版本耦合点**。已用
正则 `window.pywebview.api.xxx(...)` 扫出全部 26 处调用，`s0` 是
节目单时间字段（正则误判），排除后 **25 个方法全部由 `bridge.py` 实现**：

| 分类 | 方法 |
|---|---|
| 环境 | `platform`、`get_version` |
| 资源 | `get_asset_image` |
| UI 状态 | `get_ui_state`、`set_ui_state` |
| 收藏 | `favs_set`、`favs_toggle` |
| 录制 | `rec_open`、`rec_append`、`rec_close`、`rec_list` |
| 截图 | `shot_save`、`get_save_dirs`、`pick_save_dir`、`open_dir` |
| 自启动 | `autostart_get`、`autostart_set` |
| 窗口 | `win_toggle_max`、`win_toggle_fullscreen`、`float_toggle`、`is_float`、`win_set_topmost`、`win_set_size`、`easy_drag`、`win_close` |

`play_channel`、`copy_m3u8`、`drag_win` 是桥的防御性方法（inject.js 走
内部 `window.__lxCctv` 自行切台，不通过桥），保留以便将来切台走桥。

**字段消费核对**（inject.js 读到的键必须与桥返回一致）：

| 方法 | inject.js 读 | 桥返回 |
|---|---|---|
| `shot_save` | `r.name` | `{ok, name}` |
| `get_save_dirs` | `d.rec` / `d.shot` | `{rec, shot}` |
| `pick_save_dir` | `r.dir` | `{ok, dir}` |
| `get_version` | 当字符串 | `"x.y.z"` |
| `get_ui_state` | `s.ok` | `{ok: True, ...}` |
| `set_ui_state` | — | 收 `JSON.stringify(p)` 字符串 |

## 本轮修复的 3 个真实 bug

对照 inject.js 2960 行原样复用时逐字段核对，抓到 3 处会导致 UI 静默失效
的桥字段错位 / 解码隐患：

1. **浮窗状态字段错位** — inject.js 读 `r.floating`，桥返回 `{"float"}`，
   图标永远读不到值。修：`bridge.float_toggle / is_float / win_set_size`
   三处统一走 `_float_dict`，同时返回 `floating` 与 `float` 两个键。
2. **自启动状态字段错位** — inject.js 读 `r.enabled`，桥返回 `{"on"}`，
   设置页的开关永不回填。修：`autostart_state` 同时返回 `enabled` 与 `on`。
3. **base64 静默丢字节** — `base64.b64decode("!!!")` 默认 `validate=False`
   会静默返回 `b""` 而非报错，坏分块静默写坏 webm / png。修：`rec_append`
   与 `shot_save` 都改为 `validate=True`，坏分块立刻 400；`shot_save` 另加
   空数据保护。

另修：`rec_append` 恢复被误删的 `data:` 前缀剥离（`b64.split(",", 1)[1]`）。

## 浏览器引擎（关键前置）

> **央视频不是 DRM，是 H.264 解码缺口。** 旧版本文档说"需要 Widevine CDM"，
> 这是错的结论，已废弃：`chrome://media-internals` 在官方页上 **不出现 EME 条目**，
> 直播流是明文 H.264-over-MSE（`hlsliveali-cdn.ysp.cctv.cn`）。
> 真正的墙是 pywebview 在 Linux 上的两个后端都解不了 H.264。

一键准备真 Chrome：

```bash
bash build/build_chrome_appimage.sh   # 需要 google-chrome-stable_current_amd64.deb
# 产出 build/_chrome/Google-Chrome-stable-156.0.8078.47-1-x86_64.AppImage
```

- `.deb` 解包到 `build/_chrome/root`，用自带 `appimagetool` 打成 AppImage（**免 fuse**）
- 会**必须**先把 `file` 准备好：构建机没有 root 权限时，脚本会自动从 Debian 池
  用户态解包 `file` + `libmagic` 到 `build/_appimage_work/tools` 并设 `LD_LIBRARY_PATH`
- Chrome 自带 `WidevineCdm`，所以即使将来有 DRM 内容也能播

**为什么不能继续用 pywebview 自带的 qt/gtk**：

| 后端 | H.264/MSE 实测 | 央视频结果 |
| --- | --- | --- |
| `qt`（QtWebEngine 6.11.2 / Chrome 140） | `isTypeSupported(...)` → `false` | `0×0` / `readyState=0`，黑 |
| `gtk`（WebKit2GTK 2.54） | 所有 codec 串 → `""` | 黑 |
| 真 Chrome 156（本方案） | `true` | `1920×1080` / `rs=4`，正常 |

`libexec/pywebview_chromium/chromium.py` 是**新增**的 pywebview platform：
用 `websockets` 直连 Chrome DevTools Protocol（RFC6455 手撸，只带 `Target`+`Network`），
实现完整的 `Platform` 接口（`create_window`/`resize`/`move`/`fullscreen`/`cookies`/…），
并把 pywebview 的 JS 桥映射到 CDP 的 `Runtime.addBinding`。
`libexec/pywebview_chromium/patch_guilib.py` 给 `webview/guilib.py` 打幂等补丁
（加 `GUIType.chromium` 与 Linux 分派分支），**不动上游一行代码**。

> 踩过的坑，写下来免得再来一遍：
> - CDP 的 `call()` 返回**整个 message**，字段在 `result` 下（见 `chromium._r()`）
> - `Runtime.bindingCalled` 的参数在 `params.payload`，**不是** `params.args`
> - `Browser.setWindowBounds` 用 `left`/`top`，不是 `x`/`y`
> - pywebview 6.x 的 `webview.util.inject_pywebview()` 会自己起线程做真注入，
>   直接调它会让 `loaded` 事件在桥建好之前触发 —— `chromium._inject_bridge()` 因此
>   复制它的内联逻辑，保证 `window.pywebview` 一定在 `loaded` 之前可用
> - Linux 上 `window.external` 根本不存在，pywebview 也没兜底通用通道，
>   所以自定义平台必须自己接 `Runtime.addBinding`
> - `cef.py` 顶层 `import winreg`、`gtk.py` 顶层 `import gi` —— 两者在这类容器里都跑不起来

## 打包 AppImage

```bash
bash build/build_appimage.sh        # 产出 build/_appimage_work/LPTV-x86_64.AppImage
```

采用**自包含**方案（linuxdeploy-plugin-python 已停止维护、plugin-qt 需要 wheel 里不存在的
qmake，均已弃用）。脚本实际做的事：

1. `pip install --target` 收集 `build/requirements.txt` 依赖
2. **注入 Chromium 后端**：拷 `libexec/pywebview_chromium/` 进 site-packages 的 `webview/platforms/`，
   然后跑 `patch_guilib.py`
3. 组织 AppDir：内嵌 CPython 二进制 + 标准库 + site-packages，应用装到 `usr/share/lptv`
4. `ldd` 闭包把 Qt / Python / 库的非基础系统库收进 `usr/lib-local`
5. 写 `AppRun`：设 `PYTHONHOME` / `PYTHONPATH`（Debian 的 site-packages 路径编译期写死，必须显式给）
   / `PYTHONNOUSERSITE` / `LD_LIBRARY_PATH`，并默认 `LPTV_GUI=chromium`
6. `appimagetool --appimage-extract-and-run` 定稿（免 fuse；`file` 缺失时自动用户态补上）

产物 263M。冒烟验证（无显示器也能做）：

```bash
LPTV-x86_64.AppImage --appimage-extract
cd squashfs-root && bash AppRun
# 期望出现：[LX] inject attempt ok, len= 125087
```

打包前检查清单：

- [ ] `bash build/build_chrome_appimage.sh` 已跑成功（`build/_chrome/*.AppImage` 存在）
- [ ] `python3 tests/test_bridge.py` 全绿（55 项，无需 GUI/X11）
- [ ] `bash -n build/*.sh lzc/content/*.sh` 无语法错误
- [ ] `python3 -m compileall app tests` 无警告

> 注意：AppImage 运行时 `APPDIR` 指向解压根，应用实际在 `$APPDIR/usr/share/lptv`。
> `app/main.py _app_base()` 已按此探测；改目录结构时不要破坏这层约定，否则
> inject.js 会静默读不到、注入失败。

## 界面预览

`docs/interface-preview.html` 是纯静态界面复刻（单文件、零外部依赖），
浏览器直接打开即可预览：59 频道面板、收藏、EAS 横幅、节目单、OSD、
录制角标、浮窗控制条、设置/关于面板。图标全部取自 inject.js 的真实 SVG。

它**不是**生产 UI——只是给设计审阅与文档用的可视化基准；真实 UI 仍由
`app/assets/inject.js` 在运行时注入。预览页里所有按钮（切台、收藏、
面板切换、录制计时、浮窗缩放、toast）都可交互，便于对照 inject.js 的
字段契约（如 `shot_save` 回 `name`、`get_save_dirs` 回 `{rec,shot}`）。

---

## 组装远程 LPK 并部署

```bash
# 1) 产出 AppImage（上一步）
# 2) 组装最终 LPK（复用 chrome LPK 的 cde-supervisor/rim/drop/web）
CHROME_LPK=/path/to/cloud.lazycat.catlink.chrome.lpk \
APP=/path/to/LPTV-x86_64.AppImage \
CHROME_APP_SRC=/path/to/Google-Chrome-stable-156.*.AppImage \
bash lzc/content/assemble_lpk.sh
# 产出 cloud.lazycat.catlink.lptv.lpk（约 488M）
# 3) 在懒猫商店/盒子侧上传该 LPK，浏览器打开 https://rlptv.<盒子名>/
```

> **rim 有个硬编码坑**：`rim/bundled_app_install.go` 写死了
> `content/appimage/Google-Chrome-stable-155.0.8059.39-1-x86_64.AppImage`，
> 它会把那个 AppImage 解包到 `/lzcapp/var/apps/chrome/`。
> 所以 `assemble_lpk.sh` **必须**在文件名 `155.0.8059.39` 下放真 Chrome（哪怕内容是 156），
> 而 LPTV 本体走 `LPTV-x86_64.AppImage` 这个名字——
> 否则 LPTV AppImage 会顶替掉 Chrome 的位置，等于没带浏览器。
> v0.2.2 就栽在这里（两者是同一个 sha256 的硬链接，包里根本没有真 Chrome）。

---

## ✅ 盒子上实测结论（v0.2.3，`192.168.105.128`）

「容器 + Xdummy 虚拟显示 + Xpra 抓取」下**能出真实像素**，已端到端验过：

```
[LPTV] 解包 AppImage → /lzcapp/var/lptv/app
[pywebview] [chromium] extracting AppImage .../Google-Chrome-stable-155.0.8059.39-1-x86_64.AppImage -> /lzcapp/var/lptv/chrome
[pywebview] [chromium] launching /lzcapp/var/lptv/chrome/squashfs-root/opt/google/chrome/chrome (port 50751, app=True)
[LX] inject attempt ok, len= 125087
```

| 项 | 结果 |
| --- | --- |
| 视频 | `1920×1080` / `readyState=4` / `currentTime` 持续走（33 → 36 → 39） |
| 像素 | 三帧 `mean_lum` 155.8 / 103.5 / 83.9，直方图各不相同 = 真实画面 |
| 切台 | `play_channel("600001800")` → CCTV-2 财经，`rs=1` → `rs=4`，像素恢复 |
| JS 桥 | `window.pywebview.api` **29** 个方法全部可用 |
| 频道 | `get_channels()` → **59** 个，`CCTV-1 综合` / `600001859` |
| UI | `lx-root` / `lx-topbar` 就位，`get_ui_state()` → `{"ok":true,"lastPid":"600001800"}` |
| 窗口 | `resize_win(1024,576)` → `{"ok":true}`，viewport 变 `1024x520` |

 > 顺带说清一个此前的错觉：早先「Chrome 155 在盒子上播放成功」的观察其实是在**笔记本**上，
 > 那是另一台机器。盒子上从来没成功过——v0.2.2 发上去的是个非工作引擎。

---

## 已知限制 / 决策

- **mpv / ffmpeg 已彻底排除**：盒子容器里的 mpv 解码出来的每一帧都是纯灰
  （`uniq=1`、`Y` 通道 `min=128 max=129`），`top block unavailable for requested intra mode`，
  即上游给的不是合法 H.264；而 CDN 对非浏览器客户端返回 403，它们也拿不到真实载荷。
  不是调试问题，是这条路不通。
- **环境**：本脚手架最早在 Windows 沙箱内产出，AppImage 构建与 LPK 部署均在
  x86_64 Linux 完成；v0.2.3 已在盒子上端到端实测通过（见上节）。
- **E2E 工具未移植**：原 `LX_E2E` 是 Windows 专用开发态，不影响用户运行时功能。
- **UA**：保留 Windows Chrome/132 串（CMG 按 UA 判定环境，与 Windows 版一致最稳）。
- **浮窗/最大化/全屏**：在 Xpra 环境下仍作用于浏览器里的远端窗口，逻辑由 pywebview
  Window API 实现，比 Windows 版 SetWindowPos/DWM 更简单。
