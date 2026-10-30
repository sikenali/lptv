/* ---------------------------------------------------------------------------
 * LPTV 启动动画 —— 文字字标 "LPTV" + 加载条 (全覆盖不露YSP)
 *
 * 由 electron/preload.js 在页面 document-start 同步执行（隔离世界共享 DOM），
 * 直接建 #lptv-splash 遮罩，早于YSP自己的 HTML / JS 解析与首帧绘制。
 * 因此在导航期间屏幕上始终是本动画，不会闪现YSP裸页。
 *
 * 切台走官方 SPA 的 pushState（window.__lptv.switchChannel），不构成新的
 * 文档导航，本脚本不会重复出现。
 *
 * 配置（由 main.js 在本文件之前注入）：
 *   window.__LPTV_SPLASH_CFG = { icon: 'data:image/png;base64,...',  // 窗口图标
 *                                title: 'LPTV' }
 * --------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.__lptvSplash) return;
  window.__lptvSplash = true;

  var CFG = window.__LPTV_SPLASH_CFG || {};
  var ICON = CFG.icon || '';
  var TITLE = CFG.title || 'LPTV';
  var MIN_MS = 1000;   // 最短展示时长：快速淡出，直接进播放器（用户要求直达播放界面）
  var MAX_MS = 22000;  // 兜底：视频迟迟不播也淡出，不能卡死

  /* --- 品牌：favicon + 标题 ------------------------------------------------
   * Chrome 用 favicon 生成窗口的 _NET_WM_ICON、用 document.title 生成
   * _NET_WM_NAME / WM_NAME，所以这里改了，窗口列表里的图标和标题才是 LPTV
   * 自己的，而不是YSP的。
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
    st.id = 'lptv-splash-style';
    st.textContent = [
      /* 全覆盖: 锁死 html/body 背景与滚动, 官方页无法从缝隙/滚动边缘漏出 */
      'html.lptv-splash-lock,html.lptv-splash-lock body{background:#04070d!important;',
      '  overflow:hidden!important;height:100%!important}',
      '#lptv-splash{position:fixed;inset:0;z-index:2147483647;overflow:hidden;',
      '  background:#04070d;display:flex;align-items:center;justify-content:center;',
      '  transition:opacity .25s ease}',
      '#lptv-splash.lptv-out{opacity:0;pointer-events:none}',
      '#lptv-splash::before{content:"";position:absolute;inset:-24%;pointer-events:none;',
      '  background:radial-gradient(48% 36% at 50% 46%, rgba(28,86,196,.22), rgba(0,0,0,0) 72%)}',
      /* 圆圈加载: 四色渐变环(保留原进度条配色) + 居中 LPTV 字标。
         环用 conic-gradient 铺四色 + radial mask 掏空成环, 旋转环体实现转圈;
         LPTV 为独立非旋转子元素, 居中不跟着转。 */
      '.lptv-ring-wrap{position:relative;width:min(42vw,210px);height:min(42vw,210px);',
      '  display:flex;align-items:center;justify-content:center}',
      '.lptv-ring{position:absolute;inset:0;border-radius:50%;',
      '  background:conic-gradient(#1a6fe8 0%,#0fae92 34%,#f07d18 67%,#e8318f 100%,#1a6fe8 100%);',
      '  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 13px),#000 calc(100% - 12px));',
      '  mask:radial-gradient(farthest-side,transparent calc(100% - 13px),#000 calc(100% - 12px));',
      '  animation:lxRing 1.1s linear infinite;',
      '  filter:drop-shadow(0 0 20px rgba(80,170,255,.35))}',
      '.lptv-ring-label{font-family:sans-serif;font-weight:700;',
      '  font-size:clamp(26px,6vw,54px);line-height:1;letter-spacing:-0.04em;color:#eaf2ff;',
      '  user-select:none;text-shadow:0 10px 36px rgba(60,130,255,.4);animation:lxIn .9s ease backwards}',
      /* 纯 opacity 淡入：transform 动画会把元素提升到合成层，图片按层尺寸栅格化，
         字母描边发虚（原 translateY+scale 已实测）。opacity 不触发重栅格化，logo 全程清晰 */
      '@keyframes lxRing{to{transform:rotate(360deg)}}',
      '@keyframes lxIn{from{opacity:0}to{opacity:1}}',
      ''
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);

    var mask = document.createElement('div');
    mask.id = 'lptv-splash';

    /* 主视觉: 四色渐变圆环(转) + 居中 LPTV 字标(不转)。文字直渲, 清晰无毛边 */
    var wrap = document.createElement('div');
    wrap.className = 'lptv-ring-wrap';
    var ring = document.createElement('div');
    ring.className = 'lptv-ring';
    var label = document.createElement('div');
    label.className = 'lptv-ring-label';
    label.textContent = 'LPTV';
    label.setAttribute('aria-label', TITLE);
    label.setAttribute('role', 'img');
    wrap.appendChild(ring);
    wrap.appendChild(label);
    mask.appendChild(wrap);

    /* 锁定页面背景/滚动 (全覆盖), 并挂到 <html> 最稳 */
    var dEl = document.documentElement;
    if (dEl) dEl.classList.add('lptv-splash-lock');
    (dEl || document.body).appendChild(mask);
    return mask;
  }

  var mask = null;
  function onReady() {
    brandTitle();  // 官方页解析完又改过 title，这里再设一次
    // 页面 canvas 默认白会在 documentElement 出现后、splash 覆盖前的间隙画出 →
    // 白闪。先把 html/body 内联设暗（早于 splash 样式表生效），canvas 即暗。
    try {
      if (document.documentElement) document.documentElement.style.background = '#04070d';
      if (document.body) document.body.style.background = '#04070d';
    } catch (e) {}
    if (!mask) { try { mask = build(); } catch (e) {} }
  }
  /* 尽早盖: 官方页首帧绘制恰发生在 DOMContentLoaded, 等它才建遮罩就晚一帧,
   * 会闪出官方页。改为 documentElement 一出现就建 —— 远早于首帧。
   * document-start 时 <html> 可能还没建, 用 rAF 轮询, 一出现立即盖 (同 pumpIcon)。 */
  function pumpSplash() {
    if (document.documentElement) onReady();
    else requestAnimationFrame(pumpSplash);
  }
  try {
    if (document.documentElement) onReady();
    else requestAnimationFrame(pumpSplash);
  } catch (e) {}
  /* favicon link / title 需 head 存在 (document-start 可能还没有), 保 DOMContentLoaded */
  document.addEventListener('DOMContentLoaded', function () {
    try { brandIcon(); brandTitle(); if (!mask) onReady(); } catch (e) {}
  }, true);

  /* --- 视频真正开始播放后淡出 -------------------------------------------- */
  function videoReady() {
    var v = document.querySelector('video');
    if (!v || !v.videoWidth) return false;
    return v.readyState >= 2 && v.currentTime > 0 && !v.paused;
  }
  var t0 = Date.now();
  var timer = setInterval(function () {
    var el = Date.now() - t0;
    // Android（__lptvBridge, iframe 模型）: 视频在跨域 iframe 内, videoReady() 查不到
    // 父页 <video>, 恒为 false; 走 MIN_MS 后淡出, 避免黑屏挂 22s。
    if (mask && ((videoReady() && el >= MIN_MS) || el >= MAX_MS ||
                 (window.__lptvBridge && el >= MIN_MS))) {
      clearInterval(timer);
      var m = mask;
      mask = null;
      try { m.classList.add('lptv-out'); } catch (e) {}
      setTimeout(function () {
        try { if (m.parentNode) m.parentNode.removeChild(m); } catch (e) {}
        try {
          var dE = document.documentElement;
          if (dE) dE.classList.remove('lptv-splash-lock');
        } catch (e) {}
        try { var s = document.getElementById('lptv-splash-style'); if (s && s.parentNode) s.parentNode.removeChild(s); } catch (e) {}
        try { window.__lptvSplash = false; } catch (e) {}
        window.dispatchEvent(new CustomEvent('lptv:player-ready'));
      }, 620);
      return;
    }
    /* 兜底：inject.js 的 15s 黑幕也会自己消失，这里不重复管理 */
  }, 260);

  /* YSP SPA 会把 document.title 改成「YSP - …」，于是远程端的窗口标题栏
   * 显示的是YSP而不是 LPTV。启动后 90s 内每 700ms 拉回 LPTV，之后交还页面。
   * （inject.js 自身不改 title，所以这里不会产生竞争。） */
  var titleTimer = setInterval(function () {
    try {
      brandIcon();  // 站点 JS 可能后加自己的 favicon，周期压回 LPTV 的
      if (document.title !== TITLE) document.title = TITLE;
    } catch (e) {}
    if (Date.now() - t0 > 90000) clearInterval(titleTimer);
  }, 300);
})();
