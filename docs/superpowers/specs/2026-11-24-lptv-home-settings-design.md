# LPTV 首页右上角设置弹窗（播放设置 / 快捷键 / 关于）— 设计

日期：2026-11-24
状态：待批准

## 意图

在首页右上角**时间胶囊右侧**新增一个**设置（齿轮）图标按钮**，点击后弹出一个**小窗口**，顶部**横排 3 个标签**（上图标下文字，样式同播放界面 hover 的「首页/音量」按钮）：播放设置 / 快捷键 / 关于。

- **播放设置**：① 运行程序自动播放【勾选框】 ② 点击频道默认全屏播放【勾选框】。
- **快捷键设置**：展示当前**真实生效**的键位（已无 录制/截图/浮窗）。
- **关于**：继承之前设置界面的「关于」面板内容（图标 / 版本 / 描述 / 标语）。

## 目标

1. 首页右上角 `.lv-home-topright` 内、时间胶囊右侧新增齿轮按钮（与主题切换、时钟胶囊同排、同风格）。
2. 点击齿轮 → 居中液态玻璃小弹窗（方案 A）：顶部横排 3 个标签（图标在上、文字在下），下方为对应面板内容。
3. 播放设置面板含两个勾选框，持久化到 `cfg`（`localStorage lptv.cfg.v3`），并在 Python 侧 `set_ui_state` 同步。
4. 快捷键面板列出当前 `keydown` 实际绑定的键位（0-9 / ↑↓ / PageUp·Down / ←→ / 空格 / M / C / E / F11 / Escape / 媒体·遥控键 / Ctrl+D）。
5. 关于面板复用旧设置界面内容。

## 非目标 / 反目标

- 不改频道数据、播放器核心、切台状态机（`swState`/`finishSwitching` 不动）。
- 不改首页卡片网格、左/右面板、切换台视图。
- 不恢复已删除的功能（录制 / 截图 / 悬浮窗 / 最大化 / 设置 S 键 / 收藏 / OSD / 窗口控制）。
- 快捷键设置**只展示**，不提供改键交互（与旧设置界面一致）。

## 方案（已定：方案 A 居中弹窗）

### 新增持久化配置（默认保持现状）

| 键 | 默认 | 说明 |
|---|---|---|
| `autoPlayOnLaunch` | `false` | 启动时自动播放上次频道（否则进首页不播放，现状） |
| `clickFullscreen` | `false` | 点击频道卡片进入播放后自动全屏（否则不自动全屏，现状） |

- 两个默认值均为 `false`，保证**现有行为不变**（用户未勾选时与今天完全一致）。
- 加入 `DEFAULT_CFG`；勾选变更写 `saveCfg()` + `pyStatePush({...})`。

### 弹窗 UI（`#lptv-settings`，居中模态，液态玻璃）

- 结构：遮罩 `.lv-set-mask` + 卡片 `.lv-set-card-wrap`；卡片顶部横排 3 个 `.lv-set-tab`（上图标下文字，复刻 `.lv-bar-home`/`.lv-bar-vol` 圆角按钮造型），下方 `.lv-set-body` 放面板。
- 面板：`.lv-set-pane`，激活态 `.on`（`data-tab` 切换，点标签切换，默认「播放设置」）。
- 主题：复用 `--panel/--line/--tx/--tx2` 等设计令牌 + `[data-theme=light]` 覆盖，与现有弹窗（左/右面板）一致。
- 关闭：右上角 ✕、点击遮罩、Esc（`closeOverlay()` 里一并处理）。

### 播放设置面板

- 「运行程序自动播放」→ `cfg.autoPlayOnLaunch`。
- 「点击频道默认全屏播放」→ `cfg.clickFullscreen`。

### 快捷键面板

- 只读清单，一行一个「名称 + 按键图标（`<kbd>`）」，内容 = 当前 `keydown` 实际绑定（见目标 4）。不含 R/X/悬浮窗/双击。

### 关于面板

- 复用旧设置界面内容：`icon.png` 图标、版本号、描述「懒猫微视是一款专门为懒猫微服打造的YSP远程播放客户端。」、标语「为慵懒而生，享直播视听。」、脚注「Powered by LightOS · Made for LCMD」。

### 行为接线

- **自动播放**：`initChannels` 内 `resumeFlow`（或其后）：若 `cfg.autoPlayOnLaunch` 为真 → `switchChannel(cfg.lastPid || lptv.currentPid || chs[0].pid)`；否则维持现状（仅 `markActive`）。
- **点击频道默认全屏**：频道卡片点击切台成功进入播放（`enterPlaying`/`finishSwitching` 就绪）时：若 `cfg.clickFullscreen` 为真**且当前非全屏** → 进入全屏（不调用会切换的 `fullToggle`，改为仅当未全屏时进入，避免误退出）。仅首次进入播放时触发一次，避免每次重绘循环全屏。
- 齿轮按钮点击：`e.stopPropagation()`（避免触发卡片/拖拽）。

## 实现文件

- `android/www/inject.js`（唯一改动文件）：新增 `#lptv-settings` 视图（DOM/CSS/事件），`DEFAULT_CFG` 加两个键，`boot`/`initChannels`/`enterPlaying` 接线，`closeOverlay` 兼容，`applyTheme` 重建首页后齿轮状态保持。
- 设计文档：`docs/superpowers/specs/2026-11-24-lptv-home-settings-design.md`。

## 验证

1. 首页右上角出现齿轮，点击弹出居中弹窗，3 个横排标签可切换。
2. 播放设置两个勾选框默认**未勾选**；勾选后刷新页面状态保持（`localStorage`/Python `set_ui_state`）。
3. 勾选「运行程序自动播放」后重启：直接进入上次频道播放；取消后重启：进首页不播放（现状）。
4. 勾选「点击频道默认全屏播放」后点频道卡片：进入播放并全屏；取消后：进入播放不全屏（现状）。
5. 快捷键面板列出当前真实键位（无 R/X/浮窗/双击）。
6. 关于面板显示旧内容。
7. 深/浅主题下弹窗配色正确；Esc/遮罩/✕ 均可关闭。
