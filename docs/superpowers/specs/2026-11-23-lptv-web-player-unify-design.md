# LPTV 智慧屏 & CDE 统一到网页版播放器 /web/web/ — 设计

日期：2026-11-23
状态：待批准（用户已选方案① + 智慧屏切网页版）

## 意图

智慧屏与 CDE 播放都改走**网页版播放器 `/web/web/`**（浏览器本地解码 H.264，盒子只做静态资源 + 央视频反代），完全绕开 xpra 捕获→x264 软编→网络→客户端解码这条链路。这样智慧屏和 CDE 都获得“本地小码流/本地解码”的流畅与清晰，CDE 不再受原生投射客户端合成/缩放与最大化编码量翻倍的拖累。

背景（已分析，见 `tv.md`）：卡顿不在“播放调用方式”，而在画面传输链路。智慧屏现走 `/catlink/`（xpra HTML5 客户端，1280×720 小画布），CDE 走原生投射（虚拟屏可达 1707×960/2560×1440，原生客户端合成/缩放，最大化编码区域翻倍）。两边的真正“本地解码”路径是 `/web/web/`，但当前 UI 都没默认走它。

## 目标

1. 智慧屏入口由 `/catlink/?floating_menu=false` 改为 `/web/web/`。
2. CDE 桌面客户端入口改为 `/web/web/`（不再走原生投射/Electron）。
3. 播放链路 = 浏览器本地解码；盒子只服务 `/web/web/` 静态资源 + `/tv/ /js/ /css/`（央视频反代）+ `/rim/yspapi`（CORS 代理）。
4. 两模式行为一致：`isTv()`=true（`window.__lptvBridge===true`）→ `switchChannel` 走 `play_channel`，fit 默认 cover，切台 800ms 延迟遮罩 + 5s 看门狗。

## 非目标 / 反目标

- 不删除 Electron AppImage / xpra 链路（保留为后备与本地桌面；但播放默认不再走它）。
- 不改变 Android APK（`android/www/` 独立分发）。
- 不给网页版加录制/截图/窗口控制（`bridge.js` 为 Android 桩，网页版无这些能力——用户已知并接受）。
- 不改央视频官方页路由基址（`/tv/` 必须保持原始路径，否则 SPA 路由错乱）。
- 不引入 xpra 7.0 硬件编码（本轮不做；网页版已绕开编码）。

## 约束

- `frontend/inject.js` 与 `android/www/inject.js` 必须**字节一致**（`cmp -s`）。`lpk/content/web/web/` 由 `lpk/build.sh` 从 `android/www/` 复制生成，改动后须重生成。
- `/web/web/` 依赖 Service Worker（`/sw.js`，scope `/`）把 `*.yangshipin.cn` 的 fetch/XHR 经同源 `/rim/yspapi` 转发（这些接口无 CORS 头，直接跨域必失败）。
- 桌面/CDE 客户端必须有一个能显示 `/web/web/` 的浏览器/webview 上下文（当前 `/` 的 Vue UI 已在该上下文中，故成立；实施时先验证）。

## 方案（用户已选）

统一到网页版 `/web/web/`，播放由浏览器本地解码。

### 改动清单

1. **`lpk/ui/src/main.js`**：入口分流改为网页版。
   - 现：智慧屏 UA → `/catlink/?floating_menu=false`；桌面 → mount Vue UI（启动投射）。
   - 改：**所有客户端默认跳 `/web/web/`**（智慧屏与桌面一致）。保留 `/?setting` 走 Vue UI 设置页（catlink 客户端编码配置，网页版用不到，保留入口不破坏）。
   - 作用：跳过 catlink 投射插件安装/版本检查与 Electron 启动，盒子上只跑 cde 容器（提供 `/rim/yspapi` 与静态资源）。
2. **重新生成 `/web/web/`**：`bash lpk/build.sh`（把 `android/www/` 复制到 `content/web/web/`，注入 SW 与隐私弹窗自动点掉脚本）。确保 `content/web/web/inject.js` 为最新（含 `isTv()`/模式分离/glass）。
3. **`frontend/inject.js`（+ 镜像 `android/www/inject.js`）**：网页版隐藏无意义的窗口按钮。
   - 网页版 `window.lptv.minimize/maximize_toggle/close_window` 都是 `{ok:false}` 桩；在 `__lptvBridge` 模式下隐藏顶栏窗口控制按钮（`.lptv-tb-btns`），保留频道信息。桌面 Electron 不受影响（`__lptvBridge` 为 false，按钮照常）。
   - 保持双镜像字节一致。
4. **`lpk/content/run.sh`（可选优化，本轮可不做）**：网页版播放不启动 Electron。把“自动拉起 LPTV / 预热解包 AppImage”等逻辑用开关关闭（避免盒子上白跑 Electron）。默认本轮保留（不破坏其他路径），标记为后续优化。

### 不改

- `lpk/content/90_lzc.conf`、`run.sh` 的 xpra 编码参数（网页版不再消费；保留供本地桌面后备）。
- `electron/main.js`（Electron 保留为后备，不动）。
- `android/www/bridge.js` 的 `play_channel` 实现（网页版直接复用）。

## 风险与验证

1. **Service Worker 安全上下文**：SW 需要 https 或 localhost。若 LPK 以 http 提供服务，`/sw.js` 注册失败 → 央视频接口跨域失败 → 页面“网络异常”。**实施后必须验证**（当前智慧屏 `/web/web/` 设计即依赖 SW，若失败则回退 `/catlink/` 并上报）。
2. **桌面浏览器上下文**：CDE 客户端需能显示 `/web/web/`。先验证桌面客户端打开 `/` 的上下文是否可直接跳到 `/web/web/`（若桌面客户端是“仅投射、无浏览器上下文”，方案①在该环境不成立，需改回原生投射 + 锁 1280×720 码流）。
3. **`/rim/yspapi` 可用性**：容器 rim 必须实现该代理。若缺失，央视频接口请求失败 → 黑屏。验证方法：打开网页版后看控制台是否还有跨域/网络错误。
4. **遥控器操作（智慧屏）**：网页版用遥控器上下左右/OK 导航；验证 `bridge.js` 注入层的按键映射（inject.js 已有按键处理，需在真实智慧屏验证）。
5. **双镜像**：改动 inject.js 后 `cmp -s frontend/inject.js android/www/inject.js` 必须通过。

## 交接给实现者的决定

- 入口分流用 `lpk/ui/src/main.js` 的 UA 检测（智慧屏/桌面都用同一分支跳 `/web/web/`），不引入额外服务端 302。
- 网页版隐藏窗口按钮用 `window.__lptvBridge` 判定（与 `isTv()` 同源），不新增配置项。
- `/web/web/` 静态内容以 `android/www/` 为源，`build.sh` 重生成；不做独立 web 目录（避免三份拷贝漂移）。
- 本轮不删 Electron/xpra 链路、不改 run.sh 启动逻辑（保留后备），仅切入口。
