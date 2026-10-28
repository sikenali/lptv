/* ---------------------------------------------------------------------------
 * LPTV 启动动画 ——「LPTV」四字母注水填充
 *
 * 由 electron/main.js 在 BrowserWindow 的 dom-ready 时注入（executeJavaScript），
 * 先注入 __LPTV_SPLASH_CFG 再跑本脚本，早于央视频自己的 HTML / JS 解析完成。
 * 因此在导航期间屏幕上始终是本动画，不会闪现央视频裸页。
 *
 * 切台走官方 SPA 的 pushState（window.__lxCctv.switchChannel），不构成新的
 * 文档导航，本脚本不会重复出现。
 *
 * 配置（由 main.js 在本文件之前注入）：
 *   window.__LPTV_SPLASH_CFG = { icon: 'data:image/png;base64,...',
 *                                title: 'LPTV' }
 * --------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.__lxCctvSplash) return;
  window.__lxCctvSplash = true;

  var CFG = window.__LPTV_SPLASH_CFG || {};
  var ICON = CFG.icon || '';
  var TITLE = CFG.title || 'LPTV';
  var MIN_MS = 1000;   // 最短展示时长：快速淡出，直接进播放器（用户要求直达播放界面）
  var MAX_MS = 22000;  // 兜底：视频迟迟不播也淡出，不能卡死

  /* --- 品牌：favicon + 标题 ------------------------------------------------
   * Chrome 用 favicon 生成窗口的 _NET_WM_ICON、用 document.title 生成
   * _NET_WM_NAME / WM_NAME，所以这里改了，窗口列表里的图标和标题才是 LPTV
   * 自己的，而不是央视频的。
   *
   * document.title 在文档起始时就可用；但 head/documentElement 要到解析器
   * 建好之后才存在，favicon link 必须等 DOMContentLoaded 才能挂上去
   * （document-start 时 appendChild 会抛错，被 try 吞掉 → 图标丢失）。
   * --------------------------------------------------------------------- */
  function brandTitle() {
    try { if (document.title !== TITLE) document.title = TITLE; } catch (e) {}
  }
  function brandIcon() {
    if (!ICON) return true;
    try {
      var d = document;
      var host = d.head || d.documentElement;
      if (!host) return false;        // <html> 还没被解析出来，下一帧再来
      var all = d.querySelectorAll('link');
      for (var i = 0; i < all.length; i++) {
        if ((all[i].getAttribute('rel') || '').toLowerCase().indexOf('icon') !== -1) all[i].remove();
      }
      var l = d.createElement('link');
      l.rel = 'icon';
      l.type = 'image/png';
      l.href = ICON;
      host.appendChild(l);
      return true;
    } catch (e) { return false; }
  }
  /* 尽早挂：Chrome 在 --app 窗口建立时取一次 favicon 当窗口图标（_NET_WM_ICON）。
   * document-start 时连 <html> 都还没有，所以用 rAF 轮询，<html> 一出现就挂上，
   * 赶在窗口图标被定格之前。等 DOMContentLoaded 才挂就太晚了。 */
  function pumpIcon() {
    if (!brandIcon()) requestAnimationFrame(pumpIcon);
  }
  brandTitle();
  pumpIcon();

  /* --- 动画层 -------------------------------------------------------------- */
  function build() {
    var st = document.createElement('style');
    st.id = 'lx-splash-style';
    st.textContent = [
      '#lx-splash{position:fixed;inset:0;z-index:2147483647;overflow:hidden;',
      '  background:#04070d;display:flex;flex-direction:column;',
      '  align-items:center;justify-content:center;transition:opacity .2s ease}',
      '#lx-splash.lx-out{opacity:0;pointer-events:none}',
      '#lx-splash::before{content:"";position:absolute;inset:-24%;pointer-events:none;',
      '  background:radial-gradient(46% 34% at 50% 45%, rgba(37,112,236,.30), rgba(0,0,0,0) 72%)}',
      '.lx-letters{position:relative;display:flex;gap:.12em;font-weight:800;',
      '  font-size:clamp(86px,13vh,168px);line-height:1;letter-spacing:.03em;',
      '  font-family:system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
      '.lx-wl{position:relative;display:inline-block;overflow:hidden;padding:0 .05em;',
      '  color:rgba(158,200,255,.11);-webkit-text-stroke:2px rgba(150,196,255,.46);',
      '  text-shadow:0 8px 34px rgba(40,120,255,.20)}',
      '.lx-wl b{position:relative;z-index:1;font-weight:800}',
      '.lx-wl i{position:absolute;left:-2%;right:-2%;bottom:0;height:0;z-index:0;',
      '  background:linear-gradient(180deg,rgba(103,226,255,.96) 0%,',
      '    rgba(47,139,255,.96) 52%,rgba(24,96,224,.98) 100%);',
      '  box-shadow:0 -1px 0 rgba(255,255,255,.55), 0 -16px 38px rgba(58,158,255,.34);',
      '  animation:lxRise 1.05s cubic-bezier(.22,.75,.3,1) both;',
      '  animation-delay:var(--d,0ms)}',
      '.lx-wl i::before{content:"";position:absolute;left:0;right:0;top:-8px;height:16px;',
      '  background:radial-gradient(50% 100% at 50% 100%,',
      '    rgba(255,255,255,.55), rgba(255,255,255,0) 72%);filter:blur(2px)}',
      '@keyframes lxRise{from{height:0}to{height:101%}}',
      '.lx-tag{position:relative;margin-top:44px;display:flex;flex-direction:column;',
      '  align-items:center;gap:16px}',
      '.lx-bar{width:min(300px,52vw);height:3px;border-radius:2px;',
      '  background:rgba(255,255,255,.09);overflow:hidden}',
      '.lx-bar i{display:block;height:100%;width:0;border-radius:2px;',
      '  background:linear-gradient(90deg,#3fa2ff,#5ce6ff);',
      '  animation:lxBar 3.6s cubic-bezier(.3,.1,.2,1) forwards}',
      '@keyframes lxBar{to{width:100%}}',
      '.lx-cap{font:500 13px/1.6 system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      '  letter-spacing:.34em;color:rgba(210,230,255,.46);text-indent:.34em}',
      '.lx-sub{position:absolute;left:0;right:0;bottom:26px;text-align:center;',
      '  font:500 11px/1.6 system-ui,Arial,sans-serif;letter-spacing:.30em;',
      '  color:rgba(190,215,255,.26);text-indent:.30em}',
      ''
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);

    var mask = document.createElement('div');
    mask.id = 'lx-splash';

    var letters = document.createElement('div');
    letters.className = 'lx-letters';
    ['L', 'P', 'T', 'V'].forEach(function (ch, i) {
      var s = document.createElement('span');
      s.className = 'lx-wl';
      s.style.setProperty('--d', (120 + i * 150) + 'ms');
      var w = document.createElement('i');
      s.appendChild(w);
      var g = document.createElement('b');
      g.textContent = ch;
      s.appendChild(g);
      letters.appendChild(s);
    });

    var tag = document.createElement('div');
    tag.className = 'lx-tag';
    var bar = document.createElement('div');
    bar.className = 'lx-bar';
    var bfill = document.createElement('i');
    bar.appendChild(bfill);
    var cap = document.createElement('div');
    cap.className = 'lx-cap';
    cap.id = 'lx-splash-cap';
    cap.textContent = '正在接入直播';
    tag.appendChild(bar);
    tag.appendChild(cap);

    var sub = document.createElement('div');
    sub.className = 'lx-sub';
    sub.textContent = 'LPTV \u00b7 CENTRAL TV REMOTE PLAYER';

    mask.appendChild(letters);
    mask.appendChild(tag);
    mask.appendChild(sub);
    (document.body || document.documentElement).appendChild(mask);
    return mask;
  }

  var mask = null;
  function onReady() {
    brandIcon();   // head 此时已存在，favicon link 才能挂上
    brandTitle();  // 官方页解析完又改过 title，这里再设一次
    if (!mask) { try { mask = build(); } catch (e) {} }
  }
  try {
    if (document.body) onReady();
    else document.addEventListener('DOMContentLoaded', onReady, true);
  } catch (e) {}

  /* --- 视频真正开始播放后淡出 -------------------------------------------- */
  function videoReady() {
    var v = document.querySelector('video');
    if (!v || !v.videoWidth) return false;
    return v.readyState >= 2 && v.currentTime > 0 && !v.paused;
  }
  var t0 = Date.now();
  var timer = setInterval(function () {
    var el = Date.now() - t0;
    if (mask && ((videoReady() && el >= MIN_MS) || el >= MAX_MS)) {
      clearInterval(timer);
      var m = mask;
      mask = null;
      try { m.classList.add('lx-out'); } catch (e) {}
      setTimeout(function () {
        try { if (m.parentNode) m.parentNode.removeChild(m); } catch (e) {}
        try { var s = document.getElementById('lx-splash-style'); if (s && s.parentNode) s.parentNode.removeChild(s); } catch (e) {}
        try { window.__lxCctvSplash = false; } catch (e) {}
        window.dispatchEvent(new CustomEvent('lptv:player-ready'));
      }, 620);
      return;
    }
    /* 兜底：inject.js 的 15s 黑幕也会自己消失，这里不重复管理 */
  }, 260);

  /* 央视频 SPA 会把 document.title 改成「央视频 - …」，于是远程端的窗口标题栏
   * 显示的是央视频而不是 LPTV。启动后 90s 内每 700ms 拉回 LPTV，之后交还页面。
   * （inject.js 自身不改 title，所以这里不会产生竞争。） */
  var titleTimer = setInterval(function () {
    try {
      brandIcon();  // 站点 JS 可能后加自己的 favicon，周期压回 LPTV 的
      if (document.title !== TITLE) document.title = TITLE;
    } catch (e) {}
    if (Date.now() - t0 > 90000) clearInterval(titleTimer);
  }, 300);
})();
