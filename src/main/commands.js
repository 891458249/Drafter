// Slash commands: built-ins + user (~/.claude/commands) + project (.claude/commands).
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILTINS = [
  { name: '/compact', description: '压缩会话上下文' },
  { name: '/clear', description: '清空上下文开始新话题' },
  { name: '/review', description: '审查当前改动' },
  { name: '/init', description: '生成 CLAUDE.md' },
  { name: '/help', description: '帮助' },
];

function scanDir(dir, source) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      // namespaced commands: <dir>/<ns>/<cmd>.md -> /ns:cmd
      for (const sub of scanDir(path.join(dir, e.name), source)) {
        out.push({ ...sub, name: '/' + e.name + ':' + sub.name.slice(1) });
      }
    } else if (e.name.endsWith('.md')) {
      const name = '/' + e.name.replace(/\.md$/, '');
      let description = '';
      try {
        const head = fs.readFileSync(path.join(dir, e.name), 'utf8').slice(0, 2000);
        const fm = head.match(/^---\n[\s\S]*?description:\s*(.+)\n[\s\S]*?---/);
        if (fm) description = fm[1].trim();
        else description = (head.split('\n').find((l) => l.trim()) || '').slice(0, 80);
      } catch {}
      out.push({ name, description, source });
    }
  }
  return out;
}

function listCommands(cwd) {
  const user = scanDir(path.join(os.homedir(), '.claude', 'commands'), 'user');
  const project = cwd ? scanDir(path.join(cwd, '.claude', 'commands'), 'project') : [];
  const seen = new Set();
  const all = [];
  for (const c of [...project, ...user, ...BUILTINS.map((b) => ({ ...b, source: 'builtin' }))]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    all.push(c);
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listCommands };
