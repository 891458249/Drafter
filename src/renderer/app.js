// App entry: landing, project open, topbar, panels, modals, shortcuts, wiring.
import { api, state, $, escapeHtml, on, emit, fmtTokens } from './state.js';
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
// Update status chip (topbar) — fed by the main process via 'update:status'
// ---------------------------------------------------------------------------
api.on('update:status', (st) => {
  const chip = $('update-chip');
  if (!chip) return;
  if (!st || st.state === 'idle') { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden', 'available', 'downloading', 'downloaded');
  if (st.state === 'checking') {
    chip.textContent = '检查更新…';
  } else if (st.state === 'available') {
    chip.textContent = `发现新版本 v${st.version || ''},下载中…`;
    chip.classList.add('available');
  } else if (st.state === 'downloading') {
    chip.textContent = `下载更新 ${st.percent || 0}%`;
    chip.classList.add('downloading');
  } else if (st.state === 'downloaded') {
    chip.textContent = `v${st.version || ''} 已就绪 · 点击重启`;
    chip.classList.add('downloaded');
  } else if (st.state === 'latest') {
    chip.textContent = '已是最新';
    setTimeout(() => chip.classList.add('hidden'), 5000);
  }
});
$('update-chip').onclick = () => {
  const chip = $('update-chip');
  if (chip.classList.contains('downloaded')) api.updateInstall(); // 重启并安装
  else api.updateCheck(); // 手动触发一次检查
};

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------
async function initLanding() {
  const store = await api.getStore();
  const recent = store.recentProjects || [];
  renderRecent(recent);
  initOnboarding(store.settings || {});
  populateModelSelects(); // 按活跃 Key 填充模型下拉(v0.7.0)
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

// ---------------------------------------------------------------------------
// First-run onboarding card (landing; shows once until completed or dismissed)
// ---------------------------------------------------------------------------
const obState = { apikey: false, dir: false, mode: false };

async function initOnboarding(settings) {
  if (settings && settings.firstRunCompleted) return;
  const keyInfo = await api.apiKeyGet();
  if (keyInfo.configured) return; // 已有 key,无需引导
  $('onboarding').classList.remove('hidden');
}

function obMark(step) {
  const el = document.querySelector(`.ob-step[data-step="${step}"]`);
  if (!el || el.classList.contains('done')) return;
  el.classList.add('done');
  el.querySelector('.ob-state').textContent = '✓';
  obState[step] = true;
  if (obState.apikey && obState.dir && obState.mode) obFinish();
}

async function obFinish() {
  await api.setSetting('firstRunCompleted', true);
  $('onboarding').classList.add('hidden');
}

$('ob-close').onclick = obFinish;
document.querySelector('.ob-step[data-step="apikey"]').onclick = () => openApiKeyModal();
document.querySelector('.ob-step[data-step="dir"]').onclick = async () => {
  const res = await api.pickDir();
  if (res && res.dir) { obMark('dir'); openDirAsProject(res.dir); }
};
document.querySelector('.ob-step[data-step="mode"]').onclick = () => obMark('mode');

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
      effort: null, // 推理深度:默认跟随 SDK/模型,由会话内下拉按需约束
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
  // 优先用 SDK result.modelUsage 里的真实上下文窗口大小;
  // 没有时(旧事件)退化为整轮输入 token 加总的启发值(会偏高,仅供参考)
  const used = (s && s.ui.contextWindow) || (u
    ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    : 0);
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
      const cachePart = (v.cacheRead || v.cacheWrite)
        ? `(读${fmtTokens(v.cacheRead || 0)}/写${fmtTokens(v.cacheWrite || 0)})`
        : '';
      totalIn += tokIn; totalOut += tokOut; totalCost += cost;
      rows += `<div class="usage-row">
        <span class="um">${escapeHtml(shortModelName(m))}</span>
        <span class="ut">↑${fmtTokens(tokIn)}${cachePart} ↓${fmtTokens(tokOut)}</span>
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
      <div class="usage-row head"><span>各模型累计 token 消耗</span><span>↑输入(缓存读/写) ↓输出 · 折合金额</span></div>
      ${rows || '<div class="usage-row"><span class="um">(暂无记录,完成一轮对话后开始统计)</span></div>'}
      ${rows ? '<div class="usage-note">缓存读≈0.1×输入价、缓存写≈1.25×输入价;带 ≈ 为按官方单价折算(API 未返回实际费用时)</div>' : ''}
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
// API keys modal(多 Key 管理 + 按 Key 识别模型)
// ---------------------------------------------------------------------------
async function openApiKeyModal() {
  $('apikey-status').textContent = '';
  $('apikey-modal').classList.remove('hidden');
  await renderKeysList();
}

async function renderKeysList() {
  const box = $('keys-list');
  const { list, activeId } = await api.keysList();
  if (!list.length) {
    box.innerHTML = '<div class="mcp-row"><span style="color:var(--text-dim)">(暂无 Key,请在下方添加;未配置时回退 claude CLI 登录态)</span></div>';
    return;
  }
  const usageText = (u, quota, label) => {
    if (!u) return quota ? `${label} $0/${fmtMoney(quota)}(剩 100%)` : `${label} $0(不限)`;
    const cost = label === '本周' ? u.weekCost : u.monthCost;
    if (!quota) return `${label} ${fmtMoney(cost)}(不限)`;
    const left = Math.max(0, 100 - (cost / quota) * 100).toFixed(0);
    return `${label} ${fmtMoney(cost)}/${fmtMoney(quota)}(剩 ${left}%)`;
  };
  box.innerHTML = list.map((k) => `
    <div class="mcp-row">
      <input type="radio" name="active-key" data-id="${k.id}" ${k.id === activeId ? 'checked' : ''} title="设为默认" />
      <span class="name">${escapeHtml(k.name)}</span>
      <span class="scope">${escapeHtml(k.keyHint)}${k.baseUrl ? ' · ' + escapeHtml(k.baseUrl) : ''} · ${k.kind === 'authToken' ? 'Token' : 'Key'}${k.models && k.models.length ? ' · ' + k.models.length + ' 模型' : ''}${k.modelsEnabled ? '(已勾选 ' + k.modelsEnabled.length + ')' : ''}</span>
      <span class="ops">
        ${k.models && k.models.length ? `<button class="btn btn-sm" data-op="models" data-id="${k.id}">模型勾选</button>` : ''}
        <button class="btn btn-sm" data-op="refresh" data-id="${k.id}" title="按此 Key 拉取模型列表">刷新模型</button>
        <button class="btn btn-sm" data-op="del" data-id="${k.id}">删除</button>
      </span>
    </div>
    <div class="key-quota" data-quota="${k.id}">
      <span class="quota-usage">${usageText(k.usage, k.quotaWeek, '本周')} · ${usageText(k.usage, k.quotaMonth, '本月')}</span>
      <input class="input-sm q-week" data-id="${k.id}" value="${k.quotaWeek || ''}" placeholder="周额度($)" title="每周一 0 点重置,0/留空 = 不限" />
      <input class="input-sm q-month" data-id="${k.id}" value="${k.quotaMonth || ''}" placeholder="月额度($)" title="每月 1 号 0 点重置,0/留空 = 不限" />
      <button class="btn btn-sm q-save" data-id="${k.id}">存</button>
    </div>
    ${k.models && k.models.length ? `<div class="key-models hidden" data-models="${k.id}"></div>` : ''}`).join('');
  for (const r of box.querySelectorAll('input[name="active-key"]')) {
    r.onchange = async () => {
      await api.keysSetActive(r.dataset.id);
      await populateModelSelects();
      await renderKeysList();
    };
  }
  for (const b of box.querySelectorAll('button[data-op]')) {
    b.onclick = async () => {
      const st = $('apikey-status');
      if (b.dataset.op === 'refresh') {
        st.className = 'modal-status';
        st.textContent = '正在按该 Key 拉取模型列表…';
        const r = await api.keysRefreshModels(b.dataset.id);
        st.className = 'modal-status ' + (r.ok ? 'ok' : 'err');
        st.textContent = r.ok ? `识别到 ${r.models.length} 个模型,可在「模型勾选」里挑选要显示的。` : '模型识别失败:' + r.error;
        await populateModelSelects();
        await renderKeysList();
      } else if (b.dataset.op === 'models') {
        const panel = box.querySelector(`[data-models="${b.dataset.id}"]`);
        if (panel.classList.contains('hidden')) {
          await renderModelsPanel(panel, b.dataset.id);
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
      } else {
        await api.keysDelete(b.dataset.id);
        await populateModelSelects();
        await renderKeysList();
      }
    };
  }
  for (const b of box.querySelectorAll('.q-save')) {
    b.onclick = async () => {
      const id = b.dataset.id;
      const w = box.querySelector(`.q-week[data-id="${id}"]`).value.trim();
      const m = box.querySelector(`.q-month[data-id="${id}"]`).value.trim();
      await api.keysSave({ id, quotaWeek: w, quotaMonth: m });
      await renderKeysList();
    };
  }
}

// 模型勾选面板:只有勾选的模型出现在前端下拉里
async function renderModelsPanel(panel, keyId) {
  const { list } = await api.keysList();
  const k = list.find((x) => x.id === keyId);
  if (!k) return;
  const enabled = k.modelsEnabled ? new Set(k.modelsEnabled) : null;
  panel.innerHTML = `
    <div class="km-ops">
      <button class="btn btn-sm" data-all="1">全选</button>
      <button class="btn btn-sm" data-all="0">全不选</button>
      <button class="btn btn-sm btn-primary" data-save="1">保存勾选</button>
      <span class="scope">勾选后下拉只显示选中项;全选 = 不限制</span>
    </div>
    <div class="km-list">${k.models.map((m) => `
      <label class="km-item"><input type="checkbox" value="${escapeHtml(m)}" ${!enabled || enabled.has(m) ? 'checked' : ''} /> ${escapeHtml(m)}</label>`).join('')}
    </div>`;
  panel.querySelector('[data-all="1"]').onclick = () => {
    for (const c of panel.querySelectorAll('input[type="checkbox"]')) c.checked = true;
  };
  panel.querySelector('[data-all="0"]').onclick = () => {
    for (const c of panel.querySelectorAll('input[type="checkbox"]')) c.checked = false;
  };
  panel.querySelector('[data-save="1"]').onclick = async () => {
    const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
    await api.keysSetModelsEnabled(keyId, checked.length === k.models.length ? null : checked);
    await populateModelSelects();
    await renderKeysList();
  };
}

$('btn-apikey-landing').onclick = openApiKeyModal;
$('apikey-cancel').onclick = () => $('apikey-modal').classList.add('hidden');
$('apikey-save').onclick = async () => {
  const entry = {
    name: $('key-name').value.trim() || 'Key',
    key: $('key-secret').value.trim(),
    baseUrl: $('key-baseurl').value.trim(),
    kind: $('key-kind').value || undefined,
  };
  const st = $('apikey-status');
  const r = await api.keysSave(entry);
  st.className = 'modal-status ' + (r.ok ? 'ok' : 'err');
  if (!r.ok) { st.textContent = r.error || '保存失败'; return; }
  obMark('apikey'); // 引导卡第一步(若在展示中)
  st.textContent = '已保存。建议点「刷新模型」按此 Key 识别可用模型。';
  $('key-secret').value = '';
  await populateModelSelects();
  await renderKeysList();
};

// --- 模型下拉动态化(按活跃 Key 的模型列表,无缓存时回退内置列表) ---
const FALLBACK_MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
function modelLabel(id) {
  let s = String(id).replace(/^claude-/, '');
  const bracket = (s.match(/(\[.*\])$/) || [null, ''])[1];
  s = s.replace(/\[.*\]$/, '').replace(/-?20\d{6}$/, '').replace(/(\d)-(\d)/g, '$1.$2');
  const m = s.match(/^([a-z]+)-?(.*)$/i);
  if (!m) return s + bracket;
  return m[1][0].toUpperCase() + m[1].slice(1) + (m[2] ? ' ' + m[2] : '') + bracket;
}
async function populateModelSelects() {
  let models = null;
  try { models = await api.keysActiveModels(); } catch {}
  const ids = (models && models.length) ? models : FALLBACK_MODELS;
  const html = '<option value="">默认</option>' + ids.map((id) => `<option value="${id}">${escapeHtml(modelLabel(id))}</option>`).join('');
  for (const sel of [$('model-sel'), $('model-sel-composer')]) {
    const cur = sel.value;
    sel.innerHTML = html;
    sel.value = sel.querySelector(`option[value="${cur}"]`) ? cur : '';
  }
}

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
  // 板块跟随会话类型:chat 会话激活时自动切到 chat 板块(反之亦然)
  const kind = (s.meta.kind === 'chat') ? 'chat' : 'code';
  if (state.section !== kind) setSection(kind, { skipSessionPick: true });
  state.projectId = s.meta.projectId || null; // 独立会话不继承上个会话的项目
  const cwd = s.meta.cwd;
  const cwdChanged = cwd && cwd !== state.cwd;
  if (cwdChanged) {
    state.cwd = cwd;
    state.filesCache = null;
    state.commandsCache = null;
  }
  const b = await api.gitBranch(cwd);
  $('branch-label').textContent = b.branch ? ' ' + b.branch : '';
  if (cwdChanged) diff.refreshDiff();
});

// ---------------------------------------------------------------------------
// 板块切换:Code(面向项目的完整工作区)vs Chat(纯对话 AI,不服务项目)
// ---------------------------------------------------------------------------
function setSection(sec, { skipSessionPick } = {}) {
  if (state.section === sec) return;
  state.section = sec;
  document.body.classList.toggle('sec-chat', sec === 'chat');
  for (const b of document.querySelectorAll('#section-switch button')) {
    b.classList.toggle('active', b.dataset.sec === sec);
  }
  $('sidebar-head-label').textContent = sec === 'chat' ? '会话' : '项目 / 会话';
  if (sec === 'chat') $('right-panel').classList.add('hidden'); // chat 板块无项目面板
  sessionsUi.refreshList();
  if (!skipSessionPick) {
    // 当前会话不属于该板块时,切到该板块最近的会话
    const cur = state.sessions.get(state.activeSid);
    const curKind = (cur && cur.meta.kind === 'chat') ? 'chat' : 'code';
    if (curKind !== sec) {
      api.sessList().then((list) => {
        const latest = list
          .filter((m) => !m.archived && ((m.kind === 'chat') === (sec === 'chat')))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        if (latest) {
          chat.ensureSession(latest.id, latest);
          chat.setActiveSession(latest.id);
        }
      });
    }
  }
}
for (const b of document.querySelectorAll('#section-switch button')) {
  b.onclick = () => setSection(b.dataset.sec);
}

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
