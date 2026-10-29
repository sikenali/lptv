# LPTV（懒猫微视） — 远程电视客户端

## 软件介绍

LPTV 提供四条交付路径：

1. **Linux 本地 AppImage**：`LPTV.AppImage`（Electron 单包，约 120MB），在任意 x86_64 Linux 桌面直接运行。
2. **懒猫远程应用（catlink / LPK）**：把 AppImage 装入 LPK（`cloud.lazycat.catlink.lptv-*.lpk`），以独立 app id `rlptv` 运行，用户在浏览器里看 / 控。
3. **Windows 便携 exe**：`LPTV-*-portable.exe`（Electron portable 单文件，双击即用、免安装）。
4. **Android APK**：`LPTV-all-*-release.apk`（Capacitor WebView，约 5MB），安装在安卓设备 / 电视上观看。

壳只做一件事：加载 YSP 官方 TV 直播页 + 注入增强 UI 层，播放永远由官方页面完成。
Electron 官方构建自带 H.264 专有编解码器（`ffmpeg_branding=Chrome`），YSP 的 H.264-over-MSE
直播流（无 EME/DRM）无需外部引擎即可直接播放。

## 架构设计

```
┌──────────────────────────────────────────────────────────────────┐
│ 本地模式（AppImage / Windows portable）                             │
│   LPTV.AppImage (Electron) ── BrowserWindow 加载 YSP + 注入 UI       │
│   窗口直接显示在本地桌面                                             │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ 远程模式（catlink / LPK, app id = rlptv）—— 用户在浏览器里看"LPTV 窗口" │
│   懒猫盒子容器 (lzc-cde)                                            │
│   ┌───────────────────────────────────────────────────┐           │
│   │ LPTV.AppImage (Electron)                           │           │
│   │   main.js  ── BrowserWindow 加载 YSP (H.264 直解)    │           │
│   │   preload  ── contextBridge → window.lptv 桥        │           │
│   │   inject.js 覆盖层 ──▶ X11 顶层窗口                 │           │
│   │        ↑ 抓窗口位图                                   │           │
│   │ Xpra seamless ── 视频编码 ── WS                      │           │
│   │ rim (会话层代理, 支持 rlptv) ── /rlptv/* 路由         │           │
│   └───────────────────────────────────────────────────┘           │
│             │ 反代                                                  │
│   用户浏览器 → https://rlptv.<盒子名>/ → catlink SPA                 │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Android 原生应用（APK, 懒猫微视, TV 模式, ~5MB）                     │
│   index.html (桥接页)                                                │
│     ├─ iframe: yangshipin.cn/tv/home?pid=XXX       (画面源)         │
│     └─ #lptv-root: inject.js 覆盖层 (UI + OSD)     (我们的 UI)      │
│   bridge.js ── window.lptv 桥                                        │
│     ├─ get_channels()   ← assets/public/channels.json               │
│     ├─ get_asset_image()← assets/public/logos/{pid}                 │
│     └─ play_channel(pid)← 更新 iframe src                            │
│   WebView H.264 硬解 ── YSP 直播流直接播放                           │
└──────────────────────────────────────────────────────────────────┘
```

> **为什么是 Electron？** YSP 是纯 H.264-over-MSE 直播流（无 EME/DRM）。Electron 官方构建
> 带 H.264 专有编解码器（`ffmpeg_branding=Chrome`），`BrowserWindow` 直接能播，无需外部引擎。
> 旧方案「pywebview + 真 Chrome/CDP」要 2 个 AppImage（约 380MB），Electron 单包约 120MB，
> 且窗口控制走 BrowserWindow 原生 API，不再手写 CDP。

核心模块：

| 模块 | 说明 |
|---|---|
| `electron/main.js` | 主进程：BrowserWindow + `ipcMain.handle('lptv:*')` 桥 + 窗口控制 + 注入 |
| `electron/preload.js` | `contextBridge` 暴露 `window.lptv`（31 个方法，全返回 Promise） |
| `electron/channels.json` | 59 频道表（央视 21 / CGTN 6 / 卫视 32） |
| `frontend/inject.js` | 前端 UI 注入层（顶栏 / 控制栏 / 频道面板 / EPG / 设置 / 手势 / 浮窗 / 悬浮窗） |
| `frontend/splash.js` | 首次打开的启动动画（字标横幅 + 彩色进度条） |
| `build/build_electron.sh` | 打包：`npm install` + `electron-builder` → `electron/dist/LPTV-<os>-<arch>-<version>.AppImage` |
| `android/build.sh` | 打包：复制前端资源 → `cap sync android` → `apply_tv.sh` → gradle assembleRelease → 签名 APK |
| `android/apply_tv.sh` | 幂等固化 Android TV 模式（横屏 / banner / leanback / 懒猫微视名 / 图标） |
| `android/www/bridge.js` | Android 桥接层：读取 bundles/channels.json + logos/，注入 window.lptv API |
| `android/www/index.html` | Android 桥接页：iframe 加载 YSP + #lptv-root 覆盖层 |
| `lzc/`（本地） | 懒猫 catlink 远程包装（`manifest.yml` / `package.yml` / `run.sh` / `launch_lptv.sh` / `assemble_lpk.sh`） |
| `tools/set_version.js` | 跨平台同步版本号到 `electron/package.json` / `android/build.gradle` / `lzc/package.yml` |

## 功能清单

| 功能 | 状态 | 说明 |
|---|---|---|
| 频道表（59 频道：央视 21 / CGTN 6 / 卫视 32） | ✅ 完整 | `electron/channels.json`，含央视/卫视分类标签、频道号/台标/EPG |
| 注入层 UI（顶栏 / 控制栏 / 频道面板 / EPG / 设置 / 手势 / 浮窗） | ✅ | `frontend/inject.js`（MiSans / JetBrains Mono 字体，随包注入） |
| 启动直达频道 | ✅ | 读状态 `lastPid` 自动恢复上次频道，`?pid=` 直达 |
| 频道切换 / 取流 | ✅ | `switchChannel`（官方页 `window.lptv.switchChannel`）；Android 走 `bridge.play_channel`（iframe） |
| 状态持久化（lastPid / favs / resumeLast / res / autoFullscreen / fit / topbarAlways / perfMode） | ✅ | 白名单 + JSON 落盘（`~/.local/share/lptv/`，与旧版同路径，状态延续） |
| 录制（webm 分块） | ✅ | `rec_open / append / close`（主进程写盘） |
| 截图（PNG） | ✅ | 画面捕获 → PNG 落盘 |
| 窗口控制（最大化 / 全屏 / 浮窗 / 置顶 / 缩放 / 拖拽 / 关闭） | ✅ | BrowserWindow 原生 API；无 WM 下最小化 / 最大化退回 `setBounds` 模拟；浮窗自适应视频比例（16:9→480×270、竖版→270×480） |
| 自启动 | ✅ | XDG autostart（`~/.config/autostart/lptv.desktop`） |
| 视频流畅度优化 | ✅ | 关渲染/定时器/电源节流（`backgroundThrottling=false`、`disable-renderer-backgrounding`、`powerSaveBlocker`），xpra/浮窗下不再假卡顿 |
| 字体 | ✅ | MiSans（正文）+ JetBrains Mono（数字/等宽），经 `get_asset_font` IPC 注入 `@font-face` |
| **Android** | | |
| 横屏 TV 模式 | ✅ | `screenOrientation=landscape` + `leanback`/`touchscreen` + TV banner |
| 启动图字标 | ✅ | splash 显示 `lptv.png` 字标横幅（非 icon.png 兜底） |
| 播放 | ✅ | iframe 加载 YSP 官方播放器（`bridge.play_channel`），WebView 硬解 |
| APK 签名 | ✅ | v1 + v2 签名（`release.keystore`，keystore 不入库） |
| **远程（catlink / LPK）** | | |
| 独立 app id | ✅ | `rlptv`（不再是冒充 `rchrome`），无 chrome 空包，任务栏按 LPTV 图标 |
| rim 会话层 | ✅ | rim（`lzc-cde` 源码）新增 `rlptv` 支持：`/rlptv/*` 安装/更新路由、`appName=lptv` |

## 软件声明

### 重要声明

1. **仅限个人学习研究**
   本项目仅供网络协议分析、爬虫开发、自动化脚本调试等技术实验使用，严禁投入盈利项目、商业场景以及一切违反当地法律法规的活动。

2. **无官方隶属关系**
   本项目与 CCTV、央视、各地方电视台及任何 IPTV 运营商不存在官方合作、授权或从属关系。所有节目源均来自互联网公开地址，项目不生成、不储存、不编辑任何音视频素材。

3. **知识产权与免责声明**
   各频道内容版权归版权方所有，使用行为需满足当地法律规范。项目不保证服务的持续性、稳定性与适配性，对于使用本项目产生的一切直接、间接损失不承担任何责任。

### 商标声明

**懒猫微视™** 为未注册商标，**懒猫微服™** 为企业注册商标，两者之间没有关联关系。本开源项目仅用于个人学习与交流，非懒猫微服官方发布的电视应用。

### 字体说明

本项目界面使用以下字体（均随 `frontend/fonts/` 打包，经 `get_asset_font` IPC 读取并注入 `@font-face`）：

- **MiSans**（小米）——正文/界面字体，完整 CJK 覆盖，含 Regular/Medium/Demibold/Bold 四档字重。许可遵循[《MiSans 字体知识产权许可协议》](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf)。
- **JetBrains Mono**（JetBrains）——数字/等宽字体（频道号、版本号等），可变字重 400–800，OFL 开源许可。

## License

[MIT](./LICENSE)

<p align="center">Powered by LightOS · Made for LCMD</p>
