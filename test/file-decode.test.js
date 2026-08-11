// files.js decodeBuffer(v0.9.29):BOM / UTF-8 / GBK 解码与二进制采样,防代码文件乱码/误判
const { test } = require('node:test');
const assert = require('node:assert');
const { decodeBuffer } = require('../src/main/files');

test('decodeBuffer:UTF-8 无 BOM 原样解码', () => {
  assert.strictEqual(decodeBuffer(Buffer.from('你好世界 hello', 'utf8')), '你好世界 hello');
});

test('decodeBuffer:UTF-8 BOM 被剥掉', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('abc中文', 'utf8')]);
  assert.strictEqual(decodeBuffer(buf), 'abc中文');
});

test('decodeBuffer:GBK 编码的中文代码文件不乱码(中文 Windows 常见)', () => {
  // “中文” 的 GBK 编码:D6D0 CEC4;“注释” BC D7 A2 CA CD
  const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x20, 0x2F, 0x2F, 0x20, 0xD7, 0xA2, 0xCA, 0xCD]);
  assert.strictEqual(decodeBuffer(gbk), '中文 // 注释');
});

test('decodeBuffer:UTF-16LE BOM 解码', () => {
  const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('ab', 'utf16le')]);
  assert.strictEqual(decodeBuffer(buf), 'ab');
});

test('decodeBuffer:真实二进制(NUL/不可decode)不抛异常', () => {
  const bin = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0x00, 0xFE]);
  assert.doesNotThrow(() => decodeBuffer(bin));
});
