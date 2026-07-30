// Tasks panel: subagents (Task tool) and their status, grouped by session.
import { state, $, escapeHtml, on } from './state.js';

const tasks = new Map(); // parentId -> { sid, desc, status, el }

function render() {
  const box = $('tasks-list');
  if (!tasks.size) {
    box.innerHTML = '<div class="empty-hint">子代理 / 后台任务将显示在这里</div>';
    return;
  }
  box.innerHTML = '';
  for (const [id, t] of [...tasks.entries()].reverse()) {
    const el = document.createElement('div');
    el.className = 'task-item';
    const s = state.sessions.get(t.sid);
    const sessName = s && s.meta.title ? s.meta.title : t.sid.slice(0, 8);
    const statusCls = t.status === 'running' ? 'task-status-running' : t.status === 'error' ? 'task-status-err' : 'task-status-done';
    const statusTxt = t.status === 'running' ? '◐ 运行中' : t.status === 'error' ? '✖ 出错' : '✔ 完成';
    el.innerHTML = `
      <div class="task-name"><span class="${statusCls}">${statusTxt}</span> ${escapeHtml(t.desc || '子任务')}</div>
      <div class="task-desc">会话:${escapeHtml(sessName)} · ${id.slice(0, 10)}</div>`;
    box.appendChild(el);
  }
}

export function init() {
  on('task-started', ({ sid, parentId, desc }) => {
    if (!tasks.has(parentId)) tasks.set(parentId, { sid, desc, status: 'running' });
    else if (desc) tasks.get(parentId).desc = desc;
    render();
  });
  on('task-done', ({ parentId, isError }) => {
    const t = tasks.get(parentId);
    if (t) { t.status = isError ? 'error' : 'done'; render(); }
  });
}
