# LPTV 播放器界面高保真重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LPTV 播放器界面重写为 Calicat 设计稿 `2080555577832132608` 的 6 态高保真，保留功能核心，去掉录制/截图/悬浮窗/最大化/设置/收藏/OSD/窗口控制，智慧屏与 CDE 通用。

**Architecture:** 单一源 `android/www/inject.js`（`frontend/` 已删）。替换其 UI 层（DOM/CSS）为设计稿 6 态结构，保留数据/逻辑函数（频道/EPG/换台/播放暂停/音量/快捷键）。UI 以 1920×1080 为设计基准，用 `transform: scale()` 适配智慧屏(1280×720)与 CDE 窗口。状态机驱动 6 态 + 导航。

**Tech Stack:** 原生 JS DOM（Chromium / pywebview webview，无框架）；CSS 自定义属性；内联 SVG + remixicon；`node --check` 为语法门禁（无测试框架）。

**Spec:** `docs/superpowers/specs/2026-11-23-lptv-ui-redesign-design.md`

## Global Constraints

- **单一源**：只改 `android/www/inject.js`。改后需重生成运行副本：`lpk/content/web/web/`（`lpk/build.sh` 从 `android/www` 拷贝，智慧屏/CDE 实际运行）+ Electron 打包 `electron/dist/linux-unpacked/resources/frontend/inject.js`。`android/android/app/src/main/assets/public/inject.js`（APK 独立副本）默认不动。
- **模式分离不可破坏**：`isTv()`（渲染层）= `__lptvBridge===true || __LPTV_ENV.smart/isTv===true`；`switchChannel` 的桥接分支回归 `__lptvBridge`（防智慧屏 Electron IPC 递归死循环）；`isFull` 钉位/智慧屏自动全屏保留。
- **设计基准 1920×1080**；整体 `transform: scale()`；智慧屏 1280×720 全屏、CDE 窗口。
- **设计令牌**（从 `design_*.json` 提取）：底色 `rgb(5,7,14)`；面板 `rgba(10,15,28,0.85)`；卡片 `rgba(255,255,255,0.1)`、选中 `rgba(255,255,255,0.2)`；强调蓝 `rgb(77,124,254)`；浅蓝 `rgb(106,168,255)`；直播红 `rgb(255,90,90)`；台标白 `rgb(255,255,255)`；遮罩渐变 `rgba(5,7,14,0.85)→0`（上沿 280px）/`0.8→0`（下沿 260px）。
- **字体**：Inter + Noto Sans SC + remixicon，需新增 `@font-face` + woff2 资产（打包进 `android/www/`）。
- **移除**：录制(MediaRecorder)、截图、悬浮窗(小浮窗)、最大化、设置弹窗、收藏、OSD、CDE 窗口控制(置顶/最小化/关闭)。
- **保留**：频道/EPG/换台/播放暂停/音量(右上角提示)/全部快捷键。
- **开机不自动播放**（入口=频道首页，点卡片才播）。
- 智慧屏遥控按键触发控制栏/面板 + 自动隐藏；CDE 鼠标悬停触发。
- 频道：滚动显示全部（21 央视/32 卫视/6 CGTN），补 CGTN 组。

## Review Focus

- **智慧屏无 hover**：控制栏/面板由遥控按键呼出、无操作自动隐藏——不能用「鼠标悬停」作为唯一触发。
- **智慧屏模式分离回归**：智慧屏仍全屏铺满（cover）、不误判为桌面、位置对；CDE 桌面不误判为智慧屏。
- **换台不递归卡死**：`switchChannel` 桥接分支走 `__lptvBridge`，不进 `window.lptv.play_channel` 死循环。
- **频道数据多于设计卡数**：首页/左侧面板滚动显示全部，CGTN 有组，不丢频道。
- **开机入口首页不自动播放**：视频在点卡片后才创建/播放。

---

### Task 1: 设计令牌 + 缩放层

**Files:**
- Modify: `android/www/inject.js`（UI 段 L744+ 顶部，新增 CSS 变量与缩放容器）

**Interfaces:**
- Consumes: 无（新）
- Produces: CSS 变量 `--bg/--panel/--card/--card-active/--accent/--accent2/--live/--logo`；根缩放容器 `#lptv-root`（1920×1080 设计空间，`transform: scale()`）；`applyDesignScale()` 更新缩放。

- [ ] **Step 1: 新增设计令牌 + 缩放容器**

在 inject.js UI 段新增：根容器 `#lptv-root`（`position:fixed; inset:0; width:1920px; height:1080px; transform-origin: top left;`），`applyDesignScale()` 计算 `s = min(viewportW/1920, viewportH/1080)` 并设 `root.style.transform = scale(s)`；监听 `resize` 与 `display-metrics-changed`。CSS 变量取 §Global Constraints 的设计令牌值。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js`
Expected: 通过（无语法错误）

- [ ] **Step 3: Commit**

```bash
git add android/www/inject.js
git commit -m "feat(lptv): 界面重写——设计令牌 + 1920x1080 缩放层"
```

### Task 2: 频道分组

**Files:**
- Modify: `android/www/inject.js`（频道逻辑段 L513+）

**Interfaces:**
- Consumes: `lptv.channels`（含 `.pid/.name/.category`）
- Produces: `channelGroups()` → `[{key, label, channels:[...]}]`，顺序 `["央视","CGTN","卫视","地方","其他"]`；`groupOrder` 常量；`groupOf(ch)`（按 `category`，缺省用名称映射：`/^CGTN/→CGTN`，`/^CCTV|4K|8K/→央视`，`/卫视/→卫视`，其余→其他）。

- [ ] **Step 1: 实现 `channelGroups()` / `groupOf()` / `groupOrder`**

分组渲染顺序 = `["央视","CGTN","卫视","地方","其他"]`；过滤空组；`groupOf` 优先 `ch.category`，否则按名称正则映射。返回 `[{key,label,channels}]`。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js` Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——频道分组 channelGroups()"
```

### Task 3: 状态机 + 导航

**Files:**
- Modify: `android/www/inject.js`（UI 段）

**Interfaces:**
- Consumes: 无（新）
- Produces: `uiState`（`home|playing|leftPanel|rightPanel|switching`）；`setView(state)`；`showControls(bool)`；`goHome()`；`enterPlaying(pid)`；`openLeftPanel()`；`openRightPanel()`；`openSwitching(pid)`；`closeOverlay()`；自动隐藏定时器 `scheduleAutoHide()`。

- [ ] **Step 1: 实现状态机 + 导航函数**

`setView(state)` 切换 `#lptv-root` 子视图显隐（`data-state` 属性或 class）；`showControls` 控制播放态控制栏显隐；智慧屏（`isTv()`）由遥控按键触发 + `scheduleAutoHide()`（无操作 2.5s 隐藏）；CDE 鼠标悬停触发。`closeOverlay` 关左侧/右侧面板回播放。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js` Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——6态状态机+导航"
```

### Task 4: 频道首页（状态1）

**Files:**
- Modify: `android/www/inject.js`（UI 段）

**Interfaces:**
- Consumes: `channelGroups()`、`enterPlaying(pid)`、`lptv.channels`、台标资源 `logos/<ch>.webp`
- Produces: `renderHome()`（渲染首页卡片网格）

- [ ] **Step 1: 实现 `renderHome()`**

按 `channelGroups()` 渲染：每分组标题行（竖条 6×26 `--accent`(央视)/`--accent2`(其他) + 标题 + 分隔线 `rgba(255,255,255,0.1)` + 操作提示）+ 卡片行（`270×140`，`rgba(255,255,255,0.1)`，顶部直播徽标 `rgba(255,90,90,0.2)`+红点 6×6，底部台标 52×52 白 + 频道名；当前频道卡片 `rgba(255,255,255,0.2)`）。整页可滚动（超出 1080 高）。卡片点击 → `enterPlaying(pid)`。

- [ ] **Step 2: 语法门禁 + 视觉核对**

Run: `node --check android/www/inject.js` Expected: 通过
Manual：首页显示分组 + 卡片，滚动正常，点击进入播放。

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——频道首页卡片网格"
```

### Task 5: 播放界面（状态2/3，含 Hover 控制栏）

**Files:**
- Modify: `android/www/inject.js`（UI 段）

**Interfaces:**
- Consumes: `lptv.video`（现有 `<video>` 画面源）、`isTv()`、`showControls()`、`goHome()`、`openLeftPanel()`、`openRightPanel()`、当前频道数据、`setVolume` 相关
- Produces: `renderPlaying()`；进度条更新 `updateProgress(p)`；频道信息刷新 `setChLabel()`（复用/改名）

- [ ] **Step 1: 实现 `renderPlaying()` + Hover/遥控控制栏**

视频元素铺满 1920×1080（沿用现有视频源与 `styleOfficial` 的 cover 语义）；上沿遮罩 280px + 下沿遮罩 260px 渐变；顶部信息栏：左上（台标 68×68 白 + 频道名行：频道名 + 直播中标签 `rgba(255,90,90,0.3)`+红点 + 画质标签 `rgba(255,255,255,0.15)`），右上（音量提示 `rgba(0,0,0,0.25)` 42px + 时间显示）；底部留白（左下角水印 `rgba(0,0,0,0.2)`、右下角提示）。控制栏（状态3）：播放进度行（当前节目名 + 进度轨道 `rgba(255,255,255,0.2)` 6px + 填充 `--accent` + 进度点 14×14 白 + 剩余时间）+ 玻璃控制栏 128px `rgba(255,255,255,0.1)`（左侧频道入口按钮 68px `rgba(255,255,255,0.15)`、中间首页按钮 70×70 白、右侧节目单入口按钮 68px）。CDE 悬停显示、智慧屏遥控键显示 + 自动隐藏。

- [ ] **Step 2: 语法门禁 + 视觉核对**

Run: `node --check android/www/inject.js` Expected: 通过
Manual：播放画面 + 遮罩 + 顶部信息；悬停/按键出现控制栏，自动隐藏。

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——播放界面+Hover控制栏"
```

### Task 6: 左侧频道面板（状态4）

**Files:**
- Modify: `android/www/inject.js`（UI 段）

**Interfaces:**
- Consumes: `channelGroups()`、`switchChannel(pid)`、`closeOverlay()`、`isTv()`
- Produces: `renderLeftPanel()`（面板内容渲染）

- [ ] **Step 1: 实现 `renderLeftPanel()`**

620×1080 面板 `rgba(10,15,28,0.85)`：标题行 44px（标题竖条 6×26 `--accent` + 标题 + 关闭按钮 44×44 `rgba(255,255,255,0.1)`）；分组切换 54px（选中组 fill 白、未选 `rgba(255,255,255,0.1)`）；频道列表 752px（列表项 68px，当前频道 `rgba(255,255,255,0.2)` + 左侧 26px `--accent` 强调条 + 台标 40×40 白 + 频道名 + 正在播放标识 4×14 `--accent2`；未选 `rgba(255,255,255,0.1)`）；底部统计 21px + 滚动提示。点频道 → `switchChannel(pid)` + 状态6；关闭 → `closeOverlay()`。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js` Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——左侧频道面板"
```

### Task 7: 右侧节目单面板（状态5）

**Files:**
- Modify: `android/www/inject.js`（UI 段）

**Interfaces:**
- Consumes: `epgFetch(pid,ymd,cb)`、`epgCurList()`、`epgSetDay(off)`、`epgYmdOf(off)`、`closeOverlay()`、当前频道
- Produces: `renderRightPanel()`；日期 tab 列表（今天 + 未来 4 天，共 5 个）

- [ ] **Step 1: 实现 `renderRightPanel()`**

780×1080 面板 `rgba(10,15,28,0.85)`：标题行 44px（标题竖条 + 标题 + 关闭）；日期切换 68px（今天-选中 132×68 fill 白、其余 132×68 `rgba(255,255,255,0.1)`；今天 + 未来 4 天）；节目列表 736px（节目项 72px `rgba(255,255,255,0.05)` + 左侧 46px 条；正在播出 80px `rgba(255,255,255,0.2)` + 节目进度：轨道 220×4 `rgba(255,255,255,0.2)` + 填充 `--accent2`）。数据来自 `epgFetch/epgCurList`。关闭 → `closeOverlay()`。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js` Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——右侧节目单面板"
```

### Task 8: 切换台加载中（状态6）

**Files:**
- Modify: `android/www/inject.js`（UI 段）

**Interfaces:**
- Consumes: `switchChannel(pid)`（触发时进入状态6）、`enterPlaying(pid)`（完成时）
- Produces: `renderSwitching(pid)`（加载环 + 切换信息卡 + 进度）

- [ ] **Step 1: 实现 `renderSwitching(pid)`**

切换前画面 + 暗化遮罩；中部聚光层（中心光晕 620×620 `rgba(255,255,255,0.05)` + 内光晕 420×420 + 占位 220×220）；顶部行（左上提示 `rgba(255,255,255,0.1)` 44px；右上切换信息卡 460px `rgba(255,255,255,0.1)`：目标台标 48×48 + 名称/状态行 + 状态标签 `rgba(77,124,254,0.3)`+跳动点 6×6 `--accent2` + 切换来源行）；切换进度轨道 `rgba(255,255,255,0.2)` 5px + 填充 `--accent`；进度说明行；居中加载区：加载圆环 260×260（SVG 264×264 旋转 + 180×180 `rgba(255,255,255,0.08)` + 数字）+ 加载文字组 + 加载指示点（点1 白 10×10、点2 `rgba(255,255,255,0.45)`、点3 `rgba(255,255,255,0.2)`）；底部行 44px。`switchChannel` 进入、就绪后进状态2。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js` Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——切换台加载态"
```

### Task 9: 音量提示 + 快捷键

**Files:**
- Modify: `android/www/inject.js`（UI 段 + 对外 API 段 L3481+）

**Interfaces:**
- Consumes: `setVolume(v)`、`isTv()`、现有键位处理
- Produces: `renderVolHint()`（右上角音量提示 `rgba(0,0,0,0.25)` 42px）；保留全部快捷键映射到新 UI 动作（C/E/space/↑↓/←→/0-9/M/F11 等）

- [ ] **Step 1: 实现音量提示 + 快捷键绑定**

音量提示跟随 `setVolume` 显示于右上角（设计稿右上状态）；快捷键：保留全部现有键位，映射到新 UI 动作（C→左面板，E→右面板/EPG，space→暂停，↑↓→音量，←→→换台，0-9→频道，M→静音，F11/全屏→全屏）。

- [ ] **Step 2: 语法门禁**

Run: `node --check android/www/inject.js` Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——音量提示+快捷键"
```

### Task 10: 移除功能（录制/截图/浮窗/最大化/设置/收藏/OSD/窗口控制）

**Files:**
- Modify: `android/www/inject.js`

**Interfaces:**
- Consumes: 无（删除）
- Produces: 移除 `Rec`/`recSupported`/`recStart`/`recStop`（L2457+）、截图（L2691+）、`floatCtl`/`showFloatCtl`（L2749+）、`lptv-tb-max`/`lptv-b-full` maximize、设置弹窗（L1840+）、收藏（L79+）、OSD、窗口控制（置顶/最小化/关闭）、预约 UI

- [ ] **Step 1: 删除上述功能代码与 DOM**

删除录制角标/按钮/设置/MediaRecorder 逻辑；截图按钮/逻辑；悬浮窗 CSS/按钮/floatCtl/逻辑；最大化按钮 + 逻辑；设置弹窗 UI + 逻辑；收藏 UI/逻辑；OSD；顶栏窗口控制按钮；预约 UI。保留其快捷键（若有）。

- [ ] **Step 2: 语法门禁 + 移除核对**

Run: `node --check android/www/inject.js` Expected: 通过
Run: `grep -nE "MediaRecorder|recStart|lptv-b-float|lptv-tb-max|lptv-settings" android/www/inject.js` Expected: 无匹配（已移除）

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——移除录制/截图/浮窗/最大化/设置/收藏/OSD/窗口控制"
```

### Task 11: 启动 + 接线

**Files:**
- Modify: `android/www/inject.js`（启动段 L3522+）

**Interfaces:**
- Consumes: `initChannels`、`channelGroups`、`goHome`、`enterPlaying`、`switchChannel`、`isTv`、`renderHome`、`setChLabel`
- Produces: 改造 `boot()`——入口首页、不自动播放；`switchChannel` 接状态6；保留智慧屏首开 8s 兜底（①）与 `removeBootmask`

- [ ] **Step 1: 改造 `boot()` 与 `resumeFlow`**

入口设为 `goHome()`（状态1），**不**自动恢复上次频道、**不** Android 自动播放首频道（删除 `resumeFlow` 内自动 `switchChannel` 调用，改为等待卡片点击）。`switchChannel` 调用处包一层 `openSwitching` → 就绪 `enterPlaying`。保留智慧屏首开 8s 重切兜底（`isTv()` 分支）与 15s `removeBootmask`。

- [ ] **Step 2: 语法门禁 + 行为核对**

Run: `node --check android/www/inject.js` Expected: 通过
Manual：开机进首页；点卡片播放；换台出加载态；智慧屏首开不显示解码页。

- [ ] **Step 3: 提交**

```bash
git add android/www/inject.js && git commit -m "feat(lptv): 界面重写——启动入口首页+换台接线"
```

### Task 12: 重生成运行副本 + 全量校验

**Files:**
- Modify: `lpk/content/web/web/inject.js`、`electron/dist/linux-unpacked/resources/frontend/inject.js`（重生成产物）
- Test: 无（用命令校验）

**Interfaces:**
- Consumes: Task 1-11 的 `android/www/inject.js`
- Produces: 同步的运行时副本

- [ ] **Step 1: 重生成运行副本**

Run: `lpk/build.sh`（生成 `lpk/content/web/web/`）+ Electron 重新打包（`electron/dist/.../resources/frontend/inject.js`）。若构建重，可先 `cp android/www/inject.js lpk/content/web/web/inject.js` 供智慧屏/CDE 用。

- [ ] **Step 2: 全量校验**

Run: `node --check lpk/content/web/web/inject.js && cmp android/www/inject.js lpk/content/web/web/inject.js` Expected: 通过、字节一致
Run: `grep -cE "<<<<<<<|>>>>>>>" lpk/content/web/web/inject.js` Expected: 0（无冲突标记）

- [ ] **Step 3: 提交产物**

```bash
git add lpk/content/web/web/inject.js electron/dist/linux-unpacked/resources/frontend/inject.js
git commit -m "build(lptv): 界面重写产物同步——lpk content + electron dist"
```
