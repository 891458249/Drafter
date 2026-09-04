// graph/history.js 测试:差量命令 + 结构快照双轨、合并窗口、容量上限、重做栈清空
const { test } = require('node:test');
const assert = require('node:assert');

let H;
test.beforeEach(async () => {
  H = await import('../src/renderer/graph/history.js?v=' + Date.now());
});

// 模拟图状态:一个可序列化对象 + capture/restore
function fixture() {
  let state = { nodes: { 1: { x: 0 } } };
  const h = H.createHistory({
    limit: 3,
    capture: () => JSON.parse(JSON.stringify(state)),
    restore: (s) => { state = s; },
  });
  return { h, get: () => state, set: (s) => { state = s; } };
}

test('差量命令:undo 调 revert,redo 调 apply', () => {
  const { h, get } = fixture();
  const before = get().nodes[1].x;
  get().nodes[1].x = 100;
  h.commitDelta({ key: 'move:1', revert: () => { get().nodes[1].x = before; }, apply: () => { get().nodes[1].x = 100; } });
  assert.strictEqual(get().nodes[1].x, 100);
  h.undo();
  assert.strictEqual(get().nodes[1].x, 0);
  h.redo();
  assert.strictEqual(get().nodes[1].x, 100);
});

test('同 key 连续差量在合并窗口内只记一条(拖拽合帧)', () => {
  const { h, get } = fixture();
  const initial = 0;
  for (const x of [10, 20, 30, 40]) {
    const prev = get().nodes[1].x;
    get().nodes[1].x = x;
    h.commitDelta({ key: 'move:1', revert: () => { get().nodes[1].x = initial; }, apply: () => { get().nodes[1].x = x; } });
    void prev;
  }
  assert.strictEqual(h.depth, 1, '4 次连续移动合并为 1 条历史');
  h.undo();
  assert.strictEqual(get().nodes[1].x, 0, '一次 undo 回到拖拽起点');
});

test('快照:拓扑变更前捕获,undo 恢复全图', () => {
  const { h, get } = fixture();
  h.commitSnapshot();           // 变更前捕获 {nodes:{1:{x:0}}}
  get().nodes[2] = { x: 50 };   // 拓扑变更:加节点
  assert.strictEqual(Object.keys(get().nodes).length, 2);
  h.undo();
  assert.deepStrictEqual(get(), { nodes: { 1: { x: 0 } } });
  h.redo();
  assert.strictEqual(Object.keys(get().nodes).length, 2, 'redo 恢复变更后状态');
});

test('新操作清空重做栈;容量上限剔除最早历史', () => {
  const { h, get } = fixture();
  h.commitSnapshot();
  get().nodes[2] = { x: 1 };
  h.commitSnapshot();
  get().nodes[3] = { x: 2 };
  assert.strictEqual(h.depth, 2);
  h.undo();
  assert.ok(h.canRedo);
  h.commitSnapshot(); // 新操作
  assert.ok(!h.canRedo, '重做栈已清空');
  // 容量上限 3
  const f2 = fixture();
  for (let i = 0; i < 6; i++) { f2.h.commitSnapshot(); f2.get().nodes['n' + i] = {}; }
  assert.strictEqual(f2.h.depth, 3, '超出上限剔除最早');
});

test('空栈 undo/redo 返回 false', () => {
  const { h } = fixture();
  assert.strictEqual(h.undo(), false);
  assert.strictEqual(h.redo(), false);
});
