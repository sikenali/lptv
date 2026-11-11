/* ---------------------------------------------------------------------------
 * LPTV 启动动画 —— 单图标 (icon.png) 上下跳动 + 下方渐变横线左右往来 (全覆盖不露YSP)
 *
 * 由 electron/preload.js 在页面 document-start 同步执行（隔离世界共享 DOM），
 * 直接建 #lptv-splash 遮罩，早于YSP自己的 HTML / JS 解析与首帧绘制。
 * 因此在导航期间屏幕上始终是本动画，不会闪现YSP裸页。
 *
 * 切台走官方 SPA 的 pushState（window.__lptv.switchChannel），不构成新的
 * 文档导航，本脚本不会重复出现。
 *
 * 配置（由 main.js 在本文件之前注入）：
 *   window.__LPTV_SPLASH_CFG = { icon: 'data:image/png;base64,...',  // 窗口/动画图标
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
      /* 主视觉: 单图标(icon.png)上方上下跳动; 下方一条连续渐变横线(朱红→金→jade绿→云蓝)
         为加载轨道, 其上高亮段左右往来滑动 → 加载动画 */
      '.lptv-wave{display:flex;flex-direction:column;align-items:center;gap:clamp(12px,2.6vw,20px)}',
      '.lptv-wave-ico{width:clamp(84px,20vw,132px);height:clamp(84px,20vw,132px);object-fit:contain;',
      '  filter:drop-shadow(0 0 24px rgba(120,160,255,.28));',
      '  animation:lxBounce 1.5s infinite}',
      '.lptv-wave-bar{width:min(340px,64vw);height:4px;border-radius:2px;position:relative;',
      '  overflow:hidden;',
      '  background:linear-gradient(90deg,rgba(255,77,66,.4),rgba(247,201,72,.4),rgba(42,212,137,.4),rgba(79,168,255,.4));',
      '  box-shadow:0 0 12px rgba(120,160,255,.2)}',
      '.lptv-wave-bar::after{content:"";position:absolute;top:0;left:0;height:100%;width:42%;',
      '  border-radius:2px;',
      '  background:linear-gradient(90deg,#FF4D42,#F7C948,#2AD489,#4FA8FF);',
      '  box-shadow:0 0 14px rgba(160,190,255,.6);',
      '  animation:lxSlide 1.4s ease-in-out infinite}',
      /* 回退(无图标时): 静态 LPTV 字标, 不转圈 */
      '.lptv-ring-label{font-family:sans-serif;font-weight:700;',
      '  font-size:clamp(26px,6vw,54px);line-height:1;letter-spacing:-0.04em;color:#eaf2ff;',
      '  user-select:none;text-shadow:0 10px 36px rgba(60,130,255,.4);animation:lxIn .9s ease backwards}',
      /* 连续上下跳动(无停顿), 分段重力 easing: 上升快起慢顶(ease-out), 下降慢顶快落
         (ease-in), 顶点/触地速度均为0平滑反转 → 丝滑无顿挫; 幅度-14%细腻不过冲。
         百分比相对图标自身高度, 纯 transform 不触发重栅格化, 图标全程清晰;
         横线高亮段左右往来动画(lxSlide)保持不变。 */
      '@keyframes lxBounce{0%{transform:translateY(0);animation-timing-function:cubic-bezier(.33,0,.66,.33)}',
      '  25%{transform:translateY(-14%);animation-timing-function:cubic-bezier(.33,.66,.66,1)}',
      '  50%{transform:translateY(0);animation-timing-function:cubic-bezier(.33,0,.66,.33)}',
      '  75%{transform:translateY(-14%);animation-timing-function:cubic-bezier(.33,.66,.66,1)}',
      '  100%{transform:translateY(0)}}',
      '@keyframes lxSlide{0%{transform:translateX(0)}50%{transform:translateX(138%)}100%{transform:translateX(0)}}',
      '@keyframes lxIn{from{opacity:0}to{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){',
      '  .lptv-wave-ico{animation:none}',
      '  .lptv-wave-bar::after{animation:none}}',
      ''
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);

    var mask = document.createElement('div');
    mask.id = 'lptv-splash';

    /* 主视觉: 单图标(icon.png)在上方上下跳动; 下方连续渐变横线加载轨道 + 高亮段
       左右往来; 无图标时回退静态字标 */
    if (ICON) {
      var wave = document.createElement('div');
      wave.className = 'lptv-wave';
      wave.setAttribute('role', 'img');
      wave.setAttribute('aria-label', TITLE);
      var img = document.createElement('img');
      img.className = 'lptv-wave-ico';
      img.src = ICON;
      img.alt = TITLE;
      img.draggable = false;
      wave.appendChild(img);
      var bar = document.createElement('div');
      bar.className = 'lptv-wave-bar';
      wave.appendChild(bar);
      mask.appendChild(wave);
      /* 共享给 inject.js 频道切换动画复用(同一图标+配色):
         写入共享 DOM, 跨隔离世界读该节点即可取到 data URI。 */
      try {
        var holder = document.createElement('div');
        holder.id = 'lptv-icon-assets';
        holder.style.display = 'none';
        holder.setAttribute('data-icon', ICON);
        (document.head || document.documentElement).appendChild(holder);
      } catch (e) {}
    } else {
      var label = document.createElement('div');
      label.className = 'lptv-ring-label';
      label.textContent = 'LPTV';
      label.setAttribute('aria-label', TITLE);
      label.setAttribute('role', 'img');
      mask.appendChild(label);
    }

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
