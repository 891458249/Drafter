const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const harness = path.join(root, 'vendor', 'deepseek-harness');
const required = [
  'src/harness/dist/ipc-client-entry.mjs',
  'vendor/deepseek-harness/apps/web/dist/index.html',
  'vendor/deepseek-harness/packages/host/apiproxy/lib/index.js',
  'vendor/deepseek-harness/packages/bundle/base/cordis.patch.yml',
  'vendor/deepseek-harness/vendor-deps/js-yaml/dist/js-yaml.mjs',
];

function assertFiles(paths) {
  const missing = paths.filter((p) => !fs.existsSync(path.resolve(root, p)) || !fs.statSync(path.resolve(root, p)).isFile());
  if (missing.length) throw new Error('缺少构建依赖/产物：\n' + missing.join('\n') + '\n先运行 npm ci 和 pnpm --dir vendor/deepseek-harness install --frozen-lockfile，再运行 npm run build。');
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`构建失败：${path.basename(script)}，退出码 ${result.status}`);
}

function prepare() {
  const tsdown = path.join(harness, 'node_modules/tsdown/dist/run.mjs');
  const vite = path.join(harness, 'apps/web/node_modules/vite/bin/vite.js');
  assertFiles([tsdown, vite, ...required.slice(2)]);
  run(tsdown, ['--config', path.join(root, 'tsdown.config.ts')], root);
  run(vite, ['build'], path.join(harness, 'apps/web'));
  assertFiles(required);
  console.log('[build] Harness web + IPC bundle ready');
}

if (require.main === module) {
  try { process.argv.includes('--check') ? assertFiles(required) : prepare(); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { assertFiles, required };
