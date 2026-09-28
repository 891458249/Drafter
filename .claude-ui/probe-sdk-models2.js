// 对照实验:supportedModels() 在「prompt 是永不 yield 的 AsyncIterable」时到底怎么了?
//
// 上一版实验的教训:finally 里 q.close()/q.interrupt() 返回 rejected promise(传输已关 →
// "ProcessTransport is not ready for writing"),同步 try{}catch{} 接不住 → unhandled
// rejection 把进程打死在 A 组收尾,B 组从未执行。所以「B 无输出」当时不能推出任何结论。
//
// 本版:不调用 close/interrupt(进程直接 exit),装 unhandledRejection 记录器,并把结果
// 区分成 解析/空数组/报错/超时 四种,分别打印。
const fs = require('node:fs');
const path = require('node:path');

const LOG = 'D:/ClaudeUI/.claude-ui/probe-sdk-models.out.txt';
try { fs.writeFileSync(LOG, ''); } catch {}
const write = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
};

process.on('unhandledRejection', (e) => write('  [unhandledRejection] ' + (e && e.message)));
process.on('uncaughtException', (e) => write('  [uncaughtException] ' + (e && e.message)));

function resolveClaudeExe() {
  const BIN = ['@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'];
  const candidates = [];
  try { candidates.push(require.resolve(BIN.join('/'))); } catch {}
  try {
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    candidates.push(path.join(path.dirname(sdkEntry), 'node_modules', ...BIN));
  } catch {}
  for (const c of candidates) {
    const unpacked = path.normalize(c).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return null;
}

const exe = resolveClaudeExe();

function baseOptions() {
  return {
    cwd: 'D:/ClaudeUI',
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      ANTHROPIC_API_KEY: 'sk-probe-not-a-real-key',
      ANTHROPIC_AUTH_TOKEN: 'sk-probe-not-a-real-key',
    },
    ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
  };
}

// 永不 yield 的 AsyncIterable —— 模拟 Drafter 的 AsyncQueue 在用户没发消息时的状态
function emptyQueue() {
  let resolveNext;
  const next = () => new Promise((r) => { resolveNext = r; });
  let pending = next();
  return {
    [Symbol.asyncIterator]() { return this; },
    next() { const p = pending; pending = next(); return p; },
    close() { try { resolveNext({ done: true }); } catch {} },
  };
}

async function trial(label, promptFactory, timeoutMs) {
  const t0 = Date.now();
  let timer = null;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const prompt = promptFactory();
  const q = sdk.query({ prompt, options: baseOptions() });
  try {
    const r = await Promise.race([
      q.supportedModels(),
      new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('__TIMEOUT__')), timeoutMs); }),
    ]);
    const n = r && r.length;
    write(`${label}: ✅ ${Date.now() - t0}ms, ${n} 项${n ? '' : '  ← 空/未定义!'} [isArray=${Array.isArray(r)}]`);
    if (n) write(`   全量: ${JSON.stringify(r.map((m) => ({ value: m.value, resolved: m.resolvedModel, name: m.displayName, effort: m.supportsEffort, levels: m.supportedEffortLevels })), null, 1)}`);
  } catch (e) {
    const tag = e.message === '__TIMEOUT__' ? `超时(>${timeoutMs}ms) ⇒ 初始化未完成` : e.message;
    write(`${label}: ❌ ${Date.now() - t0}ms — ${tag}`);
  } finally {
    clearTimeout(timer);
    // 刻意不 close/interrupt:见文件头注释。靠下面的 process.exit 收尾。
  }
}

(async () => {
  write('claude.exe =', exe || '(未找到)');
  write('SDK =', JSON.parse(fs.readFileSync(
    'D:/ClaudeUI/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8')).version);
  write('');
  await trial('A 字符串 prompt   ', () => 'ping', 20000);
  await trial('B 空 AsyncIterable', () => emptyQueue(), 20000);
  write('');
  write('DONE');
  process.exit(0);
})();
