// 拆分子任务解析器单测(v0.15.9):JSON 提取 + 校验 + 提示词构造
const test = require('node:test');
const assert = require('node:assert');
const { extractJsonArray, parseSubtasks, buildSplitPrompt } = require('../src/main/split-subtasks');

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
