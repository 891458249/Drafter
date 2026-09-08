'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const math = require('../src/main/overlayMath');

// 真 renderer + 主进程 IPC/拖拽轮询,仅替换 Electron/DOM/时钟,不移动用户的鼠标。
function harness(edge = 'bottom', progress = 1) {
  const wa = { x: 0, y: 0, width: 2560, height: 1400 };
  const display = { id: 1, bounds: wa, workArea: wa };
  let position = [900, 1060];
  let cursor = { x: 948, y: 1368 };
  let setting = { enabled: true, asked: true, edge, x: 900, y: 1060, displayId: 1 };
  let now = 0, nextId = 1;
  const timers = new Map(), frames = new Map(), handlers = new Map();
  const elements = new Map();
  function element(id) {
    const listeners = new Map(), classes = new Set();
    return {
      id, style: {}, addEventListener: (name, cb) => listeners.set(name, cb),
      dispatch: (name, ev) => listeners.get(name)?.(ev),
      classList: { add: (...v) => v.forEach(c => classes.add(c)), remove: (...v) => v.forEach(c => classes.delete(c)), toggle: () => {} },
      setPointerCapture() {}, appendChild() {}, remove() {}, querySelector: () => ({ textContent: '' }),
    };
  }
  elements.set('ball', element('ball'));
  elements.set('orbs', element('orbs'));
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = () => {}; }
    setIgnoreMouseEvents() {} loadFile() {} isDestroyed() { return false; }
    isVisible() { return true; } showInactive() {} hide() {}
    setPosition(x, y) { position = [x, y]; }
    getPosition() { return position; }
  }
  const screen = { getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getCursorScreenPoint: () => cursor };
  const store = { getSetting: () => setting, setSetting: (_key, value) => { setting = value; } };
  const main = vm.createContext({
    module: { exports: {} }, __dirname: path.join(__dirname, '../src/main'), console: { log() {} },
    setInterval: (cb, ms) => { const id = nextId++; timers.set(id, { cb, ms }); return id; },
    clearInterval: id => timers.delete(id),
    require: name => name === 'electron' ? { BrowserWindow: Window, screen, app: {}, ipcMain: { handle: (key, cb) => handlers.set(key, cb) } }
      : name === './store' ? store : name === './overlayMath' ? math : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main/overlay.js'), 'utf8'), main);
  main.module.exports.registerIpc();
  main.module.exports.show();
  const invoke = async (name, p) => handlers.get(name)(null, p);
  const renderer = vm.createContext({
    window: { overlayMath: math }, document: { getElementById: id => elements.get(id), createElement: () => element('') },
    performance: { now: () => now }, setInterval: () => 0,
    requestAnimationFrame: cb => { const id = nextId++; frames.set(id, cb); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    api: {
      on() {}, sessList: async () => [], overlayGetState: () => invoke('overlay:getState'),
      overlayDragStart: p => invoke('overlay:dragStart', p), overlayDragEnd: () => invoke('overlay:dragEnd'),
      overlaySetPos: p => invoke('overlay:setPos', p), overlaySetDock: p => invoke('overlay:setDock', p),
      overlaySetRegions: regions => invoke('overlay:setRegions', regions),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/overlay.js'), 'utf8'), renderer);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const run = code => vm.runInContext(code, renderer);
  function offset() {
    const m = elements.get('ball').style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    return { x: +m[1], y: +m[2] };
  }
  function center() {
    const m = offset();
    return { x: position[0] + 48 + m.x, y: position[1] + 36 + m.y };
  }
  function tick(ms) {
    now += ms;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(cb => cb(now));
    for (const { cb, ms: interval } of timers.values()) if (interval === 12) cb();
  }
  function press(button = 0, grab = { x: 0, y: 0 }) {
    const c = center(); cursor = { x: c.x + grab.x, y: c.y + grab.y };
    return elements.get('ball').dispatch('pointerdown', { button, pointerId: 1, clientX: cursor.x - position[0], clientY: cursor.y - position[1], preventDefault() {} });
  }
  return {
    async ready() { await flush(); run(`dockedEdge = ${JSON.stringify(edge)}; morphP = ${progress}; applyBallVisual();`); },
    press, tick, center, run, flush,
    move: (dx, dy) => { cursor = { x: cursor.x + dx, y: cursor.y + dy }; tick(16); },
    release: (type = 'pointerup') => elements.get('ball').dispatch(type, {}),
    state: () => handlers.get('overlay:getState')(),
    setting: () => setting,
  };
}

for (const edge of ['bottom', 'top', 'left', 'right']) {
  test(`${edge} 停靠拖起:圆角动画不改变球心/抓取点,松手归一不跳跃`, async () => {
    const h = harness(edge);
    await h.ready();
    const before = h.center();
    h.press(0, { x: 11, y: -9 }); // 不只验证正中心抓取
    for (let i = 0; i < 16; i++) {
      h.tick(16);
      assert.deepEqual(h.center(), before, '静止按住时不能随形变漂移');
    }
    const dx = edge === 'right' ? -300 : 100;
    const dy = edge === 'top' ? 300 : -300;
    h.move(dx, dy);
    const moved = h.center();
    assert.deepEqual(moved, { x: before.x + dx, y: before.y + dy });
    await h.release();
    assert.deepEqual(h.center(), moved, '移除 translate 与窗口补偿必须抵消');
    h.tick(300);
    assert.deepEqual(h.center(), moved, '旧 undock RAF 不得影响松手后的球');
    assert.equal(h.setting().edge, null);
  });
}

test('底部快速拖起/取消:未完成的形变动画被撤销,抓取点保持', async () => {
  for (const progress of [1, 0.5]) {
    const h = harness('bottom', progress);
    await h.ready();
    const before = h.center();
    h.press(); h.move(0, -300); // 16ms 就松手,早于 220ms 圆角动画结束
    await h.release('pointercancel');
    h.tick(500);
    assert.deepEqual(h.center(), { x: before.x, y: before.y - 300 });
    assert.equal(h.run('dockedEdge'), null);
    assert.equal(h.run('morphP'), 0);
  }
});

test('底部拖拽越界:主进程使用含 translate 的实际球 rect 夹取', async () => {
  const h = harness(); await h.ready(); h.press();
  h.move(0, 500);
  assert.equal(h.center().y + 32, 1400);
  h.move(0, -2500);
  assert.equal(h.center().y - 32, 0);
});

test('右键不启动拖拽或解除底部吸附', async () => {
  const h = harness(); await h.ready(); const before = h.center();
  h.press(2); h.tick(300);
  assert.equal(h.state().dragging, false);
  assert.equal(h.run('morphP'), 1);
  assert.deepEqual(h.center(), before);
});
