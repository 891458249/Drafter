const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.13.0';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.13.0.exe', remote: 'Drafter-Setup-0.13.0.exe' },
  { local: 'Drafter Setup 0.13.0.exe.blockmap', remote: 'Drafter-Setup-0.13.0.exe.blockmap' },
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
    '### v0.13.0(2026-09-03):画布重构——自研 Canvas 2D 渲染引擎替换 Drawflow', '',
    '按《ComfyUI 画布架构解析》三层架构重写画布渲染端,Drawflow(DOM/SVG 库)退役为可回退备选:', '',
    '- **图模型层**:纯逻辑图模型 + Schema 驱动节点工厂(标量→控件、张量→插槽)+ computeSize 自适应排版 + 四阶连接验证(自环/通配/大小写归一/覆盖替换)。',
    '- **视口控制器**:世界↔屏幕双向仿射投影、**指针锚定无漂移缩放**、视口 AABB 剔除、LOD 三级渲染。',
    '- **渲染管线**:Canvas 2D 背景/前景双画布脏标记(空闲零重绘)、节点 8 层绘制管线、动态张力三次贝塞尔连线、Mute 半透明虚线 / Bypass 紫粉边框+直通虚线、执行中正弦脉冲高亮+进度条。',
    '- **交互系统**:4px 点击死区状态机、框选、左引脚反向拉线、引脚智能吸附、智能对齐参考线、分组框(几何归属+联动位移)、鹰眼图双向漫游。',
    '- **Undo/Redo 双轨**:移动/数值走差量命令合并,拓扑变更走快照(30 步)。',
    '- **PNG 工作流恢复**:把含工作流元数据的 PNG 拖进画布即可还原整条工作流(tEXt/iTXt,zlib 压缩块支持)。',
    '- 主进程:`_` 前缀保留键(分组/视口随画布落盘)、**Bypass 拓扑短路**(被忽略节点穿透到上游数据源)、节点注册表经 IPC 单一下发。',
    '- 设置 → 偏好 可切回旧 Drawflow 引擎回滚;存量画布 JSON 打开自动迁移,数据无损。', '',
    '验证:npm test 224/224(新增 22 例);CDP 冒烟 16 项断言全过(隔离 userData)。重启 App 生效(electron-updater 可自动更新)。'
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
