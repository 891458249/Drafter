// Gem 自定义助手(v0.9.11):管理 modal(三栏:列表/编辑/预览,对齐 Gemini Gem 编辑器)
// + composer Gem 选择器。数据存主进程 store settings.gems,经 api.gems* IPC。
import { api, state, $, escapeHtml, emit } from './state.js';

// 默认工具候选(对齐截图):标签即注入 systemPrompt 的偏好文本
const TOOL_OPTIONS = ['制作图片', '制作视频', '制作音乐', 'Canvas', 'Deep Research', '学习辅导'];

// 当前编辑的草稿(未保存的表单状态);null = 未在编辑
let draft = null;

export async function refreshGems() {
  try { state.gems = await api.gemsList() || []; } catch { state.gems = []; }
}

function avatarLetter(name) {
  return (String(name || 'G').trim()[0] || 'G').toUpperCase();
}

// ---------------------------------------------------------------------------
// 管理 modal
// ---------------------------------------------------------------------------
export async function openGemModal(editId = null) {
  await refreshGems();
  if (!draft || editId) {
    const g = editId ? state.gems.find((x) => x.id === editId) : null;
    draft = g ? { ...g, knowledge: (g.knowledge || []).map((k) => ({ ...k })) }
      : { id: null, name: '', desc: '', instructions: '', tools: [], model: null, knowledge: [], knowledgeEnabled: true, preset: false };
  }
  $('gem-modal').classList.remove('hidden');
  renderList();
  loadForm();
}

function closeModal() {
  $('gem-modal').classList.add('hidden');
  hideMenu();
  draft = null;
}

function renderList() {
  const box = $('gem-list');
  box.innerHTML = '';
  const presets = state.gems.filter((g) => g.preset);
  const mine = state.gems.filter((g) => !g.preset);
  const addGroup = (items, label) => {
    if (!items.length) return;
    if (label) {
      const h = document.createElement('div');
      h.className = 'gli-desc';
      h.style.cssText = 'padding:4px 9px;margin-top:4px;';
      h.textContent = label;
      box.appendChild(h);
    }
    for (const g of items) {
      const it = document.createElement('div');
      it.className = 'gem-list-item' + (draft && draft.id === g.id ? ' active' : '');
      it.innerHTML = `
        <span class="gem-avatar">${escapeHtml(avatarLetter(g.name))}</span>
        <span class="gli-texts">
          <div class="gli-name">${escapeHtml(g.name)}${g.preset ? '<span class="gem-preset-tag">预置</span>' : ''}</div>
          <div class="gli-desc">${escapeHtml(g.desc || '')}</div>
        </span>`;
      it.onclick = () => { draft = { ...g, knowledge: (g.knowledge || []).map((k) => ({ ...k })) }; renderList(); loadForm(); };
      box.appendChild(it);
    }
  };
  addGroup(mine, null);
  addGroup(presets, '预置 Gem');
}

function loadForm() {
  const d = draft;
  if (!d) return;
  $('gem-name').value = d.name || '';
  $('gem-desc').value = d.desc || '';
  $('gem-instructions').value = d.instructions || '';
  $('gem-knowledge-off').checked = d.knowledgeEnabled === false;
  renderToolChips();
  renderKnowledge();
  // 预置项只读:表单可改(便于预览),但保存隐藏,只提供「复制为副本」
  $('gem-save').classList.toggle('hidden', !!d.preset);
  $('gem-delete').classList.toggle('hidden', !!d.preset || !d.id);
  $('gem-duplicate').classList.toggle('hidden', !d.preset);
  $('gem-status').textContent = '';
  syncPreview();
}

function syncFromForm() {
  if (!draft) return;
  draft.name = $('gem-name').value;
  draft.desc = $('gem-desc').value;
  draft.instructions = $('gem-instructions').value;
  draft.knowledgeEnabled = !$('gem-knowledge-off').checked;
}

function syncPreview() {
  const d = draft || {};
  $('gem-preview-avatar').textContent = avatarLetter(d.name);
  $('gem-preview-name').textContent = d.name || 'Gem';
  $('gem-preview-desc').textContent = d.desc || '';
  renderRecent();
}

async function renderRecent() {
  const box = $('gem-recent-list');
  box.innerHTML = '';
  if (!draft || !draft.id) {
    box.innerHTML = '<div class="gem-recent-empty">保存后即可看到使用该助手的对话</div>';
    return;
  }
  const sessions = (await api.sessList())
    .filter((m) => m.gemId === draft.id && !m.archived)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 5);
  if (!sessions.length) {
    box.innerHTML = '<div class="gem-recent-empty">暂无对话</div>';
    return;
  }
  for (const m of sessions) {
    const it = document.createElement('div');
    it.className = 'gem-recent-item';
    it.innerHTML = `<span class="gem-avatar">${escapeHtml(avatarLetter(draft.name))}</span><span>${escapeHtml(m.title || '未命名会话')}</span>`;
    it.onclick = () => { closeModal(); emit('gem:activate-session', m.id); };
    box.appendChild(it);
  }
}

// --- 默认工具多选(chips + 共享小下拉) ---
function renderToolChips() {
  const btn = $('gem-tools-btn');
  const tools = (draft && draft.tools) || [];
  btn.textContent = (tools.length ? tools.join(' · ') : '没有默认工具') + ' ▾';
}

function renderKnowledge() {
  const box = $('gem-knowledge-list');
  box.innerHTML = '';
  for (const k of ((draft && draft.knowledge) || [])) {
    const row = document.createElement('div');
    row.className = 'gem-knowledge-row';
    row.innerHTML = `<span>📄</span><span class="gk-name" title="${escapeHtml(k.path)}">${escapeHtml(k.name)}</span><button class="gk-rm" title="移除">✕</button>`;
    row.querySelector('.gk-rm').onclick = () => {
      draft.knowledge = draft.knowledge.filter((x) => x.path !== k.path);
      renderKnowledge();
    };
    box.appendChild(row);
  }
}

// --- 共享小下拉(Gem 选择器 / 默认工具 共用) ---
let menuAnchor = null;
function showMenu(anchorEl, items) {
  const menu = $('gem-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { const hr = document.createElement('hr'); menu.appendChild(hr); continue; }
    const b = document.createElement('button');
    b.innerHTML = it.label;
    if (it.active) b.style.color = 'var(--accent)';
    b.onclick = (e) => { e.stopPropagation(); hideMenu(); it.onClick(); };
    menu.appendChild(b);
  }
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.classList.remove('hidden');
  menuAnchor = anchorEl;
}
export function hideMenu() { $('gem-menu').classList.add('hidden'); menuAnchor = null; }

function openToolsMenu() {
  const tools = (draft && draft.tools) || [];
  showMenu($('gem-tools-btn'), TOOL_OPTIONS.map((t) => ({
    label: `${escapeHtml(t)}${tools.includes(t) ? '<span class="gem-tool-check" style="float:right">✓</span>' : ''}`,
    active: tools.includes(t),
    onClick: () => {
      draft.tools = tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t];
      renderToolChips();
    },
  })));
}

async function save() {
  syncFromForm();
  const status = $('gem-status');
  if (!draft.name || !draft.name.trim()) {
    status.textContent = '名称不能为空';
    status.className = 'modal-status err';
    return;
  }
  const r = await api.gemsSave(draft);
  if (!r || !r.ok) {
    status.textContent = '保存失败:' + ((r && r.error) || '未知错误');
    status.className = 'modal-status err';
    return;
  }
  draft = { ...r.gem, knowledge: (r.gem.knowledge || []).map((k) => ({ ...k })) };
  await refreshGems();
  renderList();
  loadForm();
  status.textContent = '已保存';
  status.className = 'modal-status ok';
  emit('gems-changed');
}

async function removeCurrent() {
  if (!draft || !draft.id) return;
  if (!confirm(`删除 Gem「${draft.name}」?已绑定它的会话不受影响(自动失效)。`)) return;
  const r = await api.gemsDelete(draft.id);
  if (r && !r.ok) { $('gem-status').textContent = r.error; $('gem-status').className = 'modal-status err'; return; }
  await refreshGems();
  emit('gems-changed');
  draft = null;
  closeModal();
  openGemModal(); // 回到空白/第一个
}

async function duplicatePreset() {
  if (!draft) return;
  syncFromForm();
  draft = { ...draft, id: null, preset: false, name: (draft.name || 'Gem') + ' 副本' };
  $('gem-name').value = draft.name;
  renderList();
  loadForm();
  $('gem-status').textContent = '已复制为副本,保存后生效';
  $('gem-status').className = 'modal-status ok';
}

// ✨ AI 优化指令:一句话描述 → 主进程调 chat 模型按四要素扩写
async function aiRewrite() {
  const hint = prompt('用一两句话描述这个助手的目标:\n(会结合当前指令一起改写)', (draft && draft.desc) || '');
  if (hint == null) return;
  syncFromForm();
  const btn = $('gem-ai-rewrite');
  btn.disabled = true;
  btn.textContent = '✨ 生成中…';
  try {
    const r = await api.gemsRewrite({ hint, instructions: draft.instructions });
    if (r && r.ok && r.instructions) {
      draft.instructions = r.instructions;
      $('gem-instructions').value = r.instructions;
      $('gem-status').textContent = '已生成,可按需修改后保存';
      $('gem-status').className = 'modal-status ok';
    } else {
      $('gem-status').textContent = '生成失败:' + ((r && r.error) || '未知错误');
      $('gem-status').className = 'modal-status err';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI 优化';
  }
}

// 「开始对话」:按当前板块 kind 建会话并绑定该 Gem
async function startChat() {
  if (!draft || !draft.id) {
    $('gem-status').textContent = '请先保存,再开始对话';
    $('gem-status').className = 'modal-status err';
    return;
  }
  closeModal();
  emit('gem:start-chat', { gemId: draft.id, name: draft.name });
}

// ---------------------------------------------------------------------------
// composer Gem 选择器
// ---------------------------------------------------------------------------
export function updateGemSelector() {
  const s = state.sessions.get(state.activeSid);
  const gemId = s && s.meta.gemId;
  const gem = gemId ? state.gems.find((g) => g.id === gemId) : null;
  $('gem-sel-name').textContent = gem ? gem.name : 'Gem';
  $('gem-sel-btn').classList.toggle('active', !!gem);
}

function openGemPicker() {
  const s = state.sessions.get(state.activeSid);
  if (!s) return;
  const cur = s.meta.gemId || null;
  const items = [
    { label: '不使用 Gem', active: !cur, onClick: () => pickGem(null) },
    '-',
    ...state.gems.map((g) => ({
      label: `💎 ${escapeHtml(g.name)}`,
      active: g.id === cur,
      onClick: () => pickGem(g.id),
    })),
    '-',
    { label: '管理 Gem…', onClick: () => openGemModal() },
  ];
  showMenu($('gem-sel-btn'), items);
}

async function pickGem(gemId) {
  const s = state.sessions.get(state.activeSid);
  if (!s) return;
  await api.sessSetGem(s.meta.id, gemId);
  s.meta.gemId = gemId;
  updateGemSelector();
  emit('session-status', { sid: s.meta.id });
  emit('gem-changed-session', { sid: s.meta.id });
}

// ---------------------------------------------------------------------------
export function init() {
  // modal 表单联动
  $('gem-new').onclick = () => {
    syncFromFormIfOpen();
    draft = { id: null, name: '', desc: '', instructions: '', tools: [], model: null, knowledge: [], knowledgeEnabled: true, preset: false };
    renderList(); loadForm();
    $('gem-name').focus();
  };
  $('gem-close').onclick = closeModal;
  $('gem-save').onclick = save;
  $('gem-delete').onclick = removeCurrent;
  $('gem-duplicate').onclick = duplicatePreset;
  $('gem-ai-rewrite').onclick = aiRewrite;
  $('gem-start-chat').onclick = startChat;
  $('gem-tools-btn').onclick = (e) => { e.stopPropagation(); openToolsMenu(); };
  $('gem-add-knowledge').onclick = async () => {
    syncFromForm();
    const paths = await api.pickFiles({});
    if (!paths || !paths.length) return;
    const room = 10 - (draft.knowledge || []).length;
    for (const p of paths.slice(0, Math.max(0, room))) {
      draft.knowledge.push({ path: p, name: p.split(/[\\/]/).pop() });
    }
    if (paths.length > room) {
      $('gem-status').textContent = `知识文件最多 10 个,已忽略 ${paths.length - room} 个`;
      $('gem-status').className = 'modal-status err';
    }
    renderKnowledge();
  };
  $('gem-knowledge-off').onchange = syncFromForm;
  for (const id of ['gem-name', 'gem-desc', 'gem-instructions']) {
    $(id).addEventListener('input', () => { syncFromForm(); syncPreview(); });
  }
  // composer 选择器
  $('gem-sel-btn').onclick = (e) => { e.stopPropagation(); refreshGems().then(openGemPicker); };
  // 共享小下拉:点别处关闭
  document.addEventListener('click', (e) => {
    const menu = $('gem-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) hideMenu();
  });
}

function syncFromFormIfOpen() {
  if (!$('gem-modal').classList.contains('hidden')) syncFromForm();
}
