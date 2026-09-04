const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.13.3';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.13.3.exe', remote: 'Drafter-Setup-0.13.3.exe' },
  { local: 'Drafter Setup 0.13.3.exe.blockmap', remote: 'Drafter-Setup-0.13.3.exe.blockmap' },
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
    '### v0.13.3(2026-09-04):桌面悬浮球——后台任务进度一眼可见', '',
    '窗口最小化/关闭转入托盘后,桌面悬浮球接管任务进度感知:', '',
    '- **按需显示 + 首次询问**:主窗隐藏时悬浮球自动出现(主窗可见时自动隐藏);首次隐藏时询问「显示悬浮球/不用了」,可记住选择,设置面板与托盘菜单随时开关。',
    '- **一任务一小球**:每个进行中的任务一个读条小球(预测式进度,悬停显示会话名,超过 6 个折叠 +N);任务完成变绿(出错变红),一直保留到点击查看。',
    '- **点击绿球回到任务**:唤出主窗口并直接定位到对应会话;双击主球=显示主窗并清除全部提醒;右键主球=原生菜单(显示主窗/清除已完成/关闭悬浮球)。',
    '- **果冻边缘吸附**:拖到屏幕边缘附近松手,欠阻尼弹簧吸附到最近边缘并带一次过冲回弹,拖拽甩速继承为初速度;运动方向拉伸/垂直压缩的果冻形变。位置与所在显示器记忆,多屏按球心所在屏吸附(自动避开任务栏)。',
    '- **零侵入架构**:悬浮窗为透明无边框置顶小窗,透明区域鼠标穿透不挡桌面操作;sess:event 事件扇出广播,悬浮窗自行聚合;完成待查看集合在主进程,窗口重建不丢失。', '',
    '验证:npm test 243/243(新增 13 例);dev 冒烟 9/9(截图验证渲染/穿透/显隐联动)。重启 App 生效(electron-updater 可自动更新)。'
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
