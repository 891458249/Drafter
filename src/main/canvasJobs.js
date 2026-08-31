// 画布整图运行器(v0.12.0,对齐 ComfyUI PromptQueue/ExecutionList 语义)
//
// ComfyUI 通读要点(execution.py:1251 / comfy_execution/graph.py:193 / jobs.py):
// - PromptQueue:优先级队列 + currently_running + history;我们简化为单并发 job 队列
// - ExecutionList:就绪集推进——节点上游全部完成才可执行;失败节点的下游标记 skipped
//   (ComfyUI 单节点错误不炸整图)
// - 增量缓存(CacheKeySetInputSignature):节点签名(递归祖先)与上次运行一致且有完成产物
//   → 跳过远程调用直接复用(远程场景命中 = 不重建任务)
// - Job 模型(jobs.py JobStatus):pending/in_progress/completed/failed/cancelled
// 执行器不直接依赖 electron/网络:createTask/pollTask/downloadResults/llmComplete 由 main.js 注入。
const crypto = require('crypto');
const graph = require('./canvasGraph');

const TERMINAL = new Set(['done', 'fail', 'timeout', 'interrupted']);
const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;

const jobs = new Map(); // jobId → job
const jobsByCanvas = new Map(); // canvasId → Set<jobId>
const MAX_JOBS_PER_CANVAS = 20; // 对齐 ComfyUI history 容量思路:老 job 自动挤出

function jobSummary(j) {
  return {
    jobId: j.jobId, canvasId: j.canvasId, status: j.status,
    createdAt: j.createdAt, finishedAt: j.finishedAt || null,
    totalNodes: j.order.length, doneNodes: j.doneNodes, failedNodes: j.failedNodes,
    outputs: j.outputs, error: j.error || null,
  };
}

function listJobs(canvasId) {
  const set = jobsByCanvas.get(canvasId);
  if (!set) return [];
  return [...set].map((id) => jobSummary(jobs.get(id))).sort((a, b) => b.createdAt - a.createdAt);
}

function getJob(jobId) {
  const j = jobs.get(jobId);
  return j ? jobSummary(j) : null;
}

function push(job, payload) {
  job.emit({ jobId: job.jobId, canvasId: job.canvasId, ...payload });
}

// ---------------------------------------------------------------------------
// 单节点执行(媒体走 aigc 闭环;文本走 llmtext)
// ---------------------------------------------------------------------------
async function runNodeMedia(job, id, node, type, deps) {
  const { createTask, pollTask, downloadResults, keyFor } = deps;
  const d = node.inputs;
  const prompt = graph.resolvePromptPreview(job.graphSnapshot, id);
  const modelVals = Array.isArray(d.models) ? d.models : [];
  const refFiles = [];
  // 参考图:upload 文件 或 上游图片节点采用版本产物(image 槽 = input_2/ref)
  const acceptImageSlots = [];
  graph.NODE_TYPES[type].inTypes.forEach((t, i) => { if (t === 'image') acceptImageSlots.push(['prompt', 'ref'][i]); });
  for (const k of acceptImageSlots) {
    const v = d[k];
    if (!Array.isArray(v)) continue;
    const src = job.graphSnapshot[String(v[0])];
    if (!src) continue;
    const st = graph.typeOfClass(src.class_type);
    if (st === 'upload' && src.inputs.file && src.inputs.file.path) refFiles.push({ path: src.inputs.file.path, name: src.inputs.file.name });
    else if (st === 'image') {
      const tasks = src.inputs.tasks || [];
      const adopted = tasks[src.inputs.active];
      const f = adopted && (adopted.files || []).find((x) => IMG_RE.test(x.name));
      if (f) refFiles.push({ path: f.path, name: f.name });
    }
  }
  for (const modelVal of modelVals) {
    if (job.cancelled) return;
    const i = modelVal.indexOf('|');
    const keyId = i > 0 ? modelVal.slice(0, i) : null;
    const model = i > 0 ? modelVal.slice(i + 1) : modelVal;
    const keyEntry = deps.keysById(keyId);
    if (!keyEntry) { push(job, { nodeId: id, status: 'fail', failReason: 'Key 不存在' }); continue; }
    const task = { traceId: null, model, prompt, status: 'pending', ts: Date.now() };
    (d.tasks = d.tasks || []).push(task);
    d.view = d.tasks.length - 1;
    if (d.active < 0) d.active = d.view;
    deps.patchNode(job.canvasId, id, () => true); // 落盘:pending 任务行
    push(job, { nodeId: id, status: 'pending', model });
    try {
      const { traceId } = await createTask(keyEntry, type, { modelKey: model, prompt, refFiles });
      task.traceId = traceId;
      if (job.jobId) deps.registerTrace(traceId, job.jobId, id); // 取消归属
      const h = pollTask(keyEntry, traceId, (st) => {
        if (st.status === 'done') return;
        task.status = st.status;
        if (st.fail_reason || st.last_retry_reason) task.failReason = st.fail_reason || st.last_retry_reason;
        push(job, { nodeId: id, status: st.status, model, failReason: task.failReason });
      });
      if (job.cancelled) { h.cancel(); task.status = 'interrupted'; return; }
      const final = await h.promise;
      if (!final || final.status !== 'done') {
        if (task.status !== 'interrupted') task.status = (final && final.status) || 'fail';
        deps.patchNode(job.canvasId, id, () => true);
        push(job, { nodeId: id, status: task.status, model, failReason: task.failReason });
        continue;
      }
      task.status = 'downloading';
      push(job, { nodeId: id, status: 'downloading', model });
      task.files = await downloadResults(keyEntry, traceId);
      task.status = 'done';
      deps.patchNode(job.canvasId, id, () => true);
      push(job, { nodeId: id, status: 'done', model, files: task.files });
    } catch (e) {
      task.status = 'fail';
      task.failReason = e.message;
      deps.patchNode(job.canvasId, id, () => true);
      push(job, { nodeId: id, status: 'fail', model, failReason: e.message });
    }
  }
}

async function runNodeLlm(job, id, node, deps) {
  const d = node.inputs;
  const prompt = graph.resolvePromptPreview(job.graphSnapshot, id);
  for (const modelVal of d.models || []) {
    if (job.cancelled) return;
    const i = modelVal.indexOf('|');
    const keyId = i > 0 ? modelVal.slice(0, i) : null;
    const model = i > 0 ? modelVal.slice(i + 1) : modelVal;
    const keyEntry = deps.keysById(keyId);
    const entry = { model, prompt, status: 'pending', ts: Date.now(), text: '' };
    (d.results = d.results || []).push(entry);
    d.view = d.results.length - 1;
    if (d.active < 0) d.active = d.view;
    push(job, { nodeId: id, status: 'pending', model });
    const r = await deps.llmComplete(keyEntry, { model, prompt });
    if (r && r.ok) { entry.status = 'done'; entry.text = r.text; }
    else { entry.status = 'fail'; entry.failReason = (r && r.error) || '请求失败'; }
    deps.patchNode(job.canvasId, id, () => true);
    push(job, { nodeId: id, status: entry.status, model, failReason: entry.failReason });
  }
}

// ---------------------------------------------------------------------------
// 整图运行(ExecutionList 就绪集推进 + 签名缓存增量)
// ---------------------------------------------------------------------------
async function runJob(job, deps) {
  job.status = 'in_progress';
  push(job, { status: 'in_progress', order: job.order });
  const g = job.graphSnapshot;
  const done = new Set();
  const failed = new Set();
  const skipped = new Set();

  for (const id of job.order) {
    if (job.cancelled) { job.status = 'cancelled'; break; }
    const node = g[id];
    const type = graph.typeOfClass(node.class_type);
    const t = graph.NODE_TYPES[type];
    // 非目标子图/非生成节点:不算入执行(text/upload 是数据节点,天然完成)
    if (!t || t.unsupported) { failed.add(id); job.failedNodes.push({ id, reason: '不支持的节点类型:' + node.class_type }); continue; }
    // 上游失败 → 本节点跳过(ComfyUI:下游不跑)
    const upstreamFailed = Object.values(node.inputs || {}).some((v) => Array.isArray(v) && (failed.has(String(v[0])) || skipped.has(String(v[0]))));
    if (upstreamFailed) {
      skipped.add(id);
      push(job, { nodeId: id, status: 'skipped', reason: '上游失败' });
      continue;
    }
    // 数据节点(text/upload):无执行,直接 done
    if (!t.modelType) {
      done.add(id);
      job.outputs[id] = { status: 'done' };
      push(job, { nodeId: id, status: 'done' });
      continue;
    }
    // 增量缓存:签名一致且有完成产物 → 复用
    const sig = graph.nodeSignature(g, id);
    const lastSig = node.inputs._v;
    const list = type === 'llmtext' ? (node.inputs.results || []) : (node.inputs.tasks || []);
    const adopted = list[node.inputs.active];
    const hasOutput = adopted && adopted.status === 'done' && ((adopted.files && adopted.files.length) || adopted.text);
    if (lastSig && lastSig === sig && hasOutput) {
      done.add(id);
      job.outputs[id] = { status: 'done', cached: true, files: adopted.files, text: adopted.text };
      push(job, { nodeId: id, status: 'done', cached: true });
      continue;
    }
    // 执行
    push(job, { nodeId: id, status: 'running' });
    if (type === 'llmtext') await runNodeLlm(job, id, node, deps);
    else await runNodeMedia(job, id, node, type, deps);
    // 结果判定:该节点有任一模型成功即 done,全部失败才 failed
    const list2 = type === 'llmtext' ? (node.inputs.results || []) : (node.inputs.tasks || []);
    const anyDone = list2.some((x) => x.status === 'done');
    if (job.cancelled) { job.status = 'cancelled'; break; }
    if (anyDone) {
      done.add(id);
      node.inputs._v = sig; // 落签名(下次增量缓存)
      deps.patchNode(job.canvasId, id, () => true);
      job.outputs[id] = { status: 'done' };
      job.doneNodes++;
    } else {
      failed.add(id);
      job.failedNodes.push({ id, reason: '全部模型失败' });
      job.outputs[id] = { status: 'fail' };
    }
  }

  if (job.status !== 'cancelled') {
    job.status = failed.size && !done.size ? 'failed' : failed.size ? 'completed_with_errors' : 'completed';
  }
  job.finishedAt = Date.now();
  push(job, { status: job.status, outputs: job.outputs, failedNodes: job.failedNodes });
  // 容量挤出(对齐 ComfyUI history 上限思路)
  const set = jobsByCanvas.get(job.canvasId);
  if (set && set.size > MAX_JOBS_PER_CANVAS) {
    const oldest = [...set].map((id) => jobs.get(id)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest && oldest.jobId !== job.jobId) { jobs.delete(oldest.jobId); set.delete(oldest.jobId); }
  }
}

// deps: { canvasLoad, patchNode, keysById, modelTypeOf, createTask, pollTask, downloadResults,
//         llmComplete, registerTrace, emit }
function startJob(canvasId, deps) {
  const cv = deps.canvasLoad(canvasId);
  if (!cv || !cv.graph) return { ok: false, error: '画布不存在或为空' };
  const v = graph.validate(cv.graph);
  if (!v.ok) return { ok: false, error: '画布校验未通过', nodeErrors: v.nodeErrors };
  const { subgraph } = graph.executionTargets(cv.graph);
  const order = graph.topoOrder(cv.graph).filter((id) => subgraph.has(id));
  if (!order.length) return { ok: false, error: '没有可运行的节点' };
  const job = {
    jobId: 'job_' + crypto.randomUUID().slice(0, 12),
    canvasId,
    status: 'pending',
    createdAt: Date.now(),
    doneNodes: 0,
    failedNodes: [],
    outputs: {},
    order,
    graphSnapshot: cv.graph, // 执行期快照(运行中改画布不影响在跑的 job)
    cancelled: false,
    emit: deps.emit,
  };
  jobs.set(job.jobId, job);
  if (!jobsByCanvas.has(canvasId)) jobsByCanvas.set(canvasId, new Set());
  jobsByCanvas.get(canvasId).add(job.jobId);
  push(job, { status: 'pending', totalNodes: order.length });
  runJob(job, deps).catch((e) => {
    job.status = 'failed';
    job.error = e.message;
    job.finishedAt = Date.now();
    push(job, { status: 'failed', error: e.message });
  });
  return { ok: true, jobId: job.jobId, job: jobSummary(job) };
}

function cancelJob(jobId, cancelTrace) {
  const j = jobs.get(jobId);
  if (!j) return false;
  j.cancelled = true;
  if (j.status === 'pending' || j.status === 'in_progress') {
    j.status = 'cancelled';
    j.finishedAt = Date.now();
    push(j, { status: 'cancelled' });
  }
  return true;
}

module.exports = { startJob, listJobs, getJob, cancelJob, MAX_JOBS_PER_CANVAS };
