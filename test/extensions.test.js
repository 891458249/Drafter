// extensions.js(v0.15.16):CRUD/预置保护与播种/渐进披露三件套/作用域过滤/导入导出往返/AI prompt
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-ext-test-'));
installElectronStub(tmp);
const ext = require('../src/main/extensions');

beforeEach(() => {
  const store = require('../src/main/store');
  store.setSetting('extensions', { skills: [], agents: [] });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
test('save/list/byId:skill 与 agent 独立存储,name 必填', () => {
  const rs = ext.save('skill', { name: '技能A', desc: 'd', instructions: 'i' });
  assert.strictEqual(rs.ok, true);
  assert.ok(rs.item.id.startsWith('skill_'));
  const ra = ext.save('agent', { name: 'reviewer', prompt: 'p' });
  assert.ok(ra.item.id.startsWith('agent_'));
  assert.strictEqual(ext.list('skill').length, 1);
  assert.strictEqual(ext.list('agent').length, 1);
  assert.strictEqual(ext.byId('skill', ra.item.id), null, '跨 kind 不可见');
  assert.strictEqual(ext.save('skill', { name: '  ' }).ok, false, '空白名称拒绝');
  assert.strictEqual(ext.save('nope', { name: 'x' }).ok, false, '未知 kind 拒绝');
});

test('save:同 id 更新;字段截断与兜底', () => {
  const r = ext.save('skill', { name: 'A', files: [{ name: 'f.md', content: 'x' }, { bad: true }] });
  assert.strictEqual(r.item.files.length, 1, '缺 name 的文件被剔除');
  const r2 = ext.save('skill', { id: r.item.id, name: 'B'.repeat(100), enabled: false, files: r.item.files });
  assert.strictEqual(ext.list('skill').length, 1);
  assert.strictEqual(r2.item.name.length, 60);
  assert.strictEqual(r2.item.enabled, false);
  assert.strictEqual(r2.item.files.length, 1, '更新时文件保留');
  const ra = ext.save('agent', { name: 'X', scope: 'bogus' });
  assert.strictEqual(ra.item.scope, 'global', '非法 scope 回退 global');
  assert.strictEqual(ra.item.scopeId, null);
});

test('remove:预置保护', () => {
  ext.seedPresets();
  const p = ext.list('skill')[0];
  assert.strictEqual(ext.remove('skill', p.id).ok, false);
  assert.strictEqual(ext.save('skill', { id: p.id, name: '篡改' }).ok, false);
  const mine = ext.save('skill', { name: '我的' });
  assert.strictEqual(ext.remove('skill', mine.item.id).ok, true);
});

test('seedPresets:3 skill + 3 agent,幂等', () => {
  ext.seedPresets();
  assert.strictEqual(ext.list('skill').length, 3);
  assert.strictEqual(ext.list('agent').length, 3);
  assert.ok(ext.list('agent').every((a) => a.scope === 'global' && a.preset));
  ext.seedPresets();
  assert.strictEqual(ext.list('skill').length, 3, '重复播种幂等');
});

// ---------------------------------------------------------------------------
// 渐进披露
// ---------------------------------------------------------------------------
function mkSkill(name, opts = {}) {
  return ext.save('skill', { name, desc: opts.desc || 'd-' + name, instructions: 'ins-' + name, ...opts }).item;
}

test('mountedSkills:按挂载 id 取启用中技能,保持顺序,跳过禁用/不存在', () => {
  const a = mkSkill('A'), b = mkSkill('B'), c = mkSkill('C');
  ext.save('skill', { ...b, enabled: false });
  const out = ext.mountedSkills([c.id, b.id, a.id, 'skill_ghost']);
  assert.deepStrictEqual(out.map((s) => s.name), ['C', 'A']);
  assert.deepStrictEqual(ext.mountedSkills(null), []);
  assert.deepStrictEqual(ext.mountedSkills([]), []);
});

test('buildSkillsIndex:名称+描述索引;无 pinned 无优先标注', () => {
  const a = mkSkill('审查'), b = mkSkill('提交');
  const idx = ext.buildSkillsIndex([a, b], []);
  assert.ok(idx.includes('<drafter-skills>') && idx.includes('use_skill'));
  assert.ok(idx.includes('- 审查: d-审查') && idx.includes('- 提交: d-提交'));
  assert.ok(!idx.includes('手动指定'));
  assert.strictEqual(ext.buildSkillsIndex([], []), '');
});

test('buildSkillsIndex:pinned 标注最高优先级', () => {
  const a = mkSkill('审查'), b = mkSkill('提交');
  const idx = ext.buildSkillsIndex([a, b], [a.id]);
  assert.ok(idx.includes('手动指定技能「审查」'));
  assert.ok(idx.includes('优先级最高'));
  assert.ok(!idx.includes('提交」'), '未 pinned 的不进优先标注');
});

test('composePinnedSkills:全文块含指令与文件摘录,总量截断', () => {
  const a = mkSkill('A', { files: [{ name: 'ref.md', content: '参考内容\n第二行' }] });
  const text = ext.composePinnedSkills([a]);
  assert.ok(text.includes('<drafter-skill name="A">'));
  assert.ok(text.includes('ins-A') && text.includes('参考内容'));
  const big = mkSkill('BIG', { instructions: 'x'.repeat(20000) });
  assert.ok(ext.composePinnedSkills([big]).length <= 8000, '总量截断 8000');
  assert.strictEqual(ext.composePinnedSkills([]), '');
});

test('useSkill:命中挂载返回全文;已 pinned 提示直接用;未挂载报错', () => {
  const a = mkSkill('A'), b = mkSkill('B');
  const hit = ext.useSkill('A', [a.id, b.id], []);
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.instructions, 'ins-A');
  const pinned = ext.useSkill('A', [a.id], [a.id]);
  assert.strictEqual(pinned.alreadyPinned, true);
  const miss = ext.useSkill('不存在', [a.id], []);
  assert.strictEqual(miss.ok, false);
  assert.ok(miss.error.includes('A'), '错误里列出可用技能');
  // 禁用后视为未挂载
  ext.save('skill', { ...a, enabled: false });
  assert.strictEqual(ext.useSkill('A', [a.id], []).ok, false);
});

// ---------------------------------------------------------------------------
// 自定义 Agent:作用域过滤 + 定义构建
// ---------------------------------------------------------------------------
function mkAgent(name, opts = {}) {
  return ext.save('agent', { name, desc: 'd', prompt: 'p-' + name, ...opts }).item;
}

test('buildCustomAgents:global 恒生效;project/session 按 meta 过滤', () => {
  mkAgent('g1');
  mkAgent('p1', { scope: 'project', scopeId: 'proj-1' });
  mkAgent('s1', { scope: 'session', scopeId: 'sid-1' });
  const meta = { id: 'sid-9', projectId: 'proj-1' };
  const { agents } = ext.buildCustomAgents(meta);
  assert.deepStrictEqual(Object.keys(agents).sort(), ['g1', 'p1']);
  const s2 = mkAgent('s2', { scope: 'session', scopeId: 'other' });
  const meta2 = { id: 'sid-9', projectId: 'x', customAgentIds: [s2.id] };
  const r2 = ext.buildCustomAgents(meta2);
  assert.deepStrictEqual(Object.keys(r2.agents).sort(), ['g1', 's2'], 'customAgentIds 挂载生效');
});

test('buildCustomAgents:禁用跳过;固定模型进守卫,无模型登记 null', () => {
  mkAgent('fixed', { model: 'key1|gpt-x' });
  mkAgent('free');
  mkAgent('off', { enabled: false });
  const { agents, allowedAgents } = ext.buildCustomAgents({});
  assert.ok(!agents['off']);
  assert.strictEqual(agents['fixed'].model, 'gpt-x', 'keyId|model 取模型段');
  assert.strictEqual(allowedAgents.get('fixed'), 'gpt-x');
  assert.strictEqual(allowedAgents.get('free'), null);
  assert.deepStrictEqual(agents['fixed'].disallowedTools, ['Agent', 'Task', 'Workflow', 'SendMessage']);
});

test('buildCustomAgents:中文名 slug 化回退,重名加后缀', () => {
  mkAgent('审查员'); // 纯中文 → slug 空 → 回退 custom
  mkAgent('custom');
  mkAgent('custom');
  const used = new Set();
  const { agents } = ext.buildCustomAgents({}, used);
  assert.ok(agents['custom'] && agents['custom-2'] && agents['custom-3']);
  // 与调用方已有 used 冲突也避让
  const r2 = ext.buildCustomAgents({}, new Set(['custom']));
  const names = Object.keys(r2.agents);
  assert.ok(!names.includes('custom') || names.length > 1);
});

test('buildCustomAgents:tools 白名单透传', () => {
  mkAgent('t1', { tools: ['Read', 'Grep'] });
  const { agents } = ext.buildCustomAgents({});
  assert.deepStrictEqual(agents['t1'].tools, ['Read', 'Grep']);
});

// ---------------------------------------------------------------------------
// 导入/导出
// ---------------------------------------------------------------------------
test('serializeMd→parseMd:skill 往返(含参考文件)', () => {
  const s = mkSkill('review-code', { desc: '审查改动', instructions: '步骤一\n步骤二', files: [{ name: 'a.md', content: '文件内容' }] });
  const md = ext.serializeMd(s, 'skill');
  assert.ok(md.startsWith('---\nname: review-code\ndescription: 审查改动'));
  const back = ext.parseMd(md, 'skill');
  assert.strictEqual(back.name, 'review-code');
  assert.strictEqual(back.desc, '审查改动');
  assert.strictEqual(back.instructions, '步骤一\n步骤二');
  assert.deepStrictEqual(back.files, [{ name: 'a.md', content: '文件内容' }]);
});

test('serializeMd→parseMd:agent 往返;导入不绑定本机 model', () => {
  const a = mkAgent('code-reviewer', { desc: '审查', prompt: '你是审查员', tools: ['Read', 'Grep'], model: 'k1|gpt-x' });
  const md = ext.serializeMd(a, 'agent');
  assert.ok(md.includes('tools: Read, Grep') && md.includes('model: gpt-x'));
  const back = ext.parseMd(md, 'agent');
  assert.strictEqual(back.prompt, '你是审查员');
  assert.deepStrictEqual(back.tools, ['Read', 'Grep']);
  assert.strictEqual(back.model, null, '导入 model 置空');
  assert.strictEqual(back.scope, 'global');
});

test('parseMd:无 frontmatter 容错,中文名不 slug 化', () => {
  const back = ext.parseMd('直接就是正文\n第二行', 'skill');
  assert.strictEqual(back.name, '');
  assert.strictEqual(back.instructions, '直接就是正文\n第二行');
  assert.deepStrictEqual(back.files, []);
});

test('slugify:非法字符剔除,纯中文回退', () => {
  assert.strictEqual(ext.slugify('My Skill!'), 'my-skill');
  assert.strictEqual(ext.slugify('审查员', 'custom'), 'custom');
  assert.strictEqual(ext.slugify('a'.repeat(100)), 'a'.repeat(40));
});

// ---------------------------------------------------------------------------
// AI 起草 prompt
// ---------------------------------------------------------------------------
test('buildDraftPrompt:kind 分支 + 截断', () => {
  const ps = ext.buildDraftPrompt('skill', '画流程图');
  assert.ok(ps.includes('何时触发') && ps.includes('画流程图'));
  const pa = ext.buildDraftPrompt('agent', '审查', '旧内容');
  assert.ok(pa.includes('角色') && pa.includes('旧内容'));
  assert.ok(ext.buildDraftPrompt('skill', 'x'.repeat(1000)).length < 1200, 'hint 截断 500');
});
