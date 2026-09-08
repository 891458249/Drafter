// Anthropic Messages ↔ OpenAI Chat Completions 双向翻译(纯函数,无依赖,可单测)。
// 供 oai-proxy.js 使用:claude.exe 只讲 Anthropic 协议,OpenAI 协议的 Key
// (如 api.openai.com 官方)经本地代理翻译后驱动 Code/Chat 会话。
//
// 映射要点:
//  - system(字符串或 text 块数组,剥 cache_control)→ 合并为一条 system 消息
//  - assistant 的 tool_use → tool_calls;user 的 tool_result → N 条 role:tool 消息,
//    含 image 块的 tool_result 追加一条带 image_url 的 user 消息(OpenAI tool 消息只收文本)
//  - max_tokens → max_completion_tokens(o 系/GPT-5+ 必需,旧模型兼容);thinking/cache_control 丢弃
//  - finish_reason: stop→end_turn, length→max_tokens, tool_calls→tool_use, content_filter→refusal
//  - 错误透传保留上游原始 message(429 余额不足要能看到原文,而不是「模型不存在」)

// --- 请求:Anthropic → OpenAI -------------------------------------------------

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
  }
  return '';
}

// content 块数组 → OpenAI content(字符串或多模态数组);纯文本折叠为字符串
function contentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source && b.source.type === 'base64') {
      parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } });
    }
  }
  if (!parts.length) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

// tool_result 块的 content 可能是字符串或块数组 → 抽出文本;附带的 image 单独返回
function toolResultParts(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts = [], images = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && b.text) texts.push(b.text);
    else if (b.type === 'image' && b.source && b.source.type === 'base64') {
      images.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } });
    }
  }
  return { text: texts.join('\n'), images };
}

function translateMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'assistant') {
      // tool_use 块 → tool_calls;文本/图片仍进 content
      const blocks = Array.isArray(m.content) ? m.content : null;
      const toolUses = blocks ? blocks.filter((b) => b && b.type === 'tool_use') : [];
      const msg = { role: 'assistant' };
      msg.content = contentToOpenAI(blocks ? blocks.filter((b) => !b || b.type !== 'tool_use') : m.content);
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id, type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      }
      if (msg.content === '' && !msg.tool_calls) msg.content = '';
      out.push(msg);
      continue;
    }
    // user:tool_result 拆 role:tool;其余走 content 映射
    const blocks = Array.isArray(m.content) ? m.content : null;
    const toolResults = blocks ? blocks.filter((b) => b && b.type === 'tool_result') : [];
    if (blocks && toolResults.length) {
      // 同一 user 消息里可能混有普通文本块,先出普通部分
      const plain = blocks.filter((b) => !b || b.type !== 'tool_result');
      if (plain.length) out.push({ role: 'user', content: contentToOpenAI(plain) });
      for (const tr of toolResults) {
        const { text, images } = toolResultParts(tr.content);
        out.push({
          role: 'tool', tool_call_id: tr.tool_use_id,
          content: tr.is_error ? (text || '(error)') : (text || '(empty)'),
        });
        // tool 消息不能带图:图片(Read 读图)追加一条 user 消息
        if (images.length) {
          out.push({ role: 'user', content: [...images, { type: 'text', text: '(上述工具结果包含的图片)' }] });
        }
      }
      continue;
    }
    out.push({ role: 'user', content: contentToOpenAI(m.content) });
  }
  return out;
}

function translateTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

function translateToolChoice(tc) {
  if (!tc || !tc.type) return undefined;
  switch (tc.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return tc.name ? { type: 'function', function: { name: tc.name } } : 'required';
    default: return undefined;
  }
}

function translateRequest(body) {
  const out = { model: body.model, messages: translateMessages(body.messages) };
  const sys = systemText(body.system);
  if (sys) out.messages.unshift({ role: 'system', content: sys });
  if (body.max_tokens != null) out.max_completion_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  const tools = translateTools(body.tools);
  if (tools) out.tools = tools;
  const tc = translateToolChoice(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (body.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  // 丢弃:metadata / thinking / cache_control / anthropic-beta 等
  return out;
}

// --- 响应(非流式):OpenAI → Anthropic ------------------------------------------

const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };

function parseArgs(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function translateResponse(json) {
  const ch = (json.choices && json.choices[0]) || {};
  const msg = ch.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  else if (Array.isArray(msg.content)) {
    const t = msg.content.map((p) => (p && p.text) || '').filter(Boolean).join('\n');
    if (t) content.push({ type: 'text', text: t });
  }
  if (msg.refusal) content.push({ type: 'text', text: String(msg.refusal) });
  for (const tc of msg.tool_calls || []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input: parseArgs(tc.function && tc.function.arguments) });
  }
  const usage = json.usage || {};
  return {
    id: json.id || 'msg_oai',
    type: 'message',
    role: 'assistant',
    model: json.model || '',
    content,
    stop_reason: STOP_REASON[ch.finish_reason] || (msg.tool_calls && msg.tool_calls.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// --- 流式:OpenAI SSE chunk → Anthropic SSE 事件 --------------------------------
// 用法:const t = createStreamTranslator(model);
//   t.push(chunkJson) → [anthropicEvent, ...];t.finish() → 收尾事件
// chunk 形如 OpenAI chat.completion.chunk;最后一个 chunk 带 usage(stream_options)。

function createStreamTranslator(model) {
  const msgId = 'msg_' + Math.random().toString(36).slice(2);
  let started = false;
  // block 状态:当前打开的 Anthropic content blocks;index 递增
  // OpenAI tool_calls 按 tc.index 对到 block;文本块若存在恒为 block 0
  let openBlock = null; // { kind:'text'|'tool', index, tcIndex? }
  let nextIndex = 0;
  let sawText = false;
  let toolBlocks = new Map(); // tcIndex → block index
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finishReason = null;

  const startMsg = () => ({
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

  function closeOpenBlock(events) {
    if (!openBlock) return;
    events.push({ type: 'content_block_stop', index: openBlock.index });
    openBlock = null;
  }

  function openTextBlock(events) {
    closeOpenBlock(events);
    openBlock = { kind: 'text', index: nextIndex++ };
    sawText = true;
    events.push({ type: 'content_block_start', index: openBlock.index, content_block: { type: 'text', text: '' } });
  }

  function openToolBlock(events, tc) {
    closeOpenBlock(events);
    const idx = nextIndex++;
    toolBlocks.set(tc.index, idx);
    openBlock = { kind: 'tool', index: idx, tcIndex: tc.index };
    events.push({
      type: 'content_block_start', index: idx,
      content_block: { type: 'tool_use', id: tc.id || 'toolu_oai_' + tc.index, name: (tc.function && tc.function.name) || '', input: {} },
    });
  }

  function push(chunk) {
    const events = [];
    if (!started) { started = true; events.push(startMsg()); }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens || 0,
        output_tokens: chunk.usage.completion_tokens || 0,
      };
    }
    const ch = (chunk.choices && chunk.choices[0]) || null;
    if (!ch) return events; // 纯 usage chunk
    const delta = ch.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      if (!openBlock || openBlock.kind !== 'text') openTextBlock(events);
      events.push({ type: 'content_block_delta', index: openBlock.index, delta: { type: 'text_delta', text: delta.content } });
    }
    if (delta.refusal) {
      if (!openBlock || openBlock.kind !== 'text') openTextBlock(events);
      events.push({ type: 'content_block_delta', index: openBlock.index, delta: { type: 'text_delta', text: String(delta.refusal) } });
    }
    for (const tc of delta.tool_calls || []) {
      if (!toolBlocks.has(tc.index)) {
        // 新 tool_call(OpenAI 保证首个 fragment 带 id/name;缺省由 openToolBlock 兜底)
        openToolBlock(events, tc);
      } else if (openBlock && openBlock.kind === 'tool' && openBlock.tcIndex !== tc.index) {
        // 切回同一消息里此前已开的 tool 块(OpenAI 不交错,防御性)
        openBlock = { kind: 'tool', index: toolBlocks.get(tc.index), tcIndex: tc.index };
      }
      const args = tc.function && tc.function.arguments;
      if (args) {
        events.push({ type: 'content_block_delta', index: toolBlocks.get(tc.index), delta: { type: 'input_json_delta', partial_json: args } });
      }
    }
    if (ch.finish_reason) finishReason = ch.finish_reason;
    return events;
  }

  function finish() {
    const events = [];
    if (!started) { started = true; events.push(startMsg()); }
    closeOpenBlock(events);
    events.push({
      type: 'message_delta',
      delta: { stop_reason: STOP_REASON[finishReason] || (toolBlocks.size ? 'tool_use' : 'end_turn'), stop_sequence: null },
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    });
    events.push({ type: 'message_stop' });
    return events;
  }

  return { push, finish, get sawText() { return sawText; } };
}

// --- 错误透传:OpenAI 错误体 → Anthropic 错误格式(保留原始 message) -------------
// 返回 { status, body };status 可能被改写:
//  - 余额/配额类(429 insufficient_quota / credit_balance_exceeded)→ 402。
//    claude.exe 对 HTTP 429 会静默指数退避重试数分钟(UI 表现为「已发送,等待响应」
//    卡死),而余额耗尽重试无意义;402 不可重试,错误原文立即显示给用户。

function translateError(status, json) {
  const src = (json && json.error) || {};
  const message = src.message || (json && json.message) || `HTTP ${status}`;
  const isBilling = src.type === 'insufficient_quota' || src.code === 'credit_balance_exceeded' || src.code === 'billing_hard_limit_reached';
  if (isBilling) return { status: 402, body: { type: 'error', error: { type: 'billing_error', message } } };
  let type = 'api_error';
  if (status === 401) type = 'authentication_error';
  else if (status === 403) type = 'permission_error';
  else if (status === 404) type = 'not_found_error';
  else if (status === 429) type = src.code === 'rate_limit_exceeded' ? 'rate_limit_error' : 'api_error';
  else if (status === 400) type = 'invalid_request_error';
  return { status, body: { type: 'error', error: { type, message } } };
}

module.exports = {
  translateRequest, translateResponse, createStreamTranslator, translateError,
  // 暴露内部给单测细查
  systemText, contentToOpenAI, toolResultParts, translateMessages, translateTools, translateToolChoice,
};
