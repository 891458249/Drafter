// 一次性验证脚本:模拟打包态下 resolveClaudeExe 的候选解析
const path = require('path');
const fs = require('fs');
const asar = require('@electron/asar');

const res = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources');
const BIN = ['@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'];

const list = asar.listPackage(path.join(res, 'app.asar'));
const sdkInAsar = list.some((l) => l.replace(/\\/g, '/').endsWith('claude-agent-sdk/sdk.mjs'));
console.log('1. asar 内 SDK 入口 sdk.mjs:', sdkInAsar ? '存在' : '缺失');

// 打包态候选:require.resolve('@anthropic-ai/claude-agent-sdk') → asar 内 sdk.mjs
const sdkEntry = path.join(res, 'app.asar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
const nested = path.join(path.dirname(sdkEntry), 'node_modules', ...BIN);
const unpacked = path.normalize(nested).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
console.log('2. 嵌套候选(asar 内):', nested);
console.log('3. 替换后(unpacked) :', unpacked);
console.log('4. 替换后文件存在    :', fs.existsSync(unpacked));

// resourcesPath 兜底候选
const resCand = path.join(res, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', ...BIN);
console.log('5. resourcesPath 兜底存在:', fs.existsSync(resCand));

const ok = sdkInAsar && fs.existsSync(unpacked);
console.log(ok ? 'VERIFY PASS: 打包态 resolveClaudeExe 将解析到 unpacked 真实二进制' : 'VERIFY FAIL');
process.exit(ok ? 0 : 1);
