// 模型上下文窗口兜底表(v0.15.4):按模型名查各厂商官方窗口大小。
// 注意定位:这只是「首个 result 事件之前」的显示兜底——会话跑过一轮后,
// 真实窗口以 SDK 报告的 result.modelUsage.contextWindow 为准(见 app.js ctxInfo),
// 该值由提供方实际执行环境决定(网关实报,如 Kimi 262144),永远优先于本表。
//
// 表值来源(2026-09-09 调研,详见 DEVLOG v0.15.4):
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
const MODEL_CTX_TABLE = [
  // Anthropic
  [/fable|mythos/i, 1_000_000],
  [/opus-4-[6-9]|opus-[5-9]|sonnet-5|sonnet-4-[6-9]/i, 1_000_000],
  [/claude|anthropic/i, 200_000],
  // OpenAI
  [/gpt-5[._-]?[5-9]|gpt-[6-9]/i, 1_050_000],
  [/gpt-5|codex|\bo[34]/i, 400_000],
  // Google
  [/gemini/i, 1_048_576],
  // Moonshot Kimi
  [/kimi|moonshot/i, 262_144],
  // DeepSeek
  [/deepseek/i, 131_072],
  // 智谱 GLM
  [/glm-?5\.[3-9]|glm-?[6-9]/i, 1_000_000],
  [/glm|zhipu/i, 204_800],
  // MiniMax
  [/minimax-?m[13]/i, 1_000_000],
  [/minimax|abab/i, 204_800],
  // 阿里 Qwen
  [/qwen-?3[._-]?[6-9]|qwen3\.[6-9]/i, 1_000_000],
  [/qwen.*max/i, 262_144],
  [/qwen|dashscope/i, 131_072],
  // xAI Grok
  [/grok-?4.*fast/i, 2_000_000],
  [/grok/i, 262_144],
];

// 返回模型的上下文窗口兜底值( tokens );未知模型保守 200K。
export function modelCtxMax(model) {
  const m = String(model || '');
  for (const [re, ctx] of MODEL_CTX_TABLE) if (re.test(m)) return ctx;
  return 200_000;
}

export { MODEL_CTX_TABLE };
