// App entry: boot, project open, topbar, panels, modals, shortcuts, wiring.
import { api, state, $, escapeHtml, on, emit, fmtTokens, parseModelValue, updateKeyChips, MEDIA_TYPE_LABEL, sectionOfKind } from './state.js';
import * as chat from './chat.js';
import * as sessionsUi from './sessions-ui.js';
import * as input from './input.js';
import * as msgmenu from './msgmenu.js';
import * as msgnav from './msgnav.js';
import * as diff from './diff.js';
import * as editor from './editor.js';
import * as preview from './preview.js';
import * as tasks from './tasks.js';
import * as term from './term.js';
import * as gems from './gems.js';
import * as codeblock from './codeblock.js';
import * as canvas from './canvas.js';
import * as assets from './assets.js';
import * as harness from './harness.js';
import { THEMES, applyTheme, currentTheme, bootTheme } from './themes.js';

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
  try { settingsUpdateProgress(st); } catch {} // 设置面板更新区联动(函数声明提升,定义在下方)
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
// Boot(v0.9.3 起无首屏落地页):直接进对话页 —— 恢复最近会话,没有则自动建独立会话;
// 项目目录不再进门,等用户在会话里按需添加(＋文件夹 / 设置面板)。
// ---------------------------------------------------------------------------
async function boot() {
  await bootTheme(); // 皮肤(v0.9.31):尽早应用,避免首帧用错主题
  // 设置项(v0.9.15):瞬时跳转定位(默认开)
  try {
    const st = await api.getStore();
    if (st && st.settings && st.settings.instantJump === false) state.instantJump = false;
    if (st && st.settings && st.settings.comfyAdvancedMode === true) state.comfyAdvancedMode = true;
    if (st && st.settings && st.settings.sharedPromptCache === false) state.sharedPromptCache = false;
  } catch {}
  populateModelSelects(); // 按活跃 Key 填充模型下拉(v0.7.0)
  const sdk = await api.sdkStatus();
  if (!sdk.ok) {
    const w = $('sdk-warning');
    w.classList.remove('hidden');
    w.textContent = 'Agent SDK 未安装,会话功能不可用。请在项目目录执行:npm install @anthropic-ai/claude-agent-sdk。错误:' + (sdk.error || '');
  }
  const list = await api.sessList();
  const latest = list
    .filter((m) => !m.archived)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (latest) {
    chat.ensureSession(latest.id, latest);
    chat.setActiveSession(latest.id);
  } else {
    await sessionsUi.createSession(); // 首次打开:自动创建独立会话,目录留空
  }
  sessionsUi.refreshList();
  // 未配置 API Key:直接弹出配置窗(取代原首屏三步引导)
  const keyInfo = await api.apiKeyGet();
  if (!keyInfo.configured) openApiKeyModal();
}

// 打开一个目录:目录归属各自的项目组(不存在则自动创建),没有全局目录概念。
async function openDirAsProject(dir) {
  await api.addRecent(dir);
  const list = await api.sessList();
  const existing = list
    .filter((m) => m.cwd === dir && !m.archived)
    .sort((a, b2) => (b2.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (existing) {
    chat.ensureSession(existing.id, existing);
    chat.setActiveSession(existing.id);
  } else {
    const sel = parseModelValue($('model-sel').value);
    const meta = await api.sessCreate({
      cwd: dir,
      model: sel.model,
      keyId: sel.keyId,
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

// 模型下拉(会话级,输入区工具栏)的 change 处理器在 input.js,此处不再绑定

$('view-mode').onchange = () => chat.setViewMode($('view-mode').value);

// 极速问答 ⇄ Agent 模式切换(v0.10.2,仅 chat 会话;按钮为 chat-only,其他板块不可见)
$('btn-chat-mode').onclick = async () => {
  const sid = state.activeSid;
  const s = state.sessions.get(sid);
  if (!s || s.meta.kind !== 'chat') return;
  const next = s.meta.chatMode === 'agent' ? 'fast' : 'agent';
  await api.sessSetChatMode(sid, next);
  s.meta.chatMode = next; // 乐观回显;主进程按 needRestart 在回合结束后重启 query
  chat.updateTopbarForSession(sid);
  if (next === 'agent') {
    alert('已切换为 Agent 模式:会话重启后生效(上文保留),恢复全部工具能力。\n注意:Agent 模式每轮请求会携带完整系统提示与工具定义,响应明显变慢。');
  }
};

// 极速问答首次提示(v0.10.2):存量 chat 会话(chatMode 未落盘即视为 fast)首次激活时
// 告知模式已切换、如何切回 Agent。全局只提示一次。
let fastChatHinted = true;
try {
  const st = await api.getStore();
  fastChatHinted = !!(st && st.settings && st.settings.fastChatHinted);
} catch {}
on('session-activated', (sid) => {
  const s = state.sessions.get(sid);
  if (fastChatHinted || !s || s.meta.kind !== 'chat') return;
  fastChatHinted = true;
  api.setSetting('fastChatHinted', true);
  alert('Chat 已启用「⚡ 极速问答」模式:零工具 + 极简提示,响应速度接近网页版。\n如需让 AI 读取文件/执行命令等工具能力,点输入框上方的「⚡ 极速」按钮切换为 Agent 模式。');
});

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
on('usage-updated', () => updateUsageButton()); // 回合中 assistant 消息带 usage 时实时刷新上下文 %(v0.9.13)
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
// 设置面板(v0.9.31):原「⋯」下拉菜单全部入口并入;皮肤定制即时预览持久化
// ---------------------------------------------------------------------------
function renderThemeCards() {
  const box = $('theme-cards');
  box.innerHTML = '';
  for (const t of THEMES) {
    const d = document.createElement('div');
    d.className = 'theme-card' + (t.id === currentTheme() ? ' active' : '');
    d.innerHTML = `<div class="theme-swatch">${t.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</div>${t.name}`;
    d.onclick = () => { applyTheme(t.id, { persist: true }); renderThemeCards(); };
    box.appendChild(d);
  }
}
function openSettingsModal() {
  renderThemeCards();
  $('set-instantjump').checked = state.instantJump;
  $('set-comfy-advanced').checked = !!state.comfyAdvancedMode;
  $('set-sharedcache').checked = state.sharedPromptCache !== false;
  renderUpdateStatus(); // 更新区:显示当前版本,不自动请求网络
  $('settings-modal').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 更新区(v0.11.2):检查 GitHub 仓库 latest release 版本号;有新版时显式给出
// 「⬇ 立即更新」(electron-updater 下载→重启安装,仅打包版)与「🔗 Release 页」
// (浏览器手动下载,dev/下载失败兜底)。electron-updater 的 download-progress /
// update-downloaded 经顶栏 chip 的 'update:status' 同步驱动本区按钮态。
// ---------------------------------------------------------------------------
let _repoVerCache = null; // 缓存一次结果,避免反复打 GitHub API
async function renderUpdateStatus() {
  if (_repoVerCache && _repoVerCache.current) { paintUpdateStatus(_repoVerCache); return; }
  const el = $('update-status');
  el.className = 'update-status';
  el.textContent = '当前版本 v—';
  try {
    const res = await api.updateRepoVersion();
    if (res && res.current) { _repoVerCache = res; paintUpdateStatus(res); }
  } catch {}
}
function paintUpdateStatus(res) {
  const el = $('update-status');
  el.className = 'update-status';
  const dlBtn = $('btn-update-download');
  const pgBtn = $('btn-update-page');
  if (res.error) {
    el.textContent = `当前版本 v${res.current || '?'} · ${res.error}`;
    el.classList.add('error');
    return;
  }
  if (res.hasUpdate) {
    el.textContent = `当前 v${res.current} → 仓库 v${res.latest} · 发现新版本!`;
    el.classList.add('has-update');
    // 打包版:显式「立即更新」按钮(electron-updater 自动下载安装);
    // dev 环境 electron-updater 无法下载(缺 dev-app-update.yml),只给 Release 页手动下载
    if (res.packaged) { dlBtn.classList.remove('hidden'); dlBtn.dataset.version = res.latest; }
    else { pgBtn.classList.remove('hidden'); pgBtn.dataset.url = res.url || ''; }
  } else {
    el.textContent = `当前 v${res.current} · 已是最新(仓库 v${res.latest})`;
  }
}
$('btn-update-check').onclick = async () => {
  const btn = $('btn-update-check');
  const el = $('update-status');
  btn.disabled = true;
  el.className = 'update-status';
  el.textContent = '正在检查仓库版本…';
  $('btn-update-download').classList.add('hidden');
  $('btn-update-page').classList.add('hidden');
  const res = await api.updateRepoVersion();
  btn.disabled = false;
  if (!res || res.error) {
    _repoVerCache = res || { error: '检查失败' };
    el.textContent = (res && res.current) ? `当前版本 v${res.current} · ${(res && res.error) || '检查失败'}` : ((res && res.error) || '检查失败');
    el.classList.add('error');
    return;
  }
  _repoVerCache = res;
  paintUpdateStatus(res);
};
// 「立即更新」:触发 electron-updater 检查+下载;进度经 update:status 回灌本按钮
$('btn-update-download').onclick = () => {
  const btn = $('btn-update-download');
  if (btn.dataset.stage === 'install') { api.updateInstall(); return; } // 已下载完 → 重启安装
  btn.disabled = true;
  btn.textContent = '下载中… 0%';
  api.updateCheck();
};
$('btn-update-page').onclick = () => {
  const url = $('btn-update-page').dataset.url;
  if (url) api.openExternal(url);
};
// electron-updater 状态 → 更新区按钮(顶栏 chip 是同一事件的被动展示,此处复用)
function settingsUpdateProgress(st) {
  const btn = $('btn-update-download');
  if (!btn || btn.classList.contains('hidden')) return;
  if (st.state === 'downloading') {
    btn.disabled = true;
    btn.dataset.stage = '';
    btn.textContent = `下载中… ${st.percent || 0}%`;
  } else if (st.state === 'downloaded') {
    btn.disabled = false;
    btn.dataset.stage = 'install';
    btn.textContent = `🔁 v${st.version || ''} 已就绪 · 重启安装`;
  } else if (st.state === 'idle') { // 下载出错静默降级:恢复可重试,并给手动下载兜底
    btn.disabled = false;
    btn.dataset.stage = '';
    btn.textContent = '⬇ 立即更新';
    const el = $('update-status');
    el.textContent += ' · 自动下载失败,可重试或走 Release 页';
    el.classList.add('error');
    if (_repoVerCache && _repoVerCache.url) {
      const pgBtn = $('btn-update-page');
      pgBtn.dataset.url = _repoVerCache.url;
      pgBtn.classList.remove('hidden');
    }
  }
}
$('settings-close').onclick = () => $('settings-modal').classList.add('hidden');
$('set-instantjump').onchange = (e) => { // 瞬时 ↔ 平滑(原 v0.9.15 菜单项)
  state.instantJump = !!e.target.checked;
  api.setSetting('instantJump', state.instantJump);
};
$('set-comfy-advanced').onchange = (e) => {
  state.comfyAdvancedMode = !!e.target.checked;
  api.setSetting('comfyAdvancedMode', state.comfyAdvancedMode);
  window.dispatchEvent(new Event('drafter:comfy-advanced-changed'));
};
// 跨会话共享提示缓存(v0.10.2):盖戳进新会话 meta.staticPrompt(sessions.js 创建时读取)
$('set-sharedcache').onchange = (e) => {
  state.sharedPromptCache = !!e.target.checked;
  api.setSetting('sharedPromptCache', state.sharedPromptCache);
};
$('settings-modal').onclick = async (e) => {
  const act = e.target.dataset && e.target.dataset.set;
  if (!act) return;
  $('settings-modal').classList.add('hidden');
  if (act === 'apikey') openApiKeyModal();
  if (act === 'gems') gems.openGemModal();
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
// 「⋯」按钮 = 设置面板入口(v0.9.31;原下拉菜单已并入)
// ---------------------------------------------------------------------------
$('btn-more').onclick = (e) => { e.stopPropagation(); openSettingsModal(); };

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
// Key 预设:一键预填名称/Base URL/类型(secret 不预填,字段保持可编辑)
const KEY_PRESETS = {
  kuro: { name: 'Kuro', baseUrl: 'https://ai-gateway.kurogames.com', kind: 'authToken' },
  kimi: { name: 'Kimi', baseUrl: 'https://api.kimi.com/coding/v1', kind: 'authToken' },
  deepseek: { name: 'Deepseek', baseUrl: 'https://api.deepseek.com/anthropic', kind: 'authToken' },
  gemini: { name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com', kind: 'apiKey' },
  chatgpt: { name: 'ChatGPT', baseUrl: 'https://api.openai.com', kind: 'apiKey' },
};
for (const btn of document.querySelectorAll('#apikey-modal [data-preset]')) {
  btn.onclick = () => {
    const p = KEY_PRESETS[btn.dataset.preset];
    if (!p) return;
    $('key-name').value = p.name;
    $('key-baseurl').value = p.baseUrl;
    $('key-kind').value = p.kind;
  };
}

let editingKeyId = null; // 非 null = 模态框处于编辑态(保存时带 id)

// 重置为新建态:清空表单、恢复标题与 secret 占位
function resetKeyForm() {
  editingKeyId = null;
  $('apikey-form-title').textContent = '添加 API Key';
  $('key-secret').placeholder = 'Key 内容';
  for (const id of ['key-name', 'key-secret', 'key-baseurl', 'key-usageurl']) $(id).value = '';
  $('key-kind').value = '';
}

// 进入编辑态:预填该 Key 的字段;secret 留空(保存时不修改),额度在行内编辑、保存时自动保留
function startEditKey(k) {
  editingKeyId = k.id;
  $('apikey-form-title').textContent = '编辑 API Key';
  $('key-secret').placeholder = '留空则不修改';
  $('key-name').value = k.name || '';
  $('key-kind').value = k.kind || '';
  $('key-secret').value = '';
  $('key-baseurl').value = k.baseUrl || '';
  $('key-usageurl').value = k.usageUrl || '';
}

async function openApiKeyModal() {
  resetKeyForm(); // 菜单/引导卡入口一律回到新建态
  $('apikey-status').textContent = '';
  $('apikey-modal').classList.remove('hidden');
  await renderKeysList();
  // v0.8.1:弹窗打开时对命中余额映射的活跃 Key 自动查一次(失败仅行内提示,不打断)
  const { list, activeId } = await api.keysList();
  const active = list.find((k) => k.id === activeId);
  if (active && active.canBalance) {
    const r = await api.keysQueryBalance(active.id);
    if (r.ok) {
      await renderKeysList();
    } else {
      const row = document.querySelector(`[data-quota="${active.id}"] .quota-usage`);
      if (row) row.textContent = '自动查询余额失败:' + (r.error || '未知错误') + ' · ' + row.textContent;
    }
  }
}

async function renderKeysList() {
  const box = $('keys-list');
  const { list, activeId } = await api.keysList();
  renderAuxModels(); // 辅助模型候选随 Key/模型缓存刷新(后台渲染,不阻塞)
  if (!list.length) {
    box.innerHTML = '<div class="mcp-row"><span style="color:var(--text-dim)">(暂无 Key,请在下方添加;未配置时回退命令行登录态)</span></div>';
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
      <input type="checkbox" class="key-enabled" data-id="${k.id}" ${k.enabled ? 'checked' : ''} title="启用:该 Key 的模型加入会话下拉,可多选" />
      <input type="radio" name="active-key" data-id="${k.id}" ${k.id === activeId ? 'checked' : ''} title="设为默认(「默认」模型与回退额度归账用)" />
      <span class="name">${escapeHtml(k.name)}</span>
      <span class="scope">${escapeHtml(k.keyHint)}${k.baseUrl ? ' · ' + escapeHtml(k.baseUrl) : ''} · ${k.kind === 'authToken' ? 'Token' : 'Key'}${k.models && k.models.length ? ' · ' + k.models.length + ' 模型' : ''}${k.modelsEnabled ? '(已勾选 ' + k.modelsEnabled.length + ')' : ''}</span>
      <span class="ops">
        ${k.models && k.models.length ? `<button class="btn btn-sm" data-op="models" data-id="${k.id}">模型勾选</button>` : ''}
        ${k.canBalance ? `<button class="btn btn-sm" data-op="balance" data-id="${k.id}" title="按 Base URL 自动查询余额">查余额</button>` : ''}
        ${k.usageUrl ? `<button class="btn btn-sm" data-op="usage" data-id="${k.id}" data-url="${escapeHtml(k.usageUrl)}" title="在浏览器打开用量页">打开用量页</button>` : ''}
        <button class="btn btn-sm" data-op="refresh" data-id="${k.id}" title="按此 Key 拉取模型列表">刷新模型</button>
        <button class="btn btn-sm" data-op="edit" data-id="${k.id}" title="在下方表单中编辑此 Key">编辑</button>
        <button class="btn btn-sm" data-op="del" data-id="${k.id}">删除</button>
      </span>
    </div>
    <div class="key-quota" data-quota="${k.id}">
      <span class="quota-usage">${k.balanceCache ? escapeHtml(k.balanceCache.text) + ' · ' : ''}${usageText(k.usage, k.quotaWeek, '本周')} · ${usageText(k.usage, k.quotaMonth, '本月')}</span>
      <input class="input-sm u-url" data-id="${k.id}" value="${escapeHtml(k.usageUrl || '')}" placeholder="用量查询网址" title="用量查询网页地址(https://…)" />
      <input class="input-sm q-week" data-id="${k.id}" value="${k.quotaWeek || ''}" placeholder="周额度($)" title="每周一 0 点重置,0/留空 = 不限" />
      <input class="input-sm q-month" data-id="${k.id}" value="${k.quotaMonth || ''}" placeholder="月额度($)" title="每月 1 号 0 点重置,0/留空 = 不限" />
      <button class="btn btn-sm q-save" data-id="${k.id}">存</button>
      ${k.usageUrl ? '<span class="quota-hint">可不设额度,直接网页查用量</span>' : ''}
    </div>
    ${k.models && k.models.length ? `<div class="key-models hidden" data-models="${k.id}"></div>` : ''}`).join('');
  for (const r of box.querySelectorAll('input[name="active-key"]')) {
    r.onchange = async () => {
      await api.keysSetActive(r.dataset.id);
      await populateModelSelects();
      await renderKeysList();
    };
  }
  for (const c of box.querySelectorAll('.key-enabled')) {
    c.onchange = async () => {
      await api.keysSetEnabled(c.dataset.id, c.checked);
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
      } else if (b.dataset.op === 'balance') {
        b.disabled = true;
        b.textContent = '查询中…';
        const r = await api.keysQueryBalance(b.dataset.id);
        b.disabled = false;
        b.textContent = '查余额';
        if (r.ok) {
          await renderKeysList();
        } else {
          const row = box.querySelector(`[data-quota="${b.dataset.id}"] .quota-usage`);
          if (row) row.textContent = '余额查询失败:' + (r.error || '未知错误');
        }
      } else if (b.dataset.op === 'usage') {
        api.openExternal(b.dataset.url);
      } else if (b.dataset.op === 'edit') {
        const k = list.find((x) => x.id === b.dataset.id);
        if (k) startEditKey(k);
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
      const u = box.querySelector(`.u-url[data-id="${id}"]`).value.trim();
      const r = await api.keysSave({ id, quotaWeek: w, quotaMonth: m, usageUrl: u });
      if (!r.ok) {
        const st = $('apikey-status');
        st.className = 'modal-status err';
        st.textContent = r.error || '保存失败';
        return;
      }
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

// --- 辅助模型配置(v0.9.1)------------------------------------------------------
// 候选 = 所有启用 Key 勾选的完整模型列表(v0.9.2 起不再只限 chat 类,用户可自行挑选
// 多模态模型;选中非 chat 模型导致分析失败时,aux-models 会注入元信息兜底)。
// 选项标注模型类别(chat/image/…);值编码 keyId|modelId,空 = 不配置;change 即保存。
const AUX_KINDS = ['image', 'audio', 'video', 'model'];
async function renderAuxModels() {
  let entries = [], saved = {};
  const groupMap = new Map();
  try {
    entries = (await api.keysEnabledModels()) || [];
    const { list } = await api.keysList();
    for (const k of list) if (Array.isArray(k.modelGroups)) groupMap.set(k.id, k.modelGroups);
    saved = (await api.auxModelsGet()) || {};
  } catch {}
  const typeOf = (keyId, model) => {
    const groups = groupMap.get(keyId);
    if (!groups) return 'chat';
    const g = groups.find((x) => Array.isArray(x.models) && x.models.includes(model));
    return g ? g.model_type : 'chat';
  };
  const byKey = new Map();
  for (const e of entries) {
    if (!byKey.has(e.keyId)) byKey.set(e.keyId, { name: e.keyName, models: [] });
    byKey.get(e.keyId).models.push({ model: e.model, type: typeOf(e.keyId, e.model) });
  }
  let html = '<option value="">(不配置)</option>';
  for (const [keyId, g] of byKey) {
    html += `<optgroup label="${escapeHtml(g.name)}">` +
      g.models.map((x) => `<option value="${keyId}|${escapeHtml(x.model)}">${escapeHtml(modelLabel(x.model))}${x.type !== 'chat' ? ' · ' + escapeHtml(x.type) : ''}</option>`).join('') +
      '</optgroup>';
  }
  for (const kind of AUX_KINDS) {
    const sel = $('aux-' + kind);
    sel.innerHTML = html;
    const cur = saved[kind] || '';
    // 已保存的值不在候选里(key 被删/模型下市)时回退空
    sel.value = cur && sel.querySelector(`option[value="${cur}"]`) ? cur : '';
  }
}
for (const kind of AUX_KINDS) {
  $('aux-' + kind).onchange = async () => {
    const m = {};
    for (const k of AUX_KINDS) { const v = $('aux-' + k).value; if (v) m[k] = v; }
    await api.auxModelsSet(m);
  };
}

$('apikey-cancel').onclick = () => $('apikey-modal').classList.add('hidden');

// ---------------------------------------------------------------------------
// ComfyUI 连接:服务地址/令牌只经预加载 IPC 进入主进程，列表永远脱敏。
// ---------------------------------------------------------------------------
let editingComfyId = null;
function resetComfyForm() {
  editingComfyId = null;
  $('comfy-form-title').textContent = '添加 ComfyUI 连接';
  $('comfy-name').value = '';
  $('comfy-url').value = 'http://127.0.0.1:8188';
  $('comfy-auth').value = 'none';
  $('comfy-header').value = '';
  $('comfy-secret').value = '';
  $('comfy-http-confirm').checked = false;
  $('comfy-tls-confirm').checked = false;
}
function editComfy(connection) {
  editingComfyId = connection.id;
  $('comfy-form-title').textContent = '编辑 ComfyUI 连接';
  $('comfy-name').value = connection.name || '';
  $('comfy-url').value = connection.baseUrl || '';
  $('comfy-auth').value = connection.authType || 'none';
  $('comfy-header').value = connection.headerName || '';
  $('comfy-secret').value = '';
  $('comfy-http-confirm').checked = !!connection.remoteHttpConfirmed;
  $('comfy-tls-confirm').checked = !!connection.allowInsecureTls;
}
async function renderComfyList() {
  const box = $('comfy-list');
  const list = await api.comfyListConnections();
  if (!list.length) { box.innerHTML = '<div class="mcp-row"><span style="color:var(--text-dim)">暂无 ComfyUI 连接，可在下方添加。</span></div>'; return; }
  box.innerHTML = list.map((connection) => `<div class="mcp-row"><span class="name">${escapeHtml(connection.name)}</span><span class="scope">${escapeHtml(connection.baseUrl)} · ${escapeHtml(connection.authType || 'none')}${connection.authConfigured ? ` ${escapeHtml(connection.secretHint)}` : ''}${connection.health ? ` · ${connection.health.ok ? '已连接' : '连接失败'}` : ''}</span><span class="ops"><button class="btn btn-sm" data-comfy="test" data-id="${connection.id}">测试</button><button class="btn btn-sm" data-comfy="catalog" data-id="${connection.id}">节点目录</button><button class="btn btn-sm" data-comfy="edit" data-id="${connection.id}">编辑</button><button class="btn btn-sm" data-comfy="delete" data-id="${connection.id}">删除</button></span></div>`).join('');
  for (const button of box.querySelectorAll('[data-comfy]')) button.onclick = async () => {
    const connection = list.find((item) => item.id === button.dataset.id);
    const status = $('comfy-status');
    if (button.dataset.comfy === 'edit') { editComfy(connection); return; }
    if (button.dataset.comfy === 'delete') { await api.comfyDeleteConnection(connection.id); await renderComfyList(); return; }
    button.disabled = true;
    if (button.dataset.comfy === 'test') {
      const result = await api.comfyTestConnection(connection.id);
      status.className = 'modal-status ' + (result.ok ? 'ok' : 'err');
      status.textContent = result.ok ? `连接成功${result.version ? ` · ${result.version}` : ''}` : `连接失败: ${result.error || '未知错误'}`;
      await renderComfyList();
    } else {
      const result = await api.comfyCatalog(connection.id, { refresh: true });
      status.className = 'modal-status ' + (result.ok ? 'ok' : 'err');
      status.textContent = result.ok ? `已读取 ${result.catalog.length} 个节点，可用于 ComfyUI 工作流导入与编辑。` : `读取节点目录失败: ${result.error || '未知错误'}`;
    }
    button.disabled = false;
  };
}
async function openComfyModal() {
  resetComfyForm();
  $('comfy-status').textContent = '';
  $('comfy-modal').classList.remove('hidden');
  await renderComfyList();
}
window.addEventListener('drafter:open-comfy', openComfyModal);
$('comfy-close').onclick = () => $('comfy-modal').classList.add('hidden');
$('comfy-save').onclick = async () => {
  const entry = {
    name: $('comfy-name').value.trim() || 'ComfyUI', baseUrl: $('comfy-url').value.trim(),
    authType: $('comfy-auth').value, headerName: $('comfy-header').value.trim(), secret: $('comfy-secret').value.trim(),
    remoteHttpConfirmed: $('comfy-http-confirm').checked, insecureTlsConfirmed: $('comfy-tls-confirm').checked,
    allowInsecureTls: $('comfy-tls-confirm').checked,
  };
  if (editingComfyId) entry.id = editingComfyId;
  const result = await api.comfySaveConnection(entry);
  const status = $('comfy-status');
  status.className = 'modal-status ' + (result.ok ? 'ok' : 'err');
  status.textContent = result.ok ? '已保存 ComfyUI 连接。' : (result.error || '保存失败');
  if (result.ok) { resetComfyForm(); await renderComfyList(); }
};

$('apikey-save').onclick = async () => {
  const entry = {
    name: $('key-name').value.trim() || 'Key',
    key: $('key-secret').value.trim(),
    baseUrl: $('key-baseurl').value.trim(),
    kind: $('key-kind').value || undefined,
    usageUrl: $('key-usageurl').value.trim(),
  };
  if (editingKeyId) entry.id = editingKeyId; // 编辑态带 id 走更新;secret 留空由主进程保留原值
  const st = $('apikey-status');
  const r = await api.keysSave(entry);
  st.className = 'modal-status ' + (r.ok ? 'ok' : 'err');
  if (!r.ok) { st.textContent = r.error || '保存失败'; return; }
  st.textContent = editingKeyId ? '已保存修改。' : '已保存。建议点「刷新模型」按此 Key 识别可用模型。';
  resetKeyForm(); // 保存后退出编辑态
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
// v0.8.2:按「启用」Key 分组聚合模型;选中项编码为 keyId|modelId,凭据与额度随 Key 走
// 板块 → 模型类别集合(v0.9.38):code/chat 只用对话模型;创作板块合并后同时列出
// 图/视/音/3D 四类模型,optgroup 按「Key · 类型」分组,生成类型随所选模型走。
// 画布/素材板块不显示 composer,但沿用媒体类别集合(画布节点模型选择器同口径)。
const SECTION_MODEL_TYPES = { code: ['chat'], chat: ['chat'], media: ['image', 'video', 'audio', 'model'],
  canvas: ['image', 'video', 'audio', 'model'], assets: ['image', 'video', 'audio', 'model'] };
async function populateModelSelects() {
  let entries = null;
  try {
    entries = await api.keysEnabledModels();
    const { list } = await api.keysList();
    // 刷新 Kuro 分组缓存(state.GroupsCache):boardOf/工坊筛选等懒加载路径共用
    state.GroupsCache.clear();
    for (const k of list) if (Array.isArray(k.modelGroups)) state.GroupsCache.set(k.id, k.modelGroups);
  } catch {}
  // 某模型在某 key 下的类别:查分组缓存;无分组(非 Kuro key)或查不到时视为 chat
  const want = SECTION_MODEL_TYPES[state.section] || ['chat'];
  const typeOf = (keyId, model) => {
    const groups = state.GroupsCache.get(keyId);
    if (!groups) return 'chat';
    const g = groups.find((x) => Array.isArray(x.models) && x.models.includes(model));
    return g ? g.model_type : 'chat';
  };
  const filtered = (entries || []).filter((e) => want.includes(typeOf(e.keyId, e.model)));
  const isChatBoard = want.length === 1 && want[0] === 'chat';
  let html = isChatBoard ? '<option value="">默认</option>' : '';
  if (filtered.length) {
    const groups = new Map(); // groupKey = keyId(chat)/keyId|type(media)
    for (const e of filtered) {
      const t = typeOf(e.keyId, e.model);
      const gk = isChatBoard ? e.keyId : e.keyId + '|' + t;
      if (!groups.has(gk)) groups.set(gk, { keyId: e.keyId, name: e.keyName, type: t, models: [] });
      groups.get(gk).models.push(e.model);
    }
    for (const g of groups.values()) {
      const label = isChatBoard ? g.name : `${g.name} · ${MEDIA_TYPE_LABEL[g.type] || g.type}`;
      html += `<optgroup label="${escapeHtml(label)}">` +
        g.models.map((m) => `<option value="${g.keyId}|${escapeHtml(m)}">${escapeHtml(modelLabel(m))}</option>`).join('') +
        '</optgroup>';
    }
  } else if (isChatBoard && !(entries && entries.length)) {
    html += FALLBACK_MODELS.map((id) => `<option value="${id}">${escapeHtml(modelLabel(id))}</option>`).join(''); // 无缓存时的内置回退(仅 code/chat)
  } else {
    html += '<option value="" disabled>该板块暂无可用模型</option>';
  }
  for (const sel of [$('model-sel')]) {
    const cur = sel.value;
    sel.innerHTML = html;
    // 当前值不在新列表时:code/chat 回到「默认」,创作板块落到第一个可用模型
    sel.value = sel.querySelector(`option[value="${cur}"]`) ? cur : ((sel.querySelector('option:not([disabled])') || {}).value || '');
  }
  updateKeyChips(); // 下拉重建后同步 Key chip
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
api.on('aigc:status', (payload) => chat.handleAigcStatus(payload)); // 新媒体生成任务进度

// 点击系统通知(任务完成/权限确认):跳转激活对应会话(v0.9.36)
api.on('sess:activate', async ({ sid } = {}) => {
  if (!sid) return;
  if (!state.sessions.has(sid)) {
    const meta = (await api.sessList()).find((m) => m.id === sid);
    if (!meta) return;
    chat.ensureSession(sid, meta);
  }
  chat.setActiveSession(sid);
  sessionsUi.refreshList();
});

// Cross-project switching: the topbar always reflects the ACTIVE SESSION's
// project group and its own directory — there is no global directory.
on('session-activated', async (sid) => {
  const s = state.sessions.get(sid);
  if (!s) return;
  gems.updateGemSelector(); // 顶栏 Gem 选择器跟随会话回显(v0.9.11)
  // 板块跟随会话类型:会话激活时自动切到其 kind 对应的板块(缺省 code)
  const kind = sectionOfKind(s.meta.kind);
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
// 板块切换:Code(项目工作区)/ Chat(纯对话)/ 创作(图·视·音·3D 一体化,v0.9.38 四大媒体板块合并)
// ---------------------------------------------------------------------------
const SECTIONS = ['code', 'chat', 'media', 'canvas', 'assets', 'harness'];
// 画布/素材板块(v0.10.0)不走会话挑选流程(画布列表/素材网格各有数据源);
// harness 板块(v0.11.0)由 harness 引擎自管会话,也不走 SDK 会话挑选
const NON_SESSION_SECTIONS = ['canvas', 'assets', 'harness'];
function setSection(sec, { skipSessionPick } = {}) {
  if (state.section === sec) return;
  state.section = sec;
  for (const s of SECTIONS) document.body.classList.toggle('sec-' + s, s === sec);
  for (const b of document.querySelectorAll('#section-switch button')) {
    b.classList.toggle('active', b.dataset.sec === sec);
  }
  $('sidebar-head-label').textContent = sec === 'code' ? '项目 / 会话'
    : sec === 'media' ? '创作会话'
    : sec === 'canvas' ? '画布'
    : sec === 'assets' ? '素材'
    : sec === 'harness' ? 'Harness' : '会话';
  $('btn-new-session').textContent = sec === 'canvas' ? '＋ 新画布' : '＋ 新会话';
  // 面板对 code+chat 开放(v0.9.33):Chat 也处理代码任务,需要编辑器/预览/终端;
  // 其余板块(创作/画布/素材)隐藏。
  if (sec !== 'code' && sec !== 'chat') $('right-panel').classList.add('hidden');
  if (NON_SESSION_SECTIONS.includes(sec)) {
    // 各板块自行填充侧栏与主区:画布渲染画布列表,素材重扫网格,harness 启动引擎
    if (sec === 'canvas') canvas.enterSection();
    else if (sec === 'assets') assets.enterSection();
    else if (sec === 'harness') harness.enterSection();
    populateModelSelects();
    return;
  }
  sessionsUi.refreshList();
  if (skipSessionPick) { populateModelSelects(); return; }
  // 异步:先按板块重建模型下拉,再保证激活会话属于该板块。
  // 板块没有会话时自动新建(v0.9.5)——否则旧板块会话滞留,模型下拉会把新媒体模型
  // 错绑到 code/chat 会话,发送走 /v1/messages 必 403「模型未配置」。
  (async () => {
    await populateModelSelects(); // 模型下拉按板块类别重新过滤
    const cur = state.sessions.get(state.activeSid);
    const curKind = sectionOfKind(cur && cur.meta.kind);
    // 下拉重建后必须按会话真实模型回显,否则显示成回退项(看起来像模型被改了,v0.9.6)
    if (curKind === sec) { chat.updateTopbarForSession(state.activeSid); return; }
    const list = await api.sessList();
    const latest = list
      .filter((m) => !m.archived && sectionOfKind(m.kind) === sec)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (latest) {
      chat.ensureSession(latest.id, latest);
      chat.setActiveSession(latest.id);
    } else {
      await sessionsUi.createSession(); // 空板块:自动建会话(创作板块用下拉首个模型)
    }
  })();
}
for (const b of document.querySelectorAll('#section-switch button')) {
  b.onclick = () => setSection(b.dataset.sec);
}

// open the project group's shared memory file in the editor panel
on('open-project-memory', async (pid) => {
  const m = await api.projMemory(pid);
  if (m) emit('open-file', m.path);
});

// --- Gem 自定义助手(v0.9.11) ---
gems.init();
gems.refreshGems();
codeblock.initCodeCopy(); // 代码卡片复制按钮(#messages 事件委托,v0.9.12)
// 管理页「开始对话」:按当前板块建会话并绑定 Gem;Gem 带默认模型且下拉未选模型时套用
on('gem:start-chat', async ({ gemId }) => {
  const g = (state.gems || []).find((x) => x.id === gemId);
  const extra = { gemId };
  if (g && g.model) {
    const sel = parseModelValue($('model-sel').value);
    if (!sel.model) {
      const [keyId, mdl] = String(g.model).split('|');
      if (mdl) { extra.model = mdl; extra.keyId = keyId || null; }
    }
  }
  await sessionsUi.createSession(extra); // createSession 内部 setActiveSession + refreshList
});
// 管理页「近期对话」跳转
on('gem:activate-session', (sid) => chat.setActiveSession(sid));
// Gem 增删改后:刷新选择器与侧栏徽标
on('gems-changed', () => { gems.updateGemSelector(); sessionsUi.refreshList(); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
sessionsUi.init();
input.init();
msgmenu.init();
msgnav.init();
diff.init();
editor.init();
preview.init();
tasks.init();
term.init();
canvas.init(); // 无限画布(v0.10.0):Drawflow 实例与画布板块接线
assets.init(); // 素材板块(v0.10.0)
document.body.classList.add('sec-' + state.section); // 启动即挂板块 class(code-only 元素据此显隐)
chat.setViewMode('normal');
boot();
console.log('[boot] renderer modules loaded OK');
