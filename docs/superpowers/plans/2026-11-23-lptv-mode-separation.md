# LPTV 智慧屏/CDE 模式分离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `window.__lptvBridge` 作为唯一模式信号分离智慧屏（TV，全屏+等比+smart 切换）与 CDE 桌面（窗口模式），修复智慧屏显示不全并保证切换台不卡死。

**Architecture:** 单一模式信号 `isTv() = window.__lptvBridge === true`（智慧屏+Android 加载 bridge.js 才真；CDE/本地桌面 Electron 前端不加载→false，不依赖坏掉的 IS_CONTAINER）。`spinSmart()` 重定义为 `isTv()`；`styleOfficial` 去掉 1280x720 视口钳制（视频铺满视口）；`switchChannel` 桥接分支改用 `isTv()`。改动只在 inject.js（双镜像字节一致），不动 main.js。

**Tech Stack:** 浏览器注入脚本（ES5，var/function 风格，无构建步骤，无单测框架）。Electron AppImage（electron-builder）+ LPK（lzc-cli）+ GitHub release（gh）。

**Spec:** `docs/superpowers/specs/2026-11-23-lptv-mode-separation-design.md`

## Global Constraints

- `frontend/inject.js` 与 `android/www/inject.js` **字节一致**（`cmp -s` 必须通过）。
- **不改** `electron/main.js`（容器窗口 1280x720 尺寸锁、isFull 自动全屏保持）。
- 前端无单测框架 → 每步用 `node --check` / `cmp` / `grep` 验证，不用 pytest。
- `spinSmart()` 语义改为"TV/智慧屏"；CDE 容器回归桌面行为（即时遮罩、12s 看门狗）。
- 智慧屏 fit 默认 `cover`（铺满无黑边）；CDE 保持用户设置（默认 contain 等比）。

## Review Focus

- **智慧屏视口 >1280x720（1080p/4K）**：必须铺满整屏，不得被钳到 1280x720 → 由 Task 2 移除钳制覆盖。
- **CDE 最大化**：视频铺满最大化窗口（等比），不是 1280x720 小窗 → Task 2。
- **智慧屏切换台不卡死**：走 bridge `play_channel`，不进按钮点击/整页路由 → Task 3。
- **模式判定不依赖 IS_CONTAINER**：智慧屏实测 isContainer:false 也必须正确进 TV 模式 → Task 1。
- **双镜像**：两文件任一改动后字节一致 → Task 4。

---

### Task 1: 模式信号 `isTv()` + 重定义 `spinSmart()`

**Files:**
- Modify: `frontend/inject.js`（spinSmart 函数区，约 1762-1766 行）

**Interfaces:**
- Produces: `isTv() -> boolean`（`window.__lptvBridge === true`）；`spinSmart() -> boolean`（改为返回 `isTv()`）。

- [ ] **Step 1: 加 `isTv()` 并把 `spinSmart()` 改为返回它**

在 `var _spinWatchdog = null;` 附近（`spinSmart` 定义前）加：
```js
function isTv() {
  return window.__lptvBridge === true;
}
```
`spinSmart()` 函数体改为：
```js
function spinSmart() {
  try { return isTv(); } catch (e) { return false; }
}
```

- [ ] **Step 2: 验证两个函数已落地**

Run: `grep -n "function isTv" frontend/inject.js && grep -n "return isTv()" frontend/inject.js`
Expected: 各输出一行（`function isTv()` 和 `return isTv();`）。

- [ ] **Step 3: 语法检查**

Run: `node --check frontend/inject.js`
Expected: 无输出（exit 0）。

---

### Task 2: `styleOfficial()` 移除 1280x720 视口钳制

**Files:**
- Modify: `frontend/inject.js`（styleOfficial 内，约 263-270 行）

**Interfaces:**
- Consumes: 无（不依赖 isTv，双模式一致铺满视口）。
- Produces: 视频元素 `vW/vH/vL/vT` 恒等于视口（无钳制）。

- [ ] **Step 1: 删除钳制分支，视频恒铺满视口**

把：
```js
var vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
var vW = vw, vH = vh, vL = 0, vT = 0;
// 只按视口尺寸判定：智慧屏视口 1279x719 → 不限制；桌面窗口被放大 → 限制 1280x720
if (vw > 1280 || vh > 720) {
  vW = 1280; vH = 720;
  vL = Math.round((vw - vW) / 2);
  vT = Math.round((vh - vH) / 2);
}
```
改为：
```js
var vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
// 视频始终铺满当前窗口/视口（智慧屏=整屏；CDE 窗口=窗口尺寸含最大化）。
// 不再按视口尺寸钳到 1280x720（会误伤视口>1280x720 的智慧屏 → 显示不全）。
var vW = vw, vH = vh, vL = 0, vT = 0;
```

- [ ] **Step 2: 验证钳制已移除**

Run: `grep -n "vW = 1280" frontend/inject.js`
Expected: 无输出（该赋值已删除）。

- [ ] **Step 3: 验证铺满注释在**

Run: `grep -n "视频始终铺满当前窗口" frontend/inject.js`
Expected: 输出一行。

- [ ] **Step 4: 语法检查**

Run: `node --check frontend/inject.js`
Expected: 无输出。

---

### Task 3: `switchChannel()` 桥接分支改用 `isTv()`

**Files:**
- Modify: `frontend/inject.js`（switchChannel 桥接分支，约 630 行）

**Interfaces:**
- Consumes: `isTv()`（Task 1）。
- Produces: 无新接口；智慧屏走 `window.lptv.play_channel(pid)`，桌面走按钮点击。

- [ ] **Step 1: 把 `window.__lptvBridge` 条件改为 `isTv()`**

把：
```js
if (window.__lptvBridge && window.lptv && typeof window.lptv.play_channel === 'function') {
```
改为：
```js
if (isTv() && window.lptv && typeof window.lptv.play_channel === 'function') {
```

- [ ] **Step 2: 验证条件已改用 isTv()**

Run: `grep -n "isTv() && window.lptv" frontend/inject.js`
Expected: 输出一行。

- [ ] **Step 3: 语法检查**

Run: `node --check frontend/inject.js`
Expected: 无输出。

---

### Task 4: 双镜像字节一致 + 语法检查

**Files:**
- Modify: `android/www/inject.js`（同步为 frontend 镜像）

**Interfaces:**
- Consumes: frontend/inject.js（Task 1-3 产物）。

- [ ] **Step 1: 同步镜像**

Run: `cp frontend/inject.js android/www/inject.js`

- [ ] **Step 2: 验证字节一致 + 双文件语法**

Run: `cmp -s frontend/inject.js android/www/inject.js && node --check frontend/inject.js && node --check android/www/inject.js && echo MIRROR_OK`
Expected: `MIRROR_OK`（cmp 无 diff，两文件语法通过）。

---

### Task 5: 重建 AppImage + LPK 并验证内容

**Files:**
- Create: `electron/dist/LPTV-linux-x86_64-1.0.0.AppImage`（重建）
- Create: `lpk/rchrome/cloud.lazycat.catlink.lptv-v1.0.0.lpk`（重建）

**Interfaces:**
- Consumes: 两镜像（Task 4）。

- [ ] **Step 1: 重建 AppImage**

Run: `cd electron && npm run dist`
Expected: 输出含 `building target=AppImage`，`electron/dist/LPTV-linux-x86_64-1.0.0.AppImage` 时间戳更新。

- [ ] **Step 2: 验证 AppImage 内 inject.js 含改动**

Run: `grep -c "function isTv" electron/dist/linux-unpacked/resources/frontend/inject.js`
Expected: 1（>0）。

- [ ] **Step 3: 重建 LPK**

Run: `cd lpk/rchrome && CHROME_APPIMAGE=/home/jingle/opc/lptv/electron/dist/LPTV-linux-x86_64-1.0.0.AppImage lzc-cli project build`
Expected: 输出 `输出lpk包 .../cloud.lazycat.catlink.lptv-v1.0.0.lpk`。

- [ ] **Step 4: 验证 LPK /web/ 播放器 inject.js 含改动 + 内嵌 AppImage md5 一致**

Run: `grep -c "function isTv" lpk/content/web/web/inject.js && md5sum lpk/content/appimage/Google-Chrome-stable-157.0.8103.50-1-x86_64.AppImage electron/dist/LPTV-linux-x86_64-1.0.0.AppImage`
Expected: 第一行 1；两个 md5 相同。

---

### Task 6: 上传 v1.0.0 release

**Files:**
- Modify: GitHub release `v1.0.0`（clobber 两产物）。

- [ ] **Step 1: 上传**

Run: `cd /home/jingle/opc/lptv && gh release upload v1.0.0 lpk/rchrome/cloud.lazycat.catlink.lptv-v1.0.0.lpk electron/dist/LPTV-linux-x86_64-1.0.0.AppImage --clobber`
Expected: 无错误输出。

- [ ] **Step 2: 验证已更新**

Run: `gh release view v1.0.0 --json assets --jq '.assets[] | select(.name|test("lpk|AppImage")) | "\(.name) \(.size) \(.updatedAt)"'`
Expected: 两行，updatedAt 为今天。
