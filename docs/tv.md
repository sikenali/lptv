# 智慧屏 / CDE 播放技术方案对比与流畅度分析

日期：2026-11-23  
范围：当前 LPK（`cloud.lazycat.catlink.lptv`）智慧屏入口、CDE 桌面投射入口、Electron 容器端、xpra 编码链路、注入层播放逻辑。  
目的：说明两条链路各自的技术实现、为什么智慧屏播放更流畅/更清晰、CDE 为什么卡一点，以及“CDE 为什么不能直接照搬智慧屏的播放调用方式”。

---

## 0. 结论先行

1. **卡顿差异不在“播放调用方式”**。智慧屏和 CDE 最终播放的都是央视频官方 H.264-over-MSE 页面，换台是点官方按钮还是走 `play_channel`，只影响“怎么加载频道”，不影响“加载完之后每一帧画面怎么编码、传输、解码”。
2. **差异在画面传输链路**：
   - 智慧屏走 xpra HTML5 网页客户端，画布 1280×720，1:1 全屏，客户端是轻量浏览器画布。
   - CDE 走 catlink 原生客户端投射，虚拟桌面更大（1707×960 / 2560×1440），原生客户端要做桌面合成、缩放、解码，窗口/最大化时编码区域还会翻倍。
3. **xpra 当前是 x264 软件编码**（quality=90、speed=80/90、30fps、Xdummy 软件合成、oneVPL 硬编关闭），软件编码预算有限。智慧屏 0.92M 像素/帧能跟上；CDE 一旦放大到 1.64M～2.07M 像素/帧就跟不上，表现为 batch.delay、帧间隔不均、感知卡顿。
4. **清晰度差异**：
   - 智慧屏 1280×720 流 → 1280×720 屏，1:1 映射，视频原生 720p，不放大，所以清晰。
   - CDE 原生客户端把远程桌面缩放到自己的窗口；窗口大于 1280×720 时，720p 视频被放大 → 模糊；x264 软编用 speed=80（superfast）+ quality=90 换帧率，压缩效率下降 → 更多压缩痕迹；再叠加一次“解码后再编码”的代际损失。
5. **CDE 不能直接照搬 `play_channel`**：`play_channel` 是网页版播放器（`/web/web/`，bridge.js + iframe）的接口；CDE 是容器里的 Electron 窗口经 xpra 投射，Electron 前端不加载 bridge.js，`isTv()` 为 false，走官方按钮点击。即使强行让 CDE 走 `play_channel`，播放后的画面仍要经过 xpra 捕获→x264 编码→网络→客户端解码，卡顿不会消失。要 CDE 也像智慧屏一样流畅，必须动“传输链路”（缩小编码区域 / 硬件编码 / 改用网页版本地解码），不是动“调用方式”。

---

## 1. 两条链路的总体结构

### 1.1 智慧屏（当前实现）

```
智慧屏客户端（tvos BrowserView）
  │ 打开 LPK 入口 /
  ▼
Vue UI（lpk/ui）
  │ UA 检测：/LazyCatTvOsClient|Lazycat_ContentView/i
  │ 命中 → window.location.replace('/catlink/?floating_menu=false')
  ▼
/catlink/ 路由（lzc-manifest.yml）
  │ 反向代理到 http://cde:7890/
  ▼
容器内 xpra 服务（run.sh: cde-supervisor xpra seamless --bind-ws 0.0.0.0:7890）
  │ HTML5 网页客户端连接
  │ 虚拟屏：resize-display=yes:1280x720；Xorg Modes 1707x960 / 1280x720
  │ 智慧屏 HTML5 客户端 desktop-size = 1280x720
  ▼
容器内 Electron LPTV（launch_chrome.sh → AppImage → electron/main.js）
  │ 加载央视频官方页（H.264-over-MSE）
  │ 注入 frontend/inject.js：顶栏/控制栏/频道面板/EPG/设置/手势
  │ 窗口 = 虚拟屏全尺寸 1280×720（containerWinRect 对 ≤1280×720 直接全屏）
  ▼
xpra 捕获 1280×720 窗口 → x264 软件编码（quality=90 / speed=80 / 30fps）→ 网络
  ▼
智慧屏浏览器 HTML5 客户端解码/渲染（全屏 canvas，无原生桌面合成）
```

关键点：

- 智慧屏**没有 catlink 投射插件**，所以不走原生投射；`lpk/ui/src/main.js` 检测到智慧屏 UA 后直接跳 `/catlink/`。
- 智慧屏的播放画面是容器 Electron 窗口，经 xpra 的 HTML5 网页客户端显示，不是浏览器直接打开 `/web/web/` 网页播放器。
- 智慧屏画布被限制在 1280×720：`run.sh` 设置 `resize-display=yes:1280x720`，Xorg Modes 首选 1707×960、次选 1280×720；HTML5 客户端请求 1280×720，虚拟屏就是 1280×720。
- Electron 窗口按 `containerWinRect()`：`d.w <= 1280 && d.h <= 720` 时窗口=全屏 1280×720，所以编码区域 0.92M 像素/帧。

### 1.2 CDE 桌面（当前实现）

```
CDE 桌面客户端（catlink 原生客户端 + 投射插件）
  │ 打开 LPK 入口 /
  ▼
Vue UI（lpk/ui）
  │ 非智慧屏 → createApp(Open).mount()
  │ Open.vue / useProjection.js：检查插件、启动投射、launch-with-args
  ▼
容器 rim / xpra（cde-supervisor xpra seamless）
  │ 原生客户端连接，请求 desktop-size（客户端真实桌面，可能 2560×1440）
  │ resize-display=yes → xpra 跟随客户端 desktop-size（上限由 Xorg Modes/最大桌面尺寸决定）
  ▼
容器内 Electron LPTV（launch_chrome.sh → AppImage → electron/main.js）
  │ 窗口几何：containerWinRect()
  │   - 虚拟屏 ≤1280×720 → 全屏 1280×720
  │   - 虚拟屏 >1280×720 → 75% 屏，封顶 1920×1080
  │ 注入 frontend/inject.js；视频铺满窗口（当前版本不再钳 1280×720）
  ▼
xpra 捕获窗口 → x264 软件编码（同智慧屏）→ 网络
  ▼
catlink 原生客户端解码 + 桌面合成 + 缩放（远程桌面窗口）
```

关键点：

- CDE 走原生投射，客户端不是浏览器 canvas，而是完整的远程桌面客户端：解码 H.264、合成桌面、缩放远程桌面到自己的窗口、处理窗口/输入/剪贴板等。
- 虚拟屏跟随客户端桌面尺寸：`resize-display=yes:1280x720`；`run.sh` 的 Xorg Modes 是 `1707x960_60.00`、`1280x720_60.00`，初始模式 1707×960。客户端请求更大的 desktop-size 时，xpra 会把虚拟屏拉到最大可用尺寸（1707×960 或客户端尺寸，取决于 xpra/xorg 的上限）。
- Electron 窗口按 `containerWinRect()`：大屏时 75% 屏、封顶 1920×1080；在 1707×960 虚拟屏下就是 1280×720；在 2560×1440 下就是 1920×1080。
- 当前注入层 `styleOfficial()` 已移除 1280×720 钳制，视频铺满窗口：默认 1280×720 窗口时编码 0.92M；最大化/1920×1080 窗口时编码 1.64M～2.07M。

---

## 2. 逐项对比

| 维度 | 智慧屏 | CDE |
|---|---|---|
| 入口 | `/` → Vue UI → UA 检测 → `/catlink/` | `/` → Vue UI → 原生投射 |
| 显示客户端 | xpra HTML5 网页客户端（浏览器 canvas） | catlink 原生客户端（远程桌面） |
| 客户端职责 | 只解码 + 全屏渲染视频画布 | 解码 + 桌面合成 + 缩放 + 窗口/输入/剪贴板 |
| 虚拟屏/画布 | 1280×720（`resize-display=yes:1280x720`，Modes 1707×960/1280×720） | 跟随客户端 desktop-size，可达 1707×960 / 2560×1440 |
| Electron 窗口 | 全屏 1280×720 | 默认 1280×720；大屏 75% 封顶 1920×1080；最大化可到 1707×960/1920×1080 |
| 视频区域 | 铺满 1280×720 | 铺满窗口；默认 1280×720，最大化更大 |
| 编码器 | x264 软件编码 | x264 软件编码 |
| 编码参数 | quality=90、speed=80（superfast）、30fps、threads=16、500Mbps | 同左 |
| 渲染后端 | Xdummy 软件合成（无 GPU） | Xdummy 软件合成（无 GPU） |
| 编码像素/帧 | 约 0.92M | 默认约 0.92M；最大化 1.64M～2.07M |
| 客户端解码 | 浏览器/HTML5 客户端（通常硬件解码） | 原生客户端（软件解码 + 桌面合成/缩放） |
| 清晰度 | 1280×720 1:1，原生 720p，不放大 | 客户端缩放远程桌面；窗口大于 1280×720 时 720p 被放大；x264 speed/quality 取舍 + 二次编码痕迹 |
| 播放调用 | Electron 注入层官方按钮点击（`isTv()` 为 false，因为没有 bridge.js）；网页版 `/web/web/` 才走 `bridge.play_channel` | Electron 注入层官方按钮点击；不走 `play_channel` |
| 流畅度 | 小区域 + 轻客户端 → 流畅 | 原生客户端合成/缩放 + 最大化时编码区域翻倍 → 卡 |

---

## 3. 为什么智慧屏更流畅

### 3.1 编码区域小，x264 软编能跟上

`lpk/content/90_lzc.conf` 当前配置：

- `quality=90`、`max-quality=90`
- `speed=80`、`min-speed=80`（x264 preset=superfast）
- `refresh-rate=30`
- `start-env=XPRA_X264_THREADS=16`
- `video-encoders = vpl,libva,x264,vpx`（oneVPL/libva 只是前瞻；当前 `XPRA7_UPGRADE=0`，实际是 x264 软编）
- `bandwidth-limit=500Mbps`

智慧屏画布 1280×720 = 0.92M 像素/帧，30fps = 27.6M 像素/秒。x264 软编在 superfast 预设下能稳定跟上，帧间隔均匀，所以感知流畅。

CDE 默认窗口 1280×720 时编码区域也是 0.92M，理论上编码侧与智慧屏相同；但 CDE 的原生客户端还要做桌面合成/缩放/解码，客户端侧开销更重。**一旦最大化**，窗口到 1707×960 或 1920×1080，编码区域 1.64M～2.07M 像素/帧，30fps 就是 49M～62M 像素/秒，软编跟不上 → batch.delay 升高、帧间隔不均 → 感知卡顿。

`lpk/content/run.sh` 的注释已经记录了实测结论：

> 桌面 cde 客户端窗口被放大到 1920×1080 时，x264 软编跟不上（batch.delay 200ms+ → 卡顿）；智慧屏本身编码量小，影响很小。

### 3.2 客户端轻，没有桌面合成/缩放

智慧屏是 xpra HTML5 网页客户端，本质是一个全屏浏览器 canvas：解码 H.264 后直接绘制到页面，没有远程桌面窗口管理、桌面合成、窗口缩放、输入法/剪贴板等额外链路。客户端侧 CPU/GPU 开销低，帧呈现路径短。

CDE 是 catlink 原生客户端：它要解码远程桌面流、合成桌面、把远程桌面缩放到自己的窗口、处理窗口/输入/剪贴板/DPI 等。即使编码区域相同，客户端侧也更重，更容易出现抖动/延迟。

### 3.3 1:1 映射，不放大

智慧屏 1280×720 流 → 1280×720 屏，1:1 映射。视频原生 720p，不经过客户端放大，画面清晰、无放大模糊。

CDE 的远程桌面会被原生客户端缩放到客户端窗口；如果客户端窗口大于 1280×720，720p 视频被放大，画面变糊。若 Electron 窗口本身是 1920×1080，视频在渲染层就先被放大 1.5 倍，再被 xpra 编码，清晰度进一步下降。

---

## 4. 为什么 CDE 更卡、更不清晰

### 4.1 编码区域更大（最大化/大窗口）

当前 `frontend/inject.js` 的 `styleOfficial()` 已经把“钳到 1280×720”的逻辑删除：

```js
var vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
// 视频始终铺满当前窗口/视口（智慧屏=整屏；CDE 窗口=窗口尺寸含最大化）。
// 不再按视口尺寸钳到 1280×720（会误伤视口>1280×720 的智慧屏 → 显示不全）。
var vW = vw, vH = vh, vL = 0, vT = 0;
```

这意味着 CDE 最大化时视频铺满整个最大化窗口，编码区域从 0.92M 涨到 1.64M～2.07M。设计文档已经明确接受这个取舍：

> CDE 最大化铺满会增加 xpra 编码量（1920x1080 vs 1280x720），用户已知情并接受；若回顿挫，后续在 90_lzc.conf 或帧率侧平衡。

所以“CDE 打开窗口卡一点”很可能就是这次模式分离的副作用：视频不再被钳在 1280×720，窗口/最大化时编码量上升，x264 软编跟不上。

### 4.2 原生客户端解码/合成/缩放链路

CDE 原生客户端不是轻量 canvas，它要：

- 解码 H.264 远程桌面流；
- 合成远程桌面（窗口、背景、光标等）；
- 把远程桌面缩放到客户端窗口；
- 处理窗口管理、输入、剪贴板、DPI 等。

这些工作叠加在解码之后，客户端侧更容易出现延迟/抖动。智慧屏 HTML5 客户端只做“解码 + 全屏绘制”，路径短。

### 4.3 x264 软编 + speed/quality 取舍

当前没有硬件编码（`XPRA7_UPGRADE=0`，xpra 6.5 + x264 软编）。为了帧率，配置用了：

- `quality=90`（CRF≈6，视觉无损级，但比 CRF=1 快）
- `speed=80`（superfast，比默认 faster 快 2-3 倍，但压缩效率下降）

这是“画质换帧率”的取舍。CDE 在大窗口下编码压力更大，压缩效率下降的痕迹（块效应、细节丢失）也更明显，所以看起来不如智慧屏清晰。

### 4.4 二次编码代际损失

链路是：官方 H.264 解码 → Electron 渲染 → Xdummy 软件合成 → xpra 捕获 → x264 再编码 → 客户端解码。视频被解码再编码一次，代际损失不可避免；智慧屏也是同一条链路，但 1:1 映射 + 小区域让损失不明显。CDE 的放大/缩放会把代际损失放大。

---

## 5. “CDE 为什么不用智慧屏的播放调用方式”

### 5.1 两种“播放调用方式”实际是什么

- 智慧屏网页版播放器 `/web/web/`：`bridge.js` 的 `play_channel(pid)` 把官方页放进同源 iframe，浏览器本地解码渲染。这是真正的“本地网页播放器”路径，不经过 xpra 编码。
- CDE Electron：`frontend/inject.js` 的 `switchChannel()` 在 `isTv()` 为 true 时走 `window.lptv.play_channel(pid)`；否则走 `findOfficialButtons` 点击官方按钮 + 8s 整页路由兜底。Electron 前端不加载 `bridge.js`，`window.__lptvBridge` 未定义，所以 `isTv()` 为 false，CDE 走官方按钮点击。

`play_channel` 只决定“怎么加载频道页”，不决定“播放后的画面怎么送到客户端”。CDE 即使改成 `play_channel`，播放后的每一帧仍然要经过：

```
Electron 渲染 → Xdummy → xpra 捕获 → x264 编码 → 网络 → 原生客户端解码/合成/缩放
```

所以卡顿不会消失。

### 5.2 真正能让 CDE 像智慧屏一样流畅的做法

按代价从低到高：

1. **CDE 恢复 1280×720 视频钳制**（只在 CDE 桌面模式钳，智慧屏不钳）：编码区域回到 0.92M，最接近智慧屏的流畅度；代价是最大化时画面不铺满。
2. **CDE 改用网页版播放器 `/web/web/`**：和智慧屏网页版一样在客户端浏览器里本地解码，完全绕开 xpra；代价是丢掉 Electron 的窗口控制/录制/截图。
3. **开启 xpra 7 的 oneVPL 硬件编码**：`XPRA7_UPGRADE=1`（当前 manifest 是 0），编码近零 CPU，能同时保住铺满和流畅；代价是首次启动要编译几分钟，且要确认盒子核显支持。
4. **降帧率/画质**：`refresh-rate` 降到 24/25，或 `quality` 再降一点，用画质换帧间隔均匀。

### 5.3 网页版 `/web/web/` 的定位

`lpk/build.sh` 会把 `android/www/` 复制到 `lpk/content/web/web/`，这就是网页版播放器：

- `bridge.js` 提供 `play_channel(pid)`，设置同源 iframe 的 `src`；
- `index.html` 里是 iframe + `#lptv-root` 注入层；
- 浏览器本地解码，不经过 xpra；
- 当前 UI 的智慧屏 UA 检测跳的是 `/catlink/`（xpra HTML5），不是 `/web/web/`；`/web/web/` 仍作为网页版播放器保留（也用于 Android 镜像）。

如果用户说的“智慧屏的播放调用方式”指 `play_channel`，那它属于 `/web/web/` 网页版；当前智慧屏实际走的是 `/catlink/` 的 xpra HTML5 客户端。无论哪种，**“调用方式”都不是 CDE 卡顿的原因**。

---

## 6. 代码索引

| 位置 | 作用 |
|---|---|
| `lpk/ui/src/main.js` | 智慧屏 UA 检测，跳 `/catlink/?floating_menu=false` |
| `lpk/rchrome/lzc-manifest.yml` | `/catlink/` → `http://cde:7890/`；`/` → Vue UI；`/tv/`、`/js/`、`/css/` → 央视频 |
| `lpk/content/run.sh` | 启动 cde-supervisor/xpra；Xdummy；Xorg Modes 1707×960/1280×720；`resize-display=yes:1280x720`；XPRA7 开关 |
| `lpk/content/90_lzc.conf` | x264 软编参数：quality=90、speed=80、refresh-rate=30、threads=16、500Mbps |
| `lpk/content/launch_chrome.sh` | AppImage 解包/启动 Electron；LPTV_START_TS 启动计时 |
| `electron/main.js` | `containerWinRect()` 窗口几何；`IS_CONTAINER`；Electron 注入；窗口控制 |
| `frontend/inject.js` | `styleOfficial()` 铺满视口；`switchChannel()`；`isTv()`/`spinSmart()`；`fit`/cover |
| `lpk/build.sh` | 构建 UI；把 `android/www/` 复制到 `/web/web/`；Service Worker/反代 |
| `android/www/bridge.js` | `play_channel(pid)` 网页版播放器接口 |
| `docs/superpowers/specs/2026-11-23-lptv-mode-separation-design.md` | 模式分离设计；明确接受 CDE 最大化编码量上升 |

---

## 7. 验证与诊断建议

如果要在盒子上确认具体瓶颈，建议采集：

1. **xpra 编码指标**：容器内 `DISPLAY=:0 xpra info`，对比智慧屏连接和 CDE 连接时的：
   - `batch.delay`
   - 编码 fps / 帧间隔
   - 编码 region 像素数（窗口尺寸）
   - encoder 类型（x264 / vpl / libva）
2. **窗口几何**：`electron/main.js` 的 `fsDiag` 落盘 `DATA_DIR/lptv.fs.log`，确认 CDE 窗口是 1280×720 还是 1920×1080/1707×960。
3. **虚拟屏尺寸**：`xrandr --query` / `xpra info` 的 `screen-size`，确认 CDE 的 desktop-size 是否被拉到 1707×960/2560×1440。
4. **GPU/VA-API**：`lpk/content/diag_lptv.sh` 采集 `/dev/dri`、`vainfo`、`glxinfo`、xpra 编码器；确认硬件编码是否可用。
5. **客户端解码**：对比智慧屏 HTML5 客户端和 CDE 原生客户端的解码路径（浏览器 WebCodecs/硬件解码 vs 原生客户端软件解码），确认客户端侧开销。

判断逻辑：

- 如果 CDE 的编码 region 明显大于 1280×720 → 编码量问题，选“恢复 1280×720 钳制”或“开 oneVPL 硬编”。
- 如果 region 相同但 CDE 仍卡 → 原生客户端解码/合成/缩放问题，选“改用 `/web/web/` 网页版本地解码”或调客户端解码/缩放。
- 如果 CDE 最大化才卡、默认窗口不卡 → 就是模式分离移除钳制后编码量上升，按第 5.2 节第 1/3/4 条处理。

---

## 8. 一句话总结

**智慧屏流畅清晰，是因为它用 1280×720 的小画布 + 轻量 HTML5 客户端 + 1:1 映射；CDE 卡一点，是因为它走原生投射，客户端要做桌面合成/缩放，且最大化时编码区域翻倍、x264 软编跟不上。播放调用方式（官方按钮 vs `play_channel`）只影响换台加载，不影响编码/传输，所以 CDE 照搬智慧屏的调用方式也解决不了卡顿；要解决，必须缩小编码区域、开硬件编码，或改用网页版本地解码。**
