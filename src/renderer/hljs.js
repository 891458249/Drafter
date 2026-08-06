// 代码高亮(window.hljs 由 src/vendor/hljs.js 提供,build/make-hljs.js 生成)。
// 供聊天工具卡片内联代码块与编辑器面板的只读预览共用。

// 扩展名 → highlight.js 语言名(未覆盖的退化为自动检测)
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', scala: 'scala', lua: 'lua', r: 'r', dart: 'dart',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile', makefile: 'makefile',
};

export function langOf(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || '';
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  const ext = (lower.split('.').pop() || '');
  return EXT_LANG[ext] || null;
}

// 返回高亮后的 HTML;语言未知/高亮失败时退化为转义纯文本
export function highlightCode(code, filePath) {
  const text = String(code || '');
  const hljs = window.hljs;
  if (!hljs) return escape(text);
  const lang = langOf(filePath);
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    return escape(text);
  }
}

function escape(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
