const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const dist = path.resolve(process.argv[2] || path.join(root, 'dist'));
const archive = path.join(dist, 'win-unpacked/resources/app.asar');
const pkg = require('../package.json');
const built = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(built.version, pkg.version, '安装包版本必须与工作区一致');
const files = ['main.js', 'preload.js', 'preload-overlay.js',
  ...fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .map((f) => 'src/' + f.replace(/\\/g, '/'))
    .filter((f) => fs.statSync(path.join(root, f)).isFile())];
for (const file of files) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), '打包内容过期：' + file);
for (const file of require('./prepare-harness').required) assert.ok(asar.extractFile(archive, path.normalize(file)).length, '缺少运行文件：' + file);
const unpacked = path.join(dist, 'win-unpacked/resources/app.asar.unpacked');
const unpackedFiles = fs.readdirSync(unpacked, { recursive: true })
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => fs.statSync(path.join(unpacked, f)).isFile());
const exeFiles = unpackedFiles.filter((f) => path.basename(f) === 'claude.exe');
assert.ok(exeFiles.length, 'claude.exe 必须解包为可执行文件');
// 解包面收敛(v0.15.17):harness 源码全部走 asar(实验已证 Electron 38 可从 asar
// import ESM / require CJS / readdirSync),只有原生模块与可执行文件必须落地成散文件。
// 回归守卫:白名单外的散文件即说明 asarUnpack 又被放宽了。
// 白名单 = 原生/二进制扩展名 ∪ apps/cli/config ∪ 「自身含原生文件的包目录」——
// 后者是 electron-builder smartUnpack 的行为:含 .node/.dll/.exe 的整包会被整体解包
// (node-pty、claude-agent-sdk-win32-x64、@img/sharp、@koromix/koffi)。
const NATIVE = /\.(node|dll|exe)$/;
const pkgRoot = (f) => {
  const parts = f.split('/');
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const depth = parts[i + 1].startsWith('@') ? 3 : 2;
  return parts.slice(0, i + depth).join('/');
};
const nativeRoots = new Set(unpackedFiles.filter((f) => NATIVE.test(f)).map(pkgRoot).filter(Boolean));
const stray = unpackedFiles.filter((f) =>
  !NATIVE.test(f) && !f.startsWith('vendor/deepseek-harness/apps/cli/config/') && !nativeRoots.has(pkgRoot(f)));
assert.equal(stray.length, 0, `asarUnpack 出现白名单外的散文件 ${stray.length} 个(前 5:${stray.slice(0, 5).join(', ')})`);
assert.ok(unpackedFiles.length <= 400, `解包文件数 ${unpackedFiles.length} 超出上限 400`);
const exe = path.join(dist, `Drafter Setup ${pkg.version}.exe`);
assert.ok(fs.statSync(exe + '.blockmap').size > 0);
const yml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
assert.equal(/^version:\s*(.+)$/m.exec(yml)?.[1].trim(), pkg.version);
const expected = /sha512:\s*(\S+)/.exec(yml)?.[1];
const actual = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('base64');
assert.equal(actual, expected, 'latest.yml 与安装包哈希必须一致');

// —— 代码签名状态(v0.15.17 预留配置,证书后补)——————————————————————————————
// 签名由 electron-builder 原生读 CSC_LINK / CSC_KEY_PASSWORD 环境变量驱动,
// 未配置时自动跳过且构建不失败 —— 这正是「预留」。这里只做体检与报告;
// 正式发版/CI 设 DRAFTER_REQUIRE_SIGNING=1 让未签名直接失败。
const { signatureStatus } = require('./signature-status');
const appExe = path.join(dist, 'win-unpacked/Drafter.exe');
const signed = fs.existsSync(appExe)
  ? signatureStatus(appExe)
  : { status: 'Skipped', reason: 'win-unpacked/Drafter.exe 不存在(仅校验安装包时)' };
if (process.env.DRAFTER_REQUIRE_SIGNING === '1') {
  assert.equal(signed.status, 'Valid', `要求签名但 Drafter.exe 状态为 ${signed.status}`);
}
console.log(JSON.stringify({
  version: pkg.version,
  matchingSourceFiles: files.length,
  claudeBinary: true,
  unpackedFiles: unpackedFiles.length,
  installerBytes: fs.statSync(exe).size,
  sha512Verified: true,
  signed: signed.status,
  ...(signed.subject ? { signer: signed.subject } : {}),
  ...(signed.reason ? { signSkipReason: signed.reason } : {}),
}));
