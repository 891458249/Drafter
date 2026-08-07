// gems.js(v0.9.11):CRUD/预置播种与保护/composeAppend 截断与知识容错/媒体前缀
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-gems-test-'));
installElectronStub(tmp);
const gems = require('../src/main/gems');

beforeEach(() => {
  const store = require('../src/main/store');
  store.setSetting('gems', []);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('save/list/byId:新建与更新,name 必填', () => {
  const r = gems.save({ name: '测试 Gem', desc: 'd', instructions: 'i' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.gem.id.startsWith('gem_'));
  assert.strictEqual(gems.list().length, 1);
  assert.strictEqual(gems.byId(r.gem.id).name, '测试 Gem');
  const r2 = gems.save({ id: r.gem.id, name: '改名' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(gems.list().length, 1, '同 id 应更新而非新增');
  assert.strictEqual(gems.byId(r.gem.id).name, '改名');
  assert.strictEqual(gems.save({ name: '' }).ok, false, '空名称拒绝');
});

test('seedPresets:播种 4 个预置,重复播种不覆盖', () => {
  gems.seedPresets();
  assert.strictEqual(gems.list().length, 4);
  assert.ok(gems.list().every((g) => g.preset));
  gems.seedPresets();
  assert.strictEqual(gems.list().length, 4, '重复播种幂等');
});

test('预置保护:save/remove 拒绝 preset 项', () => {
  gems.seedPresets();
  const p = gems.list()[0];
  assert.strictEqual(gems.save({ id: p.id, name: '篡改' }).ok, false);
  assert.strictEqual(gems.remove(p.id).ok, false);
  assert.strictEqual(gems.byId(p.id).name, p.name, '预置未被改动');
});

test('knowledge:过滤不存在文件,数量截断到 10', () => {
  const f1 = path.join(tmp, 'a.md'); fs.writeFileSync(f1, 'hello');
  const kn = [{ path: f1 }, { path: path.join(tmp, '不存在.md') }];
  for (let i = 0; i < 12; i++) { const f = path.join(tmp, `k${i}.txt`); fs.writeFileSync(f, 'x'); kn.push({ path: f }); }
  const r = gems.save({ name: 'k', knowledge: kn });
  assert.strictEqual(r.gem.knowledge.length, 10, '≤10 且剔除不存在文件');
  assert.strictEqual(r.gem.knowledge[0].name, 'a.md', 'name 自动取 basename');
});

test('composeAppend:含指令/工具/知识摘录,超量截断', () => {
  const f = path.join(tmp, 'doc.md');
  fs.writeFileSync(f, '知识内容\n第二行');
  const g = gems.save({ name: 'A', desc: '说明', instructions: '指令', tools: ['Canvas'], knowledge: [{ path: f }] }).gem;
  const text = gems.composeAppend(g);
  assert.ok(text.includes('claude-ui-gem name="A"'));
  assert.ok(text.includes('指令') && text.includes('Canvas'));
  assert.ok(text.includes('知识内容'), '文本文件应内联摘录');
  // knowledgeEnabled=false 时不含知识
  const g2 = { ...g, knowledgeEnabled: false };
  assert.ok(!gems.composeAppend(g2).includes('知识内容'));
  // 缺失文件:只列路径不崩
  const g3 = { ...g, knowledge: [{ path: path.join(tmp, 'gone.md'), name: 'gone.md' }] };
  const t3 = gems.composeAppend(g3);
  assert.ok(t3.includes('gone.md') && !t3.includes('内容摘录'));
  // 截断
  const big = gems.save({ name: 'B', instructions: 'x'.repeat(50000) }).gem;
  assert.ok(gems.composeAppend(big).length <= 8000);
  assert.ok(big.instructions.length <= 30000);
});

test('composeMediaPrefix:指令前缀+用户需求分隔,无指令返回空', () => {
  const g = gems.save({ name: 'M', instructions: 'y'.repeat(5000) }).gem;
  const p = gems.composeMediaPrefix(g);
  assert.ok(p.startsWith('【以「M」的身份与要求生成】'));
  assert.ok(p.endsWith('用户需求:\n'));
  assert.ok(p.length < 5000, '指令应截断到 2000');
  assert.strictEqual(gems.composeMediaPrefix(gems.save({ name: 'N' }).gem), '');
  assert.strictEqual(gems.composeMediaPrefix(null), '');
});
