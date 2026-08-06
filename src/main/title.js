// 会话自动命名(v0.9.1):首条消息发出后,用会话自身的 Key+模型走 OpenAI 格式
// /v1/chat/completions 概括出短标题;模型不可用(未配置/请求失败)时退化为截取
// 首条消息前 20 字。本模块不依赖 electron(便于单测 mock fetch),store 操作由调用方注入。
const { apiRoot, authHeaders } = require('./aux-models');

const TITLE_TIMEOUT_MS = 10000;
const MAX_TITLE_LEN = 20;

// 清洗模型输出:去引号/标点/换行,限长;空串视为失败
function cleanTitle(s) {
  const t = String(s || '')
    .split('\n')[0]
    .replace(/^[\s"'「『《<【\[]+|[\s"'」』》>】\]。.!！?？,，、:：;；]+$/g, '')
    .trim();
  return t.slice(0, MAX_TITLE_LEN);
}

// 截取式兜底标题:首条消息首行前 20 字
function fallbackTitle(text) {
  const t = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  return t.slice(0, MAX_TITLE_LEN) || '新会话';
}

// 调用 chat 模型概括标题;成功返回标题字符串,失败返回 null
async function summarizeTitle(text, { keyEntry, model }) {
  if (!keyEntry || !keyEntry.key || !model) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiRoot(keyEntry.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(keyEntry) },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: `用不超过15个字概括下面这段话的主题,作为会话标题。只输出标题本身,不要引号、不要标点、不要解释。\n\n${String(text || '').slice(0, 2000)}`,
        }],
        max_tokens: 50,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return cleanTitle(json && json.choices && json.choices[0] && json.choices[0].message
      && json.choices[0].message.content) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 完整流程:先试模型概括,失败用截取兜底;写回前由 deps.getCurrentTitle() 再查一次,
// 用户已手动改名(标题非空)则不覆盖。deps: { keyEntry, model, getCurrentTitle, applyTitle }
async function autoTitle(text, deps) {
  const title = (await summarizeTitle(text, deps)) || fallbackTitle(text);
  if (!title) return null;
  const cur = typeof deps.getCurrentTitle === 'function' ? await deps.getCurrentTitle() : null;
  if (cur && String(cur).trim()) return null; // 用户已手动命名,尊重用户
  if (typeof deps.applyTitle === 'function') await deps.applyTitle(title);
  return title;
}

module.exports = { summarizeTitle, fallbackTitle, cleanTitle, autoTitle, MAX_TITLE_LEN };
