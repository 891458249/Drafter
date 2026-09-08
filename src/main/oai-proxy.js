// 本地回环 Anthropic→OpenAI 翻译代理(v0.15.0)。
// claude.exe 只讲 Anthropic Messages 协议;protocol='openai' 的 Key(如 api.openai.com
// 官方)由 buildEnv 把 ANTHROPIC_BASE_URL 指到本服务 http://127.0.0.1:<port>/<keyId>,
// 这里把请求翻译成 OpenAI Chat Completions 转发到真实端点,响应(含 SSE 流式)翻回。
//
// 安全:只绑 127.0.0.1;入站 Bearer/x-api-key 必须与该 keyId 存储的 key 完全一致,
// 否则 403——本机其他进程无法拿本代理当免密 OpenAI 出口。
const http = require('http');
const keys = require('./keys');
const tr = require('./oai-translate');

let server = null;
let port = 0;

function isRunning() { return !!server; }

// buildEnv 注入用;须在 start() 完成后调用(boot 时 await,会话启动晚于 boot,无竞态)
function baseUrlFor(keyId) {
  if (!server || !port) throw new Error('oai-proxy 未启动');
  return `http://127.0.0.1:${port}/${keyId}`;
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendAnthropicError(res, status, message, type) {
  sendJson(res, status, { type: 'error', error: { type: type || 'api_error', message: String(message) } });
}

// 入站认证:Bearer 或 x-api-key,须与存储 key 一致
function inboundToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || '';
}

function upstreamAuthHeaders(keyEntry) {
  if (keyEntry.kind === 'apiKey') return { 'x-api-key': keyEntry.key };
  return { authorization: `Bearer ${keyEntry.key}` };
}

// 粗略 token 估算(claude.exe 的上下文统计;精确值以响应 usage 为准)
function estimateTokens(body) {
  let chars = 0;
  const walk = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body.system);
  walk(body.messages);
  return Math.max(1, Math.ceil(chars / 4));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// OpenAI SSE 字节流 → Anthropic SSE 帧写出
async function pipeStream(upstreamRes, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const translator = tr.createStreamTranslator(model);
  const emit = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  let buf = '';
  let sawDone = false;
  try {
    for await (const chunk of upstreamRes.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { sawDone = true; continue; }
          let json = null;
          try { json = JSON.parse(payload); } catch { continue; }
          for (const ev of translator.push(json)) emit(ev);
        }
      }
    }
    // 上游可能不发 [DONE] 直接结束
    if (!sawDone) { /* fallthrough,照常收尾 */ }
    for (const ev of translator.finish()) emit(ev);
    res.end();
  } catch (e) {
    console.error('[oai-proxy] stream pipe failed:', e.message);
    try { res.end(); } catch {}
  }
}

async function handleMessages(req, res, keyEntry, body) {
  const upstream = tr.oaiUrl(keyEntry.baseUrl, 'chat/completions');
  const oaiBody = tr.translateRequest(body);
  let up;
  try {
    up = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...upstreamAuthHeaders(keyEntry) },
      body: JSON.stringify(oaiBody),
    });
  } catch (e) {
    return sendAnthropicError(res, 504, '上游请求失败:' + e.message);
  }
  if (!up.ok) {
    let json = null;
    try { json = await up.json(); } catch {}
    const terr = tr.translateError(up.status, json);
    return sendJson(res, terr.status, terr.body);
  }
  if (body.stream) return pipeStream(up, res, body.model);
  try {
    const json = await up.json();
    return sendJson(res, 200, tr.translateResponse(json));
  } catch (e) {
    return sendAnthropicError(res, 502, '上游响应解析失败:' + e.message);
  }
}

function onRequest(req, res) {
  (async () => {
    if (req.method !== 'POST') return sendAnthropicError(res, 405, 'Method Not Allowed', 'invalid_request_error');
    // 路由:/<keyId>/v1/messages 或 /<keyId>/v1/messages/count_tokens
    const m = (req.url || '').match(/^\/([A-Za-z0-9_-]+)\/v1\/messages(\/count_tokens)?(\?.*)?$/);
    if (!m) return sendAnthropicError(res, 404, '未知路径:' + req.url, 'not_found_error');
    const keyEntry = keys.byId(m[1]);
    if (!keyEntry || keyEntry.enabled === false) return sendAnthropicError(res, 403, 'Key 不存在或已停用', 'permission_error');
    if (inboundToken(req) !== keyEntry.key) return sendAnthropicError(res, 401, '认证失败', 'authentication_error');
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return sendAnthropicError(res, 400, '请求体不是合法 JSON', 'invalid_request_error'); }
    if (m[2]) return sendJson(res, 200, { input_tokens: estimateTokens(body) });
    if (!body.model) return sendAnthropicError(res, 400, '缺少 model', 'invalid_request_error');
    return handleMessages(req, res, keyEntry, body);
  })().catch((e) => {
    console.error('[oai-proxy] request failed:', e.message);
    try { sendAnthropicError(res, 500, '代理内部错误:' + e.message); } catch {}
  });
}

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer(onRequest);
    server.on('error', (e) => { server = null; reject(e); });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log('[oai-proxy] listening on 127.0.0.1:' + port);
      resolve(port);
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null; port = 0;
    // keep-alive 连接会挡住 close 回调(undici fetch 默认长连),先强制断开
    try { s.closeAllConnections && s.closeAllConnections(); } catch {}
    s.close(() => resolve());
  });
}

module.exports = { start, stop, isRunning, baseUrlFor };
