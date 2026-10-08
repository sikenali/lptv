/* LPTV — 盒子 WebView 注入引导脚本 (参照 pytv 桌面版注入模式)
 *
 * pytv 桌面版 (已能播放) 的做法:
 *   WebView(edgechromium) 打开 https://www.yangshipin.cn/tv/home?pid=X
 *   + 注入完整 inject.js, 复用官方 <video> (官方页自带 CMG 解密, DOM 零改动)
 *
 * 本脚本把该模式搬到盒子 WebView:
 *   盒子 WebView 打开官方页后, 将本脚本以 <script src> 注入:
 *     <script src="https://lptv.<盒子>.heiyu.space/box-bootstrap.js"></script>
 *   脚本自动推导 LPTV 域名, 依次加载 adapter.js → inject.js
 *   官方播放器在官方域名下运行 (签名/CMG 全部正常), 我们只叠加 UI。
 *
 * 域名自适应: 懒猫盒子域名 (lptv.<用户名>.heiyu.space) 每次安装不同。
 * API base 取值优先级:
 *   1) document.currentScript.src (本脚本从哪个域名加载, 即 LPTV 服务端)
 *   2) window.__LPTV_API_BASE (WebView 配置注入)
 *   3) LPTV_BOX_API_BASE 常量 (部署时填死)
 *   4) window.location.origin (仅当同源部署)
 */
(function () {
  var LPTV_BOX_API_BASE = '';   // 部署时若需写死才填; 一般留空自动推导

  var curScript = document.currentScript;
  var curScriptSrc = '';
  try { curScriptSrc = (curScript && curScript.src) || ''; } catch (e) {}

  function deriveBase() {
    if (LPTV_BOX_API_BASE) return LPTV_BOX_API_BASE;
    if (window.__LPTV_API_BASE) return window.__LPTV_API_BASE;
    if (curScriptSrc && /^https?:/i.test(curScriptSrc)) {
      try { return new URL(curScriptSrc).origin; } catch (e) {}
    }
    return window.location.origin + '';
  }

  var base = deriveBase();
  if (!base || base === 'null') {
    console.warn('[LPTV box] cannot derive API base. 请以 <script src="https://你的盒子域名/box-bootstrap.js"> 注入, 或在注入前设置 window.__LPTV_API_BASE。');
    return;
  }
  window.__LPTV_API_BASE = base;
  console.log('[LPTV box] api base = ' + base);

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      tryLoad();
      function tryLoad() {
        var head = document.head || document.getElementsByTagName('head')[0];
        if (!head) { setTimeout(tryLoad, 100); return; }
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function () { reject(new Error('load fail ' + src)); };
        head.appendChild(s);
      }
    });
  }

  function start() {
    // 幂等: 已注入过则跳过
    if (window.__lptv) { console.log('[LPTV box] already injected'); return; }
    loadScript(base + '/adapter.js')
      .then(function () { return loadScript(base + '/inject.js'); })
      .then(function () { console.log('[LPTV box] adapter+inject loaded'); })
      .catch(function (e) { console.warn('[LPTV box] load failed:', String(e)); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();