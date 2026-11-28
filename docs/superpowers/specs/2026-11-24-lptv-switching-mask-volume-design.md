# LPTV 切换台蒙层(A) + 播放界面音量 UI/空闲隐藏 — 设计

日期：2026-11-24
状态：待批准

## 意图

播放/切换界面两处体验调整：
- **切换台（状态6）**：切台时保留上一路**真实画面**（方案 A）——如 CCTV-1 继续播放，上面盖一层半透明蒙层，切换 UI（光环/信息卡/中心环）浮在蒙层上；中心环里的数字改成 `icon.png`（透明底，无圆底背景）。
- **播放界面（状态2/3）**：无操作（空闲）时隐藏顶部信息层；底部中间加一个音量图标；右上角音量提示从纯文字改成**静音图标 + 音量进度条**。

## 目标

1. 切台时 `#lptv-view-playing` 保持可见（视频继续播），`#lptv-view-switching` 背景透明 + 蒙层盖住，画面**不模糊**（真实直播画面）。
2. 中心环 `.lv-sw-ring .num`（电视台号数字）→ `<img>` 显示 `icon.png`（经 `__LPTV_ICON_SRC` data URI），去掉内圆填充背景。
3. 播放界面空闲态隐藏 `.lv-play-top`（顶部信息层：频道名/直播/高清 + 时间胶囊），有操作（`show-controls`）才显示——与底部控制栏一致。
4. 底部控制栏中间（首页按钮旁）加一个音量按钮（静音/取消静音切换）。
5. 右上角音量提示 `#lv-vol-hint` 改为：**静音图标 + 水平音量进度条**；调音量（M/方向键/音量键/滚轮）时浮出，1.6s 后自动隐藏。

## 非目标 / 反目标

- 不改频道数据、播放器核心、切台就绪判定（`swState`/`finishSwitching` 逻辑不动）。
- 不改首页、左/右面板。
- 不做音量滑块拖拽交互（无操作时调音量即可，滑块仅展示当前音量）。

## 方案

### 切换台（方案 A：真实画面留在蒙层后）
- 视图显隐：新增 `#lptv-root[data-state=switching] [data-view=playing]{display:flex}`，切换态下播放视图**保留**作背景（视频继续播）。
- `#lptv-view-switching` `background:#05070e` → `transparent`；`.lv-sw-bg`（抓帧快照）不再显示（透明/移除）——真实视频在播放视图后面。
- `.lv-sw-dim` 作蒙层：`rgba(5,7,14,.55)`（比现 .45 略深，让切换 UI 更清晰）；不加 `blur`。
- 中心环：`.lv-sw-ring .num` 的 textContent → `<img src="__LPTV_ICON_SRC">`；去掉内圆 `<circle r="90" fill="rgba(255,255,255,.08)">` 填充（透明底图标）。

### 播放界面
- `.lv-play-top` 加 `show-controls` 门控：`#lptv-root.show-controls[data-state=playing] #lptv-view-playing .lv-play-top{display:flex}`，与 `.lv-play-controls` 同规则；空闲态隐藏。
- 控制栏 `.lv-glass-bar` 中心加音量按钮（`lv-b-vol`，静音图标，点击 `toggleMute()`），放在首页按钮旁。
- `.lv-vol-hint` 结构改为：静音图标 SVG + 进度条（`.lv-vol-track` + `.lv-vol-fill`）；`updateVolHint` 更新 fill 宽度（音量%）与静音图标状态，浮出逻辑不变（1.6s）。

## 实现文件

- `android/www/inject.js`：切换视图 CSS（透明背景/蒙层/中心 icon）+ 播放视图门控 + 控制栏音量按钮 + `#lv-vol-hint` 结构与 `updateVolHint`/`toggleMute`/`setVolume` 更新。

## 待确认 / 可调项

- 蒙层不透明度 `.55`（可调）。
- 音量进度条样式：高 6px 圆角，宽 ~120px（可调）。
- 音量按钮位置：控制栏中间、首页按钮右侧（可调）。
