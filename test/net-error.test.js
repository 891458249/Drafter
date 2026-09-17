// net-error.js 单元测试:fetch 失败时的 cause 链展开与人话提示。
const { test } = require('node:test');
const assert = require('node:assert');
const { netErrorText } = require('../src/main/net-error');

function fetchFailed(code, message) {
  const cause = new Error(message || 'read ' + code);
  cause.code = code;
  return new TypeError('fetch failed', { cause });
}

test('fetch failed + ECONNRESET:展开 cause 并给出「域名可能被阻断」提示', () => {
  const t = netErrorText(fetchFailed('ECONNRESET'));
  assert.ok(t.includes('fetch failed'), '外壳 message 应保留: ' + t);
  assert.ok(t.includes('ECONNRESET'), '底层 code 应出现: ' + t);
  assert.ok(t.includes('连接被重置'), '应有人话提示: ' + t);
  assert.ok(t.includes('阻断'), '应提示可能被网络阻断: ' + t);
});

test('ENOTFOUND → DNS 解析失败提示', () => {
  const t = netErrorText(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND xhspeed.xyz'));
  assert.ok(t.includes('DNS'), t);
});

test('ETIMEDOUT 与 undici 连接超时 → 连接超时提示', () => {
  assert.ok(netErrorText(fetchFailed('ETIMEDOUT')).includes('连接超时'));
  const e = new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.ok(netErrorText(e).includes('连接超时'));
});

test('ECONNREFUSED → 连接被拒绝提示', () => {
  const t = netErrorText(fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'));
  assert.ok(t.includes('连接被拒绝'), t);
});

test('TLS 证书错误 → 证书提示', () => {
  const t = netErrorText(fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'));
  assert.ok(t.includes('TLS'), t);
});

test('多级 cause 链逐级拼接且不重复;无 cause 只回 message;空值兜底', () => {
  const inner = new Error('boom'); inner.code = 'EINNER';
  const top = new Error('top', { cause: new Error('mid', { cause: inner }) });
  assert.strictEqual(netErrorText(top), 'top(mid <= EINNER: boom)');
  assert.strictEqual(netErrorText(new Error('plain')), 'plain');
  assert.strictEqual(netErrorText(null), '未知网络错误');
  assert.strictEqual(netErrorText(undefined), '未知网络错误');
});

test('code 已含在 message 里时不重复打印 code', () => {
  const t = netErrorText(fetchFailed('ECONNRESET', 'read ECONNRESET'));
  assert.strictEqual(t.match(/ECONNRESET/g).length >= 1, true);
  assert.ok(!t.includes('ECONNRESET: read ECONNRESET'), '不应出现 code: message 重复: ' + t);
});
