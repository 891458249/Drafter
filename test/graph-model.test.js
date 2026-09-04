// graph/model.js 测试:节点工厂、四阶连接验证、computeSize、API 格式序列化与主进程 canvasGraph 兼容
const { test } = require('node:test');
const assert = require('node:assert');
const canvasGraph = require('../src/main/canvasGraph');

let m;
test.beforeEach(async () => {
  m = await import('../src/renderer/graph/model.js?v=' + Date.now());
});

const REGISTRY = canvasGraph.NODE_TYPES;

// 与 canvas-graph.test.js 相同的 drawflow fixture,经主进程转换为权威 API 格式
function drawflowFixture() {
  return { drawflow: { Home: { data: {
    '1': { id: 1, name: 'cv-text', class: 'cv-nt-text', pos_x: 60, pos_y: 100, data: { type: 'text', text: '一只猫' }, inputs: {}, outputs: { output_1: { connections: [{ node: '2', output: 'input_1' }] } } },
    '2': { id: 2, name: 'cv-image', class: 'cv-nt-image', pos_x: 400, pos_y: 90, data: { type: 'image', prompt: '', models: ['k1|Vidu-q2'], tasks: [{ traceId: 't1', status: 'done' }], active: 0, view: 0 }, inputs: { input_1: { connections: [{ node: '1', input: 'output_1' }] } }, outputs: { output_1: { connections: [{ node: '3', output: 'input_2' }] } } },
    '3': { id: 3, name: 'cv-video', class: 'cv-nt-video', pos_x: 780, pos_y: 120, data: { type: 'video', prompt: '', models: ['k1|Kling-3.0'], tasks: [], active: -1, view: 0 }, inputs: { input_1: { connections: [{ node: '1', input: 'output_1' }] }, input_2: { connections: [{ node: '2', input: 'output_1' }] } }, outputs: {} },
  } } } };
}

test('API 序列化与主进程 canvasGraph 语义一致(互逆 round-trip)', () => {
  const api = canvasGraph.fromDrawflow(drawflowFixture());
  const model = m.fromApi(api, REGISTRY);
  assert.strictEqual(model.nodes.size, 3);
  assert.strictEqual(model.links.size, 3);
  const back = m.toApi(model);
  assert.deepStrictEqual(back, api, 'fromApi→toApi 与权威 API 格式逐键一致');
});

test('节点工厂:原生节点槽位/输出按注册表开辟,computeSize 排版求和', () => {
  const model = m.createModel(REGISTRY);
  const n = m.addNativeNode(model, 'image', { x: 10, y: 20 });
  assert.deepStrictEqual(n.inputs.map((s) => s.name + ':' + s.type), ['prompt:text', 'ref:image']);
  assert.deepStrictEqual(n.outputs.map((s) => s.type), ['image']);
  // h = 30 标题 + 2×20 插槽 + 4 间距 + 6 底边距 = 80
  assert.strictEqual(n.size.h, 80);
  assert.ok(n.size.w >= m.LAYOUT.MIN_W);
  // 折叠态只剩标题栏
  n.collapsed = true;
  m.computeSize(n);
  assert.strictEqual(n.size.h, m.LAYOUT.TITLE_H + m.LAYOUT.PAD_BOTTOM);
});

test('插槽局部坐标:输入左边界/输出右边界,行内居中', () => {
  const model = m.createModel(REGISTRY);
  const n = m.addNativeNode(model, 'image');
  assert.deepStrictEqual(m.slotPos(n, 'input', 0), { x: 0, y: 40 });
  assert.deepStrictEqual(m.slotPos(n, 'input', 1), { x: 0, y: 60 });
  assert.deepStrictEqual(m.slotPos(n, 'output', 0), { x: n.size.w, y: 40 });
});

test('连接验证四阶:自环/类型不匹配/大小写归一/通配符/循环/覆盖替换', () => {
  const reg = {
    a: { modelType: null, inputs: 0, inTypes: [], outType: 'TEXT' },
    b: { modelType: null, inputs: 1, inTypes: ['text'], outType: 'any' },
    c: { modelType: null, inputs: 1, inTypes: ['*'], outType: 'image' },
    d: { modelType: null, inputs: 1, inTypes: ['image'], outType: null },
  };
  const model = m.createModel(reg);
  const a = m.addNativeNode(model, 'a');
  const b = m.addNativeNode(model, 'b');
  const c = m.addNativeNode(model, 'c');
  const d = m.addNativeNode(model, 'd');
  // 自环
  assert.strictEqual(m.validateConnection(model, a.id, 0, a.id, 0).reason, 'self');
  // 类型不匹配
  const miss = m.validateConnection(model, c.id, 0, b.id, 0);
  assert.strictEqual(miss.ok, false);
  assert.strictEqual(miss.reason, 'type');
  // 大小写归一:TEXT → text 允许
  assert.strictEqual(m.connect(model, a.id, 0, b.id, 0).ok, true);
  // 通配符:b 的 any → c 的 * 允许
  assert.strictEqual(m.connect(model, b.id, 0, c.id, 0).ok, true);
  // 覆盖替换:再连一条到 b 的同一输入槽,旧连线被顶掉
  const a2 = m.addNativeNode(model, 'a');
  const r = m.connect(model, a2.id, 0, b.id, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.replaced, true);
  assert.strictEqual(model.links.size, 2, '旧连线被移除后仍只有两条');
  // 循环:d 连回 a... a 无输入槽,构造 c→d→? 用 b:c 的 * 输出 d: image→d, 再 d? d 无输出。
  // 用 c(image)→d 与 d 无输出,改测 c→d 后 b→c 已在;构造环:b→c, c→d 不可能。
  // 直接造环:a→b 已连,尝试 b→? b 输出 any,c 输入 *:b→c 已连;再试 c→b 会因类型…c 输出 image,b 输入 text 不匹配。
  // 用通配链验证循环检测:新建两个 * 节点
  const e = m.addNativeNode(model, 'c'); // * 入,image 出
  const f = m.addNativeNode(model, 'd'); // image 入
  assert.strictEqual(m.connect(model, c.id, 0, f.id, 0).ok, true);
  // f 无输出,无法回连;用第二个 c 型节点闭环: e(*) 接 f? f 无输出。
  // 换:d 型改注册表不可行,直接用 c→d 再 d? 跳过,单独验证 reachable 语义:
  assert.strictEqual(m.validateConnection(model, c.id, 0, b.id, 0).reason, 'type', 'image↛text 在循环检查前被拦');
});

test('循环检测:通配类型链成环被拦', () => {
  const reg = {
    x: { modelType: null, inputs: 1, inTypes: ['*'], outType: '*' },
  };
  const model = m.createModel(reg);
  const n1 = m.addNativeNode(model, 'x');
  const n2 = m.addNativeNode(model, 'x');
  const n3 = m.addNativeNode(model, 'x');
  assert.strictEqual(m.connect(model, n1.id, 0, n2.id, 0).ok, true);
  assert.strictEqual(m.connect(model, n2.id, 0, n3.id, 0).ok, true);
  const r = m.validateConnection(model, n3.id, 0, n1.id, 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cycle', 'n3→n1 回连成环必须被拦');
});

test('外部节点工厂:标量→widget,张量→插槽;序列化带连接戳', () => {
  const schema = {
    classType: 'KSampler', displayName: 'K 采样器', category: 'sampling',
    inputs: [
      { name: 'model', type: 'MODEL' },
      { name: 'seed', type: 'INT', widget: { kind: 'INT', default: 42, min: 0, max: 100 } },
      { name: 'sampler_name', type: 'COMBO', widget: { kind: 'combo', values: ['euler', 'ddim'], default: 'euler' } },
    ],
    outputs: ['LATENT'], outputNames: ['LATENT'],
  };
  const model = m.createModel(REGISTRY);
  const n = m.addExternalNode(model, { connectionId: 'comfy_local', schema });
  assert.deepStrictEqual(n.inputs.map((s) => s.name), ['model'], 'MODEL 开辟为输入插槽');
  assert.deepStrictEqual(n.widgets.map((w) => w.name), ['seed', 'sampler_name'], '标量/COMBO 落 widget');
  assert.strictEqual(n.widgets[0].value, 42);
  const api = m.toApi(model);
  assert.strictEqual(api[n.id].class_type, 'KSampler');
  assert.strictEqual(api[n.id].inputs._comfyConnectionId, 'comfy_local');
  assert.strictEqual(api[n.id].inputs.seed, 42);
});

test('外部节点连线:仅同连接内互连;序列化按槽名写 [源id, 序位]', () => {
  const loadSchema = { classType: 'CheckpointLoaderSimple', inputs: [{ name: 'ckpt_name', type: 'COMBO', widget: { kind: 'combo', values: ['a.safetensors'], default: 'a.safetensors' } }], outputs: ['MODEL', 'CLIP', 'VAE'] };
  const sampSchema = { classType: 'KSampler', inputs: [{ name: 'model', type: 'MODEL' }], outputs: ['LATENT'] };
  const model = m.createModel(REGISTRY);
  const loader = m.addExternalNode(model, { connectionId: 'c1', schema: loadSchema });
  const sampler = m.addExternalNode(model, { connectionId: 'c1', schema: sampSchema });
  const other = m.addExternalNode(model, { connectionId: 'c2', schema: sampSchema });
  assert.strictEqual(m.connect(model, loader.id, 0, sampler.id, 0).ok, true);
  const cross = m.validateConnection(model, loader.id, 0, other.id, 0);
  assert.strictEqual(cross.ok, false);
  assert.strictEqual(cross.reason, 'cross_backend', '跨 ComfyUI 连接禁连');
  const api = m.toApi(model);
  assert.deepStrictEqual(api[sampler.id].inputs.model, [loader.id, 0]);
  // round-trip:fromApi 恢复连线
  const model2 = m.fromApi(api, REGISTRY);
  assert.strictEqual(model2.links.size, 1);
  const link = [...model2.links.values()][0];
  assert.strictEqual(link.from, loader.id);
  assert.strictEqual(link.to, sampler.id);
});

test('分组框:中心点几何归属 + 拖动联动位移', () => {
  const model = m.createModel(REGISTRY);
  const inside = m.addNativeNode(model, 'text', { x: 100, y: 100 });
  const outside = m.addNativeNode(model, 'text', { x: 900, y: 900 });
  const g = m.addGroup(model, { x: 50, y: 50, w: 400, h: 300 }, '分组 A', '#335');
  assert.deepStrictEqual(m.groupsOfNode(model, inside.id).map((x) => x.id), [g.id]);
  assert.strictEqual(m.groupsOfNode(model, outside.id).length, 0);
  m.moveGroup(model, g.id, 30, 40);
  assert.deepStrictEqual([g.rect.x, g.rect.y], [80, 90]);
  assert.deepStrictEqual([inside.pos.x, inside.pos.y], [130, 140], '组内节点随组移动');
  assert.deepStrictEqual([outside.pos.x, outside.pos.y], [900, 900], '组外节点不动');
});

test('removeNode 级联清理连线;disconnect 释放槽位', () => {
  const model = m.createModel(REGISTRY);
  const t = m.addNativeNode(model, 'text');
  const img = m.addNativeNode(model, 'image');
  const r = m.connect(model, t.id, 0, img.id, 0);
  assert.strictEqual(img.inputs[0].link, r.link.id);
  m.disconnect(model, r.link.id);
  assert.strictEqual(img.inputs[0].link, null);
  m.connect(model, t.id, 0, img.id, 0);
  m.removeNode(model, t.id);
  assert.strictEqual(model.links.size, 0, '节点删除后其连线全部清理');
  assert.strictEqual(img.inputs[0].link, null);
});
