// graph/i18n.js + model.js 标签注入测试(迭代规范「国际化双轨解耦」验收):
// UI 显示名中文化,逻辑键(type/name/序列化键)恒定英文,落盘零污染。
const { test } = require('node:test');
const assert = require('node:assert');

let m, i18n;
test.beforeEach(async () => {
  m = await import('../src/renderer/graph/model.js?v=' + Date.now());
  i18n = (await import('../src/renderer/graph/i18n.js?v=' + Date.now())).i18n;
});

const REGISTRY = {
  text: { modelType: null, inputs: 0, inTypes: [], outType: 'text' },
  image: { modelType: 'image', inputs: 2, inTypes: ['text', 'image'], outType: 'image', outNode: true },
};

test('词典:分类逐段翻译、节点标题、插槽/控件/输出标签,未收录兜底原文', () => {
  assert.strictEqual(i18n.tCategory('3d/mesh'), '3D/mesh');
  assert.strictEqual(i18n.tCategory('sampling'), '采样');
  assert.strictEqual(i18n.tCategory('nonexistent/deep'), 'nonexistent/deep');
  assert.strictEqual(i18n.tCategory(''), '未分类');
  assert.strictEqual(i18n.tNodeTitle('KSampler'), 'K采样器');
  assert.strictEqual(i18n.tNodeTitle('NoSuchNode', '显示名'), '显示名');
  assert.strictEqual(i18n.tNodeTitle('image'), '图片生成', '原生节点类型走 nativeNodes 表');
  assert.strictEqual(i18n.tInput('KSampler', 'latent_image'), 'Latent图像');
  assert.strictEqual(i18n.tInput('KSampler', 'unknown_slot'), 'unknown_slot');
  assert.strictEqual(i18n.tWidget('KSampler', 'seed'), '种子');
  assert.strictEqual(i18n.tOutput('VAEDecode', 'IMAGE'), '图像');
  assert.strictEqual(i18n.tType('LATENT'), 'Latent');
});

test('原生节点:label 注入中文,name/type 保持英文', () => {
  const model = m.createModel(REGISTRY);
  const n = m.addNativeNode(model, 'image');
  assert.strictEqual(n.inputs[0].name, 'prompt');
  assert.strictEqual(n.inputs[0].label, '提示词');
  assert.strictEqual(n.inputs[1].name, 'ref');
  assert.strictEqual(n.inputs[1].label, '参考图');
  assert.strictEqual(n.outputs[0].type, 'image');
  assert.strictEqual(n.outputs[0].label, '图像');
  assert.strictEqual(m.slotLabel(n.inputs[0]), '提示词');
});

test('外部节点:KSampler 全链路透出中文标签,API 序列化键名零中文污染', () => {
  const schema = {
    classType: 'KSampler', displayName: 'KSampler', category: 'sampling',
    inputs: [
      { name: 'model', type: 'MODEL' },
      { name: 'latent_image', type: 'LATENT' },
      { name: 'seed', type: 'INT', widget: { kind: 'INT', default: 42 } },
      { name: 'sampler_name', type: 'COMBO', widget: { kind: 'combo', values: ['euler'], default: 'euler' } },
    ],
    outputs: ['LATENT'], outputNames: ['LATENT'],
  };
  const model = m.createModel(REGISTRY);
  const n = m.addExternalNode(model, { connectionId: 'c', schema });
  // UI 面:标题/插槽/控件全中文
  assert.strictEqual(n.title, 'K采样器');
  assert.deepStrictEqual(n.inputs.map((s) => s.label), ['模型', 'Latent图像']);
  assert.deepStrictEqual(n.widgets.map((w) => w.label), ['种子', '采样器名称']);
  assert.strictEqual(n.outputs[0].label, 'Latent');
  // 逻辑面:键名恒定英文
  assert.deepStrictEqual(n.inputs.map((s) => s.name), ['model', 'latent_image']);
  assert.deepStrictEqual(n.widgets.map((w) => w.name), ['seed', 'sampler_name']);
  assert.strictEqual(n.classType, 'KSampler');
  // 落盘面:toApi 输出无任何中文键
  const api = m.toApi(model);
  const entry = api[n.id];
  assert.strictEqual(entry.class_type, 'KSampler');
  for (const key of Object.keys(entry.inputs)) {
    if (key.startsWith('_')) continue;
    assert.ok(/^[\x20-\x7e]+$/.test(key), `参数键 "${key}" 必须是原始英文`);
  }
  assert.strictEqual(entry.inputs.seed, 42);
  // 连接校验仍基于原始英文 type(MODEL↛LATENT)
  const model2 = m.createModel(REGISTRY);
  const a = m.addExternalNode(model2, { connectionId: 'c', schema });
  const bad = m.validateConnection(model2, a.id, 0, a.id, 0);
  assert.strictEqual(bad.reason, 'self');
});

test('computeSize:中文标签参与宽度度量(CJK 全宽)', () => {
  const model = m.createModel(REGISTRY);
  const n = m.addExternalNode(model, {
    connectionId: 'c',
    schema: { classType: 'KSampler', inputs: [{ name: 'latent_image', type: 'LATENT' }], outputs: ['LATENT'] },
  });
  // 「Latent图像」4 个 CJK + 6 latin ≈ 4*12 + 6*0.56*12,宽度必须大于纯英文 slot 名度量的下限
  const wWithLabel = n.size.w;
  const narrow = m.createModel(REGISTRY);
  const n2 = m.addExternalNode(narrow, {
    connectionId: 'c',
    schema: { classType: 'NoSuch', inputs: [{ name: 'i', type: 'LATENT' }], outputs: ['LATENT'] },
  });
  assert.ok(wWithLabel >= n2.size.w, '中文长标签不缩短宽度');
});
