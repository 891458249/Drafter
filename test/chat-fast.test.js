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
const { fastChatOverrides, FAST_CHAT_SYSTEM_PROMPT } = require('../src/main/sessions');

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

test('覆盖内容:零工具 / 隔离设置 / 零 MCP / bypass 权限 / 自定义系统提示', () => {
  const ov = fastChatOverrides({ kind: 'chat' }, '');
  assert.deepStrictEqual(ov.tools, [], '内置工具应全部禁用');
  assert.deepStrictEqual(ov.settingSources, [], '不应加载文件设置(SDK 隔离模式)');
  assert.deepStrictEqual(ov.mcpServers, {}, '不应加载 MCP 服务器');
  assert.strictEqual(ov.strictMcpConfig, true);
  assert.strictEqual(ov.permissionMode, 'bypassPermissions');
  assert.strictEqual(ov.systemPrompt, FAST_CHAT_SYSTEM_PROMPT);
  assert.ok(!ov.systemPrompt.includes('claude_code'), '不应再使用 claude_code preset');
});

test('Gem append 拼接到极速系统提示末尾', () => {
  const ov = fastChatOverrides({ kind: 'chat' }, '【Gem 指令】测试');
  assert.ok(ov.systemPrompt.startsWith(FAST_CHAT_SYSTEM_PROMPT));
  assert.ok(ov.systemPrompt.endsWith('【Gem 指令】测试'));
});

test('极速系统提示:Drafter 身份 + 无工具声明 + 简洁要求 + 附件全文约定', () => {
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('Drafter'), '应以 Drafter 身份自我介绍');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('没有任何工具能力') || FAST_CHAT_SYSTEM_PROMPT.includes('工具能力'),
    '应声明无工具能力,防止模型幻觉调用工具');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('简洁'), '应要求简洁回答');
  assert.ok(FAST_CHAT_SYSTEM_PROMPT.includes('<附件>'), '应说明附件全文在消息内(input.js 内联注入约定)');
});
