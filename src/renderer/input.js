// Composer: send, @file autocomplete, slash commands, image attachments,
// append-while-running.
import { api, state, $, escapeHtml, emit, on, parseModelValue, updateKeyChips, MEDIA_KINDS } from './state.js';
import { addUserMessage, setBusyUI, aigcLocalEcho, aigcBusy, updateAigcSendUI, updateTopbarForSession } from './chat.js';
import { refreshList } from './sessions-ui.js';

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

  // 新媒体板块会话:走 AIGC 生成任务闭环,不进 Agent SDK
  const sess = state.sessions.get(state.activeSid);
  if (sess && MEDIA_KINDS.includes(sess.meta.kind)) return sendAigcMessage(sess, text);

  let content;
  if (state.attachments.length) {
    const images = state.attachments.filter((a) => a.kind === 'image');
    const media = state.attachments.filter((a) => a.kind === 'media');
    const files = state.attachments.filter((a) => a.kind === 'file');
    // 文本附件只按路径引用(v0.9.27):内容不内联、UI 只显示文件卡片,
    // 由 AI 用 Read 工具按路径自行查看(大文件不再撑爆 UI 篇幅)
    let fullText = text || '';
    for (const f of files) {
      if (f.path) {
        fullText += `${fullText ? '\n\n' : ''}<附件 name="${f.name}" path="${f.path}">内容未内联,请使用 Read 工具读取该路径查看文件内容</附件>`;
      } else {
        // 兜底:无路径的旧形态(理论上 v0.9.27 起不再产生)
        fullText += `${fullText ? '\n\n' : ''}<附件 name="${f.name}">\n${f.text}\n</附件>`;
      }
    }
    if (images.length || media.length) {
      content = [];
      for (const att of images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
      }
      // 音频/视频/3D:只发 media_ref(路径),主进程读取后经辅助模型分析/元信息兜底注入
      for (const m of media) {
        content.push({ type: 'media_ref', mediaKind: m.mediaKind, name: m.name, path: m.path, size: m.size });
      }
      if (fullText) content.push({ type: 'text', text: fullText });
    } else {
      content = fullText;
    }
  } else {
    content = text;
  }

  // 附件以缩略图形式回显(content 里含 base64 数据)
  const echoEl = addUserMessage(state.activeSid, content);
  el.value = '';
  el.style.height = 'auto';
  clearAttachments();
  hideAc();

  const res = await api.sessSend(state.activeSid, content);
  if (!res) {
    addUserMessage(state.activeSid, '(发送失败:会话未就绪)');
    return;
  }
  // 回填消息锚点 uuid(v0.9.9):live 回显先于主进程打戳,拿到后补挂(右键编辑/分支依赖)
  if (typeof res === 'string' && echoEl) {
    echoEl.dataset.uuid = res;
    if (echoEl._umsg) echoEl._umsg.uuid = res;
  }
  setBusyUI(true);
}

// 新媒体板块发送:prompt + 参考图(仅 image/video 板块)→ aigc:send;
// 发送后锁定发送按钮,直到任务卡片到终态(aigc:status 事件)才解锁
async function sendAigcMessage(sess, text) {
  const el = inputEl();
  const kind = sess.meta.kind;
  if (aigcBusy(sess.meta.id)) return; // 任务进行中不并发发(按钮已禁用,双保险)
  if (!text) return; // 媒体生成必须有提示词
  // 参考图:仅 image/video 板块使用图片附件;文本/媒体附件对媒体生成无意义,直接忽略
  const refImages = (kind === 'image' || kind === 'video')
    ? state.attachments.filter((a) => a.kind === 'image').map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }))
    : [];
  el.value = '';
  el.style.height = 'auto';
  clearAttachments();
  hideAc();
  const r = await api.aigcSend({
    sessionId: sess.meta.id,
    keyId: sess.meta.keyId,
    model: sess.meta.model,
    prompt: text,
    refImages,
  });
  if (!r || !r.ok) {
    addUserMessage(sess.meta.id, '(发送失败:' + ((r && r.error) || '未知错误') + ')');
    return;
  }
  aigcLocalEcho(sess.meta.id, { traceId: r.traceId, prompt: text, refImages, model: sess.meta.model });
  updateAigcSendUI();
}

// --- attachments ----------------------------------------------------------------
// 附件形态:图片(content block 原生视觉)、文本文件(只按路径引用,AI 自行 Read,
// v0.9.27 起不再内联内容)、音频/视频/3D 媒体(media_ref 路径)。
// 附件随下一条消息发送后清空;文件夹是项目级常驻共享,走另一条通道。
const TEXT_EXTS = new Set(('md,txt,js,mjs,cjs,ts,jsx,tsx,json,py,css,html,htm,sh,bash,ps1,bat,cmd,'
  + 'yml,yaml,toml,ini,cfg,conf,log,csv,xml,svg,c,h,cpp,hpp,java,go,rs,rb,php,vue,sql,'
  + 'gitignore,env,example,lock,diff,patch').split(','));

// 音频/视频/3D 媒体附件(v0.9.1):renderer 只保留文件路径,不读 base64;
// 发送时组 media_ref 块,由主进程读取并经辅助模型分析/元信息兜底注入
const MEDIA_EXTS = { audio: ['mp3', 'wav', 'm4a', 'ogg'], video: ['mp4', 'mov', 'webm'], model: ['glb', 'obj', 'fbx'] };
const MEDIA_ICON = { audio: '🎵', video: '🎬', model: '🧊' };

function mediaKindOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  for (const k of Object.keys(MEDIA_EXTS)) if (MEDIA_EXTS[k].includes(ext)) return k;
  return null;
}

function fmtSize(n) {
  if (!n) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

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
    d.className = 'attach-item' + (att.kind === 'image' ? '' : ' attach-file');
    if (att.kind === 'file') {
      d.innerHTML = `<span class="af-icon">📄</span><span class="af-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span><button class="rm">✕</button>`;
    } else if (att.kind === 'media') {
      // 媒体附件:文件名片(图标+文件名+大小),非图片预览
      d.innerHTML = `<span class="af-icon">${MEDIA_ICON[att.mediaKind] || '📎'}</span><span class="af-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span><span class="af-size">${fmtSize(att.size)}</span><button class="rm">✕</button>`;
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

// 文本附件统一入口(v0.9.27):只登记路径(未知扩展名采样 4KB 做二进制检测),
// 内容不读进 renderer——大文件不再撑爆 UI;AI 发送时收到路径引用,自行 Read
async function addTextFileByPath(p, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!TEXT_EXTS.has(ext)) {
    const s = await api.fileSample(p);
    if (!s || !s.ok) { alert('无法读取文件:' + ((s && s.error) || name)); return; }
    if (!looksTextual(s.sample)) {
      alert(`不支持的二进制文件:${name}(附件支持图片、文本、音频/视频/3D 文件)`);
      return;
    }
  }
  state.attachments.push({ kind: 'file', name, path: p });
  renderAttachments();
}

// 粘贴/拖拽/＋附件 的统一入口:图片走 base64,媒体保留路径,文本文件按路径引用,其余二进制拒收
function addAnyFile(file) {
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return addImageFile(file);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mk = mediaKindOf(file.name);
  if (mk) {
    // 拖拽/粘贴来的媒体文件:取本地路径(Electron 32+ 移除 File.path,走 preload 的 webUtils)
    const p = api.pathForFile ? api.pathForFile(file) : '';
    if (!p) {
      alert(`无法获取文件路径:${file.name}(请用输入框左侧的附件按钮选择该文件)`);
      return;
    }
    state.attachments.push({ kind: 'media', mediaKind: mk, name: file.name, path: p, size: file.size || 0 });
    renderAttachments();
    return;
  }
  // 文本文件:优先取磁盘路径;粘贴内容无路径时,落盘 userData/attachments/ 再按路径引用
  const p = api.pathForFile ? api.pathForFile(file) : '';
  if (p) return addTextFileByPath(p, file.name);
  const reader = new FileReader();
  reader.onload = async () => {
    const text = String(reader.result);
    if (!TEXT_EXTS.has(ext) && !looksTextual(text)) {
      alert(`不支持的二进制文件:${file.name}(附件支持图片、文本、音频/视频/3D 文件)`);
      return;
    }
    const r = await api.fileSavePasted({ name: file.name, content: text });
    if (!r || !r.ok) { alert('附件暂存失败:' + ((r && r.error) || '未知错误')); return; }
    state.attachments.push({ kind: 'file', name: file.name, path: r.path });
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
        if (f) { addAnyFile(f); e.preventDefault(); } // 图片走 base64;粘贴的媒体文件一般无路径,会提示改用附件按钮
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
      const mk = mediaKindOf(name);
      if (/\.(png|jpe?g|gif|webp)$/i.test(p)) {
        const r = await api.fileReadImage(p);
        if (r.ok) state.attachments.push({ kind: 'image', mediaType: r.mediaType, data: r.data, name: r.name });
        else alert(r.error);
      } else if (mk) {
        // 音频/视频/3D:只保留路径与大小,本体在发送时由主进程读取(避免大文件两次过 IPC)
        const st = await api.fileStat(p);
        if (!st.ok) { alert(st.error); continue; }
        state.attachments.push({ kind: 'media', mediaKind: mk, name, path: p, size: st.size });
      } else {
        // 文本文件(v0.9.27):只登记路径,内容不读进 UI
        await addTextFileByPath(p, name);
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
    if (pid) {
      await api.projAddDir(pid, res.dir);
      await sendAddDir(res.dir);
      emit('project-files-changed', pid);
      renderFolderChips();
      el.focus();
      return;
    }
    // 独立会话(v0.9.1):弹窗确认是否把该文件夹设为项目文件夹
    const choice = await askAdoptDir(res.dir);
    if (choice === 'cancel') { el.focus(); return; }
    if (choice === 'project') {
      const p = await api.projAdoptDir(state.activeSid, res.dir);
      if (s) { s.meta.projectId = p.id; s.meta.standalone = false; s.meta.cwd = res.dir; }
      state.projectId = p.id;
      state.cwd = res.dir; // 主工作目录已切到项目目录(v0.9.7),顶栏/文件列表同步跟随
      state.filesCache = null;
      state.commandsCache = null;
      await sendAddDir(res.dir);
      emit('project-files-changed', p.id);
      renderFolderChips();
      refreshList(); // 侧栏出现以文件夹命名的项目
    } else {
      await sendAddDir(res.dir); // 仅添加目录:保持独立会话
    }
    el.focus();
  };

// /add-dir 立即生效到运行中的会话并回显
async function sendAddDir(dir) {
  await api.sessSend(state.activeSid, '/add-dir ' + dir);
  addUserMessage(state.activeSid, '/add-dir ' + dir);
}

// 独立会话添加文件夹时的确认弹窗:'project' | 'dir' | 'cancel'
function askAdoptDir(dir) {
  return new Promise((resolve) => {
    const modal = $('adopt-dir-modal');
    $('adopt-dir-text').textContent =
      `将文件夹「${dir}」设为项目文件夹?设为后左侧将出现以文件夹命名的项目,当前会话归入该项目;也可以仅把它作为附加目录使用,会话保持独立。`;
    modal.classList.remove('hidden');
    const done = (v) => { modal.classList.add('hidden'); resolve(v); };
    $('adopt-dir-project').onclick = () => done('project');
    $('adopt-dir-only').onclick = () => done('dir');
    $('adopt-dir-cancel').onclick = () => done('cancel');
  });
}

  $('model-sel').onchange = async () => {
    if (!state.activeSid) return;
    const s = state.sessions.get(state.activeSid);
    if (((s && s.meta.kind) || 'code') !== state.section) return; // 板块/会话不匹配时不写模型(v0.9.5)
    const sel = parseModelValue($('model-sel').value);
    await api.sessSetModel(state.activeSid, sel.model, sel.keyId);
    if (s) { s.meta.model = sel.model; s.meta.keyId = sel.keyId; }
    updateKeyChips(); // 同步 Key chip
    updateTopbarForSession(state.activeSid); // 同步 placeholder 的模型身份
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
