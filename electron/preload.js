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
  close_window: invoke('close_window'),
  // 数据
  get_channels: invoke('get_channels'),
  get_version: invoke('get_version'),
  get_asset_image: invoke('get_asset_image'),
  get_asset_font: invoke('get_asset_font'),
  // 环境诊断快照（cde 卡顿排查）
  diag: invoke('diag'),
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
 * 启动动画（splash）：document-start 同步建遮罩
 *
 * preload 在页面文档起始处同步执行（早于官方页任何脚本与首帧），隔离世界与
 * 页面共享 DOM —— 直接创建 #lptv-splash 遮罩即可盖住官方页，无需 executeJavaScript
 * 注入（后者排队执行晚于官方页首帧，会闪出YSP裸页）。
 *
 * 只在【首次】真实页面导航展示一次：preload 每次导航都会跑，经
 * 'lptv:claim-splash'（main 侧 splashShown 只放行第一次 http(s)）决定。
 * ------------------------------------------------------------------------- */
function showSplash() {
  try {
    // 初始 about:blank 等非 http(s) 文档不消费名额、不展示
    if (!/^https?:/i.test(String(location.href))) return;
    const claim = ipcRenderer.sendSync('lptv:claim-splash', location.href);
    if (!claim || !claim.first) return;
    const dir = (() => {
      try {
        const { app } = require('electron');
        if (app && app.isPackaged) return path.join(process.resourcesPath, 'frontend');
      } catch (e) {}
      return path.join(__dirname, '..', 'frontend');
    })();
    const b64 = fs.readFileSync(path.join(dir, 'lptv.png')).toString('base64');
    const icon = fs.readFileSync(path.join(dir, 'icon.png')).toString('base64');
    const js = fs.readFileSync(path.join(dir, 'splash.js'), 'utf8');
    if (!js) return;
    window.__LPTV_SPLASH_CFG = {
      banner: 'data:image/png;base64,' + b64,
      icon: 'data:image/png;base64,' + icon,
      title: 'LPTV',
    };
    (0, eval)(js);   // 在隔离世界全局作用域执行 splash.js（其自身为 IIFE）
  } catch (e) {}
}
showSplash();
