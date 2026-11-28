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
    fit: "cover",            // contain: 完整画面(黑边) | cover: 铺满(裁剪) | fill: 拉伸铺满(变形不裁切)
                             // 默认 cover：智慧屏/桌面全屏均铺满无黑边（用户可在设置改回"完整画面"）
    blackRecovery: true,     // 黑帧自动恢复 (恒开, 不再提供开关)
    autoHide: 3500,
    resumeLast: true,        // 启动恢复最后播放频道
    autoPlayOnLaunch: false, // 启动自动播放上次频道
    clickFullscreen: false,  // 点击频道默认全屏播放
    epgBooks: {},            // 节目预约: key = pid|ymd|s0
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
    epg: { cache: {} },
    _dbg: [],
    ui: {}
  };

  var cfg = loadCfg();
  if (!cfg.epgBooks || typeof cfg.epgBooks !== "object") cfg.epgBooks = {};
  // 迁移: 旧版自动播放策略兜底会把 muted=true 写进配置, 导致之后每次启动/切台
  // 都默认静音 (智慧屏反馈)。升级到本版本时清除一次; 用户若确实要静音再按 M。
  if ((cfg._v || 0) < 4) {
    cfg._v = 4;
    if (cfg.muted) cfg.muted = false;
    saveCfg();
  }

  /* 启动黑幕: 兜底在壳层 show() 之前页面已渲染时, 也不闪出官方页;
     官方画面开始播放后自动淡出 */
  try { if (document.body) bootmask(); } catch (e) {}
  // 深色底衬尽早建: 启动黑幕/启动动画淡出时官方页可能仍是白色加载背景,
  // 底衬(z 2147483000)盖住 → 淡出直接露深色而非白闪。APK(iframe 模型)跳过
  // (早期 iframe 未解析, 用 __lptvBridge 判 APK), 否则会盖住 iframe 视频。
  try { if (!window.__lptvBridge && document.documentElement) ensureCover(); } catch (e) {}

  function loadCfg() {
    var c;
    try {
      c = Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(LS_KEY) || "{}"));
    } catch (e) { c = Object.assign({}, DEFAULT_CFG); }
    // 智慧屏默认铺满（无黑边）：旧的 contain 只是历史默认值，非用户显式选择，
    // 迁移到 cover（尊重 fill/cover 显式选择）。桌面保持用户原设置。
    if (isTv() && c.fit === "contain") c.fit = "cover";
    return c;
  }
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
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
    // 入口=首页且未开自动播放时，官方 TV 首页也会自动起播默认频道(实测 CCTV-1)。
    // 此时不要把它记成"当前频道"(否则首页出现"正在播放"焦点)，也不更新 lastPid；
    // 用户点卡片后 switchChannel 会清掉该标记并正常起播。
    if (lptv._suppressAutoplay && uiState === "home") {
      dbg("startup pu suppressed pid=" + pid);
      return;
    }
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
    if (url === lptv.playUrl) return;
    lptv.playUrl = url;
    lptv._loadedPid = pid || lptv._loadedPid;
    dbg("pu:" + url.slice(0, 30));
    // 换流地址已确认变化 → 交给切台状态机按“视频真正可播”收尾。
    // 不能在这里直接 enterPlaying：playurl 到位只代表拿到地址，画面还要等
    // loadeddata；直接跳播放界面会截断注水动画，露出未就绪的黑屏。
    if (uiState === "switching") finishSwitching();
  }

  function dbg(s) {
    lptv._dbg.push(((new Date()).getTime() % 100000) + " " + s);
    if (lptv._dbg.length > 30) lptv._dbg.shift();
  }

  /* ================= 官方视频元素 (画面源) ================= */

  function acquireOfficial() {
    var list = document.querySelectorAll("video");
    var cand = null;
    var old = (_sw && _sw.oldVideo) || null;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      // 切台期间优先认新元素: 官方换台可能新建 <video>，旧元素还留着上一路画面；
      // 若继续认旧元素，会把旧画面当成新台已就绪 (或永远等不到新元素的 loadeddata)。
      if (uiState === "switching" && old && v === old && list.length > 1) continue;
      // 优先认"可见"的视频元素: 官方页可能有隐藏的预载/预览 video（也有 videoWidth），
      // 若按内在分辨率选中隐藏元素，会把隐藏画面铺满全屏，而真正在播的 video 仍留在
      // 官方布局里 → 两层画面叠在一起（用户反馈"类似双层的显示"）。
      var vis = (v.offsetWidth > 0 && v.offsetHeight > 0) || v.style.display !== 'none';
      if (!cand) cand = v;
      var candVis = (cand.offsetWidth > 0 && cand.offsetHeight > 0) || cand.style.display !== 'none';
      if (vis && !candVis) { cand = v; continue; }
      if (vis === candVis && v.videoWidth && (!cand.videoWidth || v.videoWidth > cand.videoWidth)) cand = v;
    }
    if (!cand) return;
    // 只让当前画面源可见: 官方换台/预载可能同时存在多个 <video>，未被我们铺满的
    // 其它元素仍按官方布局渲染，会形成第二层画面。隐藏它们（不影响解码/播放），
    // 切台时旧元素被隐藏也由切换遮罩盖住，无黑屏风险。
    var hiddenInactive = 0;
    for (var j = 0; j < list.length; j++) {
      var vv = list[j];
      var wantVis = (vv === cand) ? "visible" : "hidden";
      try {
        if (vv.style.getPropertyValue("visibility") !== wantVis ||
            vv.style.getPropertyPriority("visibility") !== "important") {
          vv.style.setProperty("visibility", wantVis, "important");
          if (wantVis === "hidden") hiddenInactive++;
        }
        if (!vv.style.getPropertyValue("pointer-events")) {
          vv.style.setProperty("pointer-events", "none", "important");
        }
      } catch (e) {}
    }
    if (hiddenInactive) {
      console.log("[LPTV-video] hide " + hiddenInactive + " inactive video(s), active index=" +
        Array.prototype.indexOf.call(list, cand) + " total=" + list.length);
    }
    if (cand !== lptv.video) {
      dbg("ov=" + (cand === lptv.video ? "same" : "acquire"));
      lptv.video = cand;
      // 入口不自动播放: 官方首页可能已经在播默认频道，认到元素后立即暂停。
      if (lptv._suppressAutoplay && uiState === "home" && !cand.paused) {
        try { cand.pause(); } catch (e) {}
        lptv._autoplayPending = false;
      }
      // 官方换台会替换 <video> 元素 → 事件必须跟着元素重新绑定。
      // 此前只在首次 acquire 时绑定 (_ovBound)，换台新建元素后收不到
      // loadeddata/playing，切换态永远等不到进入播放态 (桌面点频道卡在注水动画)。
      bindVideoEvents();
      styleOfficial();
    }
  }

  var _lastStyledVideo = null;
  var _lastStyleKey = null;
  function styleOfficial() {
    var v = lptv.video;
    if (!v) return;
    // 视频按渲染器视口(100vw/100vh)铺满——即用户实际可见区域, 保证视频以原生比例清晰显示。
    // 此前用 main 进程 getBounds()(__lptvWinW/H) 铺满, 但 xpra 下窗口边界可能大于视口
    // (viewport 未同步), 导致视频被放大裁剪 → 画面变糊 (用户反馈"不如以前清晰")。
    // 故回归视口尺寸; 同时把窗口/视口几何落盘(geo log)以便核对两者是否一致。
    // 视频始终铺满当前窗口/视口（智慧屏=整屏；CDE 窗口=窗口尺寸含最大化）。
    // 不再按视口尺寸钳到 1280x720（会误伤视口>1280x720 的智慧屏 → 显示不全）。
    // CDE 最大化铺满会增大 xpra 编码量（1920x1080 vs 1280x720），若回顿挫后续在
    // 帧率/quality 侧平衡。
    var vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
    var vW = vw, vH = vh, vL = 0, vT = 0;
    var key = vW + "x" + vH + "@" + vL + "," + vT + "|" + cfg.fit;
    // 值未变化不重写: 保活每 3s 调 styleOfficial, 若无条件 setProperty 即使值相同
    // 也触发 style 失效 → 重排/重绘 → xpra 捕获差异重编码 → 周期性卡顿。仅在
    // video 元素变化(官方换台替换 <video>)或尺寸/fit 变化时重写。
    if (v === _lastStyledVideo && key === _lastStyleKey) return;
    _lastStyledVideo = v;
    _lastStyleKey = key;
    v.style.setProperty("position", "fixed", "important");
    v.style.setProperty("left", vL + "px", "important");
    v.style.setProperty("top", vT + "px", "important");
    v.style.setProperty("right", "auto", "important");
    v.style.setProperty("bottom", "auto", "important");
    v.style.setProperty("width", vW + "px", "important");
    v.style.setProperty("height", vH + "px", "important");
    // 官方播放器可能对 video 本身施加 transform（缩放/位移/镜像）做自适应；这会
    // 让我们的铺满样式变成"偏移的第二层画面"。强制归零，只保留宽高/object-fit。
    v.style.setProperty("transform", "none", "important");
    v.style.setProperty("z-index", "2147483001", "important");
    v.style.setProperty("object-fit", cfg.fit === "cover" ? "cover" : (cfg.fit === "fill" ? "fill" : "contain"), "important");
    v.style.setProperty("background", "#000", "important");
    v.style.setProperty("max-width", "none", "important");
    v.style.setProperty("max-height", "none", "important");
    v.style.setProperty("margin", "0", "important");
    // 去毛边: 视频无圆角/描边/阴影, 紧贴窗口边缘不留缝隙
    v.style.setProperty("border-radius", "0", "important");
    v.style.setProperty("border", "none", "important");
    v.style.setProperty("outline", "none", "important");
    v.style.setProperty("box-shadow", "none", "important");
    // ---- 画面几何诊断（每次换视频元素打一次，区分"cover没生效/样式错元素/区域非16:9"）----
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      var iw = v.videoWidth, ih = v.videoHeight;
      var bw = v.clientWidth, bh = v.clientHeight;
      var oFit = v.style.getPropertyValue("object-fit") || (getComputedStyle(v).objectFit || "");
      console.log("[LPTV-geo] vw=" + vw + " vh=" + vh
        + " intrinsic=" + iw + "x" + ih + " box=" + bw + "x" + bh
        + " fit=" + cfg.fit + " applied=" + oFit
        + " viewAspect=" + (vh ? (vw / vh).toFixed(3) : "-")
        + " vidAspect=" + (ih ? (iw / ih).toFixed(3) : "-"));
    } catch (e) {}
  }

  function bindVideoEvents() {
    var v = lptv.video;
    if (!v || v.__lptvBound) return;
    v.__lptvBound = true;
    v.addEventListener("loadeddata", function () {
      if (v !== lptv.video) return;   // 旧元素迟到的事件不得推进切台
      // 切换就绪 -> 播放态 (设计稿状态2/3)。只有确认事件来自新流才收切换页,
      // 避免旧流 loadeddata/playing 迟到把切换动画提前撤掉 (露黑屏)。
      if (uiState === "switching" && swStreamIsNew(_sw && _sw.pid)) {
        if (_sw) _sw.forceReady = true;
        finishSwitching();
      }
      updateQualityBadge();
    });
    // 视频内在分辨率变化(官方换流/换台)时刷新画质标签
    v.addEventListener("resize", function () { updateQualityBadge(); });
    v.addEventListener("waiting", function () { dbg("vwaiting t=" + Math.floor(v.currentTime)); markSwStreamEvent(); });
    v.addEventListener("stalled", function () { dbg("vstalled"); markSwStreamEvent(); });
    // 官方换流证据(不依赖 src/element 身份): MSE 复用同一 <video>/同一 blob URL 时,
    // src 不变、readyState 也可能不掉, 只看 src 会误判"没换流"→ 切换页挂到看门狗。
    // 播放器真正换流/重置缓冲时会发这些事件, 记下来作为"新流已开始"的证据。
    v.addEventListener("seeking", function () { markSwStreamEvent(); });
    v.addEventListener("emptied", function () { markSwStreamEvent(); });
    v.addEventListener("loadedmetadata", function () { markSwStreamEvent(); });
    // 官方播放器切台时会重置音量为默认(50%) -> 强制回到用户设置的音量。
    // 自动播放策略/官方播放器也可能把元素静音: 用户未静音时必须恢复出声
    // (智慧屏上官方播放器常以 muted 起播, 只同步 volume 不够)。
    v.addEventListener("volumechange", function () {
      if (lptv._volLock || !cfg) return;
      // 移动端用手机系统媒体音量：不做元素音量锁定，固定 1.0/不静音。
      if (IS_MOBILE) return;
      if (!audioMuted() && v.muted) {
        lptv._volLock = true;
        v.muted = false;
        setTimeout(function () { lptv._volLock = false; }, 50);
        dbg("unmute-enforce");
        return;
      }
      if (audioMuted()) return;
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
      if (v !== lptv.video) return;
      // 入口不自动播放: 官方首页自动起播默认频道 → 立刻暂停，保持首页无焦点。
      if (lptv._suppressAutoplay && uiState === "home") {
        lptv._autoplayPending = false;
        try { v.pause(); } catch (e) {}
        return;
      }
      // 黑幕淡出前确保深色底衬在场: 首启时官方页可能仍是白色加载背景,
      // 黑幕(0.6s 淡出)若直接露白底 → 白闪。底衬盖住白底, 淡出露深色。
      ensureCover();
      // 首页未就绪前不要撤黑幕: 官方页可能已经自动播放, 此时撤掉会露出央视频原页。
      // 首页渲染完成后由 initChannels 统一撤黑幕。
      if (lptv._homeReady) removeBootmask();  // 官方画面已开始 -> 淡出启动黑幕
      dbg("vplaying t=" + Math.floor(v.currentTime));
      if (IS_MOBILE) {
        // 手机系统音量接管：元素固定满音量/不静音，不写 cfg。
        if (v.muted) { try { v.muted = false; } catch (e) {} }
        if (v.volume !== 1) v.volume = 1;
      } else if (!audioMuted()) {
        if (v.muted) { try { v.muted = false; } catch (e) {} }
        var wantVol = cfg.volume != null ? cfg.volume : 1;
        if (v.volume !== wantVol) v.volume = wantVol;
      }
      // 仅从切换态进播放态; 不从 home 强制切走 (入口=首页, 点卡片才播),
      // 避免外壳自动播放的 playing 事件把用户从首页拽进播放界面。
      if (uiState === "switching" && swStreamIsNew(_sw && _sw.pid)) {
        if (_sw) _sw.forceReady = true;
        finishSwitching();
      }
    });
    v.addEventListener("pause", function () { dbg("vpause t=" + Math.floor(v.currentTime)); handleExternalPause(); });
    v.addEventListener("error", function () {
      if (v !== lptv.video) return;
      dbg("verror " + (v.error && v.error.code));
      if (uiState === "switching") { if (_sw) _sw.forceReady = true; finishSwitching(); }
    });
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

  function audioMuted() {
    // 用户主动静音 或 首页静音模式 (回首页继续播放但静音, 点频道进入播放时解除)
    return !!(cfg.muted || lptv._homeMuted);
  }

  function tryPlay() {
    var v = lptv.video;
    if (!v) return;
    if (IS_MOBILE) {
      // 手机系统音量接管：元素固定满音量/不静音，不写 cfg。
      v.volume = 1;
      v.muted = false;
    } else {
      v.volume = cfg.volume;
      v.muted = audioMuted();
    }
    var p = v.play();
    if (p && p.catch) {
      p.catch(function () {
        dbg("tryPlay reject (policy)");
        // 自动播放策略拒绝有声播放: 先静音起播, 起播后恢复用户设置的声音。
        // 不能把 muted 写进 cfg —— 否则一次策略拒绝会让之后每次启动/切台都
        // 默认静音 (智慧屏反馈的"打开/切台默认静音"根因)。
        lptv._volLock = true;
        v.muted = true;
        var p2 = v.play();
        if (p2 && p2.then) {
          p2.then(function () {
            lptv._volLock = false;
            if (IS_MOBILE || !audioMuted()) { try { v.muted = false; } catch (e) {} }
            if (IS_MOBILE) { try { v.volume = 1; } catch (e) {} }
          }).catch(function () { lptv._volLock = false; dbg("tryPlay2 reject"); });
        } else if (p2 && p2.catch) {
          p2.catch(function () { lptv._volLock = false; dbg("tryPlay2 reject"); });
        } else {
          lptv._volLock = false;
        }
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
      dbg("hls: source " + String(url).slice(0, 30));
      // 增大直播缓冲以吸收源/网络抖动，消除"2s 停顿"。
      // 实测(lptv.video.log)：直播流每 ~2min 一次 `waiting`→`playing`(0.5~6s) + 掉帧
      // 60~73 帧 —— 这是 HLS 直播缓冲过小(默认 liveSyncDurationCount=3≈6s)，源一有
      // 瞬时抖动(网络/CDN 波动)缓冲就下溢 → 停顿。加大缓冲让播放器持有更多数据，
      // 抖动被缓冲吸收而不打断播放。代价：延迟增加几秒~十几秒(直播可接受)，换来平滑。
      try {
        var c = this.config || {};
        c.maxBufferLength = Math.max(c.maxBufferLength || 0, 60);
        c.liveSyncDurationCount = Math.max(c.liveSyncDurationCount || 0, 8);
        if (typeof c.liveMaxLatencyDurationCount === 'number' && isFinite(c.liveMaxLatencyDurationCount) && c.liveMaxLatencyDurationCount < 30) {
          c.liveMaxLatencyDurationCount = 30;
        }
      } catch (e) {}
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

  /* 低频保活: 官方元素被替换/样式复位时重铺; 窗口 resize 后官方可能改回样式;
   异常暂停时恢复 */
  setInterval(function () {
    // 提前注入(dom-ready)时官方 SPA 可能尚未挂载/后续重渲染, 若 #lptv-root 被
    // 清出文档则重新挂到 body, 保证覆盖层不因提前注入而丢失。
    if (lptv.ui && lptv.ui.root && !document.body.contains(lptv.ui.root)) {
      try { document.body.appendChild(lptv.ui.root); } catch (e) {}
    }
    ensureCover();
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
  // GPU 后备画布 + getImageData 回读(上次流畅路径)。不用 willReadFrequently:
  // 盒子弱核/软件合成下 CPU 画布每次 drawImage(video) 要读视频帧, 更吃 CPU → 卡顿。
  var wctx = wcanvas.getContext("2d");

  setInterval(function () {
    var v = lptv.video;
    // 切台加载期间画面还没稳定: 不参与黑帧判定, 否则新流起播前的黑帧会触发
    // recoverBlack() → 又切一次台 → 切换页被重置, 表现为"卡在切换圆圈"。
    if (uiState === "switching") { lptv.darkCount = 0; return; }
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
  }, 8000);

  function recoverBlack() {
    lptv.darkCount = 0;
    // 版权受限台本身就是黑屏: 重切同一台没有意义, 只保留提示卡片 (用户可手动换台)。
    if (lptv.signalBlocked) return;
    var v = lptv.video;
    if (v) {
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); }
    }
    switchChannel(lptv.currentPid);
  }

  /* ================= 版权限制提示 =================
     央视频部分频道 (体育赛事等) 会因版权只显示黑屏 + 一句"应版权方要求, 暂停提供
     信号"。官方提示层常被全屏 video 盖住, 用户只看到纯黑屏。这里读取官方页文本,
     命中提示语时在顶层 UI 显示说明卡片, 并暂停黑帧/卡死看门狗的重切, 避免反复
     切同一个受限台。 */
  function _textHasCopyright(body) {
    if (!body) return false;
    var txt = "";
    var w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = w.nextNode())) {
      var v = n.nodeValue;
      if (!v) continue;
      // 只收可能相关的文本节点, 避免整页大文本拼接开销
      if (v.indexOf("版权") < 0 && v.indexOf("信号") < 0 && v.indexOf("精彩") < 0) continue;
      var p = n.parentNode, skip = false, hidden = false;
      while (p && p !== body) {
        if (p.id === "lptv-root") { skip = true; break; }
        if (p.nodeType === 1) {
          var st = window.getComputedStyle(p);
          if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") { hidden = true; break; }
        }
        p = p.parentNode;
      }
      if (!skip && !hidden) txt += v;
    }
    txt = txt.replace(/\s+/g, "");
    // 官方文案有"暂停提供信号"和"暂停提供直播信号"两种, 用"暂停提供"兜住。
    return txt.indexOf("暂停提供") >= 0 || txt.indexOf("应版权方要求") >= 0 ||
           txt.indexOf("观看其他精彩节目") >= 0;
  }
  function hasCopyrightNotice() {
    try { if (_textHasCopyright(document.body)) return true; } catch (e) {}
    // 网页播放器同源 iframe (智慧屏 SW 接管时) 也能读到; 跨域时静默跳过,
    // 此时官方提示层本身可见, 不需要顶层提示。
    try {
      var f = document.getElementById("lptv-iframe");
      var d = f && f.contentDocument;
      if (d && d.body && _textHasCopyright(d.body)) return true;
    } catch (e) {}
    return false;
  }
  function setSignalNotice(on) {
    on = !!on;
    if (lptv.signalBlocked === on) return;
    lptv.signalBlocked = on;
    var n = lptv.ui && lptv.ui.notice;
    if (n) n.classList.toggle("on", on);
    if (on) lptv.darkCount = 0;
  }
  function checkSignalBlock() {
    var n = lptv.ui && lptv.ui.notice;
    if (!n) return;
    // 只在播放态显示: 首页/切换页/频道面板/节目单期间收起, 避免提示卡片挡住面板
    // (移动端面板较窄, 居中卡片会压到面板上); 面板关掉回播放态后再重新判定。
    var blocked = uiState === "playing" && hasCopyrightNotice();
    if (blocked !== !!lptv.signalBlocked) setSignalNotice(blocked);
  }
  setInterval(checkSignalBlock, 2500);

  /* ================= 卡死看门狗 (直播流冻结) =================
     黑帧看门狗只抓"全黑", 抓不到"冻结在最后一帧"的卡死(画面不是黑的, 只是不动)。
     这里用 currentTime 是否推进判定: 正在播放(未暂停/有画面)但 currentTime 连续多轮
     不推进 → 判定卡死 → 重切当前台(重新取流); 30s 内再次卡死 → 整页重载兜底(彻底恢复)。
     智慧屏/CDE 均走 /catlink/ xpra(容器 Electron 播放), 本看门狗运行在容器内, 两端都生效。 */
  var _stallCt = -1, _stallN = 0, _stallLastRecover = 0;
  var _nrN = 0, _nrLast = 0;   // 播放态"无画面"恢复 (切台看门狗强行收尾后 rs 仍 <2)
  setInterval(function () {
    var v = lptv.video;
    // 切台等待期 currentTime 本就可能长时间不动(缓冲/等首帧), 不能算卡死:
    // 否则重切当前台 → openSwitching 重置切换页 → 反复循环, 看起来永远卡在切换动画。
    if (uiState === "switching") { _stallN = 0; _stallCt = -1; _nrN = 0; return; }
    // 版权受限台黑屏/无画面是正常状态, 不触发重切/重载 (否则会反复整页重载)。
    if (lptv.signalBlocked) { _stallN = 0; _stallCt = -1; _nrN = 0; return; }
    if (!v || v.paused) { _stallN = 0; _stallCt = -1; _nrN = 0; return; }
    // 播放态但视频始终没拿到元数据/首帧 (rs<2 或 无内在分辨率): 切台看门狗收尾后
    // 直接是黑屏, 且下面 rs<2 分支原本被跳过 → 永久黑屏。这里补一个"无画面"恢复:
    // 持续 ~9s 无画面 → 重切当前台; 30s 内二次失败 → 整页重载兜底 (彻底恢复)。
    if (v.readyState < 2 || !v.videoWidth) {
      _stallN = 0; _stallCt = -1;
      if (uiState !== "playing" || !lptv.currentPid) { _nrN = 0; return; }
      _nrN++;
      if (_nrN >= 3) {
        _nrN = 0;
        var nowNr = Date.now();
        if (_nrLast && nowNr - _nrLast < 30000) {
          dbg("nr-reload");
          try { location.reload(); } catch (e) {}
        } else {
          _nrLast = nowNr;
          dbg("nr-recover rs=" + v.readyState);
          switchChannel(lptv.currentPid);
        }
      }
      return;
    }
    _nrN = 0;
    var ct = v.currentTime;
    if (_stallCt >= 0 && Math.abs(ct - _stallCt) < 0.5) {
      _stallN++;
      if (_stallN >= 3) {          // 约 9s currentTime 不推进 → 卡死
        _stallN = 0;
        var now = Date.now();
        if (_stallLastRecover && now - _stallLastRecover < 30000) {
          dbg("stall-reload");
          try { location.reload(); } catch (e) {}   // 重切无效 → 整页重载兜底
        } else {
          _stallLastRecover = now;
          dbg("stall-recover ct=" + Math.floor(ct));
          switchChannel(lptv.currentPid);           // 先重切当前台(重新取流)
        }
      }
    } else {
      _stallN = 0;
    }
    _stallCt = ct;
  }, 3000);

  /* ================= 频道逻辑 ================= */

  function officialNameOf(pid) {
    var ch = lptv.channels.find(function (c) { return c.pid === pid; });
    return ch ? ch.official : "";
  }
  function chNameOf(pid) {
    var ch = lptv.channels.find(function (c) { return c.pid === pid; });
    return ch ? ch.name : (pid ? "频道 " + pid : "");
  }
  /* 关于面板图片(icon.png 猫+电视图标 / lptv.png 品牌 logo): 启动即异步预加载并
     缓存 data URI 到 lptv.aboutCache。LPK 下 get_asset_image 走桥往返 + 大图
     base64 较慢, 提前拉取后打开「关于」页即取缓存, 不再现拉现等。幂等: 缓存命中跳过 */
  /* 首页背景: 注入层跑在官方远程页里, 相对路径 url('home-bg.jpg') 会按站点解析
     成 https://www.yangshipin.cn/tv/home-bg.jpg → 404, 首页一直是纯黑底。
     统一经壳层取本地资源 (Electron 返回 data URI, 网页版/APK 同源 fetch 转
     data URI), 再挂到 CSS 变量 --home-bg 上。 */
  function loadHomeBg() {
    if (lptv._homeBgLoading) return;
    var api = window.lptv;
    if (!api || !api.get_asset_image) { lptv._homeBgLoading = false; return; }
    lptv._homeBgLoading = true;
    api.get_asset_image("home-bg.jpg", "assets").then(function (r) {
      if (r && r.ok && r.src) {
        lptv.homeBg = r.src;
        var root = lptv.ui && lptv.ui.root;
        if (root) root.style.setProperty("--home-bg", "url('" + r.src + "')");
      }
    }).catch(function () {});
  }

  /* 懒加载频道台标: pid -> logos/{pid}.webp 的 data URI, 缓存到 lptv.logoCache */
  function getLogoDataUri(pid) {
    if (!pid || !/^\d+$/.test(pid)) return '';
    if (lptv.logoCache[pid]) return lptv.logoCache[pid];
    var api = window.lptv;
    if (!api || !api.get_asset_image) return '';
    api.get_asset_image(pid + '.webp', 'logos').then(function (r) {
      if (r && r.ok && r.src) {
        lptv.logoCache[pid] = r.src;
        // 台标异步到位后即时回填新设计 DOM: 首次渲染时缓存为空, 卡片/行内没有 img 节点,
        // 所以这里必须“创建”img 而不是只改已有 img 的 src。
        document.querySelectorAll('.lv-card[data-pid="' + pid + '"] .lv-card-logo,' +
          '.lv-left-item[data-pid="' + pid + '"] .lv-left-logo').forEach(function (box) {
          box.innerHTML = '<img src="' + r.src + '" alt="">';
        });
        var swLogo = document.querySelector('#lptv-view-switching #lv-sw-logo');
        if (swLogo) swLogo.innerHTML = '<img src="' + r.src + '" alt="">';
        var playLogo = document.querySelector('#lptv-view-playing #lv-play-logo');
        if (playLogo && lptv.currentPid === pid) playLogo.innerHTML = '<img src="' + r.src + '" alt="">';
      }
    }).catch(function () {});
    return '';
  }

  function findOfficialButtons(pid) {
    var ch = lptv.channels.find(function (c) { return c.pid === pid; });
    if (!ch) return [];
    // 频道显示名优先(更具体: "CGTN 法语" → CGTN法语)，再用官方短名("CCTV6")。
    // 这样同名频道(CGTN 系多个)不会因为短名相同而点错/点到当前台。
    var names = [];
    var nm = normChName(ch.name), of = normChName(ch.official);
    if (nm) names.push(nm);
    if (of && of !== nm) names.push(of);
    if (!names.length) return [];
    var items = document.querySelectorAll(".tv-main-con-r-list-left > div");
    var out = [];
    for (var n = 0; n < names.length; n++) {
      var want = names[n], exact = [], sub = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var txt = normChName(it.textContent || "");
        if (!txt) continue;
        var sel = false;
        try { sel = it.classList.contains("tvSelect"); } catch (e) {}
        if (txt === want) exact.push({ el: it, sel: sel });
        else if (txt.indexOf(want) >= 0) sub.push({ el: it, sel: sel });
      }
      if (exact.length) { out = exact; break; }
      if (sub.length) { out = sub; break; }
    }
    // 已选中(tvSelect)的排后面: 同名频道时优先点"另一个"，否则点到当前正在播的
    // 那台 → 官方不换流，表现为"点了没反应/卡死"。
    out.sort(function (a, b) { return (a.sel ? 1 : 0) - (b.sel ? 1 : 0); });
    return out.map(function (x) { return x.el; });
  }
  function findOfficialButton(pid) {
    var a = findOfficialButtons(pid);
    return a.length ? a[0] : null;
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
    // 切换进行中重复触发同一目标台（点击/事件冒泡/重复绑定）: 不要重置 _sw.t0、
    // 动画和看门狗。否则慢流时每次重复调用都会把 12s 计时重新开始，切换页
    // 反复重开，用户感知为“切换卡住”。
    if (uiState === "switching" && _sw && !_sw.done && String(_sw.pid) === String(pid)) return;
    // 换台先收起上一台的版权提示; 新台稳定后由 checkSignalBlock 重新判定。
    setSignalNotice(false);
    // 用户主动点频道 → 解除"入口不自动播放"抑制，正常切台/记忆 lastPid。
    lptv._suppressAutoplay = false;
    lptv._homeMuted = false;   // 从首页点频道进入播放: 解除首页静音, 恢复声音
    // 记录频道在频道表中的序号: 官方播放页可能回写不同的 pid, 步进换台时用它兜底,
    // 避免 findIndex 失败后从第一个频道开始 (27 后下一台错误跳回 1 的根因)。
    var _si = (lptv.channels || []).findIndex(function (c) { return c.pid === pid; });
    if (_si >= 0) lptv._stepIdx = _si;
    // 已在当前频道且视频已有画面内容: 不重载。即使官方停在 paused (整页重载后
    // 官方页已载入目标台但未起播) 也直接补播/回播放态 —— 否则会再走一次
    // openSwitching, 而官方已选中同名项不换流 → 没有 loadeddata → 卡在切换页,
    // 8s 整页重载兜底又触发 → 重载循环 (移动端冷启动"卡死"根因之一)。
    // 版权提示的"重试"会置 _forceSwitch, 跳过这个快速路径, 真正重走一次官方切台。
    if (!lptv._forceSwitch && pid === lptv.currentPid && lptv.video &&
        lptv.video.readyState >= 2 && lptv.video.videoWidth > 0) {
      lptv._autoplayPending = true;
      if (lptv.video.paused) tryPlay();
      enterPlaying(pid);
      return;
    }
    lptv._forceSwitch = false;
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
    // 设计稿状态6: 切换台加载中
    openSwitching(pid);
    // 智慧屏/CDE 模式分离：切换机制按"是否 iframe 播放器"分支。
    // __lptvBridge（/web/ 播放器, Android + 智慧屏若跑 /web/）：视频在跨域 iframe 内，
    // 无法 findOfficialButton，走 bridge 的 play_channel 设 iframe.src 加载官方播放器。
    // 智慧屏实际跑的是 Electron 前端（同桌面 DOM，无 __lptvBridge）→ 不能走 play_channel
    // （会经 IPC 递归回 window.__lptv.switchChannel → 死循环），必须走下方 findOfficialButtons。
    // 因此这里用 __lptvBridge（iframe 播放器）判定，不用 isTv()。
    if (window.__lptvBridge && window.lptv && typeof window.lptv.play_channel === 'function') {
      window.lptv.play_channel(pid);
      // iframe 模型: 视频/官方 playurl 都在跨域 iframe 内, 父页收不到
      // loadeddata/playurl 信号 → 切换态只能等看门狗 (旧版 12s, 新版 20s)。
      // 旧版 play_channel 后立即收起遮罩; 新版至少展示完最短动画就进播放界面,
      // 由 iframe 自己显示官方加载页 (与旧版一致)。
      setTimeout(function () {
        if (!_sw || _sw.done || _sw.pid !== pid) return;
        _sw.forceReady = true;
        finishSwitching();
      }, SW_MIN_MS + 50);
      return;
    }
    var cands = findOfficialButtons(pid);
    console.log("[LPTV-switch] pid=" + pid + " name=" + chNameOf(pid)
      + " official=" + officialNameOf(pid) + " cands=" + cands.length + " href=" + location.href);
    var pick = cands.length ? cands[0] : null;
    var wasSelected = false;
    try { wasSelected = !!(pick && pick.classList && pick.classList.contains("tvSelect")); } catch (e) {}
    if (pick) {
      try { pick.click(); } catch (e) {}
    } else if (officialNameOf(pid) !== "") {
      // 官方侧栏可能尚未渲染 (冷启动/移动端立即切台): 先等侧栏出现再点, 而不是
      // 立刻 pushState 空路由 (官方 SPA 不响应 → 流不启动 → 8s 整页重载循环)。
      var sideTries = 0;
      (function waitSidebar() {
        if (uiState !== "switching" || !_sw || _sw.done || _sw.pid !== pid) return;
        var c2 = findOfficialButtons(pid);
        if (c2.length) {
          console.log("[LPTV-switch] late-candidate pid=" + pid + " wait=" + sideTries);
          try { c2[0].click(); } catch (e) {}
          return;
        }
        if (sideTries++ < 8) { setTimeout(waitSidebar, 300); return; }
        // 兜底：优先走官方 SPA 路由（pushState + popstate），避免整页重载。
        // 整页重载央视频要 30s+，期间只看到启动动画，表现为“换台卡死”。
        try {
          history.pushState({}, "", "/tv/home?pid=" + pid);
          window.dispatchEvent(new PopStateEvent("popstate"));
        } catch (e) {
          location.href = "/tv/home?pid=" + pid;
        }
      })();
    } else {
      // 无候选且无官方路由: 回播放态 (不卡在加载)
      enterPlaying(pid);
      return;
    }
    // 换台状态采样（诊断用）：官方换流后 loadeddata/playing 是否触发
    var swT0 = Date.now();
    var swTimer = setInterval(function () {
      var el = Date.now() - swT0;
      var v = lptv.video;
      console.log("[LPTV-switchstate] pid=" + pid + " el=" + el
        + " v=" + (v ? v.readyState + "," + Math.floor(v.currentTime) + "," + (v.paused ? "paused" : "play") : "null")
        + " playUrl=" + String(lptv.playUrl || "").slice(-24));
      if (el >= 6000) clearInterval(swTimer);
    }, 2000);
    // 点到"官方已选中"的同名项: 官方不会换流, 但画面其实就是目标台。
    // 给一个短兜底, 避免一直停在切换态等一个永远不会来的 loadeddata。
    // (此前在 !wasSelected 分支还有 8s 整页重载兜底 —— 它不校验当前切台、
    //  不随切台结束清除, 且 8s < 看门狗 12s, 慢网络/冷启动下会形成"重载循环",
    //  表现为永远卡在切换动画。整页重载交回看门狗 + 播放态恢复看门狗统一处理。)
    if (wasSelected) {
      setTimeout(function () {
        if (uiState !== "switching" || !_sw || _sw.done || _sw.pid !== pid) return;
        _sw.forceReady = true;
        finishSwitching();
      }, 1200);
    }
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
    var len = lptv.channels.length;
    var idx = lptv.channels.findIndex(function (c) { return c.pid === lptv.currentPid; });
    // 官方播放页可能把 currentPid 回写成频道表之外的 pid (如 CGTN 复用通用 pid),
    // 此时 findIndex=-1; 用切台时记录的序号兜底, 否则会错误地从第 1 台重新开始。
    if (idx < 0 && typeof lptv._stepIdx === "number" && lptv._stepIdx >= 0 && lptv._stepIdx < len) {
      idx = lptv._stepIdx;
    }
    var next = idx < 0 ? 0 : (idx + delta + len) % len;
    lptv._stepIdx = next;
    switchChannel(lptv.channels[next].pid);
  }


  function markActive() {
    // 新设计: 频道高亮由 setChLabel (首页卡片/播放信息) 统一刷新
    setChLabel();
  }

  /* ================= UI ================= */

  // 智慧屏圆圈光标: 中心热点。智慧屏浏览器原生 cursor:default 的白圈热点在圆圈
  // 顶部(非圆心), 导致"必须把圆圈往下移才点得中"(点击偏下) —— 自绘中心热点圆圈
  // 让点击点=圆圈视觉中心, 任意位置点中组件。CDE/桌面不设此类, 保持系统鼠标。
  // (1478b30 曾改回 cursor:default 以贴合窗口外圆圈, 但默认光标热点偏移不可调。)
  var TV_CURSOR = 'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAwUlEQVR42u2XQRKDMAhFA+Oh8QTh1rhx0VpBIFHTmfytAg/E+C1l6mVBIoaMaxxNtkQLi0hVuwEIg0CPwicgqxcEosU/kv9IuY+zAGQUZms3TuJUCPQs2qEbNhaQlSlReNNlVya4NccxMA3ggUBHIk4CcI+xUeNBdzkFvKl7dzyWlzUBhgfo8RY8d4JlcuFdXbTCP/YtWCxTISJVRGrQ6Xx5CMs/WI+AFaNhHc9kuCf+S0c0hCeMuuI1sCtj/BdMTW1poasj/L1HEwAAAABJRU5ErkJggg==") 16 16, default';

  var CSS = `
  /* 全局: 页面不出现滚动条。固定 1920x1080 设计画布经 transform 缩放, 布局盒仍 1920 宽,
     会撑出视口滚动条 → html/body 兜底(!important 压过官方页 CSS); 再隐藏根内所有
     webkit 滚动条 (双保险)。 */
  html, body{overflow:hidden!important}
  #lptv-root ::-webkit-scrollbar{width:0;height:0;display:none}
  #lptv-root{--glass:rgba(18,20,28,.80);--glass-2:rgba(24,27,38,.96);
    /* 液态玻璃材质令牌: 1 结构层(频道/节目单/设置) / 2 交互层(卡片/标签/行/按钮) / 3 胶囊层 */
    --glass-1-fill:linear-gradient(160deg,rgba(30,34,46,.72),rgba(12,15,24,.86));
    --glass-1-stroke:rgba(255,255,255,.14);
    --glass-1-hi:rgba(255,255,255,.22);
    --glass-1-hi-soft:rgba(255,255,255,.08);
    --glass-1-shadow:0 18px 48px rgba(0,0,0,.45);
    --glass-2-fill:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.07));
    --glass-2-fill-weak:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.04));
    --glass-2-hover-fill:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.12));
    --glass-2-active-fill:linear-gradient(180deg,rgba(255,255,255,.26),rgba(255,255,255,.16));
    --glass-2-stroke:rgba(255,255,255,.18);
    --glass-2-stroke-weak:rgba(255,255,255,.10);
    --glass-2-hi:rgba(255,255,255,.26);
    --glass-3-fill:rgba(0,0,0,.35);
    --glass-3-stroke:rgba(255,255,255,.20);
    --tab-ind-fill:#fff;
    --grain:url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSc5NicgaGVpZ2h0PSc5Nic+PGZpbHRlciBpZD0nbic+PGZlVHVyYnVsZW5jZSB0eXBlPSdmcmFjdGFsTm9pc2UnIGJhc2VGcmVxdWVuY3k9Jy44NScgbnVtT2N0YXZlcz0nMicgc3RpdGNoVGlsZXM9J3N0aXRjaCcvPjxmZUNvbG9yTWF0cml4IHZhbHVlcz0nMCAwIDAgMCAxICAwIDAgMCAwIDEgIDAgMCAwIDAgMSAgMCAwIDAgLjMwIDAnLz48L2ZpbHRlcj48cmVjdCB3aWR0aD0nMTAwJScgaGVpZ2h0PScxMDAlJyBmaWx0ZXI9J3VybCgjbiknLz48L3N2Zz4=");
    --sheen:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.10) 45%,transparent 60%);
    --line:rgba(255,255,255,.09);
    --tx:#eef1f8;--tx2:#a5b1ca;--tx3:#8499c0;--tx-weak:#6b7c9e;
    --acc:#3d9bff;--acc2:#4fd1c5;--red:#ff4d4d;--ok:#35c46b;
    /* 设计稿令牌（Calicat 2080555577832132608） */
    --bg:#05070e; --panel:var(--glass-1-fill); --card:var(--glass-2-fill);
    --card-active:var(--glass-2-active-fill); --accent:#4d7cfe; --accent2:#6aa8ff;
    --live:#ff5a5a; --logo:#ffffff;
    position:fixed;left:0;top:0;z-index:2147483002;background:transparent;
    width:1920px;height:1080px;transform-origin:top left;
    font-family:Inter,"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","WenQuanYi Micro Hei",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;
    color:var(--tx);font-size:calc(13.0px * var(--fs-scale));line-height:1.6;
    overflow:hidden;user-select:none}
  #lptv-root.dev-hidden{display:none}
  /* 智慧屏光标统一为"浏览器默认光标" (远端兜底, 权威处理在 web/catlink-wrap.html 的
     installTvCursor —— xpra 客户端文档内 cursor:default 直接复用浏览器默认圆圈):
     智慧屏浏览器的默认光标就是白色圆圈(遥控指针); xpra 客户端只对每个窗口 div
     设 CSS 光标, 本应用窗口一出现 DOM 光标(默认箭头/cursor:pointer 手型), 远端
     X11 光标就变成鼠标指针并同步给客户端 → 界面内变指针。这里对整页显式用
     TV_CURSOR(中心热点白圈), 让窗口内点击点=圆圈视觉中心 —— 浏览器原生
     cursor:default 的白圈热点在圆圈顶部, 会"点击偏下"; 中心热点使任意位置点中组件。
     CDE/桌面模式不加此类, 保持原鼠标指针。仅作不经过 catlink-wrap 时的兜底。
     必须放在下面空闲隐藏规则之前, 让 lptv-cursor-hidden 的 cursor:none 仍能生效。 */
  html.lptv-tv-cursor, html.lptv-tv-cursor *{
    cursor:${TV_CURSOR}!important}
  /* 鼠标/遥控指针空闲隐藏: 1.5s 不操作后整页 cursor:none (包括官方视频层/按钮),
     移动/按下立即恢复。xpra 会把远程 X 光标同步给客户端, 因此 CDE/智慧屏都生效。 */
  html.lptv-cursor-hidden, html.lptv-cursor-hidden *{cursor:none!important}
  /* 覆盖官方页对子元素的字体直写规则 (官方 CSS 常给 div 设 font-family, 会盖掉
     #lptv-root 的继承) → 统一回落到本机 Noto CJK, 避免落到不存在的苹方/雅黑
     再被系统随意替换, 文字发虚。 */
  #lptv-root,#lptv-root *{font-family:Inter,"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","WenQuanYi Micro Hei",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}

  /* ---- 无边框窗口拖动 (本地桌面有真实 WM) ----
   * 界面重写移除了顶栏及其 -webkit-app-region:drag 后，xpra/lightos 对无边框窗口
   * 回退"拖任意处移动窗口"，干扰首页卡片点击/列表滚动。这里显式把拖动手柄
   * 限定到各视图【顶栏】，内容/交互区标 no-drag 保持可点击可滚动。
   * 容器/xpra(无 WM) 不加 .lptv-native-drag，仍走 JS begin_window_drag(见 main.js)。 */
  #lptv-root.lptv-native-drag #lptv-view-home .lv-home-top,
  #lptv-root.lptv-native-drag #lptv-view-playing .lv-play-top,
  #lptv-root.lptv-native-drag #lptv-view-left .lv-left-head,
  #lptv-root.lptv-native-drag #lptv-view-right .lv-right-head,
  #lptv-root.lptv-native-drag #lptv-view-switching .lv-sw-below{-webkit-app-region:drag;app-region:drag}
  #lptv-root.lptv-native-drag #lptv-view-home .lv-home-content,
  #lptv-root.lptv-native-drag #lptv-view-home .lv-home-foot,
  #lptv-root.lptv-native-drag #lptv-view-home .lv-home-scroll,
  #lptv-root.lptv-native-drag #lptv-view-playing .lv-play-mask-top,
  #lptv-root.lptv-native-drag #lptv-view-playing .lv-play-mask-bottom,
  #lptv-root.lptv-native-drag #lptv-view-playing .lv-play-controls,
  #lptv-root.lptv-native-drag #lptv-view-playing .lv-vol-hint,
  #lptv-root.lptv-native-drag #lptv-view-left .lv-left-scene,
  #lptv-root.lptv-native-drag #lptv-view-left .lv-left-panel,
  #lptv-root.lptv-native-drag #lptv-view-right .lv-right-scene,
  #lptv-root.lptv-native-drag #lptv-view-right .lv-right-panel,
  #lptv-root.lptv-native-drag #lptv-view-switching .lv-sw-card{-webkit-app-region:no-drag;app-region:no-drag}
  /* 首页顶栏: 拖动只保留在顶栏空白区; logo 与 主题/设置按钮 no-drag (可点击)。
     时间胶囊不做 no-drag: 它 hover 时才显示, 隐藏时若占 no-drag 会在右上形成
     隐形死区导致"焦点不准" —— 因此胶囊区域保持可拖动。 */
  #lptv-root.lptv-native-drag #lptv-view-home .lv-home-top .lv-brand,
  #lptv-root.lptv-native-drag #lptv-view-home .lv-theme-toggle,
  #lptv-root.lptv-native-drag #lptv-view-home .lv-settings-btn{-webkit-app-region:no-drag;app-region:no-drag}

  /* ---- 顶边不可见拖拽条 (所有视图统一) ----
   * 各视图可见顶栏已有 drag 区; 这条全透明带把拖拽扩展到窗口最顶边, 播放全屏
   * (控制栏隐藏)等任何状态都能抓住顶边拖窗口。40px 小于各视图顶边最小留白
   * (左右面板 44px / home·切换 48px), 不遮任何按钮。z-index:50: 盖住各视图
   * (inset:0, z auto)、低于 #lptv-settings(60), 弹窗打开仍可点。
   * 容器/xpra 路径的 mousedown 委托在 bindEvents 里追加 .lv-drag-strip。 */
  #lptv-root .lv-drag-strip{position:absolute;top:0;left:0;right:0;height:40px;
    z-index:50;background:transparent}
  #lptv-root.lptv-native-drag .lv-drag-strip{-webkit-app-region:drag;app-region:drag}
  /* 触摸/APK 端无窗口拖动(且无 hover 顶栏), 直接隐藏带子 */
  #lptv-root.touch .lv-drag-strip{display:none}

  /* ============ 设计稿 6 态视图 (Calicat 2080555577832132608) ============ */
  #lptv-root [data-view]{display:none}
  #lptv-root[data-state=home] [data-view=home]{display:flex}
  #lptv-root[data-state=playing] [data-view=playing]{display:flex}
  #lptv-root[data-state=leftPanel] [data-view=left]{display:flex}
  #lptv-root[data-state=rightPanel] [data-view=right]{display:flex}
  #lptv-root[data-state=switching] [data-view=switching]{display:flex}

  /* 频道首页 (状态1) — 设计稿 11b: 液态玻璃卡片 + 圆角 */
  #lptv-view-home{position:absolute;inset:0;flex-direction:column;background:var(--bg)}
  #lptv-view-home .lv-home-bg{position:absolute;inset:0;
    /* 静态光斑: 给玻璃层一点可折射的底色 (不做动画) */
    background:
      radial-gradient(640px 320px at 10% 6%,rgba(77,124,254,.12),transparent 70%),
      radial-gradient(760px 360px at 92% 94%,rgba(79,209,197,.09),transparent 72%),
      linear-gradient(180deg,rgba(5,7,14,.75) 0%,rgb(5,7,14) 100%);
    filter:none}
  #lptv-view-home .lv-home-content{position:relative;flex:1;display:flex;flex-direction:column;
    padding:48px 80px 48px;overflow:hidden}
  #lptv-view-home .lv-home-top{display:flex;align-items:center;justify-content:space-between;
    height:56px;flex-shrink:0}
  #lptv-view-home .lv-brand{display:flex;align-items:center;gap:16px}
  #lptv-view-home .lv-brand-icon{width:56px;height:56px;display:flex;align-items:center;
    justify-content:center;overflow:hidden}
  #lptv-view-home .lv-brand-icon img{width:100%;height:100%;object-fit:contain;display:block}
  #lptv-view-home .lv-brand-text{font-size:24px;font-weight:700;letter-spacing:.5px}
  #lptv-view-home .lv-brand-sub{color:var(--tx2);font-size:17px;font-weight:500;
    letter-spacing:.2px;margin-top:2px;line-height:1.35}
  #lptv-view-home .lv-home-topright{display:flex;align-items:center;gap:12px}
  #lptv-view-home .lv-theme-toggle{width:44px;height:44px;border-radius:22px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);color:var(--tx);
    display:flex;align-items:center;justify-content:center;cursor:pointer;
    transition:background .2s ease,color .2s ease,transform .2s ease}
  #lptv-view-home .lv-theme-toggle:hover{background:var(--glass-2-hover-fill);transform:scale(1.06)}
  #lptv-view-home .lv-settings-btn{width:44px;height:44px;border-radius:22px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);color:var(--tx);
    display:flex;align-items:center;justify-content:center;cursor:pointer;
    transition:background .2s ease,color .2s ease,transform .2s ease}
  #lptv-view-home .lv-settings-btn:hover{background:var(--glass-2-hover-fill);transform:scale(1.06)}
  /* 按钮悬停文字标签: 柱状排列, 只在 hover 时浮现 */
  #lptv-view-home .lv-hbtn-wrap{position:relative;display:flex;align-items:center;justify-content:center}
  /* 悬停标签绝对定位在按钮下方: 不再占布局高度, 避免把主题/设置按钮顶高使其与
     时间胶囊水平错位 (wrap 高度=按钮44px, 与胶囊 44px 对齐)。 */
  #lptv-view-home .lv-hbtn-label{position:absolute;top:calc(100% + 6px);left:50%;
    transform:translateX(-50%);font-size:11px;font-weight:500;color:transparent;
    letter-spacing:.3px;white-space:nowrap;pointer-events:none;transition:color .2s ease}
  #lptv-view-home .lv-hbtn-wrap:hover .lv-hbtn-label{color:var(--tx)}
  #lptv-view-home .lv-time-capsule{height:44px;padding:0 18px;border-radius:22px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);
    display:flex;align-items:center;gap:12px;font-weight:400;font-size:14px}
  /* 首页时间胶囊: 常驻显示 (不再由 idle 门控 opacity:0 → 与主题/设置图标同步出现,
     不再"加载慢一点"; 空闲自动隐藏已取消)。 */
  #lptv-view-home .lv-clock-line{display:inline-block;white-space:nowrap}
  #lptv-view-home .lv-clock-line b{font-size:20px;font-weight:600;letter-spacing:.5px;line-height:1}
  #lptv-view-home .lv-clock-line .lv-date{font-size:14px;font-weight:400;line-height:1;
    color:var(--tx2);margin-left:12px}
  #lptv-view-home .lv-home-scroll{flex:1;overflow-y:auto;margin-top:40px;padding-bottom:0;
    scrollbar-width:none;-ms-overflow-style:none}
  #lptv-view-home .lv-home-scroll::-webkit-scrollbar{width:0;height:0;display:none}
  #lptv-view-home .lv-group{margin-bottom:20px}
  #lptv-view-home .lv-group-head{display:flex;align-items:center;gap:14px}
  #lptv-view-home .lv-group-bar{width:6px;height:26px;border-radius:3px;background:var(--accent)}
  #lptv-view-home .lv-group[data-group=卫视] .lv-group-bar,
  #lptv-view-home .lv-group[data-group=地方] .lv-group-bar,
  #lptv-view-home .lv-group[data-group=其他] .lv-group-bar{background:var(--accent2)}
  #lptv-view-home .lv-group-title{font-size:26px;font-weight:700;line-height:1.2}
  #lptv-view-home .lv-group-count{font-size:15px;font-weight:400;color:var(--tx2)}
  #lptv-view-home .lv-group-line{flex:1;height:1px;background:var(--glass-2-fill)}
  /* 分组提示 / 展开全部 / 上次观看: 统一为与左下角操作提示一致的液态玻璃胶囊 */
  #lptv-view-home .lv-group-hint{display:flex;align-items:center;gap:8px;font-size:13px;
    font-weight:400;color:var(--tx2);height:40px;padding:0 16px;border-radius:20px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);
    box-shadow:inset 0 1px 0 var(--glass-1-hi-soft)}
  #lptv-view-home .lv-group-hint svg{opacity:.75}
  #lptv-view-home .lv-group-cards{display:grid;grid-template-columns:repeat(6,270px);
    gap:28px;padding-top:16px}
  #lptv-view-home .lv-card{box-sizing:border-box;height:140px;border-radius:24px;background:var(--glass-2-fill);
    border:1px solid var(--glass-2-stroke);box-shadow:0 10px 30px rgba(0,0,0,.28);
    cursor:pointer;display:flex;flex-direction:column;justify-content:space-between;
    padding:18px;position:relative;transition:background .16s,transform .16s,box-shadow .16s}
  #lptv-view-home .lv-card:hover{background:var(--glass-2-active-fill);transform:translateY(-2px);
    box-shadow:0 16px 40px rgba(0,0,0,.4)}
  #lptv-view-home .lv-card.cur{background:var(--glass-2-active-fill);border:2px solid var(--tx);
    box-shadow:0 16px 40px rgba(0,0,0,.4)}
  /* 键盘/遥控焦点 (仅移动焦点, 不播放): 蓝色描边 + 外发光, 与"正在播放"白框区分。
     OK/Enter/Space 才播放焦点卡片。 */
  #lptv-view-home .lv-card.focus{background:rgba(77,124,254,.24);border:2px solid var(--accent2);
    box-shadow:0 0 0 3px rgba(77,124,254,.40),0 16px 40px rgba(0,0,0,.45);
    transform:translateY(-2px)}
  /* 卡片顶部: 频道号 + 直播徽标 (设计稿) */
  #lptv-view-home .lv-card-top{display:flex;align-items:center;justify-content:space-between;height:24px}
  /* 频道号: 重点元素之一 — 放大加粗、强调色, 一眼可读 */
  #lptv-view-home .lv-card-num{font-family:Inter,sans-serif;font-size:24px;font-weight:800;
    color:var(--accent2);letter-spacing:.02em;line-height:1}
  #lptv-view-home .lv-card.cur .lv-card-num{color:var(--tx)}
  #lptv-view-home .lv-live-badge{height:24px;padding:0 10px;border-radius:12px;
    background:rgba(255,90,90,.2);border:1px solid rgba(255,90,90,.4);color:#ffd9d9;
    display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500}
  #lptv-view-home .lv-card.cur .lv-live-badge{background:rgba(255,90,90,.25);
    border-color:rgba(255,90,90,.45);color:#ffdede}
  #lptv-view-home .lv-live-dot{width:6px;height:6px;border-radius:50%;background:var(--live)}
  #lptv-view-home .lv-card-bottom{display:flex;align-items:center;gap:14px}
  /* 台标: 放大显示, object-fit:contain 等比完整显示(不压缩、不变形、不裁切) */
  #lptv-view-home .lv-card-logo{width:60px;height:60px;border-radius:16px;background:var(--logo);
    display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}
  #lptv-view-home .lv-card-logo img{width:100%;height:100%;object-fit:contain}
  #lptv-view-home .lv-card-meta{min-width:0}
  /* 频道名称: 重点元素之一 — 主字号, 单行省略 */
  #lptv-view-home .lv-card-name{font-size:20px;font-weight:600;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  /* 旧的副标题小字(记录/电影/卫视等)已从卡片移除, 保留规则仅兼容旧渲染 */
  /* 展开态: 只显示台标 (无文字) — 密集 logo 方砖, 自动填满整行 */
  #lptv-view-home .lv-group.expanded .lv-group-cards{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
    gap:16px}
  #lptv-view-home .lv-card-icon{height:150px;border-radius:20px;padding:12px 8px 10px;
    justify-content:center;align-items:center;gap:8px}
  #lptv-view-home .lv-card-icon .lv-card-logo{width:64px;height:64px;border-radius:18px}
  #lptv-view-home .lv-card-icon .lv-card-logo img{width:52px;height:52px}
  /* 展开态卡片: 台标下方的频道号 + 频道名称 */
  #lptv-view-home .lv-card-expanded-meta{display:flex;align-items:center;justify-content:center;
    gap:6px;max-width:100%;min-width:0;font-size:12px;font-weight:600;color:var(--tx2);line-height:1.2}
  #lptv-view-home .lv-card-expanded-num{font-family:Inter,sans-serif;font-size:14px;font-weight:800;
    color:var(--accent2);flex-shrink:0;letter-spacing:.02em}
  #lptv-view-home .lv-card-expanded-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  /* 折叠/展开切换: 右下角胶囊按钮 (sticky 定位由外层透明 wrap 承担, 按钮自身
     才是胶囊, 避免整行背景被拉宽) */
  #lptv-view-home .lv-home-toggle-wrap{position:sticky;bottom:0;z-index:2;display:flex;
    justify-content:flex-end;margin-top:8px;padding:6px 0 2px;pointer-events:none}
  #lptv-view-home .lv-home-toggle{display:flex;align-items:center;gap:6px;height:40px;
    padding:0 18px;border-radius:20px;background:var(--glass-2-fill);
    border:1px solid var(--glass-2-stroke);color:var(--tx2);font-size:14px;
    cursor:pointer;user-select:none;pointer-events:auto;
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);
    box-shadow:inset 0 1px 0 var(--glass-1-hi-soft);transition:background .16s,color .16s}
  #lptv-view-home .lv-home-toggle:hover{color:var(--tx);background:var(--glass-2-hover-fill)}
  #lptv-view-home .lv-home-toggle .lv-arrow{transition:transform .2s;font-size:11px;color:var(--tx3)}
  #lptv-view-home .lv-home-toggle.expanded .lv-arrow{transform:rotate(180deg)}
  /* 底部操作提示 (设计稿: 液态玻璃胶囊) */
  #lptv-view-home .lv-home-foot{flex-shrink:0;display:flex;align-items:center;
    justify-content:space-between;padding-top:28px}
  #lptv-view-home .lv-home-tips{height:48px;padding:0 18px;border-radius:24px;
    display:flex;align-items:center;gap:14px;background:var(--glass-2-fill);
    border:1px solid var(--glass-2-stroke);font-size:14px;color:var(--tx2);
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%)}
  #lptv-view-home .lv-home-tips .tip{display:flex;align-items:center;gap:8px}
  #lptv-view-home .lv-home-tips .sep{width:1px;height:16px;background:var(--glass-2-active-fill)}
  #lptv-view-home .lv-home-tips svg{opacity:.7}
  #lptv-view-home .lv-home-last{display:flex;align-items:center;height:48px;padding:0 18px;
    border-radius:24px;background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);
    font-size:14px;font-weight:400;color:var(--tx2);
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);
    box-shadow:inset 0 1px 0 var(--glass-1-hi-soft)}
  #lptv-root.perf .lv-home-tips{backdrop-filter:none;-webkit-backdrop-filter:none}

  /* 播放界面 (状态2/3) — 设计稿 d9c-1: 液态玻璃信息层 + 玻璃控制栏 */
  #lptv-view-playing{position:absolute;inset:0;flex-direction:column;overflow:hidden;background:transparent}
  #lptv-view-playing .lv-play-mask-top{position:absolute;left:0;right:0;top:0;height:280px;
    background:linear-gradient(180deg,rgba(5,7,14,.85),rgba(5,7,14,0));
    pointer-events:none}
  #lptv-view-playing .lv-play-mask-bottom{position:absolute;left:0;right:0;bottom:0;height:300px;
    background:linear-gradient(0deg,rgba(5,7,14,.78),transparent);pointer-events:none}
  #lptv-view-playing .lv-play-top{position:absolute;left:64px;right:64px;top:48px;height:68px;
    display:flex;align-items:flex-start;justify-content:space-between}
  #lptv-view-playing .lv-play-top-time{justify-content:flex-end}
  #lptv-view-playing .lv-play-top .lv-play-status{opacity:0;visibility:hidden;transition:opacity .18s}
  #lptv-root.show-controls[data-state=playing] #lptv-view-playing .lv-play-top .lv-play-status{
    opacity:1;visibility:visible}
  #lptv-root.show-controls[data-state=playing] #lptv-view-playing .lv-play-top{display:flex}
  #lptv-view-playing .lv-play-ch{display:flex;align-items:center;gap:18px}
  #lptv-view-playing .lv-play-logo{width:68px;height:68px;border-radius:22px;background:var(--logo);
    display:flex;align-items:center;justify-content:center;overflow:hidden;
    box-shadow:0 10px 26px rgba(0,0,0,.35)}
  #lptv-view-playing .lv-play-logo img{width:52px;height:52px;object-fit:contain}
  #lptv-view-playing .lv-play-name-row{display:flex;align-items:center;gap:10px}
  #lptv-view-playing .lv-play-name{font-size:26px;font-weight:700;line-height:1.23}
  #lptv-view-playing .lv-live-badge{height:26px;padding:0 12.67px;border-radius:13px;
    background:rgba(255,90,90,.3);border:1px solid rgba(255,90,90,.5);color:#fff;
    display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500}
  #lptv-view-playing .lv-live-dot{width:6px;height:6px;border-radius:50%;background:#ff5a5a}
  #lptv-view-playing .lv-quality-badge{height:26px;padding:0 12.67px;border-radius:13px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);color:#fff;
    display:inline-flex;align-items:center;font-size:12px;font-weight:600;
    font-family:Inter,sans-serif;letter-spacing:.083px}
  #lptv-view-playing .lv-play-sub{margin-top:8px;font-size:16px;line-height:1.5;
    color:var(--tx2)}
  #lptv-view-playing .lv-play-status{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
  #lptv-view-playing .lv-time-hint{height:42px;padding:0 16.67px;border-radius:21px;gap:10px;
    background:rgba(0,0,0,.25);border:1px solid var(--glass-2-stroke);
    display:flex;align-items:center;font-size:20px;font-weight:600;
    backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
  #lptv-view-playing .lv-time-hint #lv-time-hint{font-family:Inter,sans-serif;font-size:20px;
    font-weight:600;line-height:1.2}
  #lptv-view-playing .lv-time-date{font-size:14px;font-weight:400;color:var(--tx3)}
  /* 音量组件: 点击音量按钮后右侧浮出 —— 上方静音图标(点击切换), 下方竖向刻度条
     (上下拖动/点击调节)。替代原来的横向小胶囊。 */
  #lptv-view-playing .lv-vol-hint{position:absolute;top:50%;right:64px;z-index:3;
    transform:translateY(-50%);width:56px;padding:12px 0 14px;border-radius:28px;
    background:rgba(0,0,0,.45);border:1px solid var(--glass-2-stroke);
    display:none;flex-direction:column;align-items:center;gap:12px;
    font-size:12px;font-weight:600;color:var(--tx);
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%)}
  #lptv-view-playing .lv-vol-hint .lv-vol-ico{display:flex;align-items:center;
    justify-content:center;width:40px;height:40px;border-radius:20px;
    color:var(--tx);cursor:pointer;transition:background .14s}
  #lptv-view-playing .lv-vol-hint .lv-vol-ico:hover{background:rgba(255,255,255,.14)}
  #lptv-view-playing .lv-vol-hint .lv-vol-track{position:relative;width:8px;height:170px;
    border-radius:4px;background:var(--glass-2-active-fill);overflow:hidden;
    cursor:pointer;touch-action:none}
  #lptv-view-playing .lv-vol-hint .lv-vol-fill{position:absolute;left:0;right:0;bottom:0;
    height:0;border-radius:4px;background:#4d7cfe;transition:height .15s ease;
    pointer-events:none}

  /* 播放控制栏 (状态3): 默认隐藏, root.show-controls 时显示 */
  #lptv-view-playing .lv-play-controls{position:absolute;left:64px;right:64px;bottom:52px;
    display:none;flex-direction:column;gap:10px}
  #lptv-root.show-controls[data-state=playing] #lptv-view-playing .lv-play-controls{display:flex}
  #lptv-view-playing .lv-progress-row{display:flex;align-items:center;gap:18px}
  #lptv-view-playing .lv-prog-name-wrap{display:flex;align-items:center;gap:10px;flex:0 0 auto}
  #lptv-view-playing .lv-prog-ico{color:#6AA8FF;display:flex;align-items:center}
  #lptv-view-playing .lv-prog-name{font-size:16px;font-weight:500;color:var(--tx);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
  #lptv-view-playing .lv-prog-track{flex:1;height:6px;border-radius:3px;background:var(--glass-2-active-fill);
    position:relative;cursor:pointer}
  #lptv-view-playing .lv-prog-fill{position:absolute;left:0;top:0;height:100%;border-radius:3px;
    background:#4d7cfe}
  #lptv-view-playing .lv-prog-dot{position:absolute;top:50%;width:14px;height:14px;border-radius:50%;
    background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 8px rgba(255,255,255,.5)}
  #lptv-view-playing .lv-prog-time{display:flex;align-items:center;gap:6px;font-size:14px;
    font-family:Inter,sans-serif;font-weight:500;color:var(--tx);flex:0 0 auto}
  #lptv-view-playing .lv-prog-time .sep{color:var(--tx3);font-weight:400}
  #lptv-view-playing .lv-prog-time #lv-prog-end{color:var(--tx3)}
  /* 控制栏: 4 个胶囊按钮直接浮在画面/进度条下方 —— 去掉后面那条透明玻璃底
     (背景/描边/模糊/投影全去), 只保留按钮本身。高度收成按钮高, 进度条因此下移
     贴近按钮(间距 gap 由 .lv-play-controls 控制)。 */
  #lptv-view-playing .lv-glass-bar{height:68px;padding:0;
    display:flex;align-items:center;justify-content:space-between}
  #lptv-view-playing .lv-bar-col{width:572.89px;display:flex;align-items:center}
  #lptv-view-playing .lv-bar-col.center{justify-content:center;flex-direction:column;gap:8px}
  #lptv-view-playing .lv-bar-col.right{justify-content:flex-end}
  #lptv-view-playing .lv-bar-btn{height:68px;padding:0 26.67px;border-radius:34px;
    border:1px solid var(--glass-2-stroke);background:var(--glass-2-fill);color:#fff;
    cursor:pointer;font-size:19px;font-weight:600;line-height:1.26;
    display:flex;align-items:center;gap:12px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28);transition:background .16s}
  #lptv-view-playing .lv-bar-btn:hover{background:var(--glass-2-active-fill)}
  #lptv-view-playing .lv-bar-btn .ico{display:flex;align-items:center}
  /* 图标/文字子元素显式手型: 个别环境 hover 命中子元素时 cursor 不继承到
     按钮(表现为只有按钮下半部分变小手), 显式声明保证整个胶囊区域都是手型。 */
  #lptv-view-playing .lv-bar-btn *,
  #lptv-view-home .lv-theme-toggle *,
  #lptv-view-home .lv-settings-btn *{cursor:pointer}
  /* 中间首页/音量按钮: 与 频道/节目单 同款玻璃胶囊(图标左+文字右), 不再用圆钮。
     pill 外观复用 .lv-bar-btn; 这里只补中间行布局与静音态。 */
  #lptv-view-playing .lv-bar-center-row{display:flex;align-items:center;gap:14px}
  #lptv-view-playing .lv-bar-vol.muted{color:#ff8a8a;border-color:rgba(255,138,138,.5);
    background:rgba(255,138,138,.18)}

  /* 左侧频道面板 (状态4) — 设计稿 dcc-1: 液态玻璃面板 + 圆角控件 */
  #lptv-view-left{position:absolute;inset:0;background:rgba(5,7,14,.45)}
  #lptv-view-left .lv-left-panel{position:absolute;left:0;top:0;bottom:0;width:620px;
    background:var(--panel);border-right:1px solid var(--glass-1-stroke);
    box-shadow:24px 0 60px rgba(0,0,0,.5),inset 0 1px 0 var(--glass-1-hi-soft);
    backdrop-filter:blur(30px) saturate(160%);-webkit-backdrop-filter:blur(30px) saturate(160%);
    display:flex;flex-direction:column;padding:44px 36px 32px}
  #lptv-view-left .lv-left-head{height:44px;display:flex;align-items:center;justify-content:space-between;
    flex-shrink:0}
  #lptv-view-left .lv-left-title{display:flex;align-items:center;gap:12px;font-size:28px;font-weight:700}
  #lptv-view-left .lv-left-bar{width:6px;height:26px;border-radius:3px;background:var(--accent)}
  #lptv-view-left .lv-left-tabs{display:flex;height:54px;gap:12px;margin-top:24px;flex-shrink:0}
  #lptv-view-left .lv-left-tab{flex:1;height:54px;display:flex;align-items:center;justify-content:center;
    font-size:18px;font-weight:500;border-radius:27px;background:var(--glass-2-fill);
    border:1px solid var(--glass-2-stroke);color:var(--tx2);cursor:pointer;
    transition:background .14s,color .14s}
  #lptv-view-left .lv-left-tab.on{background:#fff;color:#0b1020;border-color:transparent;
    font-weight:700;box-shadow:0 10px 26px rgba(0,0,0,.35)}
  #lptv-view-left .lv-left-list{flex:1;overflow-y:auto;padding:20px 0 0;display:flex;
    flex-direction:column;gap:8px;scrollbar-width:none;-ms-overflow-style:none}
  #lptv-view-left .lv-left-list::-webkit-scrollbar{width:0;height:0}
  #lptv-view-left .lv-left-item{height:68px;flex-shrink:0;display:flex;align-items:center;gap:12px;
    border-radius:20px;background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);
    padding:0 14px;position:relative;cursor:pointer;transition:background .14s,border-color .14s}
  #lptv-view-left .lv-left-item:hover{background:var(--glass-2-fill)}
  #lptv-view-left .lv-left-item.cur{background:var(--glass-2-active-fill);border-color:var(--tx3)}
  #lptv-view-left .lv-left-num{width:26px;flex-shrink:0;font-family:Inter,sans-serif;font-size:15px;
    font-weight:600;color:var(--tx2);letter-spacing:.2px}
  #lptv-view-left .lv-left-logo{width:40px;height:40px;border-radius:12px;background:var(--logo);flex-shrink:0;
    display:flex;align-items:center;justify-content:center;overflow:hidden}
  #lptv-view-left .lv-left-logo img{width:30px;height:30px;object-fit:contain}
  #lptv-view-left .lv-left-name{flex:1;min-width:0;font-size:18px;font-weight:600;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  #lptv-view-left .lv-left-playing{display:flex;align-items:center;gap:6px;flex-shrink:0;
    font-size:13px;font-weight:500;color:#9cc4ff}
  #lptv-view-left .lv-left-playing .bar{width:4px;height:14px;border-radius:2px;background:var(--accent2)}
  #lptv-view-left .lv-left-prog{flex-shrink:0;max-width:190px;font-size:13px;font-weight:400;
    color:var(--tx3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #lptv-view-left .lv-left-foot{height:21px;flex-shrink:0;margin-top:18px;display:flex;align-items:center;
    justify-content:space-between;font-size:13px;color:var(--tx3)}
  #lptv-view-left .lv-left-foot .hint{display:flex;align-items:center;gap:6px}

  /* 右侧节目单面板 (状态5) — 设计稿 53d: 液态玻璃面板 + 圆角控件 */
  #lptv-view-right{position:absolute;inset:0;background:rgba(5,7,14,.45)}
  #lptv-view-right .lv-right-panel{position:absolute;right:0;top:0;bottom:0;width:780px;
    background:var(--panel);border-left:1px solid var(--glass-1-stroke);
    box-shadow:-24px 0 60px rgba(0,0,0,.5),inset 0 1px 0 var(--glass-1-hi-soft);
    backdrop-filter:blur(30px) saturate(160%);-webkit-backdrop-filter:blur(30px) saturate(160%);
    display:flex;flex-direction:column;padding:44px 36px 32px}
  #lptv-view-right .lv-right-head{height:44px;display:flex;align-items:center;justify-content:space-between;
    flex-shrink:0}
  #lptv-view-right .lv-right-title{display:flex;align-items:center;gap:12px;font-size:28px;font-weight:700}
  #lptv-view-right .lv-right-ch{font-size:14px;font-weight:400;color:var(--tx3)}
  #lptv-view-right .lv-right-bar{width:6px;height:26px;border-radius:3px;background:var(--accent)}
  #lptv-view-right .lv-right-tabs{display:flex;height:68px;gap:12px;margin-top:22px;flex-shrink:0}
  #lptv-view-right .lv-right-tab{flex:1;height:68px;border-radius:20px;display:flex;
    flex-direction:column;align-items:center;justify-content:center;gap:2px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);
    color:var(--tx2);cursor:pointer;transition:background .14s,color .14s}
  #lptv-view-right .lv-right-tab.on{background:#fff;color:#0b1020;border-color:transparent;
    box-shadow:0 10px 26px rgba(0,0,0,.35)}
  #lptv-view-right .lv-right-tab .dt{font-size:15px;font-weight:600;opacity:.8}
  #lptv-view-right .lv-right-tab .dw{font-size:20px;font-weight:700}
  #lptv-view-right .lv-right-tab.on .dt{font-weight:600;opacity:.72}
  #lptv-view-right .lv-right-tab.on .dw{font-weight:700}
  #lptv-view-right .lv-right-list{flex:1;overflow-y:auto;padding:20px 0 0;display:flex;
    flex-direction:column;gap:10px;scrollbar-width:none;-ms-overflow-style:none}
  #lptv-view-right .lv-right-list::-webkit-scrollbar{width:0;height:0}
  #lptv-view-right .lv-right-item{height:72px;flex-shrink:0;display:flex;align-items:center;gap:14px;
    border-radius:20px;background:var(--glass-2-fill-weak);border:1px solid var(--glass-2-stroke-weak);
    padding:0 16px;cursor:pointer;transition:background .14s,border-color .14s}
  #lptv-view-right .lv-right-item:hover{background:var(--glass-2-fill)}
  #lptv-view-right .lv-right-item.now{height:80px;border-radius:22px;
    background:var(--glass-2-active-fill);border-color:var(--tx3)}
  #lptv-view-right .lv-right-item.focus{border-color:var(--accent2);
    box-shadow:0 0 0 2px rgba(77,124,254,.55),0 12px 30px rgba(0,0,0,.4)}
  #lptv-view-right .lv-right-time{width:46px;flex-shrink:0;font-family:Inter,sans-serif;
    font-size:15px;font-weight:500;color:var(--tx3)}
  #lptv-view-right .lv-right-item.now .lv-right-time{color:#9cc4ff;font-weight:600}
  #lptv-view-right .lv-right-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
  #lptv-view-right .lv-right-pt{font-size:17px;font-weight:500;color:var(--tx3);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #lptv-view-right .lv-right-item.now .lv-right-pt{color:#fff;font-weight:600}
  #lptv-view-right .lv-right-prog{display:flex;align-items:center;gap:8px}
  #lptv-view-right .lv-right-prog .track{width:220px;height:4px;border-radius:2px;
    background:var(--glass-2-active-fill);position:relative;flex-shrink:0}
  #lptv-view-right .lv-right-prog .fill{position:absolute;left:0;top:0;height:100%;
    border-radius:2px;background:var(--accent2)}
  #lptv-view-right .lv-right-prog .pct{font-size:12px;color:var(--tx3)}
  #lptv-view-right .lv-right-status{flex-shrink:0;font-size:13px;color:var(--tx-weak)}
  #lptv-view-right .lv-right-badge{flex-shrink:0;height:28px;padding:0 12px;border-radius:14px;
    display:inline-flex;align-items:center;gap:6px;background:rgba(77,124,254,.3);
    border:1px solid rgba(77,124,254,.6);color:#fff;font-size:13px;font-weight:600}
  #lptv-view-right .lv-right-badge .dot{width:6px;height:6px;border-radius:3px;background:var(--accent2)}
  #lptv-view-right .lv-right-book{flex-shrink:0;height:36px;padding:0 16px;border-radius:18px;
    display:inline-flex;align-items:center;gap:6px;background:var(--glass-2-fill);
    border:1px solid var(--glass-2-stroke);color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  #lptv-view-right .lv-right-book.on{background:var(--accent);border-color:var(--accent2);
    box-shadow:0 0 20px rgba(77,124,254,.35)}
  #lptv-view-right .lv-right-foot{height:24px;flex-shrink:0;margin-top:18px;display:flex;
    align-items:center;justify-content:space-between;font-size:13px;color:var(--tx3)}
  #lptv-view-right .lv-right-foot .warn{color:var(--tx3)}

  /* 面板背后的液态玻璃胶囊 (设计稿右侧/左侧画面区信息层) */
  #lptv-root .lv-glass-capsule{position:relative;height:56px;display:flex;align-items:center;gap:12px;padding:0 18px;
    border-radius:28px;background:var(--glass-3-fill);border:1px solid var(--glass-3-stroke);
    color:var(--tx);font-size:15px;
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);
    box-shadow:inset 0 1px 0 var(--glass-1-hi-soft)}
  #lptv-root .lv-hint-capsule{position:relative;height:44px;display:flex;align-items:center;gap:8px;padding:0 18px;
    border-radius:22px;background:var(--glass-3-fill);border:1px solid var(--glass-3-stroke);
    color:var(--tx2);font-size:14px;
    backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%)}
  #lptv-root .lv-hint-capsule svg{opacity:.7}
  #lptv-view-left .lv-left-scene{position:absolute;left:620px;right:0;top:0;bottom:0;
    padding:48px 56px;display:flex;flex-direction:column;justify-content:flex-end;
    pointer-events:auto;cursor:pointer}
  #lptv-view-right .lv-right-scene{position:absolute;left:0;top:0;bottom:0;width:1140px;
    padding:48px 56px;display:flex;flex-direction:column;justify-content:flex-end;
    pointer-events:auto;cursor:pointer}
  /* 面板/播放控制栏不再做 --lv-panel-dx 平移补偿 (已移除): 该补偿按单一环境实测
     偏移 (1425*(1-s)) 校准, 在 CDE/容器窗口尺寸下过补偿, 导致频道/节目单面板与
     播放控制栏水平错位 (实测非 perf 下布局本就正确, 平移是错位唯一来源)。
     恢复自然定位 (transform:none), 与面板滑入滑出动画(在子元素上)不冲突。 */
  /* 频道/节目单面板滑入滑出: 频道从左侧滑入(向右), 节目单从右侧滑入(向左)。
     过渡用 iOS 式抽屉曲线 cubic-bezier(.32,.72,0,1) (animate 技能推荐), 比原
     .16,1,.3,1 生硬快起更柔和顺滑; 时长加长到 ~360ms 让滑入更舒缓; 容器淡入淡出
     改 ease-out (不用 ease-in, 避免开头迟钝)。
     滑出(关闭)用缓动曲线 cubic-bezier(.42,0,.58,1)(ease-in-out) + 与淡出同长 .32s:
     原用 .4,0,.2,1 快中段, 在软件合成(低帧率)下中段单帧位移过大(实测 .32s 曲线
     单帧最大位移 367px, ease-in-out 仅 202px), 且宽节目单(780px)比频道(620px)更
     明显 → 视觉上"先显示又瞬移/回弹"而非平滑滑出; ease-in-out 峰值速度更低, 低
     帧率下每帧位移更均匀, 滑出全程可见。淡出 .32s 与滑出同长避免面板先淡尽再滑动。 */
  /* 面板滑入/滑出全部由 JS 驱动 (slidePanelIn / closeOverlay 用内联 transition
     从屏外滑到 0 / 从当前位移滑出)。这里不再给面板写 keyframe 滑入:
     两套机制并存时 keyframe 会压制内联 transition, 导致节目单"直接出现"
     而不是从右往左滑入。CSS 只负责视图容器(暗化背板)的淡入淡出。 */
  #lptv-root[data-state=leftPanel] #lptv-view-left{animation:lvFadeIn .26s ease-out both}
  #lptv-root[data-state=rightPanel] #lptv-view-right{animation:lvFadeIn .26s ease-out both}
  @keyframes lvFadeIn{from{opacity:0}to{opacity:1}}
  /* 面板滑出由 closeOverlay 用 transition 从"当前位移"起画(px→px); 这里仅保留视图淡出。 */
  #lptv-root[data-state=leftPanel] #lptv-view-left.lv-panel-out{animation:lvFadeOut .32s ease-out both}
  #lptv-root[data-state=rightPanel] #lptv-view-right.lv-panel-out{animation:lvFadeOut .32s ease-out both}
  @keyframes lvFadeOut{from{opacity:1}to{opacity:0}}
  @media (prefers-reduced-motion: reduce){
    #lptv-root[data-state=leftPanel] #lptv-view-left,
    #lptv-root[data-state=rightPanel] #lptv-view-right,
    #lptv-root[data-state=leftPanel] #lptv-view-left.lv-panel-out,
    #lptv-root[data-state=rightPanel] #lptv-view-right.lv-panel-out{animation:none}
  }
  #lptv-root .lv-scene-top{display:flex;align-items:flex-start;justify-content:space-between}
  #lptv-root .lv-scene-bottom{display:flex;align-items:center;gap:18px}
  /* 频道面板打开时, 返回/OK 提示在右侧画面区的最右边 (设计稿 dcc-1);
     节目单面板打开时保持左侧 (设计稿 53d) */
  #lptv-view-left .lv-scene-bottom{justify-content:flex-end}
  #lptv-root .lv-cap-logo{width:34px;height:34px;border-radius:11px;background:var(--logo);flex-shrink:0;
    display:flex;align-items:center;justify-content:center;overflow:hidden}
  #lptv-root .lv-cap-logo img{width:26px;height:26px;object-fit:contain}
  #lptv-root .lv-clock-capsule{height:42px;border-radius:21px;gap:10px;padding:0 16px}
  #lptv-root .lv-clock-time{font-size:20px;font-weight:600}
  #lptv-root .lv-clock-date{font-size:14px;color:var(--tx3)}
  #lptv-root .lv-scene-ch{display:flex;align-items:center;gap:16px}
  #lptv-root .lv-scene-logo{width:60px;height:60px;border-radius:19px;background:var(--logo);
    display:flex;align-items:center;justify-content:center;overflow:hidden;
    box-shadow:0 10px 26px rgba(0,0,0,.35)}
  #lptv-root .lv-scene-logo img{width:44px;height:44px;object-fit:contain}
  #lptv-root .lv-scene-info{display:flex;flex-direction:column;gap:6px}
  #lptv-root .lv-scene-name-row{display:flex;align-items:center;gap:10px}
  #lptv-root .lv-scene-name{font-size:24px;font-weight:700}
  #lptv-root .lv-scene-live{height:24px;padding:0 10px;border-radius:12px;
    background:rgba(255,90,90,.3);border:1px solid rgba(255,90,90,.5);color:#fff;
    font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
  #lptv-root .lv-scene-live .lv-live-dot{width:6px;height:6px;border-radius:50%;
    background:var(--live);display:inline-block}
  #lptv-root .lv-scene-sub{font-size:15px;color:var(--tx2)}

  /* 容器(软件合成)下关闭毛玻璃, 保留半透明玻璃底色 */
  #lptv-root.perf .lv-left-panel,#lptv-root.perf .lv-right-panel,
  #lptv-root.perf .lv-glass-capsule,#lptv-root.perf .lv-hint-capsule,
  #lptv-root.perf .lv-group-hint,#lptv-root.perf .lv-home-toggle,
  #lptv-root.perf .lv-home-last,
  #lptv-root.perf .lv-vol-hint,#lptv-root.perf .lv-time-hint{
    backdrop-filter:none;-webkit-backdrop-filter:none}
  #lptv-root.perf .lv-glass-bar{backdrop-filter:none;-webkit-backdrop-filter:none}
  #lptv-root.perf .lv-card::after,#lptv-root.perf .lv-left-item::after,#lptv-root.perf .lv-right-item::after,#lptv-root.perf .lv-set-row::after{transition:none}
  /* 软件合成下切台信息卡关闭毛玻璃, 用深色实底保证叠在视频上仍清晰 */
  #lptv-root.perf .lv-sw-card{
    backdrop-filter:none;-webkit-backdrop-filter:none;
    background:linear-gradient(180deg,rgba(22,26,38,.92),rgba(12,16,24,.86))}

  /* 切换台加载中 (状态6) — 全屏遮罩盖住上一频道 (不可见), 遮罩上显示
     中心光环/圆环/品牌图标 + 圆环下方信息卡。切台完成
     (画面真正就绪) 后整层随切换态一起淡出 → 遮罩/光环/图标/卡片
     全部消失, 直接进播放界面 (与重构前逻辑一致)。 */
  #lptv-view-switching{position:absolute;inset:0;background:transparent;pointer-events:none}
  /* 不透明暗色遮罩: 上一频道完全不可见 (不用抓帧, 也省掉 canvas+JPEG 编码) */
  #lptv-view-switching .lv-sw-dim{position:absolute;inset:0;background:#05070e}
  #lptv-root[data-state=switching] [data-view=playing]{display:flex}
  /* 切换态: 播放视图只保留视频作背景, 隐藏其装饰层/控制栏/顶栏 */
  #lptv-root[data-state=switching] #lptv-view-playing .lv-play-mask-top,
  #lptv-root[data-state=switching] #lptv-view-playing .lv-play-mask-bottom,
  #lptv-root[data-state=switching] #lptv-view-playing .lv-play-top,
  #lptv-root[data-state=switching] #lptv-view-playing .lv-play-controls{display:none}
  /* 切台页只保留最内圈: 220 圆 + 图标 + 弧; 外层 620/420 两圈已去掉。 */
  #lptv-view-switching .lv-sw-halo3{position:absolute;left:50%;top:50%;
    width:220px;height:220px;transform:translate(-50%,-50%);border-radius:50%;
    background:var(--glass-2-fill-weak);border:1px solid var(--glass-2-stroke-weak)}
  /* 圆+图标+信息卡作为一组垂直居中, 不再让卡片单独贴屏幕底部。 */
  #lptv-view-switching .lv-sw-stack{position:absolute;left:50%;top:50%;
    transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;
    gap:32px;pointer-events:none;animation:lvswin-stack .38s ease-out both}
  @keyframes lvswin-stack{from{opacity:0;transform:translate(-50%,calc(-50% + 8px))}
    to{opacity:1;transform:translate(-50%,-50%)}}
  @keyframes lvswin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  #lptv-view-switching .lv-sw-card{animation:lvswin .38s ease-out both;animation-delay:.05s}
  /* 信息卡随圆环一起作为 .lv-sw-stack 的成员垂直居中, 不再用 top:calc(50%+330px)。 */
  #lptv-view-switching .lv-sw-below{position:relative;left:auto;right:auto;top:auto;
    display:flex;justify-content:center;pointer-events:auto}
  #lptv-view-switching .lv-sw-card{width:460px;border-radius:28px;padding:20.67px 22.67px;
    background:var(--glass-1-fill);
    border:1px solid var(--glass-1-stroke);display:flex;flex-direction:column;
    backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);
    box-shadow:0 20px 50px rgba(0,0,0,.5),inset 0 1px 0 var(--glass-1-hi)}
  /* 切台信息卡盖在不透明 .lv-sw-dim 之上: backdrop-filter 只采样到不透明深色 →
     视觉零贡献, 却是软件渲染(智慧屏 xpra)下每帧全区域重采样 → 转圈卡顿的元凶。
     直接关闭该卡毛玻璃 (视觉不变), 消除切台动画卡顿。用 !important 压过浅色主题规则。 */
  #lptv-view-switching .lv-sw-card{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
  #lptv-view-switching .lv-sw-card-main{display:flex;align-items:center;gap:14px}
  #lptv-view-switching .lv-sw-logo{width:48px;height:48px;border-radius:15px;background:var(--logo);
    flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;
    box-shadow:0 10px 26px rgba(0,0,0,.35)}
  #lptv-view-switching .lv-sw-logo img{width:38px;height:38px;object-fit:contain}
  #lptv-view-switching .lv-sw-name{font-size:19px;font-weight:700;line-height:1.26}
  #lptv-view-switching .lv-sw-name-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
  #lptv-view-switching .lv-sw-status{height:24px;padding:0 10.67px;border-radius:12px;
    background:rgba(77,124,254,.3);border:1px solid rgba(77,124,254,.6);color:#fff;
    display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
  /* 频道号胶囊位于原"切换中"位置 (标题行右侧), 内容为频道数字并放大 */
  #lptv-view-switching .lv-sw-num-pill{height:28px;padding:0 12px;border-radius:14px;
    font-family:Inter,sans-serif;font-size:18px;font-weight:800;line-height:1;
    letter-spacing:.02em;gap:0}
  /* 百分比显示在进度条上方 (右对齐), 去掉底部信息行以降低卡片高度 */
  #lptv-view-switching .lv-sw-pct-row{display:flex;justify-content:flex-end;margin-top:12px;
    font-size:13px;line-height:1.2}
  #lptv-view-switching .lv-sw-pct-row .pct{font-family:Inter,sans-serif;font-weight:600;
    color:var(--tx2)}
  #lptv-view-switching .lv-sw-dot{width:6px;height:6px;border-radius:50%;background:#6AA8FF;
    animation:lvswdot 1s ease-in-out infinite}
  @keyframes lvswdot{0%,100%{opacity:.3}50%{opacity:1}}
  #lptv-view-switching .lv-sw-from-row{display:flex;align-items:center;gap:8px;margin-top:6px;
    font-size:13px;line-height:1.38}
  #lptv-view-switching .lv-sw-from{color:var(--tx3)}
  #lptv-view-switching .lv-sw-arrow{color:var(--tx3);display:flex;align-items:center}
  #lptv-view-switching .lv-sw-to{color:var(--tx)}
  #lptv-view-switching .lv-sw-track{margin-top:4px;height:5px;border-radius:3px;
    background:var(--glass-2-active-fill);overflow:hidden}
  #lptv-view-switching .lv-sw-fill{height:100%;border-radius:3px;background:#4d7cfe;
    transition:width .3s linear}
  #lptv-view-switching .lv-sw-info{margin-top:10px;display:flex;align-items:center;
    justify-content:space-between;font-size:12px;line-height:1.33}
  #lptv-view-switching .lv-sw-info .hint{color:var(--tx3)}
  #lptv-view-switching .lv-sw-info .pct{font-family:Inter,sans-serif;font-weight:600;
    color:var(--tx2)}
  #lptv-view-switching .lv-sw-center{position:relative;left:auto;top:auto;transform:none;
    display:flex;flex-direction:column;align-items:center;gap:0;animation:none}
  #lptv-view-switching .lv-sw-ring{width:260px;height:260px;position:relative}
  #lptv-view-switching .lv-sw-ring svg{position:absolute;inset:-2px;width:264px;height:264px;
    transform:rotate(-90deg)}
  #lptv-view-switching .lv-sw-arc{transform-origin:132px 132px;
    animation:lvswring 1.2s linear infinite}
  @keyframes lvswring{to{transform:rotate(360deg)}}
  #lptv-view-switching .lv-sw-ring .num{position:absolute;inset:0;display:flex;align-items:center;
    justify-content:center}
  #lptv-view-switching .lv-sw-ring .num img{width:108px;height:108px;object-fit:contain;
    filter:drop-shadow(0 6px 22px rgba(0,0,0,.6))}
  @media (prefers-reduced-motion: reduce){
    #lptv-view-switching .lv-sw-dot{animation:none;opacity:1}
    #lptv-view-switching .lv-sw-stack{animation:none}
    #lptv-view-switching .lv-sw-arc{animation:none}
    #lptv-view-switching .lv-sw-card{animation:none}
    #lptv-settings,#lptv-settings .lv-set-card-wrap{transition:none}
    #lptv-settings.open .lv-set-card-wrap{transform:none}
  }

  /* ============ 移动客户端 (懒猫微服移动端，非 APK) ============
     根节点铺满 WebView 视口，不使用 1920 画布缩放；只覆盖移动端会用的视图。
     全部限定 #lptv-root.mobile，CDE/智慧屏不受影响。 */
  #lptv-root.mobile{width:100vw;height:100vh;left:0;top:0;transform:none}
  #lptv-root.mobile #lptv-view-home{display:none!important}
  /* 顶部时间 */
  #lptv-root.mobile #lptv-view-playing .lv-play-top{left:16px;right:16px;top:12px;height:40px}
  #lptv-root.mobile #lptv-view-playing .lv-time-hint{height:34px;padding:0 12px;border-radius:17px}
  #lptv-root.mobile #lptv-view-playing .lv-time-hint #lv-time-hint{font-size:15px}
  #lptv-root.mobile #lptv-view-playing .lv-time-date{font-size:11px}
  #lptv-root.mobile #lptv-view-playing .lv-play-mask-top{height:90px}
  #lptv-root.mobile #lptv-view-playing .lv-play-mask-bottom{height:110px}
  /* 控制栏: 底部安全区，只保留频道/节目单 */
  #lptv-root.mobile #lptv-view-playing .lv-play-controls{left:12px;right:12px;bottom:12px;gap:8px}
  #lptv-root.mobile #lptv-view-playing .lv-progress-row{gap:10px}
  #lptv-root.mobile #lptv-view-playing .lv-prog-name{font-size:13px;max-width:160px}
  #lptv-root.mobile #lptv-view-playing .lv-prog-time{font-size:12px}
  #lptv-root.mobile #lptv-view-playing .lv-glass-bar{height:auto;padding:0}
  #lptv-root.mobile #lptv-view-playing .lv-bar-col{width:auto;flex:1}
  #lptv-root.mobile #lptv-view-playing .lv-bar-col.center{display:none}
  #lptv-root.mobile #lptv-view-playing .lv-bar-col.right{justify-content:flex-end}
  #lptv-root.mobile #lptv-view-playing .lv-bar-btn{height:48px;padding:0 16px;border-radius:24px;
    font-size:15px;gap:8px}
  #lptv-root.mobile #lptv-view-playing .lv-bar-btn .ico svg{width:20px;height:20px}
  #lptv-root.mobile #lptv-view-playing .lv-vol-hint{display:none!important}
  /* 控制条只保留 频道/节目单：音量走手机系统媒体音量（无按钮），首页视图隐藏。 */
  #lptv-root.mobile #lptv-view-playing .lv-bar-home,
  #lptv-root.mobile #lptv-view-playing .lv-bar-vol{display:none}
  /* 面板: 单侧侧栏，另一侧视频保持清晰（取消整层暗色遮罩） */
  #lptv-root.mobile #lptv-view-left,
  #lptv-root.mobile #lptv-view-right{background:transparent}
  /* 浅色主题的 #lptv-view-left/right 背景规则与上面同级且靠后，会盖住 transparent →
     面板打开时视频侧被 rgba(236,242,250,.55) 洗白。加移动端专属更高优先级覆盖。 */
  #lptv-root.mobile[data-theme=light] #lptv-view-left,
  #lptv-root.mobile[data-theme=light] #lptv-view-right{background:transparent}
  #lptv-root.mobile #lptv-view-left .lv-left-panel{width:55vw;padding:16px 14px 14px;box-sizing:border-box}
  #lptv-root.mobile #lptv-view-right .lv-right-panel{width:60vw;padding:16px 14px 14px;box-sizing:border-box}
  /* 画面区保留为关闭面板的点击区，只隐藏信息胶囊 */
  #lptv-root.mobile #lptv-view-left .lv-left-scene{left:55vw;padding:0}
  #lptv-root.mobile #lptv-view-right .lv-right-scene{width:40vw;padding:0}
  #lptv-root.mobile #lptv-view-left .lv-left-scene .lv-scene-bottom,
  #lptv-root.mobile #lptv-view-right .lv-right-scene .lv-scene-bottom{display:none}
  /* 面板内控件放大到触控尺寸 */
  #lptv-root.mobile #lptv-view-left .lv-left-head,
  #lptv-root.mobile #lptv-view-right .lv-right-head{height:32px}
  #lptv-root.mobile #lptv-view-left .lv-left-title,
  #lptv-root.mobile #lptv-view-right .lv-right-title{font-size:18px;gap:8px}
  #lptv-root.mobile #lptv-view-left .lv-left-bar,
  #lptv-root.mobile #lptv-view-right .lv-right-bar{width:4px;height:18px}
  #lptv-root.mobile #lptv-view-left .lv-left-tabs{margin-top:12px;height:44px;gap:8px}
  #lptv-root.mobile #lptv-view-left .lv-left-tab{height:44px;font-size:14px;border-radius:22px}
  #lptv-root.mobile #lptv-view-left .lv-left-list{padding-top:12px;gap:6px}
  #lptv-root.mobile #lptv-view-left .lv-left-item{height:52px;border-radius:14px;padding:0 10px;gap:8px}
  #lptv-root.mobile #lptv-view-left .lv-left-num{width:20px;font-size:12px}
  #lptv-root.mobile #lptv-view-left .lv-left-logo{width:30px;height:30px;border-radius:8px}
  #lptv-root.mobile #lptv-view-left .lv-left-logo img{width:22px;height:22px}
  #lptv-root.mobile #lptv-view-left .lv-left-name{font-size:14px}
  #lptv-root.mobile #lptv-view-left .lv-left-playing{font-size:11px}
  #lptv-root.mobile #lptv-view-left .lv-left-prog{font-size:11px;max-width:100px}
  #lptv-root.mobile #lptv-view-left .lv-left-foot{height:16px;margin-top:8px;font-size:11px}
  #lptv-root.mobile #lptv-view-right .lv-right-ch{font-size:11px}
  #lptv-root.mobile #lptv-view-right .lv-right-tabs{margin-top:12px;height:44px;gap:6px}
  #lptv-root.mobile #lptv-view-right .lv-right-tab{height:44px;border-radius:12px}
  #lptv-root.mobile #lptv-view-right .lv-right-tab .dt{font-size:12px}
  #lptv-root.mobile #lptv-view-right .lv-right-tab .dw{font-size:15px}
  #lptv-root.mobile #lptv-view-right .lv-right-list{padding-top:12px;gap:6px}
  #lptv-root.mobile #lptv-view-right .lv-right-item{height:54px;border-radius:14px;padding:0 10px;gap:8px}
  #lptv-root.mobile #lptv-view-right .lv-right-item.now{height:60px;border-radius:16px}
  #lptv-root.mobile #lptv-view-right .lv-right-time{width:34px;font-size:12px}
  #lptv-root.mobile #lptv-view-right .lv-right-pt{font-size:13px}
  #lptv-root.mobile #lptv-view-right .lv-right-prog .track{width:120px}
  #lptv-root.mobile #lptv-view-right .lv-right-prog .pct{font-size:10px}
  #lptv-root.mobile #lptv-view-right .lv-right-status{font-size:11px}
  #lptv-root.mobile #lptv-view-right .lv-right-badge{height:22px;padding:0 8px;font-size:11px;border-radius:11px}
  #lptv-root.mobile #lptv-view-right .lv-right-book{height:44px;padding:0 14px;border-radius:22px;font-size:13px}
  #lptv-root.mobile #lptv-view-right .lv-right-foot{height:16px;margin-top:8px;font-size:10px}
  /* 切台页按手机尺寸重排（动画/结构不变） */
  #lptv-root.mobile #lptv-view-switching .lv-sw-ring{width:160px;height:160px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-ring svg{inset:-1px;width:162px;height:162px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-halo3{width:140px;height:140px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-ring .num img{width:70px;height:70px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-stack{gap:16px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-card{width:300px;padding:12px 14px;border-radius:16px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-card-main{gap:10px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-logo{width:34px;height:34px;border-radius:10px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-logo img{width:26px;height:26px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-name{font-size:14px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-status{height:20px;padding:0 8px;font-size:10px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-num-pill{height:22px;padding:0 8px;
    border-radius:11px;font-size:14px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-pct-row{font-size:11px;margin-top:8px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-from-row{font-size:11px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-track{margin-top:10px;height:4px}
  #lptv-root.mobile #lptv-view-switching .lv-sw-info{margin-top:6px;font-size:10px}

  /* ============ 浅色主题 (data-theme=light) — 白色主题的液态玻璃 ============
     材质分层 (避免"浅色玻璃叠浅色玻璃"导致层次与可读性一起塌掉):
       · 结构层 (频道/节目单/设置侧栏) = 冷灰玻璃 (略深、强模糊), 作为更重的材料;
       · 交互层 (卡片/行/按钮/胶囊) = 亮白玻璃芯片 (更亮、高光顶边、发丝边、弥散投影)。
     背景保留图像/色彩供玻璃折射 —— 不再用近实白把背景洗掉, 否则白玻璃在白底上不可见。
     由首页右上角太阳/月亮按钮切换。 */
  #lptv-root[data-theme=light]{--bg:#eef1f6;
    --glass-1-fill:linear-gradient(180deg,rgba(245,248,254,.88),rgba(233,239,249,.78));
    --glass-1-stroke:rgba(255,255,255,.60);
    --glass-1-hi:rgba(255,255,255,.85);
    --glass-1-hi-soft:rgba(255,255,255,.85);
    --glass-1-shadow:0 18px 48px rgba(24,40,70,.24);
    --glass-2-fill:linear-gradient(180deg,rgba(255,255,255,.82),rgba(255,255,255,.60));
    --glass-2-fill-weak:linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,.52));
    --glass-2-hover-fill:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.74));
    --glass-2-active-fill:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.82));
    --glass-2-stroke:rgba(255,255,255,.74);
    --glass-2-stroke-weak:rgba(255,255,255,.66);
    --glass-2-hi:rgba(255,255,255,.92);
    --glass-3-fill:rgba(255,255,255,.70);
    --glass-3-stroke:rgba(255,255,255,.78);
    --tab-ind-fill:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.82));
    --sheen:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.55) 45%,transparent 60%);
    --line:rgba(20,35,60,.08);
    --tx:#1a2233;--tx2:#3a4763;--tx3:#5a6b8c;--tx-weak:#8a94ab;
    --panel:var(--glass-1-fill);--card:var(--glass-2-fill);--card-active:var(--glass-2-active-fill);
    --logo:#f4f6fb}

  /* ---------- 首页 ---------- */
  /* 背景保留约 30% 图像: 玻璃卡片才有可折射的底色; 白洗过度会让所有白玻璃消失 */
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-bg{
    background:
      radial-gradient(640px 320px at 10% 6%,rgba(77,124,254,.10),transparent 70%),
      radial-gradient(760px 360px at 92% 94%,rgba(79,209,197,.08),transparent 72%),
      linear-gradient(180deg,rgba(242,246,252,.60) 0%,rgba(226,234,246,.74) 100%);
    filter:none}
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-content{text-shadow:none}
  #lptv-root[data-theme=light] #lptv-view-home .lv-brand-text{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-home .lv-brand-sub{color:#3a4763}
  /* 顶栏控件: 白玻璃芯片 + 高光顶边 + 深色发丝边 + 弥散投影 (在白底上仍能立住) */
  #lptv-root[data-theme=light] #lptv-view-home .lv-theme-toggle,
  #lptv-root[data-theme=light] #lptv-view-home .lv-settings-btn,
  #lptv-root[data-theme=light] #lptv-view-home .lv-time-capsule{
    background:linear-gradient(180deg,rgba(255,255,255,.88),rgba(248,251,255,.62));
    border:1px solid rgba(255,255,255,.85);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.96),inset 0 -1px 0 rgba(20,35,60,.04),
      0 0 0 1px rgba(24,40,70,.05),0 8px 20px rgba(30,45,80,.10);
    backdrop-filter:blur(14px) saturate(180%);-webkit-backdrop-filter:blur(14px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-theme-toggle,
  #lptv-root[data-theme=light] #lptv-view-home .lv-settings-btn{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-home .lv-theme-toggle:hover,
  #lptv-root[data-theme=light] #lptv-view-home .lv-settings-btn:hover{
    background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(250,252,255,.74));
    box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(24,40,70,.06),0 10px 26px rgba(30,45,80,.14);
    color:#3b5de9;transform:scale(1.06)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-time-capsule{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-home .lv-hbtn-label{color:transparent}
  #lptv-root[data-theme=light] #lptv-view-home .lv-hbtn-wrap:hover .lv-hbtn-label{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-home .lv-clock-line .lv-date{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-home .lv-group-title{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-home .lv-group-count{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-home .lv-group-hint,
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-toggle,
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-last{
    background:linear-gradient(180deg,rgba(255,255,255,.80),rgba(246,249,255,.58));
    border:1px solid rgba(255,255,255,.78);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),0 0 0 1px rgba(24,40,70,.04),
      0 8px 22px rgba(30,45,80,.10);
    color:#5a6b8c;text-shadow:none;
    backdrop-filter:blur(14px) saturate(170%);-webkit-backdrop-filter:blur(14px) saturate(170%)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-group-hint{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-home .lv-group-line{background:rgba(20,35,60,.08)}
  /* 卡片: 亮白玻璃芯片 (高光顶边 + 发丝边 + 弥散投影), 折射背后的图像 */
  #lptv-root[data-theme=light] #lptv-view-home .lv-card{
    background:linear-gradient(180deg,rgba(255,255,255,.78),rgba(255,255,255,.56));
    border:1px solid rgba(255,255,255,.72);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.94),inset 0 -1px 0 rgba(20,35,60,.03),
      0 0 0 1px rgba(24,40,70,.05),0 12px 30px rgba(30,45,80,.12);
    backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card:hover{
    background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.72));
    box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(24,40,70,.06),0 18px 42px rgba(30,45,80,.18)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card.cur{
    background:linear-gradient(180deg,rgba(255,255,255,.97),rgba(255,255,255,.80));
    border:1.5px solid #4d7cfe;
    box-shadow:inset 0 1px 0 #fff,0 0 0 4px rgba(77,124,254,.16),0 18px 42px rgba(30,45,80,.20)}
  /* 浅色主题焦点卡片: 上面的 .lv-card / .cur 浅色规则含 2 个 ID, 特异性高于深色
     主题的 #lptv-view-home .lv-card.focus (1 个 ID), 会把焦点蓝框盖成白框 →
     深色主题切到浅色后 cctv1 看不到焦点线框。这里用同等级特异性单独声明,
     并放在 .cur 之后, 保证焦点框(蓝描边+外发光)在浅色下也始终可见。 */
  #lptv-root[data-theme=light] #lptv-view-home .lv-card.focus{
    background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(255,255,255,.78));
    border:2px solid #4d7cfe;
    box-shadow:inset 0 1px 0 #fff,0 0 0 4px rgba(77,124,254,.22),0 18px 42px rgba(30,45,80,.20);
    transform:translateY(-2px)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card-num{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card.cur .lv-card-num{color:#4d7cfe}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card-name{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card-sub{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-home .lv-card-logo{background:#f4f6fb}
  #lptv-root[data-theme=light] #lptv-view-home .lv-live-badge{background:rgba(255,90,90,.16);
    border-color:rgba(255,90,90,.36);color:#c93a3a}
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-toggle:hover{
    color:#1a2233;background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(250,252,255,.74))}
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-toggle .lv-arrow{color:#8a94ab}
  /* 底部提示胶囊: 白玻璃芯片 (原规则只改了文字色, 背景仍是深色玻璃) */
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-tips{
    background:linear-gradient(180deg,rgba(255,255,255,.80),rgba(246,249,255,.58));
    border:1px solid rgba(255,255,255,.78);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),0 0 0 1px rgba(24,40,70,.04),
      0 8px 22px rgba(30,45,80,.10);
    color:#5a6b8c;text-shadow:none;
    backdrop-filter:blur(14px) saturate(170%);-webkit-backdrop-filter:blur(14px) saturate(170%)}
  #lptv-root[data-theme=light] #lptv-view-home .lv-home-tips .sep{background:rgba(20,35,60,.12)}

  /* ---------- 频道/节目单面板 (结构层) ---------- */
  #lptv-root[data-theme=light] #lptv-view-left,
  #lptv-root[data-theme=light] #lptv-view-right{background:rgba(236,242,250,.55)}
  /* 冷灰玻璃侧栏: 比芯片更重 (更深的底色 + 更强模糊), 芯片叠在其上才有层次 */
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-panel{
    background:linear-gradient(180deg,rgba(244,248,254,.76),rgba(232,239,249,.64));
    border-right:1px solid rgba(255,255,255,.60);
    box-shadow:24px 0 70px rgba(24,40,70,.20),inset 0 1px 0 rgba(255,255,255,.82),
      inset -1px 0 0 rgba(20,35,60,.05);
    backdrop-filter:blur(44px) saturate(180%);-webkit-backdrop-filter:blur(44px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-panel{
    background:linear-gradient(180deg,rgba(244,248,254,.76),rgba(232,239,249,.64));
    border-left:1px solid rgba(255,255,255,.60);
    box-shadow:-24px 0 70px rgba(24,40,70,.20),inset 0 1px 0 rgba(255,255,255,.82),
      inset 1px 0 0 rgba(20,35,60,.05);
    backdrop-filter:blur(44px) saturate(180%);-webkit-backdrop-filter:blur(44px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-title,
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-title{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-ch{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-tab,
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-tab{
    /* 未选中标签用浅色轨道 (深色玻璃芯片), 白色指示条才有对比 */
    background:linear-gradient(180deg,rgba(20,35,60,.08),rgba(20,35,60,.04));
    border:1px solid rgba(20,35,60,.10);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.35);
    color:#3a4763;
    backdrop-filter:blur(14px) saturate(170%);-webkit-backdrop-filter:blur(14px) saturate(170%)}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-tab.on,
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-tab.on{
    background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.82));
    border-color:rgba(77,124,254,.42);color:#1a2233;
    box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(77,124,254,.14),0 8px 22px rgba(30,45,80,.12)}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-item,
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-item{
    background:linear-gradient(180deg,rgba(255,255,255,.82),rgba(255,255,255,.60));
    border:1px solid rgba(255,255,255,.74);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),0 0 0 1px rgba(24,40,70,.05),
      0 2px 10px rgba(30,45,80,.06);
    backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%)}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-item:hover,
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-item:hover{
    background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.74))}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-item.cur{
    background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.82));
    border-color:rgba(77,124,254,.48);
    box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(77,124,254,.14),0 10px 26px rgba(30,45,80,.12)}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-num{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-item.cur .lv-left-num{color:#4d7cfe}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-logo{background:#f4f6fb}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-name{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-playing{color:#4d7cfe}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-prog{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-left .lv-left-foot{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-item.now{
    background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.82));
    border-color:rgba(77,124,254,.48);
    box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(77,124,254,.14)}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-item.focus{border-color:var(--accent2);
    box-shadow:0 0 0 2px rgba(77,124,254,.35),0 12px 30px rgba(30,45,80,.16)}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-time{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-item.now .lv-right-time{color:#4d7cfe}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-pt{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-item.now .lv-right-pt{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-prog .track{background:rgba(20,35,60,.12)}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-prog .pct{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-status{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-badge{background:rgba(77,124,254,.14);
    border-color:rgba(77,124,254,.45);color:#3157d8}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-book{
    background:linear-gradient(180deg,rgba(255,255,255,.80),rgba(255,255,255,.58));
    border:1px solid rgba(255,255,255,.72);color:#1a2233;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),0 0 0 1px rgba(24,40,70,.04)}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-book.on{background:var(--accent);
    border-color:var(--accent2);color:#fff}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-foot{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-right .lv-right-foot .warn{color:#8a94ab}
  /* 面板画面区的胶囊/场景文字 (浅色画面区上不能再沿用白色文字) */
  #lptv-root[data-theme=light] .lv-hint-capsule,
  #lptv-root[data-theme=light] .lv-glass-capsule{
    background:linear-gradient(180deg,rgba(255,255,255,.84),rgba(248,251,255,.60));
    border:1px solid rgba(255,255,255,.78);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.94),0 0 0 1px rgba(24,40,70,.05),
      0 4px 14px rgba(30,45,80,.08);
    color:#3a4763;
    backdrop-filter:blur(14px) saturate(180%);-webkit-backdrop-filter:blur(14px) saturate(180%)}
  #lptv-root[data-theme=light] .lv-glass-capsule{color:#1a2233}
  #lptv-root[data-theme=light] .lv-scene-sub{color:#5a6b8c}
  #lptv-root[data-theme=light] .lv-scene-live{background:rgba(255,90,90,.16);
    border-color:rgba(255,90,90,.36);color:#c93a3a}
  #lptv-root[data-theme=light] .lv-clock-date{color:#5a6b8c}
  #lptv-root[data-theme=light] .lv-scene-logo{box-shadow:0 8px 20px rgba(30,45,80,.16)}

  /* ---------- 播放界面 ---------- */
  #lptv-root[data-theme=light] #lptv-view-playing .lv-play-mask-top{
    background:linear-gradient(180deg,rgba(240,244,250,.78),rgba(240,244,250,.24) 55%,transparent)}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-play-mask-bottom{
    background:linear-gradient(0deg,rgba(238,242,249,.72),transparent)}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-play-name{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-play-sub{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-live-badge{background:rgba(255,90,90,.16);
    border-color:rgba(255,90,90,.36);color:#c93a3a}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-time-hint,
  #lptv-root[data-theme=light] #lptv-view-playing .lv-vol-hint{
    background:linear-gradient(180deg,rgba(255,255,255,.86),rgba(248,251,255,.64));
    border:1px solid rgba(255,255,255,.78);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.94),0 0 0 1px rgba(24,40,70,.05),
      0 4px 14px rgba(30,45,80,.08);
    color:#1a2233;
    backdrop-filter:blur(14px) saturate(180%);-webkit-backdrop-filter:blur(14px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-time-date{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-vol-hint .lv-vol-ico{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-vol-hint .lv-vol-track{background:rgba(20,35,60,.14)}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-quality-badge{
    background:linear-gradient(180deg,rgba(255,255,255,.80),rgba(255,255,255,.58));
    border:1px solid rgba(255,255,255,.72);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),0 0 0 1px rgba(24,40,70,.04);
    color:#3a4763}
  /* 控制栏按钮: 白玻璃胶囊 (底条已去掉, 只给按钮本身材质) */
  #lptv-root[data-theme=light] #lptv-view-playing .lv-bar-btn,
  #lptv-root[data-theme=light] #lptv-view-playing .lv-bar-vol,
  #lptv-root[data-theme=light] #lptv-view-playing .lv-bar-home{
    background:linear-gradient(180deg,rgba(255,255,255,.88),rgba(255,255,255,.64));
    border:1px solid rgba(255,255,255,.80);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.96),0 0 0 1px rgba(24,40,70,.05),
      0 2px 8px rgba(30,45,80,.07);
    color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-bar-btn:hover,
  #lptv-root[data-theme=light] #lptv-view-playing .lv-bar-vol:hover,
  #lptv-root[data-theme=light] #lptv-view-playing .lv-bar-home:hover{
    background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.78))}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-prog-name{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-prog-time{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-prog-time .sep{color:#a8b0c4}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-prog-time #lv-prog-end{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-prog-track{background:rgba(20,35,60,.16)}
  #lptv-root[data-theme=light] #lptv-view-playing .lv-play-logo{box-shadow:0 8px 20px rgba(30,45,80,.16)}

  /* 设置弹窗 (首页右上角齿轮 → 播放设置/快捷键/关于) — 右侧滑出侧边栏,
     与播放控制栏/频道·节目单面板同款液态玻璃 (var(--panel) + blur + 左侧描边)。 */
  /* 弹窗默认 display:none (彻底不渲染), 避免关闭态在右侧留下 translateX(100%) 的
     离屏玻璃层 —— xpra 软件合成 + transform:scale() 下会使其附近透明视图 (右侧
     节目单面板) 绘制偏移。打开时先 .show(渲染) 再 .open(滑入), 保留滑入动效。 */
  #lptv-settings{position:fixed;inset:0;z-index:60;display:none;align-items:stretch;justify-content:flex-end;
    background:rgba(4,7,13,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
    visibility:hidden;opacity:0;pointer-events:none;
    transition:opacity .32s ease-out,visibility 0s linear .32s}
  #lptv-settings.show{display:flex}
  #lptv-settings.open{visibility:visible;opacity:1;pointer-events:auto;
    transition:opacity .32s ease-out,visibility 0s linear 0s}
  #lptv-settings .lv-set-card-wrap{position:relative;width:640px;height:100%;max-height:none;
    border-radius:0;padding:40px 36px 30px;display:flex;flex-direction:column;
    background:var(--panel);border-left:1px solid var(--glass-1-stroke);
    backdrop-filter:blur(30px) saturate(160%);-webkit-backdrop-filter:blur(30px) saturate(160%);
    box-shadow:-24px 0 60px rgba(0,0,0,.5),inset 0 1px 0 var(--glass-1-hi-soft);
    transform:translateX(100%);transition:transform .32s cubic-bezier(.4,0,.2,1)}
  #lptv-settings.open .lv-set-card-wrap{transform:translateX(0)}
  #lptv-settings .lv-set-tabs{display:flex;gap:12px;margin:2px 0 24px}
  /* 设置标签按节目单日期标签样式: 同款玻璃胶囊/圆角/两行(小图标+大文字),
     选中态为白底深字, 不再用蓝色选中。 */
  #lptv-settings .lv-set-tab{flex:1;height:68px;padding:0 12px;border-radius:20px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);
    color:var(--tx2);cursor:pointer;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:2px;
    font-size:17px;font-weight:600;transition:background .14s,color .14s,border-color .14s}
  #lptv-settings .lv-set-tab svg{width:26px;height:26px;opacity:.9;stroke-width:1.8}
  #lptv-settings .lv-set-tab:hover{background:var(--glass-2-fill)}
  #lptv-settings .lv-set-tab.on{background:#fff;color:#0b1020;border-color:transparent;
    box-shadow:0 10px 26px rgba(0,0,0,.35)}
  #lptv-settings .lv-set-tab.on svg{opacity:.95}
  #lptv-settings .lv-set-body{flex:1;min-height:0;overflow-y:auto}
  #lptv-settings .lv-set-pane{display:none}
  #lptv-settings .lv-set-pane.on{display:block}
  #lptv-settings .lv-set-sec{margin-bottom:20px}
  /* 播放设置: iOS 风格开关卡片行 (整行可点, 右侧拨动开关) */
  #lptv-settings .lv-set-row{display:flex;align-items:center;justify-content:space-between;gap:14px;
    padding:16px 18px;border-radius:16px;background:var(--glass-2-fill-weak);
    border:1px solid var(--glass-2-stroke-weak);font-size:17px;cursor:pointer;
    transition:background .16s,border-color .16s}
  #lptv-settings .lv-set-row:hover{background:var(--glass-2-fill)}
  #lptv-settings .lv-set-row + .lv-set-row{margin-top:12px}
  #lptv-settings .lv-set-row span{flex:1;min-width:0;color:var(--tx)}
  #lptv-settings .lv-set-row input[type=checkbox]{appearance:none;-webkit-appearance:none;flex-shrink:0;
    width:52px;height:30px;border-radius:15px;background:rgba(255,255,255,.14);
    border:1px solid rgba(255,255,255,.22);cursor:pointer;position:relative;margin:0;
    transition:background .18s,border-color .18s}
  #lptv-settings .lv-set-row input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;
    width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35);
    transition:transform .18s}
  #lptv-settings .lv-set-row input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent2)}
  #lptv-settings .lv-set-row input[type=checkbox]:checked::after{transform:translateX(22px)}
  #lptv-settings .lv-krow{display:flex;align-items:center;justify-content:space-between;padding:11px 4px;
    border-bottom:1px solid rgba(255,255,255,.08);font-size:17px;color:var(--tx)}
  #lptv-settings .lv-krow:last-child{border-bottom:none}
  #lptv-settings .lv-kkeys{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  #lptv-settings kbd{font-family:inherit;font-size:13px;font-weight:600;color:var(--tx);
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);border-radius:6px;
    padding:3px 9px;line-height:1.3}
  #lptv-settings .lv-about-logo{width:88px;height:88px;object-fit:contain;display:block;
    margin:0 auto 14px}
  #lptv-settings .lv-about-ver{font-size:16px;color:var(--tx2);margin-bottom:16px;
    text-align:center}
  /* 关于描述: 居中 + 不换行 (卡片 640px 内单行放得下, nowrap 防折行) */
  #lptv-settings .lv-about-desc{font-size:18px;color:var(--tx);line-height:1.7;
    text-align:center;white-space:nowrap}
  #lptv-settings .lv-about-slogan{font-size:17px;color:var(--tx2);margin-top:10px;
    text-align:center}
  #lptv-settings .lv-about-foot{font-size:14px;color:var(--tx3);margin-top:26px;
    text-align:center}

  /* ---------- 设置侧栏 (浅色液态玻璃) ---------- */
  /* 遮罩改为压暗 (dim to focus), 而不是再用一层白把背景提亮 —— 白色侧栏才有边界 */
  #lptv-root[data-theme=light] #lptv-settings{background:rgba(16,26,42,.32)}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-card-wrap{
    background:linear-gradient(180deg,rgba(245,248,254,.88),rgba(233,239,249,.78));
    border-left:1px solid rgba(255,255,255,.60);
    box-shadow:-24px 0 70px rgba(24,40,70,.24),inset 0 1px 0 rgba(255,255,255,.85),
      inset 1px 0 0 rgba(20,35,60,.04);
    backdrop-filter:blur(44px) saturate(180%);-webkit-backdrop-filter:blur(44px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-tab{
    background:linear-gradient(180deg,rgba(20,35,60,.08),rgba(20,35,60,.04));
    border:1px solid rgba(20,35,60,.10);color:#3a4763;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.35);
    backdrop-filter:blur(14px) saturate(170%);-webkit-backdrop-filter:blur(14px) saturate(170%)}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-tab:hover{
    background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.74))}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-tab.on{
    background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.82));
    border-color:rgba(77,124,254,.42);color:#1a2233;
    box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(77,124,254,.14),0 8px 22px rgba(30,45,80,.12)}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-row{
    background:linear-gradient(180deg,rgba(255,255,255,.82),rgba(255,255,255,.60));
    border:1px solid rgba(255,255,255,.74);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),0 0 0 1px rgba(24,40,70,.05);
    backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%)}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-row:hover{
    background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.74))}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-row span{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-row input[type=checkbox]{background:rgba(20,35,60,.14);
    border-color:rgba(20,35,60,.10)}
  #lptv-root[data-theme=light] #lptv-settings .lv-set-row input[type=checkbox]:checked{background:var(--accent);
    border-color:var(--accent2)}
  #lptv-root[data-theme=light] #lptv-settings .lv-krow{border-color:rgba(20,35,60,.08);color:#1a2233}
  #lptv-root[data-theme=light] #lptv-settings kbd{
    background:linear-gradient(180deg,rgba(255,255,255,.86),rgba(255,255,255,.64));
    border:1px solid rgba(255,255,255,.78);color:#1a2233;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.94),0 0 0 1px rgba(24,40,70,.05)}
  #lptv-root[data-theme=light] #lptv-settings .lv-about-ver,
  #lptv-root[data-theme=light] #lptv-settings .lv-about-slogan{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-settings .lv-about-desc{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-settings .lv-about-foot{color:#8a94ab}

  /* ---------- 切台页 ---------- */
  /* 原深色遮罩 + 深色玻璃卡在浅色主题下会变成"深底深字"; 改为浅色遮罩 + 白玻璃卡 */
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-dim{
    background:linear-gradient(180deg,#f3f6fb,#e6ecf7)}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-halo3{
    background:rgba(58,92,150,.05);border-color:rgba(58,92,150,.10)}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-card{
    background:linear-gradient(180deg,rgba(255,255,255,.86),rgba(255,255,255,.66));
    border:1px solid rgba(255,255,255,.80);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 0 0 1px rgba(24,40,70,.05),
      0 20px 50px rgba(30,45,80,.16);
    backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%)}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-name{color:#1a2233}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-status{
    background:rgba(77,124,254,.14);border-color:rgba(77,124,254,.40);color:#3157d8}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-dot{background:#4d7cfe}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-from{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-arrow{color:#a8b0c4}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-to{color:#3a4763}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-track{background:rgba(20,35,60,.12)}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-fill{background:var(--accent)}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-info .hint{color:#8a94ab}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-info .pct{color:#5a6b8c}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-logo{box-shadow:0 8px 20px rgba(30,45,80,.16)}
  #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-ring .num img{
    filter:drop-shadow(0 6px 18px rgba(30,45,80,.28))}

  /* ---------- 版权限制提示 (官方黑屏时给出说明) ---------- */
  #lptv-root .lv-signal-notice{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    z-index:55;display:none;flex-direction:column;align-items:center;text-align:center;
    width:640px;max-width:calc(100vw - 80px);padding:30px 36px 28px;border-radius:26px;
    background:var(--glass-1-fill);border:1px solid var(--glass-1-stroke);
    box-shadow:0 22px 60px rgba(0,0,0,.5),inset 0 1px 0 var(--glass-1-hi-soft);
    backdrop-filter:blur(26px) saturate(160%);-webkit-backdrop-filter:blur(26px) saturate(160%);
    pointer-events:auto}
  #lptv-root .lv-signal-notice.on{display:flex}
  #lptv-root .lv-signal-notice .ico{width:56px;height:56px;border-radius:18px;display:flex;
    align-items:center;justify-content:center;background:rgba(77,124,254,.18);
    border:1px solid rgba(77,124,254,.35);color:#9cc4ff;margin-bottom:16px}
  #lptv-root .lv-signal-notice .ico svg{width:30px;height:30px}
  #lptv-root .lv-signal-notice .ttl{font-size:22px;font-weight:700;line-height:1.4}
  #lptv-root .lv-signal-notice .sub{margin-top:8px;font-size:14px;color:var(--tx2);line-height:1.6}
  #lptv-root .lv-signal-notice .acts{display:flex;gap:12px;margin-top:22px}
  #lptv-root .lv-signal-notice .btn{height:44px;padding:0 24px;border-radius:22px;
    background:var(--glass-2-fill);border:1px solid var(--glass-2-stroke);color:var(--tx);
    font-size:15px;font-weight:600;cursor:pointer;transition:background .14s}
  #lptv-root .lv-signal-notice .btn:hover{background:var(--glass-2-hover-fill)}
  #lptv-root .lv-signal-notice .btn.primary{background:#fff;color:#0b1020;border-color:transparent}
  #lptv-root.mobile .lv-signal-notice{width:min(82vw,520px);padding:20px 22px;border-radius:20px}
  #lptv-root.mobile .lv-signal-notice .ico{width:42px;height:42px;border-radius:12px;margin-bottom:10px}
  #lptv-root.mobile .lv-signal-notice .ico svg{width:22px;height:22px}
  #lptv-root.mobile .lv-signal-notice .ttl{font-size:16px}
  #lptv-root.mobile .lv-signal-notice .sub{font-size:12px;margin-top:6px}
  #lptv-root.mobile .lv-signal-notice .acts{margin-top:14px;gap:8px}
  #lptv-root.mobile .lv-signal-notice .btn{height:38px;padding:0 16px;border-radius:19px;font-size:13px}

  /* ---------- 标签选中指示条 (频道分组/节目单日期/设置项 共用) ----------
     指示条是容器内的绝对定位层, 只动 transform; 标签文字/图标抬到指示条之上,
     因此指示条滑过相邻标签时不会盖住文字。 */
  #lptv-root .lv-left-tabs,
  #lptv-root .lv-right-tabs,
  #lptv-root .lv-set-tabs{position:relative}
  #lptv-root .lv-tab-ind{position:absolute;left:0;top:0;z-index:1;pointer-events:none;
    box-sizing:border-box;
    background:var(--tab-ind-fill);border:1px solid transparent;
    box-shadow:0 10px 26px rgba(0,0,0,.35);
    transform:translateX(0);transition:transform .26s cubic-bezier(.22,.9,.3,1)}
  #lptv-root .lv-left-tab .lt,
  #lptv-root .lv-right-tab .dt,
  #lptv-root .lv-right-tab .dw,
  #lptv-root .lv-set-tab span,
  #lptv-root .lv-set-tab svg{position:relative;z-index:2}
  /* 遥控焦点环: 与首页卡片焦点同色, 静态阴影 (不做动画) */
  #lptv-root .lv-left-item.focus,
  #lptv-root .lv-set-row.focus,
  #lptv-root .lv-right-book.focus{border-color:var(--acc2);
    box-shadow:0 0 0 2px rgba(77,124,254,.55),0 12px 30px rgba(0,0,0,.4)}

  /* ---------- 液态玻璃折射边环 ----------
     内阴影伪造透镜边缘 (左上亮 / 右下暗); .perf 下加强, 补偿 blur 缺失。 */
  #lptv-root .lv-card::before,
  #lptv-root .lv-left-panel::before,
  #lptv-root .lv-right-panel::before,
  #lptv-root .lv-set-card-wrap::before,
  #lptv-root .lv-left-item::before,
  #lptv-root .lv-right-item::before,
  #lptv-root .lv-set-row::before,
  #lptv-root .lv-glass-capsule::before,
  #lptv-root .lv-hint-capsule::before{
    content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    background-image:var(--grain);background-repeat:repeat;opacity:.5;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.35),inset 0 -1px 0 rgba(0,0,0,.24),
      inset 1px 0 0 rgba(255,255,255,.09),inset -1px 0 0 rgba(0,0,0,.16)}
  #lptv-root[data-theme=light] .lv-card::before,
  #lptv-root[data-theme=light] .lv-left-panel::before,
  #lptv-root[data-theme=light] .lv-right-panel::before,
  #lptv-root[data-theme=light] .lv-set-card-wrap::before,
  #lptv-root[data-theme=light] .lv-left-item::before,
  #lptv-root[data-theme=light] .lv-right-item::before,
  #lptv-root[data-theme=light] .lv-set-row::before,
  #lptv-root[data-theme=light] .lv-glass-capsule::before,
  #lptv-root[data-theme=light] .lv-hint-capsule::before{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.92),inset 0 -1px 0 rgba(30,45,80,.10),
      inset 1px 0 0 rgba(255,255,255,.55),inset -1px 0 0 rgba(30,45,80,.06)}
  #lptv-root.perf .lv-card::before,
  #lptv-root.perf .lv-left-panel::before,
  #lptv-root.perf .lv-right-panel::before,
  #lptv-root.perf .lv-set-card-wrap::before,
  #lptv-root.perf .lv-left-item::before,
  #lptv-root.perf .lv-right-item::before,
  #lptv-root.perf .lv-set-row::before{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.5),inset 0 -1px 0 rgba(0,0,0,.45),
      inset 1px 0 0 rgba(255,255,255,.12),inset -1px 0 0 rgba(0,0,0,.28)}
  #lptv-root.perf[data-theme=light] .lv-card::before,
  #lptv-root.perf[data-theme=light] .lv-left-panel::before,
  #lptv-root.perf[data-theme=light] .lv-right-panel::before,
  #lptv-root.perf[data-theme=light] .lv-set-card-wrap::before,
  #lptv-root.perf[data-theme=light] .lv-left-item::before,
  #lptv-root.perf[data-theme=light] .lv-right-item::before,
  #lptv-root.perf[data-theme=light] .lv-set-row::before{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(30,45,80,.14),
      inset 1px 0 0 rgba(255,255,255,.7),inset -1px 0 0 rgba(30,45,80,.08)}

  /* ---------- 液态玻璃斜向光带 ----------
     静态层, 只在 hover/focus 改 opacity (合成器可处理), 不逐帧重绘阴影。 */
  #lptv-view-home .lv-card::after,
  #lptv-view-left .lv-left-item::after,
  #lptv-view-right .lv-right-item::after,
  #lptv-settings .lv-set-row::after,
  #lptv-view-home .lv-theme-toggle::after,
  #lptv-view-home .lv-settings-btn::after,
  #lptv-root .lv-glass-capsule::after,
  #lptv-root .lv-hint-capsule::after{
    content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    background:var(--sheen);opacity:0;transition:opacity .18s ease}
  #lptv-root .lv-card:hover::after,
  #lptv-root .lv-left-item:hover::after,
  #lptv-root .lv-right-item:hover::after,
  #lptv-root .lv-set-row:hover::after,
  #lptv-view-home .lv-theme-toggle:hover::after,
  #lptv-view-home .lv-settings-btn:hover::after{opacity:.5}
  #lptv-view-home .lv-theme-toggle,
  #lptv-view-home .lv-settings-btn,
  #lptv-view-right .lv-right-item,
  #lptv-settings .lv-set-row{position:relative}

  /* 主题过渡期: 令牌整体切换会让所有 blur 层重栅格化, 临时关掉 (结束恢复)。
     标签过渡期只冻结光带过渡, 不动 blur —— transform 不会让 backdrop 失效。 */
  #lptv-root.lptv-theme-anim *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
  #lptv-root.lptv-theme-anim .lv-card::after,
  #lptv-root.lptv-theme-anim .lv-left-item::after,
  #lptv-root.lptv-theme-anim .lv-right-item::after,
  #lptv-root.lptv-theme-anim .lv-set-row::after,
  #lptv-root.lptv-theme-anim .lv-theme-toggle::after,
  #lptv-root.lptv-theme-anim .lv-settings-btn::after{transition:none!important;opacity:0!important}
  #lptv-root.lptv-tab-anim .lv-card::after,
  #lptv-root.lptv-tab-anim .lv-left-item::after,
  #lptv-root.lptv-tab-anim .lv-right-item::after,
  #lptv-root.lptv-tab-anim .lv-set-row::after{transition:none!important}
  /* 标签过渡在 lite 档缩短 (CDE/智慧屏 / 自降级) */
  #lptv-root.lptv-lite .lv-tab-ind{transition-duration:.18s}

  /* ---------- 主题切换过渡层 (右上 → 左下卷轴/撕开) ----------
     lite (CDE/智慧屏): 纯色层淡入 + 斜向扫描带, 无光晕;
     full (硬件合成): 同结构 + 卷曲阴影/亮边质感。只用 transform/opacity。 */
  #lptv-theme-wipe{position:absolute;inset:0;z-index:5;pointer-events:none;
    opacity:0;will-change:opacity}
  #lptv-theme-edge{position:absolute;top:-25%;bottom:-25%;left:0;width:220px;z-index:6;
    pointer-events:none;opacity:0;will-change:transform;
    transform:translateX(2100px) skewX(-45deg);
    background:linear-gradient(90deg,rgba(0,0,0,.45),rgba(0,0,0,.18) 32%,
      rgba(255,255,255,.65) 50%,rgba(255,255,255,.22) 60%,transparent 72%)}
  #lptv-root.lptv-lite #lptv-theme-edge{
    background:linear-gradient(90deg,transparent 36%,rgba(255,255,255,.45) 50%,transparent 64%)}

  /* 减少透明度偏好: 玻璃改为实底 (仍保留浅色主题的分层) */
  @media (prefers-reduced-transparency: reduce){
    #lptv-root[data-theme=light] #lptv-view-home .lv-card,
    #lptv-root[data-theme=light] #lptv-view-home .lv-theme-toggle,
    #lptv-root[data-theme=light] #lptv-view-home .lv-settings-btn,
    #lptv-root[data-theme=light] #lptv-view-home .lv-time-capsule,
    #lptv-root[data-theme=light] #lptv-view-home .lv-home-tips,
    #lptv-root[data-theme=light] #lptv-view-left .lv-left-panel,
    #lptv-root[data-theme=light] #lptv-view-right .lv-right-panel,
    #lptv-root[data-theme=light] #lptv-settings .lv-set-card-wrap,
    #lptv-root[data-theme=light] #lptv-view-playing .lv-glass-bar,
    #lptv-root[data-theme=light] #lptv-view-switching .lv-sw-card{
      backdrop-filter:none;-webkit-backdrop-filter:none}
    #lptv-root[data-theme=light] #lptv-view-left .lv-left-panel,
    #lptv-root[data-theme=light] #lptv-view-right .lv-right-panel,
    #lptv-root[data-theme=light] #lptv-settings .lv-set-card-wrap{background:#f4f7fc}
    #lptv-root[data-theme=light] #lptv-view-home .lv-card{background:#fbfcff}
  }

  /* 软件合成(perf)下, 浅色液态玻璃的模糊一并关闭, 保留半透明+高光边+投影 (性能兜底)。
     只作用于浅色主题 (dark 主题不受影响)。注意: 浅色规则多含 2 个 ID (如
     #lptv-root[data-theme=light] #lptv-view-home .lv-card, 特异性 (2,2,0)), 会压过
     普通 perf 规则 (1,3,0); 故此处声明用 !important 保证在 light+perf 下必赢。 */
  #lptv-root.perf[data-theme=light] .lv-card,#lptv-root.perf[data-theme=light] .lv-theme-toggle,#lptv-root.perf[data-theme=light] .lv-settings-btn,
  #lptv-root.perf[data-theme=light] .lv-time-capsule,#lptv-root.perf[data-theme=light] .lv-left-panel,#lptv-root.perf[data-theme=light] .lv-right-panel,
  #lptv-root.perf[data-theme=light] .lv-left-tab,#lptv-root.perf[data-theme=light] .lv-right-tab,
  #lptv-root.perf[data-theme=light] .lv-left-item,#lptv-root.perf[data-theme=light] .lv-right-item,
  #lptv-root.perf[data-theme=light] .lv-right-book,#lptv-root.perf[data-theme=light] .lv-hint-capsule,#lptv-root.perf[data-theme=light] .lv-glass-capsule,
  #lptv-root.perf[data-theme=light] .lv-group-hint,#lptv-root.perf[data-theme=light] .lv-home-toggle,#lptv-root.perf[data-theme=light] .lv-home-last,
  #lptv-root.perf[data-theme=light] .lv-time-hint,#lptv-root.perf[data-theme=light] .lv-vol-hint,#lptv-root.perf[data-theme=light] .lv-glass-bar,
  #lptv-root.perf[data-theme=light] .lv-quality-badge,#lptv-root.perf[data-theme=light] .lv-sw-card,
  #lptv-root.perf[data-theme=light] .lv-set-tab,#lptv-root.perf[data-theme=light] .lv-set-row,#lptv-root.perf[data-theme=light] .lv-set-card-wrap{
    backdrop-filter:none !important;-webkit-backdrop-filter:none !important}

  /* ---------- 统一控件材质 (首页/侧栏 与播放控制栏同款) ----------
     同一液态玻璃填充/描边/内高光/悬停填充/字重, 覆盖首页卡片·胶囊·按钮,
     以及频道/节目单/设置侧栏的标签·列表项·设置行。 */
  #lptv-view-home .lv-card{box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 10px 30px rgba(0,0,0,.28)}
  #lptv-view-home .lv-card:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.30),0 16px 40px rgba(0,0,0,.4)}
  #lptv-view-home .lv-card.cur{box-shadow:inset 0 1px 0 rgba(255,255,255,.30),0 16px 40px rgba(0,0,0,.4)}
  #lptv-view-home .lv-card.focus{box-shadow:inset 0 1px 0 rgba(255,255,255,.30),
    0 0 0 3px rgba(77,124,254,.40),0 16px 40px rgba(0,0,0,.45)}
  #lptv-view-home .lv-theme-toggle,#lptv-view-home .lv-settings-btn,#lptv-view-home .lv-home-toggle,
  #lptv-view-home .lv-home-tips,#lptv-view-home .lv-home-last,#lptv-view-home .lv-group-hint{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.24)}
  #lptv-view-left .lv-left-tab,#lptv-view-left .lv-left-item,
  #lptv-view-right .lv-right-tab,#lptv-view-right .lv-right-item,
  #lptv-settings .lv-set-tab,#lptv-settings .lv-set-row{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.20)}
  #lptv-view-left .lv-left-item:not(.cur):hover,
  #lptv-view-right .lv-right-item:not(.now):hover,
  #lptv-view-left .lv-left-tab:not(.on):hover,
  #lptv-view-right .lv-right-tab:not(.on):hover,
  #lptv-settings .lv-set-tab:not(.on):hover,
  #lptv-settings .lv-set-row:hover{background:var(--glass-2-active-fill)}
  /* 文字与播放控件统一: 卡片/列表主名 18-20px 600, 说明文字 14px */
  #lptv-view-home .lv-card-name{font-size:20px;font-weight:600}
  #lptv-view-left .lv-left-name{font-size:19px;font-weight:600}
  #lptv-view-right .lv-right-pt{font-size:18px;font-weight:600}
  #lptv-settings .lv-set-row{font-size:18px;font-weight:600}
  #lptv-view-home .lv-group-hint,#lptv-view-home .lv-home-tips,
  #lptv-view-home .lv-home-last{font-size:14px}

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

  /* 运行期更新按钮提示文案: 只写 data-tip, 不写 title (避免原生气泡遮挡) */
  function setTip(b, text) {
    if (!b) return;
    if (text) { b.setAttribute("data-tip", text); b.removeAttribute("title"); }
  }


  // 触摸/APK 检测: 无 hover, 顶栏(窗口按钮)在手机端无意义 → 完全隐藏, 仅底部控制栏。
  // 用 (hover:none) and (pointer:coarse) 判"触摸为主"设备(手机/平板/触控平板模式):
  //   - 桌面(鼠标/触控板, 即使带触屏): hover 存在 → 非触摸 → 顶栏显示。
  //   - APK(Capacitor): __lptvBridge 可靠判 APK; 且 Android 触摸满足 media query。
  // 不要用 navigator.maxTouchPoints>0: 带触屏的 Windows 笔记本会误判为触摸,
  // 顶栏被 display:none 永不显示。
  var IS_TOUCH = !!window.__lptvBridge ||
    (window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  // 懒猫微服移动客户端（非 APK）：由主进程从 xpra 客户端 UA/platform 判定后经
  // preload 暴露。不能用 __lptvBridge（APK/旧网页播放器）或媒体查询（服务端看到
  // 的是虚拟鼠标，不是手机触摸）。
  var IS_MOBILE = !!(window.__LPTV_ENV && window.__LPTV_ENV.mobile === true);

  /* ================= 状态机 + 导航 ================= */
  var uiState = "home";
  var _autoHideTimer = null;

  function setView(state) {
    // 移动端没有首页入口：任何回首页都落到播放态（避免透明根露出官方页）。
    if (IS_MOBILE && state === "home") state = "playing";
    var prev = uiState;
    var root = lptv.ui && lptv.ui.root;
    // 切视图时立即收尾主题过渡, 避免过渡层盖住新视图
    if (root && root.classList.contains("lptv-theme-anim")) finishThemeTransition(true);
    uiState = state;
    if (root) root.setAttribute("data-state", state);
    if (prev !== state) viewFade(state);
    if (state !== "playing") showControls(false);
    // 版权提示只在播放视图显示: 首页/切台/频道面板/节目单期间立即收起, 不挡操作。
    if (state !== "playing") setSignalNotice(false);
  }
  /* 视图柔和转场: 只对新视图做淡入 (+ 轻微缩放), 不延迟 data-state 切换 ——
     延迟切状态会让状态机与按键路由在过渡期读到旧状态。 */
  function viewFade(state) {
    var root = lptv.ui && lptv.ui.root;
    if (!root || _tabReduce()) return;
    if (state === "switching") return; // 切台页自带 stack 动画, 不再叠一层
    var name = state === "leftPanel" ? "left" : (state === "rightPanel" ? "right" : state);
    var v = root.querySelector('[data-view="' + name + '"]');
    if (!v) return;
    var perf = root.classList.contains("perf");
    var dur = perf ? 160 : 240;
    v.style.transition = "none";
    v.style.opacity = "0";
    if (!perf) v.style.transform = "scale(.985)";
    void v.offsetWidth;
    v.style.transition = "opacity " + dur + "ms ease" + (perf ? "" : ", transform " + dur + "ms ease");
    v.style.opacity = "1";
    if (!perf) v.style.transform = "scale(1)";
    clearTimeout(v._fadeT);
    v._fadeT = setTimeout(function () {
      v.style.transition = "";
      v.style.transform = "";
      v.style.opacity = "";
    }, dur + 60);
  }
  function showControls(on) {
    var root = lptv.ui && lptv.ui.root;
    if (root) root.classList.toggle("show-controls", !!on);
    if (on) scheduleAutoHide();
  }
  function scheduleAutoHide() {
    if (_autoHideTimer) clearTimeout(_autoHideTimer);
    // 控制栏隐藏时间: 桌面/智慧屏 1.5s（鼠标移动会续期）；移动端给 3s，
    // 手机点一下到点按钮的间隔更短，1.5s 容易在按到按钮前消失。
    var ms = IS_MOBILE ? 3000 : 1500;
    _autoHideTimer = setTimeout(function () { showControls(false); }, ms);
  }
  function goHome() {
    // 播放中回首页: 继续播放, 但进入静音模式 (用户要求); 再次点频道进入播放时
    // 由 switchChannel/enterPlaying 解除首页静音, 恢复声音。
    var hv = lptv.video;
    if (uiState === "playing" && lptv.currentPid && hv && !IS_MOBILE) {
      lptv._homeMuted = true;
      lptv._volLock = true;
      try { hv.muted = true; } catch (e) {}
      setTimeout(function () { lptv._volLock = false; }, 60);
    }
    setView("home");
    // 回到首页时把焦点放在"正在播放"的卡片上(若有), 否则落到首张卡片;
    // 焦点只用于键盘/遥控导航, 不会自动播放。
    applyHomeFocus(lptv.currentPid || null);
  }

  /* ---- 首页卡片焦点导航 (键盘/遥控) ----
     首页方向键只移动焦点, 不切台/不播放; OK/Enter/Space 才播放焦点卡片。
     播放页的方向键仍是切台 (见 chanKey), 两者按 uiState 分支。 */
  function homeCardsList() {
    var h = lptv.ui && lptv.ui.home;
    return h ? Array.prototype.slice.call(h.querySelectorAll(".lv-card[data-pid]")) : [];
  }
  function applyHomeFocus(pid) {
    var cards = homeCardsList();
    if (!cards.length) { lptv.homeFocusPid = null; return null; }
    var target = null;
    if (pid) {
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].getAttribute("data-pid") === String(pid)) { target = cards[i]; break; }
      }
    }
    if (!target) target = cards[0];
    cards.forEach(function (c) { c.classList.toggle("focus", c === target); });
    lptv.homeFocusPid = target.getAttribute("data-pid");
    try { target.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
    return target;
  }
  function currentHomeFocus() {
    var cards = homeCardsList();
    for (var i = 0; i < cards.length; i++) if (cards[i].classList.contains("focus")) return cards[i];
    return null;
  }
  /* 按方向找最近卡片 (基于真实布局几何, 适配分组网格); 只改焦点不播放。 */
  function moveHomeFocus(dir) {
    var cards = homeCardsList();
    if (!cards.length) return;
    var cur = currentHomeFocus();
    if (!cur) { applyHomeFocus(lptv.currentPid || null); return; }
    var cr = cur.getBoundingClientRect();
    var ccx = cr.left + cr.width / 2, ccy = cr.top + cr.height / 2;
    var best = null, bestScore = Infinity;
    cards.forEach(function (c) {
      if (c === cur) return;
      var r = c.getBoundingClientRect();
      var dx = (r.left + r.width / 2) - ccx;
      var dy = (r.top + r.height / 2) - ccy;
      var ok = false, dist = 0;
      if (dir === "up") { ok = dy < -2; dist = Math.abs(dy) + Math.abs(dx) * 0.6; }
      else if (dir === "down") { ok = dy > 2; dist = Math.abs(dy) + Math.abs(dx) * 0.6; }
      else if (dir === "left") { ok = dx < -2; dist = Math.abs(dx) + Math.abs(dy) * 0.6; }
      else if (dir === "right") { ok = dx > 2; dist = Math.abs(dx) + Math.abs(dy) * 0.6; }
      if (ok && dist < bestScore) { bestScore = dist; best = c; }
    });
    if (best) applyHomeFocus(best.getAttribute("data-pid"));
  }
  function playHomeFocused() {
    var cur = currentHomeFocus();
    if (!cur) cur = applyHomeFocus(lptv.currentPid || null);
    if (!cur) return;
    lptv._fsOnClick = !!cfg.clickFullscreen;
    switchChannel(cur.getAttribute("data-pid"));
  }
  function enterPlaying(pid) {
    // 解除首页静音模式: 点频道进入播放恢复声音 (cfg.muted 为用户手动静音, 保留)。
    lptv._homeMuted = false;
    var epv = lptv.video;
    if (epv && !IS_MOBILE) {
      lptv._volLock = true;
      try {
        epv.muted = !!cfg.muted;
        epv.volume = cfg.volume != null ? cfg.volume : 1;
      } catch (e) {}
      setTimeout(function () { lptv._volLock = false; }, 60);
    }
    if (pid) lptv.currentPid = pid;
    // 切台后不自动弹出控制栏: 保持隐藏, 只有鼠标移动(mousemove)才显示, 避免
    // 每次切台都盖住画面。showControls(false) 同时清掉可能残留的自动隐藏计时。
    setView("playing"); showControls(false); updateQualityBadge();
    // 点击频道默认全屏: 进入播放后 (且非全屏) 自动全屏一次
    if (lptv._fsOnClick) { lptv._fsOnClick = false; maybeAutoFullscreen(); }
  }
  /* ================= 标签切换 (频道分组 / 节目单日期 / 设置项 共用) =================
     指示条位置用 offset 系一次性测量, 动画只改 transform; 内容切换先淡出再重建,
     切换后恢复滚动位置; 连点用递增 seq 丢弃过期回调, 不叠加动画。 */
  var _tabTimers = [];
  function _tabClear() { _tabTimers.forEach(function (t) { clearTimeout(t); }); _tabTimers = []; }
  function _tabReduce() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function tabSwitch(container, opts) {
    if (!container) return null;
    opts = opts || {};
    var tabSel = opts.tabSel || ".lv-tab";
    var attr = opts.attr || "data-tab";
    var ind = container.querySelector(".lv-tab-ind");
    if (!ind) { ind = document.createElement("div"); ind.className = "lv-tab-ind"; container.appendChild(ind); }
    var cur = null, seq = 0;
    function tabs() { return Array.prototype.slice.call(container.querySelectorAll(tabSel)); }
    /* 标签点击委托: 三类标签共用; 设置弹窗另有外层处理器 (stopPropagation), 不会重复触发 */
    var onClick = function (e) {
      var t = e.target && e.target.closest ? e.target.closest(tabSel) : null;
      if (t && container.contains(t)) select(t.getAttribute(attr));
    };
    container.addEventListener("click", onClick);
    function place(t, animate) {
      if (!t) return;
      // 必须用 offset 系 (布局像素): 根容器整体 transform:scale 适配屏幕时,
      // getBoundingClientRect 返回的是缩放后的值, 直接拿来设 width/transform 会把
      // 指示条缩小、位移减半。指示条 CSS 已加 box-sizing:border-box, 所以
      // offsetWidth 就是标签的外框宽, 不再叠加 1px 边框顶出标签行右边缘
      // (用户反馈"切标签后右侧没有间距/被遮挡")。
      ind.style.width = t.offsetWidth + "px";
      ind.style.height = t.offsetHeight + "px";
      ind.style.borderRadius = window.getComputedStyle(t).borderRadius;
      ind.style.transition = animate ? "" : "none";
      ind.style.transform = "translateX(" + t.offsetLeft + "px)";
      if (!animate) { void ind.offsetWidth; ind.style.transition = ""; }
    }
    function select(name, instant) {
      name = String(name);
      var t = tabs().filter(function (x) { return x.getAttribute(attr) === name; })[0];
      if (!t || name === cur) return false;
      var first = cur === null;
      cur = name;
      var my = ++seq;
      tabs().forEach(function (x) { x.classList.toggle("on", x === t); });
      var reduce = _tabReduce();
      place(t, !instant && !first && !reduce);
      var root = lptv.ui && lptv.ui.root;
      if (root && !instant && !first && !reduce) {
        root.classList.add("lptv-tab-anim");
        _tabTimers.push(setTimeout(function () { if (my === seq) root.classList.remove("lptv-tab-anim"); }, 420));
      }
      var content = opts.content;
      var scrollEl = opts.scrollEl;
      var st = scrollEl ? scrollEl.scrollTop : 0;
      function apply() {
        if (my !== seq) return;
        if (typeof opts.onChange === "function") opts.onChange(name);
        // onChange 里的列表渲染可能主动把焦点行滚到可见位置(当前频道/正在播出),
        // 此时保留它算出的 scrollTop; 否则按原逻辑恢复切组前的滚动位置。
        if (scrollEl) {
          if (!scrollEl._lptvFocusScrolled) scrollEl.scrollTop = st;
          scrollEl._lptvFocusScrolled = false;
        }
      }
      if (instant || first || reduce || !content || opts.quick) { apply(); return true; }
      content.style.transition = "opacity .11s ease, transform .11s ease";
      content.style.opacity = "0";
      content.style.transform = "translateY(6px)";
      _tabTimers.push(setTimeout(function () {
        if (my !== seq) return;
        apply();
        content.style.transition = "opacity .18s ease, transform .18s ease";
        content.style.opacity = "1";
        content.style.transform = "translateY(0)";
        _tabTimers.push(setTimeout(function () {
          if (my !== seq) return;
          content.style.transition = "";
          content.style.transform = "";
        }, 220));
      }, 110));
      return true;
    }
    return {
      select: select,
      dispose: function () {
        _tabClear();
        container.removeEventListener("click", onClick);
        if (ind && ind.parentNode) ind.parentNode.removeChild(ind);
      }
    };
  }
  /* ================= 遥控焦点导航 (设置 / 频道面板 / 节目单) =================
     ←→ 切标签, ↑↓ 在列表内移动焦点, OK/Enter 激活; 焦点位置按 scope 记忆。 */
  var _nav = null, _navMem = {};
  function _navVisible(el) { return !!el && el.offsetParent !== null; }
  function _navItems() {
    if (!_nav) return [];
    return Array.prototype.slice.call(_nav.scope.querySelectorAll(_nav.itemSel)).filter(_navVisible);
  }
  function _navApply(items, idx) {
    items.forEach(function (x) { x.classList.remove("focus"); });
    if (!items.length) return null;
    idx = Math.max(0, Math.min(items.length - 1, idx));
    var it = items[idx];
    it.classList.add("focus");
    try { it.scrollIntoView({ block: "nearest" }); } catch (e) {}
    _nav.idx = idx;
    _navMem[_nav.key] = idx;
    return it;
  }
  function navEnter(cfg) {
    if (_nav && _nav.key === cfg.key) return _nav;
    if (_nav) Array.prototype.forEach.call(_nav.scope.querySelectorAll(".focus"), function (x) { x.classList.remove("focus"); });
    _nav = cfg; _nav.idx = (_navMem[cfg.key] != null ? _navMem[cfg.key] : -1);
    return _nav;
  }
  function navTab(delta) {
    if (!_nav || !_nav.tabs || !_nav.tabsSw) return;
    var tabs = Array.prototype.slice.call(_nav.tabs.querySelectorAll(_nav.tabSel));
    if (!tabs.length) return;
    var ci = -1;
    tabs.forEach(function (t, i) { if (t.classList.contains("on")) ci = i; });
    var ni = ci < 0 ? 0 : (ci + delta + tabs.length) % tabs.length;
    _nav.tabsSw.select(tabs[ni].getAttribute(_nav.tabAttr));
  }
  function navMove(delta) {
    var items = _navItems();
    if (!items.length) return;
    if (_nav.idx < 0) { _navApply(items, delta < 0 ? items.length - 1 : 0); return; }
    _navApply(items, _nav.idx + delta);
  }
  function navActivate() {
    if (_nav.idx < 0) return; // 进入后未移动过焦点: Enter 不激活任何项
    var items = _navItems();
    if (!items.length) return;
    var it = items[_nav.idx];
    if (!it) return;
    var cb = it.querySelector ? it.querySelector("input[type=checkbox]") : null;
    var book = it.querySelector ? it.querySelector(".lv-right-book") : null;
    (cb || book || it).click();
  }
  function _navIn(k, c, names) {
    for (var i = 0; i < names.length; i++) if (k === names[i] || c === names[i]) return true;
    return false;
  }
  function navKey(e) {
    if (!_nav) return false;
    var k = e.key || "", c = e.code || "";
    if (k === "ArrowLeft") { navTab(-1); return true; }
    if (k === "ArrowRight") { navTab(1); return true; }
    if (k === "ArrowUp" || k === "PageUp") { navMove(-1); return true; }
    if (k === "ArrowDown" || k === "PageDown") { navMove(1); return true; }
    if (k === "Enter" || k === " " || _navIn(k, c, ["Select", "Accept", "OK"])) { navActivate(); return true; }
    if (_navIn(k, c, ["Backspace", "GoBack", "BrowserBack"])) { closeOverlay(); return true; }
    if (k === "Escape") { closeOverlay(); return true; }
    return false;
  }
  function navEnsureSettings() {
    var s = lptv.ui && lptv.ui.settings;
    if (!s) return null;
    if (_nav && _nav.key === "settings") return _nav;
    return navEnter({
      key: "settings", scope: s, itemSel: ".lv-set-pane.on .lv-set-row",
      tabs: s.querySelector(".lv-set-tabs"), tabSel: ".lv-set-tab", tabAttr: "data-tab",
      tabsSw: s._tabSw
    });
  }
  function navEnsurePanel() {
    var key = uiState;
    if (key !== "leftPanel" && key !== "rightPanel") return null;
    var v = key === "leftPanel" ? lptv.ui.left : lptv.ui.right;
    if (!v) return null;
    if (_nav && _nav.key === key) return _nav;
    return navEnter({
      key: key, scope: v,
      itemSel: key === "leftPanel" ? ".lv-left-item" : ".lv-right-item",
      tabs: v.querySelector(key === "leftPanel" ? "#lv-left-tabs" : "#lv-right-tabs"),
      tabSel: key === "leftPanel" ? ".lv-left-tab" : ".lv-right-tab",
      tabAttr: key === "leftPanel" ? "data-group" : "data-off",
      tabsSw: v._tabSw
    });
  }

  window.__lptvNav = function () {
    return _nav ? { key: _nav.key, idx: _nav.idx, items: _navItems().length } : null;
  };
  window.__lptvEpgDebug = function () {
    var v = lptv.ui && lptv.ui.right;
    return { day: lptv.epg._day, viewDay: v && v._epgDay };
  };
  /* 自检: 指示条数量/宽度、过渡层与临时类残留 (浏览器控制台 __lptvSelfTest()) */
  window.__lptvSelfTest = function () {
    var fails = [];
    var root = lptv.ui && lptv.ui.root;
    if (!root) return { ok: false, fails: ["root missing"] };
    Array.prototype.forEach.call(root.querySelectorAll(".lv-left-tabs,.lv-right-tabs,.lv-set-tabs"), function (c) {
      var n = c.querySelectorAll(".lv-tab-ind").length;
      if (n > 1) fails.push("tab indicators: " + n + " in " + c.className);
      var i = c.querySelector(".lv-tab-ind");
      if (i && c.offsetParent && !i.offsetWidth) fails.push("indicator width 0 in " + c.className);
    });
    if (document.getElementById("lptv-theme-wipe")) fails.push("theme wipe leftover");
    if (root.classList.contains("lptv-theme-anim")) fails.push("theme anim class leftover");
    if (root.classList.contains("lptv-tab-anim") && !_tabTimers.length) fails.push("tab anim class leftover");
    return { ok: !fails.length, fails: fails };
  };

  /* 设置弹窗: 打开/关闭/标签切换 (首页右上角齿轮) */
  function openSettings() {
    var s = lptv.ui && lptv.ui.settings;
    if (!s) return;
    s.classList.add("show");   // 先渲染 (display:flex), 卡片停在 translateX(100%) 透明
    void s.offsetHeight;       // 强制回流, 让过渡从该状态开始
    s.classList.add("open");   // → 淡入 + 卡片滑入
    _showPane("play", true);
    // 直接给每个设置标签绑定点击 (与频道侧栏同款可靠路径): 不依赖 tabSwitch 的
    // 容器事件委托, 避免某些环境/缩放命中下事件未到达容器 → 点击无反应。
    var tabsEl = s.querySelector(".lv-set-tabs");
    if (tabsEl && !s._tabsBound) {
      s._tabsBound = true;
      tabsEl.querySelectorAll(".lv-set-tab").forEach(function (t) {
        t.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          _showPane(t.getAttribute("data-tab"));
        });
      });
    }
    var a = s.querySelector("#lptv-s-autoplay");
    if (a) a.checked = !!cfg.autoPlayOnLaunch;
    var c = s.querySelector("#lptv-s-clickfs");
    if (c) c.checked = !!cfg.clickFullscreen;
  }
  function closeSettings() {
    var s = lptv.ui && lptv.ui.settings;
    if (!s) return;
    s.classList.remove("open"); // → 淡出 + 卡片滑出
    // 滑出结束后彻底 display:none, 移除离屏玻璃层 (见 #lptv-settings CSS 注释;
    // 滑出/淡出 .32s + 缓冲 → 380ms)
    setTimeout(function () {
      if (s && !s.classList.contains("open")) s.classList.remove("show");
    }, 380);
  }
  function _showPane(tab, instant) {
    var s = lptv.ui && lptv.ui.settings;
    if (!s) return;
    var tabsEl = s.querySelector(".lv-set-tabs");
    var body = s.querySelector(".lv-set-body");
    if (tabsEl && !s._tabSw) {
      s._tabSw = tabSwitch(tabsEl, {
        tabSel: ".lv-set-tab", attr: "data-tab", content: body, scrollEl: body,
        quick: true,   // 设置标签点击立即切换面板 (不做 110ms 淡出等待), 点击即响应
        onChange: function (name) {
          s.querySelectorAll(".lv-set-pane").forEach(function (p) {
            p.classList.toggle("on", p.id === "lptv-pane-" + name);
          });
          // 切到新面板后重置导航焦点索引: 否则沿用旧面板的 _nav.idx, 上下键/OK 落在
          // 不存在的行上, 表现为"焦点不在面板内/点了没反应"。
          _navMem["settings"] = -1;
          if (_nav && _nav.key === "settings") _nav.idx = -1;
        }
      });
    }
    if (s._tabSw) s._tabSw.select(tab, instant || !s._paneInit);
    s._paneInit = true;
  }
  /* 快捷键面板: 只读列出当前 keydown 实际绑定的键位 (无 录制/截图/浮窗) */
  function _renderKeysPane() {
    var s = lptv.ui && lptv.ui.settings;
    if (!s) return;
    var km = s.querySelector("#lptv-s-kmap");
    if (!km) return;
    var SC = [
      ["切换频道", ["↑", "↓", "PgUp", "PgDn"]],
      ["音量调节", ["←", "→"]],
      ["播放 / 暂停", ["空格"]],
      ["数字选台", ["0-9"]],
      ["频道面板", ["C"]],
      ["节目单面板", ["E"]],
      ["静音", ["M"]],
      ["全屏", ["F11"]],
      ["返回 / 关闭", ["Esc"]]
    ];
    km.innerHTML = SC.map(function (r) {
      return '<div class="lv-krow"><span>' + r[0] + '</span>' +
        '<span class="lv-kkeys">' + r[1].map(function (k) {
          return '<kbd>' + k + '</kbd>';
        }).join("") + '</span></div>';
    }).join("");
  }
  /* 关于面板: 图标 + 版本(桥异步) + 描述/标语/脚注 (继承旧设置界面) */
  function _renderAboutPane() {
    var s = lptv.ui && lptv.ui.settings;
    if (!s) return;
    var logo = s.querySelector("#lptv-about-logo-img");
    if (logo) logo.src = (window.__LPTV_ICON_SRC || 'icon.png');
    var a = window.lptv ? window.lptv : null;
    if (a && a.get_version) {
      try {
        a.get_version().then(function (v) {
          var t = s.querySelector("#lptv-about-ver");
          if (t && v) t.textContent = "版本 v" + v;
        }).catch(function () {});
      } catch (e) {}
    }
  }
  /* 打开面板前清掉上一次关闭留下的内联 animation/transition/transform, 否则
     closeOverlay 写入的 animation:none 会压制本次滑入 → 节目单看起来
     是"直接出现"而不是从右边向左滑入。同时取消未完成的关闭/滑入定时器,
     防止重开后又被旧的 setView(back) 切走或滑入清理覆盖关闭曲线。 */
  function resetPanelInline(view) {
    if (!view) return;
    if (view._closeT) { clearTimeout(view._closeT); view._closeT = null; }
    view._closing = false;   // 关闭窗口内重开面板时复位: 否则 _closeT 被清、原超时不再
                             // 触发, _closing 永久 true → 之后 closeOverlay 提前 return, 面板关不掉
    var pv = view.querySelector(".lv-left-panel,.lv-right-panel");
    if (pv) {
      if (pv._inT) { clearTimeout(pv._inT); pv._inT = null; }
      pv.style.animation = ""; pv.style.transition = ""; pv.style.transform = "";
    }
    try { view.style.animationDuration = ""; } catch (e) {}
  }
  /* 面板点击显示动画 (唯一入口 openLeftPanel/openRightPanel):
     用内联 transition 从屏外滑到原位 —— 频道 dir=-1 从左侧往右滑入,
     节目单 dir=+1 从右侧往左滑入。不再依赖 CSS keyframe (会被关闭残留压制,
     表现为"直接出现"而不是滑入)。时长按像素速度换算保持一致: 频道 620px/360ms,
     节目单 780px/450ms (≈1722px/s), 同一 iOS 式抽屉曲线 cubic-bezier(.32,.72,0,1),
     两面板观感一致、只差滑入方向。 */
  function slidePanelIn(view, state, dir, durMs) {
    resetPanelInline(view);
    setView(state);                       // 切到对应视图 (暗化背板 CSS 淡入)
    var pv = view && view.querySelector(".lv-left-panel,.lv-right-panel");
    if (!pv) return;
    var w = pv.offsetWidth || (dir < 0 ? 620 : 780);
    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    pv.style.animation = "none";          // 确保无 keyframe 参与
    pv.style.transition = "none";
    if (reduce) { pv.style.transform = ""; return; }
    pv.style.transform = "translateX(" + (dir * w) + "px)";   // 起点: 屏幕外侧
    void pv.offsetWidth;                   // 强制回流, 让起点生效再启用 transition
    pv.style.transition = "transform " + (durMs / 1000) + "s cubic-bezier(.32,.72,0,1)";
    pv.style.transform = "translateX(0px)"; // 终点: 滑到原位
    // 滑入结束后清掉 transition (保留 translateX(0) 内联), 避免残留 transition
    // 影响后续 closeOverlay 重设曲线; 也防止关闭途中被这里覆盖。
    clearTimeout(pv._inT);
    pv._inT = setTimeout(function () { pv.style.transition = "none"; }, durMs + 60);
  }
  function openLeftPanel() {
    if (uiState !== "leftPanel") lptv._panelFrom = uiState;
    slidePanelIn(lptv.ui && lptv.ui.left, "leftPanel", -1, 360);
    renderLeftPanel();
  }
  function openRightPanel() {
    if (uiState !== "rightPanel") lptv._panelFrom = uiState;
    var rv = lptv.ui && lptv.ui.right;
    if (rv) rv._epgFocus = false;   // 每次打开重新定位到"正在播出"行
    slidePanelIn(rv, "rightPanel", 1, 360);
    renderRightPanel();
  }
  function toggleLeftPanel() { if (uiState === "leftPanel") closeOverlay(); else openLeftPanel(); }
  function toggleRightPanel() { if (uiState === "rightPanel") closeOverlay(); else openRightPanel(); }

  /* 切台状态机 (状态6 → 状态2/3): 注水动画是等待期的视觉，进度按官方
     <video> 的真实就绪度推进；确认画面可播后才淡出进播放界面。
     这样点击频道 = 注水动画 → 播放界面，不会动画转完仍停在黑屏/切换页。 */
  var _sw = null;
  var SW_MIN_MS = 700;    // 动画最短展示, 防止秒切时一闪而过 (旧版收起遮罩更快)
  var SW_MAX_MS = 12000;  // 看门狗单轮: 超时重试一次
  var SW_HARD_MAX_MS = 18000; // 总时长硬上限: 防止慢流/无事件时切换页长时间卡住

  // 无缝切换宽限: 官方播放器复用同一 <video>/同一 blob URL 换台时, 长时间播放后
  // MSE 缓冲大, 可能无缝过渡 (readyState 不掉、无 seeking/emptied/waiting 事件) →
  // loadedNew 证据缺失, 旧逻辑只能等 12s 看门狗×2 重试(≈24s)才收, 用户感知"卡死"。
  // playUrl 已切到目标台(urlOk)且画面持续在播(有帧、未暂停)超过该宽限即认定已就绪
  // (无缝切换下画面本就是新台, 无黑屏风险)。非无缝路径由 loadedNew 提前完成, 不受影响。
  var SW_SEAMLESS_GRACE_MS = 1200;

  function openSwitching(pid) {
    if (_sw && _sw.timer) clearInterval(_sw.timer);
    if (_sw && _sw.finishT) clearTimeout(_sw.finishT);
    if (_sw && _sw.fadeT) clearTimeout(_sw.fadeT);
    if (_sw && _sw.attemptT) clearTimeout(_sw.attemptT);
    // 首次点频道时启动黑幕/启动动画还在最上层 (z 高于 #lptv-root)，会把切换动画
    // 整个盖住，用户只看到启动图直到新频道出画面。切台是用户主动操作，立即撤掉。
    hideBootOverlays();
    var oldV = lptv.video;
    // 每次切台重新允许在遮罩下起播: 同一 <video> 元素被官方复用时要重置标记,
    // 否则第二次切台不会补 play → readyState 停在 0, 动画挂到看门狗。
    if (oldV) oldV.__lptvSwPlay = false;
    _sw = { pid: pid, t0: Date.now(), startedAt: Date.now(), oldVideo: oldV, done: false,
            oldSrc: oldV ? String(oldV.currentSrc || oldV.src || "") : "",
            sawLoading: false, sawStreamEvent: false,
            forceReady: false, retries: 0, urlOkAt: 0,
            timer: null, finishT: null, fadeT: null, attemptT: null };
    setView("switching");
    renderSwitching(pid);
  }

  /* 撤掉启动黑幕与启动动画遮罩, 让切换台动画可见 */
  function hideBootOverlays() {
    var sp = document.getElementById("lptv-splash");
    if (sp) {
      try { sp.style.transition = "opacity .25s"; sp.style.opacity = "0"; } catch (e) {}
      setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 280);
    }
    try { document.documentElement.classList.remove("lptv-splash-lock"); } catch (e) {}
    removeBootmask();
  }

  /* 重试触发官方切台: 看门狗在超时后重新点候选/路由, 给慢流第二次机会。
     冷启动/移动端立即切台时官方侧栏此刻往往已渲染好, 重试能真正点中按钮,
     避免直接整页重载 (重载 30s+ 且会重置整个状态机, 表现为"换台卡死")。 */
  function attemptOfficialSwitch(pid) {
    if (uiState !== "switching" || !_sw || _sw.done || _sw.pid !== pid) return;
    var cands = findOfficialButtons(pid);
    if (cands.length) {
      try { cands[0].click(); } catch (e) {}
    } else if (officialNameOf(pid) !== "") {
      try {
        history.pushState({}, "", "/tv/home?pid=" + pid);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch (e) {
        location.href = "/tv/home?pid=" + pid;
      }
    }
  }

  /* 事件是否来自“新流”: loadeddata/playing 迟到时不能直接收切换页 */
  function swStreamIsNew(pid) {
    var v = lptv.video;
    if (!v || !_sw || !pid) return false;
    var want = String(pid);
    if (String(lptv._loadedPid) === want) return true;
    var srcPid = pidFromUrl(String(v.currentSrc || v.src || ""));
    if (srcPid && srcPid === want) return true;
    if (_sw.oldVideo && v !== _sw.oldVideo) return true;
    var srcNow = String(v.currentSrc || v.src || "");
    if (_sw.oldSrc && srcNow && srcNow !== _sw.oldSrc) return true;
    return false;
  }

  /* 切台就绪度 (0-100)。必须确认“已换到目标台且新画面真正可显示”才算就绪：
     仅拿到 playurl 不算完成，旧画面仍在播也不算完成。用户要求切换页的提示
     和中部动画一直保留到下一频道画面出来才消失。 */
  function markSwStreamEvent() {
    if (uiState === "switching" && _sw && !_sw.done) _sw.sawStreamEvent = true;
  }
  function swState(pid) {
    var v = lptv.video;
    if (!v) return { score: 8, ready: false };
    var rs = v.readyState || 0;
    var want = String(pid);
    var urlOk = String(lptv._loadedPid) === want;
    var srcNow = String(v.currentSrc || v.src || "");
    var srcPid = pidFromUrl(srcNow);
    var srcOk = !!srcPid && srcPid === want;
    var elChanged = !!(_sw && _sw.oldVideo && v !== _sw.oldVideo);
    var srcChanged = !!(_sw && _sw.oldSrc && srcNow && srcNow !== _sw.oldSrc);
    // 新流开始加载时 readyState 会掉到 0/1 (或 MSE 重置); 记下来作为“确实在换流”的证据
    if (rs < 2 && _sw) _sw.sawLoading = true;
    var score = [10, 30, 62, 78, 90][Math.min(4, rs)];
    if (urlOk || srcOk || elChanged || srcChanged) score = Math.max(score, 88);
    if (v.videoWidth) score = Math.max(score, 92);
    // 换流证据: 新元素 / 新 src / src 含目标 pid / 见到加载态且 playurl 已是目标台。
    var loadedNew = srcOk || elChanged || srcChanged ||
      !!(_sw && _sw.sawLoading && urlOk) ||
      !!(_sw && _sw.sawStreamEvent && urlOk);
    // 切台期间官方播放器可能停在 paused (等用户手势): 在遮罩下先让它起播/解码,
    // 否则 readyState 一直停在 0 → 切换动画要挂到看门狗才收。
    if (urlOk && v.paused && !v.__lptvSwPlay) {
      v.__lptvSwPlay = true;
      tryPlay();
    }
    // 就绪必须拿到新流的第一帧数据 (readyState>=2 且已有内在分辨率) 才收切换页。
    // 此前 playurl 换到目标台 600ms 后即淡出, 动画消失后还要等解码出帧, 中间露一段
    // 黑屏 (用户反馈)。现在动画保留到画面真正可显示再淡出, 宁可多转一会也不露黑屏。
    // 无缝切换兜底: 官方复用同一 <video>/同一 blob URL 换台时, srcOk/elChanged/
    // srcChanged 全 false, 若长时间播放后缓冲大导致无缝过渡(无 rs 跌落/无事件),
    // loadedNew 永远 false → 旧逻辑只靠 12s 看门狗×2 重试收尾, 感知为"换台卡死"。
    // 此时 playUrl 已是目标台(urlOk)且画面一直在播(有帧、未暂停), 过宽限即认定就绪
    // (无缝切换下画面本就是新台, 不会露黑屏)。loadedNew 仍是快路径, 优先完成。
    if (urlOk && _sw && !_sw.urlOkAt) _sw.urlOkAt = Date.now();
    var seamless = !!(_sw && _sw.urlOkAt) && urlOk &&
      (Date.now() - _sw.urlOkAt >= SW_SEAMLESS_GRACE_MS) &&
      rs >= 2 && v.videoWidth > 0 && !v.paused;
    var ready = !!(_sw && _sw.forceReady) ||
      ((rs >= 2 && v.videoWidth > 0) && (loadedNew || seamless));
    if (ready) score = 100;
    return { score: score, ready: ready };
  }

  function finishSwitching() {
    if (!_sw || _sw.done) return;
    var st = swState(_sw.pid);
    if (!st.ready) return;   // 轮询/视频事件继续等
    var wait = SW_MIN_MS - (Date.now() - _sw.t0);
    if (wait > 0) {
      clearTimeout(_sw.finishT);
      _sw.finishT = setTimeout(finishSwitching, wait + 20);
      return;
    }
    _sw.done = true;
    if (_sw.timer) { clearInterval(_sw.timer); _sw.timer = null; }
    if (_sw.attemptT) { clearTimeout(_sw.attemptT); _sw.attemptT = null; }
    var swRef = _sw;
    console.log("[LPTV-switchdone] pid=" + _sw.pid + " el=" + (Date.now() - _sw.t0)
      + " rs=" + (lptv.video ? lptv.video.readyState : -1)
      + " urlOk=" + (String(lptv._loadedPid) === String(_sw.pid)));
    // 注水动画淡出 → 播放界面 (先淡出再切视图, 避免生硬跳变)
    var sw = lptv.ui && lptv.ui.switching;
    if (sw) { sw.style.transition = "opacity .22s ease"; sw.style.opacity = "0"; }
    clearTimeout(swRef.fadeT);
    swRef.fadeT = setTimeout(function () {
      // 淡出期间用户又切了台 (_sw 已换新对象): 不能再 enterPlaying 覆盖新切换页
      if (_sw !== swRef) return;
      if (sw) { sw.style.opacity = ""; sw.style.transition = ""; }
      enterPlaying(lptv.currentPid);
      // 官方播放器有时停在 paused (等用户手势): 画面就绪后补一次 play
      var v = lptv.video;
      if (v && v.paused) { lptv._autoplayPending = true; tryPlay(); }
    }, 220);
  }

  /* 设计稿切换台加载 (状态6) */
  function renderSwitching(pid) {
    var v = lptv.ui && lptv.ui.switching;
    if (!v) return;
    if (v._timer) { clearInterval(v._timer); v._timer = null; }
    v.style.transition = ""; v.style.opacity = "";
    var ch = (lptv.channels || []).find(function (c) { return c.pid === pid; });
    var chName = ch ? ch.name : "--";
    var nameEl = v.querySelector("#lv-sw-name");
    if (nameEl) nameEl.textContent = chName;
    var logoEl = v.querySelector("#lv-sw-logo");
    if (logoEl) {
      var logoSrc = (ch && lptv.logoCache[pid]) ? lptv.logoCache[pid] : '';
      logoEl.innerHTML = logoSrc ? '<img src="' + logoSrc + '" alt="">' : '';
      // 台标未缓存则触发加载（getLogoDataUri 异步回填会补 #lv-sw-logo）
      if (ch && !logoSrc) getLogoDataUri(pid);
    }
    var fromName = chNameOf(lptv._pidBefore || '');
    var fromEl = v.querySelector("#lv-sw-from");
    if (fromEl) {
      fromEl.textContent = fromName;
      fromEl.style.display = fromName ? "" : "none";
      var arrowEl = v.querySelector(".lv-sw-arrow");
      if (arrowEl) arrowEl.style.display = fromName ? "" : "none";
    }
    var toEl = v.querySelector("#lv-sw-to");
    if (toEl) toEl.textContent = chName;
    var fill = v.querySelector("#lv-sw-fill");
    var pctEl = v.querySelector("#lv-sw-pct");
    var numEl = v.querySelector("#lv-sw-num-pill");
    // 频道号胶囊: 显示目标频道全局序号 (与首页卡片/频道列表编号一致), 大号字
    var swNo = ch ? (lptv.channels.indexOf(ch) + 1) : 0;
    if (numEl) numEl.textContent = swNo ? String(swNo).padStart(2, "0") : "--";
    // 中心图标 = 品牌 logo (icon.png, 无背景), 由 preload 注入的 data URI 提供;
    // 开发态 __LPTV_ICON_SRC 为空则回退相对路径 icon.png。
    var iconImg = v.querySelector("#lv-sw-icon");
    if (iconImg) iconImg.src = (window.__LPTV_ICON_SRC || 'icon.png');
    var fake = 8, shown = 8;
    var timer = setInterval(function () {
      if (!_sw || _sw.done || _sw.pid !== pid) { clearInterval(timer); return; }
      acquireOfficial();
      var st = swState(pid);
      fake = Math.min(90, fake + Math.random() * 6);   // 等待期缓慢逼近 90%
      var target = Math.max(fake, st.score);
      shown = Math.min(100, Math.max(shown, Math.min(target, shown + 18)));
      if (fill) fill.style.width = shown + "%";
      if (pctEl) pctEl.textContent = Math.round(shown) + "%";
      if (numEl) numEl.classList.toggle("ready", !!st.ready);
      if (st.ready) finishSwitching();
      else {
        var ref = _sw;
        var totalMs = Date.now() - (ref.startedAt || ref.t0);
        var hard = totalMs > SW_HARD_MAX_MS;
        if (hard || Date.now() - ref.t0 > SW_MAX_MS) {
          // 看门狗: 单轮超时先重试一次官方切台 (给慢流第二次机会); 总时长到
          // 硬上限则强行收尾, 由播放态恢复看门狗继续兜底。此前重试 2 次会在
          // 慢流/无事件时让切换页卡到 36s, 用户感知为“切换卡住”。
          if (!hard && !ref.forceReady && (ref.retries || 0) < 1) {
            ref.retries = (ref.retries || 0) + 1;
            ref.t0 = Date.now();   // 重新计时, 本轮重试有完整窗口
            console.log("[LPTV-switchretry] pid=" + ref.pid + " retry=" + ref.retries
              + " rs=" + (lptv.video ? lptv.video.readyState : -1)
              + " urlOk=" + (String(lptv._loadedPid) === String(ref.pid)));
            clearTimeout(ref.attemptT);
            ref.attemptT = setTimeout(function () { attemptOfficialSwitch(ref.pid); }, 120);
          } else {
            ref.forceReady = true;
            finishSwitching();
          }
        }
      }
    }, 180);
    v._timer = timer;
    if (_sw) _sw.timer = timer;
  }
  function closeOverlay() {
    // 设置弹窗开着时按 Esc: 只关弹窗, 不误关左/右面板
    var s = lptv.ui && lptv.ui.settings;
    if (s && s.classList.contains("open")) { closeSettings(); return; }
    if (uiState === "leftPanel" || uiState === "rightPanel") {
      var v = uiState === "leftPanel" ? lptv.ui.left : lptv.ui.right;
      var back = lptv._panelFrom === "home" ? "home" : "playing";
      if (!v || v._closing) return;
      // 关闭: 用 transition 从"当前实际位移"平滑滑出 —— 不读 keyframe, 也不用 px→%
      // 插值(易跳变/回弹)。先停滑入 keyframe, 以当前 translateX(px) 起画, 再 transition
      // 到屏外(px→px 同单位, 连续)。两面板同一机制(方向相反)=频道列表镜像。
      var pv = v.querySelector(".lv-left-panel,.lv-right-panel");
      // 两个面板关闭逻辑完全一致, 仅方向镜像: 频道(左锚定)向左滑出自身宽度,
      // 节目单(右锚定)向右滑出自身宽度; 时长/曲线/淡出完全相同。镜像滑出后
      // 面板完全离开自身锚定的屏幕边缘, 不会停在屏中段 → 无"回弹/没滑走"。
      var dir = uiState === "rightPanel" ? 1 : -1;
      var durMs = 320;
      var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      v._closing = true;
      if (pv) {
        if (pv._inT) { clearTimeout(pv._inT); pv._inT = null; }
        var _curX = 0, _tr = getComputedStyle(pv).transform;
        if (_tr && _tr !== "none") {
          var _m = _tr.match(/matrix\(([^)]+)\)/);
          if (_m) _curX = parseFloat(_m[1].split(",")[4]) || 0;
        }
        var _w = pv.offsetWidth || 620;
        // 与频道侧栏完全对称: 滑出距离=面板自身宽度, 方向=面板锚定方向。
        var _dist = _w;
        pv.style.animation = "none";
        pv.style.transform = "translateX(" + _curX + "px)";
        void pv.offsetWidth;
        pv.style.transition = reduce ? "none" : "transform " + (durMs / 1000) + "s cubic-bezier(.77,0,.175,1)";
        pv.style.transform = "translateX(" + (dir * _dist) + "px)";
      }
      v.classList.add("lv-panel-out");
      // 淡出与滑出同长 (两侧均 320ms), 避免面板先淡尽再滑动。
      try { v.style.animationDuration = (durMs / 1000) + "s"; } catch (e) {}
      // 诊断（LPTV_PANEL_DEBUG=1 启动）：记录关闭动画每帧位移，确认是否从中途起画。
      if (window.__LPTV_PANEL_DEBUG) {
        (function () {
          var _pv = pv, _s = [], _t0 = performance.now();
          function _samp() {
            var _m = getComputedStyle(_pv).transform;
            _s.push(Math.round(performance.now() - _t0) + ":" + _m);
            if (performance.now() - _t0 < 480) requestAnimationFrame(_samp);
            else console.log("[LPTV-panel] " + _s.join(" | "));
          }
          requestAnimationFrame(_samp);
        })();
      }
      v._closeT = setTimeout(function () {
        v._closeT = null;
        v.classList.remove("lv-panel-out");
        setView(back);                    // 先切视图(隐藏面板视图), 避免面板跳回可见
        if (pv) { pv.style.animation = ""; pv.style.transition = ""; pv.style.transform = ""; }
        try { v.style.animationDuration = ""; } catch (e) {}
        v._closing = false;
        if (back === "playing") showControls(true);
      }, durMs + 40);
    }
  }

  /* 侧边面板自动隐藏: 指针离开面板区域即收起 (已去掉关闭按钮)。
     留 180ms 宽限, 避免贴着面板边缘移动时误关; 重新进入则取消。
     触摸设备无 mouseleave, 仍可点画面区/按 Esc 收起。 */
  function bindPanelAutoHide(view, panelSel, state) {
    var panel = view.querySelector(panelSel);
    if (!panel || panel._autoHideBound) return;
    panel._autoHideBound = true;
    var t = null;
    panel.addEventListener("mouseleave", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        if (uiState === state) closeOverlay();
      }, 180);
    });
    panel.addEventListener("mouseenter", function () { clearTimeout(t); });
  }

  /* 设计稿图标 (remixicon v4.0.0 矢量): 直接内联 SVG，避免远程页加载字体/外链失败 */
  var RI = {
    loader: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M18.364 5.63604L16.9497 7.05025C15.683 5.7835 13.933 5 12 5C8.13401 5 5 8.13401 5 12C5 15.866 8.13401 19 12 19C15.866 19 19 15.866 19 12H21C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C14.4853 3 16.7353 4.00736 18.364 5.63604Z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M19.376 12.4161L8.77735 19.4818C8.54759 19.635 8.23715 19.5729 8.08397 19.3432C8.02922 19.261 8 19.1645 8 19.0658V4.93433C8 4.65818 8.22386 4.43433 8.5 4.43433C8.59871 4.43433 8.69522 4.46355 8.77735 4.5183L19.376 11.584C19.6057 11.7372 19.6678 12.0477 19.5146 12.2774C19.478 12.3323 19.4309 12.3795 19.376 12.4161Z"/></svg>',
    live: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M16 4C16.5523 4 17 4.44772 17 5V9.2L22.2133 5.55071C22.4395 5.39235 22.7513 5.44737 22.9096 5.6736C22.9684 5.75764 23 5.85774 23 5.96033V18.0397C23 18.3158 22.7761 18.5397 22.5 18.5397C22.3974 18.5397 22.2973 18.5081 22.2133 18.4493L17 14.8V19C17 19.5523 16.5523 20 16 20H2C1.44772 20 1 19.5523 1 19V5C1 4.44772 1.44772 4 2 4H16ZM15 6H3V18H15V6ZM7.4 8.82867C7.47607 8.82867 7.55057 8.85036 7.61475 8.8912L11.9697 11.6625C12.1561 11.7811 12.211 12.0284 12.0924 12.2148C12.061 12.2641 12.0191 12.306 11.9697 12.3375L7.61475 15.1088C7.42837 15.2274 7.18114 15.1725 7.06254 14.9861C7.02169 14.9219 7 14.8474 7 14.7713V9.22867C7 9.00776 7.17909 8.82867 7.4 8.82867ZM21 8.84131L17 11.641V12.359L21 15.1587V8.84131Z"/></svg>',
    home: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M21 20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V9.48907C3 9.18048 3.14247 8.88917 3.38606 8.69972L11.3861 2.47749C11.7472 2.19663 12.2528 2.19663 12.6139 2.47749L20.6139 8.69972C20.8575 8.88917 21 9.18048 21 9.48907V20ZM11 13V19H13V13H11Z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M7 3V1H9V3H15V1H17V3H21C21.5523 3 22 3.44772 22 4V9H20V5H17V7H15V5H9V7H7V5H4V19H10V21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H7ZM17 12C14.7909 12 13 13.7909 13 16C13 18.2091 14.7909 20 17 20C19.2091 20 21 18.2091 21 16C21 13.7909 19.2091 12 17 12ZM11 16C11 12.6863 13.6863 10 17 10C20.3137 10 23 12.6863 23 16C23 19.3137 20.3137 22 17 22C13.6863 22 11 19.3137 11 16ZM16 13V16.4142L18.2929 18.7071L19.7071 17.2929L18 15.5858V13H16Z"/></svg>',
    vol: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    volMuted: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M22 9l-1.5-1.5L18 10l-2.5-2.5L14 9l2.5 2.5L14 14l1.5 1.5L18 13l2.5 2.5L22 14l-2.5-2.5L22 9z"/></svg>',
    volHint: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    volMutedHint: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M22 9l-1.5-1.5L18 10l-2.5-2.5L14 9l2.5 2.5L14 14l1.5 1.5L18 13l2.5 2.5L22 14l-2.5-2.5L22 9z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>'
  };

  /* 网页播放器(iframe 模型, __lptvBridge): 官方页在 #lptv-iframe 内, 顶层
     cursor 规则到不了 iframe 文档, 指针其实由 iframe 文档的光标决定 → 同源时把
     同款默认光标规则 + 空闲隐藏一并注入 iframe 文档。智慧屏(若跑 /web/)生效;
     APK/桌面无鼠标指针, 注入无副作用。跨域读不到时静默跳过。 */
  var TV_CURSOR_RULE = 'html.lptv-tv-cursor,html.lptv-tv-cursor *{cursor:' + TV_CURSOR + '!important}' +
    'html.lptv-cursor-hidden,html.lptv-cursor-hidden *{cursor:none!important}';
  function tvCursorApplyToFrame(f) {
    try {
      var d = f.contentDocument;
      if (!d || !d.documentElement) return;
      if (!d.getElementById("lptv-tv-cursor-style")) {
        var s = d.createElement("style");
        s.id = "lptv-tv-cursor-style";
        s.textContent = TV_CURSOR_RULE;
        (d.head || d.documentElement).appendChild(s);
      }
      try { d.documentElement.classList.add("lptv-tv-cursor"); } catch (e) {}
    } catch (e) {}
  }
  function tvCursorFrameIdle(hidden) {
    try {
      var f = document.getElementById("lptv-iframe");
      if (!f) return;
      var d = f.contentDocument;
      if (!d || !d.documentElement) return;
      if (hidden) d.documentElement.classList.add("lptv-cursor-hidden");
      else d.documentElement.classList.remove("lptv-cursor-hidden");
    } catch (e) {}
  }

  function buildUI() {
    // 智慧屏: 全文档统一白色圆圈光标(与智慧屏桌面根光标一致), 避免应用窗口光标
    // 覆盖根光标导致界面内显示鼠标指针。CDE/桌面不加, 保持系统鼠标指针。
    if (isTv()) {
      try { document.documentElement.classList.add("lptv-tv-cursor"); } catch (e) {}
      // 网页播放器: 官方页在 iframe 内, 顶层规则到不了 iframe → 同源时注入 iframe。
      var _tfi = document.getElementById("lptv-iframe");
      if (_tfi) {
        _tfi.addEventListener("load", function () { tvCursorApplyToFrame(_tfi); });
        tvCursorApplyToFrame(_tfi);
      }
    }
    var style = el("style", { id: "lptv-style" });
    style.textContent = CSS;
    document.head.appendChild(style);

    var root = el("div", { id: "lptv-root" });
    root.setAttribute("data-state", "home");
    // 移动客户端：响应式布局/行为分支的根标记（仅 #lptv-root.mobile 生效）。
    if (IS_MOBILE) root.classList.add("mobile");
    // 本地桌面(有真实 WM): 顶栏原生 -webkit-app-region:drag (无边框窗口)
    if (window.__LPTV_IS_CONTAINER === false) root.classList.add("lptv-native-drag");
    // 不再一上来就强制 perf: 先按 full 档运行(玻璃/动效完整), 启动后采样真实帧时长,
    // 明显卡顿才降级到 lite(perf 关毛玻璃 + motionLite 缩短动效)。见 startupPerfProbe()。
    // 软件合成(__LPTV_SOFTWARE_GPU)只作为"更快判定/更低阈值"的权重, 同样先试 full。
    // APK/触摸: 标记 root
    if (IS_TOUCH) root.classList.add("touch");

    // 设计稿视图: 频道首页 (状态1)
    var homeView = el("div", { id: "lptv-view-home", "data-view": "home" });
    root.appendChild(homeView);
    // 设计稿视图: 播放界面 (状态2/3)
    var playView = el("div", { id: "lptv-view-playing", "data-view": "playing", html:
      '<div class="lv-play-mask-top"></div><div class="lv-play-mask-bottom"></div>' +
      // 播放界面不再显示右上角 hover 时间胶囊（只保留顶部渐变遮罩与控制栏）
      '<div class="lv-vol-hint" id="lv-vol-hint"><span class="lv-vol-ico" id="lv-vol-ico"></span>' +
        '<div class="lv-vol-track"><div class="lv-vol-fill" id="lv-vol-fill"></div></div></div>' +
      '<div class="lv-play-controls">' +
        '<div class="lv-progress-row">' +
          '<div class="lv-prog-name-wrap"><span class="lv-prog-ico">' + RI.play + '</span>' +
            '<span class="lv-prog-name" id="lv-prog-name">--</span></div>' +
          '<div class="lv-prog-track" id="lv-prog-track"><div class="lv-prog-fill" id="lv-prog-fill" style="width:0%"></div><div class="lv-prog-dot" id="lv-prog-dot" style="left:0%"></div></div>' +
          '<div class="lv-prog-time"><span id="lv-prog-start">--:--</span><span class="sep">/</span><span id="lv-prog-end">--:--</span></div></div>' +
        '<div class="lv-glass-bar">' +
          '<div class="lv-bar-col left"><button class="lv-bar-btn" id="lv-b-ch"><span class="ico">' + RI.live + '</span><span>频道</span></button></div>' +
          '<div class="lv-bar-col center">' +
            '<div class="lv-bar-center-row">' +
              '<button class="lv-bar-btn lv-bar-home" id="lv-b-home"><span class="ico">' + RI.home + '</span><span>首页</span></button>' +
              '<button class="lv-bar-btn lv-bar-vol" id="lv-b-vol"><span class="ico" id="lv-b-vol-ico">' + RI.vol + '</span><span>音量</span></button></div></div>' +
          '<div class="lv-bar-col right"><button class="lv-bar-btn" id="lv-b-epg"><span class="ico">' + RI.cal + '</span><span>节目单</span></button></div></div></div>' });
    root.appendChild(playView);
    // 设计稿视图: 左侧频道面板 (状态4)
    var leftView = el("div", { id: "lptv-view-left", "data-view": "left", html:
      '<div class="lv-left-scene"></div>' +
      '<div class="lv-left-panel">' +
        '<div class="lv-left-head"><div class="lv-left-title"><span class="lv-left-bar"></span>频道</div></div>' +
        '<div class="lv-left-tabs" id="lv-left-tabs"></div>' +
        '<div class="lv-left-list" id="lv-left-list"></div>' +
        '<div class="lv-left-foot"><span id="lv-left-foot-left"></span></div></div>' });
    root.appendChild(leftView);
    // 设计稿视图: 右侧节目单面板 (状态5)
    var rightView = el("div", { id: "lptv-view-right", "data-view": "right", html:
      '<div class="lv-right-scene"></div>' +
      '<div class="lv-right-panel">' +
        '<div class="lv-right-head"><div class="lv-right-title"><span class="lv-right-bar"></span>节目单' +
          '<span class="lv-right-ch" id="lv-right-ch"></span></div></div>' +
        '<div class="lv-right-tabs" id="lv-right-tabs"></div>' +
        '<div class="lv-right-list" id="lv-right-list"></div>' +
        '<div class="lv-right-foot"><span id="lv-right-foot-left"></span></div></div>' });
    root.appendChild(rightView);
    // 设计稿视图: 切换台加载中 (状态6)
    var switchView = el("div", { id: "lptv-view-switching", "data-view": "switching", html:
      '<div class="lv-sw-dim"></div>' +
      '<div class="lv-sw-stack">' +
      '<div class="lv-sw-center">' +
        '<div class="lv-sw-ring"><div class="lv-sw-halo3"></div><svg viewBox="0 0 264 264" width="264" height="264" fill="none">' +
          '<circle cx="132" cy="132" r="112" stroke="rgba(255,255,255,.12)" stroke-width="10"/>' +
          '<circle class="lv-sw-arc" cx="132" cy="132" r="112" stroke="#6AA8FF" stroke-width="10" stroke-linecap="round" stroke-dasharray="110 594"/>' +
        '</svg><div class="num" id="lv-sw-num"><img id="lv-sw-icon" src="" alt=""></div></div>' +
      '</div>' +
      // 切换信息卡: 与圆环/图标同属一个居中的 .lv-sw-stack 组合 (用户要求)
      '<div class="lv-sw-below"><div class="lv-sw-card">' +
          '<div class="lv-sw-card-main"><div class="lv-sw-logo" id="lv-sw-logo"></div>' +
            '<div style="flex:1;min-width:0"><div class="lv-sw-name-row">' +
              '<span class="lv-sw-name" id="lv-sw-name">--</span>' +
              '<span class="lv-sw-status lv-sw-num-pill" id="lv-sw-num-pill">--</span></div>' +
            '<div class="lv-sw-from-row"><span class="lv-sw-from" id="lv-sw-from"></span>' +
              '<span class="lv-sw-arrow">' + RI.arrow + '</span>' +
              '<span class="lv-sw-to" id="lv-sw-to">--</span></div></div></div>' +
          '<div class="lv-sw-pct-row"><span class="pct" id="lv-sw-pct">8%</span></div>' +
          '<div class="lv-sw-track"><div class="lv-sw-fill" id="lv-sw-fill" style="width:8%"></div></div>' +
          '</div></div></div>' });
    root.appendChild(switchView);
    // 设置弹窗 (首页右上角齿轮): 居中模态, 顶部横排 3 标签 (上图标下文字)
    var settingsView = el("div", { id: "lptv-settings", html:
      '<div class="lv-set-card-wrap">' +
        '<div class="lv-set-tabs">' +
          '<button class="lv-set-tab on" data-tab="play">' + SET_ICO.play + '<span>播放设置</span></button>' +
          '<button class="lv-set-tab" data-tab="keys">' + SET_ICO.keys + '<span>快捷键</span></button>' +
          '<button class="lv-set-tab" data-tab="about">' + SET_ICO.about + '<span>关于</span></button>' +
        '</div>' +
        '<div class="lv-set-body">' +
          '<div class="lv-set-pane on" id="lptv-pane-play">' +
            '<div class="lv-set-sec">' +
              '<label class="lv-set-row"><span>运行程序自动播放</span>' +
                '<input type="checkbox" id="lptv-s-autoplay"></label>' +
              '<label class="lv-set-row"><span>点击频道默认全屏播放</span>' +
                '<input type="checkbox" id="lptv-s-clickfs"></label>' +
            '</div>' +
          '</div>' +
          '<div class="lv-set-pane" id="lptv-pane-keys">' +
            '<div class="lv-set-sec">' +
              '<div class="lv-kmap" id="lptv-s-kmap"></div></div>' +
          '</div>' +
          '<div class="lv-set-pane" id="lptv-pane-about">' +
            '<div class="lv-set-sec">' +
              '<img class="lv-about-logo" id="lptv-about-logo-img" alt="LPTV">' +
              '<div class="lv-about-ver" id="lptv-about-ver">版本 --</div>' +
              '<div class="lv-about-desc">懒猫微视是一款专门为懒猫微服打造的远程电视直播客户端。</div>' +
              '<div class="lv-about-slogan">为慵懒而生，享直播视听。</div>' +
              '<div class="lv-about-foot">Powered by LightOS · Made for LCMD</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' });
    root.appendChild(settingsView);
    // 版权受限提示 (官方黑屏时): 位于各视图之上、设置弹窗之下; 卡片自身可点击,
    // 外层不铺满拦截, 不挡频道/节目单面板操作。
    var noticeView = el("div", { id: "lptv-signal-notice", class: "lv-signal-notice", html:
      '<div class="ico">' + RI.info + '</div>' +
      '<div class="ttl">应版权方要求，本频道暂停提供信号</div>' +
      '<div class="sub">请切换其他频道，观看精彩节目</div>' +
      '<div class="acts">' +
        '<button class="btn primary" id="lv-notice-ch">查看频道</button>' +
        '<button class="btn" id="lv-notice-retry">重试</button>' +
      '</div>' });
    root.appendChild(noticeView);
    // 顶边不可见拖拽条 (所有视图统一): 本地桌面走 -webkit-app-region:drag (见 CSS),
    // 容器/xpra 走 bindEvents 的 mousedown 委托 → begin_window_drag。
    // z-index:50 盖住各视图(inset:0, z auto)、低于设置弹窗(60), 弹窗打开仍可点。
    // 40px 小于各视图顶边最小留白(左右面板 44px / home·切换 48px), 不遮任何按钮。
    root.appendChild(el("div", { class: "lv-drag-strip", "aria-hidden": "true" }));
    document.body.appendChild(root);

    lptv.ui = { root: root,
              home: homeView, playing: playView, left: leftView, right: rightView, switching: switchView,
              settings: settingsView, notice: noticeView };
    // 版权提示按钮: 查看频道 → 打开左侧频道面板; 重试 → 重新切当前台。
    var noticeCh = noticeView.querySelector("#lv-notice-ch");
    if (noticeCh) noticeCh.addEventListener("click", function () { openLeftPanel(); });
    var noticeRetry = noticeView.querySelector("#lv-notice-retry");
    if (noticeRetry) noticeRetry.addEventListener("click", function () {
      setSignalNotice(false);
      lptv._forceSwitch = true;
      switchChannel(lptv.currentPid);
    });
    _renderKeysPane();
    _renderAboutPane();

    acquireOfficial();
    bindEvents();
    renderHome();
    setChLabel();
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
    updateNowProg();
    updatePlayingInfo();
    updateHomeLast();
    // 首页当前频道卡片高亮刷新
    if (lptv.ui && lptv.ui.home) {
      lptv.ui.home.querySelectorAll(".lv-card").forEach(function (card) {
        var cur = card.getAttribute("data-pid") === lptv.currentPid;
        card.classList.toggle("cur", cur);
        // 当前频道的卡片右上角状态: 直播 → 正在播放 (其它频道保持 直播)
        var liveText = card.querySelector(".lv-live-text");
        if (liveText) liveText.textContent = cur ? "正在播放" : "直播";
        // 当前卡片副标题跟随真实节目名 (设计稿: 卡片底部显示正在播节目)
        if (cur) {
          var subEl = card.querySelector(".lv-card-sub");
          var c = lptv.channels.find(function (x) { return x.pid === lptv.currentPid; });
          if (subEl && c) subEl.textContent = nowProgOf(lptv.currentPid) || chSub(c);
        }
      });
    }
  }

  /* 首页底部“上次观看”随切台实时刷新 (不能只在 renderHome 时算一次) */
  function updateHomeLast() {
    var el = document.getElementById("lv-home-last");
    if (!el) return;
    var pid = cfg.lastPid || lptv.currentPid;
    var ch = lptv.channels.find(function (c) { return c.pid === pid; });
    var prog = ch ? nowProgOf(ch.pid) : "";
    el.textContent = ch ? "上次观看：" + ch.name + (prog ? " · " + prog : "") : "上次观看：--";
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
    var prog = nowProgOf(lptv.currentPid);
    var name = prog || "正在直播";
    var nameEl = document.getElementById("lv-prog-name");
    if (nameEl) nameEl.textContent = name;
    // 顶部子信息行: 当前节目名(真实 EPG), 未知则留空(设计稿副标题行)
    var subEl = document.getElementById("lv-play-sub");
    if (subEl) subEl.textContent = prog ? ("正在播出：" + prog) : "";
    var startEl = document.getElementById("lv-prog-start");
    var endEl = document.getElementById("lv-prog-end");
    var list = (lptv.epg.cache || {})[lptv.currentPid];
    if (!list || !list.length) {
      if (startEl) startEl.textContent = "--:--";
      if (endEl) endEl.textContent = "--:--";
      return;
    }
    var now = Math.floor(Date.now() / 1000);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.s0 <= now && (!p.e0 || now < p.e0)) {
        if (p.e0 && p.e0 > p.s0) {
          var pct = Math.round((now - p.s0) / (p.e0 - p.s0) * 100);
          updateProgress(pct);
          if (startEl) startEl.textContent = _epgTime(p.s0);
          if (endEl) endEl.textContent = _epgTime(p.e0);
        }
        return;
      }
    }
  }

  /* 顶部画质标签: 按视频实际渲染高度映射 (真实数据)。
     未就绪或 iframe 跨域模型拿不到 videoHeight → 设计默认"高清"(央视频直播基本 1080p/720p)。 */
  function updateQualityBadge() {
    var el = document.getElementById("lv-play-quality");
    if (!el) return;
    var h = (lptv.video && lptv.video.videoHeight) || 0;
    var label;
    if (h >= 2160) label = "4K";
    else if (h >= 1080) label = "超清";
    else if (h >= 700) label = "高清";
    else if (h >= 500) label = "标清";
    else if (h >= 300) label = "流畅";
    else label = "高清";
    if (el.textContent !== label) el.textContent = label;
  }

  // 智慧屏/CDE 模式分离信号：
  //   __lptvBridge===true ⟺ 加载了 bridge.js 的"网页/TV 播放器"（智慧屏 + Android）。
  //   __LPTV_ENV.smart/isTv===true ⟺ main 进程经 xpra 客户端判定为智慧屏（Electron
  //   前端跑在 xpra, 智慧屏=Chromium HTML5/1280x720 客户端）。二者任一即智慧屏(TV)。
  // CDE 桌面/本地桌面：Electron 前端不加载 bridge.js，且 xpra 客户端为桌面(1920x1080+)
  //   → 两信号均 false → 桌面模式。不依赖 __LPTV_ENV/IS_CONTAINER（对智慧屏+桌面都 true）。
  function isTv() {
    if (IS_MOBILE) return false;
    return window.__lptvBridge === true ||
           !!(window.__LPTV_ENV && (window.__LPTV_ENV.smart === true || window.__LPTV_ENV.isTv === true));
  }

  /* ================= 面板 / 设置 ================= */

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }



  /* ================= 节目单 (EPG) ================= */
  /* 数据源: https://capi.yangshipin.cn/api/yspepg/program/{真实pid}/{yyyyMMdd}
     官方切台时 XHR(arraybuffer) 拉取, 我们钩到即缓存; 无钩到时自行 XHR 取。
     protobuf 结构实探:
       顶层 f1=varint(200), f2 重复=len包裹的节目blob, 结尾 f3=len字符串"成功"
       每个 blob: f1(eventId str) f2(节目名 utf8) f3(开始epoch秒) f4(结束epoch秒)
                  f5("HH:MM"开始) f6("HH:MM"结束) f7(时长秒) f9/f10(len1 "1") */

  var EPG_DAY_PAST = 1;     // 过去最多 1 天 (昨天; 对齐右侧面板 5 tab: 昨天+今天+未来3)
  var EPG_DAY_FUTURE = 3;   // 未来最多 3 天 (对齐 renderRightPanel 5 tab: 昨天+今天+未来3)

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
          // 官方 2xx 但该日无节目: 也缓存空数组, 让 renderRightList 显示"当日暂无节目单"
          // 而非 cache 恒 undefined → 每次渲染都重拉 → "节目单加载中"死循环。
          else { epgStore(pid, [], ymd); }
        }
      } catch (e) {}
      lptv.epg.avail = lptv.epg.avail || {};
      lptv.epg.avail[key] = has;  // 官方无数据/404 -> false
      delete lptv.epg._fetching[key];
      if (cb) cb(has);
    };
    x.onerror = function () {
      delete lptv.epg._fetching[key];
      if (cb) cb(false);
    };
    x.send();
  }

  /* 探明官方可用日期: 从今天向两侧逐日探到首个无数据即停, 只展示官方真正有数据的日期 */

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
  }

  function epgYmdOf(off) {
    var d = new Date();
    d.setDate(d.getDate() + (off || 0));
    return ymdStr(d);
  }

  function epgSetDay(off) {
    lptv.epg._day = Math.max(-EPG_DAY_PAST, Math.min(EPG_DAY_FUTURE, off || 0));
    lptv.epg._dayMap = lptv.epg._dayMap || {};
    lptv.epg._dayMap[epgYmdOf(lptv.epg._day)] = lptv.epg._day;
  }





  var idleTimer = null;

  function wake() {
    if (lptv.devHidden) return;
    lptv.ui.root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      lptv.ui.root.classList.add("idle");
    }, cfg.autoHide);
  }

  /* 光标空闲隐藏：仅智慧屏(TV) 1.5s 不操作后隐藏白色圆圈指针，移动/按下恢复。
     CDE/桌面保持"鼠标模式"——系统鼠标指针常显，不随空闲消失（桌面窗口里光标
     突然消失不符合鼠标操作习惯）。xpra 会把远程 X 光标同步给客户端。 */
  var _cursorIdleT = null;
  function wakeCursor() {
    try { document.documentElement.classList.remove("lptv-cursor-hidden"); } catch (e) {}
    clearTimeout(_cursorIdleT);
    if (!isTv()) return;   // CDE/桌面: 鼠标模式，光标常显
    _cursorIdleT = setTimeout(function () {
      try { document.documentElement.classList.add("lptv-cursor-hidden"); } catch (e) {}
      // 网页播放器: 顶层隐藏还要同步到 iframe 文档 (iframe 光标独立)。
      if (window.__lptvBridge) tvCursorFrameIdle(true);
    }, 1500);
    if (window.__lptvBridge) tvCursorFrameIdle(false);
  }



  /* 全屏切换 (双击画面 / F11 / 控制栏全屏按钮共用), 并把按钮图标同步为当前状态 */
  var _isFull = false;   // 全屏状态跟踪 (web 全屏 / bridge fullscreen_toggle)
  function fullToggle() {
    var a = window.lptv ? window.lptv : null;
    if (a && a.fullscreen_toggle) {
      a.fullscreen_toggle().then(function (r) {
        if (!r || !r.ok) return;
        setFullIcon(r.fullscreen);
      });
    } else if (document.documentElement.requestFullscreen) {
      var df = document.documentElement.requestFullscreen();
      if (df && df.catch) df.catch(function () {});
    }
  }
  /* 点击频道默认全屏: 仅在非全屏时进入 (fullToggle 会切换, 已全屏会误退出) */
  function maybeAutoFullscreen() {
    if (_isFull) return;
    fullToggle();
  }
  function setFullIcon(full) {
    full = !!full;
    _isFull = full;
    var b = document.getElementById("lptv-b-full");
    if (b) {
      b.classList.toggle("on", full);
      setTip(b, full ? "退出全屏 (F11/双击)" : "全屏 (F11/双击)");
    }
    var t = document.getElementById("lptv-tb-fs");
    if (t) t.classList.toggle("on", full);
  }
  /* 从主进程同步真实全屏态：启动时主进程可能已进入全屏（智慧屏默认整屏），
     图标若停在"未全屏"会让首次点击/点频道误退出；CDE 窗口模式则为未全屏。 */
  function syncFullState() {
    try {
      if (!window.lptv || !window.lptv.is_fullscreen) return;
      window.lptv.is_fullscreen().then(function (r) {
        if (r && r.ok) setFullIcon(!!r.fullscreen);
      }).catch(function () {});
    } catch (e) {}
  }
  /* 小浮窗切换 (小尺寸并自动置顶); 与置顶按钮状态互通 */

  function togglePlay() {
    var v = lptv.video;
    if (!v) return;
    if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); }
    else { v.pause(); lptv._autoplayPending = false; }
    syncPlayBtn();
  }
  var _lastPlayIco = null;
  function syncPlayBtn() {
    var b = document.getElementById("lptv-b-play-ico");
    var fc = document.getElementById("lptv-fc-play-ico");
    var ico = lptv.video && lptv.video.paused
      ? '<path d="M8 5l12 7-12 7z"/>'
      : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
    // 播放图标只在状态实际切换时更新。此前每 2s 无条件重写 innerHTML, 即使
    // paused 未变也会销毁重建 SVG → 强制重排/重绘 → xpra 捕获到差异重新编码
    // → 播放时每 2s 周期性卡顿 (用户反馈"总觉得2s卡顿下")。
    if (ico === _lastPlayIco) return;
    _lastPlayIco = ico;
    if (b && lptv.video) b.innerHTML = ico;
    if (fc && lptv.video) fc.innerHTML = ico;
  }

  /* 右侧竖向音量组件 (静音图标 + 竖向刻度条): 平时隐藏, 点击音量按钮/调节时浮出。 */
  function updateVolHint(flash) {
    var vh = document.getElementById("lv-vol-hint");
    if (!vh) return;
    var vol = cfg.muted ? 0 : (cfg.volume != null ? cfg.volume : 1);
    var ico = document.getElementById("lv-vol-ico");
    if (ico) ico.innerHTML = cfg.muted ? RI.volMuted : RI.vol;
    var fill = document.getElementById("lv-vol-fill");
    if (fill) fill.style.height = Math.round(vol * 100) + "%";
    if (flash) showVolHint();
  }
  /* 浮出音量 HUD (静音图标 + 可拖动进度条), 1.2s 后自动隐藏; 拖动期间保持显示 */
  function showVolHint() {
    var vh = document.getElementById("lv-vol-hint");
    if (!vh) return;
    vh.style.display = "flex";
    clearTimeout(vh._hideT);
    var doHide = function () {
      if (vh._dragging) { vh._hideT = setTimeout(doHide, 400); return; }
      vh.style.display = "none";
    };
    vh._hideT = setTimeout(doHide, 1200);
  }
  /* 竖向刻度条: 上下拖动/点击调节 (底部=0, 顶部=1); 悬停/拖动期间保持显示。 */
  function bindVolHintDrag() {
    var vh = document.getElementById("lv-vol-hint");
    var track = vh ? vh.querySelector(".lv-vol-track") : null;
    if (!vh || !track || track._bound) return;
    track._bound = true;
    function setFromEvent(e) {
      var r = track.getBoundingClientRect();
      if (r.height <= 0) return;
      var ratio = Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
      setVolume(ratio);
    }
    track.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      vh._dragging = true;
      if (track.setPointerCapture) { try { track.setPointerCapture(e.pointerId); } catch (_) {} }
      setFromEvent(e);
      showVolHint();
    });
    track.addEventListener("pointermove", function (e) {
      if (!vh._dragging) return;
      e.preventDefault(); e.stopPropagation();
      setFromEvent(e);
    });
    function endDrag(e) {
      if (!vh._dragging) return;
      vh._dragging = false;
      if (e && e.stopPropagation) e.stopPropagation();
      showVolHint();
    }
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    // 悬停组件时暂停自动隐藏, 离开后再按 1.2s 收起; 否则从按钮移到右侧滑块途中会消失。
    vh.addEventListener("mouseenter", function () { clearTimeout(vh._hideT); });
    vh.addEventListener("mouseleave", function () { if (!vh._dragging) showVolHint(); });
    // 静音图标可点击切换静音
    var ico = vh.querySelector("#lv-vol-ico");
    if (ico) {
      ico.style.cursor = "pointer";
      ico.addEventListener("click", function (e) { e.stopPropagation(); toggleMute(); });
    }
  }

  function setVolume(v) {
    // 移动端音量走手机系统媒体音量：控制条无音量按钮，键盘/滚轮音量事件也拦掉
    // （见 keydown/wheel），这里兜底直接忽略，不写 cfg.volume/element 音量，避免
    // 破坏"系统音量接管、元素恒 1.0/不静音"的约定。
    if (IS_MOBILE) return;
    v = clamp(v, 0, 1);
    cfg.volume = v; cfg.muted = false;
    if (lptv.video) { lptv.video.volume = v; lptv.video.muted = false; }
    syncMuteBtn(); saveCfg();
    updateVolHint(true);
  }


  function toggleMute() {
    if (IS_MOBILE) return;
    cfg.muted = !cfg.muted;
    if (lptv.video) lptv.video.muted = cfg.muted;
    if (!cfg.muted && cfg.volume === 0) setVolume(0.6);
    syncMuteBtn(); saveCfg();
    updateVolHint(true);
  }
  function syncMuteBtn() {
    var b = document.getElementById("lv-b-vol");
    if (b) {
      b.classList.toggle("muted", !!cfg.muted);
      setTip(b, cfg.muted ? "取消静音 (M)" : "静音 (M)");
      var ico = document.getElementById("lv-b-vol-ico");
      if (ico) ico.innerHTML = cfg.muted ? RI.volMuted : RI.vol;
    }
  }

  function handleDigit(d) {
    lptv.digits += d;
    clearTimeout(lptv._digitT);
    if (lptv.digits.length >= 3) commitDigits();
    else lptv._digitT = setTimeout(commitDigits, 900);
  }
  function commitDigits() {
    var n = parseInt(lptv.digits, 10);
    lptv.digits = "";
    if (n >= 1 && n <= lptv.channels.length) switchChannel(lptv.channels[n - 1].pid);
  }

  function devToggle() {
    lptv.devHidden = !lptv.devHidden;
    lptv.ui.root.classList.toggle("dev-hidden", lptv.devHidden);
  }

  /* 移动端列表拖动滚动: xpra 触控经鼠标事件转发，单指拖动不会触发浏览器
     原生滚动。按住拖动改 scrollTop；拖动超过阈值时抑制随后的频道点击。 */
  function bindMobileDragScroll(list) {
    if (!list || list._mobileDrag) return;
    list._mobileDrag = true;
    var dragging = false, moved = false, startY = 0, startTop = 0;
    list.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startTop = list.scrollTop;
    });
    function onMove(e) {
      if (!dragging) return;
      var dy = e.clientY - startY;
      if (Math.abs(dy) > 8) moved = true;
      if (moved) {
        list.scrollTop = startTop - dy;
        if (e.preventDefault) e.preventDefault();
      }
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      if (moved && e && e.preventDefault) e.preventDefault();
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    list.addEventListener("click", function (e) {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    }, true);
  }

  function bindEvents() {
    var root = lptv.ui.root;
    if (IS_MOBILE) {
      bindMobileDragScroll(root.querySelector("#lv-left-list"));
      bindMobileDragScroll(root.querySelector("#lv-right-list"));
    }

    /* 顶栏拖动窗口 (容器/xpra 无 WM): 本地桌面走原生 -webkit-app-region:drag,
       这里只给非原生环境兜底。事件委托到 root, 首页重渲染后依然有效。 */
    root.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest(".lv-home-top,.lv-play-top,.lv-left-head,.lv-right-head,.lv-sw-below,.lv-drag-strip")) return;
      if (t.closest("button,input,a")) return;
      if (root.classList.contains("lptv-native-drag")) return;
      var api = window.lptv;
      if (api && api.begin_window_drag) {
        try { api.begin_window_drag(e.clientX, e.clientY, e.button + 1); } catch (err) {}
      }
    });

    /* ---- CDE/桌面: 悬停播放界面显示控制栏 (设计稿状态3) ----
     * 播放视图内已绑 mousemove/mouseleave (renderPlaying), 这里做 root 级兜底,
     * 确保任何悬停都唤醒并保持控制栏 (智慧屏用遥控键呼出, 见 keydown)。 */
    root.addEventListener("mousemove", function (e) {
      wake();
      wakeCursor();
      if (uiState === "playing") showControls(true);
    });
    /* 官方视频层/页面也在光标隐藏范围内: 在 document 捕获阶段兜底恢复光标。 */
    document.addEventListener("mousemove", wakeCursor, true);
    document.addEventListener("mousedown", wakeCursor, true);
    document.addEventListener("touchstart", wakeCursor, true);
    wakeCursor();
    /* 音量组件浮出后, 鼠标在移动途中不断续期, 避免从音量按钮移到右侧滑块途中消失。 */
    document.addEventListener("mousemove", function () {
      var vh = document.getElementById("lv-vol-hint");
      if (vh && vh.style.display === "flex") showVolHint();
    }, true);

    /* ---- 双击画面 全屏/窗口 切换 (单击不触发暂停, 空格键播放/暂停) ----
     * 全屏保留能力、无可见按钮 (设计稿); 点按钮/面板/首页卡片不触发全屏。 */
    var lastTap = 0;
    root.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.closest && t.closest("button,#lptv-view-home,#lptv-view-left,#lptv-view-right,#lptv-view-switching,#lptv-settings,.lv-drag-strip")) return;
      // 移动端：点播放画面（含官方视频层/空白区）呼出控制条；双击全屏逻辑继续。
      if (IS_MOBILE && uiState === "playing") showControls(true);
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

    /* ---- 滚轮音量 (面板/节目单内部交给原生滚动) ---- */
    root.addEventListener("wheel", function (e) {
      // 仅播放态劫持滚轮为音量; 首页/面板列表交给原生滚动
      if (uiState !== "playing") return;
      var t = e.target;
      if (t && t.closest && t.closest("#lptv-view-left,#lptv-view-right")) return;
      e.preventDefault();
      setVolume((lptv.video ? lptv.video.volume : cfg.volume) + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });


    function isTyping() {
      var ae = document.activeElement;
      return !!ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName || "");
    }
    /* 遥控器/媒体键 (cde/xpra 转发; Android KEYCODE_* 由显示端客户端转成键盘事件)。
       电视遥控常发的不是 Arrow/Enter/Escape, 而是 MediaPlayPause / AudioVolumeUp /
       ChannelUp / Backspace(返回) 等 X11 keysym。e.key 与 e.code 双通道匹配, 兜住
       XF86Audio* 落到 code、部分客户端给 key 的差异。 */
    function rcIn(k, c, names) {
      for (var i = 0; i < names.length; i++) if (k === names[i] || c === names[i]) return true;
      return false;
    }
    // web 全屏态同步 (bridge 模型经 setFullIcon 回写; 原生 requestFullscreen 走此事件)
    document.addEventListener("fullscreenchange", function () {
      try { setFullIcon(!!document.fullscreenElement); } catch (e) {}
    });
    document.addEventListener("keydown", function (e) {
      // 键盘操作同样算"用户活动": 鼠标空闲隐藏光标后, 按数字键/方向键/OK 等
      // 必须把光标唤醒, 否则用户看不到指针落点(遥控/键盘操作时尤其明显)。
      wakeCursor();
      if (e.ctrlKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); devToggle(); return; }
      // 设置弹窗打开时接管键盘: Esc 关闭, 其余按键不穿透到后台 (不改台/音量/全屏等)
      var _sv = lptv.ui && lptv.ui.settings;
      if (_sv && _sv.classList.contains("open")) {
        navEnsureSettings();
        e.preventDefault(); e.stopPropagation();
        navKey(e);
        return;
      }
      if (lptv.devHidden) return;
      // 面板正在滑出: 关闭动画期间吞掉按键 (尤其 OK/返回), 避免切台/重开打断滑出
      // 动画导致"回弹"。动画结束(_closing=false)后按键恢复正常。
      if (uiState === "leftPanel" || uiState === "rightPanel") {
        var _cv = uiState === "leftPanel" ? (lptv.ui && lptv.ui.left) : (lptv.ui && lptv.ui.right);
        if (_cv && _cv._closing) { e.preventDefault(); e.stopPropagation(); return; }
      }
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (navEnsurePanel() && navKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
      var k = e.key || "";
      var c = e.code || "";
      // 全部消费掉: 阻止官方 SPA 收到 空格/方向键/数字 等触发其内部行为
      if (/^[0-9]$/.test(k)) { e.preventDefault(); e.stopPropagation(); handleDigit(k); }
      else if (k === "ArrowUp") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("up"); else chanKey(-1); }
      else if (k === "ArrowDown") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("down"); else chanKey(1); }
      else if (k === "PageUp") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("up"); else chanKey(-1); }
      else if (k === "PageDown") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("down"); else chanKey(1); }
      else if (k === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("left"); else setVolume((lptv.video ? lptv.video.volume : cfg.volume) - 0.05); }
      else if (k === "ArrowRight") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("right"); else setVolume((lptv.video ? lptv.video.volume : cfg.volume) + 0.05); }
      else if (k === "Enter") { if (uiState === "home") { e.preventDefault(); e.stopPropagation(); playHomeFocused(); } }
      else if (rcIn(k, c, ["Select","Accept","OK"])) { if (uiState === "home") { e.preventDefault(); e.stopPropagation(); playHomeFocused(); } }
      else if (k === " ") { e.preventDefault(); e.stopPropagation(); if (uiState === "home") playHomeFocused(); else togglePlay(); }
      // 遥控器/媒体键: 播放/暂停、换台、音量、静音、返回
      else if (rcIn(k, c, ["MediaPlayPause","MediaPlay","MediaPause","Play","Pause","AudioPlay","AudioPause","MediaStop"])) { e.preventDefault(); e.stopPropagation(); togglePlay(); }
      else if (rcIn(k, c, ["MediaTrackNext","AudioNext","ChannelUp","MediaChannelUp"])) { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("down"); else chanKey(1); }
      else if (rcIn(k, c, ["MediaTrackPrevious","AudioPrev","ChannelDown","MediaChannelDown"])) { e.preventDefault(); e.stopPropagation(); if (uiState === "home") moveHomeFocus("up"); else chanKey(-1); }
      else if (rcIn(k, c, ["VolumeUp","AudioVolumeUp"])) { e.preventDefault(); e.stopPropagation(); setVolume((lptv.video ? lptv.video.volume : cfg.volume) + 0.05); }
      else if (rcIn(k, c, ["VolumeDown","AudioVolumeDown"])) { e.preventDefault(); e.stopPropagation(); setVolume((lptv.video ? lptv.video.volume : cfg.volume) - 0.05); }
      else if (rcIn(k, c, ["AudioVolumeMute","VolumeMute","Mute","AudioMute"])) { e.preventDefault(); e.stopPropagation(); toggleMute(); }
      else if (rcIn(k, c, ["Backspace","GoBack","BrowserBack"])) { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
      else if (k === "m" || k === "M") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); toggleMute(); } }
      else if (k === "c" || k === "C") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); toggleLeftPanel(); } }
      else if (k === "e" || k === "E") { if (!e.ctrlKey && !e.altKey) { e.stopPropagation(); toggleRightPanel(); } }
      else if (k === "F11") { e.preventDefault(); if (isTyping()) return; fullToggle(); }
      else if (k === "Escape") { closeOverlay(); }
      // 遥控/键盘: 播放态任意键呼出控制栏 + 自动隐藏 (不再只限智慧屏;
      // CDE 桌面用键盘操作时同样需要控制栏/光标被唤醒)。
      if (uiState === "playing") showControls(true);
      wake();
    }, true);

    // 当前节目名随节目边界自动刷新
    setInterval(function () { updateNowProg(); }, 30000);
    setInterval(function () { updatePlayingInfo(); }, 30000);  // 频道名/台标兜底刷新
    setInterval(function () { syncPlayBtn(); }, 2000);

    /* 设置弹窗: ✕/遮罩关闭, 标签切换 (齿轮按钮在 renderHome 里绑定, 因每帧重建) */
    var sRoot = lptv.ui && lptv.ui.settings;
    if (sRoot) {
      sRoot.addEventListener("click", function (e) {
        // 点击遮罩 (非卡片区) 关闭 — 关闭按钮已移除, 关闭仅靠遮罩/Esc
        if (e.target === sRoot) { closeSettings(); }
        // 标签点击由 tabSwitch 的容器委托统一处理 (不再在这里二次调用, 避免重复)
      });
      // 播放设置勾选框: 持久化到 cfg + Python 侧状态
      sRoot.addEventListener("change", function (e) {
        var t = e.target;
        if (!t || !t.id) return;
        if (t.id === "lptv-s-autoplay") {
          cfg.autoPlayOnLaunch = !!t.checked; saveCfg();
          pyStatePush({ autoPlayOnLaunch: cfg.autoPlayOnLaunch });
        } else if (t.id === "lptv-s-clickfs") {
          cfg.clickFullscreen = !!t.checked; saveCfg();
          pyStatePush({ clickFullscreen: cfg.clickFullscreen });
        }
      });
    }
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
    renderHome(); setChLabel();
    // 预取所有台标, 填充 logoCache, 下一次 renderHome 即可直接展示
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

  /* 分组顺序 (设计稿: 央视/卫视, 实际含 CGTN/地方/其他) */
  var groupOrder = ["央视", "CGTN", "卫视", "地方", "其他"];

  /* 频道归属分组: 优先用 category 字段, 缺省按名称映射 */
  function groupOf(ch) {
    var c = ch.category;
    if (c && groupOrder.indexOf(c) >= 0) return c;
    var t = ch.name || ch.official || "";
    return inferCategory(t);
  }

  /* 频道按组聚合: 仅保留 央视/卫视; CGTN 融入央视 (排在 CCTV 之后); 丢弃地方/其他 */
  function channelGroups() {
    var byGroup = {};
    (lptv.channels || []).forEach(function (ch) {
      var key = groupOf(ch);
      (byGroup[key] = byGroup[key] || []).push(ch);
    });
    // 央视组 = CCTV(央视) 在前, CGTN 在后, 各自保持原始相对顺序
    var zhongyang = (byGroup["央视"] || []).concat(byGroup["CGTN"] || []);
    var out = [];
    if (zhongyang.length) out.push({ key: "央视", label: "央视", channels: zhongyang });
    if ((byGroup["卫视"] || []).length) out.push({ key: "卫视", label: "卫视", channels: byGroup["卫视"] });
    return out;
  }

  /* 设计稿首页: 频道卡片网格 (状态1) */
  function _homeClock() {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return '<span class="lv-clock-line"><b>' + hh + ':' + mm + '</b><span class="lv-date">' +
      wd + ' ' + (d.getMonth() + 1) + '/' + d.getDate() + '</span></span>';
  }
  /* 主题切换图标: sun=切到浅色, moon=切回深色 */
  function _themeIcon(kind) {
    if (kind === "moon")
      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  }
  /* 设置弹窗图标 (与旧设置界面同款, 见 a68ccc9^) */
  function _gearIcon() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09a1.7 1.7 0 001.55-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h0a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55h0a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v0a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1z"/></svg>';
  }
  var SET_ICO = {
    play: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 5.5v13l11-6.5z"/></svg>',
    keys: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
    about: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  /* 应用主题令牌: light=true 浅色, false 深色。只切属性/图标/持久化,
     不重建首页 —— 颜色全走令牌, 重建会打断过渡并丢滚动位置。 */
  function applyThemeCore(light) {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    if (light) root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    cfg.theme = light ? "light" : "dark";
    saveCfg();
    var btn = document.getElementById("lv-theme-toggle");
    if (btn) btn.innerHTML = light ? _themeIcon("moon") : _themeIcon("sun");
  }
  /* 过渡期帧采样: 连续 3 帧 > 50ms 即永久降级 (cfg.motionLite), 供 CDE/智慧屏自保。 */
  var _mp = { raf: null, last: 0, frames: [], worst: 0, sum: 0, bad: 0 };
  function motionProbeStart() {
    _mp.frames = []; _mp.worst = 0; _mp.sum = 0; _mp.bad = 0; _mp.last = performance.now();
    function tick() {
      var now = performance.now(), dt = now - _mp.last;
      _mp.last = now;
      _mp.frames.push(Math.round(dt));
      if (dt > _mp.worst) _mp.worst = dt;
      _mp.sum += dt;
      if (dt > 50) { _mp.bad++; if (_mp.bad >= 3 && !cfg.motionLite) { cfg.motionLite = true; saveCfg(); } }
      else _mp.bad = 0;
      if (now - _mp.frames.t0 < 1200) _mp.raf = requestAnimationFrame(tick);
    }
    _mp.frames.t0 = _mp.last;
    _mp.raf = requestAnimationFrame(tick);
  }
  function motionProbeStop() {
    if (_mp.raf) cancelAnimationFrame(_mp.raf);
    _mp.raf = null;
    var n = _mp.frames.length || 1;
    window.__lptvPerf = { frames: _mp.frames, worst: Math.round(_mp.worst), avg: Math.round(_mp.sum / n) };
  }
  /* 启动性能自适应: 先按 full 档运行(玻璃/动效完整), 采样启动渲染期的真实帧时长;
     只有明显卡顿(软件合成/低帧率)才降级到 lite(perf 关毛玻璃 + motionLite 缩短动效),
     满足"先考虑 full, 不行再切过去"。软件合成(__LPTV_SOFTWARE_GPU)用更短窗口/更低阈值
     更快判定, 但仍先给 full 一个机会。采样只跑启动短窗口, 不常驻, 避免额外开销。 */
  function startupPerfProbe() {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    var soft = (window.__LPTV_SOFTWARE_GPU === true);
    var limitMs = soft ? 1400 : 2800;
    var frames = 0, bad = 0, sum = 0, t0 = performance.now(), last = t0;
    function tick() {
      var now = performance.now(), dt = now - last; last = now;
      frames++; sum += dt;
      if (dt > 50) bad++;
      if (now - t0 < limitMs) { requestAnimationFrame(tick); return; }
      var avg = sum / Math.max(1, frames);
      var degrade = (avg > 40) || (bad >= Math.max(6, Math.round(frames * 0.15)));
      if (degrade) {
        cfg.motionLite = true;   // 仅本次会话降级, 不持久化 → 下次启动仍先试 full
        root.classList.add("lptv-lite");
        root.classList.add("perf");
        console.log("[LPTV] perf degrade→lite avg=" + Math.round(avg) + "ms bad=" + bad + "/" + frames);
      } else {
        console.log("[LPTV] perf keep full avg=" + Math.round(avg) + "ms bad=" + bad + "/" + frames);
      }
    }
    requestAnimationFrame(tick);
  }
  var _themePending = null, _themeFlipT = null, _themeEndT = null;
  /* 立即收尾主题过渡: 应用挂起的目标 (可选), 清定时器与过渡层。 */
  function finishThemeTransition(applyPending) {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    if (_themeFlipT) { clearTimeout(_themeFlipT); _themeFlipT = null; }
    if (_themeEndT) { clearTimeout(_themeEndT); _themeEndT = null; }
    if (applyPending && _themePending !== null) applyThemeCore(_themePending);
    var w = document.getElementById("lptv-theme-wipe");
    if (w && w.parentNode) w.parentNode.removeChild(w);
    var e = document.getElementById("lptv-theme-edge");
    if (e && e.parentNode) e.parentNode.removeChild(e);
    root.classList.remove("lptv-theme-anim");
    _themePending = null;
  }
  /* 主题切换: 卷轴过渡——整屏遮罩淡入, 同时斜向扫描带自右向左掠过, 新界面随之显现
     (整屏是"淡入淡出"而非硬遮罩覆盖, 扫描带是掠过的高光, 读作"界面切换")。
     过渡中再点 → 挂起目标并立即收尾到新目标。lite 档缩短时长; reduced-motion 只做纯淡化。 */
  function themeTransition(light) {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    if (root.classList.contains("lptv-theme-anim")) { _themePending = light; finishThemeTransition(true); return; }
    _themePending = light;
    var reduce = _tabReduce();
    var perf = root.classList.contains("perf") || !!cfg.motionLite;
    var dur = reduce ? 200 : (perf ? 520 : 780);
    root.classList.add("lptv-theme-anim");
    var wipe = document.createElement("div");
    wipe.id = "lptv-theme-wipe";
    wipe.style.background = light ? "#eef1f6" : "#05070e";
    root.appendChild(wipe);
    var edge = null;
    if (!reduce) {
      edge = document.createElement("div");
      edge.id = "lptv-theme-edge";
      root.appendChild(edge);
    }
    void wipe.offsetWidth; // 让起点生效
    motionProbeStart();
    wipe.style.transition = "opacity " + Math.round(dur * 0.55) + "ms linear";
    wipe.style.opacity = "1";
    if (edge) {
      edge.style.opacity = "1";
      edge.style.transition = "transform " + dur + "ms cubic-bezier(.22,.61,.36,1)";
      edge.style.transform = "translateX(-2100px) skewX(-45deg)";
    }
    var flipAt = Math.round(dur * 0.6);
    _themeFlipT = setTimeout(function () {
      _themeFlipT = null;
      applyThemeCore(light);
      wipe.style.transition = "opacity .26s linear";
      wipe.style.opacity = "0";
      if (edge) edge.style.opacity = "0";
    }, flipAt);
    _themeEndT = setTimeout(function () {
      _themeEndT = null;
      motionProbeStop();
      if (wipe.parentNode) wipe.parentNode.removeChild(wipe);
      if (edge && edge.parentNode) edge.parentNode.removeChild(edge);
      root.classList.remove("lptv-theme-anim");
      if (cfg.motionLite) root.classList.add("lptv-lite");
      _themePending = null;
    }, flipAt + 300);
  }
  function toggleTheme() {
    var root = lptv.ui && lptv.ui.root;
    var isLight = !!(root && root.getAttribute("data-theme") === "light");
    // 过渡中按"挂起目标"取反, 而不是按尚未翻转的 DOM 状态
    var cur = _themePending !== null ? _themePending : isLight;
    themeTransition(!cur);
  }
  /* 频道号: 全局序号补零 (01,02...); 副标题: CCTV 取数字后描述, 其他取分组 */
  function chNum(c, gi) { return ('0' + (gi || 1)).slice(-2); }
  function chSub(c) {
    var m = /^CCTV-?[0-9]+\+?\s+(.+)$/i.exec((c && c.name) || '');
    return m ? m[1] : ((c && c.category) || '');
  }

  function renderHome() {
    var view = lptv.ui && lptv.ui.home;
    if (!view) return;
    var groups = channelGroups();
    var gi = {};  // pid -> 全局序号
    (lptv.channels || []).forEach(function (c, i) { gi[c.pid] = i + 1; });
    var html = '<div class="lv-home-bg"></div><div class="lv-home-content">';
    html += '<div class="lv-home-top">' +
      '<div class="lv-brand"><div class="lv-brand-icon"><img src="' +
        (window.__LPTV_ICON_SRC || 'icon.png') + '" alt=""></div>' +
      '<div><div class="lv-brand-text">懒猫微视</div><div class="lv-brand-sub">在线直播电视软件</div></div></div>' +
      '<div class="lv-home-topright">' +
        '<div class="lv-time-capsule" id="lv-home-clock">' + _homeClock() + '</div>' +
        '<div class="lv-hbtn-wrap">' +
          '<button class="lv-theme-toggle" id="lv-theme-toggle">' +
            ((lptv.ui && lptv.ui.root && lptv.ui.root.getAttribute("data-theme") === "light") ? _themeIcon("moon") : _themeIcon("sun")) + '</button>' +
          '<span class="lv-hbtn-label">切换主题</span></div>' +
        '<div class="lv-hbtn-wrap">' +
          '<button class="lv-settings-btn" id="lv-settings-btn">' + _gearIcon() + '</button>' +
          '<span class="lv-hbtn-label">设置</span></div>' +
        '</div></div>';
    html += '<div class="lv-home-scroll">';
    groups.forEach(function (g) {
      var expanded = !!view._expandedAll;
      var hintIcon = g.key === "央视"
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>'
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M5.6 8.6a8 8 0 000 6.8M18.4 8.6a8 8 0 010 6.8"/></svg>';
      var hintText = g.key === "央视" ? "方向键切换 · OK 键播放" : "全部频道直播中";
      html += '<div class="lv-group' + (expanded ? ' expanded' : '') + '" data-group="' + g.key + '">' +
        '<div class="lv-group-head"><span class="lv-group-bar"></span>' +
        '<span class="lv-group-title">' + g.label + '</span>' +
        '<span class="lv-group-line"></span>' +
        '<span class="lv-group-hint">' + hintIcon + hintText + '</span></div>' +
        '<div class="lv-group-cards">';
      g.channels.forEach(function (c, idx) {
        if (!expanded && idx >= 12) return;   // 默认仅 2 行 (6x2=12), 展开才显示全部
        var logoSrc = lptv.logoCache[c.pid] || '';
        var cur = c.pid === lptv.currentPid ? ' cur' : '';
        if (expanded) {
          // 展开态: 台标 + 频道号 + 频道名称 (数字/名称显示在台标下方)
          html += '<div class="lv-card lv-card-icon' + cur + '" data-pid="' + c.pid + '">' +
            '<span class="lv-card-logo">' +
              (logoSrc ? '<img src="' + logoSrc + '" alt="">' : '') + '</span>' +
            '<div class="lv-card-expanded-meta"><span class="lv-card-expanded-num">' +
              chNum(c, gi[c.pid]) + '</span><span class="lv-card-expanded-name">' + c.name +
              '</span></div></div>';
        } else {
          html += '<div class="lv-card' + cur + '" data-pid="' + c.pid + '">' +
            '<div class="lv-card-top"><span class="lv-card-num">' + chNum(c, gi[c.pid]) + '</span>' +
              '<span class="lv-live-badge"><i class="lv-live-dot"></i><span class="lv-live-text">' +
              (cur ? '正在播放' : '直播') + '</span></span></div>' +
            '<div class="lv-card-bottom"><span class="lv-card-logo">' +
              (logoSrc ? '<img src="' + logoSrc + '" alt="">' : '') + '</span>' +
            '<div class="lv-card-meta"><div class="lv-card-name">' + c.name + '</div></div></div></div>';
        }
      });
      html += '</div></div>';
    });
    // 全局唯一的展开/收起开关 (无背景条, 不遮挡卡片)
    html += '<div class="lv-home-toggle-wrap"><button class="lv-home-toggle' +
      (view._expandedAll ? ' expanded' : '') +
      '" id="lv-home-toggle">' + (view._expandedAll ? '收起全部' : '展开全部') +
      ' <span class="lv-arrow">▼</span></button></div>';
    html += '</div>';
    // 底部操作提示 (设计稿 11b: 液态玻璃胶囊 + 上次观看)
    var lastCh = lptv.channels.find(function (c) { return c.pid === (cfg.lastPid || lptv.currentPid); });
    var lastProg = lastCh ? nowProgOf(lastCh.pid) : "";
    var cursorIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3l14 7-6 2-2 6z"/></svg>';
    var okIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>';
    var mouseIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/></svg>';
    html += '<div class="lv-home-foot"><div class="lv-home-tips">' +
      '<span class="tip">' + cursorIcon + '选择频道</span><span class="sep"></span>' +
      '<span class="tip">' + okIcon + 'OK 键播放</span><span class="sep"></span>' +
      '<span class="tip">' + mouseIcon + '鼠标长按顶栏拖动窗口</span></div>' +
      '<div class="lv-home-last" id="lv-home-last">' +
        (lastCh ? '上次观看：' + lastCh.name + (lastProg ? ' · ' + lastProg : '') : '上次观看：--') +
      '</div></div></div>';
    view.innerHTML = html;
    view.querySelectorAll(".lv-card").forEach(function (card) {
      // 点卡片 -> 切台 (状态6 加载 -> 就绪状态2/3), 而非直接显示播放界面
      card.addEventListener("click", function () {
        lptv._fsOnClick = !!cfg.clickFullscreen;   // 点击频道默认全屏 (仅非全屏时进入)
        switchChannel(card.getAttribute("data-pid"));
      });
    });
    var homeToggle = view.querySelector("#lv-home-toggle");
    if (homeToggle) homeToggle.addEventListener("click", function () {
      view._expandedAll = !view._expandedAll;
      renderHome();
    });
    var themeBtn = view.querySelector("#lv-theme-toggle");
    if (themeBtn) themeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleTheme();
    });
    // 设置齿轮 (renderHome 每次重建按钮, 需每次重新绑定)
    var setBtn = view.querySelector("#lv-settings-btn");
    if (setBtn) setBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openSettings();
    });
    // 时钟每 30s 刷新
    if (!view._clockTimer) view._clockTimer = setInterval(function () {
      var c = view.querySelector("#lv-home-clock");
      if (c) c.innerHTML = _homeClock();
    }, 30000);
    // 台标懒加载
    lptv.channels.forEach(function (c) { getLogoDataUri(c.pid); });
    // 卡片焦点: 重渲染后保持上次焦点(用户导航/切台不丢); 无焦点时落到当前频道或首张。
    applyHomeFocus(lptv.homeFocusPid || lptv.currentPid || null);
  }

  /* 设计稿播放界面 (状态2/3): 更新频道信息 + 绑定控制栏按钮 */
  function updatePlayingInfo() {
    var v = lptv.ui && lptv.ui.playing;
    if (!v) return;
    var ch = lptv.channels.find(function (c) { return c.pid === lptv.currentPid; });
    var nameEl = v.querySelector("#lv-play-name");
    if (nameEl) nameEl.textContent = ch ? ch.name : "--";
    var logoEl = v.querySelector("#lv-play-logo");
    if (logoEl) logoEl.innerHTML = (lptv.logoCache[lptv.currentPid])
      ? '<img src="' + lptv.logoCache[lptv.currentPid] + '" alt="">' : '';
    // 播放界面右上角时间胶囊已移除，这里不再更新时间/日期（首页时钟保留）。
  }
  function updateProgress(p) {
    var v = lptv.ui && lptv.ui.playing;
    if (!v) return;
    var pct = Math.max(0, Math.min(100, (p || 0)));
    var fill = v.querySelector("#lv-prog-fill"), dot = v.querySelector("#lv-prog-dot");
    if (fill) fill.style.width = pct + "%";
    if (dot) dot.style.left = pct + "%";
  }
  function renderPlaying() {
    var v = lptv.ui && lptv.ui.playing;
    if (!v) return;
    if (!v._bound) {
      v._bound = true;
      var bCh = v.querySelector("#lv-b-ch"), bHome = v.querySelector("#lv-b-home"), bEpg = v.querySelector("#lv-b-epg");
      if (bCh) bCh.addEventListener("click", openLeftPanel);
      if (bHome) bHome.addEventListener("click", goHome);
      if (bEpg) bEpg.addEventListener("click", openRightPanel);
      var bVol = v.querySelector("#lv-b-vol");
      if (bVol) bVol.addEventListener("click", function () { updateVolHint(true); });
      bindVolHintDrag();
      // CDE 悬停显示/隐藏控制栏 (智慧屏用遥控键, Task 9 处理)
      v.addEventListener("mousemove", function () { showControls(true); });
      v.addEventListener("mouseleave", function () { showControls(false); });
      // 频道信息每 30s 兜底刷新（播放界面不再有右上角时钟）
      if (!v._clockTimer) v._clockTimer = setInterval(function () {
        if (uiState === "playing") updatePlayingInfo();
      }, 30000);
    }
    updatePlayingInfo();
  }

  /* 设计稿左侧频道面板 (状态4) */
  /* 频道列表渲染 (分组切换/面板打开时调用; 只重建列表, 不重建 tab) */
  function renderLeftList(v, groups, active) {
    var listEl = v.querySelector("#lv-left-list");
    if (!listEl) return;
    var g = groups.find(function (x) { return x.key === active; });
    var html = (g ? g.channels : []).map(function (c) {
      var cur = c.pid === lptv.currentPid;
      var logoSrc = lptv.logoCache[c.pid] || '';
      var idx = lptv.channels.indexOf(c) + 1;
      return '<div class="lv-left-item' + (cur ? ' cur' : '') + '" data-pid="' + c.pid + '">' +
        '<span class="lv-left-num">' + String(idx).padStart(2, "0") + '</span>' +
        '<span class="lv-left-logo">' + (logoSrc ? '<img src="' + logoSrc + '" alt="">' : '') + '</span>' +
        '<span class="lv-left-name">' + c.name + '</span>' +
        (cur ? '<span class="lv-left-playing"><i class="bar"></i>正在播放</span>'
             : '<span class="lv-left-prog">' + (nowProgOf(c.pid) || '') + '</span>') +
        '</div>';
    }).join("");
    listEl.innerHTML = html || '<div style="padding:24px;color:var(--tx3)">暂无频道</div>';
    listEl.querySelectorAll(".lv-left-item").forEach(function (item) {
      item.addEventListener("click", function () {
        switchChannel(item.getAttribute("data-pid"));
      });
    });
    // 焦点/滚动到当前正在播放的频道: 打开频道面板/切组时让当前频道可见, 并把它作为
    // 上下导航的起始焦点 (此前焦点固定从列表第一项开始, 当前频道在可视区外就看不到;
    // "焦点需要显到正在播放的频道上下" 回归)。当前频道不在本组时(.cur 不存在)不覆盖,
    // 由 navMove 按 -1 从第一项开始, 不误跳。
    // 焦点环立即显式落在当前频道上 (不等到第一次按键才出现), 列表居中显示上下相邻台。
    var _curItem = listEl.querySelector(".lv-left-item.cur");
    if (_curItem) {
      listEl.querySelectorAll(".lv-left-item.focus").forEach(function (x) { x.classList.remove("focus"); });
      _curItem.classList.add("focus");
      try { _curItem.scrollIntoView({ block: "center" }); } catch (e) {}
      listEl._lptvFocusScrolled = true;   // 见 tabSwitch.apply: 保留焦点滚动位置
      var _curIdx = Array.prototype.indexOf.call(listEl.querySelectorAll(".lv-left-item"), _curItem);
      if (_curIdx >= 0) {
        _navMem["leftPanel"] = _curIdx;
        // 面板重开时 _nav 可能还是上次的实例, 同步起始索引, 否则上下键从旧位置跳。
        if (_nav && _nav.key === "leftPanel") _nav.idx = _curIdx;
      }
    }
    lptv.channels.forEach(function (c) { getLogoDataUri(c.pid); });
    // 其它频道当前节目: EPG 可能只缓存了当前频道, 按需拉取并就地回填 (不重绘, 保滚动位置)
    var ymd0 = epgYmdOf(0);
    (g ? g.channels : []).forEach(function (c) {
      var key = c.pid + "|" + ymd0;
      if ((lptv.epg.cache || {})[key]) return;
      epgFetch(c.pid, ymd0, function () {
        var el = listEl.querySelector('.lv-left-item[data-pid="' + c.pid + '"] .lv-left-prog');
        if (el) el.textContent = nowProgOf(c.pid) || "";
      });
    });
  }

  function renderLeftPanel() {
    var v = lptv.ui && lptv.ui.left;
    if (!v) return;
    var groups = channelGroups();
    var tabsEl = v.querySelector("#lv-left-tabs");
    var listEl = v.querySelector("#lv-left-list");
    var footEl = v.querySelector("#lv-left-foot");
    // 打开面板时定位到"正在播放频道"所在分组: 当前台属于卫视时默认仍显示央视组会
    // 看不到当前台(无 .cur/焦点)。只在打开时选择, 用户手动切组后不再强制拉回。
    var curCh = (lptv.channels || []).find(function (c) { return c.pid === lptv.currentPid; });
    var curGroup = curCh ? groupOf(curCh) : null;
    var active = v._activeGroup || (groups[0] && groups[0].key) || "央视";
    if (curGroup && groups.some(function (g) { return g.key === curGroup; })) {
      active = curGroup;
      v._activeGroup = active;
    }
    // 分组切换 tab: 只建一次, 之后由 tabSwitch 移动指示条 (不再整段重建)
    if (tabsEl) {
      var sameSet = v._tabKeys && v._tabKeys.length === groups.length &&
        groups.every(function (g, i) { return v._tabKeys[i] === g.key; });
      if (!v._tabSw || !sameSet) {
        if (v._tabSw) v._tabSw.dispose();
        v._tabKeys = groups.map(function (g) { return g.key; });
        tabsEl.innerHTML = groups.map(function (g) {
          return '<button class="lv-left-tab" data-group="' + g.key + '"><span class="lt">' + g.label + '</span></button>';
        }).join("");
        v._tabSw = tabSwitch(tabsEl, {
          tabSel: ".lv-left-tab", attr: "data-group", content: listEl, scrollEl: listEl,
          onChange: function (name) { v._activeGroup = name; renderLeftList(v, groups, name); }
        });
      }
      var changed = v._tabSw.select(active, !v._tabFirst);
      v._tabFirst = true;
      if (!changed) renderLeftList(v, groups, active);
    } else {
      renderLeftList(v, groups, active);
    }
    // 面板底部统计 (设计稿: 左计数 / 右滚动提示)
    var footLeft = v.querySelector("#lv-left-foot-left");
    if (footLeft) {
      var cnt = {};
      groups.forEach(function (x) { cnt[x.key] = x.channels.length; });
      footLeft.textContent = "央视 " + (cnt["央视"] || 0) + " 个 · 卫视 " + (cnt["卫视"] || 0) + " 个";
    }
    // 右侧画面区的液态玻璃胶囊: 正在播放 + 时间
    var ch = lptv.channels.find(function (c) { return c.pid === lptv.currentPid; });
    var capLogo = v.querySelector("#lv-left-cap-logo");
    if (capLogo) {
      var ls = lptv.logoCache[lptv.currentPid];
      capLogo.innerHTML = ls ? '<img src="' + ls + '" alt="">' : '';
    }
    var capText = v.querySelector("#lv-left-cap-text");
    if (capText) {
      var prog = nowProgOf(lptv.currentPid);
      capText.textContent = "正在播放：" + (ch ? ch.name : "--") + (prog ? " · " + prog : "");
    }
    var d = new Date();
    var ct = v.querySelector("#lv-left-clock-time");
    if (ct) ct.textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    var cd = v.querySelector("#lv-left-clock-date");
    if (cd) cd.textContent = "周" + "日一二三四五六".charAt(d.getDay()) + " " +
      (d.getMonth() + 1) + "/" + d.getDate();
    if (!v._bound) {
      v._bound = true;
      bindPanelAutoHide(v, ".lv-left-panel", "leftPanel");
      var scene = v.querySelector(".lv-left-scene");
      if (scene) scene.addEventListener("click", closeOverlay);
    }
  }

  /* 设计稿右侧节目单面板 (状态5) */
  function _epgTime(s) {
    if (!s) return "--:--";
    var d = new Date(s * 1000);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function _epgWeekday(off) {
    var d = new Date(); d.setDate(d.getDate() + off);
    return "周" + "日一二三四五六".charAt(d.getDay());
  }
  /* 节目列表渲染 (日期切换/面板打开时调用; 只重建列表, 不重建 tab) */
  function renderRightList(v, off) {
    var listEl = v.querySelector("#lv-right-list");
    if (!listEl) return;
    var ymd = epgYmdOf(off);
    var pid = lptv.currentPid;
    var key = pid + "|" + ymd;
    var list = (lptv.epg.cache || {})[key];
    if (!list) {
      listEl.innerHTML = '<div style="padding:24px;color:var(--tx3)">节目单加载中…</div>';
      epgFetch(pid, ymd, function () {
        if (lptv.currentPid !== pid || lptv.epg._day !== off) return; // 过期回调不覆盖当前日期
        renderRightList(v, off);
      });
      return;
    }
    if (!list.length) { listEl.innerHTML = '<div style="padding:24px;color:var(--tx3)">当日暂无节目单</div>'; return; }
    var now = Math.floor(Date.now() / 1000);
    var items = list.map(function (p) {
      var isNow = (p.s0 <= now && (!p.e0 || now < p.e0));
      var isPast = !!(p.e0 && p.e0 < now);
      var pct = 0;
      if (isNow && p.e0 > p.s0) pct = Math.round((now - p.s0) / (p.e0 - p.s0) * 100);
      var bk = pid + "|" + ymd + "|" + p.s0;
      var booked = !!cfg.epgBooks[bk];
      var right = isNow
        ? '<span class="lv-right-badge"><i class="dot"></i>正在播出</span>'
        : (isPast ? '<span class="lv-right-status">已播出</span>'
          : '<button class="lv-right-book' + (booked ? ' on' : '') + '" data-key="' + bk + '">' +
            (booked ? '✓ 已预约' : '＋ 预约') + '</button>');
      return '<div class="lv-right-item' + (isNow ? ' now' : '') + '">' +
        '<span class="lv-right-time">' + _epgTime(p.s0) + '</span>' +
        '<div class="lv-right-meta"><div class="lv-right-pt">' + p.name + '</div>' +
        (isNow ? '<div class="lv-right-prog"><span class="track"><i class="fill" style="width:' +
          pct + '%"></i></span><span class="pct">' + pct + '%</span></div>' : '') +
        '</div>' + right + '</div>';
    }).join("");
    listEl.innerHTML = items;
    listEl.querySelectorAll(".lv-right-book").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var k = b.getAttribute("data-key");
        if (cfg.epgBooks[k]) delete cfg.epgBooks[k]; else cfg.epgBooks[k] = 1;
        saveCfg();
        renderRightPanel();
      });
    });
    // 默认焦点: 打开节目单/切到"今天"时, 滚动并高亮"正在播出"行 (不打断后续操作;
    // 同一天内的重渲染(预约/数据刷新)保持当前滚动位置)
    var dayChanged = v._epgDay !== off;
    if (off === 0 && (dayChanged || v._epgFocus !== true)) {
      var nowItem = listEl.querySelector(".lv-right-item.now");
      if (nowItem) {
        nowItem.classList.add("focus");
        try { nowItem.scrollIntoView({ block: "center" }); } catch (e) {}
        listEl._lptvFocusScrolled = true;   // 见 tabSwitch.apply: 保留焦点滚动位置
        // 上下导航从"正在播出"行开始: 同步 _navMem, 否则首次按上下会把焦点从
        // 正在播出行跳到列表第一项 (navMove 用 _navMem 起始; 此处只设右面板键)。
        var _nowIdx = Array.prototype.indexOf.call(listEl.querySelectorAll(".lv-right-item"), nowItem);
        if (_nowIdx >= 0) {
          _navMem["rightPanel"] = _nowIdx;
          // 面板重开时 _nav 可能仍是上次实例, 同步起始索引, 否则上下键从旧位置跳。
          if (_nav && _nav.key === "rightPanel") _nav.idx = _nowIdx;
        }
      }
      v._epgFocus = true;
    }
    v._epgDay = off;
  }

  function renderRightPanel() {
    var v = lptv.ui && lptv.ui.right;
    if (!v) return;
    if (!v._bound) {
      v._bound = true;
      bindPanelAutoHide(v, ".lv-right-panel", "rightPanel");
      var scene = v.querySelector(".lv-right-scene");
      if (scene) scene.addEventListener("click", closeOverlay);
    }
    var ch = lptv.channels.find(function (c) { return c.pid === lptv.currentPid; });
    // 标题行副标题 (设计稿: 频道名)
    var chEl = v.querySelector("#lv-right-ch");
    if (chEl) chEl.textContent = ch ? ch.name : "";
    // 左侧画面区信息 (液态玻璃): 台标 + 频道名 + 正在播出
    var sceneLogo = v.querySelector("#lv-right-scene-logo");
    if (sceneLogo) {
      var sls = lptv.logoCache[lptv.currentPid];
      sceneLogo.innerHTML = sls ? '<img src="' + sls + '" alt="">' : '';
    }
    var sceneName = v.querySelector("#lv-right-scene-name");
    if (sceneName) sceneName.textContent = ch ? ch.name : "--";
    var sceneSub = v.querySelector("#lv-right-scene-sub");
    if (sceneSub) sceneSub.textContent = "正在播出：" + (nowProgOf(lptv.currentPid) || "正在直播");

    var tabsEl = v.querySelector("#lv-right-tabs");
    var listEl = v.querySelector("#lv-right-list");
    var off = lptv.epg._day || 0;
    // 日期 tab: 昨天 + 今天 + 未来 3 天 (共 5 天: 周X + MM/DD)。只建一次, 跨天时按日期键重建。
    if (tabsEl) {
      var dayKey = epgYmdOf(0);
      if (!v._tabSw || v._tabDayKey !== dayKey) {
        if (v._tabSw) v._tabSw.dispose();
        v._tabDayKey = dayKey;
        var html = "";
        for (var off2 = -1; off2 <= 3; off2++) {
          var d = new Date(); d.setDate(d.getDate() + off2);
          var label = off2 === -1 ? "昨天" : (off2 === 0 ? "今天" : (off2 === 1 ? "明天" : "周" + "日一二三四五六".charAt(d.getDay())));
          html += '<button class="lv-right-tab" data-off="' + off2 + '">' +
            '<span class="dt">' + label + '</span><span class="dw">' +
            (d.getMonth() + 1) + '/' + d.getDate() + '</span></button>';
        }
        tabsEl.innerHTML = html;
        v._tabSw = tabSwitch(tabsEl, {
          tabSel: ".lv-right-tab", attr: "data-off", content: listEl, scrollEl: listEl,
          onChange: function (name) { var o = parseInt(name, 10); epgSetDay(o); renderRightList(v, o); }
        });
      }
      var changed = v._tabSw.select(String(off), !v._tabFirst);
      v._tabFirst = true;
      if (!changed) renderRightList(v, off);
    } else {
      renderRightList(v, off);
    }
    // 底部: 预约统计 + 免责声明 (设计稿)
    var footLeft = v.querySelector("#lv-right-foot-left");
    if (footLeft) {
      var todayYmd = epgYmdOf(0);
      var prefix = lptv.currentPid + "|" + todayYmd + "|";
      var n = 0;
      for (var k2 in cfg.epgBooks) {
        if (cfg.epgBooks.hasOwnProperty(k2) && k2.indexOf(prefix) === 0) n++;
      }
      footLeft.textContent = "今天已预约 " + n + " 个节目，开始前 5 分钟提醒";
    }
  }

  lptv.switchChannel = function (pid) { switchChannel(pid); };
  lptv.getPlayUrl = function () {
    if (lptv.playUrl) return lptv.playUrl;
    if (lptv.currentHls && lptv.currentHls.url) return lptv.currentHls.url;
    var src = lptv.video && lptv.video.currentSrc;
    return src && src.indexOf("http") === 0 ? src : "";
  };

  /* ================= 启动 ================= */

  function initChannels(retries) {
    retries = retries || 0;
    if (window.lptv && window.lptv.get_channels) {
      window.lptv.get_channels().then(function (chs) {
        lptv.setChannels(chs);
        renderHome();
        // 首页已渲染: 撤掉启动黑幕, 让 splash 的 quick 判定看到首页卡片后淡出。
        // 这一步是"启动直达首页、不露央视频原页"的关键时序点。
        lptv._homeReady = true;
        try { document.documentElement.setAttribute("data-lptv-home-ready", "1"); } catch (e) {}
        removeBootmask();
        var m = location.href.match(/pid=(\d+)/);
        var urlPid = m ? m[1] : "";
        // 入口=频道首页、默认不自动播放: 没有 urlPid 时不要把首频道设为当前频道,
        // 否则首页会有一张卡片显示"正在播放"(实际并没播)。点卡片才设置 currentPid。
        // 页面本身带 pid(外部深链/网页播放器)时才沿用。
        lptv.currentPid = urlPid || "";
        // 跨启动状态合并 (favs/lastPid/resumeLast 存 Python 侧)
        var api2 = pyApi();
        var resumeFlow = function () {
          // 设计决策 (用户拍板 A): 桌面/智慧屏入口=频道首页, 不自动播放。
          // 移动端是纯播放器：直达上次频道；首次（无 lastPid）用频道表首个 CCTV-1。
          markActive();
          if (IS_MOBILE) {
            var mpid = cfg.lastPid || (chs[0] && chs[0].pid);
            if (mpid) {
              // 移动端冷启动: 官方频道侧栏/播放器可能尚未渲染, 立即 switchChannel
              // 会走 pushState 空路由 (官方 SPA 不响应) → 流不启动 → 整页重载循环
              // ("启动即卡在切换圆圈")。先等侧栏出现 (或画面已在目标台) 再切;
              // 兜底 4s 后仍无侧栏也切 (切台看门狗会重试点按钮)。
              var mobTries = 0;
              (function tryMobileSwitch() {
                var mv = lptv.video;
                var mvReady = mv && mv.readyState >= 2 && mv.videoWidth > 0;
                if (mvReady || findOfficialButtons(mpid).length || mobTries >= 16) {
                  switchChannel(mpid);
                  return;
                }
                mobTries++;
                setTimeout(tryMobileSwitch, 250);
              })();
            }
            return;
          }
          // 播放设置: 运行程序自动播放 → 直接切到上次频道 (switchChannel 有无候选兜底)
          if (cfg.autoPlayOnLaunch) {
            var pid = cfg.lastPid || lptv.currentPid;
            if (pid) switchChannel(pid);
          }
        };
        if (api2 && api2.get_ui_state) {
          api2.get_ui_state().then(function (st) {
            if (st && st.ok) {
              if (typeof st.resumeLast === "boolean") cfg.resumeLast = st.resumeLast;
              if (st.lastPid) cfg.lastPid = st.lastPid;
              // 画面模式跨启动恢复 (contain/cover/fill)
              if (typeof st.fit === "string") {
                // 智慧屏默认铺满：旧的 contain(历史默认) 迁移到 cover
                cfg.fit = (isTv() && st.fit === "contain") ? "cover" : st.fit;
                styleOfficial();
              }
              // 自动全屏: 启动时按设置进入沉浸观看
              if (st.autoFullscreen) {
                setTimeout(function () { fullToggle(); }, 2600);
              }
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
            renderHome(); markActive(); setChLabel();
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


  /* 按窗口宽度动态调整字体/控件缩放比 (基准 1280px = scale 1, 最大 1.5x) */
  function applyFsScale() {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    if (IS_MOBILE) { root.style.setProperty('--fs-scale', '1'); return; }
    var w = window.innerWidth || document.documentElement.clientWidth || 1280;
    var s = Math.max(0.85, Math.min(1.5, w / 1280));
    root.style.setProperty('--fs-scale', s.toFixed(3));
  }
  window.addEventListener('resize', applyFsScale);

  /* 设计稿 1920x1080 基准 → 视口缩放。
     - 智慧屏/Android（isTv）：等比 min() 铺满/居中，行为与改动前一致。
     - Electron 桌面（CDE/本地桌面）：按视口两轴分别缩放（非等比），画布正好
       覆盖视口 → 零黑边、零裁切；非 16:9 视口会有轻微拉伸变形（用户已选）。
     注: 此前曾按 perf + (1-s) 给面板/控制栏加 --lv-panel-dx 平移补偿, 但该补偿
     只对单一环境实测偏移成立, 在容器/CDE 窗口尺寸下过补偿 → 面板/控制栏水平错位,
     故已移除 (见 CSS 对应注释), 面板/控制栏恢复自然定位。 */
  function applyDesignScale() {
    var root = lptv.ui && lptv.ui.root;
    if (!root) return;
    var vw = window.innerWidth || document.documentElement.clientWidth || 1920;
    var vh = window.innerHeight || document.documentElement.clientHeight || 1080;
    // 移动端：不用 1920 画布缩放，根节点直接铺满视口，布局由 #lptv-root.mobile
    // 的响应式 CSS 控制（zoom=1 保证文字按真实 px 栅格化）。
    if (IS_MOBILE) {
      root.style.zoom = "1";
      root.style.transform = "none";
      root.style.left = "0px";
      root.style.top = "0px";
      return;
    }
    var desktop = !!(window.lptv && !isTv());
    // 用 zoom 做等比缩放: 文字按缩放后尺寸重栅格化 → 不发虚。transform:scale 会把
    // 整个画布当一张图缩放, 文字不重栅格化 → 模糊(软件合成下尤甚, 且非等比还会拉伸)。
    // zoom 双值(非等比)本 Chromium 不支持, 故:
    //  - 智慧屏/Android (等比 min 铺满/居中): 直接 zoom=s。
    //  - Electron 桌面 (用户选的非等比铺满零黑边): zoom=min 做清晰基准, 残余
    //    (sx/z, sy/z) 用 transform 拉伸铺满 (非 16:9 视口的轻微拉伸变形, 用户已选)。
    //    transform-origin:top left → 从 (0,0) 铺满视口。
    if (desktop) {
      var sx = vw / 1920, sy = vh / 1080;
      var z = Math.min(sx, sy);
      root.style.zoom = z.toFixed(4);
      root.style.transform = "scale(" + (sx / z).toFixed(4) + "," + (sy / z).toFixed(4) + ")";
      root.style.left = "0px";
      root.style.top = "0px";
      return;
    }
    var s = Math.min(vw / 1920, vh / 1080);
    root.style.zoom = s.toFixed(4);
    root.style.transform = "none";
    root.style.left = Math.round((vw - 1920 * s) / 2) + "px";
    root.style.top = Math.round((vh - 1080 * s) / 2) + "px";
  }
  window.addEventListener('resize', function () {
    applyDesignScale();
    // 窗口尺寸变化（含进出全屏）→ 同步真实全屏态（主进程 setFullScreen 后才变）
    syncFullState();
  });

  /* 移动端竖屏引导：真·触摸设备（非 __lptvBridge，避免桌面竖窗误判）竖屏时
     先 best-effort 锁横屏（Capacitor/全屏可用；普通浏览器静默失败），不行则
     显示全屏“请横屏观看”覆盖层，避免 1920x1080 设计画布在竖屏缩成小条。 */
  function applyRotatePrompt() {
    // 懒猫移动客户端在服务端 Electron 里媒体查询不可靠（看到的是虚拟鼠标），
    // 所以移动端用 IS_MOBILE 直接触发竖屏提示；其他触摸设备仍走媒体查询。
    var isMobile = IS_MOBILE || (window.matchMedia &&
      window.matchMedia("(hover: none) and (pointer: coarse)").matches);
    var prompt = document.getElementById("lptv-rotate-prompt");
    if (!isMobile) {
      if (prompt) prompt.style.display = "none";
      return;
    }
    var portrait = (window.innerHeight || 0) > (window.innerWidth || 0);
    if (portrait && window.screen && window.screen.orientation &&
        typeof window.screen.orientation.lock === "function") {
      try {
        var p = window.screen.orientation.lock("landscape");
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
    if (!prompt) {
      prompt = document.createElement("div");
      prompt.id = "lptv-rotate-prompt";
      prompt.style.cssText = "position:fixed;inset:0;z-index:2147483002;background:#04070d;" +
        "color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
        "gap:14px;font-family:system-ui,-apple-system,sans-serif;text-align:center;";
      prompt.innerHTML =
        '<div style="font-size:42px;line-height:1">&#x1F504;</div>' +
        '<div style="font-size:20px;font-weight:600">请横屏观看</div>' +
        '<div style="font-size:14px;opacity:.7">请旋转设备，或点击全屏后自动横屏</div>';
      document.documentElement.appendChild(prompt);
    }
    prompt.style.display = portrait ? "flex" : "none";
  }
  window.addEventListener('orientationchange', applyRotatePrompt);
  window.addEventListener('resize', applyRotatePrompt);

  /* 深色底衬: 铺满视口, z-index 在页面UI之上、视频(2147483001)之下。
     拖动/缩放时盒子软件合成重绘滞后, 视频暴露区未即时重绘 → 露出官方播放器的
     白色信息条(标题+台标)。此底衬让暴露区显示深色而非白块。pointer-events:none
     不影响交互。SPA 重渲染可能移除, 由保活重新挂载。 */
  function ensureCover() {
    // APK(Capacitor iframe)模型: index.html 含 #lptv-iframe, 央视频视频在 iframe 内
    // (z-index 仅 1)。深色底衬 z-index 2147483000 会盖住 iframe → 视频黑屏。
    // 仅 Electron 顶层视频模型(视频 z-index 2147483001 > 底衬)才加底衬。
    if (document.getElementById("lptv-iframe")) return;
    var c = document.getElementById("lptv-cover");
    if (!c) {
      c = document.createElement("div");
      c.id = "lptv-cover";
      c.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#04070d;pointer-events:none;";
      document.documentElement.appendChild(c);
    }
    return c;
  }

  function boot() {
    // 页面深色底: 拖动/缩放时新暴露区域若未被视频即时重绘, 显示深色而非白底,
    // 消除"白线/白块"(xpra 软件合成重绘延迟下, 白底在深色视频旁极显眼)。
    // !important: 官方页 CSS 可能设白底, 用 important 压住, 防启动淡出露白闪。
    try {
      document.documentElement.style.setProperty("background", "#04070d", "important");
      document.body.style.setProperty("background", "#04070d", "important");
    } catch (e) {}
    ensureCover();
    // 启动首页 = splash 动画(logo 上下跳动)里加载央视频网站进 iframe, 就绪后露首页。
    // 这样"打开首页时央视频已注入, 点频道即可切换", 而非 iframe 空白、点频道才冷加载。
    // 仅网页播放器 (__lptvBridge) + 非自动播放 (自动播放由 resumeFlow 走 switchChannel
    // 载入上次频道, 不预载首页, 避免两个 iframe 导航竞争)。预载用央视频 TV 首页
    // (无频道, 不自动发声)。
    if (window.__lptvBridge && !cfg.autoPlayOnLaunch) {
      try {
        var _pf = document.getElementById("lptv-iframe");
        if (_pf && !_pf.getAttribute("src")) {
          var _ybase = (window.__LPTV_YSP_BASE !== undefined)
            ? window.__LPTV_YSP_BASE : "https://www.yangshipin.cn";
          _pf.setAttribute("src", _ybase + "/tv/home");
        }
      } catch (e) {}
    }
    applyFsScale();
    installHlsHooks();
    buildUI();
    // 启动性能自适应: 先 full, 采样启动渲染帧时长, 明显卡顿才降级 lite。
    startupPerfProbe();
    // 启动恢复持久化主题 (data-theme=light → 浅色)
    if (cfg.theme === "light" && lptv.ui && lptv.ui.root)
      lptv.ui.root.setAttribute("data-theme", "light");
    if (cfg.motionLite && lptv.ui && lptv.ui.root) lptv.ui.root.classList.add("lptv-lite");
    // 首页时间胶囊默认隐藏, 首次鼠标交互 (root mousemove → wake) 后浮现
    if (lptv.ui && lptv.ui.root) lptv.ui.root.classList.add("idle");
    loadHomeBg();
    applyFsScale();
    applyDesignScale();
    // 启动全屏状态同步：主进程可能已在启动时进入全屏（CDE 默认铺满），让控制栏
    // 图标与实际状态一致（否则首次点击/点频道会误退出全屏）。
    syncFullState();
    applyRotatePrompt();
    if (IS_MOBILE) {
      // 移动端没有 Manifest 可强制横屏：网页层 best-effort 锁横屏；失败由
      // applyRotatePrompt 的竖屏提示兜底。
      try {
        if (window.screen && window.screen.orientation &&
            typeof window.screen.orientation.lock === "function") {
          var _op = window.screen.orientation.lock("landscape");
          if (_op && _op.catch) _op.catch(function () {});
        }
      } catch (e) {}
    }
    renderPlaying();
    // 入口默认不自动播放: 官方 TV 首页自身会起播默认频道(实测 CCTV-1)。置抑制标记,
    // 在 playing 事件/元素认领/playurl 钩子三处拦截, 保持首页无焦点; 用户点频道后解除。
    // 移动端是纯播放器：不抑制自动播放，由 resumeFlow 直达上次/首个频道。
    lptv._suppressAutoplay = IS_MOBILE ? false : !cfg.autoPlayOnLaunch;
    if (IS_MOBILE) setView("playing"); else goHome();   // 移动端不显示首页
    // 客户端断开(返回电视首页/关闭投射窗口) → 退出播放模式: 暂停、回首页、
    // 清掉当前频道焦点。客户端再次连上后停在干净首页，点频道才播放。
    // (主进程检测到 xpra 客户端消失后派发; 保留 cfg.lastPid 供"上次观看"/自动播放)
    window.addEventListener("lptv:client-gone", function () {
      try {
        if (_sw) {
          if (_sw.timer) clearInterval(_sw.timer);
          if (_sw.finishT) clearTimeout(_sw.finishT);
          if (_sw.fadeT) clearTimeout(_sw.fadeT);
          if (_sw.attemptT) clearTimeout(_sw.attemptT);
          _sw.done = true;
          _sw = null;
        }
        var v = lptv.video;
        if (v) { try { v.pause(); } catch (e) {} }
        lptv._autoplayPending = false;
        lptv._resumes = 0;
        lptv._suppressAutoplay = true;
        lptv.currentPid = "";
        lptv.playUrl = "";
        lptv._loadedPid = "";
        var sw = lptv.ui && lptv.ui.switching;
        if (sw) { sw.style.opacity = ""; sw.style.transition = ""; }
        goHome();
        markActive();
        renderPlaying();
      } catch (e) {}
    });
    updateVolHint();     // 启动同步持久化音量提示
    updateQualityBadge();
    setQuality();
    initChannels();
    // 智慧屏首开兜底（①）：官方播放器首次加载可能显示"网络未连接/解码页"需手动点重试。
    // 检测用户已发起的播放迟迟未就绪（网络/SW 未就绪）时自动重切当前频道一次。
    // 仅智慧屏（isTv）+ 非首页态（用户已点卡片）触发；home 态不自动播放。
    if (isTv()) {
      setTimeout(function () {
        try {
          var v = lptv.video;
          // 仅用户已发起播放 (非 home 态) 且视频迟迟未就绪时重切; home 态不自动播放。
          if (v && !(v.readyState >= 2 && v.videoWidth) && lptv.currentPid &&
              lptv._bootRetried !== true && uiState !== "home") {
            lptv._bootRetried = true;
            dbg("boot retry: " + lptv.currentPid);
            switchChannel(lptv.currentPid);
          }
        } catch (e) {}
      }, 8000);
    }
    // 兜底: 卡在加载(黑屏)时也淡出启动黑幕, 露出 OSD/提示
    ensureCover();  // 淡出前确保深色底衬在场(防白闪)
    setTimeout(removeBootmask, 15000);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(boot, 100);
  } else {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 100); });
  }

  lptv.boot = boot;
})();