// graph/interact.js 纯函数测试:hitTest 命中优先级与 smartGuides 智能参考线
const { test } = require('node:test');
const assert = require('node:assert');

let m, it;
test.beforeEach(async () => {
  m = await import('../src/renderer/graph/model.js?v=' + Date.now());
  it = await import('../src/renderer/graph/interact.js?v=' + Date.now());
});

const REGISTRY = {
  text: { modelType: null, inputs: 0, inTypes: [], outType: 'text' },
  image: { modelType: 'image', inputs: 2, inTypes: ['text', 'image'], outType: 'image', outNode: true },
};

test('hitTest:插槽优先于节点体;输入槽/输出槽区分', () => {
  const model = m.createModel(REGISTRY);
  const n = m.addNativeNode(model, 'image', { x: 100, y: 100 });
  const inP = m.slotPos(n, 'input', 0);
  const hit = it.hitTest(model, { x: 100 + inP.x, y: 100 + inP.y }, 1);
  assert.strictEqual(hit.type, 'slot');
  assert.strictEqual(hit.kind, 'input');
  const outP = m.slotPos(n, 'output', 0);
  const hit2 = it.hitTest(model, { x: 100 + outP.x, y: 100 + outP.y }, 1);
  assert.strictEqual(hit2.kind, 'output');
  // 标题区
  assert.strictEqual(it.hitTest(model, { x: 150, y: 110 }, 1).type, 'title');
  // 节点体
  assert.strictEqual(it.hitTest(model, { x: 150, y: 100 + m.LAYOUT.TITLE_H + 10 }, 1).type, 'node');
  // 空白
  assert.strictEqual(it.hitTest(model, { x: 9999, y: 9999 }, 1).type, 'canvas');
});

test('hitTest:顶层节点优先(后添加的盖住先添加的)', () => {
  const model = m.createModel(REGISTRY);
  const a = m.addNativeNode(model, 'text', { x: 100, y: 100 });
  const b = m.addNativeNode(model, 'text', { x: 150, y: 120 });
  const hit = it.hitTest(model, { x: 160, y: 130 }, 1);
  assert.strictEqual(hit.node.id, b.id);
  void a;
});

test('hitTest:贝塞尔连线拾取;分组标题条', () => {
  const model = m.createModel(REGISTRY);
  const t = m.addNativeNode(model, 'text', { x: 0, y: 0 });
  const img = m.addNativeNode(model, 'image', { x: 400, y: 0 });
  m.connect(model, t.id, 0, img.id, 0);
  const link = [...model.links.values()][0];
  const ends = it.linkEndsOf(model, link);
  const midX = (ends.p0.x + ends.p3.x) / 2;
  const hit = it.hitTest(model, { x: midX, y: ends.p0.y + 2 }, 1);
  assert.strictEqual(hit.type, 'link', '连线中点附近命中 link');
  const g = m.addGroup(model, { x: -100, y: -100, w: 800, h: 400 }, 'G');
  assert.strictEqual(it.hitTest(model, { x: -50, y: -95 }, 1).type, 'group-title');
  assert.strictEqual(it.hitTest(model, { x: 700, y: 250 }, 1).type, 'group');
  void g;
});

test('hitTest:widget 行命中;折叠节点无 widget/插槽行', () => {
  const model = m.createModel(REGISTRY);
  const schema = {
    classType: 'KSampler', inputs: [{ name: 'seed', type: 'INT', widget: { kind: 'INT', default: 1, min: 0, max: 10 } }], outputs: ['LATENT'],
  };
  const n = m.addExternalNode(model, { connectionId: 'c', schema }, { x: 0, y: 0 });
  const b = m.widgetBounds(n, 0);
  const hit = it.hitTest(model, { x: b.x + 5, y: b.y + 5 }, 1);
  assert.strictEqual(hit.type, 'widget');
  assert.strictEqual(hit.widget.name, 'seed');
});

test('smartGuides:边界对齐在阈值内产生吸附位移与引导线', () => {
  const model = m.createModel(REGISTRY);
  m.addNativeNode(model, 'text', { x: 100, y: 100 });
  // 拖动中的节点 rect 左边距参照 104(差 4px < 6px 阈值)
  const g = it.smartGuides(model, ['2'], { x: 104, y: 300, w: 220, h: 80 }, 1);
  assert.strictEqual(g.dx, -4, '左边界吸附到参照节点左边界');
  assert.ok(g.guides.some((x) => x.axis === 'x' && x.pos === 100));
  // 阈值外不吸附
  const g2 = it.smartGuides(model, ['2'], { x: 130, y: 500, w: 220, h: 80 }, 1);
  assert.strictEqual(g2.dx, 0);
  assert.strictEqual(g2.guides.length, 0);
});
