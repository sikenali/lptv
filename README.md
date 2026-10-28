# LPTV — Linux 版 LX TV（远程央视频电视客户端）

把原 Windows 版「LX TV」的央视频直播壳复刻为 **Linux 客户端**，提供两条交付路径：

1. **本地 AppImage**：`LPTV.AppImage`（Electron 单包），在任意 x86_64 Linux 桌面直接跑。
2. **懒猫远程应用（catlink）**：把该 AppImage 塞进 LPK，盒子上跑、浏览器里看/控
   （对标 `cloud.lazycat.catlink.chrome.lpk`）。

壳只做一件事：加载《央视频》官方 TV 直播页 + 注入增强 UI 层；播放永远由官方页面完成。

---

## 架构（Electron 单包）

```
┌──────────────────────────────────────────────────────────────────┐
│ 本地模式（AppImage）                                                │
│   LPTV.AppImage (Electron) ── BrowserWindow 加载央视频 + 注入 UI    │
│   窗口直接显示在本地 X11/Wayland 桌面                                 │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ 远程模式（catlink / LPK） —— 用户在浏览器里看"LPTV 窗口"              │
│                                                                    │
│   懒猫盒子容器 (lzc-cde)                                            │
│   ┌───────────────────────────────────────────────────┐           │
│   │ LPTV.AppImage (Electron)                           │           │
│   │   main.js  ── BrowserWindow 加载央视频 (H.264 直解) │           │
│   │   preload  ── contextBridge → window.lptv 桥        │           │
│   │   inject.js 覆盖层 ──▶ X11 顶层窗口                 │           │
│   │        ↑ 抓窗口位图                                   │           │
│   │ Xpra seamless (:7890) ── 视频编码 ── WS              │           │
│   │ rim (:8888) ── 会话/输入/剪贴板                      │           │
│   └───────────────────────────────────────────────────┘           │
│             │ 反代                                                  │
│   用户浏览器 → https://rlptv.<盒子名>/ → catlink SPA                 │
└──────────────────────────────────────────────────────────────────┘
```

> **为什么是 Electron？** 央视频是纯 H.264-over-MSE 直播流（无 EME/DRM）。
> Electron 官方构建带 H.264 专有编解码器（`ffmpeg_branding=Chrome`），
> `BrowserWindow` 直接能播，无需外部引擎。旧方案「pywebview + 真 Chrome/CDP」
> 要 2 个 AppImage（~380MB），Electron 单包 ~120MB，且窗口控制走 BrowserWindow
> 原生 API，不再手写 CDP。迁移细节见 `electron-migration.md`。

---

## 功能继承清单（对照 Windows 版 LX TV）

| 模块 | 状态 | 说明 |
|---|---|---|
| 频道表（59 频道：央视21/CGTN6/卫视32） | ✅ 完整 | `electron/channels.json`（由旧 `channels.py` 导出），含 CCTV-14 无 cnlid、CCTV-16/4K/8K 的 `official` 消歧 |
| 注入层 UI（顶栏/控制栏/频道面板/EPG/设置/手势/浮窗） | ✅ 复用 | `frontend/inject.js`（界面已对齐 `interface-preview.html`，频道↔节目单左右对调） |
| 启动直达频道（`?pid=` 修竞态） | ✅ | `main.js` 读 `~/.local/share/lptv/lx.state.json` 的 `lastPid` |
| 频道切换 / 取流 | ✅ | 页面内 `window.__lxCctv.switchChannel`（主进程 `play_channel`/`copy_m3u8` 兜底） |
| 状态持久化（lastPid/favs/resumeLast/res/autoFullscreen/fit） | ✅ | 白名单 + JSON 落盘（`~/.local/share/lptv/`，与旧版同路径，状态延续） |
| 录制（webm 分块） | ✅ | `rec_open/append/close`（主进程写盘，同旧协议） |
| 截图（PNG） | ✅ | `shot_save`（base64 → PNG 落盘） |
| 窗口控制（最大化/全屏/浮窗/置顶/缩放/拖拽/关闭） | ✅ | BrowserWindow 原生 API；无 WM 下最小化/最大化退回 `setBounds` 模拟 |
| 自启动 | ✅ | XDG autostart（`~/.config/autostart/lptv.desktop`） |
| 资源图（关于二维码） | ✅ | `get_asset_image` 白名单 `icon.png`/`wechat_qr.jpg` |

---

## 目录结构

```
LPTV/
├── run.sh              # 一键运行（Electron 开发模式：cd electron && npm start）
├── electron/           # ★ Electron 工程（路线 A：纯 Electron）
│   ├── package.json    # name=LPTV, main=main.js, electron-builder AppImage 配置
│   ├── main.js         # BrowserWindow + ipcMain.handle('lptv:*') + 窗口控制 + 注入
│   ├── preload.js      # contextBridge.exposeInMainWorld('lptv', {…29 方法})
│   ├── channels.json   # 59 频道（name/pid/cnlid/category/official）
│   ├── assets/         # icon.png / wechat_qr.jpg
│   └── dist/           # 打包产物（LPTV.AppImage，gitignored）
├── frontend/
│   ├── inject.js       # 前端 UI 层（bridge 协议已改 window.lptv.*；界面对齐 preview）
│   ├── splash.js       # 启动动画（dom-ready 注入）
│   ├── icon.png
│   └── wechat_qr.jpg
├── libexec/            # widevinecdm（保留；Electron 自带，无需外部）
├── docs/interface-preview.html   # 界面可视化预览（样式基准，已与 inject.js 对齐）
├── build/
│   └── build_electron.sh   # npm install + electron-builder → lzc/content/appimage/LPTV.AppImage
└── lzc/                # 懒猫 catlink 远程包装
    ├── manifest.yml
    ├── package.yml
    └── content/
        ├── run.sh
        ├── launch_lptv.sh   # exec LPTV.AppImage --no-sandbox
        ├── 90_lzc.conf
        ├── assemble_lpk.sh  # 组装最终 LPK（单 AppImage）
        └── README.md
```

---

## 本地开发 / 运行

需要 **Node.js ≥18 + npm**。

```bash
cd LPTV
bash run.sh          # 首次自动 npm install（拉取 Electron ~90MB），然后启动
# SKIP_INSTALL=1 bash run.sh   # 已装过依赖，直接启动
```

系统依赖（x86_64 Debian/Ubuntu）：

```bash
sudo apt install -y nodejs npm libgtk-3-0 libnss3 libasound2 libatk1.0-0 \
     libcups2 libxss1 libdrm2 libgbm1 libxkbcommon0
```

调试开关：`LX_NO_INJECT=1`（跳过 inject.js 看原生页）可在 `electron/main.js` 里按需扩展。
窗口/桥全部走 `electron/main.js`，无 Python、无 Qt、无外部 Chrome。

---

## 桥契约（29 方法，与主进程一一对应）

`inject.js` 复用，因此**桥契约是唯一跨版本耦合点**。协议层已从
`window.pywebview.api.xxx(...)` 改为 `window.lptv.xxx(...)`（preload 经
`contextBridge` 暴露，全返回 Promise）。字段消费与返回体与旧 `bridge.py`
保持一致（`r.ok` / `r.floating` / `r.maximized` / `r.pinned` / `r.id` / `r.enabled`）。

| 分类 | 方法 |
|---|---|
| 窗口 | `minimize` `maximize_toggle` `is_maximized` `fullscreen_toggle` `is_fullscreen` `float_toggle` `is_float` `pin_toggle` `pin_state` `resize_win` `win_pos` `move_win` `close_window` |
| 数据 | `get_channels` `get_version` `get_asset_image` |
| UI 状态 | `get_ui_state` `set_ui_state` |
| 录制/截图 | `rec_open` `rec_append` `rec_close` `shot_save` `get_save_dirs` `pick_save_dir` `open_save_dir` |
| 自启动 | `autostart_state` `autostart_set` |
| 备用 | `play_channel` `copy_m3u8` |

---

## 打包 AppImage（Electron）

```bash
bash build/build_electron.sh
# 产出 electron/dist/LPTV.AppImage，并拷贝到 lzc/content/appimage/LPTV.AppImage
```

脚本做的事：`npm install` → `npx electron-builder --linux AppImage`（内嵌
`frontend/` 为 extraResources）→ 拷贝到 lzc。首次拉取 Electron 二进制 ~90MB，之后走缓存。

---

## 组装远程 LPK 并部署

```bash
# 1) 产出 AppImage（上一步 build_electron.sh）
# 2) 组装最终 LPK（复用 chrome LPK 的 cde-supervisor/rim/drop/web）
CHROME_LPK=/path/to/cloud.lazycat.catlink.chrome.lpk \
APP=/path/to/LPTV.AppImage \
bash lzc/content/assemble_lpk.sh
# 产出 cloud.lazycat.catlink.lptv.lpk
# 3) 在懒猫商店/盒子侧上传该 LPK，浏览器打开 https://rlptv.<盒子名>/
```

> 远程层（rim/xpra/catlink SPA）只认「容器里的 X11 顶层窗口」，与窗口由谁创建无关。
> `launch_lptv.sh` 以 `--no-sandbox` 启动 Electron AppImage（root 容器必须），
> `app.setName('LPTV')` + `setTitle` + `setIcon` 做窗口伪装，xpra 才能正确显示任务栏图标。

---

## 已知限制 / 决策

- **H.264**：央视频是明文 H.264-over-MSE，无 DRM；Electron 官方构建自带 H.264 解码器，
  无需外部 Widevine/Chrome（`libexec/widevinecdm.so` 仅为旧 qt 调试路径保留）。
- **无 WM 最小化/最大化**：懒猫容器无窗口管理器时 `minimize/maximize` 可能不生效，
  主进程退回 `setBounds` 模拟；浮窗/置顶/全屏用 `setBounds`/`setAlwaysOnTop`/`setFullScreen`（不依赖 WM）。
- **UA**：保留 Windows Chrome/132 串（CMG 播放器按 UA 判定环境，与 Windows 版一致最稳）。
- **移动端**：LPTV 窗口固定在盒子容器（1280×720），手机/电视浏览器经 catlink SPA / xpra 等比缩放查看，
  LPTV 应用本身不做移动端布局；`package.yml` 已开放 **android / tvos** 平台支持（ios 暂未开放）。
