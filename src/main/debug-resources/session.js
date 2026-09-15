const crypto = require('node:crypto');
const path = require('node:path');
const { runtimeDirectory } = require('./runtime');
const resources = require('./index');
function createSessionCleanup(sessionId, emit = () => {}) {
  const base = `drafter:${sessionId}:${crypto.randomUUID()}`;
  const scopes = new Set();
  const scopeFor = (input = {}) => {
    const scope = base + ':' + (input.agent_id || input.session_id || 'main');
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
  return {
    prompt: instructionsFor(scopeFor()),
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell|mcp__.*', hooks: [async (input) => ({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', additionalContext: instructionsFor(scopeFor(input)),
      } })] }],
      Stop: [{ hooks: [async (input) => {
        const report = await clean(scopeFor(input));
        const initial = input.agent_id ? { ok: true } : await clean(base + ':main');
        if ((!report.ok || !initial.ok) && !input.stop_hook_active) return { decision: 'block', reason: '调试资源未释放，请检查 cleanup/status 输出并报告不能解除的占用。' };
        return {};
      }] }],
      SubagentStop: [{ hooks: [async (input) => { await clean(scopeFor(input)); return {}; }] }],
      PostToolUseFailure: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: '调试若已结束或失败，立即 cleanup 并验证占用；仍在排查时由脚本 finally 保证释放，不退出用户已有软件。' } })] }],
    },
    cleanup: () => Promise.all([...scopes].map(clean)),
  };
}
module.exports = { createSessionCleanup };
