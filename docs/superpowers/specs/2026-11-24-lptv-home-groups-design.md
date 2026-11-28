# LPTV 首页/左侧 2 分类 + 台标展开 + 无滚动条 — 设计

日期：2026-11-24
状态：待批准

## 意图

优化首页与播放界面左侧频道列表的展示：只保留「央视 / 卫视」两个分类，CGTN 融入央视；展开分类时只显示台标（无文字）；页面打开不出现滚动条；首页打开即显示、点击对应频道后才进入注入加载等待动画。

## 目标

1. 首页（`renderHome`）与左侧频道面板（`renderLeftPanel`）都只显示「央视」+「卫视」两组；CGTN（6 台）并入央视组，排在 CCTV（21 台）之后。
2. 首页分类「展开」时只显示台标网格（无频道名/副标题/序号/直播徽标）。
3. 首页打开时无水平/垂直滚动条。
4. 首页打开即显示（不自动播放）；点击卡片后才经切换台（状态6）注入并显示加载等待动画。

## 非目标 / 反目标

- 不改播放器/切换台/注水加载动画本身（已存在，见 #5）。
- 不改频道数据（`channels.json`）、不改 Electron/Android 桥。
- 不改 EPG 右侧面板逻辑（仅顺带隐藏其滚动条）。

## 现状（关键）

- `channelGroups()`（`inject.js` ~1995）按 `groupOrder=["央视","CGTN","卫视","地方","其他"]` 聚合，现实际返回三组：央视(21)、CGTN(6)、卫视(32)。
- `renderHome`（~2021）与 `renderLeftPanel`（~2180）**都调用 `channelGroups()`**，故一处改动可同时作用于两处。
- 左侧面板页脚（~2227）已只显示「央视 X 个 · 卫视 Y 个」，合并后计数自动正确。
- 展开/收起：`view._expanded[g.key]`；默认 12 卡（6x2），>12 显示「展开/收起」。
- `#lptv-root` 固定 1920×1080，`transform: scale()` 仅视觉缩放，布局盒仍 1920 宽 → 可能撑出视口滚动条；且无 `html,body{overflow:hidden}` 兜底。
- 点击卡片 → `switchChannel`(~569) → `openSwitching(pid)`(~590) → 切换台（状态6：注水式圆环 + 中心倒计时 + 进度条 + 旋转提示）→ 就绪后进播放态。**注入加载等待动画已存在。**

## 方案

### 1) 分组（#1 + #2）
`channelGroups()` 改为：
- 遍历频道，`groupOf(ch)` 若为 `CGTN` 则归入 `央视`；仅保留 `["央视","卫视"]` 两组（丢弃地方/其他）。
- 央视组内部排序：CCTV（category=央视）在前，CGTN 在后，各自保持原始相对顺序。
- 返回 `[{key:"央视",label:"央视",channels:[...cctv,...cgtn]}, {key:"卫视",label:"卫视",channels:[...]}]`。

### 2) 展开只显示台标（#4）
`renderHome` 中当 `expanded` 为真：卡片只渲染
`<div class="lv-card lv-card-icon"><span class="lv-card-logo">…台标…</span></div>`
（无序号/徽标/名称/副标题）。新增 CSS：`.lv-card-icon` 为紧凑方砖，logo 居中，行数更多。收起态保持现状（序号 + 直播徽标 + 台标 + 名称 + 副标题）。

### 3) 无滚动条（#3）
- `html, body { overflow:hidden }`。
- `.lv-home-scroll`, `.lv-left-list`, `.lv-right-list` 增加 `::-webkit-scrollbar{display:none}`（现有 `scrollbar-width:none` 保留，双保险）。

### 4) 首页/注入逻辑（#5）
`boot()` 已 `goHome()` 入口、不自动播放（~2540），点击卡片 → `openSwitching` 加载动画（~590）。**无需代码改动**；仅验证点击卡片后切换台加载动画正常出现。

## 实现文件

- `android/www/inject.js`：`channelGroups()` 分组、`renderHome` 展开分支、CSS（滚动条隐藏 + 图标方砖）。

## 待确认 / 可调项

- 展开态每行列数（默认 8）与方砖尺寸（默认 76px），按视觉微调。
