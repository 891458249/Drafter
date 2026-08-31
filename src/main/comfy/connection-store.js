// ComfyUI connection persistence. Secrets remain main-process-only; list()/save() return redacted entries.
'use strict';

const crypto = require('crypto');
const store = require('../store');

const SETTING = 'comfyConnections';
const AUTH_TYPES = new Set(['none', 'bearer', 'apiKey', 'header']);

function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('服务地址必须是有效的 http/https URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址仅支持 http/https');
  if (url.username || url.password) throw new Error('服务地址不得包含用户名或密码');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function isLoopback(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
  } catch { return false; }
}

function redact(entry) {
  const { secret, ...safe } = entry;
  return {
    ...safe,
    authConfigured: !!secret,
    secretHint: secret ? '…' + secret.slice(-4) : '',
  };
}

function rawList() {
  const entries = store.getSetting(SETTING, []);
  return Array.isArray(entries) ? entries : [];
}

function list() {
  return rawList().map(redact);
}

function byId(id) {
  return rawList().find((entry) => entry.id === id) || null;
}

function save(input = {}) {
  const existing = rawList();
  const id = input.id || 'comfy_' + crypto.randomUUID().slice(0, 12);
  const index = existing.findIndex((entry) => entry.id === id);
  const previous = index >= 0 ? existing[index] : {};
  let baseUrl;
  try { baseUrl = normalizeUrl(input.baseUrl !== undefined ? input.baseUrl : previous.baseUrl); }
  catch (error) { return { ok: false, error: error.message }; }

  const authType = input.authType !== undefined ? String(input.authType || 'none') : (previous.authType || 'none');
  if (!AUTH_TYPES.has(authType)) return { ok: false, error: '不支持的认证方式' };
  const headerName = authType === 'header'
    ? String(input.headerName !== undefined ? input.headerName : previous.headerName || '').trim()
    : '';
  if (authType === 'header' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) {
    return { ok: false, error: '自定义认证头名称无效' };
  }
  const wantsInsecure = input.allowInsecureTls !== undefined ? !!input.allowInsecureTls : !!previous.allowInsecureTls;
  if (wantsInsecure && !input.insecureTlsConfirmed) {
    return { ok: false, error: '必须明确确认不安全 TLS 例外' };
  }
  const remoteHttp = baseUrl.startsWith('http://') && !isLoopback(baseUrl);
  if (remoteHttp && !input.remoteHttpConfirmed && !previous.remoteHttpConfirmed) {
    return { ok: false, error: '远程 HTTP 连接必须明确确认' };
  }
  const secret = input.secret !== undefined && String(input.secret).trim() !== ''
    ? String(input.secret).trim()
    : (previous.secret || '');
  if (authType !== 'none' && !secret) return { ok: false, error: '认证方式需要令牌或密钥' };

  const next = {
    ...previous,
    id,
    name: String(input.name || previous.name || 'ComfyUI').trim() || 'ComfyUI',
    baseUrl,
    authType,
    headerName,
    secret,
    enabled: input.enabled !== undefined ? !!input.enabled : (previous.enabled !== false),
    allowInsecureTls: wantsInsecure,
    remoteHttpConfirmed: remoteHttp ? true : false,
    updatedAt: Date.now(),
  };
  if (index >= 0) existing[index] = next; else existing.push(next);
  store.setSetting(SETTING, existing);
  return { ok: true, connection: redact(next) };
}

function remove(id) {
  const remaining = rawList().filter((entry) => entry.id !== id);
  if (remaining.length === rawList().length) return false;
  store.setSetting(SETTING, remaining);
  return true;
}

function saveHealth(id, health) {
  const entries = rawList();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  entries[index] = { ...entries[index], health: { ...health, checkedAt: Date.now() } };
  store.setSetting(SETTING, entries);
  return redact(entries[index]);
}

module.exports = { list, byId, save, remove, saveHealth, normalizeUrl, isLoopback, redact };
