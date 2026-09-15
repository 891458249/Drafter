// 拆分子任务(v0.15.9 起为开关模式,v0.15.10 移到发送按钮旁):激活「⧉」开关后,
// 用户发出的下一条消息不会直接发送,而是由当前会话的 AI 把这条需求拆成若干子任务
// → 弹出可编辑的确认卡片 → 确认后为每个子任务新建一个并行 code 会话(继承当前会
// 话的项目/模型/Key/权限/Gem)并各自发送子任务,并行执行。再次点击开关即关闭。
import { api, state, $, escapeHtml } from './state.js';
import { ensureSession } from './chat.js';
import { refreshList } from './sessions-ui.js';

let open = false;
let armed = false; // 开关是否激活(激活时发送被拦截去拆分)
let splitting = false; // 正在拆分中(防止连发)

export function isArmed() { return armed; }

function syncToggle() {
  const btn = $('btn-split-subtasks');
  if (!btn) return;
  btn.classList.toggle('split-on', armed);
  btn.title = armed
    ? '拆分子任务已激活:发送的这条消息会被 AI 拆成多个子任务,确认后建多个会话并行执行;点击关闭'
    : '拆分子任务:激活后,发送的这条消息会被 AI 拆成多个子任务,确认后建多个会话并行执行;再次点击关闭';
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

async function openSplit(requirement) {
  if (open || splitting) return;
  const req = (requirement || '').trim();
  if (!req) return;
  open = true; splitting = true;
  const btn = $('btn-split-subtasks');
  const old = btn.innerHTML;
  btn.disabled = true;
  try {
    const r = await api.sessSplitSubtasks({ sid: state.activeSid, requirement: req });
    if (!r || !r.ok) { setStatus('拆分失败:' + ((r && r.error) || '未知错误'), 'err'); $('split-modal').classList.remove('hidden'); renderRows([]); return; }
    renderRows(r.tasks);
    setStatus('');
    $('split-modal').classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.innerHTML = old;
    splitting = false;
    open = false;
  }
}

// 供发送流程调用:激活时拦截这条消息去拆分,返回 true 表示已接管(不再走正常发送)
export async function maybeSplitOnSend(text) {
  if (!armed) return false;
  if (!state.activeSid) return false;
  await openSplit(text);
  return true;
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
  $('btn-split-subtasks').onclick = () => { armed = !armed; syncToggle(); };
  $('split-cancel').onclick = closeModal;
  $('split-confirm').onclick = confirmSplit;
  $('split-add').onclick = () => {
    $('split-list').appendChild(rowEl({ title: '', detail: '' }, $('split-list').children.length));
    renumber();
  };
  syncToggle();
}
