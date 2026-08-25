// Drafter Gem / 项目组上下文 → harness system-prompt 分段(Phase 4)。
//
// Gem(src/main/gems.js)是 Drafter 的自定义助手:{ name, desc, instructions, tools, knowledge }。
// harness 侧对应物是 **agent preset + persona**(packages/preset/agent-presets + persona):
//   preset = 一个目录 + agent.cordis.yml(挂工具/persona 行),persona 行把 Gem 指令渲染为
//   `deployment:persona` 提示词段落。
//
// 项目组共享记忆(src/main/projects.js 的 <drafter-project-group> 注入)→ harness 的
//   systemPrompt.section({ name, order, text }) 注册(按会话 scope 生效)。
//
// 本模块只做「文本/结构映射」与「调 harness 服务」;不写文件、不管 UI。

const gems = require('../gems')
const projects = require('../projects')

// —— Gem → persona 文本 ————————————————————————————————————————————————————————

/** 把一个 Gem 渲染成 harness persona 行的 text(人设段落)。 */
function gemToPersonaText(gem) {
  if (!gem) return ''
  // 复用 Drafter 现有的 composeAppend 文本(它已经是完整的 <drafter-gem> 块),
  // 去掉外层 XML 包裹、保留纯指令内容,persona 段落自己会加 harness 身份开场白。
  const raw = gems.composeAppend(gem)
  return raw.trim()
}

// —— Gem → agent preset 组装(cordis.yml 文本)———————————————————————————————
// preset 目录里放一份 agent.cordis.yml,挂一个 persona 行承载 Gem 指令。
// 工具白名单:Gem.tools 是 Drafter 的工具偏好(自然语言),harness 的工具 schema 由
// preset 挂载决定——此处先不映射工具(工具体系不同构),只承载人设;工具偏好文本已含在指令里。

/** 生成一个 Gem 对应的 agent.cordis.yml 内容(preset 组装文件)。 */
function gemToPresetYaml(gem) {
  const personaText = gemToPersonaText(gem)
  // persona 行的 config.text 是模板字符串;注意 YAML 转义(用块标量避免引号问题)
  const indented = personaText.split('\n').map((l) => '      ' + l).join('\n')
  return [
    '# Drafter Gem 自动生成的 agent preset(由 gems-bridge 同步,勿手改)',
    `- id: persona`,
    `  name: '@deepseek-ai/dsh-persona'`,
    `  config:`,
    `    text: |`,
    indented,
    '',
  ].join('\n')
}

/** Gem id → preset id(harness preset id 要求 [a-z0-9][a-z0-9-]*)。 */
function gemIdToPresetId(gemId) {
  const safe = String(gemId || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '')
  return ('gem-' + safe).replace(/^([0-9])/, 'g$1').slice(0, 64) || 'gem-default'
}

// —— 项目组上下文 → system-prompt section ————————————————————————————————————

/** 把一个项目组的共享记忆/上下文渲染成 harness systemPrompt section 文本。 */
function projectGroupToSectionText(projectGroup) {
  if (!projectGroup) return ''
  // projects.js 的注入文本是 <drafter-project-group> 块;复用它的内容
  // (这里只读它的内存态;真实注入文本由 projects.js 在会话启动时拼)
  const name = projectGroup.name || projectGroup.id || '未命名项目组'
  const memory = projectGroup.memory || ''
  let text = `<drafter-project-group>\n你在 Drafter 的项目组「${name}」中,该组内可能有多个并行会话。\n共享记忆文件:${projectGroup.memoryPath || ''}\n规则:\n1. 得出对项目后续工作有价值的结论、决定或阶段性进展时,主动把要点追加到共享记忆文件(保持精炼,一条一行)。\n2. 开始复杂任务前,如需了解其他会话的进展,读取共享记忆文件。\n`
  if (memory) text += `\n当前共享记忆内容:\n${memory}\n`
  text += `</drafter-project-group>`
  return text
}

// —— 应用侧:注册进 harness 运行时 ————————————————————————————————————————————

/**
 * 把一个 Gem 注册为 harness 的常驻 prompt section(按会话 scope)。
 * @param {object} harnessCtx - boot 后的 Cordis Context
 * @param {object} gem - Drafter Gem 对象
 * @param {object} [scopeCtx] - 可选的会话 scope 上下文(缺省全局)
 * @returns {Function} disposer(取消注册)
 */
function registerGemSection(harnessCtx, gem, scopeCtx) {
  const systemPrompt = harnessCtx.get('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    throw new Error('harness 缺 systemPrompt 服务')
  }
  const text = gemToPersonaText(gem)
  const ctx = scopeCtx || harnessCtx
  return ctx.systemPrompt.section({
    name: `drafter-gem-${gem.id}`,
    order: 10, // 在 harness 身份(-100)与部署 persona(0)之后
    text,
  })
}

/**
 * 把项目组上下文注册为 harness 的 prompt section(按会话 scope)。
 */
function registerProjectGroupSection(harnessCtx, projectGroup, scopeCtx) {
  const systemPrompt = harnessCtx.get('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    throw new Error('harness 缺 systemPrompt 服务')
  }
  const ctx = scopeCtx || harnessCtx
  return ctx.systemPrompt.section({
    name: `drafter-project-group-${projectGroup.id}`,
    order: 20,
    text: projectGroupToSectionText(projectGroup),
  })
}

module.exports = {
  gemToPersonaText,
  gemToPresetYaml,
  gemIdToPresetId,
  projectGroupToSectionText,
  registerGemSection,
  registerProjectGroupSection,
}
