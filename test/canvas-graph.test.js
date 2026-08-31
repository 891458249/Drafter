// canvasGraph.js 测试(v0.12.0):格式双向转换 / 校验(循环路径) / 祖先签名缓存键
const { test } = require('node:test');
const assert = require('node:assert');
const g = require('../src/main/canvasGraph');

// 构造一个 drawflow 形态的导出(文本→图片→视频)
function drawflowFixture() {
  return { drawflow: { Home: { data: {
    '1': { id: 1, name: 'cv-text', class: 'cv-nt-text', pos_x: 60, pos_y: 100, data: { type: 'text', text: '一只猫' }, inputs: {}, outputs: { output_1: { connections: [{ node: '2', output: 'input_1' }] } } },
    '2': { id: 2, name: 'cv-image', class: 'cv-nt-image', pos_x: 400, pos_y: 90, data: { type: 'image', prompt: '', models: ['k1|Vidu-q2'], tasks: [{ traceId: 't1', status: 'done' }], active: 0, view: 0 }, inputs: { input_1: { connections: [{ node: '1', input: 'output_1' }] } }, outputs: { output_1: { connections: [{ node: '3', output: 'input_2' }] } } },
    '3': { id: 3, name: 'cv-video', class: 'cv-nt-video', pos_x: 780, pos_y: 120, data: { type: 'video', prompt: '', models: ['k1|Kling-3.0'], tasks: [], active: -1, view: 0 }, inputs: { input_1: { connections: [{ node: '1', input: 'output_1' }] }, input_2: { connections: [{ node: '2', input: 'output_1' }] } }, outputs: {} },
  } } } };
}

test('fromDrawflow:连线拍平为 [源id, 端口序位],data 并入 inputs,tasks 保留', () => {
  const api = g.fromDrawflow(drawflowFixture());
  assert.strictEqual(api['1'].class_type, 'drafter/text');
  assert.strictEqual(api['1'].inputs.text, '一只猫');
  assert.deepStrictEqual(api['2'].inputs.prompt, ['1', 0], '文本→图片 prompt 槽');
  assert.deepStrictEqual(api['3'].inputs.ref, ['2', 0], '图片→视频 ref 槽');
  assert.deepStrictEqual(api['3'].pos, [780, 120]);
  assert.deepStrictEqual(api['2'].inputs.models, ['k1|Vidu-q2']);
  assert.strictEqual(api['2'].inputs.tasks.length, 1);
  // file 引用剥离 base64
  const withFile = g.fromDrawflow({ drawflow: { Home: { data: {
    '9': { id: 9, name: 'cv-upload', class: 'cv-nt-upload', pos_x: 0, pos_y: 0, data: { type: 'upload', file: { path: '/a.png', name: 'a.png', mediaType: 'image/png', data: 'BIGB64' } }, inputs: {}, outputs: {} },
  } } } });
  assert.deepStrictEqual(withFile['9'].inputs.file, { path: '/a.png', name: 'a.png' }, 'base64 不进画布 JSON');
});

test('toDrawflow 与 fromDrawflow 互逆(位置/连线/配置全保留)', () => {
  const api = g.fromDrawflow(drawflowFixture());
  const back = g.toDrawflow(api);
  const data = back.drawflow.Home.data;
  assert.strictEqual(data['1'].class, 'cv-nt-text');
  assert.strictEqual(data['1'].data.text, '一只猫');
  assert.deepStrictEqual(data['2'].inputs.input_1.connections, [{ node: '1', input: 'output_1' }]);
  assert.deepStrictEqual(data['3'].inputs.input_2.connections, [{ node: '2', input: 'output_1' }]);
  assert.strictEqual(data['3'].pos_x, 780);
  // outputs 反向重建:文本节点同时喂图片(prompt)与视频(prompt),两条都重建出来
  const outConns = data['1'].outputs.output_1.connections;
  assert.ok(outConns.some((c) => c.node === '2' && c.output === 'input_1'));
  assert.ok(outConns.some((c) => c.node === '3' && c.output === 'input_1'));
  // 再转回 API 格式应一致(round-trip 幂等;data 并入 inputs 后两侧等值)
  assert.deepStrictEqual(g.fromDrawflow(back), api);
});

test('validate:缺 class_type / 提示词空 / 未勾模型 / 循环依赖带可读路径', () => {
  // 正常画布
  const good = g.fromDrawflow(drawflowFixture());
  assert.strictEqual(g.validate(good).ok, true);
  // prompt 空且未连文本
  const bad1 = { '1': { id: '1', class_type: 'drafter/image', inputs: { prompt: '', models: ['k|m'] } } };
  const v1 = g.validate(bad1);
  assert.strictEqual(v1.ok, false);
  assert.ok(v1.nodeErrors['1'].some((e) => e.type === 'required_input_missing'));
  // 循环:A→B→A
  const cyc = {
    a: { id: 'a', class_type: 'drafter/image', inputs: { prompt: ['b', 0], models: ['k|m'] } },
    b: { id: 'b', class_type: 'drafter/text', inputs: { text: ['a', 0] } },
  };
  const v2 = g.validate(cyc);
  assert.strictEqual(v2.ok, false);
  const cycErr = Object.values(v2.nodeErrors).flat().find((e) => e.type === 'dependency_cycle');
  assert.ok(cycErr, '应有循环依赖错误');
  assert.match(cycErr.message, /→/, '循环路径可读');
  // 不支持节点
  const v3 = g.validate({ x: { id: 'x', class_type: 'KSampler', inputs: {} } });
  assert.ok(Object.values(v3.nodeErrors).flat().some((e) => e.type === 'unsupported_node'));
});

test('外部 ComfyUI 节点:连接戳保留、可回灌 Drawflow 且无连接戳时拒绝', () => {
  const prompt = {
    '1': { id: '1', class_type: 'CheckpointLoaderSimple', title: '加载模型', inputs: { ckpt_name: 'base.safetensors', _comfyConnectionId: 'comfy_local' } },
    '2': { id: '2', class_type: 'KSampler', inputs: { model: ['1', 0], steps: 20, _comfyConnectionId: 'comfy_local' } },
  };
  assert.strictEqual(g.validate(prompt).ok, true);
  const drawflow = g.toDrawflow(prompt);
  assert.strictEqual(drawflow.drawflow.Home.data['2'].data.type, 'external');
  assert.strictEqual(drawflow.drawflow.Home.data['2'].data.comfyClassType, 'KSampler');
  assert.deepStrictEqual(drawflow.drawflow.Home.data['2'].inputs.input_1.connections, [{ node: '1', input: 'output_1' }]);
  const back = g.fromDrawflow(drawflow);
  assert.strictEqual(back['2'].class_type, 'KSampler');
  assert.strictEqual(back['2'].inputs._comfyConnectionId, 'comfy_local');
  assert.deepStrictEqual(back['2'].inputs.model, ['1', 0]);
  assert.strictEqual(g.validate({ x: { id: 'x', class_type: 'KSampler', inputs: {} } }).ok, false);
});

test('nodeSignature:祖先 id 变化但结构同则签名同;内容变则签名变', () => {
  const a1 = {
    '10': { id: '10', class_type: 'drafter/text', inputs: { text: '猫' } },
    '20': { id: '20', class_type: 'drafter/image', inputs: { prompt: ['10', 0], models: ['k|m'], tasks: [{ traceId: 'x' }], active: 0, view: 0 } },
  };
  const a2 = {
    '7': { id: '7', class_type: 'drafter/text', inputs: { text: '猫' } },
    '42': { id: '42', class_type: 'drafter/image', inputs: { prompt: ['7', 0], models: ['k|m'], tasks: [{ traceId: 'y' }], active: 1, view: 2 } },
  };
  assert.strictEqual(g.nodeSignature(a1, '20'), g.nodeSignature(a2, '42'), '祖先 id/版本索引变化不破坏签名(tasks/active/view 剔除)');
  const a3 = JSON.parse(JSON.stringify(a1));
  a3['10'].inputs.text = '狗';
  assert.notStrictEqual(g.nodeSignature(a1, '20'), g.nodeSignature(a3, '20'), '上游文本变 → 下游签名变');
  const a4 = JSON.parse(JSON.stringify(a1));
  a4['20'].inputs.models = ['k|other'];
  assert.notStrictEqual(g.nodeSignature(a1, '20'), g.nodeSignature(a4, '20'), '模型变 → 签名变');
});

test('topoOrder / executionTargets:顺序与目标子图', () => {
  const api = g.fromDrawflow(drawflowFixture());
  assert.deepStrictEqual(g.topoOrder(api), ['1', '2', '3']);
  const { targets, subgraph } = g.executionTargets(api);
  assert.deepStrictEqual(targets.sort(), ['2', '3'], '生成节点是输出节点');
  assert.deepStrictEqual([...subgraph].sort(), ['1', '2', '3'], '目标子图含祖先');
  // 游离节点不进子图
  api['99'] = { id: '99', class_type: 'drafter/text', inputs: { text: '游离' } };
  assert.ok(!g.executionTargets(api).subgraph.has('99'));
});
