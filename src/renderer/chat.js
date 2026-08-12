// Chat rendering: per-session logs, streaming, tool cards, permission cards,
// plan approval, subagent grouping, view modes, history replay.
import { api, state, $, escapeHtml, truncate, renderMarkdown, fmtCost, fmtTokens, emit, modelSelValue, updateKeyChips, MEDIA_KINDS, modelLabel, sessionModelName, gemNameOf } from './state.js';
import { highlightCode } from './hljs.js';
import { enhanceCodeHtml } from './codeblock.js';
import { parseFilePath, PATH_IN_TEXT_RE } from './filelink.js';

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
  stickToBottom = true; // 切换会话:回到吸附态并吸底
  const sbBtn = $('btn-scroll-bottom');
  if (sbBtn) sbBtn.classList.add('hidden');
  scrollBottom(sid, { force: true });
  emit('session-activated', sid);
}

export function updateTopbarForSession(sid) {
  const s = state.sessions.get(sid);
  if (!s) return;
  const m = s.meta;
  if (m.permissionMode) $('perm-mode').value = m.permissionMode;
  $('model-sel').value = modelSelValue(m); // keyId|modelId 编码,回显所属 Key 分组
  updateKeyChips(); // 回显模型时同步 Key chip
  const composerEffort = $('effort-sel-composer');
  if (composerEffort) composerEffort.value = m.effort || '';
  $('usage-chip').textContent = fmtCost(s.ui.cumCost) +
    (s.ui.lastUsage ? ` · ↑${fmtTokens(ctxTokens(s.ui.lastUsage))}` : '');
  // 输入框 placeholder 跟随当前模型身份(v0.9.2);绑定 Gem 时冠以 Gem 名(v0.9.11)
  $('input').placeholder = composerPlaceholder(s);
  setBusyUI(s.ui.busy);
  updateAigcSendUI(); // 媒体会话:发送锁按任务终态恢复
}

// 输入框 placeholder:Gem 名(若绑定) + 模型身份
function composerPlaceholder(s) {
  const gemName = s.meta.gemId ? gemNameOf(s.meta.gemId) : null;
  const who = gemName ? `${gemName} · ${sessionModelName(s)}` : sessionModelName(s);
  return `给 ${who} 发送消息…  (Enter 发送 · Shift+Enter 换行 · @文件 · /命令 · 可粘贴图片)`;
}

function ctxTokens(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

export function setBusyUI(busy) {
  $('btn-send').classList.toggle('hidden', !!busy);
  $('btn-send').disabled = false; // 媒体会话的发送锁由 updateAigcSendUI 单独管理
  $('btn-stop').classList.toggle('hidden', !busy);
  $('busy-hint').classList.toggle('hidden', !busy);
  updateTurnStatus();
}

// --- 运行状态行(✳ 1m 5s · 217 tokens · 1 个运行中任务) ---------------------
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// 预测进度(v0.9.13):agentic 回合总步数不可预知,用「时间双曲线」逼近——
// 从 0 起渐近逼近 92%(永不到 100),回合结束补满 100% 后淡出。
// 参数:半衰期 25s(25 秒到 ~46%,100 秒到 ~74%),对长短回合都有合理的视觉预期。
const PREDICT_ASYMPTOTE = 92;
const PREDICT_HALF_MS = 25000;

function predictedPct(turnStart) {
  const t = Date.now() - (turnStart || Date.now());
  return Math.min(PREDICT_ASYMPTOTE, Math.round(PREDICT_ASYMPTOTE * t / (t + PREDICT_HALF_MS)));
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
  const action = s.ui.curAction ? ` · ${s.ui.curAction}` : '';
  const pct = predictedPct(s.ui.turnStart);
  $('turn-status-text').textContent =
    `${fmtDur(Date.now() - (s.ui.turnStart || Date.now()))} · ${fmtTokens(toks)} tokens · ${running} 个运行中任务${action} · ~${pct}%`;
  const bar = box.querySelector('.turn-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

setInterval(updateTurnStatus, 1000);

// 回合结束:进度条补满 100% 后随状态行一起消失(setBusyUI(false) 已隐藏,这里只复位宽度)
function resetTurnProgress() {
  const bar = $('turn-status') && $('turn-status').querySelector('.turn-progress-bar');
  if (bar) bar.style.width = '0%';
}

async function replayHistory(sid) {
  const s = state.sessions.get(sid);
  if (!s || s.ui.replayed) return;
  s.ui.replayed = true;
  const events = await api.sessHistory(sid);
  s.ui.historyKeys = new Set(events.map(eventKey)); // F-004 去重:供 live 事件比对
  for (const ev of events) renderEvent(sid, ev, { replay: true });
  finalizeAssistant(s);
  finalizeAigcReplay(s); // 新媒体会话:未完成的历史任务标记中断
  emit('history-replayed', { sid }); // 消息导航条据此重建(v0.9.9)
  scrollBottom(sid, { force: true }); // 回放完成强制吸底
}

// 滚动吸附(v0.9.13):用户上翻(拖滚动条/滚轮)即解除吸底,自由浏览上下文;
// 回到底部附近(80px 内)恢复吸附。流式渲染/工具卡片等只在本就吸底时才跟随,
// 不再把正在阅读上文的用户强制拉到底部。非吸附态显示「↓ 回到底部」悬浮按钮。
let stickToBottom = true;
const STICK_THRESHOLD = 80;

messagesEl().addEventListener('scroll', () => {
  const el = messagesEl();
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  const btn = $('btn-scroll-bottom');
  if (btn) btn.classList.toggle('hidden', stickToBottom);
}, { passive: true });

const scrollBottomBtn = $('btn-scroll-bottom');
if (scrollBottomBtn) scrollBottomBtn.onclick = () => {
  stickToBottom = true;
  scrollBottomBtn.classList.add('hidden');
  const el = messagesEl();
  // 瞬时/平滑按设置项(v0.9.15)
  if (state.instantJump) el.scrollTop = el.scrollHeight;
  else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
};

// force:用户自己发消息/切换会话/历史回放等场景强制吸底
function scrollBottom(sid, { force = false } = {}) {
  if (sid !== state.activeSid) return;
  if (!force && !stickToBottom) return;
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
  msg.innerHTML = `<div class="msg-role">${escapeHtml(sessionModelName(s))}</div><div class="bubble"></div>`;
  containerFor(s, parentId).appendChild(msg);
  s.ui.currentAssistant = {
    el: msg, bubble: msg.querySelector('.bubble'),
    buf: '', textEl: null, parentId: parentId || null,
    activity: null,
  };
  return s.ui.currentAssistant;
}

function finalizeAssistant(s) {
  const a = s.ui.currentAssistant;
  if (!a) return;
  flushAssistantRender(s, a); // 冲销待渲染帧,保证回合结束内容完整
  const live = a.bubble.querySelector('.thinking.live');
  if (live) live.classList.remove('live');
  s.ui.currentAssistant = null;
}

// 流式渲染节流(v0.9.10):此前每个 text delta 都把已累积全文重新 marked.parse 一遍
// (消息越长越慢,O(n²)),且所有会话(含后台)共用渲染主线程——一个会话流式输出时
// 其他会话的输入框被卡住无法打字。改为 80ms 合帧渲染,段落切换/回合结束时冲销。
const ASSISTANT_RENDER_MS = 80;

function scheduleAssistantRender(s, a) {
  if (a.renderTimer) return;
  a.renderTimer = setTimeout(() => {
    a.renderTimer = null;
    if (a.textEl) {
      a.textEl.innerHTML = enhanceCodeHtml(renderMarkdown(a.buf));
      linkifyPaths(a.textEl);
    }
    scrollBottom(s.meta.id);
  }, ASSISTANT_RENDER_MS);
}

function flushAssistantRender(s, a) {
  if (!a || !a.renderTimer) return;
  clearTimeout(a.renderTimer);
  a.renderTimer = null;
  if (a.textEl) {
    a.textEl.innerHTML = enhanceCodeHtml(renderMarkdown(a.buf));
    linkifyPaths(a.textEl);
  }
  scrollBottom(s.meta.id);
}

function appendText(s, parentId, delta) {
  const a = ensureAssistant(s, parentId);
  a.buf += delta;
  if (!a.textEl) {
    a.textEl = document.createElement('div');
    a.bubble.appendChild(a.textEl);
  }
  scheduleAssistantRender(s, a);
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
// v0.9.32 重写:旧正则不含冒号,Windows 盘符路径(C:\…)永远匹配不上,
// 含空格路径也不行;且只认行内 <code>,散文里的裸路径点不开。
// 现在:①行内 code 整段交给 parseFilePath;②正文文本节点扫描绝对路径包 .file-link。
function makeFileLink(text, hit) {
  const span = document.createElement('span');
  span.className = 'file-link';
  span.textContent = text;
  span.title = hit.path + '\n点击在右侧编辑器打开';
  span.onclick = (e) => { e.stopPropagation(); emit('open-file', hit); };
  return span;
}

function linkifyPaths(el) {
  // ① 行内 <code>:整段文本是路径才链接化
  for (const code of el.querySelectorAll('code')) {
    if (code.childElementCount !== 0 || code.closest('.file-link')) continue;
    const hit = parseFilePath(code.textContent || '');
    if (!hit) continue;
    code.classList.add('file-link');
    code.title = hit.path + '\n点击在右侧编辑器打开';
    code.onclick = (e) => { e.stopPropagation(); emit('open-file', hit); };
  }
  // ② 正文文本节点:绝对路径(无反引号)也可点击
  const SKIP = 'pre,code,a,script,style,.file-link,.code-card-head';
  const texts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || n.nodeValue.length < 4) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      PATH_IN_TEXT_RE.lastIndex = 0;
      return PATH_IN_TEXT_RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let tn;
  while ((tn = walker.nextNode())) texts.push(tn);
  for (const t of texts) {
    PATH_IN_TEXT_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m, dirty = false;
    while ((m = PATH_IN_TEXT_RE.exec(t.nodeValue))) {
      const hit = parseFilePath(m[0]);
      if (!hit) continue; // exec 内部 lastIndex 已前进,不会死循环
      dirty = true;
      if (m.index > last) frag.appendChild(document.createTextNode(t.nodeValue.slice(last, m.index)));
      frag.appendChild(makeFileLink(m[0], hit));
      last = m.index + m[0].length;
    }
    if (!dirty) continue;
    if (last < t.nodeValue.length) frag.appendChild(document.createTextNode(t.nodeValue.slice(last)));
    t.parentNode.replaceChild(frag, t);
  }
}

// --- user echo ---------------------------------------------------------------
// 附件块折叠(v0.9.27):<附件 name=".." path="..">…</附件> 在用户气泡里只显示
// 文件卡片(📄 文件名,悬停见路径),不显示内容——内容又长又占篇幅,AI 按路径
// 自行 Read;旧版本内联全文的 <附件 name=".."> 历史消息同样折叠。
const ATTACH_BLOCK_RE = /<附件\s+name="([^"]*)"(?:\s+path="([^"]*)")?\s*>[\s\S]*?<\/附件>/g;
function collapseAttachBlocks(text) {
  return String(text || '').replace(ATTACH_BLOCK_RE, (_m, name, p) =>
    `\n\n<div class="file-attach-chip" data-path="${escapeHtml(p || '')}" title="${escapeHtml(p ? p + '\n双击打开编辑器查看' : name)}">📄 ${escapeHtml(name)}</div>\n\n`);
}

// 渲染用户消息 bubble 内容(addUserMessage 与编辑重生成的重渲染共用)
export function renderUserBubble(bubble, content) {
  bubble.innerHTML = '';
  if (typeof content === 'string') {
    bubble.innerHTML = enhanceCodeHtml(renderMarkdown(collapseAttachBlocks(content)));
    linkifyPaths(bubble);
    return;
  }
  for (const b of content) {
    if (b.type === 'text') {
      const d = document.createElement('div');
      d.innerHTML = enhanceCodeHtml(renderMarkdown(collapseAttachBlocks(b.text)));
      bubble.appendChild(d);
    } else if (b.type === 'media_ref') {
      // 音频/视频/3D 附件卡片(媒体本体不进会话,发送时已注入分析/元信息文本)
      const n = document.createElement('div');
      n.className = 'user-img-note';
      const icon = { audio: '🎵', video: '🎬', model: '🧊' }[b.mediaKind] || '📎';
      n.textContent = `${icon} [附件] ${b.name || ''}`;
      bubble.appendChild(n);
    } else if (b.type === 'image' || b.type === 'image_ref') {
      // live 消息带 source,历史回放带 mediaType/data
      const mt = (b.source && b.source.media_type) || b.mediaType;
      const data = (b.source && b.source.data) || b.data;
      if (data) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = `data:${mt || 'image/png'};base64,${data}`;
        img.title = '双击查看 · 右键菜单'; // 查看/复制由 msgmenu.js 统一接管(v0.9.8)
        bubble.appendChild(img);
      } else {
        const n = document.createElement('div');
        n.className = 'user-img-note';
        n.textContent = '🖼 [图片附件]';
        bubble.appendChild(n);
      }
    }
  }
  linkifyPaths(bubble);
}

export function addUserMessage(sid, content, uuid) {
  const s = ensureSession(sid);
  const msg = document.createElement('div');
  msg.className = 'msg user';
  if (uuid) msg.dataset.uuid = uuid; // v0.9.9:编辑重生成/分支的锚点
  msg.innerHTML = `<div class="msg-role">你</div><div class="bubble"></div>`;
  renderUserBubble(msg.querySelector('.bubble'), content);
  finalizeAssistant(s);
  s.ui.logEl.appendChild(msg);
  msg._umsg = { uuid: uuid || null, content }; // msgmenu.js 右键编辑/分支取用
  emit('user-msg-added', { sid });
  stickToBottom = true; // 用户发消息(含 aigc 回显):恢复吸附并吸底
  scrollBottom(sid, { force: true });
  return msg;
}

// 编辑重生成后:把目标用户消息(含)之后的渲染全部移除,等待重发与新回复
export function truncateAfter(sid, msgEl) {
  const s = state.sessions.get(sid);
  if (!s || !msgEl) return;
  finalizeAssistant(s);
  let n = msgEl;
  while (n) { const next = n.nextSibling; n.remove(); n = next; }
  scrollBottom(sid);
}

// --- AIGC 任务卡片(新媒体板块,v0.9.0) -----------------------------------------
// 用户消息 = prompt + 参考图缩略图;助手消息 = 任务卡片,随 aigc:status 事件原地更新。
const AIGC_TERMINAL = new Set(['done', 'fail', 'timeout', 'interrupted']);
const AIGC_STATUS_TEXT = {
  pending: '排队中', processing: '生成中', transferring: '转存产物中', downloading: '下载产物中',
  done: '完成', fail: '失败', timeout: '超时', interrupted: '已中断',
};

export function addAigcUserMessage(sid, ev) {
  const blocks = [];
  for (const r of ev.refImages || []) {
    if (r.data) blocks.push({ type: 'image_ref', mediaType: r.mediaType, data: r.data });
  }
  if (ev.prompt) blocks.push({ type: 'text', text: ev.prompt });
  addUserMessage(sid, blocks.length ? blocks : '(空消息)');
}

// 发送后立即本地回显:用户消息 + pending 任务卡片,并加并发发送锁
export function aigcLocalEcho(sid, { traceId, prompt, refImages, model }) {
  addAigcUserMessage(sid, { prompt, refImages });
  upsertTaskCard(sid, { traceId, model, status: 'pending' }, false);
}

export function aigcBusy(sid) {
  const s = state.sessions.get(sid);
  return !!(s && s.ui.aigcPending && s.ui.aigcPending.size);
}

// 媒体会话的发送按钮/提示由任务终态控制(不走 SDK 的 ui_status)
export function updateAigcSendUI() {
  const s = state.sessions.get(state.activeSid);
  if (!s || !MEDIA_KINDS.includes(s.meta.kind)) return;
  const busy = aigcBusy(state.activeSid);
  $('btn-send').disabled = busy;
  const hint = $('busy-hint');
  hint.textContent = '生成中,任务完成后才能继续发送';
  hint.classList.toggle('hidden', !busy);
}

export function handleAigcStatus(p) {
  upsertTaskCard(p.sessionId, {
    traceId: p.traceId, model: p.model, status: p.status,
    failReason: p.failReason, files: p.files,
  }, false);
}

function upsertTaskCard(sid, ev, replay) {
  const s = ensureSession(sid);
  if (!s.ui.aigcCards) s.ui.aigcCards = new Map();
  let card = s.ui.aigcCards.get(ev.traceId);
  if (!card) {
    finalizeAssistant(s);
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    msg.innerHTML = `<div class="msg-role">${escapeHtml(modelLabel(ev.model) || '任务')}</div><div class="bubble"></div>`;
    const el = document.createElement('div');
    el.className = 'aigc-card';
    el.dataset.traceId = ev.traceId;
    msg.querySelector('.bubble').appendChild(el);
    s.ui.logEl.appendChild(msg);
    card = { el };
    s.ui.aigcCards.set(ev.traceId, card);
  }
  card.status = ev.status;
  if (ev.files) card.files = ev.files;
  if (ev.failReason) card.failReason = ev.failReason;
  renderAigcCard(s, card, ev.traceId);
  // 并发发送锁:非终态持有,终态解除
  if (!s.ui.aigcPending) s.ui.aigcPending = new Set();
  if (AIGC_TERMINAL.has(ev.status)) s.ui.aigcPending.delete(ev.traceId);
  else s.ui.aigcPending.add(ev.traceId);
  if (!replay) updateAigcSendUI();
  scrollBottom(sid);
}

function renderAigcCard(s, card, traceId) {
  const st = card.status || 'pending';
  const head = `<div class="aigc-card-head"><span class="aigc-status st-${st}">${AIGC_STATUS_TEXT[st] || st}</span>${
    AIGC_TERMINAL.has(st) ? '' : '<button class="aigc-cancel" title="取消任务(停止轮询)">✕</button>'}</div>`;
  let body = '';
  if (st === 'done') {
    body = (card.files || []).map((f) => mediaHtml(s.meta.kind, traceId, f)).join('') || '<div class="aigc-note">(无产物文件)</div>';
  } else if (st === 'fail' || st === 'timeout') {
    body = `<div class="aigc-error">${escapeHtml(card.failReason || (st === 'timeout' ? '任务超时' : '生成失败'))}</div>`;
  } else if (st === 'interrupted') {
    body = '<div class="aigc-note">任务已中断(应用重启或已取消)</div>';
  } else {
    body = `<div class="aigc-progress"><span class="spin">◐</span> ${AIGC_STATUS_TEXT[st] || st}…</div>`;
  }
  card.el.innerHTML = head + `<div class="aigc-card-body">${body}</div>`;
  const cancel = card.el.querySelector('.aigc-cancel');
  if (cancel) {
    cancel.onclick = () => {
      api.aigcCancel(s.meta.id, traceId);
      card.status = 'interrupted'; // 本地立即落终态;主进程取消后不再推事件
      if (s.ui.aigcPending) s.ui.aigcPending.delete(traceId);
      renderAigcCard(s, card, traceId);
      updateAigcSendUI();
    };
  }
  for (const btn of card.el.querySelectorAll('.aigc-open-dir')) {
    btn.onclick = () => api.shellShowItemInFolder(btn.dataset.path);
  }
  for (const el of card.el.querySelectorAll('.aigc-file-open')) {
    el.onclick = () => openGeneratedFile(el.dataset.path);
  }
}

// 生成文件点击打开(v0.9.6):文本类进编辑器面板高亮预览,其余(图片/视频/3D 等)系统默认程序打开
const TEXT_PREVIEW_EXTS = new Set(('md,txt,js,mjs,cjs,ts,jsx,tsx,json,py,css,html,htm,sh,bash,ps1,bat,cmd,'
  + 'yml,yaml,toml,ini,cfg,conf,log,csv,xml,svg,vue,sql').split(','));
function openGeneratedFile(p) {
  if (!p) return;
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (TEXT_PREVIEW_EXTS.has(ext)) emit('open-file', p);
  else api.openPath(p);
}

// 产物内联渲染:图片 <img> / 视频 <video> / 音频 <audio> / 3D 文件卡片;
// 每个产物带文件条——文件名可点击(文本进编辑器预览,其余系统程序打开),另有「打开所在文件夹」
function mediaHtml(kind, traceId, f) {
  const src = `aigc://${traceId}/${encodeURIComponent(f.name)}`;
  const bar = `<div class="aigc-file-bar"><span class="aigc-file-open" data-path="${escapeHtml(f.path || '')}" title="点击打开/预览">📦 ${escapeHtml(f.name)}</span>` +
    `<button class="btn btn-sm aigc-open-dir" data-path="${escapeHtml(f.path || '')}">打开所在文件夹</button></div>`;
  if (kind === 'image') return `<img class="aigc-media" src="${src}" alt="${escapeHtml(f.name)}" />` + bar;
  if (kind === 'video') return `<video class="aigc-media" src="${src}" controls></video>` + bar;
  if (kind === 'audio') return `<audio class="aigc-audio" src="${src}" controls></audio>` + bar;
  return `<div class="aigc-file">${bar}</div>`;
}

// 历史回放后:未到终态的卡片说明任务随应用退出中断,标记为已中断并释放发送锁
function finalizeAigcReplay(s) {
  if (!s.ui.aigcCards) return;
  for (const [traceId, card] of s.ui.aigcCards) {
    if (!AIGC_TERMINAL.has(card.status)) {
      card.status = 'interrupted';
      renderAigcCard(s, card, traceId);
    }
  }
  if (s.ui.aigcPending) s.ui.aigcPending.clear();
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

// 写/编辑类工具的产出行径:body 渲染为高亮代码(而不是 JSON 原文),超长截断
const FILE_TOOL_PATH = (name, i) => (i && (i.file_path || i.notebook_path)) || null;
const CODE_VIEW_CAP = 20000;

function renderToolBody(bodyEl, name, input) {
  if (!input) { bodyEl.textContent = ''; return; }
  const fp = FILE_TOOL_PATH(name, input);
  const code = name === 'Write' ? input.content
    : (name === 'Edit' || name === 'MultiEdit') ? input.new_string
    : null;
  if (fp && code != null) {
    const capped = String(code).length > CODE_VIEW_CAP;
    const shown = capped ? String(code).slice(0, CODE_VIEW_CAP) : String(code);
    bodyEl.innerHTML =
      `<div class="code-view-path">${escapeHtml(fp)}</div>` +
      `<pre class="code-view"><code>${highlightCode(shown, fp)}</code></pre>` +
      (capped ? `<div class="code-view-more">… 内容过长仅预览前 ${CODE_VIEW_CAP} 字符,点击文件名可在编辑器面板打开完整文件</div>` : '');
    return;
  }
  bodyEl.textContent = JSON.stringify(input, null, 2);
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
  renderToolBody(body, name, input);
  row.querySelector('.act-row-head').onclick = () => body.classList.toggle('collapsed');
  // 文件类工具:label 可点击,在编辑器面板预览该文件(v0.9.1)
  const fp = input && FILE_TOOL_PATH(name, input);
  if (fp) {
    const label = row.querySelector('.act-label');
    label.classList.add('file-link');
    label.title = fp + '(点击在编辑器面板预览)';
    label.onclick = (e) => { e.stopPropagation(); emit('open-file', fp); };
  }
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
  // 代码卡片(Write/Edit)的 body 已是高亮预览,不被结果文本覆盖;出错时追加错误行
  const isCodeCard = (card.name === 'Write' || card.name === 'Edit' || card.name === 'MultiEdit')
    && card.input && FILE_TOOL_PATH(card.name, card.input)
    && (card.input.content != null || card.input.new_string != null);
  if (isCodeCard) {
    if (isError && text) {
      const err = document.createElement('div');
      err.className = 'code-view-more';
      err.textContent = '错误:' + truncate(text, 500);
      card.body.appendChild(err);
    }
  } else {
    const inputText = card.input ? JSON.stringify(card.input, null, 2) : '';
    card.body.textContent = (inputText ? inputText + '\n── 结果 ──\n' : '') + truncate(text || '', 4000);
  }
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
    bodyHtml = `<div class="plan-md">${enhanceCodeHtml(renderMarkdown(input.plan || ''))}</div>`;
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

// Dedupe key: persisted-then-emitted events serialize identically, so an exact
// JSON match reliably identifies "already rendered from history".
// uuid 除外(v0.9.9):live 事件由 SDK 返回时才带 uuid,历史事件是持久化时打戳,
// 同一消息两处 uuid 一致但旧版历史没有,比较时忽略以避免重复渲染。
function eventKey(ev) {
  try {
    const { uuid, ...rest } = ev;
    return JSON.stringify(rest);
  } catch { return String(ev); }
}

// --- main event entry ---------------------------------------------------------
export function handleSessEvent({ sid, ev }) {
  if (!sid) { // global error
    if (ev.type === 'ui_error') console.error(ev.message);
    return;
  }
  const s = ensureSession(sid);
  if (!s.ui.replayed) {
    // F-004: live event before history replay — do NOT mark replayed (that used
    // to suppress history forever). Load history first, buffer live events,
    // then flush only those not already rendered from history.
    if (!s.ui.replayPromise) {
      s.ui.liveBuffer = [ev];
      s.ui.replayPromise = replayHistory(sid).then(() => {
        const buf = s.ui.liveBuffer || [];
        s.ui.liveBuffer = null;
        const seen = s.ui.historyKeys || new Set();
        for (const e of buf) {
          const k = eventKey(e);
          if (seen.has(k)) continue;
          seen.add(k);
          renderEvent(sid, e, { replay: false });
        }
      }).catch(() => {
        // history load failed: fall back to rendering live events directly
        const buf = s.ui.liveBuffer || [];
        s.ui.liveBuffer = null;
        for (const e of buf) renderEvent(sid, e, { replay: false });
      });
    } else if (s.ui.liveBuffer) {
      s.ui.liveBuffer.push(ev);
    } else {
      renderEvent(sid, ev, { replay: false });
    }
    return;
  }
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
      resetTurnProgress(); // 新回合:预测进度归零
    }
    if (sid === state.activeSid) setBusyUI(s.ui.busy);
    emit('session-status', { sid, busy: s.ui.busy, running: s.ui.running });
    return;
  }
  if (t === 'ui_init') {
    if (ev.model) {
      s.ui.initModel = ev.model;
      if (sid === state.activeSid) { // init 回传真实模型后刷新 placeholder 身份
        $('input').placeholder = composerPlaceholder(s);
      }
    }
    if (ev.slashCommands) state.commandsCache = null; // refresh next time
    return;
  }
  if (t === 'ui_user_input') { addUserMessage(sid, ev.content, ev.uuid || null); return; }
  if (t === 'aigc_user') { addAigcUserMessage(sid, ev); return; } // 新媒体会话:用户 prompt(+参考图)
  if (t === 'aigc_task') { upsertTaskCard(sid, ev, replay); return; } // 新媒体会话:任务卡片
  if (t === 'ui_error') { metaLine(s, '错误:' + ev.message, 'error-line'); return; }
  if (t === 'ui_aux') { metaLine(s, ev.message); return; } // 辅助模型分析附件的进度提示(v0.9.1)
  if (t === 'ui_title') { // 自动命名(v0.9.1):更新本地 meta 并刷新侧栏
    s.meta.title = ev.title;
    emit('session-status', { sid });
    return;
  }
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
    if (ev.contextWindow) s.ui.contextWindow = ev.contextWindow;
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
    if (sid === state.activeSid) {
      // 回合结束:进度补满 100% 短暂停留再隐藏,给「完成」的视觉反馈
      const bar = $('turn-status') && $('turn-status').querySelector('.turn-progress-bar');
      if (bar) bar.style.width = '100%';
      setTimeout(() => {
        if (s.ui.busy) return; // 350ms 内又来了新回合,不打断
        setBusyUI(false);
        updateTopbarForSession(sid);
        resetTurnProgress();
      }, 350);
    }
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
      flushAssistantRender(s, a); // 新文本块开始前冲销上一段的待渲染帧
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
    s.ui.msgDeltaCounted = (s.ui.curMsgTokens || 0) > 0; // 本条是否已被流式 usage 计过(v0.9.13)
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
  // token/上下文兜底计数(v0.9.13):部分网关(如 Kimi)流式 message_delta 不带 usage,
  // 回合状态会一直显示 0 tokens——用 assistant 完整消息的 message.usage 补计;
  // 流式已计过的(msgDeltaCounted)不重复计。lastUsage 同步刷新,上下文 % 随回合推进。
  if (!replay && message.usage) {
    if (message.usage.output_tokens && !s.ui.msgDeltaCounted) {
      s.ui.turnTokens = (s.ui.turnTokens || 0) + message.usage.output_tokens;
      if (s.meta.id === state.activeSid) updateTurnStatus();
    }
    s.ui.msgDeltaCounted = false;
    s.ui.lastUsage = message.usage;
    if (s.meta.id === state.activeSid) emit('usage-updated');
  }
  const content = message.content || [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      const existing = s.ui.toolCards.get(block.id);
      if (!existing) addToolCard(s, parentId, block.id, block.name, block.input || null);
      else if (block.input) {
        existing.input = block.input;
        renderToolBody(existing.body, existing.name, block.input);
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
        flushAssistantRender(s, s.ui.currentAssistant); // 冲销后再清缓冲,避免丢最后一段
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
