// Terminal panel: multiple xterm tabs backed by main-process ptys.
/* global Terminal, FitAddon */
import { api, state, $ } from './state.js';

const terms = new Map(); // id -> { term, fit, pane, tab }
let activeId = null;

export async function newTerminal(command) {
  const res = await api.termOpen({ cwd: state.cwd, cols: 80, rows: 24, command: command || 'claude' });
  if (!res.ok) {
    alert('终端启动失败:' + res.error);
    return;
  }
  const id = res.id;
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('term-host').appendChild(pane);

  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#14120f', foreground: '#ece7df', cursor: '#d97757' },
    cursorBlink: true,
  });
  let fit = null;
  if (window.FitAddon) {
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
  }
  term.open(pane);
  term.onData((data) => api.termInput(id, data));

  const tab = document.createElement('button');
  tab.className = 'term-tab';
  tab.innerHTML = `<span>终端 ${$('term-tabs').querySelectorAll('.term-tab').length + 1}</span><span class="x">✕</span>`;
  tab.onclick = (e) => {
    if (e.target.classList.contains('x')) { closeTerminal(id); return; }
    activate(id);
  };
  $('term-tabs').insertBefore(tab, $('btn-term-new'));

  terms.set(id, { term, fit, pane, tab });
  activate(id);
  requestAnimationFrame(() => fitActive());
  return id;
}

function activate(id) {
  activeId = id;
  for (const [tid, t] of terms) {
    t.pane.classList.toggle('active', tid === id);
    t.tab.classList.toggle('active', tid === id);
  }
  fitActive();
  const t = terms.get(id);
  if (t) t.term.focus();
}

export function fitActive() {
  const t = terms.get(activeId);
  if (t && t.fit) {
    try {
      t.fit.fit();
      api.termResize(activeId, t.term.cols, t.term.rows);
    } catch {}
  }
}

function closeTerminal(id) {
  api.termClose(id);
  removeUi(id);
}

function removeUi(id) {
  const t = terms.get(id);
  if (!t) return;
  t.pane.remove();
  t.tab.remove();
  terms.delete(id);
  if (activeId === id) {
    const next = [...terms.keys()].pop();
    if (next) activate(next);
    else activeId = null;
  }
}

export function init() {
  $('btn-term-new').onclick = () => newTerminal();
  api.on('term:data', ({ id, data }) => {
    const t = terms.get(id);
    if (t) t.term.write(data);
  });
  api.on('term:exit', ({ id, code }) => {
    const t = terms.get(id);
    if (t) t.term.write(`\r\n[进程已退出: ${code}]\r\n`);
  });
  window.addEventListener('resize', fitActive);
}
