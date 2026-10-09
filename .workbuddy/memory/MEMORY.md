# LPTV 项目长期记忆

## 项目本质
复刻 pytv（Windows pywebview 桌面客户端）的「**寄生式取流**」逻辑：
加载官方 `www.yangshipin.cn/tv/home?pid=<pid>`，注入 `inject.js`，
Hook `XHR/fetch` 抓 `get_live_info` → `data.playurl`，Hook `Hls.prototype.loadSource` 锁画质，
换台 = 点官方侧栏 `.tv-main-con-r-list-left > div`（按频道名归一化匹配）+ 4s 兜底。
**不要尝试自己取流/自己解密** —— 官方有 CMG 私有解密，复用官方 Hls 实例才稳。

## 仓库结构（2026-10-09 重组后）
仓库**只保留 KasmVNC 桌面版一条线**（早期 Web 版已整体删除，git 历史 26f6537 可回溯）：
- `app/` = 应用共享**真源**：`inject.js`（前端注入层）、`channels.json`（频道库，唯一真源）。
- `lzc/` = LPK 工程：manifest/build 配置/`build.sh`/`images/`（Docker 上下文）。
- `lzc/images/app/{channels.json, asset/, extension/inject.js}` 是 `build.sh` **生成的构建产物**，已 gitignore，勿手改。
- `pytv/` = 原始 Windows 样本，仅作逆向参考，已 gitignore。

早期 Web 版做法（已弃用，仅存档于 git 历史）：Express + Playwright 取 playurl + hlsProxy 同源化，
供"直连 HLS 更省资源"的场景参考。


## 关键事实（实测/核实）
- 官方站 CSP **只有 `frame-ancestors 'self'`**，无 `script-src`/`connect-src` → 主世界可直连 `127.0.0.1:8090`。
- `http://127.0.0.1` 在 Chrome 里是可信来源 → https 页 fetch 它不算混合内容。
- inject.js 的桥接口 = `window.pywebview.api.*`；EPG 走 `window.__LPTV_API_BASE + /api/epg/raw?pid=&ymd=`。
- 频道表 `app/channels.json` 是唯一真源（`official` 字段必须与官方侧栏文案一致）；
  CCTV-1 与 CCTV-14 的 cnlid 重复（均 2024078201），以 **pid** 为主键。
  inject.js 运行时还会用 `normChName()` 自愈 `official`，所以该字段只是引导值。
- `lzc-cli` 的 `buildscript` **先于** `images` 构建执行 → 可在脚本里往 `images/` 暂存文件。
- 懒猫 manifest：`application.depends_on` 已弃用（routes 自动健康检查）；
  GUI 应用走 `template/gui-vnc`：`routes: /=http://desktop:6901/` + `services.desktop.image: embed:app-runtime`。

## 约定
- 懒猫 LPK 目录固定 `lzc/`；开发态 `lzc-build.dev.yml` 覆盖 package id 为 `.dev`。
  **dev 配置是浅合并到 `lzc-build.yml`**（`{...base, ...top}`），只需写要覆盖的字段。
- 容器内桥服务**零依赖**（只用 node 内置模块，不 npm install）；文件名用 `.cjs`（避免 `type:module` 陷阱）。
- KasmVNC 是**画面流**（24–30fps 上限、0.6–0.8 核/路），`kasmvnc.yaml` 必须按"视频优先"配，
  不要用官方模板的"画质优先"默认值（那会强制全帧 + 关压缩）。
- **换行必须 LF**：`.gitattributes` 已强制 `* text=auto eol=lf`。本机全局 `core.autocrlf=true`，
  若哪天 .gitattributes 丢了，`.sh`/`Dockerfile` 会被检出成 CRLF 而**在容器里跑不起来**。
  校验换行要用字节级 `tr -cd '\r' | wc -c`，不要信 `git ls-files --eol`（有 stat 缓存）或 grep。

## 校验习惯
- YAML 必须用 **YAML 1.2** 解析器校验（`js-yaml`，lzc-cli 自带），否则 `on:` 会被当布尔。
- 提交前跑 `lzc-cli project lint .`，要求 **0 警告**。
