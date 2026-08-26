const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.11.5';
const DIST = 'D:\\ClaudeUI\\dist';
// 上传名必须与 latest.yml 里的 url 完全一致(连字符,无空格)——
// electron-updater 按 latest.yml 的 url 拼下载地址,GitHub 会把空格净化成点导致 404。
const ASSETS = [
  { local: 'Drafter Setup 0.11.5.exe', remote: 'Drafter-Setup-0.11.5.exe' },
  { local: 'Drafter Setup 0.11.5.exe.blockmap', remote: 'Drafter-Setup-0.11.5.exe.blockmap' },
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
    '### v0.11.5(2026-08-26):修复 Kimi 等网关的 Key「模型能识别、聊天全失败」(404)',
    '',
    '**问题**:使用 baseUrl 自带 /v1 后缀的网关(如 Kimi 预设 https://api.kimi.com/coding/v1)时,',
    '「刷新模型」能正常识别模型列表,但会话发送消息全部失败(404 resource_not_found_error),',
    '表现为 Key 无法识别/不可用。',
    '',
    '**根因**:会话子进程的 ANTHROPIC_BASE_URL 由 buildEnv 按 baseUrl 原样注入,',
    'claude.exe 会在其后拼 /v1/messages,实际打到 /coding/v1/v1/messages → 404。',
    '模型识别走的是 keys.js 的 apiRoot(本就会剥掉末尾 /v1),所以识别正常。',
    '',
    '**修复**:',
    '- buildEnv 注入 ANTHROPIC_BASE_URL 前用 keys.apiRoot 归一(去掉末尾 /v1),',
    '  与模型识别同一规则;空 baseUrl 仍归位官方 api.anthropic.com,行为不变。',
    '- Kuro/DeepSeek/Gemini 等不带 /v1 的预设不受影响;harness 通道(baseURL 需含 /v1)不受影响。',
    '',
    'test/keys.test.js 新增 apiRoot 归一化回归用例;npm test 全绿。',
    '',
    '正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.11.5', body: notes, draft: false, prerelease: false });
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
