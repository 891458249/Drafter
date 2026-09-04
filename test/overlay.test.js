'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-overlay-'));
installElectronStub(tmp);
const { SessionManager } = require('../src/main/sessions');
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
const {
  PREDICT_ASYMPTOTE, predictedPct, isTrackableKind, SNAP_THRESHOLD,
  snapshotToMap, reduceSessEvent, snapTarget, snapWindow, springStep, clamp,
} = require('../src/main/overlayMath');

const T0 = 1_000_000;

test('predictedPct: 0 起渐近有界,关键节点值', () => {
  assert.strictEqual(predictedPct(T0, T0), 0);
  assert.strictEqual(predictedPct(T0, T0 + 25000), 46);   // 25s ≈ 46%
  assert.strictEqual(predictedPct(T0, T0 + 100000), 74);  // 100s ≈ 74%
  assert.strictEqual(predictedPct(T0, T0 + 10 * 60000), 88); // 10min ≈ 88,永不超过 92
  assert.strictEqual(predictedPct(null, T0), 0);          // 无 turnStart 从 0 起
});

test('predictedPct: 单调递增', () => {
  let prev = -1;
  for (let s = 0; s <= 300; s += 5) {
    const p = predictedPct(T0, T0 + s * 1000);
    assert.ok(p >= prev, `t=${s}s 应单调`);
    prev = p;
  }
});

test('isTrackableKind: 只收 code/chat', () => {
  assert.strictEqual(isTrackableKind(null), true);
  assert.strictEqual(isTrackableKind('code'), true);
  assert.strictEqual(isTrackableKind('chat'), true);
  for (const k of ['media', 'image', 'video', 'audio', 'model']) {
    assert.strictEqual(isTrackableKind(k), false);
  }
});

test('snapshotToMap: busy 会话带 turnStart,媒体会话排除', () => {
  const list = [
    { id: 's_a', kind: null, title: 'A', busy: true, running: true },
    { id: 's_b', kind: 'chat', title: 'B', busy: false, running: false },
    { id: 's_c', kind: 'media', title: 'C', busy: true, running: true },
  ];
  const map = snapshotToMap(list, T0);
  assert.strictEqual(map.size, 2);
  assert.ok(map.get('s_a').busy && map.get('s_a').turnStart === T0);
  assert.ok(!map.get('s_b').busy && !map.get('s_b').done);
  assert.ok(!map.has('s_c'));
});

test('reduceSessEvent: busy→running→done 全状态机', () => {
  const map = new Map();
  // 新回合开始
  reduceSessEvent(map, { sid: 's_a', ev: { type: 'ui_status', busy: true, running: true } }, T0);
  assert.ok(map.get('s_a').busy && map.get('s_a').turnStart === T0 && !map.get('s_a').done);
  // 重复 ui_status busy:true 不重置 turnStart
  reduceSessEvent(map, { sid: 's_a', ev: { type: 'ui_status', busy: true, running: true } }, T0 + 5000);
  assert.strictEqual(map.get('s_a').turnStart, T0);
  // result:变绿
  reduceSessEvent(map, { sid: 's_a', ev: { type: 'result', is_error: false } }, T0 + 10000);
  assert.ok(map.get('s_a').done && !map.get('s_a').error && !map.get('s_a').busy);
  // result 后紧跟的 ui_status{busy:false,running:true}:保留 done
  reduceSessEvent(map, { sid: 's_a', ev: { type: 'ui_status', busy: false, running: true } }, T0 + 11000);
  assert.ok(map.get('s_a').done);
  // pump finally 的 ui_status{busy:false,running:false}:done 球仍保留
  reduceSessEvent(map, { sid: 's_a', ev: { type: 'ui_status', busy: false, running: false } }, T0 + 12000);
  assert.ok(map.get('s_a') && map.get('s_a').done);
  // 出错变红
  reduceSessEvent(map, { sid: 's_b', ev: { type: 'ui_status', busy: true, running: true } }, T0);
  reduceSessEvent(map, { sid: 's_b', ev: { type: 'result', is_error: true } }, T0 + 1000);
  assert.ok(map.get('s_b').done && map.get('s_b').error);
  // 未完成的进行中会话,进程停止 → 删球
  reduceSessEvent(map, { sid: 's_c', ev: { type: 'ui_status', busy: true, running: true } }, T0);
  reduceSessEvent(map, { sid: 's_c', ev: { type: 'ui_status', busy: false, running: false } }, T0 + 1000);
  assert.ok(!map.has('s_c'));
});

test('reduceSessEvent: 快照+事件竞态(busy 快照后会话已结束)', () => {
  // 快照时 busy,但 result 事件早于 overlay 订阅到达(丢失)——后续 running:false 对账
  const map = snapshotToMap([{ id: 's_a', kind: null, title: 'A', busy: true, running: true }], T0);
  reduceSessEvent(map, { sid: 's_a', ev: { type: 'ui_status', busy: false, running: false } }, T0 + 90000);
  // 未完成且进程已停:不残留假进度球
  assert.ok(!map.has('s_a'));
});

test('snapTarget: 返回球心到边缘的距离 dist(吸附阈值判定用)', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const t = snapTarget({ x: 1700, y: 500, w: 64, h: 64 }, wa);
  assert.strictEqual(t.edge, 'right');
  assert.strictEqual(t.dist, 1920 - (1700 + 32)); // 球心 1732 → 距右边缘 188
  const t2 = snapTarget({ x: 1800, y: 100, w: 96, h: 340 }, wa);
  assert.strictEqual(t2.dist, 1920 - (1800 + 48));
  // 球心越出边缘时 dist 收敛到 0(视为紧贴,必吸附)
  const t3 = snapTarget({ x: 1900, y: 100, w: 96, h: 340 }, wa);
  assert.strictEqual(t3.dist, 0);
  assert.strictEqual(SNAP_THRESHOLD, 80);
});

test('snapWindow: 以球 rect(非窗口中心)算距离——上下边缘吸附判定回归', () => {
  // 悬浮窗 96×340,球 rect 在窗口内 (16,4) 64×64(球心偏移 48,36)。
  // 球已贴到屏幕顶(窗口 y=10 → 球心 y=46)
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const BALL = { ox: 16, oy: 4, w: 64, h: 64 };
  const nearTop = snapWindow({ x: 800, y: 10 }, BALL, wa);
  assert.strictEqual(nearTop.edge, 'top');
  assert.strictEqual(nearTop.dist, 46); // 球心距顶 46px ≤80 → 吸
  assert.strictEqual(nearTop.y, 4);     // 换算回窗口坐标(margin 8 - 球偏移 4)
  // 窗口中心距顶 180px,但球心只有 46px——用窗口中心算会误判为不吸附(回归点)
  const farTop = snapWindow({ x: 800, y: 300 }, BALL, wa);
  assert.ok(farTop.dist > SNAP_THRESHOLD);
  assert.strictEqual(farTop.edge, 'top'); // 最近仍是顶,但调用方按阈值放弃吸附
  // 底部同理(球心贴底:窗口 y = 1040-46-36 = 958,窗口大部分悬在屏外,球在窗顶可见)
  const nearBottom = snapWindow({ x: 800, y: 958 }, BALL, wa);
  assert.strictEqual(nearBottom.edge, 'bottom');
  assert.strictEqual(nearBottom.dist, 46);
  // 左右不受影响(窗口x=1814,球心 1862,距右 58)
  const nearRight = snapWindow({ x: 1920 - 96 - 10, y: 300 }, BALL, wa);
  assert.strictEqual(nearRight.edge, 'right');
  assert.strictEqual(nearRight.dist, 58);
});

test('snapTarget: 选最近边并沿边 clamp(任务栏在底部)', () => {
  // 1920×1080,任务栏 40px 在底:workArea 高 1040
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const ball = { x: 1800, y: 500, w: 64, h: 64 };
  const t = snapTarget(ball, wa);
  assert.strictEqual(t.edge, 'right');
  assert.strictEqual(t.x, 1920 - 64 - 8);
  assert.strictEqual(t.y, 500 + 32 - 32); // 球心 y 保持
  // 吸底边时不越过任务栏
  const b2 = { x: 900, y: 990, w: 64, h: 64 };
  const t2 = snapTarget(b2, wa);
  assert.strictEqual(t2.edge, 'bottom');
  assert.strictEqual(t2.y, 1040 - 64 - 8);
});

test('snapTarget: 任务栏在左/上', () => {
  // 任务栏在左 62px:workArea x=62
  const wa = { x: 62, y: 0, width: 1858, height: 1080 };
  const t = snapTarget({ x: 100, y: 400, w: 64, h: 64 }, wa);
  assert.strictEqual(t.edge, 'left');
  assert.strictEqual(t.x, 62 + 8);
  // 任务栏在顶 40px
  const wa2 = { x: 0, y: 40, width: 1920, height: 1040 };
  const t2 = snapTarget({ x: 400, y: 60, w: 64, h: 64 }, wa2);
  assert.strictEqual(t2.edge, 'top');
  assert.strictEqual(t2.y, 40 + 8);
});

test('snapTarget: 角落/越界情况下结果必在 workArea 内', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  for (const ball of [
    { x: 2, y: 1030, w: 100, h: 100 },     // 球心已越出底边
    { x: -20, y: -20, w: 64, h: 64 },      // 完全越出左上
    { x: 1900, y: 1030, w: 64, h: 64 },    // 越出右下
    { x: 928, y: 488, w: 64, h: 64 },      // 正中心
  ]) {
    const t = snapTarget(ball, wa);
    assert.ok(t.x >= wa.x + 8 - 1e-9 && t.x <= wa.x + wa.width - ball.w - 8 + 1e-9, `x 出界: ${JSON.stringify(t)}`);
    assert.ok(t.y >= wa.y + 8 - 1e-9 && t.y <= wa.y + wa.height - ball.h - 8 + 1e-9, `y 出界: ${JSON.stringify(t)}`);
  }
});

test('springStep: 欠阻尼过冲一次后收敛到目标', () => {
  const s = { x: 200, v: 0 }; // 距目标 200px
  let minX = Infinity, overshoot = false, converged = false, steps = 0;
  for (let i = 0; i < 600; i++) { // 最多 10s @60fps
    const done = springStep(s, 1 / 60);
    steps = i + 1;
    minX = Math.min(minX, s.x);
    if (s.x < 0) overshoot = true;
    if (done) { converged = true; break; }
  }
  assert.ok(overshoot, '欠阻尼应有一次过冲(果冻感)');
  assert.ok(converged, '应收敛');
  assert.ok(steps > 10, '收敛不应瞬时(要有回弹过程)');
  assert.ok(Math.abs(s.x) < 5);
  assert.ok(minX > -80, '过冲幅度不应夸张');
});

test('springStep: dt 掉帧保护不爆炸', () => {
  const s = { x: 100, v: 0 };
  for (let i = 0; i < 100; i++) springStep(s, 5); // 5 秒的 dt 被 clamp 到 33ms
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.v));
});

test('clamp: 基础边界', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-1, 0, 10), 0);
  assert.strictEqual(clamp(11, 0, 10), 10);
});

test('SessionManager.send 扇出:主窗与悬浮窗都收到,悬浮窗缺席不报错', () => {
  const sent = [];
  const mk = (name) => ({ name, isDestroyed: () => false, webContents: { send: (ch) => sent.push([name, ch]) } });
  const main = mk('main');
  const overlay = mk('overlay');
  const mgr = new SessionManager(() => main, () => ({}));
  mgr.getExtraWindows = () => [overlay];
  mgr.send('sess:event', { sid: 's_a', ev: { type: 'ui_status', busy: true, running: true } });
  assert.deepStrictEqual(sent, [['main', 'sess:event'], ['overlay', 'sess:event']]);
  mgr.getExtraWindows = () => [null]; // 悬浮窗不可见/未创建
  mgr.send('sess:event', { sid: 's_b', ev: { type: 'result' } });
  assert.strictEqual(sent.length, 3);
  mgr.getExtraWindows = null; // 未挂 hook(纯主窗)向下兼容
  mgr.send('sess:event', { sid: 's_c' });
  assert.strictEqual(sent.length, 4);
});
