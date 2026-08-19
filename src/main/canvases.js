// 无限画布持久化与素材库聚合(v0.10.0)
// - 画布单文件 userData/canvases/<id>.json:{ id, name, createdAt, updatedAt, graph }
//   graph = Drawflow export JSON;每节点 data 存自定义配置(prompt/models/tasks/file)
// - 画布上传参考图落 canvases/<id>/assets/,节点按 { path, name } 引用
//  (aigc:exec 直读磁盘,免大 base64 过 IPC)
// - 素材库聚合:媒体会话 JSONL 的 aigc_task done 事件 + 各画布节点 tasks 两源,
//   合并按时间倒序,即 md「素材库:生成历史自动归档」的雏形
// 本模块不依赖 electron 之外的运行时(electron 由测试 stub 提供,同 store.js)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store');

const ROOT = () => path.join(app.getPath('userData'), 'canvases');
const canvasPath = (id) => path.join(ROOT(), id + '.json');
const canvasDir = (id) => path.join(ROOT(), id);
const assetsDir = (id) => path.join(canvasDir(id), 'assets');

const ID_RE = /^cv_[a-zA-Z0-9_-]+$/; // 防路径穿越

// graph 体积守卫(单画布 32MB,含节点任务元数据;产物本体不落 JSON)
const MAX_GRAPH_BYTES = 32 * 1024 * 1024;

function list() {
  let names = [];
  try { names = fs.readdirSync(ROOT()); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT(), n), 'utf8'));
      if (j && j.id) out.push({ id: j.id, name: j.name || '(未命名画布)', createdAt: j.createdAt, updatedAt: j.updatedAt });
    } catch {} // 坏文件跳过
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function create(name) {
  const id = 'cv_' + crypto.randomUUID().slice(0, 12);
  const now = Date.now();
  const cv = { id, name: (name && String(name).trim()) || '新建画布', createdAt: now, updatedAt: now, graph: null };
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.writeFileSync(canvasPath(id), JSON.stringify(cv, null, 2), 'utf8');
  return { id, name: cv.name, createdAt: now, updatedAt: now };
}

function load(id) {
  if (!ID_RE.test(id || '')) return null;
  try {
    const j = JSON.parse(fs.readFileSync(canvasPath(id), 'utf8'));
    return j && j.id ? j : null;
  } catch { return null; }
}

// name/graph 为可选部分更新;graph 传 null 也视为合法值(空画布)
function save(id, { name, graph } = {}) {
  const cur = load(id);
  if (!cur) return null;
  const next = { ...cur, updatedAt: Date.now() };
  if (typeof name === 'string' && name.trim()) next.name = name.trim();
  if (graph !== undefined) {
    if (graph && JSON.stringify(graph).length > MAX_GRAPH_BYTES) return { error: '画布数据过大(>32MB)' };
    next.graph = graph;
  }
  fs.writeFileSync(canvasPath(id), JSON.stringify(next, null, 2), 'utf8');
  return { id: next.id, name: next.name, updatedAt: next.updatedAt };
}

function remove(id) {
  if (!ID_RE.test(id || '')) return false;
  try { fs.unlinkSync(canvasPath(id)); } catch {}
  try { fs.rmSync(canvasDir(id), { recursive: true, force: true }); } catch {}
  return true;
}

// 上传参考图:base64 落画布 assets 目录(同名直接覆盖),返回 { path, name }
function saveUpload(id, { name, data } = {}) {
  if (!ID_RE.test(id || '')) throw new Error('画布 id 非法');
  if (typeof data !== 'string' || !data) throw new Error('缺少文件数据');
  const safe = String(name || 'ref.png').replace(/[\\/:*?"<>|]/g, '_').slice(-80) || 'ref.png';
  const dir = assetsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safe);
  fs.writeFileSync(fp, Buffer.from(data, 'base64'));
  return { path: fp, name: safe };
}

// --- 素材库聚合 -------------------------------------------------------------
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const VID_EXTS = new Set(['mp4', 'mov', 'webm']);
const AUD_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg']);
function extKind(name) {
  const ext = ((name || '').split('.').pop() || '').toLowerCase();
  if (IMG_EXTS.has(ext)) return 'image';
  if (VID_EXTS.has(ext)) return 'video';
  if (AUD_EXTS.has(ext)) return 'audio';
  return 'model';
}

const MEDIA_SESSION_KINDS = new Set(['media', 'image', 'video', 'audio', 'model']);

// 会话源:媒体会话 JSONL 中 status=done 且带 files 的 aigc_task 事件
function* sessionAssets() {
  for (const meta of store.listSessions()) {
    if (!meta || !MEDIA_SESSION_KINDS.has(meta.kind) || meta.archived) continue;
    let events = [];
    try { events = store.readSessionEvents(meta.id, Number.MAX_SAFE_INTEGER); } catch { continue; }
    for (const ev of events) {
      if (!ev || ev.type !== 'aigc_task' || ev.status !== 'done' || !Array.isArray(ev.files)) continue;
      for (const f of ev.files) {
        if (!f || !f.path) continue;
        yield {
          kind: extKind(f.name), traceId: ev.traceId, name: f.name, path: f.path,
          prompt: ev.prompt || '', model: ev.model || '', ts: ev.ts || 0,
          origin: 'session', originId: meta.id, originName: meta.title || '(未命名会话)',
        };
      }
    }
  }
}

// 画布源:每节点 data.tasks 里 done 且带 files 的任务
function* canvasAssets() {
  let names = [];
  try { names = fs.readdirSync(ROOT()); } catch { return; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let cv = null;
    try { cv = JSON.parse(fs.readFileSync(path.join(ROOT(), n), 'utf8')); } catch { continue; }
    const nodes = cv && cv.graph && cv.graph.drawflow && cv.graph.drawflow.Home && cv.graph.drawflow.Home.data;
    if (!nodes || typeof nodes !== 'object') continue;
    for (const [nodeId, node] of Object.entries(nodes)) {
      const tasks = node && node.data && Array.isArray(node.data.tasks) ? node.data.tasks : [];
      for (const t of tasks) {
        if (!t || t.status !== 'done' || !Array.isArray(t.files)) continue;
        for (const f of t.files) {
          if (!f || !f.path) continue;
          yield {
            kind: extKind(f.name), traceId: t.traceId, name: f.name, path: f.path,
            prompt: t.prompt || '', model: t.model || '', ts: t.ts || 0,
            origin: 'canvas', originId: cv.id, originName: cv.name || '(未命名画布)', nodeId,
          };
        }
      }
    }
  }
}

// 两源合并,按时间倒序;磁盘上已不存在的产物剔除(素材库不展示幽灵条目)
function listAssets() {
  const out = [];
  for (const gen of [sessionAssets, canvasAssets]) {
    for (const a of gen()) {
      try { if (!fs.existsSync(a.path)) continue; } catch { continue; }
      out.push(a);
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// 终态补丁(v0.10.0):画布节点的执行任务在终态时把 status/files 写回画布 JSON——
// 用户切走/关窗后任务跑完,画布历史仍完整(渲染端只负责当前打开画布的实时 UI)
function patchTask(canvasId, nodeId, traceId, patch) {
  const cv = load(canvasId);
  if (!cv || !cv.graph) return false;
  const nodes = cv.graph.drawflow && cv.graph.drawflow.Home && cv.graph.drawflow.Home.data;
  const node = nodes && nodes[String(nodeId)];
  const tasks = node && node.data && node.data.tasks;
  if (!Array.isArray(tasks)) return false;
  const t = tasks.find((x) => x && x.traceId === traceId);
  if (!t) return false;
  Object.assign(t, patch);
  save(canvasId, { graph: cv.graph });
  return true;
}

module.exports = { list, create, load, save, remove, saveUpload, listAssets, patchTask, extKind, ROOT, assetsDir };
