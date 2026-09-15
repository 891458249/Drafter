// 拆分子任务(v0.15.9):点「⧉ 拆任务」→ 当前会话的 AI 把输入框里的需求拆成
// 若干子任务 → 弹出可编辑的确认卡片 → 确认后为每个子任务新建一个并行 code
// 会话(继承当前会话的项目/模型/Key/权限/Gem)并各自发送子任务,并行执行。
import { api, state, $, escapeHtml } from './state.js';
import { ensureSession } from './chat.js';
import { refreshList } from './sessions-ui.js';

let open = false;

// 读取当前需求:优先输入框文本;为空则取当前会话最近一条用户消息作为需求
function currentRequirement() {
  const t = ($('input').value || '').trim();
  if (t) return t;
  const s = state.sessions.get(state.activeSid);
  const log = s && s.ui.logEl;
  if (!log) return '';
  const users = [...log.querySelectorAll('.msg.user')];
  const last = users[users.length - 1];
  const bubble = last && last.querySelector('.bubble');
  return (bubble ? bubble.innerText : '').trim();
}

function renderRows(tasks) {
  const list = $('split-list');
  list.innerHTML = '';
  tasks.forEach((t, i) => list.appendChild(rowEl(t, i)));
}

function rowEl(t, i) {
  const row = document.createElement('div');
  row.className = 'split-row';
  row.innerHTML =
    `<div class="split-row-head"><span class="idx">${i + 1}</span>` +
    `<input class="split-title" maxlength="60" value="${escapeHtml(t.title)}" placeholder="子任务标题" />` +
    `<button class="btn btn-sm split-del" title="删除该子任务">删</button></div>` +
    `<textarea class="split-detail" placeholder="子任务说明(自包含,执行助手看不到原始需求)">${escapeHtml(t.detail || '')}</textarea>`;
  row.querySelector('.split-del').onclick = () => {
    row.remove();
    renumber();
  };
  return row;
}

function renumber() {
  [...$('split-list').querySelectorAll('.split-row')].forEach((r, i) => {
    r.querySelector('.idx').textContent = String(i + 1);
  });
}

function collectTasks() {
  const tasks = [];
  for (const r of $('split-list').querySelectorAll('.split-row')) {
    const title = r.querySelector('.split-title').value.trim();
    const detail = r.querySelector('.split-detail').value.trim();
    if (!title && !detail) continue;
    tasks.push({ title: title || detail.slice(0, 60), detail: detail || title });
  }
  return tasks;
}

function setStatus(msg, cls) {
  const st = $('split-status');
  st.className = 'modal-status' + (cls ? ' ' + cls : '');
  st.textContent = msg || '';
}

function closeModal() { $('split-modal').classList.add('hidden'); open = false; }

async function openSplit() {
  if (open) return;
  const requirement = currentRequirement();
  if (!requirement) { alert('请先在输入框填写要拆解的需求(或当前会话需已有用户消息)。'); return; }
  open = true;
  const btn = $('btn-split-subtasks');
  const old = btn.innerHTML;
  btn.disabled = true; btn.textContent = '拆分中…';
  try {
    const r = await api.sessSplitSubtasks({ sid: state.activeSid, requirement });
    if (!r || !r.ok) { alert('拆分失败:' + ((r && r.error) || '未知错误')); return; }
    renderRows(r.tasks);
    setStatus('');
    $('split-modal').classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.innerHTML = old;
    // open 保持 true,直到取消/确认;但允许重新打开(修正:拆完后应复位)
    open = false;
  }
}

async function confirmSplit() {
  const tasks = collectTasks();
  if (!tasks.length) { setStatus('至少需要一条子任务', 'err'); return; }
  const btn = $('split-confirm');
  btn.disabled = true; setStatus('正在创建子会话…');
  try {
    const r = await api.sessSpawnSubtasks({ sid: state.activeSid, tasks });
    if (!r || !r.ok) { setStatus('创建失败:' + ((r && r.error) || '未知错误'), 'err'); return; }
    // 登记新会话(事件流会陆续推送各自回合;不在此处切换激活,保持用户当前视图)
    for (const meta of r.sessions) ensureSession(meta.id, meta);
    refreshList();
    closeModal();
  } finally {
    btn.disabled = false;
  }
}

export function init() {
  $('btn-split-subtasks').onclick = openSplit;
  $('split-cancel').onclick = closeModal;
  $('split-confirm').onclick = confirmSplit;
  $('split-add').onclick = () => {
    $('split-list').appendChild(rowEl({ title: '', detail: '' }, $('split-list').children.length));
    renumber();
  };
}
