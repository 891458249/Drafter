const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.15.2';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.15.2.exe', remote: 'Drafter-Setup-0.15.2.exe' },
  { local: 'Drafter Setup 0.15.2.exe.blockmap', remote: 'Drafter-Setup-0.15.2.exe.blockmap' },
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
  // sha512 硬校验(v0.13.6 教训:latest.yml 与 exe 必须出自同一次构建)
  const ymlText = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const shaInYml = (ymlText.match(/sha512:\s*(\S+)/) || [])[1];
  const exeData = fs.readFileSync(path.join(DIST, ASSETS[0].local));
  const shaActual = crypto.createHash('sha512').update(exeData).digest('base64');
  if (!shaInYml || shaInYml !== shaActual) throw new Error('latest.yml sha512 与 exe 不匹配,中止发布');
  console.log('sha512 一致:', shaInYml.slice(0, 16) + '…');
  const notes = [
    '### v0.15.2 (2026-09-08):API Key 预设扩充至 12 家主流提供方', '',
    '- **一键预设**:Anthropic 官方 / Kuro / Kimi / Deepseek / GLM 智谱 / MiniMax / ChatGPT / Gemini / 通义千问 / OpenRouter / Grok / 硅基流动——选预设、粘 Key、保存即可;OpenAI 协议家(ChatGPT/Gemini/千问/OpenRouter/Grok/硅基流动)自动走 v0.15.0 的本地翻译代理驱动会话。',
    '- **Gemini 预设修复**:改走 OpenAI 兼容层(Bearer 认证),此前原生 API 认证头不被支持,刷新模型/会话必失败;已存量的旧 Gemini Key 请删除后用新预设重建。',
    '- **协议自动识别扩展**:OpenRouter / xAI / Groq / Mistral / 硅基流动 / 百炼等主机手填 Base URL 也会自动判为 OpenAI 协议;Deepseek 按路径区分双协议(/anthropic 直连,根路径走翻译)。', '',
    '验证:npm test 305/305。重启 App 生效。'
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
