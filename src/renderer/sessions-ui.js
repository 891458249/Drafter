// Sidebar: project groups with sessions nested under each group.
// Group header: editable name, per-group "+" (new session), file manager
// (load files/folders with live read-only/editable tags).
import { api, state, $, escapeHtml, emit, on, parseModelValue } from './state.js';
import { ensureSession, setActiveSession } from './chat.js';

const attention = new Set();
const collapsedProjects = new Set();
const openFilePanels = new Set();

// --- 项目右键菜单(v0.9.1):打开对应文件夹 -------------------------------------
let ctxMenuEl = null;
function closeCtxMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
function showProjMenu(x, y, p) {
  closeCtxMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = `<button data-act="open">打开文件夹</button>`;
  el.querySelector('[data-act="open"]').onclick = () => { closeCtxMenu(); api.projOpenFolder(p.id); };
  document.body.appendChild(el);
  // 贴边时向内收,避免菜单超出窗口
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  ctxMenuEl = el;
}

export async function refreshList() {
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

  // --- 非 code 板块(chat/新媒体):对应 kind 的会话平铺列表(无项目组、无独立会话) ---
  if (state.section !== 'code') {
    const chats = (byProject.get('_none') || [])
      .filter((m) => m.kind === state.section)
      .filter((m) => showArchived ? true : !m.archived)
      .filter((m) => !filter || (m.title || '').toLowerCase().includes(filter))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
      ${m.model ? `<span class="badge-model">${escapeHtml(shortModel(m.model))}</span>` : ''}
    </div>
    <div class="session-sub">${escapeHtml(new Date(m.updatedAt || m.createdAt || Date.now()).toLocaleString())}${m.archived ? ' · 已归档' : ''}</div>
    <div class="session-ops">
      <button data-op="rename">重命名</button>
      <button data-op="side">Side chat</button>
      <button data-op="archive">${m.archived ? '恢复' : '归档'}</button>
      <button data-op="remove">删除</button>
    </div>`;
  li.onclick = (e) => {
    if (e.target.dataset && e.target.dataset.op) return;
    attention.delete(m.id);
    setActiveSession(m.id);
    refreshList();
  };
  li.querySelector('[data-op="rename"]').onclick = async () => {
    const title = prompt('会话名称:', m.title || '');
    if (title != null) { await api.sessRename(m.id, title.trim()); refreshList(); }
  };
  li.querySelector('[data-op="side"]').onclick = async () => {
    const meta = await api.sessCreate({
      cwd: m.cwd, model: m.model, keyId: m.keyId || null, permissionMode: m.permissionMode,
      effort: m.effort || null, // side chat 继承父会话的推理深度设置
      title: (m.title || '会话') + ' · side', parentId: m.id,
      projectId: m.projectId, forkFrom: m.sdkSessionId || null,
      standalone: m.standalone || undefined, kind: m.kind || undefined, // 独立/非 code 板块会话的 side 不进项目组
    });
    ensureSession(meta.id, meta);
    setActiveSession(meta.id);
    refreshList();
  };
  li.querySelector('[data-op="archive"]').onclick = async () => {
    await api.sessArchive(m.id, !m.archived);
    refreshList();
  };
  li.querySelector('[data-op="remove"]').onclick = async () => {
    if (!confirm('删除会话及其历史记录?')) return;
    await api.sessRemove(m.id);
    const s = state.sessions.get(m.id);
    if (s) { s.ui.logEl.remove(); state.sessions.delete(m.id); }
    refreshList();
  };
  return li;
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
  const sel = parseModelValue($('model-sel').value);
  const board = state.section;
  // 新媒体板块(image/video/audio/model)必须选中模型;无可用模型时拦截并提示
  if (board !== 'code' && board !== 'chat' && !sel.model) {
    alert('该板块暂无可用模型,请先在「配置 API Key」中刷新 Kuro 网关的模型列表。');
    return null;
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
  document.addEventListener('click', closeCtxMenu); // 点别处关闭项目右键菜单
  on('session-status', () => refreshList());
  on('project-files-changed', () => refreshList());
  api.on('cron:fired', () => refreshList());
}
