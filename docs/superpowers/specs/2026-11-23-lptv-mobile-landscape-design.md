# LPTV 网页版移动端强制横屏 — 设计（短）

日期：2026-11-23
状态：待批准（用户已选方案 A）

## 意图

网页版播放器 `/web/web/` 在手机（懒猫微服里的移动端）竖屏下 UI 缩成 16:9 小条、不可用。本改动让移动端**强制横屏**，与 APK 的 `android:screenOrientation="landscape"` 行为一致，保证 TV 式横屏体验。

## 背景（已查证）

- UI 是 1920×1080 设计画布，`applyDesignScale()` 用 `min(vw/1920, vh/1080)` contain 缩放（`transform-origin: top left`）——为横屏设计。
- APK 已强制横屏（`AndroidManifest android:screenOrientation="landscape"`，apply_tv.sh 固化）。
- 网页版无方向处理：竖屏下画布缩成小条贴左上，大片空白；`styleOfficial()` 视频仍 `object-fit:cover` 铺满（竖屏裁剪）。

## 方案（用户已选 A：强制横屏）

在 `android/www/inject.js`（现为唯一源）加**移动端竖屏引导**：

1. **触发条件**：`matchMedia("(hover: none) and (pointer: coarse)").matches`（真·触摸移动设备）**且** 竖屏（`window.innerHeight > window.innerWidth` 或 `(orientation: portrait)`）。**不用 `__lptvBridge`**——它在 `/web/web/` 恒真，会把桌面浏览器竖窗也误判成移动端。
2. **先尝试锁定**：`screen.orientation.lock('landscape')`（best-effort，`try/catch`，Capacitor WebView/全屏下可用；普通移动浏览器可能不可用，静默失败）。
3. **覆盖层引导**：锁定不可用或仍竖屏时，显示全屏覆盖层“请横屏观看 / 请旋转设备”，`position:fixed;inset:0;z-index` 高于 UI（遮住小条 UI），深色背景 + 居中图标/文案，`pointer-events:auto`。
4. **随方向切换显隐**：监听 `orientationchange`/`resize`，横屏时隐藏覆盖层，竖屏时显示。
5. **仅在移动端生效**：桌面（hover 存在）与智慧屏（非 coarse pointer）不受影响。

### 改动

- 修改：`android/www/inject.js`（唯一源，加 `applyRotatePrompt()` + boot 调用 + orientationchange 监听）。
- 同步生成物：`lpk/content/web/web/inject.js`（由 `lpk/build.sh` 从 android/www 生成；因 gitignored，手动 `cp` 同步）。

### 不改

- 不改变 1920×1080 设计画布 / `applyDesignScale` / `styleOfficial` / UI 布局（仅加竖屏引导层）。
- 不改 `android/www/index.html`、`bridge.js`、APK manifest（APK 已强制横屏）。

## 验证

1. `node --check android/www/inject.js` 通过。
2. `cmp -s android/www/inject.js lpk/content/web/web/inject.js`（生成物同步）。
3. `grep -c "请横屏\|orientation.lock" android/www/inject.js` ≥1。
4. 真机（盒子侧，人工）：手机竖屏进 `/web/web/` → 显示横屏引导；横屏 → 正常播放；桌面/智慧屏不出现引导层。

## 交接给实现者

- 引导层文案与样式自定（深色 `#04070d` 背景、居中“请横屏观看”+ 提示子文案），z-index 取 `2147483002`（高于底衬 2147483000 与视频 2147483001）。
- 触发条件用 `(hover:none) and (pointer:coarse)` 判真·移动，不用 `__lptvBridge`。
- `screen.orientation.lock` 仅 best-effort，失败静默，靠覆盖层引导。
