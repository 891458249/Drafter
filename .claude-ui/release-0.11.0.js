const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.11.0';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'Drafter Setup 0.11.0.exe',
  'Drafter Setup 0.11.0.exe.blockmap',
  'latest.yml',
];

function api(method, urlPath, body, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const isUpload = urlPath.startsWith('https://');
    const u = new URL(isUpload ? urlPath : 'https://api.github.com' + urlPath);
    const data = raw !== null ? raw : (body ? Buffer.from(JSON.stringify(body), 'utf8') : null);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'drafter-release',
        'Authorization': 'token ' + process.env.GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Type': extraHeaders['Content-Type'] || 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      let buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        const text = Buffer.concat(buf).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 400) return reject(new Error(method + ' ' + u.pathname + ' -> ' + res.statusCode + ': ' + text.slice(0, 500)));
        resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = out.split('\n').find(l => l.startsWith('password=')).slice(9).trim();
  process.env.GH_TOKEN = token;
  console.log('token ok, len', token.length);

  const notes = [
    '### v0.11.0(2026-08-26):DeepSeek Harness 板块合并 + Electron 38',
    '',
    '**🧩 新增 Harness 板块(实验)**',
    '- 顶栏新增第六个板块「Harness」:把 DeepSeek Harness(deepseek-ai/deepseek-harness,「一切皆插件」的开源 agent 运行时)整体并入 Drafter,与现有 Code/Chat/创作/画布/素材并存',
    '- Harness 板块由 harness 引擎驱动(不走 Claude Agent SDK):插件化工具表、事件溯源会话日志、会话分叉/回放、审批卡片、计划模式、Todo、子代理、Skills、MCP、@提及、/斜杠命令、会话搜索等能力开箱即用',
    '- 模型与 Drafter 的多 Key 体系打通:harness 会话直接用你已配置的 Kuro/自定义网关 Key,无需重复配置',
    '- 权限模式沿用 Drafter 的 5 档(默认/接受编辑/计划/不询问/跳过权限),在 Harness 板块内映射为 harness 的沙箱+审批策略',
    '',
    '**⚠️ Harness 板块是实验特性**:harness 上游处于 Developer Preview(官方明说可能有破坏性变更);Drafter 侧的 harness 图片附件暂未接入(媒体附件请继续用「创作/画布/素材」板块)。',
    '',
    '**⬆️ 运行时升级**',
    '- Electron 33 → 38(内嵌 Node 20 → 22.22),为 harness 提供 require(esm) 等 Node 22 能力',
    '',
    '**说明**',
    '- 本版只新增 Harness 板块,不动现有 Code/Chat(仍走 Claude Agent SDK);harness 是否取代 SDK 链路,后续视 harness 上游稳定度再定',
    '- 正在运行的 App 需重启进程生效(electron-updater 可自动更新);自动更新包体积较上版明显增大(内置 harness 运行时)',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.11.0', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    const buf = fs.readFileSync(file);
    // GitHub 会把资产名空格净化成点(v0.9.27 踩坑):两种形态都匹配
    const existing = (rel.assets || []).find(a => a.name === name || a.name === name.replace(/ /g, '.'));
    if (existing && existing.size === buf.length) { console.log('skip (same size):', name); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', existing.name); }
    const mime = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', name, buf.length);
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
