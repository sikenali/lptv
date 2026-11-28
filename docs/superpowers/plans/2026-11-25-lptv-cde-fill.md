# LPTV CDE 客户端内容真铺满 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CDE 桌面下让 LPTV 客户端首页/播放界面零黑边铺满虚拟桌面（非等比拉伸），且不改外层 CDE 客户端窗口。

**Architecture:** main.js 容器分支建窗即全尺寸、启动走 UI 全屏并把 75% 窗口记为恢复几何；inject.js 对 Electron 桌面环境把设计画布按视口两轴分别缩放。智慧屏/Android 仍走等比缩放，行为不变。

**Tech Stack:** Electron 主进程（原生 JS）、注入层原生 JS/CSS、xpra。

**Spec:** `docs/superpowers/specs/2026-11-25-lptv-cde-fill-design.md`

## Global Constraints

- 只改 `electron/main.js` 与 `android/www/inject.js`，不新增依赖、不新增设置项。
- 智慧屏/Android 行为必须不变（`isTv()` 为真时保持等比 `min()`）。
- 不触碰官方视频层（`styleOfficial()` 按视口定位，画布拉伸不影响视频）。
- 全屏退出必须恢复启动前 75% 窗口几何（F11 可退回窗口模式）。
- 每步 `node --check` 必须通过。

## Review Focus

1. CDE 启动 3 秒后窗口是否覆盖整块虚拟屏且落 (0,0)（xpra 首次映射会摆回 y=30）。
2. F11 退出全屏是否回到 75% 可拖窗口，再进全屏是否仍铺满。
3. 虚拟屏分辨率变化（客户端重连）时全屏窗口是否按新尺寸重新铺满。
4. 非 16:9 视口下首页/播放/面板是否零黑边且按钮不被裁切（拉伸变形属预期）。
5. 智慧屏（1280×720）与 Android 是否仍等比铺满、无变形。

---

### Task 1: CDE 建窗/全屏几何

**Files:**
- Modify: `electron/main.js:533-547`（建窗几何）、`:781-849`（容器启动几何）、`:1006-1024`（fullscreen_toggle）

**Interfaces:**
- Consumes: `displayBounds()`、`containerWinRect()`、`setPos()`、`st`。
- Produces: 容器桌面启动即全屏；`st.fsSeed`（一次性恢复几何）；`fullscreen_toggle` 容器目标改为 `displayBounds()` 整屏。

- [ ] **Step 1: 建窗几何改为容器全尺寸**

`createWindow()` 内 `const cb = IS_CONTAINER ? containerWinRect() : null;` 改为 `displayBounds()`，并更新上方注释（桌面也全尺寸建窗，75% 仅作恢复几何）。

- [ ] **Step 2: 容器启动统一走全屏，桌面记录恢复几何**

启动块改为：`st.fsSeed = isFull ? null : capped;`、`st.fs = false;`、`setPos(full...)`，并**所有容器模式**都在 1500ms 后调用 `window.lptv.fullscreen_toggle()`（不再仅 isFull 分支）。

- [ ] **Step 3: fullscreen_toggle 容器目标与恢复几何**

容器模式全屏目标用 `displayBounds()`（不用 `fitTvRect`）；`st.fsSaved = st.fsSeed || win.getBounds(); st.fsSeed = null;`。

- [ ] **Step 4: 语法门禁 + 提交**

```bash
node --check electron/main.js && git add electron/main.js && git commit -m "feat(lptv): CDE 建窗即全屏并整屏铺满，保留 75% 恢复几何"
```

### Task 2: 桌面画布非等比铺满

**Files:**
- Modify: `android/www/inject.js:3347-3356`（`applyDesignScale`）

**Interfaces:**
- Consumes: `window.lptv`、`isTv()`。
- Produces: Electron 桌面（`window.lptv && !isTv()`）下 `#lptv-root` 按 `scale(vw/1920, vh/1080)` 铺满、`left/top=0`；其余环境保持原等比居中。

- [ ] **Step 1: 改写 applyDesignScale**

```js
var desktop = !!(window.lptv && !isTv());
if (desktop) {
  var sx = vw / 1920, sy = vh / 1080;
  root.style.transform = "scale(" + sx.toFixed(4) + "," + sy.toFixed(4) + ")";
  root.style.left = "0px"; root.style.top = "0px";
} else {
  var s = Math.min(vw / 1920, vh / 1080);
  root.style.transform = "scale(" + s.toFixed(4) + ")";
  root.style.left = Math.round((vw - 1920 * s) / 2) + "px";
  root.style.top = Math.round((vh - 1080 * s) / 2) + "px";
}
```

- [ ] **Step 2: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 桌面画布按视口非等比铺满，智慧屏保持等比"
```
