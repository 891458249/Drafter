// perms.js tests: settings.local.json read-modify-write, corruption backup,
// rule removal, SDK suggestions → rule-string conversion.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const perms = require('../src/main/perms');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-perms-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const readJson = (cwd) => JSON.parse(fs.readFileSync(perms.settingsPath(cwd), 'utf8'));

test('addAllowRules: 新建文件并写入 allow 数组', () => {
  const dir = path.join(tmp, 'p1');
  fs.mkdirSync(dir);
  const r = perms.addAllowRules(dir, ['Bash(npm test:*)', 'Edit']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.added, ['Bash(npm test:*)', 'Edit']);
  assert.deepStrictEqual(readJson(dir).permissions.allow, ['Bash(npm test:*)', 'Edit']);
});

test('addAllowRules: 保留已有其他键与 deny 规则,重复规则去重', () => {
  const dir = path.join(tmp, 'p2');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(perms.settingsPath(dir), JSON.stringify({
    permissions: { allow: ['Edit'], deny: ['Bash(rm:*)'] },
    env: { FOO: 'bar' },
  }, null, 2));

  const r = perms.addAllowRules(dir, ['Edit', 'Read(//**)', 'Edit']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.added, ['Read(//**)']); // Edit 已存在,不重复

  const json = readJson(dir);
  assert.deepStrictEqual(json.permissions.allow, ['Edit', 'Read(//**)']);
  assert.deepStrictEqual(json.permissions.deny, ['Bash(rm:*)']);
  assert.strictEqual(json.env.FOO, 'bar');
});

test('addAllowRules: JSON 损坏时先备份再重建,不静默清空', () => {
  const dir = path.join(tmp, 'p3');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(perms.settingsPath(dir), '{ 损坏的 json !!!');

  const r = perms.addAllowRules(dir, ['Bash(ls:*)']);
  assert.strictEqual(r.ok, true);
  assert.ok(r.backup && fs.existsSync(r.backup), '应生成备份文件');
  assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), '{ 损坏的 json !!!', '备份保留原始内容');
  assert.deepStrictEqual(readJson(dir).permissions.allow, ['Bash(ls:*)']);
});

test('removeRule: 只删目标规则,其余保留', () => {
  const dir = path.join(tmp, 'p4');
  fs.mkdirSync(dir);
  perms.addAllowRules(dir, ['Edit', 'Bash(npm:*)', 'Write']);

  const r = perms.removeRule(dir, 'allow', 'Bash(npm:*)');
  assert.deepStrictEqual(r, { ok: true, removed: true });
  assert.deepStrictEqual(perms.listRules(dir).allow, ['Edit', 'Write']);

  // 删除不存在的规则:removed=false,文件内容不变
  const r2 = perms.removeRule(dir, 'allow', 'Bash(npm:*)');
  assert.deepStrictEqual(r2, { ok: true, removed: false });
  assert.deepStrictEqual(perms.listRules(dir).allow, ['Edit', 'Write']);
});

test('rulesFromSuggestions: 解析 addRules 建议为规则串', () => {
  const rules = perms.rulesFromSuggestions([
    { type: 'addRules', behavior: 'allow', rules: [
      { toolName: 'Bash', ruleContent: 'npm test:*' },
      { toolName: 'Edit' },
    ] },
    { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Write' }] }, // 非 allow 跳过
    'Read(//**)', // 字符串原样保留
  ]);
  assert.deepStrictEqual(rules, ['Bash(npm test:*)', 'Edit', 'Read(//**)']);
});
