# LPTV 智慧屏 & CDE 统一到网页版 /web/web/ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智慧屏与 CDE 入口统一跳网页版播放器 `/web/web/`，播放改由浏览器本地解码，绕开 xpra 软编，两条链路都流畅清晰。

**Architecture:** 修改 `lpk/ui/src/main.js`：除 `/?setting` 外，所有客户端（智慧屏 + CDE 桌面）`location.replace('/web/web/')`，不再走 `/catlink/` 投射或 Electron。`/web/web/` 播放器（由 `android/www/` 生成，含 iframe + bridge.js `play_channel` + Service Worker `/sw.js` + `/rim/yspapi` CORS 代理）已就绪且与 `android/www/inject.js` 字节一致；仅需重建 UI 产物（`vite build`）使 `content/web/assets` 反映新的入口分流。无 inject.js 改动——网页版下 `__lptvBridge` 为真 → `IS_TOUCH` 真 → 顶栏/窗口按钮已由现有 CSS 隐藏。

**Tech Stack:** Vue 3 (lpk/ui) + Vite 构建；浏览器注入脚本（ES5，无构建）；Electron AppImage + LPK（lzc-cli）。无单测框架，用 `node --check` / `cmp` / `grep` 验证。

**Spec:** `docs/superpowers/specs/2026-11-23-lptv-web-player-unify-design.md`

## Global Constraints

- `frontend/inject.js` 与 `android/www/inject.js` 必须字节一致（`cmp -s` 通过）。
- `/web/web/` 由 `lpk/build.sh` 从 `android/www/` 复制生成；`content/web/web/inject.js` 与 `android/www/inject.js` 必须一致。
- `lpk/` 为本地目录（gitignored）：`lpk/ui/src/main.js`、`lpk/content/web/` 不入 git，改动为本地打包内容。
- `/tv/ /js/ /css/` 反代必须保持央视频原始路径（SPA 路由基址 `/`），禁止加前缀。
- 不改 `electron/main.js`、`lpk/content/90_lzc.conf`、`lpk/content/run.sh` 的启动/编码逻辑（Electron 保留为后备，本轮不动）。

## Review Focus

- **Service Worker 安全上下文**：SW 需 https 或 localhost；若 LPK 以 http 提供服务，`/sw.js` 注册失败 → 央视频接口跨域失败。真机验证时看控制台是否报 SW 注册失败/网络异常，失败则回退 `/catlink/`。
- **桌面/CDE 客户端浏览器上下文**：CDE 客户端必须能显示 `/web/web/`（当前 `/` 的 Vue UI 就在该上下文）。若桌面客户端是“仅投射、无浏览器上下文”，方案在该环境不成立，需改回原生投射 + 锁 1280×720 码流。
- **`/rim/yspapi` 代理**：容器 rim 必须实现该代理；缺失则央视频接口失败 → 黑屏。验证时看网络面板是否仍有跨域/网络错误。
- **智慧屏遥控器导航**：网页版用遥控器方向/OK；验证 inject.js 按键映射在真实智慧屏可用（当前 `/catlink/` 的 HTML5 客户端依赖 xpra 输入，网页版依赖 DOM 键盘事件，需实测）。
- **本地桌面 Electron 不回归**：`__lptvBridge` 为 false 时窗口按钮/顶栏照常；`node --check` 通过 + 本地桌面启动验证。

---

### Task 1: 入口统一跳 `/web/web/`

**Files:**
- Modify: `lpk/ui/src/main.js`

**Interfaces:**
- Consumes: 无（现有 `installRimFetchGuard`、`App.vue`）。
- Produces: 入口行为——除 `/?setting` 外一律 `location.replace('/web/web/')`。

- [ ] **Step 1: 改写 `lpk/ui/src/main.js`**

将整段（含 `Open.vue`/`isSmartScreen` 导入与 `if/else` 分流）替换为：

```js
import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { installRimFetchGuard } from './rimApi'

installRimFetchGuard()

const params = new URLSearchParams(window.location.search)

// 智慧屏与 CDE 桌面统一走网页版播放器 /web/web/（浏览器本地解码，无 xpra 编码）。
// 仅 /?setting 保留 Vue 设置页（catlink 客户端编码配置；网页版用不到但入口不破坏）。
if (!params.has('setting')) {
  window.location.replace('/web/web/')
} else {
  createApp(App).mount('#app')
}
```

（删除 `import Open from './Open.vue'`、`isSmartScreen` 检测与 `/catlink/?floating_menu=false` 分支。）

- [ ] **Step 2: 验证入口分流已改**

Run: `grep -n "/web/web/" lpk/ui/src/main.js && ! grep -n "catlink/?floating_menu" lpk/ui/src/main.js`
Expected: 输出一行 `/web/web/`；`catlink/?floating_menu` 无输出。

- [ ] **Step 3: 重建 UI 产物**

Run: `cd lpk/ui && npx vite build --emptyOutDir --outDir ../content/web/`
Expected: 构建成功，`../content/web/assets/` 时间戳更新，产物含 `/web/web/`。

- [ ] **Step 4: 验证产物已含新分流**

Run: `grep -c "location.replace(\"/web/web/\")" lpk/content/web/assets/*.js`
Expected: `>= 1`（产物包含 `/web/web/` 跳转）。

- [ ] **Step 5: Commit**

```bash
git add lpk/ui/src/main.js
git commit -m "feat(lptv): 智慧屏与CDE入口统一跳网页版播放器 /web/web/"
```
（注：`lpk/` 本地不入 git；若 `lpk/ui` 无 git 跟踪则跳过 commit，仅保留本地改动。）

---

### Task 2: 校验 `/web/web/` 播放器为最新（含 isTv/glass + SW）

**Files:**
- Verify: `lpk/content/web/web/inject.js`、`lpk/content/web/web/index.html`、`lpk/content/web/sw.js`

**Interfaces:**
- Consumes: `android/www/inject.js`（Global Constraints 镜像）。
- Produces: 确认网页版播放器就绪（无需改动）。

- [ ] **Step 1: 校验播放器副本与镜像一致**

Run: `cmp -s lpk/content/web/web/inject.js android/www/inject.js && grep -c "function isTv" lpk/content/web/web/inject.js`
Expected: 命令成功且输出 `1`。

- [ ] **Step 2: 校验 SW / 同源反代已注入**

Run: `grep -c "serviceWorker" lpk/content/web/web/index.html && grep -c "yspapi" lpk/content/web/sw.js`
Expected: 两者均 `>= 1`。

- [ ] **Step 3: 校验 /web/web/ 路由可及（manifest）**

Run: `grep -n "/tv/=https://www.yangshipin.cn/tv/" lpk/rchrome/lzc-manifest.yml && grep -n "rim/=http://cde:8888/" lpk/rchrome/lzc-manifest.yml`
Expected: 各输出一行。

- [ ] **Step 4: 若任一校验失败，重新生成播放器**

Run: `cd lpk && bash build.sh`（从 `android/www/` 复制到 `content/web/web/` 并注入 SW/隐私弹窗脚本）
Expected: 重新生成后 Step 1-3 通过。

（此任务无代码改动，仅校验；通过后无需 commit。）

---

### Task 3: 双镜像 + 语法 + 引用一致性校验

**Files:**
- Verify: `frontend/inject.js`、`android/www/inject.js`

**Interfaces:**
- Consumes: 无改动；确认现有镜像未破坏。
- Produces: 一致性证明。

- [ ] **Step 1: 字节一致校验**

Run: `cmp -s frontend/inject.js android/www/inject.js && echo MIRROR_OK`
Expected: `MIRROR_OK`。

- [ ] **Step 2: 语法校验（受影响的 JS）**

Run: `node --check frontend/inject.js && node --check android/www/inject.js`
Expected: 无输出（exit 0）。

- [ ] **Step 3: 本地桌面 Electron 不回归（窗口按钮保留）**

Run: `grep -c "lptv-tb-btns" frontend/inject.js`
Expected: `>= 2`（选择器与渲染点仍在；`__lptvBridge` 为 false 时顶栏照常显示）。

- [ ] **Step 4: 真机验证清单（人工，盒子侧）**

- [ ] 智慧屏打开 LPK → 直接进入 `/web/web/`，无 `/catlink/` 工具条。
- [ ] 智慧屏频道切换正常（`play_channel` 路径，无黑屏/无跨域网络错误）。
- [ ] 智慧屏遥控器方向/OK 可导航控制栏、频道面板。
- [ ] CDE 桌面客户端打开 LPK → 显示 `/web/web/` 网页播放器，画面流畅清晰、无 xpra 卡顿。
- [ ] 安卓端装懒猫微服，在其中打开懒猫微视 → `/web/web/` 进入触摸模式（`IS_TOUCH`/`TOUCH` 为真）：桌面顶栏隐藏、底部控制栏 `#lptv-controls` 可用、右缘轻扫/tap 开频道抽屉、左缘开 EPG、点画面切换控制栏。
- [ ] 移动端切台正常（`play_channel` 路径），且无跨域/网络错误（验证 `/rim/yspapi` + `/sw.js` 在 http 非 localhost 下是否仍工作——若 SW 注册失败则回退并上报）。
- [ ] 本地桌面 Electron（`__lptvBridge` 未定义）窗口按钮/顶栏照常，播放不回归。

（真机验证结果记入 PR 描述；无法自动化，仅列清单。）

---

## Self-Review

- **Spec coverage**：设计目标 1（智慧屏入口）→ Task 1；目标 2（CDE 入口）→ Task 1；目标 3（本地解码链路，已有播放器）→ Task 2 校验；目标 4（isTv 行为一致）→ 无代码改动，已由现有 `isTv()`/`play_channel` 满足，Task 2 校验。无遗漏。
- **Step scan**：每步单一可检查动作；Task 1 Step 1 为“替换整段”的明确动作（spec 已定），Step 3 构建为命令+期望。
- **Type consistency**：无新接口/类型。
- **Review Focus**：5 条风险均有归属——SW 上下文/桌面浏览器上下文/yspapi → Task 3 Step 4 真机清单；遥控器 → Task 3 Step 4；Electron 不回归 → Task 3 Step 3。
- **Proportion**：计划 ≈ 100 行，spec ≈ 60 行，比例合理；无冗余代码块。

## Execution Handoff

计划已保存：`docs/superpowers/plans/2026-11-23-lptv-web-player-unify.md`。请审阅并选择执行方式。
