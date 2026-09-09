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
    assert.match(json.error.message, /未在当前会话勾选/);
    assert.deepStrictEqual(blocked, ['claude-sonnet-5']);
    assert.strictEqual(up.requests.length, 0);
  } finally {
    await guard.stop();
    up.server.close();
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
