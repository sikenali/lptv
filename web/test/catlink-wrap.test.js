'use strict';

// catlink-wrap.html 全屏策略回归：
// - 智慧屏 UA（LazyCatTvOsClient/Lazycat_ContentView）→ 自动/手势全屏；
// - CDE/桌面 UA → 保持普通客户端窗口，不调用 requestFullscreen（不再需要按 Esc 缩小）。
// 用 vm + 最小 DOM stub 执行页面内联脚本，避免依赖 xpra 服务端。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'catlink-wrap.html'), 'utf8');
const SRC = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

function runWrapper(ua) {
  const calls = [];
  const handlers = {};
  const f = {
    addEventListener() {},
    contentDocument: null,
    contentWindow: null,
    src: '',
  };
  const w = {
    classList: { add() {}, remove() {} },
    style: {},
    parentNode: null,
  };
  const doc = {
    getElementById(id) {
      if (id === 'lptv-xpra') return f;
      if (id === 'lptv-wait') return w;
      return null;
    },
    addEventListener(type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      handlers[type] = (handlers[type] || []).filter((x) => x !== fn);
    },
    documentElement: {
      requestFullscreen() { calls.push('requestFullscreen'); return Promise.resolve(); },
      webkitRequestFullscreen() { calls.push('webkitRequestFullscreen'); return Promise.resolve(); },
    },
    fullscreenElement: null,
  };
  const ctx = {
    document: doc,
    navigator: { userAgent: ua },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    console: { log() {} },
    Date,
    Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'catlink-wrap.html' });
  // 模拟用户在页面内首次点击：fsGesture 会调用 tryFullscreen。
  (handlers.pointerdown || []).forEach((fn) => fn({ type: 'pointerdown' }));
  return calls;
}

test('CDE/桌面 UA 不自动全屏（保持普通客户端窗口）', () => {
  const calls = runWrapper(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
  );
  assert.deepEqual(calls, []);
});

test('LazyCatClientDesktop UA 不自动全屏', () => {
  const calls = runWrapper(
    'Mozilla/5.0 LazyCatClientDesktop/1.0 AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36'
  );
  assert.deepEqual(calls, []);
});

test('智慧屏 LazyCatTvOsClient UA 进入全屏', () => {
  const calls = runWrapper('Mozilla/5.0 LazyCatTvOsClient/1.0 AppleWebKit/537.36');
  assert.deepEqual(calls, ['requestFullscreen']);
});

test('智慧屏 Lazycat_ContentView UA 进入全屏', () => {
  const calls = runWrapper('Mozilla/5.0 Lazycat_ContentView/1.0 AppleWebKit/537.36');
  assert.deepEqual(calls, ['requestFullscreen']);
});

test('移动端 Android UA 不自动全屏（移动端走自己的视口）', () => {
  const calls = runWrapper(
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36'
  );
  assert.deepEqual(calls, []);
});
