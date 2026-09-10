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
const exeFiles = fs.readdirSync(unpacked, { recursive: true }).filter((f) => path.basename(f) === 'claude.exe');
assert.ok(exeFiles.length, 'claude.exe 必须解包为可执行文件');
const exe = path.join(dist, `Drafter Setup ${pkg.version}.exe`);
assert.ok(fs.statSync(exe + '.blockmap').size > 0);
const yml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
assert.equal(/^version:\s*(.+)$/m.exec(yml)?.[1].trim(), pkg.version);
const expected = /sha512:\s*(\S+)/.exec(yml)?.[1];
const actual = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('base64');
assert.equal(actual, expected, 'latest.yml 与安装包哈希必须一致');
console.log(JSON.stringify({ version: pkg.version, matchingSourceFiles: files.length, claudeBinary: true, installerBytes: fs.statSync(exe).size, sha512Verified: true }));
