// git.js smoke tests: isRepo detection and diffStat on a real temp repo.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const git = require('../src/main/git');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-git-test-'));
const repoDir = path.join(tmp, 'repo');
const plainDir = path.join(tmp, 'plain');
fs.mkdirSync(repoDir);
fs.mkdirSync(plainDir);

const gitCli = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' });

gitCli(['init'], repoDir);
gitCli(['config', 'user.email', 'test@example.com'], repoDir);
gitCli(['config', 'user.name', 'test'], repoDir);
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello\n');
gitCli(['add', '.'], repoDir);
gitCli(['commit', '-m', 'init'], repoDir);

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('isRepo: git 仓库返回 true,普通目录返回 false', async () => {
  assert.strictEqual(await git.isRepo(repoDir), true);
  assert.strictEqual(await git.isRepo(plainDir), false);
});

test('diffStat: 有改动时返回非空文件列表(含 tracked 修改与 untracked)', async () => {
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'more\n');
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'new file\n');

  const stat = await git.diffStat(repoDir);
  assert.strictEqual(stat.isRepo, true);
  assert.ok(stat.files.length >= 2, `期望至少 2 个文件,实际 ${stat.files.length}`);

  const a = stat.files.find((f) => f.path === 'a.txt');
  assert.ok(a, 'a.txt 应在 diffStat 中');
  assert.ok(a.added >= 1, 'a.txt 应有新增行');
  assert.strictEqual(a.untracked, false);

  const b = stat.files.find((f) => f.path === 'b.txt');
  assert.ok(b, 'b.txt 应作为 untracked 出现');
  assert.strictEqual(b.untracked, true);
});

test('diffStat: 非仓库目录返回 isRepo=false 且不抛错', async () => {
  const stat = await git.diffStat(plainDir);
  assert.strictEqual(stat.isRepo, false);
  assert.deepStrictEqual(stat.files, []);
});
