// llmtext.js 测试(v0.10.1):/v1/chat/completions 单次调用,mock global fetch
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const llmtext = require('../src/main/llmtext');

const KEY = { id: 'k_1', name: 'Kuro', key: 'kuro-test-key', baseUrl: 'https://gw.example.com/v1/', kind: 'authToken' };

let calls = [];
let queue = [];
beforeEach(() => {
  calls = [];
  queue = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const next = queue.shift();
    if (!next) throw new Error('fetch 队列已空:' + url);
    return typeof next === 'function' ? next(String(url), opts) : next;
  };
});

const jsonRes = (obj, { status = 200 } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('complete:端点归一/鉴权头/messages 组装正确', async () => {
  queue = [jsonRes({ choices: [{ message: { content: '  生成的文案  ' } }] })];
  const r = await llmtext.complete(KEY, { model: 'gpt-x', prompt: '写一首诗', system: '你是诗人' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '生成的文案', '首尾空白应裁剪');
  assert.strictEqual(calls[0].url, 'https://gw.example.com/v1/chat/completions', 'baseUrl 末尾 /v1/ 归一');
  assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer kuro-test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.model, 'gpt-x');
  assert.deepStrictEqual(body.messages, [
    { role: 'system', content: '你是诗人' },
    { role: 'user', content: '写一首诗' },
  ]);
});

test('complete:无 system 时只有 user 消息', async () => {
  queue = [jsonRes({ choices: [{ message: { content: 'ok' } }] })];
  await llmtext.complete(KEY, { model: 'm', prompt: 'hi' });
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body).messages, [{ role: 'user', content: 'hi' }]);
});

test('complete:HTTP 错误透传状态与网关错误文案', async () => {
  queue = [jsonRes({ error: { message: 'model not configured' } }, { status: 403 })];
  const r = await llmtext.complete(KEY, { model: 'bad', prompt: 'hi' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /403/);
  assert.match(r.error, /model not configured/);
});

test('complete:content 为数组(分块)时拼接文本;空内容报错', async () => {
  queue = [jsonRes({ choices: [{ message: { content: [{ text: '一段' }, { text: '二段' }] } }] })];
  const r = await llmtext.complete(KEY, { model: 'm', prompt: 'hi' });
  assert.strictEqual(r.text, '一段\n二段');
  queue = [jsonRes({ choices: [{ message: { content: '' } }] })];
  const r2 = await llmtext.complete(KEY, { model: 'm', prompt: 'hi' });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /空内容/);
});

test('apiRoot/authHeaders:x-api-key 形态与 URL 归一', () => {
  assert.strictEqual(llmtext.apiRoot('https://a.com/v1'), 'https://a.com');
  assert.strictEqual(llmtext.apiRoot('https://a.com///'), 'https://a.com');
  assert.deepStrictEqual(llmtext.authHeaders({ kind: 'apiKey', key: 'k9' }), { 'x-api-key': 'k9' });
});
