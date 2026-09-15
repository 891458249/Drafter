const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.11.7';
const DIST = 'D:\\ClaudeUI\\dist';
// 上传名必须与 latest.yml 里的 url 完全一致(连字符,无空格)——
// electron-updater 按 latest.yml 的 url 拼下载地址,GitHub 会把空格净化成点导致 404。
const ASSETS = [
  { local: 'Drafter Setup 0.11.7.exe', remote: 'Drafter-Setup-0.11.7.exe' },
  { local: 'Drafter Setup 0.11.7.exe.blockmap', remote: 'Drafter-Setup-0.11.7.exe.blockmap' },
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
    '### v0.11.7(2026-08-26):修复 Harness 板块「新会话/选择工作区」点击无反应,接通 Typert 桥',
    '',
    '**问题**:Harness 板块里点「新会话」「选择工作区」完全没有反应;',
    '设置 → 插件清单也一直读不出。',
    '',
    '**根因(两个)**:',
    '1. 目录选择器的客户端界面插件从未挂载——v0.11.1 禁用了 directory-picker(-auto)行,',
    '   而它本来会同时挂 host 后端与 client 界面。界面槽位(directoryFlow)一空,harness',
    '   前端的规则是「popover 为空时点击不显示任何内容」→ 选择工作区点击死;没有工作区时',
    '   「新会话」也只是清空选择,看起来同样没反应。',
    '2. Typert RPC(ctx.remote.*:插件清单、目标跟踪、消息反馈、命令、引用解析等)走',
    '   connection 的 /api 复合通道(gateway 拦截器 + apiproxy 回落),而 IPC 桥此前直连',
    '   apiproxy,所有 Typert 调用 404。',
    '',
    '**修复**:',
    '- 目录选择器改为直接挂载官方 browse 双面板(纯 Node 列目录的 host 后端 + 客户端界面),',
    '  「选择工作区」现在弹出应用内目录浏览对话框(支持新建文件夹)。',
    '- /api 流量改走 connection 的复合 FetchHandler,Typert 全链接通:设置 → 插件清单/配置、',
    '  GoalBar、消息反馈、/ 命令等此前静默失败的界面全部恢复。',
    '',
    '**验证**:新增两个冒烟(主进程 6 断言 + 完整前端点击弹窗,0 console 错误);',
    'npm test 152/152。正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.11.7', body: notes, draft: false, prerelease: false });
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
