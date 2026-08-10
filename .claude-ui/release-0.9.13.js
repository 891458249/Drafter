const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.9.13';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'DeskTopUI Setup 0.9.13.exe',
  'DeskTopUI Setup 0.9.13.exe.blockmap',
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
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = out.split('\n').find(l => l.startsWith('password=')).slice(9).trim();
  process.env.GH_TOKEN = token;
  console.log('token ok, len', token.length);

  const notes = [
    '### v0.9.13(2026-08-07):滚动吸附 + token 兜底 + 预测进度条 + 回合通知 + 系统托盘',
    '',
    '- **自由滚动**:流式输出时上翻不再被强制拉回底部(吸附态:距底 80px 内跟随,上翻解除,回底恢复);非吸附态显示「↓ 回到底部」悬浮按钮',
    '- **token/上下文显示兜底**:部分网关(Kimi 等)流式事件不带 usage 导致回合恒 0 tokens——改用 assistant 消息的 usage 补计;「上下文 %」从回合结束才跳改为随回合实时推进',
    '- **预测进度条**:状态行下新增进度条,按时间双曲线渐近 92% 给出量化预期,完成时补满 100%;状态行尾部附 ~N% 与当前动作(思考中/撰写回复/调用工具 X)',
    '- **回合结束系统通知**:每次回合结束都发 Windows 右下角 toast(此前仅非活跃会话),标题区分出错,正文带用时',
    '- **系统托盘驻留**:关窗转入后台托盘(首次弹提示),托盘左键唤出/右键「显示/退出」;修复自动更新重启被关窗拦截的配套问题',
    '',
    '正在运行的 App 需重启进程生效。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'DeskTopUI v0.9.13', body: notes, draft: false, prerelease: false });
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
