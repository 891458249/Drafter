// 素材板块(v0.10.0):全部生成产物的归档网格(创作会话 + 画布节点两源)。
// md「素材库:生成历史自动归档」的雏形;「用作参考图」把图片产物塞回创作会话
// 附件区,打通 md 强调的图→视频跨模态主链路。
import { api, state, $, escapeHtml, MEDIA_TYPE_LABEL } from './state.js';
import { openViewer } from './msgmenu.js';
import { addImageAttachment } from './input.js';

let shop = 'all'; // 素材类型过滤(独立于创作板块的 state.mediaShop)
let items = [];   // 最近一次 assets:list 结果
let bound = false;

const KIND_ICON = { image: '🖼', video: '🎬', audio: '🎵', model: '🧊' };

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function thumbHtml(a) {
  const src = `aigc://${a.traceId}/${encodeURIComponent(a.name)}`;
  if (a.kind === 'image') return `<img src="${src}" loading="lazy" alt="" />`;
  if (a.kind === 'video') return `<video src="${src}" preload="metadata" muted></video>`;
  return `<span class="asset-big-ico">${KIND_ICON[a.kind] || '📦'}</span>`;
}

function cardHtml(a, i) {
  const src = `aigc://${a.traceId}/${encodeURIComponent(a.name)}`;
  return `<div class="asset-card" data-kind="${a.kind}" data-i="${i}">
    <div class="asset-thumb ${a.kind === 'image' ? 'is-img' : ''}" data-src="${a.kind === 'image' ? src : ''}" data-path="${escapeHtml(a.path)}">
      ${thumbHtml(a)}
      <span class="asset-kind-tag">${MEDIA_TYPE_LABEL[a.kind] || a.kind}</span>
    </div>
    <div class="asset-body">
      <div class="asset-prompt" title="${escapeHtml(a.prompt || a.name)}">${escapeHtml(a.prompt || a.name)}</div>
      <div class="asset-meta"><span>${escapeHtml(a.model || '')}</span><span>${fmtTs(a.ts)}</span></div>
      <div class="asset-origin" title="来源:${escapeHtml(a.originName)}">${a.origin === 'canvas' ? '🧩 画布' : '💬 会话'} · ${escapeHtml(a.originName)}</div>
    </div>
    <div class="asset-ops">
      ${a.kind === 'image' ? '<button class="btn btn-sm as-ref" title="作为参考图发到创作会话">用作参考图</button>' : ''}
      <button class="btn btn-sm as-open" title="系统程序打开">打开</button>
      <button class="btn btn-sm as-dir" title="打开所在文件夹">位置</button>
    </div>
  </div>`;
}

function applyFilter() {
  const q = ($('assets-search').value || '').trim().toLowerCase();
  const filtered = items
    .filter((a) => shop === 'all' || a.kind === shop)
    .filter((a) => !q || (a.prompt || '').toLowerCase().includes(q)
      || (a.name || '').toLowerCase().includes(q)
      || (a.model || '').toLowerCase().includes(q));
  const grid = $('assets-grid');
  grid.innerHTML = filtered.map((a, i) => cardHtml(a, i)).join('');
  $('assets-empty').classList.toggle('hidden', filtered.length > 0);
}

export async function refresh() {
  items = (await api.assetsList()) || [];
  applyFilter();
}

// 「用作参考图」:读盘 → 塞创作会话附件 → 跳创作板块聚焦输入框(md 图→视频链路)
async function attachAsRef(a) {
  const r = await api.fileReadImage(a.path);
  if (!r.ok) { alert('读取失败:' + (r.error || '')); return; }
  addImageAttachment({ name: r.name || a.name, mediaType: r.mediaType, data: r.data });
  document.querySelector('#section-switch button[data-sec="media"]').click();
  $('input').focus();
}

export function enterSection() {
  refresh();
}

function bind() {
  if (bound) return;
  bound = true;
  for (const b of document.querySelectorAll('#assets-filter button')) {
    b.onclick = () => {
      shop = b.dataset.shop;
      for (const x of document.querySelectorAll('#assets-filter button')) x.classList.toggle('active', x === b);
      applyFilter();
    };
  }
  $('assets-search').oninput = applyFilter;
  $('btn-assets-refresh').onclick = refresh;
  $('assets-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.asset-card');
    if (!card) return;
    const thumb = e.target.closest('.asset-thumb');
    if (thumb) {
      // 图片点击放大(复用 #img-viewer);视频点击系统打开;音/3D 点整卡打开
      if (thumb.dataset.src) { openViewer(thumb.dataset.src); return; }
      const media = thumb.querySelector('video');
      if (media) { api.openPath(thumb.dataset.path); return; }
      if (thumb.dataset.path) api.openPath(thumb.dataset.path);
      return;
    }
    const a = currentVisible()[Number(card.dataset.i) || 0];
    if (!a) return;
    if (e.target.closest('.as-ref')) attachAsRef(a);
    else if (e.target.closest('.as-open')) api.openPath(a.path);
    else if (e.target.closest('.as-dir')) api.shellShowItemInFolder(a.path);
  });
}

// 当前过滤后的可见条目(操作条按索引回查)
function currentVisible() {
  const q = ($('assets-search').value || '').trim().toLowerCase();
  return items
    .filter((a) => shop === 'all' || a.kind === shop)
    .filter((a) => !q || (a.prompt || '').toLowerCase().includes(q)
      || (a.name || '').toLowerCase().includes(q)
      || (a.model || '').toLowerCase().includes(q));
}

export function init() {
  bind();
}
