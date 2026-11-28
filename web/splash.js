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
  // 智慧屏（xpra 网页客户端，窗口默认全屏）：换台时官方换流很慢，22s 兜底太久，
  // 表现为「换台卡死」。只对智慧屏把兜底缩短；桌面 catlink 客户端（窗口模式）不变。
  // 注意：splash 在 document-start 执行，此时 __LPTV_IS_CONTAINER / window.lptv
  // 还没注入，必须延迟到遮罩计时器里再判定。
  var MAX_MS_SMART = 6000;
  function isSmartScreen() {
    // preload 在 document-start 同步暴露 __LPTV_ENV.smart（由主进程 argv 传入），
    // 无需等待 dom-ready 注入，避免竞态导致判定恒 false。
    try {
      if (window.__LPTV_ENV && window.__LPTV_ENV.smart === true) return true;
    } catch (e) {}
    try {
      return window.__LPTV_IS_CONTAINER === true && !!(window.lptv && window.lptv.is_fullscreen);
    } catch (e) {
      return false;
    }
  }

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
      '  transition:opacity .45s ease}',
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
      /* 上下跳动(单次/周期): 上升快起慢顶(ease-out), 下降慢顶快落(ease-in),
         顶点/触地速度均为0平滑反转 → 丝滑无顿挫; 每周期只跳一次(单程=周期/2),
         从容不急促。幅度-14%细腻不过冲。百分比相对图标自身高度, 纯 transform
         不触发重栅格化, 图标全程清晰; 横线高亮段左右往来(lxSlide)不变。 */
      '@keyframes lxBounce{0%{transform:translateY(0);animation-timing-function:cubic-bezier(.33,0,.66,.33)}',
      '  50%{transform:translateY(-14%);animation-timing-function:cubic-bezier(.33,.66,.66,1)}',
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
       左右往来。始终播放加载动画覆盖官方页; quick 只决定淡出时机(首页就绪即淡出),
       不再退化成纯深色遮罩。无图标时回退静态字标。 */
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
    // !important: 官方页 CSS 可能设白底, 用 important 压住防白闪。
    try {
      if (document.documentElement) document.documentElement.style.setProperty('background', '#04070d', 'important');
      if (document.body) document.body.style.setProperty('background', '#04070d', 'important');
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
  var splashLogged = false;
  var timer = setInterval(function () {
    var el = Date.now() - t0;
    if (!splashLogged) {
      splashLogged = true;
      try {
        console.log('[LPTV-splash] tick container=' + String(window.__LPTV_IS_CONTAINER)
          + ' lptv=' + typeof window.lptv + ' smart=' + isSmartScreen());
      } catch (e) {}
    }
    // Android（__lptvBridge, iframe 模型）: 视频在跨域 iframe 内, videoReady() 查不到
    // 父页 <video>, 恒为 false; 走 MIN_MS 后淡出, 避免黑屏挂 22s。
    // quick 模式(启动直达首页): 页面 DOM 就绪(inject.js 已注入并建好首页)后
    // 短暂延迟即淡出, 不再等视频 readyState —— 直接露首页, 不播加载动画。
    var fadeNow;
    if (CFG.quick) {
      // quick 模式(启动直达首页): 必须等 inject.js 把首页频道卡片渲染出来再淡出。
      // 只看 document.readyState 会在 inject 尚未建好首页时露出央视频原页 (用户看到
      // "打开先显示央视频")。这里用共享 DOM 判定: #lptv-root 处于 home 且有卡片。
      var root = document.getElementById('lptv-root');
      var homeReady = !!(root && root.getAttribute('data-state') === 'home' &&
        document.querySelector('#lptv-view-home .lv-card'));
      fadeNow = homeReady || el >= 6000;   // 兜底 6s, 防接口异常时永远黑屏
    } else if (window.__lptvBridge) {
      // 网页播放器 (__lptvBridge, iframe 模型): 视频在 #lptv-iframe 内, videoReady()
      // 查不到父页 <video>, 恒 false。启动首页 = 动画(logo 上下跳动)里加载央视频网站,
      // 等 iframe 把央视频页加载完 (__LPTV_YSP_READY, 由 index.html/bridge 在 iframe
      // load 时置位) 再淡出露首页 —— 此时央视频已注入, 点频道即可直接切换, 而非冷加载。
      // 不再固定 1s 淡出 (否则央视频还没注入, 首页先露、点频道才慢加载)。
      fadeNow = (window.__LPTV_YSP_READY === true && el >= MIN_MS) || el >= 8000;
    } else {
      fadeNow = (videoReady() && el >= MIN_MS) || el >= (isSmartScreen() ? MAX_MS_SMART : MAX_MS);
    }
    if (mask && fadeNow) {
      clearInterval(timer);
      var m = mask;
      mask = null;
      var beginFade = function () {
        try { m.classList.add('lptv-out'); } catch (e) {}
      };
      // 等首页真正绘出一帧(两个 rAF)再淡出, 并给 xpra 编码/客户端解码留余量:
      // 淡出瞬间底下若仍是空白底色 → 白屏。quick 模式再多等 250ms 让首页内容
      // 完成首帧合成(智慧屏走 xpra 投屏, 本地绘制到远端出帧有额外延迟)。
      var settle = CFG.quick ? 250 : 0;
      setTimeout(function () {
        try { requestAnimationFrame(function () { requestAnimationFrame(beginFade); }); }
        catch (e) { beginFade(); }
      }, settle);
      setTimeout(function () {
        try { if (m.parentNode) m.parentNode.removeChild(m); } catch (e) {}
        try {
          var dE = document.documentElement;
          if (dE) dE.classList.remove('lptv-splash-lock');
        } catch (e) {}
        try { var s = document.getElementById('lptv-splash-style'); if (s && s.parentNode) s.parentNode.removeChild(s); } catch (e) {}
        try { window.__lptvSplash = false; } catch (e) {}
        window.dispatchEvent(new CustomEvent('lptv:player-ready'));
      }, settle + 950);
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
