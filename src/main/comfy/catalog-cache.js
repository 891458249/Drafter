// 本机 ComfyUI 节点目录磁盘缓存(v0.13.9):
// comfyLocalCatalog 每次拉取成功后落盘 userData/comfy-local-catalog.json;
// ComfyUI 离线时回退到缓存目录,节点浏览器不再「丢节点」。
// 缓存仅 normalized catalog(渲染端安全数据,无凭据);>8MB 视为异常不落盘。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 8 * 1024 * 1024;
const cachePath = () => path.join(app.getPath('userData'), 'comfy-local-catalog.json');

function write(catalog) {
  try {
    if (!Array.isArray(catalog) || !catalog.length) return false;
    const payload = JSON.stringify({ cachedAt: Date.now(), catalog });
    if (payload.length > MAX_BYTES) return false;
    fs.writeFileSync(cachePath(), payload, 'utf8');
    return true;
  } catch { return false; }
}

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (!j || !Array.isArray(j.catalog) || !j.catalog.length) return null;
    return { catalog: j.catalog, cachedAt: j.cachedAt || 0 };
  } catch { return null; }
}

function clear() {
  try { fs.unlinkSync(cachePath()); } catch {}
}

module.exports = { write, read, clear };
