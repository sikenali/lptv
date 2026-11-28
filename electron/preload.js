/* ---------------------------------------------------------------------------
 * LPTV preload —— contextBridge 暴露 window.lptv 给页面
 *
 * inject.js 原调用 window.pywebview.api.xxx(...)，现改为 window.lptv.xxx(...)。
 * 每个方法 = ipcRenderer.invoke('lptv:xxx', ...)，返回 Promise（与 pywebview
 * 的 JS API 返回 Promise 契约一致，inject.js 的 .then() 用法零改动）。
 * ------------------------------------------------------------------------- */
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

function invoke(name) {
  return (...args) => ipcRenderer.invoke('lptv:' + name, ...args);
}

contextBridge.exposeInMainWorld('lptv', {
  // 窗口
  minimize: invoke('minimize'),
  maximize_toggle: invoke('maximize_toggle'),
  is_maximized: invoke('is_maximized'),
  fullscreen_toggle: invoke('fullscreen_toggle'),
  is_fullscreen: invoke('is_fullscreen'),
  float_toggle: invoke('float_toggle'),
  is_float: invoke('is_float'),
  set_float_height: invoke('set_float_height'),
  pin_toggle: invoke('pin_toggle'),
  pin_state: invoke('pin_state'),
  resize_win: invoke('resize_win'),
  win_pos: invoke('win_pos'),
  move_win: invoke('move_win'),
  drag_trace: invoke('drag_trace'),
  begin_window_drag: invoke('begin_window_drag'),
  close_window: invoke('close_window'),
  // 数据
  get_channels: invoke('get_channels'),
  get_version: invoke('get_version'),
  get_asset_image: invoke('get_asset_image'),
  // 环境诊断快照（cde 卡顿排查）
  diag: invoke('diag'),
  // 诊断日志（几何 / 视频健康，落 DATA_DIR/lptv.geo.log、lptv.video.log）
  // UI 状态
  get_ui_state: invoke('get_ui_state'),
  set_ui_state: invoke('set_ui_state'),
  // 录制 / 截图
  rec_open: invoke('rec_open'),
  rec_append: invoke('rec_append'),
  rec_close: invoke('rec_close'),
  shot_save: invoke('shot_save'),
  get_save_dirs: invoke('get_save_dirs'),
  pick_save_dir: invoke('pick_save_dir'),
  open_save_dir: invoke('open_save_dir'),
  // 自启动
  autostart_state: invoke('autostart_state'),
  autostart_set: invoke('autostart_set'),
  // 备用
  play_channel: invoke('play_channel'),
  copy_m3u8: invoke('copy_m3u8'),
});

/* ---------------------------------------------------------------------------
 * 环境标记（同步暴露给页面主世界）
 *
 * 智慧屏（xpra 网页客户端全屏）标记通过 BrowserWindow 的 additionalArguments
 * 传入，preload 在 document-start 即可读到 → splash.js / inject.js 不再等
 * 主进程 dom-ready 注入（那时遮罩计时器早已跑过，判定恒 false）。
 * ------------------------------------------------------------------------- */
try {
  let env = {};
  let err = '';
  try { env = ipcRenderer.sendSync('lptv:env', 0) || {}; } catch (e) { err = String(e && e.message); }
  // 优先用主进程 lptv:env 同步结果：每次导航都重算 smart/mobile，模式变化 reload
  // 后才是权威值。additionalArguments 在建窗时固定，移动端→桌面 reload 后仍带着
  // --lptv-mobile=1，若以其为准会错误保留 mobile。仅当 IPC 失败或键缺失（异常/
  // 旧主进程）才回退 argv。
  const envOk = !err && typeof env.smart === 'boolean';
  const smart = envOk ? env.smart : (process.argv.indexOf('--lptv-smart=1') >= 0);
  const mobile = envOk ? (env.mobile === true) : (process.argv.indexOf('--lptv-mobile=1') >= 0);
  const container = envOk ? (env.container === true) : (smart || mobile);
  try {
    console.log('[LPTV-env] smart=' + smart + ' mobile=' + mobile + ' container=' + container +
      ' src=' + (envOk ? 'env' : 'argv') + (err ? ' err=' + err : ''));
  } catch (e) {}
  // splash.js 在 preload 的隔离世界执行（(0,eval)），读不到 exposeInMainWorld 的
  // 主世界对象，所以隔离世界另存一份；主世界那份给 inject.js 用。
  try { window.__LPTV_ENV = { smart: smart, mobile: mobile, container: container }; } catch (e) {}
  contextBridge.exposeInMainWorld('__LPTV_ENV', {
    smart: smart,
    mobile: mobile,
    container: container,
  });
} catch (e) {
  try { console.log('[LPTV-env] expose ERR ' + (e && e.message)); } catch (_) {}
}

/* ---------------------------------------------------------------------------
 * 启动动画（splash）：document-start 同步建遮罩
 *
 * preload 在页面文档起始处同步执行（早于官方页任何脚本与首帧），隔离世界与
 * 页面共享 DOM —— 直接创建 #lptv-splash 遮罩即可盖住官方页，无需 executeJavaScript
 * 注入（后者排队执行晚于官方页首帧，会闪出YSP裸页）。
 *
 * 只在【首次】真实页面导航展示一次：preload 每次导航都会跑，经
 * 'lptv:claim-splash'（main 侧 splashShown 只放行第一次 http(s)）决定。
 * ------------------------------------------------------------------------- */
function frontendDir() {
  // 注意：preload 运行在渲染进程，require('electron').app 为 undefined
  // （渲染侧不暴露 app 模块），不能像 main.js 那样用 app.isPackaged 判定；
  // 打包后回退到不存在的开发路径会让 icon/splash 读取 ENOENT → 首页 logo 空白。
  // 故改为探测 resourcesPath/frontend 是否存在（打包后 extraResources 落此处，
  // 开发时该目录不存在，回退 ../web）。
  try {
    const pkg = path.join(process.resourcesPath, 'frontend');
    if (fs.existsSync(pkg)) return pkg;
  } catch (e) {}
  return path.join(__dirname, '..', 'web');
}

/* 品牌图标 data URI：主窗口加载的是远程央视频页，inject.js 注入该页后
   <img src="icon.png"> 会相对远程站点解析 → 404（首页 logo 空白）。
   故 preload 读本地 icon.png 转 data URI，暴露给 inject.js 使用。 */
try {
  const iconB64 = fs.readFileSync(path.join(frontendDir(), 'icon.png')).toString('base64');
  contextBridge.exposeInMainWorld('__LPTV_ICON_SRC', 'data:image/png;base64,' + iconB64);
} catch (e) {
  try { contextBridge.exposeInMainWorld('__LPTV_ICON_SRC', ''); } catch (_) {}
}

function showSplash() {
  try {
    // 初始 about:blank 等非 http(s) 文档不消费名额、不展示
    if (!/^https?:/i.test(String(location.href))) return;
    const claim = ipcRenderer.sendSync('lptv:claim-splash', location.href);
    if (!claim || !claim.first) return;
    const dir = frontendDir();
    const icon = fs.readFileSync(path.join(dir, 'icon.png')).toString('base64');
    const js = fs.readFileSync(path.join(dir, 'splash.js'), 'utf8');
    if (!js) return;
    window.__LPTV_SPLASH_CFG = {
      icon: 'data:image/png;base64,' + icon,
      title: 'LPTV',
      quick: true,   // 启动不播加载动画: 深色遮罩在首页就绪后即刻淡出, 直接露首页
    };
    (0, eval)(js);   // 在隔离世界全局作用域执行 splash.js（其自身为 IIFE）
  } catch (e) {}
}

/* ---------------------------------------------------------------------------
 * 启动底衬（防官方页裸闪）—— 任何真实 http(s) 导航（含客户端模式切换 /
 * GPU 崩溃 / 移动端重连触发的 reload，以及切台整页导航）都在 document-start
 * 建深色底衬，盖住官方页首帧，直到 inject.js 的 #lptv-cover / #lptv-root 就位。
 *
 * 为什么必须在这里（而不是等 inject.js）：inject.js 在 dom-ready 才注入，reload
 * 时没有 splash（splash 只授予首次导航），从首帧到 dom-ready 之间官方页（白色
 * 导航条 + 频道侧栏）会裸闪出来 —— 正是「从动画到主界面中间一瞬间出现央视频」
 * 的根因。底衬与 inject.js 的 #lptv-cover 同 id/样式（z 2147483000，低于
 * 视频 2147483001 / root 2147483002），inject.js ensureCover 直接复用，不重复建。
 * 底衬永不主动移除，只盖官方页 UI，不挡视频/root。
 * ------------------------------------------------------------------------- */
function earlyCover() {
  try {
    if (!/^https?:/i.test(String(location.href))) return;
    let done = false;
    const make = () => {
      if (done) return true;
      try {
        const dEl = document.documentElement;
        if (!dEl) return false;
        if (document.getElementById('lptv-cover')) { done = true; return true; }
        const c = document.createElement('div');
        c.id = 'lptv-cover';
        c.setAttribute('data-early', '1');
        c.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#04070d;pointer-events:none;';
        (document.body || dEl).appendChild(c);
        done = true;
        return true;
      } catch (e) { return false; }
    };
    if (make()) return;
    // document-start 时 <html> 通常还没被解析器建出来：用 MutationObserver 在 <html>
    // 出现的瞬间（microtask，早于首帧绘制）建底衬；再加 setTimeout 轮询兜底，
    // 不依赖 rAF（首帧前的 rAF 时机不一定可靠）。
    try {
      const mo = new MutationObserver(() => { if (make()) { try { mo.disconnect(); } catch (e) {} } });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) {}
    let tries = 0;
    (function tick() {
      if (make()) return;
      if (++tries < 400) setTimeout(tick, 5);   // ~2s 上限
    })();
  } catch (e) {}
}
earlyCover();
showSplash();
