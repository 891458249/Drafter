// sessions.js 极速问答(v0.10.2):fastChatOverrides 的触发条件与覆盖内容。
// 背景:chat 会话默认走 Claude Code 完整配置(系统提示+全工具 schema,首轮实测
// ~26k tokens 输入),极速模式用 SDK 隔离配置(tools:[]/settingSources:[]/零 MCP/
// 极简自定义系统提示)把首轮输入压到 ~2-4k,TTFT 对齐网页版。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-chatfast-test-'));
installElectronStub(tmp);
const { fastChatOverrides, FAST_CHAT_SYSTEM_PROMPT, agentSettingSources } = require('../src/main/sessions');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('chat + chatMode 未设置(存量会话)→ 极速覆盖', () => {
  const ov = fastChatOverrides({ kind: 'chat' }, '');
  assert.ok(ov, '存量 chat 会话应默认极速');
});

test('chat + chatMode=fast → 极速覆盖', () => {
  assert.ok(fastChatOverrides({ kind: 'chat', chatMode: 'fast' }, ''));
});

test('chat + chatMode=agent → null(走完整 Agent 配置)', () => {
  assert.strictEqual(fastChatOverrides({ kind: 'chat', chatMode: 'agent' }, ''), null);
});

test('code / media 会话 → null(极速只作用于 chat 板块)', () => {
  assert.strictEqual(fastChatOverrides({ kind: null }, ''), null);
  assert.strictEqual(fastChatOverrides({ kind: 'code' }, ''), null);
  assert.strictEqual(fastChatOverrides({ kind: 'media' }, ''), null);
});

test('覆盖内容:零工具 / 隔离设置 / 零 MCP / bypass 权限 / 自定义系统提示 / 关闭思考', () => {
  const ov = fastChatOverrides({ kind: 'chat' }, '');
  assert.deepStrictEqual(ov.tools, [], '内置工具应全部禁用');
  assert.deepStrictEqual(ov.settingSources, [], '不应加载文件设置(SDK 隔离模式)');
  assert.deepStrictEqual(ov.mcpServers, {}, '不应加载 MCP 服务器');
  assert.strictEqual(ov.strictMcpConfig, true);
  assert.strictEqual(ov.permissionMode, 'bypassPermissions');
  assert.strictEqual(ov.systemPrompt, FAST_CHAT_SYSTEM_PROMPT);
  assert.ok(!ov.systemPrompt.includes('claude_code'), '不应再使用 claude_code preset');
  assert.deepStrictEqual(ov.thinking, { type: 'disabled' },
    '极速模式应关闭扩展思考(Kimi k3 类混合推理模型默认思考占输出 70%+,是慢于网页版的根源)');
});

test('Gem append 拼接到极速系统提示末尾', () => {
  const ov = fastChatOverrides({ kind: 'chat' }, '【Gem 指令】测试');
  assert.ok(ov.systemPrompt.startsWith(FAST_CHAT_SYSTEM_PROMPT));
  assert.ok(ov.systemPrompt.endsWith('【Gem 指令】测试'));
});

test('极速系统提示:Drafter 身份 + 无工具声明 + 简洁要求 + 附件全文约定 + 直接作答', () => {
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('Drafter'), '应以 Drafter 身份自我介绍');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('没有任何工具能力') || FAST_CHAT_SYSTEM_PROMPT.includes('工具能力'),
    '应声明无工具能力,防止模型幻觉调用工具');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('简洁'), '应要求简洁回答');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('<附件>'), '应说明附件全文在消息内(input.js 内联注入约定)');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('直接作答'), '应要求跳过内部推理直接作答(提示层关思考)');
});

// Agent 模式设置源(v0.15.7):cwd = 用户主目录时,<cwd>/.claude/settings.json 与
// 用户级 settings.json 是同一文件,'project' 源会把 CLI 钉死的网关 env 重新加载进来,
// 盖过 buildEnv 按 Key 注入的凭据 → 跨网关 403「模型未配置」(--model 不受影响)。
test('agentSettingSources:常规 cwd 加载 project/local', () => {
  assert.deepStrictEqual(agentSettingSources('D:\\ClaudeUI'), ['project', 'local']);
  assert.deepStrictEqual(agentSettingSources(path.join(os.homedir(), 'some-project')), ['project', 'local'],
    '主目录的子目录不命中(claude.exe 对 settings 不做向上回溯,实测)');
});

test('agentSettingSources:cwd = 用户主目录 → 不加载任何文件设置', () => {
  assert.deepStrictEqual(agentSettingSources(os.homedir()), [],
    'cwd 为主目录时 project 与用户级是同一文件,必须排除(否则 env 钉网关复活)');
});

test('agentSettingSources:cwd 为空按当前目录解析', () => {
  const expected = path.resolve('.', '.claude') === path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
    ? [] : ['project', 'local'];
  assert.deepStrictEqual(agentSettingSources(''), expected);
  assert.deepStrictEqual(agentSettingSources(null), expected);
});

test('agentSettingSources:Windows 配置父目录大小写变体仍排除设置', { skip: process.platform !== 'win32' }, () => {
  const parent = path.dirname(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  assert.deepStrictEqual(agentSettingSources(parent.toUpperCase()), []);
  assert.deepStrictEqual(agentSettingSources(parent.toLowerCase()), []);
});
