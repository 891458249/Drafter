// Raw HTML is displayed as text. Only Markdown-generated elements reach innerHTML.
// Shared by Chromium and node:test without a DOM or a second parser implementation.
(function (root) {
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parsers = new WeakMap();
  function safeUrl(href, image = false) {
    const url = String(href || '').trim();
    // Entity escapes can conceal the protocol; reject them in URLs rather than reinterpret them.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(url) || /&(?:#\w+|\w+);/.test(url) || /&#/.test(url)) return null;
    if (/^[a-z]:[\\/]/i.test(url)) return image ? null : url; // Windows file links
    let scheme;
    try { scheme = new URL(url, 'https://drafter.invalid/').protocol.slice(0, -1).toLowerCase(); }
    catch { return null; }
    const allowed = image ? ['http', 'https', 'aigc'] : ['http', 'https', 'mailto', 'tel', 'file'];
    return allowed.includes(scheme) ? url : null;
  }
  function render(marked, text) {
    try {
      let parser = parsers.get(marked);
      if (!parser) {
        parser = new marked.Marked({ breaks: true, gfm: true, renderer: {
          html({ text }) { return escape(text); },
          link({ href, title, tokens }) {
            const label = this.parser.parseInline(tokens);
            const url = safeUrl(href);
            return url === null ? label : `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''}>${label}</a>`;
          },
          image({ href, title, text }) {
            const url = safeUrl(href, true);
            return url === null ? escape(text) : `<img src="${escape(url)}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ''}>`;
          },
        } });
        parsers.set(marked, parser);
      }
      return parser.parse(String(text || ''));
    } catch { return escape(text); }
  }
  const api = { render, safeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.safeMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
