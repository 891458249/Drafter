// 受管启动下的 node --test 包装器(v0.15.17):
// debug-runtime 的 launch 拿不到子进程 stdout/stderr(见 .claude-ui/memory.md),
// 所以由本脚本自己 spawn 测试进程并把两路输出落盘,便于事后读取。
//
// 用法:node .claude-ui/run-tests-managed.js <输出文件> <测试文件...>
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const files = process.argv.slice(3);
const root = path.resolve(__dirname, '..');

if (!out || !files.length) {
  console.error('usage: node run-tests-managed.js <outFile> <testFile...>');
  process.exit(2);
}

const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8' });
fs.writeFileSync(out, (r.stdout || '') + (r.stderr || ''), 'utf8');
// 结果也回显一份,万一受管层将来能转发 stdout 也不丢
process.stdout.write(`TESTS-DONE status=${r.status}\n`);
process.exit(typeof r.status === 'number' ? r.status : 1);
