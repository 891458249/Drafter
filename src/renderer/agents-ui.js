// 会话级子 Agent 模型选择器:主模型自动从同 Key 的已选模型中按任务调度。
import { api, state, $, escapeHtml, ensureGroups } from './state.js';

let entriesCache = [];

function isFastChat(s) {
  return !!s && s.meta.kind === 'chat' && s.meta.chatMode !== 'agent';
}

function isMediaSession(s) {
  return !!(s && s.meta.kind && s.meta.kind !== 'code' && s.meta.kind !== 'chat');
}

function modelType(keyId, model) {
  const groups = state.GroupsCache.get(keyId);
  if (!groups) return 'chat';
  const group = groups.find((g) => Array.isArray(g.models) && g.models.includes(model));
  return group ? group.model_type : 'chat';
}

function selected(s) {
  return Array.isArray(s && s.meta.agentModels) ? s.meta.agentModels : [];
}

function selectedKey(item) { return `${item.keyId}\u0000${item.model}`; }

export function updateAgentModelsSelector() {
  const s = state.sessions.get(state.activeSid);
  const btn = $('agent-models-btn');
  const name = $('agent-models-name');
  if (!btn || !name) return;
  const count = selected(s).length;
  name.textContent = count ? `子 Agent (${count})` : '子 Agent';
  btn.classList.toggle('active', count > 0);
  const disabledReason = !s ? '没有活动会话'
    : isMediaSession(s) ? '创作会话不使用 Agent SDK'
      : isFastChat(s) ? '极速问答为零工具模式,请先切换到 Agent 模式'
        : !s.meta.keyId ? '请先选择带 API Key 的主模型'
          : null;
  btn.disabled = !!disabledReason;
  btn.title = disabledReason || (count
    ? `已启用 ${count} 个子 Agent 模型;主模型会按任务自动选择调用`
    : '未启用子 Agent,当前会话只使用主模型');
  if (btn.disabled) hideAgentModelsMenu();
}

function positionMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  menu.classList.remove('hidden');
  const height = menu.offsetHeight;
  const below = window.innerHeight - r.bottom - 6;
  if (below >= height) {
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.maxHeight = '';
  } else {
    menu.style.top = Math.max(8, r.top - 6 - height) + 'px';
    menu.style.maxHeight = Math.max(120, r.top - 14) + 'px';
  }
}

async function toggleModel(item) {
  const s = state.sessions.get(state.activeSid);
  if (!s) return;
  const before = selected(s);
  const key = selectedKey(item);
  const next = before.some((x) => selectedKey(x) === key)
    ? before.filter((x) => selectedKey(x) !== key)
    : [...before, { keyId: item.keyId, model: item.model }];
  const result = await api.sessSetAgentModels(s.meta.id, next);
  if (!result || !result.ok) {
    alert((result && result.error) || '子 Agent 模型设置失败');
    return;
  }
  s.meta.agentModels = result.agentModels || [];
  updateAgentModelsSelector();
  renderMenu(s);
}

function renderMenu(s) {
  const menu = $('agent-models-menu');
  if (!menu || !s) return;
  const current = new Set(selected(s).map(selectedKey));
  const candidates = entriesCache
    .filter((e) => e.keyId === s.meta.keyId && e.model !== s.meta.model && modelType(e.keyId, e.model) === 'chat')
    .filter((e, i, a) => a.findIndex((x) => x.keyId === e.keyId && x.model === e.model) === i);
  menu.innerHTML = '<div class="agent-menu-title">子 Agent 模型 <span>主模型自动调度</span></div>';
  if (!candidates.length) {
    menu.innerHTML += '<div class="agent-menu-empty">当前 Key 没有其他可用的对话模型</div>';
  } else {
    for (const item of candidates) {
      const row = document.createElement('button');
      const active = current.has(selectedKey(item));
      row.className = 'agent-model-row' + (active ? ' active' : '');
      row.innerHTML = `<span class="agent-model-check">${active ? '✓' : ''}</span><span title="${escapeHtml(item.model)}">${escapeHtml(item.model)}</span>`;
      row.onclick = (event) => { event.stopPropagation(); toggleModel(item); };
      menu.appendChild(row);
    }
  }
  const note = document.createElement('div');
  note.className = 'agent-menu-note';
  note.textContent = current.size ? `已选择 ${current.size} 个;仅在主模型决定委派时调用` : '未选择时禁用 Agent 工具,只消耗主模型';
  menu.appendChild(note);
  positionMenu(menu, $('agent-models-btn'));
}

async function openAgentModelsMenu() {
  const s = state.sessions.get(state.activeSid);
  if (!s || $('agent-models-btn').disabled) return;
  try {
    await ensureGroups();
    entriesCache = await api.keysEnabledModels() || [];
  } catch { entriesCache = []; }
  renderMenu(s);
}

export function hideAgentModelsMenu() {
  const menu = $('agent-models-menu');
  if (menu) menu.classList.add('hidden');
}

export function init() {
  const btn = $('agent-models-btn');
  if (!btn) return;
  btn.onclick = (event) => {
    event.stopPropagation();
    const menu = $('agent-models-menu');
    if (!menu.classList.contains('hidden')) hideAgentModelsMenu();
    else openAgentModelsMenu();
  };
  document.addEventListener('click', (event) => {
    const menu = $('agent-models-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(event.target)) hideAgentModelsMenu();
  });
  updateAgentModelsSelector();
}
