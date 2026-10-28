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
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, screen } = require('electron');
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

// ---- xpra 容器判定 --------------------------------------------------------
// 同一个 AppImage 有两种运行环境：
//   1. 懒猫容器：run.sh 注入 CATLINK_APP_ID / XPRA_*，launch_lptv.sh 注入
//      LPTV_DISPLAY。窗口挂在 xpra 上，corral 会给 setBounds 请求叠加一个
//      winOrigin 偏移，getBounds() != setBounds()，必须校准。
//   2. 本地桌面：真 WM，getBounds() == setBounds()，无需任何偏移。
// 若在本地桌面仍按容器逻辑去 getBounds() 校准，拖拽会以初始窗口位置为原点
// 换算，窗口一路漂向 (0,0)，拖动失灵。因此用环境变量区分两种模式。
const IS_CONTAINER = !!(
  process.env.CATLINK_APP_ID ||
  process.env.XPRA_ENCODING_STRICT_MODE ||
  process.env.XPRA_SCALING ||
  process.env.LPTV_DISPLAY
);

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
function calibrateOrigin() {
  if (winOrigin !== null) return;
  try {
    winOrigin = IS_CONTAINER ? win.getBounds() : { x: 0, y: 0 };
  } catch (e) { winOrigin = { x: 0, y: 0 }; }
}

function displayBounds() {
  try {
    const { screen } = require('electron');
    const b = screen.getPrimaryDisplay().bounds;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch (e) {
    return { x: 0, y: 0, w: parseInt(process.env.LPTV_SCREEN_W || '1920', 10) || 1920,
             h: parseInt(process.env.LPTV_SCREEN_H || '1080', 10) || 1080 };
  }
}

// setPos: 目标位置用 getBounds 坐标（win_pos 返回值），内部换算回 setBounds 请求。
function setPos(x, y, w, h) {
  if (!win) return;
  calibrateOrigin();
  win.setBounds({ x: Math.round(x - winOrigin.x), y: Math.round(y - winOrigin.y),
                  width: Math.max(Math.round(w), 1), height: Math.max(Math.round(h), 1) });
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
  win.webContents.executeJavaScript(inject).catch((e) => {
    console.error('[LPTV] inject failed:', e && e.message);
  });
}

// ---- 窗口控制 -------------------------------------------------------------
function createWindow() {
  // 窗口上限 = 屏幕可用区：1920x1080 是期望值，但容器/小屏会被裁剪，
  // 一旦窗口大于可见屏幕，底部/右缘的 hover 触发带（CTRL_ZONE/EPG_EDGE）落到
  // 屏幕外，控制栏/节目单永远滑不出来 → 必须按屏幕尺寸收敛。
  // 基准 1280x720，按屏幕宽度等比缩放 (最高 1920)，保证高 DPI 屏幕也合适
  const disp = screen.getPrimaryDisplay();
  const sw = (disp.workAreaSize && disp.workAreaSize.width) || 1920;
  const sh = (disp.workAreaSize && disp.workAreaSize.height) || 1080;
  const scale = Math.min(sw / 1280, sh / 720, 1.5); // 最大 1.5x 倍率
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
    // 立即显示：ready-to-show 才 show 会让 xpra 在首次绘制前看不到窗口，
    // 远程端"已投射"却长时间无画面。splash 与底色一致，无闪白，尽早映射。
    show: true,
    title: 'LPTV',
    icon: assetFile('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      sandbox: false,
    },
  });

  // 窗口伪装（对应 --class=LPTV / WM_NAME / _NET_WM_ICON，xpra SPA 才能显示任务栏图标）
  app.setName('LPTV');
  win.setTitle('LPTV');
  win.setMenuBarVisibility(false);
  // 显式设窗口图标：构造 icon 选项在无 WM 容器里不写 _NET_WM_ICON（实测为空），
  // 显式 setIcon 才落到 _NET_WM_ICON，任务栏/窗口才会显示 LPTV 图标而非 Chrome。
  try {
    const ico = nativeImage.createFromPath(assetFile('icon.png'));
    if (!ico.isEmpty() && typeof win.setIcon === 'function') win.setIcon(ico);
  } catch (e) {}

  win.webContents.setUserAgent(CHROME_UA);

  // inject 在 load 完成后注入；splash 由 preload 在 document-start 同步处理。
  win.webContents.on('did-finish-load', injectUi);

  win.on('closed', () => { win = null; });

  win.once('ready-to-show', () => {
    // xpra corral 已把窗口放到初始位置：把它记为坐标偏移基准（仅容器模式，
    // 且 ready-to-show 的校准优先于早前 setPos 的粗校）。本地桌面恒为 {0,0}。
    try {
      if (IS_CONTAINER) winOrigin = win.getBounds();
      else if (winOrigin === null) winOrigin = { x: 0, y: 0 };
    } catch (e) {}
    win.show();
  });

  win.loadURL(HOME_URL_BASE + readStatePid());
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
    } else {
      st.maxSaved = win.getBounds();
      const d = displayBounds();
      setPos(d.x, d.y, d.w, d.h);
      st.max = true;
    }
    return { ok: true, maximized: st.max };
  });

  h('is_maximized', () => ({ ok: true, maximized: st.max }));

  h('fullscreen_toggle', () => {
    if (!win) return { ok: false, fullscreen: st.fs };
    if (st.fs) {
      const b = st.fsSaved;
      if (b) setPos(b.x, b.y, b.width, b.height);
      st.fs = false;
    } else {
      st.fsSaved = win.getBounds();
      const d = displayBounds();
      setPos(d.x, d.y, d.w, d.h);
      if (st.pin) win.setAlwaysOnTop(true);
      st.fs = true;
    }
    return { ok: true, fullscreen: st.fs };
  });

  h('is_fullscreen', () => ({ ok: true, fullscreen: st.fs }));

  h('float_toggle', () => {
    if (!win) return { ok: false, floating: st.float, float: st.float };
    if (st.float) {
      if (st.floatSaved) {
        const b = st.floatSaved;
        setPos(b.x, b.y, b.width, b.height);
        if (!b.wasOnTop) win.setAlwaysOnTop(false);
        st.floatSaved = null;
      }
      st.float = false;
    } else {
      const b = win.getBounds();
      st.floatSaved = { x: b.x, y: b.y, width: b.width, height: b.height, wasOnTop: st.pin };
      const d = displayBounds();
      setPos(d.x + d.w - FLOAT_W - 10, d.y + d.h - FLOAT_H - 10, FLOAT_W, FLOAT_H);
      win.setAlwaysOnTop(true);
      st.float = true;
    }
    return { ok: true, floating: st.float, float: st.float };
  });

  h('is_float', () => ({ ok: true, floating: st.float, float: st.float }));

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

  h('close_window', () => { if (win) win.destroy(); return { ok: true }; });

  // ---- 数据 ----------------------------------------------------------------
  h('get_channels', () => channelsList());

  h('get_version', () => app.getVersion());

  h('get_asset_image', (name, prefix) => {
    let p;
    if (prefix === 'logos') {
      p = path.join(path.dirname(assetFile('icon.png')), '..', 'logos', name);
    } else {
      const allowed = ['icon.png'];
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
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
