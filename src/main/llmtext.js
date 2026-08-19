// LLM 文本补全(v0.10.1,画布「文本生成」节点,md 1.1 文本生成:接入多家 LLM):
// OpenAI 格式 /v1/chat/completions 单次调用,key 解析/Bearer 兼容与 aigc/aux 同套。
// 本模块不依赖 electron(便于单测 mock fetch)。
const HTTP_TIMEOUT_MS = 120000;

// 与 keys.js/aigc.js 相同的归一化:去掉末尾 / 与 /v1 后缀,拼端点时补回 /v1
function apiRoot(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function authHeaders(keyEntry) {
  if (keyEntry.kind === 'authToken') return { authorization: `Bearer ${keyEntry.key}` };
  return { 'x-api-key': keyEntry.key };
}

// keyEntry: { key, kind, baseUrl };opts: { model, prompt, system? }
// 成功 { ok:true, text };失败 { ok:false, error }
async function complete(keyEntry, { model, prompt, system } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(prompt) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiRoot(keyEntry.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(keyEntry) },
      body: JSON.stringify({ model, messages }),
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) {
      const msg = (json && json.error && (json.error.message || json.error)) || (json && json.message) || '';
      return { ok: false, error: `HTTP ${res.status}${msg ? ' ' + msg : ''}` };
    }
    const c = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('\n') : '').trim();
    if (!text) return { ok: false, error: '模型返回空内容' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时(120s)' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { complete, apiRoot, authHeaders };
