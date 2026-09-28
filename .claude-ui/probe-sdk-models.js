// 决定性实验:Claude Agent SDK 的 supportedModels() 到底返回什么?
//
// 计划步骤 7 的前置调研。要回答三个问题:
//   Q1. initialization.models[] 里有没有 supportedEffortLevels / supportsEffort 字段?
//   Q2. 第三方网关模型(kimi-k3、GPT-6 Astra 之类)在表里吗?查不到会怎样?
//   Q3. 这个调用要花多久、需不需要真的能连上提供方?
//
// 只读实验:不写任何仓库文件,不碰用户已装 Drafter,独立进程 + 60s 硬超时自退。
// 因受管 launch 不转发子进程 stdout(v0.15.14 已坐实),结果自写日志文件。
const fs = require('node:fs');
const path = require('node:path');

const LOG = 'D:/ClaudeUI/.claude-ui/probe-sdk-models.out.txt';
try { fs.writeFileSync(LOG, ''); } catch {}
const write = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
};

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

// 60s 硬超时:无论卡在握手还是网络,都要自退,不留孤儿进程
const KILL = setTimeout(() => {
  write('TIMEOUT: 60s 内未拿到结果,强制退出(exit 2)');
  process.exit(2);
}, 60000);
KILL.unref?.();

(async () => {
  try {
    const exe = resolveClaudeExe();
    write('claude.exe =', exe || '(未找到,交给 SDK 自行解析)');

    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    write('sdk keys =', Object.keys(sdk).join(','));
    // package.json 不在 exports 白名单里,require 会 ERR_PACKAGE_PATH_NOT_EXPORTED,直接读文件
    write('sdk version =', JSON.parse(fs.readFileSync(
      'D:/ClaudeUI/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8')).version);

    const t0 = Date.now();
    // base URL 指到 127.0.0.1:1(必定 ECONNREFUSED)——用来判定 initialize 握手
    // 是否真的需要能连上提供方,还是纯 stdio 本地控制请求。
    const q = sdk.query({
      prompt: 'ping',
      options: {
        cwd: 'D:/ClaudeUI',
        permissionMode: 'bypassPermissions',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
          ANTHROPIC_API_KEY: 'sk-probe-not-a-real-key',
          ANTHROPIC_AUTH_TOKEN: 'sk-probe-not-a-real-key',
        },
        ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
      },
    });
    write('query() 已构造,', Date.now() - t0, 'ms');

    const models = await q.supportedModels();
    write('supportedModels() 返回,耗时', Date.now() - t0, 'ms,共', models?.length, '项');

    if (Array.isArray(models) && models.length) {
      // 先看字段形状(取并集),再看有没有 effort 能力
      const fields = new Set();
      for (const m of models) for (const k of Object.keys(m || {})) fields.add(k);
      write('');
      write('--- models[] 字段并集 ---');
      write([...fields].join(', '));
      write('');
      const withEffort = models.filter((m) => m && (m.supportsEffort || m.supportedEffortLevels));
      write('带 effort 能力的模型数 =', withEffort.length, '/', models.length);
      write('');
      write('--- 完整 models[] ---');
      write(JSON.stringify(models, null, 2));

      // 第三方网关模型在不在表里?
      const probes = ['kimi-k3', 'gpt-6-astra', 'GPT-6 Astra', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'];
      write('');
      write('--- 特定模型名匹配情况 ---');
      for (const name of probes) {
        const hit = models.find((m) => m && (m.id === name || m.model === name || m.displayName === name));
        write(`${name} => ${hit ? JSON.stringify(hit) : '未命中'}`);
      }
    } else {
      write('models 为空或非数组:', JSON.stringify(models));
    }

    clearTimeout(KILL);
    try { await q.interrupt?.(); } catch {}
    write('DONE');
    process.exit(0);
  } catch (e) {
    clearTimeout(KILL);
    write('FAIL:', (e && (e.stack || e.message)) || String(e));
    process.exit(1);
  }
})();
