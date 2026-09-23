const { lookupCtxWindow } = require('../renderer/ctxwin');

// This limits compaction's budget; it never increases a provider's context limit.
function compactionSettings(model) {
  const window = lookupCtxWindow(model);
  return {
    autoCompactEnabled: true,
    autoCompactWindow: Math.max(100000, Math.min(window || 200000, 200000)),
  };
}
// v0.15.17:自动压缩只在上下文真正填满(100%)时触发。低于 100% 一律不自动压缩,
// 只能由用户点输入框工具栏的「压缩」按钮手动触发。
//
// claude.exe(agent-sdk 0.3.220 反编译)的阈值算法:
//   compactAt = min(floor(window * pct/100), window - 13000),pct 仅在 (0,100] 内生效;
//   blockedAt = window - 3000。
// 取 100 → min(window, window-13000) = window-13000,是 SDK 允许的最晚触发点;
// v0.15.7~0.15.16 用 80,会在 window*0.8 就提前压缩。此处恒定下发 100,
// 不再透传更低的覆盖值(用户环境里残留的低值同样被忽略,否则等于自动触发)。
function compactionEnv(env) {
  return { ...env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' };
}
module.exports = { compactionSettings, compactionEnv };
