// 推理深度档位(v0.15.20):UI 五档 ↔ SDK EffortLevel 的映射与归一化。
//
// 为什么需要单独一层:UI 要的是「轻度/适中/深度/更深/极限」这类与模型无关的档位名,
// 而 SDK 只认 'low' | 'medium' | 'high' | 'xhigh' | 'max'(sdk.d.ts:539 的 EffortLevel,
// 没有 ultra——'ultracode' 是另一个维度的 Settings 布尔开关,见 sdk.d.ts:6277)。
// 不同模型支持的档位不同(sdk.d.ts:1229 supportedEffortLevels),xhigh 在不支持的模型上
// 会被 SDK 静默退回 high(sdk.d.ts:536),所以下发前先按能力表归一化一次。
//
// 这里全是纯函数,便于单测(见 test/effort-levels.test.js)。

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 档位中文名(UI 文案;改文案只改这一处)
export const EFFORT_LABELS = {
  low: '轻度',
  medium: '适中',
  high: '深度',
  xhigh: '更深',
  max: '极限',
};

// 未显式选档(effort=null,即「跟随默认」)时面板标题显示的文案
export const EFFORT_DEFAULT_LABEL = '默认';

// 'high' 是 SDK 官方默认档(sdk.d.ts:535「Deep reasoning (default)」)。
// 「跟随默认」熄火时手柄停在这里,代表模型自身默认落在的位置。
export const EFFORT_FALLBACK_INDEX = EFFORT_LEVELS.indexOf('high');

// 档位 → 滑块索引 0..4;null / 未知值 → -1(表示「默认」,无显式档位)
export function effortIndex(v) {
  return EFFORT_LEVELS.indexOf(v);
}

// 滑块索引 → 档位;越界 → null
export function indexToLevel(i) {
  const n = Number(i);
  return Number.isInteger(n) && n >= 0 && n < EFFORT_LEVELS.length ? EFFORT_LEVELS[n] : null;
}

// 档位 → 中文名;null / 未知值 → 「默认」
export function effortLabel(v) {
  return EFFORT_LABELS[v] || EFFORT_DEFAULT_LABEL;
}

// 滑块索引 → 已填充比例(0/25/50/75/100);-1(默认)与非法值 → 0
export function effortPercent(i) {
  const n = Number(i);
  if (!isFinite(n) || n < 0) return 0;
  const last = EFFORT_LEVELS.length - 1;
  return (Math.min(n, last) / last) * 100;
}

// 按模型支持的能力表归一化档位。
// - 非法档位 → null(调用方按「默认」处理)
// - supported 缺失/为空 → 原样返回:没有能力数据就只能下发,由 SDK 自身降级兜底
// - 不支持所选档 → 先向下找最近的受支持档,没有则向上找;全不匹配 → null
export function normalizeEffort(level, supported) {
  const i = EFFORT_LEVELS.indexOf(level);
  if (i < 0) return null;
  if (!Array.isArray(supported) || !supported.length) return level;
  if (supported.includes(level)) return level;
  for (let k = i - 1; k >= 0; k--) {
    if (supported.includes(EFFORT_LEVELS[k])) return EFFORT_LEVELS[k];
  }
  for (let k = i + 1; k < EFFORT_LEVELS.length; k++) {
    if (supported.includes(EFFORT_LEVELS[k])) return EFFORT_LEVELS[k];
  }
  return null;
}

// 归一化结果与所选档不一致时给出一句人话说明;一致或无从判断 → null。
// 用于面板提示:不能让用户以为「极限」生效了,实际跑的是「更深」。
export function effortDowngradeNote(level, effective) {
  if (!level || !effective || level === effective) return null;
  return `该模型不支持「${effortLabel(level)}」,将按「${effortLabel(effective)}」执行`;
}

// ---------------- 模型能力表(v0.15.20,接入 SDK 真实数据) ----------------
//
// 数据来源:Query.supportedModels()(sdk.d.ts:2392,即 initialize 控制响应里的 models)。
// 实测(Electron/Node 直连 claude.exe,不联网):1.9s 返回 5 条,是 claude.exe **内置的静态
// 别名注册表**——default / opus / sonnet / haiku / fable-5,与所选 Key、会话、模型无关。
//
// 实测到的三点(决定了下面这套「三态」语义,勿凭直觉改):
// 1. 支持 effort 的 4 条全部上报完整五档 ['low','medium','high','xhigh','max']
//    ⇒ 对它们归一化恒等,永远不会产生降级提示;
// 2. haiku 条目**完全没有** supportsEffort / supportedEffortLevels 字段
//    ⇒ 这是整张表里唯一的可行动信号:该模型不认 effort,滑块应直接禁用;
// 3. 第三方网关模型(kimi-k3、GPT-6 Astra 等)**完全不在这张表里**
//    ⇒ 查不到就是查不到,一律按「未知」原样下发,由 SDK 自身静默降级兜底
//    (sdk.d.ts:536 xhigh → high)。绝不为查不到的模型猜能力——那等于把 SDK 的
//    静默降级换成界面撒谎。
//
// 模型名归一化:小写 + 去掉尾部 [1M]/[1m](表里 resolvedModel 写作 'claude-sonnet-5[1M]',
// 而 Drafter 的 meta.model 是用户 Key 的 /v1/models 里的 id,两边要能对上)。
function capabilityKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\[1m\]$/, '');
}

// ModelInfo[] → 扁平查找表 { 模型名: 档位数组 }。
// 命中且数组非空 = 受支持;命中且为 [] = 明确已知不支持;键不存在 = 未知。
export function buildEffortCapabilityTable(models) {
  const table = {};
  if (!Array.isArray(models)) return table;
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const levels = Array.isArray(m.supportedEffortLevels)
      ? m.supportedEffortLevels.filter((l) => EFFORT_LEVELS.includes(l))
      : null;
    // 支持的档位以数组为准;supportsEffort 只说「支持」却没给档位时不收录(不设限 = 未知);
    // 其余情况(supportsEffort === false,或压根没这两个字段)都判为明确不支持。
    let cap;
    if (m.supportsEffort === false) cap = [];
    else if (levels && levels.length) cap = levels;
    else if (m.supportsEffort === true) cap = null;
    else cap = [];
    if (cap === null) continue;
    for (const key of [m.value, m.displayName, m.resolvedModel]) {
      const k = capabilityKey(key);
      if (k) table[k] = cap;
    }
  }
  return table;
}

// 查表。返回:档位数组(受支持)/ [](已知不支持)/ null(未知——表里没有,或压根没表)。
// 注意 [] 与 null 是两种不同含义,调用方必须分开处理:前者禁用滑块,后者原样下发。
export function lookupEffortLevels(table, model) {
  if (!table || !model) return null;
  const k = capabilityKey(model);
  return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : null;
}

// 该模型是否「明确已知不支持 effort」(表里命中且档位为空)
export function modelRejectsEffort(table, model) {
  const caps = lookupEffortLevels(table, model);
  return Array.isArray(caps) && caps.length === 0;
}
