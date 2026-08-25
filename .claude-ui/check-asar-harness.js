// 验证打包后的 asar 里关键 harness 文件可读
const asar = require('D:/ClaudeUI/node_modules/@electron/asar')
const files = asar.listPackage('D:/ClaudeUI/dist/win-unpacked/resources/app.asar')
const norm = (s) => s.replace(/\\/g, '/')
const key = [
  'vendor/deepseek-harness/apps/web/dist/index.electron.html',
  'vendor/deepseek-harness/apps/web/dist/assets/index', // 前缀匹配(hash 文件名)
  'vendor/deepseek-harness/packages/bundle/base/cordis.patch.yml',
  'vendor/deepseek-harness/packages/bundle/base/package.json',
  'vendor/deepseek-harness/packages/host/apiproxy/lib/index.js',
  'vendor/deepseek-harness/packages/host/apiproxy/lib/types/fetch/client.js',
  'vendor/deepseek-harness/vendor/timer/lib/index.js',
  'src/harness/dist/ipc-client-entry.mjs',
  'src/harness/preload.js',
  'src/main/harness/harness-bridge.js',
  'src/main/harness/keys-bridge.js',
  'src/main/harness/permission-bridge.js',
  'src/main/harness/gems-bridge.js',
]
let ok = 0
for (const k of key) {
  const found = files.some((f) => norm(f).includes(k))
  console.log(found ? 'OK  ' : 'MISS', k)
  if (found) ok++
}
console.log(`\n${ok}/${key.length} key files present; total files in asar: ${files.length}`)
