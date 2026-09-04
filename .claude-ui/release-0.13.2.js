const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.13.2';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.13.2.exe', remote: 'Drafter-Setup-0.13.2.exe' },
  { local: 'Drafter Setup 0.13.2.exe.blockmap', remote: 'Drafter-Setup-0.13.2.exe.blockmap' },
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
    '### v0.13.2(2026-09-04):画布节点汉化(i18n)+ 微缩视口 LOD 骨架渲染', '',
    '在 v0.13.0 自研 Canvas 2D 引擎之上的迭代:', '',
    '- **深度汉化(双轨解耦)**:节点标题、端口插槽、组件参数、分类树全部本地化显示(KSampler→K采样器、seed→种子、latent_image→Latent图像…),逻辑键名恒定英文——API 序列化、拓扑校验、存量工作流零影响。内置词典可持续扩充。',
    '- **中英双语搜索**:双击画布呼出的搜索框与左侧节点目录,输「采样器」或「KSampler」均可命中同一节点。',
    '- **微缩视口骨架渲染**:彻底消除画布缩小后的「黑块」——任何缩放级别节点都保留圆角底板、标题栏界线、彩色插槽圆点与控件凹槽;微缩态文字降级为印刷占位细线(Greeking),对齐 ComfyUI 官方缩放质感。LOD 阈值 0.6/0.25,阴影仅细节模式绘制。', '',
    '验证:npm test 228/228;CDP 冒烟 16/16;15% 缩放像素采样确认骨架渲染;落盘 JSON 全英文键名。重启 App 生效(electron-updater 可自动更新)。'
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
