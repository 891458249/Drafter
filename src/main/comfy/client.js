// ComfyUI HTTP protocol adapter. No Electron dependency: tests inject fetch through global.fetch.
'use strict';

const fs = require('fs');
const path = require('path');
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function endpoint(connection, suffix) {
  const base = String(connection.baseUrl || '').replace(/\/+$/, '');
  return base + suffix;
}

function headers(connection, extra = {}) {
  const out = { accept: 'application/json', ...extra };
  const secret = connection.secret;
  if (!secret || connection.authType === 'none') return out;
  if (connection.authType === 'bearer') out.authorization = `Bearer ${secret}`;
  else if (connection.authType === 'apiKey') out['x-api-key'] = secret;
  else if (connection.authType === 'header') out[connection.headerName] = secret;
  return out;
}

async function request(connection, suffix, options = {}, { timeoutMs = 12000, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint(connection, suffix), {
      ...options,
      headers: headers(connection, options.headers),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 500); } catch {}
      throw new Error(`ComfyUI HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('ComfyUI 请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function json(connection, suffix, options, requestOptions) {
  const response = await request(connection, suffix, options, requestOptions);
  const length = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error('ComfyUI 响应过大');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('ComfyUI 响应过大');
  try { return JSON.parse(text); } catch { throw new Error('ComfyUI 返回了无效 JSON'); }
}

async function health(connection, options) {
  const system = await json(connection, '/system_stats', undefined, options);
  return { system, version: system.system && (system.system.comfyui_version || system.system.version) || null };
}

const objectInfo = (connection, options) => json(connection, '/object_info', undefined, options);
const queue = (connection, options) => json(connection, '/queue', undefined, options);
const history = (connection, promptId, options) => json(connection, `/history/${encodeURIComponent(promptId)}`, undefined, options);

async function submit(connection, prompt, clientId, options) {
  return json(connection, '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
  }, options);
}

async function interrupt(connection, options) {
  return json(connection, '/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, options);
}

async function deleteQueued(connection, promptId, options) {
  return json(connection, '/queue', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  }, options);
}

async function view(connection, { filename, subfolder = '', type = 'output' } = {}, requestOptions) {
  if (!filename || /[\\/]/.test(filename) || filename.includes('..')) throw new Error('ComfyUI 输出文件名无效');
  if (String(subfolder).includes('..') || String(subfolder).includes('\\')) throw new Error('ComfyUI 输出子目录无效');
  const query = new URLSearchParams({ filename: String(filename), subfolder: String(subfolder), type: String(type) }).toString();
  return request(connection, `/view?${query}`, undefined, requestOptions);
}

async function comboOptions(connection, route, options) {
  const safe = String(route || '');
  if (!safe.startsWith('/internal/') || safe.includes('..') || safe.includes('\\')) throw new Error('ComfyUI 远程选项路径无效');
  return json(connection, safe, undefined, options);
}

async function uploadImage(connection, file, options) {
  if (!file || !file.path) throw new Error('缺少要桥接的图片文件');
  const data = fs.readFileSync(file.path);
  const name = path.basename(file.name || file.path).replace(/[\\/]/g, '_') || 'image.png';
  const boundary = '----drafter-' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const response = await json(connection, '/upload/image', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat([head, data, tail]) }, options);
  if (!response || !response.name) throw new Error('ComfyUI 图片上传未返回文件名');
  if (String(response.name).includes('..') || /[\\/]/.test(String(response.name))) throw new Error('ComfyUI 返回了无效图片文件名');
  return response.subfolder ? `${response.subfolder}/${response.name}` : response.name;
}

module.exports = { MAX_JSON_BYTES, endpoint, headers, request, json, health, objectInfo, queue, history, submit, interrupt, deleteQueued, view, comboOptions, uploadImage };
