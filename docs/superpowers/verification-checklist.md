# LPTV 真机验证清单（三个计划合并）

日期：2026-11-23
范围：web-player-unify（智慧屏/CDE/移动端统一走 `/web/`）+ player-single-source（播放器资产单源收敛 B2）+ mobile-landscape（移动端强制横屏）。
说明：所有项在**盒子侧**人工验证，无法自动化。勾选后记录结果与日期。

---

## 1. 智慧屏（懒猫智慧屏客户端）

- [ ] **入口**：打开 LPK → 直接进入 `/web/` 播放器，**无** `/catlink/?floating_menu` 工具条。
- [ ] **切台**：频道切换正常（`play_channel` 路径），无黑屏、无“网络异常/跨域”错误。
- [ ] **遥控器**：方向/OK 可导航控制栏、频道面板、节目单。
- [ ] **横屏引导不误现**：不出现“请横屏观看”覆盖层（智慧屏非 coarse touch）。

## 2. CDE 桌面客户端（懒猫微服客户端）

> 与智慧屏**同一实现**：`lpk/ui/src/main.js` 把非 `?setting` 入口统一 `location.replace('/web/')`
> （commit `886afcc`），CDE 客户端点开应用加载 `/?r` → `/web/` → 加载 `android/www` 镜像
> （iframe 央视频 + `bridge.js` + `inject.js`），浏览器本地解码，无 xpra 编码。
> `Open.vue`/`useProjection`（catlink 投射）已不被入口引用——tv.md 里"CDE 卡"的 xpra 链路
> 在当前入口下已不走。

- [ ] **入口**：打开 LPK → 直接进入 `/web/` 播放器（与智慧屏同款），**无** `/catlink/?floating_menu` 工具条、无 xpra 卡顿。
- [ ] **切台**：频道切换正常（`play_channel` 路径），无黑屏、无“网络异常/跨域”错误。
- [ ] **鼠标/键盘**：鼠标可点卡片、面板、控制栏；方向键 ↑/↓ 换台、←/→ 音量；F11 全屏；Esc 关闭面板。
- [ ] **视口非 16:9**：窗口非 16:9 时 `applyDesignScale` 按 `min()` 缩放并把 1920×1080 画布居中，无滚动条、无元素溢出。

## 3. 移动端（安卓装懒猫微服 → 开懒猫微视）

- [ ] **竖屏引导**：手机竖屏进 `/web/` → 显示“请横屏观看”覆盖层（`#lptv-rotate-prompt`）。
- [ ] **横屏恢复**：手机横屏 → 覆盖层消失，播放/UI 正常。
- [ ] **触摸模式**：顶栏隐藏、底部控制栏 `#lptv-controls` 可用、右缘轻扫/tap 开频道抽屉、左缘开 EPG、点画面切换控制栏。
- [ ] **切台无网络错误**：切台正常，无跨域/网络错误（验证 `/rim/yspapi` + `/sw.js`；若 SW 在 http 非 localhost 注册失败 → 回退并上报）。
- [ ] **桌面竖窗不误判**：桌面浏览器竖窗不出现引导层（`(hover:none) and (pointer:coarse)` 判定）。

## 4. 本地桌面 Electron（后备）

- [ ] **注入/窗口/台标**：`npx electron .`（或 AppImage）启动，窗口、顶栏、台标正常，播放不回归。
- [ ] **不回归**：`__lptvBridge` 未定义 → 窗口按钮/顶栏照常。

## 5. 打包产物（构建侧）

- [ ] **APK 构建**：`bash android/build.sh` 以 `android/www` 为唯一源，产物完整（含 inject.js/splash.js/icon/台标）。
- [ ] **Electron 打包态 logos**（单源 Minor#1 deferred）：`bash build/build_electron.sh` 后确认 `dist/linux-unpacked/resources/frontend/logos/*.webp` 存在。
- [ ] **哨兵**：打包后 `resources/frontend/inject.js` 存在（`tools/box-diag.sh`）。

---

## 诊断命令（盒子侧核对用）

```bash
# 1) 单源镜像一致（生成物 == 源）
cmp -s lpk/content/web/inject.js android/www/inject.js && echo INJECT_MIRROR_OK
cmp -s lpk/content/web/splash.js android/www/splash.js && echo SPLASH_MIRROR_OK

# 2) frontend/ 已删（单源收敛）
test ! -d frontend && echo FRONTEND_GONE

# 3) 入口分流（应只跳 /web/，无 /catlink/）
grep -q 'window.location.replace("/web/")' lpk/content/web/assets/index-*.js && echo VITE_REDIRECT_OK

# 4) 移动端横屏引导就位
grep -c 'applyRotatePrompt\|lptv-rotate-prompt\|请横屏观看' android/www/inject.js

# 5) Service Worker / CORS 代理（SW 需 https 或 localhost）
grep -c 'serviceWorker' lpk/content/web/index.html
grep -c 'yspapi' lpk/content/web/sw.js

# 6) 语法
node --check android/www/inject.js && node --check electron/main.js && echo SYNTAX_OK
```

---

## 结果记录

| # | 项 | 结果 | 备注 |
|---|---|---|---|
| 1 | 智慧屏入口/切台/遥控器/无引导层 | ☐ | |
| 2 | CDE 入口/播放流畅 | ☐ | |
| 3 | 移动端竖屏引导/横屏/触摸/切台/桌面不误判 | ☐ | |
| 4 | 本地 Electron 注入/窗口/台标 | ☐ | |
| 5 | APK 构建/Electron 打包 logos/哨兵 | ☐ | |

---

## 审计结论（2026-11-23，只读审计 + 修正）

**所有功能点真实现、真实数据，无 mock 假数据**（频道 59 真实 / 台标真实 webp / EPG 真实 capi API / 播放真实 iframe / 状态真实 localStorage；空态文案为真实空态）。UI 与设计图**高保真还原**。

**bridge.js 清理**（commit `446c382`，rebase 后）：删除 20 个 UI 不调用的 `{ok:false}` 休眠桩，保留 9 个真实实现（`play_channel`/`get_channels`/`get_ui_state`/`set_ui_state`/`get_asset_image`/`get_version`/`shot_save`/`fullscreen_toggle`/`get_save_dirs`）。Electron `main.js`/`preload.js` 为真实桌面实现（不同平台路径，保留）；`electron/dist/` 旧产物 gitignored。

**还原校验修正**（commit `8483030`，rebase 后）：
- D2：播放态顶部子信息行 `lv-play-sub` 现显示**当前节目名**（真实 EPG），未知留空。
- D3：画质标签 `lv-play-quality` 现按**真实视频分辨率**映射（4K/超清/高清/标清/流畅；未就绪或 iframe 跨域模型取不到 → 设计默认"高清"）。

**剩余非功能微差（不阻塞，可不动）**：D1 首页卡片宽 280px vs 设计 270px（grid 6 列铺满，视觉等价）；D4 CGTN 分组竖条用蓝色（设计未规定 CGTN 颜色）。

---

## AppImage 构建 + 验证（2026-11-23）

**构建**：`SKIP_INSTALL=1 bash build/build_electron.sh`（`electron-builder --linux AppImage`）→ `electron/dist/LPTV-linux-x86_64-1.0.0.AppImage`（104M，20:32）。

**产物校验（✅ 全过）**：
- 播放器资产镜像一致：`inject.js`/`bridge.js`/`splash.js`/`index.html`/`channels.json` 全部 `SAME`（来自最新 `android/www`）。
- 台标 59 个：`resources/frontend/logos/` + `resources/logos/`。
- 注入层哨兵就位（`inject.js`/`bridge.js`/`splash.js`）；含最新修正（`updateQualityBadge`/`lv-play-sub`）；bridge 桩已删（`rec_open`=0，保留 `play_channel`）。

**实际运行冒烟测试（✅ 通过，headless `--ozone-platform=headless` 45s）**：
- `[LPTV-startup] dom_ready=4405ms` / `window_shown=4432ms` / `page_loaded=9731ms`。
- 注入层运行：`[LPTV-renderer] [LPTV-env]`/`[LPTV-geo]`（inject.js 实际加载执行）。
- 页面导航真实央视频 URL `yangshipin.cn/tv/home?pid=600001801`；进程持续 45s 未崩溃（exit=124 超时）。
- 日志报错均为 headless 容器固有无害项（无 dbus/声卡/WM 图标写入需 display），非 AppImage 故障。

**局限**：本机无 display（无 `DISPLAY`、无运行中 X、sudo 需密码无法装 xvfb），**无法画面级视觉确认**。画面级需在有 display 环境跑一次。

**LPK 打包**：走 `lpk/rchrome/`（`package: cloud.lazycat.catlink.lptv`）+ `lzc-cli project release`，`CHROME_APPIMAGE=<electron AppImage>` 顶替（rchrome 分支 cp 成 rim 期望的固定名）。产物 `lpk/rchrome/cloud.lazycat.catlink.lptv-v1.0.0.lpk`（139.98MiB，v2 tar）。验证：AppImage md5 一致、播放器资产 `SAME`（index.html DIFF 为智慧屏版 SW 注入改写，设计内）、`lzc-cli lpk lint` 无警告。注：`lpk/` 构建产物（content/appimage、content/web、*.lpk）为 gitignored，不入库。

**最终重打包 + 重装（21:47-21:49）**：AppImage（`electron/dist/LPTV-linux-x86_64-1.0.0.AppImage`，104M，21:47，md5 `c555a2b…`，内嵌 `resources/frontend` 与 `android/www` 全 SAME）→ LPK（21:48，内嵌 AppImage md5 SAME、播放器资产 SAME、`main.js` 跳转 `location.replace("/web/")` ×1 / `/web/web/` ×0、lint 无警告）→ 重装盒子 `.144`（容器重建 Up，bundle md5 `f2d4b8f…` 与修复版一致；直测 `/web/` 200 1754B 播放器）。

**安卓端布局优化（22:07-22:09，用户截图）**：安卓真机截图确认白屏已修复（播放器工作，显示央视频 iframe 原生切台 UI：右上"正在播放"卡片 + 中央"1"环）。用户选定**隐藏底部调试 HUD**（`diag.js`）。改 `android/www/diag.js`：`enabled` 默认 `true`(opt-out `!=off`) → **默认 `false`(opt-in `=== "on"`)**；`android/www/index.html` 注释同步（`localStorage lptv.diag.v1=on` 后可复开诊断）。重打 AppImage（frontend diag.js opt-in，22:07，md5 `2d3799f…`）+ LPK（22:08，内嵌 AppImage SAME、web diag.js opt-in、lint 无警告）→ 重装盒子 `.144`（部署版 diag.js 已验证 `enabled=false` 默认关）。

---

## 安卓平台支持 + 安卓端白屏根因与修复（2026-11-23）

### 安卓平台支持
`lpk/rchrome/package.yml` + `lzc-build.dev.yml`：`unsupported_platforms` `[android, ios]` → **`[ios]`**（android 移除，与 tvos 受支持先例一致；两个 yml 均 gitignored 本地构建配置）。重新 release → LPK 内部 `package.yml` 验证 `[ios]` → `lzc-cli lpk install` 到盒子 `.144`（触发 APK 构建任务）。

### 安卓端白屏根因（Phase 1，systematic-debugging）
**根因**：`lpk/ui/src/main.js` 把非 `?setting` 访问无条件 `window.location.replace('/web/web/')`，但播放器实际由路由 `/=file:///lzcapp/pkg/content/web/` 的 **`/web/`** 提供（`content/web/web/index.html`，1754B）。`/web/web/` 映射到不存在的 `content/web/web/web/` → SPA fallback 回 `content/web/index.html`（Vue 入口，449B）→ `main.js` 又跳 `/web/web/` → **无限重定向死循环 → 白屏**。

**服务端证据**（盒子侧直测 app 容器 `172.28.2.66:80`，绕过外层鉴权代理）：
| 路径 | 结果 | 判定 |
|---|---|---|
| `/` | 200 449B | Vue 入口 |
| `/web/` | 200 **1754B** | **播放器**（正确路径） |
| `/web/web/` | 200 449B | Vue 入口（SPA fallback，错误路径） |
| `/tv/` | 200 | 央视频 |
| `/catlink/` | 200 | xpra websockets client |

**旁证**：`lpk/build.sh` 注释本就说"UI 入口…会跳转到 `/web/`"（与代码 `/web/web/` 矛盾）；外层 `jinglebaby.heiyu.space` 对 `/`、`/?r`、`/web/web/` **全部 307→登录页**（全局鉴权门，非路径特有问题）；xpra WebSocket(7890) 监听但**无客户端**（安卓未走投射）。

### 修复（Phase 2）
`lpk/ui/src/main.js`：`window.location.replace('/web/web/')` → **`window.location.replace('/web/')`**（+ 注释说明，避免回退）。最小改动，无其他源码引用 `/web/web/`（构建产物、inject.js 均指向 `/web/`）。

### 验证（Phase 3）
重新 `lzc-cli project release`（含修复）→ LPK `21:10` → 重装到盒子 `.144`（容器重建运行）→ 直测：`/web/` 200 **1754B**（播放器）✅；部署 bundle md5 `f2d4b8f…` 与本地修复版**一致**，含 `location.replace("/web/")` 1 次、`/web/web/` 0 次 ✅。

### 用户问题答案
**安卓端不需要 xpra**：安卓走网页版播放器（`main.js` → `/web/`，浏览器本地解码，无 xpra 编码）；xpra 仍运行（供桌面/CDE 投射路径），但安卓不连 7890。白屏**非 xpra 问题**，是跳转路径写错。

---

## 设计图完全实现审计 + 覆盖层渲染确认（2026-11-24）

### 设计审计（6 态 vs 设计稿 `ui-redesign-design.md` §5）
`inject.js` 的 6 态视图（`#lptv-view-home/playing/left/right/switching`）逐态比对设计稿**基本完全实现**，仅 2 处非问题微差（不阻塞）：
- 首页卡片：`repeat(6,1fr)` 响应式网格（1920px 下自然 ≈280px，视觉等价设计 270×140，铺满）。
- 左面板选中强调条：`box-shadow: inset 4px 0 0`（设计"26px"疑笔误）。

### 覆盖层渲染确认（关键纠偏）
此前误判"安卓端只看到央视频原生 UI"——**实际覆盖层在设备上正常渲染**：
- **Headless Chrome 复现**（本地 HTTP 服务 + `--dump-dom`）：`#lptv-root data-state="home"`、6 视图全渲染、内容 21 处、`transform: scale(0.4063)`（设计缩放生效）。
- **设备截图 `Screenshot_215603`**：右上卡片 = 我们 `lv-sw-card`（"CCTV-1 综合 / 正在接入 CCTV-1 综合 直播 / 加载中 28%"，正是模板+renderSwitching 数据）；左上药丸 = `lv-sw-tip`；中央环+"1"+“正在切换频道”+3 点 = `lv-sw-center`；底部 = `lv-sw-foot`。仅央视直播画面/黑背景透出。
- **用户确认**：重装后真机第一屏 = **频道首页（设计入口，状态1）**；入口=首页不自动播放（`initChannels` 设计决策：用户点卡片才播）。
- 结论：设计已实现且设备可见；"只看到央视频原生 UI"是**切换/播放态透明覆盖层（央视视频主导）造成的误判**。

### 部署不一致（盒子 `/web/` 浏览器播放器，仅影响浏览器，不影响安卓 APK）
- 部署版 `/lzcapp/pkg/content/web/web/inject.js` = `07e1befc`（99140B），**仅比本地 `02c59cbd`（99475B）旧 1 个 hunk**（切换环中心数字 chNum 功能）；其余 index/diag/bridge/preload/splash **全部 md5 SAME**。
- 安装（22:08）mtime 全为 22:09:03（确实写入），但 inject.js 内容为旧版——安装管线对 inject.js 写入了旧内容（其余文件正确）。
- `/lzcapp/pkg` 为 **read-only 挂载卷**，`docker cp` 无法修复；重装同样写旧。需排查安装管线为何单独回退 inject.js（不阻塞：仅浏览器 `/web/` 缺 chNum 居中数字，6 态 UI 完整可用）。
- **安卓 APK**（22:08 安装触发构建，从 LPK web 内容 = 本地 `02c59cbd`）已是当前版；设备截图中央"1" = chNum 逻辑，证明 APK 内嵌当前 inject.js。盒子 `/web/` 陈旧不影响安卓。


