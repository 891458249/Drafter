// Shared state + tiny helpers for all renderer modules.
export const api = window.api;

export const state = {
  cwd: null,
  projectId: null,       // active project group
  activeSid: null,
  sessions: new Map(),   // sid -> { meta, ui }
  viewMode: 'normal',
  filesCache: null,      // [paths] for @ autocomplete
  commandsCache: null,   // slash commands
  attachments: [],       // pending image attachments {mediaType, data(base64), name}
  diffComments: [],      // [{file, line, side, text}]
};

export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n) + '\n… (已截断)' : s;
}

if (window.marked) window.marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdown(text) {
  if (window.marked) {
    try { return window.marked.parse(text || ''); } catch { /* fall through */ }
  }
  return escapeHtml(text || '');
}

export function fmtCost(v) {
  return v == null ? '$—' : '$' + v.toFixed(4);
}

export function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

// simple pub/sub so modules can react without circular imports
const listeners = {};
export function on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); }
export function emit(evt, data) { for (const cb of (listeners[evt] || [])) cb(data); }
