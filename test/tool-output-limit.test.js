const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guardOversizedSkill, SKILL_OUTPUT_LIMIT } = require('../src/main/tool-output-limit');

test('unrelated tools and invalid skill names are unchanged', () => {
  assert.deepEqual(guardOversizedSkill({ tool_name: 'Read', tool_input: { skill: 'x' } }), {});
  assert.deepEqual(guardOversizedSkill({ tool_name: 'Skill', tool_input: { skill: '../private' } }), {});
});

test('bundled claude-api is denied with instructions for selective reading', () => {
  const output = guardOversizedSkill({ tool_name: 'Skill', tool_input: { skill: 'claude-api' } });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /shared/);
});

test('oversized local skill is denied before execution, small skill stays available', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-skill-limit-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = tmp;
    const dir = path.join(tmp, 'skills', 'large');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, 'a'.repeat(600000));
    const output = guardOversizedSkill({ tool_name: 'Skill', tool_input: { skill: 'large' } });
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /Read 工具/);
    assert.equal(fs.statSync(file).size, 600000);
    fs.writeFileSync(file, 'a'.repeat(SKILL_OUTPUT_LIMIT));
    assert.deepEqual(guardOversizedSkill({ tool_name: 'Skill', tool_input: { skill: 'large' } }), {});
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
