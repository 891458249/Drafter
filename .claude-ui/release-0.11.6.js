const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.11.6';
const DIST = 'D:\\ClaudeUI\\dist';
// 上传名必须与 latest.yml 里的 url 完全一致(连字符,无空格)——
// electron-updater 按 latest.yml 的 url 拼下载地址,GitHub 会把空格净化成点导致 404。
const ASSETS = [
  { local: 'Drafter Setup 0.11.6.exe', remote: 'Drafter-Setup-0.11.6.exe' },
  { local: 'Drafter Setup 0.11.6.exe.blockmap', remote: 'Drafter-Setup-0.11.6.exe.blockmap' },
  { local: 'latest.yml', remote: 'latest.yml' },
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
    '### v0.11.6(2026-08-26):修复切换到非 Kuro 的 Key 后仍报 403「模型未配置」',
    '',
    '**问题**:在会话里切换到 Kimi 等 Key 的模型后,发送消息仍报',
    '`Failed to authenticate. API Error: 403 模型未配置:<model>`。',
    '',
    '**根因**:claude.exe 的用户级配置 ~/.claude/settings.json 里的 env(ANTHROPIC_AUTH_TOKEN /',
    'ANTHROPIC_BASE_URL 等)优先级**高于** app 按会话 Key 注入的进程环境变量。用 CLI 配置过网关',
    '(如把 Kuro 凭据写进用户级 settings.json)时,所有会话实际都被钉到那个网关:该网关自己的模型',
    '碰巧可用,其它 Key 的模型则被拒(403 模型未配置)。v0.11.4 的「重启 query 换凭据」对此无效——',
    '换的是进程 env,仍被 settings.json 覆盖。',
    '',
    '**修复**:会话 query 的 settingSources 去掉 user(保留 project/local,项目级权限规则',
    'settings.local.json 照常生效),不再读取用户级 CLI 配置;app 的凭据完全按 Key 注入。',
    '已用真实 claude.exe 二进制端到端验证:含 user → 403 复现;去掉 user → k3 正常回复。',
    '',
    '**注意**:此前「未配置 Key 时隐式回退 ~/.claude/settings.json 凭据」的行为随之失效;',
    '请在 Key 管理中显式添加对应 Key。另外 ~/.claude/CLAUDE.md(用户级记忆)也不再注入会话,',
    '项目级记忆(.drafter/memory.md)不受影响。',
    '',
    'npm test 152/152。正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.11.6', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local);
    const buf = fs.readFileSync(file);
    const existing = (rel.assets || []).find(a => a.name === remote);
    if (existing && existing.size === buf.length) { console.log('skip (same size):', remote); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', existing.name); }
    const mime = remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(remote)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', remote, buf.length);
  }
  // 上传后校验:latest.yml 里的 url 必须能 200/302 下载(防止名字不匹配 404)
  const yml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const m = yml.match(/url:\s*(\S+)/);
  if (m) {
    const check = await new Promise((res) => {
      https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${m[1]}`, { headers: { 'User-Agent': 'x' } }, (r) => { res(r.statusCode); r.resume(); }).on('error', () => res(0));
    });
    console.log('download URL check:', m[1], '→', check, check === 302 || check === 200 ? 'OK' : 'FAIL(资产名不匹配!)');
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
