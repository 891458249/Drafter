// App entry: landing, project open, topbar, panels, modals, shortcuts, wiring.
import { api, state, $, escapeHtml, on, emit, EFFORT_LEVELS, EFFORT_NAMES, currentEffort, fmtTokens } from './state.js';
import * as chat from './chat.js';
import * as sessionsUi from './sessions-ui.js';
import * as input from './input.js';
import * as diff from './diff.js';
import * as editor from './editor.js';
import * as preview from './preview.js';
import * as tasks from './tasks.js';
import * as term from './term.js';

// ---------------------------------------------------------------------------
// Global error reporting → main-process persistent log (metadata only)
// ---------------------------------------------------------------------------
window.addEventListener('error', (e) => {
  try {
    api.reportError({
      source: 'onerror',
      message: e.message,
      stack: e.error && e.error.stack,
      url: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    api.reportError({
      source: 'unhandledrejection',
      message: (r && r.message) || String(r),
      stack: r && r.stack,
    });
  } catch {}
});

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------
async function initLanding() {
  const store = await api.getStore();
  const recent = store.recentProjects || [];
  renderRecent(recent);
  initEffort(store.settings || {});
  const sdk = await api.sdkStatus();
  if (!sdk.ok) {
    const w = $('sdk-warning');
    w.classList.remove('hidden');
    w.textContent = 'Agent SDK 未安装,会话功能不可用。请在项目目录执行:npm install @anthropic-ai/claude-agent-sdk。错误:' + (sdk.error || '');
    return; // SDK 不可用时停在首屏显示提示
  }
  // 无全局目录:直接恢复最近活跃的会话(跨所有项目组);没有会话则停留首屏
  const list = await api.sessList();
  const latest = list
    .filter((m) => !m.archived)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (latest) {
    enterWorkspace();
    chat.ensureSession(latest.id, latest);
    chat.setActiveSession(latest.id);
    sessionsUi.refreshList();
  }
}

function renderRecent(list) {
  const ul = $('recent-list');
  ul.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.textContent = '(暂无)';
    li.style.cursor = 'default';
    ul.appendChild(li);
    return;
  }
  for (const dir of list) {
    const li = document.createElement('li');
    li.textContent = dir;
    li.title = dir;
    li.onclick = () => openDirAsProject(dir);
    ul.appendChild(li);
  }
}

$('btn-pick').onclick = async () => {
  const res = await api.pickDir();
  if (res && res.dir) openDirAsProject(res.dir);
};

function enterWorkspace() {
  $('landing').classList.add('hidden');
  $('workspace').classList.remove('hidden');
}

// 打开一个目录:目录归属各自的项目组(不存在则自动创建),没有全局目录概念。
async function openDirAsProject(dir) {
  enterWorkspace();
  await api.addRecent(dir);
  const list = await api.sessList();
  const existing = list
    .filter((m) => m.cwd === dir && !m.archived)
    .sort((a, b2) => (b2.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (existing) {
    chat.ensureSession(existing.id, existing);
    chat.setActiveSession(existing.id);
  } else {
    const meta = await api.sessCreate({
      cwd: dir,
      model: $('model-sel').value || null,
      permissionMode: $('perm-mode').value,
      effort: currentEffort(),
    });
    chat.ensureSession(meta.id, meta);
    chat.setActiveSession(meta.id);
  }
  sessionsUi.refreshList();
  diff.refreshDiff();
}

// ---------------------------------------------------------------------------
// Topbar controls
// ---------------------------------------------------------------------------
$('perm-mode').onchange = async () => {
  if (state.activeSid) {
    await api.sessSetMode(state.activeSid, $('perm-mode').value);
    const s = state.sessions.get(state.activeSid);
    if (s) s.meta.permissionMode = $('perm-mode').value;
  }
};

$('model-sel').onchange = async () => {
  if (state.activeSid) {
    await api.sessSetModel(state.activeSid, $('model-sel').value || null);
    const s = state.sessions.get(state.activeSid);
    if (s) s.meta.model = $('model-sel').value || null;
    $('model-sel-composer').value = $('model-sel').value;
  }
};

$('view-mode').onchange = () => chat.setViewMode($('view-mode').value);

// ---------------------------------------------------------------------------
// Effort 滑块(Faster ↔ Smarter):控制思考深度与 token 消耗
// ---------------------------------------------------------------------------
function effortUiSet(level) {
  const idx = Math.max(0, EFFORT_LEVELS.indexOf(level || 'high'));
  $('effort-slider').value = idx;
  $('effort-btn-label').textContent = EFFORT_NAMES[EFFORT_LEVELS[idx]];
  $('effort-pop-level').textContent = EFFORT_NAMES[EFFORT_LEVELS[idx]];
}

function initEffort(settings) {
  effortUiSet(settings.defaultEffort || 'high');

  $('btn-effort').onclick = (e) => {
    e.stopPropagation();
    $('effort-pop').classList.toggle('hidden');
  };
  $('effort-pop').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => $('effort-pop').classList.add('hidden'));

  $('effort-slider').oninput = () => {
    const level = currentEffort();
    $('effort-btn-label').textContent = EFFORT_NAMES[level];
    $('effort-pop-level').textContent = EFFORT_NAMES[level];
  };
  $('effort-slider').onchange = async () => {
    const level = currentEffort();
    await api.setSetting('defaultEffort', level); // 新会话默认值
    if (state.activeSid) {
      await api.sessSetEffort(state.activeSid, level);
      const s = state.sessions.get(state.activeSid);
      if (s) s.meta.effort = level;
    }
  };
}

// 切换会话时同步显示该会话的 effort(chat.js 触发)
on('session-effort', (level) => effortUiSet(level || 'high'));

// ---------------------------------------------------------------------------
// Token 用量 / 上下文窗口弹层(输入框右下角)
// ---------------------------------------------------------------------------
function modelCtxMax(model) { return /haiku/i.test(model || '') ? 200000 : 1000000; }

function shortModelName(m) {
  if (/fable/i.test(m)) return 'Fable 5';
  if (/mythos/i.test(m)) return 'Mythos 5';
  if (/opus/i.test(m)) return 'Opus';
  if (/sonnet/i.test(m)) return 'Sonnet';
  if (/haiku/i.test(m)) return 'Haiku';
  return m === 'default' ? '默认模型' : m;
}

function ctxInfo() {
  const s = state.sessions.get(state.activeSid);
  const u = s && s.ui.lastUsage;
  const model = (s && (s.meta.model || s.ui.initModel)) || '';
  const used = u
    ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    : 0;
  const max = modelCtxMax(model);
  return { used, max, pct: Math.min(100, Math.round((used / max) * 100)) };
}

function updateUsageButton() {
  const { pct } = ctxInfo();
  $('btn-usage-label').textContent = `上下文 ${pct}%`;
}

// 官方单价($/MTok):折算金额用;缓存读按 0.1×输入价、缓存写按 1.25×输入价
function modelPricing(m) {
  if (/fable|mythos/i.test(m)) return { in: 10, out: 50 };
  if (/opus/i.test(m)) return { in: 5, out: 25 };
  if (/sonnet/i.test(m)) return { in: 3, out: 15 };
  if (/haiku/i.test(m)) return { in: 1, out: 5 };
  return { in: 5, out: 25 }; // 未知模型按 Opus 档估算
}

function estCost(m, v) {
  const p = modelPricing(m);
  return ((v.input || 0) * p.in
    + (v.cacheRead || 0) * p.in * 0.1
    + (v.cacheWrite || 0) * p.in * 1.25
    + (v.output || 0) * p.out) / 1e6;
}

function fmtMoney(n) { return '$' + (n < 0.1 ? n.toFixed(4) : n.toFixed(2)); }

async function renderUsagePop() {
  const { used, max, pct } = ctxInfo();
  let rows = '';
  let totalIn = 0, totalOut = 0, totalCost = 0;
  try {
    const mu = await api.usageGet();
    for (const [m, v] of Object.entries(mu)) {
      const tokIn = (v.input || 0) + (v.cacheRead || 0) + (v.cacheWrite || 0);
      const tokOut = v.output || 0;
      const real = v.cost || 0;
      const cost = real > 0 ? real : estCost(m, v);
      totalIn += tokIn; totalOut += tokOut; totalCost += cost;
      rows += `<div class="usage-row">
        <span class="um">${escapeHtml(shortModelName(m))}</span>
        <span class="ut">↑${fmtTokens(tokIn)} ↓${fmtTokens(tokOut)}</span>
        <span class="uc">${real > 0 ? '' : '≈'}${fmtMoney(cost)}</span>
      </div>`;
    }
  } catch {}
  if (rows) {
    rows += `<div class="usage-row total">
      <span class="um">合计</span>
      <span class="ut">↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}</span>
      <span class="uc">${fmtMoney(totalCost)}</span>
    </div>`;
  }
  $('usage-pop').innerHTML = `
    <div class="usage-sec">
      <div class="usage-row head"><span>上下文窗口</span><span>${fmtTokens(used)} / ${fmtTokens(max)} (${pct}%)</span></div>
      <div class="usage-bar"><div class="usage-bar-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="usage-sec">
      <div class="usage-row head"><span>各模型累计 token 消耗</span><span>↑输入 ↓输出 · 折合金额</span></div>
      ${rows || '<div class="usage-row"><span class="um">(暂无记录,完成一轮对话后开始统计)</span></div>'}
      ${rows ? '<div class="usage-note">带 ≈ 为按官方单价折算(API 未返回实际费用时)</div>' : ''}
    </div>`;
}

$('btn-usage').onclick = async (e) => {
  e.stopPropagation();
  const pop = $('usage-pop');
  if (pop.classList.contains('hidden')) await renderUsagePop();
  pop.classList.toggle('hidden');
};
$('usage-pop').onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => $('usage-pop').classList.add('hidden'));

on('turn-done', () => {
  updateUsageButton();
  if (!$('usage-pop').classList.contains('hidden')) renderUsagePop();
});
on('session-activated', () => updateUsageButton());

$('btn-sidebar').onclick = () => $('sidebar').classList.toggle('collapsed');
$('btn-panel').onclick = () => togglePanel();
$('btn-panel-close').onclick = () => $('right-panel').classList.add('hidden');

function togglePanel(force) {
  const p = $('right-panel');
  const show = force !== undefined ? force : p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  if (show) {
    if ($('panel-diff').classList.contains('active')) diff.refreshDiff();
    if ($('panel-terminal').classList.contains('active')) term.fitActive();
  }
}

function switchPanel(name) {
  togglePanel(true);
  for (const t of document.querySelectorAll('.ptab')) t.classList.toggle('active', t.dataset.panel === name);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === 'panel-' + name);
  if (name === 'diff') diff.refreshDiff();
  if (name === 'terminal') { term.fitActive(); }
}

for (const t of document.querySelectorAll('.ptab')) {
  if (t.dataset.panel) t.onclick = () => switchPanel(t.dataset.panel);
}

// ---------------------------------------------------------------------------
// "More" menu
// ---------------------------------------------------------------------------
$('btn-more').onclick = (e) => {
  e.stopPropagation();
  $('more-menu').classList.toggle('hidden');
};
document.addEventListener('click', () => $('more-menu').classList.add('hidden'));
$('more-menu').onclick = async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  $('more-menu').classList.add('hidden');
  if (act === 'apikey') openApiKeyModal();
  if (act === 'mcp') openMcpModal();
  if (act === 'cron') openCronModal();
  if (act === 'shortcuts') $('shortcuts-modal').classList.remove('hidden');
  if (act === 'switch') {
    const res = await api.pickDir();
    if (res && res.dir) openDirAsProject(res.dir);
  }
  if (act === 'logs') api.openLogs();
  if (act === 'perms') openPermsModal();
};

// ---------------------------------------------------------------------------
// Permission rules modal (view/delete rules in .claude/settings.local.json)
// ---------------------------------------------------------------------------
async function openPermsModal() {
  $('perms-modal').classList.remove('hidden');
  await renderPermsList();
}
async function renderPermsList() {
  const box = $('perms-list');
  if (!state.cwd) {
    $('perms-path').textContent = '尚未进入项目工作区,无法定位 settings.local.json。';
    box.innerHTML = '';
    return;
  }
  const res = await api.permsList(state.cwd);
  if (!res || !res.ok) {
    $('perms-path').textContent = '读取失败:' + ((res && res.error) || '未知错误');
    box.innerHTML = '';
    return;
  }
  $('perms-path').textContent = res.path + '(不存在时将在首次「总是允许」后自动创建)';
  const sections = [['allow', '允许 (allow)'], ['deny', '拒绝 (deny)'], ['ask', '询问 (ask)']];
  let html = '';
  for (const [kind, label] of sections) {
    const rules = res[kind] || [];
    html += `<h3>${label}</h3><div class="mcp-list">`;
    if (!rules.length) {
      html += '<div class="mcp-row"><span style="color:var(--text-dim)">(空)</span></div>';
    }
    for (const rule of rules) {
      html += `<div class="mcp-row"><span class="name">${escapeHtml(rule)}</span>` +
        `<span class="ops"><button class="btn btn-sm" data-kind="${kind}" data-rule="${escapeHtml(rule)}">删除</button></span></div>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
  for (const btn of box.querySelectorAll('button[data-rule]')) {
    btn.onclick = async () => {
      await api.permsRemove(state.cwd, btn.dataset.kind, btn.dataset.rule);
      await renderPermsList();
    };
  }
}
$('perms-close').onclick = () => $('perms-modal').classList.add('hidden');

// ---------------------------------------------------------------------------
// API key modal
// ---------------------------------------------------------------------------
async function openApiKeyModal() {
  $('apikey-input').value = '';
  const info = await api.apiKeyGet();
  const st = $('apikey-status');
  st.className = 'modal-status';
  st.textContent = info.configured
    ? `当前已配置 key(${info.hint})。输入新值覆盖,或留空保存以清除。`
    : '当前未配置 key。将回退使用系统 claude CLI 的登录状态(如有)。';
  $('apikey-modal').classList.remove('hidden');
  $('apikey-input').focus();
}
$('btn-apikey-landing').onclick = openApiKeyModal;
$('apikey-cancel').onclick = () => $('apikey-modal').classList.add('hidden');
$('apikey-save').onclick = async () => {
  const key = $('apikey-input').value.trim();
  await api.apiKeySet(key);
  const st = $('apikey-status');
  st.className = 'modal-status ok';
  st.textContent = key ? 'API key 已保存,新会话生效。' : 'API key 已清除。';
  setTimeout(() => $('apikey-modal').classList.add('hidden'), 900);
};

// ---------------------------------------------------------------------------
// MCP modal
// ---------------------------------------------------------------------------
async function openMcpModal() {
  await renderMcpList();
  $('mcp-status').textContent = '';
  $('mcp-modal').classList.remove('hidden');
}
async function renderMcpList() {
  const servers = await api.mcpList(state.cwd);
  const box = $('mcp-list');
  box.innerHTML = servers.length ? '' : '<div class="empty-hint">尚未配置 MCP 服务器</div>';
  for (const s of servers) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `
      <span class="name">${escapeHtml(s.name)}</span>
      <span class="scope">${s.scope === 'global' ? '全局' : '项目'}</span>
      <span class="ops">
        <button class="btn btn-sm" data-op="edit">编辑</button>
        <button class="btn btn-sm" data-op="del">删除</button>
      </span>`;
    row.querySelector('[data-op="edit"]').onclick = () => {
      $('mcp-name').value = s.name;
      $('mcp-scope').value = s.scope;
      $('mcp-config').value = JSON.stringify(s.config, null, 2);
    };
    row.querySelector('[data-op="del"]').onclick = async () => {
      if (!confirm(`删除 MCP 服务器 ${s.name}?`)) return;
      await api.mcpDelete({ cwd: state.cwd, scope: s.scope, name: s.name });
      renderMcpList();
    };
    box.appendChild(row);
  }
}
$('mcp-close').onclick = () => $('mcp-modal').classList.add('hidden');
$('mcp-save').onclick = async () => {
  const name = $('mcp-name').value.trim();
  const st = $('mcp-status');
  if (!name) { st.className = 'modal-status err'; st.textContent = '请填写名称'; return; }
  let config;
  try { config = JSON.parse($('mcp-config').value); }
  catch (e) { st.className = 'modal-status err'; st.textContent = 'JSON 无效:' + e.message; return; }
  const res = await api.mcpSave({ cwd: state.cwd, scope: $('mcp-scope').value, name, config });
  st.className = 'modal-status ' + (res.ok ? 'ok' : 'err');
  st.textContent = res.ok ? '已保存(新会话生效)' : res.error;
  renderMcpList();
};

// ---------------------------------------------------------------------------
// Cron modal
// ---------------------------------------------------------------------------
let editingCronId = null;
async function openCronModal() {
  editingCronId = null;
  await renderCronList();
  $('cron-status').textContent = '';
  $('cron-modal').classList.remove('hidden');
}
async function renderCronList() {
  const jobs = await api.cronList();
  const box = $('cron-list');
  box.innerHTML = jobs.length ? '' : '<div class="empty-hint">暂无定时任务</div>';
  for (const j of jobs) {
    const when = j.everyMinutes ? `每 ${j.everyMinutes} 分钟` : `每天 ${String(j.hour).padStart(2, '0')}:${String(j.minute).padStart(2, '0')}`;
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `
      <span class="name">${escapeHtml(j.label || '(未命名)')}</span>
      <span class="scope">${when} · ${j.enabled ? '启用' : '停用'}</span>
      <span class="ops">
        <button class="btn btn-sm" data-op="toggle">${j.enabled ? '停用' : '启用'}</button>
        <button class="btn btn-sm" data-op="edit">编辑</button>
        <button class="btn btn-sm" data-op="del">删除</button>
      </span>`;
    row.querySelector('[data-op="toggle"]').onclick = async () => {
      await api.cronSave({ ...j, enabled: !j.enabled });
      renderCronList();
    };
    row.querySelector('[data-op="edit"]').onclick = () => {
      editingCronId = j.id;
      $('cron-label').value = j.label || '';
      $('cron-type').value = j.everyMinutes ? 'interval' : 'daily';
      $('cron-type').dispatchEvent(new Event('change'));
      if (j.everyMinutes) $('cron-minutes').value = j.everyMinutes;
      else $('cron-time').value = `${String(j.hour).padStart(2, '0')}:${String(j.minute).padStart(2, '0')}`;
      $('cron-prompt').value = j.prompt || '';
    };
    row.querySelector('[data-op="del"]').onclick = async () => {
      await api.cronDelete(j.id);
      renderCronList();
    };
    box.appendChild(row);
  }
}
$('cron-type').onchange = () => {
  const isInterval = $('cron-type').value === 'interval';
  $('cron-time').classList.toggle('hidden', isInterval);
  $('cron-minutes').classList.toggle('hidden', !isInterval);
};
$('cron-close').onclick = () => $('cron-modal').classList.add('hidden');
$('cron-save-btn').onclick = async () => {
  const st = $('cron-status');
  const prompt = $('cron-prompt').value.trim();
  if (!prompt) { st.className = 'modal-status err'; st.textContent = '请填写 prompt'; return; }
  const job = {
    id: editingCronId || undefined,
    label: $('cron-label').value.trim(),
    prompt, cwd: state.cwd, enabled: true,
  };
  if ($('cron-type').value === 'interval') {
    job.everyMinutes = Math.max(5, +$('cron-minutes').value || 60);
    job.hour = null; job.minute = null;
  } else {
    const [h, m] = ($('cron-time').value || '09:00').split(':');
    job.hour = +h; job.minute = +m; job.everyMinutes = null;
  }
  await api.cronSave(job);
  editingCronId = null;
  st.className = 'modal-status ok';
  st.textContent = '已保存';
  renderCronList();
};

$('shortcuts-close').onclick = () => $('shortcuts-modal').classList.add('hidden');

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === '/') { e.preventDefault(); $('shortcuts-modal').classList.toggle('hidden'); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('sidebar').classList.toggle('collapsed'); return; }
  if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); togglePanel(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); sessionsUi.createSession(); return; }
  if (mod && ['1', '2', '3', '4', '5'].includes(e.key)) {
    e.preventDefault();
    switchPanel(['diff', 'editor', 'preview', 'tasks', 'terminal'][+e.key - 1]);
    return;
  }
  if (e.key === 'Escape') {
    for (const m of document.querySelectorAll('.modal-mask')) {
      if (!m.classList.contains('hidden')) { m.classList.add('hidden'); return; }
    }
    const s = state.sessions.get(state.activeSid);
    if (s && s.ui.busy && document.activeElement === $('input')) {
      api.sessInterrupt(state.activeSid);
    }
  }
});

// close modals by clicking mask
for (const m of document.querySelectorAll('.modal-mask')) {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
}

// ---------------------------------------------------------------------------
// Session event routing
// ---------------------------------------------------------------------------
api.on('sess:event', (payload) => chat.handleSessEvent(payload));

// Cross-project switching: the topbar always reflects the ACTIVE SESSION's
// project group and its own directory — there is no global directory.
on('session-activated', async (sid) => {
  const s = state.sessions.get(sid);
  if (!s) return;
  if (s.meta.projectId) state.projectId = s.meta.projectId;
  const cwd = s.meta.cwd;
  const cwdChanged = cwd && cwd !== state.cwd;
  if (cwdChanged) {
    state.cwd = cwd;
    state.filesCache = null;
    state.commandsCache = null;
  }
  let projName = '';
  try {
    const projs = await api.projList();
    const p = projs.find((x) => x.id === s.meta.projectId);
    if (p) projName = p.name;
  } catch {}
  $('cwd-label').textContent = (projName ? projName + ' · ' : '') + (cwd || '');
  const b = await api.gitBranch(cwd);
  $('branch-label').textContent = b.branch ? ' ' + b.branch : '';
  if (cwdChanged) diff.refreshDiff();
});

// open the project group's shared memory file in the editor panel
on('open-project-memory', async (pid) => {
  const m = await api.projMemory(pid);
  if (m) emit('open-file', m.path);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
sessionsUi.init();
input.init();
diff.init();
editor.init();
preview.init();
tasks.init();
term.init();
chat.setViewMode('normal');
initLanding();
console.log('[boot] renderer modules loaded OK');
