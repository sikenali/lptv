# LPTV（懒猫微视） — 远程电视客户端

<p align="center">
  <strong>加载 YSP 官方电视直播 · 注入增强 UI 层 · 跨平台桌面 / 远程 / 移动应用</strong>
</p>

<p align="center">
  <img src="frontend/icon.png" width="120" height="120" alt="LPTV Logo">
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white">
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-ES2020-F7DF1E?logo=javascript&logoColor=white">
  <img alt="Capacitor" src="https://img.shields.io/badge/Capacitor-Android-119EFF?logo=capacitor&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-yellow">
</p>

## 软件介绍

LPTV（懒猫微视）是一款远程电视直播客户端。壳只做一件事：加载 YSP 官方 TV 直播页并注入增强 UI 层，播放永远由官方页面完成。基于 Electron + Capacitor 构建，覆盖 Linux 桌面、Windows 便携、macOS 桌面、懒猫远程应用（catlink / LPK）与 Android TV 五条交付路径。

**核心功能**

| 功能 | 说明 |
|------|------|
| 频道直播 | 59 频道（央视 21 / CGTN 6 / 卫视 32），官方页 H.264-over-MSE 直解播放 |
| 注入层 UI | 顶栏 / 控制栏 / 频道面板 / EPG / 设置 / 手势 / 浮窗 / 悬浮窗 |
| 录制与截图 | MediaRecorder webm 分块录制、PNG 画面截图落盘 |
| 窗口控制 | 最大化 / 全屏 / 浮窗 / 置顶 / 缩放 / 拖拽，浮窗自适应视频比例 |
| 状态持久化 | lastPid / favs / resumeLast / fit / perfMode 等白名单 JSON 落盘 |
| 视频流畅度 | 关闭渲染 / 定时器 / 电源节流，远程与浮窗下不再假卡顿 |

## 技术实现

### 交付路径

1. **Linux 本地 AppImage**：`LPTV.AppImage`（Electron 单包，约 120MB），在任意 x86_64 Linux 桌面直接运行。
2. **懒猫远程应用（catlink / LPK）**：把 AppImage 装入 LPK（`cloud.lazycat.catlink.lptv-*.lpk`），以独立 app id `rlptv` 运行，用户在浏览器里看 / 控。
3. **Windows 便携 exe**：`LPTV-*-portable.exe`（Electron portable 单文件，双击即用、免安装）。
4. **macOS dmg**：`LPTV-mac-{arm64,x64}-*.dmg`（Electron 单包），Apple Silicon 与 Intel 双架构各一份，拖入 Applications 即可。
5. **Android APK**：`LPTV-all-*-release.apk`（Capacitor WebView，约 5MB），安装在安卓设备 / 电视上观看。

### 为什么是 Electron

YSP 是纯 H.264-over-MSE 直播流（无 EME/DRM）。Electron 官方构建带 H.264 专有编解码器（`ffmpeg_branding=Chrome`），`BrowserWindow` 直接能播，无需外部引擎，且窗口控制走 BrowserWindow 原生 API，不再手写 CDP。

### 核心模块

| 模块 | 说明 |
|------|------|
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

### 构建

```bash
# 安装依赖
npm install

# 构建 Linux AppImage
cd electron && npm run dist
# 产物: electron/dist/LPTV-linux-x86_64-<version>.AppImage

# 构建 Windows portable exe（原生 Windows）
cd electron && npx electron-builder --win portable
# 产物: electron/dist/LPTV-<version>-portable.exe

# 构建 macOS dmg（arm64 + x64，原生 macOS）
cd electron && npx electron-builder --mac --x64 --arm64
# 产物: electron/dist/LPTV-mac-{arm64,x64}-<version>.dmg

# 构建懒猫微服 LPK（需先构建 AppImage）
bash lzc/content/assemble_lpk.sh
# 产物: lzc/cloud.lazycat.catlink.lptv-<version>.lpk

# Android APK（Capacitor + gradle）
cd android && bash build.sh
```

### Android TV

横屏 TV 模式（`screenOrientation=landscape` + `leanback`/`touchscreen` + TV banner），iframe 加载 YSP 官方播放器（`bridge.play_channel`），WebView 硬解，v1 + v2 签名。

### 远程（catlink / LPK）

独立 app id `rlptv`，任务栏按 LPTV 图标；rim 会话层新增 `rlptv` 支持：`/rlptv/*` 安装/更新路由、`appName=lptv`。

---

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

## License

[MIT](./LICENSE)

<p align="center">Powered by LightOS · Made for LCMD</p>
