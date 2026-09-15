// 拆分子任务(v0.15.9):把模型返回的拆分文本解析为结构化子任务列表。
// 纯函数、不依赖 electron/DOM,便于 node:test 单测。
// 模型被要求输出 JSON 数组:[{ "title": "...", "detail": "..." }, ...],
// 但实际返回可能带 markdown 代码围栏或多余前后缀,这里做宽松提取与校验。

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

// 校验并规范化子任务:每项 { title, detail }。丢弃无标题项,标题截断 60 字。
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
    tasks.push({ title, detail });
    if (tasks.length >= 12) break;
  }
  if (!tasks.length) return { ok: false, error: '解析出的子任务为空', tasks: [] };
  return { ok: true, tasks };
}

// 构造给模型的拆分提示词
function buildSplitPrompt(requirement) {
  return [
    '你是任务拆解助手。把下面的需求拆成若干个可并行执行的子任务。',
    '要求:',
    '1. 只输出一个 JSON 数组,不要输出任何解释、标题或代码围栏。',
    '2. 数组每项是 {"title": "子任务短标题(不超过30字)", "detail": "该子任务要完成的完整说明,可独立执行"}。',
    '3. 子任务之间应尽量独立、可并行;数量 2~8 个。',
    '4. detail 要自包含,执行它的助手看不到原始需求,需包含足够上下文。',
    '',
    '需求如下:',
    String(requirement || ''),
  ].join('\n');
}

module.exports = { extractJsonArray, parseSubtasks, buildSplitPrompt };
