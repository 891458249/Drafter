// canvasJobs.js 测试(v0.12.0):整图运行顺序/单点失败不炸分支/增量缓存/取消
// 执行器全部外部依赖(createTask/pollTask/downloadResults/llmComplete)注入 mock
const { test } = require('node:test');
const assert = require('node:assert');

const canvasJobs = require('../src/main/canvasJobs');

function makeDeps(overrides = {}) {
  const created = [];
  const deps = {
    canvasLoad: overrides.canvasLoad,
    patchNode: () => true,
    keysById: () => ({ id: 'k1', key: 'x', baseUrl: 'https://gw' }),
    createTask: async (_key, board, opts) => { created.push({ board, modelKey: opts.modelKey, prompt: opts.prompt, refFiles: opts.refFiles }); return { traceId: 'tr-' + created.length }; },
    pollTask: () => ({ promise: Promise.resolve({ status: 'done' }), cancel() {} }),
    downloadResults: async () => [{ path: '/out/f.png', name: 'f.png' }],
    llmComplete: async () => ({ ok: true, text: '文案' }),
    registerTrace: () => {},
    emit: () => {},
    ...overrides,
  };
  return { deps, created };
}

// 画布:文本→图片→视频(另挂一条游离音频分支)
function makeGraph(opts = {}) {
  return {
    '1': { id: '1', class_type: 'drafter/text', inputs: { text: '一只猫' } },
    '2': { id: '2', class_type: 'drafter/image', inputs: { prompt: ['1', 0], models: ['k1|img-model'], tasks: opts.imgTasks || [], active: opts.imgActive ?? -1, view: 0 } },
    '3': { id: '3', class_type: 'drafter/video', inputs: { prompt: ['1', 0], ref: ['2', 0], models: ['k1|vid-model'], tasks: [], active: -1, view: 0 } },
    '4': { id: '4', class_type: 'drafter/llmtext', inputs: { prompt: '写标题', models: ['k1|chat-model'], results: [], active: -1, view: 0 } },
  };
}

test('整图运行:上游完成后下游才建任务;视频参考图取图片节点采用版本产物', async () => {
  const graphData = makeGraph();
  const { deps, created } = makeDeps({ canvasLoad: () => ({ id: 'cv1', graph: graphData }) });
  const events = [];
  deps.emit = (e) => events.push(e);
  const r = canvasJobs.startJob('cv1', deps);
  assert.strictEqual(r.ok, true);
  // 等 job 跑完(轮询状态)
  for (let i = 0; i < 100 && canvasJobs.getJob(r.jobId).status !== 'completed'; i++) await new Promise((x) => setTimeout(x, 10));
  const job = canvasJobs.getJob(r.jobId);
  assert.strictEqual(job.status, 'completed');
  // 执行顺序:图片在视频前
  const imgIdx = created.findIndex((c) => c.board === 'image');
  const vidIdx = created.findIndex((c) => c.board === 'video');
  assert.ok(imgIdx >= 0 && vidIdx > imgIdx, '视频在图片之后:' + JSON.stringify(created));
  // 视频参考图 = 图片节点 done 任务的首张图
  assert.deepStrictEqual(created[vidIdx].refFiles, [{ path: '/out/f.png', name: 'f.png' }]);
  // LLM 文本节点也跑了
  assert.ok(events.some((e) => e.nodeId === '4' && e.status === 'done'));
  // 输出归属
  assert.strictEqual(job.outputs['2'].status, 'done');
  assert.strictEqual(job.outputs['3'].status, 'done');
  // 图片节点落了 _v 签名(增量缓存)
  assert.ok(graphData['2'].inputs._v, '执行后落签名');
});

test('单点失败不炸分支(ComfyUI 语义):图片失败→视频 skipped,LLM 分支照常完成', async () => {
  const graphData = makeGraph();
  const { deps } = makeDeps({
    canvasLoad: () => ({ id: 'cv2', graph: graphData }),
    createTask: async (_k, board) => {
      if (board === 'image') throw new Error('网关 500');
      return { traceId: 'tr-ok' };
    },
  });
  const r = canvasJobs.startJob('cv2', deps);
  assert.strictEqual(r.ok, true);
  for (let i = 0; i < 100; i++) {
    const j = canvasJobs.getJob(r.jobId);
    if (j.status !== 'pending' && j.status !== 'in_progress') break;
    await new Promise((x) => setTimeout(x, 10));
  }
  const job = canvasJobs.getJob(r.jobId);
  assert.strictEqual(job.status, 'completed_with_errors', '有失败也有成功 → completed_with_errors');
  assert.strictEqual(job.outputs['2'].status, 'fail');
  assert.ok(!job.outputs['3'] || job.outputs['3'].status !== 'done', '视频被跳过');
  assert.strictEqual(job.outputs['4'].status, 'done', 'LLM 分支不受影响');
});

test('增量缓存:签名一致且有完成产物 → 跳过不建任务;改上游文本 → 子树重跑', async () => {
  const g = require('../src/main/canvasGraph');
  // 先造一个已完成的画布(带 _v 签名与 done 产物)
  const graphData = makeGraph({
    imgTasks: [{ traceId: 't0', status: 'done', files: [{ path: '/old.png', name: 'old.png' }] }],
    imgActive: 0,
  });
  // 视频节点也带完成产物,否则缓存不命中会重跑(缓存语义:未变更且有产物才复用)
  graphData['3'].inputs.tasks = [{ traceId: 'tv0', status: 'done', files: [{ path: '/old.mp4', name: 'old.mp4' }] }];
  graphData['3'].inputs.active = 0;
  graphData['2'].inputs._v = g.nodeSignature(graphData, '2');
  graphData['3'].inputs._v = g.nodeSignature(graphData, '3');
  const { deps, created } = makeDeps({ canvasLoad: () => ({ id: 'cv3', graph: graphData }) });
  const r = canvasJobs.startJob('cv3', deps);
  assert.strictEqual(r.ok, true);
  for (let i = 0; i < 100 && canvasJobs.getJob(r.jobId).status === 'in_progress'; i++) await new Promise((x) => setTimeout(x, 10));
  const job = canvasJobs.getJob(r.jobId);
  assert.strictEqual(created.length, 0, '全部命中缓存,零新建任务');
  assert.strictEqual(job.outputs['2'].cached, true);
  assert.strictEqual(job.outputs['3'].cached, true);

  // 改上游文本 → 图片+视频签名变 → 重跑
  graphData['1'].inputs.text = '一只狗';
  const { deps: deps2, created: created2 } = makeDeps({ canvasLoad: () => ({ id: 'cv3', graph: graphData }) });
  const r2 = canvasJobs.startJob('cv3', deps2);
  for (let i = 0; i < 100 && canvasJobs.getJob(r2.jobId).status === 'in_progress'; i++) await new Promise((x) => setTimeout(x, 10));
  assert.strictEqual(created2.length, 2, '改上游 → 下游子树重跑(图片+视频)');
});

test('校验不过直接拒:空 prompt / 循环', () => {
  const { deps } = makeDeps({ canvasLoad: () => ({ id: 'cv4', graph: { '1': { id: '1', class_type: 'drafter/image', inputs: { prompt: '', models: ['k|m'] } } } }) });
  const r = canvasJobs.startJob('cv4', deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.nodeErrors['1']);
});

test('取消:运行中的 job 标记 cancelled', () => {
  const graphData = makeGraph();
  const { deps } = makeDeps({
    canvasLoad: () => ({ id: 'cv5', graph: graphData }),
    // createTask 挂起不返回,让 job 停在 in_progress
    createTask: () => new Promise(() => {}),
  });
  const r = canvasJobs.startJob('cv5', deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(canvasJobs.cancelJob(r.jobId), true);
  assert.strictEqual(canvasJobs.getJob(r.jobId).status, 'cancelled');
  assert.strictEqual(canvasJobs.cancelJob('job_none'), false);
});
