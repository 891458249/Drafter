// graph/pngmeta.js 测试:PNG tEXt/iTXt chunk 扫描与 workflow/prompt 元数据提取
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

let pm;
test.beforeEach(async () => {
  pm = await import('../src/renderer/graph/pngmeta.js?v=' + Date.now());
});

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); // 解析器不校验 CRC,置 0 即可
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

function textChunk(keyword, text) {
  return chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

function itxtChunk(keyword, text, compress) {
  const payload = compress ? zlib.deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
  return chunk('iTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0]),
    Buffer.from([compress ? 1 : 0]), Buffer.from([0]), // flag + method
    Buffer.from([0]), Buffer.from([0]),                // language\0 translated\0
    payload,
  ]));
}

const IEND = chunk('IEND', Buffer.alloc(0));

test('tEXt workflow 提取', async () => {
  const wf = JSON.stringify({ nodes: [{ id: 1 }], links: [] });
  const png = Buffer.concat([SIG, textChunk('workflow', wf), IEND]);
  assert.ok(pm.isPng(png));
  const meta = await pm.extractWorkflowMeta(png);
  assert.strictEqual(meta.workflow, wf);
});

test('tEXt prompt 与 workflow 共存时都取出', async () => {
  const png = Buffer.concat([SIG, textChunk('prompt', '{"1":{}}'), textChunk('workflow', '{"nodes":[]}'), IEND]);
  const meta = await pm.extractWorkflowMeta(png);
  assert.strictEqual(meta.prompt, '{"1":{}}');
  assert.strictEqual(meta.workflow, '{"nodes":[]}');
});

test('iTXt 未压缩与 zlib 压缩均可解析(UTF-8)', async () => {
  const wf = '{"nodes":[{"title":"采样器"}]}';
  const plain = Buffer.concat([SIG, itxtChunk('workflow', wf, false), IEND]);
  assert.strictEqual((await pm.extractWorkflowMeta(plain)).workflow, wf);
  const packed = Buffer.concat([SIG, itxtChunk('workflow', wf, true), IEND]);
  assert.strictEqual((await pm.extractWorkflowMeta(packed)).workflow, wf);
});

test('非 PNG / 无元数据 / 截断文件返回 null', async () => {
  assert.strictEqual(await pm.extractWorkflowMeta(Buffer.from('not a png')), null);
  assert.strictEqual(await pm.extractWorkflowMeta(Buffer.concat([SIG, textChunk('Comment', 'hello'), IEND])), null);
  // 截断:声明长度超出实际数据
  const bad = Buffer.concat([SIG, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(9999); return b; })(), Buffer.from('tEXt'), Buffer.from('ab'), IEND]);
  assert.strictEqual(await pm.extractWorkflowMeta(bad), null);
});

test('scanChunks 遍历到 IEND 停止', () => {
  const png = Buffer.concat([SIG, textChunk('a', '1'), textChunk('b', '2'), IEND, textChunk('c', '3')]);
  const types = [...pm.scanChunks(png)].map((c) => c.type);
  assert.deepStrictEqual(types, ['tEXt', 'tEXt', 'IEND']);
});
