// 模型守卫代理:未勾选模型不得触达上游;合法模型按原协议/SSE 透传。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-model-guard-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const guard = require('../src/main/model-guard-proxy');

after(async () => { await guard.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function seedKey() {
  store.setSetting('apiKeys', [{
    id: 'k_guard', name: 'Gateway', key: 'secret-token', baseUrl: '', enabled: true,
    models: ['gpt-main', 'gpt-sub', 'claude-sonnet-5'], modelsEnabled: null,
  }]);
}

function startUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8'), auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

test('未勾选模型在本地 403,上游零请求并触发回调', async () => {
  const up = await startUpstream();
  seedKey();
  store.setSetting('apiKeys', [{
    id: 'k_guard', name: 'Gateway', key: 'secret-token', baseUrl: `http://127.0.0.1:${up.port}`, enabled: true,
    models: ['gpt-main', 'gpt-sub', 'claude-sonnet-5'], modelsEnabled: null,
  }]);
  const blocked = [];
  try {
    await guard.start();
    guard.register({
      sid: 's1', keyId: 'k_guard',
      getAllowedModels: () => ['gpt-main', 'gpt-sub'],
      onBlocked: (model) => blocked.push(model),
    });
    const res = await fetch(`${guard.baseUrlFor('s1')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 403);
    assert.match(json.error.message, /未在当前会话启用/);
    assert.deepStrictEqual(blocked, ['claude-sonnet-5']);
    assert.strictEqual(up.requests.length, 0);
  } finally {
    await guard.stop();
    up.server.close();
  }
});

test('直连网关连接失败:500 但错误为已翻译的上游人话(ECONNREFUSED),不套内部错误', async () => {
  // 占一个立刻关闭的端口,制造确定性的 ECONNREFUSED 上游
  const tmpSrv = http.createServer();
  await new Promise((r) => tmpSrv.listen(0, '127.0.0.1', r));
  const deadPort = tmpSrv.address().port;
  await new Promise((r) => tmpSrv.close(r));
  store.setSetting('apiKeys', [{
    id: 'k_guard', name: 'Gateway', key: 'secret-token', baseUrl: `http://127.0.0.1:${deadPort}`, enabled: true,
    models: ['gpt-main'], modelsEnabled: null,
  }]);
  try {
    await guard.start();
    guard.register({ sid: 's1', keyId: 'k_guard', getAllowedModels: () => ['gpt-main'], onBlocked: () => {} });
    const res = await fetch(`${guard.baseUrlFor('s1')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ model: 'gpt-main', messages: [] }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 500);
    assert.ok(json.error.message.includes('上游请求失败'), json.error.message);
    assert.ok(/ECONNREFUSED/.test(json.error.message), '应含底层 cause: ' + json.error.message);
    assert.ok(!json.error.message.includes('内部错误'), '上游连接错误不应误报内部错误: ' + json.error.message);
  } finally {
    await guard.stop();
  }
});

test('勾选模型按原请求转发并透传 SSE;策略动态读取最新勾选', async () => {
  const up = await startUpstream();
  seedKey();
  store.setSetting('apiKeys', [{
    id: 'k_guard', name: 'Gateway', key: 'secret-token', baseUrl: `http://127.0.0.1:${up.port}`, enabled: true,
    models: ['gpt-main', 'gpt-sub'], modelsEnabled: null,
  }]);
  let allowed = ['gpt-main'];
  try {
    await guard.start();
    guard.register({ sid: 's1', keyId: 'k_guard', getAllowedModels: () => allowed, onBlocked: () => {} });
    const first = await fetch(`${guard.baseUrlFor('s1')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ model: 'gpt-sub', messages: [] }),
    });
    assert.strictEqual(first.status, 403);
    assert.strictEqual(up.requests.length, 0);
    allowed = ['gpt-main', 'gpt-sub'];
    const ok = await fetch(`${guard.baseUrlFor('s1')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ model: 'gpt-sub', messages: [] }),
    });
    assert.strictEqual(ok.status, 200);
    assert.match(await ok.text(), /message_stop/);
    assert.strictEqual(up.requests.length, 1);
    assert.strictEqual(up.requests[0].url, '/v1/messages');
    assert.strictEqual(up.requests[0].auth, 'Bearer secret-token');
    assert.match(up.requests[0].body, /gpt-sub/);
  } finally {
    await guard.stop();
    up.server.close();
  }
});

test('同一会话按请求热切换协议:anthropic 直连 /v1/messages,openai 经翻译到 /v1/chat/completions', async () => {
  const oaiProxy = require('../src/main/oai-proxy');
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'c1', model: 'claude-sonnet-5', choices: [{ index: 0, message: { role: 'assistant', content: 'hi-oai' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi-anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  store.setSetting('apiKeys', [{
    id: 'k_guard', name: 'Gateway', key: 'secret-token', baseUrl: `http://127.0.0.1:${server.address().port}`, enabled: true,
    kind: 'authToken', protocol: 'anthropic', models: ['claude-sonnet-5'], modelsEnabled: null,
  }]);
  let protocol = null; // null = 跟随 Key(anthropic)
  const send = () => fetch(`${guard.baseUrlFor('s1')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  }).then((r) => r.json());
  try {
    await guard.start();
    await oaiProxy.start();
    guard.register({ sid: 's1', keyId: 'k_guard', getAllowedModels: () => ['claude-sonnet-5'], getProtocol: () => protocol, onBlocked: () => {} });
    assert.strictEqual((await send()).content[0].text, 'hi-anthropic');
    protocol = 'openai';
    const viaOai = await send();
    assert.strictEqual(viaOai.content[0].text, 'hi-oai'); // 翻回 Anthropic 形状
    protocol = 'anthropic';
    assert.strictEqual((await send()).content[0].text, 'hi-anthropic');
    assert.deepStrictEqual(requests.map((r) => r.url), ['/v1/messages', '/v1/chat/completions', '/v1/messages']);
    assert.strictEqual(requests[1].body.model, 'claude-sonnet-5'); // 非 GPT 模型也可走 OpenAI 协议
    assert.ok(Array.isArray(requests[1].body.messages));
  } finally {
    await guard.stop();
    await oaiProxy.stop();
    await new Promise((r) => server.close(r));
  }
});
