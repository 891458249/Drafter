// 拆分子任务(v0.15.9 起为开关模式,v0.15.10 移到发送按钮旁):激活「⧉」开关后,
// 用户发出的下一条消息不会直接发送,而是由当前会话的 AI 先做「一轮判断」再拆分:
//   parallel = 互不依赖、现在就能开工 → 确认后每条新建一个并行 code 会话(继承当前
//              会话的项目/cwd/模型/Key/权限/Gem)并各自执行;
//   wait     = 要等某个会话先完成   → 不建会话,排入那个会话的消息队列,它当前回合
//              结束后自动接着执行。
// v0.15.18(用户要求):此前是无脑拆——不管有没有依赖、别的会话是不是正在改同一处,
// 一律各建一个并行会话,会话数上去了开发并没有变快。现在判断依据除了子任务之间的
// 依赖,还包括项目组内其他并行会话的现状(标题/是否进行中/最近在做),弹窗里每条都能
// 改「并行 / 等待」与等待目标,再确认。再次点击开关即关闭。

import { api, state, $, escapeHtml } from './state.js';
import { ensureSession } from './chat.js';
import { refreshList } from './sessions-ui.js';

let armed = false;
let pending = null;      // { resolve } —— 发送被本模块接管时挂起的承诺(见 maybeSplitOnSend)
let splitSid = null;     // 本次拆分所属会话(打开卡片时的活跃会话)
let others = [];         // 判断时列出的其他并行会话快照 [{ key, id, title, busy }]
let resultShown = false; // 卡片是否已切到「落地结果」视图

export function isArmed() { return armed; }

function syncToggle() {
  const btn = $('btn-split-subtasks');
  if (!btn) return;
  btn.classList.toggle('split-on', armed);
  btn.title = armed
    ? '拆分子任务已激活:下一条消息会先由 AI 判断能否并行——能并行的建新会话,需等待的排入对应会话队列;点击关闭'
    : '拆分子任务:激活后,下一条消息会先由 AI 判断能否并行——能并行的建新会话,需等待的排入对应会话队列;再次点击关闭';
}

// --- 行渲染 ------------------------------------------------------------------

// 把模型给的 waitFor 引用换成本地下拉框的值:'current' | '#n' | 'session:<id>'
// (主进程侧 split-subtasks.normWaitFor 是同一套语义的另一份实现,渲染端不能 require)
function waitValueOf(waitFor) {
  const s = String(waitFor == null ? '' : waitFor).trim();
  if (!s || /^(current|self|this|当前|当前会话|本会话)$/i.test(s)) return 'current';
  let m = s.match(/^s\s*(\d+)$/i);
  if (m) { const t = others[Number(m[1]) - 1]; return t ? 'session:' + t.id : 'current'; }
  m = s.match(/^(?:#|subtask\s*#?|子任务\s*#?)?\s*(\d+)$/i);
  if (m) return '#' + m[1];
  if (/^s_[A-Za-z0-9_-]+$/.test(s)) return 'session:' + s;
  return 'current';
}

function rowEl(t, i) {
  const row = document.createElement('div');
  row.className = 'split-row';
  row.innerHTML =
    `<div class="split-row-head"><span class="idx">${i + 1}</span>` +
    `<input class="split-title" maxlength="60" value="${escapeHtml(t.title || '')}" placeholder="子任务标题" />` +
    `<button class="btn btn-sm split-del" title="删除该子任务">删</button></div>` +
    `<textarea class="split-detail" placeholder="子任务说明(自包含,执行助手看不到原始需求)">${escapeHtml(t.detail || '')}</textarea>` +
    `<div class="split-row-foot">` +
    `<select class="split-mode" title="这条子任务怎么落地">` +
    `<option value="parallel">⧉ 并行执行 · 新建会话</option>` +
    `<option value="wait">⏳ 等待后执行 · 排入会话队列</option>` +
    `</select><select class="split-wait hidden" title="等谁先完成"></select>` +
    `</div>`;
  const modeSel = row.querySelector('.split-mode');
  const waitSel = row.querySelector('.split-wait');
  modeSel.value = t.mode === 'wait' ? 'wait' : 'parallel';
  // 模型给的等待目标先落在 dataset 上,fillWaitOptions 重建选项时据此回填
  row.dataset.waitFor = t.mode === 'wait' ? waitValueOf(t.waitFor) : 'current';
  waitSel.classList.toggle('hidden', modeSel.value !== 'wait');
  row.classList.toggle('split-waiting', modeSel.value === 'wait');
  modeSel.onchange = () => {
    waitSel.classList.toggle('hidden', modeSel.value !== 'wait');
    row.classList.toggle('split-waiting', modeSel.value === 'wait');
    refreshHint();
  };
  row.querySelector('.split-del').onclick = () => { row.remove(); renumber(); fillWaitOptions(); refreshHint(); };
  row.querySelector('.split-title').oninput = () => fillWaitOptions();
  return row;
}

function renumber() {
  [...$('split-list').querySelectorAll('.split-row')].forEach((r, i) => {
    r.querySelector('.idx').textContent = String(i + 1);
  });
}

// 重建所有行的「等待目标」下拉(增删/改名会改变可选项),尽量保留各行当前选择
function fillWaitOptions() {
  const rows = [...$('split-list').querySelectorAll('.split-row')];
  rows.forEach((row, i) => {
    const sel = row.querySelector('.split-wait');
    const want = sel.dataset.picked || row.dataset.waitFor || 'current';
    const opts = ['<option value="current">等当前会话(本次需求所在会话)</option>'];
    const sib = rows
      .map((r, j) => ({ j, title: r.querySelector('.split-title').value.trim() }))
      .filter((x) => x.j !== i);
    if (sib.length) {
      opts.push('<optgroup label="等本次拆分的其他子任务">');
      for (const x of sib) {
        opts.push(`<option value="#${x.j + 1}">等 #${x.j + 1}${x.title ? '「' + escapeHtml(x.title) + '」' : ''} 先完成</option>`);
      }
      opts.push('</optgroup>');
    }
    if (others.length) {
      opts.push('<optgroup label="等项目组内其他并行会话">');
      for (const o of others) {
        opts.push(`<option value="session:${escapeHtml(o.id)}">等「${escapeHtml(o.title)}」${o.busy ? '(进行中)' : ''} 结束</option>`);
      }
      opts.push('</optgroup>');
    }
    sel.innerHTML = opts.join('');
    sel.value = [...sel.options].some((o) => o.value === want) ? want : 'current';
    sel.dataset.picked = sel.value;
    sel.onchange = () => { sel.dataset.picked = sel.value; };
  });
}

function renderRows(tasks) {
  const list = $('split-list');
  list.innerHTML = '';
  (tasks || []).forEach((t, i) => list.appendChild(rowEl(t, i)));
  fillWaitOptions();
  refreshHint();
}

// 收集卡片内容为投递用的子任务数组
function collectTasks() {
  const rows = [...$('split-list').querySelectorAll('.split-row')];
  const byDom = new Map(); // DOM 行号 → 收集后的下标(空行不进列表,对它的引用随之作废)
  const tasks = [];
  const waits = [];
  rows.forEach((r, i) => {
    const title = r.querySelector('.split-title').value.trim();
    const detail = r.querySelector('.split-detail').value.trim();
    if (!title && !detail) { byDom.set(i, -1); return; }
    byDom.set(i, tasks.length);
    const mode = r.querySelector('.split-mode').value === 'wait' ? 'wait' : 'parallel';
    const t = { title: title || detail.slice(0, 60), detail: detail || title, mode };
    if (mode === 'wait') waits.push({ t, raw: r.querySelector('.split-wait').value || 'current' });
    tasks.push(t);
  });
  // 下拉里的 #n 是 DOM 行号,这里换成投递数组的下标(via 由主进程直接消费)
  for (const { t, raw } of waits) {
    if (raw.startsWith('session:')) {
      const sid = raw.slice(8);
      t.waitFor = sid; t.via = { kind: 'session', sid };
    } else if (raw.startsWith('#')) {
      const idx = byDom.get(Number(raw.slice(1)) - 1);
      if (idx >= 0 && idx !== undefined) { t.waitFor = '#' + (idx + 1); t.via = { kind: 'subtask', index: idx }; }
      else { t.waitFor = 'current'; t.via = { kind: 'current' }; } // 引用的是已被删掉/留空的行
    } else {
      t.waitFor = 'current'; t.via = { kind: 'current' };
    }
  }
  return tasks;
}

// 判断结论实时提示(用户改动「并行/等待」后同步刷新)
function refreshHint() {
  const rows = [...$('split-list').querySelectorAll('.split-row')];
  const el = $('split-hint');
  if (!el) return;
  if (!rows.length) { el.textContent = '没有可执行的子任务。'; return; }
  const waits = rows.filter((r) => r.querySelector('.split-mode').value === 'wait').length;
  if (rows.length === 1 && !waits) {
    el.textContent = 'AI 判断:这条需求不需要拆分,建议直接发送到当前会话执行(也可新建一个会话单独跑)。';
    return;
  }
  el.textContent = `AI 判断:${rows.length - waits} 项可并行(各建一个会话),${waits} 项需等待(排入对应会话队列,等它当前回合结束后自动执行)。`;
}

function setStatus(msg, cls) {
  const st = $('split-status');
  st.className = 'modal-status' + (cls ? ' ' + cls : '');
  st.textContent = msg || '';
}

function closeModal() {
  $('split-modal').classList.add('hidden');
  resultShown = false;
  $('split-list').innerHTML = '';
  $('split-confirm').textContent = '确认执行';
  $('split-add').classList.remove('hidden');
  $('split-cancel').classList.remove('hidden');
  $('split-pass').classList.add('hidden');
  setStatus('');
}

// 落定本次接管:handled=true 表示消息已被拆分流程消费(不再按普通消息发送),
// false 表示交还发送流程(用户选了「不拆,直接发送」)。
function settle(handled) {
  const p = pending;
  pending = null; // 先清空,closeModal 触发的 class 观察器才不会二次落定
  closeModal();
  if (p) p.resolve(handled);
}

// --- 拆分流程 ----------------------------------------------------------------

async function openSplit(requirement) {
  const sid = state.activeSid;
  splitSid = sid;
  others = [];
  const btn = $('btn-split-subtasks');
  btn.disabled = true;
  try {
    const r = await api.sessSplitSubtasks({ sid, requirement });
    if (!r || !r.ok) {
      // 拆不出来就把这条消息原样交给普通发送流程,不吞用户的输入
      alert('拆分失败:' + ((r && r.error) || '未知错误') + '\n未拆分,这条消息将按普通消息发送。');
      return false;
    }
    others = Array.isArray(r.sessions) ? r.sessions : [];
    renderRows(r.tasks);
    $('split-modal').classList.remove('hidden');
    return true;
  } finally {
    btn.disabled = false;
  }
}

// 供发送流程调用:激活时拦截这条消息去拆分。返回 true 表示已接管(不再走正常发送)。
export async function maybeSplitOnSend(text) {
  if (!armed) return false;
  if (!state.activeSid) return false;
  if (pending) return true; // 卡片已开着(蒙层挡住输入),忽略这次发送
  return await new Promise((resolve) => {
    pending = { resolve };
    openSplit(text)
      .then((opened) => { if (!opened) settle(false); })
      .catch(() => settle(false));
  });
}

async function confirmSplit() {
  if (resultShown) { settle(true); return; } // 「完成」:关卡片,本条消息不再发送
  const tasks = collectTasks();
  if (!tasks.length) { setStatus('至少需要一条子任务', 'err'); return; }
  const btn = $('split-confirm');
  btn.disabled = true;
  setStatus('正在落地…');
  try {
    const r = await api.sessSpawnSubtasks({ sid: splitSid, tasks });
    if (!r || !r.ok) { setStatus('创建失败:' + ((r && r.error) || '未知错误'), 'err'); return; }
    for (const meta of r.sessions || []) ensureSession(meta.id, meta);
    refreshList();
    showResult(r);
  } finally {
    btn.disabled = false;
  }
}

// 落地结果:把卡片换成「建了哪些会话 / 排了哪些等待项」的清单,用户看清楚再关
function showResult(r) {
  resultShown = true;
  const lines = [];
  for (const m of r.sessions || []) {
    lines.push(`<div class="split-result-line ok">⧉ 已新建并行会话「${escapeHtml(String(m.title || '').replace(/^⧉ /, ''))}」,已开始执行。</div>`);
  }
  for (const q of r.queued || []) {
    const s = state.sessions.get(q.sid);
    const name = (s && s.meta.title) || (q.sid || '').slice(0, 8);
    lines.push(q.fallback
      ? `<div class="split-result-line wait">⏳ 「${escapeHtml(q.title)}」原等待目标不可用,已改为新建会话执行。</div>`
      : `<div class="split-result-line wait">⏳ 「${escapeHtml(q.title)}」已排入「${escapeHtml(name)}」的队列,该会话当前回合结束后自动执行。</div>`);
  }
  $('split-list').innerHTML = lines.join('') || '<div class="empty-hint">没有创建任何会话</div>';
  $('split-hint').textContent = '已按判断结果落地:并行项在各自新会话里同时跑,等待项排在目标会话的队列里。';
  $('split-add').classList.add('hidden');
  $('split-cancel').classList.add('hidden');
  $('split-pass').classList.add('hidden');
  $('split-confirm').textContent = '完成';
  setStatus('');
}

export function init() {
  $('btn-split-subtasks').onclick = () => { armed = !armed; syncToggle(); };
  $('split-cancel').onclick = () => settle(true);
  $('split-pass').onclick = () => settle(false);
  $('split-confirm').onclick = confirmSplit;
  $('split-add').onclick = () => {
    $('split-list').appendChild(rowEl({ title: '', detail: '', mode: 'parallel' }, $('split-list').children.length));
    renumber();
    fillWaitOptions();
    refreshHint();
  };
  // Esc / 点蒙层空白关闭走的是 app.js 的统一逻辑(只加 hidden 类,不通知本模块),
  // 这里用观察器兜底:卡片一旦被关掉就落定 pending,否则承诺永不 resolve,
  // 后续每次发送都会被 pending 分支吞掉。
  new MutationObserver(() => {
    if (pending && $('split-modal').classList.contains('hidden')) settle(true);
  }).observe($('split-modal'), { attributes: true, attributeFilter: ['class'] });
  syncToggle();
}
