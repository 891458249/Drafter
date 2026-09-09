const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.15.5';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.15.5.exe', remote: 'Drafter-Setup-0.15.5.exe' },
  { local: 'Drafter Setup 0.15.5.exe.blockmap', remote: 'Drafter-Setup-0.15.5.exe.blockmap' },
  { local: 'latest.yml', remote: 'latest.yml' },
];
function api(method, urlPath, body, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath.startsWith('https://') ? urlPath : 'https://api.github.com' + urlPath);
    const data = raw !== null ? raw : (body ? Buffer.from(JSON.stringify(body), 'utf8') : null);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'drafter-release', Authorization: 'token ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', ...(data ? { 'Content-Type': extraHeaders['Content-Type'] || 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch {} if (res.statusCode >= 400) return reject(new Error(`${method} ${u.pathname} -> ${res.statusCode}: ${text.slice(0, 500)}`)); resolve(json); });
    }); req.on('error', reject); if (data) req.write(data); req.end();
  });
}
(async () => {
  const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = cred.split('\n').find(line => line.startsWith('password=')); if (!token) throw new Error('未取得 GitHub 凭据'); process.env.GH_TOKEN = token.slice(9).trim();
  const ymlText = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const shaInYml = (ymlText.match(/sha512:\s*(\S+)/) || [])[1];
  const exeData = fs.readFileSync(path.join(DIST, ASSETS[0].local));
  const shaActual = crypto.createHash('sha512').update(exeData).digest('base64');
  if (!shaInYml || shaInYml !== shaActual) throw new Error('latest.yml sha512 与 exe 不匹配,中止发布');
  console.log('sha512 一致:', shaInYml.slice(0, 16) + '…');
  const notes = [
    '### v0.15.5 (2026-09-09):彻底禁止未勾选子 Agent 模型参与任务', '',
    '- **修子 Agent 默认模型泄漏/转包循环**:Claude Code 的 Agent/Task schema 仍会附带 `model:"sonnet"` 覆盖参数;旧守卫 deny 后主模型按同一 schema 反复重试。合法已勾选子 Agent 的无效覆盖现在执行前直接剥掉,固定使用其注册模型,不再进入 deny 循环。',
    '- **新增网络层模型白名单**:会话请求经 127.0.0.1 本地守卫代理,离机前校验 `body.model`;只允许「当前主模型 + 当前勾选子 Agent」。未勾选模型直接本地 403,绝不发送到 Kuro/上游网关,也不会产生计费。',
    '- **覆盖双协议与 SDK 绕路**:Kuro/Anthropic 直连与 OpenAI 翻译链都先经过模型守卫;内置 Agent、Workflow、不可核实 resume/SendMessage 仍 fail closed,嵌套子 Agent 继续禁止。', '',
    '验证:npm test 313/313;真实 claude.exe + 本地假网关覆盖内置 Agent 拒绝、合法子 Agent 通过、sonnet 覆盖剥除、未勾选模型上游零请求。重启 App 生效。'
  ].join('\n');
  let release;
  try { release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); } catch { release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: `Drafter ${TAG}`, body: notes, draft: false, prerelease: false }); }
  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local); const data = fs.readFileSync(file); const existing = (release.assets || []).find(asset => asset.name === remote);
    if (existing && existing.size === data.length) { console.log('skip:', remote); continue; } if (existing) await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
    await api('POST', `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(remote)}`, null, { 'Content-Type': remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' }, data); console.log('uploaded:', remote, data.length);
  }
  const match = ymlText.match(/url:\s*(\S+)/); if (!match) throw new Error('latest.yml 缺少 url');
  const status = await new Promise(resolve => https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${match[1]}`, { headers: { 'User-Agent': 'drafter-release-check' } }, response => { resolve(response.statusCode); response.resume(); }).on('error', () => resolve(0)));
  if (status !== 200 && status !== 302) throw new Error(`下载 URL 校验失败:${status}`); console.log('download URL verified:', match[1], status);
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
