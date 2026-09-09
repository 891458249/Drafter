// ctxwin.js(v0.15.4):模型上下文窗口兜底表
// 表值来自 2026-09-09 各厂商官方调研(见 DEVLOG);这里验证匹配规则本身。
const { test } = require('node:test');
const assert = require('node:assert');

let modelCtxMax;
test('setup', async () => {
  modelCtxMax = (await import('../src/renderer/ctxwin.js?v=' + Date.now())).modelCtxMax;
});

const CASES = [
  // Anthropic:4.6 代起 1M;更早/haiku 200K
  ['claude-fable-5', 1_000_000], ['claude-mythos-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000], ['claude-opus-4-6', 1_000_000], ['claude-opus-5', 1_000_000],
  ['claude-sonnet-5', 1_000_000], ['claude-sonnet-4-6', 1_000_000],
  ['claude-sonnet-4-5', 200_000], ['claude-haiku-4-5', 200_000], ['claude-3-5-sonnet-20241022', 200_000],
  // Kimi 256K(实测 kimi-for-coding = 262144)
  ['kimi-k3', 262_144], ['kimi-for-coding', 262_144], ['kimi-k2.5', 262_144], ['moonshot-v1', 262_144],
  // DeepSeek 128K
  ['deepseek-chat', 131_072], ['deepseek-reasoner', 131_072],
  // GLM:5.3+ 1M;4.6/5.0 200K
  ['glm-5.3', 1_000_000], ['glm-6', 1_000_000], ['glm-4.6', 204_800], ['glm-5', 204_800],
  // MiniMax:M1/M3 1M;M2 系 200K
  ['minimax-m1', 1_000_000], ['minimax-m3', 1_000_000], ['minimax-m2', 204_800], ['minimax-m2.7', 204_800],
  // OpenAI:5.5+ 1.05M;初代 gpt-5 400K
  ['gpt-5.5', 1_050_000], ['gpt-5.6-sol', 1_050_000], ['gpt-5.4', 400_000], ['gpt-5', 400_000],
  // Gemini 1M
  ['gemini-3-pro', 1_048_576], ['gemini-3.1-pro', 1_048_576], ['gemini-2.5-flash', 1_048_576],
  // Qwen:3.6+ 1M;qwen3-max 256K;其余 128K
  ['qwen3.7-plus', 1_000_000], ['qwen3.8-max', 1_000_000], ['qwen3-max', 262_144], ['qwen3-coder', 131_072],
  // Grok:4-fast 2M;4 系 256K
  ['grok-4-fast', 2_000_000], ['grok-4.1-fast', 2_000_000], ['grok-4', 262_144], ['grok-3', 262_144],
  // 兜底
  ['unknown-model-xyz', 200_000], ['', 200_000], [null, 200_000], [undefined, 200_000],
];

test('modelCtxMax:各厂商模型窗口匹配', () => {
  for (const [model, want] of CASES) {
    assert.strictEqual(modelCtxMax(model), want, `model=${model}`);
  }
});
