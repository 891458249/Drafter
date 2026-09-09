// 会话模型网络边界(v0.15.5):Anthropic 协议会话经 127.0.0.1 代理转发。
// 每次 /v1/messages 请求在离机前按「主模型 + 当前勾选子 Agent 模型」硬校验;
// 未勾选模型直接 403,绝不触达上游网关。Hook 管工具编排,本层兜底 SDK 内部绕路。
const http = require('http');
const keys = require('./keys');
const oaiProxy = require('./oai-proxy');

let server = null;
let port = 0;
const policies = new Map(); // sid -> { keyId, getAllowedModels, onBlocked }

function isRunning() { return !!server; }

function baseUrlFor(sid) {
  if (!server || !port) throw new Error('model-guard-proxy 未启动');
  return `http://127.0.0.1:${port}/${encodeURIComponent(sid)}`;
}

function register(policy) {
  if (!policy || !policy.sid || !policy.keyId || typeof policy.getAllowedModels !== 'function') {
    throw new Error('model guard policy 无效');
  }
  policies.set(policy.sid, policy);
}

function unregister(sid) {
  policies.delete(sid);
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendAnthropicError(res, status, message, type) {
  sendJson(res, status, { type: 'error', error: { type: type || 'api_error', message: String(message) } });
}

function inboundToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || '';
}

function upstreamAuthHeaders(keyEntry) {
  if (keyEntry.kind === 'apiKey') return { 'x-api-key': keyEntry.key };
  return { authorization: `Bearer ${keyEntry.key}` };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardHeaders(req, keyEntry) {
  const skip = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'expect']);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!skip.has(k.toLowerCase()) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  delete headers.authorization;
  delete headers['x-api-key'];
  Object.assign(headers, upstreamAuthHeaders(keyEntry));
  return headers;
}

async function pipeResponse(upstream, res) {
  const skip = new Set(['connection', 'content-length', 'transfer-encoding', 'content-encoding']);
  const headers = {};
  upstream.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) headers[key] = value;
  });
  res.writeHead(upstream.status, headers);
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (e) {
    console.error('[model-guard] response pipe failed:', e.message);
    try { res.end(); } catch {}
  }
}

async function onRequest(req, res) {
  try {
    const m = (req.url || '').match(/^\/([^/]+)(\/.*)?$/);
    if (!m) return sendAnthropicError(res, 404, '未知路径:' + req.url, 'not_found_error');
    const sid = decodeURIComponent(m[1]);
    const policy = policies.get(sid);
    if (!policy) return sendAnthropicError(res, 403, '会话模型策略不存在或已结束', 'permission_error');
    const keyEntry = keys.byId(policy.keyId);
    if (!keyEntry || keyEntry.enabled === false) return sendAnthropicError(res, 403, 'Key 不存在或已停用', 'permission_error');
    if (inboundToken(req) !== keyEntry.key) return sendAnthropicError(res, 401, '认证失败', 'authentication_error');

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const raw = hasBody ? await readBody(req) : null;
    let body = null;
    if (raw && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
    }
    const requestedModel = body && typeof body.model === 'string' ? body.model.trim() : '';
    if (requestedModel) {
      const allowed = new Set((policy.getAllowedModels() || []).filter(Boolean));
      if (!allowed.has(requestedModel)) {
        try { policy.onBlocked && policy.onBlocked(requestedModel, body); } catch {}
        return sendAnthropicError(res, 403,
          `模型 ${requestedModel} 未在当前会话勾选(允许:${[...allowed].join(', ') || '(无)'}),已在本地拦截,未发送上游`,
          'permission_error');
      }
    }

    const rest = m[2] || '/';
    // Anthropic 协议直连真实网关;OpenAI 协议继续走 oai-proxy 翻译层。
    // 本层只负责在两种协议共同的入站 Anthropic 请求上做模型白名单。
    const upstreamBase = keys.endpointOf(keyEntry).viaProxy
      ? oaiProxy.baseUrlFor(keyEntry.id)
      : keys.apiRoot(keyEntry.baseUrl);
    const upstreamUrl = upstreamBase + rest;
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders(req, keyEntry),
      body: raw || undefined,
      redirect: 'manual',
    });
    return pipeResponse(upstream, res);
  } catch (e) {
    console.error('[model-guard] request failed:', e.message);
    try { sendAnthropicError(res, 500, '模型守卫代理内部错误:' + e.message); } catch {}
  }
}

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => { onRequest(req, res); });
    server.on('error', (e) => { server = null; reject(e); });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log('[model-guard] listening on 127.0.0.1:' + port);
      resolve(port);
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) { policies.clear(); return resolve(); }
    const s = server;
    server = null; port = 0;
    policies.clear();
    try { s.closeAllConnections && s.closeAllConnections(); } catch {}
    s.close(() => resolve());
  });
}

module.exports = { start, stop, isRunning, baseUrlFor, register, unregister };
