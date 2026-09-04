// 画布板块·原生引擎集成层(v0.13.0,md《ComfyUI画布架构解析.md》重构):
// Drawflow(DOM/SVG)→ 自研三层架构:graph/model(图模型)+ viewport(视口控制器)
// + render(Canvas 2D 双通道渲染)+ interact(指针状态机)+ history(双轨撤销)。
// 本文件只做「接线」:DOM 外壳(工具栏/目录/inspector/tabs/队列)↔ 引擎 ↔ IPC。
// 持久化直发 ComfyUI API 格式(canvases.save 原生支持),分组/视口走 `_` 保留键。
import { api, state, $, escapeHtml, ensureGroups, modelLabel, showCtxMenu } from './state.js';
import { openViewer } from './msgmenu.js';
import {
  createModel, loadApi, toApi, fromApi, addNativeNode, addExternalNode, addGroup, removeNode,
  computeSize, connect, disconnect, isLink, LAYOUT,
} from './graph/model.js';
import { createViewport, toWorld, zoomAt } from './graph/viewport.js';
import { createRenderer, TYPE_COLORS } from './graph/render.js';
import { attach } from './graph/interact.js';
import { createHistory } from './graph/history.js';
import { extractWorkflowMeta, isPng } from './graph/pngmeta.js';
import { i18n } from './graph/i18n.js';

const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
const AIGC_TERMINAL = new Set(['done', 'fail', 'timeout', 'interrupted']);
const STATUS_TEXT = {
  pending: '排队中', processing: '生成中', transferring: '转存中', downloading: '下载中',
  done: '完成', fail: '失败', timeout: '超时', interrupted: '已取消',
};

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------
let registry = null;        // 主进程 NODE_TYPES 单一下发
let model = null;
let viewport = null;
let renderer = null;
let interactor = null;
let history = null;
let cvId = null;
let cvName = '';
const openTabIds = [];
let modelOptions = null;    // { image:[{val,label,keyName}], ... } fan-out 多选数据源
const comfyCatalogs = new Map(); // connectionId → { connection, catalog }
const favoriteNodes = new Set();
let catalogMode = 'nodes';
let inspectorTab = 'params';
let importing = false;
let saveTimer = null;
let addSeq = 0;
let currentJobId = null;
let booted = false;

// ---------------------------------------------------------------------------
// 引擎装配
// ---------------------------------------------------------------------------
async function boot() {
  if (booted) return;
  booted = true;
  registry = await api.canvasRegistry();
  const host = $('drawflow');
  host.innerHTML = '';
  // 鹰眼图:div 换 canvas(交互层绑双向漫游)
  const miniBox = $('cv-minimap');
  miniBox.innerHTML = '';
  const miniCanvas = document.createElement('canvas');
  miniCanvas.style.width = '100%';
  miniCanvas.style.height = '100%';
  miniBox.appendChild(miniCanvas);

  model = createModel(registry || {});
  viewport = createViewport();
  renderer = createRenderer(host, model, viewport, { minimapCanvas: miniCanvas });
  history = createHistory({
    limit: 30,
    capture: () => JSON.stringify(serializeAll()),
    restore: (json) => {
      importing = true;
      deserializeAll(JSON.parse(json));
      importing = false;
      refreshPreviews();
      renderInspector();
      renderer.invalidate('all');
      scheduleSave();
    },
  });
  interactor = attach(host, model, viewport, renderer, {    minimapCanvas: miniCanvas,
    getGridStep: () => 0,
    onSelectionChange: () => { renderInspector(); updateNodeToolbar(); },
    onChange: () => scheduleSave(),
    beforeTopologyChange: () => history.commitSnapshot(),
    breakHistoryMerge: () => history.breakMerge(),
    onDelta: (cmd) => history.commitDelta({
      key: cmd.key,
      revert: () => { cmd.revert(); renderInspector(); scheduleSave(); },
      apply: () => { cmd.apply(); renderInspector(); scheduleSave(); },
    }),
    onWidgetEdit: openWidgetEditor,
    onCanvasDoubleClick: (wp, evt) => openSearchMenu(wp),
    onLinkClick: (link, evt) => showCtxMenu(evt.clientX, evt.clientY, [
      { label: '➕ 在此连线上加节点', onClick: () => openSearchMenu(null, evt.clientX, evt.clientY) },
      { label: '✂ 删除连线', danger: true, onClick: () => { history.commitSnapshot(); disconnect(model, link.id); afterModelChange(); } },
    ]),
    onContextMenu: onCanvasContextMenu,
  });
  renderer.start();
  bindChrome();
  // 诊断/冒烟钩子(对齐旧引擎 window.__cvEditor 惯例)
  window.__cv2 = {
    model, viewport, renderer, history,
    addNodeAt, addExternalAt, serializeAll, openCanvas, runCanvas,
    toWorld: (p) => toWorld(viewport, p),
    toScreen: (p) => ({ x: p.x * viewport.scale + viewport.tx, y: p.y * viewport.scale + viewport.ty }),
    currentId: () => cvId,
  };
}

// 模型变更后的统一收尾(重绘 + 小地图 + 保存)
function afterModelChange() {
  renderer.invalidate('all');
  scheduleSave();
}

// ---------------------------------------------------------------------------
// 序列化:模型 + 分组 + 视口 ↔ 画布 JSON(`_` 保留键,主进程校验/拓扑跳过)
// ---------------------------------------------------------------------------
function serializeAll() {
  const graph = toApi(model);
  if (model.groups.size) {
    graph._groups = [...model.groups.values()].map((g) => ({ id: g.id, title: g.title, color: g.color, rect: g.rect }));
  }
  graph._viewport = { tx: Math.round(viewport.tx), ty: Math.round(viewport.ty), scale: viewport.scale };
  return graph;
}

function deserializeAll(graph) {
  loadApi(model, graph || {});
  model.groups.clear();
  if (Array.isArray(graph && graph._groups)) {
    let maxG = 0;
    for (const g of graph._groups) {
      model.groups.set(String(g.id), { id: String(g.id), title: g.title || '', color: g.color || '', rect: g.rect });
      maxG = Math.max(maxG, Number(g.id) || 0);
    }
    model.nextGroupId = maxG + 1;
  }
  const vp = graph && graph._viewport;
  if (vp && typeof vp.scale === 'number') {
    viewport.tx = vp.tx || 0;
    viewport.ty = vp.ty || 0;
    viewport.scale = Math.max(viewport.minScale, Math.min(viewport.maxScale, vp.scale));
  } else {
    viewport.tx = 40; viewport.ty = 40; viewport.scale = 1;
  }
}

// ---------------------------------------------------------------------------
// 持久化(防抖自动保存;API 格式直发,canvases.save 原生接受)
// ---------------------------------------------------------------------------
function scheduleSave() {
  if (importing || !cvId) return;
  $('canvas-save-hint').textContent = '…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  if (!cvId) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const r = await api.canvasSave(cvId, { graph: serializeAll() });
  $('canvas-save-hint').textContent = (r && r.error)
    ? '保存失败:' + r.error
    : '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function flushSave() {
  if (saveTimer) await saveNow();
}

// ---------------------------------------------------------------------------
// 画布打开/新建/重命名/删除 + 标签页
// ---------------------------------------------------------------------------
async function openCanvas(id) {
  await flushSave();
  let cv = await api.canvasLoad(id);
  if (!cv) return;
  // 存量 drawflow 形 JSON:经主进程归一为 API 格式后重读(一次性迁移)
  if (cv.graph && cv.graph.drawflow) {
    await api.canvasSave(id, { graph: cv.graph });
    cv = await api.canvasLoad(id);
  }
  importing = true;
  cvId = cv.id;
  cvName = cv.name;
  history.clear();
  renderer.selection.clear();
  renderer.execState.clear();
  renderer.errors.clear();
  deserializeAll(cv.graph || {});
  importing = false;
  refreshPreviews();
  renderInspector();
  renderer.invalidate('all');
  $('canvas-empty').classList.add('hidden');
  $('canvas-save-hint').textContent = '已打开「' + cv.name + '」';
  await renderList();
  renderTabs();
}

export async function createFromSidebar() {
  await boot();
  const cv = await api.canvasCreate();
  await openCanvas(cv.id);
  renderTabs();
  return cv;
}

async function renderTabs() {
  const bar = $('cv-tabs');
  if (!bar) return;
  const list = await api.canvasList();
  const byId = new Map(list.map((cv) => [cv.id, cv]));
  for (const id of [cvId, ...openTabIds]) if (id && !openTabIds.includes(id)) openTabIds.push(id);
  const tabs = openTabIds.filter((id) => byId.has(id));
  bar.innerHTML = tabs.map((id) => {
    const cv = byId.get(id);
    return `<button class="cv-tab${id === cvId ? ' active' : ''}" data-cv-tab="${id}" title="${escapeHtml(cv.name)}">${escapeHtml(cv.name)}<span class="cv-tab-close" data-cv-tab-close="${id}">×</span></button>`;
  }).join('');
  for (const tab of bar.querySelectorAll('[data-cv-tab]')) tab.onclick = (e) => { if (e.target.closest('[data-cv-tab-close]')) return; openCanvas(tab.dataset.cvTab); };
  for (const x of bar.querySelectorAll('[data-cv-tab-close]')) x.onclick = (e) => {
    e.stopPropagation();
    const id = x.dataset.cvTabClose;
    const idx = openTabIds.indexOf(id);
    if (idx >= 0) openTabIds.splice(idx, 1);
    if (id === cvId) {
      if (openTabIds.length) openCanvas(openTabIds[0]);
      else { cvId = null; cvName = ''; loadApi(model, {}); renderer.invalidate('all'); $('canvas-empty').classList.remove('hidden'); }
    }
    renderTabs();
  };
}

export async function renderList() {
  const list = await api.canvasList();
  const ul = $('session-list');
  ul.innerHTML = '';
  const wrap = document.createElement('li');
  wrap.className = 'proj-group';
  const su = document.createElement('ul');
  for (const cv of list) {
    const li = document.createElement('li');
    li.className = 'session-item' + (cv.id === cvId ? ' active' : '');
    li.innerHTML = `<div class="session-title"><span class="session-kind">🗺</span><span>${escapeHtml(cv.name)}</span></div>`;
    li.onclick = () => openCanvas(cv.id);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '✏️ 重命名', onClick: () => renameCanvas(cv, li) },
        { label: '🗑 删除', danger: true, onClick: () => deleteCanvas(cv) },
      ]);
    };
    su.appendChild(li);
  }
  if (!list.length) su.innerHTML = '<li class="cv-catalog-empty" style="padding:8px 12px">还没有画布</li>';
  wrap.appendChild(su);
  ul.appendChild(wrap);
}

async function renameCanvas(cv, li) {
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
    if (cv.id === cvId) cvName = name || cvName;
    renderList();
    renderTabs();
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
    loadApi(model, {});
    renderer.invalidate('all');
    $('canvas-empty').classList.remove('hidden');
    $('canvas-save-hint').textContent = '';
  }
  await renderList();
  renderTabs();
}

// ---------------------------------------------------------------------------
// 节点添加(目录/菜单/搜索)
// ---------------------------------------------------------------------------
function viewCenterWorld() {
  const { w, h } = renderer.viewSize();
  return toWorld(viewport, { x: w / 2 - 130, y: h / 2 - 60 });
}

function addNodeAt(type, worldPos) {
  if (!cvId) { alert('请先新建或打开一个画布，再添加节点。'); return null; }
  const c = worldPos || viewCenterWorld();
  const i = addSeq++;
  history.commitSnapshot();
  const node = addNativeNode(model, type, { x: c.x + (i % 6) * 30, y: c.y + (i % 5) * 30 });
  renderer.selection.clear();
  renderer.selection.add(node.id);
  renderInspector();
  afterModelChange();
  return node;
}

function addExternalAt(connectionId, classType, worldPos) {
  if (!cvId) { alert('请先新建或打开一个画布，再添加节点。'); return null; }
  const source = comfyCatalogs.get(connectionId);
  const schema = source && source.catalog.find((n) => n.classType === classType);
  if (!source || !schema) { alert('ComfyUI 节点目录已过期，请在连接设置中刷新。'); return null; }
  const c = worldPos || viewCenterWorld();
  const i = addSeq++;
  history.commitSnapshot();
  const node = addExternalNode(model, { connectionId, connectionName: source.connection.name, schema },
    { x: c.x + (worldPos ? 0 : (i % 6) * 30), y: c.y + (worldPos ? 0 : (i % 5) * 30) });
  renderer.selection.clear();
  renderer.selection.add(node.id);
  renderInspector();
  afterModelChange();
  return node;
}

function buildAddMenu() {
  const menu = $('cv-add-menu');
  const native = Object.entries(registry || {}).filter(([, t]) => !t.unsupported).map(([k, t]) => `<button data-nt="${k}">${typeIco(k)} ${typeLabel(k)}</button>`).join('');
  const external = [...comfyCatalogs.entries()].flatMap(([connectionId, source]) => source.catalog.slice(0, 120).map((node) =>
    `<button data-comfy-connection="${escapeHtml(connectionId)}" data-comfy-class="${escapeHtml(node.classType)}">☁ ${escapeHtml(source.connection.name)} · ${escapeHtml(node.displayName)}</button>`)).join('');
  menu.innerHTML = native + (external ? '<div class="ctx-sep"></div>' + external : '');
}

function typeLabel(type) {
  return { text: '文本', llmtext: '文本生成', upload: '参考图', image: '图片生成', video: '视频生成', audio: '音频生成', model3d: '3D 生成' }[type] || type;
}
function typeIco(type) {
  return { text: '📝', llmtext: '✍️', upload: '🖼️', image: '🎨', video: '🎬', audio: '🎵', model3d: '🧊' }[type] || '⬡';
}

// 双击画布空白 → 搜索框快速加节点(ComfyUI 惯例);worldPt 给定则落在该世界坐标
function openSearchMenu(worldPt, clientX, clientY) {
  let box = document.querySelector('.cv-search');
  if (box) box.remove();
  box = document.createElement('div');
  box.className = 'cv-search';
  box.innerHTML = `<input class="input-sm" placeholder="搜索节点…(Enter 添加)" />`;
  const list = document.createElement('div');
  list.className = 'cv-search-list';
  box.appendChild(list);
  const hostRect = $('drawflow').getBoundingClientRect();
  const sx = clientX ?? (worldPt ? worldPt.x * viewport.scale + viewport.tx + hostRect.left : window.innerWidth / 2);
  const sy = clientY ?? (worldPt ? worldPt.y * viewport.scale + viewport.ty + hostRect.top : window.innerHeight / 2);
  box.style.left = Math.min(sx, window.innerWidth - 260) + 'px';
  box.style.top = Math.min(sy, window.innerHeight - 260) + 'px';
  document.body.appendChild(box);
  const input = box.querySelector('input');
  const entries = () => {
    const q = input.value.trim().toLowerCase();
    // 双语命中:英文逻辑键(classType/type)与 i18n 中文标题都可检索
    const native = Object.entries(registry || {}).filter(([, t]) => !t.unsupported)
      .filter(([k]) => !q || typeLabel(k).toLowerCase().includes(q) || k.includes(q) || i18n.tNodeTitle(k, '').toLowerCase().includes(q))
      .map(([k]) => ({ kind: 'native', key: k, label: `${typeIco(k)} ${typeLabel(k)}` }));
    const ext = catalogEntries()
      .filter(({ node }) => !q || `${node.displayName} ${node.classType} ${i18n.tNodeTitle(node.classType, '')}`.toLowerCase().includes(q))
      .slice(0, 30)
      .map(({ connectionId, node }) => ({ kind: 'external', connectionId, key: node.classType, label: `☁ ${i18n.tNodeTitle(node.classType, node.displayName)}` }));
    return [...native, ...ext];
  };
  const render = () => {
    const items = entries();
    list.innerHTML = items.map((it, i) => `<button data-i="${i}">${escapeHtml(it.label)}</button>`).join('');
    list.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { const it = items[Number(b.dataset.i)]; pick(it); };
    });
    return items;
  };
  const pick = (it) => {
    if (!it) return;
    if (it.kind === 'native') addNodeAt(it.key, worldPt);
    else addExternalAt(it.connectionId, it.key, worldPt);
    box.remove();
  };
  input.oninput = () => render();
  input.onkeydown = (e) => {
    if (e.key === 'Escape') box.remove();
    if (e.key === 'Enter') pick(render()[0]);
  };
  render();
  input.focus();
  const closer = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', closer); } };
  document.addEventListener('mousedown', closer);
}

function catalogEntries() {
  return [...comfyCatalogs.entries()].flatMap(([connectionId, source]) => source.catalog.map((node) => ({ connectionId, source, node })));
}

// ---------------------------------------------------------------------------
// 节点目录侧栏(ComfyUI 节点浏览器)+ 左轨
// ---------------------------------------------------------------------------
function renderCatalogBrowser(query = '') {
  const box = $('cv-node-categories');
  if (!box) return;
  const q = query.trim().toLowerCase();
  // 双语命中:displayName / classType / 原始分类路径 / i18n 中文标题与分类
  const entries = catalogEntries().filter(({ node }) => (catalogMode !== 'favorites' || favoriteNodes.has(node.classType))
    && (!q || `${node.displayName} ${node.classType} ${node.category} ${i18n.tNodeTitle(node.classType, '')} ${i18n.tCategory(node.category)}`.toLowerCase().includes(q)));
  if (!entries.length && !Object.keys(registry || {}).length) { box.innerHTML = '<div class="cv-catalog-empty">未找到节点。请启用高级 ComfyUI 模式并刷新节点目录。</div>'; return; }
  // 原生节点常驻一组(ComfyUI 离线时目录不再空转);搜索时同样双语过滤
  const nativeKeys = Object.keys(registry || {}).filter((k) => !registry[k].unsupported
    && (!q || typeLabel(k).toLowerCase().includes(q) || k.includes(q) || i18n.tNodeTitle(k, '').toLowerCase().includes(q)));
  const nativeHtml = nativeKeys.length
    ? `<details class="cv-cat" open><summary>Drafter 原生 · ${nativeKeys.length}</summary><div class="cv-cat-list">${nativeKeys.map((k) => `<button class="cv-cat-node" data-native-type="${k}">${typeIco(k)} ${escapeHtml(typeLabel(k))}</button>`).join('')}</div></details>`
    : '';
  // 两级分组:大类(category「/」前) → 子类(「/」后),避免全路径平铺刷屏
  // 分组键用原始路径(稳定),显示标签走 i18n 翻译
  const roots = new Map(); // root → Map(sub → entries)
  for (const entry of entries) {
    const cat = entry.node.category || '其他';
    const root = cat.split('/')[0] || '其他';
    const sub = cat === root ? '' : cat.slice(root.length + 1);
    if (!roots.has(root)) roots.set(root, new Map());
    const subs = roots.get(root);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push(entry);
  }
  const btnHtml = ({ connectionId, node }) => `<button class="cv-cat-node" data-comfy-connection="${escapeHtml(connectionId)}" data-comfy-class="${escapeHtml(node.classType)}" title="${escapeHtml(node.classType)}">${escapeHtml(i18n.tNodeTitle(node.classType, node.displayName))}</button>`;
  box.innerHTML = [...roots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, subs]) => {
    const total = [...subs.values()].reduce((n, l) => n + l.length, 0);
    const inner = [...subs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sub, list]) =>
      (sub ? `<div class="cv-cat-sub">${escapeHtml(i18n.tCategory(sub))} · ${list.length}</div>` : '') +
      `<div class="cv-cat-list">${list.map(btnHtml).join('')}</div>`).join('');
    return `<details class="cv-cat" ${q ? 'open' : ''}><summary>${escapeHtml(i18n.tCategory(root))} · ${total}</summary>${inner}</details>`;
  }).join('');
  box.innerHTML = nativeHtml + box.innerHTML;
  if (!entries.length) box.innerHTML += '<div class="cv-catalog-empty">本机 ComfyUI 节点目录为空(ComfyUI 未启动或未连接)。上方 Drafter 原生节点可直接使用。</div>';
  for (const button of box.querySelectorAll('[data-native-type]')) button.onclick = () => addNodeAt(button.dataset.nativeType);
  for (const button of box.querySelectorAll('[data-comfy-class]')) button.onclick = () => addExternalAt(button.dataset.comfyConnection, button.dataset.comfyClass);
}

async function loadComfyCatalogs(force = false) {
  if (comfyCatalogs.size && !force) return;
  comfyCatalogs.clear();
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

// ---------------------------------------------------------------------------
// Inspector(参数/信息/设置)
// ---------------------------------------------------------------------------
const HIDDEN_PARAMS = new Set(['type', 'tasks', 'results', 'active', 'view', 'file', 'models', 'comfyInputs', 'comfyWidgets', 'comfyInputTypes', 'nodeStatus', 'nodeColor', 'nodeShape', 'locked', 'comfyDynamicValues', 'slotNames', 'comfyOutputs', 'comfyConnectionId', 'comfyConnectionName', 'comfyClassType', 'comfyDisplayName', 'comfyCategory']);

function selectedNode() {
  const id = [...renderer.selection][0];
  return id ? model.nodes.get(String(id)) : null;
}

function renderInspector() {
  const title = $('cv-inspector-title');
  const body = $('cv-inspector-body');
  if (!title || !body) return;
  const node = selectedNode();
  if (!node) { title.textContent = '工作流概览'; body.innerHTML = '<div class="cv-catalog-empty">选择一个节点以查看参数、信息和设置。</div>'; return; }
  title.textContent = node.title || node.data.comfyDisplayName || typeLabel(node.type) || node.classType;
  if (inspectorTab === 'info') {
    body.innerHTML = `<div class="cv-inspector-row"><span>类型</span><code>${escapeHtml(node.classType)}</code></div><div class="cv-inspector-row"><span>后端</span><span>${node.kind === 'external' ? 'ComfyUI' : 'API Key'}</span></div>`;
    return;
  }
  if (inspectorTab === 'settings') {
    const status = node.data.nodeStatus || 'normal';
    body.innerHTML = `<div class="cv-inspector-row"><span>节点状态</span><div class="cv-inspector-status"><button data-cv-status="normal" class="${status === 'normal' ? 'active' : ''}">正常</button><button data-cv-status="bypass" class="${status === 'bypass' ? 'active' : ''}">忽略</button><button data-cv-status="disabled" class="${status === 'disabled' ? 'active' : ''}">禁用</button></div></div><div class="cv-inspector-row"><span>节点颜色</span><input data-cv-color type="color" value="${escapeHtml(node.color || TYPE_COLORS[node.type] || '#585858')}" /></div>${node.kind === 'external' ? `<button class="btn btn-sm" data-cv-favorite>${favoriteNodes.has(node.data.comfyClassType) ? '★ 取消收藏节点' : '☆ 收藏节点'}</button>` : ''}`;
    return;
  }
  // params:原生节点业务参数 + 外部节点 widget 值
  if (node.kind === 'external') {
    body.innerHTML = node.widgets.map((wd) => `<label class="cv-inspector-row"><span>${escapeHtml(wd.name)}</span>${wd.kind === 'BOOLEAN'
      ? `<input data-cv-widget="${escapeHtml(wd.name)}" type="checkbox" ${wd.value ? 'checked' : ''} />`
      : (wd.options && wd.options.length)
        ? `<select data-cv-widget="${escapeHtml(wd.name)}">${wd.options.map((o) => `<option ${String(o) === String(wd.value) ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`
        : `<textarea data-cv-widget="${escapeHtml(wd.name)}" rows="1">${escapeHtml(wd.value ?? '')}</textarea>`}</label>`).join('') || '<div class="cv-catalog-empty">此节点没有可编辑的本地参数。</div>';
    return;
  }
  const rows = [];
  if (node.type === 'text') rows.push(`<label class="cv-inspector-row"><span>文本</span><textarea data-cv-param="text" rows="4">${escapeHtml(node.data.text || '')}</textarea></label>`);
  else if (node.type === 'upload') rows.push(`<div class="cv-inspector-row"><span>参考图</span><button class="btn btn-sm" data-cv-pick-file>${node.data.file ? escapeHtml(node.data.file.name) : '选择图片…'}</button></div>`);
  else {
    rows.push(`<label class="cv-inspector-row"><span>提示词</span><textarea data-cv-param="prompt" rows="3" ${node.inputs[0] && node.inputs[0].link != null ? 'readonly' : ''}>${escapeHtml(node.data.prompt || '')}</textarea></label>`);
    const opts = (modelOptions && modelOptions[registry[node.type].modelType]) || [];
    rows.push(`<div class="cv-inspector-row"><span>模型(fan-out)</span><div class="cv-inspector-status" style="flex-wrap:wrap">${opts.map((o) => `<button data-cv-model="${escapeHtml(o.val)}" class="${(node.data.models || []).includes(o.val) ? 'active' : ''}" title="${escapeHtml(o.keyName || '')}">${escapeHtml(o.label)}</button>`).join('') || '<span class="cv-catalog-empty">无启用模型</span>'}</div></div>`);
  }
  for (const [key, value] of Object.entries(node.data)) {
    if (HIDDEN_PARAMS.has(key) || key.startsWith('_') || ['text', 'prompt'].includes(key)) continue;
    if (typeof value === 'boolean') rows.push(`<label class="cv-inspector-row"><span>${escapeHtml(key)}</span><input data-cv-param="${escapeHtml(key)}" type="checkbox" ${value ? 'checked' : ''} /></label>`);
  }
  body.innerHTML = rows.join('') || '<div class="cv-catalog-empty">此节点没有可编辑的本地参数。</div>';
}

function bindInspector() {
  for (const btn of document.querySelectorAll('[data-cv-inspector-tab]')) btn.onclick = () => {
    inspectorTab = btn.dataset.cvInspectorTab;
    for (const b of document.querySelectorAll('[data-cv-inspector-tab]')) b.classList.toggle('active', b === btn);
    renderInspector();
  };
  const body = $('cv-inspector-body');
  body.addEventListener('click', async (e) => {
    const node = selectedNode();
    if (!node) return;
    if (e.target.closest('[data-cv-favorite]')) {
      const ct = node.data.comfyClassType;
      if (favoriteNodes.has(ct)) favoriteNodes.delete(ct); else favoriteNodes.add(ct);
      renderInspector(); renderCatalogBrowser($('cv-node-search') && $('cv-node-search').value);
      return;
    }
    if (e.target.closest('[data-cv-pick-file]')) { pickUploadFile(node); return; }
    const mb = e.target.closest('[data-cv-model]');
    if (mb) {
      const val = mb.dataset.cvModel;
      history.commitSnapshot();
      const arr = node.data.models || (node.data.models = []);
      const i = arr.indexOf(val);
      if (i >= 0) arr.splice(i, 1); else arr.push(val);
      renderInspector();
      afterModelChange();
    }
  });
  body.addEventListener('change', (e) => {
    const node = selectedNode();
    if (!node) return;
    const st = e.target.closest('[data-cv-status]');
    if (st) {
      history.commitSnapshot();
      node.data.nodeStatus = st.dataset.cvStatus;
      renderer.invalidate('fg');
      renderInspector();
      afterModelChange();
      return;
    }
    if (e.target.matches('[data-cv-color]')) {
      node.color = e.target.value === (TYPE_COLORS[node.type] || '#585858') ? null : e.target.value;
      renderer.invalidate('fg');
      scheduleSave();
      return;
    }
    const w = e.target.closest('[data-cv-widget]');
    if (w) {
      const wd = node.widgets.find((x) => x.name === w.dataset.cvWidget);
      if (!wd) return;
      history.commitSnapshot();
      wd.value = w.type === 'checkbox' ? w.checked : (wd.kind === 'INT' || wd.kind === 'FLOAT' ? Number(w.value) : w.value);
      if (node.data.comfyInputs) node.data.comfyInputs[wd.name] = wd.value;
      renderer.invalidate('fg');
      afterModelChange();
    }
  });
  body.addEventListener('input', (e) => {
    const node = selectedNode();
    if (!node) return;
    const p = e.target.closest('[data-cv-param]');
    if (p) { node.data[p.dataset.cvParam] = p.type === 'checkbox' ? p.checked : p.value; scheduleSave(); renderer.invalidate('fg'); }
  });
}

// upload 节点选图:base64 → 主进程落画布 assets 目录
function pickUploadFile(node) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const r = await api.canvasSaveUpload(cvId, f.name, b64);
    if (!r || !r.ok) { alert('上传失败:' + ((r && r.error) || '未知错误')); return; }
    history.commitSnapshot();
    node.data.file = { path: r.path, name: r.name };
    renderInspector();
    afterModelChange();
  };
  input.click();
}

// ---------------------------------------------------------------------------
// 悬浮节点工具栏(选中时出现,固定在画布左上)
// ---------------------------------------------------------------------------
function updateNodeToolbar() {
  const bar = $('cv-node-toolbar');
  if (!bar) return;
  bar.classList.toggle('hidden', !renderer.selection.size);
  bar.style.left = '12px';
  bar.style.top = '12px';
  bar.style.position = 'absolute';
}

function bindNodeToolbar() {
  const bar = $('cv-node-toolbar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cvt]');
    if (!btn) return;
    const ids = [...renderer.selection];
    if (!ids.length) return;
    const act = btn.dataset.cvt;
    if (act === 'delete') deleteSelected();
    else if (act === 'bypass') {
      history.commitSnapshot();
      for (const id of ids) {
        const n = model.nodes.get(String(id));
        n.data.nodeStatus = (n.data.nodeStatus === 'bypass') ? 'normal' : 'bypass';
      }
      renderer.invalidate('fg'); renderInspector(); afterModelChange();
    } else if (act === 'min') {
      history.commitSnapshot();
      for (const id of ids) { const n = model.nodes.get(String(id)); n.collapsed = !n.collapsed; computeSize(n); }
      renderer.invalidate('all'); afterModelChange();
    } else if (act === 'clone') { cloneSelected(); }
    else if (act === 'info') { inspectorTab = 'info'; renderInspector(); }
  });
}

function deleteSelected() {
  if (!renderer.selection.size) return;
  history.commitSnapshot();
  for (const id of [...renderer.selection]) removeNode(model, id);
  renderer.selection.clear();
  renderInspector();
  updateNodeToolbar();
  afterModelChange();
}

// 克隆/复制粘贴:选中子图(节点 + 内部连线)序列化为 API 片段,id 重映射
function cloneFragment(ids) {
  const all = toApi(model);
  const frag = {};
  const set = new Set(ids.map(String));
  for (const id of set) frag[id] = JSON.parse(JSON.stringify(all[id]));
  for (const node of Object.values(frag)) {
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (isLink(v) && !set.has(String(v[0]))) node.inputs[k] = null; // 跨选区连线断开
    }
    for (const key of ['tasks', 'results']) if (Array.isArray(node.inputs[key])) node.inputs[key] = [];
    node.inputs.active = -1; node.inputs.view = 0;
  }
  return frag;
}

function pasteFragment(frag, atWorld) {
  if (!frag || !Object.keys(frag).length) return;
  history.commitSnapshot();
  const idMap = new Map();
  let minX = Infinity, minY = Infinity;
  for (const n of Object.values(frag)) { minX = Math.min(minX, (n.pos && n.pos[0]) || 0); minY = Math.min(minY, (n.pos && n.pos[1]) || 0); }
  for (const [oldId, n] of Object.entries(frag)) {
    const fresh = fromApi({ [oldId]: n }, registry);
    const node = [...fresh.nodes.values()][0];
    if (!node) continue;
    model.nodes.delete(node.id);
    node.id = String(model.nextNodeId++);
    idMap.set(String(oldId), node.id);
    const dx = atWorld ? atWorld.x - minX : 40;
    const dy = atWorld ? atWorld.y - minY : 40;
    node.pos.x = ((n.pos && n.pos[0]) || 0) + dx;
    node.pos.y = ((n.pos && n.pos[1]) || 0) + dy;
    model.nodes.set(node.id, node);
  }
  // 内部连线按 id 重映射重连
  for (const [oldId, n] of Object.entries(frag)) {
    const node = model.nodes.get(idMap.get(String(oldId)));
    if (!node) continue;
    for (const slot of node.inputs) {
      const v = n.inputs && n.inputs[slot.name];
      if (!isLink(v)) continue;
      const srcNew = idMap.get(String(v[0]));
      if (!srcNew) continue;
      const src = model.nodes.get(srcNew);
      connect(model, src.id, Math.min(Number(v[1]) || 0, src.outputs.length - 1), node.id, node.inputs.indexOf(slot));
    }
  }
  renderer.selection = new Set([...idMap.values()]);
  renderInspector();
  updateNodeToolbar();
  afterModelChange();
}

function cloneSelected() {
  const ids = [...renderer.selection];
  if (!ids.length) return;
  pasteFragment(cloneFragment(ids));
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------
function onCanvasContextMenu(hit, evt) {
  if (hit.type === 'node' || hit.type === 'title' || hit.type === 'widget') {
    const node = hit.node;
    if (!renderer.selection.has(node.id)) { renderer.selection = new Set([node.id]); renderInspector(); renderer.invalidate('fg'); }
    const status = node.data.nodeStatus || 'normal';
    showCtxMenu(evt.clientX, evt.clientY, [
      { label: '📑 克隆', onClick: cloneSelected },
      { label: '📋 复制', onClick: () => { window.__cvClipboard = cloneFragment([...renderer.selection]); } },
      { label: status === 'bypass' ? '⤳ 取消忽略' : '⤳ 忽略 (Bypass)', onClick: () => { history.commitSnapshot(); node.data.nodeStatus = status === 'bypass' ? 'normal' : 'bypass'; renderer.invalidate('fg'); renderInspector(); afterModelChange(); } },
      { label: status === 'disabled' ? '🔇 取消禁用' : '🔇 禁用 (Mute)', onClick: () => { history.commitSnapshot(); node.data.nodeStatus = status === 'disabled' ? 'normal' : 'disabled'; renderer.invalidate('fg'); renderInspector(); afterModelChange(); } },
      { label: node.collapsed ? '🗖 展开节点' : '🗕 最小化节点', onClick: () => { history.commitSnapshot(); node.collapsed = !node.collapsed; computeSize(node); renderer.invalidate('all'); afterModelChange(); } },
      { label: node.locked ? '🔓 解锁' : '📌 固定 (Pin)', onClick: () => { node.locked = !node.locked; scheduleSave(); } },
      { label: '🗑 删除', danger: true, onClick: deleteSelected },
    ]);
    return;
  }
  if (hit.type === 'link') {
    showCtxMenu(evt.clientX, evt.clientY, [
      { label: '✂ 删除连线', danger: true, onClick: () => { history.commitSnapshot(); disconnect(model, hit.link.id); afterModelChange(); } },
    ]);
    return;
  }
  if (hit.type === 'group-title' || hit.type === 'group') {
    showCtxMenu(evt.clientX, evt.clientY, [
      { label: '✏️ 重命名分组', onClick: () => { const t = prompt('分组名', hit.group.title || ''); if (t != null) { hit.group.title = t; renderer.invalidate('bg'); scheduleSave(); } } },
      { label: '🗑 删除分组(保留节点)', danger: true, onClick: () => { history.commitSnapshot(); model.groups.delete(hit.group.id); renderer.invalidate('bg'); scheduleSave(); } },
    ]);
    return;
  }
  // 空白画布
  const wp = toWorld(viewport, { x: evt.clientX - $('drawflow').getBoundingClientRect().left, y: evt.clientY - $('drawflow').getBoundingClientRect().top });
  showCtxMenu(evt.clientX, evt.clientY, [
    { label: '➕ 添加节点', onClick: () => openSearchMenu(wp) },
    { label: '📋 粘贴', onClick: () => window.__cvClipboard && pasteFragment(window.__cvClipboard, wp) },
    { label: '▭ 新建分组框', onClick: () => { history.commitSnapshot(); addGroup(model, { x: wp.x - 160, y: wp.y - 120, w: 320, h: 240 }, '分组'); renderer.invalidate('bg'); scheduleSave(); } },
    { label: '⌖ 适配视野 (F)', onClick: () => interactor.fitView() },
  ]);
}

// ---------------------------------------------------------------------------
// Widget 编辑器浮层(combo 选项 / 数值 / 文本)
// ---------------------------------------------------------------------------
function openWidgetEditor(node, wd, rect) {
  const commit = (value) => {
    const prev = wd.value;
    const apply = (v) => { wd.value = v; if (node.data.comfyInputs) node.data.comfyInputs[wd.name] = v; renderer.invalidate('fg'); };
    apply(value);
    history.commitDelta({ key: 'widget:' + node.id + ':' + wd.name, revert: () => { apply(prev); scheduleSave(); }, apply: () => { apply(value); scheduleSave(); } });
    afterModelChange();
  };
  if (wd.options && wd.options.length) {
    showCtxMenu(rect.x, rect.y + rect.h, wd.options.slice(0, 60).map((o) => ({ label: String(o), onClick: () => commit(o) })));
    return;
  }
  // 数值/文本:行内浮层输入框
  let box = document.querySelector('.cv-widget-editor');
  if (box) box.remove();
  box = document.createElement('div');
  box.className = 'cv-widget-editor';
  box.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${Math.max(160, rect.w)}px;z-index:1000`;
  const isNum = wd.kind === 'INT' || wd.kind === 'FLOAT';
  box.innerHTML = isNum
    ? `<input type="number" class="input-sm" step="${wd.step || 1}" ${wd.min != null ? `min="${wd.min}"` : ''} ${wd.max != null ? `max="${wd.max}"` : ''} value="${escapeHtml(wd.value ?? '')}" />`
    : `<textarea class="input-sm" rows="3" style="width:100%">${escapeHtml(wd.value ?? '')}</textarea>`;
  document.body.appendChild(box);
  const input = box.querySelector(isNum ? 'input' : 'textarea');
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    if (ok) commit(isNum ? Number(input.value) : input.value);
    box.remove();
    document.removeEventListener('mousedown', closer);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && (isNum || !e.shiftKey)) { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
  const closer = (e) => { if (!box.contains(e.target)) finish(true); };
  document.addEventListener('mousedown', closer);
}

// ---------------------------------------------------------------------------
// 媒体预览:采用版本的第一个图片产物 → Image 对象(渲染层 Letterbox 绘制)
// ---------------------------------------------------------------------------
function refreshPreviews() {
  for (const node of model.nodes.values()) {
    const d = node.data || {};
    const versions = node.type === 'llmtext' ? (d.results || []) : (d.tasks || []);
    const active = versions[d.active];
    const file = active && active.status === 'done' && (active.files || []).find((f) => IMG_RE.test(f.name || ''));
    if (file) {
      const img = new Image();
      img.onload = () => renderer.setPreviewImage(node.id, img);
      img.src = `aigc://${active.traceId}/${encodeURIComponent(file.name)}`;
      if (!node.previewH) { node.previewH = LAYOUT.PREVIEW_H; computeSize(node); }
    } else {
      renderer.setPreviewImage(node.id, null);
      if (node.previewH) { node.previewH = 0; computeSize(node); }
    }
  }
  renderer.invalidate('all');
}

// ---------------------------------------------------------------------------
// 整图运行(保存→校验→主进程执行器;状态流 → 节点脉冲/进度)
// ---------------------------------------------------------------------------
async function runCanvas() {
  if (!cvId) return;
  await flushSave();
  const cv = await api.canvasLoad(cvId);
  if (!cv || !cv.graph) return;
  const v = await api.canvasValidate(cv.graph);
  for (const nid of [...renderer.errors.keys()]) renderer.setNodeErrors(nid, null);
  if (!v.ok) {
    for (const [nid, errs] of Object.entries(v.nodeErrors || {})) {
      if (nid === '_global') { alert(errs.map((e) => e.message).join('\n')); continue; }
      renderer.setNodeErrors(nid, errs.map((e) => e.message));
    }
    return;
  }
  const r = await api.canvasRun(cvId);
  if (!r || !r.ok) {
    if (r && r.nodeErrors) for (const [nid, errs] of Object.entries(r.nodeErrors)) renderer.setNodeErrors(nid, errs.map((e) => e.message));
    else alert('运行失败:' + ((r && r.error) || '未知错误'));
    return;
  }
  currentJobId = r.jobId;
  setRunBtn(true);
}

const terminalJob = (s) => ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(s);

function onJobStatus(p) {
  if (!p || p.canvasId !== cvId) return;
  if (p.nodeId) {
    const nid = String(p.nodeId);
    if (p.status === 'running' || p.status === 'pending' || p.status === 'processing' || p.status === 'queued') {
      const progress = typeof p.value === 'number' && p.max ? p.value / p.max : undefined;
      renderer.setExecState(nid, { status: 'running', progress });
    } else if (p.status === 'fail' || p.status === 'failed') {
      renderer.setExecState(nid, null);
      if (p.failReason) renderer.setNodeErrors(nid, [p.failReason]);
    } else {
      renderer.setExecState(nid, null);
    }
  }
  if (terminalJob(p.status)) {
    setRunBtn(false);
    currentJobId = null;
    if (!$('cv-queue-panel').classList.contains('hidden')) renderQueue();
    reopenCurrent(); // 产物/_v 已由主进程写回画布 JSON,重载刷新预览
  }
  if (p.status === 'failed' && p.error) alert('整图运行失败:' + p.error);
}

async function reopenCurrent() {
  if (!cvId) return;
  const cv = await api.canvasLoad(cvId);
  if (!cv || !cv.graph) return;
  importing = true;
  deserializeAll(cv.graph);
  importing = false;
  refreshPreviews();
  renderInspector();
  renderer.invalidate('all');
}

function setRunBtn(running) {
  const btn = $('btn-cv-run');
  if (!btn) return;
  btn.disabled = running;
  btn.textContent = running ? '◐ 运行中…' : '▶ 运行';
}

// ---------------------------------------------------------------------------
// 队列面板(原生 + Comfy 两源)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 模板 + 导入导出
// ---------------------------------------------------------------------------
const PRESETS = [
  ['文生图 → 图生视频', () => ({
    '1': { id: '1', class_type: 'drafter/text', pos: [60, 140], inputs: { text: '' } },
    '2': { id: '2', class_type: 'drafter/image', pos: [430, 90], inputs: { prompt: ['1', 0], ref: null, models: [], tasks: [], active: -1, view: 0 } },
    '3': { id: '3', class_type: 'drafter/video', pos: [800, 140], inputs: { prompt: ['1', 0], ref: ['2', 0], models: [], tasks: [], active: -1, view: 0 } },
  })],
  ['LLM 提示词 → 图片生成', () => ({
    '1': { id: '1', class_type: 'drafter/text', pos: [60, 140], inputs: { text: '' } },
    '2': { id: '2', class_type: 'drafter/llmtext', pos: [400, 120], inputs: { prompt: ['1', 0], models: [], results: [], active: -1, view: 0 } },
    '3': { id: '3', class_type: 'drafter/image', pos: [760, 140], inputs: { prompt: ['2', 0], ref: null, models: [], tasks: [], active: -1, view: 0 } },
  })],
];

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

// ---------------------------------------------------------------------------
// PNG 拖入:tEXt/iTXt 工作流元数据 → 新画布(md「二进制元数据通道」)
// ---------------------------------------------------------------------------
async function onDrop(evt) {
  const f = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
  if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  if (!isPng(buf)) return; // 非 PNG 交给全局 drop(作为消息附件)
  evt.preventDefault();
  evt.stopPropagation();
  const meta = await extractWorkflowMeta(buf);
  if (!meta) { alert('这张 PNG 里没有内嵌工作流元数据。'); return; }
  try {
    const json = JSON.parse(meta.workflow || meta.prompt);
    const r = await api.comfyImportGraph(json);
    if (!r || !r.ok) throw new Error((r && r.error) || '格式识别失败');
    for (const [id, node] of Object.entries(r.prompt)) {
      const meta2 = r.layout && r.layout[id];
      if (meta2) { if (meta2.pos) node.pos = meta2.pos; if (meta2.title) node.title = meta2.title; }
    }
    const cv = await api.canvasCreate((f.name || 'PNG 工作流').replace(/\.png$/i, ''));
    await api.canvasSave(cv.id, { graph: r.prompt });
    await openCanvas(cv.id);
  } catch (e) {
    alert('PNG 工作流解析失败:' + e.message);
  }
}

// ---------------------------------------------------------------------------
// 工具栏/左轨/快捷键接线
// ---------------------------------------------------------------------------
function bindChrome() {
  $('btn-cv-run').onclick = runCanvas;
  $('btn-cv-add').onclick = (e) => { e.stopPropagation(); $('cv-add-menu').classList.toggle('hidden'); };
  $('cv-add-menu').onclick = async (e) => {
    const nt = e.target.closest('[data-nt]');
    const ext = e.target.closest('[data-comfy-class]');
    if (nt) { addNodeAt(nt.dataset.nt); $('cv-add-menu').classList.add('hidden'); }
    if (ext) { addExternalAt(ext.dataset.comfyConnection, ext.dataset.comfyClass); $('cv-add-menu').classList.add('hidden'); }
  };
  $('btn-cv-zoom-in').onclick = () => { const { w, h } = renderer.viewSize(); zoomAt(viewport, w / 2, h / 2, 1.2); renderer.invalidate('all'); };
  $('btn-cv-zoom-out').onclick = () => { const { w, h } = renderer.viewSize(); zoomAt(viewport, w / 2, h / 2, 1 / 1.2); renderer.invalidate('all'); };
  $('btn-cv-zoom-reset').onclick = () => { viewport.scale = 1; renderer.invalidate('all'); };
  $('btn-cv-queue').onclick = () => { const p = $('cv-queue-panel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) renderQueue(); };
  $('cv-queue-panel').addEventListener('click', async (e) => {
    if (e.target.closest('[data-job-refresh]')) return renderQueue();
    const btn = e.target.closest('[data-job-cancel]');
    if (!btn) return;
    if (btn.dataset.jobBackend === 'comfy') await api.comfyCancel(btn.dataset.jobCancel);
    else await api.canvasJobCancel(btn.dataset.jobCancel);
    renderQueue();
  });
  // 模板菜单
  $('btn-cv-tpl').onclick = async (e) => {
    e.stopPropagation();
    const menu = $('cv-tpl-menu');
    if (menu.classList.contains('hidden')) menu.innerHTML = tplMenuHtml(await api.canvasListTemplates());
    menu.classList.toggle('hidden');
  };
  $('cv-tpl-menu').onclick = async (e) => {
    const menu = $('cv-tpl-menu');
    if (e.target.closest('[data-tplsave]')) {
      const name = ($('cv-tpl-name').value || '').trim();
      if (!name || !cvId) return;
      await api.canvasSaveTemplate(name, serializeAll());
      $('canvas-save-hint').textContent = '已存为模板「' + name + '」';
      menu.innerHTML = tplMenuHtml(await api.canvasListTemplates());
      return;
    }
    const use = e.target.closest('[data-tpl]');
    if (use) { menu.classList.add('hidden'); await newCanvasFromTemplate(use.dataset.tpl); return; }
    const del = e.target.closest('[data-tpldel]');
    if (del) { await api.canvasRemoveTemplate(del.dataset.tpldel); menu.innerHTML = tplMenuHtml(await api.canvasListTemplates()); return; }
    if (e.target.closest('[data-tplexport]')) {
      menu.classList.add('hidden');
      if (cvId) await api.canvasExportFile(cvId);
    }
  };
  $('btn-cv-import').onclick = async () => {
    const r = await api.canvasImportFile();
    if (r && r.ok && r.canvas) { await openCanvas(r.canvas.id); renderTabs(); }
    else if (r && r.error) alert('导入失败:' + r.error);
  };
  // ComfyUI 工具(高级模式)
  const comfyImportBtn = $('btn-cv-comfy-import');
  if (comfyImportBtn) comfyImportBtn.onclick = async () => {
    const connections = await api.comfyListConnections();
    const r = await api.comfyImportFile(connections.length === 1 ? connections[0].id : null);
    if (r && r.ok && r.canvas) { await openCanvas(r.canvas.id); renderTabs(); }
    else if (r && r.error) alert('导入失败:' + r.error);
  };
  const comfyBtn = $('btn-cv-comfy');
  if (comfyBtn) comfyBtn.onclick = () => document.querySelector('[data-settings-page="comfy"]')?.click();
  // 左轨
  for (const b of document.querySelectorAll('[data-cv-rail]')) {
    b.onclick = () => {
      for (const x of document.querySelectorAll('[data-cv-rail]')) x.classList.toggle('active', x === b);
      const pane = b.dataset.cvRail;
      $('cv-browser-title').textContent = b.title;
      for (const p of document.querySelectorAll('.cv-browser-pane')) p.classList.add('hidden');
      const el = $('cv-browser-' + pane);
      if (el) el.classList.remove('hidden');
    };
  }
  $('cv-node-search').oninput = (e) => renderCatalogBrowser(e.target.value);
  $('btn-cv-catalog-refresh').onclick = async () => { await loadComfyCatalogs(true); buildAddMenu(); renderCatalogBrowser($('cv-node-search').value); };
  for (const b of document.querySelectorAll('[data-cv-browser]')) {
    b.onclick = () => {
      catalogMode = b.dataset.cvBrowser;
      for (const x of document.querySelectorAll('[data-cv-browser]')) x.classList.toggle('active', x === b);
      renderCatalogBrowser($('cv-node-search').value);
    };
  }
  bindInspector();
  bindNodeToolbar();
  // PNG 拖入工作流(画布宿主捕获,先于全局附件 drop)
  const host = $('drawflow');
  host.addEventListener('dragover', (e) => e.preventDefault());
  host.addEventListener('drop', onDrop, true);
  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (state.section !== 'canvas' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); }
    else if (mod && e.key.toLowerCase() === 'c' && renderer.selection.size) { e.preventDefault(); window.__cvClipboard = cloneFragment([...renderer.selection]); }
    else if (mod && e.key.toLowerCase() === 'v' && window.__cvClipboard) { e.preventDefault(); pasteFragment(window.__cvClipboard); }
    else if (e.key.toLowerCase() === 'f') { e.preventDefault(); interactor.fitView(); }
    else if (e.key === 'Delete' && renderer.selection.size) { e.preventDefault(); deleteSelected(); }
  });
  // 模型选项加载
  loadModelOptions();
}

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
// 对外入口
// ---------------------------------------------------------------------------
export async function enterSection() {
  await boot();
  await loadModelOptions(true);
  await loadComfyCatalogs();
  const tools = $('cv-comfy-tools');
  if (tools) tools.classList.toggle('hidden', !state.comfyAdvancedMode);
  buildAddMenu();
  renderCatalogBrowser();
  await seedPresetsIfEmpty();
  await renderList();
  if (!cvId) {
    const list = await api.canvasList();
    if (list.length) await openCanvas(list[0].id);
    else $('canvas-empty').classList.remove('hidden');
  } else {
    renderTabs();
    renderer.invalidate('all');
  }
}

export function init() {
  api.on('canvas:job-status', onJobStatus);
  window.addEventListener('drafter:comfy-advanced-changed', async () => {
    if (!booted) return;
    await loadComfyCatalogs(true);
    buildAddMenu();
    renderCatalogBrowser($('cv-node-search') && $('cv-node-search').value);
  });
  // 双击预览图放大(渲染态图片进查看模式)
  $('drawflow').addEventListener('dblclick', (e) => {
    const id = [...renderer ? renderer.selection : []][0];
    if (!id) return;
    const node = model.nodes.get(String(id));
    const d = node && node.data;
    const versions = node && node.type === 'llmtext' ? (d.results || []) : ((d && d.tasks) || []);
    const active = versions[d.active];
    const file = active && active.status === 'done' && (active.files || []).find((f) => IMG_RE.test(f.name || ''));
    if (file) openViewer(`aigc://${active.traceId}/${encodeURIComponent(file.name)}`);
  });
}

export function currentId() { return cvId; }
