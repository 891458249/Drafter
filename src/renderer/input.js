// Composer: send, @file autocomplete, slash commands, image attachments,
// append-while-running.
import { api, state, $, escapeHtml, emit, on } from './state.js';
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
    const images = state.attachments.filter((a) => a.kind !== 'file');
    const files = state.attachments.filter((a) => a.kind === 'file');
    // 文本附件内联进消息文本(图片仍走原生 content block)
    let fullText = text || '';
    for (const f of files) {
      fullText += `${fullText ? '\n\n' : ''}<附件 name="${f.name}">\n${f.text}\n</附件>`;
    }
    if (images.length) {
      content = [];
      for (const att of images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
      }
      if (fullText) content.push({ type: 'text', text: fullText });
    } else {
      content = fullText;
    }
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
// 附件两种形态:图片(content block 原生视觉)与文本文件(内联进消息文本)。
// 附件随下一条消息发送后清空;文件夹是项目级常驻共享,走另一条通道。
const FILE_ATTACH_LIMIT = 50 * 1024; // 文本附件截断阈值
const TEXT_EXTS = new Set(('md,txt,js,mjs,cjs,ts,jsx,tsx,json,py,css,html,htm,sh,bash,ps1,bat,cmd,'
  + 'yml,yaml,toml,ini,cfg,conf,log,csv,xml,svg,c,h,cpp,hpp,java,go,rs,rb,php,vue,sql,'
  + 'gitignore,env,example,lock,diff,patch').split(','));

function looksTextual(content) {
  if (content.includes('\uFFFD') || content.includes('\0')) return false;
  const sample = content.slice(0, 2000);
  const controls = (sample.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
  return controls < sample.length * 0.02;
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.classList.toggle('hidden', state.attachments.length === 0);
  state.attachments.forEach((att, i) => {
    const d = document.createElement('div');
    d.className = 'attach-item' + (att.kind === 'file' ? ' attach-file' : '');
    if (att.kind === 'file') {
      d.innerHTML = `<span class="af-icon">📄</span><span class="af-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span><button class="rm">✕</button>`;
    } else {
      d.innerHTML = `<img src="data:${att.mediaType};base64,${att.data}" alt="" /><button class="rm">✕</button>`;
    }
    d.querySelector('.rm').onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(d);
  });
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

// 项目文件夹常驻 chips(输入框上方):当前会话所属项目组共享的目录
async function renderFolderChips() {
  const box = $('folder-chips');
  if (!box) return;
  const s = state.sessions.get(state.activeSid);
  const pid = (s && s.meta.projectId) || null;
  if (!pid) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  try {
    const projs = await api.projList();
    const p = projs.find((x) => x.id === pid);
    const dirs = (p && p.dirs) || [];
    if (!dirs.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = dirs.map((d) =>
      `<span class="folder-chip" title="${escapeHtml(d)}">📂 ${escapeHtml(d.split(/[\\/]/).filter(Boolean).pop() || d)}</span>`
    ).join('');
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

function addImageFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return addAnyFile(file);
  const reader = new FileReader();
  reader.onload = () => {
    const data = String(reader.result).split(',')[1];
    state.attachments.push({ kind: 'image', mediaType: file.type, data, name: file.name });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

// 粘贴/拖拽/＋附件 的统一入口:图片走 base64,文本文件读内容,二进制拒收
function addAnyFile(file) {
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return addImageFile(file);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result);
    if (!TEXT_EXTS.has(ext) && !looksTextual(text)) {
      alert(`不支持的二进制文件:${file.name}(附件仅支持图片与文本类文件)`);
      return;
    }
    if (text.length > FILE_ATTACH_LIMIT) {
      text = text.slice(0, FILE_ATTACH_LIMIT) + `\n… (已截断,原 ${text.length} 字符)`;
    }
    state.attachments.push({ kind: 'file', name: file.name, text });
    renderAttachments();
  };
  reader.readAsText(file);
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
      for (const f of e.dataTransfer.files) addAnyFile(f); // 拖拽:图片与文本文件均可
    }
  });

  // --- 项目文件夹常驻显示(输入框上方):表示当前项目共享了哪些目录 ---
  on('session-activated', renderFolderChips);
  on('project-files-changed', renderFolderChips);

  $('btn-send').onclick = sendMessage;
  $('btn-stop').onclick = async () => {
    if (state.activeSid) await api.sessInterrupt(state.activeSid);
  };
  $('btn-compact').onclick = async () => {
    if (!state.activeSid) return;
    addUserMessage(state.activeSid, '/compact');
    await api.sessSend(state.activeSid, '/compact');
  };

  // --- composer toolbar: attachments / folder / per-session model & effort ---
  $('btn-add-attach').onclick = async () => {
    if (!state.activeSid) return;
    const paths = await api.pickFiles({});
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop();
      if (/\.(png|jpe?g|gif|webp)$/i.test(p)) {
        const r = await api.fileReadImage(p);
        if (r.ok) state.attachments.push({ kind: 'image', mediaType: r.mediaType, data: r.data, name: r.name });
        else alert(r.error);
      } else {
        const r = await api.fileRead({ cwd: state.cwd, path: p });
        if (!r.ok) { alert(r.error); continue; }
        let text = r.content;
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (!TEXT_EXTS.has(ext) && !looksTextual(text)) {
          alert(`不支持的二进制文件:${name}(附件仅支持图片与文本类文件)`);
          continue;
        }
        if (text.length > FILE_ATTACH_LIMIT) {
          text = text.slice(0, FILE_ATTACH_LIMIT) + `\n… (已截断,原 ${r.content.length} 字符)`;
        }
        state.attachments.push({ kind: 'file', name, text });
      }
    }
    if (paths.length) renderAttachments();
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
    renderFolderChips();
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
