# LPTV 智慧屏/CDE 模式分离 — 设计

日期：2026-11-23
状态：待批准

## 意图

用户反馈：智慧屏画面显示不全（视频被钳到 1280x720 居中，四周黑边）；CDE 桌面窗口最大化时画面未铺满。要求从程序层面**按模式分离**设计，避免 CDE 的"窗口模式"逻辑误伤智慧屏。

## 目标

1. **智慧屏（TV）模式**：默认全屏，视频铺满整屏，等比（不拉伸变形，裁边铺满）。
2. **CDE 桌面模式**：默认窗口模式（1280x720 窗口），最大化时视频铺满最大化窗口，等比。
3. 用明确的模式信号分离两种环境，不再依赖"视口尺寸启发式"。

## 非目标 / 反目标

- 不改变 Android APK 的分发行为（Android 归入 TV 模式，全屏）。
- 不改变 CDE 容器窗口的 1280x720 尺寸锁（那是 main.js 的窗口锁，与视频钳制无关）。
- 不引入 xpra 7.0 硬件编码（CDE 顿挫是另一独立问题，本轮不碰）。
- 不破坏"双镜像字节一致"（frontend/inject.js == android/www/inject.js）。

## 约束

- 模式信号必须**不依赖**坏的 `IS_CONTAINER` 检测（智慧屏实测 `isContainer:false`）。
- `styleOfficial()` 的 1280x720 视频钳制（视口尺寸启发式）是"显示不全"的根因，须按模式处理。
- 改动只涉及 `frontend/inject.js`（+ 镜像 `android/www/inject.js`），不需要改 main.js。

## 现状（改动前）

- `styleOfficial()`：`if (vw>1280 || vh>720)` 把视频钳到 1280x720 居中。智慧屏视口 >1280x720 时被误钳 → 显示不全。
- `spinSmart()` = `window.__LPTV_ENV.smart === true`（= IS_CONTAINER）。实测智慧屏 `IS_CONTAINER=false`、CDE 容器 `true` → 模式**反了**：CDE 被当 smart、智慧屏被当桌面。
- 该错误导致：智慧屏换台遮罩卡死（没拿到 smart 行为，Fix A 已单独修）；智慧屏被当桌面窗口钳制（本轮修）。

## 方案（用户已选）

**模式信号**：`isTv() = window.__lptvBridge === true`。
- 智慧屏 + Android：加载 `bridge.js` → `__lptvBridge=true` → TV 模式。
- CDE 桌面 + 本地桌面：Electron 前端不加载 bridge.js → `__lptvBridge` 未定义 → 桌面模式。

### 改动清单（inject.js，两镜像同步）

1. **新增 `isTv()`**：`return window.__lptvBridge === true;`（智慧屏 + Android）。
2. **重定义 `spinSmart()`** → `return isTv();`（把"smart 行为"从 CDE 挪到智慧屏：800ms 延迟遮罩、5s 看门狗、fit→cover 迁移。CDE 回到桌面行为：即时遮罩、12s 看门狗）。
3. **`styleOfficial()` 去掉 1280x720 视频钳制**：视频始终铺满当前窗口/视口（vW=vw, vH=vh, vL=0, vT=0），等比由 `cfg.fit` 决定。
   - 智慧屏：视口=整屏 → 铺满全屏（cover）。
   - CDE 窗口：默认 1280x720 窗口 → 铺满窗口；最大化 → 铺满最大化窗口。
4. **`switchChannel()` 按模式分支（用户新增要求，保证不卡死）**：
   - TV 模式（`isTv()`）：走智慧屏切换逻辑 —— `bridge` 路径 `window.lptv.play_channel(pid)`（设 iframe.src 加载官方播放器），不进 `findOfficialButtons`/整页路由兜底。
   - 桌面模式（`!isTv()`）：走 CDE 窗口切换逻辑 —— `findOfficialButtons` 点击 + 8s 整页路由兜底。
   - 改 `switchChannel` 的桥接分支条件：`if (isTv() && window.lptv && typeof window.lptv.play_channel === 'function')`。
5. **fit 默认**：智慧屏迁移到 cover（已有逻辑，条件改为 `isTv()`）；桌面保持用户设置（默认 contain，等比，16:9 窗口下=铺满）。
6. `[LPTV-geo]` 诊断保留（打 vw/vh/box/fit，便于核对模式生效）。

### 不改

- main.js 容器窗口逻辑（1280x720 尺寸锁、isFull 自动全屏）保持。
- 智慧屏浏览器已全屏显示 /web/ 播放器，视频铺满视口即可，无需 requestFullscreen。

## 交接给实现者的决定

- `isTv()` 用 `window.__lptvBridge === true`（严格布尔），不依赖 `__LPTV_ENV`。
- `spinSmart()` 改为 `isTv()` 的返回值；若个别调用点需区分 Android 与智慧屏，后续再议（本轮不区分）。
- `styleOfficial()` 的 1280x720 分支整体删除（含 `vL/vT` 居中计算）。
- CDE 最大化铺满会增加 xpra 编码量（1920x1080 vs 1280x720），用户已知情并接受；若回顿挫，后续在 90_lzc.conf 或帧率侧平衡。
