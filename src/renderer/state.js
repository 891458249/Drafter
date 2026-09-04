// Shared state + tiny helpers for all renderer modules.
export const api = window.api;

export const state = {
  cwd: null,
  projectId: null,
  section: 'code', // 板块:'code' 项目工作区;'chat' 纯对话(v0.6.0);'media' 创作板块(图/视/音/3D,v0.9.38 四大媒体板块合并)
  activeSid: null,
  sessions: new Map(),   // sid -> { meta, ui }
  viewMode: 'normal',
  filesCache: null,      // [paths] for @ autocomplete
  commandsCache: null,   // slash commands
  attachments: [],       // 待发送附件:image {mediaType, data(base64)} / file 文本 / media {mediaKind, path, size}
  diffComments: [],      // [{file, line, side, text}]
  gems: [],              // Gem 自定义助手缓存(v0.9.11),gems.js 负责刷新
  instantJump: true,     // 导航点击/回到底部瞬时跳转(v0.9.15);false=平滑滚动,boot 时从设置载入
  floatBallEnabled: false, // 窗口隐藏时显示桌面悬浮球(v0.13.3);boot 时从 settings.floatBall 载入
  canvasEngine: 'native', // 画布引擎(v0.13.0):native=自研 Canvas 2D 引擎;'drawflow'=旧 Drawflow,boot 时从设置载入
  comfyAdvancedMode: false, // 外部 ComfyUI 服务为高级可选后端;默认 API Key 原生画布
  mediaShop: 'all',      // 创作板块工坊筛选:'all'|'image'|'video'|'audio'|'model'(v0.9.38)
  GroupsCache: new Map(),// Kuro 模型分组缓存:keyId → [{category, model_type, models}](populateModelSelects/ensureGroups 填充)
};

export const $ = (id) => document.getElementById(id);

// 创作板块会话 kind:'media'(v0.9.38 起唯一的媒体会话 kind;四类旧 kind 由
// migrations 归一,数组保留旧值仅为兼容手工降级/未迁移存量)。这些会话不走
// Agent SDK,走 AIGC 生成任务闭环;生成类型按所选模型的 model_type 决定。
export const MEDIA_KINDS = ['media', 'image', 'video', 'audio', 'model'];

// 生成类型显示标签(工坊 chips/下拉 optgroup/任务卡片用)
export const MEDIA_TYPE_LABEL = { image: '图片', video: '视频', audio: '音频', model: '3D' };

// 会话 kind → 板块:四类旧媒体 kind 与 'media' 都映射到创作板块
export function sectionOfKind(kind) {
  return MEDIA_KINDS.includes(kind) ? 'media' : (kind || 'code');
}

// 确保分组缓存已加载(首次需要时拉一次 /my-models 结果;空结果也标记已拉取,避免重复请求)
let groupsLoaded = false;
export async function ensureGroups() {
  if (groupsLoaded) return;
  groupsLoaded = true;
  try {
    const { list } = await api.keysList();
    for (const k of list || []) if (Array.isArray(k.modelGroups)) state.GroupsCache.set(k.id, k.modelGroups);
  } catch {}
}

// 当前会话的生成类型(image/video/audio/model):优先按所选模型在 Kuro 分组
// 缓存里的 model_type;查不到(分组失效)依次回退会话 board 戳(主进程在迁移/
// 建会话/换模型时盖的最近已知类型)与旧 kind;都不行返回 null。
const MEDIA_BOARDS = ['image', 'video', 'audio', 'model'];
export function boardOf(keyId, model, kind, board) {
  const groups = keyId ? state.GroupsCache.get(keyId) : null;
  const g = groups && groups.find((x) => Array.isArray(x.models) && x.models.includes(model));
  let t = g && MEDIA_BOARDS.includes(g.model_type) ? g.model_type : null;
  if (!t && MEDIA_BOARDS.includes(board)) t = board;
  if (!t && MEDIA_BOARDS.includes(kind)) t = kind; // 旧 kind 兜底(未迁移存量)
  return t;
}

// body 挂 board-<type> class:附件按钮分段显隐(参考图按类型准入)等 UI 跟随生成类型。
// board=null 时清掉全部 board class(切回 code/chat 或类型未知)。
export function setBoardClass(board) {
  for (const b of ['image', 'video', 'audio', 'model']) document.body.classList.toggle('board-' + b, b === board);
}

// Gem 名称查询(v0.9.11):gem 被删返回 null(调用方静默回退)
export function gemNameOf(id) {
  const g = (state.gems || []).find((x) => x.id === id);
  return g ? g.name : null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
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
