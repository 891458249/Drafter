const { lookupCtxWindow } = require('../renderer/ctxwin');

// 自动压缩窗口 = 模型真实上下文窗口(ctxwin 表值),表未命中才退回 200000
// (与 claude.exe 对非自家模型的默认一致)。
//
// v0.15.20:去掉 Math.max(100000, Math.min(…, 200000)) 的人为钳位。v0.15.10 引入、
// v0.15.18 未察觉的这层钳位会把 1M 模型压成 200K,于是压缩在 187000 token
// (≈ 圈上 18.7%)就触发——PCT_OVERRIDE=100 对此完全无效,因为它只能取
// min(window, window-13000),而 window 本身已经被钳低了。两处必须同时成立:
// 窗口是真实窗口 + pct 取 100,才能把触发点推到尽可能晚。
//
// 上限 1000000 不是随手取的,是实测定出来的硬边界:窗口 ≤1000000 时主动压缩
// 正常触发,一旦 >1000000 就**完全不再触发**(改由提供方 prompt-too-long 拒绝
// 后再补),边界精确落在 1000001(探针 .claude-ui/probe-context-window.js +
// test/agent-route-live.test.js 实测:1000000 触发 / 1000001 不触发,与上报
// token 数无关)。所以这里对 ≥1M 的模型封到 1000000,而不是放行到真实窗口——
// 放行等于把 fable/opus/sonnet-5/kimi-k3/gemini 这些主力模型的主动压缩整个关掉。
// 代价:超长上下文可能被某些网关按更低上限硬拒,由 sessions 的
// 「提供方拒绝超长上下文后自动恢复」链路兜底。
const AUTOCOMPACT_WINDOW_MAX = 1000000;
function compactionSettings(model) {
  const window = lookupCtxWindow(model);
  return {
    autoCompactEnabled: true,
    autoCompactWindow: Math.min(window || 200000, AUTOCOMPACT_WINDOW_MAX),
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
// 注意:pct 只在 (0,100] 生效,不设该变量时算法直接返回 window-13000,与取 100
// 等价——所以「把压缩推后」真正靠的是上面的真实窗口,这里只是兜住环境残留。
function compactionEnv(env) {
  return { ...env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' };
}
module.exports = { compactionSettings, compactionEnv };
