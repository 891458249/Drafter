const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.12.6';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.12.6.exe', remote: 'Drafter-Setup-0.12.6.exe' },
  { local: 'Drafter Setup 0.12.6.exe.blockmap', remote: 'Drafter-Setup-0.12.6.exe.blockmap' },
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
    '### v0.12.6(2026-09-02):Bifrost 节点风格 + 双向连线 + 工具栏跟随', '',
    '- **Bifrost 节点外观**(参照 Maya Bifrost 图编辑器):深色石板卡 + 分类色顶部色条 + 小方块端口(两侧竖排,左输入/右输出,带端口名,不遮挡内容)。',
    '- **双向连线**:左右引脚大小一致,左引脚可主动拉到其他节点右引脚(反向拉起,带类型校验)。',
    '- **悬浮工具栏**:拖拽节点时隐藏,停手后重新跟随;随平移/缩放/移动同步跟随。',
    '- **形状与颜色**:颜色条由形状按钮展开,配形状下拉菜单(方/圆/卡三选);颜色直接改变整个节点配色并随画布持久化。',
    '- 修复:全局样式把输入端口撑大 3 倍、外部节点端口名缺失。', '',
    '验证:npm test 190/190;CDP 冒烟(真实本机 ComfyUI 0.34.0)全部通过,零渲染错误。重启 App 生效(electron-updater 可自动更新)。'
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
