const assert = require('node:assert/strict');
const test = require('node:test');
const { parseXpraClientInfo, classifyClient, isChromiumClient } = require('./xpra-client-info');

function info(stdout) { return parseXpraClientInfo(stdout); }

test('Android mobile UA with small canvas is mobile, not smart', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
    'client.platform=Android',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(800, 360)',
  ].join('\n'));
  assert.equal(c.w, 800);
  assert.equal(c.h, 360);
  assert.equal(c.platform, 'Android');
  assert.match(c.ua, /Android/);
  assert.deepEqual(classifyClient(c), { mobile: true, smart: false });
});

test('iOS platform alone marks mobile', () => {
  const c = info([
    'client.platform=iOS',
    'client.screen.0.size=(390, 844)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: true, smart: false });
});

test('Smart screen UA stays smart, never mobile', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 LazyCatTvOsClient/1.0',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1280, 720)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: true });
});

test('Desktop UA and 1920 canvas is neither mobile nor smart', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 LazyCatClientDesktop/1.0',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1920, 1080)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: false });
});

test('UA key with dots is parsed too', () => {
  const c = info([
    'client.session-type.full=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
    'client.screen.0.size=(390, 844)',
  ].join('\n'));
  assert.match(c.ua, /iPhone/);
  assert.equal(classifyClient(c).mobile, true);
});

test('Missing UA/platform falls back to small canvas only', () => {
  const small = info('client.screen.0.size=(800, 360)');
  assert.deepEqual(classifyClient(small), { mobile: true, smart: false });
  const big = info('client.screen.0.size=(1920, 1080)');
  assert.deepEqual(classifyClient(big), { mobile: false, smart: false });
  const smartSize = info('client.screen.0.size=(1280, 720)');
  assert.deepEqual(classifyClient(smartSize), { mobile: false, smart: true });
});

test('Chromium detection is independent of mobile classification', () => {
  const c = info('client.screen.0.display=Chromium\nclient.screen.0.size=(800, 360)');
  assert.equal(isChromiumClient(c), true);
});

test('Trailing whitespace after size parens still parses', () => {
  const c = info('client.screen.0.size=(800, 360)  \n');
  assert.equal(c.w, 800);
  assert.equal(c.h, 360);
  assert.deepEqual(classifyClient(c), { mobile: true, smart: false });
});

test('UA carrying both mobile and smart markers is smart (never mobile)', () => {
  // 移动 UA 同时带智慧屏标记 → 智慧屏优先，避免智慧屏失去 TV 布局/白色圆圈光标。
  const c = info([
    'client.session-type-full=Mozilla/5.0 (Linux; Android 14) LazyCatTvOsClient/1.0 Mobile Safari/537.36',
    'client.platform=Android',
    'client.screen.0.size=(1280, 720)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: true });
});

test('Smart marker on platform alone is smart', () => {
  const c = info([
    'client.platform=LazyCatTvOsClient',
    'client.screen.0.size=(1280, 720)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: true });
});

test('Chromium canvas with desktop identity is desktop, never smart by size', () => {
  // CDE 原生客户端同样上报 display=Chromium；小窗口画布 ≤1280x720 时不得再按
  // 尺寸兜底成智慧屏（否则 CDE 被全屏 + 白色圆圈光标）。
  const c = info([
    'client.session-type-full=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1280, 720)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: false });
});

test('Unknown identity UA is desktop even on a small canvas', () => {
  const c = info([
    'client.session-type-full=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1024, 600)',
  ].join('\n'));
  assert.deepEqual(classifyClient(c), { mobile: false, smart: false });
});

test('Short session-type token is not treated as desktop UA', () => {
  // xpra info 简版 client.session-type=html5 被解析成 ua 时，不能据此判桌面；
  // 智慧屏（Chromium/1280x720）必须仍按尺寸兜底判 smart。
  const c = info([
    'client.session-type=html5',
    'client.screen.0.display=Chromium',
    'client.screen.0.size=(1280, 720)',
  ].join('\n'));
  assert.equal(c.ua, 'html5');
  assert.deepEqual(classifyClient(c), { mobile: false, smart: true });
});

test('session_type_full underscore key is parsed too', () => {
  const c = info([
    'client.session_type_full=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148',
    'client.screen.0.size=(390, 844)',
  ].join('\n'));
  assert.match(c.ua, /iPhone/);
  assert.equal(classifyClient(c).mobile, true);
});
