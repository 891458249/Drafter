// 图模型层(md「Graph Model」):纯逻辑内存模型,无 DOM/Canvas 依赖。
// 职责:节点/连线/分组数据结构、Schema 驱动的节点工厂、四阶连接验证、
// computeSize 自适应排版、ComfyUI API 格式双向序列化(与主进程 canvasGraph.js 语义对齐)。
//
// 数据形态:
//   node = { id, kind:'native'|'external', type, classType, title, pos:{x,y}, size:{w,h},
//            collapsed, color, locked, inputs:[Slot], outputs:[Slot], widgets:[Widget], data }
//   Slot   = { name, type, link }          // link = 连线 id 或 null(输入槽至多一条,md 规则4)
//   Widget = { name, kind, value, options, min, max, step, multiline, tooltip }
//   link   = { id, from, fromSlot, to, toSlot, type }
//   group  = { id, title, color, rect:{x,y,w,h} }   // 几何归属(中心点判定),非树状父子

import { snapToGrid } from './geom.js';
import { i18n } from './i18n.js';

// 排版常量(md「几何尺寸自适应布局算法」,数值取 LiteGraph/ComfyUI 惯例)
export const LAYOUT = {
  TITLE_H: 30,       // 顶部标题栏
  SLOT_H: 20,        // 插槽行高
  WIDGET_H: 28,      // 交互组件行高
  GAP: 4,            // 垂直堆叠间距
  PAD_BOTTOM: 6,     // 底部内边距
  PREVIEW_H: 160,    // 媒体预览区(无媒体为 0)
  MIN_W: 220,
  MAX_W: 560,
  PAD_X: 14,         // 左右内边距
};

// 原生节点槽位语义(与主进程 canvasGraph.js INPUT_NAME 对齐):1=prompt(text),2=ref(image)
export const INPUT_NAME = { 1: 'prompt', 2: 'ref' };
// 槽位名称 → 展示标签
export const SLOT_LABEL = { prompt: '提示词', ref: '参考图' };

// 标量 widget 类型(schema.js normalizeInput 归一化后的 widget.kind);
// 其余类型(MODEL/LATENT/CONDITIONING/IMAGE…)一律开辟输入插槽(md「类型映射断言」)
const WIDGET_KINDS = new Set(['enum', 'combo', 'dynamic', 'autogrow', 'INT', 'FLOAT', 'BOOLEAN', 'STRING']);

// 兜底文字度量(Canvas measureText 由渲染层注入;此处用于无头测试/主线程外)
export function defaultMeasure(text, fontSize = 12) {
  let units = 0;
  for (const ch of String(text ?? '')) units += /[⺀-꓏가-힣぀-ヿ＀-￯]/.test(ch) ? 1 : 0.56;
  return units * fontSize;
}

export function createModel(registry = {}) {
  return {
    registry,               // 节点类型注册表(主进程 canvasGraph.NODE_TYPES 下发,单一数据源)
    nodes: new Map(),       // id(string) → node
    links: new Map(),       // id(string) → link
    groups: new Map(),      // id(string) → group
    nextNodeId: 1, nextLinkId: 1, nextGroupId: 1,
  };
}

// ---------------------------------------------------------------------------
// 节点工厂
// ---------------------------------------------------------------------------
export function addNativeNode(model, type, pos = { x: 0, y: 0 }, data = null) {
  const t = model.registry[type];
  if (!t) throw new Error('未知节点类型: ' + type);
  const id = String(model.nextNodeId++);
  const node = {
    id, kind: 'native', type, classType: 'drafter/' + type, title: '',
    pos: { x: pos.x, y: pos.y }, size: { w: LAYOUT.MIN_W, h: LAYOUT.TITLE_H },
    collapsed: false, color: null, locked: false,
    // name/type 是逻辑键(英文,进 API 序列化与连接校验);label 只是 UI 显示名(i18n)
    inputs: (t.inTypes || []).map((slotType, i) => {
      const name = INPUT_NAME[i + 1] || 'input_' + (i + 1);
      return { name, type: slotType, label: i18n.tInput(type, name), link: null };
    }),
    outputs: t.outType ? [{ name: 'output', type: t.outType, label: i18n.tType(t.outType) }] : [],
    widgets: [],
    data: data || defaultData(type),
  };
  model.nodes.set(id, node);
  computeSize(node);
  return node;
}

function defaultData(type) {
  if (type === 'text') return { type, text: '' };
  if (type === 'upload') return { type, file: null };
  if (type === 'llmtext') return { type, prompt: '', models: [], results: [], active: -1, view: 0 };
  return { type, prompt: '', models: [], tasks: [], active: -1, view: 0 };
}

// 外部 ComfyUI 节点:schema 来自主进程 schema.js normalizeNode 的输出
// (inputs:[{name, required, type, widget}], outputs:[type], outputNames)
export function addExternalNode(model, { connectionId, connectionName = '', schema }, pos = { x: 0, y: 0 }) {
  if (!schema) throw new Error('缺少节点 schema');
  const id = String(model.nextNodeId++);
  const inputs = [], widgets = [], comfyInputs = {}, comfyInputTypes = {}, comfyWidgets = {}, slotNames = [];
  for (const input of schema.inputs || []) {
    const w = input.widget || {};
    comfyInputTypes[input.name] = input.type;
    if (WIDGET_KINDS.has(w.kind)) {
      // 标量 → 原生 widget(md: 字符串数组→combo;INT/FLOAT/BOOLEAN/STRING→数值/文本控件)
      widgets.push({
        name: input.name, kind: w.kind, label: i18n.tWidget(schema.classType, input.name),
        value: w.default ?? (w.kind === 'BOOLEAN' ? false : w.kind === 'INT' || w.kind === 'FLOAT' ? 0 : ''),
        options: w.values || [], min: w.min, max: w.max, step: w.step,
        multiline: !!w.multiline, tooltip: w.tooltip || '', remote: w.remote || null,
      });
      comfyInputs[input.name] = w.default;
      comfyWidgets[input.name] = w;
    } else {
      // 高阶复合类型 → 输入插槽
      slotNames.push(input.name);
      inputs.push({ name: input.name, type: input.type, label: i18n.tInput(schema.classType, input.name), link: null });
    }
  }
  const outputs = (schema.outputs || []).map((type, i) => {
    const name = (schema.outputNames || [])[i] || type;
    return { name, type, label: i18n.tOutput(schema.classType, name) };
  });
  if (!outputs.length) outputs.push({ name: 'output', type: '*', label: i18n.tType('*') });
  const node = {
    id, kind: 'external', type: 'external', classType: schema.classType,
    title: i18n.tNodeTitle(schema.classType, schema.displayName || schema.classType),
    pos: { x: pos.x, y: pos.y }, size: { w: LAYOUT.MIN_W, h: LAYOUT.TITLE_H },
    collapsed: false, color: null, locked: false,
    inputs, outputs, widgets,
    data: {
      type: 'external', comfyConnectionId: connectionId, comfyConnectionName: connectionName,
      comfyClassType: schema.classType, comfyDisplayName: schema.displayName, comfyCategory: schema.category,
      comfyOutputs: schema.outputs || [], comfyInputs, comfyWidgets, comfyInputTypes,
      slotNames, tasks: [], active: -1, view: 0,
    },
  };
  model.nodes.set(id, node);
  computeSize(node);
  return node;
}

export function removeNode(model, id) {
  const node = model.nodes.get(String(id));
  if (!node) return false;
  for (const [lid, link] of [...model.links]) if (link.from === node.id || link.to === node.id) disconnect(model, lid);
  model.nodes.delete(node.id);
  return true;
}

// ---------------------------------------------------------------------------
// 连接验证(md「端口类型约束与连接验证器」四阶规则)
// ---------------------------------------------------------------------------
export function validateConnection(model, fromId, fromSlot, toId, toSlot) {
  const src = model.nodes.get(String(fromId));
  const dst = model.nodes.get(String(toId));
  if (!src || !dst) return { ok: false, reason: 'missing_node' };
  // 规则 1:严禁自环
  if (src.id === dst.id) return { ok: false, reason: 'self' };
  const out = src.outputs[fromSlot];
  const inp = dst.inputs[toSlot];
  if (!out || !inp) return { ok: false, reason: 'missing_slot' };
  // 外部 ComfyUI 节点只允许同一连接内互连(私有类型不可跨后端)
  const sc = src.data && src.data.comfyConnectionId, dc = dst.data && dst.data.comfyConnectionId;
  if ((src.kind === 'external' || dst.kind === 'external') && sc !== dc) return { ok: false, reason: 'cross_backend' };
  // 规则 2:通配符兼容
  if (out.type === '*' || inp.type === '*') return finishCycleCheck(model, src, dst, inp);
  // 规则 3:强类型匹配(不区分大小写)
  if (String(out.type).toLowerCase() !== String(inp.type).toLowerCase()) return { ok: false, reason: 'type', detail: `${out.type} ↛ ${inp.type}` };
  return finishCycleCheck(model, src, dst, inp);
}

function finishCycleCheck(model, src, dst, inp) {
  // 规则 4 之前:连 src→dst 若 dst 的下游可达 src 则成环
  if (reachable(model, dst.id, src.id)) return { ok: false, reason: 'cycle' };
  // 规则 4:输入端口单一性——已有连接则覆盖替换
  return { ok: true, replace: inp.link != null };
}

function reachable(model, fromId, targetId) {
  const seen = new Set();
  const stack = [String(fromId)];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === String(targetId)) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const link of model.links.values()) if (link.from === cur) stack.push(link.to);
  }
  return false;
}

export function connect(model, fromId, fromSlot, toId, toSlot) {
  const v = validateConnection(model, fromId, fromSlot, toId, toSlot);
  if (!v.ok) return v;
  const dst = model.nodes.get(String(toId));
  const inp = dst.inputs[toSlot];
  if (inp.link != null) model.links.delete(String(inp.link)); // 覆盖替换旧连接
  const src = model.nodes.get(String(fromId));
  const id = String(model.nextLinkId++);
  const link = { id, from: src.id, fromSlot, to: dst.id, toSlot, type: src.outputs[fromSlot].type };
  model.links.set(id, link);
  inp.link = id;
  return { ok: true, link, replaced: v.replace || false };
}

export function disconnect(model, linkId) {
  const link = model.links.get(String(linkId));
  if (!link) return false;
  const dst = model.nodes.get(link.to);
  if (dst && dst.inputs[link.toSlot] && dst.inputs[link.toSlot].link === link.id) {
    dst.inputs[link.toSlot].link = null;
    dst.inputs[link.toSlot].omitWhenEmpty = false; // 用户显式断开后,空槽占位恢复落盘
  }
  model.links.delete(link.id);
  return true;
}

// ---------------------------------------------------------------------------
// 分组框(md「分组框系统 LGraphGroup」:几何中心点归属,拖动标题栏联动)
// ---------------------------------------------------------------------------
export function addGroup(model, rect, title = '', color = '') {
  const id = String(model.nextGroupId++);
  const group = { id, title, color, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
  model.groups.set(id, group);
  return group;
}

export function groupsOfNode(model, nodeId) {
  const node = model.nodes.get(String(nodeId));
  if (!node) return [];
  const cx = node.pos.x + node.size.w / 2, cy = node.pos.y + node.size.h / 2;
  return [...model.groups.values()].filter((g) => cx >= g.rect.x && cx <= g.rect.x + g.rect.w && cy >= g.rect.y && cy <= g.rect.y + g.rect.h);
}

export function moveGroup(model, groupId, dx, dy) {
  const group = model.groups.get(String(groupId));
  if (!group) return false;
  group.rect.x += dx;
  group.rect.y += dy;
  for (const node of model.nodes.values()) {
    const cx = node.pos.x + node.size.w / 2, cy = node.pos.y + node.size.h / 2;
    // 用位移前的矩形判定归属(组内节点随组一起动,不能因位移丢失成员)
    if (cx >= group.rect.x - dx && cx <= group.rect.x - dx + group.rect.w && cy >= group.rect.y - dy && cy <= group.rect.y - dy + group.rect.h) {
      node.pos.x += dx;
      node.pos.y += dy;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 几何尺寸自适应布局(md「computeSize」):高度自顶向下排版求和,宽度由文字度量决定。
// measure(text, fontSize) 由渲染层注入 Canvas measureText;缺省用 defaultMeasure。
// ---------------------------------------------------------------------------
export function computeSize(node, measure = defaultMeasure) {
  const slotRows = Math.max(node.inputs.length, node.outputs.length);
  const widgetRows = node.widgets.length;
  const previewH = node.collapsed ? 0 : (Number(node.previewH) || 0); // previewH 是渲染态属性,不落盘
  if (node.collapsed) {
    node.size = { w: LAYOUT.MIN_W, h: LAYOUT.TITLE_H + LAYOUT.PAD_BOTTOM };
    return node.size;
  }
  const h = LAYOUT.TITLE_H
    + slotRows * LAYOUT.SLOT_H
    + widgetRows * LAYOUT.WIDGET_H
    + (slotRows || widgetRows ? LAYOUT.GAP : 0)
    + previewH
    + LAYOUT.PAD_BOTTOM;
  let w = LAYOUT.MIN_W;
  w = Math.max(w, defaultMeasure(node.title || node.classType, 14) + LAYOUT.PAD_X * 2 + 40);
  for (let i = 0; i < slotRows; i++) {
    const inLabel = node.inputs[i] ? slotLabel(node.inputs[i]) : '';
    const outLabel = node.outputs[i] ? slotLabel(node.outputs[i]) : '';
    w = Math.max(w, measure(inLabel) + measure(outLabel) + LAYOUT.PAD_X * 2 + 60);
  }
  for (const wd of node.widgets) w = Math.max(w, measure(wd.label || wd.name, 12) + LAYOUT.PAD_X * 2 + 60);
  node.size = { w: Math.min(Math.round(w), LAYOUT.MAX_W), h: Math.round(h) };
  return node.size;
}

export function slotLabel(slot) {
  // 显示名优先级:工厂注入的 i18n label → 原生槽位中文表 → 原始逻辑键
  return slot.label || SLOT_LABEL[slot.name] || slot.name;
}

// 插槽相对节点左上角的局部坐标(圆心)。输入在左边界,输出在右边界。
export function slotPos(node, kind, index) {
  const y = LAYOUT.TITLE_H + index * LAYOUT.SLOT_H + LAYOUT.SLOT_H / 2;
  return kind === 'input'
    ? { x: 0, y }
    : { x: node.size.w, y };
}

// widget 行的局部包围盒(交互命中用)
export function widgetBounds(node, index) {
  const slotRows = Math.max(node.inputs.length, node.outputs.length);
  const y = LAYOUT.TITLE_H + slotRows * LAYOUT.SLOT_H + LAYOUT.GAP + index * LAYOUT.WIDGET_H;
  return { x: LAYOUT.PAD_X, y, w: node.size.w - LAYOUT.PAD_X * 2, h: LAYOUT.WIDGET_H - 4 };
}

// ---------------------------------------------------------------------------
// 序列化:模型 → ComfyUI API 格式(与主进程 canvasGraph.fromDrawflow 输出语义一致)
// ---------------------------------------------------------------------------
export function toApi(model) {
  const out = {};
  for (const node of model.nodes.values()) {
    const inputs = {};
    if (node.kind === 'external') {
      // 标量 widget 值先行(md: 配置与连线同列)
      Object.assign(inputs, node.data.comfyInputs || {});
      // 连线槽:按槽名写 [源id, 源端口序位]
      for (const slot of node.inputs) {
        if (slot.link == null) continue;
        const link = model.links.get(String(slot.link));
        if (!link) continue;
        const src = model.nodes.get(link.from);
        inputs[slot.name] = [String(link.from), src ? link.fromSlot : link.fromSlot];
      }
      if (node.data.comfyConnectionId) inputs._comfyConnectionId = node.data.comfyConnectionId;
      if (node.data.comfyCategory) inputs._comfyCategory = node.data.comfyCategory;
      if (Array.isArray(node.data.comfyOutputs)) inputs._comfyOutputs = node.data.comfyOutputs;
      if (node.data.comfyInputTypes) inputs._comfyInputTypes = node.data.comfyInputTypes;
    } else {
      // 原生节点:槽位语义固定 1=prompt, 2=ref(对齐 fromDrawflow)
      node.inputs.forEach((slot, i) => {
        const name = INPUT_NAME[i + 1] || slot.name;
        if (slot.link != null) {
          const link = model.links.get(String(slot.link));
          if (link) inputs[name] = [String(link.from), link.fromSlot];
        } else if (!slot.omitWhenEmpty && model.registry[node.type] && model.registry[node.type].modelType && i > 0) {
          inputs[name] = null; // 可选槽(ref)空槽占位;prompt 空槽不落 null,保 data 里的标量
        }
      });
      // data 并入 inputs(配置与连线同列);槽位已被连线占位时跳过标量
      for (const [k, v] of Object.entries(node.data || {})) {
        if (k === 'type') continue;
        if (k === 'file') { inputs.file = v ? { path: v.path, name: v.name } : null; continue; }
        if (k in inputs) continue;
        inputs[k] = v;
      }
    }
    const entry = {
      id: node.id,
      class_type: node.classType,
      pos: [Math.round(node.pos.x), Math.round(node.pos.y)],
      inputs,
    };
    const title = node.title || (node.kind === 'external' ? node.classType : '');
    if (title && (node.kind === 'external' || !model.registry[node.type])) entry.title = title;
    else if (node.title) entry.title = node.title;
    out[node.id] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 反序列化:ComfyUI API 格式 → 模型(与 canvasGraph.toDrawflow 的 nodeData 语义对齐)
// ---------------------------------------------------------------------------
export function fromApi(apiJson, registry = {}) {
  const model = createModel(registry);
  if (!apiJson || typeof apiJson !== 'object') return model;
  let maxNodeId = 0;
  // 第一遍:建节点(连线留到第二遍,源/目标顺序无关);`_` 前缀是画布元数据(分组/视口),跳过
  for (const [id, n] of Object.entries(apiJson)) {
    if (id.startsWith('_')) continue;
    const numId = Number(id);
    if (!Number.isNaN(numId)) maxNodeId = Math.max(maxNodeId, numId);
    const nativeType = String(n.class_type || '').startsWith('drafter/') ? String(n.class_type).slice(8) : null;
    const pos = { x: (n.pos && n.pos[0]) || 0, y: (n.pos && n.pos[1]) || 0 };
    if (nativeType && registry[nativeType]) {
      const data = { ...defaultData(nativeType) };
      for (const [k, v] of Object.entries(n.inputs || {})) {
        if (isLink(v)) continue;           // 连线不落 data
        if (v === null && (k === 'prompt' || k === 'ref')) continue; // 空槽占位不落 data
        data[k] = v;
      }
      data.type = nativeType;
      const node = addNativeNode(model, nativeType, pos, data);
      node.id = id; // 保持持久化 id,连线与历史引用不断
      model.nodes.delete(String(model.nextNodeId - 1));
      model.nodes.set(id, node);
      if (n.title) node.title = n.title;
      // 文件里缺省的可选槽(从未连过线):序列化时不补 null 占位,与 fromDrawflow 逐键一致
      node.inputs.forEach((slot, i) => {
        const name = INPUT_NAME[i + 1] || slot.name;
        if (!(n.inputs && name in n.inputs)) slot.omitWhenEmpty = true;
      });
    } else {
      // 外部 ComfyUI 节点(或 unknown 占位):从 _comfy 字段重建槽位/widget
      const inputTypes = (n.inputs && n.inputs._comfyInputTypes) || {};
      const scalarKeys = [], slotKeys = [];
      for (const [key, value] of Object.entries(n.inputs || {})) {
        if (key.startsWith('_') || ['tasks', 'results', 'active', 'view', '_v', 'file'].includes(key)) continue;
        const t = inputTypes[key];
        const isLinked = isLink(value);
        // 已连线或张量类型 → 槽位;标量 → widget 值
        if (isLinked || (t && !WIDGET_KINDS.has(t) && !scalarKind(inputTypes, key))) slotKeys.push(key);
        else scalarKeys.push(key);
      }
      const schema = {
        classType: n.class_type, displayName: n.title || n.class_type, category: (n.inputs && n.inputs._comfyCategory) || '',
        inputs: [...slotKeys.map((name) => ({ name, type: inputTypes[name] || '*' })),
                 ...scalarKeys.map((name) => ({ name, type: inputTypes[name] || 'STRING', widget: { kind: inputTypes[name] || 'STRING' } }))],
        outputs: (n.inputs && n.inputs._comfyOutputs) || [],
      };
      const node = addExternalNode(model, { connectionId: (n.inputs && n.inputs._comfyConnectionId) || '', schema }, pos);
      node.id = id;
      model.nodes.delete(String(model.nextNodeId - 1));
      model.nodes.set(id, node);
      for (const key of scalarKeys) {
        const wd = node.widgets.find((w) => w.name === key);
        if (wd) wd.value = n.inputs[key];
        node.data.comfyInputs[key] = n.inputs[key];
      }
      node.data.tasks = (n.inputs && n.inputs.tasks) || [];
      node.data.active = (n.inputs && n.inputs.active) ?? -1;
      node.data.view = (n.inputs && n.inputs.view) || 0;
      computeSize(node);
    }
  }
  model.nextNodeId = Math.max(model.nextNodeId, maxNodeId + 1);
  // 第二遍:连线
  for (const [id, n] of Object.entries(apiJson)) {
    if (id.startsWith('_')) continue;
    const node = model.nodes.get(String(id));
    if (!node) continue;
    for (const slot of node.inputs) {
      const v = n.inputs && n.inputs[slot.name];
      if (!isLink(v)) continue;
      const src = model.nodes.get(String(v[0]));
      if (!src) continue;
      const fromSlot = Math.max(0, Math.min(Number(v[1]) || 0, src.outputs.length - 1));
      connectForce(model, src.id, fromSlot, node.id, node.inputs.indexOf(slot));
    }
  }
  return model;
}

// 反序列化专用:信任文件内容,不做验证(损坏数据由主进程 validate 拦在运行前)
function connectForce(model, fromId, fromSlot, toId, toSlot) {
  const src = model.nodes.get(String(fromId));
  const dst = model.nodes.get(String(toId));
  if (!src || !dst) return;
  const inp = dst.inputs[toSlot];
  if (!inp) return;
  if (inp.link != null) model.links.delete(String(inp.link));
  const id = String(model.nextLinkId++);
  model.links.set(id, { id, from: src.id, fromSlot, to: dst.id, toSlot, type: src.outputs[fromSlot] ? src.outputs[fromSlot].type : '*' });
  inp.link = id;
}

// ComfyUI is_link 等位:[源节点id(string), 端口序位(number)]
export function isLink(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

// 就地重载:把 API JSON 装进既有 model 对象(渲染器/交互层持有的引用不变)
export function loadApi(model, apiJson) {
  const fresh = fromApi(apiJson, model.registry);
  model.nodes = fresh.nodes;
  model.links = fresh.links;
  model.groups = fresh.groups;
  model.nextNodeId = fresh.nextNodeId;
  model.nextLinkId = fresh.nextLinkId;
  model.nextGroupId = fresh.nextGroupId;
  return model;
}

// 外部节点标量类型启发:无 inputTypes 记录时按已知标量名兜底
function scalarKind(inputTypes, key) {
  return ['seed', 'steps', 'cfg', 'denoise', 'text', 'prompt', 'width', 'height', 'filename_prefix'].includes(key);
}

// 网格吸附(节点拖拽落点量化,step 0 = 关闭)
export function snapNodePos(node, step) {
  if (!step) return;
  node.pos.x = snapToGrid(node.pos.x, step);
  node.pos.y = snapToGrid(node.pos.y, step);
}
