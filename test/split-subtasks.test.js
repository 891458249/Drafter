// 拆分子任务解析器单测(v0.15.9):JSON 提取 + 校验 + 提示词构造
// v0.15.18:新增「先判断」一轮——mode(parallel/wait)、waitFor 引用解析、等待目标解析、
// 判断依据(其他并行会话现状)与提示词。
const test = require('node:test');
const assert = require('node:assert');
const {
  extractJsonArray, parseSubtasks, buildSplitPrompt, resolveWaitTargets,
  pickOtherSessions, summarizePlan, normMode, normWaitFor,
} = require('../src/main/split-subtasks');

test('extractJsonArray: 直接 JSON 数组', () => {
  const r = extractJsonArray('[{"title":"a","detail":"da"},{"title":"b","detail":"db"}]');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].title, 'a');
});

test('extractJsonArray: 剥 markdown 代码围栏', () => {
  const r = extractJsonArray('```json\n[{"title":"x","detail":"dx"}]\n```');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 'x');
});

test('extractJsonArray: 容忍首尾散文', () => {
  const r = extractJsonArray('好的,拆分如下:\n[{"title":"t1","detail":"d1"}]\n以上是子任务。');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 't1');
});

test('extractJsonArray: 非数组返回 null', () => {
  assert.strictEqual(extractJsonArray('{"title":"a"}'), null);
  assert.strictEqual(extractJsonArray('根本不是 JSON'), null);
  assert.strictEqual(extractJsonArray(''), null);
});

test('parseSubtasks: 规范化 title/detail,兼容别名字段', () => {
  const r = parseSubtasks('[{"name":"任务A","desc":"说明A"},{"task":"任务B","prompt":"说明B"}]');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tasks[0].title, '任务A');
  assert.strictEqual(r.tasks[0].detail, '说明A');
  assert.strictEqual(r.tasks[1].title, '任务B');
  assert.strictEqual(r.tasks[1].detail, '说明B');
});

test('parseSubtasks: 丢弃无标题项,标题截断 60 字', () => {
  const longTitle = '长'.repeat(80);
  const r = parseSubtasks(JSON.stringify([
    { title: '', detail: '' },           // 全空 → 丢弃
    { title: longTitle, detail: 'd' },   // 截断
    { detail: '只有说明没有标题' },        // 用 detail 前 60 字补标题
  ]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tasks.length, 2);
  assert.strictEqual(r.tasks[0].title.length, 60);
  assert.strictEqual(r.tasks[1].title, '只有说明没有标题');
});

test('parseSubtasks: 数量上限 12,空数组报错', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: 't' + i, detail: 'd' + i }));
  const r = parseSubtasks(JSON.stringify(many));
  assert.strictEqual(r.tasks.length, 12);
  const empty = parseSubtasks('[]');
  assert.strictEqual(empty.ok, false);
  const bad = parseSubtasks('完全不是JSON');
  assert.strictEqual(bad.ok, false);
});

test('buildSplitPrompt: 含需求与 JSON 约束', () => {
  const p = buildSplitPrompt('做一个登录页');
  assert.ok(p.includes('做一个登录页'));
  assert.ok(p.includes('JSON'));
  assert.ok(p.includes('title'));
});

// --- v0.15.18:mode / waitFor 解析 -------------------------------------------

test('normMode: 中英文写法与无法识别时的兜底', () => {
  assert.strictEqual(normMode('wait'), 'wait');
  assert.strictEqual(normMode('WAITING'), 'wait');
  assert.strictEqual(normMode('blocked'), 'wait');
  assert.strictEqual(normMode('等待'), 'wait');
  assert.strictEqual(normMode('依赖'), 'wait');
  assert.strictEqual(normMode('parallel'), 'parallel');
  assert.strictEqual(normMode('并行'), 'parallel');
  assert.strictEqual(normMode(''), 'parallel');
  assert.strictEqual(normMode(undefined), 'parallel');
  assert.strictEqual(normMode('随便写的'), 'parallel'); // 认不出一律按并行,不卡住任务
});

test('normWaitFor: current / S1 / #2 / sid / 中文 与非法值', () => {
  assert.strictEqual(normWaitFor('current'), 'current');
  assert.strictEqual(normWaitFor('当前会话'), 'current');
  assert.strictEqual(normWaitFor('s1'), 'S1');
  assert.strictEqual(normWaitFor('S2'), 'S2');
  assert.strictEqual(normWaitFor('#3'), '#3');
  assert.strictEqual(normWaitFor('2'), '#2');
  assert.strictEqual(normWaitFor(2), '#2');
  assert.strictEqual(normWaitFor('子任务1'), '#1');
  assert.strictEqual(normWaitFor('sid:abc'), null);
  assert.strictEqual(normWaitFor('s_abc-123'), 'sid:s_abc-123');
  assert.strictEqual(normWaitFor(''), null);
  assert.strictEqual(normWaitFor(null), null);
});

test('parseSubtasks: 缺省 mode 一律并行,waitFor 被清空', () => {
  const r = parseSubtasks('[{"title":"a","detail":"da"}]');
  assert.strictEqual(r.tasks[0].mode, 'parallel');
  assert.strictEqual(r.tasks[0].waitFor, null);
  // 并行项即使带了 waitFor 也不保留(语义自相矛盾)
  const r2 = parseSubtasks('[{"title":"a","detail":"da","mode":"parallel","waitFor":"S1"}]');
  assert.strictEqual(r2.tasks[0].mode, 'parallel');
  assert.strictEqual(r2.tasks[0].waitFor, null);
});

test('parseSubtasks: wait 项的 waitFor;漏写时兜底为 current', () => {
  const r = parseSubtasks(JSON.stringify([
    { title: 'a', detail: 'da', mode: 'wait', waitFor: 'current' },
    { title: 'b', detail: 'db', mode: 'wait', waitFor: 'S1' },
    { title: 'c', detail: 'dc', mode: 'wait', waitFor: '#2' },
    { title: 'd', detail: 'dd', mode: 'wait' }, // 说了要等没说等谁
  ]));
  assert.deepStrictEqual(r.tasks.map((t) => t.mode), ['wait', 'wait', 'wait', 'wait']);
  assert.deepStrictEqual(r.tasks.map((t) => t.waitFor), ['current', 'S1', '#2', 'current']);
});

test('parseSubtasks: 没写 mode 但给了依赖字段 → 按等待处理', () => {
  const r = parseSubtasks(JSON.stringify([
    { title: 'a', detail: 'da', dependsOn: 'S1' },
    { title: 'b', detail: 'db', after: '当前会话' },
  ]));
  assert.strictEqual(r.tasks[0].mode, 'wait');
  assert.strictEqual(r.tasks[0].waitFor, 'S1');
  assert.strictEqual(r.tasks[1].mode, 'wait');
  assert.strictEqual(r.tasks[1].waitFor, 'current');
});

// --- v0.15.18:等待目标解析 ---------------------------------------------------

test('resolveWaitTargets: 并行项 spawn,等待项按引用落到对应目标', () => {
  const plan = resolveWaitTargets([
    { title: 'a', mode: 'parallel' },
    { title: 'b', mode: 'wait', waitFor: 'current' },
    { title: 'c', mode: 'wait', waitFor: '#1' }, // 等第 1 项(并行 → 它新建的会话)
    { title: 'd', mode: 'wait', via: { kind: 'session', sid: 's_x' } },
  ]);
  assert.strictEqual(plan[0].action, 'spawn');
  assert.deepStrictEqual(plan[1].via, { kind: 'current' });
  assert.deepStrictEqual(plan[2].via, { kind: 'subtask', index: 0 });
  assert.deepStrictEqual(plan[3].via, { kind: 'session', sid: 's_x' });
});

test('resolveWaitTargets: 等待项等另一个等待项 → 继承其最终目标', () => {
  // 2 等当前会话,3 等 2 → 3 最终也落在当前会话(投递顺序保证 2 先于 3)
  const plan = resolveWaitTargets([
    { title: 'a', mode: 'parallel' },
    { title: 'b', mode: 'wait', waitFor: 'current' },
    { title: 'c', mode: 'wait', waitFor: '#2' },
  ]);
  assert.deepStrictEqual(plan[2].via, { kind: 'current' });
  assert.ok(!plan[2].cycle);
  // 2 等 1(并行),3 等 2 → 3 继承到「第 1 项新建的会话」,与 2 同队列且排在 2 之后
  const plan2 = resolveWaitTargets([
    { title: 'a', mode: 'parallel' },
    { title: 'b', mode: 'wait', waitFor: '#1' },
    { title: 'c', mode: 'wait', waitFor: '#2' },
  ]);
  assert.deepStrictEqual(plan2[1].via, { kind: 'subtask', index: 0 });
  assert.deepStrictEqual(plan2[2].via, { kind: 'subtask', index: 0 });
});

test('resolveWaitTargets: 成环 / 越界 / 自引用都退化为等当前会话,不死循环', () => {
  const cyc = resolveWaitTargets([
    { title: 'a', mode: 'wait', waitFor: '#2' },
    { title: 'b', mode: 'wait', waitFor: '#1' },
  ]);
  assert.strictEqual(cyc[0].cycle, true);
  assert.strictEqual(cyc[1].cycle, true);
  assert.deepStrictEqual(cyc[0].via, { kind: 'current' });
  const self = resolveWaitTargets([{ title: 'a', mode: 'wait', waitFor: '#1' }]);
  assert.strictEqual(self[0].cycle, true);
  const oob = resolveWaitTargets([{ title: 'a', mode: 'wait', waitFor: '#9' }]);
  assert.strictEqual(oob[0].cycle, true);
  assert.deepStrictEqual(oob[0].via, { kind: 'current' });
});

test('resolveWaitTargets: 空输入与未标注 mode 的旧格式', () => {
  assert.deepStrictEqual(resolveWaitTargets([]), []);
  assert.deepStrictEqual(resolveWaitTargets(undefined), []);
  assert.deepStrictEqual(resolveWaitTargets([{ title: 'a' }]), [{ action: 'spawn' }]);
});

// --- v0.15.18:判断依据(其他并行会话现状) ------------------------------------

test('pickOtherSessions: 同项目组、排除自身/归档/媒体会话,按最近更新排序编号', () => {
  const all = [
    { id: 'me', projectId: 'p1', title: '当前', updatedAt: 100 },
    { id: 's1', projectId: 'p1', title: '旧会话', updatedAt: 10 },
    { id: 's2', projectId: 'p1', title: '新会话', updatedAt: 90 },
    { id: 's3', projectId: 'p2', title: '别的项目', updatedAt: 999 },
    { id: 's4', projectId: 'p1', title: '已归档', updatedAt: 500, archived: true },
    { id: 's5', projectId: 'p1', title: '画图', updatedAt: 400, kind: 'image' },
  ];
  const out = pickOtherSessions({
    currentSid: 'me', projectId: 'p1', all,
    busyOf: (id) => id === 's2', doingOf: (id) => (id === 's2' ? '重构   登录页' : ''),
  });
  assert.deepStrictEqual(out.map((o) => o.key), ['S1', 'S2']);
  assert.deepStrictEqual(out.map((o) => o.id), ['s2', 's1']);
  assert.strictEqual(out[0].title, '新会话');
  assert.strictEqual(out[0].busy, true);
  assert.strictEqual(out[0].doing, '重构 登录页'); // 空白归一
  assert.strictEqual(out[1].busy, false);
});

test('pickOtherSessions: 无项目组时按 cwd 匹配,数量上限生效', () => {
  const all = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, cwd: 'D:/x', updatedAt: i }));
  all.push({ id: 'other', cwd: 'D:/y', updatedAt: 99 });
  const out = pickOtherSessions({ currentSid: 'none', cwd: 'D:/x', all });
  assert.strictEqual(out.length, 6);            // 默认上限 6
  assert.strictEqual(out[0].id, 's8');          // 最近更新在前
  assert.ok(!out.some((o) => o.id === 'other'));
});

test('buildSplitPrompt: 带上其他并行会话现状与判断要求', () => {
  const p = buildSplitPrompt('做一个博客', {
    current: { title: '主会话', busy: true, doing: '改首页样式' },
    sessions: [{ key: 'S1', title: '接口会话', busy: true, doing: '写用户接口' }],
  });
  assert.ok(p.includes('做一个博客'));
  assert.ok(p.includes('主会话'));
  assert.ok(p.includes('S1'));
  assert.ok(p.includes('接口会话'));
  assert.ok(p.includes('写用户接口'));
  assert.ok(p.includes('parallel'));
  assert.ok(p.includes('waitFor'));
  assert.ok(!p.includes('其他并行会话现状:(无')); // 有其他会话时不出现兜底提示
});

test('buildSplitPrompt: 没有其他并行会话时明确告知,不留空', () => {
  const p = buildSplitPrompt('做一个博客', { current: null, sessions: [] });
  assert.ok(p.includes('其他并行会话现状:(无'));
});

test('summarizePlan: 单条并行判为「不需要拆分」,混合项给出计数', () => {
  assert.ok(summarizePlan([{ title: 'a', mode: 'parallel' }]).includes('不需要拆分'));
  const s = summarizePlan([
    { title: 'a', mode: 'parallel' },
    { title: 'b', mode: 'parallel' },
    { title: 'c', mode: 'wait', waitFor: 'current' },
  ]);
  assert.ok(s.includes('2 项可并行'));
  assert.ok(s.includes('1 项需等待'));
  assert.strictEqual(summarizePlan([]), '');
});
