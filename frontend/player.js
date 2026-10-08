/* LPTV Web — HLS.js 播放引擎 + XHR 代理 + 伪造官方侧栏
 *
 * 职责：
 *   1. 自建 video 元素 (喂给 inject.js 的 acquireOfficial/录制/黑帧看门狗)
 *   2. 监听 LPTV.playUrl 变化 → 初始化/切换 hls.js 实例 (同源 /api/stream)
 *   3. 伪造 .tv-main-con-r-list-left 侧栏 + 事件委托:
 *      inject.js 的 switchChannel 会 findOfficialButton() -> 命中伪造按钮 -> click()
 *      事件委托捕获阶段拦下, 转成 请求 /api/live_info (触发 hook/OSD/lastPid/EPG)
 *      + hls.js 播 /api/stream, 而不是 location.href 导航离开
 *   4. 代理 EPG XHR 请求到服务端 (避免 CORS, 兼容旧路径)
 */
(function () {
  if (window.__lptvPlayerInitialized) return;
  window.__lptvPlayerInitialized = true;

  var hls = null;
  var video = null;
  var wrapper = document.getElementById('lptv-web-wrapper');

  /* ---------- 视频元素 ---------- */
  function getVideo() {
    if (!video) {
      video = document.createElement('video');
      video.id = 'lptv-web-video';
      video.controls = false;
      video.autoplay = true;
      video.muted = false;
      video.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;z-index:1;';
      wrapper.appendChild(video);
    }
    return video;
  }

  /* ---------- HLS 播放 ---------- */
  function destroyHls() {
    if (hls) { hls.destroy(); hls = null; }
  }

  function playManifest(manifestUrl) {
    if (!manifestUrl) return;
    // 支持绝对 http(s) 或同源相对路径 (/api/stream...)
    if (manifestUrl.indexOf('http') !== 0 && manifestUrl.indexOf('/') !== 0) return;
    destroyHls();
    var v = getVideo();

    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 30, maxMaxBufferLength: 60 });
      hls.loadSource(manifestUrl);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, function (_e, data) {
        console.log('[Player] manifest parsed, levels:', data.levels.length);
        v.play().catch(function () {});
      });
      hls.on(Hls.Events.ERROR, function (_e, data) {
        console.warn('[Player] hls error:', data.type, data.details);
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (data.details === 'bufferAddCodecError') {
              // Codec 不被浏览器支持时 recoverMediaError 会死循环, 从源头重建
              console.warn('[Player] codec not supported, restarting hls instance');
              destroyHls();
              var cur = _playingPid;
              if (cur) setTimeout(function () { playManifest('/api/stream?pid=' + encodeURIComponent(cur)); }, 1500);
            } else {
              hls.recoverMediaError();
            }
            break;
          default: destroyHls(); break;
        }
      });
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = manifestUrl;
      v.addEventListener('loadedmetadata', function () { v.play().catch(function () {}); }, { once: true });
    }
  }

  /* ---------- 切台: 触发 hook + 播放 ---------- */
  var _playingPid = '';
  function playChannel(pid) {
    if (!pid || pid === _playingPid) return;
    _playingPid = pid;
    console.log('[Player] playChannel:', pid);
    // 1) 请求 /api/live_info: inject.js 的 hook 会捕获并更新 playUrl/OSD/lastPid/EPG
    try { fetch('/api/live_info?pid=' + encodeURIComponent(pid)).catch(function () {}); } catch (e) {}
    // 2) hls.js 经同源 /api/stream 播放
    playManifest('/api/stream?pid=' + encodeURIComponent(pid));
  }

  /* ---------- 拦截 inject.js 的 location.href 导航兜底 ----------
   * inject.js 的 switchChannel 在 findOfficialButton() 未命中时 (伪造侧栏尚未就绪,
   * 或官方页不存在) 会执行 location.href = "/tv/home?pid=xxx", 导致整页刷新黑屏。
   * 这里包装 location 赋值: 命中 /tv/home?pid= 就转成 playChannel, 不真实跳转。
   */
  (function interceptNav() {
    var realHref = window.location.href;
    try {
      Object.defineProperty(window.location, 'href', {
        set: function (v) {
          var m = String(v).match(/\/tv\/home\?pid=(\d+)/);
          if (m) { playChannel(m[1]); return; }
          // 其余导航放行 (懒猫网关的 file:// 路由同源, 直接赋值可能整页跳走)
          realHref = v;
          try { window.location.assign(v); } catch (e) {}
        },
        get: function () { return realHref; },
        configurable: true,
      });
    } catch (e) {}
    // 兜底: 即使 defineProperty 失败, 也轮询监听 SPA hash/路径变化防呆
  })();

  /* ---------- 启动自动播放 ----------
   * 盒子上没有官方页面, inject.js 启动只设置 currentPid 不会触发播放。
   * 这里轮询 LPTV.currentPid: 一旦有值且未在播, 自动 playChannel。
   */
  var _autoPlayedPid = '';
  var _autoPlayTries = 0;
  setInterval(function () {
    var lptv = window.__lptv;
    if (!lptv || !lptv.currentPid) return;
    if (_autoPlayedPid === lptv.currentPid) return;
    // 等频道数据/伪造侧栏就绪后再触发 (首台依赖 channels)
    if (lptv.channels.length === 0) { if (++_autoPlayTries > 40) _autoPlayTries = 0; return; }
    _autoPlayedPid = lptv.currentPid;
    _autoPlayTries = 0;
    console.log('[Player] auto-play:', lptv.currentPid);
    playChannel(lptv.currentPid);
  }, 500);

  /* ---------- 伪造官方侧栏 (供 inject.js switchChannel 命中) ---------- */
  function buildFakeSidebar() {
    if (document.getElementById('lptv-fake-sidebar')) return;
    var sidebar = document.createElement('div');
    sidebar.id = 'lptv-fake-sidebar';
    sidebar.className = 'tv-main-con-r-list-left';
    sidebar.style.display = 'none';   // 视觉隐藏, 只让 findOfficialButton 命中
    document.body.appendChild(sidebar);

    // 点击事件委托 (捕获阶段, 早于任何官方/页面处理; 不 preventDefault 的原生行为也拦掉)
    sidebar.addEventListener('click', function (e) {
      var t = e.target;
      var el = t && t.closest ? t.closest('div[data-pid]') : null;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      playChannel(el.getAttribute('data-pid'));
    }, true);

    function fill(chs) {
      if (!Array.isArray(chs) || !chs.length) return false;
      var html = '';
      chs.forEach(function (c) {
        var official = c.official || c.name.split(' ')[0].replace('CCTV-', 'CCTV') || '';
        html += '<div data-pid="' + (c.pid || '') + '">' + official + '</div>';
      });
      sidebar.innerHTML = html;
      console.log('[Player] fake sidebar ready:', chs.length, 'channels');
      return true;
    }

    // 优先用 inject.js 已加载的 __lptv.channels (数据与 findOfficialButton 的反查表一致)
    var lptv = window.__lptv;
    if (lptv && lptv.channels && lptv.channels.length) {
      if (fill(lptv.channels)) return;
    }
    // 否则回退 fetch /api/channels
    fetch('/api/channels').then(function (r) { return r.json(); }).then(function (chs) {
      if (fill(chs)) return;
    }).catch(function (e) {
      console.warn('[Player] channels fetch failed:', e);
      setTimeout(buildFakeSidebar, 3000);
    });
  }

  /* ---------- EPG XHR 代理 (兼容旧路径, 新路径 inject 已直连 /api/epg/raw) ---------- */
  (function proxyEpgXHR() {
    var OrigOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var u = String(url || '');
      if (u.indexOf('/api/yspepg/program/') >= 0) {
        var m = u.match(/\/api\/yspepg\/program\/(\d+)\/(\d{8})/);
        if (m) {
          var localUrl = '/api/epg/raw?pid=' + encodeURIComponent(m[1]) + '&ymd=' + encodeURIComponent(m[2]);
          console.log('[Player] EPG proxy:', u.slice(0, 60), '->', localUrl);
          return OrigOpen.call(this, method, localUrl);
        }
      }
      return OrigOpen.apply(this, arguments);
    };
  })();

  /* ---------- 监听 LPTV.playUrl 变化 → 兜底驱动 hls.js ---------- */
  var _lastPlayUrl = '';
  setInterval(function () {
    var lptv = window.__lptv;
    if (!lptv || !lptv.playUrl || lptv.playUrl === _lastPlayUrl) return;
    _lastPlayUrl = lptv.playUrl;
    console.log('[Player] playUrl changed:', lptv.playUrl.slice(0, 80));
    var pid = lptv.currentPid || '';
    if (pid && pid !== _playingPid) playChannel(pid);
  }, 500);

  /* 侧栏尽早就绪 (在 inject.js boot 之前) + 立即创建 video 供 acquireOfficial 绑定 */
  function bootstrap() {
    getVideo();
    buildFakeSidebar();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  /* 侧栏随 __lptv.channels 变化同步 (inject.js setChannels/harvest 会增删频道) */
  setInterval(function () {
    var lptv = window.__lptv;
    if (!lptv || !lptv.channels || !lptv.channels.length) return;
    var sb = document.getElementById('lptv-fake-sidebar');
    if (!sb) { buildFakeSidebar(); return; }
    var want = lptv.channels.map(function (c) {
      return (c.official || c.name.split(' ')[0].replace('CCTV-', 'CCTV') || '') + '|' + (c.pid || '');
    }).join('\n');
    var have = sb.textContent.split('\n').filter(function (s) { return s; }).map(function (s) {
      var parts = s.split('|');
      return parts[1];
    }).join('\n');
    // 简单比对 div 数量, 不一致则重建
    if (sb.children.length !== lptv.channels.length) {
      var html = '';
      lptv.channels.forEach(function (c) {
        var official = c.official || c.name.split(' ')[0].replace('CCTV-', 'CCTV') || '';
        html += '<div data-pid="' + (c.pid || '') + '">' + official + '</div>';
      });
      sb.innerHTML = html;
      console.log('[Player] fake sidebar synced:', lptv.channels.length, 'channels');
    }
  }, 1500);

  window.__lptvPlayer = {
    playManifest: playManifest,
    playChannel: playChannel,
    getVideo: getVideo,
    destroy: destroyHls,
  };
})();
