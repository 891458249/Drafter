const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.12.3';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.12.3.exe', remote: 'Drafter-Setup-0.12.3.exe' },
  { local: 'Drafter Setup 0.12.3.exe.blockmap', remote: 'Drafter-Setup-0.12.3.exe.blockmap' },
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
  const notes = [
    '### v0.12.3(2026-09-01):原生 ComfyUI Canvas', '',
    '- 左侧原生节点库:加载本机 ComfyUI 900 个节点、201 个分类,支持搜索、刷新、收藏。',
    '- 原生三栏画布:节点检查器、分类颜色、忽略/禁用、多输出端口、复杂参数控件、动态输入、撤销重做、小地图。',
    '- API Key 与本机 ComfyUI 双后端:标准文本/图片资产可跨后端桥接,私有推理对象不跨边界。',
    '- 不再嵌入官方 Web 页面,Canvas 使用 Drafter 自己的本地 UI。', '',
    '验证:npm test 185/185;本机 ComfyUI 0.34.0 + CUDA 12.6 + RTX 5060 Ti;原生 Electron 冒烟通过。',
    '真实出图需将模型文件放入本机 ComfyUI 的 models 目录。重启 App 生效(electron-updater 可自动更新)。'
  ].join('\n');
  let release;
  try { release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); } catch { release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: `Drafter ${TAG}`, body: notes, draft: false, prerelease: false }); }
  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local); const data = fs.readFileSync(file); const existing = (release.assets || []).find(asset => asset.name === remote);
    if (existing && existing.size === data.length) { console.log('skip:', remote); continue; } if (existing) await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
    await api('POST', `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(remote)}`, null, { 'Content-Type': remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' }, data); console.log('uploaded:', remote, data.length);
  }
  const yml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8'); const match = yml.match(/url:\s*(\S+)/); if (!match) throw new Error('latest.yml 缺少 url');
  const status = await new Promise(resolve => https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${match[1]}`, { headers: { 'User-Agent': 'drafter-release-check' } }, response => { resolve(response.statusCode); response.resume(); }).on('error', () => resolve(0)));
  if (status !== 200 && status !== 302) throw new Error(`下载 URL 校验失败:${status}`); console.log('download URL verified:', match[1], status);
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
