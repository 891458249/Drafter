// 扩展板块(v0.15.16):Skill 技能 + 自定义子 Agent 的创建与管理。
// 存储走 store settings.extensions({skills, agents} 两个数组),与 gems 同模式;
// 预置模板(preset:true)不可改删,只能复制副本后编辑。
// 生效方式:
// - Skill 渐进式披露:会话挂载(meta.skillIds)后 systemPrompt 只放「名称+描述」索引,
//   模型经进程内 MCP 工具 use_skill 按需取回完整指令;发送前手动指定的技能
//   (pinSkillIds)全量随该条消息注入,优先级高于模型自触发。
// - Agent 按作用域挂载:global/project/session,buildCustomAgents 按会话 meta 过滤后
//   合并进 SDK options.agents(sessions.js buildSessionAgents 处)。
// 本模块不依赖 electron(便于单测),store 在 require 时注入。
const crypto = require('crypto');
const store = require('./store');

const MAX_INSTRUCTIONS = 30000; // 指令/提示词上限(对齐 gems)
const MAX_APPEND = 8000;        // 索引/pinned 注入总量截断
const MAX_FILES = 5;            // Skill 参考文件数量上限
const MAX_FILE_CONTENT = 20000; // 单个参考文件内容上限
const MAX_FILE_INLINE = 2000;   // pinned 注入时单文件内联前 N 字符

const KINDS = { skill: 'skills', agent: 'agents' };

// ---------------------------------------------------------------------------
// 预置模板
// ---------------------------------------------------------------------------
const PRESET_SKILLS = [
  {
    id: 'skill_preset_review',
    name: '代码审查清单',
    desc: '审查代码改动,按严重性分级输出问题清单。当用户要求 review、审查代码或检查改动质量时触发。',
    instructions: [
      '对目标代码做四维度审查:',
      '1. 正确性:边界条件、空值、并发、错误处理;',
      '2. 安全:注入、越权、敏感信息泄露;',
      '3. 性能:不必要的循环/拷贝、N+1、阻塞调用;',
      '4. 可读性:命名、重复代码、与周边风格一致性。',
      '输出格式:按「严重/建议/可选」三级分组,每条注明文件与行号、问题描述、修改建议;',
      '没有问题的维度也要明确说「未发现问题」,不要沉默跳过。',
    ].join('\n'),
  },
  {
    id: 'skill_preset_commit',
    name: 'Commit 信息助手',
    desc: '根据暂存的改动撰写规范 git commit message。当用户要求写提交信息、commit 时触发。',
    instructions: [
      '先运行 git diff --staged(无暂存则 git diff)了解改动;',
      '格式:<type>(<scope>): <一句话摘要>,type 取 feat/fix/refactor/docs/test/chore;',
      '摘要用祈使句、不超过 72 字符;正文按需补充动机与方案取舍,列表分行;',
      '不要夸大改动范围,不要在信息里编造未发生的改动。',
    ].join('\n'),
  },
  {
    id: 'skill_preset_docs',
    name: '文档撰写',
    desc: '为代码/功能撰写或更新文档。当用户要求写 README、注释、使用说明、文档时触发。',
    instructions: [
      '先读相关代码确认真实行为,文档必须与实现一致,禁止凭印象描述;',
      '结构:是什么 → 为什么 → 怎么用(含可运行示例)→ 注意事项;',
      '示例代码必须语法正确、可直接复制运行;',
      '中文为主,技术名词保留英文原文。',
    ].join('\n'),
  },
];

const PRESET_AGENTS = [
  {
    id: 'agent_preset_reviewer',
    name: 'code-reviewer',
    desc: '资深代码审查员:独立审查改动,找正确性/安全问题,输出分级清单',
    prompt: [
      '你是资深代码审查员,在独立上下文中审查父会话交代的代码改动。',
      '按正确性、安全、性能、可读性四维度检查;每条发现注明文件:行号、严重级别(严重/建议/可选)与修改建议。',
      '只报告有把握的问题,不确定的标注「待确认」并说明理由;不要修改代码本身。',
      '回报格式:先一句结论(能否合并),再分级清单。',
    ].join('\n'),
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
  {
    id: 'agent_preset_tester',
    name: 'test-engineer',
    desc: '测试工程师:为指定模块补充/修复测试,运行并报告结果',
    prompt: [
      '你是测试工程师。理解父会话指定的模块行为后,补充缺失的测试用例(正常/边界/异常路径)。',
      '遵循项目现有测试框架与风格;先运行现有测试确认基线,再增量添加。',
      '完成后运行全部相关测试,报告:新增用例数、通过率、失败用例的原因分析。',
      '不要为了让测试通过而修改被测实现,发现实现 bug 时如实上报。',
    ].join('\n'),
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep'],
  },
  {
    id: 'agent_preset_explorer',
    name: 'code-explorer',
    desc: '代码探索员:快速定位代码位置、梳理调用链与架构关系',
    prompt: [
      '你是代码探索员。在代码库中快速定位父会话询问的实现位置、调用链与依赖关系。',
      '优先用 Glob/Grep 定向搜索,避免逐文件通读;引用一律用 文件:行号 格式。',
      '回报:直接回答位置/链路,附关键代码摘录(每段 ≤15 行),不做无关扩展。',
    ].join('\n'),
    tools: ['Read', 'Grep', 'Glob'],
  },
];

// ---------------------------------------------------------------------------
// 基础 CRUD
// ---------------------------------------------------------------------------
function now() { return Date.now(); }

function read() {
  const ext = store.getSetting('extensions', {});
  return {
    skills: Array.isArray(ext.skills) ? ext.skills : [],
    agents: Array.isArray(ext.agents) ? ext.agents : [],
  };
}

function write(data) { store.setSetting('extensions', data); }

function list(kind) { return read()[KINDS[kind]] || []; }

function byId(kind, id) { return list(kind).find((x) => x.id === id) || null; }

// name 合法化:Claude Code 的 skill/agent 定义名只允许小写字母/数字/连字符;
// 中文名会全部剔除,空结果回退 fallback(SDK AgentDefinition 对字符集有硬性要求)
function slugify(name, fallback) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

function cleanSkill(item, existing) {
  return {
    id: (existing && existing.id) || ('skill_' + crypto.randomUUID().slice(0, 12)),
    name: String(item.name || '').trim().slice(0, 60),
    desc: String(item.desc || '').slice(0, 200),
    instructions: String(item.instructions || '').slice(0, MAX_INSTRUCTIONS),
    files: (Array.isArray(item.files) ? item.files : [])
      .filter((f) => f && f.name)
      .slice(0, MAX_FILES)
      .map((f) => ({ name: String(f.name).slice(0, 80), content: String(f.content || '').slice(0, MAX_FILE_CONTENT) })),
    enabled: item.enabled !== false,
    preset: false,
    createdAt: existing ? existing.createdAt : now(),
    updatedAt: now(),
  };
}

function cleanAgent(item, existing) {
  const scope = ['global', 'project', 'session'].includes(item.scope) ? item.scope : 'global';
  return {
    id: (existing && existing.id) || ('agent_' + crypto.randomUUID().slice(0, 12)),
    name: String(item.name || '').trim().slice(0, 60),
    desc: String(item.desc || '').slice(0, 200),
    prompt: String(item.prompt || '').slice(0, MAX_INSTRUCTIONS),
    tools: Array.isArray(item.tools) ? item.tools.map(String).slice(0, 20) : [],
    model: item.model || null, // 'keyId|model' 或 null(跟随会话默认)
    scope,
    scopeId: scope === 'global' ? null : (item.scopeId || null),
    enabled: item.enabled !== false,
    preset: false,
    createdAt: existing ? existing.createdAt : now(),
    updatedAt: now(),
  };
}

function save(kind, item) {
  const key = KINDS[kind];
  if (!key || !item || typeof item.name !== 'string' || !item.name.trim()) {
    return { ok: false, error: '名称不能为空' };
  }
  const data = read();
  const arr = data[key];
  const idx = item.id ? arr.findIndex((x) => x.id === item.id) : -1;
  if (idx >= 0 && arr[idx].preset) return { ok: false, error: '预置模板不可直接修改,请复制为副本' };
  const clean = kind === 'skill' ? cleanSkill(item, idx >= 0 ? arr[idx] : null)
    : cleanAgent(item, idx >= 0 ? arr[idx] : null);
  if (idx >= 0) arr[idx] = clean; else arr.push(clean);
  write(data);
  return { ok: true, item: clean };
}

function remove(kind, id) {
  const key = KINDS[kind];
  if (!key) return { ok: false, error: '未知类型' };
  const data = read();
  const it = data[key].find((x) => x.id === id);
  if (!it) return { ok: false, error: '条目不存在' };
  if (it.preset) return { ok: false, error: '预置模板不可删除' };
  data[key] = data[key].filter((x) => x.id !== id);
  write(data);
  return { ok: true };
}

// 首次启动播种预置模板;已存在的 id 跳过,绝不覆盖用户数据
function seedPresets() {
  const data = read();
  let changed = false;
  const seed = (key, presets, extra) => {
    const ids = new Set(data[key].map((x) => x.id));
    for (const p of presets) {
      if (ids.has(p.id)) continue;
      data[key].push({
        files: [], tools: [], model: null, scope: 'global', scopeId: null,
        ...p, ...extra, enabled: true, preset: true, createdAt: now(), updatedAt: now(),
      });
      changed = true;
    }
  };
  seed('skills', PRESET_SKILLS);
  seed('agents', PRESET_AGENTS);
  if (changed) write(data);
}

// ---------------------------------------------------------------------------
// Skill 渐进式披露
// ---------------------------------------------------------------------------
// 会话挂载池:meta.skillIds → 启用中的 skill 列表(保持传入顺序)
function mountedSkills(skillIds) {
  if (!Array.isArray(skillIds) || !skillIds.length) return [];
  const all = list('skill');
  const out = [];
  for (const id of skillIds) {
    const s = all.find((x) => x.id === id);
    if (s && s.enabled !== false) out.push(s);
  }
  return out;
}

// systemPrompt 索引:只放名称+描述+调用指引;pinned(本条手动指定)标注最高优先级
function buildSkillsIndex(skills, pinnedIds) {
  if (!skills || !skills.length) return '';
  const pinned = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  let text = '\n\n<drafter-skills>\n本会话挂载了以下技能。当任务匹配某个技能的描述时,'
    + '调用 use_skill 工具(参数 name 为技能名)取回完整指令后再执行;不要凭描述猜测细节。\n';
  for (const s of skills) text += `- ${s.name}: ${s.desc || '(无描述)'}\n`;
  const pinnedSkills = skills.filter((s) => pinned.has(s.id));
  if (pinnedSkills.length) {
    text += `\n注意:用户已为本条消息手动指定技能「${pinnedSkills.map((s) => s.name).join('、')}」,`
      + '其完整指令已随消息注入,优先级最高——同类需求直接遵循它们,无需再调用 use_skill 取回。\n';
  }
  return (text + '</drafter-skills>\n').slice(0, MAX_APPEND);
}

// 手动指定技能的全文块(拼到该条用户消息前)
function composePinnedSkills(skills) {
  if (!skills || !skills.length) return '';
  let text = '';
  for (const s of skills) {
    text += `<drafter-skill name="${s.name}">\n用户为本条消息指定使用技能「${s.name}」,请严格遵循:\n`;
    if (s.desc) text += `说明:${s.desc}\n`;
    text += `\n指令:\n${s.instructions}\n`;
    if (Array.isArray(s.files) && s.files.length) {
      text += `\n参考文件:\n`;
      for (const f of s.files) {
        text += `- ${f.name}\n`;
        if (f.content) text += `  内容摘录:\n  ${String(f.content).slice(0, MAX_FILE_INLINE).replace(/\n/g, '\n  ')}\n`;
      }
    }
    text += `</drafter-skill>\n\n`;
  }
  return text.slice(0, MAX_APPEND);
}

// use_skill 工具处理器(纯函数):name 命中挂载池返回全文;已 pinned 提示直接用;否则报错
function useSkill(name, skillIds, pinnedIds) {
  const mounted = mountedSkills(skillIds);
  const target = mounted.find((s) => s.name === name || s.id === name);
  if (!target) {
    return { ok: false, error: `技能「${name}」未挂载到本会话。可用:${mounted.map((s) => s.name).join('、') || '(无)'}` };
  }
  if (Array.isArray(pinnedIds) && pinnedIds.includes(target.id)) {
    return { ok: true, name: target.name, alreadyPinned: true, text: `技能「${target.name}」的完整指令已随本条消息注入,直接遵循即可。` };
  }
  return { ok: true, name: target.name, instructions: target.instructions, files: target.files || [] };
}

// ---------------------------------------------------------------------------
// 自定义子 Agent:按作用域过滤后合并进 SDK options.agents
// ---------------------------------------------------------------------------
function scopeMatches(agent, meta) {
  if (!meta) return agent.scope === 'global';
  if (agent.scope === 'project') return !!agent.scopeId && agent.scopeId === meta.projectId;
  if (agent.scope === 'session') {
    return agent.scopeId === meta.id
      || (Array.isArray(meta.customAgentIds) && meta.customAgentIds.includes(agent.id));
  }
  return true; // global
}

// 返回 { agents: {定义名: AgentDefinition}, allowedAgents: Map(名→固定模型|null) };
// used: 名称去重集合(与 buildSessionAgents 的模型 agent 共用),冲突加 -2/-3 后缀
function buildCustomAgents(meta, used) {
  const agents = {};
  const allowedAgents = new Map();
  const usedNames = used || new Set();
  for (const a of list('agent')) {
    if (a.enabled === false || !scopeMatches(a, meta)) continue;
    let name = slugify(a.name, 'custom');
    if (usedNames.has(name)) {
      let i = 2;
      while (usedNames.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
    usedNames.add(name);
    const model = a.model ? String(a.model).split('|')[1] || null : null; // 'keyId|model' → model
    const def = {
      description: a.desc || `自定义子 Agent「${a.name}」`,
      prompt: a.prompt,
      // 子 Agent 不得再派生下级/给其他任务发消息——嵌套委派绕开主会话的模型白名单
      disallowedTools: ['Agent', 'Task', 'Workflow', 'SendMessage'],
    };
    if (model) def.model = model;
    if (Array.isArray(a.tools) && a.tools.length) def.tools = a.tools;
    agents[name] = def;
    allowedAgents.set(name, model); // null = 守卫放行但不钉模型(跟随会话默认)
  }
  return { agents, allowedAgents };
}

// ---------------------------------------------------------------------------
// 导入/导出:Claude Code 原生 frontmatter 格式
// ---------------------------------------------------------------------------
function serializeMd(item, kind) {
  const lines = ['---', `name: ${slugify(item.name, item.name)}`, `description: ${item.desc || ''}`];
  if (kind === 'agent') {
    if (item.model) lines.push(`model: ${String(item.model).split('|')[1] || item.model}`);
    if (item.tools && item.tools.length) lines.push(`tools: ${item.tools.join(', ')}`);
  }
  lines.push('---', '');
  let body = kind === 'skill' ? (item.instructions || '') : (item.prompt || '');
  if (kind === 'skill' && Array.isArray(item.files)) {
    for (const f of item.files) {
      body += `\n\n## 参考文件:${f.name}\n\n\`\`\`\n${f.content || ''}\n\`\`\``;
    }
  }
  return lines.join('\n') + body.trim() + '\n';
}

// 容错解析:无 frontmatter 时整段当正文;字段缺失给默认值
function parseMd(text, kind) {
  const src = String(text || '');
  let fm = {};
  let body = src;
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      fm[kv[1]] = kv[2].trim();
    }
  }
  const files = [];
  if (kind === 'skill') {
    // 还原 serializeMd 的「## 参考文件:name + ```块」结构
    body = body.replace(/\n*## 参考文件:([^\n]+)\n+```[^\n]*\n([\s\S]*?)```/g, (_all, name, content) => {
      files.push({ name: name.trim(), content: content.replace(/\n$/, '') });
      return '';
    }).trim();
  }
  const item = {
    id: null,
    name: (fm.name || '').trim(),
    desc: fm.description || '',
    enabled: true,
  };
  if (kind === 'skill') {
    item.instructions = body.trim();
    item.files = files;
  } else {
    item.prompt = body.trim();
    item.tools = fm.tools ? fm.tools.split(/[,，]\s*/).filter(Boolean) : [];
    item.model = null; // 导入的 model 不绑定本机 Key,一律置空由用户重选
    item.scope = 'global';
    item.scopeId = null;
  }
  return item;
}

// ---------------------------------------------------------------------------
// AI 起草 prompt
// ---------------------------------------------------------------------------
function buildDraftPrompt(kind, hint, existing) {
  const base = kind === 'skill'
    ? '为一个 AI 编程助手撰写技能(Skill)指令。技能是按需调用的能力包,模型会在匹配场景下取回并遵循。'
      + '按三个部分组织:「何时触发」(一句话,会作为触发描述)、「执行步骤」(编号列表,每步一句话)、「输出格式」(一段)。'
    : '为一个自定义子 Agent 撰写系统提示词。子 Agent 由主会话委派独立子任务。'
      + '按三个部分组织:「角色」(一句话)、「职责边界」(该做什么/绝不做什么)、「汇报方式」(完成后向主会话回报的格式)。';
  return base + '只输出指令/提示词本身,不要解释,不要包裹代码块。'
    + '\n\n目标描述:' + String(hint || '').slice(0, 500)
    + (existing ? '\n\n现有内容(在其基础上改写完善):\n' + String(existing).slice(0, 4000) : '');
}

module.exports = {
  list, byId, save, remove, seedPresets,
  mountedSkills, buildSkillsIndex, composePinnedSkills, useSkill,
  buildCustomAgents, scopeMatches, slugify,
  serializeMd, parseMd, buildDraftPrompt,
  MAX_FILES, MAX_INSTRUCTIONS,
};
