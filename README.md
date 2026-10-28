# LPTV — 远程电视客户端

## 软件介绍

LPTV 提供三条交付路径：

1. **本地 AppImage**：`LPTV.AppImage`（Electron 单包，~120MB），在任意 x86_64 Linux 桌面直接运行。
2. **懒猫远程应用（catlink / LPK）**：把该 AppImage 装入 LPK，在懒猫盒子上运行，用户在浏览器里看 / 控
   （对标 `cloud.lazycat.catlink.chrome.lpk`）。
3. **Android APK**：`lptv-*.apk`（Capacitor WebView，~30MB），安装在安卓设备上直接观看。

壳只做一件事：加载 YSP 官方 TV 直播页 + 注入增强 UI 层，播放永远由官方页面完成。
Electron 官方构建自带 H.264 专有编解码器（`ffmpeg_branding=Chrome`），YSP 的 H.264-over-MSE
直播流（无 EME/DRM）无需外部引擎即可直接播放。

## 架构设计

```
┌──────────────────────────────────────────────────────────────────┐
│ 本地模式（AppImage）                                                │
│   LPTV.AppImage (Electron) ── BrowserWindow 加载 YSP + 注入 UI       │
│   窗口直接显示在本地 X11/Wayland 桌面                                 │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ 远程模式（catlink / LPK） —— 用户在浏览器里看"LPTV 窗口"              │
│                                                                    │
│   懒猫盒子容器 (lzc-cde)                                            │
│   ┌───────────────────────────────────────────────────┐           │
│   │ LPTV.AppImage (Electron)                           │           │
│   │   main.js  ── BrowserWindow 加载 YSP (H.264 直解)    │           │
│   │   preload  ── contextBridge → window.lptv 桥        │           │
│   │   inject.js 覆盖层 ──▶ X11 顶层窗口                 │           │
│   │        ↑ 抓窗口位图                                   │           │
│   │ Xpra seamless (:7890) ── 视频编码 ── WS              │           │
│   │ rim (:8888) ── 会话/输入/剪贴板                      │           │
│   └───────────────────────────────────────────────────┘           │
│             │ 反代                                                  │
│   用户浏览器 → https://rlptv.<盒子名>/ → catlink SPA                 │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Android 原生应用（APK）                                              │
│   lptv-*.apk (Capacitor WebView, ~30MB)                            │
│   ┌─────────────────────────────────────────────────┐             │
│   │ index.html  (桥接页)                              │             │
│   │   ├─ iframe: yangshipin.cn/tv/home?pid=XXX       │ 画面源    │
│   │   └─ #lptv-root: inject.js 覆盖层 (UI + OSD)     │ 我们的UI  │
│   bridge.js ── window.lptv 桥                         │            │
│     ├─ get_channels()   ← android_asset/channels.json│            │
│     ├─ get_asset_image()← android_asset/logos/{pid}  │            │
│     ├─ play_channel(pid)← 更新 iframe src            │            │
│     └─ shot_save/chname← Canvas 截图 → 下载          │            │
│   Capacitor FileSystem ── 读取 bundles               │            │
│   WebView H.264 硬解 ── YSP 直播流直接播放             │            │
└──────────────────────────────────────────────────────────────────┘
```

> **为什么是 Electron？** YSP 是纯 H.264-over-MSE 直播流（无 EME/DRM）。Electron 官方构建
> 带 H.264 专有编解码器（`ffmpeg_branding=Chrome`），`BrowserWindow` 直接能播，无需外部引擎。
> 旧方案「pywebview + 真 Chrome/CDP」要 2 个 AppImage（~380MB），Electron 单包 ~120MB，
> 且窗口控制走 BrowserWindow 原生 API，不再手写 CDP。

核心模块：

| 模块 | 说明 |
|---|---|
| `electron/main.js` | 主进程：BrowserWindow + `ipcMain.handle('lptv:*')` 桥 + 窗口控制 + 注入 |
| `electron/preload.js` | `contextBridge` 暴露 `window.lptv`（~29 方法，全返回 Promise） |
| `electron/channels.json` | 59 频道表（央视 21 / CGTN 6 / 卫视 32） |
| `frontend/inject.js` | 前端 UI 注入层（顶栏 / 控制栏 / 频道面板 / EPG / 设置 / 手势 / 浮窗） |
| `frontend/splash.js` | 首次打开的启动动画 |
| `build/build_electron.sh` | 打包：`npm install` + `electron-builder` → `electron/dist/LPTV-<os>-<arch>-<version>.AppImage` |
| `android/build.sh` | 打包：复制前端资源 → `cap sync android` → gradle assembleRelease → `android/app/build/outputs/apk/release/*.apk` |
| `android/www/bridge.js` | Android 桥接层：读取 bundles/channels.json + logos/，注入 window.lptv API |
| `android/www/index.html` | Android 桥接页：iframe 加载 YSP + #lptv-root 覆盖层 |
| `lzc/` | 懒猫 catlink 远程包装（manifest / run.sh / launch_lptv.sh / assemble_lpk.sh） |

## 功能清单

| 模块 | 状态 | 说明 |
|---|---|---|
| 频道表（59 频道：央视 21 / CGTN 6 / 卫视 32） | ✅ 完整 | `electron/channels.json`（含 CCTV-14 无 cnlid、CCTV-16/4K/8K 的 `official` 消歧） |
| 注入层 UI（顶栏 / 控制栏 / 频道面板 / EPG / 设置 / 手势 / 浮窗） | ✅ 复用 | `frontend/inject.js` |
| 启动直达频道（`?pid=` 修竞态） | ✅ | `main.js` 读 `~/.local/share/lptv/lx.state.json` 的 `lastPid` |
| 频道切换 / 取流 | ✅ | 页面内 `window.__lxCctv.switchChannel`（主进程 `play_channel` / `copy_m3u8` 兜底） |
| 状态持久化（lastPid / favs / resumeLast / res / autoFullscreen / fit） | ✅ | 白名单 + JSON 落盘（`~/.local/share/lptv/`，与旧版同路径，状态延续） |
| 录制（webm 分块） | ✅ | `rec_open / append / close`（主进程写盘，同旧协议） |
| 截图（PNG） | ✅ | `shot_save`（base64 → PNG 落盘） |
| 窗口控制（最大化 / 全屏 / 浮窗 / 置顶 / 缩放 / 拖拽 / 关闭） | ✅ | BrowserWindow 原生 API；无 WM 下最小化 / 最大化退回 `setBounds` 模拟 |
| 自启动 | ✅ | XDG autostart（`~/.config/autostart/lptv.desktop`） |
| 资源图（关于二维码） | ✅ | `get_asset_image` 白名单 `icon.png` / `wechat_qr.jpg` |

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
