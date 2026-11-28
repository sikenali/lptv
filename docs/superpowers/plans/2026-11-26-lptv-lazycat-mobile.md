# LPTV 懒猫移动客户端播放器模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让懒猫微服移动客户端（非 APK）打开懒猫微视时进入独立的手机播放器模式：直达播放、单侧频道/节目单、系统音量、保留切台。

**Architecture:** 主进程从 xpra 客户端信息识别移动端并通过 `lptv:env`/preload 暴露 `__LPTV_ENV.mobile`；`web/inject.js` 增加移动端分支与响应式布局，复用现有切台/面板/视频机制；CDE、智慧屏、APK 路径不变。

**Tech Stack:** Electron main/preload (Node/CommonJS), vanilla JS/CSS injected into the official page, headless Chrome for UI assertions.

**Spec:** `docs/superpowers/specs/2026-11-26-lptv-lazycat-mobile-design.md`

## Global Constraints

- 移动端识别只能来自主进程解析 xpra 客户端信息；不得用 `__lptvBridge`、AndroidManifest 或渲染层媒体查询判懒猫移动客户端。
- 智慧屏 UA（`LazyCatTvOsClient`/`Lazycat_ContentView`）不得判成移动端；移动端 `smart=false`。
- CDE/智慧屏的 1920 画布、鼠标指针、白色圆圈光标不得改变。
- 移动端视频元素固定 `volume=1`、`muted=false`，不套 `cfg.volume` 锁定。
- 移动端布局只作用于 `#lptv-root.mobile`，使用 100vw/100vh + vw/vh。
- 移动端保留切台页，启动和手动切台都走 `openSwitching → finishSwitching`。
- 首页在移动端不显示；设置由客户端自带 `/?setting` 入口提供。

## Review Focus

- 移动 UA 同时带智慧屏标记 → 误判移动端，智慧屏失去 TV 布局/白色圆圈光标。Task 1 测试。
- `xpra info` 的 UA 键可能是 `client.session-type-full` 或 `client.session-type.full` → 识别失败。Task 1 测试。
- UA 缺失时小画布兜底 → 桌面小屏误判移动端。Task 1 测试桌面 UA/大画布不误判。
- 手机竖屏且 `orientation.lock` 不可用 → 布局/旋转提示仍可用。Task 4 人工核对。
- 点击控制条/面板被当成“点画面”再次 showControls，或面板打开后视频被整层遮罩压暗。Task 3/4 测试。
- 视频被静音或 `cfg.volume` 锁定 → 手机系统音量无效。Task 3 测试（无视频时检查分支条件）。

---

### Task 1: xpra 客户端信息解析与移动端分类

**Files:**
- Create: `electron/xpra-client-info.js`
- Create: `electron/xpra-client-info.test.js`
- Modify: `electron/package.json` (`build.files` 增加 `xpra-client-info.js`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseXpraClientInfo(stdout: string) -> { display: string, w: number, h: number, ua: string, platform: string }`
  - `classifyClient(info) -> { mobile: boolean, smart: boolean }`
  - `isChromiumClient(info) -> boolean`（供 main.js 几何逻辑使用）

- [ ] **Step 1: Write the failing test**

```js
// electron/xpra-client-info.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseXpraClientInfo, classifyClient, isChromiumClient } = require('./xpra-client-info');

function info(stdout) { return parseXpraClientInfo(stdout); }

test('Android mobile UA with small canvas is mobile, not smart', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
    'client.platform=Android',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(800, 360)',
  ].join('\n'));
  assert.equal(c.w, 800);
  assert.equal(c.h, 360);
  assert.equal(c.platform, 'Android');
  assert.match(c.ua, /Android/);
  assert.deepEqual(classifyClient(c), { mobile: true, smart: false });
});

test('iOS platform alone marks mobile', () => {
  const c = info([
    'client.platform=iOS',
    'client.screen.0.size=(390, 844)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: true, smart: false });
});

test('Smart screen UA stays smart, never mobile', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 LazyCatTvOsClient/1.0',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1280, 720)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: true });
});

test('Desktop UA and 1920 canvas is neither mobile nor smart', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 LazyCatClientDesktop/1.0',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1920, 1080)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: false });
});

test('UA key with dots is parsed too', () => {
  const c = info([
    'client.session-type.full=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
    'client.screen.0.size=(390, 844)',
  ].join('\n'));
  assert.match(c.ua, /iPhone/);
  assert.equal(classifyClient(c).mobile, true);
});

test('Missing UA/platform falls back to small canvas only', () => {
  const small = info('client.screen.0.size=(800, 360)');
  assert.deepEqual(classifyClient(small), { mobile: true, smart: false });
  const big = info('client.screen.0.size=(1920, 1080)');
  assert.deepEqual(classifyClient(big), { mobile: false, smart: false });
  const smartSize = info('client.screen.0.size=(1280, 720)');
  assert.deepEqual(classifyClient(smartSize), { mobile: false, smart: true });
});

test('Chromium detection is independent of mobile classification', () => {
  const c = info('client.screen.0.display=Chromium\nclient.screen.0.size=(800, 360)');
  assert.equal(isChromiumClient(c), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/xpra-client-info.test.js`
Expected: FAIL — `Cannot find module './xpra-client-info'`

- [ ] **Step 3: Implement `electron/xpra-client-info.js`**

Implement exactly these exported functions. Parsing: match lines `client.screen.0.display=...`, `client.screen.0.size=(W, H)`, `client.platform=...`, and UA lines matching `^client\..*session.*type.*full=(.+)$` (covers `client.session-type-full` and `client.session-type.full`). Mobile: platform or UA matches `/Android|iOS|iPhone|iPad|iPod|Mobile/i` and does not match `/LazyCatTvOsClient|Lazycat_ContentView/i`; only if both platform and UA are empty, fall back to `w > 0 && w < 1100`. Smart: not mobile and (`/^Chromium/i.test(display)` or `(w <= 1280 && h <= 720)` with positive size). `isChromiumClient`: display starts with `Chromium`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/xpra-client-info.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Add module to packaged files**

Add `"xpra-client-info.js"` to `electron/package.json` `build.files` next to `main.js`.

- [ ] **Step 6: Commit**

```bash
git add electron/xpra-client-info.js electron/xpra-client-info.test.js electron/package.json
git commit -m "feat(lptv): xpra 客户端移动端识别模块"
```

---

### Task 2: 主进程/preload 传递 mobile 环境

**Files:**
- Modify: `electron/main.js` (`queryXpraClient`, `refreshXpraClientAsync`, `isSmartClient`, window `additionalArguments`, `lptv:env`)
- Modify: `electron/preload.js` (argv/env 读取与 expose)

**Interfaces:**
- Consumes: Task 1 `parseXpraClientInfo`, `classifyClient`, `isChromiumClient`.
- Produces: `__LPTV_ENV.mobile` boolean (main world and isolated world); `lptv:env` returns `{ smart, mobile, container, isTv }`.

- [ ] **Step 1: Wire parser in main process**

Replace inline parsing in `queryXpraClient()`/`refreshXpraClientAsync()` with `parseXpraClientInfo(stdout)`, keeping the returned object shape and adding `ua`/`platform`. Cache `{ display, w, h, ua, platform }`. Add a `[LPTV-env] client=… mobile=… smart=…` log in `lptv:env` so the real mobile client’s actual fields can be verified.

- [ ] **Step 2: Replace smart classification**

Implement `isSmartClient(c)` as `classifyClient(c).smart`; add `isMobileClient(c)` as `classifyClient(c).mobile`. `isChromiumXpraClient` remains for geometry but uses the parsed `display`.

- [ ] **Step 3: Pass mobile to the window and IPC**

`additionalArguments`: if `IS_CONTAINER` and `isMobileClient()` → `['--lptv-mobile=1']`; else existing smart argument. `lptv:env` returns `mobile: IS_CONTAINER && isMobileClient()` and `smart` from `isSmartClient()`.

- [ ] **Step 4: Reload on client mode change / mobile reattach**

In the existing client poll (`refreshXpraClientAsync`), track the applied mode (`mobile`/`smart`/`desktop`) and connected state. When the classified mode changes, call `win.reload()` so document-start re-reads `__LPTV_ENV`. When mobile transitions from no-client to connected, also reload (restores last channel; avoids a frozen frame with no play button). CDE/智慧屏 same-mode reconnects do not reload.

- [ ] **Step 5: Expose in preload**

Read `env.mobile === true || process.argv.indexOf('--lptv-mobile=1') >= 0`; expose `mobile` in `window.__LPTV_ENV` (both isolated and main world copies).

- [ ] **Step 6: Verify**

Run:
```bash
node --check electron/main.js
node --check electron/preload.js
node --test electron/xpra-client-info.test.js
grep -n "lptv-mobile\|mobile:\|LPTV-env\|reload" electron/main.js electron/preload.js
```
Expected: syntax OK, tests PASS, grep shows mobile argument, env field, log, reload branch.

- [ ] **Step 7: Commit**

```bash
git add electron/main.js electron/preload.js
git commit -m "feat(lptv): 懒猫移动客户端环境标记"
```

---

### Task 3: inject.js 移动端行为分支

**Files:**
- Modify: `web/inject.js`
- Create: `web/test/mobile-mode.html` (headless assertion page)

**Interfaces:**
- Consumes: `__LPTV_ENV.mobile` from Task 2.
- Produces:
  - `IS_MOBILE` boolean in inject.js.
  - `isTv()` returns false when `IS_MOBILE`.
  - `applyDesignScale()` mobile branch sets `zoom=1`, `transform=none`, `left=0`, `top=0`.
  - `setView("home")` coerced to `"playing"` on mobile.
  - Tap on playing view (not button/panel) shows controls.
  - Volume lock skipped and video forced `volume=1`, `muted=false` on mobile.

- [ ] **Step 1: Write the failing headless assertion page**

Create `web/test/mobile-mode.html` that stubs `window.__LPTV_ENV={mobile:true,container:true,smart:false}` and `window.lptv` (`get_channels` returns CCTV-1/CCTV-2; `get_ui_state` returns `{ok:true,lastPid:'600001859',fit:'cover'}`; `fullscreen_toggle`/`set_quality`/`set_state` resolve). Load `../inject.js` relative to the test page. After 1200ms write `document.body.dataset.test = JSON.stringify({...})` with:
`mobileClass`, `state`, `zoom`, `showControlsAfterTap`.
The assertion command:

```bash
google-chrome --headless --disable-gpu --no-sandbox --window-size=800,360 \
  --virtual-time-budget=3000 --dump-dom "file://$(pwd)/web/test/mobile-mode.html" \
  | grep -o 'data-test="[^"]*"'
```
Expected now: `mobileClass:false`, `state:"home"`, `zoom` not `1`.

- [ ] **Step 2: Add `IS_MOBILE` and make `isTv()` false for mobile**

In `web/inject.js`, define `IS_MOBILE` from `window.__LPTV_ENV.mobile === true` (do not include `__lptvBridge`). Update `isTv()` to `return !IS_MOBILE && (...)`.

- [ ] **Step 3: Add the mobile design-scale branch**

In `applyDesignScale()`, before the desktop branch:
```js
if (IS_MOBILE) {
  root.style.zoom = "1";
  root.style.transform = "none";
  root.style.left = "0px";
  root.style.top = "0px";
  return;
}
```

- [ ] **Step 4: Skip home, force startup playback, and gate the rotate prompt**

In `setView`, coerce `home` to `playing` when `IS_MOBILE`. In `boot()`, use `if (!IS_MOBILE) goHome(); else setView("playing");`, set `lptv._suppressAutoplay = false` for mobile, and best-effort `screen.orientation.lock('landscape')`. In `initChannels` `resumeFlow`, when `IS_MOBILE`, always `switchChannel(cfg.lastPid || chs[0].pid)` (CCTV-1 is first). Keep `_homeReady`/bootmask flow unchanged; splash fades on video ready. In `applyRotatePrompt`, trigger on `IS_MOBILE` + portrait (not the `(hover:none) and (pointer:coarse)` media query), so the prompt actually shows when orientation lock fails.

- [ ] **Step 5: Skip volume lock and force system volume**

In the `volumechange` handler, return early when `IS_MOBILE`. In `tryPlay()` and the `playing` handler, when `IS_MOBILE` set `v.muted=false; v.volume=1;` instead of `cfg.volume`/`cfg.muted`. Do **not** write `cfg.volume`/`cfg.muted`; this is a runtime override so CDE/智慧屏 saved volume preferences are untouched.

- [ ] **Step 6: Add tap-to-show-controls**

In the existing root click handler (or a new one), when `IS_MOBILE && uiState === "playing"` and the target is not inside `button,#lptv-view-left,#lptv-view-right,#lptv-view-switching,#lptv-settings`, call `showControls(true)` and let the existing double-tap fullscreen logic continue.

- [ ] **Step 7: Run the headless assertion**

Run the command from Step 1. Expected: `mobileClass:true`, `state` is `playing` or `switching` (not `home`), `zoom:"1"`, `showControlsAfterTap:true`.

Also run `node --check web/inject.js`.

- [ ] **Step 8: Commit**

```bash
git add web/inject.js web/test/mobile-mode.html
git commit -m "feat(lptv): 移动客户端直达播放与触控控制条"
```

---

### Task 4: 移动端响应式布局与面板

**Files:**
- Modify: `web/inject.js` (CSS block + panel/tap helpers)
- Modify: `web/test/mobile-mode.html` (extend assertions)

**Interfaces:**
- Consumes: Task 3 `IS_MOBILE`, `showControls`, `openLeftPanel`, `openRightPanel`.
- Produces: CSS under `#lptv-root.mobile`; `#lptv-root.mobile` root sizing; mobile control bar/panel/switching dimensions.

- [ ] **Step 1: Extend the failing assertion page**

Add assertions after boot:
- `#lptv-root.mobile` exists.
- `#lptv-view-playing .lv-bar-col.center` computed `display` is `none`.
- `#lptv-view-left` computed `background-color` is transparent (`rgba(0, 0, 0, 0)`).
- `#lptv-view-left .lv-left-panel` width ≈ `55vw` (within 4px).
- `#lptv-view-right .lv-right-panel` width ≈ `60vw`.
- `#lptv-view-playing .lv-bar-btn` height ≥ 44px.
- `#lptv-view-left .lv-left-scene` computed `display` is `none` (or capsules hidden).
- Drag scroll: stub `get_channels` with 30 entries; click the playing view, click `#lv-b-ch`; dispatch `mousedown` on `#lv-left-list`, `mousemove` up 80px on `document`, `mouseup`; assert `scrollTop > 0`.
Run the headless command; expected: assertions fail/empty before CSS/drag code.

- [ ] **Step 2: Add mobile CSS block**

Add a `#lptv-root.mobile` section to the existing `CSS` string:
- root: `width:100vw;height:100vh;left:0;top:0`.
- hide `#lptv-view-home`.
- control bar: bottom/top safe spacing; `.lv-bar-col.center{display:none}`; two buttons, height ≥44px, readable font; hide `.lv-vol-hint`.
- left panel width `55vw`; right panel width `60vw`; padding/font/touch targets ≥44px; list scroll.
- `#lptv-view-left`/`#lptv-view-right` background transparent; hide `.lv-left-scene .lv-scene-bottom`/`.lv-right-scene .lv-scene-bottom` (or the capsules) so the video side stays clear.
- switching page mobile sizes (ring/icon/card/fonts) but keep animations.
- top time readable at mobile size.
Do not change non-mobile selectors.

- [ ] **Step 3: Add panel tap guards and drag-to-scroll**

Ensure tapping inside an open panel does not close it; tapping the video/scene side closes via existing `closeOverlay`. Ensure tapping the control bar buttons doesn’t trigger the “tap screen shows controls” handler (already guarded by target check). For `IS_MOBILE`, add drag-to-scroll to `#lv-left-list` and `#lv-right-list`: on `mousedown` record `startY/startScroll`; on document `mousemove` while dragging set `scrollTop = startScroll - (clientY - startY)`; on `mouseup` end. Suppress the item `click` when the drag distance exceeds ~8px (use a captured click guard).

- [ ] **Step 4: Run the headless assertions**

Run the Step 1 command. Expected: all asserted values match (center none, transparent views, 55vw/60vw panels, ≥44px buttons, scene hidden, drag scrollTop > 0).

Also `node --check web/inject.js`.

- [ ] **Step 5: Commit**

```bash
git add web/inject.js web/test/mobile-mode.html
git commit -m "feat(lptv): 移动端响应式播放器布局"
```

---

### Task 5: 回归核对（CDE/智慧屏/APK）

**Files:** none.

- [ ] **Step 1: Static regression checks**

Run:
```bash
grep -n "IS_MOBILE" web/inject.js
grep -n "lptv-mobile\|mobile:" electron/main.js electron/preload.js
node --check web/inject.js
node --check electron/main.js
node --check electron/preload.js
node --test electron/xpra-client-info.test.js
```
Expected: mobile branches only; syntax OK; tests PASS.

- [ ] **Step 2: Manual/known-environment checks**

- 智慧屏 UA sample → `classifyClient` returns `smart:true, mobile:false` (covered by Task 1 test).
- CDE desktop UA sample → both false.
- APK (`__lptvBridge`) → `IS_MOBILE` false; TV behavior unchanged.
- Real mobile client: opens directly to playback; first run CCTV-1, second run last channel; tap shows control bar; channel left/EPG right; single-finger drag scrolls the channel/EPG list; system volume works; switching screen appears; disconnect/reconnect reloads and resumes last channel; log shows `[LPTV-env] client=… mobile=… smart=…` with the real UA/platform.
- Real smart screen: white circle cursor and home still present.
- Real CDE: mouse pointer and home still present.

- [ ] **Step 3: Commit any doc/verification notes**

If no code changes, no commit needed.

---

## Self-Review

- Spec coverage: 1 startup/landscape → Task 3 (+ manual orientation); 2 channels left → Task 4; 3 EPG right → Task 4; 4 hide home/volume + system volume → Task 3/4; 5 keep switching → Task 3/4; mobile identification → Task 1/2; regression → Task 5.
- Types: `classifyClient` returns `{mobile, smart}` used by main.js; `__LPTV_ENV.mobile` consumed by inject.js; `IS_MOBILE` used in all mobile branches.
- Review Focus tests: Task 1 covers smart/mobile ambiguity, UA key variants, missing-UA fallback; Task 3 covers tap guard and volume branch; Task 4 covers panel dim; Task 5 covers portrait/orientation and APK regression.
