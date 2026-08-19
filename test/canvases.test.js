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

test('create/list/load/save/delete:画布单文件生命周期', () => {
  const cv = canvases.create('测试画布');
  assert.match(cv.id, /^cv_/);
  assert.deepStrictEqual(canvases.list().map((x) => x.id), [cv.id]);
  assert.strictEqual(canvases.load(cv.id).name, '测试画布');

  const graph = { drawflow: { Home: { data: { '1': { id: 1, name: 'gen', data: { prompt: '猫' } } } } } };
  const s1 = canvases.save(cv.id, { graph });
  assert.ok(s1.updatedAt >= cv.updatedAt);
  assert.strictEqual(canvases.load(cv.id).graph.drawflow.Home.data['1'].data.prompt, '猫');
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

test('patchTask:终态写回画布 JSON(用户切走后任务完成历史仍完整)', () => {
  const cv = canvases.create('补丁画布');
  canvases.save(cv.id, {
    graph: { drawflow: { Home: { data: {
      '3': { id: 3, name: 'gen', data: { tasks: [
        { traceId: 'ok-1', status: 'pending', ts: 1 },
        { traceId: 'ok-2', status: 'processing', ts: 2 },
      ] } },
    } } } },
  });
  assert.strictEqual(canvases.patchTask(cv.id, '3', 'ok-2', { status: 'done', files: [{ path: '/x.png', name: 'x.png' }] }), true);
  const tasks = canvases.load(cv.id).graph.drawflow.Home.data['3'].data.tasks;
  assert.strictEqual(tasks[1].status, 'done');
  assert.deepStrictEqual(tasks[1].files, [{ path: '/x.png', name: 'x.png' }]);
  assert.strictEqual(tasks[0].status, 'pending', '只改目标任务');
  // 未命中不报错
  assert.strictEqual(canvases.patchTask(cv.id, '3', 'nope', { status: 'done' }), false);
  assert.strictEqual(canvases.patchTask(cv.id, '99', 'ok-1', { status: 'done' }), false);
  assert.strictEqual(canvases.patchTask('cv_none', '3', 'ok-1', {}), false);
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
    graph: { drawflow: { Home: { data: {
      '7': { id: 7, name: 'gen', data: { tasks: [
        { traceId: 't2', model: 'Kling-3.0', prompt: '狗跑', status: 'done', ts: 200, files: [{ path: fCv1, name: 'dog.mp4' }] },
        { traceId: 't3', status: 'done', ts: 300, files: [{ path: fCvGone, name: 'gone.png' }] },
        { traceId: 't4', status: 'processing', ts: 400 }, // 未完成,不收
      ] } },
    } } } },
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
