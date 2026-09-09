// ctxwin.js(v0.15.4):模型上下文窗口兜底表
// 表值来自 2026-09-09 各厂商官方调研(见 DEVLOG);这里验证匹配规则本身。
const { test } = require('node:test');
const assert = require('node:assert');

let modelCtxMax, lookupCtxWindow, effectiveCtxWindow;
test('setup', async () => {
  const m = await import('../src/renderer/ctxwin.js?v=' + Date.now());
  const mod = m.modelCtxMax ? m : m.default; // CJS 双环境导出,import 经 lexer 取命名导出
  modelCtxMax = mod.modelCtxMax;
  lookupCtxWindow = mod.lookupCtxWindow;
  effectiveCtxWindow = mod.effectiveCtxWindow;
});

const CASES = [
  // Anthropic:4.6 代起 1M;更早/haiku 200K
  ['claude-fable-5', 1_000_000], ['claude-mythos-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000], ['claude-opus-4-6', 1_000_000], ['claude-opus-5', 1_000_000],
  ['claude-sonnet-5', 1_000_000], ['claude-sonnet-4-6', 1_000_000],
  ['claude-sonnet-4-5', 200_000], ['claude-haiku-4-5', 200_000], ['claude-3-5-sonnet-20241022', 200_000],
  // Kimi:K3 = 1M(2026-07 官方);K2.x/kimi-for-coding = 256K(harness 实报验证)
  ['kimi-k3', 1_048_576], ['kimi-k3-0716', 1_048_576], ['k3', 1_048_576],
  ['kimi-for-coding', 262_144], ['kimi-k2.5', 262_144], ['moonshot-v1', 262_144],
  // DeepSeek:V4 系 1M;V3.x 128K
  ['deepseek-v4-flash', 1_048_576], ['deepseek-chat', 131_072], ['deepseek-reasoner', 131_072],
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

// v0.15.5:result.modelUsage.contextWindow 是 claude.exe 本地注册表算的,
// 对第三方网关模型一律回退默认 200000——effectiveCtxWindow 用实表纠正。
test('effectiveCtxWindow:表命中纠正 claude.exe 的 200k 误报', () => {
  assert.strictEqual(effectiveCtxWindow('kimi-k3', 200000), 1048576, 'kimi-k3 实报 200k → 纠正为官方 1M');
  assert.strictEqual(effectiveCtxWindow('kimi-for-coding', 200000), 262144, 'kimi-for-coding 实报 200k → 纠正为 256k');
  assert.strictEqual(effectiveCtxWindow('deepseek-chat', 200000), 131072, 'deepseek 实报 200k → 纠正为 128k');
  assert.strictEqual(effectiveCtxWindow('claude-opus-4-8', 200000), 1000000, 'opus-4.8 旧实报 200k → 纠正为 1M(GA)');
  assert.strictEqual(effectiveCtxWindow('claude-sonnet-5', 1000000), 1000000);
});

test('effectiveCtxWindow:表外模型回退实报,实报缺失回退 200k', () => {
  assert.strictEqual(effectiveCtxWindow('some-future-model', 512000), 512000);
  assert.strictEqual(effectiveCtxWindow('some-future-model', null), 200000);
  assert.strictEqual(lookupCtxWindow('some-future-model'), null, '未命中必须返回 null 而非默认值');
});
