// 拆分子任务(v0.15.9):把模型返回的拆分文本解析为结构化子任务列表。
// 纯函数、不依赖 electron/DOM,便于 node:test 单测。
// 模型被要求输出 JSON 数组:[{ "title", "detail", "mode", "waitFor" }, ...],
// 但实际返回可能带 markdown 代码围栏或多余前后缀,这里做宽松提取与校验。
//
// v0.15.18(用户要求):拆分前先做「一轮判断」。此前是无脑拆——不管子任务之间有没有
// 先后依赖、别的会话是不是正在改同一处,一律各建一个并行会话,会话数上去了、开发
// 并没有变快。现在每个子任务必须带 mode:
//   parallel = 互不依赖、现在就能开工 → 新建会话立刻执行
//   wait     = 要等某个目标先完成 → 不建会话,排入那个会话的消息队列(目标当前回合
//              结束后自动接着执行;目标空闲则立即执行,因为「要等的事」本就不存在)
// waitFor 指向等待目标:current(当前会话)/ S1(上下文里列出的第 1 个并行会话)/ #2(本次拆分的第 2 项)。

// 从模型原文中提取第一个 JSON 数组(剥 ``` 围栏 / 首尾散文),失败返回 null
function extractJsonArray(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 剥 markdown 代码围栏 ```json ... ``` 或 ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 直接整体是数组
  const direct = tryParse(s);
  if (direct) return direct;
  // 截取第一个 [ 到最后一个 ] 之间再试(容忍首尾散文)
  const i = s.indexOf('[');
  const j = s.lastIndexOf(']');
  if (i >= 0 && j > i) {
    const slice = tryParse(s.slice(i, j + 1));
    if (slice) return slice;
  }
  return null;
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

const MODE_PARALLEL = 'parallel';
const MODE_WAIT = 'wait';

// 判断模型给出的 mode 字样 → 'parallel' | 'wait'。缺省/无法识别一律按并行
// (兜底成并行 = 保持 v0.15.9 起的老行为,不会因为模型不听话就把任务卡住)。
function normMode(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return MODE_PARALLEL;
  if (/^(wait|waiting|waits|queue[dr]?|dep|deps|depend(s|ency)?|blocked|after|serial|sequential|等待|等待中|依赖|排队|串行|顺序|后置)$/.test(s)) return MODE_WAIT;
  return MODE_PARALLEL;
}

// 判断模型给出的 waitFor 字样 → 'current' | 'S1' | '#2' | 'sid:s_xxx' | null。
// 兼容中文/裸数字/子任务 等多种写法,识别不了返回 null(调用方决定兜底)。
function normWaitFor(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return '#' + Math.trunc(v);
  const s = String(v).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (/^(current|self|this|this session|当前|当前会话|本会话|本任务|自身)$/.test(low)) return 'current';
  let m = s.match(/^s\s*(\d+)$/i);                 // S1 / s2
  if (m) return 'S' + m[1];
  m = s.match(/^(?:#|subtask\s*#?|子任务\s*#?)\s*(\d+)$/i); // #2 / subtask 2 / 子任务2
  if (m) return '#' + m[1];
  m = s.match(/^(\d+)$/);                          // 裸数字
  if (m) return '#' + m[1];
  if (/^s_[A-Za-z0-9_-]+$/.test(s)) return 'sid:' + s; // 模型直接抄了会话 id
  return null;
}

// 校验并规范化子任务:每项 { title, detail, mode, waitFor }。丢弃无标题项,标题截断 60 字。
// 返回 { ok, tasks, error }。tasks 至少 1 项、至多 12 项。
function parseSubtasks(text) {
  const arr = extractJsonArray(text);
  if (!arr) return { ok: false, error: '未能从模型回复中解析出子任务列表(JSON)', tasks: [] };
  const tasks = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    let title = String(it.title ?? it.name ?? it.task ?? '').trim();
    let detail = String(it.detail ?? it.desc ?? it.description ?? it.prompt ?? '').trim();
    if (!title && detail) { title = detail.slice(0, 60); }
    if (!title) continue;
    if (title.length > 60) title = title.slice(0, 60);
    // mode 与 waitFor 的取舍:显式写了 mode 就听它的;没写 mode 但给了 waitFor 的,
    // 按「要等待」处理(模型漏字段时它真正想表达的往往是依赖关系,不能被丢掉)。
    const hasMode = it.mode != null || it.type != null || it.exec != null;
    const raw = hasMode ? (it.mode ?? it.type ?? it.exec) : undefined;
    let mode = hasMode ? normMode(raw) : MODE_PARALLEL;
    let waitFor = normWaitFor(it.waitFor ?? it.wait_for ?? it.wait ?? it.after ?? it.dependsOn ?? it.depends_on);
    if (!hasMode && waitFor) mode = MODE_WAIT;
    if (mode === MODE_WAIT) {
      if (!waitFor) waitFor = 'current'; // 说了要等但没说等谁 → 等当前会话(最保守的落点)
    } else {
      waitFor = null; // 并行项不保留等待目标,避免语义自相矛盾
    }
    tasks.push({ title, detail, mode, waitFor });
    if (tasks.length >= 12) break;
  }
  if (!tasks.length) return { ok: false, error: '解析出的子任务为空', tasks: [] };
  return { ok: true, tasks };
}

// ---------------------------------------------------------------------------
// 判断依据:当前会话 + 同项目组其他并行会话现状(v0.15.18)
// ---------------------------------------------------------------------------

// 挑出「与当前会话同项目组、未归档、非自身」的其他并行会话,按最近更新倒序取前 limit 个。
// 新媒体板块会话(image/video/audio/model/media)不在其列:它们不跑 Agent 任务,
// 既不能作为撞车判断的参照,也不能被当成等待项的投递目标。
// 纯函数:busyOf/doingOf 由调用方注入(主进程读 live 实例与事件日志,单测传桩),
// 同一份输入必得同一份输出——拆分时与投放时用同一函数,键位(S1/S2…)才对得上。
const MEDIA_KINDS = ['media', 'image', 'video', 'audio', 'model'];

function pickOtherSessions({ currentSid, projectId, cwd, all = [], busyOf, doingOf, limit = 6 } = {}) {
  const busy = typeof busyOf === 'function' ? busyOf : () => false;
  const doing = typeof doingOf === 'function' ? doingOf : () => '';
  const same = (all || []).filter((m) => m && m.id !== currentSid && !m.archived
    && !MEDIA_KINDS.includes(m.kind)
    && (projectId ? m.projectId === projectId : (!!cwd && m.cwd === cwd)));
  same.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return same.slice(0, limit).map((m, i) => ({
    key: 'S' + (i + 1),
    id: m.id,
    title: String(m.title || '(未命名会话)').slice(0, 60),
    busy: !!busy(m.id),
    doing: String(doing(m.id) || '').replace(/\s+/g, ' ').slice(0, 120),
  }));
}

// 一行描述一个会话,拼进判断提示词
function sessionLine(label, s) {
  if (!s) return `${label}:(未知)`;
  const bits = [s.busy ? '进行中' : '空闲'];
  if (s.doing) bits.push(`最近在做:${s.doing}`);
  return `${label}${s.title} [${bits.join(' / ')}]`;
}

// 构造给模型的拆分提示词(先判断,再拆分)
function buildSplitPrompt(requirement, opts = {}) {
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : [];
  const cur = opts.current || null;
  const lines = [
    '你是任务拆解助手。目标不是「拆得越碎越好」,而是找出真正能同时开工的部分让多个会话并行推进;',
    '其余有先后依赖、或与别的会话正在做的事重叠的部分,必须串行等待,不能硬拆成并行会话。',
    '',
    '【第一步:先判断,再拆分】',
    '1. 依赖判断:后一项必须等前一项产出才能开始的(如「后端接口」→「前端对接」),属于 wait。',
    '2. 撞车判断:对照下面「其他并行会话现状」,若某件事正在被别的会话做、或要改同一个文件/模块,不要重复开工——把它标成 wait 并指向那个会话。',
    '3. 只有互不依赖、现在就能立刻开工、且不与任何进行中会话冲突的,才是 parallel。',
    '4. 不要为了凑数硬拆:如果这条需求本就是一个不可分的整体,就只输出 1 项。',
    '',
  ];
  if (cur) lines.push('当前会话:' + sessionLine('', cur));
  if (sessions.length) {
    lines.push('其他并行会话现状:');
    for (const s of sessions) lines.push(`${s.key}. ` + sessionLine('', s));
  } else {
    lines.push('其他并行会话现状:(无,项目组内没有其他会话)');
  }
  lines.push(
    '',
    '【第二步:输出】只输出一个 JSON 数组,不要任何解释、标题或代码围栏。每项格式:',
    '{"title":"子任务短标题(不超过30字)","detail":"该子任务要完成的完整说明","mode":"parallel|wait","waitFor":"current|S1|#2"}',
    '- mode:parallel = 现在就能并行开工(会为它新建一个会话);wait = 需要等待。',
    '- waitFor:仅 mode=wait 时填。"current" = 等当前会话;"S1" = 等上面列出的某个并行会话(用它的编号);"#2" = 等本次拆分中的第 2 项先完成。',
    '- detail 必须自包含:执行它的助手看不到原始需求,也看不到其他子任务的说明。wait 项的 detail 要写明它等待的前置产出是什么、拿到后要做什么。',
    '- 数量 1~8 个;若判断为「不需要拆分」则只输出 1 项,并在 detail 里说明为什么它是一个整体。',
    '',
    '需求如下:',
    String(requirement || ''),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 等待目标解析(纯函数,主进程投放前调用)
// ---------------------------------------------------------------------------

// 把每项的等待引用解析成最终投递目标,返回与 tasks 等长的数组:
//   { action:'spawn' }                                          并行项 → 建新会话
//   { action:'queue', via:{ kind:'current' } }                  排入当前会话队列
//   { action:'queue', via:{ kind:'session', sid } }             排入指定会话队列
//   { action:'queue', via:{ kind:'session', key:'S1' } }        排入「上下文第 1 个并行会话」(主进程换 id)
//   { action:'queue', via:{ kind:'subtask', index } }           排入「第 index 项」新建出来的会话队列
//   { action:'queue', via:{...}, cycle:true }                   引用成环/越界,已退化为当前会话
// 成环(如 #1 等 #2、#2 等 #1)不做无限解析:退化为「等当前会话」并按数组顺序投递,
// 顺序仍由投递次序保证,不会互相死等。
function resolveWaitTargets(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const one = (i, seen) => {
    const t = list[i] || {};
    if (normMode(t.mode) !== MODE_WAIT) return { action: 'spawn' };
    const via = normalizeVia(t.via, t.waitFor);
    if (via.kind === 'subtask') {
      const idx = via.index;
      if (!(idx >= 0) || idx >= list.length || idx === i) {
        return { action: 'queue', via: { kind: 'current' }, cycle: true, reason: '等待引用越界' };
      }
      if (seen.has(idx)) {
        return { action: 'queue', via: { kind: 'current' }, cycle: true, reason: '等待关系成环' };
      }
      const target = list[idx] || {};
      // 目标本身是并行项 → 等它新建出来的那个会话
      if (normMode(target.mode) !== MODE_WAIT) return { action: 'queue', via: { kind: 'subtask', index: idx } };
      // 目标自己也在等 → 继承目标最终要落到的会话,投递顺序天然保证先后
      seen.add(idx);
      const r = one(idx, seen);
      if (r.action === 'spawn') return { action: 'queue', via: { kind: 'subtask', index: idx } };
      return r.cycle
        ? { action: 'queue', via: r.via, cycle: true, reason: r.reason }
        : { action: 'queue', via: r.via };
    }
    return { action: 'queue', via };
  };
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(one(i, new Set([i])));
  return out;
}

// 渲染端已解析好的 via 优先;否则退回解析原始 waitFor 字样
function normalizeVia(via, waitFor) {
  if (via && typeof via === 'object') {
    if (via.kind === 'current') return { kind: 'current' };
    if (via.kind === 'session' && via.sid) return { kind: 'session', sid: String(via.sid) };
    if (via.kind === 'session' && via.key) return { kind: 'session', key: String(via.key) };
    if (via.kind === 'subtask' && Number.isFinite(via.index)) return { kind: 'subtask', index: Math.trunc(via.index) };
  }
  const ref = normWaitFor(waitFor);
  if (!ref || ref === 'current') return { kind: 'current' };
  if (/^S\d+$/.test(ref)) return { kind: 'session', key: ref };
  if (ref.startsWith('sid:')) return { kind: 'session', sid: ref.slice(4) };
  return { kind: 'subtask', index: Number(ref.slice(1)) - 1 };
}

// 判断结果的一句话小结(弹窗提示用)
function summarizePlan(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const plan = resolveWaitTargets(list);
  const parallel = plan.filter((p) => p.action === 'spawn').length;
  const wait = plan.length - parallel;
  if (!list.length) return '';
  if (list.length === 1 && !wait) return 'AI 判断:这条需求不需要拆分,建议直接发送到当前会话执行。';
  return `AI 判断:${parallel} 项可并行(各建一个会话),${wait} 项需等待(排入对应会话的队列,等它当前回合结束后自动执行)。`;
}

module.exports = {
  extractJsonArray, parseSubtasks, buildSplitPrompt, resolveWaitTargets,
  pickOtherSessions, summarizePlan, normMode, normWaitFor,
  MODE_PARALLEL, MODE_WAIT, MEDIA_KINDS,
};
