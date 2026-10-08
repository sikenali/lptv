/* LPTV Web API 适配器
 * 将 pywebview API 调用透明转换为 fetch 请求
 * inject.js 无需任何修改
 *
 * API base:
 *   - PC/同源模式: 直接用相对路径 /api/* (默认)
 *   - 盒子 WebView 注入官方页模式: 页面在官方域名下运行, 相对路径会指向官方站,
 *     必须用绝对地址访问本应用服务端。base 由注入引导脚本通过
 *     window.__LPTV_API_BASE 提供 (如 https://lptv.xxx)。
 */
(function () {
  if (window.__lptvBridge) return;

  var base = (function () {
    if (window.__LPTV_API_BASE) return window.__LPTV_API_BASE;
    return window.location.origin + '';
  })();

  function apiUrl(p) {
    return base + p;
  }

  function fetchJson(url, options) {
    return fetch(apiUrl(url), options).then(function (r) { return r.json(); });
  }

  window.__lptvBridge = {
    get_channels: function () {
      return fetchJson('/api/channels');
    },

    get_ui_state: function () {
      return fetchJson('/api/state');
    },
    set_ui_state: function (patch) {
      return fetchJson('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: patch,
      });
    },

    play_channel: function (pid) {
      return fetchJson('/api/play?pid=' + encodeURIComponent(pid));
    },

    get_manifest_url: function (pid) {
      return '/api/manifest?pid=' + encodeURIComponent(pid);
    },

    shot_save: function (name, b64) {
      return fetchJson('/api/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, b64: b64 }),
      });
    },

    copy_m3u8: function (url) {
      if (navigator.clipboard) {
        return navigator.clipboard.writeText(url || '');
      }
      return Promise.resolve(false);
    },

    get_asset_image: function (name) {
      return fetch(apiUrl('/api/assets/' + encodeURIComponent(name)))
        .then(function (r) {
          if (!r.ok) throw new Error('not found');
          return r.blob();
        })
        .then(function (blob) {
          return URL.createObjectURL(blob);
        })
        .then(function (url) {
          return { ok: true, src: url };
        });
    },

    get_version: function () {
      return Promise.resolve('1.0.0-web');
    },

    get_save_dirs: function () {
      return Promise.resolve({ ok: true, rec: '--', shot: '--' });
    },
    pick_save_dir: function (kind) {
      return Promise.resolve({ ok: false, error: 'Not supported in web mode' });
    },
    open_save_dir: function (kind) {
      return Promise.resolve();
    },

    rec_open: function (chname) {
      return Promise.resolve({ ok: false, error: 'Recording handled client-side' });
    },
    rec_append: function (id, b64) {
      return Promise.resolve({ size: 0 });
    },
    rec_close: function (id) {
      return Promise.resolve({ ok: true });
    },
    rec_list: function () {
      return Promise.resolve([]);
    },

    minimize: function () { return Promise.resolve(); },
    maximize_toggle: function () { return Promise.resolve({ maximized: false }); },
    is_maximized: function () { return Promise.resolve({ maximized: false }); },
    close_window: function () { window.close(); return Promise.resolve(); },
    resize_win: function (w, h) { return Promise.resolve(); },
    drag_win: function (x, y) { return Promise.resolve(); },
    pin_toggle: function () {
      var video = document.querySelector('video');
      if (video && video.requestPictureInPicture) {
        return video.requestPictureInPicture().then(function () {
          return { pinned: true };
        }).catch(function () {
          return { pinned: false };
        });
      }
      return Promise.resolve({ pinned: false });
    },
    pin_state: function () {
      return Promise.resolve({ pinned: !!document.pictureInPictureElement });
    },
    fullscreen_toggle: function () {
      var el = document.documentElement;
      if (el.requestFullscreen) {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          el.requestFullscreen().catch(function () {});
        }
      }
      return Promise.resolve({
        ok: true,
        fullscreen: !!document.fullscreenElement
      });
    },
    is_fullscreen: function () {
      return Promise.resolve({ fullscreen: !!document.fullscreenElement });
    },
    float_toggle: function () {
      return Promise.resolve({ ok: false });
    },
    is_float: function () {
      return Promise.resolve({ floating: false });
    },

    autostart_state: function () { return Promise.resolve({ enabled: false }); },
    autostart_set: function (enabled) { return Promise.resolve({ ok: true }); },
  };

  window.pywebview = window.pywebview || {};
  window.pywebview.api = window.__lptvBridge;
  window.pywebview.platform = 'web';
  window.pywebview.token = 'web-token';
})();
