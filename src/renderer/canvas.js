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
const comfyCatalogs = new Map(); // connectionId → normalized object_info catalog (由主进程脱敏/清洗)
let saveTimer = null;
let importing = false;      // import 期间不触发保存
let addSeq = 0;             // 新节点错位摆放
let selectedNodeId = null;
let inspectorTab = 'params';
let catalogMode = 'nodes';
const favoriteNodes = new Set();

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

function catalogEntries() {
  return [...comfyCatalogs.entries()].flatMap(([connectionId, source]) => source.catalog.map((node) => ({ connectionId, source, node })));
}

function renderCatalogBrowser(query = '') {
  const box = $('cv-node-categories');
  if (!box) return;
  const q = query.trim().toLowerCase();
  const entries = catalogEntries().filter(({ node }) => (catalogMode !== 'favorites' || favoriteNodes.has(node.classType)) && (!q || `${node.displayName} ${node.classType} ${node.category}`.toLowerCase().includes(q)));
  const groups = new Map();
  for (const entry of entries) { const list = groups.get(entry.node.category) || []; list.push(entry); groups.set(entry.node.category, list); }
  if (!entries.length) { box.innerHTML = '<div class="cv-catalog-empty">未找到节点。请启用高级 ComfyUI 模式并刷新节点目录。</div>'; return; }
  box.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, list]) => `<details class="cv-cat" ${q ? 'open' : ''}><summary>${escapeHtml(category)} · ${list.length}</summary><div class="cv-cat-list">${list.map(({ connectionId, node }) => `<button class="cv-cat-node" data-comfy-connection="${escapeHtml(connectionId)}" data-comfy-class="${escapeHtml(node.classType)}" title="${escapeHtml(node.classType)}">${escapeHtml(node.displayName)}</button>`).join('')}</div></details>`).join('');
  for (const button of box.querySelectorAll('[data-comfy-class]')) button.onclick = () => { if (cvId) addExternalNodeAt(button.dataset.comfyConnection, button.dataset.comfyClass); };
}

function renderInspector() {
  const title = $('cv-inspector-title');
  const body = $('cv-inspector-body');
  if (!title || !body) return;
  const d = selectedNodeId && nodeData.get(String(selectedNodeId));
  if (!d) { title.textContent = '工作流概览'; body.innerHTML = '<div class="cv-catalog-empty">选择一个节点以查看参数、信息和设置。</div>'; return; }
  title.textContent = d.comfyDisplayName || NODE_TYPES[d.type]?.label || d.comfyClassType || '节点';
  if (inspectorTab === 'info') { body.innerHTML = `<div class="cv-inspector-row"><span>类型</span><code>${escapeHtml(d.comfyClassType || d.type || '')}</code></div><div class="cv-inspector-row"><span>后端</span><span>${d.type === 'external' ? 'ComfyUI' : 'API Key'}</span></div>`; return; }
  if (inspectorTab === 'settings') {
    const status = d.nodeStatus || 'normal';
    const isExternal = d.type === 'external';
    body.innerHTML = `<div class="cv-inspector-row"><span>节点状态</span><div class="cv-inspector-status"><button data-cv-status="normal" class="${status === 'normal' ? 'active' : ''}">正常</button><button data-cv-status="bypass" class="${status === 'bypass' ? 'active' : ''}">忽略</button><button data-cv-status="disabled" class="${status === 'disabled' ? 'active' : ''}">禁用</button></div></div><div class="cv-inspector-row"><span>节点颜色</span><input data-cv-color type="color" value="${escapeHtml(d.nodeColor || '#585858')}" /></div>${isExternal ? `<button class="btn btn-sm" data-cv-favorite>${favoriteNodes.has(d.comfyClassType) ? '★ 取消收藏节点' : '☆ 收藏节点'}</button>` : ''}`;
    return;
  }
  const values = d.type === 'external' ? (d.comfyInputs || {}) : d;
  body.innerHTML = Object.entries(values).filter(([key]) => !['type', 'tasks', 'results', 'active', 'view', 'file', 'models', 'comfyInputs', 'comfyWidgets', 'comfyInputTypes'].includes(key)).map(([key, value]) => `<label class="cv-inspector-row"><span>${escapeHtml(key)}</span>${typeof value === 'boolean' ? `<input data-cv-param="${escapeHtml(key)}" type="checkbox" ${value ? 'checked' : ''} />` : `<textarea data-cv-param="${escapeHtml(key)}" rows="${typeof value === 'string' && value.length > 80 ? 4 : 1}">${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value ?? '')}</textarea>`}</label>`).join('') || '<div class="cv-catalog-empty">此节点没有可编辑的本地参数。</div>';
}

function bindInspector() {
  for (const btn of document.querySelectorAll('[data-cv-inspector-tab]')) btn.onclick = () => { inspectorTab = btn.dataset.cvInspectorTab; for (const b of document.querySelectorAll('[data-cv-inspector-tab]')) b.classList.toggle('active', b === btn); renderInspector(); };
  $('cv-inspector-body').addEventListener('click', (e) => {
    if (!e.target.closest('[data-cv-favorite]') || !selectedNodeId) return;
    const d = nodeData.get(String(selectedNodeId)); if (!d?.comfyClassType) return;
    if (favoriteNodes.has(d.comfyClassType)) favoriteNodes.delete(d.comfyClassType); else favoriteNodes.add(d.comfyClassType);
    renderInspector(); renderCatalogBrowser($('cv-node-search').value);
  });
  $('cv-inspector-body').addEventListener('change', (e) => {
    const d = selectedNodeId && nodeData.get(String(selectedNodeId)); if (!d) return;
    if (e.target.dataset.cvStatus) { d.nodeStatus = e.target.dataset.cvStatus; const el = document.querySelector(`#node-${selectedNodeId}`); if (el) el.classList.toggle('cv-node-disabled', d.nodeStatus === 'disabled'); renderInspector(); scheduleSave(); return; }
    if (e.target.dataset.cvColor) { d.nodeColor = e.target.value; const el = document.querySelector(`#node-${selectedNodeId} .cv-head`); if (el) el.style.borderLeft = `5px solid ${d.nodeColor}`; scheduleSave(); return; }
    const key = e.target.dataset.cvParam; if (!key) return;
    const target = d.type === 'external' ? (d.comfyInputs ||= {}) : d;
    target[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    renderNodeBody(selectedNodeId); scheduleSave();
  });
}

function applyComfyAdvancedVisibility() {
  const tools = $('cv-comfy-tools');
  if (tools) tools.classList.toggle('hidden', !state.comfyAdvancedMode);
}

async function loadComfyCatalogs(force = false) {
  if (comfyCatalogs.size && !force) return;
  comfyCatalogs.clear();
  // 本机 ComfyUI 是原生节点浏览器的数据源，不依赖“外部高级连接”开关。
  const local = await api.comfyLocalCatalog();
  if (local && local.ok) comfyCatalogs.set('comfy_local', { connection: { id: 'comfy_local', name: '本机 ComfyUI', enabled: true }, catalog: local.catalog || [] });
  if (!state.comfyAdvancedMode) return;
  const connections = await api.comfyListConnections();
  for (const connection of connections || []) {
    if (connection.enabled === false) continue;
    const result = await api.comfyCatalog(connection.id, { refresh: false });
    if (result && result.ok) comfyCatalogs.set(connection.id, { connection, catalog: result.catalog || [] });
  }
}

function externalDefaults(schema) {
  const values = {};
  for (const input of schema.inputs || []) {
    if (input.widget && Object.prototype.hasOwnProperty.call(input.widget, 'default')) values[input.name] = input.widget.default;
    else if (input.widget && input.widget.kind === 'enum' && input.widget.values && input.widget.values.length) values[input.name] = input.widget.values[0];
  }
  return values;
}

function externalEntry(connectionId, classType) {
  const source = comfyCatalogs.get(connectionId);
  const schema = source && source.catalog.find((node) => node.classType === classType);
  return { source, schema };
}

// ---------------------------------------------------------------------------
// 节点外壳与内容渲染(内容全量重建;输入事件不重建以保光标)
// ---------------------------------------------------------------------------
function comfyCategoryClass(category = '') {
  const root = String(category).split('/')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `cv-cat-${root || 'other'}`;
}

function nodeShellHtml(type, d = {}) {
  const t = NODE_TYPES[type];
  if (type === 'external') {
    const label = escapeHtml(d.title || d.comfyDisplayName || d.comfyClassType || 'ComfyUI 节点');
    const category = comfyCategoryClass(d.comfyCategory);
    return `<div class="cv-shell cv-external"><div class="cv-head nt-external ${category}"><span>☁</span><span class="cv-title">${label}</span><button class="cv-del" title="删除节点">✕</button></div><div class="cv-body"></div></div>`;
  }
  const safe = t || { ico: '❔', label: '未知节点' };
  return `<div class="cv-shell"><div class="cv-head nt-${escapeHtml(type)}"><span>${safe.ico}</span><span class="cv-title">${escapeHtml(safe.label)}</span><button class="cv-del" title="删除节点">✕</button></div><div class="cv-body"></div></div>`;
}

function renderNodeShell(id, d) {
  const host = document.querySelector(`#node-${id} .drawflow_content_node`);
  if (host) host.innerHTML = nodeShellHtml(d.type, d);
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

function renderMinimap() {
  const map = $('cv-minimap');
  if (!map || !editor) return;
  const nodes = Object.values(editor.drawflow.drawflow.Home.data || {});
  if (!nodes.length) { map.innerHTML = ''; return; }
  const minX = Math.min(...nodes.map(n => n.pos_x || 0)); const minY = Math.min(...nodes.map(n => n.pos_y || 0));
  const maxX = Math.max(...nodes.map(n => (n.pos_x || 0) + 320)); const maxY = Math.max(...nodes.map(n => (n.pos_y || 0) + 180));
  const scale = Math.min(140 / Math.max(1, maxX - minX), 86 / Math.max(1, maxY - minY));
  map.innerHTML = nodes.map((node) => { const d = nodeData.get(String(node.id)) || {}; return `<i class="cv-minimap-node ${d.type === 'external' ? 'external' : ''}" style="left:${5 + ((node.pos_x || 0) - minX) * scale}px;top:${5 + ((node.pos_y || 0) - minY) * scale}px;width:${Math.max(5, 260 * scale)}px;height:${Math.max(4, 70 * scale)}px"></i>`; }).join('');
}

function dynamicWidgetsHtml(d) {
  const specs = d.comfyDynamicWidgets || [];
  if (!specs.length) return '';
  return specs.map((spec, index) => `<div class="cv-dynamic"><label>${escapeHtml(spec.label || `输入 ${index + 1}`)}<button data-act="dynamic-remove" data-dyn="${index}" title="移除">−</button></label><input data-comfy-dynamic="${index}" value="${escapeHtml(d.comfyDynamicValues?.[index] || '')}" /></div>`).join('') + `<button class="btn btn-sm" data-act="dynamic-add">＋ 添加输入</button>`;
}

function externalBodyHtml(d) {
  const inputs = d.comfyInputs || {};
  const names = d.slotNames || Object.keys(inputs);
  const widgetSchema = d.comfyWidgets || {};
  const widgets = names.filter((name) => !Array.isArray(inputs[name])).map((name) => {
    const value = inputs[name];
    const schema = widgetSchema[name] || {};
    const title = schema.tooltip ? ` title="${escapeHtml(schema.tooltip)}"` : '';
    if ((schema.kind === 'enum' || schema.kind === 'combo' || schema.kind === 'dynamic') && Array.isArray(schema.values)) {
      if (!schema.values.length) return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <span class="cv-ref-src">当前本机没有可用选项</span></label>`;
      if (schema.multiselect) return `<fieldset class="cv-combo-multi"${title}><legend>${escapeHtml(name)}</legend>${schema.values.map((v) => `<label><input data-comfy-input="${escapeHtml(name)}" type="checkbox" value="${escapeHtml(v)}" ${(Array.isArray(value) ? value : [value]).map(String).includes(String(v)) ? 'checked' : ''} />${escapeHtml(v)}</label>`).join('')}</fieldset>`;
      return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <select data-comfy-input="${escapeHtml(name)}">${schema.values.map((v) => `<option value="${escapeHtml(v)}" ${String(v) === String(value) ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select></label>`;
    }
    if (schema.kind === 'autogrow') return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <input data-comfy-input="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}" /><span class="cv-ref-src">可增长输入组，范围 ${schema.min || 0}–${schema.max || 32}</span></label>`;
    if (typeof value === 'boolean') return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <input data-comfy-input="${escapeHtml(name)}" type="checkbox" ${value ? 'checked' : ''} /></label>`;
    if (typeof value === 'number') return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <input data-comfy-input="${escapeHtml(name)}" type="number" min="${schema.min ?? ''}" max="${schema.max ?? ''}" step="${schema.step ?? 'any'}" value="${escapeHtml(value)}" /></label>`;
    if (schema.multiline) return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <textarea data-comfy-input="${escapeHtml(name)}" rows="4">${escapeHtml(value ?? '')}</textarea></label>`;
    return `<label class="cv-ext-field"${title}>${escapeHtml(name)} <input data-comfy-input="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}" /></label>`;
  });
  return `<div class="cv-ref-src">ComfyUI · ${escapeHtml(d.comfyConnectionName || d.comfyConnectionId || '')}</div>${widgets.join('')}${dynamicWidgetsHtml(d) || ''}${!widgets.length && !d.comfyDynamicWidgets?.length ? '<div class="cv-ref-src">连接端口由连线提供</div>' : ''}${galleryHtml(d)}`;
}

function bodyHtml(id, d) {
  const t = NODE_TYPES[d.type];
  if (d.type === 'external') return externalBodyHtml(d);
  if (!t) return '<div class="cv-status st-fail">未知节点，无法编辑</div>';
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
      renderNodeShell(String(nid), data);
      renderNodeBody(String(nid));
    }
    renderMinimap();
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
  await loadComfyCatalogs();
  applyComfyAdvancedVisibility();
  buildAddMenu();
  renderCatalogBrowser();
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
  renderMinimap();
  scheduleSave();
  return id;
}

function addExternalNodeAt(connectionId, classType) {
  const { source, schema } = externalEntry(connectionId, classType);
  if (!source || !schema) { alert('ComfyUI 节点目录已过期，请在连接设置中刷新。'); return null; }
  const i = addSeq++;
  const outCount = Math.max(1, (schema.outputs || []).length);
  const id = String(editor.addNode('cv-external', (schema.inputs || []).length, outCount, 120 + (i % 6) * 40, 80 + (i % 5) * 40, 'cv-nt-external', {}, nodeShellHtml('external', { comfyDisplayName: schema.displayName, comfyCategory: schema.category }), false));
  const data = {
    type: 'external', comfyConnectionId: connectionId, comfyConnectionName: source.connection.name,
    comfyClassType: classType, comfyDisplayName: schema.displayName, comfyCategory: schema.category, comfyOutputs: schema.outputs || [],
    comfyInputs: externalDefaults(schema),
    comfyWidgets: Object.fromEntries((schema.inputs || []).map((input) => [input.name, input.widget || {}])),
    comfyInputTypes: Object.fromEntries((schema.inputs || []).map((input) => [input.name, input.type])),
    slotNames: (schema.inputs || []).map((input) => input.name), tasks: [], active: -1, view: 0,
  };
  nodeData.set(id, data);
  renderNodeBody(id);
  renderMinimap();
  scheduleSave();
  return id;
}

const undoStack = [];
const redoStack = [];
let historyTimer = null;
function snapshotCanvas() {
  if (!editor || importing) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    const graph = editor.export();
    const nodes = graph?.drawflow?.Home?.data;
    if (nodes) for (const [id, node] of Object.entries(nodes)) node.data = structuredClone(nodeData.get(String(id)) || {});
    undoStack.push(graph); if (undoStack.length > 30) undoStack.shift(); redoStack.length = 0;
  }, 150);
}
function restoreSnapshot(graph) {
  if (!graph || !editor) return;
  importing = true; editor.clear(); nodeData.clear(); editor.import(graph);
  for (const [id, node] of Object.entries(graph.drawflow.Home.data || {})) { nodeData.set(String(id), node.data || {}); renderNodeShell(id, node.data || {}); renderNodeBody(id); }
  importing = false; scheduleSave();
}
function undoCanvas() { if (!undoStack.length) return; const current = editor.export(); redoStack.push(current); restoreSnapshot(undoStack.pop()); }
function redoCanvas() { if (!redoStack.length) return; const current = editor.export(); undoStack.push(current); restoreSnapshot(redoStack.pop()); }

function bootEditor() {
  editor = new Drawflow($('drawflow'));
  editor.start();

  editor.on('nodeSelected', (id) => { selectedNodeId = String(id); renderInspector(); });
  editor.on('nodeRemoved', (id) => { snapshotCanvas(); nodeData.delete(String(id)); if (String(id) === selectedNodeId) { selectedNodeId = null; renderInspector(); } scheduleSave(); });
  editor.on('nodeMoved', () => { snapshotCanvas(); renderMinimap(); scheduleSave(); });
  editor.on('connectionCreated', (info) => {
    const src = nodeData.get(String(info.output_id)) || {};
    const dst = nodeData.get(String(info.input_id)) || {};
    const srcType = src.type;
    const dstType = dst.type;
    const slot = Number(String(info.input_class).replace('input_', '')) - 1;
    const externalPair = srcType === 'external' && dstType === 'external' && src.comfyConnectionId && src.comfyConnectionId === dst.comfyConnectionId;
    const accept = dstType && NODE_TYPES[dstType] ? NODE_TYPES[dstType].inTypes[slot] : null;
    const offer = srcType && NODE_TYPES[srcType] ? NODE_TYPES[srcType].outType : null;
    if (!externalPair && (!accept || accept !== offer)) {
      // 外部张量只允许在同一 ComfyUI 连接内连线；原生节点仍按既有类型槽校验。
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
  const native = Object.entries(NODE_TYPES).map(([k, t]) => `<button data-nt="${k}">${t.ico} ${t.label}</button>`).join('');
  const external = [...comfyCatalogs.entries()].flatMap(([connectionId, source]) => source.catalog.slice(0, 120).map((node) =>
    `<button data-comfy-connection="${escapeHtml(connectionId)}" data-comfy-class="${escapeHtml(node.classType)}">☁ ${escapeHtml(source.connection.name)} · ${escapeHtml(node.displayName)}</button>`)).join('');
  menu.innerHTML = native + (external ? '<div class="ctx-sep"></div>' + external : '');
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

const terminalJob = (status) => ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status);
function jobLine(job, backend) {
  const status = job.status || 'queued';
  const title = backend === 'comfy' ? `ComfyUI · ${job.promptId || job.jobId}` : `API Key · ${job.jobId}`;
  const when = new Date(job.createdAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const cancel = !terminalJob(status) ? `<button class="btn btn-sm" data-job-cancel="${escapeHtml(job.jobId)}" data-job-backend="${backend}">取消</button>` : '';
  const outputs = Array.isArray(job.files) && job.files.length ? ` · ${job.files.length} 个产物` : '';
  return `<div class="cv-queue-item"><div><div>${escapeHtml(title)} <span class="cv-queue-status ${escapeHtml(status)}">${escapeHtml(status)}</span></div><div class="cv-queue-meta">${when}${escapeHtml(outputs)}${job.error ? ` · ${escapeHtml(job.error)}` : ''}</div></div>${cancel}</div>`;
}

async function renderQueue() {
  const panel = $('cv-queue-panel');
  if (!panel || !cvId) return;
  const [nativeJobs, comfyJobs] = await Promise.all([api.canvasJobList(cvId), api.comfyJobs(cvId)]);
  const rows = [
    ...(Array.isArray(nativeJobs) ? nativeJobs : []).map((job) => ({ job, backend: 'native' })),
    ...(Array.isArray(comfyJobs) ? comfyJobs : []).map((job) => ({ job, backend: 'comfy' })),
  ].sort((a, b) => (b.job.createdAt || 0) - (a.job.createdAt || 0));
  panel.innerHTML = `<div class="cv-queue-head"><span>运行队列 / 历史</span><button class="icon-btn" data-job-refresh title="刷新">⟳</button></div>` +
    (rows.length ? rows.map(({ job, backend }) => jobLine(job, backend)).join('') : '<div class="cv-queue-empty">当前画布还没有运行记录</div>');
}

async function toggleQueue() {
  const panel = $('cv-queue-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await renderQueue();
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
  if (terminalJob(p.status)) {
    setRunBtn(false);
    currentJobId = null;
    if (!$('cv-queue-panel').classList.contains('hidden')) renderQueue();
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
    renderNodeShell(String(nid), data);
    renderNodeBody(String(nid));
  }
  renderMinimap();
  importing = false;
  // 状态环保留(直到下次运行前清除)
}

function bindToolbar() {
  buildAddMenu();
  bindTemplateMenu();
  $('btn-cv-run').onclick = runCanvas; // 整图运行(v0.12.0)
  $('btn-cv-comfy').onclick = () => window.dispatchEvent(new Event('drafter:open-comfy'));
  $('btn-cv-comfy-import').onclick = async () => {
    const connections = await api.comfyListConnections();
    const result = await api.comfyImportFile(connections.length === 1 ? connections[0].id : null);
    if (result && result.ok) {
      await openCanvas(result.canvas.id);
      $('canvas-save-hint').textContent = `已导入 ComfyUI ${result.format === 'workflow' ? 'workflow' : 'prompt'}。`;
    } else if (result && result.error && !result.canceled) alert(result.error);
  };
  $('btn-cv-queue').onclick = toggleQueue;
  $('cv-queue-panel').onclick = async (e) => {
    if (e.target.closest('[data-job-refresh]')) { await renderQueue(); return; }
    const btn = e.target.closest('[data-job-cancel]');
    if (!btn) return;
    const ok = btn.dataset.jobBackend === 'comfy'
      ? await api.comfyCancel(btn.dataset.jobCancel)
      : await api.canvasJobCancel(btn.dataset.jobCancel);
    if (!ok) alert('任务已结束或取消失败');
    await renderQueue();
  };
  $('btn-cv-add').onclick = (e) => {
    e.stopPropagation();
    $('cv-add-menu').classList.toggle('hidden');
  };
  $('cv-node-search').oninput = (e) => renderCatalogBrowser(e.target.value);
  for (const button of document.querySelectorAll('[data-cv-browser]')) button.onclick = () => { catalogMode = button.dataset.cvBrowser; for (const b of document.querySelectorAll('[data-cv-browser]')) b.classList.toggle('active', b === button); renderCatalogBrowser($('cv-node-search').value); };
  $('btn-cv-catalog-refresh').onclick = async () => { await loadComfyCatalogs(true); renderCatalogBrowser($('cv-node-search').value); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cv-add-wrap')) {
      $('cv-add-menu').classList.add('hidden');
      $('cv-tpl-menu').classList.add('hidden');
    }
  });
  $('cv-add-menu').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || !cvId) { if (!cvId) $('cv-add-menu').classList.add('hidden'); return; }
    if (b.dataset.comfyConnection && b.dataset.comfyClass) addExternalNodeAt(b.dataset.comfyConnection, b.dataset.comfyClass);
    else if (b.dataset.nt) { await loadModelOptions(); addNodeAt(b.dataset.nt); }
    else return;
    $('cv-add-menu').classList.add('hidden');
  };
  $('cv-add-menu').addEventListener('contextmenu', (e) => e.preventDefault());
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

  host.addEventListener('contextmenu', (e) => {
    const id = nodeIdOf(e.target);
    if (!id || !nodeData.has(id)) return;
    e.preventDefault(); selectedNodeId = id; renderInspector();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '复制节点', onClick: () => { window.__cvClipboard = structuredClone(nodeData.get(id)); } },
      { label: '重复节点', onClick: () => { const d = structuredClone(nodeData.get(id)); const n = editor.getNodeFromId(id); const newId = String(editor.addNode('cv-' + d.type, n.inputs ? Object.keys(n.inputs).length : 0, n.outputs ? Object.keys(n.outputs).length : 1, (n.pos_x || 120) + 36, (n.pos_y || 80) + 36, 'cv-nt-' + d.type, {}, nodeShellHtml(d.type, d), false)); nodeData.set(newId, d); renderNodeBody(newId); snapshotCanvas(); scheduleSave(); } },
      { label: '删除节点', danger: true, onClick: () => editor.removeNodeId(id) },
    ]);
  });

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
    } else if (act === 'combo-refresh') {
      const schema = d.comfyWidgets && d.comfyWidgets[actBtn.dataset.combo];
      if (schema && schema.remote && schema.remote.route) {
        const r = await api.comfyComboOptions(d.comfyConnectionId, schema.remote.route);
        if (r && r.ok) { schema.values = r.values || []; renderNodeBody(id); }
      }
    } else if (act === 'dynamic-add') {
      d.comfyDynamicValues = d.comfyDynamicValues || [];
      d.comfyDynamicValues.push('');
      renderNodeBody(id); scheduleSave();
    } else if (act === 'dynamic-remove') {
      d.comfyDynamicValues = d.comfyDynamicValues || [];
      d.comfyDynamicValues.splice(Number(actBtn.dataset.dyn), 1);
      renderNodeBody(id); scheduleSave();
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
    } else if (d.type === 'external' && e.target.matches('[data-comfy-input]')) {
      const key = e.target.dataset.comfyInput;
      if (!d.comfyInputs) d.comfyInputs = {};
      d.comfyInputs[key] = e.target.type === 'checkbox' ? e.target.checked : (e.target.type === 'number' ? Number(e.target.value) : e.target.value);
      scheduleSave();
    } else if (d.type === 'external' && e.target.matches('[data-comfy-dynamic]')) {
      d.comfyDynamicValues = d.comfyDynamicValues || [];
      d.comfyDynamicValues[Number(e.target.dataset.comfyDynamic)] = e.target.value;
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
  document.addEventListener('keydown', (e) => {
    if (!state.section || state.section !== 'canvas' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redoCanvas(); else undoCanvas(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redoCanvas(); }
    if (e.key === 'Delete' && selectedNodeId) { editor.removeNodeId(selectedNodeId); }
  });
  bindInspector();
  window.addEventListener('drafter:comfy-advanced-changed', async () => {
    applyComfyAdvancedVisibility();
    await loadComfyCatalogs(true);
    buildAddMenu();
    renderCatalogBrowser($('cv-node-search') && $('cv-node-search').value);
  });
  api.on('aigc:exec-status', onExecStatus);
  api.on('canvas:job-status', onJobStatus); // 整图运行状态流(v0.12.0)
}
