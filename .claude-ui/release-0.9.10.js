const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.9.10';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'DeskTopUI Setup 0.9.10.exe',
  'DeskTopUI Setup 0.9.10.exe.blockmap',
  'latest.yml',
];

function api(method, urlPath, body, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const isUpload = urlPath.startsWith('https://');
    const u = new URL(isUpload ? urlPath : 'https://api.github.com' + urlPath);
    const data = raw !== null ? raw : (body ? Buffer.from(JSON.stringify(body), 'utf8') : null);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'claudeui-release',
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
  // token from git credential manager
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = out.split('\n').find(l => l.startsWith('password=')).slice(9).trim();
  process.env.GH_TOKEN = token;
  console.log('token ok, len', token.length);

  const notes = [
    '### v0.9.10(2026-08-07):新项目首会话作废修复 + 流式渲染卡顿修复',
    '',
    '- **「设为项目文件夹」后会话作废修复**:adoptDir 切换 cwd 后 resume 在新目录找不到会话记录(No conversation found)且 sdkSessionId 残留导致会话永久卡死。现在 resume 前自动把旧目录的记录迁移到新 cwd 目录(编码规则与 Claude Code 一致);迁移失败时降级为全新会话并提示,不再卡死',
    '- **流式执行卡死其他会话输入框修复**:此前每个流式 delta 都把已累积全文重新 markdown 渲染一遍(O(n²)),所有会话共用渲染主线程。改为 80ms 合帧渲染,后台会话执行时输入框打字不再受影响',
    '',
    '<details><summary>v0.9.8–v0.9.9 累计更新(自上个 release)</summary>',
    '',
    '- v0.9.8 会话操作收进右键菜单 + 消息右键复制/引用 + 图片双击查看/右键复制(查看模式滚轮缩放)',
    '- v0.9.9 用户消息锚点 uuid + 右侧消息导航条(点击定位/滚动联动)+ 右键「修改并重新生成」(锚点截断重发,不丢上下文)与「从此消息分支」(复制上文开新会话)',
    '',
    '</details>',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'DeskTopUI v0.9.10', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    const buf = fs.readFileSync(file);
    const existing = (rel.assets || []).find(a => a.name === name);
    if (existing && existing.size === buf.length) { console.log('skip (same size):', name); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', name); }
    const mime = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', name, buf.length);
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
