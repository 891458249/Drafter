// oai-translate.js tests:Anthropic Messages ↔ OpenAI Chat Completions 双向映射
const { test } = require('node:test');
const assert = require('node:assert');
const tr = require('../src/main/oai-translate');

test('请求:system 字符串 + max_tokens→max_completion_tokens + 采样参数透传', () => {
  const out = tr.translateRequest({
    model: 'gpt-5.6-sol', max_tokens: 32000, temperature: 0.7, top_p: 0.9,
    stop_sequences: ['END'], system: '你是助手',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.model, 'gpt-5.6-sol');
  assert.strictEqual(out.max_completion_tokens, 32000);
  assert.strictEqual(out.max_tokens, undefined);
  assert.strictEqual(out.temperature, 0.7);
  assert.strictEqual(out.top_p, 0.9);
  assert.deepStrictEqual(out.stop, ['END']);
  assert.deepStrictEqual(out.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(out.stream, undefined, '非流式不带 stream');
});

test('请求:system 块数组剥 cache_control 合并;stream 附加 include_usage', () => {
  const out = tr.translateRequest({
    model: 'm', max_tokens: 100, stream: true,
    system: [
      { type: 'text', text: '第一段', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '第二段' },
    ],
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.deepStrictEqual(out.messages[0], { role: 'system', content: '第一段\n第二段' });
  assert.strictEqual(out.stream, true);
  assert.deepStrictEqual(out.stream_options, { include_usage: true });
});

test('请求:用户图片块 → image_url data URI;纯文本折叠为字符串', () => {
  const out = tr.translateRequest({
    model: 'm', max_tokens: 1,
    messages: [
      { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        { type: 'text', text: '这是什么' },
      ] },
      { role: 'user', content: [{ type: 'text', text: '只有文字' }] },
    ],
  });
  assert.deepStrictEqual(out.messages[0].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
  assert.deepStrictEqual(out.messages[0].content[1], { type: 'text', text: '这是什么' });
  assert.strictEqual(out.messages[1].content, '只有文字');
});

test('请求:assistant 的 text+tool_use → content + tool_calls(arguments 序列化)', () => {
  const out = tr.translateRequest({
    model: 'm', max_tokens: 1,
    messages: [{ role: 'assistant', content: [
      { type: 'text', text: '我来查一下' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    ] }],
  });
  const msg = out.messages[0];
  assert.strictEqual(msg.content, '我来查一下');
  assert.deepStrictEqual(msg.tool_calls, [
    { id: 'toolu_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
  ]);
});

test('请求:user 的多个 tool_result → 多条 role:tool;含图片追加 user 消息', () => {
  const out = tr.translateRequest({
    model: 'm', max_tokens: 1,
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
      { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [
        { type: 'text', text: '失败原因' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'R0c=' } },
      ] },
    ] }],
  });
  assert.deepStrictEqual(out.messages[0], { role: 'tool', tool_call_id: 'toolu_1', content: 'done' });
  assert.deepStrictEqual(out.messages[1], { role: 'tool', tool_call_id: 'toolu_2', content: '失败原因' });
  assert.strictEqual(out.messages[2].role, 'user', '图片应追加 user 消息');
  assert.deepStrictEqual(out.messages[2].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,R0c=' } });
});

test('请求:tools → functions;tool_choice 四态映射', () => {
  const tools = [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }];
  const base = { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tools };
  const out = tr.translateRequest(base);
  assert.deepStrictEqual(out.tools, [{ type: 'function', function: { name: 'Read', description: '读文件', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }]);
  assert.strictEqual(tr.translateRequest({ ...base, tool_choice: { type: 'auto' } }).tool_choice, 'auto');
  assert.strictEqual(tr.translateRequest({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.strictEqual(tr.translateRequest({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.deepStrictEqual(tr.translateRequest({ ...base, tool_choice: { type: 'tool', name: 'Read' } }).tool_choice,
    { type: 'function', function: { name: 'Read' } });
});

test('响应:text + tool_calls + usage + finish_reason 映射', () => {
  const out = tr.translateResponse({
    id: 'chatcmpl-1', model: 'gpt-5.6-sol',
    choices: [{ finish_reason: 'tool_calls', message: {
      content: '好的',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo hi"}' } }],
    } }],
    usage: { prompt_tokens: 123, completion_tokens: 45 },
  });
  assert.strictEqual(out.type, 'message');
  assert.strictEqual(out.stop_reason, 'tool_use');
  assert.deepStrictEqual(out.content, [
    { type: 'text', text: '好的' },
    { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo hi' } },
  ]);
  assert.deepStrictEqual(out.usage, { input_tokens: 123, output_tokens: 45 });
  assert.strictEqual(tr.translateResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop_reason, 'max_tokens');
  assert.strictEqual(tr.translateResponse({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }).stop_reason, 'end_turn');
});

test('流式:text 增量 + tool_calls 分片 + 末尾 usage → Anthropic 事件序列', () => {
  const t = tr.createStreamTranslator('gpt-5.6-sol');
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
  ];
  const events = chunks.flatMap((c) => t.push(c)).concat(t.finish());
  const types = events.map((e) => e.type);
  assert.deepStrictEqual(types, [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_delta', // text 你/好
    'content_block_stop',
    'content_block_start', // tool_use
    'content_block_delta', 'content_block_delta', // arguments 两片
    'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  assert.strictEqual(toolStart.content_block.name, 'Bash');
  assert.strictEqual(toolStart.content_block.id, 'call_1');
  assert.strictEqual(toolStart.index, 1, 'text 块之后 tool 块 index=1');
  const argDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta');
  assert.strictEqual(argDeltas.map((e) => e.delta.partial_json).join(''), '{"command":"ls"}');
  assert.ok(argDeltas.every((e) => e.index === 1), 'arguments 增量应归属 tool 块');
  const md = events.find((e) => e.type === 'message_delta');
  assert.strictEqual(md.delta.stop_reason, 'tool_use');
  assert.deepStrictEqual(md.usage, { input_tokens: 10, output_tokens: 20 }, '末尾 usage 应回填');
});

test('流式:多个并行 tool_calls 按 index 归属;stop finish → end_turn', () => {
  const t = tr.createStreamTranslator('m');
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'c1', type: 'function', function: { name: 'A', arguments: '{"x":1}' } },
      { index: 1, id: 'c2', type: 'function', function: { name: 'B', arguments: '{"y":2}' } },
    ] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const events = chunks.flatMap((c) => t.push(c)).concat(t.finish());
  const starts = events.filter((e) => e.type === 'content_block_start');
  assert.deepStrictEqual(starts.map((e) => e.content_block.name), ['A', 'B']);
  assert.deepStrictEqual(starts.map((e) => e.index), [0, 1]);
  const deltas = events.filter((e) => e.type === 'content_block_delta');
  assert.deepStrictEqual(deltas.map((e) => e.index), [0, 1], '两片 arguments 各归其块');
  const t2 = tr.createStreamTranslator('m');
  const ev2 = t2.push({ choices: [{ index: 0, delta: { content: '完' }, finish_reason: null }] })
    .concat(t2.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), t2.finish());
  assert.strictEqual(ev2.find((e) => e.type === 'message_delta').delta.stop_reason, 'end_turn');
});

test('错误透传:余额类 429 改写 402(防 claude.exe 静默重试);真限流保持 429', () => {
  const e = tr.translateError(429, { error: { message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exceeded' } });
  assert.strictEqual(e.status, 402, '余额耗尽须映射为不可重试的 402');
  assert.strictEqual(e.body.type, 'error');
  assert.strictEqual(e.body.error.type, 'billing_error');
  assert.ok(e.body.error.message.includes('no credits remaining'), '余额不足原文必须可见');
  const rl = tr.translateError(429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } });
  assert.strictEqual(rl.status, 429, '真限流保持 429 让客户端正常退避');
  assert.strictEqual(rl.body.error.type, 'rate_limit_error');
  assert.strictEqual(tr.translateError(401, { error: { message: 'bad key' } }).body.error.type, 'authentication_error');
  assert.strictEqual(tr.translateError(404, { error: { message: 'no model' } }).body.error.type, 'not_found_error');
  const e500 = tr.translateError(500, null);
  assert.strictEqual(e500.status, 500);
  assert.strictEqual(e500.body.error.message, 'HTTP 500', '无 body 时兜底状态码');
});

test('oaiUrl:标准端点补 /v1,Gemini OpenAI 兼容层(/openai 结尾)直接拼', () => {
  assert.strictEqual(tr.oaiUrl('https://api.openai.com', 'chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(tr.oaiUrl('https://api.openai.com/v1', 'chat/completions'), 'https://api.openai.com/v1/chat/completions', '自带 /v1 不重复');
  assert.strictEqual(tr.oaiUrl('https://openrouter.ai/api/v1/', 'models'), 'https://openrouter.ai/api/v1/models');
  assert.strictEqual(tr.oaiUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'chat/completions'),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'Gemini 兼容层不带 /v1');
  assert.strictEqual(tr.oaiUrl('https://generativelanguage.googleapis.com/v1beta/openai/', 'models'),
    'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.strictEqual(tr.oaiUrl('http://127.0.0.1:8080', 'models?limit=100'), 'http://127.0.0.1:8080/v1/models?limit=100');
});
