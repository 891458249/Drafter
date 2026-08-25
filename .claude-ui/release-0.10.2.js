const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.10.2';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'Drafter Setup 0.10.2.exe',
  'Drafter Setup 0.10.2.exe.blockmap',
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
    '### v0.10.2(2026-08-19):Chat 极速问答 + 跨会话提示缓存',
    '',
    '> 本版同时包含 v0.10.0/v0.10.1 的全部内容(这两版未单独发 Release):创作板块合并、画布 MVP、文本生成节点、流式渲染修复。从 v0.9.37 自动更新将直接跳到本版。',
    '',
    '**⚡ Chat 极速问答(默认开启)**',
    '- Chat 会话默认走「极速问答」:零工具 + 零文件设置 + 零 MCP + 极简系统提示,首轮请求输入从实测 ~2.6 万 tokens 降到 2-4 千,响应速度对齐网页版',
    '- 输入框上方「⚡ 极速 / 🛠 Agent」一键切换(切换后会话重启、上文保留);需要 AI 读文件/跑命令时切 Agent 模式',
    '- 极速模式下文本附件改为内容内联注入(≤100KB),AI 可直接读到附件全文',
    '',
    '**🚀 跨会话共享提示缓存**',
    '- 新建会话的系统提示前缀跨会话静态(目录/git/记忆等动态信息移到首条消息),缓存命中率更高、首轮更快;设置 → 偏好可关,默认开',
    '',
    '**体验**',
    '- 回合状态行新增「已发送,等待响应…」首字节等待提示,不再像卡死',
    '- 侧栏在多会话并发时的高频重绘改 200ms 防抖',
    '- 品牌统一 Drafter(界面文案/说明文档)',
    '',
    '**包含的 v0.10.0/v0.10.1 内容**',
    '- 创作板块:图/视/音/3D 四大媒体板块合并为一个,工坊按生成类型筛选,跨类型产物同会话并存',
    '- 画布 MVP:节点式编排,文本生成节点(chat 模型 fan-out)、画布模板、fork 导出/导入',
    '- 流式渲染修复:thinking 合帧、后台会话跳过渲染、超长消息自适应降帧,多会话并发不再卡输入框',
    '',
    '正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.10.2', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    const buf = fs.readFileSync(file);
    // GitHub 会把资产名空格净化成点(v0.9.27 踩坑):两种形态都匹配
    const existing = (rel.assets || []).find(a => a.name === name || a.name === name.replace(/ /g, '.'));
    if (existing && existing.size === buf.length) { console.log('skip (same size):', name); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', existing.name); }
    const mime = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', name, buf.length);
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
