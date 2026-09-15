const crypto = require('node:crypto');
const path = require('node:path');
const resources = require('../debug-resources');
const { runtimeDirectory } = require('../debug-resources/runtime');
async function applyDebugResources(ctx) {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const runs = new Map();
  const scopeFor = (agent) => {
    if (!runs.has(agent)) runs.set(agent, resources.track('harness:' + crypto.randomUUID()));
    return runs.get(agent);
  };
  const clean = async (agent) => {
    const scope = runs.get(agent);
    if (!scope) return;
    const report = await resources.cleanup(scope);
    if (!report.ok) ctx.logger.warn('Debug resources remain: ' + JSON.stringify(report.pending));
  };
  const disposers = [];
  disposers.push(ctx.get('systemPrompt').section({ name: 'drafter-debug-cleanup', order: 30,
    text: require('../debug-resources/rules').RULES }));
  const signalled = new WeakSet();
  disposers.push(ctx.on('agent/session-start', ({ agent }) => {
    const text = require(path.join(runtimeDirectory(), 'rules')).instructions(scopeFor(agent));
    agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'drafter-debug-cleanup' } }));
  }));
  disposers.push(ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    scopeFor(agent);
    if (!signalled.has(signal)) {
      signalled.add(signal);
      signal.addEventListener('abort', () => { void clean(agent).catch((e) => ctx.logger.warn(String(e))); }, { once: true });
    }
    return next();
  }));
  disposers.push(ctx.on('agent/error', ({ agent }) => { void clean(agent).catch((e) => ctx.logger.warn(String(e))); }));
  disposers.push(ctx.on('agent/turn-stopping', async ({ agent }) => { await clean(agent); }));
  return async () => {
    for (const dispose of disposers) dispose();
    await Promise.all([...runs.keys()].map(clean));
  };
}
module.exports = { applyDebugResources };
