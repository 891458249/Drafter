// comfy/catalog-cache.js 测试:目录磁盘缓存(写/读/清/超限守卫)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-catcache-'));
installElectronStub(tmp);
const cache = require('../src/main/comfy/catalog-cache');

test('写入后可读回,带 cachedAt', () => {
  const catalog = [{ classType: 'KSampler', displayName: 'K采样器', category: 'sampling', inputs: [], outputs: ['LATENT'] }];
  assert.strictEqual(cache.write(catalog), true);
  const r = cache.read();
  assert.ok(r);
  assert.strictEqual(r.catalog[0].classType, 'KSampler');
  assert.ok(r.cachedAt > 0);
});

test('空目录/非数组不落盘;无缓存时读为 null', () => {
  cache.clear();
  assert.strictEqual(cache.read(), null);
  assert.strictEqual(cache.write([]), false);
  assert.strictEqual(cache.write(null), false);
  assert.strictEqual(cache.read(), null);
});

test('超大目录(>8MB)拒绝落盘', () => {
  cache.clear();
  const huge = [{ classType: 'X'.repeat(9 * 1024 * 1024) }];
  assert.strictEqual(cache.write(huge), false);
  assert.strictEqual(cache.read(), null);
});

test('clear 幂等', () => {
  cache.write([{ classType: 'A' }]);
  cache.clear();
  cache.clear(); // 再删不炸
  assert.strictEqual(cache.read(), null);
});
