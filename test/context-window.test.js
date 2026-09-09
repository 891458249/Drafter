// 上下文 % 计算修复(v0.15.3):result.modelUsage.contextWindow 是「窗口上限」
// (Claude 200k / Kimi 262144),此前被当成「已用 token」直接做分子,且分母用
// 启发值 1M——导致任何会话恒定显示 20%。修复后 result 事件只发 contextWindowMax,
// 「已用」由渲染端取最近一次 assistant 消息的 usage(单次 API 调用输入快照)。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-ctxwin-test-'));
installElectronStub(tmp);
const { SessionManager, Session } = require('../src/main/sessions');
Session.prototype.start = async () => {}; // 不真起 query(防子进程占住事件循环)

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function makeSession() {
  const cwd = path.join(tmp, 'case');
  fs.mkdirSync(cwd, { recursive: true });
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push(payload) } };
  const mgr = new SessionManager(() => win, (extra, keyId) => ({ keyId }));
  const s = mgr.create({ cwd, kind: 'code' });
  return { live: mgr.get(s.id), sent };
}

test('result 事件发 contextWindowMax(窗口上限),不再发 contextWindow', () => {
  const { live, sent } = makeSession();
  live._handleMessage({
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: 0.01,
    usage: { input_tokens: 3000000, output_tokens: 5000, cache_read_input_tokens: 2000000 },
    modelUsage: {
      'kimi-for-coding': {
        inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01,
        contextWindow: 262144, maxOutputTokens: 8192,
      },
    },
  });
  const ev = sent.map((p) => p.ev).find((e) => e && e.type === 'result');
  assert.ok(ev, '应发出 result 事件');
  assert.strictEqual(ev.contextWindowMax, 262144, '真实窗口上限(如 Kimi 256k)应透传');
  assert.strictEqual(ev.contextWindow, undefined, '旧的 contextWindow 字段不再发送(防误用为已用)');
  assert.ok(ev.usage, '整轮 usage 仍透传(回合统计行用)');
});

test('result 无 modelUsage 时 contextWindowMax 为 null,不报错', () => {
  const { live, sent } = makeSession();
  live._handleMessage({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
  const ev = sent.map((p) => p.ev).find((e) => e && e.type === 'result');
  assert.ok(ev);
  assert.strictEqual(ev.contextWindowMax, null);
});

test('多模型回合(子 Agent):取各模型窗口上限的最大值', () => {
  const { live, sent } = makeSession();
  live._handleMessage({
    type: 'result',
    subtype: 'success',
    modelUsage: {
      main: { contextWindow: 200000, inputTokens: 1, outputTokens: 1 },
      sub: { contextWindow: 262144, inputTokens: 1, outputTokens: 1 },
    },
  });
  const ev = sent.map((p) => p.ev).find((e) => e && e.type === 'result');
  assert.strictEqual(ev.contextWindowMax, 262144);
});
