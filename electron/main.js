/* ---------------------------------------------------------------------------
 * LPTV Electron 主进程
 *
 * 替代「pywebview + 真 Chrome/CDP」两包方案：Electron 官方构建带 H.264 专有
 * 编解码器（ffmpeg_branding=Chrome），YSP（H.264-over-MSE）直接能播。
 *
 * 职责（与迁移文档 electron-migration.md 对齐）：
 *   - BrowserWindow 创建（无边框 1920x1080）+ 窗口控制（原生 API）
 *   - ipcMain.handle('lptv:xxx') 实现 inject.js 桥契约（25 个方法）
 *   - did-finish-load 时注入 web/inject.js（协议层已改 window.lptv.*）
 *   - 懒猫容器无 WM：最小化/最大化退回 setBounds 模拟，浮窗/置顶/全屏用
 *     setBounds / setAlwaysOnTop / setFullScreen（不依赖 WM）
 *
 * 与旧 bridge.py 的返回值契约保持一致（inject.js 读 r.ok/r.floating/r.maximized
 * /r.pinned/r.id/r.enabled 等），保证前端零逻辑改动。
 * ------------------------------------------------------------------------- */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, screen, powerSaveBlocker, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseXpraClientInfo, classifyClient, isChromiumClient } = require('./xpra-client-info');

// ---- root 容器必须 -------------------------------------------------------
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
// 无 WM 容器下避免 Chromium 崩溃兜底
app.commandLine.appendSwitch('disable-dev-shm-usage');
// 启动即恢复上次频道自动播放：容器内无用户手势，默认策略会拒播并静音降级
// （inject.js tryPlay 捕到 reject 会强制 muted），放开后声音开播即出
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 硬件视频解码 (VAAPI)：盒子无 GPU/驱动不支持时 Chromium 自动回退软解，无副作用。
// YSP 720p H.264 软解在弱核 CPU 上是掉帧主因，打开后可显著提升流畅度。
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL');
// 视频流畅度：禁止渲染器/后台定时器节流（配合 webPreferences.backgroundThrottling=false）。
// 窗口被判定"被遮挡/隐藏"或系统判定后台时，Chromium 默认降渲染至 ~1fps 甚至暂停视频，
// xpra/浮窗模式下遮挡判定不可靠极易误触发 → 本可流畅却被节流的假卡顿。双保险。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ---- 单实例锁 -----------------------------------------------------------
// 每个「实例」独立 userData。多客户端(智慧屏/CDE)同时投射时，平台按
// application.multi_instance 起多个容器实例；但每个容器内的 xpra 显示号都是 :0，
// 若按显示号分目录 → 两个实例落到同一个 display-0 → Electron 单实例锁把后起的
// 实例直接挡掉 → 后起实例退出 → 客户端回落到已运行实例 → 表现"CDE 冲掉智慧屏"、
// 只能保留一个画面。故按「实例标识」(平台注入的 LPTV_INSTANCE_ID / 容器主机名 +
// 显示号)分目录：不同容器/不同显示各自一个 profile 与锁，两个实例才能真正同时
// 运行、同时播放，且配置相互独立。跨端状态(lastPid 等)仍走共享 DATA_DIR。
// 首次升级时把旧 profile(display-*/默认)的 Local Storage 复制过来，保留主题/音量。
try {
  let _host = '';
  try { _host = require('os').hostname() || ''; } catch (e) {}
  const _dispTag = String(process.env.DISPLAY || '0').replace(/[^0-9A-Za-z]/g, '') || '0';
  // 容器/实例唯一标识 = 主机名 + 容器网络地址 + 显示号。
  // 只按「主机名+显示号」不够：平台多实例容器共享 /lzcapp/var（userData 同一
  // 路径），且 Docker 会把 hostname 固定成 compose 服务名（两个实例都叫 cde），
  // 显示号也都是 :0 → 两个实例仍落到同一 profile → 单实例锁把后起的挡掉 →
  // 表现"CDE 冲掉智慧屏、只能保留一个画面"。各容器在网络上地址不同，用非
  // 回环 IPv4 做标签才能真正区分。地址变化时下面会从旧 profile 迁移 Local
  // Storage（主题/音量），避免设置丢失。
  let _ipTag = '';
  try {
    const nets = require('os').networkInterfaces();
    const cands = [];
    for (const name of Object.keys(nets)) {
      for (const ni of (nets[name] || [])) {
        if (ni && ni.family === 'IPv4' && !ni.internal) cands.push(ni.address);
      }
    }
    cands.sort();
    if (cands.length) _ipTag = cands[0].replace(/[^0-9A-Za-z]/g, '_');
  } catch (e) {}
  const _instRaw = process.env.LPTV_INSTANCE_ID ||
    [_host, _ipTag, _dispTag].filter(Boolean).join('-') || ('display-' + _dispTag);
  const _instTag = String(_instRaw).replace(/[^0-9A-Za-z_.-]/g, '_') || ('display-' + _dispTag);
  const _baseUD = app.getPath('userData');
  const _perUD = path.join(_baseUD, 'instance-' + _instTag);
  if (!fs.existsSync(_perUD)) {
    try {
      fs.mkdirSync(_perUD, { recursive: true });
      // 迁移来源优先级: 旧的 per-display profile → 旧默认 profile →
      // 其它已有 instance-* profile（IP 变化导致标签变化时保主题/音量）。
      const _srcs = [path.join(_baseUD, 'display-' + _dispTag), _baseUD];
      try {
        const _instDirs = fs.readdirSync(_baseUD)
          .filter((n) => /^instance-/.test(n))
          .map((n) => ({ p: path.join(_baseUD, n), t: (() => {
            try { return fs.statSync(path.join(_baseUD, n)).mtimeMs || 0; } catch (e) { return 0; }
          })() }))
          .sort((a, b) => b.t - a.t);
        for (const d of _instDirs) if (d.p !== _perUD) _srcs.push(d.p);
      } catch (e) {}
      for (const _src of _srcs) {
        const _lsSrc = path.join(_src, 'Local Storage');
        const _lsDst = path.join(_perUD, 'Local Storage');
        if (fs.existsSync(_lsSrc) && !fs.existsSync(_lsDst)) {
          fs.cpSync(_lsSrc, _lsDst, { recursive: true });
          try { fs.rmSync(path.join(_lsDst, 'leveldb', 'LOCK'), { force: true }); } catch (e) {}
          break;
        }
      }
    } catch (e) {}
  }
  app.setPath('userData', _perUD);
  console.log('[LPTV] userData=' + _perUD + ' display=' + (process.env.DISPLAY || '') +
    ' host=' + _host + ' ip=' + (_ipTag || '-'));
} catch (e) {}
// 同一实例内若被重复拉起（rim 与 xpra 各拉一次），共用同一 userData 时 Chromium
// 的 IndexedDB LOCK 只允许单写者，后启实例的渲染进程会每秒重试打开 IndexedDB 并
// 报 "LOCK: File currently in use"（实测必现，可致缓存/状态争用）。
// requestSingleInstanceLock 以 userData 目录为锁，只放行第一个实例，后续实例立即
// 退出并把窗口聚焦到已运行实例。不同实例(智慧屏/CDE)已在上面分到不同 userData，
// 因此锁不会互相挡掉，两端可同时运行。
// 注意：win 在下方以 let 声明，此回调仅在后置事件触发时引用，届时已初始化。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    } catch (e) {}
  });
}

// ---- xpra 容器判定 --------------------------------------------------------
// 同一个 AppImage 有两种运行环境：
//   1. 懒猫容器：run.sh 注入 CATLINK_APP_ID / XPRA_*，launch_lptv.sh 注入
//      LPTV_DISPLAY。窗口挂在 xpra 上（无真实 WM）。2026-11-15 fs.log 实测：
//      xpra 6.5 corral 不叠加 winOrigin，getBounds()==setBounds()，setPos 直接 x,y。
//   2. 本地桌面：真 WM，getBounds() == setBounds()，setPos 同样直接 x,y。
// 容器/本地桌面 setPos 均直接用 x,y（无 winOrigin 校准，见 setPos/winOrigin 注释）。
// 环境变量可能缺失（裸 cde 容器/手动起 xpra 不注入），再认"容器/流媒体会话"
// 独有的文件系统标记：/lzcapp（懒猫容器根）、/run/xpra/<n>/socket（xpra 会话）。
// 注意不要用 /run/catlink —— 它在懒猫宿主也存在，会误判容器，让本地桌面走
// 容器逻辑（show/drag 行为差异）。纯 Linux 桌面/宿主真实桌面无上述标记 → 判定本地。
function lazycatSignals() {
  const has = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
  if (has('/lzcapp')) return true;
  try {
    for (const n of fs.readdirSync('/run/xpra')) {
      if (/^\d+$/.test(n) && has('/run/xpra/' + n + '/socket')) return true;
    }
  } catch (e) {}
  // DISPLAY 指向 /run/xpra/<n>/socket 也说明在 cde 容器内（xpra 提供 X server）
  try {
    const disp = process.env.DISPLAY || '';
    if (disp && fs.existsSync('/run/xpra' + disp.replace(':', '') + '/socket')) return true;
  } catch (e) {}
  return false;
}
const IS_CONTAINER = !!(
  typeof process.env.CATLINK_APP_ID !== 'undefined' ||
  typeof process.env.XPRA_ENCODING_STRICT_MODE !== 'undefined' ||
  typeof process.env.XPRA_SCALING !== 'undefined' ||
  typeof process.env.LPTV_DISPLAY !== 'undefined' ||
  lazycatSignals()
);

// ---- 启动计时（点开应用→界面出现）：launch_chrome.sh 置 LPTV_START_TS(ms 时间戳)
// 并 export 给 Electron。main.js 据此记录各阶段相对耗时，[LPTV-startup] 打到容器
// 日志，供精确测量 ~20s 去向（解包/Electron/页面加载各占多少）。
const LPTV_START_TS = parseInt(process.env.LPTV_START_TS || '0', 10);
const startupLog = (label) => {
  if (LPTV_START_TS > 0) console.log('[LPTV-startup] ' + label + '=' + (Date.now() - LPTV_START_TS) + 'ms');
};

// ---- 渲染后端（Electron → X11/XDummy → xpra 捕获）-----------------
// 注意：不要强制 use-gl=egl！实测本环境（catlink :100 / cde 容器）DRI 节点存在但
// EGL 初始化崩，GPU 进程反复 exit_code=133(SIGTRAP) → 页面加载不了 → 白屏。
// "DRI 节点存在" ≠ "EGL 能工作"。交 Chromium 自动探测：能硬件则硬件，否则干净
// 回退软件合成（能渲染，仅可能卡顿）。宁可卡顿不可白屏。
function driRenderNode() {
  try {
    for (const n of fs.readdirSync('/dev/dri')) {
      if (!/^renderD/.test(n)) continue;
      try { fs.accessSync('/dev/dri/' + n, fs.constants.R_OK | fs.constants.W_OK); return '/dev/dri/' + n; } catch (e) {}
    }
  } catch (e) {}
  return null;
}
const DRI_RENDER = driRenderNode();

// ---- catlink/lightos 盒子识别 ------------------------------------------
// 本盒子 (catlink / lightos-remote-desktop / cde) DRI 节点存在但 EGL 初始化崩
// (见头注释: "DRI 节点存在 ≠ EGL 能工作... GPU 进程反复 exit_code=133 → 白屏")。
// 直启 AppImage 时无 CATLINK_APP_ID → IS_CONTAINER=false → 误走本地桌面硬件路径
// → 启动即崩、无窗口 (实测: 硬件路径必崩, 软件路径必出窗)。用 lightos/catlink
// 运行时信号 (目录 + 环境变量) 可靠识别该盒子, 与容器一致强制软件合成 (宁可卡顿
// 不可白屏)。不翻转 IS_CONTAINER: 保留本地桌面窗口行为 (1280x720 / frame:false)。
function isCatlinkBox() {
  try {
    if (fs.existsSync('/run/catlink') || fs.existsSync('/run/lightos-remote-desktop')) return true;
  } catch (e) {}
  return !!(process.env.LIGHTOS_REMOTE_DESKTOP_AUTH_USER ||
    process.env.LIGHTOS_REMOTE_DESKTOP_SESSION);
}
// CDE 桌面几何：容器 + catlink/lightos 盒子直启（IS_CONTAINER=false 但仍是远程
// 桌面，用户要求客户端内容铺满整屏）。只用于窗口/全屏几何，不改变 IS_CONTAINER
// 的 GPU/show/drag 语义。
const IS_XPRA_DESKTOP = IS_CONTAINER || isCatlinkBox();

// ---- 光标大小（CDE/xpra）-------------------------------------------------
// Xdummy/xpra 虚拟屏的 Xft.dpi 常偏高，Chromium 会按 DPI 猜出 36/48px 的 X 光标；
// 经 xpra 网页客户端投到客户端后显得特别大，热点也随之偏移（点击落点感觉不对）。
// Chromium 支持 XCURSOR_SIZE 环境变量显式指定光标像素尺寸：CDE/容器下固定 24px
// 标准光标。只影响光标本身，不改 UI/窗口缩放；本地桌面保持系统设置不动。
if (IS_XPRA_DESKTOP) {
  process.env.XCURSOR_SIZE = process.env.XCURSOR_SIZE || '24';
}

// ---- 资源路径（开发/打包兼容）------------------------------------------
function frontendDir() {
  // 打包后 extraResources 放在 resourcesPath/frontend；开发时用仓库根 web/
  if (app.isPackaged) return path.join(process.resourcesPath, 'frontend');
  return path.join(__dirname, '..', 'web');
}
function assetFile(name) { return path.join(frontendDir(), name); }

// ---- 固定 UA：与 Windows 版一致（CMG 环境判定最稳）-----------------------
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

// ---- YSP首页 ----------------------------------------------------------
// 入口固定为央视频 TV 首页（不带 pid）：官方页不会自己先播某个台。
// 是否自动播放上次频道由渲染层按设置(cfg.autoPlayOnLaunch)决定：
// 关闭（默认）→ 首页没有任何频道处于"正在播放"，用户点卡片才切台；
// 开启 → resumeFlow 用 lastPid 主动 switchChannel。
const HOME_URL_BASE = 'https://www.yangshipin.cn/tv/home';

// ---- 数据目录（与旧 bridge.py 一致，保证跨启动状态延续）------------------
function xdgDataDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'lptv');
}
function xdgConfigDir() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
function videosDir() {
  for (const cand of [path.join(os.homedir(), 'Videos'), path.join(os.homedir(), 'Pictures')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return path.join(os.homedir(), 'Videos');
}
const DATA_DIR = xdgDataDir();

// ---- python3 定位（send_moveresize.py / write_netwm_icon.py 依赖 ctypes+libX11）----
// Electron 进程的 PATH 可能与容器不同，python3 未必在 PATH 上；这里依次尝试
// 常见候选，找到可执行的就用。找到的 python 路径缓存，避免每次拖动都探测。
let _pythonPath = null;
function findPython() {
  if (_pythonPath) return _pythonPath;
  const cands = ['python3', 'python', '/usr/bin/python3', '/usr/bin/python',
                 '/usr/local/bin/python3', '/usr/local/bin/python'];
  for (const c of cands) {
    try {
      const r = require('child_process').spawnSync(c, ['-c', 'import ctypes; print("pyok")'],
        { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && /pyok/.test(r.stdout || '')) { _pythonPath = c; return c; }
    } catch (e) {}
  }
  return 'python3'; // 兜底，让 execFile 报错并走诊断
}
// 用找到的 python 跑脚本；cb(err, pythonUsed)。脚本自身输出落 LPTV_DRAG_LOG。
function runPython(script, args, opts, cb) {
  const py = findPython();
  require('child_process').execFile(py, [script].concat(args), opts, (err) => cb(err, py));
}

// ---- GPU 健康自愈 ------------------------------------------------------
// 本环境（catlink 显示 / cde 容器）GPU 进程初始化即崩（exit_code 133/15, viz_main_impl
// "Exiting GPU process due to errors during initialization"），导致页面渲染进程被连带
// 销毁 → 白屏。此前任何一次运行 GPU 进程崩溃即写 gpu.broken 标记，本次启动若见标记
// 则禁用 GPU（软件合成，能渲染不白屏）；GPU 正常的机器不崩不写标记，保持硬件加速。
// 宁可软件合成(可能卡顿)不可白屏。
// 自动康复：GPU 连续稳定运行 60s 或页面成功加载，清除 gpu.broken 标记，下次启动
// 恢复硬件加速。避免历史崩溃标记永久阻塞硬件加速（如 EGL 修复后仍被软解限速）。
const GPU_BROKEN_MARKER = path.join(DATA_DIR, 'gpu.broken');
let gpuDisabled = false;
let softwareGpu = false;   // 本次是否走软件合成 (用于前端关闭毛玻璃)
if (fs.existsSync(GPU_BROKEN_MARKER)) {
  app.commandLine.appendSwitch('disable-gpu');
  console.log('[LPTV] 检测到 gpu.broken 标记 → 本次禁用 GPU(软件合成)');
  gpuDisabled = true;
  softwareGpu = true;
}
// cde/catlink 容器：Xdummy 环境下 use-gl=egl 触发 ANGLE Passthrough FATAL crash，
// 且 Xdummy 无 DRI/EGL context 可绑定，任何 enable-gpu-rasterization 都会崩。
// 容器内强制走软件合成（已验证稳定），视频解码由 VA-API 硬解独立于合成路径不受影响。
// 本地桌面(独立 AppImage, GPU 正常)不受此分支影响。
if (IS_CONTAINER) {
  // 容器"启用 Chrome 硬件加速（实验性）"：run.sh 把它导出为
  // CATLINK_CHROME_HARDWARE_ACCELERATION。开启且无 gpu.broken 崩溃标记时
  // 不强制 disable-gpu，交 Chromium 自动探测（硬件可用则硬件合成，否则干净
  // 回退软件）。EGL 崩（白屏）由 child-process-gone 写 gpu.broken → 下次启动
  // 禁 GPU 回退软件，自愈。gpu.broken 存在则维持软件（历史崩溃恢复中）。
  // 关闭/未设则软件合成（已验证稳定，Xdummy 无 EGL 支持）。
  if (process.env.CATLINK_CHROME_HARDWARE_ACCELERATION === '1' && !gpuDisabled) {
    console.log('[LPTV] 容器启用 Chrome 硬件加速(实验性) → 交 Chromium 自动探测' +
      '(可用则硬件, 否则回退软件; 崩溃由 gpu.broken 自愈)');
  } else if (gpuDisabled) {
    console.log('[LPTV] gpu.broken 标记 → 容器保持软件合成(硬件自愈中)');
  } else {
    app.commandLine.appendSwitch('disable-gpu');
    softwareGpu = true;
    console.log('[LPTV] cde/catlink 容器 → 禁用GPU(软件合成，Xdummy无EGL支持)');
  }
} else if (isCatlinkBox()) {
  // catlink/lightos 盒子直启 (无 CATLINK_APP_ID): DRI 存在但 EGL 崩 → 强制软件
  app.commandLine.appendSwitch('disable-gpu');
  softwareGpu = true;
  console.log('[LPTV] 检测到 catlink/lightos 盒子 → 禁用GPU(软件合成，EGL不可用)');
} else if (DRI_RENDER) {
  // 本地桌面有 DRI 节点 → 保持硬件加速（含 VAAPI 硬解视频）
  console.log('[LPTV] 检测到 DRI 节点 ' + DRI_RENDER + ' → 硬件加速保持启用');
} else {
  // 无 DRI 节点 → 软件渲染（普通 Linux 桌面/无 GPU 环境）
  app.commandLine.appendSwitch('disable-gpu');
  softwareGpu = true;
  console.log('[LPTV] 无 DRI 节点 → 强制软件合成');
}
let gpuCrashReloaded = false;
// reload 时重新授予 splash：客户端模式切换 / GPU 崩溃 / 移动端重连会 win.reload()，
// 若不重新授予 splash，reload 期间没有遮罩 → 官方页(央视频)从首帧裸闪到 inject.js
// 在 dom-ready 盖上为止（用户看到的「动画→主界面中间一瞬间出现央视频」）。
// 置位后由下一次真实导航的 claim 消费（仅 reload 触发；切台整页导航不置位 →
// 不会重播启动动画）。GPU 崩溃自愈的 reload 同样覆盖，避免白屏/裸页。
let splashReloadPending = false;
function clearGpuBrokenMarker() {
  try {
    if (fs.existsSync(GPU_BROKEN_MARKER)) {
      fs.unlinkSync(GPU_BROKEN_MARKER);
      console.log('[LPTV] GPU 稳定运行 → 清除 gpu.broken 标记，下次启动恢复硬件加速');
    }
  } catch (e) {}
}
app.on('child-process-gone', (e, details) => {
  try {
    if (details && details.type === 'GPU') {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(GPU_BROKEN_MARKER, String(details.exitCode != null ? details.exitCode : details.reason));
      console.log('[LPTV] GPU 进程退出 type=' + details.type +
        ' exit_code=' + (details.exitCode != null ? details.exitCode : details.reason) +
        ' → 写 gpu.broken, 下次启动禁用 GPU');
      // 尽力当前次自恢复：GPU 崩后软件回退, 重载一次页面(首次运行不再白屏)
      if (!gpuCrashReloaded && win && !win.isDestroyed()) {
        gpuCrashReloaded = true;
        splashReloadPending = true;   // reload 期间重新授予 splash，避免官方页裸闪
        try { win.webContents.reload(); } catch (err) {}
      }
    }
  } catch (err) {}
});

const STATE_FILE = path.join(DATA_DIR, 'lptv.state.json');
const RECDIR_FILE = path.join(DATA_DIR, 'lptv.recdir.json');
const DEFAULT_REC_DIR = path.join(videosDir(), 'LPTV', '录制');
const DEFAULT_SHOT_DIR = path.join(videosDir(), 'LPTV', '截图');
const STATE_WHITELIST = ['lastPid', 'favs', 'resumeLast', 'res', 'autoFullscreen', 'fit', 'perfMode', 'topbarAlways'];

// 浮窗几何（16:9 小窗）
const FLOAT_W = 480, FLOAT_H = 270;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {}
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch (e) { return ''; }
}

// ---- 窗口状态跟踪（无 WM 下 pywebview 的 win.maximized 不可靠，自维护）----
let win = null;
// fsUserExit: 只有用户显式退出全屏（F11/控制栏全屏按钮）才置真。fsDefault 表示
// 该环境默认保持全屏：容器内由客户端模式在启动时决定（智慧屏=true；CDE 也=true，
// 但 CDE 的"全屏"是铺满客户端画布，外层客户端窗口本身保持普通窗口）。启动/尺寸
// 变化/周期断言在 fsDefault && !fsUserExit 时保持全屏，避免智慧屏被一次误判或事件
// 压回 75% 窗口。CDE 用户按 F11 退出全屏后才进入 75% 窗口模式（可拖动）。
// 本地真桌面 fsDefault=false，行为不变。窗口模式恢复几何走 fsSaved。
const st = { max: false, fs: false, fsUserExit: false, fsDefault: !!IS_CONTAINER, fsAuto: false, float: false, pin: false, floatSaved: null, maxSaved: null, fsSaved: null, fsSeed: null };
// winOrigin：窗口初始位置，仅留作 fsDiag 诊断记录（不再参与 setPos 换算）。
// 2026-11-15 fs.log 实测：xpra 6.5 的 corral 不叠加 winOrigin，getBounds()==setBounds()。
// 早期曾假设 getBounds()=setBounds()+winOrigin（实测 +100→+3556），现不成立（疑旧环境
// corral 行为/旧 xpra）。setPos 直接用 x,y（见 setPos 注释）。winOrigin 于 ready-to-show
// 记录窗口初始位置（容器模式）。
let winOrigin = null;
// 页面加载诊断：did-fail-load / did-finish-load 记录，供 collectDiag 判断白屏是
// 页面没加载(网络/域名)还是渲染问题。
const pageLoad = { fail: null, finish: null };

// ---- xpra 客户端探测（智慧屏 / CDE 桌面模式分离的唯一可靠信号）----------
// 智慧屏 = 容器 Electron 窗口的 xpra 客户端（实测 Chromium 140 HTML5，画布 1280x720），
// 不是 /web/ 播放器 —— 因此渲染层 __lptvBridge 未定义，isTv()=__lptvBridge 对智慧屏无效。
// 模式必须由 main 进程从 xpra 客户端判定：
//   B 主：client.screen.0.display 以 Chromium 开头（HTML5 浏览器客户端 = 智慧屏）
//   A 兜底：client.screen.0.size <= 1280x720（智慧屏画布）
// 同时解析 client.screen.0.size 作为客户端【真实】屏幕尺寸 —— xpra 服务端虚拟屏 =
// 客户端 canvas；而 Electron/xdpyinfo 报的是 X max (8192x4096)，与客户端真实屏幕
// （智慧屏 1280x720 / 桌面 1920x1080）不一致，导致窗口溢出画布 / isFull 判错。
let _xpClientCache = null;
function queryXpraClient() {
  // 解析 xpra info 的客户端屏幕与类型。返回 {display, w, h} 或 null（无客户端/失败）。
  try {
    const { execSync } = require('child_process');
    const disp = xpraSocketDisplay() || ':0';
    const out = execSync('xpra info ' + disp + ' 2>/dev/null',
                         { env: Object.assign({}, process.env, { DISPLAY: disp }),
                           timeout: 4000, encoding: 'utf8' });
    const info = parseXpraClientInfo(out);
    if (!(info.w > 0 && info.h > 0)) return null;
    return info;
  } catch (e) { return null; }
}
function getXpraClient(refresh) {
  if (refresh || !_xpClientCache) _xpClientCache = queryXpraClient();
  return _xpClientCache;
}
// 异步版：客户端把 CDE 窗口最大化/缩放后，xpra 会改虚拟屏尺寸，但 Electron 的
// screen 模块可能不触发 display-metrics-changed（Xdummy RandR 变化不落到缓存），
// 同步 execSync 轮询又会阻塞主进程。故用 execFile 异步刷新客户端尺寸缓存，
// 由 createWindow 里的低频轮询调用；几何跟随仍复用 reapplyGeometry。
// 回调第二参告知连接状态：null=查询失败(不判定)，false=查询成功但没有客户端，
// true=有客户端。客户端断开(返回电视首页/关闭投射窗口)靠 false 判定 → 通知
// 渲染层退出播放模式(暂停 + 回首页 + 清掉"正在播放"焦点)。
function refreshXpraClientAsync(cb) {
  try {
    const { execFile } = require('child_process');
    const disp = xpraSocketDisplay() || ':0';
    execFile('xpra', ['info', disp], {
      env: Object.assign({}, process.env, { DISPLAY: disp }),
      timeout: 4000, encoding: 'utf8',
    }, (err, stdout) => {
      if (err || !stdout) { cb(null, null); return; }
      const info = parseXpraClientInfo(stdout);
      if (!(info.w > 0 && info.h > 0)) { cb(null, false); return; }
      _xpClientCache = info;
      cb(_xpClientCache, true);
    });
  } catch (e) { cb(null, null); }
}
function isSmartClient(c) {
  c = c || getXpraClient();
  if (!c) return false;
  return classifyClient(c).smart;
}
function isMobileClient(c) {
  c = c || getXpraClient();
  if (!c) return false;
  return classifyClient(c).mobile;
}
// 已应用模式：mobile / smart / desktop / ''（无客户端）。
function clientMode(c) {
  if (!c) return '';
  const cls = classifyClient(c);
  if (cls.mobile) return 'mobile';
  if (cls.smart) return 'smart';
  return 'desktop';
}
// 严格版：只认 Chromium HTML5 客户端。桌面 CDE 客户端的窗口/画布在启动早期也可能
// 恰好 ≤1280x720（默认小窗），用 isSmartClient 的尺寸兜底会把它误判成智慧屏 →
// 几何处理把 st.fs 清掉，之后客户端放大窗口，应用就永久停在 75% 窗口模式。
function isChromiumXpraClient(c) {
  c = c || getXpraClient();
  return !!(c && isChromiumClient(c));
}

// ---- 虚拟屏实际尺寸查询 -------------------------------------------------
// Electron 的 screen 模块在窗口创建时(虚拟屏初始 ~1600)就缓存了 display，
// xpra resize-display=auto 在客户端连接后把虚拟屏调到 1920，但 Electron
// **不感知**（screen.on 不触发，getPrimaryDisplay().bounds 仍返回 1600）。
// 因此全屏/最大化的目标尺寸不能依赖 Electron 缓存，须直接查询 X 服务器：
// xpra 客户端真实屏幕 (首选) → xrandr → xdpyinfo → Electron 缓存 → env 兜底。
function queryActualScreenSize() {
  // 0. xpra 客户端真实屏幕（智慧屏 1280x720 / 桌面 1920x1080）——权威，非 X max
  try {
    const c = getXpraClient();
    if (c && c.w > 0 && c.h > 0) return { w: c.w, h: c.h };
  } catch (e) {}
  // 统一坐标源：优先 Electron 屏幕尺寸（fs.log 实测：resize-display 后 Electron 正确
  // 反映客户端 desktop-size，如 1707x960，与 setBounds 同一坐标系）。xrandr 报的是
  // 当前 X 屏幕 current 模式，但可能未随 resize-display 同步/陈旧（启动时 2560x1440
  // 与 Electron 的 1707x960 不一致），导致窗口模式/悬窗定位错位 → 降为兜底。
  // 1. Electron 屏幕（权威、随 resize-display 更新、与 setBounds 同坐标系）
  try {
    const { screen } = require('electron');
    const b = screen.getPrimaryDisplay().bounds;
    if (b.width > 0 && b.height > 0) return { w: b.width, h: b.height };
  } catch (e) {}
  // 2. xrandr: "Screen 0: ... current 1920 x 1080 ..."（兜底）
  try {
    const { execSync } = require('child_process');
    const out = execSync('xrandr --query 2>/dev/null', { timeout: 3000, encoding: 'utf8' });
    const m = out.match(/current\s+(\d+)\s+x\s+(\d+)/);
    if (m) {
      const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch (e) {}
  // 3. xdpyinfo: "dimensions:    1920x1080 pixels"
  try {
    const { execSync } = require('child_process');
    const out = execSync('xdpyinfo 2>/dev/null | grep dimensions', { timeout: 3000, encoding: 'utf8' });
    const m = out.match(/dimensions:\s+(\d+)x(\d+)/);
    if (m) {
      const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch (e) {}
  // 4. env 兜底
  return { w: parseInt(process.env.LPTV_SCREEN_W || '1920', 10) || 1920,
           h: parseInt(process.env.LPTV_SCREEN_H || '1080', 10) || 1080 };
}

function displayBounds() {
  try {
    const { screen } = require('electron');
    const b = screen.getPrimaryDisplay().bounds;
    if (IS_CONTAINER) {
      // 容器: Electron 缓存可能陈旧，用 xrandr 实际虚拟屏尺寸
      const s = queryActualScreenSize();
      return { x: b.x, y: b.y, w: s.w, h: s.h };
    }
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch (e) {
    const s = queryActualScreenSize();
    return { x: 0, y: 0, w: s.w, h: s.h };
  }
}
// 容器内应用窗口的目标几何：编码尺寸不超过视频原生 1280x720。
// 桌面 cde 客户端会把虚拟屏拉到 2560x1440；窗口若跟着放大，xpra 每帧要编码
// 2M+ 像素（实测 region 2.2M、batch.delay 170-270ms）→ 掉帧/顿。
// 固定 1280x720 后编码区域恒定 ~0.92M；智慧屏虚拟屏本身 1280x720，
// 窗口=全屏，因此智慧屏行为不变。
function containerWinRect(d0) {
  const d = d0 || displayBounds();
  const c = getXpraClient();
  const mode = clientMode(c);
  // 智慧屏(Chromium HTML5 客户端)/移动端无论屏幕多大都按整屏(全屏)处理：HDMI 接
  // 电视后虚拟屏可能 >1280x720，若仍按尺寸走 75% 窗口，智慧屏会变成"窗口化"而非
  // 全屏。用完整客户端分类(UA/platform 优先)判定，避免把同为 Chromium 的 CDE
  // 桌面客户端误判成智慧屏，或反过来。
  if (mode === 'smart' || mode === 'mobile') return { x: d.x, y: d.y, w: d.w, h: d.h };
  // 客户端尚未连接（容器自动拉起 LPTV、智慧屏首次打开）：小画布按全屏，
  // 保持智慧屏启动行为；大画布（CDE 桌面）按窗口模式。客户端连上后按真实
  // 模式重算（智慧屏 → 整屏，CDE → 75% 窗口）。
  if (!c && d.w <= 1280 && d.h <= 720) return { x: d.x, y: d.y, w: d.w, h: d.h };
  // 桌面 cde 客户端（含画布 ≤1280x720 的小窗口）：一律窗口模式，绝不因为
  // 画布小就误判成全屏。窗口按客户端 WM 的"75% 屏"规则建（避免和它抢尺寸）。
  // 但窗口必须是 16:9：超宽屏（如 3372x1308 → 75% = 2529x981）若按 75% 宽高
  // 建窗，1920x1080 设计画布只能按高度缩放，左右各留数百像素黑边，看起来
  // "窗口太宽"。故以 75% 高度定高、按 16:9 算宽并居中；宽度仍不超过 75% 屏宽。
  // 这样应用视口=设计画布比例，UI 铺满窗口；xpra 每帧编码区域也控制在 ~1.7M。
  let h = Math.min(Math.round(d.h * 0.75), 1080);
  let w = Math.round(h * 16 / 9);
  const maxW = Math.round(d.w * 0.75);
  if (w > maxW) {
    w = maxW;
    h = Math.round(w * 9 / 16);
  }
  return { x: d.x + Math.round((d.w - w) / 2),
           y: d.y + Math.round((d.h - h) / 2), w: w, h: h };
}

// 窗口模式下把目标位置钳进当前虚拟屏，避免客户端画布缩小/漂移后窗口跑到
// 屏幕外（CDE 窗口必须完整可见、可拖动）。尺寸由 containerWinRect 决定。
function clampRectPos(rect, screenRect) {
  const maxX = screenRect.x + Math.max(0, screenRect.w - rect.w);
  const maxY = screenRect.y + Math.max(0, screenRect.h - rect.h);
  return { x: Math.max(screenRect.x, Math.min(rect.x, maxX)),
           y: Math.max(screenRect.y, Math.min(rect.y, maxY)),
           w: rect.w, h: rect.h };
}

// CDE 桌面窗口模式的初始/重算几何：75% 屏、16:9、居中并钳在屏内。
function desktopWindowRect(full) {
  const f = full || displayBounds();
  return clampRectPos(containerWinRect(f), f);
}

// 把给定区域收敛成居中的 16:9 矩形（最大化/全屏用）：目标屏若不是 16:9，
// 直接铺满会让设计画布两侧/上下留黑边。保持 16:9 后 UI 完整铺满窗口。
function fitTvRect(b) {
  const x = Math.round(b.x || 0), y = Math.round(b.y || 0);
  const bw = Math.max(1, Math.round(b.w || b.width || 1280));
  const bh = Math.max(1, Math.round(b.h || b.height || 720));
  let w, h;
  if (bw * 9 >= bh * 16) {          // 区域比 16:9 更宽 → 按高度定
    h = bh; w = Math.round(bh * 16 / 9);
  } else {                          // 更窄/更高 → 按宽度定
    w = bw; h = Math.round(bw * 9 / 16);
  }
  return { x: x + Math.round((bw - w) / 2), y: y + Math.round((bh - h) / 2), w: w, h: h };
}
// 最大化: 铺满工作区(保留任务栏); 全屏: 铺满整个桌面(桌面全屏, 覆盖任务栏区)。
// 容器内无 WM 时 workArea==bounds, 二者相同; 本地桌面则区分。
function workAreaBounds() {
  try {
    const { screen } = require('electron');
    const b = screen.getPrimaryDisplay().workArea;
    if (IS_CONTAINER) {
      // 容器: workArea==bounds（无 WM），用实际虚拟屏尺寸
      const s = queryActualScreenSize();
      return { x: b.x, y: b.y, w: s.w, h: s.h };
    }
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch (e) {
    const s = queryActualScreenSize();
    return { x: 0, y: 0, w: s.w, h: s.h };
  }
}

// setPos: 目标位置用虚拟屏坐标（displayBounds/workAreaBounds 返回），直接 setBounds。
// xpra 无真实 WM：corral 当前不叠加 winOrigin 偏移，getBounds()==setBounds()。
// 2026-11-15 fs.log 实测：fullscreen setPos(0,0,2160,1440) → setBounds(-640,-360) →
// getBounds=(-640,-360)，即窗口移到 目标-winOrigin，左上 winOrigin(640,360) 在屏幕外
// → 全屏错位。早期曾假设 getBounds()=setBounds()+winOrigin，现（xpra 6.5）不成立。
// 故 setPos 直接用 x,y（winOrigin 仅留作 fsDiag 诊断记录，不再参与换算）。
function setPos(x, y, w, h) {
  if (!win) return;
  win.setBounds({ x: Math.round(x), y: Math.round(y),
                  width: Math.max(Math.round(w), 1), height: Math.max(Math.round(h), 1) });
}

// 退出全屏的窗口恢复几何：优先用保存的窗口几何；若保存值等于整屏（启动即全屏、
// 无真实窗口几何，如 st.fsSeed 为空），退到当前屏幕居中的 75% 窗口（CDE 可拖）。
function windowRestoreRect() {
  const d = displayBounds();
  const saved = st.fsSaved;
  if (saved) {
    const sw = saved.width || saved.w, sh = saved.height || saved.h;
    const isFullSize = (Math.abs(sw - d.w) <= 8 && Math.abs(sh - d.h) <= 8);
    if (!isFullSize) return { x: saved.x, y: saved.y, width: sw, height: sh };
  }
  const c = containerWinRect(d);
  return { x: c.x, y: c.y, width: c.w, height: c.h };
}

// ---- 全屏/窗口几何诊断 ---------------------------------------------------
// 排查 cde 容器全屏错位：记录 Electron 看到的屏幕 bounds/workArea、窗口实际
// bounds、winOrigin，以及 setBounds 请求值。落 DATA_DIR/lptv.fs.log + 容器日志。
// 目的：确认 screen.getPrimaryDisplay() 报的是 xpra 虚拟屏还是客户端真实分辨率，
// 以及窗口实际位置（win.getBounds）与 setPos 目标是否一致（全屏铺满验证）。
function fsDiag(tag, extra) {
  try {
    const s = screen.getPrimaryDisplay();
    const b = win && !win.isDestroyed() ? win.getBounds() : null;
    const line = {
      t: new Date().toISOString(), tag,
      disp: { x: s.bounds.x, y: s.bounds.y, w: s.bounds.width, h: s.bounds.height },
      work: { x: s.workArea.x, y: s.workArea.y, w: s.workArea.width, h: s.workArea.height },
      origin: winOrigin ? { x: winOrigin.x, y: winOrigin.y } : null,
      win: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
      isContainer: !!IS_CONTAINER,
    };
    if (extra) line.extra = extra;
    const str = '[LPTV-fs] ' + JSON.stringify(line);
    console.log(str);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(path.join(DATA_DIR, 'lptv.fs.log'), str + '\n');
    } catch (e) {}
  } catch (e) {}
}

function stateLoad() {
  return readJson(STATE_FILE) || {};
}
function stateSave(patch) {
  const cur = readJson(STATE_FILE) || {};
  for (const k of STATE_WHITELIST) if (k in patch) cur[k] = patch[k];
  writeJson(STATE_FILE, cur);
}

// ---- 保存目录（录制/截图，自定义优先）-----------------------------------
function saveDirs() {
  const custom = readJson(RECDIR_FILE) || {};
  return { rec: custom.rec || DEFAULT_REC_DIR, shot: custom.shot || DEFAULT_SHOT_DIR };
}

// ---- 频道库（channels.json，由 app/channels.py 导出）---------------------
function channelsList() {
  // files 里的 channels.json 打包后在 app.asar 内（Electron 可透读 asar）
  const p = app.isPackaged ? path.join(app.getAppPath(), 'channels.json')
                           : path.join(__dirname, 'channels.json');
  return readJson(p) || [];
}

// ---- 注入：启动动画 + inject.js ------------------------------------------
// splash 由 preload 在 document-start 同步建遮罩（隔离世界共享 DOM，早于官方页
// 首帧，杜绝官方页闪现），此处不再用 executeJavaScript 注入。inject.js 仍在此
// did-finish-load 注入。
function injectUi() {
  if (!win || win.isDestroyed()) return;
  // 只注入 UI 脚本；splash 由 preload 在 document-start 同步处理，这里不再混入
  // splash，避免 __LPTV_SPLASH_CFG 被覆盖成无 banner 且 __lptvSplash 被重置后再闪现。
  const inject = readText(assetFile('inject.js'));
  if (!inject) return;
  // 暴露环境标志给渲染层：本地桌面(有真实 WM)顶栏用 Electron 原生 -webkit-app-region:drag
  // （最流畅、焦点正确）；容器/xpra(无 WM) 用 begin_window_drag → main 进程注入
  // mousemove 监听器 → move_win → setPos 直接 setBounds（不用 send_moveresize.py，因
  // xpra 6.5 HTML5 客户端 move_drag 有坐标漂移/缩放 bug，见 begin_window_drag 注释）。
  const pre = 'window.__LPTV_IS_CONTAINER=' + (IS_CONTAINER ? 'true' : 'false') + ';' +
    'window.__LPTV_SOFTWARE_GPU=' + (softwareGpu ? 'true' : 'false') + ';' +
    'window.__LPTV_PANEL_DEBUG=' + (process.env.LPTV_PANEL_DEBUG ? 'true' : 'false') + ';\n';
  win.webContents.executeJavaScript(pre + inject).catch((e) => {
    console.error('[LPTV] inject failed:', e && e.message);
  });
}

// ---- 窗口控制 -------------------------------------------------------------
function createWindow() {
  // 窗口上限 = 屏幕可用区：1920x1080 是期望值，但容器/小屏会被裁剪，
  // 一旦窗口大于可见屏幕，底部/右缘的 hover 触发带（CTRL_ZONE/EPG_EDGE）落到
  // 屏幕外，控制栏/节目单永远滑不出来 → 必须按屏幕尺寸收敛。
  // 基准 1280x720：不再向上等比放大（大屏保持 1280x720），小屏收敛到可见区
  const disp = screen.getPrimaryDisplay();
  // 容器（xpra）：建窗即给【虚拟屏全尺寸】，否则窗口以较小尺寸居中映射 →
  // 四周留壁纸/黑边（用户看到"没铺满"）。CDE 桌面默认全屏，75% 窗口只在
  // F11 退出全屏时作为恢复几何（st.fsSeed）。建窗即给全尺寸比事后 setBounds
  // 可靠（xpra 映射后再 resize 常被忽略）。
  const cb = IS_CONTAINER ? displayBounds() : null;
  const sw = (disp.workAreaSize && disp.workAreaSize.width) || 1920;
  const sh = (disp.workAreaSize && disp.workAreaSize.height) || 1080;
  const scale = Math.min(sw / 1280, sh / 720, 1.0); // 上限 1.0x：不超过 1280x720
  const W = cb ? cb.w : Math.max(360, Math.round(1280 * scale));
  const H = cb ? cb.h : Math.max(220, Math.round(720 * scale));
  // 建窗时已连接的客户端模式：决定 preload 的 argv 标记；后续轮询发现模式变化会 reload。
  const bootClient = getXpraClient();
  const bootMode = clientMode(bootClient);
  win = new BrowserWindow({
    width: W,
    height: H,
    x: cb ? cb.x : (disp.workArea ? Math.round(disp.workArea.x + (disp.workArea.width - W) / 2) : undefined),
    y: cb ? cb.y : (disp.workArea ? Math.round(disp.workArea.y + (disp.workArea.height - H) / 2) : undefined),
    minWidth: 360,
    minHeight: 220,
    frame: false,
    // 与 splash.js 底色一致（#04070d），窗口建立到 splash 注入之间不闪黑
    backgroundColor: '#04070d',
    // 容器：立即显示（xpra 在首次绘制前也要看到窗口映射，否则远程端"已投射"却
    // 长时间无画面）；splash 与底色一致，无闪白。本地桌面：ready-to-show 才显示，
    // 否则真实 WM 会在渲染首帧前以默认白呈现窗口 → 白闪。splash 于 document-start
    // 首帧即盖暗，ready-to-show 时窗口已带暗色 splash，不闪白。
    show: IS_CONTAINER,
    title: 'LPTV',
    name: 'LPTV',
    icon: assetFile('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      sandbox: false,
      // 智慧屏标记：preload 同步读取 argv → splash/inject 在 document-start 就能判定，
      // 不依赖 dom-ready 时的 executeJavaScript 注入（此前存在竞态，判定恒 false）。
      // 用 xpra 客户端判定（智慧屏 = Chromium/1280x720 客户端；移动端 = UA/platform），
      // 而非 IS_CONTAINER（容器本身对智慧屏+桌面都 true，无法区分两模式）。
      additionalArguments: (IS_CONTAINER && bootMode === 'mobile') ? ['--lptv-mobile=1']
        : ((IS_CONTAINER && bootMode === 'smart') ? ['--lptv-smart=1'] : []),
      // 视频流畅度：禁止按窗口遮挡/隐藏节流渲染（xpra/浮窗下遮挡判定不可靠，
      // 默认会降 ~1fps 甚至暂停视频 → 假卡顿）。配合 disable-renderer-backgrounding。
      backgroundThrottling: false,
    },
  });

  // 把渲染层关键日志（换台诊断）转到主进程 stdout → 容器日志
  win.webContents.on('console-message', (e, level, message) => {
    if (typeof message === 'string' && message.indexOf('[LPTV-') === 0) {
      console.log('[LPTV-renderer] ' + message);
    }
  });

  // 窗口伪装（对应 --class=LPTV / WM_NAME / _NET_WM_ICON，xpra SPA 才能显示任务栏图标）
  app.setName('LPTV');
  win.setTitle('LPTV');
  win.setMenuBarVisibility(false);
  // xpra seamless 模式：Electron setIcon 不写 _NET_WM_ICON（无真实 WM）。
  // 图标由 xpra windowicon.py 兜底从 hicolor lptv.png 加载（需 CATLINK_FORCE_WINDOW_ICON 或 wmclass 匹配）。
  try {
    const ico = nativeImage.createFromPath(assetFile('icon.png'));
    if (!ico.isEmpty() && typeof win.setIcon === 'function') win.setIcon(ico);
  } catch (e) {}

  // ---- 直接写 _NET_WM_ICON（与真 Chrome 行为一致）----------------------
  // xpra 无 WM 下 setIcon 不落 _NET_WM_ICON → 客户端任务栏回退到自身图标。
  // 用 getNativeWindowHandle() 取 XID，经 libX11 XChangeProperty 直写完整
  // ARGB32 数组（写 write_netwm_icon.py，见该文件注释：xprop -set 有 64 元素
  // 硬上限，128x128 需 16386 个，xprop 会截断 → xpra 报 corrupt），让 xpra
  // windowicon 读窗口属性并作为 window-icon 发给客户端，任务栏即显示 LPTV 图标。
  // 与 windowicon.py 补丁互为兜底（优先窗口自身属性）。
  let _iconSeq = 0;   // 每次调用独立临时文件，防多路重写(_iconRetry/show/6s)共享同名文件互删
  const writeNetWmIcon = (w) => {
    try {
      if (!w || w.isDestroyed()) return;
      const buf = w.getNativeWindowHandle();
      if (!buf || buf.length < 4) return;
      // Linux 原生句柄 = XID（32 位），小端下低 4 字节即窗口 id
      let xid = buf.readUInt32LE(0);
      if (xid === 0 && buf.length >= 8) xid = buf.readUInt32LE(4);
      if (!xid) return;
      const img0 = nativeImage.createFromPath(assetFile('icon.png'));
      if (img0.isEmpty()) return;
      // 128px 已足够任务栏清晰，且控制临时文件大小
      const s0 = img0.getSize();
      const img = (s0.width > 128) ? img0.resize({ width: 128, height: 128, quality: 'best' }) : img0;
      const { width, height } = img.getSize();
      const bmp = img.toBitmap(); // BGRA，每像素 4 字节
      // 转 ARGB32 文本（脚本读入直写 X11）：A<<24|R<<16|G<<8|B
      const argb = [String(width), String(height)];
      for (let i = 0; i < bmp.length; i += 4) {
        const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
        argb.push(String(((a << 24) | (r << 16) | (g << 8) | b) >>> 0));
      }
      const tmp = path.join(os.tmpdir(), 'lptv-argb-' + process.pid + '-' + (_iconSeq++) + '-' + xid + '.txt');
      fs.writeFileSync(tmp, argb.join('\n'));
      const script = app.isPackaged
        ? path.join(process.resourcesPath, 'write_netwm_icon.py')
        : path.join(__dirname, 'write_netwm_icon.py');
      require('child_process').execFile('python3',
        [script, '0x' + xid.toString(16), tmp],
        (err) => {
          try { fs.unlinkSync(tmp); } catch (e) {}
          const line = err
            ? 'FAIL ' + new Date().toISOString() + ' ' + err.message
            : 'OK ' + new Date().toISOString() + ' xid=0x' + xid.toString(16) + ' ' + width + 'x' + height;
          if (err) console.error('[LPTV] _NET_WM_ICON write failed:', err.message);
          else console.log('[LPTV] _NET_WM_ICON set OK xid=0x' + xid.toString(16) + ' ' + width + 'x' + height);
          // 诊断：写 DATA_DIR/lptv.icon.json（盒子侧可 cat 确认 _NET_WM_ICON 是否真写入）
          try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.appendFileSync(path.join(DATA_DIR, 'lptv.icon.json'), line + '\n');
          } catch (e) {}
        });
    } catch (e) { console.error('[LPTV] _NET_WM_ICON write error:', e); }
  };
  // 写 _NET_WM_ICON：单次 + 单兜底在容器（xpra 无 WM）里偶发落空 —— xpra 可能
  // 在窗口 map 前接管、官方 SPA 重渲染会重建/替换窗口（XID 变化），或迟到映射。
  // 改多点重写：ready-to-show 后 0.8/1.6/2.4/3.2/4.0s 各写一次（每次重取 XID），
  // 再加 show 事件，确保窗口自身 _NET_WM_ICON 稳定为 LPTV（xpra windowicon 读
  // 的正是该 "icons" 属性，容器客户端任务栏据此显示 LPTV 而非 rchrome/微信）。
  // 真 WM 下 setIcon() 已落属性；此 libX11 直写是 xpra 无 WM 容器的真正来源。
  // 去掉 CDE/xpra 远程窗口的标题栏/边框：显式写 _MOTIF_WM_HINTS.decorations=0。
  // Electron frame:false 在 Xdummy/xpra 下仍可能被服务端当成有装饰，客户端于是
  // 画出 CDE 顶栏。xpra 读该属性生成 window metadata "decorations"；写 0 后
  // HTML5/原生客户端都不再画标题栏。窗口拖动仍走应用顶栏的 begin_window_drag。
  const stripDecorations = (w) => {
    try {
      if (!w || w.isDestroyed()) return;
      const buf = w.getNativeWindowHandle();
      if (!buf || buf.length < 4) return;
      let xid = buf.readUInt32LE(0);
      if (xid === 0 && buf.length >= 8) xid = buf.readUInt32LE(4);
      if (!xid) return;
      const script = app.isPackaged
        ? path.join(process.resourcesPath, 'strip_decorations.py')
        : path.join(__dirname, 'strip_decorations.py');
      require('child_process').execFile(findPython(),
        [script, '0x' + xid.toString(16)],
        { timeout: 4000, env: Object.assign({}, process.env,
          { LPTV_DECOR_LOG: path.join(DATA_DIR, 'lptv.decor.log') }) },
        (err) => {
          if (err) console.error('[LPTV] strip decorations failed:', err.message);
        });
    } catch (e) {}
  };

  const _iconRetry = (n) => {
    try {
      if (!win || win.isDestroyed()) return;
      writeNetWmIcon(win);
      stripDecorations(win);
      if (n < 5) setTimeout(() => _iconRetry(n + 1), 800);   // ~4s 内共 5 次，覆盖重建/迟映射
    } catch (e) {}
  };
  win.once('ready-to-show', () => _iconRetry(0));
  win.on('show', () => {
    try { writeNetWmIcon(win); stripDecorations(win); } catch (e) {}
  });
  setTimeout(() => {
    try {
      if (win && !win.isDestroyed()) { writeNetWmIcon(win); stripDecorations(win); }
    } catch (e) {}
  }, 6000);

  win.webContents.setUserAgent(CHROME_UA);

  // ---- 锁定窗口标题为 LPTV ------------------------------------------------
  // YSP(央视频) SPA 每次路由切换(切台)都会改 document.title(如「央视频 - 有品质
  // 的视频社交媒体」)。Electron 默认把窗口标题与页面标题同步(page-title-updated)，
  // 于是切台后远程端标题栏变成央视频而不是 LPTV。preventDefault 阻止页面标题覆盖
  // 窗口标题，标题栏恒为 LPTV(xpra 客户端显示 "LPTV on <server-domain>")。
  // splash.js 的 90s 临时定时器由此冗余(仍保留, 无害; 它只护首载 90s, 不护切台)。
  win.webContents.on('page-title-updated', (e) => {
    try {
      e.preventDefault();
      if (!win.isDestroyed()) win.setTitle('LPTV');
    } catch (err) {}
  });

  // inject 在 DOM 就绪(dom-ready)后注入——比 did-finish-load 早数秒(YSP 整页资源
  // 仍在加载), 让 LPTV 覆盖层与官方页 DOM 同时出现, 消除"注入慢半拍"。
  // inject.js 自带 DOMContentLoaded 等待 + 视频 acquireOfficial 轮询 + 3s 保活
  // re-root 守卫, 提前注入也不会因官方 SPA 后续重渲染而丢失。splash 仍由 preload
  // 在 document-start 同步处理, 覆盖 dom-ready 之前的空窗。
  // 仅真实 http(s) 页(即 YSP)注入；about:blank/初始帧的 dom-ready 跳过, 避免
  // 注入后被导航替换(白忙+可能闪 UI)。真正注入点 = YSP DOM 就绪 ≈ dom-ready。
  win.webContents.on('dom-ready', () => {
    try {
      if (/^https?:\/\//.test(win.webContents.getURL())) { startupLog('dom_ready'); injectUi(); }
    } catch (e) {}
  });
  win.webContents.on('did-finish-load', () => { pageLoad.finish = Date.now(); startupLog('page_loaded');
    // 只有本次真正启用了硬件加速时才清标记。否则会出现"软件启动成功→清标记→
    // 下次硬件启动又崩"的来回振荡 (本机 GPU 驱动 SIGBUS 时尤其明显)。
    if (!gpuDisabled) clearGpuBrokenMarker();
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    pageLoad.fail = { code, desc: String(desc || ''), url: String(url || ''), t: Date.now() };
  });

  // 环境诊断：启动 ~3s(GPU 进程已初始化)与 ~15s(页面是否真正加载完成)各打一次
  // 快照到容器日志 + 落盘, 供 cde 白屏/卡顿排查。
  // (容器日志见 [LPTV-diag], 文件见 ~/.local/share/lptv/lptv.diag.json)
  const diagAt = (ms) => setTimeout(() => {
    collectDiag().then((d) => {
      d.snap = ms;
      console.log('[LPTV-diag] ' + JSON.stringify(d));
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, 'lptv.diag.json'), JSON.stringify(d, null, 2));
      } catch (e) {}
    }).catch(() => {});
  }, ms);
  diagAt(3000);
  diagAt(15000);

  win.on('closed', () => { win = null; });

  // 真 WM 的整屏态（仅智慧屏默认使用；CDE 桌面保持窗口模式）：setBounds 会被
  // 工作区 struts 钳到任务栏以上，必须用 setFullScreen；初始窗口记为恢复几何。
  const enterXpraDesktopFullscreen = () => {
    try {
      if (!win || win.isDestroyed() || st.fs) return;
      const b = win.getBounds();
      st.fsSaved = { x: b.x, y: b.y, width: b.width, height: b.height };
      st.fs = true;
      st.fsAuto = false;
      st.fsUserExit = false;
      win.setFullScreen(true);
      fsDiag('startup_fullscreen', { target: displayBounds() });
    } catch (e) {}
  };
  // CDE 桌面（真 WM）全屏窗口在虚拟屏尺寸变化（xpra 客户端最大化/缩放）后，
  // WM 未必重新铺满 → 应用仍是旧尺寸，客户端放大后周围留桌面/黑边。先直接按新
  // 屏幕尺寸 setBounds（部分 WM 全屏态下仍接受）；若 400ms 后仍未铺满，再退出/
  // 重进全屏态让 WM 重新声明（已全屏时 setFullScreen(true) 是 no-op，必须切换）。
  let _fsReassertT = null;
  const reassertDesktopFullscreen = () => {
    if (!win || win.isDestroyed()) return;
    if (_fsReassertT) clearTimeout(_fsReassertT);
    const d = displayBounds();
    setPos(d.x, d.y, d.w, d.h);
    _fsReassertT = setTimeout(() => {
      _fsReassertT = null;
      try {
        if (!win || win.isDestroyed()) return;
        const b = win.getBounds();
        if (Math.abs(b.width - d.w) <= 8 && Math.abs(b.height - d.h) <= 8) return;
        win.setFullScreen(false);
        setTimeout(() => {
          try {
            if (!win || win.isDestroyed()) return;
            win.setFullScreen(true);
            setTimeout(() => {
              try {
                const d2 = displayBounds();
                const b2 = win.getBounds();
                if (Math.abs(b2.width - d2.w) > 8 || Math.abs(b2.height - d2.h) > 8) {
                  setPos(d2.x, d2.y, d2.w, d2.h);
                }
              } catch (e) {}
            }, 700);
          } catch (e) {}
        }, 120);
      } catch (e) {}
    }, 400);
  };

  win.once('ready-to-show', () => {
    startupLog('window_shown');
    // xpra corral 已把窗口放到初始位置：把它记为坐标偏移基准（仅容器模式，
    // 且 ready-to-show 的校准优先于早前 setPos 的粗校）。本地桌面恒为 {0,0}。
    try {
      if (IS_CONTAINER) winOrigin = win.getBounds();
      else if (winOrigin === null) winOrigin = { x: 0, y: 0 };
    } catch (e) {}
    fsDiag('ready_to_show');
    // 先定最终几何再显示首帧: 容器建窗会被 WM 钳到工作区(比全屏矮 ~50px),
    // 若等 1.5s/UI toggle 再铺满, 首页已按矮尺寸画出来 → 随后整页上下跳动
    // (用户反馈"运行 AppImage 首页会上下跳动")。此刻 splash 还盖着, 调整不可见。
    try {
      if (IS_CONTAINER) {
        const d = displayBounds();
        setPos(d.x, d.y, d.w, d.h);
      }
      // 智慧屏默认整屏；CDE 桌面（catlink/lightos 盒子直启，真 WM）保持建窗时的
      // 1280x720 普通窗口，不强制全屏（用户可自行最大化/F11）。
      if (IS_XPRA_DESKTOP && !IS_CONTAINER && isSmartClient()) enterXpraDesktopFullscreen();
    } catch (e) {}
    try { if (!win.isDestroyed()) win.show(); } catch (e) {}
    // 少数 WM 在窗口映射前忽略 setFullScreen: 映射后按实际 bounds 校验并补一次
    // (仍在 splash 遮罩下, 不可见)。
    try {
      if (IS_XPRA_DESKTOP && !IS_CONTAINER && isSmartClient()) {
        const d = displayBounds();
        const b = win.getBounds();
        if (Math.abs(b.width - d.w) > 8 || Math.abs(b.height - d.h) > 8 ||
            b.x !== d.x || b.y !== d.y) {
          st.fs = false;
          enterXpraDesktopFullscreen();
        }
      }
    } catch (e) {}
  });
  // ---- 虚拟屏跟随客户端分辨率（xpra resize-display=auto）------------------
  // xpra 在客户端连接后把 Xdummy 虚拟屏调整到客户端尺寸(如 1920x1080)，但
  // Electron 的 screen 模块在窗口创建时(虚拟屏初始 ~1600)就初始化了 display，
  // **不感知后续 RandR 变化** → 全屏 setBounds 只铺到 1600，右侧露出客户端
  // 桌面(错位)。监听 display 变化，虚拟屏 resize 后若处于全屏/最大化，用新
  // 尺寸重新 setPos 铺满。容器模式才需要（本地桌面真 WM 无此问题）。
  try {
    const { screen } = require('electron');
    const reapplyGeometry = (why) => {
      try {
        if (!win || win.isDestroyed()) return;
        // 启动时因"客户端未连接+小画布"兜底成全屏（fsAuto），客户端连上后
        // 若确认是 CDE 桌面 → 保持铺满客户端画布（外层客户端窗口已是普通窗口，
        // 不再露出远程桌面黑边）；智慧屏/移动端仍保持整屏。75% 几何仅作为
        // F11 退出全屏时的恢复窗口，不再作为启动默认几何。
        if (st.fsAuto && !st.fsUserExit) {
          const mode = clientMode(getXpraClient());
          if (mode === 'desktop') {
            st.fsAuto = false;
            st.fs = true;
            st.fsDefault = true;
            if (!st.fsSaved) st.fsSaved = desktopWindowRect();
            const d0 = displayBounds();
            fsDiag('display_changed_' + why, { disp: d0, fullscreen: true, desktopFill: true });
            setPos(d0.x, d0.y, d0.w, d0.h);
            return;
          }
          if (mode === 'smart' || mode === 'mobile') {
            st.fsAuto = false;
            st.fs = true;
          }
        }
        // 全屏意图（st.fs，或该环境默认保持全屏且用户尚未显式退出）→ 一律按
        // 整屏重新铺满。CDE 桌面客户端放大/缩小画布时，即使中途被误清 st.fs，
        // 也不会停在 75% 窗口模式。
        if (st.fs || (st.fsDefault && !st.fsUserExit)) {
          const d = displayBounds();
          st.fs = true;
          fsDiag('display_changed_' + why, { disp: d, fullscreen: true });
          // 容器(无 WM)直接 setPos 铺满；CDE 桌面(真 WM)全屏态由 WM 管，
          // 但客户端尺寸变化后 WM 未必重新铺满 → 重新声明全屏态。
          if (IS_XPRA_DESKTOP && !IS_CONTAINER) reassertDesktopFullscreen();
          else setPos(d.x, d.y, d.w, d.h);
        } else if (st.max) {
          const d = workAreaBounds();
          fsDiag('display_changed_' + why, { disp: d, maximized: true });
          setPos(d.x, d.y, d.w, d.h);
        } else if (IS_XPRA_DESKTOP) {
          // CDE 窗口模式（容器无 WM / 盒子真 WM 通用）：虚拟屏随客户端变化后
          // 按新的 75% 目标校正尺寸，保留用户当前窗口位置；画布缩小导致越界时
          // 钳回屏内，保证窗口完整可见、可拖动。
          const d = containerWinRect();
          const f = displayBounds();
          const b = win.getBounds();
          const r = clampRectPos({ x: b.x, y: b.y, w: d.w, h: d.h }, f);
          if (b.width !== r.w || b.height !== r.h || b.x !== r.x || b.y !== r.y) {
            setPos(r.x, r.y, r.w, r.h);
          }
        }
      } catch (e) {}
    };
    screen.on('display-metrics-changed', () => reapplyGeometry('metrics'));
    screen.on('display-added', () => reapplyGeometry('added'));
    screen.on('display-removed', () => reapplyGeometry('removed'));
    // 低频异步探测 xpra 客户端尺寸：CDE 客户端窗口最大化/缩放后虚拟屏可能变化，
    // 但 Electron 的 screen 模块不一定触发 display-metrics-changed（Xdummy RandR
    // 变化不落缓存）。execFile 异步、不阻塞主进程；只在尺寸真变化时重新套几何，
    // 避免每 2.5s 的同步 execSync 轮询（旧实现因此被移除）。
    // 页面实际加载时经 lptv:env IPC 拿到的客户端模式。建窗时 getXpraClient() 可能因
    // 客户端尚未在 xpra info 注册而返回 null（bootMode=''），若轮询仍拿 bootMode 对比，
    // 客户端一连上就会被判成"模式变化"→ 整页重载（首页已显示又刷新+重播启动动画）。
    // 故以"页面 document-start 真正读到的环境"为准：只有页面环境与当前客户端模式
    // 真不符才 reload（该环境由下方 lptv:env handler 同步更新）。
    let pageEnvMode = bootMode;
    if (IS_CONTAINER || IS_XPRA_DESKTOP) {
      let following = false;
      let lastSize = '';
      let hadClient = false;       // 曾确认有客户端; 断开后才允许触发收尾
      let everHadClient = false;   // 是否曾经连过（区分首次连接与断开后重连）
      let goneMisses = 0;
      const followTimer = setInterval(() => {
        if (following) return;
        following = true;
        refreshXpraClientAsync((c, connected) => {
          following = false;
          if (!win || win.isDestroyed()) return;
          if (connected === null) return;   // xpra info 查询失败: 不判定连接状态
          // 客户端断开：先只做"两次未确认才收尾"（暂停/回首页），不做模式比较/reload。
          // 断开时 getXpraClient() 已无客户端 → clientMode 返回 '' ≠ appliedMode，
          // 若先比较模式会误判成"客户端类型变化"而整页重载，绕过去抖、破坏
          // CDE/智慧屏同模式重连的"不额外 reload"行为。
          if (!connected) {
            if (hadClient) {
              goneMisses++;
              if (goneMisses >= 2) {
                hadClient = false; goneMisses = 0; lastSize = '';
                fsDiag('client_gone');
                try {
                  win.webContents.executeJavaScript(
                    "window.dispatchEvent(new CustomEvent('lptv:client-gone'))"
                  ).catch(() => {});
                } catch (e) {}
              }
            }
            return;
          }
          goneMisses = 0;
          const mode = clientMode(c);
          if (mode !== pageEnvMode) {
            // 客户端模式与"页面实际读到的环境"不符：页面只在 document-start 读
            // __LPTV_ENV，reload 让新客户端重新走启动流程（仅当页面环境确实需要纠正时）。
            const from = pageEnvMode;
            pageEnvMode = mode;
            // '' → desktop 不重载：CDE 客户端首次连上前，页面已经是桌面环境
            // （smart=false），重载只会让首页刷新、再播一次启动动画。智慧屏/
            // 移动端/desktop↔smart 等真实模式变化仍重载以纠正 UI。
            if (!(from === '' && mode === 'desktop')) {
              fsDiag('client_mode', { mode: mode });
              splashReloadPending = true;   // reload 期间重新授予 splash，避免官方页裸闪
              try { win.reload(); } catch (e) {}
              reapplyGeometry('modechange');
              return;
            }
          }
          const key = c.w + 'x' + c.h;
          if (!hadClient) {
            // 客户端(重新)连上: 记基线并按当前虚拟屏重新铺满(分辨率可能已变)。
            hadClient = true;
            const reattach = everHadClient;
            everHadClient = true;
            lastSize = key;
            if (reattach && mode === 'mobile') {
              // 移动端重连：reload 重走启动自动播放上次频道，避免留下冻结画面
              // （移动端控制条没有播放按钮）。CDE/智慧屏同模式重连保持原行为。
              fsDiag('mobile_reattach');
              splashReloadPending = true;   // reload 期间重新授予 splash，避免官方页裸闪
              try { win.reload(); } catch (e) {}
              return;
            }
            reapplyGeometry('xprareconnect');
            return;
          }
          if (!lastSize) { lastSize = key; return; }   // 首轮只记基线, 避免启动即闪一次全屏重声明
          if (key === lastSize) return;
          lastSize = key;
          fsDiag('xpra_client_size', { client: { w: c.w, h: c.h } });
          reapplyGeometry('xprapoll');
        });
      }, 2500);
      win.on('closed', () => { clearInterval(followTimer); });
    }
  } catch (e) {}
  // ---- 启动诊断：捕获 Electron 看到的 display vs 实际虚拟屏尺寸 ----
  // 容器模式下 ready-to-show 可能不触发（xpra 无 WM），用定时器兜底，
  // 确认 displayBounds() 是否返回实际 1920（若返回 1600 → Electron 缓存陈旧）。
  setTimeout(() => {
    try {
      fsDiag('startup_3s', { actual: queryActualScreenSize() });
    } catch (e) {}
  }, 3000);
  // 本地桌面兜底：ready-to-show 迟迟不触发（极少数首帧异常）也要显示窗口，
  // 避免窗口永不出现（比白闪更糟）。
  if (!IS_CONTAINER) {
    setTimeout(function () {
      try {
        if (win && !win.isDestroyed() && !win.isVisible()) {
          // 智慧屏先全屏再显示, 避免首页先以窗口尺寸出现再跳全屏;
          // CDE 桌面保持 1280x720 窗口模式（鼠标模式）。
          if (IS_XPRA_DESKTOP && !IS_CONTAINER && isSmartClient()) enterXpraDesktopFullscreen();
          win.show();
        }
      } catch (e) {}
      try {
        if (IS_XPRA_DESKTOP && !IS_CONTAINER && isSmartClient() && win && !win.isDestroyed()) {
          const d = displayBounds();
          const b = win.getBounds();
          if (Math.abs(b.width - d.w) > 8 || Math.abs(b.height - d.h) > 8 ||
              b.x !== d.x || b.y !== d.y) {
            st.fs = false;
            enterXpraDesktopFullscreen();
          }
        }
      } catch (e) {}
    }, 2500);
  }

  // 入口=首页且不带 pid：官方页不自动播任何频道；自动播放由渲染层按设置处理。
  win.loadURL(HOME_URL_BASE);

  // 容器（xpra）：按客户端模式定启动几何——智慧屏/移动端整屏（保持原实现），
  // CDE 桌面窗口模式（75% 16:9 居中、鼠标可拖动）。客户端未连接时按画布尺寸
  // 兜底，连上后由轮询按真实模式重算。
  if (IS_CONTAINER) {
    setTimeout(function () {
      try {
        if (!win || win.isDestroyed()) return;
        // 先刷新客户端缓存再算几何，避免用建窗时的陈旧分类决定模式。
        const bootC = getXpraClient(true);
        const bootModeNow = clientMode(bootC);
        const full = displayBounds();
        const capped = containerWinRect(full);
        const isFull = (capped.w === full.w && capped.h === full.h);
        // 客户端模式决定启动几何：智慧屏/移动端整屏（保持原实现不变）；CDE
        // 桌面窗口模式（75% 16:9 居中、鼠标可拖动）。客户端尚未连接时按画布
        // 尺寸兜底：小画布（智慧屏自动拉起）全屏，大画布（CDE）窗口；客户端
        // 连上后由下方轮询按真实模式重算。
        const wantFull = (bootModeNow === 'smart' || bootModeNow === 'mobile' ||
                          (bootModeNow === '' && isFull));
        if (wantFull) {
          st.fsSeed = null;
          st.fsSaved = { x: full.x, y: full.y, width: full.w, height: full.h };
          st.fs = true;
          // 客户端未连接时按小画布兜底成全屏：标记 fsAuto，客户端连上若是
          // CDE 桌面则自动降回窗口模式（智慧屏/移动端仍保持整屏）。
          st.fsAuto = (bootModeNow === '');
          st.fsDefault = true;
          st.fsUserExit = false;
          setPos(full.x, full.y, full.w, full.h);
        } else {
          // CDE 桌面：外层客户端窗口保持普通窗口（catlink-wrap 不再自动全屏），
          // 应用窗口铺满客户端画布 → 用户只看到 LPTV 内容，不露出远程桌面的黑边。
          // 75% 几何仅记录为恢复窗口：F11/控制栏退出全屏时可回到可拖的 75% 窗口。
          const r0 = desktopWindowRect(full);
          st.fsSeed = null;
          st.fsSaved = { x: r0.x, y: r0.y, width: r0.w, height: r0.h };
          st.fs = true;
          st.fsDefault = true;
          st.fsAuto = false;
          st.fsUserExit = false;
          setPos(full.x, full.y, full.w, full.h);
        }
        // 常驻断言：全屏意图（智慧屏/用户显式全屏；CDE 默认铺满客户端画布）钉整屏；
        // CDE 用户 F11 退出全屏后的窗口模式只校尺寸并保留拖动位置（越界时钳回屏内）。
        // isFull 每 tick 按当前屏幕重算。
        var fix = setInterval(function () {
          try {
            if (!win || win.isDestroyed()) { clearInterval(fix); return; }
            const f2 = displayBounds();
            if (st.fs || (st.fsDefault && !st.fsUserExit)) {
              st.fs = true;
              setPos(f2.x, f2.y, f2.w, f2.h);
              return;
            }
            if (st.max) return;   // 用户已最大化：不要用 75% 恢复几何覆盖
            if (st.float) return; // 浮窗：尺寸由 float_toggle/set_float_height 管，别覆盖
            // 窗口模式：只校尺寸（16:9 75% 目标）、保留用户当前位置（不抢拖动）。
            const d2 = containerWinRect(f2);
            const b = win.getBounds();
            const r2 = clampRectPos({ x: b.x, y: b.y, w: d2.w, h: d2.h }, f2);
            if (b.width !== r2.w || b.height !== r2.h || b.x !== r2.x || b.y !== r2.y) {
              setPos(r2.x, r2.y, r2.w, r2.h);
            }
          } catch (e) { clearInterval(fix); }
        }, 3000);
        // 客户端连上会改变虚拟屏尺寸(display-metrics-changed)：重新探测客户端并校几何。
        // 智慧屏(isFull)钉 (0,0)；桌面端只校尺寸、保留位置。
        try {
          const { screen } = require('electron');
          screen.on('display-metrics-changed', function () {
            try {
              if (!win || win.isDestroyed()) return;
              const c = getXpraClient(true);  // 客户端连接/尺寸变化 → 重新探测
              if (st.float) return;           // 浮窗尺寸独立，不跟随虚拟屏重铺
              const full3 = displayBounds();
              const d3 = containerWinRect(full3);
              // 模式分离用完整客户端分类（UA/platform 优先），不用 display 是否
              // Chromium：CDE 桌面客户端同样是 Chromium，只看 display 会把两端
              // 判成同一模式。智慧屏（TV）永远整屏；CDE 桌面保持窗口模式。
              if (isSmartClient(c)) {
                st.fs = true;                 // 智慧屏始终整屏，UI 图标同步为全屏
                st.fsAuto = false;
                st.fsUserExit = false;
                setPos(full3.x, full3.y, full3.w, full3.h);
                return;
              }
              // 启动时按"未连接+小画布"兜底的全屏，客户端确认是 CDE 桌面后
              // 保持铺满客户端画布（外层客户端窗口是普通窗口，不再露出桌面黑边）；
              // 75% 几何留给 F11 退出全屏时恢复。
              if (st.fsAuto && !st.fsUserExit && clientMode(c) === 'desktop') {
                st.fsAuto = false;
                st.fs = true;
                st.fsDefault = true;
                if (!st.fsSaved) st.fsSaved = desktopWindowRect(full3);
                setPos(full3.x, full3.y, full3.w, full3.h);
                return;
              }
              if (st.fs || (st.fsDefault && !st.fsUserExit)) {  // 全屏意图：按新虚拟屏重新铺满
                st.fs = true;
                setPos(full3.x, full3.y, full3.w, full3.h);
                return;
              }
              const b = win.getBounds();
              // CDE 桌面：只校尺寸、保留用户位置；画布缩小导致越界时钳回屏内，
              // 保证窗口始终完整可见可拖动。
              const r3 = clampRectPos({ x: b.x, y: b.y, w: d3.w, h: d3.h }, full3);
              if (b.width !== r3.w || b.height !== r3.h || b.x !== r3.x || b.y !== r3.y) {
                setPos(r3.x, r3.y, r3.w, r3.h);
              }
            } catch (e) {}
          });
        } catch (e) {}
      } catch (e) {}
    }, 1500);
  }

  // CDE 桌面（catlink/lightos 盒子直启：IS_CONTAINER=false，但仍是远程桌面）：
  // 建窗仍按本地桌面 1280x720（可拖），窗口显示后进入系统全屏态覆盖整块屏幕
  // （setBounds 会被工作区 struts 钳住），初始窗口记为一次性恢复几何。
  // 由 ready-to-show（及 2.5s 兜底）调用 enterXpraDesktopFullscreen()。
}

// ---- 环境诊断：容器判定 / GPU 后端 / xpra 配置 快照 + 卡顿判定 ----------
// 供 cde 卡顿排查：启动即打印到容器日志，也可随时 window.lptv.diag() 拉取。
// 判定维度：
//   isContainer=false 且存在 xpra socket → 容器优化分支(EGL/GPU光栅化)未启用, 软件合成卡顿主因
//   gl_renderer 含 swiftshader/software → 实际软渲染
//   xpra.conf 缺 vaapih264enc → 可能软件 x264 编码; quality>=80 → YUV444P 掉帧风险
function xpraSocketDisplay() {
  try {
    const ds = fs.readdirSync('/run/xpra').filter((n) => /^\d+$/.test(n));
    if (ds.length) return ':' + ds[0];
  } catch (e) {}
  return process.env.LPTV_DISPLAY || (process.env.DISPLAY || '');
}

async function collectDiag() {
  const d = { t: Date.now(), verdict: [] };
  d.isContainer = !!IS_CONTAINER;
  d.env = {
    CATLINK_APP_ID: process.env.CATLINK_APP_ID || '',
    XPRA_ENCODING_STRICT_MODE: process.env.XPRA_ENCODING_STRICT_MODE || '',
    XPRA_SCALING: process.env.XPRA_SCALING || '',
    LPTV_DISPLAY: process.env.LPTV_DISPLAY || '',
    DISPLAY: process.env.DISPLAY || '',
  };
  d.xpraSocket = xpraSocketDisplay();
  try { d.dri = fs.existsSync('/dev/dri') ? fs.readdirSync('/dev/dri') : []; } catch (e) { d.dri = []; }
  d.driRender = DRI_RENDER;
  if (!DRI_RENDER && !IS_CONTAINER) d.verdict.push('无可用 DRI render 节点(renderD*) → 本地桌面软件合成(能渲染, 仅可能卡顿)');
  try { d.gpuFeature = app.getGPUFeatureStatus(); } catch (e) { d.gpuFeature = { error: String(e && e.message || e) }; }
  const gc = d.gpuFeature && d.gpuFeature.gpu_compositing;
  const vd = d.gpuFeature && d.gpuFeature.video_decode;
  d.gpuCompositing = gc; d.videoDecode = vd;
  if (gc === 'disabled_software' || !gc) d.verdict.push('gpu_compositing=' + gc + '→软件合成(拖动时CPU瓶颈风险)');
  else if (gc !== 'available') d.verdict.push('gpu_compositing=' + gc);
  if (vd === 'disabled_software' || !vd) d.verdict.push('video_decode=' + vd + '→视频软解(CPU负载↑)');
  else if (vd !== 'enabled') d.verdict.push('video_decode=' + vd);
  try {
    const gi = await app.getGPUInfo('basic');
    const dev = (gi && (gi.gpuDevice || gi.devices) && (gi.gpuDevice || gi.devices)[0]) || {};
    d.gpu = { vendorString: dev.vendorString || '', deviceString: dev.deviceString || '' };
  } catch (e) { d.gpu = { error: String(e && e.message || e) }; }
  const gr = d.gpuFeature && (d.gpuFeature.gl_renderer || '');
  if (gr && /swiftshader|software|llvmpipe|softpipe/i.test(String(gr))) {
    d.verdict.push('gl_renderer=' + gr + ' → 软件渲染/合成, 卡顿主因');
  }
  // 页面加载状态：区分白屏是"页面没加载(网络/域名)"还是"渲染问题"
  try {
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      d.page = {
        url: win.webContents.getURL() || '',
        title: win.webContents.getTitle() || '',
        loading: win.webContents.isLoading(),
        fail: pageLoad.fail,
        finished: !!pageLoad.finish,
      };
      if (!pageLoad.finish) d.verdict.push('did-finish-load 未触发 → 页面未加载成功(白屏主因候选)');
      if (pageLoad.fail) d.verdict.push('did-fail-load: code=' + pageLoad.fail.code + ' ' + pageLoad.fail.desc + ' url=' + pageLoad.fail.url);
    }
  } catch (e) {}
  // xpra.conf 是懒猫容器 launcher(90_lzc.conf)写入的产物，只在容器模式有意义。
  // 本地桌面/手动运行 AppImage 时该文件必然不存在，若无条件判缺失会误报
  // "90_lzc.conf 未安装"（false positive，手动运行 diag 每次必现，实测确认）。
  // 因此仅容器模式读取并给出判定；本地桌面保留 d.xpraConf 字段但不报 verdict。
  try {
    d.xpraConf = fs.existsSync('/tmp/catlink/xpra.conf') ? fs.readFileSync('/tmp/catlink/xpra.conf', 'utf8') : '';
  } catch (e) { d.xpraConf = ''; }
  if (IS_CONTAINER) {
    if (d.xpraConf) {
      if (!/video-encoders\s*=\s*vaapih264enc/.test(d.xpraConf)) d.verdict.push('xpra.conf 缺 video-encoders=vaapih264enc → 可能回落软件 x264');
      if (/quality\s*=\s*(8[0-9]|9[0-9]|100)/.test(d.xpraConf)) d.verdict.push('xpra quality>=80 → YUV444P→软件x264掉帧风险');
    } else {
      d.verdict.push('xpra.conf 缺失(/tmp/catlink/xpra.conf) → 90_lzc.conf 未安装');
    }
  }
  if (!d.verdict.length) d.verdict.push('未发现明显异常');
  return d;
}

// ===========================================================================
// ipcMain：inject.js 桥契约（25 方法，一一对应 bridge.py）
// ===========================================================================
function registerIpc() {
  const h = (name, fn) => ipcMain.handle('lptv:' + name, async (_e, ...args) => {
    try { return await fn(...args); }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // ---- 启动动画守卫：preload 每次导航都会跑，只放行第一次真实页面 ----------
  // preload 传 location.href，仅当是 http(s) 且首次才授予 splash（about:blank
  // 等初始文档不消费名额）。返回 {first} 告知 preload 是否展示启动动画。
  let splashShown = false;
  ipcMain.on('lptv:env', (e) => {
    // preload 在 document-start 同步取环境（splash/inject 需要立即判定智慧屏/移动端）
    // smart/mobile 由 xpra 客户端判定，而非 IS_CONTAINER（容器对两者都 true）。
    const c = getXpraClient();
    const smart = IS_CONTAINER && isSmartClient(c);
    const mobile = IS_CONTAINER && isMobileClient(c);
    // 记录页面 document-start 真正读到的客户端模式，供轮询判定是否需要 reload
    // （页面环境与当前客户端一致则绝不 reload，避免首页已显示又被整页重载）。
    pageEnvMode = IS_CONTAINER ? clientMode(c) : '';
    try {
      // ua 是移动/智慧屏识别的主信号：打印出来（截断），UA 键名写错时才不会
      // 静默回退，真机排查可直接对照。
      const desc = c ? (c.display + ' ' + c.w + 'x' + c.h + ' platform=' + (c.platform || '') +
        ' ua=' + String(c.ua || '').slice(0, 90)) : 'none';
      console.log('[LPTV-env] client=' + desc + ' mobile=' + mobile + ' smart=' + smart + ' mode=' + pageEnvMode);
    } catch (e) {}
    e.returnValue = { smart: smart, mobile: mobile, container: !!IS_CONTAINER, isTv: smart };
  });

  ipcMain.on('lptv:claim-splash', (e, href) => {
    const isReal = typeof href === 'string' && /^https?:/i.test(href);
    let first = false;
    if (isReal && splashReloadPending) {
      // reload（模式切换/GPU 崩溃/移动端重连）：重新授予 splash 覆盖 reload 全程。
      first = true;
      splashReloadPending = false;
    } else if (isReal && !splashShown) {
      first = true;
      splashShown = true;
    }
    e.returnValue = { first };
  });

  // ---- 窗口 ----------------------------------------------------------------
  h('minimize', () => {
    if (!win) return { ok: false };
    if (win.isMinimized()) { win.restore(); return { ok: true, minimized: false }; }
    win.minimize();
    return { ok: true, minimized: true };
  });

  h('maximize_toggle', () => {
    if (!win) return { ok: false, maximized: st.max };
    if (st.max) {
      const b = st.maxSaved;
      if (b) setPos(b.x, b.y, b.width, b.height);
      st.max = false;
      fsDiag('maximize_restore', { saved: b });
    } else {
      st.maxSaved = win.getBounds();
      const d = fitTvRect(workAreaBounds());
      setPos(d.x, d.y, d.w, d.h);
      st.max = true;
      fsDiag('maximize_enter', { target: d });
    }
    return { ok: true, maximized: st.max };
  });

  h('is_maximized', () => ({ ok: true, maximized: st.max }));

  // 全屏/浮窗互斥辅助：退出全屏/浮窗并恢复保存的窗口几何。
  // fullscreen_toggle/float_toggle 进入新模式前先退出旧模式，保证焦点互斥
  // （全屏时浮窗按钮不 active，反之亦然），且恢复链正确：浮窗→全屏→退出
  // 全屏回到浮窗前窗口，全屏→浮窗→退出浮窗回到全屏前窗口。
  function exitFullscreen() {
    if (!win) return null;
    st.fsUserExit = true;   // 用户显式退出：周期断言不再强行拉回全屏
    st.fsAuto = false;
    const b = st.fsSaved;
    const bw = b && (b.width || b.w), bh = b && (b.height || b.h);
    if (IS_XPRA_DESKTOP && !IS_CONTAINER) {
      // 真 WM：必须退出系统全屏态（setBounds 会被工作区 struts 钳到任务栏以上），
      // 再由 WM 恢复原窗口；随后按记录的几何校正位置/尺寸。
      try { win.setFullScreen(false); } catch (e) {}
      st.fs = false;
      if (b) setTimeout(function () {
        try { if (!st.fs && win && !win.isDestroyed()) setPos(b.x, b.y, bw, bh); } catch (e) {}
      }, 300);
      return b;
    }
    // 容器(无 WM)：直接用 setBounds 恢复窗口几何；启动即全屏（无真实窗口几何）
    // 时退到当前屏幕居中的 75% 窗口，避免退出全屏得到一个"伪全屏"大窗口。
    const r = windowRestoreRect();
    st.fsSaved = r;
    setPos(r.x, r.y, r.width, r.height);
    st.fs = false;
    return r;
  }
  function exitFloat() {
    if (!win) return;
    if (st.floatSaved) {
      const b = st.floatSaved;
      setPos(b.x, b.y, b.width, b.height);
      if (!b.wasOnTop) win.setAlwaysOnTop(false);
      st.floatSaved = null;
    }
    st.float = false;
  }

  h('fullscreen_toggle', () => {
    if (!win) return { ok: false, fullscreen: st.fs };
    if (st.fs) {
      const b = exitFullscreen();
      fsDiag('fullscreen_restore', { saved: b });
    } else {
      // 桌面全屏: 容器内铺满整块虚拟桌面（不做 16:9 收敛——画布由渲染层按
      // 视口非等比拉伸铺满，零黑边）；catlink/lightos 盒子直启（真 WM）用系统
      // 全屏态（setBounds 会被工作区 struts 钳到任务栏以上）；本地桌面仍用
      // 16:9 窗口。全屏/浮窗互斥: 从浮窗切全屏时先退出浮窗，退出全屏回到浮窗前的窗口。
      if (st.float) exitFloat();
      st.fsSaved = st.fsSeed || win.getBounds();
      st.fsSeed = null;
      st.fsAuto = false;       // 用户显式进入全屏，不再被桌面模式自动降回窗口
      st.fsUserExit = false;   // 进入全屏：恢复"默认保持全屏"意图
      const raw = displayBounds();
      if (IS_XPRA_DESKTOP && !IS_CONTAINER) {
        fsDiag('fullscreen_before', { target: raw, saved: st.fsSaved });
        st.fs = true;
        win.setFullScreen(true);
        if (st.pin) win.setAlwaysOnTop(true);
        fsDiag('fullscreen_after');
      } else {
        const d = IS_CONTAINER ? raw : fitTvRect(raw);
        fsDiag('fullscreen_before', { target: d, saved: st.fsSaved });
        setPos(d.x, d.y, d.w, d.h);
        if (st.pin) win.setAlwaysOnTop(true);
        st.fs = true;
        fsDiag('fullscreen_after');
      }
    }
    return { ok: true, fullscreen: st.fs };
  });

  h('is_fullscreen', () => ({ ok: true, fullscreen: st.fs }));

  h('float_toggle', () => {
    if (!win) return { ok: false, floating: st.float, float: st.float };
    if (st.float) {
      exitFloat();
    } else {
      // 全屏/浮窗互斥: 从全屏切浮窗时先退出全屏，退出浮窗回到全屏前的窗口。
      if (st.fs) exitFullscreen();
      const b = win.getBounds();
      st.floatSaved = { x: b.x, y: b.y, width: b.width, height: b.height, wasOnTop: st.pin };
      const d = workAreaBounds();
      setPos(d.x + d.w - FLOAT_W - 10, d.y + d.h - FLOAT_H - 10, FLOAT_W, FLOAT_H);
      win.setAlwaysOnTop(true);
      st.float = true;
    }
    return { ok: true, floating: st.float, float: st.float };
  });

  h('is_float', () => ({ ok: true, floating: st.float, float: st.float }));

  // 悬窗: 按视频宽高比调节窗口尺寸(只显示画面大小, 无黑边), 右下锚定。
  // 宽高来自 syncFloatHeight 的自适应计算(视频保持比例, 16:9→480×270,
  // 竖版→270×480), 高度钳在工作区 65% 内, 宽不超 FLOAT_W, 避免超长浮窗。
  h('set_float_height', (h, w) => {
    if (!win || !st.float) return { ok: false };
    const d = workAreaBounds();
    let hh = parseInt(h, 10);
    if (!(hh > 0)) hh = FLOAT_H;
    let ww = parseInt(w, 10);
    if (!(ww > 0)) ww = FLOAT_W;
    hh = Math.max(120, Math.min(Math.round(d.h * 0.65), hh));
    ww = Math.max(180, Math.min(FLOAT_W, ww));
    setPos(d.x + d.w - ww - 10, d.y + d.h - hh - 10, ww, hh);
    return { ok: true, height: hh, width: ww };
  });

  h('pin_toggle', () => {
    st.pin = !st.pin;
    if (win) win.setAlwaysOnTop(st.pin);
    return { ok: true, pinned: st.pin };
  });

  h('pin_state', () => ({ ok: true, pinned: st.pin }));

  h('resize_win', (w, hh) => {
    if (!win) return { ok: false };
    const b = win.getBounds();
    setPos(b.x, b.y, Math.max(parseInt(w, 10) || 360, 360), Math.max(parseInt(hh, 10) || 220, 220));
    return { ok: true };
  });

  h('win_pos', () => {
    if (!win) return { ok: false };
    const b = win.getBounds();
    return { ok: true, x: b.x, y: b.y };
  });

  h('move_win', (x, y) => {
    if (!win) return { ok: false };
    const b = win.getBounds();
    setPos(parseInt(x, 10) || b.x, parseInt(y, 10) || b.y, b.width, b.height);
    return { ok: true };
  });

  // 拖动轨迹诊断：记录每个 mousemove 的鼠标 screen 坐标/按钮状态与目标窗口位置，
  // 判断拖动是否 1:1 跟手、是否被 e.buttons 检查误杀、是否 IPC 延迟。
  h('drag_trace', (info) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(path.join(DATA_DIR, 'lptv.drag.log'),
        `[${new Date().toISOString()}] trace ${JSON.stringify(info)}\n`);
    } catch (e) {}
    return { ok: true };
  });

  // ---- 窗口拖动（_NET_WM_MOVERESIZE 原生拖拽 + 漂移看门狗）----------------
  // xpra 无真实 WM，Electron -webkit-app-region:drag 不落 _NET_WM_MOVERESIZE，
  // 故用 send_moveresize.py（ctypes+libX11 XSendEvent）发 _NET_WM_MOVERESIZE 给根窗口，
  // xpra 服务端 (x11/models/base.py) 转发给客户端(浏览器)执行 begin_move_drag，
  // 客户端随后在浏览器内跟踪鼠标拖动 —— 与微信/Chromium CSD 完全一致。
  // 优点：拖拽逻辑全在客户端(浏览器)本地执行，无 JS setBounds 的 IPC 往返延迟，
  // 窗口跟手、流畅（此前 js-setBounds 每帧 IPC→setBounds→xpra→客户端 往返致滞后）。
  //
  // 已知风险：xpra 6.5 HTML5 客户端 move_drag 曾有坐标漂移/缩放 bug（拖动后窗口
  // resize(1280x720→2160x1337) 并漂到屏幕外(-6417,-1080)，界面消失，a181fab 据此
  // 弃用原生拖拽）。该 bug 在用户浏览器无法从服务端根治，故加"漂移看门狗"：
  // 拖动期间轮询 getBounds，一旦检测到窗口 resize 或飞到屏幕外，立即恢复拖动前
  // 边界（防窗口消失）。若看门狗未触发（多数情况），原生拖拽即流畅跟手。
  let _dragWatchdog = null;
  function startDragWatchdog(saved) {
    if (_dragWatchdog) { clearInterval(_dragWatchdog); _dragWatchdog = null; }
    const startTime = Date.now();
    let stableCount = 0;
    let lastPos = { x: saved.x, y: saved.y };
    _dragWatchdog = setInterval(() => {
      if (!win || win.isDestroyed()) { clearInterval(_dragWatchdog); _dragWatchdog = null; return; }
      const b = win.getBounds();
      const now = Date.now();
      // 漂移检测：尺寸明显变化（原生拖拽不改变尺寸）或位置飞到屏幕外（远超正常拖动范围）。
      const resized = Math.abs(b.width - saved.width) > 50 || Math.abs(b.height - saved.height) > 50;
      const flew = Math.abs(b.x - saved.x) > 3000 || Math.abs(b.y - saved.y) > 3000
                 || b.x < -1500 || b.y < -1500;
      if (resized || flew) {
        console.error('[LPTV] drag drift detected, restoring bounds ' + JSON.stringify(saved));
        try {
          fs.appendFileSync(path.join(DATA_DIR, 'lptv.drag.log'),
            `[${new Date().toISOString()}] drift detected b=${JSON.stringify(b)} saved=${JSON.stringify(saved)} restoring\n`);
        } catch (e) {}
        setPos(saved.x, saved.y, saved.width, saved.height);
        clearInterval(_dragWatchdog); _dragWatchdog = null;
        return;
      }
      // 稳定检测：连续 3 次(≈300ms)位置无变化 → 拖动结束，立即停止看门狗。
      // （原 6 次/600ms + 20s 超时会致看门狗在拖动后长期残留，播放时每 100ms
      //   getBounds 干扰渲染 → 不流畅；拖动结束应尽快停。）
      if (b.x === lastPos.x && b.y === lastPos.y && b.width === saved.width && b.height === saved.height) {
        if (++stableCount >= 3) { clearInterval(_dragWatchdog); _dragWatchdog = null; return; }
      } else {
        stableCount = 0;
        lastPos = { x: b.x, y: b.y };
      }
      // 超时兜底：4 秒后停止（拖动一般 <4s，防看门狗残留干扰播放）。
      if (now - startTime > 4000) { clearInterval(_dragWatchdog); _dragWatchdog = null; }
    }, 100);
  }

  h('begin_window_drag', (x, y, button) => {
    if (!win || win.isDestroyed()) return { ok: false, err: 'no-window' };
    try {
      const b = win.getBounds();
      const sx = parseInt(x, 10) || 0;
      const sy = parseInt(y, 10) || 0;
      // 取窗口原生 XID（_NET_WM_MOVERESIZE 需发到具体窗口）。
      const buf = win.getNativeWindowHandle();
      if (!buf || buf.length < 4) return { ok: false, err: 'no-native-handle' };
      let xid = buf.readUInt32LE(0);
      if (xid === 0 && buf.length >= 8) xid = buf.readUInt32LE(4);
      if (!xid) return { ok: false, err: 'no-xid' };
      const script = app.isPackaged
        ? path.join(process.resourcesPath, 'send_moveresize.py')
        : path.join(__dirname, 'send_moveresize.py');
      // 诊断：记录拖动调用（保留 drag.log 链路便于定位）。
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(path.join(DATA_DIR, 'lptv.drag.log'),
          `[${new Date().toISOString()}] begin_window_drag x=${x} y=${y} btn=${button} mode=netwm start=${b.x},${b.y} xid=0x${xid.toString(16)}\n`);
      } catch (e) {}
      // 启动漂移看门狗：检测客户端 move_drag 漂移/缩放 bug，一旦窗口 resize 或
      // 飞到屏幕外立即恢复拖动前边界（防窗口消失）。
      startDragWatchdog({ x: b.x, y: b.y, width: b.width, height: b.height });
      // 发 _NET_WM_MOVERESIZE（原生客户端拖拽，跟手、无 JS setBounds 的 IPC 往返滞后）。
      runPython(script,
        ['0x' + xid.toString(16),
         String(sx), String(sy), String(parseInt(button, 10) || 1)],
        { env: Object.assign({}, process.env, { LPTV_DRAG_LOG: path.join(DATA_DIR, 'lptv.drag.log') }) },
        (err, py) => {
          if (err) {
            console.error('[LPTV] _NET_WM_MOVERESIZE send failed:', err.message);
            try { fs.appendFileSync(path.join(DATA_DIR, 'lptv.drag.log'), `[${new Date().toISOString()}] python FAIL py=${py} err=${err.message}\n`); } catch (e) {}
          } else {
            console.log('[LPTV] _NET_WM_MOVERESIZE sent xid=0x' + xid.toString(16));
            try { fs.appendFileSync(path.join(DATA_DIR, 'lptv.drag.log'), `[${new Date().toISOString()}] python OK py=${py} xid=0x${xid.toString(16)}\n`); } catch (e) {}
          }
        });
      return { ok: true, xid };
    } catch (e) {
      console.error('[LPTV] _NET_WM_MOVERESIZE error:', e);
      return { ok: false, err: String(e && e.message || e) };
    }
  });

  h('close_window', () => { if (win) win.destroy(); return { ok: true }; });

  // ---- 数据 ----------------------------------------------------------------
  h('get_channels', () => channelsList());

  h('get_version', () => {
    // About 版本号与 AppImage 文件名同步(如 LPTV-linux-x86_64-1.0.0.AppImage):
    // 打包变更版本后 About 页自动跟随, 不依赖 package.json。非 AppImage 环境回落。
    const ap = process.env.APPIMAGE || '';
    const m = ap.match(/LPTV-.+?(\d+\.\d+\.\d+)\.AppImage$/i);
    return (m && m[1]) || app.getVersion();
  });

  h('get_asset_image', (name, prefix) => {
    let p;
    if (prefix === 'logos') {
      p = path.join(frontendDir(), 'logos', name);
    } else {
      const allowed = ['icon.png', 'lptv.png', 'home-bg.jpg'];
      if (allowed.indexOf(name) < 0) return { ok: false, error: 'asset not allowed', src: '' };
      p = assetFile(name);
    }
    if (!fs.existsSync(p)) return { ok: false, error: 'asset missing', src: '' };
    const ext = path.extname(name).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
    try {
      const b64 = fs.readFileSync(p).toString('base64');
      return { ok: true, src: 'data:' + mime + ';base64,' + b64 };
    } catch (e) { return { ok: false, error: String(e && e.message || e), src: '' }; }
  });

  // 环境诊断快照（cde 卡顿排查, window.lptv.diag()）
  h('diag', collectDiag);

  // ---- UI 状态（跨启动，路径与旧版一致）------------------------------------
  h('get_ui_state', () => {
    const s = stateLoad();
    const out = { ok: true };
    for (const k of STATE_WHITELIST) if (k in s) out[k] = s[k];
    return out;
  });

  h('set_ui_state', (patch) => {
    let p = patch;
    if (typeof patch === 'string') { try { p = JSON.parse(patch); } catch (e) { return { ok: false, error: 'bad patch' }; } }
    if (!p || typeof p !== 'object') return { ok: false, error: 'bad patch' };
    stateSave(p);
    return { ok: true };
  });

  // ---- 录制（分块 base64 → webm 落盘，与 bridge.py 同协议）------------------
  let recSeq = 0;
  const recFiles = {}; // rid -> { path, fd }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  h('rec_open', (chname) => {
    recSeq++;
    const rid = new Date().toISOString().replace(/[:.]/g, '') + '_' + recSeq;
    const d = saveDirs().rec;
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* fallthrough */ }
    const dir = fs.existsSync(d) ? d : DATA_DIR;
    const fp = path.join(dir, rid + '.webm');
    try {
      const fd = fs.openSync(fp, 'w');
      recFiles[rid] = { path: fp, fd };
      return { ok: true, id: rid };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  h('rec_append', (rid, b64) => {
    const ent = recFiles[rid];
    if (!ent) return { ok: false, error: 'no such rec' };
    try {
      let s = b64;
      if (s.indexOf(',') >= 0) s = s.split(',', 2)[1];
      const buf = Buffer.from(s, 'base64');
      fs.writeSync(ent.fd, buf);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  h('rec_close', (rid) => {
    const ent = recFiles[rid];
    if (!ent) return { ok: false, error: 'no such rec' };
    delete recFiles[rid];
    try { fs.closeSync(ent.fd); } catch (e) {}
    return { ok: true, path: ent.path };
  });

  // ---- 截图（base64 → PNG 落盘）--------------------------------------------
  h('shot_save', (chname, b64) => {
    if (!b64) return { ok: false, error: 'empty image' };
    let s = b64;
    if (s.indexOf(',') >= 0) s = s.split(',', 2)[1];
    let data;
    try { data = Buffer.from(s, 'base64'); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    if (!data.length) return { ok: false, error: 'empty image' };
    const d = saveDirs().shot;
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = 'LPTV_' + String(chname || '直播').replace(/[/\\]/g, '_') + '_' + ts + '.png';
    const fp = path.join(d, name);
    try {
      fs.writeFileSync(fp, data);
      return { ok: true, name, path: fp };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  h('get_save_dirs', () => { const d = saveDirs(); return { ok: true, rec: d.rec, shot: d.shot }; });

  h('pick_save_dir', (kind) => {
    const cur = saveDirs()[kind === 'rec' ? 'rec' : 'shot'];
    return dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cur })
      .then((r) => {
        let newDir = cur;
        if (!r.canceled && r.filePaths && r.filePaths[0]) newDir = r.filePaths[0];
        const custom = readJson(RECDIR_FILE) || {};
        custom[kind === 'rec' ? 'rec' : 'shot'] = newDir;
        writeJson(RECDIR_FILE, custom);
        return { ok: true, dir: newDir };
      });
  });

  h('open_save_dir', (kind) => {
    const d = saveDirs()[kind === 'rec' ? 'rec' : 'shot'];
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
    shell.openPath(d);
    return { ok: true, dir: d };
  });

  // ---- 自启动（XDG autostart，同现状）--------------------------------------
  function autostartDesktopPath() {
    return path.join(xdgConfigDir(), 'autostart', 'lptv.desktop');
  }
  function selfExec() {
    // 打包后指向自身 AppImage；开发时指向 electron 启动器
    if (process.env.APPIMAGE) return { exe: process.env.APPIMAGE, cwd: path.dirname(process.env.APPIMAGE) };
    if (app.isPackaged) return { exe: process.execPath, cwd: path.dirname(process.execPath) };
    return { exe: process.execPath, cwd: __dirname };
  }

  h('autostart_state', () => {
    const on = fs.existsSync(autostartDesktopPath());
    return { ok: true, enabled: on, on };
  });

  h('autostart_set', (on) => {
    const dp = autostartDesktopPath();
    if (on) {
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      const { exe, cwd } = selfExec();
      const content =
        '[Desktop Entry]\nType=Application\nName=LPTV\nComment=LPTV 远程电视\n' +
        'Exec=' + exe + '\nPath=' + cwd + '\nTerminal=false\nX-GNOME-Autostart-enabled=true\n';
      try { fs.writeFileSync(dp, content, 'utf-8'); } catch (e) { return { ok: false, on: false, error: String(e && e.message || e) }; }
      return { ok: true, on: true };
    } else {
      try { if (fs.existsSync(dp)) fs.unlinkSync(dp); } catch (e) { return { ok: false, on: true, error: String(e && e.message || e) }; }
      return { ok: true, on: false };
    }
  });

  // ---- 备用（bridge 保留，Electron 下直接页面内转发）------------------------
  h('play_channel', (pid) => {
    if (win) win.webContents.executeJavaScript("window.__lptv && window.__lptv.switchChannel('" + pid + "')").catch(() => {});
    return { ok: true };
  });

  h('copy_m3u8', (pid) => {
    return win.webContents.executeJavaScript("window.__lptv ? window.__lptv.getPlayUrl() : ''")
      .then((url) => {
        if (url) { try { require('electron').clipboard.writeText(url); } catch (e) {} }
        return { ok: !!url, url: url || '' };
      })
      .catch(() => ({ ok: false, url: '' }));
  });
}

// ===========================================================================
// 单实例锁未获(第二个实例)时不创建窗口：app.quit() 已在前面触发，若 whenReady
// 仍 resolve 会闪一个窗口再退出。仅持锁实例注册启动流程。
if (gotSingleInstanceLock) app.whenReady().then(() => {
  // 视频流畅度：防系统"空闲/低电"判定后降帧、休眠显示器导致视频被拖慢。
  // 保持电源唤醒策略，持续阻止休眠（对容器/流媒体无副作用，进程退出自动释放）。
  try { powerSaveBlocker.start('prevent-display-sleep'); } catch (e) {}
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
