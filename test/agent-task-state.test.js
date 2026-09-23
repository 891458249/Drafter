const { test } = require('node:test');
const assert = require('node:assert/strict');

test('后台工具返回不等于完成；完成后迟到的开始/进度不得恢复运行状态', async () => {
  const { updateTaskState } = await import('../src/renderer/task-state.mjs');
  const tasks = new Map();
  const update = (e) => updateTaskState(tasks, { sid: 's1', parentId: 'tool1', ...e });
  update({ status: 'running', source: 'start' });
  update({ taskId: 'agent1', status: 'running', source: 'sdk', model: 'child' });
  assert.equal(update({ status: 'completed', source: 'result' }).status, 'running');
  assert.equal(update({ status: 'completed', source: 'sdk' }).status, 'completed');
  assert.equal(update({ status: 'running', source: 'sdk' }).status, 'completed');
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0].model, 'child');
});

test('仅 taskId 的通知关联已有工具；不同会话同工具编号互不覆盖', async () => {
  const { updateTaskState } = await import('../src/renderer/task-state.mjs');
  const tasks = new Map();
  updateTaskState(tasks, { sid: 's1', parentId: 'tool1', taskId: 'a', status: 'running', source: 'sdk' });
  updateTaskState(tasks, { sid: 's2', parentId: 'tool1', taskId: 'b', status: 'running', source: 'sdk' });
  updateTaskState(tasks, { sid: 's1', taskId: 'a', status: 'stopped', source: 'sdk' });
  assert.equal(tasks.size, 2);
  assert.equal(tasks.get('s1:tool1').status, 'stopped');
  assert.equal(tasks.get('s2:tool1').status, 'running');
});

test('同一 Agent 的后续调用可以重新运行，迟到的旧进度不能改变旧调用终态', async () => {
  const { updateTaskState } = await import('../src/renderer/task-state.mjs');
  const tasks = new Map();
  updateTaskState(tasks, { sid: 's', parentId: 'spawn', taskId: 'a', status: 'completed', source: 'sdk', model: 'child' });
  const next = updateTaskState(tasks, { sid: 's', parentId: 'followup', taskId: 'a', status: 'running', source: 'sdk' });
  assert.equal(next.status, 'running');
  assert.equal(next.model, 'child');
  assert.equal(tasks.size, 1);
});
