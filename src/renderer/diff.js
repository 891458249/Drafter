// Diff panel: per-file diffs with +/- indicators, inline comments sent back to
// Claude, "Review code" button, PR monitoring via gh.
import { api, state, $, escapeHtml, on } from './state.js';
import { addUserMessage } from './chat.js';

let currentFile = null;
let prTimer = null;

export async function refreshDiff() {
  if (!state.cwd) return;
  const res = await api.gitDiffStat(state.cwd);
  const box = $('diff-files');
  box.innerHTML = '';
  if (!res.isRepo) {
    box.innerHTML = '<div class="empty-hint">当前目录不是 git 仓库</div>';
    $('diff-view').innerHTML = '';
    return;
  }
  if (!res.files.length) {
    box.innerHTML = '<div class="empty-hint">没有未提交的变更</div>';
    $('diff-view').innerHTML = '';
    return;
  }
  for (const f of res.files) {
    const row = document.createElement('div');
    row.className = 'diff-file-row' + (f.path === currentFile ? ' active' : '');
    row.innerHTML = `
      <span class="fname" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}${f.untracked ? ' <em>(新)</em>' : ''}</span>
      <span class="plus">+${f.added}</span><span class="minus">−${f.removed}</span>`;
    row.onclick = () => openFileDiff(f);
    box.appendChild(row);
  }
  // auto-open first file if nothing selected
  if (!currentFile && res.files.length) openFileDiff(res.files[0]);
  else if (currentFile) {
    const f = res.files.find((x) => x.path === currentFile);
    if (f) openFileDiff(f);
  }
}

async function openFileDiff(f) {
  currentFile = f.path;
  for (const row of $('diff-files').querySelectorAll('.diff-file-row')) {
    row.classList.toggle('active', row.querySelector('.fname').title === f.path);
  }
  const res = await api.gitDiffFile({ cwd: state.cwd, file: f.path, untracked: f.untracked });
  const view = $('diff-view');
  view.innerHTML = '';
  if (!res.ok) { view.innerHTML = `<div class="empty-hint">${escapeHtml(res.error || 'diff 失败')}</div>`; return; }
  renderDiff(view, f.path, res.diff);
}

function renderDiff(view, file, diffText) {
  const lines = diffText.split('\n');
  let oldLn = 0, newLn = 0;
  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const el = document.createElement('div');
    el.className = 'diff-line';
    let ln = '', cls = '', display = line;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLn = +hunk[1]; newLn = +hunk[2];
      cls = 'hunk';
    } else if (line.startsWith('+')) {
      cls = 'add'; ln = String(newLn++);
    } else if (line.startsWith('-')) {
      cls = 'del'; ln = String(oldLn++);
    } else {
      ln = String(newLn); oldLn++; newLn++;
    }
    el.className = 'diff-line ' + cls;
    el.innerHTML = `<span class="ln" title="点击添加评论">${ln}</span><span class="code">${escapeHtml(display)}</span>`;
    if (cls !== 'hunk') {
      el.querySelector('.ln').onclick = () => openCommentEditor(el, file, ln, cls === 'del' ? 'old' : 'new', display);
    }
    view.appendChild(el);
    // render existing comment for this line
    const existing = state.diffComments.filter((c) => c.file === file && c.line === ln && c.lineText === display);
    for (const c of existing) view.appendChild(renderCommentChip(c));
  }
}

function openCommentEditor(lineEl, file, line, side, lineText) {
  const next = lineEl.nextElementSibling;
  if (next && next.classList.contains('diff-comment-editor')) { next.remove(); return; }
  const ed = document.createElement('div');
  ed.className = 'diff-comment-editor';
  ed.innerHTML = `
    <textarea placeholder="对第 ${line} 行的评论…"></textarea>
    <div class="ops">
      <button class="btn btn-sm" data-op="cancel">取消</button>
      <button class="btn btn-sm btn-primary" data-op="add">添加评论</button>
    </div>`;
  ed.querySelector('[data-op="cancel"]').onclick = () => ed.remove();
  ed.querySelector('[data-op="add"]').onclick = () => {
    const text = ed.querySelector('textarea').value.trim();
    if (!text) return;
    const c = { file, line, side, lineText, text };
    state.diffComments.push(c);
    ed.replaceWith(renderCommentChip(c));
    updateCommentButton();
  };
  lineEl.insertAdjacentElement('afterend', ed);
  ed.querySelector('textarea').focus();
}

function renderCommentChip(c) {
  const chip = document.createElement('div');
  chip.className = 'diff-comment';
  chip.innerHTML = `<span>💬 ${escapeHtml(c.text)}</span><button class="rm" title="删除">✕</button>`;
  chip.querySelector('.rm').onclick = () => {
    const i = state.diffComments.indexOf(c);
    if (i >= 0) state.diffComments.splice(i, 1);
    chip.remove();
    updateCommentButton();
  };
  return chip;
}

function updateCommentButton() {
  const n = state.diffComments.length;
  $('comment-count').textContent = String(n);
  $('btn-send-comments').classList.toggle('hidden', n === 0);
}

async function sendComments() {
  if (!state.diffComments.length || !state.activeSid) return;
  const byFile = {};
  for (const c of state.diffComments) (byFile[c.file] = byFile[c.file] || []).push(c);
  let msg = '我对当前变更有以下代码评审意见,请逐条处理:\n';
  for (const [file, cs] of Object.entries(byFile)) {
    msg += `\n**${file}**\n`;
    for (const c of cs) {
      msg += `- 第 ${c.line} 行(${c.side === 'old' ? '删除行' : '新行'}) \`${c.lineText.slice(0, 100)}\`:${c.text}\n`;
    }
  }
  addUserMessage(state.activeSid, msg);
  await api.sessSend(state.activeSid, msg);
  state.diffComments = [];
  updateCommentButton();
  refreshDiff();
}

// --- PR monitoring -----------------------------------------------------------
async function refreshPr() {
  if (!state.cwd) return;
  const box = $('pr-box');
  const res = await api.gitPrStatus(state.cwd);
  if (!res.ok || !res.pr) {
    box.classList.add('hidden');
    return;
  }
  const pr = res.pr;
  box.classList.remove('hidden');
  const failing = pr.checks.filter((c) => /fail|error/i.test(c.conclusion));
  const pending = pr.checks.filter((c) => /pending|in_progress|queued/i.test(c.status + c.conclusion));
  box.innerHTML = `
    <div class="pr-title">PR #${pr.number} · ${escapeHtml(pr.title)} <span class="scope">[${escapeHtml(pr.state)}${pr.reviewDecision ? ' · ' + escapeHtml(pr.reviewDecision) : ''}]</span></div>
    ${pr.checks.map((c) => `
      <div class="pr-check">
        <span class="${/success|pass/i.test(c.conclusion) ? 'ok' : /fail|error/i.test(c.conclusion) ? 'fail' : 'pending'}">
          ${/success|pass/i.test(c.conclusion) ? '✔' : /fail|error/i.test(c.conclusion) ? '✖' : '◌'}</span>
        <span>${escapeHtml(c.name)}</span>
      </div>`).join('')}
    <div class="pr-actions">
      <button class="btn btn-sm" data-op="open">在浏览器打开</button>
      ${failing.length ? '<button class="btn btn-sm btn-primary" data-op="fix">Auto-fix 失败检查</button>' : ''}
      ${pending.length ? `<span class="scope">${pending.length} 项进行中…</span>` : ''}
    </div>`;
  box.querySelector('[data-op="open"]').onclick = () => api.openExternal(pr.url);
  const fixBtn = box.querySelector('[data-op="fix"]');
  if (fixBtn) fixBtn.onclick = async () => {
    const msg = `PR #${pr.number} 的以下 CI 检查失败了:${failing.map((c) => c.name).join(', ')}。请用 gh 查看失败日志(gh pr checks / gh run view --log-failed),定位原因并修复,然后提交推送。`;
    addUserMessage(state.activeSid, msg);
    await api.sessSend(state.activeSid, msg);
  };
}

export function init() {
  $('btn-diff-refresh').onclick = () => { refreshDiff(); refreshPr(); };
  $('btn-send-comments').onclick = sendComments;
  $('btn-review').onclick = async () => {
    if (!state.activeSid) return;
    const msg = '请审查当前工作区未提交的代码改动(git diff),从正确性、边界情况、安全性、可读性几个角度给出评审意见,不要修改代码。';
    addUserMessage(state.activeSid, msg);
    await api.sessSend(state.activeSid, msg);
  };
  on('files-changed', () => refreshDiff());
  on('turn-done', () => refreshDiff());

  // poll PR checks every 60s while panel is visible
  if (prTimer) clearInterval(prTimer);
  prTimer = setInterval(() => {
    if (!$('right-panel').classList.contains('hidden') && $('panel-diff').classList.contains('active')) refreshPr();
  }, 60000);
  refreshPr();
}
