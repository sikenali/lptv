# LPTV 迁移方案：从「pywebview + Chrome CDP」到「Electron 单 AppImage」

> **状态：已实施（路线 A：纯 Electron）。** `electron/` 工程已建好，`frontend/inject.js`
> 桥协议层已改 `window.lptv.*`、界面已对齐 `interface-preview.html`、频道/节目单已左右对调；
> `app/`（pywebview）、`libexec/pywebview_chromium/`、`build/build_appimage.sh` 等 pywebview
> 内容已删除。打包：`bash build/build_electron.sh` → `lzc/content/appimage/LPTV.AppImage`。

> 结论先行：**可以用 Electron 打包成单个 AppImage 替代现在的「chrome + LPTV 两个 AppImage」，
> 懒猫远程功能（rim/xpra）完全不受影响。** 远程层只认「容器里的 X11 顶层窗口」，
> 与窗口由谁创建无关。改动集中在应用层（AppImage 产物 + 启动脚本 + 桥实现）。

---

## 一、背景与目标

### 现状
- 懒猫盒子上跑 LPTV，用户浏览器打开 `https://lptv.<盒子名>/`，经 **catlink 远程桌面
  （rim + xpra，WebSocket）** 看到并操作一个无边框的央视频播放窗口。
- 应用层当前 = **pywebview 驱动**。`LPTV/app/main.py` 用 `gui="qt"`（QtWebEngine）；
  但央视频是 **H.264-over-MSE**，QtWebEngine / WebKitGTK 发行版默认关闭 H.264 专有
  编解码器（专利授权），**实测黑屏**。
- 因此实际部署走「**真 Chrome + CDP**」：自带一个 `webview.platforms.chromium` 后端，
  用 DevTools Protocol 驱动真 Chrome 播 H.264，并注入 `inject.js`。
- 打包产物是 **2 个 AppImage**：`chrome.AppImage`（真 Chrome 引擎，~180MB）+
  `LPTV.AppImage`（pywebview+QtWebEngine 应用，~200MB），**引擎重复打包，合计 ~380MB**。

### 目标
- 用 **Electron 单 AppImage** 替代上述 2 个：
  - Electron 官方构建**带 H.264 专有编解码器**（`ffmpeg_branding=Chrome`），央视频直接能播；
  - 一个包内 = Chromium 引擎 + Node.js + 你的应用，**1 个替代 2 个**；
  - 窗口控制走 **BrowserWindow 原生 API**，比 CDP 简单；
  - 体积从 ~380MB 降到 ~120MB。

---

## 二、现状盘点（以当前代码为准）

| 组件 | 文件 | 说明 |
|---|---|---|
| 入口 | `LPTV/app/main.py` | pywebview：`gui="qt"`、`frameless=True`、`easy_drag=True`、`min_size=(360,220)`；`LPTV_GUI` 可强制 qt/cef |
| 桥实现 | `LPTV/app/bridge.py` | `Bridge` 类，窗口控制走 pywebview Window API（`win.minimize/maximize/resize/move/set_on_top/start_drag/destroy`）；录制/截图/状态/自启动 |
| 频道库 | `LPTV/app/channels.py` | 59 频道（央视21/CGTN6/卫视32），含 `official` 消歧 |
| 前端 UI | `LPTV/frontend/inject.js` | 2960 行，跑在央视频页面里，桥调用 `window.pywebview.api.*` |
| 懒猫启动 | `LPTV/lzc/content/launch_lptv.sh` | 由 xpra `start-child-after-connect` 拉起 LPTV AppImage |
| 懒猫骨架 | `LPTV/lzc/content/{run.sh,90_lzc.conf}` | xpra seamless 配置；`manifest.yml`/`package.yml` 路由与权限 |

### 桥契约（inject.js 实际调用的方法，与 bridge.py 已对齐）

| 分类 | 方法（inject.js → bridge.py） |
|---|---|
| 窗口 | `minimize` `maximize_toggle` `is_maximized` `fullscreen_toggle` `is_fullscreen` `float_toggle` `is_float` `pin_toggle` `pin_state` `resize_win` `close_window` |
| 数据 | `get_channels` `get_version` `get_asset_image` |
| UI 状态 | `get_ui_state` `set_ui_state` |
| 录制/截图 | `rec_open` `rec_append` `rec_close` `shot_save` `get_save_dirs` `pick_save_dir` `open_save_dir` |
| 自启动 | `autostart_state` `autostart_set` |
| 备用（bridge 保留） | `play_channel` `copy_m3u8` `drag_win` |

> 迁移时这 25 个方法是 **Electron 主进程/preload 必须实现的 API 契约**，一一对应不可少。

---

## 三、目标架构（Electron 单包）

```
懒猫盒子容器（lzc-cde 镜像）
└── LPTV.AppImage  (Electron, ~120MB)
    ├── 主进程 (main.js)          ← BrowserWindow 创建/窗口控制/ipc 处理
    ├── preload.js                ← contextBridge 暴露 window.lptv.* 给页面
    └── renderer (inject.js)      ← 跑在央视频页面里，原样复用
         │
    X11 顶层窗口  ←── rim/xpra 抓取 ──→  WebSocket ──→  用户浏览器 catlink SPA
```

---

## 四、影响面：动什么 / 不动什么

### 不动（懒猫远程层，零改动）
- `lzc/content/90_lzc.conf`（xpra 配置）
- `lzc/content/run.sh`（LPK 入口）
- `lzc/manifest.yml`、`lzc/package.yml`（路由 / 权限 / subdomain）
- `lzc/content/assemble_lpk.sh` 的骨架逻辑（cde-supervisor/rim/drop/web 复用 chrome LPK）
- catlink SPA、xpra 抓窗机制

### 动（应用层，仅这些）
1. **打包产物**：`chrome.AppImage` + `LPTV.AppImage` → 单个 `LPTV.AppImage`（Electron）
2. **`lzc/content/launch_lptv.sh`**：启动命令改为跑 Electron AppImage
3. **应用代码**：`main.py`/`bridge.py`（Python）→ Electron 主进程 + preload（JS）
4. **`inject.js`**：桥调用层从 `window.pywebview.api.*` 改为 `window.lptv.*`（仅协议层）

---

## 五、体积与收益对比

| 项 | 现状 | Electron 方案 |
|---|---|---|
| AppImage 数量 | 2（chrome + LPTV） | **1** |
| 总体积 | ~380MB（引擎重复打包） | **~120MB** |
| H.264 | ✅ 真 Chrome | ✅ Electron 官方构建带 |
| 窗口控制 | CDP `Browser.setWindowBounds`（自写） | **BrowserWindow 原生 API** |
| 桥 | 自写 `webview.platforms.chromium` | **preload + ipcRenderer**（官方机制） |
| Python 依赖 | 需要 | **砍掉**（或保留子进程，见路线） |

---

## 六、迁移路线：A（纯 Electron） vs B（Electron + Python 子进程）

| | 路线 A：纯 Electron | 路线 B：Electron 壳 + Python 子进程 |
|---|---|---|
| 做法 | 全部改 JS 主进程；`channels.py` 转 JSON；截图用 `webContents.capturePage()`；录制用页面内 `MediaRecorder` | 主进程只做窗口/桥；`child_process` 拉起 `bridge.py` 做频道/录制/状态 |
| 改动量 | 中等（重写桥 + 转数据） | 小（保留 Python 逻辑） |
| 依赖 | 彻底甩掉 Python + Qt | 仍带 Python 运行时 |
| 长期 | 最干净，依赖链最短 | 保留一份 Python 逻辑 |
| 建议 | **推荐**（盒子已够折腾，干净最重要） | 想最小改动/快速验证时用 |

> 两条路 **`inject.js` 都几乎不用动**（纯前端），只需把 `window.pywebview.api.xxx(...)`
> 换成 `window.lptv.xxx(...)`（约 25 处机械替换，逻辑不变）。

---

## 七、桥协议迁移表（inject.js 方法 → Electron 对应）

| inject.js 调用 | pywebview（现状） | Electron 主进程对应 |
|---|---|---|
| `minimize()` | `win.minimize()` | `BrowserWindow.minimize()` |
| `maximize_toggle()` | `win.maximize()/restore()` | `win.isMaximized()?win.unmaximize():win.maximize()` |
| `is_maximized()` | 内部 `_max` | `win.isMaximized()` |
| `fullscreen_toggle()` | `win.toggle_fullscreen()` | `win.setFullScreen(!win.isFullScreen())` |
| `is_fullscreen()` | 内部 `_fs` | `win.isFullScreen()` |
| `float_toggle()` | `win.resize/move/set_on_top` | `win.setBounds()` + `setAlwaysOnTop()` |
| `is_float()` | 内部 `_float` | 主进程维护状态 |
| `pin_toggle()` | `win.set_on_top()` | `win.setAlwaysOnTop()` |
| `pin_state()` | 内部 `_pin` | `win.isAlwaysOnTop()` |
| `resize_win(w,h)` | `win.resize()` | `win.setBounds({width,height})`（无 WM 下唯一可靠） |
| `close_window()` | `win.destroy()` | `win.destroy()` |
| `get_channels()` | `channels.py` | 导出 `channels.json`，主进程读 |
| `get_version()` | `build/version` | 主进程读 `package.json` version |
| `get_asset_image(name)` | 白名单读文件 | `fs.readFile` + data URI（白名单不变） |
| `get_ui_state()/set_ui_state(p)` | `~/.local/share/lptv/state.json` | `fs` 写 `app.getPath('userData')`（或 localStorage） |
| `shot_save(name,b64)` | base64 写 PNG | `webContents.capturePage()` → 写 PNG（**更简单，免 base64**） |
| `rec_open/append/close` | Python 分块写 webm | 页面内 `MediaRecorder`（inject.js 已有 rec 逻辑） |
| `get_save_dirs/pick_save_dir/open_save_dir` | XDG 目录 | `dialog.showSaveDialog` / `shell.openPath` |
| `autostart_state()/autostart_set(on)` | XDG `~/.config/autostart` | `app.setLoginItemSettings()` 或写 XDG .desktop（同现状） |
| `drag_win()` | `win.start_drag()` | 无等价；**保留 JS 拖动**（`setBounds` 增量，同现状） |

> ⚠ 无 WM 容器：`minimize()/maximize()` 依赖 WM 的 `_NET_WM`，容器里可能不生效；
> `setBounds/setAlwaysOnTop/setFullScreen` **不依赖 WM**，覆盖拖动/浮窗/置顶/全屏。
> 最小化/最大化退回用 `setBounds` 模拟（与现状 JS 方案同理）。

---

## 八、具体改动清单

### 新增（Electron 工程，放 `LPTV/electron/`）
```
LPTV/electron/
├── package.json        # name=LPTV, main=main.js, version 与 build/version 同步
├── main.js             # BrowserWindow 创建 + ipcMain.handle('lptv:*') + 窗口控制
├── preload.js          # contextBridge.exposeInMainWorld('lptv', {...25 方法})
├── channels.json       # 由 app/channels.py 导出（59 频道）
└── assets/
    ├── inject.js       # 原样复用（只改桥调用层）
    ├── icon.png
    └── wechat_qr.jpg
```

### 修改
- **`frontend/inject.js`**：`window.pywebview.api.xxx(...)` → `window.lptv.xxx(...)`（约 25 处，
  通过局部变量 `a`/`a1`/`a2`/`a3`/`a9` 拿到 api 的地方，改成 `window.lptv` 即可）
- **`lzc/content/launch_lptv.sh`**：`exec "$APPIMAGE"` → `exec "$CONTENT/appimage/LPTV.AppImage"`
  （Electron 版）；保留 `--no-sandbox`（root 容器必须）

### 删除/停用
- `app/main.py`、`app/bridge.py`、`app/channels.py`（路线 A 下不再需要；路线 B 下保留）
- 自写 `webview.platforms.chromium` 后端（CDP 样板）
- 打包时的 2 个 AppImage 逻辑（`build/build_appimage.sh` 改为 electron-builder 配置）

> ✅ 已实施：上述均已删除；打包改走 `build/build_electron.sh`（electron-builder）。

### 打包命令（新增）
```bash
# 在 LPTV/electron/ 下
npx electron-builder --linux AppImage
# 产出 dist/LPTV-<ver>-x86_64.AppImage
```

---

## 九、懒猫侧改动

1. **`launch_lptv.sh`**：改启动 Electron AppImage（见上）
2. **容器依赖**：Electron 需要 `libgtk-3`、`libnss3`、`libasound2`、`libatk-1.0`、
   `libcups2`、`libxss1`、`libdrm2` 等。确认 `lzc-cde` 镜像已装；缺了在
   `lzc/Dockerfile`（自托管路线）补 `apt-get install`。
3. **root 下**：`app.commandLine.appendSwitch('no-sandbox')` 或启动参数 `--no-sandbox`。
4. **窗口伪装**：`app.setName('LPTV')` + `win.setTitle('LPTV')` + `win.setIcon(icon.png)`
   （对应现状 `--class=LPTV` / `WM_NAME` / `_NET_WM_ICON`，xpra SPA 才能正确显示任务栏图标）。

---

## 十、上盒验证清单

- [ ] Electron AppImage 能启动（`./LPTV.AppImage --no-sandbox`）
- [ ] 央视频页面加载，**H.264 画面正常**（非黑屏）——关键
- [ ] 窗口在 `DISPLAY=:0` 被 xpra 抓到，浏览器 catlink SPA 能看到
- [ ] 顶栏 6 按钮：最小化/置顶/浮窗/全屏/最大化/关闭，各就位（无 WM 下最小化/最大化用 setBounds 模拟）
- [ ] JS 拖动（顶栏 mousedown → setBounds 增量）在远程端可用
- [ ] 切台 / 收藏 / 录制 / 截图 / 自启动 全链路通
- [ ] 看门狗（视频 `readyState`/`videoWidth`）不误报
- [ ] 体积确认：单包 ~120MB，LPK 整体比现状小

---

## 十一、风险与回退

| 风险 | 应对 |
|---|---|
| 无 WM 容器最小化/最大化不生效 | 退回 `setBounds` 模拟；不影响主流程 |
| Electron 在容器 root 下崩溃 | 加 `--no-sandbox`；确认容器依赖库齐全 |
| Electron 窗口被 xpra 误判为 Chrome | `app.setName('LPTV')` + `setTitle` + `setIcon` 伪装 |
| Python 逻辑迁移有遗漏 | 路线 B 保留 `bridge.py` 子进程；或先 B 后 A 渐进 |
| 打包机需联网下载 Electron 二进制 | `electron-builder` 首次拉取 ~90MB，之后缓存 |

**回退**：保留现有 `chrome.AppImage + LPTV.AppImage` 打包分支（`build/build_appimage.sh`），
Electron 方案验证不通过时一键切回，二者并存不冲突。

---

## 十二、工作量估算

| 项 | 估计 |
|---|---|
| Electron 工程骨架（main/preload/package.json） | 0.5-1 天 |
| inject.js 桥调用层替换（25 处） | 0.5 天 |
| 频道库转 JSON / 状态 / 录制迁移 | 0.5-1 天 |
| 懒猫侧 launch_lptv.sh + 容器依赖 | 0.5 天 |
| 上盒实测与校准 | 1-2 天（DRM/无 WM 关键） |
| **合计** | **3-4 天** |

> 若走路线 B（保留 Python 子进程），主进程桥工作量减半，总估约 2-3 天。
