// 无限画布板块(v0.10.0):Drawflow 节点工作流——md「模块一:无限画布」的 MVP。
// 节点类型:文本(prompt 源)/ 参考图上传 / 图片·视频·音频·3D 生成;
// 连线语义:text→prompt 槽、image→参考图/首帧槽(ComfyUI 式类型校验);
// 生成节点支持多模型 fan-out(每模型独立任务,结果并排翻页,勾选「采用」供下游取用);
// 节点保留全部任务历史(画布 JSON 即历史,md 1.2 节点生成历史);
// 变更防抖自动保存到 userData/canvases/<id>.json;产物落 AIGC_DIR 自动进素材库。
import { api, state, $, escapeHtml, ensureGroups, parseModelValue, modelLabel, showCtxMenu } from './state.js';
import { openViewer } from './msgmenu.js';

// ---------------------------------------------------------------------------
// 节点类型注册表(连线类型槽:inTypes[i] 对应 input_{i+1} 接受的来源类型)
// ---------------------------------------------------------------------------
const NODE_TYPES = {
  text:    { label: '文本',     ico: '📝', modelType: null,    inputs: 0, outputs: 1, inTypes: [],                outType: 'text'  },
  upload:  { label: '参考图',   ico: '🖼️', modelType: null,    inputs: 0, outputs: 1, inTypes: [],                 outType: 'image' },
  image:   { label: '图片生成', ico: '🎨', modelType: 'image', inputs: 2, outputs: 1, inTypes: ['text', 'image'],  outType: 'image' },
  video:   { label: '视频生成', ico: '🎬', modelType: 'video', inputs: 2, outputs: 1, inTypes: ['text', 'image'],  outType: 'video' },
  audio:   { label: '音频生成', ico: '🎵', modelType: 'audio', inputs: 1, outputs: 1, inTypes: ['text'],           outType: 'audio' },
  model3d: { label: '3D 生成',  ico: '🧊', modelType: 'model', inputs: 1, outputs: 1, inTypes: ['text'],           outType: 'model' },
};

const AIGC_TERMINAL = new Set(['done', 'fail', 'timeout', 'interrupted']);
const STATUS_TEXT = {
  pending: '排队中', processing: '生成中', transferring: '转存中', downloading: '下载中',
  done: '完成', fail: '失败', timeout: '超时', interrupted: '已取消',
};
const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------
let editor = null;          // Drawflow 实例(首次进入画布板块时惰性创建)
let cvId = null;            // 当前画布 id
let cvName = '';
const nodeData = new Map(); // nodeId(string) → 节点配置/任务历史(持久化进画布 JSON)
let modelOptions = null;    // { image:[{val,label,keyName}], video:[], audio:[], model:[] }
let saveTimer = null;
let importing = false;      // import 期间不触发保存
let addSeq = 0;             // 新节点错位摆放

function defaultData(type) {
  if (type === 'text') return { type, text: '' };
  if (type === 'upload') return { type, file: null }; // file:{path,name,mediaType,data}
  return { type, prompt: '', models: [], tasks: [], active: -1, view: 0 };
}

// ---------------------------------------------------------------------------
// 模型选项:按生成类型聚合启用 Key 的媒体模型(fan-out 多选数据源)
// ---------------------------------------------------------------------------
async function loadModelOptions(force = false) {
  if (modelOptions && !force) return;
  await ensureGroups();
  const entries = (await api.keysEnabledModels()) || [];
  const byType = { image: [], video: [], audio: [], model: [] };
  for (const e of entries) {
    const groups = state.GroupsCache.get(e.keyId);
    const g = groups && groups.find((x) => Array.isArray(x.models) && x.models.includes(e.model));
    const t = g ? g.model_type : 'chat';
    if (byType[t]) byType[t].push({ val: `${e.keyId}|${e.model}`, label: modelLabel(e.model), keyName: e.keyName });
  }
  modelOptions = byType;
}

// ---------------------------------------------------------------------------
// 节点外壳与内容渲染(内容全量重建;输入事件不重建以保光标)
// ---------------------------------------------------------------------------
function nodeShellHtml(type) {
  const t = NODE_TYPES[type];
  return `<div class="cv-shell">
    <div class="cv-head nt-${type}"><span>${t.ico}</span><span class="cv-title">${t.label}</span><button class="cv-del" title="删除节点">✕</button></div>
    <div class="cv-body"></div>
  </div>`;
}

function nodeEl(id) {
  return $('drawflow').querySelector(`#node-${id} .cv-body`);
}

function taskFilesHtml(task) {
  const files = task.files || [];
  if (!files.length) return '';
  return files.map((f) => {
    const src = `aigc://${task.traceId}/${encodeURIComponent(f.name)}`;
    if (IMG_RE.test(f.name)) return `<img src="${src}" alt="" title="点击放大" data-zoom="${src}" />`;
    if (/\.(mp4|mov|webm)$/i.test(f.name)) return `<video src="${src}" controls preload="metadata"></video>`;
    if (/\.(mp3|wav|m4a|ogg)$/i.test(f.name)) return `<audio src="${src}" controls></audio>`;
    return `<span class="cv-file-chip" data-path="${escapeHtml(f.path || '')}" title="点击打开">📦 ${escapeHtml(f.name)}</span>`;
  }).join('');
}

function galleryHtml(d) {
  const total = d.tasks.length;
  if (!total) return '';
  const view = Math.min(Math.max(0, d.view || 0), total - 1);
  const task = d.tasks[view];
  const st = task.status || 'pending';
  let inner = '';
  if (st === 'done') {
    inner = taskFilesHtml(task) || '<div class="cv-status">(无产物文件)</div>';
  } else if (AIGC_TERMINAL.has(st)) {
    inner = `<div class="cv-status st-fail">${escapeHtml(task.failReason || STATUS_TEXT[st] || st)}</div>`;
  } else {
    inner = `<div class="cv-status"><span class="spin">◐</span> ${STATUS_TEXT[st] || st}… <button class="cv-cancel" title="取消任务">✕</button></div>`;
  }
  const adopted = d.active === view;
  return `<div class="cv-gallery" data-view="${view}">
    <div class="cv-result">${inner}</div>
    <div class="cv-pager">
      <button data-act="prev" ${total <= 1 ? 'disabled' : ''} title="上一版">◀</button>
      <span>${view + 1}/${total}</span>
      <button data-act="next" ${total <= 1 ? 'disabled' : ''} title="下一版">▶</button>
      ${st === 'done' ? (adopted ? '<span class="cv-adopted-tag">✓ 已采用</span>' : '<button data-act="adopt" title="采用此版本作为下游输入">采用</button>') : ''}
    </div>
    <div class="cv-ref-src" title="${escapeHtml(task.prompt || '')}">${escapeHtml(modelLabel(task.model || '') || '')}</div>
  </div>`;
}

function bodyHtml(id, d) {
  const t = NODE_TYPES[d.type];
  if (d.type === 'text') {
    return `<textarea class="cv-txt" rows="3" placeholder="输入提示词文本,连到生成节点的 prompt 槽…">${escapeHtml(d.text || '')}</textarea>`;
  }
  if (d.type === 'upload') {
    const f = d.file;
    return `<button class="cv-pick" data-act="pick">${f ? '更换图片…' : '选择图片…'}</button>` +
      (f ? `<img class="cv-upload-thumb" src="data:${f.mediaType};base64,${f.data}" alt="" /><div class="cv-ref-src">${escapeHtml(f.name)}</div>` : '');
  }
  // 生成节点
  const opts = (modelOptions && modelOptions[t.modelType]) || [];
  const msel = opts.length
    ? opts.map((o) => `<label class="${d.models.includes(o.val) ? 'on' : ''}" title="${escapeHtml(o.keyName)}"><input type="checkbox" value="${escapeHtml(o.val)}" ${d.models.includes(o.val) ? 'checked' : ''} />${escapeHtml(o.label)}</label>`).join('')
    : '<span class="cv-ref-src">(无可用模型,请先在「配置 API Key」刷新 Kuro 网关模型列表)</span>';
  return `<textarea class="cv-prompt" rows="3" placeholder="提示词…(连入文本节点后由它接管)">${escapeHtml(d.prompt || '')}</textarea>
    <div class="cv-msel">${msel}</div>
    <button class="cv-gen" data-act="gen">生成${d.models.length > 1 ? ` ×${d.models.length}` : ''}</button>
    ${galleryHtml(d)}`;
}

function renderNodeBody(id) {
  const d = nodeData.get(String(id));
  const el = nodeEl(id);
  if (!d || !el) return;
  el.innerHTML = bodyHtml(id, d);
  applyLinkedPrompt(String(id)); // 重渲染后恢复 prompt 槽接管态
}

// ---------------------------------------------------------------------------
// prompt 槽接管:text 节点连入 input_1 后,prompt 由文本节点供给(只读展示)
// ---------------------------------------------------------------------------
function linkedTextSource(id) {
  // 返回连入该节点 input_1(prompt 槽)的文本节点 id;无则 null
  if (!editor) return null;
  const node = editor.getNodeFromId(id);
  const conns = node && node.inputs && node.inputs.input_1 && node.inputs.input_1.connections;
  for (const c of conns || []) {
    const src = nodeData.get(String(c.node));
    if (src && src.type === 'text') return String(c.node);
  }
  return null;
}

function applyLinkedPrompt(id) {
  const d = nodeData.get(String(id));
  if (!d || !NODE_TYPES[d.type] || !NODE_TYPES[d.type].modelType) return;
  const el = nodeEl(id);
  const ta = el && el.querySelector('.cv-prompt');
  if (!ta) return;
  const src = linkedTextSource(id);
  if (src != null) {
    ta.value = (nodeData.get(src) || {}).text || '';
    ta.readOnly = true;
    ta.placeholder = '(由文本节点接管)';
  } else {
    ta.readOnly = false;
    if (ta.value !== (d.prompt || '')) ta.value = d.prompt || '';
  }
}

function applyLinkedPromptsFromText(textNodeId) {
  // 文本节点内容变化:向所有下游 prompt 槽同步展示
  if (!editor) return;
  const node = editor.getNodeFromId(textNodeId);
  const conns = node && node.outputs && node.outputs.output_1 && node.outputs.output_1.connections;
  for (const c of conns || []) applyLinkedPrompt(String(c.node));
}

// ---------------------------------------------------------------------------
// 参考图解析:连入 image 槽的来源(upload 文件 / 图片生成节点采用版本的首张图)
// ---------------------------------------------------------------------------
function resolveRefFiles(id) {
  if (!editor) return [];
  const node = editor.getNodeFromId(id);
  const out = [];
  for (const [slotName, slot] of Object.entries((node && node.inputs) || {})) {
    const d = nodeData.get(String(id));
    const accept = NODE_TYPES[d.type].inTypes[Number(slotName.replace('input_', '')) - 1];
    if (accept !== 'image') continue;
    for (const c of slot.connections || []) {
      const src = nodeData.get(String(c.node));
      if (!src) continue;
      if (src.type === 'upload' && src.file) out.push({ path: src.file.path, name: src.file.name });
      else if (src.type === 'image' && src.active >= 0) {
        const task = src.tasks[src.active];
        const f = task && (task.files || []).find((x) => IMG_RE.test(x.name));
        if (f) out.push({ path: f.path, name: f.name });
      }
    }
  }
  return out;
}

function resolvePrompt(id, d) {
  const src = linkedTextSource(id);
  if (src != null) return ((nodeData.get(src) || {}).text || '').trim();
  return (d.prompt || '').trim();
}

// ---------------------------------------------------------------------------
// 生成执行(fan-out:每个选中模型一个独立任务)
// ---------------------------------------------------------------------------
async function runNode(id) {
  const d = nodeData.get(String(id));
  if (!d || !NODE_TYPES[d.type].modelType) return;
  if (!cvId) return;
  const prompt = resolvePrompt(id, d);
  if (!prompt) { alert('请先填写提示词(或连入文本节点)。'); return; }
  if (!d.models.length) { alert('请先勾选模型(可多选,同屏对比)。'); return; }
  const refFiles = resolveRefFiles(id);
  for (const modelVal of d.models) {
    const { keyId, model } = parseModelValue(modelVal);
    const task = { traceId: null, model, prompt, status: 'pending', ts: Date.now() };
    d.tasks.push(task);
    const r = await api.aigcExec({ canvasId: cvId, nodeId: String(id), keyId, model, prompt, refFiles });
    if (!r || !r.ok) {
      task.traceId = 'local-err-' + Date.now();
      task.status = 'fail';
      task.failReason = (r && r.error) || '创建任务失败';
    } else {
      task.traceId = r.traceId;
    }
  }
  d.view = d.tasks.length - 1;
  if (d.active < 0) d.active = d.view;
  renderNodeBody(id);
  scheduleSave();
}

function onExecStatus(p) {
  if (!p || p.canvasId !== cvId) return; // 非当前画布:主进程已 patch 画布 JSON,UI 不管
  const id = String(p.nodeId);
  const d = nodeData.get(id);
  if (!d) return;
  const task = d.tasks.find((x) => x.traceId === p.traceId);
  if (!task) return;
  task.status = p.status;
  if (p.files) task.files = p.files;
  if (p.failReason) task.failReason = p.failReason;
  renderNodeBody(id);
  scheduleSave();
}

// ---------------------------------------------------------------------------
// 持久化(防抖自动保存;graph=Drawflow export,节点 data 由 nodeData 覆盖)
// ---------------------------------------------------------------------------
function scheduleSave() {
  if (importing || !cvId) return;
  $('canvas-save-hint').textContent = '…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  if (!cvId || !editor) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const out = editor.export();
  const nodes = out && out.drawflow && out.drawflow.Home && out.drawflow.Home.data;
  if (nodes) for (const [id, node] of Object.entries(nodes)) node.data = nodeData.get(String(id)) || {};
  const r = await api.canvasSave(cvId, { graph: out });
  $('canvas-save-hint').textContent = (r && r.error)
    ? '保存失败:' + r.error
    : '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function flushSave() {
  if (saveTimer) await saveNow();
}

// ---------------------------------------------------------------------------
// 画布打开/新建/重命名/删除
// ---------------------------------------------------------------------------
async function openCanvas(id) {
  await flushSave();
  const cv = await api.canvasLoad(id);
  if (!cv) return;
  importing = true;
  cvId = cv.id;
  cvName = cv.name;
  nodeData.clear();
  editor.clear();
  if (cv.graph) {
    try { editor.import(cv.graph); } catch (e) { console.error('[canvas] import failed:', e); }
    const nodes = (cv.graph.drawflow && cv.graph.drawflow.Home && cv.graph.drawflow.Home.data) || {};
    for (const [nid, node] of Object.entries(nodes)) {
      const data = node.data && node.data.type ? node.data
        : defaultData(String(node.class || '').replace('cv-nt-', ''));
      nodeData.set(String(nid), data);
      renderNodeBody(String(nid));
    }
  }
  importing = false;
  $('canvas-empty').classList.add('hidden');
  $('canvas-save-hint').textContent = '已打开「' + cv.name + '」';
  await renderList();
}

export async function createFromSidebar() {
  const cv = await api.canvasCreate();
  await openCanvas(cv.id);
  return cv;
}

async function renameCanvas(cv, li) {
  // window.prompt 在本 Electron 不可用:行内 input 改名(同会话项双击模式)
  const span = li.querySelector('.session-title span:last-child') || li.querySelector('.session-title');
  const input = document.createElement('input');
  input.className = 'input-sm';
  input.value = cv.name;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const name = input.value.trim();
    if (name && name !== cv.name) await api.canvasSave(cv.id, { name });
    renderList();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') renderList(); };
  input.onblur = commit;
}

async function deleteCanvas(cv) {
  if (!confirm(`删除画布「${cv.name}」?(节点与历史一并删除,产物文件保留在素材库)`)) return;
  await api.canvasDelete(cv.id);
  if (cvId === cv.id) {
    cvId = null;
    cvName = '';
    nodeData.clear();
    if (editor) editor.clear();
    $('canvas-empty').classList.remove('hidden');
    $('canvas-save-hint').textContent = '';
  }
  await renderList();
}

export async function renderList() {
  const list = await api.canvasList();
  const ul = $('session-list');
  ul.innerHTML = '';
  const wrap = document.createElement('li');
  wrap.className = 'proj-group';
  const su = document.createElement('ul');
  su.className = 'proj-sessions';
  for (const cv of list) {
    const li = document.createElement('li');
    li.className = 'session-item' + (cv.id === cvId ? ' active' : '');
    li.innerHTML = `<div class="session-title"><span>🧩 ${escapeHtml(cv.name)}</span></div>
      <div class="session-sub">${escapeHtml(new Date(cv.updatedAt || cv.createdAt || Date.now()).toLocaleString())}</div>`;
    li.title = '双击重命名;右键:重命名 / 删除';
    li.onclick = () => openCanvas(cv.id);
    li.ondblclick = (e) => { e.preventDefault(); renameCanvas(cv, li); };
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '重命名', onClick: () => renameCanvas(cv, li) },
        { label: '删除画布', danger: true, onClick: () => deleteCanvas(cv) },
      ]);
    };
    su.appendChild(li);
  }
  wrap.appendChild(su);
  ul.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// 板块进入:惰性建 Drawflow、加载模型选项、打开最近画布
// ---------------------------------------------------------------------------
export async function enterSection() {
  if (!editor) bootEditor();
  await loadModelOptions(true); // 每次进板块重取(Key 可能刚改过)
  await renderList();
  if (!cvId) {
    const list = await api.canvasList();
    if (list.length) await openCanvas(list[0].id);
    else $('canvas-empty').classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Drawflow 初始化与事件
// ---------------------------------------------------------------------------
function addNodeAt(type) {
  const t = NODE_TYPES[type];
  const i = addSeq++;
  const x = 120 + (i % 6) * 40;
  const y = 80 + (i % 5) * 40;
  const id = String(editor.addNode('cv-' + type, t.inputs, t.outputs, x, y, 'cv-nt-' + type, {}, nodeShellHtml(type), false));
  nodeData.set(id, defaultData(type));
  renderNodeBody(id);
  scheduleSave();
  return id;
}

function bootEditor() {
  editor = new Drawflow($('drawflow'));
  editor.start();

  editor.on('nodeRemoved', (id) => { nodeData.delete(String(id)); scheduleSave(); });
  editor.on('nodeMoved', () => scheduleSave());
  editor.on('connectionCreated', (info) => {
    const srcType = (nodeData.get(String(info.output_id)) || {}).type;
    const dstData = nodeData.get(String(info.input_id));
    const dstType = dstData && dstData.type;
    const slot = Number(String(info.input_class).replace('input_', '')) - 1;
    const accept = dstType ? NODE_TYPES[dstType].inTypes[slot] : null;
    const offer = srcType ? NODE_TYPES[srcType].outType : null;
    if (!accept || accept !== offer) {
      // 类型不匹配即拒连(ComfyUI 式类型槽);同类型重复连由 Drawflow 自身处理
      editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
      return;
    }
    applyLinkedPrompt(String(info.input_id));
    scheduleSave();
  });
  editor.on('connectionRemoved', (info) => {
    applyLinkedPrompt(String(info.input_id));
    scheduleSave();
  });
}

// ---------------------------------------------------------------------------
// 工具栏与宿主事件委托
// ---------------------------------------------------------------------------
function buildAddMenu() {
  const menu = $('cv-add-menu');
  menu.innerHTML = Object.entries(NODE_TYPES).map(([k, t]) =>
    `<button data-nt="${k}">${t.ico} ${t.label}</button>`).join('');
}

function bindToolbar() {
  buildAddMenu();
  $('btn-cv-add').onclick = (e) => {
    e.stopPropagation();
    $('cv-add-menu').classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cv-add-wrap')) $('cv-add-menu').classList.add('hidden');
  });
  $('cv-add-menu').onclick = async (e) => {
    const b = e.target.closest('button[data-nt]');
    if (!b || !cvId) { if (!cvId) $('cv-add-menu').classList.add('hidden'); return; }
    await loadModelOptions();
    addNodeAt(b.dataset.nt);
    $('cv-add-menu').classList.add('hidden');
  };
  $('btn-cv-zoom-in').onclick = () => editor && editor.zoom_in();
  $('btn-cv-zoom-out').onclick = () => editor && editor.zoom_out();
  $('btn-cv-zoom-reset').onclick = () => editor && editor.zoom_reset();
}

function nodeIdOf(target) {
  const el = target.closest('.drawflow-node');
  return el ? el.id.replace('node-', '') : null;
}

function bindDelegation() {
  const host = $('drawflow');

  host.addEventListener('click', async (e) => {
    const id = nodeIdOf(e.target);
    if (!id) return;
    const d = nodeData.get(id);
    if (!d) return;

    if (e.target.closest('.cv-del')) { editor.removeNodeId(id); return; }

    const zoomImg = e.target.closest('img[data-zoom]');
    if (zoomImg) { openViewer(zoomImg.dataset.zoom); return; }

    const chip = e.target.closest('.cv-file-chip');
    if (chip && chip.dataset.path) { api.openPath(chip.dataset.path); return; }

    if (e.target.closest('.cv-cancel')) {
      const view = Math.min(Math.max(0, d.view || 0), d.tasks.length - 1);
      const task = d.tasks[view];
      // traceId 未回(创建中)或本地失败的任务无可取消,忽略
      if (!task || !task.traceId || String(task.traceId).startsWith('local-err-')) return;
      await api.aigcCancel(cvId, task.traceId);
      task.status = 'interrupted';
      renderNodeBody(id);
      scheduleSave();
      return;
    }

    const actBtn = e.target.closest('button[data-act]');
    if (!actBtn) return;
    const act = actBtn.dataset.act;
    if (act === 'pick') {
      const paths = await api.pickFiles({});
      if (!paths || !paths.length) return;
      const r = await api.fileReadImage(paths[0]);
      if (!r.ok) { alert('读取图片失败:' + (r.error || '')); return; }
      const up = await api.canvasSaveUpload(cvId, r.name || paths[0].split(/[\\/]/).pop(), r.data);
      if (!up || !up.ok) { alert('保存参考图失败:' + ((up && up.error) || '')); return; }
      d.file = { path: up.path, name: up.name, mediaType: r.mediaType, data: r.data };
      renderNodeBody(id);
      scheduleSave();
    } else if (act === 'gen') {
      runNode(id);
    } else if (act === 'prev') {
      d.view = Math.max(0, (d.view || 0) - 1);
      renderNodeBody(id);
      scheduleSave();
    } else if (act === 'next') {
      d.view = Math.min(d.tasks.length - 1, (d.view || 0) + 1);
      renderNodeBody(id);
      scheduleSave();
    } else if (act === 'adopt') {
      d.active = d.view || 0;
      renderNodeBody(id);
      scheduleSave();
    }
  });

  // 模型多选 chips(change 不重建 DOM,保持交互顺滑)
  host.addEventListener('change', (e) => {
    const input = e.target.closest('.cv-msel input[type="checkbox"]');
    if (!input) return;
    const id = nodeIdOf(input);
    const d = nodeData.get(id);
    if (!d) return;
    if (input.checked) { if (!d.models.includes(input.value)) d.models.push(input.value); }
    else d.models = d.models.filter((v) => v !== input.value);
    input.closest('label').classList.toggle('on', input.checked);
    // 「生成 ×N」计数即时更新(只改按钮文本,不重建节点)
    const gen = nodeEl(id) && nodeEl(id).querySelector('.cv-gen');
    if (gen) gen.textContent = '生成' + (d.models.length > 1 ? ` ×${d.models.length}` : '');
    scheduleSave();
  });

  // 文本/提示词输入(input 不重建 DOM 以保光标)
  host.addEventListener('input', (e) => {
    const id = nodeIdOf(e.target);
    const d = nodeData.get(id);
    if (!d) return;
    if (e.target.classList.contains('cv-txt')) {
      d.text = e.target.value;
      applyLinkedPromptsFromText(id);
      scheduleSave();
    } else if (e.target.classList.contains('cv-prompt') && !e.target.readOnly) {
      d.prompt = e.target.value;
      scheduleSave();
    }
  });
}

// ---------------------------------------------------------------------------
// 对外:app.js 启动时接线(工具栏/委托/状态事件;Drawflow 本体进板块才建)
// ---------------------------------------------------------------------------
export function init() {
  bindToolbar();
  bindDelegation();
  api.on('aigc:exec-status', onExecStatus);
}
