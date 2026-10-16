/* LPTV —— Web 播放器前端
 *
 * 这是对原 EXE 版 inject.js 的「改造版」:
 *   - 原 inject.js 注入官方央视频 TV 网页、复用其 video 元素与 CMG 解密
 *     (switchChannel / getPlayUrl / acquireOfficial / installHlsHooks ...)。
 *   - 懒猫微服 web 模式下无法加载第三方官方页，因此这里:
 *       1) 保留 inject.js 的 UI/UX 设计 (配置、频道面板、OSD、收藏、设置、
 *          黑帧看门狗、快捷键、全屏、fit 比例)；
 *       2) 用自有播放内核替换官方页依赖: 通过后端 /api/resolve 解出真实线路，
 *          用 hls.js / mpegts.js 经 /proxy 取流。
 *   - 配置、收藏全部存 localStorage。
 *
 * 关键机制
 * --------
 * * 会话代号 seq: 每次 playChannel 自增，所有异步回调 (解析 / 超时 / 播放器错误)
 *   先校验 seq，过期即丢弃。旧频道 destroyPlayer 之后残留的 hls/flv 错误回调
 *   不会再把新频道的线路推进去 —— 这是切台偶发失败的主要根因。
 * * 线路由后端探测排序: /api/resolve 抓页后并发探测每条线路并按时延升序返回，
 *   前端只按顺序播，界面上不出现任何线路信息。
 * * 兜底: 线路耗尽或解析失败 -> fresh=1 强制后端重新抓页再试一轮，仅此一次。
 */
(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // 配置 (localStorage)
  // -----------------------------------------------------------------------
  var LS_KEY = "lptv.cfg.v2";
  var DEFAULT_CFG = {
    volume: 1, muted: false, fit: "contain",
    autoHide: true, favs: [], defMute: false, showLines: false
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
  var video = $("video"), spin = $("spin"), osd = $("osd");
  var tip = $("tip");
  var root = $("lx-root");
  var btnMenu = $("btnMenu"), btnPrev = $("btnPrev"), btnNext = $("btnNext");
  var btnFs = $("btnFs"), btnSettings = $("btnSettings");
  var panel = $("panel"), panelMask = $("panelMask");
  var tabBar = $("tabBar"), catWrap = $("catWrap");
  var setWrap = $("setWrap"), setFit = $("setFit");
  var setDefMute = $("setDefMute"), setShowLines = $("setShowLines");
  var btnLines = $("btnLines"), linePop = $("linePop"), linePopList = $("linePopList");
  var cPlay = $("cPlay"), cMute = $("cMute"), cVol = $("cVol");

  // -----------------------------------------------------------------------
  // 全局状态
  // -----------------------------------------------------------------------
  var channels = [], cats = {};
  var current = null;        // 当前频道对象
  var lines = [];            // 当前频道线路 (后端已探测排序)
  var lineIdx = -1;          // 当前线路下标
  var hls = null, flv = null;
  var loadTimer = null, isPlaying = false;
  var darkCount = 0, dbg = [];
  var uiHideT = null, panelOpen = false, setOpen = false;
  var seq = 0;               // 播放会话代号: 切台即自增，过期回调作废
  var freshUsed = false;     // 本轮是否已用过 fresh 兜底
  var stallSince = 0;        // 最近一次流中断时间戳
  var lineCache = {};        // 频道 url -> {t, lines} 前端线路缓存
  var chState = {};          // 频道 url -> "ok"(播通过) / "bad"(播失败)，行首小圆点用

  var LOAD_TIMEOUT = 30000;     // 单条线路最长等待（FLV直播流需缓冲时间）
  var STALL_TIMEOUT = 6000;     // 流中断多久后换下一条线路
  var STALL_SHOW_MS = 2000;     // 中断持续多久才盖上注水遮罩（直播补缓冲常 <2s，不算中断）
  var RESOLVE_TIMEOUT = 10000;  // 解析请求超时
  var LINE_TTL = 300000;        // 前端线路缓存有效期 (5 分钟)
  var MAX_LINES = 4;            // 最多顺序尝试的线路数，超出走 fresh 兜底
  var DARK_LIMIT = 5;           // 连续黑帧阈值 (2s 采样一次)

  // -----------------------------------------------------------------------
  // 工具
  // -----------------------------------------------------------------------
  function isFav(id) { return cfg.favs.indexOf(id) >= 0; }
  function favToggle(id) {
    var i = cfg.favs.indexOf(id);
    if (i >= 0) cfg.favs.splice(i, 1); else cfg.favs.push(id);
    saveCfg(); renderPanel();
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  // 线条图标（currentColor 着色，随 .on / .active 变色）
  var ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
  };
  function setPlayIcon() { cPlay.innerHTML = video.paused ? ICONS.play : ICONS.pause; }
  function setMuteIcon() { cMute.innerHTML = video.muted ? ICONS.mute : ICONS.vol; }
  // 音量条 UI：滑块位置 + 轨道填充百分比（下方 5 档手动刻度对齐滑块行程）
  function syncVolUI() {
    var v = Math.round(cfg.volume * 100);
    cVol.value = v;
    cVol.style.background = "linear-gradient(90deg,var(--accent) " + v +
      "%,rgba(255,255,255,.15) " + v + "%)";
  }
  function showOSD(txt, ms) {
    osd.innerHTML = txt; osd.classList.remove("hidden");
    clearTimeout(showOSD._t);
    showOSD._t = setTimeout(function () { osd.classList.add("hidden"); }, ms || 1600);
  }
  function showSpin() { spin.classList.remove("hidden"); }
  function hideSpin() { spin.classList.add("hidden"); }
  // 悬停提示：显示在图标正上方居中，贴边时自动收进屏幕内
  function showTip(elm) {
    var t = elm.dataset ? elm.dataset.tip : null;
    if (!t) return;
    tip.textContent = t;
    tip.classList.remove("hidden");
    var r = elm.getBoundingClientRect();
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    var y = r.top - th - 10;
    if (y < 8) y = r.bottom + 10;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip() { tip.classList.add("hidden"); }
  function dbgPush(s) {
    dbg.push(s); if (dbg.length > 40) dbg.shift();
    if (window.console) console.log("[lptv]", s);
  }
  function alive(mySeq) { return mySeq === seq; }
  function lineBudget() { return Math.min(lines.length, MAX_LINES); }

  // -----------------------------------------------------------------------
  // 频道面板 / 收藏：央视 / 卫视 / 收藏 三个 tab 切换显示
  // -----------------------------------------------------------------------
  var activeTab = "央视";
  // 台号：央视 1~N，卫视接着往下排（收藏 tab 沿用同一套号）
  var numByKey = {}, chByNum = {}, maxDigits = 2;
  var numBuf = "", numTimer = null;
  function buildNumbers() {
    numByKey = {}; chByNum = {};
    var n = 0;
    ["央视", "卫视"].forEach(function (cat) {
      (cats[cat] || []).forEach(function (c) {
        n++;
        numByKey[c.url] = n;
        chByNum[n] = c;
      });
    });
    maxDigits = String(n).length;
  }
  function channelRow(ch) {
    var row = el("div", "ch-row");
    row.dataset.key = ch.url;   // url 全局唯一（id 只在单个 tid 内唯一，不能做 key）
    var num = el("span", "num", numByKey[ch.url] || "");
    var nm = el("span", "nm", ch.name);
    // 状态小圆点：ok=绿(播通过) / bad=红(播失败) / 无类=灰(未知)
    var st = chState[ch.url];
    var dot = el("span", "dot" + (st === "ok" ? " ok" : st === "bad" ? " bad" : ""));
    var star = el("span", "star" + (isFav(ch.id) ? " on" : ""), ICONS.star);
    star.onclick = function (e) { e.stopPropagation(); favToggle(ch.id); };
    row.appendChild(num); row.appendChild(nm); row.appendChild(dot); row.appendChild(star);
    row.onclick = function () { playChannel(ch); closePanel(); };
    if (current && ch.url === current.url) row.classList.add("active");
    return row;
  }
  // 只刷新可见行的小圆点，不重建列表（避免滚动位置跳动）
  function paintDots() {
    Array.prototype.forEach.call(document.querySelectorAll(".ch-row"), function (r) {
      var d = r.querySelector(".dot");
      if (!d) return;
      var st = chState[r.dataset.key];
      d.className = "dot" + (st === "ok" ? " ok" : st === "bad" ? " bad" : "");
    });
  }
  function syncTabs() {
    Array.prototype.forEach.call(tabBar.children, function (b) {
      b.classList.toggle("active", b.dataset.tab === activeTab);
    });
  }
  function matchQ(c, q) { return !q || c.name.toLowerCase().indexOf(q) >= 0; }
  function renderPanel() {
    syncTabs();
    var q = "";
    catWrap.innerHTML = "";
    var list, hint = "";
    if (activeTab === "收藏") {
      list = channels.filter(function (c) { return isFav(c.id) && matchQ(c, q); });
      if (!list.length) hint = q ? "收藏里没有匹配的频道" : "暂无收藏<br>点击频道旁的 ★ 即可收藏";
    } else {
      list = (cats[activeTab] || []).filter(function (c) { return matchQ(c, q); });
      if (!list.length) hint = q ? "没有匹配的频道" : "该分类暂无频道";
    }
    if (hint) { catWrap.appendChild(el("div", "empty-hint", hint)); return; }
    var box = el("div", "ch-list");
    list.forEach(function (c) { box.appendChild(channelRow(c)); });
    catWrap.appendChild(box);
  }
  function openPanel() {
    if (current && (current.category === "央视" || current.category === "卫视")) {
      activeTab = current.category;
    }
    renderPanel();
    panel.classList.add("open"); panelMask.classList.remove("hidden"); panelOpen = true;
  }
  function closePanel() { panel.classList.remove("open"); panelMask.classList.add("hidden"); panelOpen = false; }

  // -----------------------------------------------------------------------
  // 播放内核
  // -----------------------------------------------------------------------
  function destroyPlayer() {
    stallSince = 0; darkCount = 0; lastTick = 0;
    try { if (hls) { hls.destroy(); hls = null; } } catch (e) {}
    try { if (flv) { flv.destroy(); flv = null; } } catch (e) {}
    try {
      video.pause();
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    } catch (e) {}
  }
  function applyFit() { video.style.objectFit = cfg.fit; }

  // 按顺序尝试第 i 条线路。所有回调先校验 mySeq，切台后的残留回调一律作废。
  function loadLine(i) {
    var mySeq = seq;
    if (i >= lineBudget()) { onAllLinesFailed(mySeq); return; }
    lineIdx = i;
    var ln = lines[i];
    if (linesOpen) renderLines();
    destroyPlayer();
    showSpin();
    isPlaying = false;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (!alive(mySeq) || isPlaying) return;
      dbgPush("line " + (i + 1) + " timeout -> next");
      loadLine(i + 1);
    }, LOAD_TIMEOUT);

    var src = "/proxy?u=" + encodeURIComponent(ln.url);
    if (ln.type === "flv" && window.mpegts && mpegts.isSupported()) {
      flv = mpegts.createPlayer({ type: "flv", isLive: true, url: src, cors: true },
        { lazyLoad: false, liveBufferLatency: 3, liveBufferLatencyMaxLatency: 5 });
      flv.attachMediaElement(video);
      flv.on(mpegts.Events.ERROR, function () {
        if (!alive(mySeq)) return;
        dbgPush("flv err -> next");
        // 延一拍再销毁，避免在播放器自身回调栈里 destroy 造成重入
        setTimeout(function () { loadLine(i + 1); }, 0);
      });
      flv.load();
      var p = flv.play();
      if (p && p.catch) p.catch(function () {});
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false, enableWorker: true, capLevelToPlayerSize: true,
        startLevel: 0, liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 3,
        maxBufferLength: 20, maxBufferSize: 0,
        manifestLoadingTimeOut: 8000, manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 8000, levelLoadingMaxRetry: 2,
        fragmentLoadingTimeOut: 8000, fragmentLoadingMaxRetry: 2,
        enableSoftInactivityDetection: false
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        if (!alive(mySeq)) return;
        video.play().catch(function () {});
      });
      hls.on(Hls.Events.ERROR, function (e, d) {
        if (!alive(mySeq)) return;
        if (d && d.fatal) {
          dbgPush("hls fatal -> next");
          setTimeout(function () { loadLine(i + 1); }, 0);
        }
      });
      hls.attachMedia(video); hls.loadSource(src);
    } else {
      video.src = src; video.play().catch(function () {});
      video.onerror = function () {
        if (!alive(mySeq)) return;
        dbgPush("native err -> next");
        loadLine(i + 1);
      };
    }
  }

  function onPlaySuccess() {
    isPlaying = true; hideSpin(); darkCount = 0; stallSince = 0;
    clearTimeout(loadTimer);
    if (current) { chState[current.url] = "ok"; paintDots(); }
  }

  // 线路耗尽 / 解析失败：用 fresh=1 强制后端重新抓页再试一轮，仅此一次。
  function onAllLinesFailed(mySeq) {
    if (!alive(mySeq)) return;
    if (!freshUsed) {
      freshUsed = true;
      if (!current) return;
      dbgPush("failover: force fresh resolve");
      showOSD("⚠ 加载失败，重试中…", 2400);
      setTimeout(function () {
        if (alive(mySeq)) resolveAndPlay(current, mySeq, true);
      }, 350);
      return;
    }
    dbgPush("failover: exhausted");
    showOSD("⚠ 频道加载失败，请稍后再试", 3200);
    showSpin();
    if (current) { chState[current.url] = "bad"; paintDots(); }
  }

  function resolveAndPlay(ch, mySeq, forceFresh) {
    if (!alive(mySeq)) return;
    showSpin();
    if (!forceFresh) {
      var hit = lineCache[ch.url];
      if (hit && hit.lines && hit.lines.length && Date.now() - hit.t < LINE_TTL) {
        dbgPush("line cache hit");
        lines = hit.lines; lineIdx = -1; loadLine(0);
        return;
      }
    }
    var qs = "?url=" + encodeURIComponent(ch.url) + (forceFresh ? "&fresh=1" : "");
    var ac = window.AbortController ? new AbortController() : null;
    var tm = setTimeout(function () { if (ac) ac.abort(); }, RESOLVE_TIMEOUT);
    fetch("/api/resolve" + qs, ac ? { signal: ac.signal } : {}).then(function (r) {
      clearTimeout(tm);
      return r.json();
    }).then(function (j) {
      if (!alive(mySeq)) return;
      if (!j || !j.lines || !j.lines.length) {
        dbgPush("resolve: empty");
        onAllLinesFailed(mySeq);
        return;
      }
      lines = j.lines; lineIdx = -1;
      lineCache[ch.url] = { t: Date.now(), lines: j.lines };
      loadLine(0);
    }).catch(function (e) {
      clearTimeout(tm);
      if (!alive(mySeq)) return;
      dbgPush("resolve err: " + ((e && e.message) || e));
      onAllLinesFailed(mySeq);
    });
  }

  function playChannel(ch, opts) {
    if (!ch) return;
    seq++;
    var mySeq = seq;
    freshUsed = false;
    clearTimeout(loadTimer); loadTimer = null;
    closeLines();
    destroyPlayer();
    current = ch;
    Array.prototype.forEach.call(document.querySelectorAll(".ch-row"), function (r) {
      r.classList.toggle("active", r.dataset.key === ch.url);
    });
    resolveAndPlay(ch, mySeq, !!(opts && opts.fresh));
  }

  function stepChannel(dir) {
    if (!channels.length) return;
    var idx = channels.indexOf(current);
    if (idx < 0) idx = 0;
    idx = (idx + dir + channels.length) % channels.length;
    var ch = channels[idx];
    showOSD("切换：" + ch.name);
    playChannel(ch);
  }

  // -----------------------------------------------------------------------
  // 流中断看门狗
  // -----------------------------------------------------------------------
  // 注意: 直播流的 waiting/stalled/suspend 会**频繁**触发（补缓冲、浏览器主动暂停拉流、
  // 关键帧等待）。如果在事件里直接 showSpin()，注水遮罩就会不停盖住再露出播放画面。
  // 所以事件只记录时间点，持续超过 STALL_SHOW_MS 才遮罩；一旦流动恢复立即撤下。
  // -----------------------------------------------------------------------
  function bindMedia() {
    video.addEventListener("playing", onPlaySuccess);
    video.addEventListener("playing", setPlayIcon);
    video.addEventListener("pause", setPlayIcon);
    ["timeupdate", "canplay"].forEach(function (ev) {
      video.addEventListener(ev, function () {
        if (!stallSince) return;
        stallSince = 0;
        if (isPlaying) hideSpin();          // 从中断恢复 -> 撤下遮罩，交回播放画面
      });
    });
    ["waiting", "stalled", "suspend"].forEach(function (ev) {
      video.addEventListener(ev, function () {
        if (!isPlaying) return;             // 首播前的缓冲不算中断，遮罩由 loadLine 负责
        if (!stallSince) stallSince = Date.now();
      });
    });
    setInterval(function () {
      if (!stallSince) return;
      var dur = Date.now() - stallSince;
      if (dur >= STALL_SHOW_MS) showSpin();
      if (dur >= STALL_TIMEOUT && lineIdx + 1 < lineBudget()) {
        dbgPush("stall line " + (lineIdx + 1) + " -> next");
        stallSince = 0;
        loadLine(lineIdx + 1);
      }
    }, 500);
  }

  // -----------------------------------------------------------------------
  // 黑帧看门狗 (移植自 inject.js.recoverBlack，用于卡黑屏时换线)
  // -----------------------------------------------------------------------
  var darkCanvas = document.createElement("canvas");
  darkCanvas.width = 32; darkCanvas.height = 18;
  var dctx = darkCanvas.getContext("2d");
  var lastTick = 0;       // 上次采样的 video.currentTime
  function watchDog() {
    if (!isPlaying || video.paused || video.readyState < 2) {
      darkCount = 0; lastTick = 0; return;
    }
    var t = video.currentTime;
    var frozen = lastTick > 0 && t <= lastTick;
    lastTick = t;
    // 必须同时满足「时间轴停摆」才算真卡住。否则夜景、倒计时黑屏等正常暗画面会被
    // 误判成死流，触发换线/重新解析 -> showSpin() 反复盖住正在播放的画面。
    // 时间轴在走就不管；冻结在亮帧上则由上面的流中断看门狗兜底。
    if (!frozen) { darkCount = 0; return; }
    var mySeq = seq;
    try {
      dctx.drawImage(video, 0, 0, 32, 18);
      var d = dctx.getImageData(0, 0, 32, 18).data;
      var sum = 0; for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      var avg = sum / (d.length / 4) / 3;
      if (avg < 20) { darkCount++; } else { darkCount = 0; }
      if (darkCount >= DARK_LIMIT) {
        dbgPush("black frame -> recover");
        darkCount = 0;
        if (!alive(mySeq)) return;
        if (lineIdx + 1 < lineBudget()) loadLine(lineIdx + 1);
        else if (current) resolveAndPlay(current, seq, true);
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
  // 底栏：鼠标 Y 进入底部 80px 显示，离开隐藏
  var CTRL_HOVER_ZONE = 80;
  document.addEventListener("mousemove", function(e) {
    if (e.clientY >= window.innerHeight - CTRL_HOVER_ZONE) {
      ctrl.classList.add("ctrl-show");
    } else {
      ctrl.classList.remove("ctrl-show");
    }
  }, { passive: true });
  // 移动端没有 hover：点画面一下呼出底栏，3s 无操作自动收起（面板打开时不收）
  var IS_TOUCH = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
  var ctrlTimer = null;
  if (IS_TOUCH) {
    video.addEventListener("click", function () {
      var bar = $("ctrl");
      clearTimeout(ctrlTimer);
      if (bar.classList.contains("ctrl-show")) { bar.classList.remove("ctrl-show"); return; }
      bar.classList.add("ctrl-show");
      ctrlTimer = setTimeout(function () {
        if (!panelOpen && !setOpen && !linesOpen) bar.classList.remove("ctrl-show");
      }, 3000);
    });
  }
  ["mousemove", "touchstart", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, wakeUI, true);
  });

  // -----------------------------------------------------------------------
  // 设置面板
  // -----------------------------------------------------------------------
  function openSettings() { setOpen = true; syncSettings(); setWrap.classList.add("open"); }
  function closeSettings() { setOpen = false; setWrap.classList.remove("open"); }
  function syncSettings() {
    setDefMute.checked = !!cfg.defMute;
    setShowLines.checked = !!cfg.showLines;
    Array.prototype.forEach.call(setFit.children, function (b) {
      b.classList.toggle("active", b.dataset.fit === cfg.fit);
    });
  }
  function bindSettings() {
    Array.prototype.forEach.call(setFit.children, function (b) {
      b.onclick = function () {
        cfg.fit = b.dataset.fit; saveCfg(); applyFit(); syncSettings();
      };
    });
    setDefMute.onchange = function () {
      cfg.defMute = setDefMute.checked; saveCfg();
      video.muted = cfg.defMute;
      setMuteIcon();
    };
    setShowLines.onchange = function () {
      cfg.showLines = setShowLines.checked; saveCfg(); syncLineBtn();
    };
  }

  // -----------------------------------------------------------------------
  // 线路切换浮层：勾选设置后在播放键左侧出现 ⇄，点开横排显示所有线路名
  // -----------------------------------------------------------------------
  var linesOpen = false;
  function renderLines() {
    linePopList.innerHTML = "";
    if (!lines.length) {
      linePopList.appendChild(el("div", "line-empty", "暂无线路"));
      return;
    }
    lines.forEach(function (ln, i) {
      var b = el("button", "line-chip" + (i === lineIdx ? " active" : ""),
        ln.label || ("线路" + (i + 1)));
      b.onclick = (function (idx) {
        return function () { loadLine(idx); closeLines(); };
      })(i);
      linePopList.appendChild(b);
    });
  }
  function openLines() { renderLines(); linesOpen = true; linePop.classList.add("open"); }
  function closeLines() { linesOpen = false; linePop.classList.remove("open"); }
  function syncLineBtn() {
    btnLines.classList.toggle("hidden", !cfg.showLines);
    if (!cfg.showLines) closeLines();
  }

  // -----------------------------------------------------------------------
  // 全屏
  // -----------------------------------------------------------------------
  function toggleFs() {
    if (!document.fullscreenElement) {
      // iOS Safari 只有 video.webkitEnterFullscreen（注意不是 webkitRequestFullscreen）
      (video.requestFullscreen || video.webkitEnterFullscreen ||
       video.webkitRequestFullscreen || function () {}).call(video);
    } else { document.exitFullscreen(); }
  }

  // -----------------------------------------------------------------------
  // 控制条 / 顶栏 事件
  // -----------------------------------------------------------------------
  function bindControls() {
    btnMenu.onclick = function () { panelOpen ? closePanel() : openPanel(); };
    
    panelMask.onclick = closePanel;
    Array.prototype.forEach.call(tabBar.children, function (b) {
      b.onclick = function () { activeTab = b.dataset.tab; renderPanel(); };
    });
    btnPrev.onclick = function () { stepChannel(-1); };
    btnNext.onclick = function () { stepChannel(1); };
    btnFs.onclick = toggleFs;
    btnLines.onclick = function () { linesOpen ? closeLines() : openLines(); };
    btnSettings.onclick = function () { setOpen ? closeSettings() : openSettings(); };
    
    setWrap.onclick = function (e) { if (e.target === setWrap) closeSettings(); };
    cPlay.onclick = function () { if (video.paused) video.play(); else video.pause(); };
    cMute.onclick = function () {
      cfg.muted = !cfg.muted; video.muted = cfg.muted; saveCfg();
      setMuteIcon();
    };
    cVol.oninput = function () {
      cfg.volume = cVol.value / 100; cfg.muted = false; saveCfg();
      video.volume = cfg.volume; video.muted = false; setMuteIcon(); syncVolUI();
    };
    
    Array.prototype.forEach.call(document.querySelectorAll("[data-tip]"), function (b) {
      b.addEventListener("mouseenter", function () { showTip(b); });
      b.addEventListener("mouseleave", hideTip);
      b.addEventListener("focus", function () { showTip(b); });
      b.addEventListener("blur", hideTip);
    });
    document.addEventListener("click", hideTip, true);
    document.addEventListener("fullscreenchange", scheduleHide);
  }

  // -----------------------------------------------------------------------
  // 数字换台：输 1 位停 1.5s 等第二位，输满位数立即跳；Enter 立即确认，Esc 取消
  function commitNum() {
    clearTimeout(numTimer);
    var n = parseInt(numBuf, 10);
    numBuf = "";
    var ch = chByNum[n];
    if (!ch) {
      if (n) showOSD("无此台号：" + n, 1500);
      return;
    }
    showOSD("切换：" + ch.name);
    playChannel(ch);
  }
  function numInput(d) {
    if (!channels.length) return;
    numBuf += d;
    if (numBuf.length >= maxDigits) { commitNum(); return; }
    showOSD("换台：" + numBuf, 1500);
    clearTimeout(numTimer);
    numTimer = setTimeout(commitNum, 1500);
  }

  // 键盘快捷键 (对照 inject.js)
  // -----------------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.key >= "0" && e.key <= "9" && e.key.length === 1) { numInput(e.key); return; }
    switch (e.key) {
      case "Enter": if (numBuf) commitNum(); break;
      case "f": case "F": toggleFs(); break;
      case " ": e.preventDefault(); if (video.paused) video.play(); else video.pause(); break;
      case "m": case "M": cfg.muted = !cfg.muted; video.muted = cfg.muted; saveCfg();
        setMuteIcon(); break;
      case "ArrowUp": case "PageUp": e.preventDefault(); stepChannel(-1); break;
      case "ArrowDown": case "PageDown": e.preventDefault(); stepChannel(1); break;
      case "Escape":
        numBuf = ""; clearTimeout(numTimer);
        if (linesOpen) closeLines();
        else if (setOpen) closeSettings(); else if (panelOpen) closePanel();
        break;
    }
  });

  // -----------------------------------------------------------------------
  // 启动
  // -----------------------------------------------------------------------
  // 默认频道：CCTV-1 综合。注意 channels.json 里 id 只在单个 tid 内唯一
  // (CCTV-1 与湖南卫视都是 id:1)，所以必须按名称匹配，不能按 id。
  function pickDefaultChannel() {
    var re = /^cctv[- ]?1\b/i;
    for (var i = 0; i < channels.length; i++) {
      if (re.test((channels[i].name || "").trim())) return channels[i];
    }
    return channels[0] || null;
  }

  function boot() {
    applyFit();
    bindMedia(); bindControls(); bindSettings(); syncSettings();
    video.volume = cfg.volume; video.muted = !!(cfg.defMute || cfg.muted); video.preload = "auto";
    syncVolUI(); setMuteIcon(); setPlayIcon();
    syncLineBtn();
    $("setYear").textContent = "©" + new Date().getFullYear() + " LPTV";
    showSpin();
    fetch("/api/channels").then(function (r) { return r.json(); }).then(function (list) {
      channels = list;
      cats = {};
      channels.forEach(function (c) {
        var k = c.category || "其他";
        (cats[k] = cats[k] || []).push(c);
      });
      buildNumbers();
      renderPanel();
      var start = pickDefaultChannel();
      if (start) playChannel(start); else showOSD("无频道", 2000);
    }).catch(function () { showOSD("⚠ 频道列表加载失败", 2400); });
    scheduleHide();
  }
  boot();
})();
