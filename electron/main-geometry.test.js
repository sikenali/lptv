'use strict';

// Electron 主进程窗口几何回归：CDE 桌面客户端必须按 75% 屏 16:9 窗口几何
// （这是 F11 退出全屏后的恢复窗口；默认启动窗口铺满客户端画布，由启动分支
// setPos(full) 处理）。智慧屏/移动端仍按整屏。用 vm 抽取几何函数，避免启动
// Electron 进程。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const START = MAIN.indexOf('function containerWinRect');
const END = MAIN.indexOf('// 把给定区域收敛成居中的 16:9 矩形');
assert.ok(START >= 0 && END > START, 'geometry block found');
const BLOCK = MAIN.slice(START, END);

function loadGeometry(opts) {
  const ctx = {
    displayBounds: () => opts.bounds,
    getXpraClient: () => opts.client,
    clientMode: () => opts.mode,
    Math,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx, { filename: 'main-geometry.js' });
  return ctx;
}

const full = { x: 0, y: 0, w: 1920, h: 1200 };
const plain = (o) => JSON.parse(JSON.stringify(o));

test('CDE 桌面：75% 高度、16:9、居中，且宽度不超过 75% 屏宽', () => {
  const g = loadGeometry({ bounds: full, client: {}, mode: 'desktop' });
  const r = g.containerWinRect(full);
  assert.equal(r.h, 810);          // 1200*0.75=900 → 16:9 宽 1600 > 1440 → 高度回算 810
  assert.equal(r.w, 1440);
  assert.equal(r.x, 240);
  assert.equal(r.y, 195);
});

test('CDE 桌面：小画布（1280x720）仍是窗口几何，不被误判成全屏', () => {
  const g = loadGeometry({ bounds: { x: 0, y: 0, w: 1280, h: 720 }, client: {}, mode: 'desktop' });
  const r = g.containerWinRect({ x: 0, y: 0, w: 1280, h: 720 });
  assert.deepEqual(plain(r), { x: 160, y: 90, w: 960, h: 540 });
});

test('智慧屏：无论画布多大都整屏', () => {
  const g = loadGeometry({ bounds: full, client: {}, mode: 'smart' });
  assert.deepEqual(plain(g.containerWinRect(full)), full);
});

test('移动端：整屏', () => {
  const g = loadGeometry({ bounds: full, client: {}, mode: 'mobile' });
  assert.deepEqual(plain(g.containerWinRect(full)), full);
});

test('客户端未连接 + 小画布：按整屏兜底（智慧屏首开行为）', () => {
  const g = loadGeometry({ bounds: { x: 0, y: 0, w: 1280, h: 720 }, client: null, mode: '' });
  assert.deepEqual(plain(g.containerWinRect({ x: 0, y: 0, w: 1280, h: 720 })), { x: 0, y: 0, w: 1280, h: 720 });
});

test('客户端未连接 + 大画布：按桌面窗口几何兜底', () => {
  const g = loadGeometry({ bounds: full, client: null, mode: '' });
  const r = g.containerWinRect(full);
  assert.equal(r.w, 1440);
  assert.equal(r.h, 810);
});

test('超宽屏：按 75% 高度定高、16:9 算宽，不超出 75% 屏宽', () => {
  const b = { x: 0, y: 0, w: 3372, h: 1308 };
  const g = loadGeometry({ bounds: b, client: {}, mode: 'desktop' });
  const r = g.containerWinRect(b);
  assert.equal(r.h, 981);
  assert.equal(r.w, 1744);
  assert.equal(r.x, 814);
  assert.equal(r.y, 164);
});

test('窗口位置钳制：越界左上回到屏内', () => {
  const g = loadGeometry({ bounds: full, client: {}, mode: 'desktop' });
  const r = g.clampRectPos({ x: -100, y: -80, w: 1000, h: 600 }, full);
  assert.deepEqual(plain(r), { x: 0, y: 0, w: 1000, h: 600 });
});

test('窗口位置钳制：越界右下回到屏内', () => {
  const g = loadGeometry({ bounds: full, client: {}, mode: 'desktop' });
  const r = g.clampRectPos({ x: 1500, y: 1000, w: 1000, h: 600 }, full);
  assert.deepEqual(plain(r), { x: 920, y: 600, w: 1000, h: 600 });
});

test('desktopWindowRect 返回钳制后的 75% 窗口', () => {
  const g = loadGeometry({ bounds: full, client: {}, mode: 'desktop' });
  const r = g.desktopWindowRect(full);
  assert.deepEqual(plain(r), { x: 240, y: 195, w: 1440, h: 810 });
});
