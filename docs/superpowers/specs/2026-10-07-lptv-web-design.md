# LX TV Web 版设计文档

## 概述

将 pytv（Python + pywebview 桌面客户端）复刻为 Web 版本。核心原则：**保留 inject.js 全部前端逻辑，仅替换 pywebview 桥接层为 HTTP REST API**，其他功能从 Python 迁移到 Node.js。

---

## 关键技术事实（决定架构）

1. **寄生式取流**：原应用不调取流接口，靠 hook `window.Hls.prototype.loadSource` 截获 m3u8 地址。这是可靠的方式——官方 Hls 实例自带完整鉴权和解密。
2. **换台 = 点击官方侧栏按钮**：`.tv-main-con-r-list-left > div`，元素上有真实 `data-pid` 属性。不是直接跳转 URL。
3. **官方 `<video>` 被 inject 强制 `position:fixed` 铺满视口**。
4. **EPG 端点**：`https://capi.yangshipin.cn/api/yspepg/program/{pid}/{yyyyMMdd}`，响应是 protobuf（field 1=id, 2=name, 5=start, 6=end，varint field 3=秒级起点），前端手搓 varint 解码。
5. **频道表坑**：CCTV-1 与 CCTV-14 的 cnlid 重复（均为 2024078201），导出 JSON 时需处理。
6. **桌面版约 40% 能力依赖 Win32**（置顶/全屏去边框/浮窗/拖拽/注册表自启），浏览器替身方案：PiP ≈ SetWindowPos TOPMOST；Fullscreen API ≈ DWM 去边框；Wake Lock ≈ 防息屏；开机自启无替代，改用「记住 lastPid 打开即续播」。
7. **录/截前提**：视频流必须同源化。改写 m3u8 的分片与 `EXT-X-KEY` 走 `/seg/?u=` 代理，否则 canvas 被污染，`toDataURL`/`drawImage` 抛 SecurityError。

---

## 完整执行流程（寄生式）

```
① 服务端加载 https://www.yangshipin.cn/tv/home?pid=<pid>（Playwright 有头浏览器）
② 官方 JS 启动 → new Hls().loadSource("https://xxx/…/index.m3u8?auth…")
③ inject 的 hook 已提前替换 loadSource → 拿到 m3u8 绝对 URL → Lx.playUrl
④ inject 找到页面上最后一个/最大的 <video> → styleOfficial() 铺满 100vw/100vh
⑤ 换台：switchChannel(pid) → 找 OfficialNameOf(pid) 对应的侧栏 div → .click()
⑥ 4s 兜底：若 Lx.playUrl 仍为空，用自愈后的真实 pid 再点一次
⑦ 黑帧看门狗：像素采样(avg/sd) 连续偏黑 → recoverBlack() → 重新 play + switchChannel
```

---

## 桌面→Web 控件映射表

| 桌面功能 | Win32/pywebview | Web 替身 | 实现方式 |
|---|---|---|---|
| 窗口置顶 | SetWindowPos TOPMOST | Picture-in-Picture | `video.requestPictureInPicture()` |
| 小浮窗 | 浮窗模式 | PiP + 页内 `<div class="mini-float">` | pointer events 拖拽 + 位置存 store |
| 真全屏去白边 | _dwm_fullscreen_frame 关 DWM 非客户区 | Fullscreen API | `container.requestFullscreen()` |
| 普通最大化（保留任务栏） | Win32 rcWork | CSS | `width:100vw; height:100vh`（窗口内 vs fullscreen） |
| 顶栏拖拽 drag_win | SC_MOVE + HTCAPTION | 仅对页内浮层/EPG 面板有意义 | pointerdown + setPointerCapture 手写拖拽 |
| 右下角缩放柄 resize_win | Win32 | CSS 变量 | `--ui-scale` 提供 S/M/L/全屏-fit 预设 |
| 开机自启 | 注册表 Run | 无对应能力 | 替代：①服务端记住 lastPid，打开即续播上次频道；②懒猫 App 本身常驻，点开即用 |
| UI 状态持久化 | LOCALAPPDATA/LX TV | localStorage 够用（网页环境天然跨"启动"持久化）；跨设备 → /api/state 或云数据库 |
| 截图 shot_save | canvas.toDataURL → python 写 PNG | 同源化后：canvas.toBlob() → a[download] 直接下载；架构 C：POST 到服务端落 /lzcapp/var/shot |
| 录制 rec_open/append/close | 前端 webm 分块 → python 拼接 | 前端：video.captureStream() + MediaRecorder → Blob → a[download] / 分片 POST；后端：ffmpeg -c copy 直录（推荐，可后台、可定时） |
| 复制 m3u8 copy_m3u8 | 取该 Lx.playUrl | 同源方案下 URL 已在我们手里 → navigator.clipboard.writeText() |
| 20s 黑帧看门狗 | 像素采样(avg/sd) | requestVideoFrameCallback 判 ①帧是否在推进 ②currentTime 是否单调；再叠 16×16 canvas 采样判纯色 |
| 频道列表 | 内置 59 台 + 官方侧栏收割 data-pid | channels.json（内置兜底）+ 运行时收割（动态补充）双轨 |
| EPG | 直连 capi（跨子域） | 走 /epg/ 反代（否则必被 CORS 拦），仍然用 protobuf 解析 |
| 清晰度 applyMaxQuality | 锁最高 level，每 500ms 多敲几次防回落 | hls.js 内部，完全照搬 + 增加 UI 手选 |

---

## 架构总览

```
浏览器（任意现代浏览器）
  │
  ├── 加载 /index.html + adapter.js + inject.js
  │
  ├── 播放: GET /api/manifest?pid=xxx  → 返回改写后的 m3u8（同源）
  │         GET /api/seg/?u=<base64_url> → 代理 TS 分片（同源 + 可选解密）
  │
  ├── fetch('/api/channels')              → 频道列表
  ├── fetch('/api/play?pid=xxx')          → 捕获的 playUrl（JSON）
  ├── fetch('/api/epg?...')               → 节目单 JSON
  ├── GET/POST /api/state                 → UI 状态持久化
  ├── POST /api/shot                      → 保存截图
  ├── navigator.clipboard.writeText()     → 复制 m3u8
  └── GET /api/assets/:name               → 资源文件
          ↓
   Node.js Server (Express + Playwright)
          │
          ├── playwright.ts
          │     ├── 加载 yangshipin.cn/tv/home?pid=xxx
          │     ├── 注入 Hls hook 代码 → 捕获 window.__lxPlayUrl
          │     └── 换台时点击 .tv-main-con-r-list-left > div[data-pid="xxx"]
          │
          ├── hlsProxy.ts    ← HLS 同源化代理（录/截关键）
          │     ├── GET /api/manifest?pid= → 取 m3u8，改写分片 URL 为本服务
          │     ├── GET /api/seg/?u=     → 代理 TS 下载
          │     └── （可选）AES-128 密钥解密
          │
          ├── epgProxy.ts    ← EPG 反代（避免 CORS）
          │     └── GET /api/epg?pid=&ymd= → 服务端发 protobuf 请求，返回 JSON
          │
          ├── channels.ts    (频道数据库)
          ├── state.ts       (JSON 持久化)
          └── api.ts         (REST 路由)
          ↓
   yangshipin.cn（官方站）
     - /tv/home?pid=xxx（Playwright 加载页面）
     - Hls 实例自动加载 m3u8（Playwright 浏览器内）
     - /api/yspepg/program/{pid}/{ymd}（EPG protobuf）
```

---

## 一、前端改造范围

### 1.1 无需改动（完整保留）

- `frontend/inject.js` 全部 UI 逻辑（频道面板、节目单、设置、录制、截图等）
- CSS 样式、快捷键、触摸适配、黑帧看门狗
- MediaRecorder 录制流程（前提是流同源化）
- protobuf EPG 解析函数

### 1.2 前端适配层（adapter.js）

inject.js 中所有 `window.pywebview.api.xxx()` 调用，由 `adapter.js` 透明拦截并转换为 fetch 请求。inject.js **无需修改**。

```javascript
// adapter.js 核心逻辑（伪代码）
if (!window.pywebview) {
  window.pywebview = {
    api: {
      get_channels: () => fetch('/api/channels').then(r => r.json()),
      set_ui_state: (data) => fetch('/api/state', { method: 'POST', body: data }),
      get_ui_state: () => fetch('/api/state').then(r => r.json()),
      // ... 其他 API 映射
    }
  };
}
```

### 1.3 新增：index.html

最小外壳页面，加载 adapter.js + inject.js：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>LX TV Web</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; background: #000; }
  </style>
</head>
<body>
  <script src="/adapter.js"></script>
  <script src="/inject.js"></script>
</body>
</html>
```

---

## 二、服务端模块设计

### 2.1 server.ts — Express 主服务

- 监听端口：`3456`（可通过 `PORT` 环境变量覆盖）
- CORS 中间件：允许自定义域名跨域访问
- 健康检查：`GET /health`
- 静态文件服务：`frontend/` 目录

### 2.2 playwright.ts — 官方站浏览器代理层

**核心职责**：维护一个有登录态的 Playwright 浏览器实例，执行寄生式操作。

**寄生式取流流程**：
```
1. Playwright 加载 https://www.yangshipin.cn/tv/home?pid={pid}
2. 注入 hook 代码到页面:
   var OrigHlsLoad = window.Hls.prototype.loadSource;
   window.Hls.prototype.loadSource = function(url) {
     window.__lxPlayUrl = url;  // 捕获 m3u8 地址
     return OrigHlsLoad.call(this, url);
   };
3. 轮询 window.__lxPlayUrl 直到非空
4. 返回 m3u8 URL 给 Node.js 服务端
```

**换台操作**：
```
1. 在 Playwright 页面中执行:
   document.querySelector('.tv-main-con-r-list-left > div[data-pid="{pid}"]').click()
2. 等待 window.__lxPlayUrl 更新
3. 返回新的 m3u8 URL
```

**4s 兜底**：若 playUrl 仍为空，用自愈后的真实 pid 再点一次。

**核心方法**：

```typescript
class YangshipinBrowser {
  async getPlayUrl(pid: string): Promise<string | null>
  async switchChannel(pid: string): Promise<boolean>
  async getEpg(pid: string, ymd: string): Promise<EpgProgram[]>
  async refreshCookies(): Promise<void>
  isLoggedIn(): boolean
  async dispose(): Promise<void>
  page: Page  // 暴露 page 供 hlsProxy 使用
}
```

**Cookie 管理**：
- 存储路径：`data/cookies.json`
- 格式：Playwright 标准 `context.storageState()` 输出
- 失效处理：收到 403 时清除 Cookie 并提示用户重新登录

### 2.3 hlsProxy.ts — HLS 同源化代理（录/截关键）

**职责**：让官方 HLS 流对前端表现为"同源"，从而解除 canvas 污染限制。

**端点**：

```
GET /api/manifest?pid=xxx
  → 从 Playwright page 获取原始 m3u8
  → 将所有 #EXTINF 后的 TS 分片 URL 改写为 /api/seg/?u=<base64_url>
  → 将 #EXT-X-KEY: URI="..." 改写为 /api/seg/?u=<key_url>&type=key
  → 添加 Access-Control-Allow-Origin: * 头

GET /api/seg/?u=<base64_url>&type=ts|key
  → 通过 Playwright page 向原始 URL 发起请求（携带官方站 Cookie）
  → 转发响应（TS 分片或解密密钥）
  → 添加 CORS 头
```

**m3u8 改写逻辑**：

```typescript
function rewriteManifest(m3u8: string, originalUrl: string): string {
  // 将相对路径转换为绝对路径
  // 将 #EXTINF 行后的 URL 替换为 /api/seg/?u=<base64_encoded_url>
  // 将 #EXT-X-KEY 的 URI 替换为 /api/seg/?u=<base64_encoded_key_url>&type=key
}
```

**为什么需要这个**：pytv 的录制依赖 `canvas.drawImage(video)` 和 `MediaRecorder`，这两个操作要求 video 元素同源。如果不做同源化，Web 版的录制和截图会全部失败。

### 2.4 epgProxy.ts — EPG 反代（避免 CORS）

**职责**：服务端代理 EPG protobuf 请求，前端通过 JSON API 获取。

```typescript
// GET /api/epg?pid=xxx&ymd=xxxxxx
// 服务端用 Playwright page 请求官方 EPG API，解析 protobuf，返回 JSON
```

### 2.5 channels.ts — 频道数据库

从 `channels.py` 移植，注意 **CCTV-1 和 CCTV-14 的 cnlid 重复**（均为 2024078201），以 pid 为主键唯一标识。

```typescript
interface Channel {
  pid: string;                    // 唯一标识，如 "600001859"
  name: string;                   // 显示名称，如 "CCTV-1 综合"
  official: string;               // 官网按钮文字
  category: '央视' | 'CGTN' | '卫视' | '地方' | '其他';
  cnlid?: string;                 // 可选，用于兼容旧逻辑
}

const CHANNELS: Channel[] = [...];
export function getAllChannels(): Channel[]
export function getByPid(pid: string): Channel | undefined
export function getByCategory(category: string): Channel[]
```

### 2.6 state.ts — 状态持久化

```typescript
interface UiState {
  lastPid?: string;           // 上次播放的频道 pid（替代开机自启）
  favs?: string[];            // 收藏频道 pid 列表
  resumeLast?: boolean;       // 启动时恢复上次频道
  autoFullscreen?: boolean;   // 启动时自动全屏
  fit?: string;               // "contain" | "cover" | "fill"
  res?: Reservation[];        // 预约列表
}

interface Reservation {
  id: string;      // pid_s0
  pid: string;
  ch: string;
  name: string;
  s0: number;
  e0: number;
  made: number;
  notified?: number;
}

class StateManager {
  load(): Promise<UiState>
  save(patch: Partial<UiState>): Promise<void>
}
```

存储方式：`data/state.json`，每次写操作后 flush。

### 2.7 api.ts — REST 路由汇总

```
GET  /api/channels              → 频道列表 JSON
GET  /api/play?pid=xxx          → 流地址 { url: "..." }（寄生式捕获）
GET  /api/manifest?pid=xxx      → 改写后的同源 m3u8
GET  /api/seg/?u=<base64>       → 代理 TS 分片或密钥
GET  /api/epg?pid=xxx&ymd=...   → 节目单 JSON
POST /api/state                 → 更新状态
GET  /api/state                 → 读取状态
POST /api/shot                  → 保存截图（或前端直接下载）
GET  /api/assets/:name          → 资源文件
POST /api/cookies/refresh       → 触发 Cookie 刷新
GET  /api/health                → 健康检查（含 cookiesLoaded 状态）
```

---

## 三、录制与截图

### 3.1 录制

**方案 A（推荐）：前端 MediaRecorder**
- 前端 hls.js 播放 `/api/manifest?pid=xxx`（同源）
- MediaRecorder + canvas.captureStream() 正常工作（无 SecurityError）
- 音频：AudioContext MediaElementSource
- 下载：前端 Blob → a[download] 本地下载
- 无需服务端介入

**方案 B：服务端 ffmpeg 直录**
- 服务端用 `ffmpeg -i <playUrl> -c copy output.webm` 录制
- 支持后台录制、定时录制
- 通过 `/api/rec/open`、`/api/rec/close` 控制

### 3.2 截图

- 前端 canvas.toBlob() → a[download] 直接下载（同源化后）
- 或 POST `/api/shot` 保存到服务端 `data/shots/`

### 3.3 复制 m3u8

```javascript
navigator.clipboard.writeText(Lx.playUrl);
```

---

## 四、黑帧看门狗（Web 版增强）

原方案：20s 轮询 canvas 像素采样（avg/sd）。

Web 版增强：
```javascript
// 使用 requestVideoFrameCallback 替代 20s 轮询
video.requestVideoFrameCallback(() => {
  // ① 判帧是否在推进：currentTime 是否单调递增
  // ② 叠 16×16 canvas 采样判纯色（avg < 12）
  // 连续 N 帧偏黑 → recoverBlack()
});
```

---

## 五、登录态管理

### 5.1 分级策略

| 场景 | 行为 |
|---|---|
| 无需登录即可播放的频道 | 直接取流，全程免登录 |
| 需要登录的频道（取流失败） | 提示用户运行 Cookie 初始化 |
| Cookie 过期 | 服务端捕获 403，自动清除并提示 |

### 5.2 Cookie 初始化

```bash
# 首次运行
node scripts/init-cookies.js
# → 打开有头浏览器访问 yangshipin.cn
# → 用户手动登录（或填入 Cookie）
# → 自动保存至 data/cookies.json
```

---

## 六、部署

### 6.1 目录结构

```
/home/jingle/opc/lptv/
├── pytv/                   # 原有 Python 桌面版，不动
├── frontend/
│   ├── index.html          # 最小外壳
│   ├── adapter.js          # pywebview API → fetch 适配器
│   └── inject.js           # 复制自 pytv/frontend/inject.js（零修改）
├── server/
│   ├── server.ts           # Express 主入口
│   ├── playwright.ts       # Playwright 浏览器代理（寄生式取流）
│   ├── hlsProxy.ts         # HLS 同源化代理（m3u8 改写 + TS/KEY 代理）
│   ├── epgProxy.ts         # EPG 反代（避免 CORS）
│   ├── channels.ts         # 频道数据库（含 CCTV-1/CCTV-14 cnlid 去重）
│   ├── state.ts            # 状态持久化
│   └── api.ts              # REST 路由
├── data/
│   ├── cookies.json        # 官方站 Cookie
│   ├── state.json          # UI 状态
│   └── shots/              # 截图存储
├── scripts/
│   └── init-cookies.js     # Cookie 初始化引导
├── package.json
├── tsconfig.json
└── deploy/
    ├── nginx.conf          # nginx 反向代理配置示例
    └── caddyfile           # caddy 反向代理配置示例
```

### 6.2 反向代理（nginx 示例）

```nginx
server {
    listen 80;
    server_name tv.example.com;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 6.3 启动命令

```bash
# 安装依赖
npm install

# 初始化 Cookie（首次）
node scripts/init-cookies.js

# 启动服务
npm run dev
```

---

## 七、风险与注意事项

1. **官方 API 变更**：EPG protobuf 格式可能随官方更新而变化，需定期验证
2. **Cookie 过期**：yangshipin.cn 的登录态通常 7-30 天有效，需提供刷新机制
3. **流地址时效**：playUrl 通常有时效限制（几小时），每次切台需重新获取
4. **HLS 加密**：如果官方流使用 AES-128 加密，hlsProxy.ts 需要实现服务端解密
5. **CORS 限制**：m3u8 中可能包含跨域限制，服务端需添加 CORS 头
6. **Playwright 资源**：每个活跃频道需要一个浏览器页面，注意进程管理
7. **X-Frame-Options**：官方站可能拒绝 iframe 嵌入，本架构通过 Playwright 浏览器实例而非 iframe 解决
