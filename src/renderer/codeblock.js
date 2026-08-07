// 聊天消息内代码块(v0.9.12):marked 输出的 <pre><code> 统一增强为
// 带头部条(语言标签 + 复制按钮)的 IDE 风格卡片,并按 fence 语言做着色。
// 所有 renderMarkdown 的注入点(chat.js)统一走 enhanceCodeHtml 包装。
import { $, escapeHtml, PRE_CODE_RE, decodeCodeHtml } from './state.js';
import { highlightAs } from './hljs.js';

// fenced 语言别名 → highlight.js 注册名(vendor 包内含的语言见 build/make-hljs.js)
const LANG_ALIAS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', cs: 'csharp',
  sh: 'bash', zsh: 'bash', shell: 'bash',
  html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml',
  yml: 'yaml', toml: 'ini', conf: 'ini', md: 'markdown',
  objc: 'objectivec', 'c++': 'cpp', 'c#': 'csharp', fs: 'vbnet', fsharp: 'vbnet',
  ps1: null, // vendor 包无 powershell,走自动检测
};

// 把 renderMarkdown 输出的 HTML 中的 <pre><code> 替换为代码卡片(着色 + 复制头)
export function enhanceCodeHtml(html) {
  return String(html || '').replace(PRE_CODE_RE, (_m, lang, codeHtml) => {
    const code = decodeCodeHtml(codeHtml);
    const norm = normLang(lang);
    const hi = highlightAs(code, norm);
    const label = lang ? escapeHtml(lang) : 'code';
    return `<div class="code-card" data-code="${escapeHtml(code)}">`
      + `<div class="code-card-head"><span class="code-card-lang">${label}</span>`
      + `<button type="button" class="code-copy-btn">复制</button></div>`
      + `<pre><code class="hljs">${hi}</code></pre></div>`;
  });
}

function normLang(lang) {
  if (!lang) return null;
  const l = String(lang).toLowerCase();
  if (l in LANG_ALIAS) return LANG_ALIAS[l];
  return (window.hljs && window.hljs.getLanguage(l)) ? l : null;
}

// 复制按钮:#messages 事件委托;复制 data-code 里的原文(转义存取)
export function initCodeCopy() {
  $('messages').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.code-copy-btn');
    if (!btn) return;
    const card = btn.closest('.code-card');
    if (!card) return;
    const code = card.dataset.code || '';
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = '已复制 ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1600);
    }).catch(() => {
      btn.textContent = '复制失败';
      setTimeout(() => { btn.textContent = '复制'; }, 1600);
    });
  });
}
