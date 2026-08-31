// Convert ComfyUI /object_info to renderer-safe catalog data.
'use strict';

const MAX_NODES = 10000;
const MAX_TEXT = 512;
const safeText = (value, fallback = '') => String(value ?? fallback).replace(/[\x00-\x1F<>]/g, ' ').trim().slice(0, MAX_TEXT);

function normalizeInput(name, spec, required) {
  const type = Array.isArray(spec) ? spec[0] : 'UNKNOWN';
  const config = Array.isArray(spec) ? (spec[1] || {}) : {};
  const widget = Array.isArray(type)
    ? { kind: 'enum', values: type.map((value) => safeText(value)).filter(Boolean).slice(0, 200), default: config.default }
    : { kind: safeText(type, 'UNKNOWN'), default: config.default, min: config.min, max: config.max, step: config.step };
  return { name: safeText(name), required: !!required, type: Array.isArray(type) ? 'COMBO' : safeText(type, 'UNKNOWN'), widget };
}

function normalizeNode(classType, info = {}) {
  const inputs = info.input || {};
  const required = Object.entries(inputs.required || {}).map(([name, spec]) => normalizeInput(name, spec, true));
  const optional = Object.entries(inputs.optional || {}).map(([name, spec]) => normalizeInput(name, spec, false));
  return {
    classType: safeText(classType),
    displayName: safeText(info.display_name, classType),
    category: safeText(info.category, 'Uncategorized'),
    description: safeText(info.description),
    inputs: [...required, ...optional],
    outputs: (Array.isArray(info.output) ? info.output : []).map((type) => safeText(type, 'UNKNOWN')),
    outputNames: (Array.isArray(info.output_name) ? info.output_name : []).map((name) => safeText(name)),
  };
}

function normalizeCatalog(objectInfo) {
  if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) throw new Error('ComfyUI object_info 格式无效');
  const nodes = [];
  for (const [classType, info] of Object.entries(objectInfo)) {
    if (nodes.length >= MAX_NODES) break;
    if (!classType || !info || typeof info !== 'object') continue;
    nodes.push(normalizeNode(classType, info));
  }
  return nodes.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName));
}

module.exports = { normalizeCatalog, normalizeNode, safeText };
