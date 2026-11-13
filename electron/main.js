/* ---------------------------------------------------------------------------
 * LPTV Electron 主进程
 *
 * 替代「pywebview + 真 Chrome/CDP」两包方案：Electron 官方构建带 H.264 专有
 * 编解码器（ffmpeg_branding=Chrome），YSP（H.264-over-MSE）直接能播。
 *
 * 职责（与迁移文档 electron-migration.md 对齐）：
 *   - BrowserWindow 创建（无边框 1920x1080）+ 窗口控制（原生 API）
 *   - ipcMain.handle('lptv:xxx') 实现 inject.js 桥契约（25 个方法）
 *   - did-finish-load 时注入 frontend/inject.js（协议层已改 window.lptv.*）
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

// ---- xpra 容器判定 --------------------------------------------------------
// 同一个 AppImage 有两种运行环境：
//   1. 懒猫容器：run.sh 注入 CATLINK_APP_ID / XPRA_*，launch_lptv.sh 注入
//      LPTV_DISPLAY。窗口挂在 xpra 上，corral 会给 setBounds 请求叠加一个
//      winOrigin 偏移，getBounds() != setBounds()，必须校准。
//   2. 本地桌面：真 WM，getBounds() == setBounds()，无需任何偏移。
// 若在本地桌面仍按容器逻辑去 getBounds() 校准，拖拽会以初始窗口位置为原点
// 换算，窗口一路漂向 (0,0)，拖动失灵。因此用环境变量区分两种模式。
// 环境变量可能缺失（裸 cde 容器/手动起 xpra 不注入），再认"容器/流媒体会话"
// 独有的文件系统标记：/lzcapp（懒猫容器根）、/run/xpra/<n>/socket（xpra 会话）。
// 注意不要用 /run/catlink —— 它在懒猫宿主也存在，会误判容器，让本地桌面走
// winOrigin 校准导致拖拽漂移。纯 Linux 桌面/宿主真实桌面无上述标记 → 判定本地。
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

// ---- 资源路径（开发/打包兼容）------------------------------------------
function frontendDir() {
  // 打包后 extraResources 放在 resourcesPath/frontend；开发时用 ../frontend
  if (app.isPackaged) return path.join(process.resourcesPath, 'frontend');
  return path.join(__dirname, '..', 'frontend');
}
function assetFile(name) { return path.join(frontendDir(), name); }

// ---- 固定 UA：与 Windows 版一致（CMG 环境判定最稳）-----------------------
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

// ---- YSP首页 ----------------------------------------------------------
const HOME_URL_BASE = 'https://www.yangshipin.cn/tv/home?pid=';
const DEFAULT_PID = '600001859'; // CCTV-1 综合

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
if (fs.existsSync(GPU_BROKEN_MARKER)) {
  app.commandLine.appendSwitch('disable-gpu');
  console.log('[LPTV] 检测到 gpu.broken 标记 → 本次禁用 GPU(软件合成)');
  gpuDisabled = true;
}
// cde/catlink 容器：Xdummy 环境下 use-gl=egl 触发 ANGLE Passthrough FATAL crash，
// 且 Xdummy 无 DRI/EGL context 可绑定，任何 enable-gpu-rasterization 都会崩。
// 容器内强制走软件合成（已验证稳定），视频解码由 VA-API 硬解独立于合成路径不受影响。
// 本地桌面(独立 AppImage, GPU 正常)不受此分支影响。
if (IS_CONTAINER) {
  app.commandLine.appendSwitch('disable-gpu');
  console.log('[LPTV] cde/catlink 容器 → 禁用GPU(软件合成，Xdummy无EGL支持)');
} else if (DRI_RENDER) {
  // 本地桌面有 DRI 节点 → 保持硬件加速（含 VAAPI 硬解视频）
  console.log('[LPTV] 检测到 DRI 节点 ' + DRI_RENDER + ' → 硬件加速保持启用');
} else {
  // 无 DRI 节点 → 软件渲染（普通 Linux 桌面/无 GPU 环境）
  app.commandLine.appendSwitch('disable-gpu');
  console.log('[LPTV] 无 DRI 节点 → 强制软件合成');
}
let gpuCrashReloaded = false;
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
const st = { max: false, fs: false, float: false, pin: false, floatSaved: null, maxSaved: null, fsSaved: null };
// xpra 坐标偏移：getBounds() = setBounds(请求值) + winOrigin。
// xpra seamless 的 corral 会把窗口放到初始位置 (winOrigin)，导致 Electron 的
// setBounds 请求坐标与实际 getBounds 恒差一个 winOrigin。所有 setBounds 需减去它，
// 否则 move_win/float 每步多走一个 winOrigin，窗口乱跳、拖动失灵（已实测 +100 → +3556）。
// 仅容器模式需要校准；本地桌面 getBounds()==setBounds()，winOrigin 恒为 {0,0}，
// 否则 move_win 会把窗口位置误当成偏移，拖拽时窗口漂向 (0,0)。
let winOrigin = null;
// 页面加载诊断：did-fail-load / did-finish-load 记录，供 collectDiag 判断白屏是
// 页面没加载(网络/域名)还是渲染问题。
const pageLoad = { fail: null, finish: null };
function calibrateOrigin() {
  if (winOrigin !== null) return;
  try {
    winOrigin = IS_CONTAINER ? win.getBounds() : { x: 0, y: 0 };
  } catch (e) { winOrigin = { x: 0, y: 0 }; }
}

// ---- 虚拟屏实际尺寸查询 -------------------------------------------------
// Electron 的 screen 模块在窗口创建时(虚拟屏初始 ~1600)就缓存了 display，
// xpra resize-display=auto 在客户端连接后把虚拟屏调到 1920，但 Electron
// **不感知**（screen.on 不触发，getPrimaryDisplay().bounds 仍返回 1600）。
// 因此全屏/最大化的目标尺寸不能依赖 Electron 缓存，须直接查询 X 服务器：
// xrandr (首选) → xdpyinfo → Electron 缓存 → env 兜底。
function queryActualScreenSize() {
  // 1. xrandr: "Screen 0: ... current 1920 x 1080 ..."
  try {
    const { execSync } = require('child_process');
    const out = execSync('xrandr --query 2>/dev/null', { timeout: 3000, encoding: 'utf8' });
    const m = out.match(/current\s+(\d+)\s+x\s+(\d+)/);
    if (m) {
      const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch (e) {}
  // 2. xdpyinfo: "dimensions:    1920x1080 pixels"
  try {
    const { execSync } = require('child_process');
    const out = execSync('xdpyinfo 2>/dev/null | grep dimensions', { timeout: 3000, encoding: 'utf8' });
    const m = out.match(/dimensions:\s+(\d+)x(\d+)/);
    if (m) {
      const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch (e) {}
  // 3. Electron 缓存（可能陈旧，仅作兜底）
  try {
    const { screen } = require('electron');
    const b = screen.getPrimaryDisplay().bounds;
    if (b.width > 0 && b.height > 0) return { w: b.width, h: b.height };
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

// setPos: 目标位置用 getBounds 坐标（win_pos 返回值），内部换算回 setBounds 请求。
function setPos(x, y, w, h) {
  if (!win) return;
  calibrateOrigin();
  win.setBounds({ x: Math.round(x - winOrigin.x), y: Math.round(y - winOrigin.y),
                  width: Math.max(Math.round(w), 1), height: Math.max(Math.round(h), 1) });
}

// ---- 全屏/窗口几何诊断 ---------------------------------------------------
// 排查 cde 容器全屏错位：记录 Electron 看到的屏幕 bounds/workArea、窗口实际
// bounds、winOrigin，以及 setBounds 请求值。落 DATA_DIR/lptv.fs.log + 容器日志。
// 目的：确认 screen.getPrimaryDisplay() 报的是 xpra 虚拟屏还是客户端真实分辨率，
// 以及 winOrigin 模型 getBounds()=setBounds()+winOrigin 是否成立。
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

function readStatePid() {
  const s = stateLoad();
  return s.lastPid || DEFAULT_PID;
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
  // （最流畅、焦点正确）；容器/xpra(无 WM) 用 begin_window_drag + send_moveresize.py 主动发
  // _NET_WM_MOVERESIZE（send_moveresize.py 在宿主 KWin 上实测不响应，故本地桌面必须走原生）。
  const pre = 'window.__LPTV_IS_CONTAINER=' + (IS_CONTAINER ? 'true' : 'false') + ';\n';
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
  const sw = (disp.workAreaSize && disp.workAreaSize.width) || 1920;
  const sh = (disp.workAreaSize && disp.workAreaSize.height) || 1080;
  const scale = Math.min(sw / 1280, sh / 720, 1.0); // 上限 1.0x：不超过 1280x720
  const W = Math.max(360, Math.round(1280 * scale));
  const H = Math.max(220, Math.round(720 * scale));
  win = new BrowserWindow({
    width: W,
    height: H,
    x: disp.workArea ? Math.round(disp.workArea.x + (disp.workArea.width - W) / 2) : undefined,
    y: disp.workArea ? Math.round(disp.workArea.y + (disp.workArea.height - H) / 2) : undefined,
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
      // 视频流畅度：禁止按窗口遮挡/隐藏节流渲染（xpra/浮窗下遮挡判定不可靠，
      // 默认会降 ~1fps 甚至暂停视频 → 假卡顿）。配合 disable-renderer-backgrounding。
      backgroundThrottling: false,
    },
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
      const tmp = path.join(os.tmpdir(), 'lptv-argb-' + process.pid + '-' + xid + '.txt');
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
  const _iconRetry = (n) => {
    try {
      if (!win || win.isDestroyed()) return;
      writeNetWmIcon(win);
      if (n < 5) setTimeout(() => _iconRetry(n + 1), 800);   // ~4s 内共 5 次，覆盖重建/迟映射
    } catch (e) {}
  };
  win.once('ready-to-show', () => _iconRetry(0));
  win.on('show', () => { try { writeNetWmIcon(win); } catch (e) {} });
  setTimeout(() => { try { if (win && !win.isDestroyed()) writeNetWmIcon(win); } catch (e) {} }, 6000);

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
      if (/^https?:\/\//.test(win.webContents.getURL())) injectUi();
    } catch (e) {}
  });
  win.webContents.on('did-finish-load', () => { pageLoad.finish = Date.now(); clearGpuBrokenMarker(); });
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

  win.once('ready-to-show', () => {
    // xpra corral 已把窗口放到初始位置：把它记为坐标偏移基准（仅容器模式，
    // 且 ready-to-show 的校准优先于早前 setPos 的粗校）。本地桌面恒为 {0,0}。
    try {
      if (IS_CONTAINER) winOrigin = win.getBounds();
      else if (winOrigin === null) winOrigin = { x: 0, y: 0 };
    } catch (e) {}
    fsDiag('ready_to_show');
    try { if (!win.isDestroyed()) win.show(); } catch (e) {}
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
        if (st.fs) {
          const d = displayBounds();
          fsDiag('display_changed_' + why, { disp: d, fullscreen: true });
          setPos(d.x, d.y, d.w, d.h);
        } else if (st.max) {
          const d = workAreaBounds();
          fsDiag('display_changed_' + why, { disp: d, maximized: true });
          setPos(d.x, d.y, d.w, d.h);
        }
      } catch (e) {}
    };
    screen.on('display-metrics-changed', () => reapplyGeometry('metrics'));
    screen.on('display-added', () => reapplyGeometry('added'));
    screen.on('display-removed', () => reapplyGeometry('removed'));
    // 注意：不再加 setInterval 轮询（execSync xrandr 阻塞主进程每 2s 一次，
    // 与渲染进程的 IPC 轮询(2-3s)叠加 → 规律卡顿）。全屏/最大化的目标尺寸
    // 由 displayBounds()/workAreaBounds() 按需 queryActualScreenSize() 获取
    // （用户点全屏时查 xrandr 得实际 1920），无需周期性阻塞查询。
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
      try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch (e) {}
    }, 2500);
  }

  win.loadURL(HOME_URL_BASE + readStatePid());
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
  try {
    d.xpraConf = fs.existsSync('/tmp/catlink/xpra.conf') ? fs.readFileSync('/tmp/catlink/xpra.conf', 'utf8') : '';
  } catch (e) { d.xpraConf = ''; }
  if (d.xpraConf) {
    if (!/video-encoders\s*=\s*vaapih264enc/.test(d.xpraConf)) d.verdict.push('xpra.conf 缺 video-encoders=vaapih264enc → 可能回落软件 x264');
    if (/quality\s*=\s*(8[0-9]|9[0-9]|100)/.test(d.xpraConf)) d.verdict.push('xpra quality>=80 → YUV444P→软件x264掉帧风险');
  } else {
    d.verdict.push('xpra.conf 缺失(/tmp/catlink/xpra.conf) → 90_lzc.conf 未安装');
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
  ipcMain.on('lptv:claim-splash', (e, href) => {
    const isReal = typeof href === 'string' && /^https?:/i.test(href);
    const first = !splashShown && isReal;
    if (first) splashShown = true;
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
      const d = workAreaBounds();
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
    const b = st.fsSaved;
    if (b) setPos(b.x, b.y, b.width, b.height);
    st.fs = false;
    return b;
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
      // 桌面全屏: 铺满整个桌面(display bounds, 覆盖任务栏区)
      // 全屏/浮窗互斥: 从浮窗切全屏时先退出浮窗，退出全屏回到浮窗前的窗口。
      if (st.float) exitFloat();
      st.fsSaved = win.getBounds();
      const d = displayBounds();
      fsDiag('fullscreen_before', { target: d, saved: st.fsSaved });
      setPos(d.x, d.y, d.w, d.h);
      if (st.pin) win.setAlwaysOnTop(true);
      st.fs = true;
      fsDiag('fullscreen_after');
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

  // ---- 窗口拖动（与 rwx/微信同机制：应用主动发 _NET_WM_MOVERESIZE）------------
  // xpra 无真实 WM，Electron -webkit-app-region:drag 不落 _NET_WM_MOVERESIZE，
  // JS setBounds 又受 winOrigin 偏移影响。这里在渲染层按下顶栏时，直接经
  // send_moveresize.py（ctypes+libX11 XSendEvent）发 _NET_WM_MOVERESIZE 给根窗口，
  // xpra 服务端 (x11/models/base.py) 收到后转发给客户端(Windows)执行 begin_move_drag，
  // 客户端随后跟踪鼠标完成拖动 —— 与微信完全一致，且不受坐标/偏移校准影响。
  h('begin_window_drag', (x, y, button) => {
    if (!win || win.isDestroyed()) return { ok: false, err: 'no-window' };
    try {
      const buf = win.getNativeWindowHandle();
      if (!buf || buf.length < 4) return { ok: false, err: 'no-native-handle' };
      let xid = buf.readUInt32LE(0);
      if (xid === 0 && buf.length >= 8) xid = buf.readUInt32LE(4);
      if (!xid) return { ok: false, err: 'no-xid' };
      const script = app.isPackaged
        ? path.join(process.resourcesPath, 'send_moveresize.py')
        : path.join(__dirname, 'send_moveresize.py');
      // 诊断：每次拖动调用都落盘，盒子侧 cat DATA_DIR/lptv.drag.log 即可定位
      // 拖动链路断在哪一环（IPC 是否到达 / XID / python / XSendEvent res）。
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(path.join(DATA_DIR, 'lptv.drag.log'),
          `[${new Date().toISOString()}] begin_window_drag x=${x} y=${y} btn=${button} xid=0x${xid.toString(16)} script=${script}\n`);
      } catch (e) {}
      runPython(script,
        ['0x' + xid.toString(16),
         String(parseInt(x, 10) || 0), String(parseInt(y, 10) || 0),
         String(parseInt(button, 10) || 1)],
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
      p = path.join(path.dirname(assetFile('icon.png')), '..', 'logos', name);
    } else {
      const allowed = ['icon.png', 'lptv.png'];
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
app.whenReady().then(() => {
  // 视频流畅度：防系统"空闲/低电"判定后降帧、休眠显示器导致视频被拖慢。
  // 保持电源唤醒策略，持续阻止休眠（对容器/流媒体无副作用，进程退出自动释放）。
  try { powerSaveBlocker.start('prevent-display-sleep'); } catch (e) {}
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
