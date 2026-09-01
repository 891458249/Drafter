// Build a ComfyUI prompt from an external subgraph plus completed native assets.
'use strict';

const path = require('path');
const format = require('./format');
const bridge = require('../canvasBridge');
const graph = require('../canvasGraph');

function nativeText(source, all, id) {
  const type = graph.typeOfClass(source.class_type);
  if (type === 'text') return String(source.inputs && source.inputs.text || '').trim();
  if (type === 'llmtext') {
    const results = source.inputs && source.inputs.results || [];
    const adopted = results[source.inputs && source.inputs.active];
    return String(adopted && adopted.text || '').trim();
  }
  return graph.resolvePromptPreview(all, id);
}

function nativeImage(source) {
  const type = graph.typeOfClass(source.class_type);
  if (type === 'upload') return bridge.referenceFiles(source, 'IMAGE')[0] || null;
  if (type === 'image') return bridge.referenceFiles(source, 'IMAGE')[0] || null;
  return null;
}

async function projectPrompt(all, { uploadImage } = {}) {
  bridge.validateExternalLinks(all);
  const prompt = {};
  const external = Object.entries(all || {}).filter(([, node]) => node && node.inputs && node.inputs._comfyConnectionId);
  let bridgeSeq = 0;
  for (const [id, node] of external) {
    const inputs = {};
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (name.startsWith('_') || format.RUNTIME_KEYS.has(name)) continue;
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') { inputs[name] = value; continue; }
      const sourceId = String(value[0]);
      const source = all[sourceId];
      if (!source || (source.inputs && source.inputs._comfyConnectionId)) { inputs[name] = value; continue; }
      const requiredType = bridge.externalInputType(node, name);
      bridge.assertBridgeType(requiredType);
      if (['TEXT', 'STRING'].includes(String(requiredType).toUpperCase())) {
        const text = nativeText(source, all, sourceId);
        if (!text) throw new Error(`节点 ${id} 的 ${name} 需要可用文本输入`);
        inputs[name] = text;
      } else if (String(requiredType).toUpperCase() === 'IMAGE') {
        if (typeof uploadImage !== 'function') throw new Error('ComfyUI 图片桥接不可用');
        const file = nativeImage(source);
        if (!file) throw new Error(`节点 ${id} 的 ${name} 需要已完成的图片素材`);
        const uploaded = await uploadImage(file);
        const loadId = `drafter_bridge_${bridgeSeq++}`;
        prompt[loadId] = { class_type: 'LoadImage', inputs: { image: uploaded } };
        inputs[name] = [loadId, 0];
      } else {
        throw new Error(`节点 ${id} 的 ${name} 类型 ${requiredType} 尚不能由 API Key 后端桥接`);
      }
    }
    prompt[id] = { class_type: node.class_type, inputs };
  }
  return prompt;
}

module.exports = { projectPrompt };
