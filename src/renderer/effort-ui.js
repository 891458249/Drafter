// 推理深度滑块 + 模型合并入口(v0.15.20)。
//
// 背景:此前「模型」与「推理深度」是两个独立 <select>(#model-sel / #effort-sel-composer)。
// 现合并为一个「选择强度」入口,点开是浮层:档位名 + 当前模型(可点切换)+ 5 格滑块
// + 独立的「跟随默认」开关。
//
// 三条设计约束:
// 1. #model-sel 保留为**隐藏数据源**——app.js/sessions-ui.js/canvas.js/state.js 共 10 处
//    通过 parseModelValue($('model-sel').value) 读它,面板只是展示层,不另立数据源。
// 2. 本模块**不 import chat.js**。它需要的「应用模型选择」「刷新工具条」两个回调由
//    input.js 在 init() 时注入,避免与 chat.js ↔ effort-ui.js 形成 import 环。
// 3. effort 真正下发到 SDK 的条件见下方 effortApplies():media 会话不走 Agent SDK
//    (state.js:26-29),极速 chat 固定 thinking:'disabled'(src/main/sessions.js:425-427),
//    两者下档位都不生效——此时滑块「熄火」并禁用,而不是留一个能拖却无效的活滑块。
import { api, state, $, escapeHtml, MEDIA_KINDS } from './state.js';
import {
  EFFORT_LEVELS, EFFORT_DEFAULT_LABEL, EFFORT_FALLBACK_INDEX,
  effortIndex, indexToLevel, effortLabel, normalizeEffort, effortDowngradeNote,
  buildEffortCapabilityTable, lookupEffortLevels, modelRejectsEffort,
} from './effort.js';

const LAST = EFFORT_LEVELS.length - 1; // 4

let deps = { applyModel: null, refreshTopbar: null };
let ctx = { sid: null, fast: false };
let dragging = false;
let previewIdx = null; // 拖动中的临时档位(只改视觉,pointerup 才落盘)

// 模型能力表:主进程取 Query.supportedModels() 后缓存,渲染端经 api.sessEffortCaps() **主动拉**
// (见主进程 SessionManager.loadEffortCapability 里「为什么是拉而不是推」的实测记录)。
// 三态语义见 effort.js 的 lookupEffortLevels——命中空数组 = 明确不支持(禁用滑块),
// 查不到 = 未知(原样下发,由 SDK 自身的静默降级兜底)。
//
// 时机:主进程要等某条会话真正 start() 才拿得到(claude.exe 的 initialize 控制响应)。新建会话时
// create() 里就 start,故建完即拉得到;但重启后直接打开一条已存会话、还没发过消息时要等首次发送。
// 在那之前 capTable 为 null,面板行为与本改动之前完全一致(五档全可拖、原样下发)。
let capTable = null;
let capFetching = false; // 一次只飞一个请求
let capFetchedAt = 0;    // 上次尝试时间,节流用

export function setEffortCapability(models) {
  if (!models) return;
  capTable = buildEffortCapabilityTable(models);
  render(); // 表可能在面板已打开之后才到,立即重绘
}

// 拉取失败/为空都只是维持「未知」,不提示不阻塞——它只是旁路信息。
// 节流 3s:syncEffort 在切会话时会频繁调用,而主进程那张表一辈子只取一次。
function pullEffortCapability() {
  if (capTable || capFetching) return;
  const now = Date.now();
  if (now - capFetchedAt < 3000) return;
  capFetchedAt = now;
  capFetching = true;
  Promise.resolve()
    .then(() => api.sessEffortCaps())
    .then((models) => { if (models) setEffortCapability(models); })
    .catch(() => {})
    .then(() => { capFetching = false; });
}

// ---------------- 状态推导 ----------------

function sessionOf() {
  return ctx.sid ? state.sessions.get(ctx.sid) : null;
}

// 档位是否真的会下发到 SDK(对照 src/main/sessions.js:427 的 !fastOv 分支)
function effortApplies(m) {
  if (!m) return false;
  if (MEDIA_KINDS.includes(m.kind)) return false; // media 会话走 AIGC 闭环,不起 Agent SDK
  if (ctx.fast) return false; // 极速问答固定无思考
  if (modelRejectsEffort(capTable, m.model)) return false; // 模型不认 effort(实测:haiku 条目无该能力)
  return true;
}

// 「跟随默认」是否生效(effort=null ⟺ 交给模型自适应)
function followMode(m) {
  return !!m && !m.effort;
}

// 滑块是否不接受指针/键盘改档:①板块下档位不生效 ②熄火态(跟随默认)。
// 熄火是「发动机停了」——按计划 §6,熄火时不接受拖拽,要调档先取消跟随。
function sliderLocked(m) {
  return !effortApplies(m) || followMode(m);
}

// 当前应显示的滑块索引:显式档位 > 本会话上次显式档位(渲染端记忆) > SDK 默认档
function currentIndex(s, m) {
  const explicit = effortIndex(m && m.effort);
  if (explicit >= 0) return explicit;
  const remembered = s && Number.isInteger(s.ui.lastEffortIndex) ? s.ui.lastEffortIndex : null;
  return remembered != null ? remembered : EFFORT_FALLBACK_INDEX;
}

// ---------------- 渲染 ----------------

export function syncEffort(sid, opts = {}) {
  ctx.sid = sid || null;
  ctx.fast = !!(opts && opts.fast);
  pullEffortCapability(); // 表可能这条会话启动后才就绪,每次同步都顺带试一次(带节流)
  render();
}

function render() {
  const pop = $('effort-pop');
  const btn = $('btn-effort');
  const slider = $('effort-slider');
  if (!pop || !btn || !slider) return;

  const s = sessionOf();
  const m = s && s.meta;
  const applies = effortApplies(m);
  const follow = followMode(m);
  const level = (m && m.effort) || null;
  const idx = Math.min(Math.max(previewIdx != null ? previewIdx : currentIndex(s, m), 0), LAST);

  // 熄火:跟随默认,或该档位在当前会话下根本不生效
  pop.classList.toggle('is-off', !applies || follow);
  pop.classList.toggle('is-disabled', !applies);
  if (applies && !follow) pop.setAttribute('data-level', String(effortIndex(level)));
  else pop.removeAttribute('data-level'); // 无 data-level → --effort-c 走中性色

  slider.style.setProperty('--effort-frac', String(idx / LAST));
  slider.setAttribute('aria-valuenow', String(idx));
  slider.setAttribute('aria-valuetext', effortLabel(indexToLevel(idx)));
  slider.setAttribute('aria-disabled', String(sliderLocked(m)));
  for (const t of slider.querySelectorAll('.effort-slider-tick')) {
    t.classList.toggle('on', Number(t.dataset.i) <= idx);
  }

  $('effort-pop-level').textContent = level ? effortLabel(level) : EFFORT_DEFAULT_LABEL;

  const sel = $('model-sel');
  const cur = sel ? sel.selectedOptions[0] : null;
  const modelName = cur && cur.textContent ? cur.textContent.trim() : '默认';
  $('effort-pop-model-name').textContent = modelName;
  btn.title = `选择模型与推理深度(当前:${modelName} · ${level ? effortLabel(level) : '跟随默认'})`;

  const chk = $('effort-follow-chk');
  chk.checked = follow;
  chk.disabled = !applies;

  renderHint(applies, follow, level, m);
}

function renderHint(applies, follow, level, m) {
  const hint = $('effort-pop-hint');
  let text = '';
  if (!applies) {
    // 三种「档位不生效」按约束由硬到软排:板块模型类 > 模型自身能力 > 会话模式
    if (MEDIA_KINDS.includes(m && m.kind)) text = '当前板块的生成模型不支持推理深度';
    else if (modelRejectsEffort(capTable, m && m.model)) text = '当前模型不支持推理深度调节';
    else text = '极速问答固定无思考,推理深度不生效;切到 Agent 模式后可用';
  } else if (follow) {
    text = '跟随默认:由模型按任务难度自行决定思考量';
  } else {
    // 归一化提示:能力表里没有这个模型时 lookupEffortLevels 返回 null,
    // normalizeEffort 原样放行,这里自然为 null
    text = effortDowngradeNote(level, normalizeEffort(level, lookupEffortLevels(capTable, m && m.model))) || '';
  }
  hint.textContent = text;
  hint.classList.toggle('hidden', !text);
}

// ---------------- 面板开合 ----------------

function openPanel() {
  renderModelList();
  $('effort-pop').classList.remove('hidden');
  $('btn-effort').classList.add('active');
}
function closePanel() {
  $('effort-pop').classList.add('hidden');
  $('effort-model-list').classList.add('hidden');
  $('btn-effort').classList.remove('active');
  previewIdx = null;
}

// ---------------- 模型列表(#model-sel 的展示层) ----------------

function modelItemHtml(opt, cur) {
  const v = opt.value;
  const label = (opt.textContent || '').trim();
  return `<button type="button" class="effort-model-item${v === cur ? ' active' : ''}" data-v="${escapeHtml(v)}">${escapeHtml(label)}</button>`;
}

// 每次打开面板时现读 #model-sel:populateModelSelects() 会按板块类别 + Key 分组重建它,
// 现读即永远同步,不必监听。
function renderModelList() {
  const sel = $('model-sel');
  const box = $('effort-model-list');
  if (!sel || !box) return;
  const cur = sel.value;
  let html = '';
  for (const node of sel.children) {
    if (node.tagName === 'OPTGROUP') {
      const items = [...node.children].filter((o) => !o.disabled).map((o) => modelItemHtml(o, cur)).join('');
      if (items) html += `<div class="effort-model-group">${escapeHtml(node.getAttribute('label') || '')}</div>${items}`;
    } else if (node.tagName === 'OPTION' && !node.disabled) {
      html += modelItemHtml(node, cur);
    }
  }
  box.innerHTML = html || '<div class="effort-model-group">该板块暂无可用模型</div>';
}

// ---------------- 写入 ----------------

async function setEffort(level) {
  const sid = ctx.sid;
  if (!sid) return;
  await api.sessSetEffort(sid, level);
  const s = state.sessions.get(sid);
  if (s) {
    s.meta.effort = level || null;
    // 记住上次显式档位:关掉「跟随默认」时恢复到这里(仅渲染端记忆,不新增持久化字段)
    if (level) s.ui.lastEffortIndex = effortIndex(level);
  }
  render();
}

function commitIndex(i) {
  const level = indexToLevel(Math.min(Math.max(i, 0), LAST));
  previewIdx = null;
  return setEffort(level);
}

function indexFromEvent(e) {
  const box = $('effort-slider').getBoundingClientRect();
  const inner = Math.max(1, box.width - 16); // 两端各 8px 手柄半径,与 CSS 一致
  const x = Math.min(Math.max(e.clientX - box.left - 8, 0), inner);
  return Math.round((x / inner) * LAST);
}

// ---------------- 初始化 ----------------

export function initEffortUi(injected = {}) {
  deps = { ...deps, ...injected };
  const btn = $('btn-effort');
  const pop = $('effort-pop');
  const slider = $('effort-slider');
  if (!btn || !pop || !slider) return;

  // 刻度点由档位表生成,改档位数不必改 HTML
  const ticks = $('effort-slider-ticks');
  if (ticks && !ticks.childElementCount) {
    ticks.innerHTML = EFFORT_LEVELS.map((_lv, i) =>
      `<span class="effort-slider-tick" data-i="${i}" style="left:${(i / LAST) * 100}%"></span>`).join('');
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    if (pop.classList.contains('hidden')) openPanel();
    else closePanel();
  };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => { if (!pop.classList.contains('hidden')) closePanel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) closePanel();
  });

  // 滑块:pointer 拖拽(自绘,仓库无 range 组件)+ 键盘可达
  slider.addEventListener('pointerdown', (e) => {
    if (sliderLocked((sessionOf() || {}).meta)) return;
    dragging = true;
    try { slider.setPointerCapture(e.pointerId); } catch {}
    previewIdx = indexFromEvent(e);
    render();
    e.preventDefault();
  });
  slider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    previewIdx = indexFromEvent(e);
    render();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { slider.releasePointerCapture(e.pointerId); } catch {}
    commitIndex(indexFromEvent(e));
  };
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', () => { dragging = false; previewIdx = null; render(); });

  slider.addEventListener('keydown', (e) => {
    const meta = (sessionOf() || {}).meta;
    // Enter/Space 切换「跟随默认」:熄火态下这是键盘用户唯一的路子,故不受 sliderLocked 拦
    if (e.key === 'Enter' || e.key === ' ') {
      if (!effortApplies(meta)) return;
      e.preventDefault();
      const chk = $('effort-follow-chk');
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change'));
      return;
    }
    if (sliderLocked(meta)) return;
    const cur = previewIdx != null ? previewIdx : currentIndex(sessionOf(), meta);
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LAST;
    if (next == null) return;
    e.preventDefault();
    commitIndex(next);
  });

  // 「跟随默认」:勾选 = 下发 effort=null 交给模型自适应
  $('effort-follow-chk').onchange = async () => {
    if (!effortApplies((sessionOf() || {}).meta)) return;
    const on = $('effort-follow-chk').checked;
    await setEffort(on ? null : indexToLevel(currentIndex(sessionOf(), (sessionOf() || {}).meta)));
  };

  $('effort-pop-model-btn').onclick = (e) => {
    e.stopPropagation();
    const list = $('effort-model-list');
    if (list.classList.contains('hidden')) { renderModelList(); list.classList.remove('hidden'); }
    else list.classList.add('hidden');
  };

  $('effort-model-list').onclick = async (e) => {
    const item = e.target.closest('.effort-model-item');
    if (!item) return;
    e.stopPropagation();
    const v = item.dataset.v || '';
    const sel = $('model-sel');
    if (sel) sel.value = v;
    $('effort-model-list').classList.add('hidden');
    if (deps.applyModel) await deps.applyModel(v);
  };
}

// 面板开合状态供探针/其它模块查询
export function isEffortPanelOpen() {
  const pop = $('effort-pop');
  return !!pop && !pop.classList.contains('hidden');
}
