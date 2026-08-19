// aigc.js 测试:创建任务 / 参考图上传链 / 轮询 / 下载(两分支),全部 mock global fetch
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aigc = require('../src/main/aigc');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-aigc-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEY = { id: 'k_1', name: 'Kuro', key: 'kuro-test-key', baseUrl: 'https://gw.example.com', kind: 'authToken' };

// fetch 调用记录 + 按序返回的响应队列
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

const jsonRes = (obj, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

// --- createTask -------------------------------------------------------------
test('createTask(image):端点/body 正确,trace_id 取响应头 X-Trace-ID', async () => {
  queue = [jsonRes({}, { headers: { 'x-trace-id': 'trace-img-1' } })];
  const r = await aigc.createTask(KEY, 'image', { modelKey: 'Vidu-q2', prompt: '一只猫' });
  assert.strictEqual(r.traceId, 'trace-img-1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://gw.example.com/aigc/api/create-image');
  assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer kuro-test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(body, { ModelKey: 'Vidu-q2', Prompt: '一只猫' });
});

test('createTask(audio):type=tts,MiniMax 模型注入默认音色', async () => {
  queue = [jsonRes({}, { headers: { 'x-trace-id': 'trace-audio-1' } })];
  const r = await aigc.createTask(KEY, 'audio', { modelKey: 'speech-2.6-hd', prompt: '你好' });
  assert.strictEqual(r.traceId, 'trace-audio-1');
  assert.strictEqual(calls[0].url, 'https://gw.example.com/aigc/api/create-audio');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.model, 'speech-2.6-hd');
  assert.strictEqual(body.type, 'tts');
  assert.strictEqual(body.text, '你好');
  assert.ok(body.voice_id, 'speech-* 模型应带默认 voice_id');
});

test('createTask(model):映射 create-3D,文生 3D,trace_id 可来自 body', async () => {
  queue = [jsonRes({ trace_id: 'trace-3d-1' })];
  const r = await aigc.createTask(KEY, 'model', { modelKey: 'Hunyuan3D-3.1', prompt: '一把椅子' });
  assert.strictEqual(r.traceId, 'trace-3d-1');
  assert.strictEqual(calls[0].url, 'https://gw.example.com/aigc/api/create-3D');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(body, { ModelKey: 'Hunyuan3D-3.1', type: 'text_to_model', prompt: '一把椅子' });
});

test('createTask(image+参考图):走 apply-upload → COS PUT → commit-upload 完整上传链', async () => {
  queue = [
    // ① apply-upload
    jsonRes({
      Response: {
        StorageBucket: 'vod-123', StorageRegion: 'ap-guangzhou',
        VodSessionKey: 'sess-abc', MediaUploadPath: '/dir/ref.jpg',
        TempCertificate: { SecretId: 'AKIDx', SecretKey: 'sk', Token: 'tok', ExpiredTime: 9999999999 },
      },
    }),
    // ② COS PUT 直传
    new Response('', { status: 200 }),
    // ③ commit-upload
    jsonRes({ Response: { FileId: 'f1', MediaUrl: 'http://vod.example.com/ref.jpg' } }),
    // ④ create-image
    jsonRes({}, { headers: { 'x-trace-id': 'trace-img-2' } }),
  ];
  const r = await aigc.createTask(KEY, 'image', {
    modelKey: 'Kling-3.0', prompt: '猫',
    refImages: [{ name: 'ref.jpg', mediaType: 'image/jpeg', data: Buffer.from('fake-jpg').toString('base64') }],
  });
  assert.strictEqual(r.traceId, 'trace-img-2');
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(calls[0].url, 'https://gw.example.com/aigc/api/apply-upload');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { MediaType: 'jpg', MediaName: 'ref.jpg' });
  // COS PUT:目标地址 + STS 签名头 + 安全 token
  assert.strictEqual(calls[1].url, 'https://vod-123.cos.ap-guangzhou.myqcloud.com/dir/ref.jpg');
  assert.strictEqual(calls[1].opts.method, 'PUT');
  assert.ok(calls[1].opts.headers.authorization.includes('q-sign-algorithm=sha1'));
  assert.strictEqual(calls[1].opts.headers['x-cos-security-token'], 'tok');
  // commit-upload 带回 VodSessionKey;create body 的 FileInfos 用 MediaUrl
  assert.deepStrictEqual(JSON.parse(calls[2].opts.body), { VodSessionKey: 'sess-abc' });
  const body = JSON.parse(calls[3].opts.body);
  assert.deepStrictEqual(body.FileInfos, [{ Type: 'Url', Category: 'Image', Usage: 'Reference', Url: 'http://vod.example.com/ref.jpg' }]);
});

test('createTask(video+参考图):Usage 用 FirstFrame 首帧语义', async () => {
  queue = [
    jsonRes({
      Response: {
        StorageBucket: 'vod-123', StorageRegion: 'ap-guangzhou',
        VodSessionKey: 'sess-abc', MediaUploadPath: '/dir/ref.png',
        TempCertificate: { SecretId: 'AKIDx', SecretKey: 'sk', Token: 'tok' },
      },
    }),
    new Response('', { status: 200 }),
    jsonRes({ Response: { MediaUrl: 'http://vod.example.com/ref.png' } }),
    jsonRes({}, { headers: { 'x-trace-id': 'trace-vid-1' } }),
  ];
  await aigc.createTask(KEY, 'video', {
    modelKey: 'Kling-3.0', prompt: '动起来',
    refImages: [{ name: 'ref.png', mediaType: 'image/png', data: Buffer.from('x').toString('base64') }],
  });
  const body = JSON.parse(calls[3].opts.body);
  assert.strictEqual(calls[3].url, 'https://gw.example.com/aigc/api/create-video');
  assert.strictEqual(body.FileInfos[0].Usage, 'FirstFrame');
});

test('createTask:HTTP 错误与缺 trace_id 都抛错', async () => {
  queue = [jsonRes({ error: 'forbidden' }, { status: 403 })];
  await assert.rejects(() => aigc.createTask(KEY, 'image', { modelKey: 'm', prompt: 'p' }), /403.*forbidden/);
  queue = [jsonRes({})];
  await assert.rejects(() => aigc.createTask(KEY, 'image', { modelKey: 'm', prompt: 'p' }), /trace_id/);
});

// --- resolveBoard(v0.9.38 创作板块合并:生成类型按模型 model_type 决定) -----------
test('resolveBoard:按模型 model_type 决定生成类型,不随会话 kind', () => {
  const typeOf = (kid, mdl) => ({ 'Kling-3.0': 'video', 'Vidu-q2': 'image', 'speech-2.6': 'audio', 'Hunyuan3D-3.1': 'model' })[mdl] || 'chat';
  assert.strictEqual(aigc.resolveBoard(typeOf, 'k1', 'Kling-3.0', 'media'), 'video');
  assert.strictEqual(aigc.resolveBoard(typeOf, 'k1', 'Vidu-q2', 'media'), 'image');
  assert.strictEqual(aigc.resolveBoard(typeOf, 'k1', 'speech-2.6', 'media'), 'audio');
  assert.strictEqual(aigc.resolveBoard(typeOf, 'k1', 'Hunyuan3D-3.1', 'media'), 'model');
});

test('resolveBoard:类型查不到回退旧 kind;都不行返回 null(调用方拦截)', () => {
  const typeOf = () => 'chat'; // 分组缺失/非 Kuro key
  assert.strictEqual(aigc.resolveBoard(typeOf, 'k1', 'unknown', 'image'), 'image', '旧 kind 兜底');
  assert.strictEqual(aigc.resolveBoard(typeOf, 'k1', 'unknown', 'media'), null, 'media 无类型可退');
  assert.strictEqual(aigc.resolveBoard(null, 'k1', 'unknown', 'video'), 'video');
  assert.strictEqual(aigc.resolveBoard(null, 'k1', 'unknown', null), null);
});

// --- pollTask ---------------------------------------------------------------
test('pollTask:状态序列推进并在终态停止', async () => {
  queue = [
    jsonRes({ status: 'pending' }),
    jsonRes({ status: 'pending' }),
    jsonRes({ status: 'processing' }),
    jsonRes({ status: 'done', file_count: 1 }),
  ];
  const seen = [];
  const h = aigc.pollTask(KEY, 'trace-p1', (st) => seen.push(st.status), { intervalMs: 1, timeoutMs: 5000 });
  const final = await h.promise;
  assert.strictEqual(final.status, 'done');
  assert.deepStrictEqual(seen, ['pending', 'processing', 'done'], '同状态不重复回调');
  assert.strictEqual(calls.length, 4, '终态后停止轮询');
  assert.ok(calls[0].url.includes('/aigc/api/task-detail?trace_id=trace-p1'));
});

test('pollTask:超过总时长按 timeout 收场', async () => {
  handler = () => jsonRes({ status: 'processing' });
  const seen = [];
  const h = aigc.pollTask(KEY, 'trace-p2', (st) => seen.push(st.status), { intervalMs: 5, timeoutMs: 30 });
  const final = await h.promise;
  assert.strictEqual(final.status, 'timeout');
  assert.strictEqual(seen[seen.length - 1], 'timeout');
  assert.ok(final.fail_reason);
});

test('pollTask:cancel 停止轮询并 resolve null', async () => {
  handler = () => jsonRes({ status: 'pending' });
  const h = aigc.pollTask(KEY, 'trace-p3', () => {}, { intervalMs: 5, timeoutMs: 5000 });
  setTimeout(() => h.cancel(), 20);
  const final = await h.promise;
  assert.strictEqual(final, null);
});

// --- downloadResults ----------------------------------------------------------
test('downloadResults:watermark_required 分支直接 GET download_url 落盘', async () => {
  const outDir = path.join(tmp, 'wm');
  queue = [
    jsonRes({
      status: 'watermark_required',
      files: [
        { index: 0, download_url: 'https://cdn.example.com/wm_0.png', filename: 'demo_0.png' },
        { index: 1, download_url: 'https://cdn.example.com/wm_1.png', filename: 'demo_1.png' },
      ],
    }),
    new Response('img0'),
    new Response('img1'),
  ];
  const files = await aigc.downloadResults(KEY, 'trace-dl-1', outDir);
  assert.strictEqual(files.length, 2);
  assert.deepStrictEqual(files.map((f) => f.name), ['demo_0.png', 'demo_1.png']);
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'demo_0.png'), 'utf8'), 'img0');
  assert.strictEqual(calls[1].url, 'https://cdn.example.com/wm_0.png');
  assert.strictEqual(calls[1].opts.headers, undefined, '水印 URL 直接 GET,不带签名');
  // 多文件模式:不传 index
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { trace_id: 'trace-dl-1' });
});

test('downloadResults:download_url 为相对路径时按 baseUrl 解析且同源带鉴权头', async () => {
  const outDir = path.join(tmp, 'wm-rel');
  queue = [
    jsonRes({
      status: 'watermark_required',
      files: [{ index: 0, download_url: '/aigc/api/download_wm_url?index=0&trace_id=t-rel', filename: 'rel_0.png' }],
    }),
    new Response('img-rel'),
  ];
  const files = await aigc.downloadResults(KEY, 't-rel', outDir);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'rel_0.png'), 'utf8'), 'img-rel');
  assert.ok(calls[1].url.startsWith('http'), '相对路径已解析为绝对 URL:' + calls[1].url);
  assert.ok(calls[1].url.includes('/aigc/api/download_wm_url'), '保留原路径与 query');
  assert.ok(calls[1].opts.headers, '同源回网关的请求带鉴权头');
});

test('downloadResults:done 分支 COS STS 签名 GET 落盘', async () => {
  const outDir = path.join(tmp, 'sts');
  queue = [
    jsonRes({
      status: 'done',
      secret_id: 'AKIDx', secret_key: 'sk', session_token: 'tok',
      bucket: 'ai-gateway-aigc-1318084580', region: 'ap-guangzhou',
      files: [{ index: 0, cos_path: 'aigc/20260408/xxx_0.png', filename: 'xxx_0.png' }],
      file_count: 1,
    }),
    new Response('png-bytes'),
  ];
  const files = await aigc.downloadResults(KEY, 'trace-dl-2', outDir);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'xxx_0.png'), 'utf8'), 'png-bytes');
  assert.strictEqual(calls[1].url, 'https://ai-gateway-aigc-1318084580.cos.ap-guangzhou.myqcloud.com/aigc/20260408/xxx_0.png');
  const h = calls[1].opts.headers;
  assert.ok(h.authorization.startsWith('q-sign-algorithm=sha1'), 'COS 请求带签名');
  assert.ok(h.authorization.includes('q-ak=AKIDx'));
  assert.strictEqual(h['x-cos-security-token'], 'tok');
});

test('downloadResults:任务未到 done 报错', async () => {
  queue = [jsonRes({ status: 'pending' }, { status: 202 })];
  await assert.rejects(() => aigc.downloadResults(KEY, 'trace-dl-3', tmp), /未到可下载状态/);
});

// --- COS 签名算法自洽性 -------------------------------------------------------
test('cosSign:产出标准 q-sign-algorithm=sha1 AuthString', () => {
  const auth = aigc.cosSign({
    method: 'GET', cosPath: '/aigc/x_0.png',
    secretId: 'AKIDx', secretKey: 'sk',
    headers: { host: 'b.cos.ap-guangzhou.myqcloud.com' },
  });
  assert.ok(auth.startsWith('q-sign-algorithm=sha1&'));
  assert.ok(auth.includes('q-ak=AKIDx'));
  assert.ok(auth.includes('q-header-list=host'));
  assert.ok(/q-signature=[0-9a-f]{40}$/.test(auth));
  assert.ok(/q-sign-time=\d+;\d+/.test(auth));
});
