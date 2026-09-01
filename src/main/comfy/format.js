// ComfyUI interchange formats. Keeps the execution prompt clean from Drafter-only runtime state.
'use strict';

const RUNTIME_KEYS = new Set(['tasks', 'results', 'active', 'view', '_v', 'file', '_comfyConnectionId', 'nodeStatus', 'nodeColor']);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const isPromptLink = (value) => Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && Number.isInteger(value[1]);

function detectFormat(value) {
  if (!isObject(value)) return null;
  if (Array.isArray(value.nodes)) return 'workflow';
  const nodes = Object.values(value);
  if (nodes.length && nodes.every((node) => isObject(node) && typeof node.class_type === 'string')) return 'prompt';
  return null;
}

function cleanPrompt(prompt) {
  const out = {};
  for (const [id, node] of Object.entries(prompt || {})) {
    if (!node || typeof node.class_type !== 'string') continue;
    const inputs = {};
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (!RUNTIME_KEYS.has(key)) inputs[key] = clone(value);
    }
    out[String(id)] = { class_type: node.class_type, inputs };
    if (node._meta && typeof node._meta === 'object') out[String(id)]._meta = clone(node._meta);
  }
  return out;
}

function inputNames(classType, schema) {
  const entry = schema && schema[classType];
  const required = Object.keys(entry && entry.input && entry.input.required || {});
  const optional = Object.keys(entry && entry.input && entry.input.optional || {});
  return [...required, ...optional];
}

function widgetNames(classType, schema) {
  const entry = schema && schema[classType];
  const all = { ...(entry && entry.input && entry.input.required || {}), ...(entry && entry.input && entry.input.optional || {}) };
  return Object.entries(all).filter(([, spec]) => {
    const type = Array.isArray(spec) ? spec[0] : null;
    const config = Array.isArray(spec) ? spec[1] : null;
    return Array.isArray(type) || (config && Object.prototype.hasOwnProperty.call(config, 'default'));
  }).map(([name]) => name);
}

function workflowToPrompt(workflow, schema = {}) {
  if (!workflow || !Array.isArray(workflow.nodes)) throw new Error('ComfyUI workflow 缺少 nodes');
  const byLink = new Map();
  for (const link of workflow.links || []) {
    if (!Array.isArray(link) || link.length < 5) continue;
    const [, sourceId, sourceSlot, targetId, targetSlot] = link;
    byLink.set(`${targetId}:${targetSlot}`, [String(sourceId), Number(sourceSlot) || 0]);
  }
  const prompt = {};
  const layout = {};
  for (const node of workflow.nodes) {
    if (!node || node.id === undefined || !node.type) continue;
    const id = String(node.id);
    const classType = String(node.type);
    const inputs = {};
    const names = inputNames(classType, schema);
    const widgetNamesForType = widgetNames(classType, schema);
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const slots = Array.isArray(node.inputs) ? node.inputs : [];
    slots.forEach((slot, index) => {
      const name = slot && slot.name || names[index];
      const linked = byLink.get(`${node.id}:${index}`);
      if (name && linked) inputs[name] = linked;
    });
    widgets.forEach((value, index) => {
      const name = widgetNamesForType[index];
      if (name && inputs[name] === undefined) inputs[name] = clone(value);
    });
    prompt[id] = { class_type: classType, inputs };
    layout[id] = { pos: Array.isArray(node.pos) ? node.pos.slice(0, 2) : [0, 0], title: node.title || undefined };
  }
  return { prompt, layout };
}

function promptToWorkflow(prompt, schema = {}, layout = {}) {
  const clean = cleanPrompt(prompt);
  const nodes = [];
  const links = [];
  let linkId = 1;
  for (const [id, node] of Object.entries(clean)) {
    const names = inputNames(node.class_type, schema);
    const widgetNamesForType = widgetNames(node.class_type, schema);
    const nodeInputs = names.map((name) => ({ name, type: (schema[node.class_type] && schema[node.class_type].input.required && schema[node.class_type].input.required[name] || [])[0] || '*' }));
    const widgetsValues = widgetNamesForType.map((name) => node.inputs[name]).filter((value) => !isPromptLink(value) && value !== undefined);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isPromptLink(value)) continue;
      let targetSlot = names.indexOf(name);
      if (targetSlot < 0) { targetSlot = nodeInputs.length; nodeInputs.push({ name, type: '*' }); }
      links.push([linkId++, Number(value[0]) || value[0], value[1], Number(id) || id, targetSlot, '*']);
    }
    const meta = layout[id] || {};
    nodes.push({ id: Number(id) || id, type: node.class_type, pos: meta.pos || [0, 0], size: meta.size || [240, 180], title: meta.title, inputs: nodeInputs, outputs: [] , widgets_values: widgetsValues });
  }
  return { last_node_id: Math.max(0, ...nodes.map((node) => Number(node.id) || 0)), last_link_id: linkId - 1, nodes, links, groups: [] };
}

function importAny(value, schema) {
  const format = detectFormat(value);
  if (format === 'prompt') return { format, prompt: cleanPrompt(value), layout: {} };
  if (format === 'workflow') return { format, ...workflowToPrompt(value, schema) };
  throw new Error('不是有效的 ComfyUI prompt 或 workflow JSON');
}

module.exports = { RUNTIME_KEYS, detectFormat, cleanPrompt, workflowToPrompt, promptToWorkflow, importAny, isPromptLink };
