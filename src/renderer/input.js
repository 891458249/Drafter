// Composer: send, @file autocomplete, slash commands, image attachments,
// append-while-running.
import { api, state, $, escapeHtml, emit } from './state.js';
import { addUserMessage, setBusyUI } from './chat.js';

const inputEl = () => $('input');
const acEl = () => $('autocomplete');

let acItems = [];
let acIndex = 0;
let acKind = null;   // 'file' | 'cmd'
let acAnchor = 0;    // position where token starts

// --- send --------------------------------------------------------------------
export async function sendMessage() {
  const el = inputEl();
  const text = el.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.activeSid) return;

  let content;
  if (state.attachments.length) {
    content = [];
    for (const att of state.attachments) {
      content.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
    }
    if (text) content.push({ type: 'text', text });
  } else {
    content = text;
  }

  // 附件以缩略图形式回显(content 里含 base64 数据)
  addUserMessage(state.activeSid, content);
  el.value = '';
  el.style.height = 'auto';
  clearAttachments();
  hideAc();

  const ok = await api.sessSend(state.activeSid, content);
  if (!ok) {
    addUserMessage(state.activeSid, '(发送失败:会话未就绪)');
    return;
  }
  setBusyUI(true);
}

// --- attachments ----------------------------------------------------------------
function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.classList.toggle('hidden', state.attachments.length === 0);
  state.attachments.forEach((att, i) => {
    const d = document.createElement('div');
    d.className = 'attach-item';
    d.innerHTML = `<img src="data:${att.mediaType};base64,${att.data}" alt="" /><button class="rm">✕</button>`;
    d.querySelector('.rm').onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(d);
  });
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function addImageFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
  const reader = new FileReader();
  reader.onload = () => {
    const data = String(reader.result).split(',')[1];
    state.attachments.push({ mediaType: file.type, data, name: file.name });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

// --- autocomplete ----------------------------------------------------------------
async function updateAutocomplete() {
  const el = inputEl();
  const pos = el.selectionStart;
  const before = el.value.slice(0, pos);

  // slash command: line starts with '/'
  const slashMatch = before.match(/(?:^|\n)(\/[\w:-]*)$/);
  // @file token
  const atMatch = before.match(/(?:^|[\s(])@([\w./\\-]*)$/);

  if (slashMatch) {
    acKind = 'cmd';
    acAnchor = pos - slashMatch[1].length;
    if (!state.commandsCache) state.commandsCache = await api.cmdsList(state.cwd);
    const q = slashMatch[1].toLowerCase();
    acItems = state.commandsCache.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 12);
    showAc(acItems.map((c) => ({ name: c.name, desc: c.description || c.source || '' })));
    return;
  }
  if (atMatch) {
    acKind = 'file';
    acAnchor = pos - atMatch[1].length;
    if (!state.filesCache) state.filesCache = await api.filesList(state.cwd);
    const q = atMatch[1].toLowerCase().replace(/\\/g, '/');
    const scored = [];
    for (const f of state.filesCache) {
      const lf = f.toLowerCase();
      if (!q || lf.includes(q)) {
        scored.push({ f, score: lf.indexOf(q) === -1 ? 999 : (lf.split('/').pop().startsWith(q) ? 0 : lf.indexOf(q)) });
        if (scored.length > 400) break;
      }
    }
    scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length);
    acItems = scored.slice(0, 12).map((x) => x.f);
    showAc(acItems.map((f) => ({ name: f, desc: '' })));
    return;
  }
  hideAc();
}

function showAc(items) {
  const box = acEl();
  if (!items.length) { hideAc(); return; }
  acIndex = 0;
  box.innerHTML = items.map((it, i) => `
    <div class="ac-item${i === 0 ? ' selected' : ''}" data-i="${i}">
      <span class="ac-name">${escapeHtml(it.name)}</span>
      <span class="ac-desc">${escapeHtml(it.desc)}</span>
    </div>`).join('');
  box.classList.remove('hidden');
  for (const item of box.querySelectorAll('.ac-item')) {
    item.onclick = () => applyAc(+item.dataset.i);
  }
}

function hideAc() { acEl().classList.add('hidden'); acItems = []; acKind = null; }

function applyAc(i) {
  const el = inputEl();
  const item = acItems[i];
  if (item == null) return;
  const insert = acKind === 'cmd' ? (item.name || item) + ' ' : '@' + item + ' ';
  const pos = el.selectionStart;
  const start = acKind === 'cmd' ? acAnchor : acAnchor - 1; // include '@'
  el.value = el.value.slice(0, start) + insert + el.value.slice(pos);
  const newPos = start + insert.length;
  el.setSelectionRange(newPos, newPos);
  el.focus();
  hideAc();
}

function moveAc(delta) {
  const box = acEl();
  const items = box.querySelectorAll('.ac-item');
  if (!items.length) return;
  acIndex = (acIndex + delta + items.length) % items.length;
  items.forEach((it, i) => it.classList.toggle('selected', i === acIndex));
  items[acIndex].scrollIntoView({ block: 'nearest' });
}

// --- init ---------------------------------------------------------------------
export function init() {
  const el = inputEl();

  el.addEventListener('input', () => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    updateAutocomplete();
  });

  el.addEventListener('keydown', (e) => {
    const acOpen = !acEl().classList.contains('hidden');
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyAc(acIndex); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) { addImageFile(f); e.preventDefault(); }
      }
    }
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const f of e.dataTransfer.files) addImageFile(f);
    }
  });

  $('btn-send').onclick = sendMessage;
  $('btn-stop').onclick = async () => {
    if (state.activeSid) await api.sessInterrupt(state.activeSid);
  };
  $('btn-compact').onclick = async () => {
    if (!state.activeSid) return;
    addUserMessage(state.activeSid, '/compact');
    await api.sessSend(state.activeSid, '/compact');
  };

  // --- composer toolbar: add file / folder / image, per-session model ---
  $('btn-add-file').onclick = async () => {
    if (!state.activeSid) return;
    const paths = await api.pickFiles({});
    if (!paths.length) return;
    const s = state.sessions.get(state.activeSid);
    const pid = (s && s.meta.projectId) || state.projectId;
    const images = paths.filter((p) => /\.(png|jpe?g|gif|webp)$/i.test(p));
    const others = paths.filter((p) => !/\.(png|jpe?g|gif|webp)$/i.test(p));
    for (const img of images) {
      const r = await api.fileReadImage(img);
      if (r.ok) state.attachments.push({ mediaType: r.mediaType, data: r.data, name: r.name });
    }
    if (images.length) renderAttachments();
    if (others.length) {
      if (pid) await api.projAddFiles(pid, others, 'editable'); // register with editable tag
      el.value += (el.value && !el.value.endsWith(' ') ? ' ' : '') + others.map((p) => '@' + p).join(' ') + ' ';
      el.dispatchEvent(new Event('input'));
      emit('project-files-changed', pid);
    }
    el.focus();
  };

  $('btn-add-folder').onclick = async () => {
    if (!state.activeSid) return;
    const res = await api.pickDir();
    if (!res || !res.dir) return;
    const s = state.sessions.get(state.activeSid);
    const pid = (s && s.meta.projectId) || state.projectId;
    if (pid) await api.projAddDir(pid, res.dir);
    // take effect immediately in the running session
    await api.sessSend(state.activeSid, '/add-dir ' + res.dir);
    addUserMessage(state.activeSid, '/add-dir ' + res.dir);
    emit('project-files-changed', pid);
    el.focus();
  };

  $('btn-add-image').onclick = async () => {
    const paths = await api.pickFiles({ imagesOnly: true });
    for (const p of paths) {
      const r = await api.fileReadImage(p);
      if (r.ok) state.attachments.push({ mediaType: r.mediaType, data: r.data, name: r.name });
      else alert(r.error);
    }
    if (paths.length) renderAttachments();
    el.focus();
  };

  $('model-sel-composer').onchange = async () => {
    if (!state.activeSid) return;
    const model = $('model-sel-composer').value || null;
    await api.sessSetModel(state.activeSid, model);
    const s = state.sessions.get(state.activeSid);
    if (s) s.meta.model = model;
    $('model-sel').value = model || '';
    emit('session-status', { sid: state.activeSid });
  };

  // 会话级推理深度:仅约束当前会话,空值 = 跟随 SDK/模型默认
  $('effort-sel-composer').onchange = async () => {
    if (!state.activeSid) return;
    const effort = $('effort-sel-composer').value || null;
    await api.sessSetEffort(state.activeSid, effort);
    const s = state.sessions.get(state.activeSid);
    if (s) s.meta.effort = effort;
  };
}
