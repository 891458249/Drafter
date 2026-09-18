// 会话级子 Agent 模型选择器:主模型自动从同 Key 的已选模型中按任务调度。
import { api, state, $, escapeHtml, ensureGroups } from './state.js';

let entriesCache = [];
let customAgentsCache = []; // 自定义子 Agent(扩展板块,v0.15.16)
let toggling = false; // 防快速连点并发提交导致勾选互相覆盖

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

// 会话挂载的自定义子 Agent id(扩展板块创建,scope=session 时经此挂载生效)
function customSelected(s) {
  return Array.isArray(s && s.meta.customAgentIds) ? s.meta.customAgentIds : [];
}

export function updateAgentModelsSelector() {
  const s = state.sessions.get(state.activeSid);
  const btn = $('agent-models-btn');
  const name = $('agent-models-name');
  if (!btn || !name) return;
  const count = selected(s).length + customSelected(s).length;
  name.textContent = count ? `子 Agent (${count})` : '子 Agent';
  btn.classList.toggle('active', count > 0);
  const disabledReason = !s ? '没有活动会话'
    : isMediaSession(s) ? '创作会话不使用 Agent SDK'
      : isFastChat(s) ? '极速问答为零工具模式,请先切换到 Agent 模式'
        : !s.meta.keyId ? '请先选择带 API Key 的主模型'
          : null;
  btn.disabled = !!disabledReason;
  btn.title = disabledReason || (s.meta.agentModelsPending
    ? `已启用 ${count} 个子 Agent 模型(新配置待当前回合结束后生效)`
    : count
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
  if (!s || toggling) return;
  toggling = true;
  const sid = s.meta.id;
  try {
    const before = selected(s);
    const key = selectedKey(item);
    const next = before.some((x) => selectedKey(x) === key)
      ? before.filter((x) => selectedKey(x) !== key)
      : [...before, { keyId: item.keyId, model: item.model }];
    const result = await api.sessSetAgentModels(sid, next);
    if (!result || !result.ok) {
      alert((result && result.error) || '子 Agent 模型设置失败');
      return;
    }
    const cur = state.sessions.get(sid);
    if (!cur) return;
    cur.meta.agentModels = result.agentModels || [];
    // 回合进行中:新配置待重启生效;取消勾选已由守卫立即拦截新调用,
    // 但新增模型要等重启注册,旧子任务也仍在按启动配置运行——如实提示
    cur.meta.agentModelsPending = !!result.pending;
    updateAgentModelsSelector();
    if (state.activeSid === sid) renderMenu(cur);
  } finally {
    toggling = false;
  }
}

async function toggleCustomAgent(agent) {
  const s = state.sessions.get(state.activeSid);
  if (!s || toggling) return;
  toggling = true;
  const sid = s.meta.id;
  try {
    const before = customSelected(s);
    const next = before.includes(agent.id)
      ? before.filter((x) => x !== agent.id)
      : [...before, agent.id];
    const result = await api.sessSetCustomAgents(sid, next);
    if (!result || !result.ok) {
      alert((result && result.error) || '自定义子 Agent 挂载失败');
      return;
    }
    const cur = state.sessions.get(sid);
    if (!cur) return;
    cur.meta.customAgentIds = result.customAgentIds || [];
    updateAgentModelsSelector();
    if (state.activeSid === sid) renderMenu(cur);
  } finally {
    toggling = false;
  }
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
  // 自定义子 Agent(扩展板块 v0.15.16):global/project 作用域自动生效,仅列出
  // 会话作用域的可在此挂载;挂载写 meta.customAgentIds。
  const customs = customAgentsCache.filter((a) => a.enabled !== false);
  const sessionScoped = customs.filter((a) => a.scope === 'session');
  const autoActive = customs.filter((a) => a.scope !== 'session');
  if (customs.length) {
    const t = document.createElement('div');
    t.className = 'agent-menu-title';
    t.innerHTML = '自定义 Agent <span>扩展板块创建</span>';
    menu.appendChild(t);
    const cur = new Set(customSelected(s));
    for (const a of sessionScoped) {
      const bound = a.scopeId === s.meta.id; // 创建时绑定了本会话:自动生效
      const active = bound || cur.has(a.id);
      const row = document.createElement('button');
      row.className = 'agent-model-row' + (active ? ' active' : '');
      row.innerHTML = `<span class="agent-model-check">${active ? '✓' : ''}</span><span title="${escapeHtml(a.desc || a.name)}">${escapeHtml(a.name)}${bound ? ' <small>(已绑定本会话)</small>' : ''}</span>`;
      if (bound) row.disabled = true;
      else row.onclick = (event) => { event.stopPropagation(); toggleCustomAgent(a); };
      menu.appendChild(row);
    }
    for (const a of autoActive) {
      const row = document.createElement('button');
      row.className = 'agent-model-row active';
      row.disabled = true;
      row.title = a.scope === 'global' ? '全局作用域,所有会话自动生效' : '项目作用域,该项目下会话自动生效';
      row.innerHTML = `<span class="agent-model-check">✓</span><span title="${escapeHtml(a.desc || a.name)}">${escapeHtml(a.name)} <small>(${a.scope === 'global' ? '全局' : '项目'})</small></span>`;
      menu.appendChild(row);
    }
  }
  const note = document.createElement('div');
  note.className = 'agent-menu-note';
  note.textContent = s.meta.agentModelsPending
    ? `已保存 ${current.size} 个,当前回合结束后生效;守卫已立即按最新勾选拦截新调用,但运行中的子任务仍按旧配置执行`
    : current.size ? `已选择 ${current.size} 个;仅在主模型决定委派时调用` : '未选择时禁用 Agent 工具,只消耗主模型';
  menu.appendChild(note);
  if (s.meta.agentModelsPending) {
    const stop = document.createElement('button');
    stop.className = 'agent-model-row agent-model-stop';
    stop.innerHTML = '<span class="agent-model-check">⏹</span><span>停止当前回合并立即应用新配置</span>';
    stop.onclick = (event) => {
      event.stopPropagation();
      api.sessInterrupt(s.meta.id); // 回合结束后 needRestart 自动 resume 重启
      hideAgentModelsMenu();
    };
    menu.appendChild(stop);
  }
  positionMenu(menu, $('agent-models-btn'));
}

async function openAgentModelsMenu() {
  const s = state.sessions.get(state.activeSid);
  if (!s || $('agent-models-btn').disabled) return;
  try {
    await ensureGroups();
    entriesCache = await api.keysEnabledModels() || [];
  } catch { entriesCache = []; }
  try { customAgentsCache = await api.extList('agent') || []; } catch { customAgentsCache = []; }
  renderMenu(s);
}

export function hideAgentModelsMenu() {
  const menu = $('agent-models-menu');
  if (menu) menu.classList.add('hidden');
}

export function init() {
  const btn = $('agent-models-btn');
  if (!btn) return;
  // 回合结束(needRestart 重启)后清除「待生效」状态
  api.on('sess:event', ({ sid, ev } = {}) => {
    if (!sid || !ev || ev.type !== 'ui_status' || ev.busy) return;
    const s = state.sessions.get(sid);
    if (!s || !s.meta.agentModelsPending) return;
    s.meta.agentModelsPending = false;
    if (sid === state.activeSid) updateAgentModelsSelector();
  });
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
