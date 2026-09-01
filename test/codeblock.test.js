// codeblock.js(v0.9.12):enhanceCodeHtml 代码卡片包装/着色/复制原文提取
// 渲染端模块用 ESM,node:test 直接 import;window.hljs 用 stub 注入。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

let enhanceCodeHtml, state, apiCalls;

beforeEach(async () => {
  // 每次重建模块态(state.js 读 window.marked/document,hljs.js 读 window.hljs)
  global.document = { addEventListener() {} }; // state.js 顶层挂全局监听
  apiCalls = [];
  global.window = {
    marked: null, // 不走 renderMarkdown,直接喂 marked 输出形态的 HTML
    api: { openExternal: (u) => apiCalls.push(u) }, // state.js 顶层绑定 window.api
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

// v0.12.3:AI 把文件路径写成 [路径](路径) 时,marked 生成 <a href="D:%5C...">,
// 默认导航会把主窗口导航到 file:/// 伪地址 → ERR_FAILED 整窗黑屏。
// initCodeCopy 的 #messages 委托必须拦截:preventDefault + 转编辑器打开。
test('点击路径伪链接:拦截默认导航,转 open-file 编辑器', async () => {
  let clickHandler = null;
  global.document = {
    addEventListener() {},
    getElementById: (id) => (id === 'messages' ? { addEventListener: (ev, fn) => { if (ev === 'click') clickHandler = fn; } } : null),
  };
  const opened = [];
  // 必须与 codeblock.js 内部裸 import 同一实例(裸说明符命中同一模块缓存)
  const stateMod = await import('../src/renderer/state.js');
  const cb = await import('../src/renderer/codeblock.js?v=' + Date.now());
  cb.initCodeCopy();
  assert.ok(clickHandler, '委托监听已挂');
  stateMod.on('open-file', (hit) => opened.push(hit));

  const fakeA = {
    getAttribute: () => 'D:%5CPlugins%5CHARU%5C%E4%B8%80%E9%94%AE%E7%BB%91%E5%AE%9A.md',
    textContent: 'D:\\Plugins\\HARU\\一键绑定.md',
  };
  const ev = {
    target: { closest: (sel) => (sel === 'a[href]' ? fakeA : null) },
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  clickHandler(ev);
  assert.ok(ev.prevented, '默认导航被拦截');
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].path, 'D:\\Plugins\\HARU\\一键绑定.md');
});

test('点击 http 链接:拦截默认导航,外抛系统浏览器', async () => {
  let clickHandler = null;
  global.document = {
    addEventListener() {},
    getElementById: (id) => (id === 'messages' ? { addEventListener: (ev, fn) => { if (ev === 'click') clickHandler = fn; } } : null),
  };
  const cb = await import('../src/renderer/codeblock.js?v=' + Date.now());
  cb.initCodeCopy();
  const fakeA = { getAttribute: () => 'https://example.com/x', textContent: 'x' };
  const ev = {
    target: { closest: (sel) => (sel === 'a[href]' ? fakeA : null) },
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  clickHandler(ev);
  assert.ok(ev.prevented);
  assert.deepStrictEqual(apiCalls, ['https://example.com/x']);
});
