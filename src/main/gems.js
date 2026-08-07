// Gem 自定义助手(v0.9.11):可复用的「角色包」——名称/说明/指令/默认工具/知识文件,
// 绑定到会话后经 systemPrompt append(SDK 会话)或 prompt 前缀(媒体板块)注入。
// 存储走 store settings.gems;预置 Gem(preset:true)不可改删,只能复制副本后编辑。
// 本模块不依赖 electron(便于单测),store 在 require 时注入。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_INSTRUCTIONS = 30000;  // 指令上限
const MAX_KNOWLEDGE = 10;        // 知识文件数量上限(对齐 Gemini)
const MAX_APPEND = 8000;         // composeAppend 总量截断
const MAX_FILE_INLINE = 2000;    // 单个文本文件内联前 N 字符
const MAX_FILE_BYTES = 200 * 1024; // 超过此大小的文件不内联,只列路径
const MEDIA_PREFIX_MAX = 2000;   // 媒体板块指令前缀截断

// 预置 Gem(preset:true):指令参照 Gemini 官方「角色/任务/情境/形式」四要素
const PRESETS = [
  {
    id: 'gem_preset_coding',
    name: '编程伙伴',
    desc: '资深全栈工程师,结对编程与代码审查',
    instructions: [
      '角色:你是一位资深全栈软件工程师,精通多语言与系统架构,擅长结对编程与代码审查。',
      '任务:帮助用户编写、调试、重构代码,解释复杂概念,给出可直接落地的实现方案。',
      '情境:用户是开发者,重视代码质量、可维护性与性能;回答应包含可运行的代码示例。',
      '形式:先给结论,再给代码,最后简要说明取舍;代码块标注语言;改动建议附原因。',
    ].join('\n'),
  },
  {
    id: 'gem_preset_writing',
    name: '写作编辑助手',
    desc: '润色文稿、调整语气与结构',
    instructions: [
      '角色:你是一位专业的文字编辑与写作教练,擅长中英文写作。',
      '任务:润色文稿、修正语病、调整语气与结构,并说明每处修改的理由。',
      '情境:用户需要清晰、有说服力的表达;保留原作者的个人风格。',
      '形式:先给修改后的版本,再用列表说明主要改动;可选给出多种风格供选择。',
    ].join('\n'),
  },
  {
    id: 'gem_preset_brainstorm',
    name: '头脑风暴助手',
    desc: '发散思路,产出大量创意',
    instructions: [
      '角色:你是一位创意总监,擅长发散思维与跨界联想。',
      '任务:围绕用户的主题产出大量、多样化的创意,不急于评判,先求数量再求质量。',
      '情境:用户处于探索阶段,需要打破常规的视角;鼓励大胆、意想不到的组合。',
      '形式:以编号列表给出至少 10 个创意,每条一句话;最后挑 3 个最有潜力的展开说明。',
    ].join('\n'),
  },
  {
    id: 'gem_preset_tutor',
    name: '学习辅导',
    desc: '循循善诱的个性化导师',
    instructions: [
      '角色:你是一位循循善诱的导师,擅长把复杂概念拆解成易懂的步骤。',
      '任务:帮助用户理解新知识,通过提问引导思考,而不是直接给答案。',
      '情境:用户正在学习,可能有基础薄弱处;需要鼓励与循序渐进的讲解。',
      '形式:先诊断用户的理解程度,再分层讲解;穿插小练习;结尾总结要点并预告下一步。',
    ].join('\n'),
  },
];

function now() { return Date.now(); }

// 首次启动播种预置 Gem;已存在的 id 跳过,绝不覆盖用户数据
function seedPresets() {
  const gems = list();
  const ids = new Set(gems.map((g) => g.id));
  let changed = false;
  for (const p of PRESETS) {
    if (ids.has(p.id)) continue;
    gems.push({ ...p, tools: [], model: null, knowledge: [], knowledgeEnabled: true, preset: true, createdAt: now(), updatedAt: now() });
    changed = true;
  }
  if (changed) store.setSetting('gems', gems);
}

function list() {
  const g = store.getSetting('gems', []);
  return Array.isArray(g) ? g : [];
}

function byId(id) {
  return list().find((g) => g.id === id) || null;
}

// upsert;preset 项拒绝直改(返回 {ok:false});name 必填;字段做兜底与截断
function save(gem) {
  if (!gem || typeof gem.name !== 'string' || !gem.name.trim()) return { ok: false, error: '名称不能为空' };
  const gems = list();
  const idx = gem.id ? gems.findIndex((g) => g.id === gem.id) : -1;
  if (idx >= 0 && gems[idx].preset) return { ok: false, error: '预置 Gem 不可直接修改,请复制为副本' };
  const clean = {
    id: gem.id || ('gem_' + crypto.randomUUID().slice(0, 12)),
    name: gem.name.trim().slice(0, 60),
    desc: String(gem.desc || '').slice(0, 200),
    instructions: String(gem.instructions || '').slice(0, MAX_INSTRUCTIONS),
    tools: Array.isArray(gem.tools) ? gem.tools.map(String).slice(0, 10) : [],
    model: gem.model || null,
    knowledge: (Array.isArray(gem.knowledge) ? gem.knowledge : [])
      .filter((k) => k && k.path && fs.existsSync(k.path))
      .slice(0, MAX_KNOWLEDGE)
      .map((k) => ({ path: k.path, name: k.name || path.basename(k.path) })),
    knowledgeEnabled: gem.knowledgeEnabled !== false,
    preset: false,
    createdAt: idx >= 0 ? gems[idx].createdAt : now(),
    updatedAt: now(),
  };
  if (idx >= 0) gems[idx] = clean; else gems.push(clean);
  store.setSetting('gems', gems);
  return { ok: true, gem: clean };
}

function remove(id) {
  const gems = list();
  const g = gems.find((x) => x.id === id);
  if (!g) return { ok: false, error: 'Gem 不存在' };
  if (g.preset) return { ok: false, error: '预置 Gem 不可删除' };
  store.setSetting('gems', gems.filter((x) => x.id !== id));
  return { ok: true };
}

// 注入 SDK 会话的 systemPrompt append 文本
function composeAppend(gem) {
  if (!gem) return '';
  let text = `\n\n<claude-ui-gem name="${gem.name}">\n`;
  text += `你以自定义助手「${gem.name}」的身份运行。\n`;
  if (gem.desc) text += `说明:${gem.desc}\n`;
  if (gem.instructions) text += `\n指令:\n${gem.instructions}\n`;
  if (gem.tools && gem.tools.length) {
    text += `\n默认工具偏好:用户希望此助手优先使用以下能力——${gem.tools.join('、')}。\n`;
  }
  if (gem.knowledgeEnabled && Array.isArray(gem.knowledge) && gem.knowledge.length) {
    text += `\n知识文件(用户提供的参考资料):\n`;
    for (const k of gem.knowledge) {
      text += `- ${k.path}\n`;
      try {
        const st = fs.statSync(k.path);
        if (st.isFile() && st.size <= MAX_FILE_BYTES && /\.(txt|md|markdown|json|js|ts|py|java|c|cpp|h|css|html|xml|yml|yaml|csv|log)$/i.test(k.path)) {
          const content = fs.readFileSync(k.path, 'utf8').slice(0, MAX_FILE_INLINE);
          text += `  内容摘录:\n  ${content.replace(/\n/g, '\n  ')}\n`;
        }
      } catch {} // 读取失败只保留路径
    }
  }
  text += `</claude-ui-gem>\n`;
  return text.slice(0, MAX_APPEND);
}

// 媒体板块(image/video/audio/model)的 prompt 前缀:把 Gem 指令拼在用户 prompt 前
function composeMediaPrefix(gem) {
  if (!gem || !gem.instructions) return '';
  return `【以「${gem.name}」的身份与要求生成】\n${gem.instructions.slice(0, MEDIA_PREFIX_MAX)}\n\n用户需求:\n`;
}

module.exports = {
  list, byId, save, remove, seedPresets, composeAppend, composeMediaPrefix,
  MAX_KNOWLEDGE, MAX_INSTRUCTIONS,
};
