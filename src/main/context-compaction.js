const { lookupCtxWindow } = require('../renderer/ctxwin');

// This limits compaction's budget; it never increases a provider's context limit.
function compactionSettings(model) {
  const window = lookupCtxWindow(model);
  return {
    autoCompactEnabled: true,
    autoCompactWindow: Math.max(100000, Math.min(window || 200000, 200000)),
  };
}
function compactionEnv(env) {
  const current = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  return { ...env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(current >= 1 && current < 80 ? current : 80) };
}
module.exports = { compactionSettings, compactionEnv };
