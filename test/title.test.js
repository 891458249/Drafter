// title.js 测试:自动命名(模型概括成功/失败退化/标题清洗/不覆盖手动命名),mock global fetch
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const title = require('../src/main/title');

const KEY = { id: 'k_1', name: 'Kuro', key: 'kuro-test-key', baseUrl: 'https://gw.example.com', kind: 'authToken' };

let calls = [];
let queue = [];
function mockFetch() {
  calls = [];
  queue = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const next = queue.shift();
    if (!next) throw new Error('fetch 队列已空:' + url);
    return typeof next === 'function' ? next(String(url), opts) : next;
  };
}
beforeEach(mockFetch);

const jsonRes = (obj, { status = 200 } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const chatRes = (text) => jsonRes({ choices: [{ message: { content: text } }] });

// --- summarizeTitle -----------------------------------------------------------
test('summarizeTitle:走 /v1/chat/completions 并清洗输出', async () => {
  queue = [chatRes('「整理报销流程。」\n')];
  const t = await title.summarizeTitle('帮我把这个月的报销单整理一下', { keyEntry: KEY, model: 'qwen-chat' });
  assert.strictEqual(t, '整理报销流程');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://gw.example.com/v1/chat/completions');
  assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer kuro-test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.model, 'qwen-chat');
  assert.ok(body.messages[0].content.includes('报销单'));
});

test('summarizeTitle:HTTP 错误 / 无 key / 无模型 返回 null', async () => {
  queue = [jsonRes({}, { status: 500 })];
  assert.strictEqual(await title.summarizeTitle('你好', { keyEntry: KEY, model: 'm' }), null);
  assert.strictEqual(await title.summarizeTitle('你好', { keyEntry: null, model: 'm' }), null);
  assert.strictEqual(await title.summarizeTitle('你好', { keyEntry: KEY, model: null }), null);
});

test('summarizeTitle:输出超长按 20 字截断', async () => {
  queue = [chatRes('这是一个非常非常非常非常非常非常非常长的标题输出')] ;
  const t = await title.summarizeTitle('x', { keyEntry: KEY, model: 'm' });
  assert.strictEqual(t.length, 20);
});

// --- fallbackTitle ------------------------------------------------------------
test('fallbackTitle:取首行前 20 字,空文本兜底「新会话」', () => {
  assert.strictEqual(title.fallbackTitle('\n  帮我写一个贪吃蛇游戏\n第二步...'), '帮我写一个贪吃蛇游戏');
  assert.strictEqual(title.fallbackTitle('   '), '新会话');
});

// --- autoTitle ----------------------------------------------------------------
test('autoTitle:模型成功时应用概括标题', async () => {
  queue = [chatRes('贪吃蛇游戏开发')];
  let applied = null;
  const r = await title.autoTitle('帮我写贪吃蛇', {
    keyEntry: KEY, model: 'm',
    getCurrentTitle: () => null,
    applyTitle: (t) => { applied = t; },
  });
  assert.strictEqual(r, '贪吃蛇游戏开发');
  assert.strictEqual(applied, '贪吃蛇游戏开发');
});

test('autoTitle:模型失败时退化为截取标题,且不发第二次请求', async () => {
  queue = [() => { throw new Error('network down'); }];
  let applied = null;
  const r = await title.autoTitle('第一行内容\n第二行', {
    keyEntry: KEY, model: 'm',
    getCurrentTitle: () => null,
    applyTitle: (t) => { applied = t; },
  });
  assert.strictEqual(r, '第一行内容');
  assert.strictEqual(applied, '第一行内容');
});

test('autoTitle:用户已手动命名时不覆盖', async () => {
  queue = [chatRes('模型生成的标题')];
  let applied = null;
  const r = await title.autoTitle('随便聊聊', {
    keyEntry: KEY, model: 'm',
    getCurrentTitle: () => '我的手写标题',
    applyTitle: (t) => { applied = t; },
  });
  assert.strictEqual(r, null);
  assert.strictEqual(applied, null);
});
