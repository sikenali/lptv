'use strict';

// xpra info 客户端信息解析与模式分类。
// 懒猫移动客户端在服务端看来是 xpra HTML5 客户端；必须靠客户端 UA/platform
// 区分移动端与智慧屏/CDE，不能靠渲染层媒体查询（服务端看到的是虚拟鼠标）。

const SMART_MARKERS = /LazyCatTvOsClient|Lazycat_ContentView/i;
const DESKTOP_MARKERS = /LazyCatClientDesktop|lzc-client-desktop/i;
const MOBILE_MARKERS = /Android|iOS|iPhone|iPad|iPod|Mobile/i;

function parseXpraClientInfo(stdout) {
  const text = String(stdout || '');
  const out = { display: '', w: 0, h: 0, ua: '', platform: '' };

  const mD = text.match(/^client\.screen\.0\.display=(.+)$/m);
  if (mD) out.display = mD[1].trim();

  const mS = text.match(/^client\.screen\.0\.size=\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/m);
  if (mS) {
    out.w = parseInt(mS[1], 10) || 0;
    out.h = parseInt(mS[2], 10) || 0;
  }

  // xpra info 可能输出 client.session-type-full / client.session-type.full /
  // client.session_type_full，也可能只有简版 client.session-type。
  const mU = text.match(/^client\..*session.*type.*full=(.+)$/im)
    || text.match(/^client\..*session.*type=(.+)$/im);
  if (mU) out.ua = mU[1].trim();

  const mP = text.match(/^client\.platform(?:\.system)?=(.+)$/m)
    || text.match(/^client\.platform-name=(.+)$/m);
  if (mP) out.platform = mP[1].trim();

  return out;
}

function classifyClient(info) {
  const c = info || {};
  const ua = String(c.ua || '');
  const platform = String(c.platform || '');
  const display = String(c.display || '');
  const w = Number(c.w) || 0;
  const h = Number(c.h) || 0;

  if (SMART_MARKERS.test(ua) || SMART_MARKERS.test(platform)) {
    return { mobile: false, smart: true };
  }
  if (DESKTOP_MARKERS.test(ua) || DESKTOP_MARKERS.test(platform)) {
    return { mobile: false, smart: false };
  }

  // 只把"看起来像浏览器 UA"的值当作身份。xpra info 的简版
  // client.session-type 可能只是 "html5"/"python"，不能当成 UA 用来判桌面，
  // 否则会把 UA 键缺失的智慧屏误判成 CDE。
  const uaIsUA = /Mozilla|AppleWebKit|Chrome|Safari|Gecko/i.test(ua);
  const hasPlatform = !!platform;

  let mobile = false;
  if (hasPlatform) mobile = MOBILE_MARKERS.test(platform);
  if (!mobile && uaIsUA) mobile = MOBILE_MARKERS.test(ua);
  if (mobile) return { mobile: true, smart: false };

  // 有真实桌面 UA（且没有智慧屏/移动端标记）→ 桌面客户端（CDE/原生远程桌面）。
  // 此前还会按 display=Chromium / 画布 ≤1280x720 兜底成智慧屏，导致小窗口 CDE
  // 被误判成全屏 + 白色圆圈光标。智慧屏 UA 带 LazyCatTvOsClient/
  // Lazycat_ContentView 标记（上方已优先命中），不受影响。
  if (uaIsUA) return { mobile: false, smart: false };

  // 没有任何可用 UA 身份时才用尺寸/display 兜底；小 CDE 窗口有误判风险，
  // 故只作最后兜底（真实客户端都会上报 UA/platform）。
  if (!hasPlatform) {
    mobile = w > 0 && w < 1100;
    if (mobile) return { mobile: true, smart: false };
  }
  const smart = /^Chromium/i.test(display) ||
    (w > 0 && h > 0 && w <= 1280 && h <= 720);
  return { mobile: false, smart };
}

function isChromiumClient(info) {
  return /^Chromium/i.test(String((info && info.display) || ''));
}

module.exports = { parseXpraClientInfo, classifyClient, isChromiumClient };
