// aux-models.js 测试:辅助模型分析(image/audio 块结构、错误兜底)与发送前注入逻辑,全部 mock global fetch
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aux = require('../src/main/aux-models');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-aux-test-'));
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
const videoFile = path.join(tmp, 'demo.mp4');
fs.writeFileSync(imgFile, Buffer.from('fake-png-bytes'));
fs.writeFileSync(audioFile, Buffer.from('fake-mp3-bytes'));
fs.writeFileSync(videoFile, Buffer.from('fake-mp4-bytes'));

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

test('analyzeMedia(video):注入抽帧器时走多 image_url 块(Responses 网关无视频入参,v0.15.12)', async () => {
  queue = [chatRes('一段猫在客厅跑动的视频')];
  const deps = { extractFrames: async (fp) => ({ ok: true, frames: [{ t: 0.5, jpeg: 'ZjE=' }, { t: 1.5, jpeg: 'ZjI=' }], duration: 3 }) };
  const r = await aux.analyzeMedia(KEY, 'gpt-6-astra', { name: 'demo.mp4', mediaKind: 'video', filePath: videoFile }, { deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '一段猫在客厅跑动的视频');
  assert.strictEqual(calls.length, 1);
  const blocks = JSON.parse(calls[0].opts.body).messages[0].content;
  assert.strictEqual(blocks[0].type, 'image_url');
  assert.strictEqual(blocks[0].image_url.url, 'data:image/jpeg;base64,ZjE=');
  assert.strictEqual(blocks[1].type, 'image_url');
  assert.strictEqual(blocks[2].type, 'text');
  assert.ok(blocks[2].text.includes('关键帧'));
  assert.ok(blocks[2].text.includes('2 个关键帧'));
});

test('analyzeMedia(video):图像通道失败时回退 video_url 块', async () => {
  // 第一次(图像通道)400,第二次(video_url 回退)成功
  queue = [jsonRes({ error: { message: 'no image' } }, { status: 400 }), chatRes('回退成功')];
  const deps = { extractFrames: async () => ({ ok: true, frames: [{ t: 0.5, jpeg: 'ZjE=' }], duration: 1 }) };
  const r = await aux.analyzeMedia(KEY, 'qwen-vl', { name: 'demo.mp4', mediaKind: 'video', filePath: videoFile }, { deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '回退成功');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(JSON.parse(calls[0].opts.body).messages[0].content[0].type, 'image_url');
  const blocks2 = JSON.parse(calls[1].opts.body).messages[0].content;
  assert.strictEqual(blocks2[0].type, 'video_url');
  assert.strictEqual(blocks2[0].video_url.url, 'data:video/mp4;base64,' + Buffer.from('fake-mp4-bytes').toString('base64'));
});

test('analyzeMedia(video):无抽帧器时直接走 video_url 块(原生多模态网关)', async () => {
  queue = [chatRes('x'), chatRes('y')];
  await aux.analyzeMedia(KEY, 'm', { name: 'a.mov', mediaKind: 'video', data: 'eA==' });
  assert.ok(JSON.parse(calls[0].opts.body).messages[0].content[0].video_url.url.startsWith('data:video/quicktime;base64,'));
  await aux.analyzeMedia(KEY, 'm', { name: 'a.webm', mediaKind: 'video', data: 'eA==' });
  assert.ok(JSON.parse(calls[1].opts.body).messages[0].content[0].video_url.url.startsWith('data:video/webm;base64,'));
});

test('analyzeMedia:model 不发请求直接走兜底(ok:false)', async () => {
  const rm = await aux.analyzeMedia(KEY, 'm', { name: 'a.glb', mediaKind: 'model', filePath: imgFile });
  assert.strictEqual(rm.ok, false);
  assert.ok(rm.error.includes('暂不支持'));
  assert.strictEqual(calls.length, 0, 'model 不应发起 HTTP 请求');
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

test('injectMedia:配置视频辅助时 media_ref(video) 被 <附件分析> 替换(v0.15.12)', async () => {
  queue = [chatRes('视频内容:猫在客厅跑动')];
  const content = [
    { type: 'media_ref', mediaKind: 'video', name: 'demo.mp4', path: videoFile, size: 15 },
    { type: 'text', text: '视频里有什么?' },
  ];
  const out = await aux.injectMedia(content, { auxModels: { video: 'k_1|qwen-vl' }, keysById });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].type, 'text');
  assert.ok(out[0].text.includes('<附件分析 name="demo.mp4">'));
  assert.ok(out[0].text.includes('视频内容:猫在客厅跑动'));
  // 单测无 electron,抽帧器为 null → 回退 video_url,一次请求
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(JSON.parse(calls[0].opts.body).messages[0].content[0].type, 'video_url');
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

// --- 跨 Key 兜底(v0.15.15) ---------------------------------------------------
const KEY2 = { id: 'k_2', name: 'Kimi', key: 'kimi-test-key', baseUrl: 'https://kimi.example.com', kind: 'authToken' };
const keysById2 = (id) => (id === 'k_1' ? KEY : id === 'k_2' ? KEY2 : null);
const listKeys2 = () => [KEY, KEY2];

test('injectMedia:配置 key 失败(429)时自动兜底到其他 key 的模型', async () => {
  const status = [];
  handler = (url, opts) => {
    if (url.endsWith('/v1/models')) return jsonRes({ data: [{ id: 'text-embedding-3' }, { id: 'k3' }] });
    if (url.includes('gw.example.com')) return jsonRes({ error: { message: '额度已用完' } }, { status: 429 });
    if (url.includes('kimi.example.com')) return jsonRes({ choices: [{ message: { content: '兜底分析:一段语音' } }] });
    throw new Error('unexpected url ' + url);
  };
  const content = [{ type: 'media_ref', mediaKind: 'audio', name: 'voice.mp3', path: audioFile, size: 14 }];
  const out = await aux.injectMedia(content, {
    auxModels: { audio: 'k_1|qwen-audio' }, keysById: keysById2, listKeys: listKeys2, onStatus: (m) => status.push(m),
  });
  assert.ok(out[0].text.includes('<附件分析 name="voice.mp3">'));
  assert.ok(out[0].text.includes('兜底分析:一段语音'));
  // 调用序:主 key chat(429)→ 兜底 key GET models → 兜底 key chat(成功)
  assert.strictEqual(calls.length, 3);
  assert.ok(calls[0].url.includes('gw.example.com/v1/chat/completions'));
  assert.ok(calls[1].url.includes('kimi.example.com/v1/models'));
  assert.ok(calls[2].url.includes('kimi.example.com/v1/chat/completions'));
  // 非多模态模型被过滤,兜底用的是 k3;认证头用兜底 key
  const body = JSON.parse(calls[2].opts.body);
  assert.strictEqual(body.model, 'k3');
  assert.strictEqual(calls[2].opts.headers.authorization, 'Bearer kimi-test-key');
  assert.ok(status.some((m) => m.includes('Kimi')), '兜底进度提示含 key 名');
});

test('injectMedia:兜底链全部失败 → 元信息兜底并聚合各 key 错误', async () => {
  handler = (url) => {
    if (url.endsWith('/v1/models')) return jsonRes({ data: [{ id: 'k3' }] });
    return jsonRes({ error: { message: 'down' } }, { status: 500 });
  };
  const content = [{ type: 'media_ref', mediaKind: 'audio', name: 'voice.mp3', path: audioFile, size: 14 }];
  const out = await aux.injectMedia(content, {
    auxModels: { audio: 'k_1|qwen-audio' }, keysById: keysById2, listKeys: listKeys2,
  });
  assert.ok(out[0].text.includes('<附件 name="voice.mp3">'));
  assert.ok(out[0].text.includes('辅助分析失败'));
  assert.ok(out[0].text.includes('Kimi/k3'), '兜底 key 的错误也聚合进原因');
});

test('injectMedia:未传 listKeys 时不触发兜底(旧行为)', async () => {
  queue = [jsonRes({ error: 'boom' }, { status: 429 })];
  const content = [{ type: 'media_ref', mediaKind: 'audio', name: 'voice.mp3', path: audioFile, size: 14 }];
  const out = await aux.injectMedia(content, { auxModels: { audio: 'k_1|qwen-audio' }, keysById });
  assert.ok(out[0].text.includes('<附件 name="voice.mp3">'));
  assert.strictEqual(calls.length, 1, '不拉 models 列表,不重试');
});

test('injectMedia:3D 模型不触发兜底(本就无 chat 入参)', async () => {
  const content = [{ type: 'media_ref', mediaKind: 'model', name: 'a.glb', path: imgFile, size: 14 }];
  const out = await aux.injectMedia(content, {
    auxModels: { model: 'k_1|qwen' }, keysById: keysById2, listKeys: listKeys2,
  });
  assert.ok(out[0].text.includes('<附件 name="a.glb">'));
  assert.ok(out[0].text.includes('暂不支持'));
  assert.strictEqual(calls.length, 0, '3D 不应发任何请求,也不应拉兜底 models');
});

test('rankVisionCandidates:剔除非多模态模型,视觉线索排前', () => {
  const ranked = aux.rankVisionCandidates(['text-embedding-3', 'llama-3-8b', 'qwen-vl-max', 'whisper-1', 'k3']);
  assert.deepStrictEqual(ranked, ['qwen-vl-max', 'k3', 'llama-3-8b']);
});
