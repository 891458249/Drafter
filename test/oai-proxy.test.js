// oai-proxy.js 集成测试:真实起代理 + 假 OpenAI 后端。
// 覆盖:路由/认证(401/403/404)、非流式翻译、流式 SSE 管道、count_tokens。
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-oai-proxy-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const proxy = require('../src/main/oai-proxy');

after(async () => {
  await proxy.stop();
  if (upstream) await new Promise((r) => { try { upstream.closeAllConnections && upstream.closeAllConnections(); } catch {} upstream.close(r); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- 假 OpenAI 后端:按路径脚本化响应 -------------------------------------------
let upstream = null;
let upstreamPort = 0;
const seenRequests = [];

function sse(frames) {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
}

before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      seenRequests.push({ url: req.url, body, auth: req.headers['authorization'] });
      if (!req.url.endsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"no such route"}}');
        return;
      }
      if (body.model === 'err-429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse([
          { id: 'chatcmpl-s', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
          { id: 'chatcmpl-s', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { id: 'chatcmpl-s', model: body.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
        ]));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-n', model: body.model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
  store.setSetting('apiKeys', [
    { id: 'k_oai', name: 'OAI', key: 'sk-real-secret', baseUrl: `http://127.0.0.1:${upstreamPort}`, kind: 'authToken', protocol: 'openai', enabled: true, models: [], modelsAt: 0 },
    { id: 'k_off', name: 'Off', key: 'sk-off', baseUrl: `http://127.0.0.1:${upstreamPort}`, kind: 'authToken', protocol: 'openai', enabled: false, models: [], modelsAt: 0 },
  ]);
  await proxy.start();
});

function call(pathname, { token = 'sk-real-secret', body = {} } = {}) {
  return fetch(`http://127.0.0.1:${proxyPort()}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
}
function proxyPort() {
  return new URL(proxy.baseUrlFor('k_oai')).port;
}

test('认证与路由:错误 token 401;停用 Key 403;未知路径 404', async () => {
  const r1 = await call('/k_oai/v1/messages', { token: 'wrong', body: { model: 'm', max_tokens: 1, messages: [] } });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('/k_off/v1/messages', { token: 'sk-off', body: { model: 'm', max_tokens: 1, messages: [] } });
  assert.strictEqual(r2.status, 403);
  const r3 = await call('/k_oai/v1/nope', { body: {} });
  assert.strictEqual(r3.status, 404);
});

test('非流式:Anthropic 请求翻译成 chat/completions,响应翻回 Messages 格式', async () => {
  const r = await call('/k_oai/v1/messages', {
    body: {
      model: 'gpt-test', max_tokens: 64, system: 'S',
      messages: [{ role: 'user', content: 'ping' }],
    },
  });
  assert.strictEqual(r.status, 200);
  const json = await r.json();
  assert.strictEqual(json.type, 'message');
  assert.deepStrictEqual(json.content, [{ type: 'text', text: 'pong' }]);
  assert.deepStrictEqual(json.usage, { input_tokens: 5, output_tokens: 2 });
  const up = seenRequests.find((x) => x.body.model === 'gpt-test');
  assert.ok(up, '上游应收到请求');
  assert.strictEqual(up.auth, 'Bearer sk-real-secret', '上游认证应为存储 key 的 Bearer');
  assert.strictEqual(up.body.max_completion_tokens, 64);
  assert.deepStrictEqual(up.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'ping' }]);
});

test('流式:SSE 管道产出完整 Anthropic 事件序列与 usage', async () => {
  const r = await call('/k_oai/v1/messages', {
    body: { model: 'gpt-stream', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  assert.ok(text.includes('"text":"ok"'), 'text 增量应到达');
  assert.ok(text.includes('"input_tokens":7'), 'usage 应回填到 message_delta');
  const up = seenRequests.find((x) => x.body.model === 'gpt-stream');
  assert.strictEqual(up.body.stream, true);
  assert.deepStrictEqual(up.body.stream_options, { include_usage: true });
});

test('count_tokens:粗略估算,不打扰上游', async () => {
  const before = seenRequests.length;
  const r = await call('/k_oai/v1/messages/count_tokens', {
    body: { model: 'm', messages: [{ role: 'user', content: 'a'.repeat(400) }] },
  });
  assert.strictEqual(r.status, 200);
  const json = await r.json();
  assert.ok(json.input_tokens >= 100, '400 字符应估出 ≥100 tokens');
  assert.strictEqual(seenRequests.length, before, 'count_tokens 不应请求上游');
});

test('错误透传:上游余额 429 改写 402,原文保留在 Anthropic 错误体里', async () => {
  const r = await call('/k_oai/v1/messages', { body: { model: 'err-429', max_tokens: 1, messages: [] } });
  assert.strictEqual(r.status, 402, '余额耗尽应映射 402,避免 claude.exe 静默重试');
  const json = await r.json();
  assert.strictEqual(json.type, 'error');
  assert.ok(json.error.message.includes('no credits remaining'));
});
