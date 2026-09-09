// 模型上下文窗口实表(v0.15.5):按模型名查各厂商官方窗口大小。
//
// 双环境导出(同 overlayMath.js 模式):渲染端经 index.html 经典 script 挂 window.ctxwin,
// 主进程/单测经 require 取 module.exports。不能用 ESM export——Chromium ESM 加载器
// 不认 CJS interop(v0.13.4 教训)。
//
// 为什么需要它(v0.15.5 根因):result.modelUsage.contextWindow 是 claude.exe 按自身
// 模型注册表本地算出的——对第三方网关模型(kimi-k3、deepseek-chat 等)一律回退默认
// 200000,并不是提供方实报。所以「实报」也要用本表纠正:
//   effectiveCtxWindow(model, reported) = 表命中 ? 表值 : (reported || 200000)
//
// 表值来源(2026-09-09 各厂商官方文档调研,详见 DEVLOG v0.15.4):
// - Anthropic 官方:Fable 5 / Mythos 5 / Opus 4.6-4.8 / Sonnet 5 / Sonnet 4.6 = 1M(GA);
//   Haiku 4.5 及更早模型 = 200K
// - Moonshot Kimi:K2.x / K3 全系 = 256K(harness 实报 262144 交叉验证)
// - DeepSeek:V3.x API(deepseek-chat/reasoner)= 128K(官方文档)
// - 智谱 GLM:4.6 / 5.0-5.2 ≈ 200K;5.3 起 = 1M
// - MiniMax:M2 系 = 200K;M1 / M3 = 1M
// - OpenAI:GPT-5.5 起 = 1.05M;GPT-5 初代 / Codex 系 = 400K
// - Google Gemini:3.x 全系 = 1M(1,048,576)
// - 阿里 Qwen(DashScope):3.6/3.7/3.8 系 = 1M;qwen3-max = 256K;其余 = 128K
// - xAI Grok:4-fast = 2M;4 系 = 256K
var MODEL_CTX_TABLE = [
  // Anthropic
  [/fable|mythos/i, 1000000],
  [/opus-4-[6-9]|opus-[5-9]|sonnet-5|sonnet-4-[6-9]/i, 1000000],
  [/claude|anthropic/i, 200000],
  // OpenAI
  [/gpt-5[._-]?[5-9]|gpt-[6-9]/i, 1050000],
  [/gpt-5|codex|\bo[34]/i, 400000],
  // Google
  [/gemini/i, 1048576],
  // Moonshot Kimi
  [/kimi|moonshot/i, 262144],
  // DeepSeek
  [/deepseek/i, 131072],
  // 智谱 GLM
  [/glm-?5\.[3-9]|glm-?[6-9]/i, 1000000],
  [/glm|zhipu/i, 204800],
  // MiniMax
  [/minimax-?m[13]/i, 1000000],
  [/minimax|abab/i, 204800],
  // 阿里 Qwen
  [/qwen-?3[._-]?[6-9]|qwen3\.[6-9]/i, 1000000],
  [/qwen.*max/i, 262144],
  [/qwen|dashscope/i, 131072],
  // xAI Grok
  [/grok-?4.*fast/i, 2000000],
  [/grok/i, 262144],
];

// 查表:命中返回窗口 tokens,未命中返回 null(不是默认值!用于区分「表不知道」)
function lookupCtxWindow(model) {
  var m = String(model || '');
  for (var i = 0; i < MODEL_CTX_TABLE.length; i++) {
    if (MODEL_CTX_TABLE[i][0].test(m)) return MODEL_CTX_TABLE[i][1];
  }
  return null;
}

// 显示兜底(总是给数):表命中用表,否则保守 200K
function modelCtxMax(model) {
  return lookupCtxWindow(model) || 200000;
}

// 纠正 SDK 实报:claude.exe 对非自家模型一律报默认 200000,表命中时以表为准
function effectiveCtxWindow(model, reported) {
  return lookupCtxWindow(model) || reported || 200000;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports.MODEL_CTX_TABLE = MODEL_CTX_TABLE;
  module.exports.lookupCtxWindow = lookupCtxWindow;
  module.exports.modelCtxMax = modelCtxMax;
  module.exports.effectiveCtxWindow = effectiveCtxWindow;
} else if (typeof window !== 'undefined') {
  window.ctxwin = { MODEL_CTX_TABLE: MODEL_CTX_TABLE, lookupCtxWindow: lookupCtxWindow, modelCtxMax: modelCtxMax, effectiveCtxWindow: effectiveCtxWindow };
}
