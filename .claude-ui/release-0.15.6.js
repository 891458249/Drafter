const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.15.6';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.15.6.exe', remote: 'Drafter-Setup-0.15.6.exe' },
  { local: 'Drafter Setup 0.15.6.exe.blockmap', remote: 'Drafter-Setup-0.15.6.exe.blockmap' },
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
    '### v0.15.6 (2026-09-09):修上下文窗口分母被 claude.exe 锁死 200k + Kimi K3 订正为 1M', '',
    '- **根因**:上下文分母来自 claude.exe 内置模型注册表的本地计算,对 kimi-k3 / deepseek-chat 等第三方网关模型一律回退默认 200,000——不是提供方实报。此前「K3 会话显示 281.7k/200.0k」即此 bug(已用超 200k 会话仍正常,佐证真实窗口远不止 200k)。',
    '- **修复**:按 modelUsage 里的模型 id 用内置实表逐厂商纠正(K3 会话分母 200k → **1M**;kimi-for-coding → 256K;DeepSeek V3 → 128K;DeepSeek V4 → 1M;Claude 新代被误报 200k 时 → 1M);主模型条目优先,子 Agent 的大窗口不再污染主会话分母;旧会话的历史事件回放时同样自动纠正。',
    '- **订正**:Kimi K3 官方上下文窗口为 **1M**(1,048,576,2026-07 发布,KDA 混合线性注意力架构,1M 不加价)——v0.15.4 误记为 256K(那是 K2 代的数)。',
    '- 说明:上下文窗口是提供方服务端硬上限,本地数据量不改变窗口本身;要 1M 请选用本身支持 1M 的模型(K3 / Claude Opus 4.6+ / Sonnet 5 / GPT-5.5+ / Gemini 3 / GLM-5.3 / Qwen3.6+ / MiniMax M1/M3,Grok 4-fast 为 2M)。',
    '', '验证:npm test 318/318。重启 App 生效。'
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
