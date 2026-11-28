# LPTV 首页右上角设置弹窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首页右上角时间胶囊右侧新增设置齿轮按钮，点击弹出居中液态玻璃小弹窗，顶部横排 3 个「上图标下文字」标签（播放设置 / 快捷键 / 关于），对应三个面板；其中播放设置含「运行程序自动播放」「点击频道默认全屏播放」两个勾选框并持久化生效。

**Architecture:** 全部改动在单一注入层 `android/www/inject.js`（原生 JS，无框架）。新增一个 `#lptv-settings` 视图（挂到 `#lptv-root`，与左/右面板平级），由齿轮按钮开/关；标签切换用 `data-tab` 激活。行为接线：`initChannels.resumeFlow` 加自动播放分支，`enterPlaying` 加「点击频道默认全屏」分支（用新 `maybeAutoFullscreen()`，仅在非全屏时进入）。持久化沿用 `cfg`（`lptv.cfg.v3`）+ `pyStatePush`。

**Tech Stack:** 原生 JS + CSS（无构建、无框架）；Electron/Android 壳层（`window.lptv` bridge）。验证用 `node --check`（语法门禁）+ 手动运行 `bash run.sh`。

**Spec:** `docs/superpowers/specs/2026-11-24-lptv-home-settings-design.md`

## Global Constraints

- 唯一改动文件：`android/www/inject.js`（设计文档另有 `docs/superpowers/specs/2026-11-24-lptv-home-settings-design.md`）。
- 新增配置键且默认值**必须为 `false`**（保持现有行为不变）：`autoPlayOnLaunch`、`clickFullscreen`。
- 快捷键面板只展示**当前真实生效**键位，不含 录制(R)/截图(X)/悬浮窗/双击；不提供改键交互。
- 不恢复已删除功能（录制/截图/悬浮窗/最大化/设置 S 键/收藏/OSD/窗口控制）。
- 主题：复用 `--panel/--line/--tx/--tx2/--accent` 等设计令牌 + `[data-theme=light]` 覆盖，与左/右面板一致。
- 弹窗关闭三途径：右上角 ✕、点击遮罩、Esc（接入现有 `closeOverlay` 流程）。
- 每步 `node --check android/www/inject.js` 必须通过（语法门禁）。

## Review Focus

1. 用户**未勾选**任何新开关时，现有行为完全不变（启动进首页不播放；点频道不进全屏）——Task 1/4 验证 `autoPlayOnLaunch`/`clickFullscreen` 默认 `false` 且只在为真时走新分支。
2. 勾选「运行程序自动播放」后重启，若上次频道存在但官方按钮未渲染，仍要落到播放态而非卡在加载——Task 4 依赖 `switchChannel` 已有的「无候选→`enterPlaying`」兜底。
3. 「点击频道默认全屏播放」不能在已全屏时误退出——Task 1 的 `maybeAutoFullscreen()` 只在 `!_isFull` 时 `fullToggle()`。
4. Esc 关闭：设置弹窗开着时按 Esc 只关弹窗，不误关左/右面板——Task 3 在 `closeOverlay` 优先关设置。
5. 浅色主题下弹窗文字/背景可读（复用 `[data-theme=light]` 令牌，不硬编码白色）——Task 2 的 CSS 走令牌。

---

### Task 1: 配置键 + 全屏状态跟踪

**Files:**
- Modify: `android/www/inject.js:17-29`（`DEFAULT_CFG`）、`:2033-2054`（`fullToggle`/`setFullIcon`）、`bindEvents` 内（`fullscreenchange`）

**Interfaces:**
- Consumes: 现有 `fullToggle()`、`setFullIcon(full)`、`cfg`。
- Produces: `cfg.autoPlayOnLaunch:boolean`（默认 false）、`cfg.clickFullscreen:boolean`（默认 false）、模块变量 `_isFull:boolean`、`maybeAutoFullscreen()`（Task 4 用）。

- [ ] **Step 1: 在 `DEFAULT_CFG` 增加两个键**

```js
autoPlayOnLaunch: false,   // 启动自动播放上次频道
clickFullscreen: false,    // 点击频道默认全屏播放
```

- [ ] **Step 2: 加全屏状态变量 + 修改 `setFullIcon` 记录状态**

在 `fullToggle` 定义前加 `var _isFull = false;`；在 `setFullIcon(full)` 首行加 `_isFull = !!full;`。

- [ ] **Step 3: 新增 `maybeAutoFullscreen()`（仅在非全屏时进入全屏）**

放在 `fullToggle` 之后：

```js
function maybeAutoFullscreen() {
  if (_isFull) return;
  fullToggle();
}
```

- [ ] **Step 4: 监听 `fullscreenchange` 同步 `_isFull`**

在 `bindEvents()` 内（现有 `document.addEventListener("keydown", ...)` 附近）加：

```js
document.addEventListener("fullscreenchange", function () {
  try { setFullIcon(!!document.fullscreenElement); } catch (e) {}
});
```

- [ ] **Step 5: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 设置弹窗——新增 autoPlayOnLaunch/clickFullscreen 配置与全屏状态跟踪"
```

---

### Task 2: 设置弹窗视图 + CSS + 齿轮按钮

**Files:**
- Modify: `android/www/inject.js`（CSS 区，`:704` 起的 `CSS` 模板；`buildUI` 内 `:1638-1666` 附近加视图；`renderHome` `:2397-2400` 加按钮、`:2465-2469` 绑事件）

**Interfaces:**
- Consumes: `el()`、`cfg`、`_gearIcon()`（本任务定义）。
- Produces: `#lptv-settings` DOM（含 `[data-tab]` 标签 ×3、`#lptv-pane-play`/`#lptv-pane-keys`/`#lptv-pane-about`、`.lv-set-close`）、`lptv.ui.settings`、`openSettings()`/`closeSettings()`（Task 3）、`_renderKeysPane()`/`_renderAboutPane()`（Task 5）。

- [ ] **Step 1: 追加设置弹窗 CSS 到 `CSS` 模板末尾**

用 `#lptv-settings`（固定遮罩居中）+ `.lv-set-card-wrap`（液态玻璃卡片）+ `.lv-set-tabs`（横排 3 标签）+ `.lv-set-tab`（上图标下文字，复刻 `.lv-bar-home` 圆角按钮造型）+ `.lv-set-body`/`.lv-set-pane` + `.lv-set-close`；浅色用 `[data-theme=light]` 覆盖。尺寸约 720×560，圆角 28px，`backdrop-filter:blur(30px) saturate(160%)`。

- [ ] **Step 2: 定义三个标签图标 + 齿轮图标函数**

从旧设置界面（git `a68ccc9^:android/www/inject.js`）复制 SVG：
- `_gearIcon()`：设置齿轮（`<circle cx="12" cy="12" r="3"/>` + 齿轮外轮廓 path）。
- 播放设置标签图标：播放三角 `<path d="M8 5.5v13l11-6.5z"/>`。
- 快捷键标签图标：键盘 `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>`。
- 关于标签图标：`<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>`。

- [ ] **Step 3: 在 `buildUI` 追加 `#lptv-settings` 视图**

在 `root.appendChild(switchView)`（`:1662`）后加，结构：遮罩层 + 卡片（`.lv-set-close` ✕ + `.lv-set-tabs` 三个 `.lv-set-tab[data-tab=play|keys|about]`（图标 + 文字）+ `.lv-set-body` 三个 `.lv-set-pane`：`#lptv-pane-play`（含 `#lptv-s-autoplay`、`#lptv-s-clickfs` 两个勾选框 label）、`#lptv-pane-keys`（`#lptv-s-kmap`）、`#lptv-pane-about`）。挂到 `lptv.ui.settings`。

- [ ] **Step 4: `renderHome` 顶部右侧加齿轮按钮**

`.lv-home-topright` 内、时间胶囊 `<div class="lv-time-capsule" id="lv-home-clock">` 之后加：

```js
'<button class="lv-settings-btn" id="lv-settings-btn" title="设置">' + _gearIcon() + '</button>'
```

并加 `.lv-settings-btn` CSS（与 `.lv-theme-toggle` 同款 44×44 圆角胶囊）+ 浅色覆盖。（齿轮点击绑定在 Task 3 Step 4，因 `openSettings` 定义于 Task 3。）

- [ ] **Step 5: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 设置弹窗——视图/CSS/齿轮按钮入口"
```

---

### Task 3: 打开/关闭 + 标签切换 + Esc 接入

**Files:**
- Modify: `android/www/inject.js`（新增 `openSettings`/`closeSettings`/`_showPane`；`:1532-1538` `closeOverlay` 扩展；`bindEvents` 加事件）

**Interfaces:**
- Consumes: `lptv.ui.settings`、`cfg`（Task 4 勾选态）、`closeOverlay`。
- Produces: `openSettings()`（默认显示「播放设置」标签）、`closeSettings()`。

- [ ] **Step 1: 实现 `openSettings()` / `closeSettings()` / `_showPane(tab)`**

- `openSettings()`：给 `#lptv-settings` 加 `.open`（`display:flex`），复位到 `data-tab=play`（`_showPane("play")`），同步两个勾选框 `checked = cfg.autoPlayOnLaunch / cfg.clickFullscreen`。
- `_showPane(tab)`：所有 `.lv-set-tab` 切 `.on`，所有 `.lv-set-pane` 切 `.on`（`[data-tab]` 匹配）。
- `closeSettings()`：移除 `.open`。

- [ ] **Step 2: 绑定遮罩点击 / ✕ / 标签切换事件**

在 `bindEvents()` 加：点击 `#lptv-settings` 遮罩区（`e.target === 遮罩`）→ `closeSettings()`；点击 `.lv-set-close` → `closeSettings()`；点击 `.lv-set-tab` → `_showPane(tab.dataset.tab)`（`e.stopPropagation()`）。

- [ ] **Step 3: `closeOverlay()` 优先关设置弹窗**

`:1532` 的 `closeOverlay()` 开头加：

```js
var s = lptv.ui && lptv.ui.settings;
if (s && s.classList.contains("open")) { closeSettings(); return; }
```

（现有 Esc → `closeOverlay` 路径自动生效，且不会误关左/右面板。）

- [ ] **Step 4: 齿轮按钮点击绑定**

在 `bindEvents()`（或 `renderHome` 事件区）加：

```js
var setBtn = document.getElementById("lv-settings-btn");
if (setBtn) setBtn.addEventListener("click", function (e) { e.stopPropagation(); openSettings(); });
```

- [ ] **Step 5: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 设置弹窗——开关/标签切换/Esc 接入"
```

---

### Task 4: 播放设置勾选框持久化 + 行为接线

**Files:**
- Modify: `android/www/inject.js`（`bindEvents` 加 `change` 监听；`:2767-2771` `resumeFlow` 加自动播放；`:1366` `enterPlaying` 加自动全屏；`:2456-2459` 卡片点击设 `lptv._fsOnClick`）

**Interfaces:**
- Consumes: `cfg`、`saveCfg()`、`pyStatePush()`、`switchChannel()`、`enterPlaying()`、`maybeAutoFullscreen()`（Task 1）。
- Produces: `lptv._fsOnClick:boolean`（卡片点击时置位）。

- [ ] **Step 1: 勾选框 `change` 监听**

在 `bindEvents` 加：`#lptv-settings` 的 `change` 事件——`#lptv-s-autoplay.checked` → `cfg.autoPlayOnLaunch`；`#lptv-s-clickfs.checked` → `cfg.clickFullscreen`；各调用 `saveCfg(); pyStatePush({ autoPlayOnLaunch:..., clickFullscreen:... });`。

- [ ] **Step 2: `resumeFlow` 加自动播放分支**

`:2767` 的 `resumeFlow` 函数体内、`markActive()` 后加：

```js
if (cfg.autoPlayOnLaunch) {
  var pid = cfg.lastPid || lptv.currentPid;
  if (pid) switchChannel(pid);
}
```

（`switchChannel` 已有「无候选→`enterPlaying`」兜底，不会卡在加载。）

- [ ] **Step 3: 卡片点击置位 `_fsOnClick`**

`renderHome` 卡片点击（`:2458`）改为：`card.addEventListener("click", function(){ lptv._fsOnClick = !!cfg.clickFullscreen; switchChannel(card.getAttribute("data-pid")); });`

- [ ] **Step 4: `enterPlaying` 加自动全屏**

`:1366` 的 `enterPlaying` 改为：

```js
function enterPlaying(pid) {
  if (pid) lptv.currentPid = pid;
  setView("playing"); showControls(true); updateQualityBadge();
  if (lptv._fsOnClick) { lptv._fsOnClick = false; maybeAutoFullscreen(); }
}
```

- [ ] **Step 5: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 设置弹窗——播放设置勾选持久化+自动播放/自动全屏接线"
```

---

### Task 5: 快捷键 + 关于面板内容

**Files:**
- Modify: `android/www/inject.js`（新增 `_renderKeysPane()`/`_renderAboutPane()`，在 `openSettings` 或 `buildUI` 后调用）

**Interfaces:**
- Consumes: `lptv.ui.settings`、`#lptv-s-kmap`、`#lptv-pane-about`。
- Produces: 无（只读展示）。

- [ ] **Step 1: `_renderKeysPane()` 填充当前真实键位**

只读清单（与 `keydown` 实际绑定一致，无 R/X/浮窗/双击）：

```js
[["切换频道", ["↑", "↓", "PgUp", "PgDn"]],
 ["音量调节", ["←", "→"]],
 ["播放 / 暂停", ["空格"]],
 ["数字选台", ["0-9"]],
 ["频道面板", ["C"]],
 ["节目单面板", ["E"]],
 ["静音", ["M"]],
 ["全屏", ["F11"]],
 ["返回 / 关闭", ["Esc"]],
 ["媒体·遥控键", ["播放/换台/音量/静音/返回"]]]
```

每行渲染为 `<div class="lv-krow"><span>名称</span><span class="lv-kkeys"><kbd>…</kbd></span></div>`（复用旧 `.lptv-krow`/`kbd` 样式，本任务改为 `.lv-krow`/`.lv-kkeys`）。

- [ ] **Step 2: `_renderAboutPane()` 填充关于内容**

复用旧设置界面：`icon.png` 图标、`__LPTV_ICON_SRC` 版本号、描述「懒猫微视是一款专门为懒猫微服打造的YSP远程播放客户端。」、标语「为慵懒而生，享直播视听。」、脚注「Powered by LightOS · Made for LCMD」。

- [ ] **Step 3: 调用两函数（在 `buildUI` 创建视图后各调一次）**

- [ ] **Step 4: 语法门禁 + 提交**

```bash
node --check android/www/inject.js && git add android/www/inject.js && git commit -m "feat(lptv): 设置弹窗——快捷键/关于面板内容"
```

---

### Task 6: 全量验证

**Files:**
- Modify: 无（仅验证）

- [ ] **Step 1: 语法门禁全文件**

```bash
node --check android/www/inject.js
```

- [ ] **Step 2: 手动运行验证（`bash run.sh`）**

1. 首页右上角出现齿轮；点击弹居中弹窗；3 个横排「上图标下文字」标签可切换。
2. 播放设置两勾选框默认**未勾选**；勾选后刷新状态保持（`localStorage`/Python `set_ui_state`）。
3. 勾选「运行程序自动播放」重启：直接进上次频道播放；取消重启：进首页不播放（现状不变）。
4. 勾选「点击频道默认全屏播放」后点频道卡片：进入播放并全屏；取消后：进入播放不全屏（现状不变）；已全屏时切台不退出全屏。
5. 快捷键面板列出当前真实键位（无 R/X/浮窗/双击）。
6. 关于面板显示旧内容（图标/版本/描述/标语/脚注）。
7. 深/浅主题下弹窗配色正确；✕ / 遮罩 / Esc 均可关闭；设置开着时 Esc 不误关左/右面板。
