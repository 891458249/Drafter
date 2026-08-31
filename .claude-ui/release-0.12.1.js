const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.12.1';
const DIST = 'D:\\ClaudeUI\\dist';
// 上传名必须与 latest.yml 里的 url 完全一致(连字符,无空格)——
// electron-updater 按 latest.yml 的 url 拼下载地址,GitHub 会把空格净化成点导致 404。
const ASSETS = [
  { local: 'Drafter Setup 0.12.1.exe', remote: 'Drafter-Setup-0.12.1.exe' },
  { local: 'Drafter Setup 0.12.1.exe.blockmap', remote: 'Drafter-Setup-0.12.1.exe.blockmap' },
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
    '### v0.12.1(2026-08-31):画布执行内核 ComfyUI 化',
    '',
    '无限画布的执行引擎对齐 ComfyUI 架构(通读 Comfy-Org/ComfyUI master 源码后实现):',
    '',
    '- **API 工作流格式**:画布持久化改为 `{id: {class_type, inputs}}` 标准格式,与 ComfyUI 工作流文件互通;存量画布启动时自动迁移并留 .bak 备份。',
    '- **整图运行队列**:新增「▶ 运行」按钮,按依赖拓扑整体推进就绪节点,单点失败不再炸掉整棵分支。',
    '- **增量缓存**:节点按祖先签名缓存,参数未变的上游节点直接复用上次产物,只重算受影响的下游。',
    '- **节点状态环**:节点边框颜色实时反映排队/运行/完成/失败/缓存命中。',
    '- **双击画布空白处**搜索并添加节点。',
    '',
    '(原计划版本号 v0.12.0 已被 Harness 修复版占用,画布升级让位至 v0.12.1。)',
    '',
    '验证:npm test 163/163;CDP 冒烟 20/20;打包 asar 校验全过。',
    '重启 App 生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.12.1', body: notes, draft: false, prerelease: false });
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
