// aux-models.js 测试:辅助模型分析(image/audio 块结构、错误兜底)与发送前注入逻辑,全部 mock global fetch
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aux = require('../src/main/aux-models');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-aux-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEY = { id: 'k_1', name: 'Kuro', key: 'kuro-test-key', baseUrl: 'https://gw.example.com', kind: 'authToken' };
const keysById = (id) => (id === 'k_1' ? KEY : null);

// fetch 调用记录 + 按序返回的响应队列(与 test/aigc.test.js 同款写法)
let calls = [];
let queue = [];
let handler = null;

function mockFetch() {
  calls = [];
  queue = [];
  handler = null;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (handler) return handler(String(url), opts);
    const next = queue.shift();
    if (!next) throw new Error('fetch 队列已空:' + url);
    return typeof next === 'function' ? next(String(url), opts) : next;
  };
}

beforeEach(mockFetch);

const jsonRes = (obj, { status = 200 } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const chatRes = (text) => jsonRes({ choices: [{ message: { content: text } }] });

// 临时媒体文件
const imgFile = path.join(tmp, 'cat.png');
const audioFile = path.join(tmp, 'voice.mp3');
fs.writeFileSync(imgFile, Buffer.from('fake-png-bytes'));
fs.writeFileSync(audioFile, Buffer.from('fake-mp3-bytes'));

// --- analyzeMedia -----------------------------------------------------------
test('analyzeMedia(image):image_url 块结构 + data url + 中文 prompt', async () => {
  queue = [chatRes('这是一只猫')];
  const r = await aux.analyzeMedia(KEY, 'qwen-vl', { name: 'cat.png', mediaKind: 'image', filePath: imgFile });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '这是一只猫');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://gw.example.com/v1/chat/completions');
  assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer kuro-test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.model, 'qwen-vl');
  const blocks = body.messages[0].content;
  assert.strictEqual(blocks[0].type, 'image_url');
  assert.strictEqual(blocks[0].image_url.url, 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64'));
  assert.strictEqual(blocks[1].type, 'text');
  assert.ok(blocks[1].text.includes('请详细描述这张图片'));
});

test('analyzeMedia(audio):input_audio 块,mp3 按扩展名取 format', async () => {
  queue = [chatRes('一段中文语音,内容是你好')];
  const r = await aux.analyzeMedia(KEY, 'qwen-audio', { name: 'voice.mp3', mediaKind: 'audio', filePath: audioFile });
  assert.strictEqual(r.ok, true);
  const blocks = JSON.parse(calls[0].opts.body).messages[0].content;
  assert.strictEqual(blocks[0].type, 'input_audio');
  assert.strictEqual(blocks[0].input_audio.format, 'mp3');
  assert.strictEqual(blocks[0].input_audio.data, Buffer.from('fake-mp3-bytes').toString('base64'));
  assert.ok(blocks[1].text.includes('请详细描述这段音频'));
});

test('analyzeMedia(audio):m4a/ogg 映射最接近的 mp3 format', async () => {
  queue = [chatRes('x'), chatRes('y')];
  await aux.analyzeMedia(KEY, 'm', { name: 'a.m4a', mediaKind: 'audio', data: 'eA==' });
  assert.strictEqual(JSON.parse(calls[0].opts.body).messages[0].content[0].input_audio.format, 'mp3');
  await aux.analyzeMedia(KEY, 'm', { name: 'a.ogg', mediaKind: 'audio', data: 'eA==' });
  assert.strictEqual(JSON.parse(calls[1].opts.body).messages[0].content[0].input_audio.format, 'mp3');
});

test('analyzeMedia:video/model 不发请求直接走兜底(ok:false)', async () => {
  const rv = await aux.analyzeMedia(KEY, 'm', { name: 'v.mp4', mediaKind: 'video', filePath: imgFile });
  assert.strictEqual(rv.ok, false);
  assert.ok(rv.error.includes('暂不支持'));
  const rm = await aux.analyzeMedia(KEY, 'm', { name: 'a.glb', mediaKind: 'model', filePath: imgFile });
  assert.strictEqual(rm.ok, false);
  assert.strictEqual(calls.length, 0, 'video/model 不应发起 HTTP 请求');
});

test('analyzeMedia:HTTP 错误与网络错误都返回 ok:false', async () => {
  queue = [jsonRes({ error: { message: 'bad model' } }, { status: 400 })];
  const r1 = await aux.analyzeMedia(KEY, 'bad', { name: 'cat.png', mediaKind: 'image', filePath: imgFile });
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.error.includes('400'));
  handler = () => { throw new Error('ECONNREFUSED'); };
  const r2 = await aux.analyzeMedia(KEY, 'm', { name: 'cat.png', mediaKind: 'image', filePath: imgFile });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.error.includes('ECONNREFUSED'));
});

test('analyzeMedia:超过 20MB 不读取不请求', async () => {
  const big = path.join(tmp, 'big.mp3');
  fs.writeFileSync(big, Buffer.alloc(aux.MAX_MEDIA_BYTES + 1));
  const r = await aux.analyzeMedia(KEY, 'm', { name: 'big.mp3', mediaKind: 'audio', filePath: big });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('20MB'));
  assert.strictEqual(calls.length, 0);
});

// --- injectMedia -------------------------------------------------------------
test('injectMedia:配置 aux 时 media_ref 块被 <附件分析> 文本替换', async () => {
  queue = [chatRes('音频转写:大家好')];
  const status = [];
  const content = [
    { type: 'media_ref', mediaKind: 'audio', name: 'voice.mp3', path: audioFile, size: 14 },
    { type: 'text', text: '这段音频说了什么?' },
  ];
  const out = await aux.injectMedia(content, {
    auxModels: { audio: 'k_1|qwen-audio' }, keysById, onStatus: (m) => status.push(m),
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].type, 'text');
  assert.ok(out[0].text.includes('<附件分析 name="voice.mp3">'));
  assert.ok(out[0].text.includes('音频转写:大家好'));
  assert.deepStrictEqual(out[1], content[1], '普通文本块不受影响');
  assert.strictEqual(calls.length, 1);
  assert.ok(status.some((m) => m.includes('voice.mp3')), '分析期间有进度提示');
});

test('injectMedia:未配置 aux 的 media_ref 注入元信息兜底文本', async () => {
  const content = [{ type: 'media_ref', mediaKind: 'video', name: 'demo.mp4', path: 'D:\\media\\demo.mp4', size: 12 * 1024 * 1024 }];
  const out = await aux.injectMedia(content, { auxModels: {}, keysById });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'text');
  assert.ok(out[0].text.includes('<附件 name="demo.mp4">'));
  assert.ok(out[0].text.includes('视频'));
  assert.ok(out[0].text.includes('12.0 MB'));
  assert.ok(out[0].text.includes('D:\\media\\demo.mp4'));
  assert.ok(out[0].text.includes('配置辅助模型'));
  assert.strictEqual(calls.length, 0, '未配置时不发请求');
});

test('injectMedia:配置了但分析失败 → 元信息兜底并带失败原因', async () => {
  queue = [jsonRes({ error: 'boom' }, { status: 500 })];
  const content = [{ type: 'media_ref', mediaKind: 'audio', name: 'voice.mp3', path: audioFile, size: 14 }];
  const out = await aux.injectMedia(content, { auxModels: { audio: 'k_1|qwen-audio' }, keysById });
  assert.strictEqual(out[0].type, 'text');
  assert.ok(out[0].text.includes('<附件 name="voice.mp3">'));
  assert.ok(out[0].text.includes('辅助分析失败'));
  assert.ok(out[0].text.includes('500'));
});

test('injectMedia:图片块未配置图像辅助时原样保留', async () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } };
  const out = await aux.injectMedia([img, { type: 'text', text: '看图' }], { auxModels: {}, keysById });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0], img, 'image block 原样保留(同一引用)');
  assert.strictEqual(calls.length, 0);
});

test('injectMedia:配置图像辅助时 image block 保留 + 追加分析文本', async () => {
  queue = [chatRes('图中是一只橘猫')];
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } };
  const out = await aux.injectMedia([img], { auxModels: { image: 'k_1|qwen-vl' }, keysById });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0], img, 'image block 仍在且直发主模型');
  assert.strictEqual(out[1].type, 'text');
  assert.ok(out[1].text.includes('<附件分析'));
  assert.ok(out[1].text.includes('图中是一只橘猫'));
  // 分析请求用的是块内 base64,不读文件
  const blocks = JSON.parse(calls[0].opts.body).messages[0].content;
  assert.strictEqual(blocks[0].image_url.url, 'data:image/png;base64,eA==');
});

test('injectMedia:字符串 content 与无媒体块数组原样返回', async () => {
  const s = '纯文本消息';
  assert.strictEqual(await aux.injectMedia(s, { auxModels: {}, keysById }), s);
  const arr = [{ type: 'text', text: '没有附件' }];
  assert.strictEqual(await aux.injectMedia(arr, { auxModels: {}, keysById }), arr);
  assert.strictEqual(calls.length, 0);
});

test('injectMedia:aux 配置指向不存在的 key 时走元信息兜底', async () => {
  const content = [{ type: 'media_ref', mediaKind: 'audio', name: 'voice.mp3', path: audioFile, size: 14 }];
  const out = await aux.injectMedia(content, { auxModels: { audio: 'k_gone|m' }, keysById });
  assert.ok(out[0].text.includes('<附件 name="voice.mp3">'));
  assert.strictEqual(calls.length, 0);
});
