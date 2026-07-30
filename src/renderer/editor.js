// Editor panel: open (from chat file links or diff), edit, save, external-change warning.
import { api, state, $, on } from './state.js';

let current = null; // { rel, abs, mtimeMs, dirty }

export async function openFile(rel) {
  const res = await api.fileRead({ cwd: state.cwd, path: rel });
  const area = $('editor-area');
  const warn = $('editor-warning');
  warn.classList.add('hidden');
  if (!res.ok) {
    $('editor-path').textContent = rel + ' — ' + res.error;
    area.value = ''; area.disabled = true;
    $('btn-editor-save').disabled = true;
    return;
  }
  if (current) api.fileUnwatch('editor');
  current = { rel, abs: res.path, mtimeMs: res.mtimeMs, dirty: false };
  $('editor-path').textContent = rel;
  area.value = res.content;
  area.disabled = false;
  $('btn-editor-save').disabled = true;
  api.fileWatch({ key: 'editor', path: res.path });
  showPanel('editor');
}

function showPanel(name) {
  $('right-panel').classList.remove('hidden');
  for (const t of document.querySelectorAll('.ptab')) t.classList.toggle('active', t.dataset.panel === name);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === 'panel-' + name);
}

async function save(force = false) {
  if (!current) return;
  const res = await api.fileSave({
    cwd: state.cwd, path: current.rel,
    content: $('editor-area').value,
    mtimeMs: current.mtimeMs, force,
  });
  const warn = $('editor-warning');
  if (res.ok) {
    current.mtimeMs = res.mtimeMs;
    current.dirty = false;
    $('btn-editor-save').disabled = true;
    warn.classList.add('hidden');
  } else if (res.conflict) {
    warn.classList.remove('hidden');
    warn.innerHTML = '⚠ 文件已被外部修改。';
    const reload = document.createElement('button');
    reload.className = 'btn btn-sm'; reload.textContent = '放弃我的修改并重新加载';
    reload.onclick = () => openFile(current.rel);
    const overwrite = document.createElement('button');
    overwrite.className = 'btn btn-sm'; overwrite.textContent = '仍然覆盖保存';
    overwrite.onclick = () => save(true);
    warn.appendChild(reload); warn.appendChild(overwrite);
  } else {
    warn.classList.remove('hidden');
    warn.textContent = '保存失败:' + res.error;
  }
}

export function init() {
  $('editor-area').addEventListener('input', () => {
    if (!current) return;
    current.dirty = true;
    $('btn-editor-save').disabled = false;
  });
  $('editor-area').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  $('btn-editor-save').onclick = () => save();

  api.on('file:changed', ({ key }) => {
    if (key !== 'editor' || !current) return;
    const warn = $('editor-warning');
    if (current.dirty) {
      warn.classList.remove('hidden');
      warn.textContent = '⚠ 文件已被外部修改(可能是 Claude 编辑了它)。保存时将提示如何处理。';
    } else {
      // auto-reload clean buffer
      openFile(current.rel);
    }
  });

  on('open-file', (rel) => openFile(rel));
}
