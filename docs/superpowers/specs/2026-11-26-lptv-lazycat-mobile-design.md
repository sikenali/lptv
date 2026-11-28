# LPTV 懒猫微服移动客户端（非 APK）播放器模式 — 设计

日期：2026-11-26
状态：待批准（用户已选方案 B）

## 意图

懒猫微服移动客户端安装懒猫微视后，打开的是 LPK 入口 → `/web/catlink-wrap.html` → `/catlink/` 的 xpra 投射链路。移动端需要一套与 CDE 桌面、智慧屏完全分开的“纯播放器”体验：

1. 启动不显示首页；首次自动播 CCTV-1，之后恢复上次频道；画面加载后横屏。
2. 点屏幕出控制条；频道栏只在左侧，右侧保留播放画面。
3. 节目单只在右侧，左侧保留播放画面。
4. 播放页隐藏首页/音量按钮，改用手机系统媒体音量。
5. 保留切台画面。

## 背景（已查证）

- 移动客户端不是 APK：没有 `__lptvBridge`，也没有我们自己的 `AndroidManifest`。它在服务端看来就是一个 xpra HTML5 客户端。
- 现有 `electron/main.js` 的 `isSmartClient()` 会把“Chromium / 画布 ≤1280×720”的客户端判成智慧屏；移动客户端因此会拿到智慧屏模式（`__LPTV_ENV.smart=true`）。
- 现有前端是 1920×1080 设计画布，`applyDesignScale()` 在手机视口（约 800×360）会缩到约 0.33；18px 文字实际约 6px，按钮也过小。
- 频道/节目单面板已经存在左右分栏和画面区（`lv-left-scene` / `lv-right-scene`），但整层有 45% 暗色遮罩；面板宽度按 TV 画布为 32%/40%。
- 控制条中间有“首页/音量”；面板自动收起依赖 `mouseleave`；音量被 `cfg.volume` 锁定。
- 切台页 `openSwitching → finishSwitching` 已存在，可复用。
- 移动客户端触控经 xpra HTML5 客户端转为鼠标事件，`click`/`pointer` 路径仍可用。
- 视频在服务端 Electron 播放，声音经 xpra 传到手机；手机系统音量键控制客户端音频输出。
- 客户端自带“设置”菜单项（打开 `/?setting`），首页隐藏后设置仍可达。

## 目标

- 移动端启动直达播放（无首页），首次 CCTV-1、后续上次频道。
- 移动端使用独立的响应式布局，不复用 1920 画布缩放。
- 频道/节目单为单侧侧栏，另一侧播放画面清晰可见。
- 播放页只保留频道/节目单入口；系统音量控制声音。
- 切台画面保留且适配手机尺寸。
- CDE、智慧屏、APK 行为不变。

## 非目标

- 不重做 APK（Capacitor）路径；`__lptvBridge` 仍按原逻辑走。
- 不改变 CDE 桌面与智慧屏的 1920 画布、鼠标指针、白色圆圈光标。
- 不新增移动端设置页；设置继续走客户端自带入口。

## 反目标

- 不因移动端改动破坏智慧屏白色圆圈光标或 CDE 鼠标指针。
- 不依赖 `AndroidManifest` 或 `__lptvBridge` 判移动端。
- 不让移动端进入首页后出现空白/官方页裸露。
- 不把服务端视频静音或锁在 `cfg.volume`，导致系统音量无效。

## 约束

- 移动端识别必须来自主进程对 xpra 客户端信息的解析（客户端 UA / 屏幕），不能靠渲染层媒体查询（服务端 Electron 看到的是虚拟鼠标，不是手机触摸）。
- 横屏没有 Manifest 可用：只能 `screen.orientation.lock('landscape')` 尽力锁，失败时显示旋转提示兜底。
- 移动端触控是 xpra 转发的鼠标事件，不新增原生触摸 API 依赖。
- 移动端布局使用 WebView 视口的 vw/vh，服务端窗口尺寸即手机画布尺寸。

## 方案对比

### 方案 A：只改行为，保留 1920 画布缩放
改动小、风险低；但手机上文字/按钮仍是 1/3 大小，体验不会真正改善。

### 方案 B（已选）：独立移动端模式
新增移动端识别与 `mobile` 根类；移动端不走 1920 画布缩放，改为按视口响应式布局（vw/vh、大触控目标）；CDE/智慧屏路径完全不动。选择原因：需求 2/3/4 本质是手机专用排版与触控入口，只改行为解决不了可读性。

## 设计

### 1. 移动端识别与环境传递

- `electron/main.js`：扩展 `queryXpraClient()`，解析客户端 UA（`xpra info` 中的 `client.*session-type*full*`，兼容 `client.session-type-full` / `client.session-type.full`）、`client.platform`（Android/iOS 等）和现有 `client.screen.0.size`；解析结果写一条 `[LPTV-env] client=… mobile=… smart=…` 日志，便于真机核对实际字段。
- 新增 `isMobileXpraClient(c)`：
  - `client.platform` 为 `Android`/`iOS`（或 UA 含 `Android`/`iPhone`/`iPad`/`iPod`/`Mobile`），且不含智慧屏标记 `LazyCatTvOsClient`/`Lazycat_ContentView` → 移动端。
  - UA 与 platform 都缺失时，才用画布宽度 < 1100 兜底（智慧屏 1280、桌面 1920 不命中；小 CDE 窗口有误判风险，故仅作最后兜底）。
- `isSmartClient()` 先排除移动端；移动端 `smart=false`、`mobile=true`。
- `lptv:env` 返回 `{smart, mobile, container, isTv: smart}`。
- `preload.js` 读取并暴露 `__LPTV_ENV.mobile`；隔离世界同步副本同样带 `mobile`。
- 窗口几何仍用 `isChromiumXpraClient()` 判全屏，移动端照旧铺满画布。

### 1.1 客户端重连与模式变化

- 页面只在 document-start 读一次 `__LPTV_ENV`。若已有窗口在客户端断开后又被新客户端连上，或客户端类型从桌面/智慧屏变为移动端，模式会过期。
- 主进程在客户端轮询中记录“已应用模式”；分类结果变化（mobile/smart/desktop）时 `win.reload()`，让新客户端重新走 document-start 环境读取。
- 移动端从“无客户端”变为“有客户端”（重连）时也 reload：移动端启动自动播放上次频道，避免留下冻结画面且没有播放按钮。
- CDE/智慧屏同模式重连不额外 reload，保持现有行为。

### 2. 前端模式

- `web/inject.js`：`IS_MOBILE = __LPTV_ENV.mobile === true`（不把 `__lptvBridge` 纳入，APK 路径不变）。
- `isTv()` 对移动端返回 false；智慧屏专属行为（白色圆圈光标、智慧屏首开兜底等）不落到移动端。
- 根节点加 `mobile` 类；`applyDesignScale()` 对移动端直接 `zoom=1 / transform=none / left=top=0`，布局由移动端 CSS 按 100vw/100vh 控制。
- `setView("home")` 在移动端改为 `playing`，避免首页空白；移动端不调用 `goHome()`。
- 启动：不显示首页；频道数据就绪后 `pid = cfg.lastPid || channels[0].pid`（CCTV-1），强制 `switchChannel(pid)`；`_suppressAutoplay=false`；启动遮罩由 splash 的视频就绪判定淡出。
- 横屏：boot 后 best-effort `screen.orientation.lock('landscape')`；失败且竖屏时显示旋转提示。现有提示用 `(hover:none) and (pointer:coarse)` 触发，在服务端 Electron 不可靠；移动端改为 `IS_MOBILE` + 竖屏判定触发，不依赖媒体查询。移动端不因竖屏隐藏 UI。

### 3. 控制条与侧栏

- 移动端播放画面单击 → `showControls(true)`，沿用自动隐藏计时（可调短到约 3s）。点击按钮/面板不触发。
- 控制条只保留左侧“频道”、右侧“节目单”；中间“首页/音量”隐藏，竖向音量组件隐藏。
- 左侧频道侧栏宽度约 55vw，右侧节目单侧栏约 60vw；面板自身玻璃/模糊保留，整层 45% 暗色遮罩在移动端取消，另一侧视频保持清晰。
- 面板滑入/滑出、场景区点击关闭沿用现有机制；移动端隐藏画面区信息胶囊，最大化视频区域。
- 面板内触控目标 ≥44px，列表可滚动；字体/间距按手机视口重排。
- xpra 触控经鼠标事件转发，单指拖动不保证触发浏览器原生滚动；移动端面板列表额外实现“按住拖动改变 scrollTop”，拖动超过阈值时抑制点击，避免 30+ 频道列表无法滚动。

### 4. 音量

- 移动端视频元素固定 `volume=1`、`muted=false`；`cfg.volume` 的 `volumechange` 锁定在移动端跳过。
- 这是**运行期覆盖**，不写 `cfg.volume`/`cfg.muted`，避免覆盖 CDE/智慧屏用户保存的音量偏好。
- 手机系统媒体音量键控制客户端音频输出；服务端不做应用内音量 UI。
- 自动播放策略仍保留现有“静音起播后恢复”的兜底；移动端恢复目标为 1.0。

### 5. 切台

- 移动端启动与手动切台都走现有 `openSwitching → finishSwitching`；不跳过切台画面。
- 切台页按手机尺寸重排（圆环/图标/信息卡/字体），保留现有动画与就绪判定。

### 6. 移动端样式范围

- 仅覆盖移动端会用的视图：播放页、左侧频道、右侧节目单、切台页、顶部时间。
- 首页视图在移动端隐藏（不参与布局），设置页仍由客户端入口打开。
- 所有移动端覆盖限定在 `#lptv-root.mobile` 下，不影响 CDE/智慧屏。

## 留给实现者

- 移动端 CSS 的具体尺寸/间距/字号（以 800×360 视口为基准，保证触控目标 ≥44px、文字可读）。
- 单击显示控制条的自动隐藏时长（建议 3s）。
- 画面区信息胶囊在移动端是否完全隐藏（建议隐藏）。
- 切台页移动端具体尺寸。
- 旋转提示文案/样式沿用现有实现即可。

## 验证

1. `node --check web/inject.js`、`node --input-type=module --check < electron/preload.js`（或等效）、`node --check electron/main.js` 通过。
2. 主进程模拟 `xpra info` 输出：移动 UA/platform → `mobile=true, smart=false`；智慧屏 UA → `smart=true, mobile=false`；CDE UA → 两者 false；UA/platform 都缺失时小画布兜底。
3. 移动端启动不出现首页；首次请求 CCTV-1，第二次请求上次频道。
4. 单击画面显示控制条；左侧频道/右侧节目单打开后另一侧视频可见且不被整层遮罩压暗。
5. 控制条无首页/音量；视频 `volume=1`、`muted=false`，且 `cfg` 未被改写。
6. 面板列表单指拖动可滚动，拖动后不误触发频道点击。
7. 切台页出现并完成到播放页。
8. 客户端断开再连上（同模式）→ 移动端 reload 并恢复上次频道；模式变化 → reload 后按新客户端模式运行。
9. 真机日志包含 `[LPTV-env] client=… mobile=… smart=…`，用于核对实际 UA/platform 字段。
10. CDE/智慧屏回归：鼠标指针/白色圆圈光标、首页入口、1920 画布均不变。
