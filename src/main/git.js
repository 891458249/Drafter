// Git helpers: status, diff, worktrees, PR info via gh CLI.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cmd, args, cwd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

const git = (args, cwd) => run('git', args, cwd);

async function isRepo(cwd) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

async function branchInfo(cwd) {
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return { branch: b.ok ? b.stdout.trim() : null };
}

// Changed files with +n -n counts (working tree vs HEAD, incl. untracked).
async function diffStat(cwd) {
  if (!(await isRepo(cwd))) return { isRepo: false, files: [] };
  const files = new Map();
  const numstat = await git(['diff', 'HEAD', '--numstat'], cwd);
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) files.set(m[3], { path: m[3], added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2], untracked: false });
    }
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd);
  if (untracked.ok) {
    for (const f of untracked.stdout.split('\n').filter(Boolean)) {
      if (!files.has(f)) {
        let added = 0;
        try { added = fs.readFileSync(path.join(cwd, f), 'utf8').split('\n').length; } catch {}
        files.set(f, { path: f, added, removed: 0, untracked: true });
      }
    }
  }
  return { isRepo: true, files: [...files.values()] };
}

// Unified diff for one file (untracked files rendered as all-added).
async function diffFile(cwd, file, untracked) {
  if (untracked) {
    try {
      const content = fs.readFileSync(path.join(cwd, file), 'utf8');
      const lines = content.split('\n');
      const body = lines.map((l) => '+' + l).join('\n');
      return { ok: true, diff: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  const r = await git(['diff', 'HEAD', '--', file], cwd);
  return r.ok ? { ok: true, diff: r.stdout } : { ok: false, error: r.stderr };
}

// --- Worktrees (per-session isolation) ---
function worktreeRoot(repo) {
  return path.join(repo, '.claude-ui-worktrees');
}

async function createWorktree(repo, name) {
  if (!(await isRepo(repo))) return { ok: false, error: '不是 git 仓库,无法创建 worktree' };
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'session';
  const dir = path.join(worktreeRoot(repo), safe);
  const branch = 'claude-ui/' + safe;
  const r = await git(['worktree', 'add', '-b', branch, dir], repo);
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout };
  // keep worktree dir out of the repo's status
  try {
    const excl = path.join(repo, '.git', 'info', 'exclude');
    const line = '.claude-ui-worktrees/';
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.includes(line)) fs.appendFileSync(excl, '\n' + line + '\n');
  } catch {}
  return { ok: true, dir, branch };
}

async function removeWorktree(repo, dir) {
  const r = await git(['worktree', 'remove', '--force', dir], repo);
  return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout) };
}

// --- PR monitoring via gh CLI ---
async function prStatus(cwd) {
  const r = await run('gh', ['pr', 'view', '--json',
    'number,title,url,state,mergeable,statusCheckRollup,reviewDecision'], cwd, 20000);
  if (!r.ok) {
    const msg = (r.stderr || '').trim();
    if (/no pull requests found|not found/i.test(msg)) return { ok: true, pr: null };
    return { ok: false, error: msg || 'gh 执行失败(未安装或未登录?)' };
  }
  try {
    const pr = JSON.parse(r.stdout);
    const checks = (pr.statusCheckRollup || []).map((c) => ({
      name: c.name || c.context || '',
      status: c.status || c.state || '',
      conclusion: c.conclusion || c.state || '',
      url: c.detailsUrl || c.targetUrl || '',
    }));
    return { ok: true, pr: { number: pr.number, title: pr.title, url: pr.url, state: pr.state, reviewDecision: pr.reviewDecision, mergeable: pr.mergeable, checks } };
  } catch (e) {
    return { ok: false, error: 'gh 输出解析失败: ' + e.message };
  }
}

module.exports = { isRepo, branchInfo, diffStat, diffFile, createWorktree, removeWorktree, prStatus, run };
