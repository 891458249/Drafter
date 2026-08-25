// 验证 dist/win-unpacked/resources/app.asar 的打包内容包含 v0.10.2 改动
const { extractFile } = require('@electron/asar');
const asar = 'D:/ClaudeUI/dist/win-unpacked/resources/app.asar';
const checks = [
  ['main.js', ['sess:setChatMode']],
  ['preload.js', ['sessSetChatMode']],
  ['src\\main\\sessions.js', ['fastChatOverrides', 'FAST_CHAT_SYSTEM_PROMPT', 'strictMcpConfig', 'excludeDynamicSections', 'setChatMode', 'staticPrompt']],
  ['src\\renderer\\app.js', ['btn-chat-mode', 'fastChatHinted', 'set-sharedcache', 'sharedPromptCache']],
  ['src\\renderer\\chat.js', ['isFastChat', '已发送,等待响应']],
  ['src\\renderer\\input.js', ['isFastChat', '极速模式内联上限']],
  ['src\\renderer\\sessions-ui.js', ['refreshListSoon']],
  ['src\\index.html', ['btn-chat-mode', 'set-sharedcache']],
  ['src\\styles.css', ['chat-only', 'chat-mode-on']],
  ['package.json', ['0.10.2', 'Drafter']],
];

let fail = 0;
for (const [file, needles] of checks) {
  let content;
  try { content = extractFile(asar, file).toString('utf8'); }
  catch (e) { console.log('FAIL extract', file, e.message); fail++; continue; }
  for (const n of needles) {
    if (!content.includes(n)) { console.log('FAIL', file, 'missing:', n); fail++; }
  }
}
console.log(fail ? `FAIL ${fail} 项` : 'check-asar 全过 (' + checks.length + ' 文件)');
process.exit(fail ? 1 : 0);
