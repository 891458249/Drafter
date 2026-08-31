// canvases.js 测试(v0.10.0):画布 CRUD/上传落盘/素材库两源聚合
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-canvases-test-'));
installElectronStub(tmp);
const canvases = require('../src/main/canvases');
const store = require('../src/main/store');

const STORE_FILE = path.join(tmp, 'drafter-store.json');
const CANVAS_ROOT = path.join(tmp, 'canvases');

beforeEach(() => {
  try { fs.unlinkSync(STORE_FILE); } catch {}
  fs.rmSync(CANVAS_ROOT, { recursive: true, force: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 造一个真实产物文件(素材库要 existsSync 校验)
function touchFile(rel) {
  const fp = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, 'x');
  return fp;
}

test('create/list/load/save/delete:画布单文件生命周期(v0.12.0 起存 API 格式)', () => {
  const cv = canvases.create('测试画布');
  assert.match(cv.id, /^cv_/);
  assert.deepStrictEqual(canvases.list().map((x) => x.id), [cv.id]);
  assert.strictEqual(canvases.load(cv.id).name, '测试画布');

  const graph = { '1': { id: '1', class_type: 'drafter/text', pos: [10, 20], inputs: { text: '猫' } } };
  const s1 = canvases.save(cv.id, { graph });
  assert.ok(s1.updatedAt >= cv.updatedAt);
  assert.strictEqual(canvases.load(cv.id).graph['1'].inputs.text, '猫');
  // 部分更新:只改名,graph 保留
  canvases.save(cv.id, { name: '改名画布' });
  const loaded = canvases.load(cv.id);
  assert.strictEqual(loaded.name, '改名画布');
  assert.ok(loaded.graph, 'graph 未被覆盖');

  assert.strictEqual(canvases.remove(cv.id), true);
  assert.strictEqual(canvases.load(cv.id), null);
  assert.strictEqual(canvases.list().length, 0);
});

test('安全:非法 id 拒绝访问(防路径穿越)', () => {
  for (const bad of ['../x', '..\\x', 'cv_//etc', '', null, undefined]) {
    assert.strictEqual(canvases.load(bad), null);
    assert.strictEqual(canvases.remove(bad), false);
    assert.throws(() => canvases.saveUpload(bad, { name: 'a.png', data: 'eA==' }), /id 非法/);
  }
});

test('saveUpload:参考图落画布 assets 目录,文件名安全化', () => {
  const cv = canvases.create('上传');
  const r = canvases.saveUpload(cv.id, { name: 'a:b c?.png', data: Buffer.from('png-bytes').toString('base64') });
  assert.ok(r.path.startsWith(path.join(CANVAS_ROOT, cv.id, 'assets')), '落在该画布 assets 目录:' + r.path);
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), 'png-bytes');
  assert.ok(!/[:*?"<>|]/.test(r.name), '文件名已安全化:' + r.name);
  assert.throws(() => canvases.saveUpload(cv.id, { name: 'a.png' }), /缺少文件数据/);
});

test('patchTask:终态写回画布 JSON(API 格式,v0.12.0)', () => {
  const cv = canvases.create('补丁画布');
  canvases.save(cv.id, {
    graph: {
      '3': { id: '3', class_type: 'drafter/image', inputs: { prompt: 'x', tasks: [
        { traceId: 'ok-1', status: 'pending', ts: 1 },
        { traceId: 'ok-2', status: 'processing', ts: 2 },
      ] } },
    },
  });
  assert.strictEqual(canvases.patchTask(cv.id, '3', 'ok-2', { status: 'done', files: [{ path: '/x.png', name: 'x.png' }] }), true);
  const tasks = canvases.load(cv.id).graph['3'].inputs.tasks;
  assert.strictEqual(tasks[1].status, 'done');
  assert.deepStrictEqual(tasks[1].files, [{ path: '/x.png', name: 'x.png' }]);
  assert.strictEqual(tasks[0].status, 'pending', '只改目标任务');
  // 未命中不报错
  assert.strictEqual(canvases.patchTask(cv.id, '3', 'nope', { status: 'done' }), false);
  assert.strictEqual(canvases.patchTask(cv.id, '99', 'ok-1', { status: 'done' }), false);
  assert.strictEqual(canvases.patchTask('cv_none', '3', 'ok-1', {}), false);
});

test('模板(v0.10.1):保存/列表/加载/删除 + sanitize 剥离任务历史与上传文件', () => {
  const graph = { drawflow: { Home: { data: {
    '1': { id: 1, name: 'gen', data: { type: 'image', prompt: '猫', models: ['k1|Vidu-q2'], tasks: [{ traceId: 't1', status: 'done' }], active: 2, view: 1 } },
    '2': { id: 2, name: 'up', data: { type: 'upload', file: { path: '/x.png', name: 'x.png', data: 'b64' } } },
    '3': { id: 3, name: 'llm', data: { type: 'llmtext', results: [{ text: 'old' }], active: 0, view: 0 } },
  } } } };
  const t = canvases.saveTemplate('我的模板', graph);
  assert.match(t.id, /^t_/);
  const loaded = canvases.loadTemplate(t.id);
  const d1 = loaded.graph.drawflow.Home.data['1'].data;
  assert.deepStrictEqual(d1.tasks, [], '任务历史被剥离');
  assert.strictEqual(d1.active, -1);
  assert.strictEqual(d1.prompt, '猫', '配置保留');
  assert.deepStrictEqual(d1.models, ['k1|Vidu-q2'], '模型选择保留');
  assert.strictEqual(loaded.graph.drawflow.Home.data['2'].data.file, null, '上传文件剥离');
  assert.deepStrictEqual(loaded.graph.drawflow.Home.data['3'].data.results, [], '文本结果剥离');
  assert.deepStrictEqual(canvases.listTemplates().map((x) => x.id), [t.id]);
  assert.strictEqual(canvases.removeTemplate(t.id), true);
  assert.strictEqual(canvases.loadTemplate(t.id), null);
  assert.strictEqual(canvases.listTemplates().length, 0);
});

test('导出/导入载荷(v0.10.1 fork;v0.12.0 API 格式):导出剥离历史,导入严格校验并加副本名', () => {
  const cv = canvases.create('原画布');
  canvases.save(cv.id, { graph: {
    '1': { id: '1', class_type: 'drafter/image', pos: [0, 0], inputs: { prompt: '狗', models: ['k|m'], tasks: [{ traceId: 'x' }], active: 0, view: 0 } },
  } });
  const payload = canvases.exportPayload(cv.id);
  assert.strictEqual(payload.app, 'drafter-canvas');
  assert.strictEqual(payload.name, '原画布');
  assert.deepStrictEqual(payload.graph['1'].inputs.tasks, [], '导出不带任务历史');
  assert.strictEqual(payload.graph['1'].inputs.prompt, '狗');
  const imp = canvases.importPayload(payload);
  assert.strictEqual(imp.name, '原画布(副本)');
  assert.ok(imp.graph['1']);
  assert.throws(() => canvases.importPayload({ foo: 1 }), /不是本应用导出的画布 JSON/);
  assert.throws(() => canvases.importPayload({ app: 'drafter-canvas' }), /不是本应用导出的画布 JSON/);
});

test('listAssets:会话 JSONL 与画布节点双源聚合,剔除磁盘缺失,时间倒序', () => {
  // --- 会话源:媒体会话 aigc_task done 事件 ---
  const fSess = touchFile('aigc/t1/cat.png');
  store.upsertSession({ id: 'msess', kind: 'media', title: '老会话', cwd: tmp });
  store.appendSessionEvent('msess', { type: 'aigc_task', traceId: 't1', model: 'Vidu-q2', prompt: '一只猫', status: 'done', ts: 100, files: [{ path: fSess, name: 'cat.png' }] });
  store.appendSessionEvent('msess', { type: 'aigc_task', traceId: 't1', model: 'Vidu-q2', status: 'pending', ts: 99 }); // 无 files,不收
  // 归档会话不收
  store.upsertSession({ id: 'arch', kind: 'media', archived: true, cwd: tmp });
  store.appendSessionEvent('arch', { type: 'aigc_task', traceId: 'tA', status: 'done', ts: 500, files: [{ path: fSess, name: 'cat.png' }] });

  // --- 画布源:节点 tasks ---
  const fCv1 = touchFile('aigc/t2/dog.mp4');
  const fCvGone = touchFile('aigc/t3/gone.png');
  fs.unlinkSync(fCvGone); // 磁盘缺失,应剔除
  const cv = canvases.create('素材画布');
  canvases.save(cv.id, {
    graph: {
      '7': { id: '7', class_type: 'drafter/image', inputs: { tasks: [
        { traceId: 't2', model: 'Kling-3.0', prompt: '狗跑', status: 'done', ts: 200, files: [{ path: fCv1, name: 'dog.mp4' }] },
        { traceId: 't3', status: 'done', ts: 300, files: [{ path: fCvGone, name: 'gone.png' }] },
        { traceId: 't4', status: 'processing', ts: 400 }, // 未完成,不收
      ] } },
    },
  });

  const items = canvases.listAssets();
  assert.deepStrictEqual(items.map((x) => x.traceId), ['t2', 't1'], '剔除 pending/归档/磁盘缺失后按时间倒序');
  assert.strictEqual(items[0].kind, 'video');
  assert.strictEqual(items[0].origin, 'canvas');
  assert.strictEqual(items[0].originName, '素材画布');
  assert.strictEqual(items[0].nodeId, '7');
  assert.strictEqual(items[1].kind, 'image');
  assert.strictEqual(items[1].origin, 'session');
  assert.strictEqual(items[1].originName, '老会话');
  assert.strictEqual(items[1].prompt, '一只猫');
});
