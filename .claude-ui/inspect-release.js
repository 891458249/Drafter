const { execFileSync } = require('child_process');
const https = require('https');
const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
const token = out.split('\n').find(l => l.startsWith('password=')).slice(9).trim();
https.get({
  hostname: 'api.github.com',
  path: '/repos/891458249/Drafter/releases/367756803',
  headers: { 'User-Agent': 'x', 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
}, (res) => {
  let b = [];
  res.on('data', c => b.push(c));
  res.on('end', () => {
    const j = JSON.parse(Buffer.concat(b).toString());
    console.log('tag:', j.tag_name, 'draft:', j.draft);
    console.log('body head:', String(j.body || '').slice(0, 200));
    for (const a of j.assets || []) console.log('asset:', a.name, a.size, a.state, a.updated_at);
  });
});
