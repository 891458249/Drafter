// sessions.js 会话记录迁移(v0.9.10):encodeCwdForProjects 编码规则 / migrateTranscript 复制
// 背景:cwd 切换(设为项目文件夹)后 Claude Code 按新 cwd 目录找 <sid>.jsonl,
// 找不到会报 "No conversation found with session ID" 使会话作废。
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-transcript-test-'));
installElectronStub(tmp);
// 必须在 require sessions 之前:sessions.js 模块加载时按 CLAUDE_CONFIG_DIR 定位记录根目录
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-cfg');
const { encodeCwdForProjects, migrateTranscript, transcriptPath, isTranscriptResumable } = require('../src/main/sessions');

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
const SID = 'test-session-id-123';

function seedTranscript(cwd, content = '{"type":"user"}\n') {
  const dir = path.join(PROJECTS, encodeCwdForProjects(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), content);
}

beforeEach(() => {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('encodeCwdForProjects:非字母数字一律替换为 -(与 claude.exe 的 A0 一致)', () => {
  assert.strictEqual(encodeCwdForProjects('C:\\Users\\dingyongzhen'), 'C--Users-dingyongzhen');
  assert.strictEqual(encodeCwdForProjects('D:\\ClaudeUI'), 'D--ClaudeUI');
  assert.strictEqual(encodeCwdForProjects('D:\\临时测试 abc'), 'D-------abc'); // : \ 4个中文字符 空格 → 7 个 '-'
});

test('encodeCwdForProjects:超 200 字符截断并加哈希后缀', () => {
  const longCwd = 'D:\\' + 'a'.repeat(300);
  const enc = encodeCwdForProjects(longCwd);
  const head = longCwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
  assert.ok(enc.startsWith(head + '-'));
  assert.ok(/^-[0-9a-z]+$/.test(enc.slice(200)), '后缀应为 base36 哈希');
  assert.strictEqual(enc, encodeCwdForProjects(longCwd), '同输入编码应稳定');
});

test('isTranscriptResumable:有效 JSONL 最后一行可恢复,不存在或截断则降级', () => {
  const cwd = 'D:\\ResumeCheck';
  assert.strictEqual(transcriptPath(SID, cwd), path.join(PROJECTS, encodeCwdForProjects(cwd), SID + '.jsonl'));
  assert.strictEqual(isTranscriptResumable(SID, cwd), false, '不存在的记录不可恢复');
  seedTranscript(cwd, '{"type":"user"}\n{"type":"assistant"}\n');
  assert.strictEqual(isTranscriptResumable(SID, cwd), true, '最后一条完整 JSON 可恢复');
  seedTranscript(cwd, '{"type":"user"}\n{"type":"assistant"');
  assert.strictEqual(isTranscriptResumable(SID, cwd), false, '中断写入的末行不可恢复');
});

test('migrateTranscript:旧目录记录复制到新目录,原文件保留', () => {
  const oldCwd = 'C:\\Users\\someone';
  const newCwd = 'D:\\NewProject';
  seedTranscript(oldCwd);
  assert.strictEqual(migrateTranscript(SID, oldCwd, newCwd), true);
  const dst = path.join(PROJECTS, encodeCwdForProjects(newCwd), SID + '.jsonl');
  const src = path.join(PROJECTS, encodeCwdForProjects(oldCwd), SID + '.jsonl');
  assert.ok(fs.existsSync(dst), '新目录应有记录');
  assert.ok(fs.existsSync(src), '旧目录记录保留(留底)');
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), '{"type":"user"}\n');
});

test('migrateTranscript:新目录已有记录则跳过不覆盖', () => {
  const oldCwd = 'C:\\Users\\someone';
  const newCwd = 'D:\\NewProject';
  seedTranscript(oldCwd, 'old\n');
  seedTranscript(newCwd, 'new\n');
  assert.strictEqual(migrateTranscript(SID, oldCwd, newCwd), true);
  const dst = path.join(PROJECTS, encodeCwdForProjects(newCwd), SID + '.jsonl');
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'new\n');
});

test('migrateTranscript:登记的旧 cwd 无记录时兜底扫描其他目录(连续两次 adopt)', () => {
  const home = 'C:\\Users\\someone';
  const firstProj = 'D:\\ProjectA';
  const secondProj = 'D:\\ProjectB';
  seedTranscript(home); // 记录停在最初的 cwd(prevCwd 只会登记 ProjectA)
  assert.strictEqual(migrateTranscript(SID, firstProj, secondProj), true);
  const dst = path.join(PROJECTS, encodeCwdForProjects(secondProj), SID + '.jsonl');
  assert.ok(fs.existsSync(dst), '应从主目录兜底复制到最新 cwd');
});

test('migrateTranscript:旧目录无记录返回 false(调用方应清 sdkSessionId)', () => {
  assert.strictEqual(migrateTranscript(SID, 'C:\\Users\\nobody', 'D:\\Nowhere'), false);
  assert.strictEqual(migrateTranscript('', 'C:\\a', 'D:\\b'), false);
});
