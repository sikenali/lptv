/* ---------------------------------------------------------------------------
 * LPTV preload —— contextBridge 暴露 window.lptv 给页面
 *
 * inject.js 原调用 window.pywebview.api.xxx(...)，现改为 window.lptv.xxx(...)。
 * 每个方法 = ipcRenderer.invoke('lptv:xxx', ...)，返回 Promise（与 pywebview
 * 的 JS API 返回 Promise 契约一致，inject.js 的 .then() 用法零改动）。
 * ------------------------------------------------------------------------- */
const { contextBridge, ipcRenderer } = require('electron');

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
