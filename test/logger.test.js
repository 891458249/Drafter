// logger.js smoke tests: JSONL append, field clipping, 2MB rotation (one generation).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-logger-test-'));
installElectronStub(tmp);
const logger = require('../src/main/logger');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('logRendererError: 写入带时间戳的 JSONL,字段齐全', () => {
  logger.logRendererError({ source: 'onerror', message: 'boom', stack: 'Error: boom\n  at x.js:1', url: 'app.js', line: 12, col: 3 });

  const p = logger.logPath();
  assert.ok(p.endsWith(path.join('logs', 'renderer-errors.log')));
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);

  const rec = JSON.parse(lines[0]);
  assert.ok(rec.ts && !Number.isNaN(Date.parse(rec.ts)));
  assert.strictEqual(rec.source, 'onerror');
  assert.strictEqual(rec.message, 'boom');
  assert.strictEqual(rec.line, 12);
  assert.strictEqual(rec.col, 3);
});

test('logRendererError: 单文件超 2MB 轮转为 .log.1,只保留一代', () => {
  const p = logger.logPath();
  // 直接造一个超 2MB 的现役文件和上一代备份
  fs.writeFileSync(p, 'x'.repeat(2 * 1024 * 1024 + 1));
  fs.writeFileSync(p + '.1', 'old-generation');

  logger.logRendererError({ source: 'test', message: 'after-rotate' });

  assert.strictEqual(fs.readFileSync(p + '.1', 'utf8').startsWith('xxx'), true, '旧文件应轮转为 .1');
  const cur = fs.readFileSync(p, 'utf8');
  assert.ok(cur.includes('after-rotate'), '新记录写入新文件');
  assert.ok(fs.statSync(p).size < 1024, '新文件从头部开始');
  // 上一代 'old-generation' 已被覆盖(只保留一代)
  assert.ok(!fs.readFileSync(p + '.1', 'utf8').includes('old-generation'));
});

test('logRendererError: 缺省/异常入参不抛错', () => {
  logger.logRendererError();
  logger.logRendererError({ message: 123, line: 'not-a-number' });
  const lines = fs.readFileSync(logger.logPath(), 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.message, '123');
  assert.strictEqual(last.line, null);
});
