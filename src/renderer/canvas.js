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
  llmtext: { label: '文本生成', ico: '✍️', modelType: 'chat',  inputs: 1, outputs: 1, inTypes: ['text'],           outType: 'text', llm: true },
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
  if (type === 'llmtext') return { type, prompt: '', models: [], results: [], active: -1, view: 0 };
  return { type, prompt: '', models: [], tasks: [], active: -1, view: 0 };
}

// 版本列表:媒体生成走 tasks(含 traceId),文本生成走 results(含 text)
function versionsOf(d) {
  return d && d.type === 'llmtext' ? (d.results || []) : (d.tasks || []);
}

// ---------------------------------------------------------------------------
// 模型选项:按生成类型聚合启用 Key 的媒体模型(fan-out 多选数据源)
// ---------------------------------------------------------------------------
async function loadModelOptions(force = false) {
  if (modelOptions && !force) return;
  await ensureGroups();
  const entries = (await api.keysEnabledModels()) || [];
  const byType = { chat: [], image: [], video: [], audio: [], model: [] };
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
  const list = versionsOf(d);
  const total = list.length;
  if (!total) return '';
  const view = Math.min(Math.max(0, d.view || 0), total - 1);
  const v = list[view];
  const st = v.status || 'pending';
  let inner = '';
  if (d.type === 'llmtext') {
    // 文本生成:结果即文本(预览可滚动)
    inner = st === 'fail'
      ? `<div class="cv-status st-fail">${escapeHtml(v.failReason || '生成失败')}</div>`
      : st === 'done'
        ? `<div class="cv-text-out">${escapeHtml(v.text || '')}</div>`
        : `<div class="cv-status"><span class="spin">◐</span> 生成中…</div>`;
  } else if (st === 'done') {
    inner = taskFilesHtml(v) || '<div class="cv-status">(无产物文件)</div>';
  } else if (AIGC_TERMINAL.has(st)) {
    inner = `<div class="cv-status st-fail">${escapeHtml(v.failReason || STATUS_TEXT[st] || st)}</div>`;
  } else {
    inner = `<div class="cv-status"><span class="spin">◐</span> ${STATUS_TEXT[st] || st}… <button class="cv-cancel" title="取消任务">✕</button></div>`;
  }
  const adopted = d.active === view;
  const adoptable = st === 'done';
  return `<div class="cv-gallery" data-view="${view}">
    <div class="cv-result">${inner}</div>
    <div class="cv-pager">
      <button data-act="prev" ${total <= 1 ? 'disabled' : ''} title="上一版">◀</button>
      <span>${view + 1}/${total}</span>
      <button data-act="next" ${total <= 1 ? 'disabled' : ''} title="下一版">▶</button>
      ${adoptable ? (adopted ? '<span class="cv-adopted-tag">✓ 已采用</span>' : '<button data-act="adopt" title="采用此版本作为下游输入">采用</button>') : ''}
    </div>
    <div class="cv-ref-src" title="${escapeHtml(v.prompt || '')}">${escapeHtml(modelLabel(v.model || '') || '')}</div>
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
  // 返回连入该节点 input_1(prompt 槽)的文本来源节点 id(文本/文本生成);无则 null
  if (!editor) return null;
  const node = editor.getNodeFromId(id);
  const conns = node && node.inputs && node.inputs.input_1 && node.inputs.input_1.connections;
  for (const c of conns || []) {
    const src = nodeData.get(String(c.node));
    if (src && (src.type === 'text' || src.type === 'llmtext')) return String(c.node);
  }
  return null;
}

// 文本来源的当前文本:文本节点=正文;文本生成节点=采用版本的文本
function textOfNode(id) {
  const d = nodeData.get(String(id));
  if (!d) return '';
  if (d.type === 'text') return d.text || '';
  if (d.type === 'llmtext') {
    const r = d.results && d.results[d.active];
    return (r && r.text) || '';
  }
  return '';
}

function applyLinkedPrompt(id) {
  const d = nodeData.get(String(id));
  if (!d || !NODE_TYPES[d.type] || !NODE_TYPES[d.type].modelType) return;
  const el = nodeEl(id);
  const ta = el && el.querySelector('.cv-prompt');
  if (!ta) return;
  const src = linkedTextSource(id);
  if (src != null) {
    ta.value = textOfNode(src);
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
  if (src != null) return textOfNode(src).trim();
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

  // 文本生成节点(走 /v1/chat/completions,串行调用,版本翻页与媒体节点同规)
  if (d.type === 'llmtext') {
    for (const modelVal of d.models) {
      const { keyId, model } = parseModelValue(modelVal);
      const entry = { model, prompt, status: 'pending', ts: Date.now(), text: '' };
      d.results.push(entry);
      d.view = d.results.length - 1;
      renderNodeBody(id);
      const r = await api.llmComplete({ keyId, model, prompt });
      if (r && r.ok) { entry.status = 'done'; entry.text = r.text; }
      else { entry.status = 'fail'; entry.failReason = (r && r.error) || '请求失败'; }
      if (d.active < 0) d.active = d.results.length - 1;
      renderNodeBody(id);
    }
    scheduleSave();
    return;
  }

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
// 持久化(防抖自动保存;v0.12.0 起画布存 ComfyUI API 格式:export 后经主进程转换)
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
  // 主进程转 API 格式落盘(graph 参数语义不变:传编辑器 export,主进程负责转换)
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
    // v0.12.0:画布存 ComfyUI API 格式;渲染端经主进程转 drawflow 形再 import
    const dfGraph = cv.graph.drawflow ? cv.graph : await api.canvasToDrawflow(cv.graph);
    try { editor.import(dfGraph); } catch (e) { console.error('[canvas] import failed:', e); }
    const nodes = (dfGraph.drawflow && dfGraph.drawflow.Home && dfGraph.drawflow.Home.data) || {};
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
  await seedPresetsIfEmpty();   // 模板铺底(一次性)
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

// 双击画布空白 → 搜索框快速加节点(模糊匹配节点名,Enter 选第一个)
function openSearchMenu(x, y) {
  let box = document.querySelector('.cv-search');
  if (box) box.remove();
  box = document.createElement('div');
  box.className = 'cv-search';
  box.innerHTML = `<input class="input-sm" placeholder="搜索节点…(Enter 添加)" />`;
  const list = document.createElement('div');
  list.className = 'cv-search-list';
  box.appendChild(list);
  box.style.left = Math.min(x, window.innerWidth - 260) + 'px';
  box.style.top = Math.min(y, window.innerHeight - 260) + 'px';
  document.body.appendChild(box);
  const input = box.querySelector('input');
  const render = (q) => {
    const items = Object.entries(NODE_TYPES).filter(([, t]) =>
      !q || t.label.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = items.map(([k, t]) => `<button data-nt="${k}">${t.ico} ${t.label}</button>`).join('');
    list.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => { await loadModelOptions(); addNodeAt(b.dataset.nt); box.remove(); };
    });
    return items;
  };
  input.oninput = () => render(input.value.trim());
  input.onkeydown = async (e) => {
    if (e.key === 'Escape') box.remove();
    if (e.key === 'Enter') {
      const items = render(input.value.trim());
      if (items.length) { await loadModelOptions(); addNodeAt(items[0][0]); box.remove(); }
    }
  };
  render('');
  input.focus();
  const closer = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', closer); } };
  document.addEventListener('mousedown', closer);
}

// ---------------------------------------------------------------------------
// 画布模板(md 1.2:保存/复用整套节点布局) + fork/导入导出(只读分享与复制项目)
// ---------------------------------------------------------------------------
function presetNode({ id, type, x, y, inputs = {}, outputs = {} }) {
  const t = NODE_TYPES[type];
  const ins = {};
  for (let i = 1; i <= t.inputs; i++) ins['input_' + i] = { connections: inputs['input_' + i] || [] };
  const outs = {};
  for (let i = 1; i <= t.outputs; i++) outs['output_' + i] = { connections: outputs['output_' + i] || [] };
  return [String(id), {
    id, name: 'cv-' + type, data: defaultData(type), class: 'cv-nt-' + type,
    html: nodeShellHtml(type), typenode: false, inputs: ins, outputs: outs, pos_x: x, pos_y: y,
  }];
}

const PRESETS = [
  ['文生图 → 图生视频', () => ({ drawflow: { Home: { data: Object.fromEntries([
    presetNode({ id: 1, type: 'text', x: 60, y: 140, outputs: { output_1: [{ node: '2', output: 'input_1' }, { node: '3', output: 'input_1' }] } }),
    presetNode({ id: 2, type: 'image', x: 430, y: 90, inputs: { input_1: [{ node: '1', input: 'output_1' }] }, outputs: { output_1: [{ node: '3', output: 'input_2' }] } }),
    presetNode({ id: 3, type: 'video', x: 800, y: 140, inputs: { input_1: [{ node: '1', input: 'output_1' }], input_2: [{ node: '2', input: 'output_1' }] } }),
  ]) } } })],
  ['LLM 提示词 → 图片生成', () => ({ drawflow: { Home: { data: Object.fromEntries([
    presetNode({ id: 1, type: 'text', x: 60, y: 140, outputs: { output_1: [{ node: '2', output: 'input_1' }] } }),
    presetNode({ id: 2, type: 'llmtext', x: 400, y: 120, inputs: { input_1: [{ node: '1', input: 'output_1' }] }, outputs: { output_1: [{ node: '3', output: 'input_1' }] } }),
    presetNode({ id: 3, type: 'image', x: 760, y: 140, inputs: { input_1: [{ node: '2', input: 'output_1' }] } }),
  ]) } } })],
];

// 首次进入播种两个预置模板(gems 预置同款:无模板时一次性铺底)
async function seedPresetsIfEmpty() {
  if ((await api.canvasListTemplates()).length) return;
  for (const [name, make] of PRESETS) await api.canvasSaveTemplate(name, make());
}

function tplMenuHtml(list) {
  const items = list.map((t) =>
    `<div class="cv-tpl-row"><button class="cv-tpl-use" data-tpl="${t.id}">📐 ${escapeHtml(t.name)}</button><button class="cv-tpl-del" data-tpldel="${t.id}" title="删除模板">✕</button></div>`).join('');
  return `<div class="cv-tpl-save"><input id="cv-tpl-name" class="input-sm" placeholder="模板名…" /><button class="btn btn-sm btn-primary" data-tplsave>存为模板</button></div>
    <div class="cv-tpl-list">${items || '<div class="cv-ref-src cv-tpl-none">(暂无模板)</div>'}</div>
    <div class="ctx-sep"></div>
    <button data-tplexport>⇩ 导出当前画布副本…</button>`;
}

async function newCanvasFromTemplate(tplId) {
  const t = await api.canvasLoadTemplate(tplId);
  if (!t) return;
  const cv = await api.canvasCreate(t.name);
  await api.canvasSave(cv.id, { graph: t.graph });
  await openCanvas(cv.id);
}

function bindTemplateMenu() {
  $('btn-cv-tpl').onclick = async (e) => {
    e.stopPropagation();
    const menu = $('cv-tpl-menu');
    if (menu.classList.contains('hidden')) {
      menu.innerHTML = tplMenuHtml(await api.canvasListTemplates());
    }
    menu.classList.toggle('hidden');
  };
  $('cv-tpl-menu').onclick = async (e) => {
    const menu = $('cv-tpl-menu');
    if (e.target.closest('[data-tplsave]')) {
      const name = ($('cv-tpl-name').value || '').trim();
      if (!name || !cvId || !editor) return;
      await api.canvasSaveTemplate(name, editor.export()); // 主进程 sanitize 剥离任务历史
      $('canvas-save-hint').textContent = '已存为模板「' + name + '」';
      menu.innerHTML = tplMenuHtml(await api.canvasListTemplates());
      return;
    }
    const use = e.target.closest('[data-tpl]');
    if (use) {
      menu.classList.add('hidden');
      await newCanvasFromTemplate(use.dataset.tpl);
      return;
    }
    const del = e.target.closest('[data-tpldel]');
    if (del) {
      e.stopPropagation();
      await api.canvasRemoveTemplate(del.dataset.tpldel);
      menu.innerHTML = tplMenuHtml(await api.canvasListTemplates());
      return;
    }
    if (e.target.closest('[data-tplexport]')) {
      menu.classList.add('hidden');
      if (!cvId) return;
      await flushSave();
      const r = await api.canvasExportFile(cvId);
      if (r && r.ok) $('canvas-save-hint').textContent = '已导出副本:' + r.path;
      else if (r && r.error && !r.canceled) alert('导出失败:' + r.error);
    }
  };
  $('btn-cv-import').onclick = async () => {
    const r = await api.canvasImportFile();
    if (r && r.ok && r.canvas) await openCanvas(r.canvas.id);
    else if (r && r.error && !r.canceled) alert(r.error);
  };
}

// ---------------------------------------------------------------------------
// 整图运行(v0.12.0,对齐 ComfyUI):保存→校验→主进程执行器;节点状态环随
// canvas:job-status 流转;校验失败逐节点高亮错误
// ---------------------------------------------------------------------------
let currentJobId = null;
const nodeJobState = new Map(); // nodeId → 'queued'|'running'|'done'|'fail'|'skipped'|'cached'

async function runCanvas() {
  if (!cvId) return;
  await flushSave();
  const cv = await api.canvasLoad(cvId);
  if (!cv || !cv.graph) return;
  const v = await api.canvasValidate(cv.graph);
  clearNodeErrors();
  if (!v.ok) {
    for (const [nid, errs] of Object.entries(v.nodeErrors || {})) {
      if (nid === '_global') { alert(errs.map((e) => e.message).join('\n')); continue; }
      markNodeError(nid, errs.map((e) => e.message).join('\n'));
    }
    return;
  }
  const r = await api.canvasRun(cvId);
  if (!r || !r.ok) {
    if (r && r.nodeErrors) {
      for (const [nid, errs] of Object.entries(r.nodeErrors)) markNodeError(nid, errs.map((e) => e.message).join('\n'));
    } else {
      alert('运行失败:' + ((r && r.error) || '未知错误'));
    }
    return;
  }
  currentJobId = r.jobId;
  nodeJobState.clear();
  setRunBtn(true);
}

function setRunBtn(running) {
  const btn = $('btn-cv-run');
  if (!btn) return;
  btn.disabled = running;
  btn.textContent = running ? '◐ 运行中…' : '▶ 运行';
}

function clearNodeErrors() {
  for (const el of $('drawflow').querySelectorAll('.cv-node-err')) el.remove();
  for (const el of $('drawflow').querySelectorAll('.drawflow-node.cv-err')) el.classList.remove('cv-err');
}

function markNodeError(nid, msg) {
  const nodeEl = $(('drawflow')) && document.querySelector(`#node-${nid}`);
  if (!nodeEl) return;
  nodeEl.classList.add('cv-err');
  const body = nodeEl.querySelector('.cv-body');
  if (body) body.insertAdjacentHTML('afterbegin', `<div class="cv-node-err">⚠ ${escapeHtml(msg)}</div>`);
}

function applyNodeState(nid, status) {
  const el = document.querySelector(`#node-${nid}`);
  if (!el) return;
  for (const s of ['queued', 'running', 'done', 'fail', 'skipped', 'cached']) el.classList.remove('cv-st-' + s);
  if (status) el.classList.add('cv-st-' + status);
  nodeJobState.set(String(nid), status);
}

function onJobStatus(p) {
  if (!p || p.canvasId !== cvId) return;
  if (p.nodeId) applyNodeState(p.nodeId, p.status === 'done' && p.cached ? 'cached' : p.status);
  if (p.status === 'completed' || p.status === 'completed_with_errors' || p.status === 'failed' || p.status === 'cancelled') {
    setRunBtn(false);
    currentJobId = null;
    // 终态:重开画布数据(canvasJobs 已把任务产物/_v 写回画布 JSON),节点内容与产物刷新
    reopenCurrent();
  }
  if (p.status === 'failed' && p.error) alert('整图运行失败:' + p.error);
}

// 整图运行终态后重载画布内容(节点任务历史/产物由主进程写回,UI 重新挂)
async function reopenCurrent() {
  if (!cvId) return;
  const cv = await api.canvasLoad(cvId);
  if (!cv || !cv.graph) return;
  importing = true;
  nodeData.clear();
  const dfGraph = cv.graph.drawflow ? cv.graph : await api.canvasToDrawflow(cv.graph);
  try { editor.import(dfGraph); } catch {}
  const nodes = (dfGraph.drawflow && dfGraph.drawflow.Home && dfGraph.drawflow.Home.data) || {};
  for (const [nid, node] of Object.entries(nodes)) {
    const data = node.data && node.data.type ? node.data : defaultData(String(node.class || '').replace('cv-nt-', ''));
    nodeData.set(String(nid), data);
    renderNodeBody(String(nid));
  }
  importing = false;
  // 状态环保留(直到下次运行前清除)
}

function bindToolbar() {
  buildAddMenu();
  bindTemplateMenu();
  $('btn-cv-run').onclick = runCanvas; // 整图运行(v0.12.0)
  $('btn-cv-add').onclick = (e) => {
    e.stopPropagation();
    $('cv-add-menu').classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cv-add-wrap')) {
      $('cv-add-menu').classList.add('hidden');
      $('cv-tpl-menu').classList.add('hidden');
    }
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
  // 双击画布空白 → 搜索框快速加节点(ComfyUI litegraph 惯例)
  $('drawflow').addEventListener('dblclick', (e) => {
    if (e.target.closest('.drawflow-node') || e.target.closest('.cv-add-menu') || e.target.closest('.cv-search')) return;
    if (!cvId) return;
    openSearchMenu(e.clientX, e.clientY);
  });
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
      const view = Math.min(Math.max(0, d.view || 0), (d.tasks || []).length - 1);
      const task = (d.tasks || [])[view];
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
      d.view = Math.min(versionsOf(d).length - 1, (d.view || 0) + 1);
      renderNodeBody(id);
      scheduleSave();
    } else if (act === 'adopt') {
      d.active = d.view || 0;
      renderNodeBody(id);
      // 采用版本变更:下游 prompt 槽的只读展示同步刷新(文本生成采用版即下游提示词)
      if (d.type === 'llmtext') applyLinkedPromptsFromText(id);
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
  api.on('canvas:job-status', onJobStatus); // 整图运行状态流(v0.12.0)
}
