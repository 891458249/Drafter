// resolveClaudeExe (F-001): SDK 原生二进制路径解析。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-sessions-test-'));
installElectronStub(tmp);
const { resolveClaudeExe } = require('../src/main/sessions');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('resolveClaudeExe: 解析到真实存在的 claude.exe,且不在 asar 归档内', () => {
  const p = resolveClaudeExe();
  assert.ok(p, '应解析出 claude.exe 路径');
  assert.ok(p.endsWith('claude.exe'), `路径应指向 claude.exe,实际 ${p}`);
  assert.ok(fs.existsSync(p), `解析结果应真实存在:${p}`);
  assert.ok(!/app\.asar(?!\.unpacked)/.test(p), '不得指向 asar 归档内路径(无法 spawn)');
});
