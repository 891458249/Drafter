const crypto = require('node:crypto');
const path = require('node:path');
const { runtimeDirectory } = require('./runtime');
const resources = require('./index');
function createSessionCleanup(sessionId, emit = () => {}) {
  const base = `drafter:${sessionId}:${crypto.randomUUID()}`;
  const scopes = new Set();
  const scopeFor = (input = {}) => {
    const scope = base + ':' + (input.agent_id || 'main');
    scopes.add(scope); resources.track(scope);
    return scope;
  };
  const instructionsFor = (scope) => require(path.join(runtimeDirectory(), 'rules')).instructions(scope);
  const clean = async (scope) => {
    try {
      if (!resources.records(scope).length) return { ok: true, count: 0, pending: [] };
      emit({ type: 'ui_aux', message: '正在释放调试资源…' });
      const report = await resources.cleanup(scope);
      emit({ type: report.ok ? 'ui_aux' : 'ui_error', message: report.ok
        ? `已释放并复核 ${report.count} 项已登记调试资源。`
        : '调试占用尚未全部解除：' + JSON.stringify(report.pending) });
      return report;
    } catch (e) {
      emit({ type: 'ui_error', message: '调试资源清理失败：' + e.message });
      return { ok: false, pending: [{ reason: e.message }] };
    }
  };
  // 子 Agent 的 scope 只能在 hook 输入里拿到 agent_id,规则按父会话 scope 写进系统提示;
  // 子 Agent 结束(SubagentStop)时连带清理它自己 scope 下登记的资源。
  return {
    prompt: instructionsFor(scopeFor()),
    hooks: {
      Stop: [{ hooks: [async (input) => {
        const scope = scopeFor(input);
        const report = await clean(scope);
        const initial = input.agent_id && scope !== base + ':main' ? await clean(base + ':main') : { ok: true };
        if ((!report.ok || !initial.ok) && !input.stop_hook_active) return { decision: 'block', reason: '调试资源未释放，请检查 cleanup/status 输出并报告不能解除的占用。' };
        return {};
      }] }],
      SubagentStop: [{ hooks: [async (input) => { await clean(scopeFor(input)); return {}; }] }],
    },
    cleanup: () => Promise.all([...scopes].map(clean)),
  };
}
module.exports = { createSessionCleanup };
