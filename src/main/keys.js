// Multi-API-key management + per-key model discovery (/v1/models).
// Data lives in store settings:
//   apiKeys: [{ id, name, key, baseUrl, kind: 'apiKey'|'authToken', models: [id…], modelsAt, usageUrl, balanceCache? }]
//   activeKeyId: string
// Renderer never receives full keys — only hints (…last4).
const crypto = require('crypto');
const store = require('./store');

const OFFICIAL_API = 'https://api.anthropic.com';

// --- migration: legacy single settings.apiKey → apiKeys list --------------
function ensureMigrated() {
  const s = store.loadStore();
  if (Array.isArray(s.settings?.apiKeys)) return;
  const legacy = store.getSetting('apiKey');
  const list = legacy
    ? [{ id: 'k_' + crypto.randomUUID().slice(0, 8), name: '默认 Key', key: legacy, baseUrl: '', kind: 'apiKey', models: [], modelsAt: 0 }]
    : [];
  store.update((st) => {
    st.settings = st.settings || {};
    st.settings.apiKeys = list;
    if (legacy) st.settings.activeKeyId = list[0].id;
    delete st.settings.apiKey;
  });
}

function listRaw() {
  ensureMigrated();
  return store.getSetting('apiKeys', []) || [];
}

const sanitize = ({ key, ...rest }) => ({ ...rest, keyHint: key ? '…' + key.slice(-4) : '' });

function list() {
  return listRaw().map((k) => ({ ...sanitize(k), usage: store.getKeyUsage(k.id), canBalance: !!balanceProvider(k.baseUrl) }));
}

function activeKey() {
  ensureMigrated();
  const id = store.getSetting('activeKeyId');
  const k = listRaw().find((x) => x.id === id);
  return k || null;
}

function guessKind(key) {
  return /^sk-ant-/i.test(key || '') ? 'apiKey' : 'authToken';
}

// save: { id?, name, key, baseUrl?, kind?, usageUrl?, ... } → 保存后返回脱敏列表
function save(entry) {
  ensureMigrated();
  const list = listRaw();
  const id = entry.id || 'k_' + crypto.randomUUID().slice(0, 8);
  const i = list.findIndex((x) => x.id === id);
  const prev = i >= 0 ? list[i] : {};
  const usageUrl = entry.usageUrl !== undefined ? String(entry.usageUrl || '').trim() : (prev.usageUrl || '');
  if (usageUrl && !/^https?:\/\//.test(usageUrl)) return { ok: false, error: '用量查询网址仅支持 http/https' };
  const next = {
    ...prev,
    id,
    name: String(entry.name || prev.name || 'Key').trim() || 'Key',
    key: entry.key !== undefined ? String(entry.key).trim() : (prev.key || ''),
    baseUrl: entry.baseUrl !== undefined ? String(entry.baseUrl || '').trim() : (prev.baseUrl || ''),
    kind: entry.kind || prev.kind || guessKind(entry.key || prev.key),
    usageUrl,
    models: prev.models || [],
    modelsAt: prev.modelsAt || 0,
    modelsEnabled: entry.modelsEnabled !== undefined ? entry.modelsEnabled : (prev.modelsEnabled ?? null), // null = 全部显示
    quotaWeek: entry.quotaWeek !== undefined ? (Number(entry.quotaWeek) || 0) : (prev.quotaWeek || 0), // 0 = 不限
    quotaMonth: entry.quotaMonth !== undefined ? (Number(entry.quotaMonth) || 0) : (prev.quotaMonth || 0),
  };
  if (!next.key) return { ok: false, error: 'Key 不能为空' };
  if (i >= 0) list[i] = next; else list.push(next);
  store.setSetting('apiKeys', list);
  if (!store.getSetting('activeKeyId')) store.setSetting('activeKeyId', id);
  return { ok: true, id, list: list.map(sanitize) };
}

function remove(id) {
  ensureMigrated();
  store.setSetting('apiKeys', listRaw().filter((x) => x.id !== id));
  if (store.getSetting('activeKeyId') === id) {
    const rest = listRaw();
    store.setSetting('activeKeyId', rest.length ? rest[0].id : null);
  }
  return list();
}

function setActive(id) {
  if (!listRaw().some((x) => x.id === id)) return { ok: false, error: 'Key 不存在' };
  store.setSetting('activeKeyId', id);
  return { ok: true };
}

// --- model discovery --------------------------------------------------------
async function fetchModels(entry) {
  const base = (entry.baseUrl || OFFICIAL_API).replace(/\/+$/, '');
  const headers = { 'anthropic-version': '2023-06-01' };
  if (entry.kind === 'authToken') headers['authorization'] = `Bearer ${entry.key}`;
  else headers['x-api-key'] = entry.key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${base}/v1/models?limit=100`, { headers, signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    const ids = (json.data || json.models || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return { ok: false, error: '接口返回空模型列表' };
    return { ok: true, models: ids };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 拉取并缓存某个 key 的模型列表
async function refreshModels(id) {
  const k = listRaw().find((x) => x.id === id);
  if (!k) return { ok: false, error: 'Key 不存在' };
  const r = await fetchModels(k);
  if (!r.ok) return r;
  const list = listRaw();
  const i = list.findIndex((x) => x.id === id);
  list[i] = { ...list[i], models: r.models, modelsAt: Date.now() };
  store.setSetting('apiKeys', list);
  return { ok: true, models: r.models };
}

// --- provider balance lookup(v0.8.1) -----------------------------------------
// 基地址 host → 余额查询函数映射;未命中不自动查询(仅 usageUrl 跳转或本地额度)
const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

async function httpGetJson(url, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, error: res.status === 401 ? '认证失败(401):Key 与平台不匹配或已失效' : `HTTP ${res.status}` };
    }
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Moonshot 按量计费:api.moonshot.cn(国内)/ api.moonshot.ai、api.kimi.ai(国际)
async function moonshotBalance(entry, base) {
  const r = await httpGetJson(`${base}/v1/users/me/balance`, entry.key);
  if (!r.ok) return r;
  const d = r.json.data || {};
  const text = `可用余额 ¥${money(d.available_balance ?? 0)}(代金券 ¥${money(d.voucher_balance ?? 0)} / 现金 ¥${money(d.cash_balance ?? 0)})`;
  return { ok: true, text };
}

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };
async function deepseekBalance(entry, base) {
  const r = await httpGetJson(`${base}/user/balance`, entry.key);
  if (!r.ok) return r;
  const infos = Array.isArray(r.json.balance_infos) ? r.json.balance_infos : [];
  if (!infos.length) return { ok: false, error: '接口返回空余额列表' };
  const parts = infos.map((b) => `${CURRENCY_SYMBOL[b.currency] || b.currency + ' '}${money(b.total_balance ?? 0)}`);
  return { ok: true, text: `合计余额 ${parts.join(' / ')}` };
}

const BALANCE_PROVIDERS = [
  { hosts: ['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.ai'], query: moonshotBalance },
  { hosts: ['api.deepseek.com'], query: deepseekBalance },
];

function balanceProvider(baseUrl) {
  if (!baseUrl) return null;
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return null; }
  return BALANCE_PROVIDERS.find((p) => p.hosts.includes(host)) || null;
}

// 查余额并缓存展示文本(entry.balanceCache { at, text });失败不写缓存、不打断调用方
async function queryBalance(id) {
  const k = listRaw().find((x) => x.id === id);
  if (!k) return { ok: false, error: 'Key 不存在' };
  const provider = balanceProvider(k.baseUrl);
  if (!provider) return { ok: false, error: '该 Key 的 Base URL 未匹配自动余额查询' };
  const r = await provider.query(k, k.baseUrl.replace(/\/+$/, ''));
  if (!r.ok) return r;
  const list = listRaw();
  const i = list.findIndex((x) => x.id === id);
  list[i] = { ...list[i], balanceCache: { at: Date.now(), text: r.text } };
  store.setSetting('apiKeys', list);
  return r;
}

// 当前活跃 key 的可用模型(勾选白名单优先;无缓存则 null,由调用方回退默认列表)
function activeModels() {
  const k = activeKey();
  if (!k) return null;
  if (Array.isArray(k.modelsEnabled) && k.modelsEnabled.length) return k.modelsEnabled;
  return k.models && k.models.length ? k.models : null;
}

// 保存模型勾选白名单(null = 恢复全部显示)
function setModelsEnabled(id, enabled) {
  const list = listRaw();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: 'Key 不存在' };
  list[i] = { ...list[i], modelsEnabled: enabled && enabled.length ? enabled : null };
  store.setSetting('apiKeys', list);
  return { ok: true };
}

module.exports = { list, save, remove, setActive, activeKey, activeModels, refreshModels, setModelsEnabled, queryBalance, balanceProvider };
