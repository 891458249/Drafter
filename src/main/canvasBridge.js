// Standard-asset bridge for unified Canvas backends.
// Only serializable assets may cross API-key and ComfyUI boundaries; inference
// internals (LATENT/MODEL/CLIP/VAE/CONDITIONING) must remain in their backend.
'use strict';

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|ogg|flac)$/i;
const PRIVATE_TYPES = new Set(['LATENT', 'MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'SIGMAS', 'GUIDER', 'SAMPLER']);
const STANDARD_TYPES = new Set(['TEXT', 'STRING', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE']);

function assetKind(file = {}) {
  const name = String(file.name || file.filename || '');
  if (IMAGE_RE.test(name)) return 'IMAGE';
  if (VIDEO_RE.test(name)) return 'VIDEO';
  if (AUDIO_RE.test(name)) return 'AUDIO';
  return 'FILE';
}

function isPrivateComfyType(type) {
  return PRIVATE_TYPES.has(String(type || '').trim().toUpperCase());
}

function assertBridgeType(type) {
  const normalized = String(type || '').trim().toUpperCase();
  if (isPrivateComfyType(normalized)) throw new Error(`ComfyUI 私有运行态 ${type} 不能跨后端传递；请先在 ComfyUI 内转换为图片、视频、音频或文本。`);
  if (!STANDARD_TYPES.has(normalized)) throw new Error(`ComfyUI 类型 ${type || 'UNKNOWN'} 不能跨后端传递；仅支持文本、图片、视频、音频和文件。`);
  return true;
}

function externalInputType(node, inputName) {
  const types = node && node.inputs && node.inputs._comfyInputTypes;
  return types && types[inputName] || null;
}

function validateExternalLinks(graph) {
  for (const [id, node] of Object.entries(graph || {})) {
    if (!node || !node.inputs || !node.inputs._comfyConnectionId) continue;
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') continue;
      const source = graph[String(value[0])];
      if (!source || (source.inputs && source.inputs._comfyConnectionId)) continue;
      const requiredType = externalInputType(node, name);
      if (requiredType) assertBridgeType(requiredType);
    }
  }
  return true;
}

function adoptedFiles(node) {
  const inputs = node && node.inputs || {};
  const tasks = Array.isArray(inputs.tasks) ? inputs.tasks : [];
  const task = tasks[inputs.active];
  return task && task.status === 'done' && Array.isArray(task.files) ? task.files : [];
}

function referenceFiles(node, acceptedKind = 'IMAGE') {
  const inputs = node && node.inputs || {};
  if (inputs.file && inputs.file.path) return acceptedKind === 'IMAGE' ? [{ path: inputs.file.path, name: inputs.file.name || 'reference' }] : [];
  return adoptedFiles(node).filter((file) => assetKind(file) === acceptedKind && file.path).map((file) => ({ path: file.path, name: file.name }));
}

module.exports = { assetKind, isPrivateComfyType, assertBridgeType, externalInputType, validateExternalLinks, adoptedFiles, referenceFiles };
