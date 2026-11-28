# LPTV 智慧屏 3 问题修复 — 设计（迭代 2，修正）

日期：2026-11-23
状态：已实现（待用户实测）

## 背景：迭代 1 的 `isTv()=__lptvBridge` 对智慧屏无效

迭代 1（mode-separation）假设智慧屏跑 `/web/` 播放器（加载 bridge.js → `__lptvBridge=true`）。
实测智慧屏是 **容器 Electron 窗口的 xpra 客户端**（`client.screen.0.display=Chromium 140`，
画布 1280x720），不加载 bridge.js → `__lptvBridge` 未定义 → `isTv()=false` → 桌面模式。
导致：② 黑边（contain）、③ 切换台卡死（桌面切换逻辑）、③ 位置不对（窗口溢出画布 + 不钉 (0,0)）。

## 修正方案（用户已批：B 主 + A 兜底 + 完整修 3 问题）

**模式信号改由 main 进程从 xpra 客户端判定**（渲染层无法自判，Electron 前端无 bridge.js）：

- `queryXpraClient()`：`xpra info <disp>` 解析 `client.screen.0.display` 与 `client.screen.0.size`。
- `isSmartClient()`：B 主 = display 以 `Chromium` 开头（HTML5 浏览器客户端 = 智慧屏）；
  A 兜底 = size <= 1280x720（智慧屏画布）。
- `queryActualScreenSize()` 首选 xpra 客户端真实屏幕（权威，非 Electron/xdpyinfo 的 X max 8192x4096）
  → `containerWinRect()` / `isFull` / 窗口尺寸 / 钉 (0,0) 全部修正。
- `lptv:env` 返回 `smart: isSmartClient()`；`additionalArguments` 按 `isSmartClient()` 设 `--lptv-smart=1`。

**渲染层**：
- `isTv()` = `__lptvBridge===true || __LPTV_ENV.smart/isTv===true`（智慧屏走 TV 行为：cover + 短看门狗）。
- `switchChannel` 桥接分支**回归 `__lptvBridge`**（不用 isTv()）：智慧屏跑 Electron 前端（同桌面 DOM），
  若走 `window.lptv.play_channel` 会经 IPC 递归回 `window.__lptv.switchChannel` → 死循环；
  必须走 `findOfficialButtons`（与桌面一致）。`__lptvBridge`（iframe 播放器）才走 bridge。
- 首开兜底（①）：智慧屏启动后 8s 视频未播放则自动重切当前频道（自动连接不点击解码页）。

## 改动文件

- `electron/main.js`：queryXpraClient/isSmartClient/getXpraClient + queryActualScreenSize 首选客户端
  尺寸 + additionalArguments/lptv:env 用 isSmartClient + display-metrics-changed 重新探测。
- `frontend/inject.js` + 镜像 `android/www/inject.js`：isTv() 新信号 + switchChannel 回归 __lptvBridge
  + 首开 8s 重切。
- `electron/preload.js`：无需改（smart 已由 main.js lptv:env 置为 isSmartClient，preload 直接暴露）。

## 验证

- `node --check` 三文件通过；`cmp` 双镜像字节一致；打包 AppImage asar 内 main.js 含 isSmartClient、
  无冲突标记；LPK `/web/` inject.js = 源码、内嵌 AppImage md5 一致。
- 待用户智慧屏实测：等比 cover、切换台不卡死、位置对、首开不显示解码页。
