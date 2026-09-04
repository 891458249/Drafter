// Sidebar: project groups with sessions nested under each group.
// Group header: editable name, per-group "+" (new session), file manager
// (load files/folders with live read-only/editable tags).
import { api, state, $, escapeHtml, emit, on, parseModelValue, showCtxMenu, gemNameOf, sectionOfKind, boardOf, ensureGroups } from './state.js';
import { ensureSession, setActiveSession } from './chat.js';

const attention = new Set();
const collapsedProjects = new Set();
const openFilePanels = new Set();

// --- 项目右键菜单(v0.9.1):打开对应文件夹 -------------------------------------
function showProjMenu(x, y, p) {
  showCtxMenu(x, y, [{ label: '打开文件夹', onClick: () => api.projOpenFolder(p.id) }]);
}

export async function refreshList() {
  // 画布板块(v0.10.0):侧栏是画布列表,由 canvas.js 掌管;素材板块侧栏隐藏
  if (state.section === 'canvas') { const m = await import('./canvas.js'); m.renderList(); return; }
  if (state.section === 'assets') { $('session-list').innerHTML = ''; return; }
  const [projList, sessList] = await Promise.all([api.projList(), api.sessList()]);
  const filter = ($('session-filter').value || '').toLowerCase();
  const showArchived = $('show-archived').checked;
  const ul = $('session-list');
  ul.innerHTML = '';

  const byProject = new Map();
  for (const m of sessList) {
    const pid = m.projectId || '_none';
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(m);
  }

  // --- 非 code 板块(chat/创作):对应板块的会话平铺列表(无项目组、无独立会话) ---
  if (state.section !== 'code') {
    let chats = (byProject.get('_none') || [])
      .filter((m) => sectionOfKind(m.kind) === state.section)
      .filter((m) => showArchived ? true : !m.archived)
      .filter((m) => !filter || (m.title || '').toLowerCase().includes(filter))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // 创作板块(v0.9.38):工坊 chips 按会话当前模型的生成类型过滤
    if (state.section === 'media' && state.mediaShop !== 'all') {
      await ensureGroups(); // boardOf 依赖 Kuro 分组缓存,首次懒加载
      chats = chats.filter((m) => boardOf(m.keyId, m.model, m.kind, m.board) === state.mediaShop);
    }
    const li = document.createElement('li');
    li.className = 'proj-group';
    const sessUl = document.createElement('ul');
    sessUl.className = 'proj-sessions';
    for (const m of chats) sessUl.appendChild(renderSessionItem(null, m));
    li.appendChild(sessUl);
    ul.appendChild(li);
    return;
  }

  const projs = [...projList];
  // sort project groups by their most recent session activity
  projs.sort((a, b) => {
    const la = Math.max(0, ...(byProject.get(a.id) || []).map((s) => s.updatedAt || 0));
    const lb = Math.max(0, ...(byProject.get(b.id) || []).map((s) => s.updatedAt || 0));
    return lb - la;
  });

  for (const p of projs) {
    let sessions = (byProject.get(p.id) || [])
      .filter((m) => showArchived ? true : !m.archived)
      .filter((m) => !filter
        || (m.title || '').toLowerCase().includes(filter)
        || (p.name || '').toLowerCase().includes(filter))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (filter && !sessions.length && !(p.name || '').toLowerCase().includes(filter)) continue;

    const li = document.createElement('li');
    li.className = 'proj-group';
    const collapsed = collapsedProjects.has(p.id);
    const filesOpen = openFilePanels.has(p.id);
    const isActive = state.projectId === p.id;

    li.innerHTML = `
      <div class="proj-head${isActive ? ' active' : ''}">
        <span class="proj-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="proj-name" title="双击重命名">${escapeHtml(p.name)}</span>
        <span class="proj-count">${sessions.length}</span>
        <span class="proj-ops">
          <button data-op="files" title="项目文件与标签">📁</button>
          <button data-op="add" title="在此项目组新建会话">＋</button>
        </span>
      </div>
      <div class="proj-dir" title="${escapeHtml((p.dirs && p.dirs[0]) || '')}">📂 ${escapeHtml((p.dirs && p.dirs[0]) || '(未设置目录)')}</div>
      <div class="proj-files ${filesOpen ? '' : 'hidden'}"></div>
      <ul class="proj-sessions ${collapsed ? 'hidden' : ''}"></ul>`;

    const head = li.querySelector('.proj-head');
    head.querySelector('.proj-caret').onclick = () => {
      collapsed ? collapsedProjects.delete(p.id) : collapsedProjects.add(p.id);
      refreshList();
    };
    const nameEl = head.querySelector('.proj-name');
    nameEl.ondblclick = async () => {
      const name = prompt('项目组名称:', p.name);
      if (name != null && name.trim()) { await api.projRename(p.id, name.trim()); refreshList(); }
    };
    head.querySelector('[data-op="add"]').onclick = async (e) => {
      e.stopPropagation();
      await createSessionInProject(p);
    };
    head.querySelector('[data-op="files"]').onclick = (e) => {
      e.stopPropagation();
      filesOpen ? openFilePanels.delete(p.id) : openFilePanels.add(p.id);
      refreshList();
    };
    head.oncontextmenu = (e) => {
      e.preventDefault();
      showProjMenu(e.clientX, e.clientY, p);
    };

    renderProjectFiles(li.querySelector('.proj-files'), p);

    const sessUl = li.querySelector('.proj-sessions');
    for (const m of sessions) sessUl.appendChild(renderSessionItem(p, m));
    ul.appendChild(li);
  }

  // --- 独立会话区(不属于任何项目组;仅 code 会话,非 code 板块会话只在各自板块显示) ---
  const standalone = (byProject.get('_none') || [])
    .filter((m) => m.standalone && (!m.kind || m.kind === 'code'))
    .filter((m) => showArchived ? true : !m.archived)
    .filter((m) => !filter || (m.title || '').toLowerCase().includes(filter))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (standalone.length) {
    const li = document.createElement('li');
    li.className = 'proj-group standalone-group';
    li.innerHTML = `
      <div class="proj-head">
        <span class="proj-name">独立会话</span>
        <span class="proj-count">${standalone.length}</span>
      </div>
      <ul class="proj-sessions"></ul>`;
    const sessUl = li.querySelector('.proj-sessions');
    for (const m of standalone) sessUl.appendChild(renderSessionItem(null, m));
    ul.appendChild(li);
  }
}

function renderProjectFiles(box, p) {
  const files = p.files || [];
  const dirs = p.dirs || [];
  box.innerHTML = '';
  for (const d of dirs) {
    const row = document.createElement('div');
    row.className = 'proj-file-row dir';
    row.innerHTML = `<span class="pf-name" title="${escapeHtml(d)}">📂 ${escapeHtml(d)}</span>`;
    box.appendChild(row);
  }
  for (const f of files) {
    const ro = f.tag === 'readonly';
    const row = document.createElement('div');
    row.className = 'proj-file-row';
    row.innerHTML = `
      <span class="pf-name" title="${escapeHtml(f.path)}">${escapeHtml(f.path.split(/[\\/]/).pop())}</span>
      <button class="pf-tag ${ro ? 'ro' : 'rw'}" title="点击切换只读/可修改">${ro ? '只读' : '可改'}</button>
      <button class="pf-rm" title="移出项目组">✕</button>`;
    row.querySelector('.pf-tag').onclick = async () => {
      await api.projSetTag(p.id, f.path, ro ? 'editable' : 'readonly');
      refreshList();
    };
    row.querySelector('.pf-rm').onclick = async () => {
      await api.projRemoveFile(p.id, f.path);
      refreshList();
    };
    box.appendChild(row);
  }
  const ops = document.createElement('div');
  ops.className = 'pf-ops';
  ops.innerHTML = `
    <button class="btn btn-sm" data-op="addfile">＋文件</button>
    <button class="btn btn-sm" data-op="adddir">＋文件夹</button>
    <button class="btn btn-sm" data-op="mem">共享记忆</button>`;
  ops.querySelector('[data-op="addfile"]').onclick = async () => {
    const paths = await api.pickFiles({});
    if (paths.length) { await api.projAddFiles(p.id, paths, 'editable'); refreshList(); }
  };
  ops.querySelector('[data-op="adddir"]').onclick = async () => {
    const res = await api.pickDir();
    if (res && res.dir) { await api.projAddDir(p.id, res.dir); refreshList(); }
  };
  ops.querySelector('[data-op="mem"]').onclick = () => emit('open-project-memory', p.id);
  box.appendChild(ops);
}

function renderSessionItem(p, m) {
  ensureSession(m.id, m);
  const live = state.sessions.get(m.id);
  const li = document.createElement('li');
  li.className = 'session-item'
    + (m.id === state.activeSid ? ' active' : '')
    + (attention.has(m.id) ? ' attention' : '');
  const busy = live && live.ui.busy;
  li.innerHTML = `
    <div class="session-title">
      ${busy ? '<span class="spin">◐</span>' : ''}
      <span>${escapeHtml(m.title || '未命名会话')}</span>
      ${m.parentId ? '<span class="badge-side">side</span>' : ''}
      ${m.worktreePath ? '<span class="badge-wt">wt</span>' : ''}
      ${m.gemId && gemNameOf(m.gemId) ? `<span class="badge-gem">💎${escapeHtml(gemNameOf(m.gemId))}</span>` : ''}
      ${m.model ? `<span class="badge-model">${escapeHtml(shortModel(m.model))}</span>` : ''}
    </div>
    <div class="session-sub">${escapeHtml(new Date(m.updatedAt || m.createdAt || Date.now()).toLocaleString())}${m.archived ? ' · 已归档' : ''}</div>`;
  li.title = '右键:重命名 / Side chat / 归档 / 删除'; // 操作项收进右键菜单(v0.9.8)
  li.onclick = () => {
    attention.delete(m.id);
    setActiveSession(m.id);
    refreshList();
  };
  li.oncontextmenu = (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '重命名', onClick: () => renameSession(m) },
      { label: 'Side chat', onClick: () => sideChat(m) },
      { label: m.archived ? '恢复' : '归档', onClick: async () => { await api.sessArchive(m.id, !m.archived); refreshList(); } },
      '-',
      { label: '删除', danger: true, onClick: () => removeSession(m) },
    ]);
  };
  return li;
}

async function renameSession(m) {
  const title = prompt('会话名称:', m.title || '');
  if (title != null) { await api.sessRename(m.id, title.trim()); refreshList(); }
}

async function sideChat(m) {
  const meta = await api.sessCreate({
    cwd: m.cwd, model: m.model, keyId: m.keyId || null, permissionMode: m.permissionMode,
    effort: m.effort || null, // side chat 继承父会话的推理深度设置
    title: (m.title || '会话') + ' · side', parentId: m.id,
    projectId: m.projectId, forkFrom: m.sdkSessionId || null,
    gemId: m.gemId || null, // side chat 继承 Gem 绑定(v0.9.11)
    standalone: m.standalone || undefined, kind: m.kind || undefined, // 独立/非 code 板块会话的 side 不进项目组
    chatMode: m.chatMode || undefined, // side chat 继承极速/Agent 模式(v0.10.2)
  });
  ensureSession(meta.id, meta);
  setActiveSession(meta.id);
  refreshList();
}

async function removeSession(m) {
  if (!confirm('删除会话及其历史记录?')) return;
  await api.sessRemove(m.id);
  const s = state.sessions.get(m.id);
  if (s) { s.ui.logEl.remove(); state.sessions.delete(m.id); }
  refreshList();
}

function shortModel(model) {
  if (/fable/.test(model)) return 'Fable';
  if (/opus/.test(model)) return 'Opus';
  if (/sonnet/.test(model)) return 'Sonnet';
  if (/haiku/.test(model)) return 'Haiku';
  return model.slice(0, 8);
}

async function createSessionInProject(p) {
  const sel = parseModelValue($('model-sel').value);
  const meta = await api.sessCreate({
    cwd: (p.dirs && p.dirs[0]) || state.cwd,
    projectId: p.id,
    model: sel.model,
    keyId: sel.keyId,
    permissionMode: $('perm-mode').value,
    effort: null, // 推理深度跟随默认,由会话内下拉按需约束
    useWorktree: $('new-worktree').checked,
  });
  ensureSession(meta.id, meta);
  setActiveSession(meta.id);
  refreshList();
  return meta;
}

// New session: standalone by default (v0.5.0) — lives outside project groups
// with the home directory as cwd unless a specific folder is given.
// Project sessions are created via the group's own ＋ button or the ⋯ menu's
// "打开目录" flow.
export async function createSession(extra = {}) {
  // 画布板块点「＋ 新画布」:创建画布而不是会话(v0.10.0);引擎按 settings.canvasEngine(v0.13.0)
  if (state.section === 'canvas') { const m = await import(state.canvasEngine === 'drawflow' ? './canvas.js' : './canvas2.js'); return m.createFromSidebar(); }
  let sel = parseModelValue($('model-sel').value);
  const board = state.section;
  // 创作板块必须选中模型;无可用模型时拦截并提示
  if (board !== 'code' && board !== 'chat' && !sel.model) {
    alert('该板块暂无可用模型,请先在「配置 API Key」中刷新 Kuro 网关的模型列表。');
    return null;
  }
  // 工坊筛选下新建会话(v0.9.38):当前下拉所选模型类型与工坊不符时,预选该类型首个模型
  if (board === 'media' && state.mediaShop !== 'all') {
    await ensureGroups();
    if (boardOf(sel.keyId, sel.model) !== state.mediaShop) {
      for (const opt of $('model-sel').options) {
        const v = parseModelValue(opt.value);
        if (v.model && boardOf(v.keyId, v.model) === state.mediaShop) { sel = v; break; }
      }
    }
  }
  const meta = await api.sessCreate({
    standalone: true,
    kind: board !== 'code' ? board : undefined, // 非 code 板块的新会话打对应 kind 标记
    model: sel.model,
    keyId: sel.keyId,
    permissionMode: $('perm-mode').value,
    effort: null, // 推理深度跟随默认,由会话内下拉按需约束
    ...extra,
  });
  ensureSession(meta.id, meta);
  setActiveSession(meta.id);
  refreshList();
  return meta;
}

export function init() {
  $('btn-new-session').onclick = () => createSession();
  $('session-filter').oninput = refreshList;
  $('show-archived').onchange = refreshList;
  // 创作板块工坊筛选 chips(v0.9.38):点击切换 state.mediaShop 并重绘列表
  for (const b of document.querySelectorAll('#shop-filter button')) {
    b.onclick = () => {
      state.mediaShop = b.dataset.shop;
      for (const x of document.querySelectorAll('#shop-filter button')) x.classList.toggle('active', x === b);
      refreshList();
    };
  }
  $('btn-proj-refresh').onclick = async () => {
    const r = await api.projPrune();
    refreshList();
    if (r && (r.groups.length || r.dirs || r.files)) {
      const parts = [];
      if (r.groups.length) parts.push(`移除空项目组:${r.groups.join('、')}`);
      if (r.dirs) parts.push(`${r.dirs} 个失效目录`);
      if (r.files) parts.push(`${r.files} 个失效文件`);
      alert('刷新完成,已清理 ' + parts.join(';'));
    }
  };

  api.on('sess:attention', ({ sid }) => {
    if (sid !== state.activeSid) { attention.add(sid); refreshList(); }
  });
  // refreshList 防抖(v0.10.2):session-status 在多会话并发时高频触发(每回合
  // 开始/结束/标题/结果),每次全量重绘侧栏 + 2 次 IPC;合并到 200ms 尾沿一次。
  // 用户主动操作(点击/新建/重命名)仍走即时 refreshList。
  let refreshTimer = null;
  const refreshListSoon = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshList(); }, 200);
  };
  on('session-status', refreshListSoon);
  on('project-files-changed', () => refreshList());
  api.on('cron:fired', () => refreshList());
}
