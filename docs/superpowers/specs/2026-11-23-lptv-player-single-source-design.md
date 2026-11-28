# LPTV 播放器资产收敛到单一源 `android/www/`（B2）— 设计

日期：2026-11-23
状态：待批准（用户已选 B2）

## 意图

消除 `frontend/` 与 `android/www/` 之间对 **inject.js / splash.js / icon.png / lptv.png** 的重复拷贝，让这套共享播放器代码只有**一个授权源**。`frontend/` 现无任何独有文件（4 个全在 `android/www/` 且已字节一致），删除后仓库不再有两份可漂移的拷贝；Electron 本地桌面后备改为复用 `android/www/`。智慧屏 / CDE / 移动端 / APK / Electron 后备从此字面同一份播放器代码。

背景：智慧屏+CDE 已统一走 `/web/web/`（源 = `android/www/` → `lpk/build.sh` → `content/web/web/`）。唯一残留的“两套代码”是 `frontend/`（Electron 桌面后备加载）与 `android/www/`（web/移动/APK）对共享文件的镜像拷贝——本次已发现 `splash.js` 漂移（`frontend/` 有智慧屏专用逻辑，`android/www/` 是旧版），即“两份拷贝”的维护风险。

## 目标

1. `android/www/` 成为 inject.js/splash.js/icon.png/lptv.png 的**唯一授权源**。
2. 删除 `frontend/`（无独有文件，不丢任何内容）。
3. Electron 本地桌面后备改从 `android/www/` 读取上述文件，行为不变。
4. 全链路生成脚本（`android/build.sh`、`lpk/build.sh`）与打包配置（`electron/package.json` extraResources）指向新源。
5. 镜像约束更新为“`android/www/` 为源，`content/web/web/` 由 `lpk/build.sh` 生成且与之字节一致”。

## 关键前提（builder check Q1，必须纳入）

`android/www/splash.js` 的**智慧屏同步尚未提交**——它是本会话里 `cp frontend/splash.js android/www/splash.js` 产生的**未提交工作区改动**（+26 行：`MAX_MS_SMART`/`isSmartScreen()`/计时兜底 22s→6s）。HEAD 上 `android/www/splash.js` 仍是旧版（无智慧屏逻辑）。**“删除 frontend/ 不丢内容”仅在 `android/www/splash.js` 先落为智慧屏版时才成立。**

- **实现顺序硬约束**：本次变更必须把 `android/www/splash.js` 的智慧屏同步**连同删除 frontend/ 一并 `git add` 提交**；否则提交后的树永久丢失智慧屏 splash 逻辑（frontend/splash.js 被删、android/www/splash.js 回退到 HEAD 旧版）。
- 该逻辑在 `/web/web/` 浏览器路径下是惰性的（`isSmartScreen()` 因无 `__LPTV_ENV`/`__LPTV_IS_CONTAINER` 恒 false），故并入共享 splash.js 无行为副作用；Electron 路径保留其原有智慧屏行为。

## 非目标 / 反目标

- 不删除 `android/`（用户已决定保留；仅删 `frontend/`）。
- 不改 `electron/main.js` 的启动/编码/窗口逻辑（仅改资源路径解析）。
- 不改播放器行为、不改 inject.js/splash.js 内容本身。
- 不把 web 独有资产（bridge.js/index.html/preload.js/diag.js/channels.json/logos）搬出 `android/www/`——它们本就在那，无需动。

## 约束

- 打包后 Electron 资源路径 `resourcesPath/frontend` 保持**不变**（`extraResources` 的 `to` 仍为 `frontend`，仅 `from` 改为 `../android/www`），这样 `frontendDir()` 打包分支、`tools/box-diag.sh` 哨兵（`resources/frontend/inject.js`）、`lpk/content/launch_chrome.sh` 哨兵（`resources/frontend/inject.js`）**全部无需改动**。
- `android/www/logos/`（59 个 webp）随 `extraResources` `../android/www`→`frontend` 一并打包到 `resourcesPath/frontend/logos`，供 Electron `get_asset_image('logos')` 使用。
- 开发态路径 `frontendDir()` 由 `../frontend` 改为 `../android/www`（`__dirname`=`electron/`，即仓库 `android/www`）。

## 方案（用户已选 B2：`android/www/` 为唯一源，删 `frontend/`）

### 改动清单

1. **`electron/main.js`**
   - `frontendDir()`（L99-102）：开发态分支 `return path.join(__dirname, '..', 'android', 'www')`；打包态 `resourcesPath/frontend` 不变。
   - `get_asset_image` logos 解析（L1158）：`path.join(path.dirname(assetFile('icon.png')), '..', 'logos', name)` → `path.join(frontendDir(), 'logos', name)`。
     - 开发态：`android/www/logos/<name>`（存在，59 文件）；打包态：`resourcesPath/frontend/logos/<name>`（随 extraResources 打包）。
2. **`electron/preload.js`**（L105-107）：开发态 `return path.join(__dirname, '..', 'android', 'www')`；打包态 `resourcesPath/frontend` 不变。读取的 `icon.png`、`splash.js` 均在。
3. **`electron/package.json`**（extraResources L40-41）：`"from": "../frontend"` → `"from": "../android/www"`；`"to": "frontend"`、`filter: ["**/*"]` 不变。
4. **`android/build.sh`**（L33-36）：删除 4 行 `cp "$ROOT/frontend/{inject.js,splash.js,lptv.png,icon.png}" "$WWW_DIR/"`。保留 `cp electron/channels.json` 与 `logos/` 拷贝（这两处仍是 `android/www/` 的刷新源，不属本次重复）。
5. **`android/apply_tv.sh`**（L92）：`SRC_ICON="$HERE/../frontend/icon.png"` → `"$HERE/../android/www/icon.png"`；同步更新 L91/L112/L115 的注释与 echo 文案（`frontend/icon.png` → `android/www/icon.png`，Q3）。
6. **`electron/main.js`** L10 注释：`frontend/inject.js` → `android/www/inject.js`（Q3，纯文案）。
7. **`README.md`**（L8、L54、L55）：`frontend/icon.png`→`android/www/icon.png`；`frontend/inject.js`→`android/www/inject.js`；`frontend/splash.js`→`android/www/splash.js`。
8. **`android/www/splash.js`**：将本会话已同步的智慧屏版（= `frontend/splash.js`）**一并 `git add` 提交**（Q1 关键前提，见上）。
9. **删除 `frontend/`**（`git rm`）：`inject.js`、`splash.js`、`icon.png`、`lptv.png`（全部已存在于 `android/www/` 且字节一致，删除不丢内容——前提是第 8 条先落）。

### 我的调用（builder check Q2/Q4，标记为设计者决定）

- **Q2**：`electron/package.json` 的独立 `../logos`→`logos` extraResources 条目**保留**（改动后 main.js:1158 改读 `frontendDir()/logos`=打包态 `resourcesPath/frontend/logos`，原 `resourcesPath/logos` 不再被代码消费，成无害死重）。保留以最小化 churn 并规避打包回归风险；不删。
- **Q4**：历史 plan/spec 文档（mode-separation / web-player-unify / smartscreen-fix）对 `frontend/` 的引用**不改**——它们记录的是当时决策，属历史记录，非本次范围。

### 不改

- `tools/box-diag.sh`、`lpk/content/launch_chrome.sh`：检查 `resources/frontend/inject.js`，打包输出目录仍为 `frontend`，无需改。
- `lpk/build.sh`：`cp -r ../android/www/. → content/web/web/` 不变（android/www 现为唯一源，链路自然正确）。
- `electron/main.js` 启动/编码/窗口逻辑、`lpk/content/90_lzc.conf`、`run.sh`。
- `android/www/` 除 splash.js 智慧屏同步（第 8 条，关键前提）外，其余内容不动。

## 风险与验证

1. **Electron 开发态资源路径**：`frontendDir()` 开发分支改 `../android/www`。验证 `node --check electron/main.js electron/preload.js` 通过；本地桌面启动 Electron 看注入/图标/台标正常。
2. **打包路径**：`extraResources from ../android/www`。验证产物 `resources/frontend/{inject.js,splash.js,icon.png,logos/*}` 存在（`tools/box-diag.sh` 哨兵即测）。
3. **logos 解析**：L1158 改 `frontendDir()/logos`。验证 `get_asset_image('logos', <pid>)` 在开发与打包态都返回台标（`android/www/logos` 存在；打包态随 extraResources 拷入）。
4. **`android/www/` 完整性**：删除 `frontend/` 后，`cmp` 校验 `android/www/inject.js` 与 `content/web/web/inject.js`（生成物）一致。
5. **回归**：本地桌面 Electron 不回归（注入/窗口按钮/顶栏照常，`__lptvBridge` 为 false）；`/web/web/` 智慧屏+CDE+移动端不回归。

## 交接给实现者的决定

- 打包输出目录保持 `frontend`（`resourcesPath/frontend` 不变），仅源改为 `android/www`——最小 churn，哨兵脚本零改动。
- 删除 `frontend/` 用 `git rm`（入 git），不留空目录。
- 不改 inject.js/splash.js 内容（避免行为变化；仅在需要时通过 `android/www/` 编辑，再由 `lpk/build.sh` 生成 `/web/web/`）。
- 同步更新当前计划文档中的镜像约束表述（`frontend/` 已不存在，源为 `android/www/`）。
