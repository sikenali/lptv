/* LX TV · Web —— 播放器前端
 *
 * 这是对原 EXE 版 inject.js 的「改造版」:
 *   - 原 inject.js 是注入到官方 央视频 TV 网页、复用其 video 元素与 CMG 解密
 *     (switchChannel / getPlayUrl / acquireOfficial / installHlsHooks ...)。
 *   - 在懒猫微服的 web 模式下无法加载第三方官方页，因此这里:
 *       1) 保留 inject.js 的 UI/UX 设计 (配置、频道面板、OSD、收藏、设置、
 *          黑帧看门狗、快捷键、全屏、fit 比例)；
 *       2) 用自有播放内核替换官方页依赖: 通过后端 /api/resolve 解出真实线路，
 *          用 hls.js / mpegts.js 经 /proxy 取流，并支持多线路容错 (对照原站
 *          switchNextLine)。
 *   - 配置、收藏、上次频道全部存 localStorage，与 inject.js 思路一致。
 */
(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // 配置 (localStorage)
  // -----------------------------------------------------------------------
  var LS_KEY = "lx.cfg.web";
  var DEFAULT_CFG = {
    volume: 1, muted: false, fit: "contain",
    autoHide: true, resumeLast: true, favs: []
  };
  function loadCfg() {
    try { return Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); }
    catch (e) { return Object.assign({}, DEFAULT_CFG); }
  }
  function saveCfg() { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }
  var cfg = loadCfg();

  // -----------------------------------------------------------------------
  // DOM 速记
  // -----------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  var video = $("video"), spin = $("spin"), spinTxt = $("spinTxt"), osd = $("osd");
  var root = $("lx-root"), topbar = $("topbar"), ctrl = $("ctrl");
  var btnMenu = $("btnMenu"), btnPrev = $("btnPrev"), btnNext = $("btnNext");
  var btnFs = $("btnFs"), btnSettings = $("btnSettings");
  var panel = $("panel"), panelMask = $("panelMask"), search = $("search");
  var favWrap = $("favWrap"), favList = $("favList"), catWrap = $("catWrap");
  var setWrap = $("setWrap"), setVol = $("setVol"), setMute = $("setMute");
  var setFit = $("setFit"), setAutoHide = $("setAutoHide"), setResume = $("setResume");
  var btnClearFav = $("btnClearFav"), btnSetClose = $("btnSetClose");
  var cPlay = $("cPlay"), cMute = $("cMute"), cVol = $("cVol");
  var chName = $("chName"), chCat = $("chCat");
  var btnPanelClose = $("btnPanelClose");

  // -----------------------------------------------------------------------
  // 全局状态
  // -----------------------------------------------------------------------
  var channels = [], byId = {}, cats = {};
  var current = null;        // 当前频道对象
  var lines = [];            // 当前频道解出的线路
  var lineIdx = -1;          // 当前线路下标
  var hls = null, flv = null;
  var loadTimer = null, isPlaying = false;
  var darkCount = 0, dbg = [];
  var uiHideT = null, panelOpen = false, setOpen = false;
  var LOAD_TIMEOUT = 12000, STALL_TIMEOUT = 8000, DARK_LIMIT = 5;

  // -----------------------------------------------------------------------
  // 工具
  // -----------------------------------------------------------------------
  function isFav(id) { return cfg.favs.indexOf(id) >= 0; }
  function favToggle(id) {
    var i = cfg.favs.indexOf(id);
    if (i >= 0) cfg.favs.splice(i, 1); else cfg.favs.push(id);
    saveCfg(); renderFav(); renderPanel();
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function showOSD(txt, ms) {
    osd.innerHTML = txt; osd.classList.remove("hidden");
    clearTimeout(showOSD._t);
    showOSD._t = setTimeout(function () { osd.classList.add("hidden"); }, ms || 1600);
  }
  function showSpin(txt) { spinTxt.textContent = txt || "缓冲中…"; spin.classList.remove("hidden"); }
  function hideSpin() { spin.classList.add("hidden"); }
  function dbgPush(s) { dbg.push(s); if (dbg.length > 40) dbg.shift(); if (window.console) console.log("[lx]", s); }

  // -----------------------------------------------------------------------
  // 频道面板 / 收藏
  // -----------------------------------------------------------------------
  function channelRow(ch) {
    var row = el("div", "ch-row");
    row.dataset.id = ch.id;
    var nm = el("span", "nm", ch.name);
    var star = el("span", "star" + (isFav(ch.id) ? " on" : ""), "★");
    star.onclick = function (e) { e.stopPropagation(); favToggle(ch.id); };
    row.appendChild(nm); row.appendChild(star);
    row.onclick = function () { playChannel(ch); closePanel(); };
    if (current && ch.id === current.id) row.classList.add("active");
    return row;
  }
  function renderFav() {
    favList.innerHTML = "";
    var favs = channels.filter(function (c) { return isFav(c.id); });
    favWrap.classList.toggle("hidden", favs.length === 0);
    favs.forEach(function (c) { favList.appendChild(channelRow(c)); });
  }
  function renderPanel() {
    var q = (search.value || "").trim().toLowerCase();
    catWrap.innerHTML = "";
    Object.keys(cats).forEach(function (cat) {
      var list = cats[cat].filter(function (c) {
        return !q || c.name.toLowerCase().indexOf(q) >= 0;
      });
      if (!list.length) return;
      catWrap.appendChild(el("div", "cat-title", cat));
      var box = el("div", "ch-list");
      list.forEach(function (c) { box.appendChild(channelRow(c)); });
      catWrap.appendChild(box);
    });
    renderFav();
  }
  function openPanel() { panel.classList.add("open"); panelMask.classList.remove("hidden"); panelOpen = true; }
  function closePanel() { panel.classList.remove("open"); panelMask.classList.add("hidden"); panelOpen = false; }

  // -----------------------------------------------------------------------
  // 播放内核 (改造核心: 替代原 inject.js 的官方页/hls 复用)
  // -----------------------------------------------------------------------
  function destroyPlayer() {
    try { if (hls) { hls.destroy(); hls = null; } } catch (e) {}
    try { if (flv) { flv.destroy(); flv = null; } } catch (e) {}
    try { video.removeAttribute("src"); video.load(); } catch (e) {}
  }
  function applyFit() { video.style.objectFit = cfg.fit; }

  function loadLine(i) {
    if (i >= lines.length) { showOSD("⚠ 所有线路已失效，请稍后重试", 3000); showSpin("全部线路失效"); return; }
    lineIdx = i;
    var ln = lines[i];
    destroyPlayer();
    showSpin("线路 " + (i + 1) + "/" + lines.length + " 连接中…");
    isPlaying = false;
    var waitingSince = 0;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (!isPlaying) { dbgPush("line " + (i + 1) + " timeout -> next"); tryLine(i + 1); }
    }, LOAD_TIMEOUT);

    var src = "/proxy?u=" + encodeURIComponent(ln.url);
    if (ln.type === "flv" && window.mpegts && mpegts.isSupported()) {
      flv = mpegts.createPlayer({ type: "flv", isLive: true, url: src, cors: true },
        { lazyLoad: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8 });
      flv.attachMediaElement(video);
      flv.on(mpegts.Events.ERROR, function () { dbgPush("flv err -> next"); tryLine(i + 1); });
      flv.load();
      var p = flv.play();
      if (p && p.catch) p.catch(function () {});
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: false, enableWorker: true, capLevelToPlayerSize: true,
        liveSyncDurationCount: 3, maxBufferLength: 40, maxBufferSize: 0,
        manifestLoadingTimeOut: 10000, manifestLoadingMaxRetry: 3, fragmentLoadingTimeOut: 10000 });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { video.play().catch(function () {}); });
      hls.on(Hls.Events.ERROR, function (e, d) {
        if (d && d.fatal) { dbgPush("hls fatal -> next"); tryLine(i + 1); }
      });
      hls.attachMedia(video); hls.loadSource(src);
    } else {
      // Safari / 原生 HLS
      video.src = src; video.play().catch(function () {});
      video.onerror = function () { dbgPush("native err -> next"); tryLine(i + 1); };
    }
  }
  function tryLine(i) { loadLine(i); }

  function onPlaySuccess() {
    isPlaying = true; hideSpin(); darkCount = 0;
    clearTimeout(loadTimer);
  }

  function resolveAndPlay(ch) {
    showSpin("解析频道…");
    var url = "/api/resolve?url=" + encodeURIComponent(ch.url);
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.lines || !j.lines.length) {
        showOSD("⚠ 解析失败：无可用线路", 2600); showSpin("无可用线路"); return;
      }
      lines = j.lines; lineIdx = -1; loadLine(0);
    }).catch(function (e) {
      dbgPush("resolve err: " + e); showOSD("⚠ 解析失败 (网络/后端)", 2600); showSpin("解析失败");
    });
  }

  function playChannel(ch) {
    if (!ch) return;
    current = ch;
    chName.textContent = ch.name;
    chCat.textContent = ch.category || "";
    // 高亮面板
    Array.prototype.forEach.call(document.querySelectorAll(".ch-row"), function (r) {
      r.classList.toggle("active", r.dataset.id === String(ch.id));
    });
    if (cfg.resumeLast) { cfg._lastId = ch.id; saveCfg(); }
    resolveAndPlay(ch);
  }

  function stepChannel(dir) {
    if (!channels.length) return;
    var idx = channels.indexOf(current);
    if (idx < 0) idx = 0;
    idx = (idx + dir + channels.length) % channels.length;
    showOSD("切换：" + channels[idx].name);
    playChannel(channels[idx]);
  }

  // -----------------------------------------------------------------------
  // 黑帧看门狗 (移植自 inject.js.recoverBlack，用于卡黑屏时换线)
  // -----------------------------------------------------------------------
  var darkCanvas = document.createElement("canvas");
  darkCanvas.width = 32; darkCanvas.height = 18;
  var dctx = darkCanvas.getContext("2d");
  function watchDog() {
    if (!isPlaying || video.paused || video.readyState < 2) { darkCount = 0; return; }
    try {
      dctx.drawImage(video, 0, 0, 32, 18);
      var d = dctx.getImageData(0, 0, 32, 18).data;
      var sum = 0; for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      var avg = sum / (d.length / 4) / 3;
      if (avg < 12) { darkCount++; } else { darkCount = 0; }
      if (darkCount >= DARK_LIMIT) {
        dbgPush("black frame -> switch line");
        darkCount = 0;
        if (lineIdx + 1 < lines.length) tryLine(lineIdx + 1);
        else { video.currentTime += 1; }   // 轻微跳播尝试恢复
      }
    } catch (e) {}
  }
  setInterval(watchDog, 2000);

  // -----------------------------------------------------------------------
  // 自动隐藏控制栏
  // -----------------------------------------------------------------------
  function scheduleHide() {
    clearTimeout(uiHideT);
    if (!cfg.autoHide) return;
    uiHideT = setTimeout(function () {
      if (!panelOpen && !setOpen) root.classList.add("lx-hide");
    }, 3500);
  }
  function wakeUI() { root.classList.remove("lx-hide"); scheduleHide(); }
  ["mousemove", "touchstart", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, wakeUI, true);
  });

  // -----------------------------------------------------------------------
  // 设置面板
  // -----------------------------------------------------------------------
  function openSettings() { setOpen = true; setWrap.classList.remove("hidden"); }
  function closeSettings() { setOpen = false; setWrap.classList.add("hidden"); }
  function syncSettings() {
    setVol.value = Math.round(cfg.volume * 100);
    setMute.checked = cfg.muted;
    setAutoHide.checked = cfg.autoHide;
    setResume.checked = cfg.resumeLast;
    Array.prototype.forEach.call(setFit.children, function (b) {
      b.classList.toggle("active", b.dataset.fit === cfg.fit);
    });
  }
  function bindSettings() {
    setVol.oninput = function () {
      cfg.volume = setVol.value / 100; cfg.muted = false; saveCfg();
      video.volume = cfg.volume; video.muted = false; cVol.value = setVol.value; cMute.textContent = "🔊";
    };
    setMute.onchange = function () {
      cfg.muted = setMute.checked; saveCfg(); video.muted = cfg.muted;
      cMute.textContent = cfg.muted ? "🔇" : "🔊";
    };
    setAutoHide.onchange = function () { cfg.autoHide = setAutoHide.checked; saveCfg(); scheduleHide(); };
    setResume.onchange = function () { cfg.resumeLast = setResume.checked; saveCfg(); };
    Array.prototype.forEach.call(setFit.children, function (b) {
      b.onclick = function () {
        cfg.fit = b.dataset.fit; saveCfg(); applyFit(); syncSettings();
      };
    });
    btnClearFav.onclick = function () { cfg.favs = []; saveCfg(); renderFav(); renderPanel(); };
  }

  // -----------------------------------------------------------------------
  // 全屏
  // -----------------------------------------------------------------------
  function toggleFs() {
    if (!document.fullscreenElement) {
      (video.requestFullscreen || video.webkitRequestFullscreen || function () {}).call(video);
    } else { document.exitFullscreen(); }
  }

  // -----------------------------------------------------------------------
  // 控制条 / 顶栏 事件
  // -----------------------------------------------------------------------
  function bindControls() {
    btnMenu.onclick = function () { panelOpen ? closePanel() : openPanel(); };
    btnPanelClose.onclick = closePanel;
    panelMask.onclick = closePanel;
    btnPrev.onclick = function () { stepChannel(-1); };
    btnNext.onclick = function () { stepChannel(1); };
    btnFs.onclick = toggleFs;
    btnSettings.onclick = function () { setOpen ? closeSettings() : openSettings(); };
    btnSetClose.onclick = closeSettings;
    setWrap.onclick = function (e) { if (e.target === setWrap) closeSettings(); };
    cPlay.onclick = function () { if (video.paused) video.play(); else video.pause(); };
    cMute.onclick = function () {
      cfg.muted = !cfg.muted; video.muted = cfg.muted; saveCfg();
      cMute.textContent = cfg.muted ? "🔇" : "🔊"; setMute.checked = cfg.muted;
    };
    cVol.oninput = function () {
      cfg.volume = cVol.value / 100; cfg.muted = false; saveCfg();
      video.volume = cfg.volume; video.muted = false; cMute.textContent = "🔊"; setVol.value = cVol.value;
    };
    search.oninput = renderPanel;
    video.addEventListener("playing", onPlaySuccess);
    var waitingSince = 0;
    var STALL_LIMIT = 10000;
    video.addEventListener("waiting", function () {
      if (!waitingSince) waitingSince = Date.now();
      var elapsed = Date.now() - waitingSince;
      if (elapsed >= STALL_LIMIT && !isPlaying && lineIdx + 1 < lines.length) {
        waitingSince = 0;
        dbgPush("stall " + (lineIdx + 1) + " -> next");
        tryLine(lineIdx + 1);
      } else {
        showSpin("缓冲中…");
      }
    });
    video.addEventListener("playing", function () { waitingSince = 0; hideSpin(); });
    video.addEventListener("stalled", function () { showSpin("网络缓慢…"); });
    document.addEventListener("fullscreenchange", scheduleHide);
  }

  // -----------------------------------------------------------------------
  // 键盘快捷键 (对照 inject.js)
  // -----------------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    if (e.target && e.target.tagName === "INPUT") return;
    switch (e.key) {
      case "f": case "F": toggleFs(); break;
      case " ": e.preventDefault(); if (video.paused) video.play(); else video.pause(); break;
      case "m": case "M": cfg.muted = !cfg.muted; video.muted = cfg.muted; saveCfg();
        cMute.textContent = cfg.muted ? "🔇" : "🔊"; setMute.checked = cfg.muted; break;
      case "ArrowUp": case "PageUp": e.preventDefault(); stepChannel(-1); break;
      case "ArrowDown": case "PageDown": e.preventDefault(); stepChannel(1); break;
      case "Escape": if (setOpen) closeSettings(); else if (panelOpen) closePanel(); break;
    }
  });

  // -----------------------------------------------------------------------
  // 启动
  // -----------------------------------------------------------------------
  function boot() {
    applyFit();
    bindControls(); bindSettings(); syncSettings();
    video.volume = cfg.volume; video.muted = cfg.muted;
    cVol.value = Math.round(cfg.volume * 100); cMute.textContent = cfg.muted ? "🔇" : "🔊";
    showSpin("加载频道列表…");
    fetch("/api/channels").then(function (r) { return r.json(); }).then(function (list) {
      channels = list;
      cats = {};
      channels.forEach(function (c) {
        var k = c.category || "其他";
        (cats[k] = cats[k] || []).push(c);
        byId[c.id] = c;
      });
      renderPanel();
      hideSpin();
      // 恢复上次 / 默认第一个
      var start = (cfg.resumeLast && byId[cfg._lastId]) ? byId[cfg._lastId] : channels[0];
      if (start) playChannel(start); else showOSD("无频道", 2000);
    }).catch(function () { showOSD("⚠ 频道列表加载失败", 2400); });
    scheduleHide();
  }
  boot();
})();
