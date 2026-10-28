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
 *     + (可选) lptv.setChannels()/lptv.boot()
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

  var lptv = window.__lptv = {
    playUrl: "",
    currentPid: "",
    channels: [],
    logoCache: {},           // pid -> data URI (懒加载, 首次渲染时按需获取)
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
    return window.lptv ? window.lptv : null;
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
    if (u.indexOf("get_live_info") >= 0) {
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
      if (url && url.indexOf("get_live_info") >= 0) {
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
      if (lptv._pidBefore && pid === lptv._pidBefore &&
          Date.now() - (lptv._switchAt || 0) < 6000) {
        dbg("stale pu ignored: " + pid);
        return;
      }
      // 收割的频道先用合成 pid(x...)占位, 收到官网真实 pid 后替换, 保持身份稳定
      if (lptv.currentPid && String(lptv.currentPid).charAt(0) === "x") {
        var ch = lptv.channels.find(function (c) { return c.pid === lptv.currentPid; });
        if (ch) ch.pid = pid;
      }
      lptv.currentPid = pid;
    }
    // 记忆最后播放频道 (含启动首台)
    if (pid && /^\d+$/.test(String(pid))) {
      cfg.lastPid = pid;
      saveCfg();
      pyStatePush({ lastPid: pid });  // 跨启动持久化
    }
    markActive();
    epgSync();
    if (url === lptv.playUrl) return;
    lptv.playUrl = url;
    lptv._loadedPid = pid || lptv._loadedPid;
    dbg("pu:" + url.slice(0, 30));
    showOSD(chNumLabel(), "正在直播 · " + chNameOf(lptv.currentPid));
  }

  function dbg(s) {
    lptv._dbg.push(((new Date()).getTime() % 100000) + " " + s);
    if (lptv._dbg.length > 30) lptv._dbg.shift();
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
    if (cand !== lptv.video) {
      dbg("ov=" + (cand === lptv.video ? "same" : "acquire"));
      lptv.video = cand;
      if (!lptv._ovBound) { bindVideoEvents(); lptv._ovBound = true; }
      styleOfficial();
    }
  }

  function styleOfficial() {
    var v = lptv.video;
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
    var v = lptv.video;
    v.addEventListener("loadeddata", function () { showSpin(false); });
    v.addEventListener("waiting", function () { showSpin(true); dbg("vwaiting t=" + Math.floor(v.currentTime)); });
    v.addEventListener("stalled", function () { showSpin(true); dbg("vstalled"); });
    // 官方播放器切台时会重置音量为默认(50%) -> 强制回到用户设置的音量
    v.addEventListener("volumechange", function () {
      if (lptv._volLock || !cfg || cfg.muted) return;
      var want = cfg.volume != null ? cfg.volume : 1;
      if (Math.abs(v.volume - want) > 0.02) {
        lptv._volLock = true;
        v.volume = want;
        setTimeout(function () { lptv._volLock = false; }, 50);
        dbg("volock " + Math.round(v.volume * 100) + "->" + Math.round(want * 100));
      }
    });
    v.addEventListener("playing", function () {
      lptv._resumes = 0;
      showSpin(false);
      removeBootmask();  // 官方画面已开始 -> 淡出启动黑幕
      dbg("vplaying t=" + Math.floor(v.currentTime));
      if (!cfg.muted && v.volume !== (cfg.volume != null ? cfg.volume : 1)) {
        v.volume = cfg.volume != null ? cfg.volume : 1;
      }
      showOSD(chNumLabel(), "正在直播 · " + chNameOf(lptv.currentPid));
      hideHint();
    });
    v.addEventListener("pause", function () { dbg("vpause t=" + Math.floor(v.currentTime)); handleExternalPause(); });
    v.addEventListener("error", function () { dbg("verror " + (v.error && v.error.code)); });
  }

  var _resumeT = null;
  function handleExternalPause() {
    var v = lptv.video;
    if (!lptv._autoplayPending || !v) return;
    if (!(v.readyState >= 2 && v.videoWidth)) return;
    if (lptv._resumes > 12) return;
    clearTimeout(_resumeT);
    _resumeT = setTimeout(function () {
      if (lptv._autoplayPending && v.paused && v.readyState >= 2 && v.videoWidth) {
        lptv._resumes = (lptv._resumes || 0) + 1;
        dbg("vresume #" + lptv._resumes);
        tryPlay();
      }
    }, 400);
  }

  function tryPlay() {
    var v = lptv.video;
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
    if (!window.Hls || window.Hls.__lptvBoosted) return;
    window.Hls.__lptvBoosted = true;
    var origLoad = window.Hls.prototype.loadSource;
    window.Hls.prototype.loadSource = function (url) {
      lptv.currentHls = this;
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
    var inst = lptv.currentHls;
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
    var group = document.getElementById("lptv-s-fit");
    if (!group) return;
    var radio = group.querySelector('input[value="' + cfg.fit + '"]');
    if (radio) radio.checked = true;
  }

  /* 低频保活: 官方元素被替换/样式复位时重铺; 窗口 resize 后官方可能改回样式;
   异常暂停时恢复 */
  setInterval(function () {
    acquireOfficial();
    styleOfficial();
    var v = lptv.video;
    if (!v) return;
    if (v.paused && lptv._autoplayPending && v.readyState >= 2 && v.videoWidth &&
        (lptv._resumes || 0) < 12) {
      dbg("wkr " + Math.floor(v.currentTime));
      tryPlay();
    }
  }, 3000);

  /* ================= 黑帧看门狗 ================= */

  var wcanvas = document.createElement("canvas");
  wcanvas.width = 48; wcanvas.height = 27;
  var wctx = wcanvas.getContext("2d");

  setInterval(function () {
    var v = lptv.video;
    if (!v || v.paused || v.readyState < 2 || !v.videoWidth) return;
    try {
      wctx.drawImage(v, 0, 0, 48, 27);
      var d = wctx.getImageData(0, 0, 48, 27).data;
      var sum = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      var avg = sum / (n * 3);
      if (avg < 12) {
        lptv.darkCount++;
        if (lptv.darkCount >= 3) recoverBlack();  // 恒开 (设置中不再提供开关)
      } else {
        lptv.darkCount = 0;
      }
    } catch (e) {}
  }, 4000);

  function recoverBlack() {
    lptv.darkCount = 0;
    var v = lptv.video;
    if (v) {
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); }
    }
    switchChannel(lptv.currentPid);
    toast("检测到黑帧，已自动恢复");
  }

  /* ================= 频道逻辑 ================= */

  function officialNameOf(pid) {
    var ch = lptv.channels.find(function (c) { return c.pid === pid; });
    return ch ? ch.official : "";
  }
  function chNameOf(pid) {
    var ch = lptv.channels.find(function (c) { return c.pid === pid; });
    return ch ? ch.name : (pid ? "频道 " + pid : "");
  }
  function chNumLabel() {
    var idx = lptv.channels.findIndex(function (c) { return c.pid === lptv.currentPid; });
    return idx >= 0 ? String(idx + 1).padStart(2, "0") : "--";
  }
  /* 懒加载频道台标: pid -> logos/{pid}.webp 的 data URI, 缓存到 lptv.logoCache */
  function getLogoDataUri(pid) {
    if (!pid || !/^\d+$/.test(pid)) return '';
    if (lptv.logoCache[pid]) return lptv.logoCache[pid];
    var api = window.lptv;
    if (!api || !api.get_asset_image) return '';
    api.get_asset_image(pid + '.webp', 'logos').then(function (r) {
      if (r && r.ok && r.src) lptv.logoCache[pid] = r.src;
    }).catch(function () {});
    return '';
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
    if (pid !== lptv.currentPid) {           // 记录切台, 供 onPlayUrl 过期响应防护
      lptv._pidBefore = lptv.currentPid;
      lptv._switchAt = Date.now();
    }
    lptv.currentPid = pid;
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
      if (lptv.playUrl) return;
      var eff = lptv.currentPid || pid;
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
    if (!lptv.channels.length) return;
    var idx = lptv.channels.findIndex(function (c) { return c.pid === lptv.currentPid; });
    var next = (idx < 0 ? 0 : idx + delta + lptv.channels.length) % lptv.channels.length;
    switchChannel(lptv.channels[next].pid);
    showNextCh(delta);
  }

  /* 上下台预览: 展示当前台的上一个/下一个 (毛玻璃标识, 高亮本次方向) */
  function showNextCh(dir) {
    var p = lptv.ui.nextch;
    if (!p || !lptv.channels.length) return;
    var idx = lptv.channels.findIndex(function (c) { return c.pid === lptv.currentPid; });
    if (idx < 0) return;
    var prev = lptv.channels[(idx - 1 + lptv.channels.length) % lptv.channels.length];
    var next = lptv.channels[(idx + 1) % lptv.channels.length];
    var prevNo = idx === 0 ? lptv.channels.length : idx;
    var nextNo = (idx + 1) % lptv.channels.length + 1;
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
      el.classList.toggle("active", el.dataset.pid === lptv.currentPid);
    });
    updatePanelCur();
    updateTopbarCh();
    setChLabel();
  }
  function updateTopbarCh() {
    var ch = document.getElementById("lptv-tb-ch");
    if (!ch) return;
    var cur = lptv.channels.find(function (c) { return c.pid === lptv.currentPid; });
    ch.textContent = (lptv.currentPid && cur) ? cur.name : (lptv.currentPid ? chNameOf(lptv.currentPid) : "未连接");
  }

  /* ================= UI ================= */

  var CSS = `
  #lptv-root{--glass:rgba(18,20,28,.74);--glass-2:rgba(28,31,42,.90);--line:rgba(255,255,255,.09);
    --tx:#eef1f8;--tx2:#9aa6c0;--tx3:#6b7fae;--acc:#3d9bff;--acc2:#4fd1c5;
    --red:#ff4d4d;--ok:#35c46b;
    position:fixed;inset:0;z-index:2147483002;background:transparent;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:var(--tx);font-size:calc(13.0px * var(--fs-scale));line-height:1.6;
    overflow:hidden;user-select:none}
  #lptv-root.dev-hidden{display:none}

  #lptv-spin{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;z-index:3;
    width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,255,255,.15);
    border-top-color:var(--acc);animation:lptvspin .8s linear infinite;pointer-events:none}
  @keyframes lptvspin{to{transform:translate(-50%,-50%) rotate(360deg)}}

  #lptv-osd{position:absolute;left:16px;bottom:64px;pointer-events:none;opacity:0;z-index:10;
    transition:opacity .35s;max-width:70vw;text-shadow:0 2px 12px rgba(0,0,0,.9)}
  #lptv-osd.show{opacity:1}
  .lptv-osd-num{font-size:calc(34.0px * var(--fs-scale));font-weight:700;line-height:1}
  .lptv-osd-num b{color:var(--acc)}
  .lptv-osd-name{font-size:calc(17.0px * var(--fs-scale));font-weight:600;margin-top:3px}
  .lptv-osd-sub{font-size:calc(12.0px * var(--fs-scale));color:var(--tx2);margin-top:2px;letter-spacing:1px}

  #lptv-digit{position:absolute;right:38px;top:34px;font-size:calc(40.0px * var(--fs-scale));font-weight:800;z-index:10;
    display:none;pointer-events:none;text-shadow:0 2px 14px rgba(0,0,0,.9)}
  #lptv-digit.show{display:block}

  #lptv-vol{position:absolute;right:38px;top:110px;width:220px;opacity:0;z-index:10;pointer-events:none;
    transition:opacity .3s}
  #lptv-vol.show{opacity:1;pointer-events:auto}
  #lptv-vol .lptv-vol-label{font-size:calc(13.0px * var(--fs-scale));color:var(--tx2);margin-bottom:6px;letter-spacing:1px}

  /* 底部控制栏: 居中收窄 (不再贴满左右边缘), 避免遮挡左(频道)/右(节目单)的
     hover 触发带与滑出面板; 内容超出 max-width 时 .lptv-ctl-now 自行截断 */
  #lptv-controls{position:absolute;left:50%;bottom:16px;z-index:8;
    width:max-content;max-width:min(76vw,760px);
    display:flex;align-items:center;gap:6px;padding:6px 9px;border-radius:12px;
    background:var(--glass);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    border:1px solid var(--line);box-shadow:0 8px 30px rgba(0,0,0,.5);
    opacity:0;transform:translate(-50%,14px);transition:opacity .25s,transform .25s;
    pointer-events:none}
  #lptv-controls.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}
  .lptv-ctl-seg{display:flex;align-items:center;gap:4px}
  .lptv-ctl-now{flex:1;justify-content:center;min-width:0;overflow:hidden;padding:0 4px}
  .lptv-ctl-side{gap:2px}
  .lptv-now-dot{width:7px;height:7px;border-radius:50%;background:var(--red);
    box-shadow:0 0 7px var(--red);flex-shrink:0;animation:lptvnow 2s ease-in-out infinite}
  @keyframes lptvnow{0%,100%{opacity:1}50%{opacity:.35}}
  .lptv-now-sep{color:var(--tx3);margin:0 2px}
  .lptv-now-prog{font-size:calc(11.5px * var(--fs-scale));color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lptv-vol-txt{font-size:calc(11.5px * var(--fs-scale));color:var(--tx2);width:26px;text-align:center}
  .lptv-btn{border:0;cursor:pointer;color:var(--tx);border-radius:9px;background:rgba(255,255,255,.07);
    display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 8px;
    font-size:calc(12.5px * var(--fs-scale));white-space:nowrap;position:relative;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
    transition:background .16s,color .16s,box-shadow .16s,transform .12s}
  .lptv-btn:hover{background:rgba(255,255,255,.18);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 4px 14px rgba(0,0,0,.35)}
  .lptv-btn:active{transform:scale(.92)}
  .lptv-btn-ico{width:40px;padding:0}
  .lptv-btn-ico svg{width:18px;height:18px;fill:currentColor;stroke:currentColor;transition:transform .18s}
  .lptv-btn-ico:hover svg{transform:scale(1.1)}
  .lptv-btn-main{width:50px;height:50px;background:linear-gradient(135deg,#3d9bff,#2f7fe0);color:#fff;
    font-size:calc(15.0px * var(--fs-scale));box-shadow:0 4px 14px rgba(47,127,224,.4)}
  .lptv-btn-main:hover{background:linear-gradient(135deg,#54a8ff,#3d8fe8);
    box-shadow:0 4px 18px rgba(80,160,255,.55)}
  .lptv-btn-main svg{width:19px;height:19px;fill:#fff;stroke:#fff}
  .lptv-btn-txt svg{width:16px;height:16px}
  /* 样式化 hover 提示 (由 title 转 data-tip) */
  .lptv-btn[data-tip]:hover::after{
    content:attr(data-tip);position:absolute;bottom:calc(100% + 11px);left:50%;
    transform:translateX(-50%) translateY(4px);white-space:nowrap;z-index:30;
    background:rgba(16,20,32,.97);color:#e6ecff;font-size:calc(11.5px * var(--fs-scale));font-weight:500;
    letter-spacing:.3px;padding:6px 10px;border-radius:8px;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.55);
    opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
  .lptv-btn[data-tip]:hover::before{
    content:"";position:absolute;bottom:calc(100% + 6px);left:50%;z-index:30;
    transform:translateX(-50%);border:5px solid transparent;border-top-color:rgba(255,255,255,.2);
    opacity:0;transition:opacity .18s}
  .lptv-btn[data-tip]:hover::after{opacity:1;transform:translateX(-50%)}
  .lptv-btn[data-tip]:hover::before{opacity:1}
  /* 顶栏按钮: 位于屏幕顶端, 提示显示在按钮下方 */
  .lptv-tb-btn[data-tip]:hover::after{
    content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:50%;
    transform:translateX(-50%) translateY(-4px);white-space:nowrap;z-index:30;
    background:rgba(16,20,32,.97);color:#e6ecff;font-size:calc(11.5px * var(--fs-scale));font-weight:500;
    letter-spacing:.3px;padding:6px 10px;border-radius:8px;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.55);
    opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
  .lptv-tb-btn[data-tip]:hover::before{
    content:"";position:absolute;top:calc(100% + 3px);left:50%;z-index:30;
    transform:translateX(-50%);border:5px solid transparent;border-bottom-color:rgba(255,255,255,.2);
    opacity:0;transition:opacity .18s}
  .lptv-tb-btn[data-tip]:hover::after{opacity:1;transform:translateX(-50%)}
  .lptv-tb-btn[data-tip]:hover::before{opacity:1}
  .lptv-btn.rec-on,#lptv-b-rec.rec-on{background:rgba(255,77,77,.85);color:#fff}
  #lptv-b-rec.rec-on svg{color:#fff;animation:lptvrec 1.2s ease-in-out infinite}
  #lptv-b-full.on,#lptv-b-float.on{background:rgba(61,155,255,.22);color:#9ccbff}
  #lptv-b-mute .lptv-mute-x{display:none}
  #lptv-b-mute.muted .lptv-waves{display:none}
  #lptv-b-mute.muted .lptv-mute-x{display:block}
  #lptv-c-vol{width:82px;accent-color:var(--acc);cursor:pointer}
  .lptv-chlabel{font-size:calc(12.5px * var(--fs-scale));font-weight:600;color:var(--tx);overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  /* 窄窗口(最小360): 收缩控制栏, 隐藏信息性元素防溢出 */
  @media (max-width:760px){
    #lptv-controls{gap:5px;padding:6px 8px}
    .lptv-ctl-now{display:none}
    #lptv-c-vol{width:56px}
  }
  @media (max-width:560px){
    .lptv-btn-txt{display:none}
    #lptv-b-rec,#lptv-b-shot{display:none}
  }
  /* 流畅模式: 关掉 backdrop-blur/大阴影/呼吸动画, 降低渲染合成开销 */
  /* 流畅模式: 砍掉毛玻璃/阴影/动画/过渡 —— 明显提帧, 且切换后一眼可辨。
     毛玻璃(backdrop-filter)在软渲染下代价最高, 是全屏逐帧重采样, 去掉收益最大。 */
  #lptv-root.perf *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;
    box-shadow:none!important;transition:none!important;animation:none!important}
  #lptv-root.perf .lptv-now-dot{animation:none}
  /* 毛玻璃去掉后半透明底衬会透出画面, 换成高不透明度实色, 观感不变糊 */
  #lptv-root.perf #lptv-controls,#lptv-root.perf #lptv-panel,#lptv-root.perf #lptv-epg,
  #lptv-root.perf #lptv-topbar,#lptv-root.perf #lptv-settings .lptv-modal-card,
  #lptv-root.perf #lptv-floatctl,#lptv-root.perf .lptv-nextch-c{background:rgba(20,23,33,.95)!important}

  /* 上下台预览: 当前台的上一个/下一个 毛玻璃标识 */
  #lptv-nextch{position:absolute;left:50%;bottom:104px;transform:translate(-50%,8px);opacity:0;z-index:9;
    pointer-events:none;transition:opacity .18s,transform .18s;
    background:var(--glass);backdrop-filter:blur(22px) saturate(1.4);
    -webkit-backdrop-filter:blur(22px) saturate(1.4);
    border:1px solid var(--line);border-radius:14px;padding:9px 18px;
    min-width:250px;box-shadow:0 12px 36px rgba(0,0,0,.55)}
  #lptv-nextch.show{opacity:1;transform:translate(-50%,0)}
  #lptv-nextch .lptv-nc-row{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:calc(13.0px * var(--fs-scale));color:var(--tx)}
  #lptv-nextch .lptv-nc-row.dim{color:var(--tx3)}
  #lptv-nextch .lptv-nc-arrow{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;
    justify-content:center;font-size:calc(11.0px * var(--fs-scale));background:rgba(61,155,255,.16);color:#9ccbff;
    flex-shrink:0;font-family:Consolas,monospace}
  #lptv-nextch .lptv-nc-row.hl .lptv-nc-arrow{background:rgba(61,155,255,.5);color:#fff}
  #lptv-nextch .lptv-nc-num{width:28px;color:var(--tx3);font-size:calc(11.0px * var(--fs-scale));font-family:Consolas,monospace;flex-shrink:0}
  #lptv-nextch .lptv-nc-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #lptv-nextch .lptv-nc-sep{height:1px;background:var(--line);margin:3px 0}

  /* 节目录制: 状态角标 (左上角, 闲置也不隐藏) + 控制栏按钮 */
  #lptv-rec-badge{position:absolute;left:14px;top:44px;z-index:11;display:none;
    align-items:center;gap:7px;padding:4px 11px;border-radius:20px;
    background:rgba(20,8,10,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
    border:1px solid rgba(255,77,77,.45);box-shadow:0 4px 18px rgba(0,0,0,.45)}
  #lptv-rec-badge.show{display:flex}
  #lptv-rec-badge .lptv-rec-dot{width:7px;height:7px;border-radius:50%;background:var(--red);
    box-shadow:0 0 8px var(--red);animation:lptvrec 1.2s ease-in-out infinite}
  @keyframes lptvrec{0%,100%{opacity:1}50%{opacity:.25}}
  #lptv-rec-badge #lptv-rec-time{font-size:calc(11.5px * var(--fs-scale));font-weight:600;color:#ffd7d7;
    font-family:Consolas,monospace;letter-spacing:1px}
  /* 截图白闪 */
  #lptv-shot-flash{position:fixed;inset:0;background:#fff;opacity:0;z-index:2147483005;
    pointer-events:none}
  #lptv-shot-flash.go{animation:lptvflash .35s ease-out}
  @keyframes lptvflash{0%{opacity:.85}100%{opacity:0}}

  /* 侧面板: 频道列表(左) / 节目单(右) —— 与 interface-preview.html .panel 一致
     注意: 频道 #lptv-panel 在左侧滑出, 节目单 #lptv-epg 在右侧滑出 (已对调) */
  #lptv-panel,#lptv-epg{position:absolute;top:34px;bottom:0;z-index:5;display:none;
    flex-direction:column;background:var(--glass-2);
    backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);
    border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.5)}
  #lptv-panel.open,#lptv-epg.open{display:flex}

  /* 频道列表: 左侧 (right:0 -> left:0, 反向滑入) */
  #lptv-panel{left:0;width:360px;
    border-left:none;border-right:1px solid var(--line);box-shadow:12px 0 40px rgba(0,0,0,.5)}
  /* 节目单: 右侧 (left:0 -> right:0, 反向滑入) */
  #lptv-epg{right:0;width:400px;
    border-right:none;border-left:1px solid var(--line);box-shadow:-12px 0 40px rgba(0,0,0,.5)}

  .lptv-panel-head,.lptv-epg-head{display:flex;align-items:center;justify-content:space-between;
    padding:13px 14px 8px}
  .lptv-panel-title,.lptv-epg-title{font-size:calc(13.5px * var(--fs-scale));font-weight:650;color:var(--tx)}
  .lptv-panel-cur{display:flex;align-items:center;gap:10px;padding:8px 14px;
    border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:rgba(0,0,0,.22)}
  .lptv-panel-cur-num{font-size:calc(19.0px * var(--fs-scale));font-weight:700;color:var(--acc);line-height:1;font-family:Consolas,monospace;min-width:44px}
  .lptv-panel-cur-name{font-size:calc(13.0px * var(--fs-scale));font-weight:600;color:var(--tx)}
  .lptv-panel-cur-sub{font-size:calc(11.0px * var(--fs-scale));color:var(--tx3);margin-top:2px}
  .lptv-panel-body,.lptv-epg-body{flex:1;overflow-y:auto;padding:0 8px 14px;overscroll-behavior:contain;
    scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
  .lptv-panel-body::-webkit-scrollbar,.lptv-epg-body::-webkit-scrollbar{width:6px}
  .lptv-panel-body::-webkit-scrollbar-track,.lptv-epg-body::-webkit-scrollbar-track{background:transparent}
  .lptv-panel-body::-webkit-scrollbar-thumb,.lptv-epg-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
  .lptv-cat{color:var(--tx3);font-size:calc(11.0px * var(--fs-scale));padding:9px 14px 5px;letter-spacing:1px}
  .lptv-ch{display:flex;align-items:center;gap:8px;padding:6px 8px;margin:0 2px 2px;
    cursor:pointer;color:var(--tx);font-size:calc(12.5px * var(--fs-scale));border-radius:7px;transition:background .12s}
  .lptv-ch:hover{background:rgba(255,255,255,.08);color:#fff}
  .lptv-ch.active{background:rgba(61,155,255,.2);box-shadow:inset 0 0 0 1px rgba(61,155,255,.4)}
  .lptv-ch.focus{outline:1px solid rgba(61,155,255,.65);outline-offset:-1px}
  .lptv-ch .lptv-ch-num{font-size:calc(11.0px * var(--fs-scale));color:var(--tx3);width:28px;flex-shrink:0;font-family:Consolas,monospace;font-variant-numeric:tabular-nums}
  .lptv-ch.active .lptv-ch-num{color:var(--acc)}
  /* 台标: 正方形圆角图, 数字与名称之间 */
  .lptv-ch .lptv-ch-logo{width:22px;height:22px;flex-shrink:0;border-radius:4px;
    background-size:cover;background-position:center;background-color:rgba(255,255,255,.07);
    background-repeat:no-repeat;opacity:.85}
  .lptv-ch .lptv-ch-logo.lptv-ch-logo--loading{opacity:.4}
  .lptv-ch .lptv-ch-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lptv-ch .live-dot{width:5px;height:5px;border-radius:50%;background:#5b6884;flex-shrink:0}
  .lptv-ch.active .live-dot{background:var(--acc2);box-shadow:0 0 6px var(--acc2)}
  /* 收藏星标 */
  .lptv-ch .lptv-ch-fav{flex-shrink:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;
    color:#5b6884;cursor:pointer;border-radius:6px;transition:all .12s}
  .lptv-ch .lptv-ch-fav:hover{color:#ff8fb3;background:rgba(255,107,157,.14)}
  .lptv-ch .lptv-ch-fav.on{color:#ff6b9d}
  .lptv-ch .lptv-ch-fav svg{width:14px;height:14px}
  /* 面板分类 tab */
  #lptv-panel-tabs{display:flex;gap:4px;padding:9px 14px;flex-wrap:wrap}
  .lptv-ptab{display:inline-flex;align-items:center;padding:4px 11px;border-radius:20px;font-size:calc(11.5px * var(--fs-scale));
    color:var(--tx2);cursor:pointer;line-height:1.4;
    background:rgba(255,255,255,.06);border:1px solid transparent;transition:all .12s}
  .lptv-ptab:hover{color:#fff}
  .lptv-ptab.on{color:#b9dcff;background:rgba(61,155,255,.2);border-color:rgba(61,155,255,.45)}
  /* 收藏数徽标: 白底深字 (高对比, 数字清晰), 与标签文字垂直居中对齐 */
  .lptv-ptab b{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;
    margin-left:6px;padding:0 3px;border-radius:999px;background:#fff;color:#0d1226;
    font-size:calc(9.0px * var(--fs-scale));font-weight:800;line-height:1}
  .lptv-panel-empty{padding:30px 20px;text-align:center;color:var(--tx3);font-size:calc(13.0px * var(--fs-scale));line-height:1.7}

  /* 节目单 (右侧): 行样式与 .epg-row 一致 */
  .lptv-epg-sub{font-size:calc(11.0px * var(--fs-scale));color:var(--tx3);margin-top:3px;letter-spacing:1px}
  .lptv-epg-row{display:flex;gap:10px;padding:9px 14px;margin:0;
    color:var(--tx);font-size:calc(12.5px * var(--fs-scale));border-bottom:1px solid rgba(255,255,255,.05);
    transition:background .12s}
  .lptv-epg-row.past{color:var(--tx3)}
  .lptv-epg-row.future{color:var(--tx2)}
  .lptv-epg-row.live{background:rgba(61,155,255,.1);box-shadow:inset 2px 0 0 var(--acc)}
  .lptv-epg-t{font-size:calc(11.0px * var(--fs-scale));color:var(--tx3);width:72px;flex-shrink:0;padding-top:2px;
    font-family:Consolas,monospace;font-variant-numeric:tabular-nums;
    white-space:nowrap;overflow:hidden}
  .lptv-epg-row.live .lptv-epg-t{color:var(--acc)}
  .lptv-epg-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 长节目名悬停气泡 (JS 检测截断后显示) */
  #lptv-name-pop{position:fixed;z-index:2147483010;max-width:420px;padding:8px 12px;
    background:rgba(16,19,28,.94);border:1px solid var(--line);border-radius:8px;
    font-size:calc(12.0px * var(--fs-scale));color:var(--tx);line-height:1.6;pointer-events:none;
    opacity:0;transition:opacity .12s;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #lptv-name-pop.show{opacity:1}
  .lptv-epg-empty{padding:30px 20px;text-align:center;color:var(--tx3);font-size:calc(13.0px * var(--fs-scale))}
  /* 日期切换 tabs: 前后一周, 横向滚动 */
  #lptv-epg-tabs{display:flex;gap:4px;padding:9px 14px;flex-wrap:wrap;
    overflow-x:auto;overflow-y:hidden;scroll-behavior:smooth;scrollbar-width:none;flex-shrink:0}
  #lptv-epg-tabs::-webkit-scrollbar{display:none}
  /* box-sizing:border-box 让 min-width 含内边距; flex:1 1 0 让 5 天均匀铺满一行,
     避免 content-box 下每格 66px×5+gap>332px 导致「后天」换行到第二行 */
  .lptv-epg-tab{flex:1 1 0;min-width:0;box-sizing:border-box;text-align:center;padding:4px 8px;border-radius:8px;font-size:calc(11.5px * var(--fs-scale));color:var(--tx2);
    cursor:pointer;transition:all .12s;white-space:nowrap}
  .lptv-epg-tab i{display:block;font-style:normal;font-size:calc(10.0px * var(--fs-scale));color:var(--tx3);margin-top:1px}
  .lptv-epg-tab.past{opacity:.48}
  .lptv-epg-tab:hover{background:rgba(255,255,255,.08);color:#fff}
  .lptv-epg-tab.on{background:rgba(61,155,255,.2);color:#b9dcff;font-weight:600}
  .lptv-epg-tab.on i{color:#9ccbff}
  /* 行内预约按钮 */
  .lptv-epg-res{flex-shrink:0;padding:3px 10px;border-radius:7px;font-size:calc(11.0px * var(--fs-scale));letter-spacing:1px;
    background:rgba(79,209,197,.14);color:var(--acc2);cursor:pointer;transition:all .12s;
    border:1px solid rgba(79,209,197,.35)}
  .lptv-epg-res:hover{background:rgba(79,209,197,.28);color:#fff}
  .lptv-epg-res.on{background:rgba(255,170,80,.2);color:#ffb36b;border-color:rgba(255,170,80,.45)}
  /* 节目单头部: 预约列表按钮 (始终可见, 免滚动) */
  .lptv-epg-resbtn{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;
    font-size:calc(11.5px * var(--fs-scale));letter-spacing:1px;font-weight:600;color:var(--acc2);cursor:pointer;transition:all .14s;
    background:rgba(79,209,197,.14);border:1px solid rgba(79,209,197,.35)}
  .lptv-epg-resbtn:hover{background:rgba(79,209,197,.28);color:#fff}
  .lptv-epg-resbtn.on{background:rgba(255,170,80,.2);color:#ffb36b;border-color:rgba(255,170,80,.45)}
  .lptv-epg-resbtn b{display:inline-block;min-width:15px;height:15px;line-height:15px;text-align:center;
    border-radius:8px;background:var(--acc2);color:#08202a;font-size:calc(9.0px * var(--fs-scale));font-weight:700;padding:0 4px}
  .lptv-epg-resbtn.on b{background:#ffb36b;color:#2a1a05}
  /* 预约列表行 */
  .lptv-res-row{display:flex;align-items:center;gap:8px;padding:9px 12px;margin:1px 8px 2px;
    border-radius:9px;cursor:pointer;transition:background .12s}
  .lptv-res-row:hover{background:rgba(255,255,255,.08)}
  .lptv-res-main{flex:1;overflow:hidden}
  .lptv-res-ch{display:inline-block;font-size:calc(11.0px * var(--fs-scale));color:#9ccbff;background:rgba(61,155,255,.16);
    padding:1px 7px;border-radius:5px;margin-right:7px;vertical-align:middle}
  .lptv-res-name{font-size:calc(13.0px * var(--fs-scale));color:var(--tx);vertical-align:middle}
  .lptv-res-when{display:block;font-size:calc(11.0px * var(--fs-scale));color:var(--tx3);margin-top:3px;
    font-family:Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lptv-res-when em{font-style:normal;color:#ffb36b}
  .lptv-res-x{flex-shrink:0;width:22px;height:22px;line-height:20px;text-align:center;border-radius:6px;
    color:var(--tx3);font-size:calc(15.0px * var(--fs-scale));cursor:pointer;transition:all .12s}
  .lptv-res-x:hover{background:rgba(255,77,77,.25);color:#ff8f9a}

  /* 设置 / 关于: 统一居中弹窗 (左右布局, 左侧设置/关于两个标签) */
  #lptv-settings{position:fixed;inset:0;z-index:2147483005;display:none;align-items:center;justify-content:center;
    background:rgba(6,8,13,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  #lptv-settings.open{display:flex}
  /* 固定高度 = 内容最多一栏 (播放设置) 的高度, 切标签不跳动; 内部滚动 */
  .lptv-modal-card{position:relative;display:flex;width:560px;max-width:92vw;height:min(444px,86vh);overflow:hidden;
    background:linear-gradient(160deg,rgba(34,40,58,.97),rgba(18,22,34,.97));
    backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5);
    border-radius:16px;border:1px solid var(--line);
    box-shadow:0 30px 90px rgba(0,0,0,.7);color:var(--tx);
    animation:lptv-about-in .22s ease}
  @keyframes lptv-about-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
  .lptv-modal-side{width:128px;flex-shrink:0;display:flex;flex-direction:column;gap:4px;padding:18px 10px;
    background:rgba(255,255,255,.03);border-right:1px solid var(--line)}
  .lptv-side-item{display:flex;align-items:center;gap:9px;padding:10px 13px;border-radius:10px;
    font-size:calc(13.0px * var(--fs-scale));color:var(--tx2);cursor:pointer;transition:all .12s;user-select:none;white-space:nowrap}
  .lptv-side-item svg{width:16px;height:16px;flex-shrink:0}
  .lptv-side-item:hover{background:rgba(255,255,255,.07);color:#fff}
  .lptv-side-item.on{color:#b9dcff;background:rgba(61,155,255,.2)}
  .lptv-modal-main{flex:1;min-width:0;height:100%;overflow-y:auto;padding:20px 22px 14px;position:relative}
  /* flex 居中替代 line-height, 让 ✕ 字形在 26px 方框内光学居中, 不再错位 */
  .lptv-modal-x{position:absolute;top:10px;right:12px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;
    border-radius:6px;color:var(--tx3);font-size:calc(13.0px * var(--fs-scale));line-height:1;cursor:pointer;transition:all .12s;user-select:none}
  .lptv-modal-x:hover{background:rgba(255,255,255,.1);color:#fff}
  .lptv-pane{display:none}
  .lptv-pane.on{display:block}
  /* 设置卡片: 3 个 section, 每块一张卡 */
  .lptv-set-card{border:1px solid var(--line);border-radius:12px;padding:4px 14px 8px;margin-bottom:12px;
    background:rgba(255,255,255,.03)}
  .lptv-set-card-t{font-size:calc(10.5px * var(--fs-scale));color:var(--tx3);letter-spacing:2.5px;padding:9px 0 2px}
  .lptv-set-row{display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:8px 0;font-size:calc(12.5px * var(--fs-scale));color:var(--tx)}
  .lptv-set-row label{display:flex;align-items:center;gap:9px;cursor:pointer}
  .lptv-set-row input[type=checkbox]{accent-color:var(--acc);width:15px;height:15px;cursor:pointer}
  .lptv-set-url{font-size:calc(10.5px * var(--fs-scale));color:var(--tx3);word-break:break-all;max-height:44px;overflow:hidden;line-height:1.45}
  .lptv-link{color:var(--acc);cursor:pointer;font-size:calc(11.5px * var(--fs-scale))}
  .lptv-link:hover{text-decoration:underline}
  /* 保存位置行: 左侧标签+路径, 右侧按钮组 */
  .lptv-set-dir{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 0}
  .lptv-set-dir-l{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .lptv-set-dir-l > span{font-size:calc(12.5px * var(--fs-scale));color:var(--tx)}
  .lptv-set-dir-l .lptv-set-url{margin-top:0}
  .lptv-set-dir-btns{display:flex;gap:10px;flex-shrink:0;justify-content:flex-end;margin-top:5px}
  .lptv-set-dir-btns .lptv-link{white-space:nowrap}
  /* 画面模式: radio 横向选中 (去下拉框) */
  .lptv-fit{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .lptv-fit label{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:calc(12.0px * var(--fs-scale));color:var(--tx2);
    padding:5px 11px;border-radius:8px;border:1px solid var(--line);
    background:rgba(255,255,255,.05);transition:all .12s}
  .lptv-fit label:hover{color:#fff}
  .lptv-fit input{accent-color:var(--acc);cursor:pointer}
  .lptv-fit label:has(input:checked){border-color:rgba(61,155,255,.5);background:rgba(61,155,255,.14);color:#b9dcff}
  /* 快捷键: 一行一个, 名称 + 按键图标 */
  .lptv-kmap{display:flex;flex-direction:column;padding:4px 0}
  .lptv-krow{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:5px 0;font-size:calc(12.0px * var(--fs-scale));color:var(--tx2)}
  .lptv-krow .lptv-kkeys{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
  #lptv-settings kbd{font-family:inherit;font-size:calc(10.5px * var(--fs-scale));color:var(--tx);background:rgba(255,255,255,.09);
    border:1px solid rgba(255,255,255,.16);border-bottom-width:2px;border-radius:5px;
    padding:2px 6px;min-width:16px;text-align:center;line-height:1.4}
  /* 关于: 居中 logo 换行 LPTV 换行版本号 + 一段文字 + 底部 Powered by */
  .lptv-about-pane{text-align:center;padding:10px 6px 6px}
  /* 关于图标: 去掉渐变背景, 直接用透明 PNG 原图 + 柔和投影 */
  .lptv-about-logo{width:76px;height:76px;object-fit:contain;margin:0 auto 16px;
    display:block;filter:drop-shadow(0 8px 24px rgba(61,155,255,.30))}
  .lptv-about-appname{font-size:calc(42.0px * var(--fs-scale));font-weight:800;line-height:1;letter-spacing:.04em;
    background:linear-gradient(120deg,#7fe0ff,#4fd1c5,#ff5fa8);
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .lptv-about-ver{font-size:calc(12.0px * var(--fs-scale));color:var(--tx3);margin-top:10px;font-family:Consolas,monospace}
  .lptv-about-desc{font-size:calc(12.5px * var(--fs-scale));color:var(--tx2);line-height:1.95;margin:20px auto 0;max-width:340px}
  .lptv-about-foot{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);
    font-size:calc(11.0px * var(--fs-scale));color:var(--tx3);letter-spacing:.5px}

  #lptv-toast{position:absolute;left:50%;top:48px;transform:translateX(-50%) translateY(-16px);z-index:9;
    background:rgba(16,19,28,.92);color:var(--tx);padding:8px 16px;border-radius:20px;
    font-size:calc(12.5px * var(--fs-scale));opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;
    border:1px solid var(--line);max-width:72vw;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  #lptv-toast.show{opacity:1;transform:translateX(-50%)}
  #lptv-toast.show._res{pointer-events:auto;cursor:pointer;border-color:rgba(255,170,80,.5)}
  #lptv-toast.show._res::after{content:" · 点击跳转";color:#ffb36b;font-size:calc(11.0px * var(--fs-scale))}

  #lptv-hint{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);z-index:9;
    background:var(--glass);color:var(--tx2);padding:8px 18px;border-radius:20px;
    font-size:calc(12.5px * var(--fs-scale));opacity:0;transition:opacity .3s;pointer-events:none;border:1px solid var(--line)}
  #lptv-hint.show{opacity:1}

  /* 全局滚动条: 隐藏页面/html 自身滚动条, 其余细条毛玻璃质感 */
  html::-webkit-scrollbar, body::-webkit-scrollbar{display:none}
  html, body{scrollbar-width:none}
  #lptv-root{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
  #lptv-root ::-webkit-scrollbar{width:6px;height:6px}
  #lptv-root ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
  #lptv-root ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.3)}
  #lptv-root ::-webkit-scrollbar-track{background:transparent}

  /* 顶部毛玻璃功能区: 拖拽区 + 窗口控制按钮 (与 .topbar 一致) */
  #lptv-topbar{position:absolute;top:0;left:0;right:0;height:42px;z-index:12;
    display:flex;align-items:center;gap:10px;padding:0 6px 0 12px;
    background:linear-gradient(180deg,rgba(10,12,18,.86),rgba(10,12,18,.28));
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border-bottom:1px solid var(--line);
    opacity:0;transform:translateY(-100%);transition:opacity .25s,transform .25s;
    pointer-events:none;color:var(--tx);user-select:none}
  #lptv-topbar.show{opacity:1;transform:none;pointer-events:auto}
  /* 设置「启动时显示顶栏」: 顶栏常显 (含 idle/无 hover 时), 不参与隐藏 */
  #lptv-root.tb-always #lptv-topbar{opacity:1!important;transform:none!important;pointer-events:auto!important}
  #lptv-topbar .lptv-tb-title{display:flex;align-items:center;gap:6px;font-size:calc(12.0px * var(--fs-scale));
    letter-spacing:.5px;color:var(--tx2);white-space:nowrap;overflow:hidden}
  #lptv-topbar .lptv-tb-title b{color:var(--tx);font-weight:650;letter-spacing:.5px}
  #lptv-topbar .lptv-tb-meta{display:flex;align-items:center;gap:6px;font-size:calc(11.5px * var(--fs-scale));
    color:var(--tx2);background:rgba(255,255,255,.06);border:1px solid var(--line);
    border-radius:20px;padding:2px 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #lptv-topbar .lptv-tb-meta .dot{width:6px;height:6px;border-radius:50%;background:var(--ok);
    box-shadow:0 0 6px var(--ok);flex-shrink:0}
  #lptv-topbar .lptv-tb-sp{flex:1}
  #lptv-tb-btns{display:flex;align-items:center;gap:2px;-webkit-app-region:no-drag;flex-shrink:0}
  .lptv-tb-btn{width:38px;height:32px;display:flex;align-items:center;justify-content:center;
    border:none;border-radius:6px;background:transparent;color:var(--tx2);cursor:default;
    transition:background .15s;line-height:0;position:relative}
  .lptv-tb-btn svg{pointer-events:none}
  #lptv-topbar .lptv-tb-logo{width:20px;height:20px;border-radius:4px;object-fit:contain;
    background:rgba(255,255,255,.08);flex-shrink:0}
  .lptv-tb-btn:hover{background:rgba(255,255,255,.12);color:#fff}
  .lptv-tb-btn.close:hover{background:var(--red);color:#fff}
  .lptv-tb-btn.on{color:var(--acc);background:rgba(61,155,255,.16)}
  .lptv-tb-btn.on:hover{color:#9ccbff}

  #lptv-root.idle{cursor:none}
  #lptv-root.idle #lptv-osd,#lptv-root.idle #lptv-vol,#lptv-root.idle #lptv-win-grip{opacity:0;pointer-events:none}
  /* idle 时顶栏半透明常显, 方便用户定位 */
  #lptv-root.idle #lptv-topbar{opacity:.35!important;transform:none!important;pointer-events:auto!important}
  /* 非 idle 时鼠标离开顶部区域后也保持半透明提示 */
  #lptv-topbar.lptv-topbar--dim{opacity:.35!important;transform:none!important;pointer-events:auto!important}
  #lptv-root.idle.ctrl-on{cursor:auto}
  #lptv-root.idle.ctrl-on #lptv-controls{opacity:1;transform:translate(-50%,0);pointer-events:auto}

  /* 小浮窗模式: 隐藏列表/控制栏/OSD, 仅保留悬浮的 上一台/暂停/下一台, 鼠标离开即隐藏 */
  #lptv-root.float #lptv-controls,#lptv-root.float #lptv-panel,#lptv-root.float #lptv-epg,
  #lptv-root.float #lptv-settings,#lptv-root.float #lptv-vol,#lptv-root.float #lptv-osd,
  #lptv-root.float #lptv-nextch,#lptv-root.float #lptv-digit,#lptv-root.float #lptv-rec-badge,
  #lptv-root.float #lptv-win-grip{display:none !important}
  #lptv-floatctl{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);
    display:none;align-items:center;gap:4px;padding:5px;z-index:30;border-radius:10px;
    background:var(--glass);border:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.55);
    backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);
    opacity:0;pointer-events:none;transition:opacity .2s}
  #lptv-root.float #lptv-floatctl{display:flex}
  #lptv-root.float.show-floatctl #lptv-floatctl{opacity:1;pointer-events:auto}
  #lptv-floatctl .lptv-btn{position:static;width:32px;height:32px}
  #lptv-floatctl .lptv-btn-main{width:40px;height:40px}
  #lptv-floatctl .lptv-fc-sep{width:1px;height:18px;background:var(--line);margin:0 3px}

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
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-prev" title="上一台 (↑)"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M18 5l-9 7 9 7z"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-main" id="lptv-b-play" title="暂停/播放 (空格)"><svg id="lptv-b-play-ico" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-next" title="下一台 (↓)"><svg viewBox="0 0 24 24"><path d="M6 5l9 7-9 7z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/></svg></button>' +
      '</div>' +
      '<div class="lptv-ctl-seg lptv-ctl-now" id="lptv-ctl-now">' +
        '<span class="lptv-now-dot"></span>' +
        '<span class="lptv-chlabel" id="lptv-chlabel"></span>' +
        '<span class="lptv-now-sep">·</span>' +
        '<span class="lptv-now-prog" id="lptv-now-prog">正在直播</span>' +
      '</div>' +
      '<div class="lptv-ctl-seg lptv-ctl-vol">' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-mute" title="静音 (M)"><svg id="lptv-b-mute-ico" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="lptv-waves" d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke-width="1.8" stroke-linecap="round"/><path class="lptv-mute-x" d="M16 9l6 6M22 9l-6 6" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg></button>' +
        '<input id="lptv-c-vol" type="range" min="0" max="100" />' +
        '<span class="lptv-vol-txt" id="lptv-c-vol-txt">100</span>' +
      '</div>' +
      '<div class="lptv-ctl-seg">' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-rec" title="录制节目 (R)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-shot" title="截图 (X)"><svg viewBox="0 0 24 24"><path d="M5 7h2l1.5-2h7L17 7h2a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V8a1 1 0 011-1zm7 3a4 4 0 100 8 4 4 0 000-8z" fill="none" stroke-width="1.6"/><circle cx="12" cy="14" r="2.2"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-float" title="小浮窗 (小尺寸并自动置顶)"><svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke-width="1.7"/><rect x="12" y="12" width="7" height="5.2" rx="1" fill="currentColor" stroke="none"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-full" title="全屏 / 退出全屏"><svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '</div>' +
      '<div class="lptv-ctl-seg lptv-ctl-side">' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-epg" title="节目单 (E)"><svg viewBox="0 0 24 24"><path d="M8.5 6h11M8.5 12h11M8.5 18h11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="4.6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-panel" title="频道列表 (S)"><svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.3" y="3.5" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3.5" y="13.3" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.3" y="13.3" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>' +
        '<button class="lptv-btn lptv-btn-ico" id="lptv-b-set" title="设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>' +
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
      '<div class="lptv-modal-card">' +
        '<div class="lptv-modal-side">' +
          '<span class="lptv-side-item on" data-pane="play"><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9 4a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2L16 21h-4l-.4-2.6a7 7 0 01-2-1.2l-2.5 1-2-3.4 2-1.6A7 7 0 017 12a7 7 0 01.1-1.2l-2-1.6 2-3.4 2.4 1a7 7 0 012-1.2L10 3h4l.4 2.6a7 7 0 012 1.2l2.5-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>播放设置</span>' +
          '<span class="lptv-side-item" data-pane="keys"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>快捷键</span>' +
          '<span class="lptv-side-item" data-pane="about"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5M12 7.5v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>关于</span>' +
        '</div>' +
        '<div class="lptv-modal-main">' +
          '<div class="lptv-pane on" id="lptv-pane-play">' +
            '<div class="lptv-set-card"><div class="lptv-set-card-t">播放设置</div>' +
              '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-resume" ' + (cfg.resumeLast !== false ? "checked" : "") + '>启动时恢复上次频道</label></div>' +
              '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-tbalways">启动时显示顶栏（常显）</label></div>' +
              '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-autofs">启动时自动全屏</label></div>' +
              '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-autostart">开机自启动</label></div>' +
              '<div class="lptv-set-row"><label><input type="checkbox" id="lptv-s-perf">流畅模式（降低毛玻璃特效）</label></div>' +
            '</div>' +
            '<div class="lptv-set-card"><div class="lptv-set-card-t">画面</div>' +
              '<div class="lptv-set-row"><span>画面模式</span>' +
                '<div class="lptv-fit" id="lptv-s-fit">' +
                  '<label><input type="radio" name="fit" value="contain"><span>完整画面</span></label>' +
                  '<label><input type="radio" name="fit" value="cover"><span>铺满</span></label>' +
                  '<label><input type="radio" name="fit" value="fill"><span>拉伸</span></label>' +
                '</div></div>' +
              '<div class="lptv-set-dir" data-kind="rec">' +
                '<div class="lptv-set-dir-l"><span>录制</span><div class="lptv-set-url" id="lptv-s-recdir-val" title="">--</div></div>' +
                '<div class="lptv-set-dir-btns"><span class="lptv-link" id="lptv-s-recdir-pick">更改</span><span class="lptv-link" id="lptv-s-recdir-open">打开</span></div>' +
              '</div>' +
              '<div class="lptv-set-dir" data-kind="shot">' +
                '<div class="lptv-set-dir-l"><span>截图</span><div class="lptv-set-url" id="lptv-s-shotdir-val" title="">--</div></div>' +
                '<div class="lptv-set-dir-btns"><span class="lptv-link" id="lptv-s-shotdir-pick">更改</span><span class="lptv-link" id="lptv-s-shotdir-open">打开</span></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="lptv-pane" id="lptv-pane-keys">' +
            '<div class="lptv-set-card"><div class="lptv-set-card-t">快捷键</div><div class="lptv-kmap" id="lptv-s-kmap"></div></div>' +
          '</div>' +
          '<div class="lptv-pane lptv-about-pane" id="lptv-pane-about">' +
            '<img class="lptv-about-logo" id="lptv-about-logo-img" alt="LPTV">' +
            '<div class="lptv-about-appname">LPTV</div>' +
            '<div class="lptv-about-ver" id="lptv-about-ver">版本 --</div>' +
            '<div class="lptv-about-desc">LPTV 是一款为懒猫盒子打造的央视频远程播放客户端，支持频道收藏、节目单预约、录制截图、置顶浮窗。</div>' +
            '<div class="lptv-about-foot">Powered by LightOS · Made for LCMD</div>' +
          '</div>' +
        '</div>' +
        '<span class="lptv-modal-x" id="lptv-set-x" title="关闭">✕</span>' +
      '</div>' });

    // 快捷键清单: 一行一个「名称 + 按键图标」, 填充到 #lptv-s-kmap
    (function () {
      var km = settings.querySelector("#lptv-s-kmap");
      if (!km) return;
      var SC = [
        ["切换频道", ["↑", "↓"]],
        ["音量调节", ["←", "→"]],
        ["播放 / 暂停", ["空格"]],
        ["数字选台", ["0-9"]],
        ["频道列表", ["S"]],
        ["节目单", ["E"]],
        ["静音", ["M"]],
        ["录制节目", ["R"]],
        ["截图", ["X"]],
        ["全屏 / 浮窗", ["F11", "双击"]]
      ];
      km.innerHTML = SC.map(function (r) {
        return '<div class="lptv-krow"><span>' + r[0] + '</span>' +
          '<span class="lptv-kkeys">' + r[1].map(function (k) {
            return '<kbd>' + k + '</kbd>';
          }).join("") + '</span></div>';
      }).join("");
    })();

    var toastEl = el("div", { id: "lptv-toast" });
    var hint = el("div", { id: "lptv-hint" });
    var shotFlash = el("div", { id: "lptv-shot-flash" });
    var namePop = el("div", { id: "lptv-name-pop" });

    // 顶部毛玻璃功能区: 整条可拖拽, 按钮区 no-drag (无边框窗口)
    var topbar = el("div", { id: "lptv-topbar" });
    var LX_ICO = {
      min: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="7.5" width="11" height="1.6" rx="0.8" fill="currentColor"/></svg>',
      pin: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M9.6 1.5l4.9 4.9-1.9.7-3.2 1.2-.4 3.2-2.3-2.3-3.2 3.2-.9-.9 3.2-3.2-2.3-2.3 3.2-.4z" fill="currentColor"/></svg>',
      fs: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 5V2h3L2 5zm12 0L11 2h3v3zM2 11v3h3L2 11zm12 0l-3 3h3v-3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
      max: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
      close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      float: '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="12" y="12" width="7" height="5.2" rx="1" fill="currentColor"/></svg>'
    };
    topbar.innerHTML =
      '<span class="lptv-tb-title"><img class="lptv-tb-logo" src="data:image/png;base64,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" alt=""><b>LPTV</b></span>' +
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
    topbar.querySelector("#lptv-tb-min").innerHTML = LX_ICO.min;
    topbar.querySelector("#lptv-tb-pin").innerHTML = LX_ICO.pin;
    topbar.querySelector("#lptv-tb-fs").innerHTML = LX_ICO.fs;
    topbar.querySelector("#lptv-tb-max").innerHTML = LX_ICO.max;
    topbar.querySelector("#lptv-tb-close").innerHTML = LX_ICO.close;
    topbar.querySelector("#lptv-tb-float").innerHTML = LX_ICO.float;
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
    root.appendChild(toastEl);
    root.appendChild(hint);
    root.appendChild(shotFlash);
    root.appendChild(namePop);
    var floatCtl = el("div", { id: "lptv-floatctl", html:
      '<button class="lptv-btn lptv-btn-ico" id="lptv-fc-prev" title="上一台 (↑)"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M18 5l-9 7 9 7z"/></svg></button>' +
      '<button class="lptv-btn lptv-btn-main" id="lptv-fc-play" title="暂停/播放 (空格)"><svg id="lptv-fc-play-ico" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>' +
      '<button class="lptv-btn lptv-btn-ico" id="lptv-fc-next" title="下一台 (↓)"><svg viewBox="0 0 24 24"><path d="M6 5l9 7-9 7z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/></svg></button>' +
      '<span class="lptv-fc-sep"></span>' +
      '<button class="lptv-btn lptv-btn-ico" id="lptv-fc-exit" title="退出小浮窗"><svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke-width="1.7"/><rect x="12" y="12" width="7" height="5.2" rx="1" fill="currentColor" stroke="none"/><path d="M3 3l18 18" fill="none" stroke-width="1.9" stroke-linecap="round"/></svg></button>' });
    root.appendChild(topbar);
    root.appendChild(floatCtl);
    root.appendChild(el("div", { id: "lptv-win-grip", title: "调整窗口大小" }));
    document.body.appendChild(root);

    // 原生 title 提示 → 样式化 data-tip 悬浮提示 (避免原生气泡遮挡)
    // 覆盖 .lptv-btn (底部/浮窗控制栏) 与 .lptv-tb-btn (顶栏), 保证任何控件
    // 都不残留原生 title, 杜绝「原生气泡 + 自定义气泡」文字重复。
    root.querySelectorAll(".lptv-btn[title],.lptv-tb-btn[title]").forEach(function (b) {
      var t = b.getAttribute("title");
      if (t) { b.setAttribute("data-tip", t); b.removeAttribute("title"); }
    });

    // 运行期更新提示文案: 只写 data-tip, 不再写 title。
    // title 会触发浏览器原生气泡, 与 data-tip 的样式化气泡并存 → 文字重复,
    // 且原生气泡还常被窗口裁剪. 所有状态切换 (录制/静音/全屏/浮窗) 都走这里.
    function setTip(b, text) {
      if (!b) return;
      if (text) { b.setAttribute("data-tip", text); b.removeAttribute("title"); }
    }

    lptv.ui = { root: root, osd: osd, digit: digit, vol: vol,
              controls: controls, nextch: nextch, panel: panel, epg: epg, settings: settings,
              toast: toastEl, hint: hint, topbar: topbar, floatCtl: floatCtl, volRange: range, volRange2: controls.querySelector("#lptv-c-vol"),
              chlabel: controls.querySelector("#lptv-chlabel"),
              spin: spinRoot };

    acquireOfficial();
    bindEvents();
    renderPanel();
    setChLabel();
  }

  function renderPanel() {
    var body = lptv.ui.panel.querySelector("#lptv-panel-body");
    var tabs = lptv.ui.panel.querySelector("#lptv-panel-tabs");
    var filter = lptv._panelFilter || "all";
    var favsOnly = filter === "fav";
    var groups = {};
    var shown = {};
    lptv.channels.forEach(function (c) {
      if (favsOnly && !favHas(c.pid)) return;
      (groups[c.category] = groups[c.category] || []).push(c);
      shown[c.pid] = true;
    });
    var html = "";
    if (favsOnly) {
      // 收藏 tab: 按收藏时间顺序 (cfg.favs 数组序即收藏序)
      var favList = [];
      (cfg.favs || []).forEach(function (pid) {
        var c = lptv.channels.find(function (x) { return x.pid === pid; });
        if (c) favList.push(c);
      });
      html += '<div class="lptv-cat">我的收藏 · ' + favList.length + '</div>';
      if (!favList.length) {
        html += '<div class="lptv-panel-empty">暂无收藏频道<br><span style="font-size:calc(11.0px * var(--fs-scale))">点击频道行的 ♥ 即可收藏</span></div>';
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
    var idx = lptv.channels.indexOf(c) + 1;
    var faved = favHas(c.pid);
    var logoSrc = lptv.logoCache[c.pid] || '';
    return '<div class="lptv-ch' + (faved ? " faved" : "") + '" data-pid="' + c.pid + '">' +
      '<span class="lptv-ch-num">' + String(idx).padStart(2, "0") + "</span>" +
      '<span class="lptv-ch-logo' + (logoSrc ? '' : ' lptv-ch-logo--loading') + '"' +
        (logoSrc ? ' style="background-image:url(' + logoSrc + ')"' : '') + '></span>' +
      '<span class="lptv-ch-name">' + c.name + '</span>' +
      '<span class="lptv-ch-fav' + (faved ? " on" : "") + '" data-pid="' + c.pid + '" title="' +
        (faved ? "取消收藏" : "收藏频道") + '">' + favStarSvg(faved) + '</span>' +
      '<span class="live-dot"></span></div>';
  }

  function favStarSvg(on) {
    /* 收藏图标: 爱心 (原五角星) */
    return '<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" ' +
      (on ? 'fill="currentColor" stroke="none"/>' : 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>');
  }

  function renderPanelTabs() {
    var tabs = lptv.ui.panel.querySelector("#lptv-panel-tabs");
    if (!tabs) return;
    var cur = lptv._panelFilter || "all";
    var favN = (cfg.favs || []).filter(function (pid) {
      return lptv.channels.some(function (c) { return c.pid === pid; });
    }).length;
    var html = '<span class="lptv-ptab' + (cur === "all" ? " on" : "") + '" data-f="all">全部</span>' +
      '<span class="lptv-ptab' + (cur === "fav" ? " on" : "") + '" data-f="fav">收藏' +
      (favN ? '<b>' + favN + '</b>' : "") + '</span>';
    tabs.innerHTML = html;
  }

  function updatePanelCur() {
    var panel = lptv.ui.panel;
    if (!panel) return;
    var num = panel.querySelector(".lptv-panel-cur-num");
    var name = panel.querySelector(".lptv-panel-cur-name");
    if (!num || !name) return;
    var idx = lptv.channels.findIndex(function (c) { return c.pid === lptv.currentPid; });
    num.textContent = idx >= 0 ? String(idx + 1).padStart(2, "0") : "--";
    name.textContent = chNameOf(lptv.currentPid) || "--";
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
    lptv.channels.forEach(function (c) {
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
    lptv.channels.forEach(function (c) { seen[c.official] = true; seen[normChName(c.official)] = true; });
    var added = 0;
    items.forEach(function (it) {
      if (seen[it.txt] || seen[it.nrm] || !it.pid) return;
      seen[it.txt] = true; seen[it.nrm] = true;
      lptv.channels.push({
        name: it.txt, pid: it.pid, cnlid: "", official: it.txt, category: inferCategory(it.txt)
      });
      added++;
    });
    return added;
  }

  function setChLabel() {
    if (lptv.ui.chlabel) lptv.ui.chlabel.textContent = chNameOf(lptv.currentPid);
    updateNowProg();
  }

  /* 控制栏中部: 当前正在播的节目名 (EPG 缓存按当前时间定位) */
  function nowProgOf(pid) {
    var list = (lptv.epg.cache || {})[pid];
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
    el2.textContent = nowProgOf(lptv.currentPid) || "正在直播";
  }

  function showOSD(num, text, sticky) {
    var o = lptv.ui.osd;
    if (!o) return;
    o.querySelector(".lptv-osd-num").innerHTML = "<b>" + (num || "--") + "</b>";
    o.querySelector(".lptv-osd-name").textContent = chNameOf(lptv.currentPid);
    o.querySelector(".lptv-osd-sub").textContent = text || "";
    o.classList.add("show");
    clearTimeout(o._t);
    if (!sticky) o._t = setTimeout(function () { o.classList.remove("show"); }, 3000);
  }

  function showSpin(on) {
    if (lptv.ui.spin) lptv.ui.spin.style.display = on ? "block" : "none";
  }

  var hintTimer = null;
  function showHint(msg) {
    var h = lptv.ui.hint;
    if (!h) return;
    h.textContent = msg;
    h.classList.add("show");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { h.classList.remove("show"); }, 5000);
  }
  function hideHint() {
    if (lptv.ui.hint) lptv.ui.hint.classList.remove("show");
  }

  var toastTimer = null;
  function toast(msg) {
    var t = lptv.ui.toast;
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
    var open = lptv.ui.panel.classList.toggle("open");
    cancelPanelHide();
    lptv._panelIn = false;
    if (open) {
      var act = lptv.ui.panel.querySelector(".lptv-ch.active");
      if (act) act.classList.add("focus");
    }
    return open;
  }

  function hidePanel() {
    cancelPanelHide();
    lptv._panelIn = false;
    lptv.ui.panel.classList.remove("open");
    var pop = document.getElementById("lptv-name-pop");
    if (pop) pop.classList.remove("show");
  }

  /* 右缘滑出频道面板; 指针离开右侧保持区即隐藏 (250ms 快速跟手) */
  function panelPointer(e) {
    if (lptv.devHidden) return;
    var x = e.clientX, y = e.clientY;
    var open = lptv.ui.panel.classList.contains("open");
    if (open) {
      if (x <= PANEL_ZONE) { lptv._panelIn = true; cancelPanelHide(); }
      else if (lptv._panelIn) schedulePanelHide(250);
      return;
    }
    // 关闭后指针仍贴边 -> 冷却, 先离开触发带再允许重新滑出
    if (x <= PANEL_EDGE) {
      if (lptv._panelArmed !== false && y > 46 && !lptv.ui.settings.classList.contains("open")) {
        lptv._panelArmed = false;
        lptv._panelIn = true;
        lptv.ui.panel.classList.add("open");
        markActive();
      }
    } else {
      lptv._panelArmed = true;
    }
  }
  function schedulePanelHide(ms) {
    clearTimeout(lptv._panelHideT);
    lptv._panelHideT = setTimeout(function () {
      lptv._panelIn = false;
      lptv.ui.panel.classList.remove("open");
    }, ms);
  }
  function topbarPointer(e) {
    if (lptv.devHidden) return;
    var tb = document.getElementById("lptv-topbar");
    if (!tb) return;
    // 「启动时显示顶栏」开启: 常显, 不参与 hover 隐藏
    if (lptv.tbAlways) { tb.classList.add("show"); return; }
    tb.classList.add("show");
  }
  function cancelPanelHide() {
    clearTimeout(lptv._panelHideT);
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
      if (lptv.ui.epg && lptv.epg._resView) resRender();
      epgRenderTabs();
    }
  }

  /* 开播提醒: Toast + 可点击跳转 (挂在 lptv-toast 上) */
  function resNotify(r) {
    var t = lptv.ui.toast;
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

  var EPG_DAY_PAST = 2;     // 过去最多 2 天
  var EPG_DAY_FUTURE = 2;   // 未来最多 2 天 (共 5 天: 前2 + 今天 + 后2)

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
    if ((lptv.epg.cache || {})[key]) { if (cb) cb(true); return; }
    lptv.epg._fetching = lptv.epg._fetching || {};
    if (lptv.epg._fetching[key]) return;
    lptv.epg._fetching[key] = 1;
    var x = new XMLHttpRequest();
    x.open("GET", "https://capi.yangshipin.cn/api/yspepg/program/" + pid + "/" + ymd, true);
    x.responseType = "arraybuffer";
    x.onload = function () {
      var has = false;
      try {
        if (x.status >= 200 && x.status < 300) {
          var progs = parseEpg(x.response);
          if (progs.length) { epgStore(pid, progs, ymd); has = true; }
        }
      } catch (e) {}
      lptv.epg.avail = lptv.epg.avail || {};
      lptv.epg.avail[key] = has;  // 官方无数据/404 -> false, 用于隐藏空白日期 tab
      delete lptv.epg._fetching[key];
      epgRenderTabs();
      if (cb) cb(has);
    };
    x.onerror = function () {
      delete lptv.epg._fetching[key];
      if (cb) cb(false);
    };
    x.send();
  }

  /* 探明官方可用日期: 从今天向两侧逐日探到首个无数据即停, 只展示官方真正有数据的日期 */
  function epgProbe(pid) {
    if (!/^\d+$/.test(String(pid))) return;
    lptv.epg._probed = lptv.epg._probed || {};
    if (lptv.epg._probed[pid]) return;
    lptv.epg._probed[pid] = 1;
    [1, -1].forEach(function (dir) {
      var off = dir;
      (function step() {
        if (off > EPG_DAY_FUTURE || off < -EPG_DAY_PAST) return;
        var ymd = epgYmdOf(off);
        var av = (lptv.epg.avail || {})[pid + "|" + ymd];
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
    lptv.epg.cache[key] = programs;
    if (ymd === ymdStr(new Date())) {
      lptv.epg.cache[pid] = programs;  // 兼容旧键 (nowProg 等读当天)
      lptv.epg.last = { pid: pid, n: programs.length, t: Date.now() };
      if (lptv.currentPid === pid) updateNowProg();
    }
    if (lptv.currentPid === pid && lptv.epg._day === (lptv.epg._dayMap || {})[ymd]) epgRender();
  }

  /* EPG 日期偏移: 0=今天, 范围 -2(过去) ~ +2(未来); 面板头部按钮切换 */
  function epgDayOffset() { return lptv.epg._day || 0; }

  function epgYmdOf(off) {
    var d = new Date();
    d.setDate(d.getDate() + (off || 0));
    return ymdStr(d);
  }

  function epgCurList() {
    var key = lptv.currentPid + "|" + epgYmdOf(epgDayOffset());
    return (lptv.epg.cache || {})[key];
  }

  function epgRender() {
    var body = document.getElementById("lptv-epg-body");
    if (!body) return;
    epgRenderTabs();
    if (lptv.epg._resView) { resRender(); return; }
    var pid = lptv.currentPid;
    var chEl = document.getElementById("lptv-epg-ch");
    if (chEl) chEl.textContent = chNameOf(pid);
    var list = epgCurList();
    if (!list || !list.length) {
      var ke = (lptv.epg.avail || {})[pid + "|" + epgYmdOf(epgDayOffset())] === false;
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
    var pid = lptv.currentPid;
    var html = "";
    // 固定 5 天窗口 (前天/昨天/今天/明天/后天): 官方个别日期无数据也只降级为
    // 「当日暂无节目单」, 绝不隐藏日期 tab —— 用户要求恒见 5 天 (前天/后天也要有)。
    for (var off = -EPG_DAY_PAST; off <= EPG_DAY_FUTURE; off++) {
      var d = new Date();
      d.setDate(d.getDate() + off);
      var label = off === 0 ? "今天" : off === 1 ? "明天" : off === -1 ? "昨天" :
        off === -2 ? "前天" : off === 2 ? "后天" :
          "周" + ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
      var cls = "lptv-epg-tab" + (off < 0 ? " past" : "") +
        (off === cur && !lptv.epg._resView ? " on" : "");
      html += '<span class="' + cls + '" data-off="' + off + '">' + label +
        "<i>" + (d.getMonth() + 1) + "/" + d.getDate() + "</i></span>";
    }
    tabs.innerHTML = html;
    // 预约按钮: 徽标数量 + 激活态 (固定右上方, 不受日期滚动影响)
    var rb = document.getElementById("lptv-epg-resbtn");
    if (rb) rb.classList.toggle("on", !!lptv.epg._resView);
    var rbadge = document.getElementById("lptv-epg-resbadge");
    if (rbadge) {
      var n = resLoad().length;
      rbadge.textContent = n ? n : "";
      rbadge.style.display = n ? "" : "none";
    }
    // 选中项滚动到可视区中央 (仅日期变化时, 避免刷新节目时打断手动滚动)
    var key = String(cur);
    if (key !== lptv.epg._tabKey) {
      lptv.epg._tabKey = key;
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
      body.innerHTML = '<div class="lptv-epg-empty">暂无预约<br><span style="font-size:calc(11.0px * var(--fs-scale))">在节目单中选择节目点"预约"即可</span></div>';
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
    if (!lptv.ui.epg || !lptv.ui.epg.classList.contains("open")) return;
    var pid = lptv.currentPid;
    if (!pid) return;
    epgProbe(pid);  // 探明官方可用日期范围, 隐藏空白未来日
    var ymd = epgYmdOf(epgDayOffset());
    if ((lptv.epg.cache || {})[pid + "|" + ymd]) { epgRender(); return; }
    epgFetch(pid, ymd);
  }

  function epgSetDay(off) {
    lptv.epg._day = Math.max(-EPG_DAY_PAST, Math.min(EPG_DAY_FUTURE, off || 0));
    lptv.epg._dayMap = lptv.epg._dayMap || {};
    lptv.epg._dayMap[epgYmdOf(lptv.epg._day)] = lptv.epg._day;
    var dLabel = document.getElementById("lptv-epg-date");
    if (dLabel) {
      var d = new Date();
      d.setDate(d.getDate() + lptv.epg._day);
      dLabel.textContent = epgDateLabel(d);
    }
    epgRender();
    epgSync();
  }

  function openEpg() {
    cancelEpgHide();
    lptv._epgIn = false;
    // 每次打开回到今天+节目单视图 (避免停留在未来日期/预约列表)
    lptv.epg._resView = false;
    if (lptv.epg._day) epgSetDay(0);
    lptv.ui.epg.classList.add("open");
    epgSync();
    return true;
  }
  function hideEpg() {
    cancelEpgHide();
    lptv._epgIn = false;
    lptv.ui.epg.classList.remove("open");
    var pop = document.getElementById("lptv-name-pop");
    if (pop) pop.classList.remove("show");
  }
  function toggleEpg() {
    return lptv.ui.epg.classList.contains("open") ? (hideEpg(), false) : (openEpg(), true);
  }

  /* 右缘滑出节目单; 指针离开右侧保持区即隐藏 (同左缘机制) */
  function epgPointer(e) {
    if (lptv.devHidden) return;
    var x = e.clientX, y = e.clientY;
    var open = lptv.ui.epg.classList.contains("open");
    if (open) {
      if (x >= innerWidth - EPG_ZONE) { lptv._epgIn = true; cancelEpgHide(); }
      else if (lptv._epgIn) scheduleEpgHide(250);
      return;
    }
    if (x >= innerWidth - EPG_EDGE) {
      if (lptv._epgArmed !== false && y > 46 && !lptv.ui.settings.classList.contains("open")) {
        lptv._epgArmed = false;
        lptv._epgIn = true;
        lptv.ui.epg.classList.add("open");
        epgSync();
      }
    } else {
      lptv._epgArmed = true;
    }
  }
  function scheduleEpgHide(ms) {
    clearTimeout(lptv._epgHideT);
    lptv._epgHideT = setTimeout(function () {
      lptv._epgIn = false;
      lptv.ui.epg.classList.remove("open");
    }, ms);
  }
  function cancelEpgHide() {
    clearTimeout(lptv._epgHideT);
  }

  function panelNav(dir) {
    var items = Array.prototype.slice.call(lptv.ui.panel.querySelectorAll(".lptv-ch"));
    if (!items.length) return;
    var cur = lptv.ui.panel.querySelector(".lptv-ch.focus");
    var idx = cur ? items.indexOf(cur) : -1;
    var next = clamp(idx + dir, 0, items.length - 1);
    items.forEach(function (it) { it.classList.remove("focus"); });
    items[next].classList.add("focus");
    items[next].scrollIntoView({ block: "nearest" });
  }
  function panelSelect() {
    var cur = lptv.ui.panel.querySelector(".lptv-ch.focus");
    if (cur) { switchChannel(cur.dataset.pid); hidePanel(); }
  }

  function toggleSettings() {
    var willOpen = !lptv.ui.settings.classList.contains("open");
    lptv.ui.settings.classList.toggle("open");
    if (willOpen) {
      // 每次打开默认回到「播放设置」面板 (左侧标签复位)
      lptv.ui.settings.querySelectorAll(".lptv-side-item").forEach(function (it) {
        it.classList.toggle("on", it.dataset.pane === "play");
      });
      ["play", "keys", "about"].forEach(function (pn) {
        var pp = lptv.ui.settings.querySelector("#lptv-pane-" + pn);
        if (pp) pp.classList.toggle("on", pn === "play");
      });
    }
    var a9 = window.lptv ? window.lptv : null;
    if (a9) {
      // 填充 自动全屏 (来自持久状态)
      var fsBox = document.getElementById("lptv-s-autofs");
      if (fsBox && a9.get_ui_state) a9.get_ui_state().then(function (st) {
        if (st && st.ok && fsBox) fsBox.checked = !!st.autoFullscreen;
        if (st && st.ok) {
          var pf = document.getElementById("lptv-s-perf");
          if (pf) pf.checked = !!st.perfMode;
          var tb = document.getElementById("lptv-s-tbalways");
          if (tb) tb.checked = !!st.topbarAlways;
        }
      });
      // 填充 开机自启动 (来自注册表实际值)
      var stBox = document.getElementById("lptv-s-autostart");
      if (stBox && a9.autostart_state) a9.autostart_state().then(function (r) {
        if (stBox && r) stBox.checked = !!r.enabled;
      });
    }
  }
  function setPerfMode(on) {
    lptv.ui.root.classList.toggle("perf", !!on);
  }
  function setTopbarAlways(on) {
    lptv.tbAlways = !!on;
    lptv.ui.root.classList.toggle("tb-always", lptv.tbAlways);
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

  function recApi() { return window.lptv ? window.lptv : null; }

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
    var root = lptv.ui.root, btn = document.getElementById("lptv-b-rec");
    var badge = document.getElementById("lptv-rec-badge");
    if (root) root.classList.toggle("recording", on);
    if (btn) {
      btn.classList.toggle("rec-on", on);
      setTip(btn, on ? "停止录制 (R)" : "录制节目 (R)");
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
    var v = lptv.video;
    if (!v || !v.videoWidth) { toast("画面尚未就绪，稍后再录"); return; }
    if (!recSupported()) { toast("当前环境不支持录制"); return; }
    if (!document.hasFocus()) { toast("仅前台可录制 · 请先点击本应用窗口"); return; }
    if (Rec.on) return;
    var api = recApi();
    if (!api || !api.rec_open) { toast("录制桥不可用"); return; }
    dbg("rec: start v=" + (v === (lptv._dbgLastV || null) ? "same" : "new"));

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
      Rec.mr = new MediaRecorder(cs, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
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

    api.rec_open(chNameOf(lptv.currentPid) || "直播").then(function (r) {
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
    var v = lptv.video;
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
    var v = lptv.video;
    if (!v || !v.videoWidth) { toast("画面尚未就绪"); return; }
    try {
      var c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      var x = c.getContext("2d");
      x.drawImage(v, 0, 0, c.width, c.height);
      var data = c.toDataURL("image/png");
      var api = recApi();
      if (!api || !api.shot_save) { toast("截图桥不可用"); return; }
      api.shot_save(chNameOf(lptv.currentPid) || "直播", String(data).split(",")[1] || "").then(function (r) {
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
    if (lptv.devHidden) return;
    lptv.ui.root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      lptv.ui.root.classList.add("idle");
    }, cfg.autoHide);
  }

  /* 控制栏+设置面板: 指针在底部区域时显示, 离开底部区域即隐藏 */
  function showControls() {
    cancelHideControls();
    lptv.ui.controls.classList.add("show");
    lptv.ui.root.classList.add("ctrl-on");
  }
  function scheduleHideControls() {
    clearTimeout(ctrlTimer);
    ctrlTimer = setTimeout(function () {
      lptv.ui.controls.classList.remove("show");
      lptv.ui.root.classList.remove("ctrl-on");
      // 设置弹窗不再随底部区域离开自动隐藏: 只允许点 ✕ 关闭 (用户需求)
    }, 900);
  }
  function cancelHideControls() {
    clearTimeout(ctrlTimer);
  }

  /* 小浮窗: 悬浮控制条 鼠标移动时出现, 离开窗口或 1.6s 无操作即隐藏 */
  var floatCtlTimer = null;
  function showFloatCtl() {
    if (!lptv.ui.root.classList.contains("float")) return;
    lptv.ui.root.classList.add("show-floatctl");
    clearTimeout(floatCtlTimer);
    floatCtlTimer = setTimeout(function () {
      lptv.ui.root.classList.remove("show-floatctl");
    }, 1600);
  }
  function hideFloatCtl() {
    clearTimeout(floatCtlTimer);
    if (lptv.ui.root) lptv.ui.root.classList.remove("show-floatctl");
  }

  /* 顶栏窗口按钮 (无边框窗口) */
  function bindTopbar() {
    function wvApi() { return window.lptv ? window.lptv : null; }
    function setMaxIcon(isMax) {
      var b = document.getElementById("lptv-tb-max");
      if (b) b.innerHTML = isMax
        ? '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 3h6.5a1 1 0 0 1 1 1V11" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
        : '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
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
    // 无边框窗口拖动：按住标题区移动鼠标 → bridge.move_win（容器无 WM，
    // pywebview easy_drag / _NET_WM_MOVERESIZE 都不可用，只能 JS 拖动）。
    // 拖拽面：整条 topbar（不含按钮），按钮区 no-drag。
    (function () {
      var tb = document.querySelector("#lptv-topbar");
      var dragging = false, sx = 0, sy = 0, wx = 0, wy = 0, posReady = false;
      tb.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        if (e.target.closest && e.target.closest("#lptv-tb-btns, .lptv-tb-btn")) return;
        dragging = true; posReady = false; sx = e.screenX; sy = e.screenY;
        var api = wvApi();
        if (api && api.win_pos) {
          api.win_pos().then(function (r) {
            if (r && r.ok) { wx = r.x; wy = r.y; }
            posReady = true;
          });
        } else { posReady = true; }
        e.preventDefault();
      });
      window.addEventListener("mousemove", function (e) {
        if (!dragging || !posReady) return;
        var dx = e.screenX - sx, dy = e.screenY - sy;
        var api = wvApi();
        if (api && api.move_win) api.move_win(wx + dx, wy + dy);
      });
      window.addEventListener("mouseup", function () { dragging = false; });
    })();
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
    var a = window.lptv ? window.lptv : null;
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
      setTip(b, full ? "退出全屏 (F11/双击)" : "全屏 (F11/双击)");
    }
    var t = document.getElementById("lptv-tb-fs");
    if (t) t.classList.toggle("on", !!full);
  }
  function pollFullState() {
    var a = window.lptv ? window.lptv : null;
    if (a && a.is_fullscreen) a.is_fullscreen().then(function (r) { setFullIcon(r && r.fullscreen); }).catch(function () {});
  }

  /* 小浮窗切换 (小尺寸并自动置顶); 与置顶按钮状态互通 */
  function floatToggle() {
    var a = window.lptv ? window.lptv : null;
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
    if (b) { b.classList.toggle("on", f); setTip(b, f ? "退出小浮窗" : "小浮窗 (小尺寸并自动置顶)"); }
    var t = document.getElementById("lptv-tb-float");
    if (t) t.classList.toggle("on", f);
    var root = lptv.ui && lptv.ui.root;
    if (root) {
      var was = root.classList.contains("float");
      root.classList.toggle("float", f);
      if (f && !was) showFloatCtl();
      if (!f && was) hideFloatCtl();
    }
    if (f) syncPlayBtn();
  }
  function pollFloatState() {
    var a = window.lptv ? window.lptv : null;
    if (a && a.is_float) a.is_float().then(function (r) { setFloatIcon(r && r.floating); }).catch(function () {});
  }

  function togglePlay() {
    var v = lptv.video;
    if (!v) return;
    if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); }
    else { v.pause(); lptv._autoplayPending = false; }
    syncPlayBtn();
  }
  function syncPlayBtn() {
    var b = document.getElementById("lptv-b-play-ico");
    var fc = document.getElementById("lptv-fc-play-ico");
    var ico = lptv.video && lptv.video.paused
      ? '<path d="M8 5l12 7-12 7z"/>'
      : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
    if (b && lptv.video) b.innerHTML = ico;
    if (fc && lptv.video) fc.innerHTML = ico;
  }

  function setVolume(v) {
    v = clamp(v, 0, 1);
    cfg.volume = v; cfg.muted = false;
    if (lptv.video) { lptv.video.volume = v; lptv.video.muted = false; }
    if (lptv.ui.volRange) lptv.ui.volRange.value = Math.round(v * 100);
    if (lptv.ui.volRange2) lptv.ui.volRange2.value = Math.round(v * 100);
    fillRange(lptv.ui.volRange2);
    syncMuteBtn(); saveCfg();
    var vn = document.getElementById("lptv-vol-num");
    if (vn) vn.textContent = Math.round(v * 100);
    var vt = document.getElementById("lptv-c-vol-txt");
    if (vt) vt.textContent = Math.round(v * 100);
    lptv.ui.vol.classList.add("show");
    clearTimeout(lptv.ui.vol._t);
    lptv.ui.vol._t = setTimeout(function () { lptv.ui.vol.classList.remove("show"); }, 1600);
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
    if (lptv.video) lptv.video.muted = cfg.muted;
    if (!cfg.muted && cfg.volume === 0) setVolume(0.6);
    syncMuteBtn(); saveCfg(); hideHint();
  }
  function syncMuteBtn() {
    var b = document.getElementById("lptv-b-mute");
    if (b) {
      b.classList.toggle("muted", !!cfg.muted);
      setTip(b, cfg.muted ? "取消静音 (M)" : "静音 (M)");
    }
  }

  function handleDigit(d) {
    lptv.digits += d;
    lptv.ui.digit.textContent = lptv.digits;
    lptv.ui.digit.classList.add("show");
    clearTimeout(lptv._digitT);
    if (lptv.digits.length >= 3) commitDigits();
    else lptv._digitT = setTimeout(commitDigits, 900);
  }
  function commitDigits() {
    var n = parseInt(lptv.digits, 10);
    lptv.digits = "";
    lptv.ui.digit.classList.remove("show");
    if (n >= 1 && n <= lptv.channels.length) switchChannel(lptv.channels[n - 1].pid);
    else toast("没有频道 " + n);
  }

  function devToggle() {
    lptv.devHidden = !lptv.devHidden;
    lptv.ui.root.classList.toggle("dev-hidden", lptv.devHidden);
    toast(lptv.devHidden ? "已隐藏 LPTV 界面（Ctrl+D 恢复）" : "已恢复 LPTV 界面");
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
    var root = lptv.ui.root;

    root.addEventListener("mousemove", function (e) {
      wake();
      panelPointer(e);
      epgPointer(e);
      topbarPointer(e);
      showFloatCtl();
      // 鼠标离开顶部区域: idle 时半透明, 非 idle 时加 dim 类半透明
      if (!lptv.tbAlways && e.clientY > 56) {
        var tb2 = document.getElementById("lptv-topbar");
        if (tb2) {
          tb2.classList.remove("show");
          if (!lptv.ui.root.classList.contains("idle")) tb2.classList.add("lptv-topbar--dim");
        }
      } else if (e.clientY <= 56) {
        var tb3 = document.getElementById("lptv-topbar");
        if (tb3) tb3.classList.remove("lptv-topbar--dim");
      }
      if (e.clientY >= innerHeight - CTRL_ZONE) showControls();
      else scheduleHideControls();
    });
    /* 指针离开窗口: 已"进入过区域"的滑窗立即隐藏 (不等延迟) */
    document.addEventListener("mouseout", function (e) {
      if (!e.relatedTarget && !e.toElement) {
        if (lptv._panelIn) schedulePanelHide(0);
        if (lptv._epgIn) scheduleEpgHide(0);
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
        var inDrawer = _tsTarget && _tsTarget.closest && _tsTarget.closest("#lptv-panel,#lptv-epg,#lptv-settings,#lptv-controls,#lptv-topbar");
        // 右缘 -> 频道抽屉
        if (!inDrawer && (_tsX >= innerWidth - 60) && (dx < -30 || tap)) {
          e.preventDefault();
          if (!lptv.ui.panel.classList.contains("open")) togglePanel();
          return;
        }
        // 左缘 -> 节目单抽屉
        if (!inDrawer && (_tsX <= 60) && (dx > 30 || tap)) {
          e.preventDefault();
          if (!lptv.ui.epg.classList.contains("open")) toggleEpg();
          return;
        }
        // 抽屉打开时点外部关闭
        if (!inDrawer && tap) {
          if (lptv.ui.panel.classList.contains("open")) { hidePanel(); return; }
          if (lptv.ui.epg.classList.contains("open")) { hideEpg(); return; }
          // 设置弹窗只允许点 ✕ 关闭, 点外部不再关闭
          // 点画面: 切换控制栏显隐
          if (lptv.ui.controls.classList.contains("show")) { lptv.ui.root.classList.remove("ctrl-on"); lptv.ui.controls.classList.remove("show"); }
          else showControls();
        }
      }, { passive: false });
    }

    /* ---- 长按画面拖动窗口 (无边框) ----
     * 除了顶栏，播放器区域也支持拖拽：按住 ~350ms 不松手即进入拖拽态，随后
     * 移动就 move_win。短按释放不进入拖拽态，因此不干扰单击(控制栏显隐)/
     * 双击(全屏) 手势。拖拽发生过的释放会置 lptv._longDrag，由 click 处理器消费，
     * 避免拖完的 click 被误判成"双击第二击"触发全屏。 */
    (function () {
      var r = lptv.ui.root;
      var holdT = null, hx = 0, hy = 0;
      var dragging = false, moved = false, sx = 0, sy = 0, wx = 0, wy = 0, posReady = false;
      function api() { return window.lptv ? window.lptv : null; }
      function endDrag() {
        if (dragging && moved) {
          lptv._longDrag = true;
          setTimeout(function () { lptv._longDrag = false; }, 500);
        }
        clearTimeout(holdT); holdT = null;
        dragging = false; moved = false; posReady = false;
      }
      r.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        var t = e.target;
        // UI 控件/抽屉/输入框不参与长按拖拽 (与顶栏拖拽的豁免区一致)
        if (t && t.closest && t.closest(DRAG_GUARD_SEL)) return;
        hx = e.screenX; hy = e.screenY; moved = false;
        clearTimeout(holdT);
        holdT = setTimeout(function () {
          dragging = true; sx = hx; sy = hy; posReady = false;
          var a = api();
          if (a && a.win_pos) {
            a.win_pos().then(function (res) {
              if (res && res.ok) { wx = res.x; wy = res.y; }
              posReady = true;
            });
          } else { posReady = true; }
          wake();
        }, 350);
      });
      window.addEventListener("mousemove", function (e) {
        // 长按计时内鼠标快速移动 -> 取消本次长按 (这是单击/双击, 非拖拽)
        if (holdT && (Math.abs(e.screenX - hx) > 6 || Math.abs(e.screenY - hy) > 6)) {
          clearTimeout(holdT); holdT = null;
        }
        if (!dragging || !posReady) return;
        if (Math.abs(e.screenX - sx) + Math.abs(e.screenY - sy) > 3) moved = true;
        var a = api();
        if (a && a.move_win) a.move_win(wx + (e.screenX - sx), wy + (e.screenY - sy));
      });
      window.addEventListener("mouseup", endDrag);
      window.addEventListener("blur", endDrag);
    })();

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
      setVolume((lptv.video ? lptv.video.volume : cfg.volume) + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
    lptv.ui.controls.addEventListener("mouseenter", cancelHideControls);
    lptv.ui.controls.addEventListener("mouseleave", scheduleHideControls);
    lptv.ui.settings.addEventListener("mouseenter", cancelHideControls);
    // 设置弹窗移开不自动关闭 (只允许点 ✕), 故不绑定 mouseleave -> scheduleHideControls

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
      lptv._panelFilter = t.dataset.f;
      renderPanel();
    });

    // EPG: 日期 tab 切换 + 行内预约开关 (预约列表入口在面板右上角按钮)
    document.getElementById("lptv-epg-tabs").addEventListener("click", function (e) {
      var t = e.target.closest(".lptv-epg-tab");
      if (!t) return;
      lptv.epg._resView = false;
      epgSetDay(parseInt(t.dataset.off, 10) || 0);
    });
    var epgResBtn = document.getElementById("lptv-epg-resbtn");
    if (epgResBtn) epgResBtn.addEventListener("click", function () {
      lptv.epg._resView = !lptv.epg._resView;
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
        var p = ((lptv.epg.cache || {})[key] || []).find(function (x) { return x.s0 === s0; });
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
    lptv.ui.toast.addEventListener("click", function () {
      var pid = lptv.ui.toast._res;
      if (pid) {
        lptv.ui.toast._resClicked = true;
        switchChannel(pid);
        lptv.ui.toast.classList.remove("show");
        lptv.ui.toast._res = null;
        clearTimeout(lptv.ui.toast._resJump);
      }
    });
    bindTopbar();
    wake();

    // 双击画面 全屏/窗口 切换; 单击不再触发暂停 (空格键暂停/播放)
    var lastTap = 0;
    root.addEventListener("click", function (e) {
      // 长按拖拽窗口后的这次 click 属于拖动产物, 忽略, 防止误判成"双击第二击"全屏
      if (lptv._longDrag) { lptv._longDrag = false; return; }
      var t = e.target;
      if (t.closest && t.closest("#lptv-controls,#lptv-nextch,#lptv-panel,#lptv-epg,#lptv-settings,#lptv-toast,#lptv-hint,#lptv-osd,#lptv-vol,#lptv-digit,#lptv-topbar,#lptv-win-grip,#lptv-rec-badge")) return;
      var now = Date.now();
      if (now - lastTap < 350) {
        lastTap = 0;
        var a = window.lptv ? window.lptv : null;
        if (a && a.fullscreen_toggle) fullToggle();
        else if (document.documentElement.requestFullscreen) {
          var df = document.documentElement.requestFullscreen();
          if (df && df.catch) df.catch(function () {});
        }
      } else {
        lastTap = now;
      }
    });

    lptv.ui.volRange.addEventListener("input", function () { setVolume(this.value / 100); });
    lptv.ui.volRange2.addEventListener("input", function () { setVolume(this.value / 100); });

    lptv.ui.controls.addEventListener("click", function (e) {
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

    if (lptv.ui.floatCtl) {
      lptv.ui.floatCtl.addEventListener("click", function (e) {
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

    lptv.ui.settings.addEventListener("change", function (e) {
      var t = e.target;
      if (t.id === "lptv-s-resume") { cfg.resumeLast = t.checked; pyStatePush({ resumeLast: t.checked }); }
      if (t.id === "lptv-s-autofs") { pyStatePush({ autoFullscreen: t.checked }); }
      if (t.id === "lptv-s-autostart") {
        var a9 = window.lptv ? window.lptv : null;
        if (a9 && a9.autostart_set) {
          a9.autostart_set(t.checked).then(function (r) {
            if (r && !r.ok) { t.checked = !t.checked; toast("自启动设置失败"); }
            else toast(t.checked ? "已开启开机自启动" : "已关闭开机自启动");
          });
        }
      }
      if (t.name === "fit") { cfg.fit = t.value; styleOfficial(); pyStatePush({ fit: t.value }); }
      if (t.id === "lptv-s-perf") {
        setPerfMode(t.checked); pyStatePush({ perfMode: t.checked });
        toast(t.checked ? "已开启流畅模式 (特效已降低)" : "已关闭流畅模式");
      }
      if (t.id === "lptv-s-tbalways") {
        setTopbarAlways(t.checked); pyStatePush({ topbarAlways: t.checked });
        toast(t.checked ? "顶栏已常显" : "顶栏改为悬停显示");
      }
      saveCfg();
    });

    /* 保存位置: 更改/打开 (录制与截图各自独立) */
    function dirShow(kind, dir) {
      var el2 = document.getElementById(kind === "rec" ? "lptv-s-recdir-val" : "lptv-s-shotdir-val");
      if (el2) { el2.textContent = dir || "--"; el2.title = dir || ""; }
    }
    function dirRefresh() {
      var a3 = window.lptv ? window.lptv : null;
      if (a3 && a3.get_save_dirs) a3.get_save_dirs().then(function (r) {
        if (r && r.ok) { dirShow("rec", r.rec); dirShow("shot", r.shot); }
      });
    }
    lptv.ui.settings.addEventListener("click", function (e) {
      /* 左侧标签切换 设置/关于; 关闭按钮/遮罩关闭弹窗 */
      var tab = e.target.closest(".lptv-side-item[data-pane]");
      if (tab) {
        var want = tab.dataset.pane;
        lptv.ui.settings.querySelectorAll(".lptv-side-item").forEach(function (it) {
          it.classList.toggle("on", it === tab);
        });
        ["play", "keys", "about"].forEach(function (pn) {
          var pp = lptv.ui.settings.querySelector("#lptv-pane-" + pn);
          if (pp) pp.classList.toggle("on", pn === want);
        });
        if (want === "about") loadAbout();
        return;
      }
      // 只允许点击关闭按钮 (✕) 关闭弹窗; 点遮罩/外部不再关闭
      if (e.target.id === "lptv-set-x") {
        lptv.ui.settings.classList.remove("open");
        return;
      }
      var id = e.target.id, kind = "";
      if (id === "lptv-s-recdir-pick" || id === "lptv-s-shotdir-pick") kind = id.indexOf("recdir") > 0 ? "rec" : "shot";
      else if (id === "lptv-s-recdir-open" || id === "lptv-s-shotdir-open") {
        kind = id.indexOf("recdir") > 0 ? "rec" : "shot";
        var a1 = window.lptv ? window.lptv : null;
        if (a1 && a1.open_save_dir) a1.open_save_dir(kind);
        return;
      } else return;
      var a2 = window.lptv ? window.lptv : null;
      if (!a2 || !a2.pick_save_dir) { toast("桥不可用"); return; }
      a2.pick_save_dir(kind).then(function (r) {
        if (r && r.ok) { dirShow(kind, r.dir); toast("保存位置已更改: " + r.dir); }
      });
    });
    setInterval(dirRefresh, 5000);

    /* 关于面板: 切换到时经桥异步填 logo 与版本号 */
    function loadAbout() {
      var a = window.lptv ? window.lptv : null;
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

    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); devToggle(); return; }
      if (lptv.devHidden) return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var panelOpen = lptv.ui.panel.classList.contains("open");
      var k = e.key;
      // 全部消费掉: 阻止官方 SPA 收到 空格/方向键/数字 等触发其内部行为
      if (/^[0-9]$/.test(k)) { e.preventDefault(); e.stopPropagation(); handleDigit(k); }
      else if (k === "ArrowUp") { e.preventDefault(); e.stopPropagation(); panelOpen ? panelNav(-1) : chanKey(-1); }
      else if (k === "ArrowDown") { e.preventDefault(); e.stopPropagation(); panelOpen ? panelNav(1) : chanKey(1); }
      else if (k === "PageUp") { e.preventDefault(); e.stopPropagation(); chanKey(-1); }
      else if (k === "PageDown") { e.preventDefault(); e.stopPropagation(); chanKey(1); }
      else if (k === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setVolume((lptv.video ? lptv.video.volume : cfg.volume) - 0.05); }
      else if (k === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setVolume((lptv.video ? lptv.video.volume : cfg.volume) + 0.05); }
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
      else if (k === "Escape") { hidePanel(); hideEpg(); }  // 设置弹窗只允许点 ✕ 关闭
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
          var a = window.lptv ? window.lptv : null;
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

  lptv.setChannels = function (channels) {
    lptv.channels = channels.map(function (c) {
      // 保留已由摘要收割校正过的 official (官网按钮文字), 没有才从名称推导
      var official = c.official || c.name.split(" ")[0].replace("CCTV-", "CCTV");
      return Object.assign({}, c, { official: official });
    }).filter(function (c) {
      // VIP/限免/付费台不显示
      return c.category !== "付费" && !isPayChannel(c.official || "") && !isPayChannel(c.name || "");
    });
    renderPanel(); setChLabel();
    // 预取所有台标, 填充 logoCache, 下一次 renderPanel 即可直接展示
    (function preloadLogos() {
      var api = window.lptv;
      if (!api || !api.get_asset_image) return;
      lptv.channels.forEach(function (c) {
        if (lptv.logoCache[c.pid]) return;
        api.get_asset_image(c.pid + '.webp', 'logos').then(function (r) {
          if (r && r.ok && r.src) lptv.logoCache[c.pid] = r.src;
        }).catch(function () {});
      });
    })();
  };

  lptv.switchChannel = function (pid) { switchChannel(pid); };
  lptv.getPlayUrl = function () {
    if (lptv.playUrl) return lptv.playUrl;
    if (lptv.currentHls && lptv.currentHls.url) return lptv.currentHls.url;
    var src = lptv.video && lptv.video.currentSrc;
    return src && src.indexOf("http") === 0 ? src : "";
  };
  lptv.toast = toast;
  lptv.resTick = resTick;   // E2E/测试可手动触发预约扫描
  lptv.recToggle = recToggle;   // E2E/外壳可编程触发录制
  lptv.recState = function () {
    return { on: Rec.on, rid: Rec.rid, bytes: Rec.bytes, frames: Rec.frames,
             ac: !!Rec.ac, src: !!Rec.srcNode, mime: (Rec.mr && Rec.mr.mimeType) || "",
             appends: Rec._appends || 0, written: Rec._written || 0, appendErr: Rec._appendErr || "" };
  };

  /* ================= 启动 ================= */

  function initChannels(retries) {
    retries = retries || 0;
    if (window.lptv && window.lptv.get_channels) {
      window.lptv.get_channels().then(function (chs) {
        lptv.setChannels(chs);
        var m = location.href.match(/pid=(\d+)/);
        var urlPid = m ? m[1] : "";
        lptv.currentPid = urlPid || (chs[0] && chs[0].pid || "");
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
              // 流畅模式: 关掉毛玻璃特效降低渲染开销
              if (typeof st.perfMode === "boolean") setPerfMode(st.perfMode);
              // 启动时显示顶栏: 常显顶栏 (去勾选为悬停显示)
              if (typeof st.topbarAlways === "boolean") setTopbarAlways(st.topbarAlways);
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
        dbg("channels=" + chs.length + " cur=" + lptv.currentPid);
        // 收割官方侧栏: 官方频道渲染晚于 SPA, 重试直到稳定拿到全量
        var lastN = -1, stable = 0, tries = 0;
        var h = setInterval(function () {
          tries++;
          var cont = document.querySelector(".tv-main-con-r-list-left");
          var cnt = cont ? cont.children.length : 0;
          var added = harvestOfficial();
          if (added > 0) {
            renderPanel(); markActive(); setChLabel();
            dbg("harvest +" + added + " n=" + lptv.channels.length);
          }
          if (cnt >= 30) {
            if (lptv.channels.length === lastN) stable++;
            else stable = 0;
            lastN = lptv.channels.length;
            if (stable >= 2 || tries > 20) {
              clearInterval(h);
              dbg("harvest done n=" + lptv.channels.length);
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

  /* 按窗口宽度动态调整字体/控件缩放比 (基准 1280px = scale 1, 最大 1.5x) */
  function applyFsScale() {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    var w = window.innerWidth || document.documentElement.clientWidth || 1280;
    var s = Math.max(0.85, Math.min(1.5, w / 1280));
    root.style.setProperty('--fs-scale', s.toFixed(3));
  }
  window.addEventListener('resize', applyFsScale);

  function boot() {
    applyFsScale();
    installHlsHooks();
    installDragGuard();
    buildUI();
    applyFsScale();
    setQuality();
    syncFit();
    initChannels();
    // 兜底: 卡在加载(黑屏)时也淡出启动黑幕, 露出 OSD/提示
    setTimeout(removeBootmask, 15000);
    if (lptv.video && !lptv.video.paused) showOSD("00", "正在接入直播…", true);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(boot, 100);
  } else {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 100); });
  }

  lptv.boot = boot;
})();