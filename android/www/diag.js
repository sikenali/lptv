/* diag.js — LPTV Android 黑屏定位辅助
 *
 * 原生 APK 视频在跨域央视频 iframe 内，父页面无法读其内部 <video>/错误。
 * 本脚本在 APK 顶层页面提供一个轻量 HUD，记录：
 *   1. iframe 加载状态（did yangshipin 页是否真的加载/被拒）
 *   2. 顶层 JS 错误（window.onerror / unhandledrejection）
 *   3. play_channel 调用（是否切了台、pid 是什么）
 * 配合 MainActivity 已开启的 WebView 调试（chrome://inspect），
 * 可进一步看央视频 iframe 的控制台/网络（DRM/编解码/自动播放/被拒请求）。
 *
 * 显示方式：屏幕底部一条半透明横幅，点 X 可收起；无错误时仅短暂显示 iframe 状态。
 */
(function () {
  if (window.__lptvDiag) return;
  window.__lptvDiag = true;

  var LS = "lptv.diag.v1";
  var enabled = true;
  try { enabled = localStorage.getItem(LS) !== "off"; } catch (e) {}
  if (!enabled) return;

  var logEl = null;
  var lastMsg = "";

  function ensure() {
    if (logEl) return logEl;
    logEl = document.createElement("div");
    logEl.setAttribute("data-lptv-diag", "1");
    logEl.style.cssText =
      "position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483000;" +
      "background:rgba(0,0,0,.78);color:#9fe870;font:11px/1.5 monospace;" +
      "padding:6px 10px;border-radius:6px;border:1px solid #2a2a2a;" +
      "pointer-events:auto;max-height:38vh;overflow:auto;white-space:pre-wrap;" +
      "word-break:break-all;";
    var close = document.createElement("span");
    close.textContent = "✕";
    close.style.cssText = "position:absolute;right:8px;top:4px;cursor:pointer;color:#fff;";
    close.onclick = function () { logEl.style.display = "none"; };
    logEl.appendChild(close);
    (document.body || document.documentElement).appendChild(logEl);
    return logEl;
  }

  function show(msg, sticky) {
    try {
      var el = ensure();
      lastMsg = msg;
      el.textContent = "[" + new Date().toTimeString().slice(0, 8) + "] " + msg;
      if (sticky) el.style.opacity = "1";
      else { el.style.opacity = "0.85"; }
    } catch (e) {}
  }

  // 顶层 JS 错误
  window.addEventListener("error", function (ev) {
    var m = (ev && ev.message) || "unknown error";
    show("JS错误: " + m + " @ " + ((ev && ev.filename) || "") + ":" + ((ev && ev.lineno) || ""), true);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    var r = ev && ev.reason;
    show("Promise拒绝: " + (r && (r.message || r) || String(r)), true);
  });

  // iframe 加载状态
  function watchFrame() {
    var f = document.getElementById("lptv-iframe");
    if (!f) return;
    var t0 = Date.now();
    f.addEventListener("load", function () {
      show("iframe 已加载(" + (Date.now() - t0) + "ms): " + (f.src || "").slice(0, 80), false);
    });
    f.addEventListener("error", function () {
      show("iframe 加载失败: " + (f.src || "").slice(0, 80), true);
    });
  }

  // play_channel 调用（bridge.js 设 iframe.src 前打点）
  var orig = window.lptv && window.lptv.play_channel;
  if (orig) {
    window.lptv.play_channel = function (pid) {
      show("play_channel(" + pid + ") -> iframe.src=央视频", false);
      return orig.apply(this, arguments);
    };
  }

  watchFrame();
  show("diag 就绪（黑屏时读此横幅；chrome://inspect 可看 iframe 控制台）", false);
})();
