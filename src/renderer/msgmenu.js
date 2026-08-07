// 消息区右键菜单与图片查看模式(v0.9.8):
// - 文本消息右键:复制(有选区复制选区,否则复制整条)/ 引用(markdown 引用块填入输入框)
// - 图片(用户附件缩略图 .msg-img / 生成产物 .aigc-media)右键:查看 / 复制图片;双击进入查看模式
// - 用户消息右键(v0.9.9):修改并重新生成(截断其下所有消息)/ 从此消息分支(复制上文为新会话)
import { $, showCtxMenu } from './state.js';
import { addUserMessage, renderUserBubble, truncateAfter, ensureSession, setActiveSession } from './chat.js';
import { refreshList } from './sessions-ui.js';

// 提取一条消息的纯文本:剔除工具进程组/任务卡片/思考块/代码卡片头部条,只保留正文
function msgText(msgEl) {
  const bubble = msgEl.querySelector('.bubble');
  if (!bubble) return '';
  const clone = bubble.cloneNode(true);
  for (const el of clone.querySelectorAll('.activity, .tool, .task-group, .aigc-card, .thinking, .code-card-head')) el.remove();
  return (clone.innerText || '').trim();
}

// 选区完全落在该消息内时返回选中文本,否则空串
function selectionTextIn(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  if (el.contains(sel.anchorNode) && el.contains(sel.focusNode)) return sel.toString().trim();
  return '';
}

async function copyText(t) {
  if (!t) return;
  try { await navigator.clipboard.writeText(t); }
  catch (err) { console.error('复制失败:', err); }
}

// 引用:以 markdown 引用块填入输入框末尾并聚焦,随下一条消息发出
function quote(t) {
  if (!t) return;
  const el = $('input');
  const block = t.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
  el.value = el.value ? el.value.replace(/\n*$/, '\n') + block : block;
  el.focus();
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  el.setSelectionRange(el.value.length, el.value.length);
}

// 复制图片:fetch 取回 blob(兼容 data: 与 aigc://)→ 位图 → 转 PNG 写剪贴板
async function copyImage(img) {
  try {
    const blob = await (await fetch(img.src)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    img.classList.add('copied');
    setTimeout(() => img.classList.remove('copied'), 600);
  } catch (err) { console.error('复制图片失败:', err); }
}

// --- 图片查看模式(#img-viewer 复用 modal-mask:Esc/点空白关闭,滚轮缩放) ---
let zoom = 1;
function setZoom(z) {
  zoom = Math.min(8, Math.max(0.1, z));
  $('img-viewer').querySelector('img').style.transform = `scale(${zoom})`;
}

function openViewer(src) {
  const v = $('img-viewer');
  v.querySelector('img').src = src;
  setZoom(1);
  v.classList.remove('hidden');
}

const isMsgImg = (t) => t && t.closest && t.closest('img.msg-img, img.aigc-media');

// --- 修改并重新生成 / 从此消息分支(v0.9.9) -----------------------------------
// 操作失败:在可见会话日志末尾落一条错误行(复用 meta-line 样式)
function errLine(msg) {
  const logEl = $('messages').querySelector('.session-log:not(.hidden)');
  if (!logEl) { alert('操作失败:' + msg); return; }
  const el = document.createElement('div');
  el.className = 'meta-line error-line';
  el.textContent = '操作失败:' + msg;
  logEl.appendChild(el);
  el.scrollIntoView({ block: 'end' });
}

function startInlineEdit(msg) {
  if (msg.querySelector('.msg-edit-area')) return;
  const u = msg._umsg;
  const text = typeof u.content === 'string' ? u.content
    : (Array.isArray(u.content) ? (u.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')) : '');
  const bubble = msg.querySelector('.bubble');
  bubble.classList.add('hidden');
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit-area';
  ta.value = text;
  const ops = document.createElement('div');
  ops.className = 'msg-edit-ops';
  ops.innerHTML = `<button class="btn btn-sm" data-op="cancel">取消</button>
    <button class="btn btn-sm btn-primary" data-op="save">保存并重新生成</button>`;
  msg.appendChild(ta);
  msg.appendChild(ops);
  const close = (restore) => {
    ta.remove(); ops.remove();
    if (restore) bubble.classList.remove('hidden');
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(true); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ops.querySelector('[data-op="save"]').click(); }
  });
  ops.querySelector('[data-op="cancel"]').onclick = () => close(true);
  ops.querySelector('[data-op="save"]').onclick = async () => {
    const newText = ta.value.trim();
    if (!newText) return; // 编辑后不能为空消息
    close(false);
    bubble.textContent = '⏳ 重新生成中…';
    bubble.classList.remove('hidden');
    await applyEdit(msg, u, newText);
  };
  ta.focus();
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

async function applyEdit(msg, u, newText) {
  const logEl = msg.closest('.session-log');
  const sid = logEl && logEl.dataset.sid;
  const bubble = msg.querySelector('.bubble');
  let newContent;
  if (typeof u.content === 'string') {
    newContent = newText;
  } else if (Array.isArray(u.content)) {
    // 附件(图片/媒体)原样保留,替换全部文本块
    newContent = [...u.content.filter((b) => b && b.type !== 'text'), { type: 'text', text: newText }];
  } else {
    bubble.textContent = '(该消息不含可编辑的文本)';
    return;
  }
  const r = await window.api.sessEditRegenerate({ sid, echoUuid: u.uuid, content: newContent, echoContent: newContent });
  if (!r || !r.ok) {
    renderUserBubble(bubble, u.content);
    errLine((r && r.error) || '未知错误');
    return;
  }
  // 本地 UI 截断:目标消息换为编辑后的内容,其下所有消息移除;主进程日志已同步截断
  truncateAfter(sid, msg);
  addUserMessage(sid, newContent, r.uuid);
}

async function branchFrom(msg) {
  const logEl = msg.closest('.session-log');
  const sid = logEl && logEl.dataset.sid;
  const u = msg._umsg;
  const r = await window.api.sessBranch({ sid, echoUuid: u.uuid });
  if (!r || !r.ok) { errLine((r && r.error) || '未知错误'); return; }
  ensureSession(r.meta.id, r.meta);
  setActiveSession(r.meta.id);
  refreshList();
  if (r.warning) { // 分支已生成,仅提示降级原因(不走 errLine 的失败样式)
    const logEl2 = $('messages').querySelector('.session-log:not(.hidden)');
    if (logEl2) {
      const d = document.createElement('div');
      d.className = 'meta-line';
      d.textContent = '提示:' + r.warning;
      logEl2.appendChild(d);
    }
  }
}

export function init() {
  const box = $('messages');

  box.addEventListener('contextmenu', (e) => {
    const img = isMsgImg(e.target);
    if (img && box.contains(img)) {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '查看图片', onClick: () => openViewer(img.src) },
        { label: '复制图片', onClick: () => copyImage(img) },
      ]);
      return;
    }
    const msg = e.target.closest && e.target.closest('.msg');
    if (!msg || !box.contains(msg)) return;
    e.preventDefault();
    const sel = selectionTextIn(msg);
    const full = msgText(msg);
    const items = [
      { label: sel ? '复制所选' : '复制', onClick: () => copyText(sel || full) },
      { label: '引用', onClick: () => quote(sel || full) },
    ];
    // 用户消息追加编辑/分支(v0.9.9);依赖消息锚点 uuid,旧版本消息给出提示
    if (msg.classList.contains('user') && msg._umsg) {
      const u = msg._umsg;
      const noAnchor = { disabled: true, hint: '该消息由旧版本创建,缺少定位锚点' };
      items.push('-');
      items.push(u.uuid
        ? { label: '修改并重新生成…', onClick: () => startInlineEdit(msg) }
        : { label: '修改并重新生成…', ...noAnchor });
      items.push(u.uuid
        ? { label: '从此消息分支', onClick: () => branchFrom(msg) }
        : { label: '从此消息分支', ...noAnchor });
    }
    showCtxMenu(e.clientX, e.clientY, items);
  });

  box.addEventListener('dblclick', (e) => {
    const img = isMsgImg(e.target);
    if (img && box.contains(img)) openViewer(img.src);
  });

  const viewer = $('img-viewer');
  viewer.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  viewer.addEventListener('dblclick', (e) => {
    if (e.target.tagName === 'IMG') setZoom(1); // 双击图面复位缩放
  });
}
