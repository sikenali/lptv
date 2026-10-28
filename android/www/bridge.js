/**
 * bridge.js — LPTV Android WebView 桥接层
 *
 * 对应 Electron preload.js 的 window.lptv API。
 * 使用 Capacitor @capacitor/filesystem 读取 bundles 中的 channels.json 和 logos/。
 *
 * 加载顺序: 本文件在 index.html 中排在 inject.js 之前，
 *           inject.js 的 initChannels() 调用 window.lptv.get_channels() 时
 *           channels 正在异步读取，读取完成后通过缓存返回。
 */
(function () {
  if (window.__lptvBridge) return;
  window.__lptvBridge = true;

  var FS = (window.Capacitor && window.Capacitor.Filesystem) || null;
  var STORAGE = (window.Capacitor && window.Capacitor.Storage) || null;

  // ---- channels ----
  var _channels = null;

  /* 读取 bundles 中的 channels.json (android_asset/www/channels.json) */
  function loadChannels() {
    if (!FS) return Promise.resolve([]);
    var PATH = '/android_asset/www/channels.json';
    return FS.readFile({ path: PATH, type: 'text' }).then(function (r) {
      try { _channels = JSON.parse(r.data); } catch (e) { _channels = []; }
      return _channels || [];
    }).catch(function (e) {
      console.warn('[LPTV] 读取 channels.json 失败:', e);
      _channels = [];
      return [];
    });
  }

  // ---- logos (data URI 缓存) ----
  var _logoCache = {};   // pid -> data URI

  /* 从 android_asset/www/logos/{pid}.webp 读取为 data URI */
  function loadLogo(pid) {
    if (_logoCache[pid]) return Promise.resolve(_logoCache[pid]);
    if (!FS || !/^\d+$/.test(String(pid))) return Promise.resolve('');
    var PATH = '/android_asset/www/logos/' + pid + '.webp';
    return FS.readFile({ path: PATH, type: 'arraybuffer' }).then(function (r) {
      var b64 = arrayBufferToBase64(r.data);
      _logoCache[pid] = 'data:image/webp;base64,' + b64;
      return _logoCache[pid];
    }).catch(function () { return ''; });
  }

  /* ArrayBuffer → base64 字符串 */
  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000;
    var str = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var end = Math.min(i + chunkSize, bytes.length);
      var chunk = bytes.subarray(i, end);
      // 手动拼接避免 String.fromCharCode 溢出
      for (var j = 0; j < chunk.length; j++) {
        str += String.fromCharCode(chunk[j]);
      }
    }
    return btoa(str);
  }

  // ---- UI state (localStorage 持久化, 跨启动) ----
  var _uiState = null;
  var LS_KEY = 'lptv.cfg.v3';

  function loadState() {
    if (!STORAGE) return Promise.resolve({});
    return STORAGE.get({ key: LS_KEY }).then(function (r) {
      try { _uiState = JSON.parse(r.value || '{}'); } catch (e) { _uiState = {}; }
      return _uiState || {};
    }).catch(function () { _uiState = {}; return {}; });
  }

  function saveState(patch) {
    if (!STORAGE || !patch) return Promise.resolve();
    _uiState = Object.assign(_uiState || {}, patch);
    return STORAGE.set({ key: LS_KEY, value: JSON.stringify(_uiState) });
  }

  // ---- bridge API ----
  window.lptv = {
    // 数据
    get_channels: function () {
      return Promise.resolve(_channels || []);
    },
    get_version: function () {
      return Promise.resolve('1.0.0');
    },
    get_asset_image: function (name, prefix) {
      if (prefix === 'logos' && /^\d+$/.test(name)) {
        return loadLogo(name);
      }
      // icon.png / lptv.png (兜底)
      if (name && !/\//.test(name)) {
        return loadLogo('_asset_' + name.replace('.', '_'));
      }
      return Promise.resolve({ ok: false, src: '' });
    },
    // UI 状态
    get_ui_state: function () {
      return loadState().then(function (st) { return { ok: true }.concat(st) || { ok: true }; });
    },
    set_ui_state: function (patch) {
      try {
        if (typeof patch === 'string') patch = JSON.parse(patch);
        return saveState(patch);
      } catch (e) { return Promise.reject(e); }
    },
    // 频道切换 (更新 iframe src)
    play_channel: function (pid) {
      var iframe = document.getElementById('lptv-iframe');
      if (iframe && pid) {
        iframe.src = 'https://www.yangshipin.cn/tv/home?pid=' + encodeURIComponent(String(pid));
      }
      return Promise.resolve({ ok: true });
    },
    // 截图 (WebView 截图 → base64 PNG, 落盘到公共下载目录)
    shot_save: function (chname, _b64data) {
      try {
        var img = document.createElement('img');
        img.src = _b64data;
        img.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 1280;
          canvas.height = img.naturalHeight || 720;
          canvas.getContext('2d').drawImage(img, 0, 0);
          var dataUrl = canvas.toDataURL('image/png');
          var filename = (chname || '直播') + '_' + Date.now() + '.png';
          var downloadDir = window.LPTV_DOWNLOAD_DIR || 'Download';
          var link = document.createElement('a');
          link.download = downloadDir + '/' + filename;
          link.href = dataUrl;
          link.click();
        };
      } catch (e) {}
      return Promise.resolve({ ok: true });
    },
    // 录制 (Android WebView 暂不支持 MediaRecorder 捕获官方 iframe 视频流)
    rec_open: function (_chname) {
      return Promise.resolve({ ok: false, error: 'Android 暂不支持录制' });
    },
    rec_append: function (_rid, _b64) {
      return Promise.resolve({ ok: false, error: 'rec_append' });
    },
    rec_close: function (_rid) {
      return Promise.resolve({ ok: false, error: 'rec_close' });
    },
    // 窗口管理 (Android 单窗口, 无 minimize/maximize/float)
    minimize: function () { return Promise.resolve({ ok: false }); },
    maximize_toggle: function () { return Promise.resolve({ ok: false, maximized: false }); },
    is_maximized: function () { return Promise.resolve({ ok: true, maximized: false }); },
    fullscreen_toggle: function () {
      // 尝试全屏
      try {
        var el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      } catch (e) {}
      return Promise.resolve({ ok: true, fullscreen: false });
    },
    is_fullscreen: function () { return Promise.resolve({ ok: true, fullscreen: false }); },
    float_toggle: function () { return Promise.resolve({ ok: false }); },
    is_float: function () { return Promise.resolve({ ok: true, floating: false }); },
    pin_toggle: function () { return Promise.resolve({ ok: false }); },
    pin_state: function () { return Promise.resolve({ ok: true, pinned: false }); },
    resize_win: function () { return Promise.resolve({ ok: false }); },
    win_pos: function () { return Promise.resolve({ ok: true, x: 0, y: 0, w: 0, h: 0 }); },
    move_win: function () { return Promise.resolve({ ok: false }); },
    close_window: function () { return Promise.resolve({ ok: false }); },
    // 存储目录
    get_save_dirs: function () {
      return Promise.resolve({
        ok: true,
        rec:  '/storage/emulated/0/Download/LPTV/录制',
        shot: '/storage/emulated/0/Download/LPTV/截图'
      });
    },
    pick_save_dir: function () { return Promise.resolve({ ok: false }); },
    open_save_dir: function () { return Promise.resolve({ ok: false }); },
    // 自启动
    autostart_state: function () { return Promise.resolve({ ok: true, value: false }); },
    autostart_set: function () { return Promise.resolve({ ok: true }); },
    // 备用
    copy_m3u8: function () { return Promise.resolve({ ok: false }); },
  };

  // 启动: 预读取 channels + 图标
  loadChannels();
  loadState();
})();
