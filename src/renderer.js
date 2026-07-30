/* global marked, Terminal, FitAddon */
(function () {
'use strict';

const api = window.api;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  cwd: null,
  busy: false,
  termStarted: false,
  currentAssistant: null,       // { el, bubble, markdownBuf }
  toolCards: {},                // tool_use_id -> { el, body }
};

// DOM refs
const $ = (id) => document.getElementById(id);
const landing = $('landing');
const workspace = $('workspace');
const recentList = $('recent-list');
const messagesEl = $('messages');
const inputEl = $('input');

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}
function renderMarkdown(text) {
  if (window.marked) {
    try { return marked.parse(text || ''); } catch { /* fall through */ }
  }
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Landing / directory selection
// ---------------------------------------------------------------------------
async function initLanding() {
  const store = await api.getStore();
  renderRecent(store.recentProjects || []);
}

function renderRecent(list) {
  recentList.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.textContent = '(暂无)';
    li.style.cursor = 'default';
    recentList.appendChild(li);
    return;
  }
  for (const dir of list) {
    const li = document.createElement('li');
    li.textContent = dir;
    li.title = dir;
    li.onclick = () => openProject(dir);
    recentList.appendChild(li);
  }
}

$('btn-pick').onclick = async () => {
  const res = await api.pickDir();
  if (res && res.dir) openProject(res.dir);
};

async function openProject(dir) {
  state.cwd = dir;
  await api.addRecent(dir);
  $('cwd-label').textContent = dir;
  landing.classList.add('hidden');
  workspace.classList.remove('hidden');
  await startChat();
}

// ---------------------------------------------------------------------------
// Chat session lifecycle
// ---------------------------------------------------------------------------
async function startChat() {
  clearMessages();
  state.busy = false;
  setBusyUI(false);
  const permissionMode = $('perm-mode').value;
  const model = $('model-sel').value || null;
  await api.chatOpen({ cwd: state.cwd, permissionMode, model });
  addMeta(`会话已启动 · ${state.cwd}`);
}

$('btn-new').onclick = async () => {
  await api.chatClose();
  await startChat();
};

$('btn-switch').onclick = async () => {
  const res = await api.pickDir();
  if (res && res.dir) {
    await api.chatClose();
    if (state.termStarted) { await api.termClose(); state.termStarted = false; }
    openProject(res.dir);
  }
};

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$('btn-send').onclick = sendMessage;
$('btn-stop').onclick = async () => {
  await api.chatInterrupt();
  addMeta('已请求停止…');
};

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.busy) return;
  addUserMessage(text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  const ok = await api.chatSend(text);
  if (!ok) {
    addMeta('发送失败:会话未就绪或已退出。点击「新会话」重试。');
    return;
  }
  setBusyUI(true);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function clearMessages() {
  messagesEl.innerHTML = '';
  state.currentAssistant = null;
  state.toolCards = {};
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'msg user';
  msg.innerHTML = `<div class="msg-role">你</div><div class="bubble"></div>`;
  msg.querySelector('.bubble').innerHTML = renderMarkdown(text);
  messagesEl.appendChild(msg);
  scrollToBottom();
}

function addMeta(text) {
  const el = document.createElement('div');
  el.className = 'meta-line';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function ensureAssistant() {
  if (state.currentAssistant) return state.currentAssistant;
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.innerHTML = `<div class="msg-role">Claude</div><div class="bubble"></div>`;
  messagesEl.appendChild(msg);
  state.currentAssistant = {
    el: msg,
    bubble: msg.querySelector('.bubble'),
    markdownBuf: '',
  };
  return state.currentAssistant;
}

function finalizeAssistant() {
  state.currentAssistant = null;
}

function appendAssistantText(delta) {
  const a = ensureAssistant();
  a.markdownBuf += delta;
  a.bubble.innerHTML = renderMarkdown(a.markdownBuf);
  scrollToBottom();
}

function appendThinking(delta) {
  const a = ensureAssistant();
  let think = a.bubble.querySelector('.thinking.live');
  if (!think) {
    think = document.createElement('div');
    think.className = 'thinking live';
    a.bubble.appendChild(think);
  }
  think.textContent += delta;
  scrollToBottom();
}

function toolIcon(name) {
  const map = {
    Bash: '⌘', Read: '📄', Write: '✎', Edit: '✎', Glob: '🔍',
    Grep: '🔍', Task: '⚙', WebFetch: '🌐', WebSearch: '🌐',
    TodoWrite: '☑', NotebookEdit: '✎',
  };
  return map[name] || '⚙';
}

function addToolCard(id, name, input) {
  const a = ensureAssistant();
  const card = document.createElement('div');
  card.className = 'tool';
  let target = '';
  if (input) {
    if (input.file_path) target = input.file_path;
    else if (input.command) target = input.command;
    else if (input.pattern) target = input.pattern;
    else if (input.description) target = input.description;
    else if (input.url) target = input.url;
  }
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${toolIcon(name)}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-target">${escapeHtml(truncate(target, 90))}</span>
      <span class="tool-status">运行中…</span>
    </div>
    <div class="tool-body collapsed"></div>`;
  const body = card.querySelector('.tool-body');
  if (input) body.textContent = JSON.stringify(input, null, 2);
  card.querySelector('.tool-head').onclick = () => body.classList.toggle('collapsed');
  a.bubble.appendChild(card);
  state.toolCards[id] = { el: card, body };
  scrollToBottom();
}

function completeToolCard(id, content, isError) {
  const card = state.toolCards[id];
  if (!card) return;
  const status = card.el.querySelector('.tool-status');
  status.textContent = isError ? '出错' : '完成';
  status.className = 'tool-status ' + (isError ? 'err' : 'ok');
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  card.body.textContent = truncate(text, 4000);
}

function addResultLine(text) {
  const el = document.createElement('div');
  el.className = 'result-line';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n) + '\n… (已截断)' : s;
}

function setBusyUI(busy) {
  state.busy = busy;
  $('btn-send').classList.toggle('hidden', busy);
  $('btn-stop').classList.toggle('hidden', !busy);
}

// ---------------------------------------------------------------------------
// stream-json event handling
// ---------------------------------------------------------------------------
api.on('chat:started', () => {});

api.on('chat:event', (event) => handleStreamEvent(event));

api.on('chat:raw', ({ line }) => {
  console.debug('[raw]', line);
});

api.on('chat:stderr', ({ text }) => {
  console.debug('[stderr]', text);
});

api.on('chat:exit', ({ code }) => {
  setBusyUI(false);
  finalizeAssistant();
  addMeta(`会话进程已退出 (code ${code})。点击「新会话」重新开始。`);
});

api.on('chat:error', ({ message }) => {
  setBusyUI(false);
  addMeta(`错误:${message}`);
});

function handleStreamEvent(event) {
  const t = event.type;

  // system init / meta
  if (t === 'system') {
    if (event.subtype === 'init') {
      // available at session start; keep quiet in UI
    }
    return;
  }

  // partial streaming deltas
  if (t === 'stream_event' && event.event) {
    handleAnthropicStreamEvent(event.event);
    return;
  }

  // full assistant message (arrives after streaming, or when partials off)
  if (t === 'assistant' && event.message) {
    handleAssistantMessage(event.message);
    return;
  }

  // tool results are delivered as user messages
  if (t === 'user' && event.message) {
    handleUserMessage(event.message);
    return;
  }

  // final turn result
  if (t === 'result') {
    setBusyUI(false);
    finalizeAssistant();
    if (event.total_cost_usd != null || event.duration_ms != null) {
      const parts = [];
      if (event.duration_ms != null) parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
      if (event.num_turns != null) parts.push(`${event.num_turns} 轮`);
      if (event.total_cost_usd != null) parts.push(`$${event.total_cost_usd.toFixed(4)}`);
      if (event.is_error) parts.push('（出错）');
      if (parts.length) addResultLine(parts.join(' · '));
    }
    return;
  }
}

// Anthropic-style incremental events (from --include-partial-messages)
function handleAnthropicStreamEvent(ev) {
  const type = ev.type;
  if (type === 'content_block_start') {
    const block = ev.content_block;
    if (block && block.type === 'tool_use') {
      addToolCard(block.id, block.name, block.input || null);
    }
    return;
  }
  if (type === 'content_block_delta') {
    const d = ev.delta;
    if (!d) return;
    if (d.type === 'text_delta') appendAssistantText(d.text);
    else if (d.type === 'thinking_delta') appendThinking(d.thinking);
    return;
  }
  if (type === 'message_stop') {
    // remove the "live" marker so next thinking block is separate
    const a = state.currentAssistant;
    if (a) {
      const live = a.bubble.querySelector('.thinking.live');
      if (live) live.classList.remove('live');
    }
    return;
  }
}

// Full assistant message: fill in tool inputs; render text if we had no partials
function handleAssistantMessage(message) {
  const content = message.content || [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      if (!state.toolCards[block.id]) {
        addToolCard(block.id, block.name, block.input || null);
      } else if (block.input) {
        state.toolCards[block.id].body.textContent = JSON.stringify(block.input, null, 2);
      }
    } else if (block.type === 'text') {
      const a = state.currentAssistant;
      if (!a || !a.markdownBuf) {
        // no streaming happened — render the whole text now
        appendAssistantText(block.text || '');
      }
    }
  }
}

// User message here means tool_result payloads
function handleUserMessage(message) {
  const content = message.content || [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      let text = '';
      if (typeof block.content === 'string') text = block.content;
      else if (Array.isArray(block.content)) {
        text = block.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      }
      completeToolCard(block.tool_use_id, text, block.is_error);
    }
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    $('view-' + view).classList.add('active');
    if (view === 'terminal') startTerminal();
  };
});

// ---------------------------------------------------------------------------
// Terminal (xterm + pty)
// ---------------------------------------------------------------------------
let term = null;
let fitAddon = null;

function startTerminal() {
  if (state.termStarted) { if (fitAddon) fitAddon.fit(); return; }
  state.termStarted = true;

  term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#14120f', foreground: '#ece7df', cursor: '#d97757' },
    cursorBlink: true,
  });
  if (window.FitAddon) {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  term.open($('terminal'));
  if (fitAddon) fitAddon.fit();

  term.onData((data) => api.termInput(data));
  api.on('term:data', ({ data }) => term.write(data));
  api.on('term:exit', ({ code }) => term.write(`\r\n[进程已退出: ${code}]\r\n`));
  api.on('term:error', ({ message }) => term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`));

  const { cols, rows } = term;
  api.termOpen({ cwd: state.cwd, cols, rows });

  window.addEventListener('resize', () => {
    if (fitAddon && $('view-terminal').classList.contains('active')) {
      fitAddon.fit();
      api.termResize({ cols: term.cols, rows: term.rows });
    }
  });
}

// ---------------------------------------------------------------------------
// API key modal
// ---------------------------------------------------------------------------
const apikeyModal = $('apikey-modal');
const apikeyInput = $('apikey-input');
const apikeyStatus = $('apikey-status');

async function openApiKeyModal() {
  apikeyInput.value = '';
  const info = await api.apiKeyGet();
  apikeyStatus.className = 'modal-status';
  apikeyStatus.textContent = info.configured
    ? `当前已配置 key(${info.hint})。输入新值覆盖,或留空保存以清除。`
    : '当前未配置 key。将回退使用系统 claude CLI 的登录状态(如有)。';
  apikeyModal.classList.remove('hidden');
  apikeyInput.focus();
}

function closeApiKeyModal() {
  apikeyModal.classList.add('hidden');
}

$('btn-apikey').onclick = openApiKeyModal;
$('btn-apikey-landing').onclick = openApiKeyModal;
$('apikey-cancel').onclick = closeApiKeyModal;
apikeyModal.addEventListener('click', (e) => {
  if (e.target === apikeyModal) closeApiKeyModal();
});
apikeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('apikey-save').click();
  if (e.key === 'Escape') closeApiKeyModal();
});

$('apikey-save').onclick = async () => {
  const key = apikeyInput.value.trim();
  await api.apiKeySet(key);
  apikeyStatus.className = 'modal-status ok';
  apikeyStatus.textContent = key ? 'API key 已保存。新会话生效。' : 'API key 已清除。';
  setTimeout(closeApiKeyModal, 900);
  // restart chat so the new key takes effect immediately (if a project is open)
  if (state.cwd) {
    await api.chatClose();
    await startChat();
  }
};

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
initLanding();

})();
