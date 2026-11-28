# LPTV 播放器资产单源收敛（B2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把播放器共享资产（inject.js/splash.js/icon.png/lptv.png）的重复拷贝收敛到唯一源 `android/www/`，删除 `frontend/`，Electron 后备改从 `android/www/` 读取，全链路构建/打包指向新源。

**Architecture:** `android/www/` 已是智慧屏/CDE/移动端/APK 的 `/web/web/` 播放器源（`lpk/build.sh` 从它生成 `content/web/web/`）。本次把 Electron 本地桌面后备的资源路径从 `../frontend` 改到 `../android/www`（打包态输出目录保持 `resourcesPath/frontend` 不变），并删除无独有文件的 `frontend/`，使 5 条链路（智慧屏/CDE/移动端/APK/Electron）字面同一份播放器资产。

**Tech Stack:** Electron（main/preload）、Capacitor/Android（www + build.sh）、Vue/Vite（lpk/ui）；无单测框架，用 `node --check` / `cmp` / `grep` 验证。

**Spec:** `docs/superpowers/specs/2026-11-23-lptv-player-single-source-design.md`

## Global Constraints

- 打包后 Electron 资源路径 `resourcesPath/frontend` **保持不变**（`electron/package.json` extraResources 的 `to` 仍为 `frontend`，仅 `from` 改为 `../android/www`）——这样 `tools/box-diag.sh` 与 `lpk/content/launch_chrome.sh` 的 `resources/frontend/inject.js` 哨兵零改动。
- `android/www/splash.js` 的**智慧屏同步必须提交**（Q1 关键前提）：它当前是未提交工作区改动（HEAD 为旧版）。删除 `frontend/` 前必须先把 `android/www/splash.js` 提交为智慧屏版，否则提交后永久丢失智慧屏 splash 逻辑。
- 删除 `frontend/` 前确认其 4 文件（inject.js/splash.js/icon.png/lptv.png）与 `android/www/` 对应文件**字节一致**（`cmp -s`）。
- 不改 inject.js/splash.js 内容、不改 electron 启动/编码/窗口逻辑、不改 `lpk/content/90_lzc.conf`/`run.sh`。
- 执行于当前分支（`main`）；本次改动**产生真实 git 提交**（electron/、android/、frontend/、README 均 tracked）。

## Review Focus

- **Electron 打包态路径**：打包后 `resourcesPath/frontend`（哨兵 `tools/box-diag.sh` 测 `resources/frontend/inject.js`）仍成立 → extraResources `to: frontend` 不变即保证。
- **Electron 开发态路径**：`frontendDir()`/preload 开发分支改 `../android/www` → 本地 `npx electron .` 能读到 inject.js/splash.js/icon.png。
- **logos 解析**：`get_asset_image('logos', pid)` 改 `frontendDir()/logos` → 开发态 `android/www/logos`、打包态 `resourcesPath/frontend/logos`（随 `../android/www` 连带打包）都命中。
- **删除后镜像一致**：`android/www/{inject.js,splash.js}` 与生成物 `lpk/content/web/web/{inject.js,splash.js}` 字节一致（`cmp -s`）。
- **`frontend/` 全消**：`grep -rn frontend/`（排除历史文档/历史 plan/spec）不再命中功能路径。

---

### Task 1: Electron 资源路径改从 `android/www` 读取

**Files:**
- Modify: `electron/main.js:99-104`（`frontendDir()` 开发态）、`electron/main.js:1157-1158`（logos 解析）、`electron/main.js:10`（注释）
- Modify: `electron/preload.js:105-107`
- Modify: `electron/package.json:40-41`（extraResources `from`）

**Interfaces:**
- Consumes: 无（只改路径解析）。
- Produces: Electron 开发/打包态均从 `android/www` 读取播放器资产；`frontendDir()` 仍为唯一资源入口。

- [ ] **Step 1: 改 `electron/main.js` `frontendDir()` 开发态**

将 L100-101 的开发态分支：
```js
return path.join(__dirname, '..', 'frontend');
```
改为：
```js
return path.join(__dirname, '..', 'android', 'www');
```
（打包态 `resourcesPath/frontend` 分支不变。）

- [ ] **Step 2: 改 `electron/main.js` logos 解析**

将 L1158：
```js
p = path.join(path.dirname(assetFile('icon.png')), '..', 'logos', name);
```
改为：
```js
p = path.join(frontendDir(), 'logos', name);
```

- [ ] **Step 3: 改 `electron/main.js` L10 注释**

`注入 frontend/inject.js` → `注入 android/www/inject.js`。

- [ ] **Step 4: 改 `electron/preload.js` 开发态路径**

将 L106-107 的开发态分支：
```js
return path.join(__dirname, '..', 'frontend');
```
改为：
```js
return path.join(__dirname, '..', 'android', 'www');
```
（打包态 `resourcesPath/frontend` 分支不变。）

- [ ] **Step 5: 改 `electron/package.json` extraResources**

L40-41：
```json
{ "from": "../frontend", "to": "frontend", "filter": ["**/*"] }
```
改为：
```json
{ "from": "../android/www", "to": "frontend", "filter": ["**/*"] }
```

- [ ] **Step 6: 验证**

Run: `node --check electron/main.js && node --check electron/preload.js && ! grep -rn "\.\./frontend\|'../frontend'" electron/main.js electron/preload.js electron/package.json`
Expected: 语法通过；`../frontend` 不再出现于三文件（`../android/www` 出现于 main/preload/package.json；`frontendDir(), 'logos'` 出现于 main.js）。

- [ ] **Step 7: Commit**

```bash
git add electron/main.js electron/preload.js electron/package.json
git commit -m "refactor(electron): 播放器资产改从 android/www 读取（单源）"
```

---

### Task 2: 构建/文档引用改指向 `android/www`

**Files:**
- Modify: `android/build.sh:33-36`（删 4 行 `cp frontend/*`）
- Modify: `android/apply_tv.sh:91-92,112,115`（图标源 + 文案）
- Modify: `README.md:8,54,55`

**Interfaces:**
- Consumes: Task 1 已把 Electron 指向 `android/www`。
- Produces: 构建/文档不再引用 `frontend/`；`android/www` 为唯一源。

- [ ] **Step 1: 删 `android/build.sh` 的 4 行 `cp frontend/*`**

删除：
```bash
cp "$ROOT/frontend/inject.js"   "$WWW_DIR/"
cp "$ROOT/frontend/splash.js"   "$WWW_DIR/"
cp "$ROOT/frontend/lptv.png"    "$WWW_DIR/"
cp "$ROOT/frontend/icon.png"    "$WWW_DIR/"
```
保留其后的 `cp "$ROOT/electron/channels.json"` 与 `[ -d "$ROOT/logos" ] && cp -r "$ROOT/logos"`。

- [ ] **Step 2: 改 `android/apply_tv.sh` 图标源与文案**

L92：`SRC_ICON="$HERE/../frontend/icon.png"` → `SRC_ICON="$HERE/../android/www/icon.png"`。
L91 注释、L112/L115 echo：`frontend/icon.png` → `android/www/icon.png`。

- [ ] **Step 3: 改 `README.md`**

L8：`src="frontend/icon.png"` → `src="android/www/icon.png"`。
L54：`` `frontend/inject.js` `` → `` `android/www/inject.js` ``。
L55：`` `frontend/splash.js` `` → `` `android/www/splash.js` ``。

- [ ] **Step 4: 验证**

Run: `! grep -n "frontend/" android/build.sh android/apply_tv.sh README.md`
Expected: 三文件无 `frontend/` 残留。

- [ ] **Step 5: Commit**

```bash
git add android/build.sh android/apply_tv.sh README.md
git commit -m "refactor: android/www 为播放器唯一源，构建/文档改指向它"
```

---

### Task 3: 提交 splash 智慧屏同步 + 删除 `frontend/`

**Files:**
- Modify: `android/www/splash.js`（智慧屏同步，当前为未提交改动）
- Delete: `frontend/inject.js`、`frontend/splash.js`、`frontend/icon.png`、`frontend/lptv.png`

**Interfaces:**
- Consumes: Task 1-2 已让所有消费者指向 `android/www`。
- Produces: `android/www/` 为唯一授权源；`frontend/` 消失；镜像约束 = `android/www/*` 与 `lpk/content/web/web/*` 字节一致。

- [ ] **Step 1: 提交 `android/www/splash.js` 智慧屏同步（Q1 关键前提）**

先确认它已含智慧屏逻辑（`grep -q "MAX_MS_SMART" android/www/splash.js`）且与 `frontend/splash.js` 一致（`cmp -s android/www/splash.js frontend/splash.js`），然后：
```bash
git add android/www/splash.js
git commit -m "fix(lptv): 同步 android/www/splash.js 智慧屏 splash 逻辑（单源镜像）"
```

- [ ] **Step 2: 删 `frontend/` 前确认 4 文件字节一致**

Run: `for f in inject.js splash.js icon.png lptv.png; do cmp -s frontend/$f android/www/$f || echo "DIFF $f"; done; echo done`
Expected: 仅输出 `done`（无 DIFF）。

- [ ] **Step 3: 删除 `frontend/` 并提交**

```bash
git rm -r frontend
git commit -m "refactor: 删除 frontend/ 重复拷贝，播放器资产收敛到 android/www/（单源）"
```

- [ ] **Step 4: 验证单源一致 + frontend 全消**

Run:
```bash
node --check android/www/inject.js && node --check android/www/splash.js && node --check electron/main.js && node --check electron/preload.js
cmp -s android/www/inject.js lpk/content/web/web/inject.js && echo INJ_GEN_OK
cmp -s android/www/splash.js lpk/content/web/web/splash.js && echo SPLASH_GEN_OK
test ! -d frontend && echo FRONTEND_GONE
grep -rn "frontend/" --include=*.js --include=*.json --include=*.sh --include=*.yml electron android README.md | grep -v node_modules || echo NO_FRONTEND_REF
```
Expected: 语法全过；`INJ_GEN_OK`、`SPLASH_GEN_OK`、`FRONTEND_GONE`、`NO_FRONTEND_REF`（功能路径无 `frontend/` 残留）。

- [ ] **Step 5: 记录真机回归清单（人工，盒子侧）**

- [ ] 本地桌面 Electron（`npx electron .` 或 AppImage）：窗口/顶栏/台标正常，播放不回归。
- [ ] `/web/web/`（智慧屏+CDE+移动端）：入口、切台、遥控器/触摸正常，无跨域错误。
- [ ] APK 构建（`bash android/build.sh`）：`android/www/` 作为唯一源，产物完整。

---

## Self-Review

- **Spec coverage**：目标 1-5 → Task 1（Electron 读 android/www）、Task 2（构建/文档指向）、Task 3（单源提交 + 删 frontend）。Q1 关键前提 → Task 3 Step 1（先提交 splash 同步再删 frontend）。Q2（保留 ../logos）→ 无改动（Global Constraints 已述）。Q3（残留文案）→ Task 1 Step 3、Task 2 Step 2。Q4（历史文档不改）→ Global Constraints/Review Focus 已述。无遗漏。
- **Step scan**：每步单一可检查动作；Step 均为具体路径/命令 + 期望，无“TBD/酌情处理”。
- **Type consistency**：无新接口/类型；`frontendDir()` 唯一资源入口保持一致（main/preload 均用它）。
- **Review Focus**：5 条风险各有归属——打包态路径→Task 1 Step 5/6（extraResources `to` 不变）；开发态路径→Task 1 Step 1/4/6；logos→Task 1 Step 2/6；删除后镜像一致→Task 3 Step 4；frontend 全消→Task 3 Step 4。
- **Proportion**：计划约 130 行，spec 约 75 行，比例合理；代码块仅精确替换片段（签名/值已由 spec 固定），非程序转录。

## Execution Handoff

计划已保存：`docs/superpowers/plans/2026-11-23-lptv-player-single-source.md`。请审阅并选择执行方式（本次改动产生真实 git 提交，涉及 electron/、android/、frontend/、README，建议独立复核）。
