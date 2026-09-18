// 扩展板块(v0.15.16):Skill 技能 / 自定义子 Agent 的管理界面 + composer 技能选择器。
// 数据经 extList/extSave/extRemove IPC 落 settings.extensions;生效注入在主进程
// sessions.js(技能索引/use_skill/委派守卫)与 main.js sess:send(本条指定全文注入)。
import { api, state, $, escapeHtml, emit } from './state.js';

// Agent 表单的允许工具候选(留空 = 不限制)
const TOOL_CANDIDATES = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

let curTab = 'skill';          // 板块页签:'skill' | 'agent'
let draft = null;              // modal 编辑草稿(未保存的表单状态)
let pinSet = new Set();        // 本条消息手动指定的技能 id(发送后清空)
let toggling = false;          // composer 菜单防连点

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------
export async function refreshExt() {
  try {
    state.extSkills = await api.extList('skill') || [];
    state.extAgents = await api.extList('agent') || [];
  } catch { state.extSkills = []; state.extAgents = []; }
}

function items(kind) { return kind === 'skill' ? (state.extSkills || []) : (state.extAgents || []); }

function avatarLetter(name) { return (String(name || '扩').trim()[0] || '扩').toUpperCase(); }

// ---------------------------------------------------------------------------
// 板块:enterSection / 卡片网格
// ---------------------------------------------------------------------------
export async function enterSection() {
  await refreshExt();
  renderGrid();
  updateSkillSelector();
}

function scopeLabel(a) {
  if (a.scope === 'project') return '项目';
  if (a.scope === 'session') return '会话';
  return '全局';
}

export function renderGrid() {
  const grid = $('ext-grid');
  if (!grid) return;
  const list = items(curTab);
  grid.innerHTML = '';
  $('ext-empty').classList.toggle('hidden', list.length > 0);
  $('ext-hint').textContent = curTab === 'skill'
    ? '技能挂载到会话后按需触发(渐进披露);发送前还可在输入区「🧩 技能」里为本条消息指定'
    : '子 Agent 按作用域生效:全局恒可用;会话级还可在输入区「🤖 子 Agent」菜单挂载';
  const mine = list.filter((x) => !x.preset);
  const presets = list.filter((x) => x.preset);
  const addGroup = (arr, label) => {
    if (!arr.length) return;
    if (label) {
      const h = document.createElement('div');
      h.className = 'ext-group-label';
      h.textContent = label;
      grid.appendChild(h);
    }
    for (const it of arr) grid.appendChild(card(curTab, it));
  };
  addGroup(mine, null);
  addGroup(presets, '预置模板(只读,可复制为副本)');
}

function card(kind, it) {
  const el = document.createElement('div');
  el.className = 'ext-card' + (it.enabled === false ? ' ext-off' : '');
  const tags = [it.preset ? '<span class="ext-tag ext-tag-preset">模板</span>' : '',
    kind === 'agent' ? `<span class="ext-tag">${scopeLabel(it)}</span>` : '',
    it.enabled === false ? '<span class="ext-tag">已停用</span>' : ''].join('');
  el.innerHTML = `
    <div class="ext-card-head">
      <span class="gem-avatar">${escapeHtml(avatarLetter(it.name))}</span>
      <span class="ext-card-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
      ${tags}
    </div>
    <div class="ext-card-desc">${escapeHtml(it.desc || '(无描述)')}</div>
    <div class="ext-card-foot">
      <div class="ext-card-actions">
        ${it.preset ? '' : `<button data-act="toggle" title="${it.enabled === false ? '启用' : '停用'}">${it.enabled === false ? '启用' : '停用'}</button>`}
        <button data-act="edit">${it.preset ? '查看' : '编辑'}</button>
        <button data-act="export" title="导出为 Claude Code 格式 .md">导出</button>
        ${it.preset ? '<button data-act="dup">复制副本</button>' : '<button data-act="del" class="btn-danger-text">删除</button>'}
      </div>
    </div>`;
  el.onclick = (e) => { if (!e.target.closest('button')) openModal(kind, it.id); };
  el.querySelector('[data-act="edit"]').onclick = () => openModal(kind, it.id);
  el.querySelector('[data-act="export"]').onclick = async () => {
    const r = await api.extExport(kind, it.id);
    if (r && r.ok) toast(`已导出:${r.path}`);
    else if (r && !r.canceled) toast('导出失败:' + (r.error || '未知错误'));
  };
  const toggleBtn = el.querySelector('[data-act="toggle"]');
  if (toggleBtn) toggleBtn.onclick = async () => {
    await api.extSave(kind, { ...it, enabled: it.enabled === false });
    await refreshExt();
    renderGrid();
    emit('ext-changed');
  };
  const delBtn = el.querySelector('[data-act="del"]');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`删除「${it.name}」?已挂载它的会话自动失效。`)) return;
    await api.extRemove(kind, it.id);
    await refreshExt();
    renderGrid();
    emit('ext-changed');
  };
  const dupBtn = el.querySelector('[data-act="dup"]');
  if (dupBtn) dupBtn.onclick = () => openModal(kind, it.id, { duplicate: true });
  return el;
}

// 轻量提示:借 ext-hint 栏短暂显示(错误仍用 alert,同 canvas.js 惯例)
let toastTimer = null;
function toast(msg) {
  const el = $('ext-hint');
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => renderGrid(), 3000); // renderGrid 会恢复 hint 默认文案
}

// ---------------------------------------------------------------------------
// 编辑 modal(三栏,结构复用 gem-modal)
// ---------------------------------------------------------------------------
export function openModal(kind, editId = null, { duplicate = false } = {}) {
  curTab = kind;
  syncTabs();
  const src = editId ? items(kind).find((x) => x.id === editId) : null;
  draft = src ? { ...src, files: (src.files || []).map((f) => ({ ...f })) }
    : { id: null, name: '', desc: '', instructions: '', prompt: '', files: [], tools: [], model: null, scope: 'global', scopeId: null, enabled: true, preset: false };
  if (duplicate && draft.preset) {
    draft = { ...draft, id: null, preset: false, name: (draft.name || '') + ' 副本' };
  }
  $('ext-modal').classList.remove('hidden');
  // 字段显隐与文案按 kind 切换
  $('ext-modal').dataset.kind = kind;
  document.querySelectorAll('#ext-modal .ext-skill-only').forEach((el) => el.classList.toggle('hidden', kind !== 'skill'));
  document.querySelectorAll('#ext-modal .ext-agent-only').forEach((el) => el.classList.toggle('hidden', kind !== 'agent'));
  $('ext-name-label').textContent = kind === 'skill' ? '技能名' : 'Agent 名';
  $('ext-body-label').textContent = kind === 'skill' ? '指令' : '提示词';
  $('ext-body').placeholder = kind === 'skill'
    ? '何时触发:什么场景该用这个技能\n执行步骤:1. … 2. …\n输出格式:…'
    : '角色:这个子 Agent 是谁\n职责边界:该做什么/绝不做什么\n汇报方式:完成后向主会话回报的格式';
  renderList();
  loadForm();
}

function closeModal() {
  $('ext-modal').classList.add('hidden');
  hideSkillMenu();
  draft = null;
}

function syncTabs() {
  for (const b of document.querySelectorAll('#ext-tabs button')) {
    b.classList.toggle('active', b.dataset.extTab === curTab);
  }
}

function renderList() {
  const box = $('ext-list');
  box.innerHTML = '';
  const list = items(curTab);
  const mine = list.filter((x) => !x.preset);
  const presets = list.filter((x) => x.preset);
  const addGroup = (arr, label) => {
    if (!arr.length) return;
    if (label) {
      const h = document.createElement('div');
      h.className = 'gli-desc';
      h.style.cssText = 'padding:4px 9px;margin-top:4px;';
      h.textContent = label;
      box.appendChild(h);
    }
    for (const it of arr) {
      const row = document.createElement('div');
      row.className = 'gem-list-item' + (draft && draft.id === it.id ? ' active' : '');
      row.innerHTML = `
        <span class="gem-avatar">${escapeHtml(avatarLetter(it.name))}</span>
        <span class="gli-texts">
          <div class="gli-name">${escapeHtml(it.name)}${it.preset ? '<span class="gem-preset-tag">模板</span>' : ''}${it.enabled === false ? '<span class="gem-preset-tag">停用</span>' : ''}</div>
          <div class="gli-desc">${escapeHtml(it.desc || '')}</div>
        </span>`;
      row.onclick = () => { draft = { ...it, files: (it.files || []).map((f) => ({ ...f })) }; renderList(); loadForm(); };
      box.appendChild(row);
    }
  };
  addGroup(mine, null);
  addGroup(presets, '预置模板');
}

function loadForm() {
  const d = draft;
  if (!d) return;
  $('ext-name').value = d.name || '';
  $('ext-desc').value = d.desc || '';
  $('ext-body').value = curTab === 'skill' ? (d.instructions || '') : (d.prompt || '');
  $('ext-enabled').checked = d.enabled !== false;
  $('ext-draft-row').classList.add('hidden');
  if (curTab === 'skill') renderFiles();
  else { renderScope(); renderModelOptions(); renderToolChips(); }
  // 预置项只读:表单可改(便于预览),保存隐藏,只提供「复制为副本」
  $('ext-save').classList.toggle('hidden', !!d.preset);
  $('ext-delete').classList.toggle('hidden', !!d.preset || !d.id);
  $('ext-duplicate').classList.toggle('hidden', !d.preset);
  $('ext-export').classList.toggle('hidden', !d.id);
  $('ext-status').textContent = '';
  syncPreview();
}

function syncFromForm() {
  if (!draft) return;
  draft.name = $('ext-name').value;
  draft.desc = $('ext-desc').value;
  if (curTab === 'skill') draft.instructions = $('ext-body').value;
  else draft.prompt = $('ext-body').value;
  draft.enabled = $('ext-enabled').checked;
}

function syncPreview() {
  const d = draft || {};
  $('ext-preview-avatar').textContent = avatarLetter(d.name);
  $('ext-preview-name').textContent = d.name || (curTab === 'skill' ? '技能' : '子 Agent');
  $('ext-preview-desc').textContent = d.desc || '';
  $('ext-preview-effect').textContent = curTab === 'skill'
    ? '挂载到会话后,systemPrompt 只放名称+描述;模型判断需要时调用 use_skill 取回完整指令(渐进披露,省 token)。\n发送前在输入区「🧩 技能」里手动指定的技能,全文随该条消息注入,优先级最高。'
    : '按作用域生效:全局=所有 code/chat 会话;项目=该项目下会话;会话=仅指定会话(也可在输入区「🤖 子 Agent」菜单挂载)。\n主模型委派时经 Agent 工具调用;固定模型不为空时强制走该模型,否则跟随会话默认。';
}

// --- 技能:参考文件编辑 ---
function renderFiles() {
  const box = $('ext-files-list');
  box.innerHTML = '';
  for (const f of ((draft && draft.files) || [])) {
    const row = document.createElement('div');
    row.className = 'ext-file-row';
    row.innerHTML = `
      <div class="ext-file-head">
        <input class="input-sm grow" value="${escapeHtml(f.name)}" placeholder="文件名(如 reference.md)" />
        <button class="gk-rm" title="移除">✕</button>
      </div>
      <textarea class="editor-area" rows="3" spellcheck="false" placeholder="参考内容(随技能全文注入)">${escapeHtml(f.content || '')}</textarea>`;
    const [nameInput, rmBtn] = row.querySelectorAll('input,button');
    nameInput.oninput = () => { f.name = nameInput.value; };
    row.querySelector('textarea').oninput = (e) => { f.content = e.target.value; };
    rmBtn.onclick = () => { draft.files = draft.files.filter((x) => x !== f); renderFiles(); };
    box.appendChild(row);
  }
}

// --- 子 Agent:作用域/模型/工具 ---
async function renderScope() {
  const d = draft;
  $('ext-scope').value = d.scope || 'global';
  const target = $('ext-scope-target');
  target.innerHTML = '';
  if (d.scope === 'project') {
    target.classList.remove('hidden');
    try {
      const projs = await api.projList();
      for (const p of projs || []) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name || p.id;
        target.appendChild(o);
      }
    } catch {}
    if (d.scopeId) target.value = d.scopeId;
    if (!target.value && target.options.length) d.scopeId = target.options[0].value;
  } else if (d.scope === 'session') {
    target.classList.remove('hidden');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不绑定(在输入区「🤖 子 Agent」按需挂载)';
    target.appendChild(empty);
    try {
      const sess = await api.sessList();
      for (const m of (sess || []).filter((x) => !x.archived).slice(0, 50)) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.title || m.id;
        target.appendChild(o);
      }
    } catch {}
    // 留空 = 只经会话侧挂载(meta.customAgentIds)生效;选中 = 恒生效于该会话
    target.value = d.scopeId || '';
  } else {
    target.classList.add('hidden');
    d.scopeId = null;
  }
}

async function renderModelOptions() {
  const sel = $('ext-model');
  sel.innerHTML = '<option value="">跟随会话默认</option>';
  try {
    const { list } = await api.keysList();
    for (const k of list || []) {
      if (k.enabled === false || !Array.isArray(k.modelGroups)) continue;
      for (const g of k.modelGroups) {
        if (g.model_type !== 'chat') continue;
        for (const m of g.models || []) {
          const o = document.createElement('option');
          o.value = `${k.id}|${m}`;
          o.textContent = `${m}(${k.name || k.id})`;
          sel.appendChild(o);
        }
      }
    }
  } catch {}
  if (draft && draft.model) sel.value = draft.model;
}

function renderToolChips() {
  const tools = (draft && draft.tools) || [];
  $('ext-tools-btn').textContent = (tools.length ? tools.join(' · ') : '全部工具') + ' ▾';
}

function openToolsMenu() {
  const tools = (draft && draft.tools) || [];
  const menu = $('skill-menu');
  menu.innerHTML = '';
  for (const t of TOOL_CANDIDATES) {
    const b = document.createElement('button');
    b.innerHTML = `${escapeHtml(t)}${tools.includes(t) ? '<span class="gem-tool-check" style="float:right">✓</span>' : ''}`;
    b.onclick = (e) => {
      e.stopPropagation();
      draft.tools = tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t];
      renderToolChips();
      openToolsMenu();
    };
    menu.appendChild(b);
  }
  const r = $('ext-tools-btn').getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.classList.remove('hidden');
}

async function save() {
  syncFromForm();
  const status = $('ext-status');
  if (!draft.name || !draft.name.trim()) {
    status.textContent = '名称不能为空';
    status.className = 'modal-status err';
    return;
  }
  const r = await api.extSave(curTab, draft);
  if (!r || !r.ok) {
    status.textContent = '保存失败:' + ((r && r.error) || '未知错误');
    status.className = 'modal-status err';
    return;
  }
  draft = { ...r.item, files: (r.item.files || []).map((f) => ({ ...f })) };
  await refreshExt();
  renderList();
  loadForm();
  renderGrid();
  status.textContent = '已保存';
  status.className = 'modal-status ok';
  emit('ext-changed');
}

async function removeCurrent() {
  if (!draft || !draft.id) return;
  if (!confirm(`删除「${draft.name}」?已挂载它的会话自动失效。`)) return;
  const r = await api.extRemove(curTab, draft.id);
  if (r && !r.ok) { $('ext-status').textContent = r.error; $('ext-status').className = 'modal-status err'; return; }
  await refreshExt();
  emit('ext-changed');
  closeModal();
  renderGrid();
  openModal(curTab);
}

async function duplicatePreset() {
  if (!draft) return;
  syncFromForm();
  draft = { ...draft, id: null, preset: false, name: (draft.name || '副本') + ' 副本' };
  renderList();
  loadForm();
  $('ext-status').textContent = '已复制为副本,保存后生效';
  $('ext-status').className = 'modal-status ok';
}

// ✨ AI 起草:行内输入一句话(window.prompt 在本应用不可用,v0.15.13 教训)
async function aiDraft() {
  const hint = $('ext-draft-hint').value.trim() || (draft && draft.desc) || '';
  if (!hint) { $('ext-status').textContent = '先写一句目标描述'; $('ext-status').className = 'modal-status err'; return; }
  syncFromForm();
  const btn = $('ext-draft-go');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const r = await api.extDraft({ kind: curTab, hint, existing: curTab === 'skill' ? draft.instructions : draft.prompt });
    if (r && r.ok && r.text) {
      $('ext-body').value = r.text;
      syncFromForm();
      $('ext-status').textContent = '已生成,可按需修改后保存';
      $('ext-status').className = 'modal-status ok';
    } else {
      $('ext-status').textContent = '生成失败:' + ((r && r.error) || '未知错误');
      $('ext-status').className = 'modal-status err';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '生成';
  }
}

async function doImport() {
  const r = await api.extImport(curTab);
  if (!r || !r.ok) {
    if (r && !r.canceled) toast('导入失败:' + ((r && r.error) || '未知错误'));
    return;
  }
  await refreshExt();
  openModal(curTab);
  draft = { preset: false, files: [], tools: [], model: null, scope: 'global', scopeId: null, enabled: true, instructions: '', prompt: '', ...r.item, id: null };
  renderList();
  loadForm();
  $('ext-status').textContent = '已导入,确认后保存生效';
  $('ext-status').className = 'modal-status ok';
}

// ---------------------------------------------------------------------------
// composer 技能选择器:会话挂载(持久)+ 本条指定(pin,发送后清空)
// ---------------------------------------------------------------------------
function sessionSkills() {
  const s = state.sessions.get(state.activeSid);
  return (s && Array.isArray(s.meta.skillIds)) ? s.meta.skillIds : [];
}

export function updateSkillSelector() {
  const btn = $('skill-sel-btn');
  const name = $('skill-sel-name');
  if (!btn || !name) return;
  const s = state.sessions.get(state.activeSid);
  const mounted = sessionSkills().length;
  const pins = pinSet.size;
  name.textContent = pins ? `技能 (${mounted}+${pins}★)` : mounted ? `技能 (${mounted})` : '技能';
  btn.classList.toggle('active', mounted + pins > 0);
  const disabledReason = !s ? '没有活动会话'
    : (s.meta.kind && s.meta.kind !== 'code' && s.meta.kind !== 'chat') ? '创作会话不使用技能'
      : null;
  btn.disabled = !!disabledReason;
  btn.title = disabledReason || '挂载技能到本会话(模型按需调用);★ 为本条消息手动指定,优先级最高,发送后清空';
  if (btn.disabled) hideSkillMenu();
}

async function toggleMount(id) {
  const s = state.sessions.get(state.activeSid);
  if (!s || toggling) return;
  toggling = true;
  try {
    const before = sessionSkills();
    const next = before.includes(id) ? before.filter((x) => x !== id) : [...before, id];
    const r = await api.sessSetSkills(s.meta.id, next);
    if (r && r.ok) {
      s.meta.skillIds = r.skillIds || [];
      if (!s.meta.skillIds.includes(id)) pinSet.delete(id); // 取消挂载连带取消指定
    }
    updateSkillSelector();
  } finally {
    toggling = false;
  }
}

function renderSkillMenu() {
  const menu = $('skill-menu');
  const s = state.sessions.get(state.activeSid);
  if (!menu || !s) return;
  const all = (state.extSkills || []).filter((x) => x.enabled !== false);
  const mounted = new Set(sessionSkills());
  menu.innerHTML = '<div class="skill-menu-title">挂载到本会话 <span>(索引+按需调用)</span></div>';
  if (!all.length) {
    menu.innerHTML += '<div class="agent-menu-empty">还没有技能——去「扩展」板块新建</div>';
  }
  for (const sk of all) {
    const row = document.createElement('button');
    const on = mounted.has(sk.id);
    row.className = 'agent-model-row' + (on ? ' active' : '');
    row.innerHTML = `<span class="agent-model-check">${on ? '✓' : ''}</span><span title="${escapeHtml(sk.desc || '')}">${escapeHtml(sk.name)}</span>`;
    row.onclick = async (e) => { e.stopPropagation(); await toggleMount(sk.id); renderSkillMenu(); };
    menu.appendChild(row);
  }
  const pinned = all.filter((x) => mounted.has(x.id));
  if (pinned.length) {
    const t = document.createElement('div');
    t.className = 'skill-menu-title';
    t.innerHTML = '本条消息指定 <span>(全文随消息注入,优先级最高,发送后清空)</span>';
    menu.appendChild(t);
    for (const sk of pinned) {
      const row = document.createElement('button');
      const on = pinSet.has(sk.id);
      row.className = 'agent-model-row' + (on ? ' active' : '');
      row.innerHTML = `<span class="agent-model-check">${on ? '★' : ''}</span><span title="${escapeHtml(sk.desc || '')}">${escapeHtml(sk.name)}</span>`;
      row.onclick = (e) => {
        e.stopPropagation();
        if (pinSet.has(sk.id)) pinSet.delete(sk.id); else pinSet.add(sk.id);
        updateSkillSelector();
        renderSkillMenu();
      };
      menu.appendChild(row);
    }
  }
  const r = $('skill-sel-btn').getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  menu.classList.remove('hidden');
  const mh = menu.offsetHeight;
  const below = window.innerHeight - r.top - 6;
  if (below >= mh) {
    menu.style.top = '';
    menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  } else {
    menu.style.bottom = '';
    menu.style.top = Math.max(8, r.bottom + 6) + 'px';
  }
}

export function hideSkillMenu() {
  const menu = $('skill-menu');
  if (menu) menu.classList.add('hidden');
}

// 发送时取走本条指定的技能 id(并清空);input.js 在每条条发送前调用
export function consumePins() {
  if (!pinSet.size) return undefined;
  const pinSkillIds = [...pinSet];
  pinSet.clear();
  updateSkillSelector();
  return { pinSkillIds };
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export function init() {
  for (const b of document.querySelectorAll('#ext-tabs button')) {
    b.onclick = () => { curTab = b.dataset.extTab; syncTabs(); renderGrid(); };
  }
  $('btn-ext-new').onclick = () => openModal(curTab);
  $('btn-ext-import').onclick = doImport;
  $('ext-new').onclick = () => { draft = { id: null, name: '', desc: '', instructions: '', prompt: '', files: [], tools: [], model: null, scope: 'global', scopeId: null, enabled: true, preset: false }; renderList(); loadForm(); };
  $('ext-close').onclick = closeModal;
  $('ext-save').onclick = save;
  $('ext-delete').onclick = removeCurrent;
  $('ext-duplicate').onclick = duplicatePreset;
  $('ext-export').onclick = async () => {
    if (!draft || !draft.id) return;
    const r = await api.extExport(curTab, draft.id);
    if (r && r.ok) { $('ext-status').textContent = '已导出:' + r.path; $('ext-status').className = 'modal-status ok'; }
    else if (r && !r.canceled) { $('ext-status').textContent = '导出失败:' + (r.error || ''); $('ext-status').className = 'modal-status err'; }
  };
  $('ext-ai-draft').onclick = () => $('ext-draft-row').classList.toggle('hidden');
  $('ext-draft-go').onclick = aiDraft;
  $('ext-draft-hint').onkeydown = (e) => { if (e.key === 'Enter') aiDraft(); };
  $('ext-add-file').onclick = () => { if (!draft) return; draft.files = [...(draft.files || []), { name: '', content: '' }]; renderFiles(); };
  $('ext-scope').onchange = () => { if (!draft) return; draft.scope = $('ext-scope').value; draft.scopeId = null; renderScope(); };
  $('ext-scope-target').onchange = () => { if (draft) draft.scopeId = $('ext-scope-target').value; };
  $('ext-model').onchange = () => { if (draft) draft.model = $('ext-model').value || null; };
  $('ext-tools-btn').onclick = (e) => { e.stopPropagation(); openToolsMenu(); };
  // 表单输入联动预览
  for (const id of ['ext-name', 'ext-desc']) {
    $(id).addEventListener('input', () => { syncFromForm(); syncPreview(); });
  }
  // modal 遮罩点击空白关闭
  $('ext-modal').addEventListener('mousedown', (e) => { if (e.target === $('ext-modal')) closeModal(); });
  // composer 技能选择器
  const btn = $('skill-sel-btn');
  if (btn) btn.onclick = async (e) => {
    e.stopPropagation();
    const menu = $('skill-menu');
    if (!menu.classList.contains('hidden')) { hideSkillMenu(); return; }
    await refreshExt();
    renderSkillMenu();
  };
  document.addEventListener('click', (e) => {
    const menu = $('skill-menu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== $('skill-sel-btn') && e.target !== $('ext-tools-btn')) {
      hideSkillMenu();
    }
  });
  updateSkillSelector();
}
