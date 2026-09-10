const { test } = require('node:test');
const assert = require('node:assert/strict');
const marked = require('marked');
const { render } = require('../src/renderer/markdown');

test('HTML、样式、表单和 webview 作为文本显示，不能注入应用 DOM', () => {
  for (const input of ['<style>body{display:none}</style>', '<img src=x onerror=alert(1)>',
    '<form id=input><input name=api></form>', '<webview preload="file:///evil.js" src="https://example.com"></webview>',
    '<svg><script>alert(1)</script></svg>']) {
    const output = render(marked, input);
    assert.doesNotMatch(output, /<(style|img|form|input|webview|svg|script)\b/i);
    assert.ok(output.includes('&lt;'));
  }
});

test('危险链接协议与实体混淆不生成可点击地址', () => {
  for (const url of ['javascript:alert%281%29', 'java&#x73;cript:alert%281%29', 'vbscript:msgbox%281%29', 'data:text/html,evil']) {
    assert.doesNotMatch(render(marked, `[link](${url})`), /href=/);
    assert.doesNotMatch(render(marked, `![image](${url})`), /<img/);
  }
});

test('保留常用 Markdown、普通 URL 参数、文件链接与代码围栏', () => {
  const html = render(marked, '**bold**\n\n[a](https://example.com/?a=1&b=2)\n\n[f](<D:/My Project/file.js>)\n\n```html\n<style>body{display:none}</style>\n```');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(html, /href="D:\/My Project\/file.js"/);
  assert.match(html, /<pre><code class="language-html">/);
  assert.doesNotMatch(html, /<style>/);
  assert.match(render(marked, '| A | B |\n|---|---|\n| 1 | 2 |'), /<table>/);
});

test('解析器不可用时安全退回纯文本', () => {
  assert.equal(render(null, '<style>x</style>'), '&lt;style&gt;x&lt;/style&gt;');
});
