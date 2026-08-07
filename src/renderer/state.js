// Shared state + tiny helpers for all renderer modules.
export const api = window.api;

export const state = {
  cwd: null,
  projectId: null,
  section: 'code', // 板块:'code' 项目工作区;'chat' 纯对话(v0.6.0);'image'/'video'/'audio'/'model' 新媒体(v0.9.0)
  activeSid: null,
  sessions: new Map(),   // sid -> { meta, ui }
  viewMode: 'normal',
  filesCache: null,      // [paths] for @ autocomplete
  commandsCache: null,   // slash commands
  attachments: [],       // 待发送附件:image {mediaType, data(base64)} / file 文本 / media {mediaKind, path, size}
  diffComments: [],      // [{file, line, side, text}]
  gems: [],              // Gem 自定义助手缓存(v0.9.11),gems.js 负责刷新
};

export const $ = (id) => document.getElementById(id);

// 新媒体板块 kind(v0.9.0):这些会话不走 Agent SDK,走 AIGC 生成任务闭环
export const MEDIA_KINDS = ['image', 'video', 'audio', 'model'];

// Gem 名称查询(v0.9.11):gem 被删返回 null(调用方静默回退)
export function gemNameOf(id) {
  const g = (state.gems || []).find((x) => x.id === id);
  return g ? g.name : null;
}

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

// marked v4+ 的 tokenizer 把 code block 规范为 <pre><code class="language-xx">…;
// 该正则同时兼容无 class 的裸 pre。供 chat.js 高亮/复制后处理使用(v0.9.12)。
export const PRE_CODE_RE = /<pre><code(?:\s+class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g;

// 提取 <code> 内 HTML 的纯文本(用于复制):剥标签 + 反转义
export function decodeCodeHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function fmtCost(v) {
  return v == null ? '$—' : '$' + v.toFixed(4);
}

export function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

// 模型 id → 展示名(claude-opus-4-8 → Opus 4.8;非 claude 模型去日期后缀),供输入框
// placeholder 与助手气泡身份使用(v0.9.2);app.js 有同名实现用于下拉列表
export function modelLabel(id) {
  let s = String(id || '').replace(/^claude-/, '');
  const bracket = (s.match(/(\[.*\])$/) || [null, ''])[1];
  s = s.replace(/\[.*\]$/, '').replace(/-?20\d{6}$/, '').replace(/(\d)-(\d)/g, '$1.$2');
  const m = s.match(/^([a-z]+)-?(.*)$/i);
  if (!m) return s + bracket;
  return m[1][0].toUpperCase() + m[1].slice(1) + (m[2] ? ' ' + m[2] : '') + bracket;
}

// 会话当前模型的展示名:所选模型 > SDK init 回传模型 > 默认模型
export function sessionModelName(s) {
  if (!s) return '默认模型';
  return modelLabel(s.meta.model || s.ui.initModel || '') || '默认模型';
}

// 通用右键菜单(v0.9.8):.ctx-menu 样式;items = [{ label, danger?, onClick }],('-' 为分隔线)
let ctxMenuEl = null;
export function closeCtxMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
export function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      el.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    if (it.disabled) {
      b.disabled = true;
      if (it.hint) b.title = it.hint;
    } else {
      b.onclick = () => { closeCtxMenu(); it.onClick(); };
    }
    el.appendChild(b);
  }
  document.body.appendChild(el);
  // 贴边时向内收,避免菜单超出窗口
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  ctxMenuEl = el;
}
document.addEventListener('click', closeCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return; // 本次右键已被某个菜单接管(菜单在同一事件里刚打开)
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu();
});

// simple pub/sub so modules can react without circular imports
const listeners = {};
export function on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); }
export function emit(evt, data) { for (const cb of (listeners[evt] || [])) cb(data); }

// 模型下拉值编码(v0.8.2):"keyId|modelId" = 启用 Key 分组下的模型;
// 无前缀 = 内置回退列表(走活跃 Key / CLI 登录态)
export function parseModelValue(v) {
  if (!v) return { keyId: null, model: null };
  const i = v.indexOf('|');
  return i > 0 ? { keyId: v.slice(0, i), model: v.slice(i + 1) } : { keyId: null, model: v };
}

export function modelSelValue(meta) {
  return meta.model ? (meta.keyId ? `${meta.keyId}|${meta.model}` : meta.model) : '';
}

// 会话 Key chip:在模型下拉旁显示所选模型所属 Key 的名称,无匹配(内置回退)时隐藏
export async function updateKeyChips() {
  const pairs = [['model-sel', 'model-key-chip']];
  let list = null;
  for (const [selId, chipId] of pairs) {
    const sel = $(selId), chip = $(chipId);
    if (!sel || !chip) continue;
    const { keyId } = parseModelValue(sel.value);
    if (keyId && !list) {
      try { list = (await api.keysList()).list; } catch { list = []; }
    }
    const name = keyId && list ? ((list.find((k) => k.id === keyId) || {}).name || '') : '';
    chip.textContent = name;
    chip.classList.toggle('hidden', !name);
  }
}
