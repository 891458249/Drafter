// Chat rendering: per-session logs, streaming, tool cards, permission cards,
// plan approval, subagent grouping, view modes, history replay.
import { api, state, $, escapeHtml, truncate, renderMarkdown, fmtCost, fmtTokens, emit } from './state.js';

const messagesEl = () => $('messages');

// --- session UI registry ---------------------------------------------------
export function ensureSession(sid, meta) {
  let s = state.sessions.get(sid);
  if (!s) {
    const logEl = document.createElement('div');
    logEl.className = 'session-log hidden';
    logEl.dataset.sid = sid;
    messagesEl().appendChild(logEl);
    s = {
      meta: meta || { id: sid },
      ui: {
        logEl,
        currentAssistant: null,   // { el, bubble, buf, thinkBuf }
        toolCards: new Map(),     // tool_use_id -> { el, body, name, input }
        taskGroups: new Map(),    // parent_tool_use_id -> container el
        replayed: false,
        busy: false, running: false,
        cumCost: 0, lastUsage: null,
      },
    };
    state.sessions.set(sid, s);
  } else if (meta) {
    s.meta = { ...s.meta, ...meta };
  }
  return s;
}

export function setActiveSession(sid) {
  state.activeSid = sid;
  api.sessSetActive(sid);
  for (const [id, s] of state.sessions) {
    s.ui.logEl.classList.toggle('hidden', id !== sid);
  }
  const s = state.sessions.get(sid);
  if (s && !s.ui.replayed) replayHistory(sid);
  updateTopbarForSession(sid);
  scrollBottom(sid);
  emit('session-activated', sid);
}

export function updateTopbarForSession(sid) {
  const s = state.sessions.get(sid);
  if (!s) return;
  const m = s.meta;
  if (m.permissionMode) $('perm-mode').value = m.permissionMode;
  $('model-sel').value = m.model || '';
  emit('session-effort', m.effort || null);
  const composerModel = $('model-sel-composer');
  if (composerModel) composerModel.value = m.model || '';
  $('usage-chip').textContent = fmtCost(s.ui.cumCost) +
    (s.ui.lastUsage ? ` · ↑${fmtTokens(ctxTokens(s.ui.lastUsage))}` : '');
  setBusyUI(s.ui.busy);
}

function ctxTokens(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

export function setBusyUI(busy) {
  $('btn-send').classList.toggle('hidden', !!busy);
  $('btn-stop').classList.toggle('hidden', !busy);
  $('busy-hint').classList.toggle('hidden', !busy);
  updateTurnStatus();
}

// --- 运行状态行(✳ 1m 5s · 217 tokens · 1 个运行中任务) ---------------------
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function updateTurnStatus() {
  const box = $('turn-status');
  if (!box) return;
  const s = state.sessions.get(state.activeSid);
  const busy = !!(s && s.ui.busy);
  box.classList.toggle('hidden', !busy);
  if (!busy) return;
  let running = 0;
  for (const [, x] of state.sessions) if (x.ui.busy) running++;
  const toks = (s.ui.turnTokens || 0) + (s.ui.curMsgTokens || 0);
  $('turn-status-text').textContent =
    `${fmtDur(Date.now() - (s.ui.turnStart || Date.now()))} · ${fmtTokens(toks)} tokens · ${running} 个运行中任务`;
}

setInterval(updateTurnStatus, 1000);

async function replayHistory(sid) {
  const s = state.sessions.get(sid);
  if (!s || s.ui.replayed) return;
  s.ui.replayed = true;
  const events = await api.sessHistory(sid);
  for (const ev of events) renderEvent(sid, ev, { replay: true });
  finalizeAssistant(s);
  scrollBottom(sid);
}

function scrollBottom(sid) {
  if (sid !== state.activeSid) return;
  const el = messagesEl();
  el.scrollTop = el.scrollHeight;
}

// --- container helpers ------------------------------------------------------
// Returns the element new content should be appended to: either the session log
// or a subagent task group (keyed by parent_tool_use_id).
function containerFor(s, parentId) {
  if (!parentId) return s.ui.logEl;
  let group = s.ui.taskGroups.get(parentId);
  if (!group) {
    group = document.createElement('div');
    group.className = 'task-group collapsed';
    const head = document.createElement('div');
    head.className = 'task-group-head';
    const card = s.ui.toolCards.get(parentId);
    const desc = card && card.input && (card.input.description || card.input.prompt) || '';
    head.textContent = '⚙ 子任务 ' + (desc ? '· ' + String(desc).slice(0, 60) : parentId.slice(0, 8));
    head.onclick = () => group.classList.toggle('collapsed');
    group.appendChild(head);
    // place the group right after the Task tool card if we have it
    if (card && card.el.parentElement) card.el.insertAdjacentElement('afterend', group);
    else s.ui.logEl.appendChild(group);
    s.ui.taskGroups.set(parentId, group);
    emit('task-started', { sid: s.meta.id, parentId, desc });
  }
  return group;
}

function metaLine(s, text, cls = '') {
  const el = document.createElement('div');
  el.className = 'meta-line ' + cls;
  el.textContent = text;
  s.ui.logEl.appendChild(el);
  scrollBottom(s.meta.id);
}

// --- assistant bubble --------------------------------------------------------
function ensureAssistant(s, parentId) {
  if (s.ui.currentAssistant && s.ui.currentAssistant.parentId === (parentId || null)) {
    return s.ui.currentAssistant;
  }
  finalizeAssistant(s);
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.innerHTML = `<div class="msg-role">Claude</div><div class="bubble"></div>`;
  containerFor(s, parentId).appendChild(msg);
  s.ui.currentAssistant = {
    el: msg, bubble: msg.querySelector('.bubble'),
    buf: '', textEl: null, parentId: parentId || null,
    activity: null,
  };
  return s.ui.currentAssistant;
}

function finalizeAssistant(s) {
  if (!s.ui.currentAssistant) return;
  const live = s.ui.currentAssistant.bubble.querySelector('.thinking.live');
  if (live) live.classList.remove('live');
  s.ui.currentAssistant = null;
}

function appendText(s, parentId, delta) {
  const a = ensureAssistant(s, parentId);
  a.buf += delta;
  if (!a.textEl) {
    a.textEl = document.createElement('div');
    a.bubble.appendChild(a.textEl);
  }
  a.textEl.innerHTML = renderMarkdown(a.buf);
  linkifyPaths(a.textEl);
  scrollBottom(s.meta.id);
}

function appendThinking(s, parentId, delta) {
  const a = ensureAssistant(s, parentId);
  let think = a.bubble.querySelector('.thinking.live');
  if (!think) {
    think = document.createElement('div');
    think.className = 'thinking live';
    think.onclick = () => think.classList.toggle('expanded');
    a.bubble.appendChild(think);
  }
  think.textContent += delta;
  scrollBottom(s.meta.id);
}

// Make file paths in assistant text clickable -> open in editor panel.
function linkifyPaths(el) {
  for (const code of el.querySelectorAll('code')) {
    const t = code.textContent || '';
    if (code.childElementCount === 0 && /^[\w./\\-]+\.[\w]{1,8}(:\d+)?$/.test(t.trim()) && t.length < 200) {
      code.classList.add('file-link');
      code.onclick = () => emit('open-file', t.trim().replace(/:\d+$/, ''));
    }
  }
}

// --- user echo ---------------------------------------------------------------
export function addUserMessage(sid, content) {
  const s = ensureSession(sid);
  const msg = document.createElement('div');
  msg.className = 'msg user';
  msg.innerHTML = `<div class="msg-role">你</div><div class="bubble"></div>`;
  const bubble = msg.querySelector('.bubble');
  if (typeof content === 'string') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    for (const b of content) {
      if (b.type === 'text') {
        const d = document.createElement('div');
        d.innerHTML = renderMarkdown(b.text);
        bubble.appendChild(d);
      } else if (b.type === 'image' || b.type === 'image_ref') {
        // live 消息带 source,历史回放带 mediaType/data
        const mt = (b.source && b.source.media_type) || b.mediaType;
        const data = (b.source && b.source.data) || b.data;
        if (data) {
          const img = document.createElement('img');
          img.className = 'msg-img';
          img.src = `data:${mt || 'image/png'};base64,${data}`;
          img.title = '右键复制图片';
          img.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            try {
              const c = document.createElement('canvas');
              c.width = img.naturalWidth; c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0);
              const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
              img.classList.add('copied');
              setTimeout(() => img.classList.remove('copied'), 600);
            } catch (err) { console.error('复制图片失败:', err); }
          });
          bubble.appendChild(img);
        } else {
          const n = document.createElement('div');
          n.className = 'user-img-note';
          n.textContent = '🖼 [图片附件]';
          bubble.appendChild(n);
        }
      }
    }
  }
  finalizeAssistant(s);
  s.ui.logEl.appendChild(msg);
  scrollBottom(sid);
}

// --- tool activity groups (折叠的进程摘要行,如 "编辑了 1 个文件,运行了 2 条命令 ›") ---
const TOOL_CATS = {
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', PowerShell: 'run',
  Read: 'read',
  Glob: 'search', Grep: 'search',
  WebFetch: 'web', WebSearch: 'web',
};
const CAT_LABELS = {
  edit: (n) => `编辑了 ${n} 个文件`,
  run: (n) => `运行了 ${n} 条命令`,
  read: (n) => `读取了 ${n} 个文件`,
  search: (n) => `搜索了 ${n} 次`,
  web: (n) => `联网查询 ${n} 次`,
  other: (n) => `${n} 项操作`,
};

function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }

function toolRowLabel(name, input) {
  const i = input || {};
  if (name === 'Edit' || name === 'MultiEdit') return `编辑 ${baseName(i.file_path)}`;
  if (name === 'Write') return `写入 ${baseName(i.file_path)}`;
  if (name === 'NotebookEdit') return `编辑 ${baseName(i.notebook_path)}`;
  if (name === 'Bash' || name === 'PowerShell') return `运行 ${String(i.description || i.command || '').slice(0, 70)}`;
  if (name === 'Read') return `读取 ${baseName(i.file_path)}`;
  if (name === 'Glob' || name === 'Grep') return `搜索 ${String(i.pattern || '').slice(0, 60)}`;
  if (name === 'WebFetch') return `抓取 ${String(i.url || '').slice(0, 60)}`;
  if (name === 'WebSearch') return `搜索 ${String(i.query || '').slice(0, 60)}`;
  if (name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate') return '更新任务清单';
  const tgt = i.file_path || i.command || i.pattern || i.description || i.url || i.path || '';
  return `${name} ${String(tgt).slice(0, 60)}`;
}

// Edit/Write 的 +n -m 统计
function diffStatHtml(name, input) {
  const i = input || {};
  let add = 0, del = 0;
  if (name === 'Edit' || name === 'MultiEdit') {
    if (i.new_string) add = String(i.new_string).split('\n').length;
    if (i.old_string) del = String(i.old_string).split('\n').length;
  } else if (name === 'Write' && i.content) {
    add = String(i.content).split('\n').length;
  } else return '';
  if (!add && !del) return '';
  return `${add ? `<span class="dadd">+${add}</span>` : ''}${del ? ` <span class="ddel">-${del}</span>` : ''}`;
}

function ensureActivity(s, parentId) {
  const a = ensureAssistant(s, parentId);
  if (a.activity) return a.activity;
  const el = document.createElement('div');
  el.className = 'activity collapsed';
  el.innerHTML = `
    <div class="activity-head">
      <span class="activity-summary">运行中…</span>
      <span class="activity-chev">›</span>
    </div>
    <div class="activity-list"></div>`;
  el.querySelector('.activity-head').onclick = () => el.classList.toggle('collapsed');
  a.bubble.appendChild(el);
  a.activity = { el, list: el.querySelector('.activity-list'), summary: el.querySelector('.activity-summary'), counts: {}, pending: 0 };
  return a.activity;
}

function updateActivitySummary(act) {
  const parts = [];
  for (const [cat, n] of Object.entries(act.counts)) {
    if (n > 0) parts.push((CAT_LABELS[cat] || CAT_LABELS.other)(n));
  }
  act.summary.textContent = (parts.join(',') || '进程') + (act.pending > 0 ? ' …' : '');
  act.el.classList.toggle('working', act.pending > 0);
}

function addToolCard(s, parentId, id, name, input) {
  if (name === 'Task') {
    // 子任务保持原有的分组框
    const a = ensureAssistant(s, parentId);
    const card = document.createElement('div');
    card.className = 'tool';
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-icon">⚙</span>
        <span class="tool-name">子任务</span>
        <span class="tool-target">${escapeHtml(String((input && (input.description || input.prompt)) || '').slice(0, 120))}</span>
        <span class="tool-status act-status">运行中…</span>
      </div>
      <div class="tool-body collapsed"></div>`;
    const body = card.querySelector('.tool-body');
    if (input) body.textContent = JSON.stringify(input, null, 2);
    card.querySelector('.tool-head').onclick = () => body.classList.toggle('collapsed');
    a.bubble.appendChild(card);
    s.ui.toolCards.set(id, { el: card, body, name, input, activity: null });
    emit('task-started', { sid: s.meta.id, parentId: id, desc: input && input.description });
    scrollBottom(s.meta.id);
    return;
  }

  const act = ensureActivity(s, parentId);
  const cat = TOOL_CATS[name] || 'other';
  act.counts[cat] = (act.counts[cat] || 0) + 1;
  act.pending++;

  const row = document.createElement('div');
  row.className = 'act-row';
  row.innerHTML = `
    <div class="act-row-head">
      <span class="act-label">${escapeHtml(toolRowLabel(name, input))}</span>
      <span class="act-diff">${diffStatHtml(name, input)}</span>
      <span class="act-status">…</span>
    </div>
    <div class="act-body collapsed"></div>`;
  const body = row.querySelector('.act-body');
  if (input) body.textContent = JSON.stringify(input, null, 2);
  row.querySelector('.act-row-head').onclick = () => body.classList.toggle('collapsed');
  act.list.appendChild(row);
  s.ui.toolCards.set(id, { el: row, body, name, input, activity: act });
  updateActivitySummary(act);
  scrollBottom(s.meta.id);
}

function completeToolCard(s, id, content, isError) {
  const card = s.ui.toolCards.get(id);
  if (!card) return;
  const status = card.el.querySelector('.act-status');
  if (status) {
    status.textContent = isError ? '✕' : '✓';
    status.className = (card.name === 'Task' ? 'tool-status act-status ' : 'act-status ') + (isError ? 'err' : 'ok');
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const inputText = card.input ? JSON.stringify(card.input, null, 2) : '';
  card.body.textContent = (inputText ? inputText + '\n── 结果 ──\n' : '') + truncate(text || '', 4000);
  if (card.activity) {
    card.activity.pending = Math.max(0, card.activity.pending - 1);
    updateActivitySummary(card.activity);
  }
  if (card.name === 'Task') {
    emit('task-done', { sid: s.meta.id, parentId: id, isError });
  }
  if (card.name === 'Edit' || card.name === 'Write') emit('files-changed', s.meta.cwd);
}

// --- permission / plan cards -----------------------------------------------
function addPermissionCard(s, ev, replay) {
  finalizeAssistant(s);
  const card = document.createElement('div');
  const isPlan = ev.isPlan;
  card.className = 'perm-card' + (isPlan ? ' plan-card' : '');
  card.dataset.reqId = ev.reqId;
  const input = ev.input || {};

  let bodyHtml;
  if (isPlan) {
    bodyHtml = `<div class="plan-md">${renderMarkdown(input.plan || '')}</div>`;
  } else if ((ev.toolName === 'Edit' || ev.toolName === 'Write' || ev.toolName === 'MultiEdit') && (input.old_string || input.new_string || input.content)) {
    bodyHtml = `<div class="perm-diff">${renderEditDiff(input)}</div>`;
  } else {
    bodyHtml = `<div class="perm-body">${escapeHtml(JSON.stringify(input, null, 2).slice(0, 4000))}</div>`;
  }

  const title = isPlan ? '计划待审批' : `请求使用 <span class="perm-tool">${escapeHtml(ev.toolName)}</span>`;
  card.innerHTML = `
    <div class="perm-head">${isPlan ? '<span class="perm-tool">📋</span>' : '🔐'} ${title}
      ${input.file_path ? `<span class="tool-target">${escapeHtml(input.file_path)}</span>` : ''}</div>
    ${bodyHtml}
    <div class="perm-actions">
      ${isPlan
        ? `<button class="btn btn-sm btn-primary" data-d="allow">批准并开始</button>
           <button class="btn btn-sm" data-d="deny">继续完善计划</button>`
        : `<button class="btn btn-sm btn-primary" data-d="allow">允许一次</button>
           <button class="btn btn-sm" data-d="always">总是允许(写入项目规则)</button>
           <button class="btn btn-sm" data-d="deny">拒绝</button>`}
    </div>`;

  if (!replay) {
    for (const btn of card.querySelectorAll('.perm-actions button')) {
      btn.onclick = async () => {
        const decision = btn.dataset.d;
        let denyMessage;
        if (decision === 'deny' && !isPlan) denyMessage = '用户拒绝了此操作';
        if (decision === 'deny' && isPlan) denyMessage = '用户希望继续完善计划,请根据后续反馈调整';
        await api.sessPermission({ sid: s.meta.id, reqId: ev.reqId, decision, denyMessage });
        resolvePermCard(s, ev.reqId, decision);
        if (isPlan && decision === 'allow') {
          await api.sessSetMode(s.meta.id, 'acceptEdits');
          s.meta.permissionMode = 'acceptEdits';
          $('perm-mode').value = 'acceptEdits';
        }
      };
    }
  } else {
    card.querySelector('.perm-actions').innerHTML = '<div class="perm-done">（历史请求）</div>';
  }
  s.ui.logEl.appendChild(card);
  scrollBottom(s.meta.id);
}

function resolvePermCard(s, reqId, decision) {
  const card = s.ui.logEl.querySelector(`.perm-card[data-req-id="${reqId}"]`);
  if (!card) return;
  const actions = card.querySelector('.perm-actions');
  if (actions) {
    const label = { allow: '✔ 已允许', always: '✔ 已允许(总是,已写入项目规则)', deny: '✖ 已拒绝', aborted: '已中断' }[decision] || decision;
    actions.innerHTML = `<div class="perm-done">${label}</div>`;
  }
}

// Minimal inline diff for Edit/Write permission requests.
function renderEditDiff(input) {
  const rows = [];
  const push = (cls, sign, text) => {
    for (const line of String(text).split('\n')) {
      rows.push(`<div class="diff-line ${cls}"><span class="ln"></span><span class="code">${escapeHtml(sign + line)}</span></div>`);
    }
  };
  if (input.old_string || input.new_string) {
    if (input.old_string) push('del', '- ', input.old_string);
    if (input.new_string) push('add', '+ ', input.new_string);
  } else if (input.content) {
    push('add', '+ ', String(input.content).slice(0, 8000));
  }
  return rows.join('');
}

// --- main event entry ---------------------------------------------------------
export function handleSessEvent({ sid, ev }) {
  if (!sid) { // global error
    if (ev.type === 'ui_error') console.error(ev.message);
    return;
  }
  const s = ensureSession(sid);
  // live events only render if history already replayed (avoid duplication)
  if (!s.ui.replayed) s.ui.replayed = true;
  renderEvent(sid, ev, { replay: false });
}

export function renderEvent(sid, ev, { replay }) {
  const s = ensureSession(sid);
  const t = ev.type;

  if (t === 'ui_status') {
    const wasBusy = s.ui.busy;
    s.ui.busy = !!ev.busy;
    s.ui.running = !!ev.running;
    if (s.ui.busy && !wasBusy) {
      s.ui.turnStart = Date.now();
      s.ui.turnTokens = 0;
      s.ui.curMsgTokens = 0;
    }
    if (sid === state.activeSid) setBusyUI(s.ui.busy);
    emit('session-status', { sid, busy: s.ui.busy, running: s.ui.running });
    return;
  }
  if (t === 'ui_init') {
    if (ev.model) s.ui.initModel = ev.model;
    if (ev.slashCommands) state.commandsCache = null; // refresh next time
    return;
  }
  if (t === 'ui_user_input') { addUserMessage(sid, ev.content); return; }
  if (t === 'ui_error') { metaLine(s, '错误:' + ev.message, 'error-line'); return; }
  if (t === 'ui_stderr') { console.debug('[stderr]', ev.text); return; }
  if (t === 'ui_compact') { metaLine(s, '── 上下文已压缩 ──'); return; }
  if (t === 'ui_permission') { addPermissionCard(s, ev, replay); return; }
  if (t === 'ui_permission_done') { resolvePermCard(s, ev.reqId, ev.decision); return; }

  if (t === 'stream_event' && ev.event) {
    handleStreamEvent(s, ev.parent_tool_use_id, ev.event);
    return;
  }

  if (t === 'assistant' && ev.message) {
    handleAssistantMessage(s, ev.parent_tool_use_id, ev.message, replay);
    return;
  }

  if (t === 'user' && ev.message) {
    const content = ev.message.content || [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          let text = '';
          if (typeof block.content === 'string') text = block.content;
          else if (Array.isArray(block.content)) {
            text = block.content.map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
          }
          completeToolCard(s, block.tool_use_id, text, block.is_error);
        }
      }
    }
    return;
  }

  if (t === 'result') {
    s.ui.busy = false;
    finalizeAssistant(s);
    if (ev.cum_cost_usd != null) s.ui.cumCost = ev.cum_cost_usd;
    else if (ev.total_cost_usd != null) s.ui.cumCost += ev.total_cost_usd;
    if (ev.usage) s.ui.lastUsage = ev.usage;
    const parts = [];
    if (ev.duration_ms != null) parts.push((ev.duration_ms / 1000).toFixed(1) + 's');
    if (ev.num_turns != null) parts.push(ev.num_turns + ' 轮');
    if (ev.total_cost_usd != null) parts.push('$' + ev.total_cost_usd.toFixed(4));
    if (ev.usage) parts.push('↑' + fmtTokens(ctxTokens(ev.usage)) + ' ↓' + fmtTokens(ev.usage.output_tokens));
    if (ev.is_error) parts.push('(出错:' + (ev.subtype || '') + ')');
    if (parts.length) {
      const el = document.createElement('div');
      el.className = 'result-line' + (ev.is_error ? ' error-line' : '');
      el.textContent = parts.join(' · ');
      s.ui.logEl.appendChild(el);
    }
    if (sid === state.activeSid) { setBusyUI(false); updateTopbarForSession(sid); }
    emit('session-status', { sid, busy: false, running: s.ui.running });
    emit('turn-done', { sid });
    scrollBottom(sid);
    return;
  }
}

function handleStreamEvent(s, parentId, ev) {
  const type = ev.type;
  if (type === 'content_block_start') {
    const block = ev.content_block;
    if (block && block.type === 'tool_use') addToolCard(s, parentId, block.id, block.name, block.input || null);
    if (block && block.type === 'text') {
      const a = ensureAssistant(s, parentId);
      a.textEl = null; a.buf = '';
      a.activity = null; // 文本出现后,后续工具进入新的进程组
    }
    return;
  }
  if (type === 'content_block_delta') {
    const d = ev.delta;
    if (!d) return;
    if (d.type === 'text_delta') appendText(s, parentId, d.text);
    else if (d.type === 'thinking_delta') appendThinking(s, parentId, d.thinking);
    return;
  }
  if (type === 'message_delta') {
    if (ev.usage && ev.usage.output_tokens != null) {
      s.ui.curMsgTokens = ev.usage.output_tokens;
      if (s.meta.id === state.activeSid) updateTurnStatus();
    }
    return;
  }
  if (type === 'message_stop') {
    s.ui.turnTokens = (s.ui.turnTokens || 0) + (s.ui.curMsgTokens || 0);
    s.ui.curMsgTokens = 0;
    const a = s.ui.currentAssistant;
    if (a) {
      const live = a.bubble.querySelector('.thinking.live');
      if (live) live.classList.remove('live');
    }
  }
}

function handleAssistantMessage(s, parentId, message, replay) {
  const content = message.content || [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      const existing = s.ui.toolCards.get(block.id);
      if (!existing) addToolCard(s, parentId, block.id, block.name, block.input || null);
      else if (block.input) {
        existing.input = block.input;
        existing.body.textContent = JSON.stringify(block.input, null, 2);
        const label = existing.el.querySelector('.act-label');
        if (label) label.textContent = toolRowLabel(existing.name, block.input);
        const diff = existing.el.querySelector('.act-diff');
        if (diff) diff.innerHTML = diffStatHtml(existing.name, block.input);
        const tgt = existing.el.querySelector('.tool-target');
        if (tgt) tgt.textContent = String((block.input.description || block.input.prompt || '')).slice(0, 120);
      }
    } else if (block.type === 'text') {
      const a = s.ui.currentAssistant;
      // if streaming already rendered this text, skip; otherwise render whole
      if (replay || !a || !a.buf) appendText(s, parentId, block.text || '');
      // reset buffer so following blocks don't duplicate
      if (s.ui.currentAssistant) {
        s.ui.currentAssistant.buf = '';
        s.ui.currentAssistant.textEl = null;
        s.ui.currentAssistant.activity = null; // 文本后新的进程组
      }
    } else if (block.type === 'thinking' && replay) {
      if (block.thinking) appendThinking(s, parentId, block.thinking);
      const a = s.ui.currentAssistant;
      if (a) { const live = a.bubble.querySelector('.thinking.live'); if (live) live.classList.remove('live'); }
    }
  }
}

// --- view mode -----------------------------------------------------------------
export function setViewMode(mode) {
  state.viewMode = mode;
  const el = messagesEl();
  el.classList.remove('mode-normal', 'mode-verbose', 'mode-summary');
  el.classList.add('mode-' + mode);
  if (mode === 'verbose') {
    for (const body of el.querySelectorAll('.tool-body')) body.classList.remove('collapsed');
  } else {
    for (const body of el.querySelectorAll('.tool-body')) body.classList.add('collapsed');
  }
}
