// Tool return is not background task completion. SDK lifecycle events take precedence.
export function updateTaskState(tasks, update) {
  let key = `${update.sid}:${update.parentId || update.taskId}`;
  let previous = tasks.get(key);
  if (!previous && update.taskId) {
    const match = [...tasks.entries()].find(([, t]) => t.sid === update.sid && t.taskId === update.taskId);
    if (match) { previous = match[1]; tasks.delete(match[0]); }
  }
  previous ||= {};
  const parentId = update.parentId || previous.parentId;
  key = `${update.sid}:${parentId || update.taskId}`;
  const terminal = ['completed', 'failed', 'stopped'].includes(previous.status);
  const authoritative = update.source === 'sdk';
  const newRun = update.parentId && previous.parentId && update.parentId !== previous.parentId;
  const acceptStatus = (!terminal || newRun || (authoritative && !previous.authoritative))
    && (authoritative || !previous.authoritative || update.status === 'failed');
  const next = { ...previous, sid: update.sid, parentId,
    taskId: update.taskId || previous.taskId,
    desc: update.description || update.desc || previous.desc,
    model: update.model || previous.model,
    status: acceptStatus ? update.status || previous.status || 'running' : previous.status,
    authoritative: previous.authoritative || authoritative };
  tasks.set(key, next);
  return next;
}
