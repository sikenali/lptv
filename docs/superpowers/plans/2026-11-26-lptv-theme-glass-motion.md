# LPTV 主题液态玻璃与切换动效 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一套材质令牌重做深/浅主题的液态玻璃与文字可读性，给三类标签统一柔和切换动效并接入遥控导航，给主题切换加右上→左下卷轴过渡，且 CDE/智慧屏软件合成端不掉帧。

**Architecture:** 全部改动在 `web/inject.js`（CSS 字符串 + 注入脚本）。先收敛材质令牌（颜色/玻璃/文字），再实现 `tabSwitch` 与 `focusCtx` 两个共享模块，最后实现带性能档位的 `themeTransition`；所有动画只用 `transform`/`opacity`，过渡期间临时关闭 blur。

**Tech Stack:** 原生 JS（ES5 风格 IIFE）、CSS 变量、FLIP 动画、无构建步骤；验证靠 `node --check` + Electron/CDE/智慧屏实机。

**Spec:** `docs/superpowers/specs/2026-11-26-lptv-theme-glass-motion-design.md`

## Global Constraints

- 动画只允许 `transform` / `opacity`；禁止动画 `width/height/left/top/margin/filter/box-shadow/background-position`。
- 过渡期间 root 临时加类关闭 blur；动画层数 ≤ 2；`will-change` 动画后移除。
- CDE/智慧屏（`.perf`）为主动效路径：主题过渡 500–700ms、标签切换 300ms、单帧 ≤ 50ms、平均 ≥ 24fps。
- 主题切换不得调用 `renderHome()`；令牌切换在覆盖层下完成。
- 按键语义保留：播放态 ↑↓ 换台、←→ 音量；面板/设置内 ←→ 切标签、↑↓ 移动焦点；Esc/Backspace 关闭。
- 文字对比度：正文 ≥ 7:1、次要 ≥ 4.5:1、弱化 ≥ 3:1；不允许残留 `rgba(255,255,255,…)` 文字色。
- `prefers-reduced-motion` → 主题 200ms/标签 120ms 纯淡化；`.perf` → lite 档；自降级写 `cfg.motionLite`。
- 不新增设置项、不改页面结构、不改播放/EPG 抓取逻辑。

## Review Focus

1. 过渡进行中切视图（播放/面板/设置）→ 过渡层与状态机叠加：期望过渡直接收尾、无残留层遮挡点击。
2. 标签快速连切/连点 → 期望从当前 transform 续接、无错位、无叠层。
3. 浅色主题下漏改的硬编码白字（播放控制栏、提示胶囊、切台页）→ 期望无白字。
4. 设置/面板打开时按 ←→ → 期望切标签而非调音量；关闭后恢复音量。
5. xpra 软件合成下过渡层残留 → 期望过渡层 900ms 内移除、`pointer-events` 恢复。

---

### Task 1: 材质令牌与玻璃基础

**Files:**
- Modify: `web/inject.js`（CSS 令牌块约 `826` 起；`.perf` 块约 `1294`；`prefers-reduced-transparency` 块约 `1742`）

**Interfaces:**
- Produces: CSS 变量 `--glass-1-fill/-stroke/-hi/-shadow`、`--glass-2-fill/-stroke/-hi`、`--glass-3-fill`、`--tx/--tx2/--tx3/--tx-weak`、`--sheen`；深色值在 `#lptv-root`，浅色值在 `#lptv-root[data-theme=light]`。后续任务只引用这些变量，不再写死颜色。

- [ ] **Step 1: 写入深浅两套令牌**

在 `#lptv-root{…}` 内按 spec 表格写入深色令牌，在 `[data-theme=light]` 块内写入浅色令牌；`--panel/--card/--card-active/--line/--tx*` 改为引用对应令牌（保留旧名以免大面积改选择器）。`--tx*` 深色用 `#eef1f8/#a5b1ca/#8499c0/#6b7c9e`，浅色用 `#1a2233/#3a4763/#5a6b8c/#8a94ab`。

- [ ] **Step 2: 玻璃四件套**

给结构层/交互层/胶囊层加统一的底色渐变、顶边高光、描边、投影；`::after` 光带用 `--sheen` 静态高光。现有 `.lv-card/.lv-left-item/.lv-right-item/.lv-set-row/.lv-glass-capsule` 等选择器改为引用令牌，不新增结构。

- [ ] **Step 3: 性能与降级**

`.perf` 与 `prefers-reduced-transparency` 块：blur 置零，底色不透明度深 ≥ .82 / 浅 ≥ .9，保留描边、高光、投影；`.perf` 下 `--sheen` 位移取消。`#lptv-root.lptv-theme-anim`、`#lptv-root.lptv-tab-anim` 两条规则：`backdrop-filter:none`。

- [ ] **Step 4: 语法检查**

Run: `node --check web/inject.js`
Expected: 无输出、退出码 0。

- [ ] **Step 5: 实机确认玻璃层次**

Run: `bash run.sh`
Expected: 深色下卡片/面板/胶囊有顶边高光与描边层次；浅色下结构层与交互层可区分；无布局位移。

- [ ] **Step 6: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 深浅主题材质令牌化 + 液态玻璃四件套 + perf 降级"
```

---

### Task 2: 首页与播放界面文字令牌化

**Files:**
- Modify: `web/inject.js`（首页 CSS 约 `898–1010`、播放 CSS 约 `1020–1110`、对应浅色覆盖约 `1396–1460`、`1544–1600`）

**Interfaces:**
- Consumes: Task 1 的 `--tx*`、`--glass-2-*`、`--glass-3-fill`。
- Produces: 首页/播放界面无硬编码白色文字；浅色覆盖块删除重复的文字色规则。

- [ ] **Step 1: 替换首页文字色**

`lv-brand-text/-sub`、`lv-group-title/-count/-hint`、`lv-card-num/-name/-sub`、`lv-home-toggle/-last/-tips`、`lv-time-capsule` 全部改用 `var(--tx*)`；删除浅色块里对应的重复 color 覆盖。

- [ ] **Step 2: 替换播放界面文字色**

`lv-play-name/-sub`、`lv-time-hint/-date`、`lv-vol-hint`、`lv-bar-btn`、`lv-quality-badge` 改用 `var(--tx*)`；控制栏按钮底色用 `--glass-2-fill`。

- [ ] **Step 3: 语法检查 + 浅色实机扫页**

Run: `node --check web/inject.js`
Expected: 0；`bash run.sh` 切浅色后首页/播放界面无白字、无低对比文字。

- [ ] **Step 4: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 首页/播放界面文字色令牌化, 移除浅色重复覆盖"
```

---

### Task 3: 频道/节目单/设置/切台文字与表面令牌化

**Files:**
- Modify: `web/inject.js`（面板 CSS 约 `1110–1240`、设置 CSS 约 `1600–1710`、切台 CSS 约 `1330–1380`、浅色覆盖约 `1462–1600`）

**Interfaces:**
- Consumes: Task 1 令牌。
- Produces: 四个视图无硬编码白色文字；浅色覆盖仅保留阴影/描边等真正主题差异。

- [ ] **Step 1: 面板文字/表面**

`lv-left-title/-tab/-item/-num/-name/-playing/-prog/-foot`、`lv-right-title/-ch/-tab/-item/-time/-pt/-status/-badge/-book/-foot` 改用令牌；标签选中态用 `--glass-2-fill` + `--tx` 反色。

- [ ] **Step 2: 设置与切台**

`lv-set-tab/-row/-krow/-about-*`、`lv-sw-*` 改用令牌；勾选框轨道用 `--glass-2-stroke`。

- [ ] **Step 3: 收敛浅色覆盖**

删除浅色块中只改 color 的规则（由令牌覆盖），保留表面渐变/阴影/描边差异；逐页核对无遗漏。

- [ ] **Step 4: 语法检查 + 两主题扫页**

Run: `node --check web/inject.js`
Expected: 0；两主题下频道/节目单/设置/切台逐页无白字、无不可读文字。

- [ ] **Step 5: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 面板/设置/切台文字与表面令牌化, 收敛浅色覆盖"
```

---

### Task 4: `tabSwitch` 指示条与自检

**Files:**
- Modify: `web/inject.js`（新增 CSS 约 `1240` 后；新增 JS 模块约 `1806` 前后；自检函数放在 `buildUI` 之后）

**Interfaces:**
- Produces: `tabSwitch(container, opts)`，`opts = {tabSel, indClass, onSelect(name), duration}`；内部注入指示条节点 `#lv-tab-ind`，提供 `tabSwitch.select(name)`。`window.__lptvSelfTest()` 返回 `{ok, fails[]}`，断言指示条存在、位置随选中项变化、无残留过渡层。

- [ ] **Step 1: 指示条 CSS**

绝对定位胶囊，`transform:translateX()` 驱动，`transition:transform 260ms cubic-bezier(.22,.9,.3,1)`；`.perf` 下 300ms；`reduced-motion` 下无位移。指示条只用 `--glass-2-fill/--glass-2-hi`，不挂 blur。

- [ ] **Step 2: 实现 `tabSwitch`**

按 spec：`offsetLeft/offsetWidth` 一次性测量；切换时旧内容 110ms 淡出下移 → `onSelect` → 180ms 淡入；记录并恢复 `scrollTop`；连点用递增 token 丢弃过期回调；动画结束移除 `will-change`。

- [ ] **Step 3: 自检函数**

`__lptvSelfTest()` 在首页/面板打开时检查：`#lv-tab-ind` 数量 ≤ 1；选中项变化后指示条 `translateX` 值变化；`#lptv-theme-wipe` 不存在；root 无 `lptv-tab-anim` 残留。

- [ ] **Step 4: 语法检查 + 自检**

Run: `node --check web/inject.js`；浏览器控制台 `__lptvSelfTest()`。
Expected: 语法 0；`{ok:true, fails:[]}`。

- [ ] **Step 5: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 标签切换指示条与内容过渡模块"
```

---

### Task 5: 三类标签接入与首页视图转场

**Files:**
- Modify: `web/inject.js`（`renderLeftPanel` 约 `3322`、`renderRightPanel` 约 `3418`、`_showPane` 约 `1857`、`setView` 约 `1806`）

**Interfaces:**
- Consumes: Task 4 的 `tabSwitch`。
- Produces: 三个入口调用 `tabSwitch.select()`；tabs 节点只建一次；`viewFade(from, to, durMs)` 供 `setView` 调用；`lv-left-tab/lv-right-tab/lv-set-tab` 不再整段重建。

- [ ] **Step 1: 频道分组**

`renderLeftPanel` 首次建 tabs 并初始化 `tabSwitch`；后续只切 `.on` 与列表内容；分组切换走 `onSelect`，列表只重建必要节点。

- [ ] **Step 2: 节目单 5 天**

`renderRightPanel` 同法；切天复用已缓存日期（`lptv.epg.cache[pid|ymd]` 命中不重新 fetch）；切天保留滚动位置，`today` 首次仍定位"正在播出"行。

- [ ] **Step 3: 设置 3 项**

`_showPane` 改调 `tabSwitch.select()`，pane 只切 `.on`（静态 DOM，不重建）。

- [ ] **Step 4: 首页视图转场**

实现 `viewFade(from, to, durMs)`：旧视图 120ms 淡出 + `scale(.985)`，切状态后 240ms 淡入归位；`.perf` 160ms、`reduced-motion` 直接切。只在 `goHome/enterPlaying/openLeftPanel/openRightPanel/openSwitching` 的状态入口调用，不改变面板自身的滑入曲线。

- [ ] **Step 5: 快切验证**

Run: `node --check web/inject.js`；三处各连续快切 10 次；首页↔播放/面板往返。
Expected: 指示条续接不错位、内容不叠层、滚动位置保持、无重复 EPG 请求（控制台网络面板）；视图转场无闪白、无残留层。

- [ ] **Step 6: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 标签统一切换动效 + 首页视图柔和转场"
```

---

### Task 6: 遥控焦点导航与按键路由

**Files:**
- Modify: `web/inject.js`（按键处理约 `2960–3032`；新增 `focusCtx` 模块约 `1810` 前后；新增 `.focus` CSS 约 `1240` 后）

**Interfaces:**
- Consumes: Task 4 `tabSwitch`（面板内 ←→ 调用其 `select`）。
- Produces: `focusCtx.enter(scope)` / `focusCtx.exit()` / `focusCtx.key(e)`，返回 `true` 表示已消费；路由优先级 设置 > 面板 > 播放态 > 首页。

- [ ] **Step 1: 焦点样式**

`.focus` 环：`box-shadow:0 0 0 2px var(--acc2)` + 静态光带，不做动画。

- [ ] **Step 2: 实现 `focusCtx`**

收集可见可聚焦节点（`offsetParent` 非空、所在视图未隐藏），按方向向量找最近项；`scrollIntoView({block:"nearest"})`；记忆上次焦点。←→ 在面板/设置内先尝试切标签，再在列表内移动。

- [ ] **Step 3: 接入按键路由**

`keydown` 开头按优先级分发：设置打开 → `focusCtx.key`；面板打开 → `focusCtx.key`；否则走现有播放态/首页逻辑（音量/换台/数字/播放）。设置内 Esc/Backspace 仍关闭。

- [ ] **Step 4: 验证按键隔离**

Run: `node --check web/inject.js`；实机：面板/设置内 ←→ 不调音量、↑↓ 焦点可见、OK 激活；退出后 ←→ 恢复音量。
Expected: 全部符合；播放态原有快捷键不变。

- [ ] **Step 5: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 遥控焦点导航与按键上下文路由"
```

---

### Task 7: 主题卷轴过渡与性能自降级

**Files:**
- Modify: `web/inject.js`（`applyTheme/toggleTheme` 约 `3140–3155`；新增过渡 CSS 约 `1240` 后；`boot` 恢复处约 `3759`）

**Interfaces:**
- Consumes: Task 1 令牌（目标主题底色）。
- Produces: `themeTransition(toLight)`、`applyThemeCore(light)`（切属性/图标/`saveCfg`，不 `renderHome`）、`motionProbe.start()/stop()`（写 `cfg.motionLite`，采样结果挂在 `window.__lptvPerf = {frames, worst, avg}`）。`__lptvSelfTest()` 增加过渡残留断言。

- [ ] **Step 1: 过渡层 CSS**

`#lptv-theme-wipe`（全屏纯色）、`#lptv-theme-edge`（220×1080 斜向带，卷曲阴影 + 亮边）、`#lptv-theme-roll`（full 档旋转层，≤2600×2600）；`#lptv-root.lptv-theme-anim` 关 blur/光带位移。

- [ ] **Step 2: 实现两档过渡**

`full`：旋转层从右上外侧平移到覆盖 + 卷曲边带；`lite`：纯色层 opacity 0→1（420ms 延迟 180ms）+ 扫描带平移（500–700ms），自降级后改 3 段阶梯淡化。覆盖率 55–65% 时 `applyThemeCore`，500–900ms 清理层与临时类、恢复 `pointer-events`；中途再点直接收尾。

- [ ] **Step 3: 性能采样**

`motionProbe` 在过渡期 rAF 采样，连续 3 帧 > 50ms → `cfg.motionLite = true; saveCfg()`；`lite` 档生效后跳过采样。`reduced-motion` 直接 200ms 淡化。

- [ ] **Step 4: 语法检查 + 自检 + 帧采样**

Run: `node --check web/inject.js`；`__lptvSelfTest()`；CDE/智慧屏上 `window.__lptvPerf` 读过渡期帧间隔。
Expected: 语法 0；自检 ok；单帧 ≤ 50ms、平均 ≥ 24fps，或已自降级且 `cfg.motionLite=true`。

- [ ] **Step 5: Commit**

```bash
git add web/inject.js
git commit -m "feat(lptv): 主题切换卷轴过渡 + CDE/智慧屏性能自降级"
```

---

### Task 8: 最终回归与发布前检查

**Files:**
- Modify: `web/inject.js`（仅修复回归问题）
- Test: 无新增测试文件；实机清单

**Interfaces:**
- Consumes: Task 1–7 全部产物。

- [ ] **Step 1: 主环境回归（CDE/智慧屏）**

主题深↔浅各 5 次（含中途点击）、三类标签快切 10 次、遥控全路径、播放/切台/EPG 正常；无闪白、无残影、无卡顿、无残留层。

- [ ] **Step 2: 次环境回归（AppImage/exe）**

full 档卷轴形态正常、玻璃层次正常、快捷键不变。

- [ ] **Step 3: 清理检查**

DOM 无 `#lptv-theme-*` 残留、无 `lptv-theme-anim/lptv-tab-anim` 残留、无 `will-change` 残留；`cfg.motionLite` 与 `cfg.theme` 持久化正确。

- [ ] **Step 4: 提交回归修复（如有）**

```bash
git add web/inject.js
git commit -m "fix(lptv): 主题/标签/遥控回归修复"
```
