const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(config) {
  function element() {
    const classes = new Set(['hidden']);
    return { children: [], style: {}, textContent: '', innerHTML: '', offsetHeight: 100,
      classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x),
        toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      appendChild(el) { this.children.push(el); }, contains() { return false; },
      getBoundingClientRect() { return { left: 20, top: 300, bottom: 320 }; } };
  }
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const session = { meta: { id: 's', kind: 'code', model: 'main', keyId: 'key', agentModels: [], customAgentIds: [], agentConfig: config } };
  let listener;
  const context = vm.createContext({ console, Set, Map, state: { activeSid: 's', sessions: new Map([['s', session]]), GroupsCache: new Map() },
    $, escapeHtml: (s) => String(s), ensureGroups: async () => {},
    api: { on: (_name, cb) => { listener = cb; }, sessAgentConfig: async () => config,
      keysEnabledModels: async () => [] },
    document: { createElement: element, addEventListener() {} }, window: { innerWidth: 1000, innerHeight: 800 } });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/agents-ui.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
  vm.runInContext(source, context);
  context.init();
  return { context, session, $, event: (ev) => listener({ sid: 's', ev }) };
}

test('选择器使用实际配置数量，空闲事件不能提前清除待生效提示', () => {
  const config = { count: 2, customAgents: [], agentModels: [], customAgentIds: [], pending: true };
  const f = fixture(config);
  f.event({ type: 'ui_agent_config', config });
  assert.equal(f.$('agent-models-name').textContent, '子 Agent (2)');
  assert.match(f.$('agent-models-btn').title, /待当前回合结束/);
  f.event({ type: 'ui_status', busy: false });
  assert.equal(f.session.meta.agentModelsPending, true);
  f.event({ type: 'ui_agent_config', config: { ...config, pending: false } });
  assert.equal(f.session.meta.agentModelsPending, false);
});

test('菜单呈现后端筛选的自定义 Agent，跨 Key 不伪装成已启用', () => {
  const f = fixture({ count: 1, agentModels: [], customAgentIds: [], pending: false, customAgents: [
    { id: 'global', name: 'global-agent', scope: 'global', active: true },
    { id: 'foreign', name: 'foreign-agent', scope: 'session', active: false, error: '使用其他 Key' },
  ] });
  f.context.renderMenu(f.session);
  const rows = f.$('agent-models-menu').children;
  const foreign = rows.find((r) => r.innerHTML.includes('foreign-agent'));
  assert.equal(foreign.disabled, true);
  assert.equal(foreign.className, 'agent-model-row');
  assert.ok(rows.some((r) => r.textContent.includes('已启用 1 个')));
  assert.ok(!rows.some((r) => r.innerHTML.includes('code-reviewer')));
});
