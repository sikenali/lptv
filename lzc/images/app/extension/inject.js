/* LPTV — PC 模式注入层 (纯原生 JS, 无框架, 可移植)
 *
 * 架构 (方案C-v2, 官方画面复用):
 *   官方 yangshipin TV 播放器自带 CMG 解密 (其解码必然正确)。
 *   我们不再自建 Hls/解密, 而是:
 *     - 复用官方 video 元素: 强制铺满视口 (position:fixed; z 2147483001)
 *       (已实测: 修改 video 元素几何 不触发 CMG 黑帧检测; 注意: ".tv-home-list"
 *        等页面 UI 元素仍必须保持零改动)
 *     - 自建 UI 覆盖层 #lptv-root (z 2147483002, 透明) 承载 OSD/频道面板/设置/黑帧看门狗
 *   多端移植: 本文件即全部前端。壳层只需 加载官方页 + 注入本文件
 *     + (可选) LPTV.setChannels()/LPTV.boot()
 */

(function () {
  if (window.__lptv) return;

  var LS_KEY = "lptv.cfg.v3";
  var DEFAULT_CFG = {
    volume: 1,
    muted: false,
    maxQuality: true,        // 默认强制官方播放器最高画质
    fit: "contain",          // contain: 完整画面(黑边) | cover: 铺满(裁剪) | fill: 拉伸铺满(变形不裁切)
    blackRecovery: true,     // 黑帧自动恢复 (恒开, 不再提供开关)
    autoHide: 3500,
    resumeLast: true,        // 启动恢复最后播放频道
    favs: []                 // 收藏频道 pid 列表 (按收藏时间排序)
  };

  var LPTV = window.__lptv = {
    playUrl: "",
    currentPid: "",
    channels: [],
    video: null,             // 官方 video 元素 (我们复用的画面源)
    currentHls: null,        // 官方 Hls 实例 (画质控制用)
    darkCount: 0,
    digits: "",
    devHidden: false,
    _lastLoad: 0,
    _loadedPid: "",
    _autoplayPending: false,
    _panelIn: false,
    _panelHideT: null,
    _panelArmed: true,
    _epgIn: false,
    _epgHideT: null,
    _epgArmed: true,
    epg: { cache: {} },
    _dbg: [],
    ui: {}
  };

  var cfg = loadCfg();

  /* 启动黑幕: 兜底在壳层 show() 之前页面已渲染时, 也不闪出官方页;
     官方画面开始播放后自动淡出 */
  try { if (document.body) bootmask(); } catch (e) {}

  function loadCfg() {
    try {
      return Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(LS_KEY) || "{}"));
    } catch (e) { return Object.assign({}, DEFAULT_CFG); }
  }
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ================= 收藏频道 ================= */
  function favHas(pid) {
    return (cfg.favs || []).indexOf(pid) >= 0;
  }
  function favToggle(pid) {
    if (!pid) return false;
    cfg.favs = cfg.favs || [];
    var i = cfg.favs.indexOf(pid);
    if (i >= 0) cfg.favs.splice(i, 1);
    else cfg.favs.push(pid);
    saveCfg();
    pyStatePush({ favs: cfg.favs });  // 持久化到 Python (localStorage 不跨启动)
    return i < 0;  // 返回收藏后的状态: true=已收藏
  }

  /* ---- Python 侧持久化状态 (pywebview 默认 private_mode, localStorage 不跨启动) ---- */
  function pyApi() {
    return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
  }
  var _statePushT = null, _statePending = null;
  function pyStatePush(patch) {
    _statePending = Object.assign(_statePending || {}, patch);
    clearTimeout(_statePushT);
    _statePushT = setTimeout(function () {
      var p = _statePending; _statePending = null;
      var api = pyApi();
      if (api && api.set_ui_state) {
        try { api.set_ui_state(JSON.stringify(p)); } catch (e) {}
      }
    }, 800);  // 节流
  }

  function bootmask() {
    if (document.getElementById("lptv-bootmask")) return;
    var st = el("style", { id: "lptv-bootmask-style" });
    st.textContent =
      "#lptv-bootmask{position:fixed;inset:0;background:#000;z-index:2147483003;}\n" +
      "#lptv-bootmask .lptv-bmask-spin{position:absolute;left:50%;top:50%;width:46px;height:46px;" +
      "margin:-29px 0 0 -29px;border-radius:50%;border:3px solid rgba(255,255,255,.15);" +
      "border-top-color:#4f7cff;animation:lptvbmaskspin .8s linear infinite}\n" +
      "@keyframes lptvbmaskspin{to{transform:rotate(360deg)}}";
    (document.head || document.documentElement).appendChild(st);
    var m = el("div", { id: "lptv-bootmask" });
    m.appendChild(el("div", { class: "lptv-bmask-spin" }));
    (document.body || document.documentElement).appendChild(m);
  }
  function removeBootmask() {
    var m = document.getElementById("lptv-bootmask");
    var st = document.getElementById("lptv-bootmask-style");
    if (m) {
      try { m.style.transition = "opacity .6s"; m.style.opacity = "0"; } catch (e) {}
      setTimeout(function () { if (m.parentNode) m.parentNode.removeChild(m); }, 700);
    }
    if (st) setTimeout(function () { if (st.parentNode) st.parentNode.removeChild(st); }, 800);
  }

  /* ================= Hook: 拦截 get_live_info → playUrl ================= */

  var OrigOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var u = String(url || "");
    if (u.indexOf("get_live_info") >= 0 || u.indexOf("live_info") >= 0) {
      this.addEventListener("load", function () {
        try {
          var d = JSON.parse(this.responseText).data;
          if (d && d.iretcode === 0 && d.playurl) onPlayUrl(d.playurl);
        } catch (e) {}
      });
    }
    // 节目单: 官方切台时按真实 pid 抓 capi EPG (protobuf), 我们顺势缓存
    // 注意: 必须从 URL 提取真实 ymd 传入 epgStore, 否则官方浏览未来日期时
    // 会把未来节目单写进"今天"键, 导致点回今天仍显示未来节目 (已修复的历史 bug)
    if (u.indexOf("/api/yspepg/program/") >= 0) {
      this.addEventListener("load", function () {
        try {
          if (this.responseType !== "arraybuffer") return;
          var m2 = String(this.responseURL || url).match(/program\/(\d+)\/(\d{8})/);
          if (m2) {
            var progs = parseEpg(this.response);
            if (progs.length) epgStore(m2[1], progs, m2[2]);
          }
        } catch (e) {}
      });
    }
    return OrigOpen.apply(this, arguments);
  };

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var url = arguments[0] && String(arguments[0]);
      var p = origFetch.apply(this, arguments);
      if (url && (url.indexOf("get_live_info") >= 0 || url.indexOf("live_info") >= 0)) {
        p.then(function (r) {
          return r.clone().json().then(function (d) {
            var dd = d && d.data;
            if (dd && dd.iretcode === 0 && dd.playurl) onPlayUrl(dd.playurl);
          }).catch(function () {});
        });
      }
      return p;
    };
  }

  function pidFromUrl(u) {
    var m = String(u).match(/[?&]pid=(\d+)/);
    return m ? m[1] : "";
  }

  function onPlayUrl(url) {
    var pid = pidFromUrl(url);
    if (pid) {
      // 防过期响应: 切台后短时间内, 旧频道的 straggler 响应不得回写状态
      // (启动时官方页的旧请求/切台重试的迟到响应会把 lastPid 污染回上一个台)
      if (LPTV._pidBefore && pid === LPTV._pidBefore &&
          Date.now() - (LPTV._switchAt || 0) < 6000) {
        dbg("stale pu ignored: " + pid);
        return;
      }
      // 收割的频道先用合成 pid(x...)占位, 收到官网真实 pid 后替换, 保持身份稳定
      if (LPTV.currentPid && String(LPTV.currentPid).charAt(0) === "x") {
        var ch = LPTV.channels.find(function (c) { return c.pid === LPTV.currentPid; });
        if (ch) ch.pid = pid;
      }
      LPTV.currentPid = pid;
    }
    // 记忆最后播放频道 (含启动首台)
    if (pid && /^\d+$/.test(String(pid))) {
      cfg.lastPid = pid;
      saveCfg();
      pyStatePush({ lastPid: pid });  // 跨启动持久化
    }
    markActive();
    epgSync();
    if (url === LPTV.playUrl) return;
    LPTV.playUrl = url;
    LPTV._loadedPid = pid || LPTV._loadedPid;
    dbg("pu:" + url.slice(0, 30));
    showOSD(chNumLabel(), "正在直播 · " + chNameOf(LPTV.currentPid));
  }

  function dbg(s) {
    LPTV._dbg.push(((new Date()).getTime() % 100000) + " " + s);
    if (LPTV._dbg.length > 30) LPTV._dbg.shift();
  }

  /* ================= 官方视频元素 (画面源) ================= */

  function acquireOfficial() {
    var list = document.querySelectorAll("video");
    var cand = null;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!cand) cand = v;
      if (v.videoWidth && (!cand.videoWidth || v.videoWidth > cand.videoWidth)) cand = v;
    }
    if (!cand) return;
    if (cand !== LPTV.video) {
      dbg("ov=" + (cand === LPTV.video ? "same" : "acquire"));
      LPTV.video = cand;
      if (!LPTV._ovBound) { bindVideoEvents(); LPTV._ovBound = true; }
      styleOfficial();
    }
  }

  function styleOfficial() {
    var v = LPTV.video;
    if (!v) return;
    v.style.setProperty("position", "fixed", "important");
    v.style.setProperty("left", "0px", "important");
    v.style.setProperty("top", "0px", "important");
    v.style.setProperty("width", "100vw", "important");
    v.style.setProperty("height", "100vh", "important");
    v.style.setProperty("z-index", "2147483001", "important");
    v.style.setProperty("object-fit", cfg.fit === "cover" ? "cover" : (cfg.fit === "fill" ? "fill" : "contain"), "important");
    v.style.setProperty("background", "#000", "important");
    v.style.setProperty("max-width", "none", "important");
    v.style.setProperty("max-height", "none", "important");
    v.style.setProperty("margin", "0", "important");
  }

  function bindVideoEvents() {
    var v = LPTV.video;
    v.addEventListener("loadeddata", function () { showSpin(false); });
    v.addEventListener("waiting", function () { showSpin(true); dbg("vwaiting t=" + Math.floor(v.currentTime)); });
    v.addEventListener("stalled", function () { showSpin(true); dbg("vstalled"); });
    // 官方播放器切台时会重置音量为默认(50%) -> 强制回到用户设置的音量
    v.addEventListener("volumechange", function () {
      if (LPTV._volLock || !cfg || cfg.muted) return;
      var want = cfg.volume != null ? cfg.volume : 1;
      if (Math.abs(v.volume - want) > 0.02) {
        LPTV._volLock = true;
        v.volume = want;
        setTimeout(function () { LPTV._volLock = false; }, 50);
        dbg("volock " + Math.round(v.volume * 100) + "->" + Math.round(want * 100));
      }
    });
    v.addEventListener("playing", function () {
      LPTV._resumes = 0;
      showSpin(false);
      removeBootmask();  // 官方画面已开始 -> 淡出启动黑幕
      dbg("vplaying t=" + Math.floor(v.currentTime));
      if (!cfg.muted && v.volume !== (cfg.volume != null ? cfg.volume : 1)) {
        v.volume = cfg.volume != null ? cfg.volume : 1;
      }
      showOSD(chNumLabel(), "正在直播 · " + chNameOf(LPTV.currentPid));
      hideHint();
    });
    v.addEventListener("pause", function () { dbg("vpause t=" + Math.floor(v.currentTime)); handleExternalPause(); });
    v.addEventListener("error", function () { dbg("verror " + (v.error && v.error.code)); });
  }

  var _resumeT = null;
  function handleExternalPause() {
    var v = LPTV.video;
    if (!LPTV._autoplayPending || !v) return;
    if (!(v.readyState >= 2 && v.videoWidth)) return;
    if (LPTV._resumes > 12) return;
    clearTimeout(_resumeT);
    _resumeT = setTimeout(function () {
      if (LPTV._autoplayPending && v.paused && v.readyState >= 2 && v.videoWidth) {
        LPTV._resumes = (LPTV._resumes || 0) + 1;
        dbg("vresume #" + LPTV._resumes);
        tryPlay();
      }
    }, 400);
  }

  function tryPlay() {
    var v = LPTV.video;
    if (!v) return;
    v.volume = cfg.volume;
    v.muted = cfg.muted;
    var p = v.play();
    if (p && p.catch) {
      p.catch(function () {
        dbg("tryPlay reject (policy)");
        v.muted = true;
        cfg.muted = true; saveCfg(); syncMuteBtn();
        var p2 = v.play();
        if (p2 && p2.catch) p2.catch(function () { dbg("tryPlay2 reject"); });
        showHint("受自动播放策略影响已静音播放，按 M 键开启声音");
      });
    } else {
      dbg("tryPlay ok");
    }
  }

  /* ================= 画质: 复用官方 Hls 实例, 默认强制最高 ================= */

  function installHlsHooks() {
    if (!window.Hls || window.Hls.__lxBoosted) return;
    window.Hls.__lxBoosted = true;
    var origLoad = window.Hls.prototype.loadSource;
    window.Hls.prototype.loadSource = function (url) {
      LPTV.currentHls = this;
      dbg("hls: source " + String(url).slice(0, 26));
      if (cfg.maxQuality) applyMaxQuality(this);
      return origLoad.apply(this, arguments);
    };
  }

  function applyMaxQuality(inst) {
    if (!inst || !cfg.maxQuality) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var done = false;
      try {
        var lv = inst.levels;
        if (lv && lv.length) {
          var mx = 0;
          for (var i = 1; i < lv.length; i++) {
            if (lv[i].bitrate > lv[mx].bitrate) mx = i;
          }
          try { if (inst.currentLevel !== mx) inst.currentLevel = mx; } catch (e) {}
          done = tries >= 4;  // 多敲几次, 防页面 ABR/选择后回落
        } else if (tries >= 15) {
          done = true;
        }
      } catch (e) { done = tries >= 15; }
      if (done) clearInterval(timer);
    }, 500);
  }

  function setQuality() {
    var inst = LPTV.currentHls;
    if (!inst) return;
    if (cfg.maxQuality) applyMaxQuality(inst);
    else {
      try {
        if (inst.currentLevel > -1) inst.currentLevel = -1;
        inst.autoLevelEnabled = true;
        inst.loadLevel = -1;
      } catch (e) {}
    }
  }

  function syncFit() {
    var sel = document.getElementById("lptv-s-fit");
    if (sel) sel.value = cfg.fit;
  }

  /* 低频保活: 官方元素被替换/样式复位时重铺; 窗口 resize 后官方可能改回样式;
   异常暂停时恢复 */
  setInterval(function () {
    acquireOfficial();
    styleOfficial();
    var v = LPTV.video;
    if (!v) return;
    if (v.paused && LPTV._autoplayPending && v.readyState >= 2 && v.videoWidth &&
        (LPTV._resumes || 0) < 12) {
      dbg("wkr " + Math.floor(v.currentTime));
      tryPlay();
    }
  }, 3000);

  /* ================= 黑帧看门狗 ================= */

  var wcanvas = document.createElement("canvas");
  wcanvas.width = 48; wcanvas.height = 27;
  var wctx = wcanvas.getContext("2d");

  setInterval(function () {
    var v = LPTV.video;
    if (!v || v.paused || v.readyState < 2 || !v.videoWidth) return;
    try {
      wctx.drawImage(v, 0, 0, 48, 27);
      var d = wctx.getImageData(0, 0, 48, 27).data;
      var sum = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      var avg = sum / (n * 3);
      if (avg < 12) {
        LPTV.darkCount++;
        if (LPTV.darkCount >= 3) recoverBlack();  // 恒开 (设置中不再提供开关)
      } else {
        LPTV.darkCount = 0;
      }
    } catch (e) {}
  }, 4000);

  function recoverBlack() {
    LPTV.darkCount = 0;
    var v = LPTV.video;
    if (v) {
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); }
    }
    switchChannel(LPTV.currentPid);
    toast("检测到黑帧，已自动恢复");
  }

  /* ================= 频道逻辑 ================= */

  function officialNameOf(pid) {
    var ch = LPTV.channels.find(function (c) { return c.pid === pid; });
    return ch ? ch.official : "";
  }
  function chNameOf(pid) {
    var ch = LPTV.channels.find(function (c) { return c.pid === pid; });
    return ch ? ch.name : (pid ? "频道 " + pid : "");
  }
  function chNumLabel() {
    var idx = LPTV.channels.findIndex(function (c) { return c.pid === LPTV.currentPid; });
    return idx >= 0 ? String(idx + 1).padStart(2, "0") : "--";
  }

  function findOfficialButton(official) {
    var want = normChName(official);
    if (!want) return null;
    var items = document.querySelectorAll(".tv-main-con-r-list-left > div");
    var sub = null;
    for (var i = 0; i < items.length; i++) {
      var txt = normChName(items[i].textContent || "");
      if (!txt) continue;
      if (txt === want) return items[i];          // 归一化精确匹配优先
      if (!sub && txt.indexOf(want) >= 0) sub = items[i];
    }
    return sub;
  }

  /* 频道名归一化: 去空白/全角括号, 统一大写, 便于点击官方按钮时可靠匹配
     (官网侧栏文字与我们的 official 全/半角、空格常不一致) */
  function normChName(s) {
    return String(s || "")
      .replace(/\s+/g, "")
      .replace(/\uFF08/g, "(").replace(/\uFF09/g, ")")
      .toUpperCase();
  }

  function switchChannel(pid) {
    if (!pid) return;
    if (pid !== LPTV.currentPid) {           // 记录切台, 供 onPlayUrl 过期响应防护
      LPTV._pidBefore = LPTV.currentPid;
      LPTV._switchAt = Date.now();
    }
    LPTV.currentPid = pid;
    if (/^\d+$/.test(String(pid))) {  // 记忆最后播放频道 (真实 pid)
      cfg.lastPid = pid;
      saveCfg();
      pyStatePush({ lastPid: pid });  // 跨启动持久化
    }
    markActive();
    epgSync();
    showOSD(chNumLabel(), chNameOf(pid) + " · 正在切换…", true);
    showSpin(true);
    var btn = findOfficialButton(officialNameOf(pid));
    if (btn) {
      btn.click();
    } else if (officialNameOf(pid) !== "") {
      location.href = "/tv/home?pid=" + pid;
    } else {
      showSpin(false);
      toast("该频道暂不可用");
      return;
    }
    setTimeout(function () {
      // 4s 兜底重试: 仅当仍未取到流时, 按自愈后的真实 pid 再次点击
      // (合成 pid 已被 onPlayUrl 替换为真实 pid, 不可再用原 pid 反查按钮)
      if (LPTV.playUrl) return;
      var eff = LPTV.currentPid || pid;
      var b2 = findOfficialButton(officialNameOf(eff));
      if (b2) b2.click();
    }, 4000);
  }

  /* 方向键/PageUp/Down 连续换台节流: 长按系统自动 repeat 时每帧都触发,
   * 而每次切台官方要做完整 auth+取流 (~数百 ms), 不加间隔会堆爆加载队列,
   * 表现为"多按几下就卡住加载不出来"。设 600ms 下限, 快速浏览依旧跟手。 */
  var _chKeyLast = 0, _chKeyPending = false, _chKeyTimer = null;
  function chanKey(delta) {
    var now = Date.now();
    if (now - _chKeyLast < 560) {
      _chKeyPending = true;   // 记下最后一个方向, 冷却后执行一次
      clearTimeout(_chKeyTimer);
      _chKeyTimer = setTimeout(function () { _chKeyPending = false; chanKey(delta); }, 560 - (now - _chKeyLast));
      return;
    }
    _chKeyLast = now;
    stepChannel(delta);
  }

  function stepChannel(delta) {
    if (!LPTV.channels.length) return;
    var idx = LPTV.channels.findIndex(function (c) { return c.pid === LPTV.currentPid; });
    var next = (idx < 0 ? 0 : idx + delta + LPTV.channels.length) % LPTV.channels.length;
    switchChannel(LPTV.channels[next].pid);
    showNextCh(delta);
  }

  /* 上下台预览: 展示当前台的上一个/下一个 (毛玻璃标识, 高亮本次方向) */
  function showNextCh(dir) {
    var p = LPTV.ui.nextch;
    if (!p || !LPTV.channels.length) return;
    var idx = LPTV.channels.findIndex(function (c) { return c.pid === LPTV.currentPid; });
    if (idx < 0) return;
    var prev = LPTV.channels[(idx - 1 + LPTV.channels.length) % LPTV.channels.length];
    var next = LPTV.channels[(idx + 1) % LPTV.channels.length];
    var prevNo = idx === 0 ? LPTV.channels.length : idx;
    var nextNo = (idx + 1) % LPTV.channels.length + 1;
    p.innerHTML =
      '<div class="lptv-nc-row' + (dir > 0 ? "" : " hl") + '"><span class="lptv-nc-arrow">▲</span>' +
        '<span class="lptv-nc-num">' + prevNo + '</span><span class="lptv-nc-name">' + prev.name + '</span></div>' +
      '<div class="lptv-nc-sep"></div>' +
      '<div class="lptv-nc-row' + (dir > 0 ? " hl" : "") + '"><span class="lptv-nc-arrow">▼</span>' +
        '<span class="lptv-nc-num">' + nextNo + '</span><span class="lptv-nc-name">' + next.name + '</span></div>';
    p.classList.add("show");
    clearTimeout(p._t);
    p._t = setTimeout(function () { p.classList.remove("show"); }, 2000);
  }

  function markActive() {
    document.querySelectorAll(".lptv-ch").forEach(function (el) {
      el.classList.toggle("active", el.dataset.pid === LPTV.currentPid);
    });
    updatePanelCur();
    updateTopbarCh();
    setChLabel();
  }
  function updateTopbarCh() {
    var ch = document.getElementById("lptv-tb-ch");
    if (!ch) return;
    var cur = LPTV.channels.find(function (c) { return c.pid === LPTV.currentPid; });
    ch.textContent = (LPTV.currentPid && cur) ? cur.name : (LPTV.currentPid ? chNameOf(LPTV.currentPid) : "未连接");
  }

  /* ================= UI ================= */

  var CSS = `
  #lptv-root{position:fixed;inset:0;z-index:2147483002;background:transparent;
    font-family:system-ui,"Microsoft YaHei",sans-serif;color:#e8eefc;
    overflow:hidden;user-select:none}
  #lptv-root.dev-hidden{display:none}

  #lptv-spin{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;z-index:3;
    width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,255,255,.15);
    border-top-color:#4f7cff;animation:lptvspin .8s linear infinite;pointer-events:none}
  @keyframes lptvspin{to{transform:translate(-50%,-50%) rotate(360deg)}}

  #lptv-osd{position:absolute;left:38px;top:34px;pointer-events:none;opacity:0;z-index:10;
    transition:opacity .35s;max-width:70vw;
    background:linear-gradient(90deg,rgba(10,16,32,.55),rgba(10,16,32,.18) 55%,transparent);
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    border:1px solid rgba(120,160,255,.16);border-radius:14px;padding:14px 22px 16px}
  #lptv-osd.show{opacity:1}
  .lptv-osd-num{font-size:52px;font-weight:800;line-height:1;
    text-shadow:0 2px 18px rgba(0,0,0,.85)}
  .lptv-osd-num b{color:#4f7cff}
  .lptv-osd-name{font-size:26px;font-weight:600;margin-top:6px;
    text-shadow:0 2px 12px rgba(0,0,0,.85)}
  .lptv-osd-sub{font-size:14px;color:#9db4e8;margin-top:6px;letter-spacing:1px}

  #lptv-digit{position:absolute;right:38px;top:34px;font-size:40px;font-weight:800;z-index:10;
    display:none;pointer-events:none;text-shadow:0 2px 14px rgba(0,0,0,.9)}
  #lptv-digit.show{display:block}

  #lptv-vol{position:absolute;right:38px;top:110px;width:220px;opacity:0;z-index:10;pointer-events:none;
    transition:opacity .3s}
  #lptv-vol.show{opacity:1;pointer-events:auto}
  #lptv-vol .lptv-vol-label{font-size:13px;color:#9db4e8;margin-bottom:6px;letter-spacing:1px}

  #lptv-controls{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:8;
    display:flex;align-items:center;gap:12px;padding:11px 18px;border-radius:18px;
    background:linear-gradient(180deg,rgba(22,30,52,.8),rgba(10,15,28,.76));
    backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);
    border:1px solid rgba(120,160,255,.2);
    box-shadow:0 16px 48px rgba(0,0,0,.6),
      0 1px 0 rgba(255,255,255,.08) inset;
    opacity:0;transition:opacity .25s;pointer-events:none;max-width:94vw;flex-wrap:wrap;justify-content:center}
  #lptv-controls::before{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;
    background:linear-gradient(90deg,transparent,rgba(125,155,255,.55),transparent);
    pointer-events:none;border-radius:1px}
  #lptv-controls.show{opacity:1;pointer-events:auto}
  .lptv-ctl-seg{display:flex;align-items:center;gap:7px}
  .lptv-ctl-nav{padding-right:14px;border-right:1px solid rgba(120,160,255,.15)}
  .lptv-ctl-vol{padding:0 14px;border-right:1px solid rgba(120,160,255,.15)}
  .lptv-ctl-now{min-width:120px;max-width:380px;overflow:hidden;padding:2px 4px}
  .lptv-now-dot{width:7px;height:7px;border-radius:50%;background:#ff4d5e;
    box-shadow:0 0 8px #ff4d5e;flex-shrink:0;animation:lptvnow 2s ease-in-out infinite}
  @keyframes lptvnow{0%,100%{opacity:1}50%{opacity:.35}}
  .lptv-now-sep{color:#5c719e;margin:0 2px}
  .lptv-now-prog{font-size:12.5px;color:#c9d6f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lptv-vol-txt{font-size:11px;color:#7d9bff;width:26px;text-align:right;
    font-family:Consolas,monospace}
  .lptv-btn{border:1px solid transparent;background:rgba(44,60,102,.5);color:#c9d6f2;font-size:13px;
    padding:7px 13px;border-radius:11px;cursor:pointer;transition:all .16s;white-space:nowrap}
  .lptv-btn:hover{background:rgba(79,124,255,.32);color:#fff;border-color:rgba(120,160,255,.35);transform:translateY(-1px)}
  .lptv-btn:active{transform:translateY(0) scale(.95)}
  .lptv-btn-ico{display:flex;align-items:center;justify-content:center;width:36px;height:36px;
    padding:0;border-radius:11px}
  .lptv-btn-ico svg{width:16px;height:16px;fill:none;stroke:#c9d6f2;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;transition:all .15s}
  .lptv-btn-ico:hover svg{fill:none;stroke:#fff}
  .lptv-btn-main{width:46px;height:46px;border-radius:14px;
    background:linear-gradient(180deg,rgba(96,140,255,.55),rgba(70,110,235,.42));
    border:1px solid rgba(150,180,255,.5);
    box-shadow:0 6px 20px rgba(60,110,255,.42),0 1px 0 rgba(255,255,255,.22) inset}
  .lptv-btn-main svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
  .lptv-btn-main:hover{background:linear-gradient(180deg,rgba(112,156,255,.78),rgba(82,126,246,.62));
    box-shadow:0 8px 26px rgba(60,110,255,.62)}
  .lptv-btn-txt{font-size:12.5px;letter-spacing:1px;padding:8px 14px}
  #lptv-b-mute .lptv-mute-x{display:none}
  #lptv-b-mute.muted .lptv-waves{display:none}
  #lptv-b-mute.muted .lptv-mute-x{display:block}
  #lptv-c-vol{-webkit-appearance:none;appearance:none;width:100px;height:4px;border-radius:2px;
    background:rgba(60,80,130,.55);outline:none;cursor:pointer}
  #lptv-c-vol::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;
    background:#fff;box-shadow:0 0 7px rgba(120,160,255,.9);cursor:pointer;transition:transform .12s}
  #lptv-c-vol::-webkit-slider-thumb:hover{transform:scale(1.18)}
  .lptv-chlabel{font-size:13.5px;font-weight:600;color:#e8eefc;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}

  /* 上下台预览: 当前台的上一个/下一个 毛玻璃标识 */
  #lptv-nextch{position:absolute;left:50%;bottom:104px;transform:translate(-50%,8px);opacity:0;z-index:9;
    pointer-events:none;transition:opacity .18s,transform .18s;
    background:linear-gradient(180deg,rgba(16,23,42,.74),rgba(10,16,32,.8));
    backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);
    border:1px solid rgba(120,160,255,.18);border-radius:14px;padding:9px 18px;
    min-width:250px;box-shadow:0 12px 36px rgba(0,0,0,.55)}
  #lptv-nextch.show{opacity:1;transform:translate(-50%,0)}
  #lptv-nextch .lptv-nc-row{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:13px;color:#b9c8ec}
  #lptv-nextch .lptv-nc-row.dim{color:#6b7fae}
  #lptv-nextch .lptv-nc-arrow{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;
    justify-content:center;font-size:11px;background:rgba(79,124,255,.16);color:#7d9bff;
    flex-shrink:0;font-family:Consolas,monospace}
  #lptv-nextch .lptv-nc-row.hl .lptv-nc-arrow{background:rgba(79,124,255,.5);color:#fff}
  #lptv-nextch .lptv-nc-num{width:28px;color:#5c719e;font-size:11px;font-family:Consolas,monospace;flex-shrink:0}
  #lptv-nextch .lptv-nc-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #lptv-nextch .lptv-nc-sep{height:1px;background:rgba(120,160,255,.14);margin:3px 0}

  /* 节目录制: 状态角标 (左上角, 闲置也不隐藏) + 控制栏按钮 */
  #lptv-rec-badge{position:absolute;left:38px;bottom:34px;z-index:11;display:none;
    align-items:center;gap:8px;padding:7px 14px;border-radius:9px;
    background:rgba(20,28,48,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border:1px solid rgba(255,77,94,.4);box-shadow:0 4px 18px rgba(0,0,0,.45)}
  #lptv-rec-badge.show{display:flex}
  #lptv-rec-badge .lptv-rec-dot{width:9px;height:9px;border-radius:50%;background:#ff4d5e;
    box-shadow:0 0 8px #ff4d5e;animation:lptvrec 1.2s ease-in-out infinite}
  @keyframes lptvrec{0%,100%{opacity:1}50%{opacity:.25}}
  #lptv-rec-badge #lptv-rec-time{font-size:12px;font-weight:600;color:#ffb3bb;
    font-family:Consolas,monospace;letter-spacing:1px}
  #lptv-b-rec svg{color:#ff4d5e}
  #lptv-b-rec.rec-on{background:rgba(255,77,94,.32);border:1px solid rgba(255,77,94,.55)}
  #lptv-b-rec.rec-on svg{color:#ff4d5e;animation:lptvrec 1.2s ease-in-out infinite}
  #lptv-b-rec.rec-on:hover{background:rgba(255,77,94,.45)}
  #lptv-b-full.on,#lptv-b-float.on{background:rgba(91,134,229,.32);border:1px solid rgba(91,134,229,.55)}
  #lptv-b-full.on svg,#lptv-b-float.on svg{color:#5b86e5}
  /* 截图白闪 */
  #lptv-shot-flash{position:fixed;inset:0;background:#fff;opacity:0;z-index:2147483005;
    pointer-events:none}
  #lptv-shot-flash.go{animation:lptvflash .35s ease-out}
  @keyframes lptvflash{0%{opacity:.85}100%{opacity:0}}

  #lptv-panel{position:absolute;left:0;top:0;bottom:0;width:320px;z-index:5;
    background:rgba(16,23,42,.66);backdrop-filter:blur(24px) saturate(1.5);
    -webkit-backdrop-filter:blur(24px) saturate(1.5);
    transform:translateX(-320px);transition:transform .28s ease;
    display:flex;flex-direction:column;
    border-right:1px solid rgba(120,160,255,.14);
    box-shadow:10px 0 40px rgba(0,0,0,.5)}
  #lptv-panel.open{transform:translateX(0)}
  .lptv-panel-head{display:flex;align-items:center;justify-content:space-between;
    padding:14px 16px;border-bottom:1px solid rgba(120,160,255,.12)}
  .lptv-panel-title{font-size:15px;font-weight:700;letter-spacing:2px;color:#e8eefc}
  .lptv-panel-cur{display:flex;align-items:center;gap:12px;padding:12px 16px;
    border-bottom:1px solid rgba(120,160,255,.12);background:rgba(79,124,255,.08)}
  .lptv-panel-cur-num{font-size:24px;font-weight:800;color:#4f7cff;line-height:1;font-family:Consolas,monospace;min-width:34px}
  .lptv-panel-cur-name{font-size:15px;font-weight:700;color:#fff}
  .lptv-panel-cur-sub{font-size:11px;color:#7d9bff;margin-top:2px}
  .lptv-panel-body{flex:1;overflow-y:auto;padding:6px 0 18px;overscroll-behavior:contain;
    scrollbar-width:thin;scrollbar-color:#28345a transparent}
  .lptv-panel-body::-webkit-scrollbar{width:6px}
  .lptv-panel-body::-webkit-scrollbar-track{background:transparent}
  .lptv-panel-body::-webkit-scrollbar-thumb{background:#2c3d6b;border-radius:3px}
  .lptv-cat{color:#5c719e;font-size:11px;padding:14px 20px 5px;letter-spacing:2px}
  .lptv-ch{display:flex;align-items:center;gap:10px;padding:8px 14px;margin:1px 8px 2px;
    cursor:pointer;color:#c7d3ed;font-size:14px;border-radius:9px;transition:all .12s}
  .lptv-ch:hover{background:rgba(79,124,255,.14);color:#fff}
  .lptv-ch.active{background:linear-gradient(90deg,rgba(79,124,255,.26),rgba(79,124,255,.05));
    color:#fff;font-weight:600}
  .lptv-ch.focus{outline:1px solid rgba(79,124,255,.65);outline-offset:-1px}
  .lptv-ch .lptv-ch-num{font-size:11px;color:#6b7fae;width:24px;flex-shrink:0;font-family:Consolas,monospace}
  .lptv-ch.active .lptv-ch-num{color:#9db4e8}
  .lptv-ch .lptv-ch-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lptv-ch .live-dot{width:5px;height:5px;border-radius:50%;background:#3d4c6e;flex-shrink:0}
  .lptv-ch.active .live-dot{background:#ff4d5e;box-shadow:0 0 6px #ff4d5e}
  /* 收藏星标 */
  .lptv-ch .lptv-ch-fav{flex-shrink:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;
    color:#3d4c6e;cursor:pointer;border-radius:6px;transition:all .12s}
  .lptv-ch .lptv-ch-fav:hover{color:#ffd166;background:rgba(255,209,102,.14)}
  .lptv-ch .lptv-ch-fav.on{color:#ffd166}
  .lptv-ch .lptv-ch-fav svg{width:14px;height:14px}
  /* 面板分类 tab */
  #lptv-panel-tabs{display:flex;gap:6px;padding:6px 14px 8px;border-bottom:1px solid rgba(120,160,255,.12)}
  .lptv-ptab{padding:3px 12px;border-radius:999px;font-size:12px;color:#8fa3cc;cursor:pointer;
    background:rgba(79,124,255,.08);border:1px solid rgba(79,124,255,.14);transition:all .12s}
  .lptv-ptab:hover{color:#fff;background:rgba(79,124,255,.2)}
  .lptv-ptab.on{color:#fff;background:rgba(79,124,255,.32);border-color:rgba(79,124,255,.5)}
  .lptv-ptab b{display:inline-block;min-width:14px;height:14px;line-height:14px;margin-left:4px;
    border-radius:7px;background:#ffd166;color:#1b2540;font-size:9px;font-weight:700;padding:0 3px}
  .lptv-panel-empty{padding:30px 20px;text-align:center;color:#6b7fae;font-size:13px;line-height:1.7}

  /* 节目单: 右侧毛玻璃面板 (鼠标移到右缘自动滑出, 当前节目居中高亮) */
  #lptv-epg{position:absolute;right:0;top:0;bottom:0;width:360px;z-index:5;
    background:rgba(16,23,42,.66);backdrop-filter:blur(24px) saturate(1.5);
    -webkit-backdrop-filter:blur(24px) saturate(1.5);
    transform:translateX(360px);transition:transform .28s ease;
    display:flex;flex-direction:column;
    border-left:1px solid rgba(120,160,255,.14);
    box-shadow:-10px 0 40px rgba(0,0,0,.5)}
  #lptv-epg.open{transform:translateX(0)}
  .lptv-epg-head{display:flex;align-items:center;justify-content:space-between;
    padding:14px 16px;border-bottom:1px solid rgba(120,160,255,.12)}
  .lptv-epg-title{font-size:15px;font-weight:700;letter-spacing:2px;color:#e8eefc}
  .lptv-epg-sub{font-size:11px;color:#7d9bff;margin-top:3px;letter-spacing:1px}
  .lptv-epg-body{flex:1;overflow-y:auto;padding:8px 0 18px;overscroll-behavior:contain;
    scrollbar-width:thin;scrollbar-color:#28345a transparent}
  .lptv-epg-body::-webkit-scrollbar{width:6px}
  .lptv-epg-body::-webkit-scrollbar-track{background:transparent}
  .lptv-epg-body::-webkit-scrollbar-thumb{background:#2c3d6b;border-radius:3px}
  .lptv-epg-row{display:flex;align-items:center;gap:10px;padding:9px 14px;margin:1px 8px 2px;
    color:#c7d3ed;font-size:14px;border-radius:9px;transition:background .12s}
  .lptv-epg-row.past{color:#5c719e}
  .lptv-epg-row.future{color:#9db4e8}
  .lptv-epg-row.live{background:linear-gradient(90deg,rgba(255,77,94,.22),rgba(255,77,94,.05));
    color:#fff;font-weight:600;box-shadow:inset 2px 0 0 #ff4d5e}
  .lptv-epg-t{font-size:12px;color:#6b7fae;width:100px;flex-shrink:0;font-family:Consolas,monospace}
  .lptv-epg-row.live .lptv-epg-t{color:#ff9aa8}
  .lptv-epg-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 长节目名悬停气泡 (JS 检测截断后显示) */
  #lptv-name-pop{position:fixed;z-index:2147483010;max-width:420px;padding:8px 12px;
    background:rgba(14,20,36,.92);border:1px solid rgba(120,160,255,.3);border-radius:8px;
    font-size:12px;color:#e8eefc;line-height:1.6;pointer-events:none;
    opacity:0;transition:opacity .12s;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #lptv-name-pop.show{opacity:1}
  .lptv-epg-empty{padding:30px 20px;text-align:center;color:#6b7fae;font-size:13px}
  /* 日期切换 tabs: 前后一周, 横向滚动 */
  #lptv-epg-tabs{display:flex;gap:6px;padding:8px 10px 6px;border-bottom:1px solid rgba(120,160,255,.12);
    overflow-x:auto;overflow-y:hidden;scroll-behavior:smooth;scrollbar-width:none;flex-shrink:0}
  #lptv-epg-tabs::-webkit-scrollbar{display:none}
  .lptv-epg-tab{flex:0 0 auto;min-width:50px;text-align:center;padding:6px 8px;border-radius:8px;font-size:12px;color:#8fa3cc;
    cursor:pointer;transition:all .12s;white-space:nowrap}
  .lptv-epg-tab i{display:block;font-style:normal;font-size:10px;color:#5c719e;margin-top:1px}
  .lptv-epg-tab.past{opacity:.48}
  .lptv-epg-tab:hover{background:rgba(79,124,255,.14);color:#fff}
  .lptv-epg-tab.on{background:rgba(79,124,255,.28);color:#fff;font-weight:600}
  .lptv-epg-tab.on i{color:#9db4e8}
  /* 行内预约按钮 */
  .lptv-epg-res{flex-shrink:0;padding:3px 10px;border-radius:7px;font-size:11px;letter-spacing:1px;
    background:rgba(79,124,255,.16);color:#7d9bff;cursor:pointer;transition:all .12s;
    border:1px solid rgba(79,124,255,.25)}
  .lptv-epg-res:hover{background:rgba(79,124,255,.35);color:#fff}
  .lptv-epg-res.on{background:rgba(255,170,80,.2);color:#ffb36b;border-color:rgba(255,170,80,.45)}
  /* 节目单头部: 预约列表按钮 (始终可见, 免滚动) */
  .lptv-epg-resbtn{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;padding:7px 15px;border-radius:9px;
    font-size:12px;letter-spacing:1px;font-weight:600;color:#bcd0ff;cursor:pointer;transition:all .14s;
    background:rgba(79,124,255,.14);border:1px solid rgba(120,160,255,.3)}
  .lptv-epg-resbtn:hover{background:rgba(79,124,255,.34);color:#fff}
  .lptv-epg-resbtn.on{background:rgba(255,170,80,.2);color:#ffb36b;border-color:rgba(255,170,80,.45)}
  .lptv-epg-resbtn b{display:inline-block;min-width:15px;height:15px;line-height:15px;text-align:center;
    border-radius:8px;background:#4f7cff;color:#fff;font-size:9px;font-weight:700;padding:0 4px}
  .lptv-epg-resbtn.on b{background:#ffb36b;color:#2a1a05}
  /* 预约列表行 */
  .lptv-res-row{display:flex;align-items:center;gap:8px;padding:9px 12px;margin:1px 8px 2px;
    border-radius:9px;cursor:pointer;transition:background .12s}
  .lptv-res-row:hover{background:rgba(79,124,255,.14)}
  .lptv-res-main{flex:1;overflow:hidden}
  .lptv-res-ch{display:inline-block;font-size:11px;color:#7d9bff;background:rgba(79,124,255,.16);
    padding:1px 7px;border-radius:5px;margin-right:7px;vertical-align:middle}
  .lptv-res-name{font-size:13px;color:#e8eefc;vertical-align:middle}
  .lptv-res-when{display:block;font-size:11px;color:#6b7fae;margin-top:3px;
    font-family:Consolas,monospace}
  .lptv-res-when em{font-style:normal;color:#ffb36b}
  .lptv-res-x{flex-shrink:0;width:22px;height:22px;line-height:20px;text-align:center;border-radius:6px;
    color:#6b7fae;font-size:15px;cursor:pointer;transition:all .12s}
  .lptv-res-x:hover{background:rgba(255,77,94,.25);color:#ff8f9a}

  #lptv-settings{position:absolute;right:26px;bottom:86px;width:320px;z-index:6;
    background:rgba(14,20,36,.65);backdrop-filter:blur(24px) saturate(1.5);
    -webkit-backdrop-filter:blur(24px) saturate(1.5);border-radius:14px;
    border:1px solid rgba(120,160,255,.16);padding:16px;display:none;
    box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #lptv-settings.open{display:block}
  .lptv-set-title{font-size:13px;font-weight:700;letter-spacing:2px;color:#9db4e8;margin-bottom:12px}
  .lptv-set-row{display:flex;align-items:center;justify-content:space-between;
    padding:8px 0;font-size:13px;color:#c7d3ed}
  .lptv-set-row label{display:flex;align-items:center;gap:8px;cursor:pointer}
  .lptv-set-row input[type=checkbox]{accent-color:#4f7cff;width:15px;height:15px;cursor:pointer}
  .lptv-set-row select{background:#141d33;color:#c7d3ed;border:1px solid #28345a;
    border-radius:6px;padding:4px 8px;font-size:12px}
  .lptv-set-sep{height:1px;background:rgba(80,120,255,.12);margin:8px 0}
  .lptv-set-url{font-size:10px;color:#6b7fae;word-break:break-all;max-height:44px;overflow:hidden}
  .lptv-link{color:#7d9bff;cursor:pointer;font-size:12px}
  .lptv-link:hover{color:#a5bdff;text-decoration:underline}
  /* 保存位置行: 左侧标签+路径, 右侧按钮组 */
  .lptv-set-dir{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 0}
  .lptv-set-dir-l{flex:1;min-width:0}
  .lptv-set-dir-l > span{font-size:13px;color:#c7d3ed}
  .lptv-set-dir-l .lptv-set-url{margin-top:3px;line-height:1.5}
  .lptv-set-dir-btns{display:flex;gap:2px;flex-shrink:0}
  .lptv-set-dir-btns .lptv-link{padding:4px 10px;border-radius:6px;
    background:rgba(79,124,255,.1);border:1px solid rgba(79,124,255,.18);font-size:11px;white-space:nowrap}
  .lptv-set-dir-btns .lptv-link:hover{background:rgba(79,124,255,.25);text-decoration:none}

  /* 关于应用: 全屏毛玻璃弹窗 */
  #lptv-about{position:fixed;inset:0;z-index:2147483005;display:none;align-items:center;justify-content:center;
    background:rgba(5,9,20,.5);backdrop-filter:blur(16px) saturate(1.3);
    -webkit-backdrop-filter:blur(16px) saturate(1.3)}
  #lptv-about.open{display:flex}
  .lptv-about-card{position:relative;width:400px;max-width:92vw;max-height:86vh;overflow-y:auto;
    background:rgba(14,20,36,.72);backdrop-filter:blur(24px) saturate(1.5);
    -webkit-backdrop-filter:blur(24px) saturate(1.5);border-radius:16px;
    border:1px solid rgba(120,160,255,.16);padding:24px 26px 18px;
    box-shadow:0 24px 80px rgba(0,0,0,.65);color:#c7d3ed;
    animation:lptv-about-in .22s ease}
  @keyframes lptv-about-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
  .lptv-about-x{position:absolute;top:12px;right:14px;width:28px;height:28px;line-height:26px;text-align:center;
    border-radius:8px;color:#8fa3cc;font-size:15px;cursor:pointer;transition:all .12s;user-select:none}
  .lptv-about-x:hover{background:rgba(255,77,94,.22);color:#ff8f9a}
  .lptv-about-app{display:flex;align-items:center;gap:14px;margin-bottom:16px}
  .lptv-about-logo{width:52px;height:52px;border-radius:13px;flex-shrink:0;object-fit:cover;
    box-shadow:0 4px 16px rgba(79,124,255,.35)}
  .lptv-about-appname{font-size:18px;font-weight:700;color:#fff;letter-spacing:2px}
  .lptv-about-ver{font-size:11px;color:#6b7fae;margin-top:3px;font-family:Consolas,monospace}
  .lptv-about-desc{font-size:12px;color:#9db4e8;line-height:1.8;margin:0 0 16px;
    padding-bottom:14px;border-bottom:1px solid rgba(120,160,255,.1)}
  .lptv-about-brand{border:1px solid rgba(120,160,255,.16);border-radius:12px;padding:15px 16px;
    background:rgba(79,124,255,.06);margin-bottom:14px}
  .lptv-about-brandname{font-size:15px;font-weight:700;color:#fff;letter-spacing:2px}
  .lptv-about-slogan{font-size:11px;color:#7d9bff;letter-spacing:1px;margin-top:3px}
  .lptv-about-foot{text-align:center;font-size:11px;color:#5c719e;margin-top:14px;letter-spacing:1px}

  #lptv-toast{position:absolute;left:50%;top:72px;transform:translateX(-50%);z-index:9;
    background:rgba(20,28,48,.96);color:#e8eefc;padding:10px 22px;border-radius:9px;
    font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;
    border:1px solid rgba(80,120,255,.25);max-width:72vw;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  #lptv-toast.show{opacity:1}
  #lptv-toast.show._res{pointer-events:auto;cursor:pointer;border-color:rgba(255,170,80,.5)}
  #lptv-toast.show._res::after{content:" · 点击跳转";color:#ffb36b;font-size:11px}

  #lptv-hint{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);z-index:9;
    background:rgba(20,28,48,.92);color:#c9d6f2;padding:8px 18px;border-radius:8px;
    font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none}
  #lptv-hint.show{opacity:1}

  /* 全局滚动条: 隐藏页面/html 自身滚动条, 其余细条毛玻璃质感 */
  html::-webkit-scrollbar, body::-webkit-scrollbar{display:none}
  html, body{scrollbar-width:none}
  #lptv-root{scrollbar-width:thin;scrollbar-color:rgba(120,160,255,.3) transparent}
  #lptv-root ::-webkit-scrollbar{width:7px;height:7px}
  #lptv-root ::-webkit-scrollbar-thumb{background:rgba(120,160,255,.3);border-radius:4px;border:1px solid rgba(0,0,0,.25)}
  #lptv-root ::-webkit-scrollbar-thumb:hover{background:rgba(120,160,255,.5)}
  #lptv-root ::-webkit-scrollbar-track{background:rgba(255,255,255,.04);border-radius:4px}

  /* 顶部毛玻璃功能区: 拖拽区 + 窗口控制按钮 (无边框沉浸窗口用) */
  #lptv-topbar{position:absolute;top:0;left:0;right:0;height:36px;z-index:12;
    display:flex;align-items:center;-webkit-app-region:drag;
    background:linear-gradient(180deg,rgba(10,16,32,.74),rgba(10,16,32,.42) 60%,transparent);
    backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);
    opacity:0;transition:opacity .25s;pointer-events:none;color:#e8eefc;user-select:none}
  #lptv-topbar.show{opacity:1;pointer-events:auto}
  #lptv-topbar .lptv-tb-title{display:flex;align-items:center;gap:8px;padding:0 14px;font-size:12px;
    letter-spacing:1px;color:#a8bce8;white-space:nowrap;overflow:hidden}
  #lptv-topbar .lptv-tb-title b{color:#e8eefc;font-weight:700}
  #lptv-topbar .lptv-tb-meta{display:flex;align-items:center;gap:6px;padding:0 10px;font-size:11px;
    color:#7d9bff;border-left:1px solid rgba(120,160,255,.18);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #lptv-topbar .lptv-tb-meta .dot{width:6px;height:6px;border-radius:50%;background:#ff4d5e;
    box-shadow:0 0 6px #ff4d5e;flex-shrink:0}
  #lptv-topbar .lptv-tb-sp{flex:1}
  #lptv-tb-btns{display:flex;height:100%;-webkit-app-region:no-drag;flex-shrink:0}
  .lptv-tb-btn{width:46px;height:100%;display:flex;align-items:center;justify-content:center;
    border:none;background:transparent;color:#c9d6f2;cursor:default;transition:background .15s;
    font-family:"Segoe MDL2 Assets",Webdings,sans-serif;font-size:13px}
  .lptv-tb-btn:hover{background:rgba(120,160,255,.16);color:#fff}
  .lptv-tb-btn.close:hover{background:#e81123;color:#fff}
  .lptv-tb-btn.on{color:#4f7cff}
  .lptv-tb-btn.on:hover{color:#7d9bff}

  #lptv-root.idle{cursor:none}
  #lptv-root.idle #lptv-osd,#lptv-root.idle #lptv-vol,#lptv-root.idle #lptv-topbar,#lptv-root.idle #lptv-win-grip{opacity:0;pointer-events:none}
  #lptv-root.idle.ctrl-on{cursor:auto}
  #lptv-root.idle.ctrl-on #lptv-controls{opacity:1;pointer-events:auto}

  /* 小浮窗模式: 隐藏列表/控制栏/OSD, 仅保留悬浮的 上一台/暂停/下一台, 鼠标离开即隐藏 */
  #lptv-root.float #lptv-controls,#lptv-root.float #lptv-panel,#lptv-root.float #lptv-epg,
  #lptv-root.float #lptv-settings,#lptv-root.float #lptv-vol,#lptv-root.float #lptv-osd,
  #lptv-root.float #lptv-nextch,#lptv-root.float #lptv-digit,#lptv-root.float #lptv-rec-badge,
  #lptv-root.float #lptv-win-grip{display:none !important}
  #lptv-floatctl{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);
    display:none;align-items:center;gap:9px;padding:8px 12px;z-index:30;border-radius:16px;
    background:linear-gradient(180deg,rgba(18,24,42,.88),rgba(10,14,26,.8));
    border:1px solid rgba(120,160,255,.22);box-shadow:0 10px 34px rgba(0,0,0,.55);
    backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);
    opacity:0;pointer-events:none;transition:opacity .2s}
  #lptv-root.float #lptv-floatctl{display:flex}
  #lptv-root.float.show-floatctl #lptv-floatctl{opacity:1;pointer-events:auto}
  #lptv-floatctl .lptv-btn{position:static;width:40px;height:40px}
  #lptv-floatctl .lptv-btn-main{width:46px;height:46px}
  #lptv-floatctl .lptv-fc-sep{width:1px;height:24px;background:rgba(120,160,255,.2);margin:0 2px}

  /* 无边框窗口右下角缩放柄 (整窗 resize) */
  #lptv-win-grip{position:absolute;right:0;bottom:0;width:22px;height:22px;z-index:14;
    cursor:nwse-resize;opacity:.35;transition:opacity .2s;pointer-events:auto}
  #lptv-win-grip:hover{opacity:.9}
  #lptv-win-grip::before{content:"";position:absolute;right:5px;bottom:5px;width:9px;height:9px;
    border-right:2px solid rgba(255,255,255,.8);border-bottom:2px solid rgba(255,255,255,.8)}
  `;

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "html") e.innerHTML = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    return e;
  }

  function buildUI() {
    var style = el("style", { id: "lptv-style" });
    style.textContent = CSS;
    document.head.appendChild(style);

    var root = el("div", { id: "lptv-root" });

    var osd = el("div", { id: "lptv-osd", html:
      '<div class="lptv-osd-num"><b>00</b></div><div class="lptv-osd-name"></div><div class="lptv-osd-sub"></div>' });

    var digit = el("div", { id: "lptv-digit" });

    var spinRoot = el("div", { id: "lptv-spin" });

    var vol = el("div", { id: "lptv-vol", html:
      '<div class="lptv-vol-label">音量 <span id="lptv-vol-num">100</span>%</div>' });
    var range = el("input", { id: "lptv-vol-range", type: "range", min: "0", max: "100" });
    range.value = Math.round(cfg.volume * 100);
    vol.appendChild(range);

    var controls = el("div", { id: "lptv-controls", html:
      '<div class="lptv-ctl-seg lptv-ctl-nav">' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-prev" title="上一台 (↑)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 5.5v13"/><path d="M6.5 12l12-6.5v13z"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-main" id="lptv-b-play" title="暂停/播放 (空格)"><svg id="lptv-b-play-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-next" title="下一台 (↓)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5.5v13"/><path d="M17.5 12l-12-6.5v13z"/></svg></button>' +
      '</div>' +
      '<div class="lptv-ctl-seg lptv-ctl-now" id="lptv-ctl-now">' +
        '<span class="lptv-now-dot"></span>' +
        '<span class="lptv-chlabel" id="lptv-chlabel"></span>' +
        '<span class="lptv-now-sep">·</span>' +
        '<span class="lptv-now-prog" id="lptv-now-prog">正在直播</span>' +
      '</div>' +
      '<div class="lptv-ctl-seg lptv-ctl-vol">' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-mute" title="静音 (M)"><svg id="lptv-b-mute-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="lptv-waves" d="M16 9.5a3.5 3.5 0 010 5M18.5 7a6.5 6.5 0 010 10" stroke-width="1.6"/><path class="lptv-mute-x" d="M16 9l6 6M22 9l-6 6" stroke-width="1.8"/></svg></button>' +
        '<input id="lptv-c-vol" type="range" min="0" max="100" />' +
        '<span class="lptv-vol-txt" id="lptv-c-vol-txt">100</span>' +
      '</div>' +
      '<div class="lptv-ctl-seg">' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-rec" title="录制节目 (R)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-shot" title="截图 (X)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h2.5l1.6-2h5.8l1.6 2H19a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5v-8A1.5 1.5 0 015 8z"/><circle cx="12" cy="13.5" r="3.2"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-float" title="小浮窗 (小尺寸并自动置顶)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><rect x="13.5" y="12.5" width="6" height="5" rx="1.5" fill="currentColor" stroke="none"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-full" title="全屏 / 退出全屏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3H5a2 2 0 00-2 2v3.5M15.5 3H19a2 2 0 012 2v3.5M8.5 21H5a2 2 0 01-2-2v-3.5M15.5 21H19a2 2 0 002-2v-3.5"/></svg></button>' +
      '</div>' +
      '<div class="lptv-ctl-seg lptv-ctl-side">' +
        '<button class="lptv-btn lptv-btn-txt" id="lptv-b-epg" title="节目单 (E)">节目单</button>' +
        '<button class="lptv-btn lptv-btn-txt" id="lptv-b-panel" title="频道列表 (S)">频道</button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-set" title="设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7"/></svg></button>' +
      '</div>' });
    controls.querySelector("#lptv-c-vol").value = Math.round(cfg.volume * 100);
    fillRange(controls.querySelector("#lptv-c-vol"));

    var nextch = el("div", { id: "lptv-nextch" });

    // 录制状态角标 (左上, 常显 — 即使 UI 闲置也可见)
    var recBadge = el("div", { id: "lptv-rec-badge", html:
      '<span class="lptv-rec-dot"></span><span id="lptv-rec-time">REC 00:00</span>' });

    var panel = el("div", { id: "lptv-panel", html:
      '<div class="lptv-panel-head"><span class="lptv-panel-title">频道列表</span></div>' +
      '<div class="lptv-panel-cur">' +
      '<span class="lptv-panel-cur-num">--</span>' +
      '<div><div class="lptv-panel-cur-name">--</div><div class="lptv-panel-cur-sub">正在直播</div></div>' +
      '</div>' +
      '<div id="lptv-panel-tabs"></div>' +
      '<div class="lptv-panel-body" id="lptv-panel-body"></div>' });

    var epg = el("div", { id: "lptv-epg", html:
      '<div class="lptv-epg-head">' +
      '<div><div class="lptv-epg-title">节目单</div>' +
      '<div class="lptv-epg-sub"><span id="lptv-epg-ch">--</span> · <span id="lptv-epg-date"></span></div></div>' +
      '<button class="lptv-epg-resbtn" id="lptv-epg-resbtn" title="预约节目列表">预约<b id="lptv-epg-resbadge" style="display:none"></b></button>' +
      '</div>' +
      '<div id="lptv-epg-tabs"></div>' +
      '<div class="lptv-epg-body" id="lptv-epg-body"></div>' });
    var dLabel = epg.querySelector("#lptv-epg-date");
    if (dLabel) dLabel.textContent = epgDateLabel(new Date());

    var settings = el("div", { id: "lptv-settings", html:
      '<div class="lptv-set-title">设 置</div>' +
      '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-resume" ' + (cfg.resumeLast !== false ? "checked" : "") + '>启动时恢复上次频道</label></div>' +
      '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-autofs">启动时自动全屏</label></div>' +
      '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-autostart">开机自启动</label></div>' +
      '<div class="lptv-set-sep"></div>' +
      '<div class="lptv-set-row"><span>画面模式</span>' +
      '<select id="lptv-s-fit"><option value="contain">完整画面（黑边）</option><option value="cover">铺满（裁剪）</option><option value="fill">拉伸铺满（不裁切）</option></select></div>' +
      '<div class="lptv-set-sep"></div>' +
      '<div class="lptv-set-dir" data-kind="rec">' +
        '<div class="lptv-set-dir-l"><span>录制</span><div class="lptv-set-url" id="lptv-s-recdir-val" title="">--</div></div>' +
        '<div class="lptv-set-dir-btns"><span class="lptv-link" id="lptv-s-recdir-pick">更改</span><span class="lptv-link" id="lptv-s-recdir-open">打开</span></div>' +
      '</div>' +
      '<div class="lptv-set-dir" data-kind="shot">' +
        '<div class="lptv-set-dir-l"><span>截图</span><div class="lptv-set-url" id="lptv-s-shotdir-val" title="">--</div></div>' +
        '<div class="lptv-set-dir-btns"><span class="lptv-link" id="lptv-s-shotdir-pick">更改</span><span class="lptv-link" id="lptv-s-shotdir-open">打开</span></div>' +
      '</div>' +
      '<div class="lptv-set-sep"></div>' +
      '<div class="lptv-set-row"><span>快捷键</span><span style="font-size:11px;color:#6b7fae">↑↓ 切台 · ←→ 音量 · 空格 播放<br>数字选台 · S 频道 · E 节目单 · M 静音<br>R 录制 · X 截图 · 双击/F11 全屏</span></div>' +
      '<div class="lptv-set-sep"></div>' +
      '<div class="lptv-set-row" id="lptv-s-about" style="cursor:pointer"><span>关于应用</span><span class="lptv-link">关于 ›</span></div>' +
      '</div>' });

    // 关于应用: 全屏毛玻璃弹窗
    var about = el("div", { id: "lptv-about", html:
      '<div class="lptv-about-card">' +
        '<span class="lptv-about-x" id="lptv-about-x" title="关闭">✕</span>' +
        '<div class="lptv-about-app">' +
          '<img class="lptv-about-logo" id="lptv-about-logo-img" alt="LPTV">' +
          '<div><div class="lptv-about-appname">LPTV</div>' +
          '<div class="lptv-about-ver" id="lptv-about-ver">版本 --</div></div>' +
        '</div>' +
        '<div class="lptv-about-desc">Y视频官方直播源 · Web版客户端<br>毛玻璃极简界面 · 频道收藏 · 节目单预约 · 录制截图 · 置顶浮窗</div>' +
         '<div class="lptv-about-brand">' +
           '<div class="lptv-about-brandname">LPTV</div>' +
           '<div class="lptv-about-slogan">AI 编程时代 · 行者</div>' +
         '</div>' +
         '<div class="lptv-about-foot">@2026 LPTV Powered by LightOS</div>' +
      '</div>' });

    var toastEl = el("div", { id: "lptv-toast" });
    var hint = el("div", { id: "lptv-hint" });
    var shotFlash = el("div", { id: "lptv-shot-flash" });
    var namePop = el("div", { id: "lptv-name-pop" });

    // 顶部毛玻璃功能区: 整条可拖拽, 按钮区 no-drag (无边框窗口)
    var topbar = el("div", { id: "lptv-topbar" });
    topbar.innerHTML =
      '<span class="lptv-tb-title"><b>LPTV</b></span>' +
      '<span class="lptv-tb-meta"><span class="dot"></span><span id="lptv-tb-ch">--</span></span>' +
      '<span class="lptv-tb-sp"></span>' +
      '<span id="lptv-tb-btns">' +
      '<button class="lptv-tb-btn" id="lptv-tb-min" title="最小化"></button>' +
      '<button class="lptv-tb-btn" id="lptv-tb-pin" title="窗口置顶"></button>' +
      '<button class="lptv-tb-btn" id="lptv-tb-float" title="小浮窗 (小尺寸并自动置顶)"></button>' +
      '<button class="lptv-tb-btn" id="lptv-tb-fs" title="全屏 / 退出全屏 (F11)"></button>' +
      '<button class="lptv-tb-btn" id="lptv-tb-max" title="最大化/还原 (保留任务栏)"></button>' +
      '<button class="lptv-tb-btn close" id="lptv-tb-close" title="关闭"></button>' +
      "</span>";
    topbar.querySelector("#lptv-tb-min").textContent = "\uE921";
    topbar.querySelector("#lptv-tb-pin").textContent = "\uE718";
    topbar.querySelector("#lptv-tb-fs").textContent = "\uE740";
    topbar.querySelector("#lptv-tb-max").textContent = "\uE922";
    topbar.querySelector("#lptv-tb-close").textContent = "\uE8BB";
    topbar.querySelector("#lptv-tb-float").innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="12" y="12" width="7" height="5.2" rx="1" fill="currentColor"/></svg>';
    topbar.classList.add("show");

    root.appendChild(osd);
    root.appendChild(digit);
    root.appendChild(spinRoot);
    root.appendChild(vol);
    root.appendChild(controls);
    root.appendChild(nextch);
    root.appendChild(recBadge);
    root.appendChild(panel);
    root.appendChild(epg);
    root.appendChild(settings);
    root.appendChild(about);
    root.appendChild(toastEl);
    root.appendChild(hint);
    root.appendChild(shotFlash);
    root.appendChild(namePop);
    var floatCtl = el("div", { id: "lptv-floatctl", html:
      '<button class="lptv-btn lptv-btn-ico" id="lptv-fc-prev" title="上一台 (↑)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 5.5v13"/><path d="M6.5 12l12-6.5v13z"/></svg></button>' +
      '<button class="lptv-btn lptv-btn-main" id="lptv-fc-play" title="暂停/播放 (空格)"><svg id="lptv-fc-play-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>' +
      '<button class="lptv-btn lptv-btn-ico" id="lptv-fc-next" title="下一台 (↓)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5.5v13"/><path d="M17.5 12l-12-6.5v13z"/></svg></button>' +
      '<span class="lptv-fc-sep"></span>' +
      '<button class="lptv-btn lptv-btn-ico" id="lptv-fc-exit" title="退出小浮窗"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><rect x="13.5" y="12.5" width="6" height="5" rx="1.5" fill="currentColor" stroke="none"/><path d="M3 3l18 18" stroke-width="2"/></svg></button>' });
    root.appendChild(topbar);
    root.appendChild(floatCtl);
    root.appendChild(el("div", { id: "lptv-win-grip", title: "调整窗口大小" }));
    document.body.appendChild(root);

    LPTV.ui = { root: root, osd: osd, digit: digit, vol: vol,
              controls: controls, nextch: nextch, panel: panel, epg: epg, settings: settings, about: about,
              toast: toastEl, hint: hint, topbar: topbar, floatCtl: floatCtl, volRange: range, volRange2: controls.querySelector("#lptv-c-vol"),
              chlabel: controls.querySelector("#lptv-chlabel"),
              spin: spinRoot };

    acquireOfficial();
    bindEvents();
    renderPanel();
    setChLabel();
  }

  function renderPanel() {
    var body = LPTV.ui.panel.querySelector("#lptv-panel-body");
    var tabs = LPTV.ui.panel.querySelector("#lptv-panel-tabs");
    var filter = LPTV._panelFilter || "all";
    var favsOnly = filter === "fav";
    var groups = {};
    var shown = {};
    LPTV.channels.forEach(function (c) {
      if (favsOnly && !favHas(c.pid)) return;
      (groups[c.category] = groups[c.category] || []).push(c);
      shown[c.pid] = true;
    });
    var html = "";
    if (favsOnly) {
      // 收藏 tab: 按收藏时间顺序 (cfg.favs 数组序即收藏序)
      var favList = [];
      (cfg.favs || []).forEach(function (pid) {
        var c = LPTV.channels.find(function (x) { return x.pid === pid; });
        if (c) favList.push(c);
      });
      html += '<div class="lptv-cat">我的收藏 · ' + favList.length + '</div>';
      if (!favList.length) {
        html += '<div class="lptv-panel-empty">暂无收藏频道<br><span style="font-size:11px">点击频道行的 ☆ 即可收藏</span></div>';
      }
      favList.forEach(function (c) { html += chRowHtml(c); });
    } else {
      var order = ["央视", "CGTN", "卫视", "地方", "其他"];
      order.forEach(function (cat) {
        if (!groups[cat]) return;
        // 收藏只标记状态, 不改变频道顺序 (星标高亮即可)
        html += '<div class="lptv-cat">' + cat + "</div>";
        groups[cat].forEach(function (c) { html += chRowHtml(c); });
      });
    }
    body.innerHTML = html;
    body.scrollTop = 0;
    if (tabs) renderPanelTabs();
    markActive();
  }

  function chRowHtml(c) {
    var idx = LPTV.channels.indexOf(c) + 1;
    var faved = favHas(c.pid);
    return '<div class="lptv-ch' + (faved ? " faved" : "") + '" data-pid="' + c.pid + '">' +
      '<span class="lptv-ch-num">' + String(idx).padStart(2, "0") + "</span>" +
      '<span class="lptv-ch-name">' + c.name + '</span>' +
      '<span class="lptv-ch-fav' + (faved ? " on" : "") + '" data-pid="' + c.pid + '" title="' +
        (faved ? "取消收藏" : "收藏频道") + '">' + favStarSvg(faved) + '</span>' +
      '<span class="live-dot"></span></div>';
  }

  function favStarSvg(on) {
    return '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" ' +
      (on ? 'fill="currentColor" stroke="none"/>' : 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>');
  }

  function renderPanelTabs() {
    var tabs = LPTV.ui.panel.querySelector("#lptv-panel-tabs");
    if (!tabs) return;
    var cur = LPTV._panelFilter || "all";
    var favN = (cfg.favs || []).filter(function (pid) {
      return LPTV.channels.some(function (c) { return c.pid === pid; });
    }).length;
    var html = '<span class="lptv-ptab' + (cur === "all" ? " on" : "") + '" data-f="all">全部</span>' +
      '<span class="lptv-ptab' + (cur === "fav" ? " on" : "") + '" data-f="fav">收藏' +
      (favN ? '<b>' + favN + '</b>' : "") + '</span>';
    tabs.innerHTML = html;
  }

  function updatePanelCur() {
    var panel = LPTV.ui.panel;
    if (!panel) return;
    var num = panel.querySelector(".lptv-panel-cur-num");
    var name = panel.querySelector(".lptv-panel-cur-name");
    if (!num || !name) return;
    var idx = LPTV.channels.findIndex(function (c) { return c.pid === LPTV.currentPid; });
    num.textContent = idx >= 0 ? String(idx + 1).padStart(2, "0") : "--";
    name.textContent = chNameOf(LPTV.currentPid) || "--";
  }

  /* 运行时收割官方侧栏: 补全官方有而我们没有的频道(4K/8K/教育台等),
     并按官网按钮文字校正 official(如 东南卫视->福建东南卫视), 保证点击可靠。
     VIP/限免台需要会员, 一律不显示 */
  function inferCategory(t) {
    if (/^CGTN/.test(t)) return "CGTN";
    if (/^CCTV/.test(t) || /4K|8K/.test(t)) return "央视";
    if (/教育/.test(t)) return "其他";
    if (/卫视/.test(t)) return "卫视";
    return "地方";
  }

  function isPayChannel(t) {
    return /限免|VIP/.test(t);
  }

  function harvestOfficial() {
    var cont = document.querySelector(".tv-main-con-r-list-left");
    if (!cont) return 0;
    var els = Array.prototype.slice.call(cont.children).filter(function (e) { return e.tagName === "DIV"; });
    if (els.length < 30) return 0;
    // 收集侧栏项: 展示文字 + 归一化 + 真实 data-pid (官方给的是真 pid, 用它可避免合成 pid)
    var items = els.map(function (e) {
      var txt = (e.textContent || "").trim().replace(/\s+/g, " ");
      return { txt: txt, nrm: normChName(e.textContent || ""),
               pid: e.getAttribute("data-pid") || "" };
    }).filter(function (it) { return it.txt && !isPayChannel(it.txt); });
    // 1) 校正已知频道 official 为官网真实按钮文字 (归一化精确优先, 再取最接近的包含项)
    LPTV.channels.forEach(function (c) {
      var want = normChName(c.official);
      if (!want) return;
      var exact = null, sub = null;
      items.forEach(function (it) {
        if (it.nrm === want) { if (!exact) exact = it; return; }
        if (it.nrm.indexOf(want) >= 0) {
          if (!sub || Math.abs(it.nrm.length - want.length) < Math.abs(sub.nrm.length - want.length)) sub = it;
        }
      });
      var hit = exact || sub;
      if (hit) c.official = hit.txt;
    });
    // 2) 追加官网有、我们缺的频道 (用侧栏真实 data-pid, 源头消除 "x10000" 合成 pid)
    var seen = {};
    LPTV.channels.forEach(function (c) { seen[c.official] = true; seen[normChName(c.official)] = true; });
    var added = 0;
    items.forEach(function (it) {
      if (seen[it.txt] || seen[it.nrm] || !it.pid) return;
      seen[it.txt] = true; seen[it.nrm] = true;
      LPTV.channels.push({
        name: it.txt, pid: it.pid, cnlid: "", official: it.txt, category: inferCategory(it.txt)
      });
      added++;
    });
    return added;
  }

  function setChLabel() {
    if (LPTV.ui.chlabel) LPTV.ui.chlabel.textContent = chNameOf(LPTV.currentPid);
    updateNowProg();
  }

  /* 控制栏中部: 当前正在播的节目名 (EPG 缓存按当前时间定位) */
  function nowProgOf(pid) {
    var list = (LPTV.epg.cache || {})[pid];
    if (!list || !list.length) return "";
    var now = Math.floor(Date.now() / 1000);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.s0 <= now && (!p.e0 || now < p.e0)) return p.name || "";
    }
    return "";
  }
  function updateNowProg() {
    var el2 = document.getElementById("lptv-now-prog");
    if (!el2) return;
    el2.textContent = nowProgOf(LPTV.currentPid) || "正在直播";
  }

  function showOSD(num, text, sticky) {
    var o = LPTV.ui.osd;
    if (!o) return;
    o.querySelector(".lptv-osd-num").innerHTML = "<b>" + (num || "--") + "</b>";
    o.querySelector(".lptv-osd-name").textContent = chNameOf(LPTV.currentPid);
    o.querySelector(".lptv-osd-sub").textContent = text || "";
    o.classList.add("show");
    clearTimeout(o._t);
    if (!sticky) o._t = setTimeout(function () { o.classList.remove("show"); }, 3000);
  }

  function showSpin(on) {
    if (LPTV.ui.spin) LPTV.ui.spin.style.display = on ? "block" : "none";
  }

  var hintTimer = null;
  function showHint(msg) {
    var h = LPTV.ui.hint;
    if (!h) return;
    h.textContent = msg;
    h.classList.add("show");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { h.classList.remove("show"); }, 5000);
  }
  function hideHint() {
    if (LPTV.ui.hint) LPTV.ui.hint.classList.remove("show");
  }

  var toastTimer = null;
  function toast(msg) {
    var t = LPTV.ui.toast;
    if (!t) { return; }
    t.classList.remove("_res");
    t._res = null;
    clearTimeout(t._resT);
    clearTimeout(t._resJump);
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ================= 面板 / 设置 ================= */

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* 三侧滑窗统一机制: 指针移到对应侧缘滑出; 指针离开该侧区域(或离开窗口)即隐藏。
     边缘带回滞+冷却, 防止指针贴边时 反复开->隐->开 抖动 */
  var PANEL_ZONE = 400;   // 左侧频道面板保持区 (面板320 + 宽回滞, 防越界误隐藏)
  var PANEL_EDGE = 18;    // 左缘触发带宽 (原 8px 太窄, 鼠标常滑过)
  var EPG_ZONE = 440;     // 右侧节目单保持区 (面板360 + 宽回滞)
  var EPG_EDGE = 18;      // 右缘触发带宽

  function togglePanel() {
    var open = LPTV.ui.panel.classList.toggle("open");
    cancelPanelHide();
    LPTV._panelIn = false;
    if (open) {
      var act = LPTV.ui.panel.querySelector(".lptv-ch.active");
      if (act) act.classList.add("focus");
    }
    return open;
  }

  function hidePanel() {
    cancelPanelHide();
    LPTV._panelIn = false;
    LPTV.ui.panel.classList.remove("open");
    var pop = document.getElementById("lptv-name-pop");
    if (pop) pop.classList.remove("show");
  }

  /* 左缘滑出频道面板; 指针离开左侧保持区即隐藏 (250ms 快速跟手) */
  function panelPointer(e) {
    if (LPTV.devHidden) return;
    var x = e.clientX, y = e.clientY;
    var open = LPTV.ui.panel.classList.contains("open");
    if (open) {
      if (x <= PANEL_ZONE) { LPTV._panelIn = true; cancelPanelHide(); }
      else if (LPTV._panelIn) schedulePanelHide(250);
      return;
    }
    // 关闭后指针仍贴边 -> 冷却, 先离开触发带再允许重新滑出
    if (x <= PANEL_EDGE) {
      if (LPTV._panelArmed !== false && y > 46 && !LPTV.ui.settings.classList.contains("open")) {
        LPTV._panelArmed = false;
        LPTV._panelIn = true;
        LPTV.ui.panel.classList.add("open");
        markActive();
      }
    } else {
      LPTV._panelArmed = true;
    }
  }
  function schedulePanelHide(ms) {
    clearTimeout(LPTV._panelHideT);
    LPTV._panelHideT = setTimeout(function () {
      LPTV._panelIn = false;
      LPTV.ui.panel.classList.remove("open");
    }, ms);
  }
  function topbarPointer(e) {
    if (LPTV.devHidden) return;
    var tb = document.getElementById("lptv-topbar");
    if (tb) tb.classList.toggle("show", e.clientY <= 44);
  }
  function cancelPanelHide() {
    clearTimeout(LPTV._panelHideT);
  }

  /* ================= 预约播放 (开播提醒, 点击跳频道) =================
   * 存储: localStorage lptv.res.v1 = [{id, pid, ch, name, s0, e0}]
   * id = pid+s0 (唯一); 轮询 20s: 开播前 60s Toast 提醒 (带跳转按钮),
   * 开播后 15 分钟自动清理; 过期预约列表在启动时清理 */

  var RES_KEY = "lptv.res.v1";

  function resLoad() {
    try {
      var a = JSON.parse(localStorage.getItem(RES_KEY) || "[]");
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function resSave(list) {
    try { localStorage.setItem(RES_KEY, JSON.stringify(list)); } catch (e) {}
    pyStatePush({ res: list });  // 持久化到 Python 侧 (localStorage 不跨启动)
  }
  function resHas(pid, s0) {
    var id = pid + "_" + s0;
    return resLoad().some(function (r) { return r.id === id; });
  }
  function resToggle(pid, s0, e0, name) {
    var id = pid + "_" + s0;
    var list = resLoad();
    var i = list.findIndex(function (r) { return r.id === id; });
    var had = i >= 0;
    if (had) list.splice(i, 1);
    else list.push({
      id: id, pid: String(pid), ch: chNameOf(pid), name: name || "",
      s0: s0, e0: e0 || 0, made: Date.now()
    });
    resSave(list);
    return !had;
  }

  /* 开播提醒轮询: 每 20s 扫一遍; 同一预约只提醒一次 (r.notified) */
  function resTick() {
    var now = Math.floor(Date.now() / 1000);
    var list = resLoad();
    var changed = false;
    list = list.filter(function (r) {
      if (r.e0 && r.e0 < now - 15 * 60) { changed = true; return false; }  // 播完 15 分钟过期
      if (!r.notified && r.s0 - 60 <= now && now < r.s0 + 5 * 60) {
        r.notified = 1;
        changed = true;
        resNotify(r);
      }
      return true;
    });
    if (changed) {
      resSave(list);
      if (LPTV.ui.epg && LPTV.epg._resView) resRender();
      epgRenderTabs();
    }
  }

  /* 开播提醒: Toast + 可点击跳转 (挂在 lptv-toast 上) */
  function resNotify(r) {
    var t = LPTV.ui.toast;
    if (!t) return;
    t.textContent = "即将开播: " + r.ch + " · " + r.name;
    t.classList.add("show", "_res");
    t._res = r.pid;
    t._resClicked = false;  // 用户主动点击过则不自动跳
    clearTimeout(toastTimer);
    clearTimeout(t._resT);
    t._resT = setTimeout(function () { t.classList.remove("show"); t._res = null; }, 12000);
    // 到点自动跳台一次 (toast 未被用户点击时; 与 toast 自身 12s 消失无关)
    clearTimeout(t._resJump);
    t._resJump = setTimeout(function () {
      if (!t._resClicked && t._resPending === r.id) {
        switchChannel(r.pid);
        t.classList.remove("show"); t._res = null;
      }
    }, Math.max(0, (r.s0 - Math.floor(Date.now() / 1000)) * 1000));
    t._resPending = r.id;
    wake();
  }

  setInterval(resTick, 20000);
  setTimeout(resTick, 3000);

  /* ================= 节目单 (EPG) ================= */
  /* 数据源: https://capi.yangshipin.cn/api/yspepg/program/{真实pid}/{yyyyMMdd}
     官方切台时 XHR(arraybuffer) 拉取, 我们钩到即缓存; 无钩到时自行 XHR 取。
     protobuf 结构实探:
       顶层 f1=varint(200), f2 重复=len包裹的节目blob, 结尾 f3=len字符串"成功"
       每个 blob: f1(eventId str) f2(节目名 utf8) f3(开始epoch秒) f4(结束epoch秒)
                  f5("HH:MM"开始) f6("HH:MM"结束) f7(时长秒) f9/f10(len1 "1") */

  var EPG_DAY_MAX = 5;  // 官方仅提供 今天±5 天节目单 (更远日期返回 404/空), 依此收敛, 不展示空白未来日

  function utf8Bytes(bytes, a, n) {
    try {
      if (window.TextDecoder) return new TextDecoder().decode(bytes.subarray(a, a + n));
    } catch (e) {}
    try {
      var s = "";
      for (var i = a; i < a + n; i++) s += String.fromCharCode(bytes[i]);
      return decodeURIComponent(escape(s));
    } catch (e) { return ""; }
  }

  function parseEpg(buf) {
    var programs = [];
    try {
      var bytes = new Uint8Array(buf);
      var i = 0;
      function varint() {
        var v = 0, s = 0, k = 0;
        while (i < bytes.length && k < 5) {
          var b = bytes[i++];
          v += (b & 0x7f) * Math.pow(2, s);
          s += 7;
          k++;
          if (!(b & 0x80)) break;
        }
        return v;
      }
      while (i < bytes.length) {
        var tag = varint();
        if (tag === 0) break;
        var f = tag >>> 3, wt = tag & 7;
        if (wt === 2) {
          var len = varint();
          var p = parseEpgEntry(bytes, i, i + len);
          if (p) programs.push(p);
          i += len;
        } else if (wt === 0) {
          varint(); // 值忽略 (顶层 f1=200)
        } else {
          i += varint();
        }
        if (programs.length > 200) break;
      }
    } catch (e) {}
    return programs;
  }

  function parseEpgEntry(bytes, a, b) {
    var i = a, p = {};
    function varint() {
      var v = 0, s = 0, k = 0;
      while (i < b && k < 5) {
        var x = bytes[i++];
        v += (x & 0x7f) * Math.pow(2, s);
        s += 7;
        k++;
        if (!(x & 0x80)) break;
      }
      return v;
    }
    try {
      while (i < b) {
        var tag = varint();
        if (tag === 0) break;
        var f = tag >>> 3, wt = tag & 7;
        if (wt === 2) {
          var len = varint();
          if (i + len > b) break;
          if (f === 1) p.id = utf8Bytes(bytes, i, len);
          else if (f === 2) p.name = utf8Bytes(bytes, i, len);
          else if (f === 5) p.start = utf8Bytes(bytes, i, len);
          else if (f === 6) p.end = utf8Bytes(bytes, i, len);
          else if (f === 9 || f === 10) p.extra = utf8Bytes(bytes, i, len);
          i += len;
        } else if (wt === 0) {
          var v = varint();
          if (f === 3) p.s0 = v;
          else if (f === 4) p.e0 = v;
          else if (f === 7) p.dur = v;
        } else {
          i += varint();
        }
      }
    } catch (e) {}
    return p.name ? p : null;
  }

  function ymdStr(dt) {
    return dt.getFullYear() +
      String(dt.getMonth() + 1).padStart(2, "0") +
      String(dt.getDate()).padStart(2, "0");
  }
  function epgDateLabel(dt) {
    return (dt.getMonth() + 1) + "月" + dt.getDate() + "日 星期" +
      ["日", "一", "二", "三", "四", "五", "六"][dt.getDay()];
  }

  function epgFetch(pid, ymd, cb) {
    // 合成 pid(x...) 官网无此台, 等 onPlayUrl 自愈成真实 pid 后再取
    if (!/^\d+$/.test(String(pid))) return;
    ymd = ymd || ymdStr(new Date());
    var key = pid + "|" + ymd;
    if ((LPTV.epg.cache || {})[key]) { if (cb) cb(true); return; }
    LPTV.epg._fetching = LPTV.epg._fetching || {};
    if (LPTV.epg._fetching[key]) return;
    LPTV.epg._fetching[key] = 1;
    var x = new XMLHttpRequest();
    x.open("GET", (window.__LPTV_API_BASE || "") + "/api/epg/raw?pid=" + pid + "&ymd=" + ymd, true);
    x.responseType = "arraybuffer";
    x.onload = function () {
      var has = false;
      try {
        if (x.status >= 200 && x.status < 300) {
          var progs = parseEpg(x.response);
          if (progs.length) { epgStore(pid, progs, ymd); has = true; }
        }
      } catch (e) {}
      LPTV.epg.avail = LPTV.epg.avail || {};
      LPTV.epg.avail[key] = has;  // 官方无数据/404 -> false, 用于隐藏空白日期 tab
      delete LPTV.epg._fetching[key];
      epgRenderTabs();
      if (cb) cb(has);
    };
    x.onerror = function () {
      delete LPTV.epg._fetching[key];
      if (cb) cb(false);
    };
    x.send();
  }

  /* 探明官方可用日期: 从今天向两侧逐日探到首个无数据即停, 只展示官方真正有数据的日期 */
  function epgProbe(pid) {
    if (!/^\d+$/.test(String(pid))) return;
    LPTV.epg._probed = LPTV.epg._probed || {};
    if (LPTV.epg._probed[pid]) return;
    LPTV.epg._probed[pid] = 1;
    [1, -1].forEach(function (dir) {
      var off = dir;
      (function step() {
        if (Math.abs(off) > EPG_DAY_MAX) return;
        var ymd = epgYmdOf(off);
        var av = (LPTV.epg.avail || {})[pid + "|" + ymd];
        if (av === true) { off += dir; step(); return; }
        if (av === false) return;
        epgFetch(pid, ymd, function (has) { if (has) { off += dir; step(); } });
      })();
    });
  }

  function epgStore(pid, programs, ymd) {
    try { programs.sort(function (a, b) { return (a.s0 || 0) - (b.s0 || 0); }); } catch (e) {}
    // 回填缺失的 e0: 官方数据部分条目无结束时间, 用下一条的 s0 补上,
    // 否则旧节目会被误判为"正在直播"并错误定位滚动 (EPG 回今天显示凌晨节目的根因)
    for (var k = 0; k < programs.length; k++) {
      if (!programs[k].e0 && programs[k + 1] && programs[k + 1].s0) {
        programs[k].e0 = programs[k + 1].s0;
      }
    }
    ymd = ymd || ymdStr(new Date());
    var key = pid + "|" + ymd;
    // 防污染: 数据 s0 明显不属于该 ymd (>半天偏差) 时, 以 s0 推断真实日期重建键,
    // 避免调用方传错 ymd 把未来节目写进"今天" (历史 bug 的双保险)
    if (programs.length && programs[0].s0) {
      var mid = programs[0].s0 + 12 * 3600;  // 首条开播+12h 约等于节目单所属日的中点
      var dReal = new Date(mid * 1000);
      var realYmd = ymdStr(dReal);
      if (realYmd !== ymd) {
        ymd = realYmd;
        key = pid + "|" + ymd;
      }
    }
    LPTV.epg.cache[key] = programs;
    if (ymd === ymdStr(new Date())) {
      LPTV.epg.cache[pid] = programs;  // 兼容旧键 (nowProg 等读当天)
      LPTV.epg.last = { pid: pid, n: programs.length, t: Date.now() };
      if (LPTV.currentPid === pid) updateNowProg();
    }
    if (LPTV.currentPid === pid && LPTV.epg._day === (LPTV.epg._dayMap || {})[ymd]) epgRender();
  }

  /* EPG 日期偏移: 0=今天 最多+3; 面板头部按钮切换 */
  function epgDayOffset() { return LPTV.epg._day || 0; }

  function epgYmdOf(off) {
    var d = new Date();
    d.setDate(d.getDate() + (off || 0));
    return ymdStr(d);
  }

  function epgCurList() {
    var key = LPTV.currentPid + "|" + epgYmdOf(epgDayOffset());
    return (LPTV.epg.cache || {})[key];
  }

  function epgRender() {
    var body = document.getElementById("lptv-epg-body");
    if (!body) return;
    epgRenderTabs();
    if (LPTV.epg._resView) { resRender(); return; }
    var pid = LPTV.currentPid;
    var chEl = document.getElementById("lptv-epg-ch");
    if (chEl) chEl.textContent = chNameOf(pid);
    var list = epgCurList();
    if (!list || !list.length) {
      var ke = (LPTV.epg.avail || {})[pid + "|" + epgYmdOf(epgDayOffset())] === false;
      body.innerHTML = '<div class="lptv-epg-empty">' + (ke ? "当日暂无节目单" : "节目单加载中…") + '</div>';
      return;
    }
    var now = Math.floor(Date.now() / 1000);
    var day = epgDayOffset();
    var hs = -1, html = "";
    list.forEach(function (p, k) {
      // e0 缺失时: 只把"最后一条 s0<=now"视为正在直播 (而非所有 s0<=now)
      var live = day === 0 && p.s0 <= now && (!p.e0
        ? (k === list.length - 1) || (list[k + 1] && list[k + 1].s0 > now)
        : now < p.e0);
      // 过去日期全天只读展示; 今天: 已播完的为 past
      var past = (day < 0) || (day === 0 && p.s0 && !live && p.s0 <= now);
      if (live && hs < 0) hs = k;
      var cls = live ? "live" : (past ? "past" : "future");
      var reservable = !past && p.s0 && p.name;   // 今天未播完 / 未来日期均可预约(过去只读)
      var reserved = reservable && resHas(pid, p.s0);
      html += '<div class="lptv-epg-row ' + cls + '" data-pid="' + pid + '" data-s0="' + (p.s0 || 0) + '">' +
        '<span class="lptv-epg-t">' + (p.start || "--") + "-" + (p.end || "--") + '</span>' +
        '<span class="lptv-epg-n">' + (p.name || "") + '</span>' +
        (reservable ? '<span class="lptv-epg-res' + (reserved ? " on" : "") + '" title="' +
          (reserved ? "已预约, 点击取消" : "预约开播提醒") + '">' +
          (reserved ? "已约" : "预约") + '</span>' : "") +
        '</div>';
    });
    body.innerHTML = html;
    if (hs >= 0 && body.children[hs]) {
      setTimeout(function () {
        try { body.children[hs].scrollIntoView({ block: "center" }); } catch (e) {}
      }, 30);
    }
  }

  function epgRenderTabs() {
    var tabs = document.getElementById("lptv-epg-tabs");
    if (!tabs) return;
    var cur = epgDayOffset();
    var pid = LPTV.currentPid;
    var avail = LPTV.epg.avail || {};
    var html = "";
    // 官方可用窗口 (今天±5): 已知无数据的日期不展示, 杜绝空白未来日; 当前选中日始终保留
    for (var off = -EPG_DAY_MAX; off <= EPG_DAY_MAX; off++) {
      var d = new Date();
      d.setDate(d.getDate() + off);
      if (avail[pid + "|" + ymdStr(d)] === false && off !== cur) continue;
      var label = off === 0 ? "今天" : off === 1 ? "明天" : off === -1 ? "昨天" :
        "周" + ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
      var cls = "lptv-epg-tab" + (off < 0 ? " past" : "") +
        (off === cur && !LPTV.epg._resView ? " on" : "");
      html += '<span class="' + cls + '" data-off="' + off + '">' + label +
        "<i>" + (d.getMonth() + 1) + "/" + d.getDate() + "</i></span>";
    }
    tabs.innerHTML = html;
    // 预约按钮: 徽标数量 + 激活态 (固定右上方, 不受日期滚动影响)
    var rb = document.getElementById("lptv-epg-resbtn");
    if (rb) rb.classList.toggle("on", !!LPTV.epg._resView);
    var rbadge = document.getElementById("lptv-epg-resbadge");
    if (rbadge) {
      var n = resLoad().length;
      rbadge.textContent = n ? n : "";
      rbadge.style.display = n ? "" : "none";
    }
    // 选中项滚动到可视区中央 (仅日期变化时, 避免刷新节目时打断手动滚动)
    var key = String(cur);
    if (key !== LPTV.epg._tabKey) {
      LPTV.epg._tabKey = key;
      var onEl = tabs.querySelector(".lptv-epg-tab.on");
      if (onEl && onEl.scrollIntoView) {
        try { onEl.scrollIntoView({ inline: "center", block: "nearest" }); } catch (e) {}
      }
    }
  }

  /* 预约列表视图: 频道/节目/倒计时, 点击行跳频道, 点×取消 */
  function resRender() {
    var body = document.getElementById("lptv-epg-body");
    if (!body) return;
    var chEl = document.getElementById("lptv-epg-ch");
    if (chEl) chEl.textContent = "预约列表";
    var now = Math.floor(Date.now() / 1000);
    var list = resLoad().sort(function (a, b) { return a.s0 - b.s0; });
    if (!list.length) {
      body.innerHTML = '<div class="lptv-epg-empty">暂无预约<br><span style="font-size:11px">在节目单中选择节目点"预约"即可</span></div>';
      return;
    }
    var html = "";
    list.forEach(function (r) {
      var d = new Date(r.s0 * 1000);
      var mm = Math.max(0, Math.round((r.s0 - now) / 60));
      var countdown = mm < 60 ? mm + " 分钟后" :
        Math.floor(mm / 60) + " 小时 " + (mm % 60) + " 分后";
      html += '<div class="lptv-res-row" data-pid="' + r.pid + '" data-id="' + r.id + '">' +
        '<div class="lptv-res-main">' +
          '<span class="lptv-res-ch">' + r.ch + '</span>' +
          '<span class="lptv-res-name">' + (r.name || "未知节目") + '</span>' +
          '<span class="lptv-res-when">' +
            (d.getMonth() + 1) + "/" + d.getDate() + " " +
            String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") +
            ' <em>' + countdown + '</em></span>' +
        '</div>' +
        '<span class="lptv-res-x" title="取消预约">×</span>' +
        '</div>';
    });
    body.innerHTML = html;
  }

  /* 面板开着且当前台有真实 pid 时: 有缓存先渲染, 无则抓取 (当前选中的日期) */
  function epgSync() {
    if (!LPTV.ui.epg || !LPTV.ui.epg.classList.contains("open")) return;
    var pid = LPTV.currentPid;
    if (!pid) return;
    epgProbe(pid);  // 探明官方可用日期范围, 隐藏空白未来日
    var ymd = epgYmdOf(epgDayOffset());
    if ((LPTV.epg.cache || {})[pid + "|" + ymd]) { epgRender(); return; }
    epgFetch(pid, ymd);
  }

  function epgSetDay(off) {
    LPTV.epg._day = Math.max(-EPG_DAY_MAX, Math.min(EPG_DAY_MAX, off || 0));
    LPTV.epg._dayMap = LPTV.epg._dayMap || {};
    LPTV.epg._dayMap[epgYmdOf(LPTV.epg._day)] = LPTV.epg._day;
    var dLabel = document.getElementById("lptv-epg-date");
    if (dLabel) {
      var d = new Date();
      d.setDate(d.getDate() + LPTV.epg._day);
      dLabel.textContent = epgDateLabel(d);
    }
    epgRender();
    epgSync();
  }

  function openEpg() {
    cancelEpgHide();
    LPTV._epgIn = false;
    // 每次打开回到今天+节目单视图 (避免停留在未来日期/预约列表)
    LPTV.epg._resView = false;
    if (LPTV.epg._day) epgSetDay(0);
    LPTV.ui.epg.classList.add("open");
    epgSync();
    return true;
  }
  function hideEpg() {
    cancelEpgHide();
    LPTV._epgIn = false;
    LPTV.ui.epg.classList.remove("open");
    var pop = document.getElementById("lptv-name-pop");
    if (pop) pop.classList.remove("show");
  }
  function toggleEpg() {
    return LPTV.ui.epg.classList.contains("open") ? (hideEpg(), false) : (openEpg(), true);
  }

  /* 右缘滑出节目单; 指针离开右侧保持区即隐藏 (同左缘机制) */
  function epgPointer(e) {
    if (LPTV.devHidden) return;
    var x = e.clientX, y = e.clientY;
    var open = LPTV.ui.epg.classList.contains("open");
    if (open) {
      if (x >= innerWidth - EPG_ZONE) { LPTV._epgIn = true; cancelEpgHide(); }
      else if (LPTV._epgIn) scheduleEpgHide(250);
      return;
    }
    if (x >= innerWidth - EPG_EDGE) {
      if (LPTV._epgArmed !== false && y > 46 && !LPTV.ui.settings.classList.contains("open")) {
        LPTV._epgArmed = false;
        LPTV._epgIn = true;
        LPTV.ui.epg.classList.add("open");
        epgSync();
      }
    } else {
      LPTV._epgArmed = true;
    }
  }
  function scheduleEpgHide(ms) {
    clearTimeout(LPTV._epgHideT);
    LPTV._epgHideT = setTimeout(function () {
      LPTV._epgIn = false;
      LPTV.ui.epg.classList.remove("open");
    }, ms);
  }
  function cancelEpgHide() {
    clearTimeout(LPTV._epgHideT);
  }

  function panelNav(dir) {
    var items = Array.prototype.slice.call(LPTV.ui.panel.querySelectorAll(".lptv-ch"));
    if (!items.length) return;
    var cur = LPTV.ui.panel.querySelector(".lptv-ch.focus");
    var idx = cur ? items.indexOf(cur) : -1;
    var next = clamp(idx + dir, 0, items.length - 1);
    items.forEach(function (it) { it.classList.remove("focus"); });
    items[next].classList.add("focus");
    items[next].scrollIntoView({ block: "nearest" });
  }
  function panelSelect() {
    var cur = LPTV.ui.panel.querySelector(".lptv-ch.focus");
    if (cur) { switchChannel(cur.dataset.pid); hidePanel(); }
  }

  function toggleSettings() {
    LPTV.ui.settings.classList.toggle("open");
    var a9 = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
    if (a9) {
      // 填充 自动全屏 (来自持久状态)
      var fsBox = document.getElementById("lptv-s-autofs");
      if (fsBox && a9.get_ui_state) a9.get_ui_state().then(function (st) {
        if (st && st.ok && fsBox) fsBox.checked = !!st.autoFullscreen;
      });
      // 填充 开机自启动 (来自注册表实际值)
      var stBox = document.getElementById("lptv-s-autostart");
      if (stBox && a9.autostart_state) a9.autostart_state().then(function (r) {
        if (stBox && r) stBox.checked = !!r.enabled;
      });
    }
  }

  /* ================= 节目实时录制 (MediaRecorder) =================
   * 只录官方 video 元素: OSD/面板/控制栏等 LPTV 覆盖层 UI 绝不进画面。
   * 画面: canvas 逐帧重绘 video (captureStream) — 复用黑帧看门狗同款 drawImage,
   *       实测不触发 CMG 黑帧检测。
   * 声音: AudioContext MediaElementSource (注意回连 destination 保持外放)。
   * 落盘: MediaRecorder webm 分块 -> base64 -> 桥 rec_open/rec_append/rec_close。
   * 限制: 官方切台会换 video 元素 -> 录制自动停止 (Toast 提示), 不跟随切台。
   * 仅前台: 失焦/最小化即自动停止录制 (隐私边界), 后台自动录制为规划中的路线图功能。 */

  var Rec = {
    on: false, rid: 0, mr: null, ac: null, srcNode: null,
    canvas: null, cctx: null, stream: null, chunks: [],
    t0: 0, timer: null, bytes: 0, frames: 0,
    video: null, vw: 0, vh: 0
  };

  function recApi() { return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null; }

  function recSupported() {
    return !!(window.MediaRecorder && document.createElement("canvas").captureStream);
  }

  function recTick() {
    var el = document.getElementById("lptv-rec-time");
    if (!el) return;
    var s = Math.floor((Date.now() - Rec.t0) / 1000);
    var mm = String(Math.floor(s / 60)).padStart(2, "0");
    var ss = String(s % 60).padStart(2, "0");
    el.textContent = "REC " + mm + ":" + ss + " · " + (Rec.bytes / 1048576).toFixed(1) + "MB";
  }

  function recSetUI(on) {
    var root = LPTV.ui.root, btn = document.getElementById("lptv-b-rec");
    var badge = document.getElementById("lptv-rec-badge");
    if (root) root.classList.toggle("recording", on);
    if (btn) {
      btn.classList.toggle("rec-on", on);
      btn.title = on ? "停止录制 (R)" : "录制节目 (R)";
    }
    if (badge) badge.classList.toggle("show", on);
    if (on) {
      Rec.t0 = Date.now(); Rec.bytes = 0;
      recTick();
      Rec.timer = setInterval(recTick, 1000);
    } else {
      clearInterval(Rec.timer);
    }
  }

  function recDestroyGraph() {
    try { if (Rec.mr && Rec.mr.state !== "inactive") Rec.mr.stop(); } catch (e) {}
    Rec.mr = null;
    try { if (Rec.stream) Rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    Rec.stream = null;
    // 音频源节点必须保留复用: 同一 video 元素二次 createMediaElementSource 会失败
  }

  function recEnsureAudio(v) {
    if (Rec.srcNode && Rec.video === v) return Rec.srcNode;
    try {
      if (!Rec.ac) Rec.ac = new (window.AudioContext || window.webkitAudioContext)();
      if (Rec.ac.state === "suspended") Rec.ac.resume();
      if (Rec.srcNode) { try { Rec.srcNode.disconnect(); } catch (e) {} Rec.srcNode = null; }
      // 关键: 回连 destination, 否则创建 MediaElementSource 后喇叭静音
      Rec.srcNode = Rec.ac.createMediaElementSource(v);
      Rec.srcNode.connect(Rec.ac.destination);
      Rec.video = v;
    } catch (e) { Rec.srcNode = null; }
    return Rec.srcNode;
  }

  function recStart() {
    var v = LPTV.video;
    if (!v || !v.videoWidth) { toast("画面尚未就绪，稍后再录"); return; }
    if (!recSupported()) { toast("当前环境不支持录制"); return; }
    if (!document.hasFocus()) { toast("仅前台可录制 · 请先点击本应用窗口"); return; }
    if (Rec.on) return;
    var api = recApi();
    if (!api || !api.rec_open) { toast("录制桥不可用"); return; }
    dbg("rec: start v=" + (v === (LPTV._dbgLastV || null) ? "same" : "new"));

    var mime = "";
    var cands = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (var i = 0; i < cands.length; i++) {
      try { if (MediaRecorder.isTypeSupported(cands[i])) { mime = cands[i]; break; } } catch (e) {}
    }
    if (!mime) { toast("不支持 webm 编码"); return; }

    // 画布: 按视频源尺寸 (不随窗口缩放, 保原分辨率)
    Rec.canvas = document.createElement("canvas");
    Rec.canvas.width = v.videoWidth;
    Rec.canvas.height = v.videoHeight;
    Rec.cctx = Rec.canvas.getContext("2d");
    Rec.vw = v.videoWidth; Rec.vh = v.videoHeight;

    var cs = Rec.canvas.captureStream(0);  // 0 = 手动帧驱动
    var hasAudio = false;
    var aSrc = recEnsureAudio(v);
    if (aSrc) {
      try {
        var dest = Rec.ac.createMediaStreamDestination();
        aSrc.connect(dest);
        cs = new MediaStream(cs.getVideoTracks().concat(dest.stream.getAudioTracks()));
        hasAudio = true;
      } catch (e) {}
    }

    try {
      Rec.mr = new MediaRecorder(cs, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    } catch (e) {
      try { Rec.mr = new MediaRecorder(cs, { mimeType: mime }); }
      catch (e2) { toast("录制器创建失败"); return; }
    }
    Rec.chunks = [];
    Rec.mr.ondataavailable = function (ev) {
      if (!ev.data || !ev.data.size) return;
      Rec.bytes += ev.data.size;
      // 大块切小 (~96KB base64 前的上限): 规避 WebView2 postMessage 体积限制
      if (ev.data.size <= 72000) Rec.chunks.push(ev.data);
      else {
        var off = 0;
        while (off < ev.data.size) {
          Rec.chunks.push(ev.data.slice(off, off + 72000));
          off += 72000;
        }
      }
      recFlush();
    };
    Rec.mr.onerror = function () { recStop(true); };

    Rec.stream = cs;
    Rec._raf = recFrame;
    Rec.mr.start(1000);

    api.rec_open(chNameOf(LPTV.currentPid) || "直播").then(function (r) {
      if (!r || !r.ok) { toast("无法创建录制文件: " + (r && r.error)); recStop(true); return; }
      Rec.rid = r.id;
      Rec.on = true;
      recSetUI(true);
      toast("开始录制 · 覆盖层不进画面，切至后台自动停止" + (hasAudio ? "" : " (无声)"));
      recFrame();
    });
  }

  function recFrame() {
    if (!Rec.on) return;
    var v = LPTV.video;
    if (!v || !v.videoWidth) { requestAnimationFrame(Rec._raf); return; }
    // 官方换 video 元素或分辨率变化: 录制停止 (webm 无法跨流续写)
    if (v !== Rec.video || v.videoWidth !== Rec.vw || v.videoHeight !== Rec.vh) {
      dbg("rec: video-changed v_same=" + (v === Rec.video) + " " + Rec.vw + "x" + Rec.vh +
          " -> " + v.videoWidth + "x" + v.videoHeight);
      toast("画面源已变化，录制已停止");
      recStop();
      return;
    }
    try { Rec.cctx.drawImage(v, 0, 0, Rec.vw, Rec.vh); } catch (e) {}
    var track = Rec.stream && Rec.stream.getVideoTracks()[0];
    if (track && track.requestFrame) track.requestFrame();
    Rec.frames++;
    requestAnimationFrame(Rec._raf);
  }

  function recFlush() {
    // 串行写盘: 上一次 append 未完成则等 (保序)。rid>0 即可写 (录制中或停止排空中)
    if (Rec._flushing || !Rec.chunks.length || !Rec.rid) return;
    var api = recApi();
    if (!api) return;
    var blob = Rec.chunks.shift();
    Rec._flushing = true;
    var fr = new FileReader();
    fr.onload = function () {
      var b64 = String(fr.result).split(",")[1] || "";
      api.rec_append(Rec.rid, b64).then(function (r) {
        Rec._appends = (Rec._appends || 0) + 1;
        Rec._written = (r && r.size) || 0;
        Rec._flushing = false;
        recFlush();
      }, function (err) {
        Rec._appendErr = String(err);
        Rec._flushing = false;
      });
    };
    fr.onerror = function () { Rec._flushing = false; };
    fr.readAsDataURL(blob);
  }

  function recStop(silent) {
    if (!Rec.on && !Rec.mr) return;
    var rid = Rec.rid;
    var bytes = Rec.bytes, frames = Rec.frames;
    Rec.on = false;
    // 先让 MediaRecorder 产出最后一拍
    try { if (Rec.mr && Rec.mr.state === "recording") Rec.mr.requestData(); } catch (e) {}
    recDestroyGraph();
    clearInterval(Rec.timer);
    recSetUI(false);
    Rec.frames = 0;
    var api = recApi();
    // 关键: 串行排空剩余分块 (含最后一拍) 后再关闭文件; rid 保持到排空完成
    function drain(i) {
      if (i > 60) return done();  // 3s 兜底
      if (Rec.chunks.length || Rec._flushing) {
        recFlush();
        setTimeout(function () { drain(i + 1); }, 50);
      } else if (i < 6) {
        // 前 300ms 即使无块也再等: mr.stop() 的最后一拍 ondataavailable 是异步派发的
        setTimeout(function () { drain(i + 1); }, 50);
      } else {
        done();
      }
    }
    function done() {
      Rec.chunks = [];
      Rec.rid = 0;
      if (api && rid) api.rec_close(rid);
      if (!silent) toast("录制已保存 · " + (bytes / 1048576).toFixed(1) + "MB / " + frames + " 帧");
    }
    drain(0);
  }

  function recToggle() { Rec.on ? recStop() : recStart(); }

  /* 仅前台录制: 窗口失焦/最小化 -> 自动停止 (一次性绑定, Rec.on 兜底) */
  window.addEventListener("blur", function () {
    if (Rec.on) { toast("窗口已切至后台，录制自动停止"); recStop(); }
  });
  document.addEventListener("visibilitychange", function () {
    if (Rec.on && document.visibilityState === "hidden") {
      toast("窗口已切至后台，录制自动停止");
      recStop();
    }
  });

  /* ================= 一键截图 (当前节目画面, 不含任何 UI) ================= */
  function shotTake() {
    var v = LPTV.video;
    if (!v || !v.videoWidth) { toast("画面尚未就绪"); return; }
    try {
      var c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      var x = c.getContext("2d");
      x.drawImage(v, 0, 0, c.width, c.height);
      var data = c.toDataURL("image/png");
      var api = recApi();
      if (!api || !api.shot_save) { toast("截图桥不可用"); return; }
      api.shot_save(chNameOf(LPTV.currentPid) || "直播", String(data).split(",")[1] || "").then(function (r) {
        if (r && r.ok) toast("已截图 · " + r.name);
        else toast("截图失败: " + (r && r.error || ""));
      });
      // 白闪反馈
      var fl = document.getElementById("lptv-shot-flash");
      if (fl) {
        fl.classList.remove("go");
        void fl.offsetWidth;  // 重置动画
        fl.classList.add("go");
      }
    } catch (e) { toast("截图失败: " + e); }
  }


  var idleTimer = null;
  var CTRL_ZONE = 170;    // 底部触发控制栏的区域高度 (控制栏高度 + 余量)
  var ctrlTimer = null;

  function wake() {
    if (LPTV.devHidden) return;
    LPTV.ui.root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      LPTV.ui.root.classList.add("idle");
    }, cfg.autoHide);
  }

  /* 控制栏+设置面板: 指针在底部区域时显示, 离开底部区域即隐藏 */
  function showControls() {
    cancelHideControls();
    LPTV.ui.controls.classList.add("show");
    LPTV.ui.root.classList.add("ctrl-on");
  }
  function scheduleHideControls() {
    clearTimeout(ctrlTimer);
    ctrlTimer = setTimeout(function () {
      LPTV.ui.controls.classList.remove("show");
      LPTV.ui.root.classList.remove("ctrl-on");
      LPTV.ui.settings.classList.remove("open");  // 离开底部区域: 设置面板一并隐藏
    }, 900);
  }
  function cancelHideControls() {
    clearTimeout(ctrlTimer);
  }

  /* 小浮窗: 悬浮控制条 鼠标移动时出现, 离开窗口或 1.6s 无操作即隐藏 */
  var floatCtlTimer = null;
  function showFloatCtl() {
    if (!LPTV.ui.root.classList.contains("float")) return;
    LPTV.ui.root.classList.add("show-floatctl");
    clearTimeout(floatCtlTimer);
    floatCtlTimer = setTimeout(function () {
      LPTV.ui.root.classList.remove("show-floatctl");
    }, 1600);
  }
  function hideFloatCtl() {
    clearTimeout(floatCtlTimer);
    if (LPTV.ui.root) LPTV.ui.root.classList.remove("show-floatctl");
  }

  /* 顶栏窗口按钮 (无边框窗口) */
  function bindTopbar() {
    function wvApi() { return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null; }
    function setMaxIcon(isMax) {
      var b = document.getElementById("lptv-tb-max");
      if (b) b.textContent = isMax ? "\uE923" : "\uE922";
    }
    function setPinIcon(pinned) {
      var b = document.getElementById("lptv-tb-pin");
      if (b) b.classList.toggle("on", !!pinned);
    }
    var a = wvApi();
    document.getElementById("lptv-tb-min").addEventListener("click", function () {
      if (a && a.minimize) a.minimize();
    });
    document.getElementById("lptv-tb-pin").addEventListener("click", function () {
      if (a && a.pin_toggle) {
        a.pin_toggle().then(function (r) {
          setPinIcon(r && r.pinned);
          toast(r && r.pinned ? "窗口已置顶" : "已取消置顶");
        });
      }
    });
    document.getElementById("lptv-tb-max").addEventListener("click", function () {
      if (a && a.maximize_toggle) a.maximize_toggle().then(function (r) { setMaxIcon(r && r.maximized); });
      else setMaxIcon(false);
    });
    document.getElementById("lptv-tb-fs").addEventListener("click", function () { fullToggle(); });
    document.getElementById("lptv-tb-float").addEventListener("click", function () { floatToggle(); });
    document.getElementById("lptv-tb-close").addEventListener("click", function () {
      if (a && a.close_window) a.close_window();
      else window.close();
    });
    if (a && a.is_maximized) {
      setInterval(function () { a.is_maximized().then(function (r) { setMaxIcon(r && r.maximized); }); }, 2000);
    }
    if (a && a.pin_state) {
      a.pin_state().then(function (r) { setPinIcon(r && r.pinned); });
      setInterval(function () { a.pin_state().then(function (r) { setPinIcon(r && r.pinned); }); }, 3000);
    }
    if (a && a.is_fullscreen) {
      a.is_fullscreen().then(function (r) { setFullIcon(r && r.fullscreen); });
      setInterval(function () { pollFullState(); }, 2000);
    }
    if (a && a.is_float) {
      a.is_float().then(function (r) { setFloatIcon(r && r.floating); });
      setInterval(function () { pollFloatState(); }, 2000);
    }
  }

  /* 全屏切换 (双击画面 / F11 / 控制栏全屏按钮共用), 并把按钮图标同步为当前状态 */
  function fullToggle() {
    var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
    if (a && a.fullscreen_toggle) {
      a.fullscreen_toggle().then(function (r) {
        if (!r || !r.ok) { toast("全屏切换失败"); return; }
        setFullIcon(r.fullscreen);
        toast(r.fullscreen ? "已进入全屏（双击画面或 F11 可退出）" : "已退出全屏");
      });
    } else if (document.documentElement.requestFullscreen) {
      var df = document.documentElement.requestFullscreen();
      if (df && df.catch) df.catch(function () {});
    }
  }
  function setFullIcon(full) {
    var b = document.getElementById("lptv-b-full");
    if (b) {
      b.classList.toggle("on", !!full);
      b.title = full ? "退出全屏 (F11/双击)" : "全屏 (F11/双击)";
    }
    var t = document.getElementById("lptv-tb-fs");
    if (t) t.classList.toggle("on", !!full);
  }
  function pollFullState() {
    var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
    if (a && a.is_fullscreen) a.is_fullscreen().then(function (r) { setFullIcon(r && r.fullscreen); }).catch(function () {});
  }

  /* 小浮窗切换 (小尺寸并自动置顶); 与置顶按钮状态互通 */
  function floatToggle() {
    var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
    if (!a || !a.float_toggle) return;
    a.float_toggle().then(function (r) {
      if (!r || !r.ok) { toast("小浮窗切换失败"); return; }
      setFloatIcon(r.floating);
      toast(r.floating ? "已进入小浮窗（自动置顶）" : "已退出小浮窗");
      if (a.pin_state) {
        a.pin_state().then(function (p) {
          var pb = document.getElementById("lptv-tb-pin");
          if (pb) pb.classList.toggle("on", !!(p && p.pinned));
        });
      }
    });
  }
  function setFloatIcon(f) {
    f = !!f;
    var b = document.getElementById("lptv-b-float");
    if (b) { b.classList.toggle("on", f); b.title = f ? "退出小浮窗" : "小浮窗 (小尺寸并自动置顶)"; }
    var t = document.getElementById("lptv-tb-float");
    if (t) t.classList.toggle("on", f);
    var root = LPTV.ui && LPTV.ui.root;
    if (root) {
      var was = root.classList.contains("float");
      root.classList.toggle("float", f);
      if (f && !was) showFloatCtl();
      if (!f && was) hideFloatCtl();
    }
    if (f) syncPlayBtn();
  }
  function pollFloatState() {
    var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
    if (a && a.is_float) a.is_float().then(function (r) { setFloatIcon(r && r.floating); }).catch(function () {});
  }

  function togglePlay() {
    var v = LPTV.video;
    if (!v) return;
    if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); }
    else { v.pause(); LPTV._autoplayPending = false; }
    syncPlayBtn();
  }
  function syncPlayBtn() {
    var b = document.getElementById("lptv-b-play-ico");
    var fc = document.getElementById("lptv-fc-play-ico");
    var ico = LPTV.video && LPTV.video.paused
      ? '<path d="M8 5.5l11 6.5-11 6.5z"/>'
      : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
    if (b && LPTV.video) b.innerHTML = ico;
    if (fc && LPTV.video) fc.innerHTML = ico;
  }

  function setVolume(v) {
    v = clamp(v, 0, 1);
    cfg.volume = v; cfg.muted = false;
    if (LPTV.video) { LPTV.video.volume = v; LPTV.video.muted = false; }
    if (LPTV.ui.volRange) LPTV.ui.volRange.value = Math.round(v * 100);
    if (LPTV.ui.volRange2) LPTV.ui.volRange2.value = Math.round(v * 100);
    fillRange(LPTV.ui.volRange2);
    syncMuteBtn(); saveCfg();
    var vn = document.getElementById("lptv-vol-num");
    if (vn) vn.textContent = Math.round(v * 100);
    var vt = document.getElementById("lptv-c-vol-txt");
    if (vt) vt.textContent = Math.round(v * 100);
    LPTV.ui.vol.classList.add("show");
    clearTimeout(LPTV.ui.vol._t);
    LPTV.ui.vol._t = setTimeout(function () { LPTV.ui.vol.classList.remove("show"); }, 1600);
  }

  /* 控制栏音量条: 已播放部分高亮 (appearance:none 后需手动填色) */
  function fillRange(el) {
    if (!el) return;
    var mn = el.min === "" ? 0 : +el.min, mx = el.max === "" ? 100 : +el.max;
    var p = mx > mn ? (el.value - mn) / (mx - mn) * 100 : 0;
    el.style.background = "linear-gradient(90deg,#5b86e5 0%,#7d9bff " + p +
      "%,rgba(60,80,130,.55) " + p + "%)";
  }

  function toggleMute() {
    cfg.muted = !cfg.muted;
    if (LPTV.video) LPTV.video.muted = cfg.muted;
    if (!cfg.muted && cfg.volume === 0) setVolume(0.6);
    syncMuteBtn(); saveCfg(); hideHint();
  }
  function syncMuteBtn() {
    var b = document.getElementById("lptv-b-mute");
    if (b) {
      b.classList.toggle("muted", !!cfg.muted);
      b.title = cfg.muted ? "取消静音 (M)" : "静音 (M)";
    }
  }

  function handleDigit(d) {
    LPTV.digits += d;
    LPTV.ui.digit.textContent = LPTV.digits;
    LPTV.ui.digit.classList.add("show");
    clearTimeout(LPTV._digitT);
    if (LPTV.digits.length >= 3) commitDigits();
    else LPTV._digitT = setTimeout(commitDigits, 900);
  }
  function commitDigits() {
    var n = parseInt(LPTV.digits, 10);
    LPTV.digits = "";
    LPTV.ui.digit.classList.remove("show");
    if (n >= 1 && n <= LPTV.channels.length) switchChannel(LPTV.channels[n - 1].pid);
    else toast("没有频道 " + n);
  }

  function devToggle() {
    LPTV.devHidden = !LPTV.devHidden;
    LPTV.ui.root.classList.toggle("dev-hidden", LPTV.devHidden);
    toast(LPTV.devHidden ? "已隐藏 LPTV 界面（Ctrl+D 恢复）" : "已恢复 LPTV 界面");
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    ta.remove();
    return Promise.resolve(ok);
  }

  function bindEvents() {
    var root = LPTV.ui.root;

    root.addEventListener("mousemove", function (e) {
      wake(); panelPointer(e); epgPointer(e); topbarPointer(e); showFloatCtl();
      if (e.clientY >= innerHeight - CTRL_ZONE) showControls();
      else scheduleHideControls();
    });
    /* 指针离开窗口: 已"进入过区域"的滑窗立即隐藏 (不等延迟) */
    document.addEventListener("mouseout", function (e) {
      if (!e.relatedTarget && !e.toElement) {
        if (LPTV._panelIn) schedulePanelHide(0);
        if (LPTV._epgIn) scheduleEpgHide(0);
        scheduleHideControls();
        hideFloatCtl();
      }
    });
    root.addEventListener("mousedown", wake);

    /* ---- 触摸平板适配 (需求6) ----
     * 触摸屏无 hover, 原 mousemove 边缘滑出面板/节目单不生效。
     * 补: ①左右缘轻扫/tap 开关抽屉 ②点画面切换控制栏显隐
     *     ③抽屉打开时点外部关闭。桌面鼠标逻辑保持不变。 */
    var TOUCH = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
    if (TOUCH) {
      var _tsX = 0, _tsY = 0, _tsT = 0, _tsTarget = null;
      root.addEventListener("touchstart", function (e) {
        if (e.touches.length !== 1) return;
        var t = e.touches[0];
        _tsX = t.clientX; _tsY = t.clientY; _tsT = Date.now(); _tsTarget = e.target;
        wake();
      }, { passive: true });
      root.addEventListener("touchend", function (e) {
        if (!e.changedTouches || !e.changedTouches.length) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - _tsX, dy = t.clientY - _tsY, dt = Date.now() - _tsT;
        var tap = Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 400;
        var inDrawer = _tsTarget && _tsTarget.closest && _tsTarget.closest("#lptv-panel,#lptv-epg,#lptv-settings,#lptv-controls,#lptv-topbar,#lptv-about");
        // 右缘 -> 节目单抽屉
        if (!inDrawer && (_tsX >= innerWidth - 60) && (dx < -30 || tap)) {
          e.preventDefault();
          if (!LPTV.ui.epg.classList.contains("open")) toggleEpg();
          return;
        }
        // 左缘 -> 频道抽屉
        if (!inDrawer && (_tsX <= 60) && (dx > 30 || tap)) {
          e.preventDefault();
          if (!LPTV.ui.panel.classList.contains("open")) togglePanel();
          return;
        }
        // 抽屉打开时点外部关闭
        if (!inDrawer && tap) {
          if (LPTV.ui.panel.classList.contains("open")) { hidePanel(); return; }
          if (LPTV.ui.epg.classList.contains("open")) { hideEpg(); return; }
          if (LPTV.ui.settings.classList.contains("open")) { LPTV.ui.settings.classList.remove("open"); return; }
          // 点画面: 切换控制栏显隐
          if (LPTV.ui.controls.classList.contains("show")) { LPTV.ui.root.classList.remove("ctrl-on"); LPTV.ui.controls.classList.remove("show"); }
          else showControls();
        }
      }, { passive: false });
    }

    /* 长名称悬停气泡: 指向截断的节目/预约名 (.lptv-epg-n/.lptv-res-name) 时显示完整文本 */
    var NAME_POP_SEL = ".lptv-epg-n,.lptv-res-name";
    function namePopHide() {
      var pop = document.getElementById("lptv-name-pop");
      if (pop) pop.classList.remove("show");
    }
    root.addEventListener("mouseover", function (e) {
      var t = e.target.closest && e.target.closest(NAME_POP_SEL);
      var pop = document.getElementById("lptv-name-pop");
      if (!pop) return;
      if (t && t.scrollWidth > t.clientWidth + 1) {  // 确实被截断
        pop.textContent = t.textContent;
        pop.classList.add("show");
        var r = t.getBoundingClientRect();
        pop.style.left = Math.max(4, Math.min(r.left, innerWidth - 440)) + "px";
        var top = r.bottom + 6;
        var ph = pop.offsetHeight || 40;
        if (top + ph > innerHeight) top = r.top - ph - 6;  // 视口内翻转
        pop.style.top = Math.max(4, top) + "px";
      } else {
        pop.classList.remove("show");
      }
    });
    root.addEventListener("mouseout", function (e) {
      var t = e.target.closest && e.target.closest(NAME_POP_SEL);
      if (t) {
        var pop = document.getElementById("lptv-name-pop");
        if (pop) pop.classList.remove("show");
      }
    });
    root.addEventListener("wheel", function (e) {
      var t = e.target;
      // 面板/设置/节目单内部: 交给原生滚动 (否则音量滚轮会劫持滚动)
      if (t && t.closest && t.closest("#lptv-panel,#lptv-settings,#lptv-epg")) {
        namePopHide();  // 滚动时收起长名气泡 (位置已失真)
        return;
      }
      e.preventDefault();
      setVolume((LPTV.video ? LPTV.video.volume : cfg.volume) + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
    LPTV.ui.controls.addEventListener("mouseenter", cancelHideControls);
    LPTV.ui.controls.addEventListener("mouseleave", scheduleHideControls);
    LPTV.ui.settings.addEventListener("mouseenter", cancelHideControls);
    LPTV.ui.settings.addEventListener("mouseleave", scheduleHideControls);

    // 频道面板: 行点击切台 / 星标收藏 / 分类 tab 切换
    document.getElementById("lptv-panel-body").addEventListener("click", function (e) {
      var fav = e.target.closest(".lptv-ch-fav");
      if (fav) {
        e.stopPropagation();
        var on = favToggle(fav.dataset.pid);
        toast(on ? "已收藏: " + chNameOf(fav.dataset.pid) : "已取消收藏");
        renderPanel();
        return;
      }
      var item = e.target.closest(".lptv-ch");
      if (!item) return;
      switchChannel(item.dataset.pid);
      hidePanel();
    });
    document.getElementById("lptv-panel-tabs").addEventListener("click", function (e) {
      var t = e.target.closest(".lptv-ptab");
      if (!t) return;
      LPTV._panelFilter = t.dataset.f;
      renderPanel();
    });

    // EPG: 日期 tab 切换 + 行内预约开关 (预约列表入口在面板右上角按钮)
    document.getElementById("lptv-epg-tabs").addEventListener("click", function (e) {
      var t = e.target.closest(".lptv-epg-tab");
      if (!t) return;
      LPTV.epg._resView = false;
      epgSetDay(parseInt(t.dataset.off, 10) || 0);
    });
    var epgResBtn = document.getElementById("lptv-epg-resbtn");
    if (epgResBtn) epgResBtn.addEventListener("click", function () {
      LPTV.epg._resView = !LPTV.epg._resView;
      epgRender();
    });
    // 预约视图: 点行跳频道 / 点×取消
    document.getElementById("lptv-epg-body").addEventListener("click", function (e) {
      if (e.target.classList.contains("lptv-res-x")) {
        var row = e.target.closest(".lptv-res-row");
        if (!row) return;
        var list = resLoad().filter(function (r) { return r.id !== row.dataset.id; });
        resSave(list);
        toast("已取消预约");
        resRender(); epgRenderTabs();
        return;
      }
      var res = e.target.closest(".lptv-epg-res");
      if (res) {
        var row2 = res.closest(".lptv-epg-row");
        if (!row2) return;
        var pid = row2.dataset.pid, s0 = parseInt(row2.dataset.s0, 10) || 0;
        if (!pid || !s0) return;
        var key = pid + "|" + epgYmdOf(epgDayOffset());
        var p = ((LPTV.epg.cache || {})[key] || []).find(function (x) { return x.s0 === s0; });
        var on = resToggle(pid, s0, p && p.e0, p && p.name);
        toast(on ? "已预约开播提醒: " + (p ? p.name : "") : "已取消预约");
        res.classList.toggle("on", on);
        res.textContent = on ? "已约" : "预约";
        res.title = on ? "已预约, 点击取消" : "预约开播提醒";
        epgRenderTabs();
        return;
      }
      var rr = e.target.closest(".lptv-res-row");
      if (rr && rr.dataset.pid) {
        switchChannel(rr.dataset.pid);
        hideEpg();
      }
    });
    // 开播提醒 Toast: 点击跳转到该频道 (点击后不再自动跳)
    LPTV.ui.toast.addEventListener("click", function () {
      var pid = LPTV.ui.toast._res;
      if (pid) {
        LPTV.ui.toast._resClicked = true;
        switchChannel(pid);
        LPTV.ui.toast.classList.remove("show");
        LPTV.ui.toast._res = null;
        clearTimeout(LPTV.ui.toast._resJump);
      }
    });
    bindTopbar();
    wake();

    // 双击画面 全屏/窗口 切换; 单击不再触发暂停 (空格键暂停/播放)
    var lastTap = 0;
    root.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest && t.closest("#lptv-controls,#lptv-nextch,#lptv-panel,#lptv-epg,#lptv-settings,#lptv-toast,#lptv-hint,#lptv-osd,#lptv-vol,#lptv-digit,#lptv-topbar,#lptv-win-grip,#lptv-rec-badge")) return;
      var now = Date.now();
      if (now - lastTap < 350) {
        lastTap = 0;
        var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
        if (a && a.fullscreen_toggle) fullToggle();
        else if (document.documentElement.requestFullscreen) {
          var df = document.documentElement.requestFullscreen();
          if (df && df.catch) df.catch(function () {});
        }
      } else {
        lastTap = now;
      }
    });

    LPTV.ui.volRange.addEventListener("input", function () { setVolume(this.value / 100); });
    LPTV.ui.volRange2.addEventListener("input", function () { setVolume(this.value / 100); });

    LPTV.ui.controls.addEventListener("click", function (e) {
      var t = e.target.closest("button");
      if (!t) return;
      switch (t.id) {
        case "lptv-b-prev": stepChannel(-1); break;
        case "lptv-b-next": stepChannel(1); break;
        case "lptv-b-play": togglePlay(); break;
        case "lptv-b-mute": toggleMute(); break;
        case "lptv-b-rec": recToggle(); break;
        case "lptv-b-shot": shotTake(); break;
        case "lptv-b-float": floatToggle(); break;
        case "lptv-b-full": fullToggle(); break;
        case "lptv-b-epg": toggleEpg(); break;
        case "lptv-b-panel": togglePanel(); break;
        case "lptv-b-set": toggleSettings(); break;
      }
    });

    if (LPTV.ui.floatCtl) {
      LPTV.ui.floatCtl.addEventListener("click", function (e) {
        var t = e.target.closest("button");
        if (!t) return;
        switch (t.id) {
          case "lptv-fc-prev": stepChannel(-1); break;
          case "lptv-fc-next": stepChannel(1); break;
          case "lptv-fc-play": togglePlay(); break;
          case "lptv-fc-exit": floatToggle(); break;
        }
      });
    }

    LPTV.ui.settings.addEventListener("change", function (e) {
      var t = e.target;
      if (t.id === "lptv-s-resume") { cfg.resumeLast = t.checked; pyStatePush({ resumeLast: t.checked }); }
      if (t.id === "lptv-s-autofs") { pyStatePush({ autoFullscreen: t.checked }); }
      if (t.id === "lptv-s-autostart") {
        var a9 = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
        if (a9 && a9.autostart_set) {
          a9.autostart_set(t.checked).then(function (r) {
            if (r && !r.ok) { t.checked = !t.checked; toast("自启动设置失败"); }
            else toast(t.checked ? "已开启开机自启动" : "已关闭开机自启动");
          });
        }
      }
      if (t.id === "lptv-s-fit") { cfg.fit = t.value; styleOfficial(); pyStatePush({ fit: t.value }); }
      saveCfg();
    });

    /* 保存位置: 更改/打开 (录制与截图各自独立) */
    function dirShow(kind, dir) {
      var el2 = document.getElementById(kind === "rec" ? "lptv-s-recdir-val" : "lptv-s-shotdir-val");
      if (el2) { el2.textContent = dir || "--"; el2.title = dir || ""; }
    }
    function dirRefresh() {
      var a3 = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
      if (a3 && a3.get_save_dirs) a3.get_save_dirs().then(function (r) {
        if (r && r.ok) { dirShow("rec", r.rec); dirShow("shot", r.shot); }
      });
    }
    LPTV.ui.settings.addEventListener("click", function (e) {
      if (e.target.closest("#lptv-s-about")) { openAbout(); return; }
      var id = e.target.id, kind = "";
      if (id === "lptv-s-recdir-pick" || id === "lptv-s-shotdir-pick") kind = id.indexOf("recdir") > 0 ? "rec" : "shot";
      else if (id === "lptv-s-recdir-open" || id === "lptv-s-shotdir-open") {
        kind = id.indexOf("recdir") > 0 ? "rec" : "shot";
        var a1 = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
        if (a1 && a1.open_save_dir) a1.open_save_dir(kind);
        return;
      } else return;
      var a2 = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
      if (!a2 || !a2.pick_save_dir) { toast("桥不可用"); return; }
      a2.pick_save_dir(kind).then(function (r) {
        if (r && r.ok) { dirShow(kind, r.dir); toast("保存位置已更改: " + r.dir); }
      });
    });
    setInterval(dirRefresh, 5000);

    /* 关于应用弹窗: 打开时收起设置面板, 版本号与二维码经桥异步获取 */
    function openAbout() {
      LPTV.ui.settings.classList.remove("open");
      LPTV.ui.about.classList.add("open");
      var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
      if (a && a.get_version) a.get_version().then(function (v) {
        var t = document.getElementById("lptv-about-ver");
        if (t && v) t.textContent = "版本 v" + v;
      }).catch(function () {});
      if (a && a.get_asset_image) {
        a.get_asset_image("icon.png").then(function (r) {
          var img = document.getElementById("lptv-about-logo-img");
          if (img && r && r.ok) img.src = r.src;
        }).catch(function () {});
      }
    }
    LPTV.ui.about.addEventListener("click", function (e) {
      if (e.target.id === "lptv-about" || e.target.id === "lptv-about-x") LPTV.ui.about.classList.remove("open");
    });

    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); devToggle(); return; }
      if (LPTV.devHidden) return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var panelOpen = LPTV.ui.panel.classList.contains("open");
      var k = e.key;
      // 全部消费掉: 阻止官方 SPA 收到 空格/方向键/数字 等触发其内部行为
      if (/^[0-9]$/.test(k)) { e.preventDefault(); e.stopPropagation(); handleDigit(k); }
      else if (k === "ArrowUp") { e.preventDefault(); e.stopPropagation(); panelOpen ? panelNav(-1) : chanKey(-1); }
      else if (k === "ArrowDown") { e.preventDefault(); e.stopPropagation(); panelOpen ? panelNav(1) : chanKey(1); }
      else if (k === "PageUp") { e.preventDefault(); e.stopPropagation(); chanKey(-1); }
      else if (k === "PageDown") { e.preventDefault(); e.stopPropagation(); chanKey(1); }
      else if (k === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setVolume((LPTV.video ? LPTV.video.volume : cfg.volume) - 0.05); }
      else if (k === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setVolume((LPTV.video ? LPTV.video.volume : cfg.volume) + 0.05); }
      else if (k === "Enter") { if (panelOpen) { e.preventDefault(); e.stopPropagation(); panelSelect(); } }
      else if (k === " ") { e.preventDefault(); e.stopPropagation(); togglePlay(); }
      else if (k === "m" || k === "M") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); toggleMute(); } }
      else if (k === "s" || k === "S") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); togglePanel(); } }
      else if (k === "e" || k === "E") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); toggleEpg(); } }
      else if (k === "r" || k === "R") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); recToggle(); } }
      else if (k === "x" || k === "X") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); shotTake(); } }
      else if (k === "F11") {
        e.preventDefault();
        if (isTyping()) return;
        fullToggle();
      }
      else if (k === "Escape") { hidePanel(); hideEpg(); LPTV.ui.settings.classList.remove("open"); LPTV.ui.about.classList.remove("open"); }
      wake();
    }, true);

    // 无边框窗口: 右下角缩放柄通过桥 resize 整窗
    (function () {
      var grip = document.getElementById("lptv-win-grip");
      if (!grip) return;
      grip.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        var baseW = innerWidth, baseH = innerHeight, sx = e.clientX, sy = e.clientY;
        var moved = false, last = 0;
        function doResize(ev) {
          var now = Date.now();
          if (now - last < 50) return;
          last = now;
          var a = (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
          if (a && a.resize_win) a.resize_win(baseW + ev.clientX - sx, baseH + ev.clientY - sy);
        }
        function onMove(ev) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
          if (moved) doResize(ev);
        }
        function onUp(ev) {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          if (moved) doResize(ev);
        }
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
    })();

    // 当前节目名随节目边界自动刷新
    setInterval(function () { updateNowProg(); }, 30000);
    setInterval(function () { syncPlayBtn(); }, 2000);
  }

  /* ================= 对外 API (多端壳层) ================= */

  LPTV.setChannels = function (channels) {
    LPTV.channels = channels.map(function (c) {
      // 保留已由摘要收割校正过的 official (官网按钮文字), 没有才从名称推导
      var official = c.official || c.name.split(" ")[0].replace("CCTV-", "CCTV");
      return Object.assign({}, c, { official: official });
    }).filter(function (c) {
      // VIP/限免/付费台不显示
      return c.category !== "付费" && !isPayChannel(c.official || "") && !isPayChannel(c.name || "");
    });
    renderPanel(); setChLabel();
  };

  LPTV.switchChannel = function (pid) { switchChannel(pid); };
  LPTV.getPlayUrl = function () {
    if (LPTV.playUrl) return LPTV.playUrl;
    if (LPTV.currentHls && LPTV.currentHls.url) return LPTV.currentHls.url;
    var src = LPTV.video && LPTV.video.currentSrc;
    return src && src.indexOf("http") === 0 ? src : "";
  };
  LPTV.toast = toast;
  LPTV.resTick = resTick;   // E2E/测试可手动触发预约扫描
  LPTV.recToggle = recToggle;   // E2E/外壳可编程触发录制
  LPTV.recState = function () {
    return { on: Rec.on, rid: Rec.rid, bytes: Rec.bytes, frames: Rec.frames,
             ac: !!Rec.ac, src: !!Rec.srcNode, mime: (Rec.mr && Rec.mr.mimeType) || "",
             appends: Rec._appends || 0, written: Rec._written || 0, appendErr: Rec._appendErr || "" };
  };

  /* ================= 启动 ================= */

  function initChannels(retries) {
    retries = retries || 0;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.get_channels) {
      window.pywebview.api.get_channels().then(function (chs) {
        LPTV.setChannels(chs);
        var m = location.href.match(/pid=(\d+)/);
        var urlPid = m ? m[1] : "";
        LPTV.currentPid = urlPid || (chs[0] && chs[0].pid || "");
        // 跨启动状态合并 (favs/lastPid/resumeLast 存 Python 侧)
        var api2 = pyApi();
        var resumeFlow = function () {
          if (cfg.resumeLast !== false && cfg.lastPid && cfg.lastPid !== urlPid &&
              chs.some(function (c) { return c.pid === cfg.lastPid; })) {
            dbg("resume last: " + cfg.lastPid);
            setTimeout(function () { switchChannel(cfg.lastPid); }, 800);
          }
          markActive();
        };
        if (api2 && api2.get_ui_state) {
          api2.get_ui_state().then(function (st) {
            if (st && st.ok) {
              if (Array.isArray(st.favs) && st.favs.length) {
                // Python 状态为准 (localStorage 每次启动都是空的)
                cfg.favs = st.favs.filter(function (pid) {
                  return chs.some(function (c) { return c.pid === pid; });
                });
                saveCfg();
              }
              if (typeof st.resumeLast === "boolean") cfg.resumeLast = st.resumeLast;
              if (st.lastPid) cfg.lastPid = st.lastPid;
              // 画面模式跨启动恢复 (contain/cover/fill)
              if (typeof st.fit === "string") { cfg.fit = st.fit; syncFit(); styleOfficial(); }
              // 自动全屏: 启动时按设置进入沉浸观看
              if (st.autoFullscreen) {
                setTimeout(function () { fullToggle(); }, 2600);
              }
              // 预约列表跨启动恢复 (localStorage -> resLoad 可直接读)
              if (Array.isArray(st.res) && st.res.length) {
                try { localStorage.setItem(RES_KEY, JSON.stringify(st.res)); } catch (e) {}
                epgRenderTabs();  // 刷新预约 tab 徽标
              }
              var rs = document.getElementById("lptv-s-resume");
              if (rs) rs.checked = cfg.resumeLast !== false;
            }
            resumeFlow();
          }).catch(resumeFlow);
        } else {
          resumeFlow();
        }
        setChLabel();
        dbg("channels=" + chs.length + " cur=" + LPTV.currentPid);
        // 收割官方侧栏: 官方频道渲染晚于 SPA, 重试直到稳定拿到全量
        var lastN = -1, stable = 0, tries = 0;
        var h = setInterval(function () {
          tries++;
          var cont = document.querySelector(".tv-main-con-r-list-left");
          var cnt = cont ? cont.children.length : 0;
          var added = harvestOfficial();
          if (added > 0) {
            renderPanel(); markActive(); setChLabel();
            dbg("harvest +" + added + " n=" + LPTV.channels.length);
          }
          if (cnt >= 30) {
            if (LPTV.channels.length === lastN) stable++;
            else stable = 0;
            lastN = LPTV.channels.length;
            if (stable >= 2 || tries > 20) {
              clearInterval(h);
              dbg("harvest done n=" + LPTV.channels.length);
            }
          } else if (tries > 20) {
            clearInterval(h);
          }
        }, 1500);
      }).catch(function () { setTimeout(function () { initChannels(retries + 1); }, 500); });
    } else if (retries < 30) {
      setTimeout(function () { initChannels(retries + 1); }, 400);
    }
  }

  /* 首频道 playUrl 由 currentHls hook 捕获, 不再需要 dance 补抓 */

  /* 交互区清单: 命中其中任一元素的 mousedown 不允许成为窗口拖拽起点
     (pywebview easy_drag 在 window 上冒泡监听 mousedown -> 这里捕获阶段先行拦截,
      且不 preventDefault, 原生拖动/点击行为不受影响) */
  /* 交互区清单: 命中其中任一元素的 mousedown 不允许成为窗口拖拽起点
     注意: #lptv-topbar 本身要可拖拽(易拖区), 只豁免其中按钮区/输入控件;
     pywebview easy_drag 在 window 上冒泡监听 mousedown -> 这里捕获阶段先行拦截,
     且不 preventDefault, 原生拖动/点击行为不受影响) */
  var DRAG_GUARD_SEL = "#lptv-tb-btns,#lptv-controls,#lptv-vol,#lptv-panel,#lptv-epg," +
    "#lptv-settings,#lptv-toast,#lptv-hint,#lptv-osd,#lptv-nextch,#lptv-digit,#lptv-rec-badge,#lptv-win-grip,input,select,button";

  function installDragGuard() {
    window.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest(DRAG_GUARD_SEL)) e.stopPropagation();
    }, true);  // capture: 早于 pywebview customize.js 的 bubble 监听
  }

  function boot() {
    installHlsHooks();
    installDragGuard();
    buildUI();
    setQuality();
    syncFit();
    initChannels();
    // 兜底: 卡在加载(黑屏)时也淡出启动黑幕, 露出 OSD/提示
    setTimeout(removeBootmask, 15000);
    if (LPTV.video && !LPTV.video.paused) showOSD("00", "正在接入直播…", true);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(boot, 100);
  } else {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 100); });
  }

  LPTV.boot = boot;
})();