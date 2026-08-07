// codeblock.js(v0.9.12):enhanceCodeHtml 代码卡片包装/着色/复制原文提取
// 渲染端模块用 ESM,node:test 直接 import;window.hljs 用 stub 注入。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

let enhanceCodeHtml, state;

beforeEach(async () => {
  // 每次重建模块态(state.js 读 window.marked/document,hljs.js 读 window.hljs)
  global.document = { addEventListener() {} }; // state.js 顶层挂全局监听
  global.window = {
    marked: null, // 不走 renderMarkdown,直接喂 marked 输出形态的 HTML
    hljs: {
      getLanguage: (l) => (l === 'python' || l === 'javascript' ? {} : null),
      highlight: (code, { language }) => ({ value: `<hl lang="${language}">${code}</hl>` }),
      highlightAuto: (code) => ({ value: `<hl auto>${code}</hl>` }),
    },
  };
  const m = await import('../src/renderer/codeblock.js?v=' + Date.now());
  enhanceCodeHtml = m.enhanceCodeHtml;
  state = (await import('../src/renderer/state.js?v=' + Date.now())).state;
});

test('带语言围栏:生成卡片+语言标签+按语言着色', () => {
  const html = '<p>x</p><pre><code class="language-python">a&amp;b</code></pre>';
  const out = enhanceCodeHtml(html);
  assert.ok(out.includes('class="code-card"'));
  assert.ok(out.includes('code-card-lang">python<'));
  assert.ok(out.includes('code-copy-btn'));
  assert.ok(out.includes('<hl lang="python">a&b</hl>'), 'decode 后按 python 着色');
  assert.ok(out.includes('data-code="a&amp;b"'), '原文转义存 data-code 供复制');
});

test('无语言围栏:退化为自动检测,标签显示 code', () => {
  const out = enhanceCodeHtml('<pre><code>plain</code></pre>');
  assert.ok(out.includes('code-card-lang">code<'));
  assert.ok(out.includes('<hl auto>plain</hl>'));
});

test('语言别名与未注册语言:py→python;ps1 走自动检测', () => {
  assert.ok(enhanceCodeHtml('<pre><code class="language-py">1</code></pre>').includes('<hl lang="python">'));
  assert.ok(enhanceCodeHtml('<pre><code class="language-ps1">1</code></pre>').includes('<hl auto>'));
});

test('多个代码块各自独立成卡片', () => {
  const html = '<pre><code class="language-python">p</code></pre><p>mid</p><pre><code class="language-javascript">j</code></pre>';
  const out = enhanceCodeHtml(html);
  assert.strictEqual((out.match(/code-card/g) || []).length >= 2, true);
  assert.ok(out.includes('<hl lang="python">p</hl>') && out.includes('<hl lang="javascript">j</hl>'));
});
