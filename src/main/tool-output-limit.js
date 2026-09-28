const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_OUTPUT_LIMIT = 24000;

// 内置 Skill 的 PostToolUse 响应仅有 {success,commandName};正文随后作为单独消息
// 注入,无法通过 updatedToolOutput 截断。必须在调用之前阻止过大的入口文件。
function guardOversizedSkill(input) {
  if (input?.tool_name !== 'Skill') return {};
  const name = input.tool_input?.skill;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '.' || name === '..') return {};
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  // claude-api 是 claude.exe 内置的组合技能,并无 SKILL.md;现场实测展开后
  // 注入约 58 万字符。其缓存位于系统临时目录,与 CLAUDE_CONFIG_DIR 无关。
  if (name === 'claude-api') return { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `内置 claude-api 技能会一次注入整套超大文档。请先在 ${path.join(os.tmpdir(), 'claude', 'bundled-skills')} 中查找 claude-api 目录,再用 Read 按需读取相关语言或 shared 下的文件,不要一次载入整个技能。`,
  } };
  const dirs = [path.join(configDir, 'skills', name)];
  for (const dir of dirs) {
    const file = path.join(dir, 'SKILL.md');
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size <= SKILL_OUTPUT_LIMIT) continue;
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `技能 ${name} 的入口文件超过 ${SKILL_OUTPUT_LIMIT} 字节。请改用 Read 工具按需读取 ${file} 的相关章节,不要一次载入整份文档。`,
    } };
  }
  return {};
}

module.exports = { guardOversizedSkill, SKILL_OUTPUT_LIMIT };
