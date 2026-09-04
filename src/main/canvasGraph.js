// 画布 API 格式转换/校验/签名(v0.12.0,对齐 ComfyUI comfy_execution 语义,纯逻辑不依赖 electron)
//
// ComfyUI 通读要点(已核实源码):
// - API 格式:{ nodeId: { class_type, inputs: { name: value | [源节点id, 源端口序位] }, _meta:{title} } }
//   (server.py POST /prompt 的提交形态;平铺对象而非 Drawflow 的树)
// - validate_prompt(execution.py:1128):缺 class_type / 循环依赖(visiting 路径给出 A→B→A)
//   / 必需输入缺失;返回逐节点 node_errors
// - CacheKeySetInputSignature(caching.py:82):节点缓存键=递归祖先签名——输入逐 key 排序序列化,
//   link 输入记 [祖先序位, socket] 而非祖先 id(祖先等价重写不破坏缓存)
// - OUTPUT_NODE:我们的「生成类节点」即输出节点(整图运行的终点集合)
'use strict';

const crypto = require('crypto');

// 保留键约定(v0.13.0):`_` 前缀的顶层键是画布元数据(分组框 _groups、视口 _viewport),
// 不是节点——校验/拓扑/签名/执行一律跳过。渲染端原生引擎据此把分组与视口随画布落盘。
const isNodeKey = (k) => !k.startsWith('_');
const nodeKeys = (graph) => Object.keys(graph || {}).filter(isNodeKey);
const nodeEntries = (graph) => Object.entries(graph || {}).filter(([k]) => isNodeKey(k));

// Drafter 画布节点类型注册表(与渲染端 canvas.js 的 NODE_TYPES 一致,class_type 用 drafter/ 前缀)
// inTypes: input_1..N 接受的来源 outType;outType: 该节点输出类型;outNode: 是否整图运行终点
const NODE_TYPES = {
  text:    { modelType: null,   inputs: 0, inTypes: [],                outType: 'text',  outNode: false },
  llmtext: { modelType: 'chat', inputs: 1, inTypes: ['text'],           outType: 'text',  outNode: true },
  upload:  { modelType: null,   inputs: 0, inTypes: [],                 outType: 'image', outNode: false },
  image:   { modelType: 'image',inputs: 2, inTypes: ['text', 'image'],  outType: 'image', outNode: true },
  video:   { modelType: 'video',inputs: 2, inTypes: ['text', 'image'],  outType: 'video', outNode: true },
  audio:   { modelType: 'audio',inputs: 1, inTypes: ['text'],           outType: 'audio', outNode: true },
  model3d: { modelType: 'model',inputs: 1, inTypes: ['text'],           outType: 'model', outNode: true },
  // 导入 ComfyUI 工作流时未知类型的占位:只读展示,整图运行时拒绝
  unknown: { modelType: null,   inputs: 0, inTypes: [],                 outType: null,    outNode: false, unsupported: true },
};

const CLASS_PREFIX = 'drafter/';
const classOf = (type) => CLASS_PREFIX + type;
const typeOfClass = (ct) => String(ct || '').startsWith(CLASS_PREFIX) ? String(ct).slice(CLASS_PREFIX.length) : null;

// ---------------------------------------------------------------------------
// Drawflow export → API 格式
// ---------------------------------------------------------------------------
// Drawflow export: { drawflow: { Home: { data: { id: { name:'cv-<type>', class, pos_x, pos_y,
//   data:{...}, inputs:{input_i:{connections:[{node, input:'output_j'}]}}, outputs:{...} } } } } }
// API 格式: { [id]: { id, class_type, title, pos:[x,y], inputs: { prompt:[srcId,slot]|text,
//   ref:[srcId,slot]|null, models, text, file, tasks/results, active, view, _v(上次运行签名) } } }
const INPUT_NAME = { 1: 'prompt', 2: 'ref' }; // 我们槽位语义固定:1=prompt(text),2=ref(image)

// 连线判断(ComfyUI is_link 等位):[源节点id(string), 端口序位(number)]
// 注意区分「连线数组」与「值数组」(models:['k|m'] 是值,不是连线)
function isLink(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

function fromDrawflow(exportJson) {
  const data = exportJson && exportJson.drawflow && exportJson.drawflow.Home && exportJson.drawflow.Home.data;
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [id, node] of Object.entries(data)) {
    const type = String(node.class || '').replace(/^cv-nt-/, '') || String(node.name || '').replace(/^cv-/, '');
    const t = NODE_TYPES[type]; // 未识别类型 t=undefined(占位 unknown,不做槽位展开)
    const d = node.data || {};
    const inputs = {};
    // 连线:Drawflow 的 input_i.connections[].input='output_j' → API 的 [源id, j-1]
    // 空槽(null 占位)只对「可选槽」写——ref(图生视频可空);prompt 是必需槽,空槽不落 null,
    // 让 data 里的标量 prompt 得以保留(用户自己的提示词;上游连线时槽位才接管)
    for (const [slotName, slot] of Object.entries(node.inputs || {})) {
      const slotIdx = Number(String(slotName).replace('input_', '')) || 1;
      const inputName = INPUT_NAME[slotIdx] || slotName;
      const conn = slot && slot.connections && slot.connections[0]; // 每槽至多一条(Drawflow 语义)
      if (conn) inputs[inputName] = [String(conn.node), Math.max(0, (Number(String(conn.input).replace('output_', '')) || 1) - 1)];
      else if (t && t.modelType && slotIdx > 1) inputs[inputName] = null;
    }
    // data 并入 inputs(配置与连线同列,签名时一起参与);槽位已被连线占位时跳过标量
    for (const [k, v] of Object.entries(d)) {
      if (k === 'type') continue;
      if (k === 'file') { inputs.file = v ? { path: v.path, name: v.name } : null; continue; } // base64 不进画布 JSON(体积)
      if (k in inputs) continue; // 槽位(连线/null)权威,标量不覆盖
      inputs[k] = v;
    }
    const rawClass = d.comfyClassType || (type in NODE_TYPES ? classOf(type) : classOf('unknown'));
    const comfyInputs = d.comfyClassType && d.comfyInputs && typeof d.comfyInputs === 'object' ? d.comfyInputs : null;
    if (comfyInputs) {
      for (const [key, value] of Object.entries(comfyInputs)) {
        inputs[key] = value;
        if (Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && Number.isInteger(value[1])) inputs[key] = [String(value[0]), value[1]];
      }
      for (const [slotName, slot] of Object.entries(node.inputs || {})) {
        const slotIdx = Number(String(slotName).replace('input_', '')) || 1;
        const inputName = (d.slotNames && d.slotNames[slotIdx - 1]) || slotName;
        const conn = slot && slot.connections && slot.connections[0];
        if (conn) inputs[inputName] = [String(conn.node), Math.max(0, (Number(String(conn.input).replace('output_', '')) || 1) - 1)];
      }
      if (d.comfyConnectionId) inputs._comfyConnectionId = d.comfyConnectionId;
      if (d.comfyCategory) inputs._comfyCategory = d.comfyCategory;
      if (Array.isArray(d.comfyOutputs)) inputs._comfyOutputs = d.comfyOutputs;
      if (d.comfyInputTypes && typeof d.comfyInputTypes === 'object') inputs._comfyInputTypes = d.comfyInputTypes;
    }
    out[String(id)] = {
      id: String(id),
      class_type: rawClass,
      title: d.title || (NODE_TYPES[type] ? undefined : String(node.class || node.name || '未知节点')),
      pos: [Math.round(node.pos_x || 0), Math.round(node.pos_y || 0)],
      inputs,
    };
    if (!out[String(id)].title) delete out[String(id)].title;
  }
  return out;
}

// ---------------------------------------------------------------------------
// API 格式 → Drawflow export(渲染端 import 用)
// ---------------------------------------------------------------------------
function toDrawflow(apiGraph) {
  const data = {};
  let maxId = 0;
  for (const [id, node] of Object.entries(apiGraph || {})) {
    const nativeType = typeOfClass(node.class_type);
    const type = nativeType || 'external';
    const t = NODE_TYPES[nativeType] || NODE_TYPES.unknown;
    const external = nativeType === null;
    const inputNames = external ? Object.keys(node.inputs || {}).filter((key) => !key.startsWith('_') && !['tasks', 'results', 'active', 'view', '_v', 'file'].includes(key)) : null;
    const numericId = Number(id);
    if (!Number.isNaN(numericId)) maxId = Math.max(maxId, numericId);
    const inputs = {};
    const slotCount = external ? inputNames.length : t.inputs;
    for (let i = 1; i <= slotCount; i++) {
      const inputName = external ? inputNames[i - 1] : (INPUT_NAME[i] || 'input_' + i);
      const v = node.inputs && node.inputs[inputName];
      if (isLink(v)) inputs['input_' + i] = { connections: [{ node: String(v[0]), input: 'output_' + ((v[1] || 0) + 1) }] };
    }
    const nodeDataObj = external
      ? {
          type: 'external', comfyClassType: node.class_type,
          comfyConnectionId: node.inputs && node.inputs._comfyConnectionId || '',
          comfyDisplayName: node.title || node.class_type,
          comfyCategory: node.inputs && node.inputs._comfyCategory || '',
          comfyOutputs: node.inputs && node.inputs._comfyOutputs || [],
          comfyInputTypes: node.inputs && node.inputs._comfyInputTypes || {},
          comfyInputs: Object.fromEntries(Object.entries(node.inputs || {}).filter(([key, value]) => !isLink(value) && !key.startsWith('_') && !['tasks', 'results', 'active', 'view', '_v', 'file'].includes(key))),
          slotNames: inputNames,
          tasks: node.inputs && node.inputs.tasks || [], active: node.inputs && node.inputs.active || -1, view: node.inputs && node.inputs.view || 0,
        }
      : { type };
    if (!external) for (const [k, v] of Object.entries(node.inputs || {})) {
      if (isLink(v)) continue; // 连线不落 data
      if (v === null && (k === 'prompt' || k === 'ref')) continue; // 空槽占位不落 data
      nodeDataObj[k] = v; // prompt/ref 的标量值(未连线的自有 prompt)也要带上
    }
    if (node.title) nodeDataObj.title = node.title;
    data[String(id)] = {
      id: Number(id) || id,
      name: 'cv-' + type,
      data: nodeDataObj,
      class: 'cv-nt-' + type,
      html: '',
      typenode: false,
      inputs,
      outputs: {}, // 由连线反向重建
      pos_x: (node.pos && node.pos[0]) || 0,
      pos_y: (node.pos && node.pos[1]) || 0,
    };
  }
  // 反向重建 outputs(Drawflow 需要)
  for (const [id, node] of Object.entries(data)) {
    for (const [slotName, slot] of Object.entries(node.inputs)) {
      for (const conn of slot.connections) {
        const src = data[conn.node];
        if (!src) continue;
        const outSlot = conn.input || 'output_1';
        if (!src.outputs[outSlot]) src.outputs[outSlot] = { connections: [] };
        src.outputs[outSlot].connections.push({ node: String(id), output: slotName });
      }
    }
  }
  return { drawflow: { Home: { data } } };
}

// ---------------------------------------------------------------------------
// 校验(对齐 ComfyUI validate_prompt:输出节点回溯 + 循环路径)
// ---------------------------------------------------------------------------
function validate(graph) {
  const nodeErrors = {};
  const nodes = graph || {};
  const addErr = (id, type, message) => {
    (nodeErrors[id] = nodeErrors[id] || []).push({ type, message });
  };
  // 1) class_type / 不支持类型 / 必需输入
  for (const [id, node] of nodeEntries(nodes)) {
    const type = typeOfClass(node.class_type);
    if (type === null) {
      // 外部 ComfyUI 节点由连接戳识别;服务端 /prompt 会做最终 schema 校验。
      if (!(node.inputs && node.inputs._comfyConnectionId)) addErr(id, 'unsupported_node', `不支持的节点类型:${node.class_type}`);
      continue;
    }
    const t = NODE_TYPES[type];
    if (!t || t.unsupported) { addErr(id, 'unsupported_node', `不支持的节点类型:${node.class_type}`); continue; }
    if (t.modelType) {
      const p = resolvePromptPreview(nodes, id);
      if (!p) addErr(id, 'required_input_missing', '提示词为空(填 prompt 或连入文本节点)');
      if (!Array.isArray(node.inputs.models) || !node.inputs.models.length) addErr(id, 'required_input_missing', '未勾选模型');
    }
    if (type === 'upload' && !(node.inputs.file && node.inputs.file.path)) {
      addErr(id, 'required_input_missing', '未选择参考图');
    }
  }
  // 2) 循环依赖(DFS visiting,报错带可读路径 A → B → A)
  const state = {}; // id: 0=未访问 1=访问中 2=完成
  const path = [];
  const dfs = (id) => {
    if (state[id] === 2) return true;
    if (state[id] === 1) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      const label = cycle.map((x) => nodeLabel(nodes[x], x)).join(' → ');
      addErr(id, 'dependency_cycle', `循环依赖:${label}`);
      return false;
    }
    state[id] = 1;
    path.push(id);
    let ok = true;
    for (const v of Object.values(nodes[id].inputs || {})) {
      if (isLink(v) && nodes[v[0]]) { if (!dfs(String(v[0]))) ok = false; }
    }
    path.pop();
    state[id] = 2;
    return ok;
  };
  for (const id of nodeKeys(nodes)) if (!state[id]) dfs(id);
  // 3) 至少要有一个输出节点(整图运行的终点集合)
  const hasOut = nodeEntries(nodes).some(([, n]) => {
    const t = NODE_TYPES[typeOfClass(n.class_type)];
    return (t && t.outNode && !t.unsupported) || (typeOfClass(n.class_type) === null && n.inputs && n.inputs._comfyConnectionId);
  });
  if (Object.keys(nodes).length && !hasOut) addErr('_global', 'prompt_no_outputs', '画布里没有可运行的生成节点');
  return { ok: !Object.keys(nodeErrors).length, nodeErrors };
}

function nodeLabel(node, id) {
  if (!node) return '#' + id;
  if (node.title) return node.title;
  const type = typeOfClass(node.class_type);
  const names = { text: '文本', llmtext: '文本生成', upload: '参考图', image: '图片生成', video: '视频生成', audio: '音频生成', model3d: '3D 生成', unknown: '未知' };
  return (names[type] || node.class_type || '未知') + '#' + id;
}

// prompt 预览(校验/执行用):沿 prompt 槽向上游解析——文本节点给正文,文本生成节点给
// 采用版本,生成节点给自身解析结果(递归);解析到自身或遇环回退自身标量,真无则空。
// 注意:null 是「空槽」占位,不是连线;连线是 [id, socket] 数组
// Bypass 短路(v0.13.0):被忽略节点的输入原样穿透——沿其第一个连线输入继续向上取
function throughBypass(graph, id, stack = []) {
  let cur = String(id);
  while (graph[cur] && graph[cur].inputs && graph[cur].inputs.nodeStatus === 'bypass' && !stack.includes(cur)) {
    stack.push(cur);
    const linked = Object.values(graph[cur].inputs).find((v) => isLink(v));
    if (!linked) break;
    cur = String(linked[0]);
  }
  return cur;
}

function resolvePromptPreview(graph, id, stack = []) {
  const node = graph[id];
  if (!node) return '';
  if (stack.includes(id)) return String((node.inputs && node.inputs.prompt) || '').trim(); // 环:回退标量
  const link = node.inputs && node.inputs.prompt;
  if (isLink(link)) {
    const srcId = throughBypass(graph, String(link[0]));
    const src = graph[srcId];
    if (!src) return '';
    const st = typeOfClass(src.class_type);
    if (st === 'text') return String(src.inputs.text || '').trim();
    if (st === 'llmtext') {
      const results = src.inputs.results;
      const r = Array.isArray(results) && results[src.inputs.active];
      return ((r && r.text) || '').trim();
    }
    return resolvePromptPreview(graph, srcId, [...stack, id]); // 上游也是生成节点:递归
  }
  return String((node.inputs && node.inputs.prompt) || '').trim();
}

// ---------------------------------------------------------------------------
// 拓扑与签名(对齐 CacheKeySetInputSignature:递归祖先签名,link 记祖先序位)
// ---------------------------------------------------------------------------
// 祖先序位映射:按「递归输入来源」DFS 顺序编号(确定性,与节点 id 无关)
function ancestorOrder(graph) {
  const order = new Map();
  let idx = 0;
  const visit = (id) => {
    if (order.has(id) || !graph[id]) return;
    for (const v of Object.values(graph[id].inputs || {})) if (isLink(v)) visit(String(v[0]));
    order.set(id, idx++);
  };
  for (const id of nodeKeys(graph)) visit(id);
  return order;
}

// 单个节点的立即签名:[class_type, 逐 key 排序的输入(link→[祖先序位,socket],其余原值;版本/状态字段剔除)]
const VOLATILE_KEYS = new Set(['tasks', 'results', 'active', 'view', '_v']);
function immediateSignature(graph, id, order) {
  const node = graph[id];
  if (!node) return [NaN];
  const sig = [node.class_type];
  for (const key of Object.keys(node.inputs || {}).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    const v = node.inputs[key];
    if (isLink(v)) {
      sig.push([key, ['ANCESTOR', order.has(String(v[0])) ? order.get(String(v[0])) : -1, v[1] || 0]]);
    } else if (key === 'file') {
      sig.push([key, v && v.path ? v.path : null]); // 参考图按路径(内容同路径即同文件)
    } else {
      sig.push([key, v]);
    }
  }
  return sig;
}

// 节点签名 = 自身 + 全部祖先的立即签名(序位稳定序列化后 sha1)
function nodeSignature(graph, id) {
  const order = ancestorOrder(graph);
  const sigs = [];
  for (const [nid] of [...order.entries()].sort((a, b) => a[1] - b[1])) {
    if (nid !== id && !isAncestorOf(graph, id, nid)) continue;
    sigs.push(immediateSignature(graph, nid, order));
  }
  return crypto.createHash('sha1').update(JSON.stringify(sigs)).digest('hex');
}

function isAncestorOf(graph, id, maybeAncestor) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === maybeAncestor) return true;
    if (seen.has(cur) || !graph[cur]) continue;
    seen.add(cur);
    for (const v of Object.values(graph[cur].inputs || {})) {
      if (isLink(v) && typeof v[0] !== 'undefined') stack.push(String(v[0])); // 连线数组
      else if (v && typeof v === 'object' && Array.isArray(v.inputs)) stack.push(...v.inputs); // 防误遍历
    }
  }
  return false;
}

// 拓扑排序(整图运行顺序):Kahn,同层按 id 稳定
function topoOrder(graph) {
  const nodes = nodeKeys(graph);
  const inDeg = new Map(nodes.map((id) => [id, 0]));
  const downstream = new Map(nodes.map((id) => [id, []]));
  for (const id of nodes) {
    for (const v of Object.values(graph[id].inputs || {})) {
      if (isLink(v) && graph[String(v[0])]) {
        inDeg.set(id, inDeg.get(id) + 1);
        downstream.get(String(v[0])).push(id);
      }
    }
  }
  const queue = nodes.filter((id) => inDeg.get(id) === 0).sort();
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const dn of downstream.get(id)) {
      inDeg.set(dn, inDeg.get(dn) - 1);
      if (inDeg.get(dn) === 0) { queue.push(dn); queue.sort(); }
    }
  }
  return order; // 有环时 order 短于 nodes(校验阶段已拦)
}

// 整图运行的目标子图:全部输出节点及其祖先(非生成链上的游离节点不跑)
function executionTargets(graph) {
  const targets = [];
  for (const [id, node] of nodeEntries(graph)) {
    const t = NODE_TYPES[typeOfClass(node.class_type)];
    if (t && t.outNode && !t.unsupported) targets.push(id);
  }
  const inSubgraph = new Set();
  for (const t of targets) {
    const stack = [t];
    while (stack.length) {
      const cur = stack.pop();
      if (inSubgraph.has(cur) || !graph[cur]) continue;
      inSubgraph.add(cur);
      for (const v of Object.values(graph[cur].inputs || {})) if (isLink(v)) stack.push(String(v[0]));
    }
  }
  return { targets, subgraph: inSubgraph };
}

module.exports = {
  NODE_TYPES, CLASS_PREFIX, classOf, typeOfClass,
  fromDrawflow, toDrawflow, validate, resolvePromptPreview, nodeLabel, throughBypass,
  topoOrder, nodeSignature, executionTargets, ancestorOrder,
};
