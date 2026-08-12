// 文件路径识别(纯函数,不依赖 DOM,可单测)。v0.9.32。
// 会话文本里的落地路径(已写入 C:\...\xxx.py)此前不可点击——旧 linkifyPaths
// 的正则不含冒号,Windows 盘符路径永远匹配失败。这里统一识别规则,
// chat.js linkifyPaths 用它把路径变成 .file-link,点击在右侧编辑器面板打开。

const EXT = '[A-Za-z0-9]{1,10}';
const LINE_SUFFIX = '(?::(\\d+))?$';

// 整段匹配(行内 code 的全文):允许空格、括号、中文字符
const RE_WIN = new RegExp('^([A-Za-z]:[\\\\/][^:*?"<>|]*\\.' + EXT + ')' + LINE_SUFFIX);
const RE_UNC = new RegExp('^(\\\\\\\\[^:*?"<>|]*\\.' + EXT + ')' + LINE_SUFFIX);
const RE_POSIX = new RegExp('^(/[^:*?"<>|]*\\.' + EXT + ')' + LINE_SUFFIX);
// 相对路径:沿用旧 linkifyPaths 的思路(字符类 + 必须带扩展名),版本号单独排除
const RE_REL = new RegExp('^([\\w./\\\\()@+~$%&=\\[\\]\\-一-鿿]+\\.' + EXT + ')' + LINE_SUFFIX);
const RE_VERSION = /^v?\d+(\.\d+)+$/;

// 正文(非 code)扫描:只认绝对路径(盘符 / UNC / 前导 /)——相对路径在散文里误报率太高。
// BODY 排除空白与常见中英文标点;空格仅在后随非空格字符时计入(支持含空格的目录名)。
// 扩展名后若紧跟字母数字说明不是扩展名边界(如 "a.pytxt"),用否定前瞻排除。
const BODY = '(?:[^\\s*?"<>|:。、,;:!?\'`\\[\\]{}()（）【】「」『』“”‘’]| (?=\\S))*';
export const PATH_IN_TEXT_RE = new RegExp(
  '(?<![\\w:/.\\\\])((?:[A-Za-z]:[\\\\/]|\\\\\\\\|/)' + BODY + '\\.' + EXT + '(?![A-Za-z0-9]))(?::(\\d+))?',
  'g'
);

// 整段文本 → { path, line } | null。尾部标点(。,))等)逐轮剥离重试。
export function parseFilePath(text) {
  let t = String(text || '').trim();
  if (!t || t.length > 260 || t.includes('://')) return null;
  for (let i = 0; i < 8 && t; i++) {
    const hit = matchPath(t);
    if (hit) return hit;
    const next = t.replace(/[。、,;:!?.'"”’)\]}>》」』]+$/u, '');
    if (next === t) return null;
    t = next;
  }
  return null;
}

function matchPath(t) {
  let m = RE_WIN.exec(t) || RE_UNC.exec(t) || RE_POSIX.exec(t);
  if (m) return { path: m[1], line: m[2] ? parseInt(m[2], 10) : null };
  m = RE_REL.exec(t);
  if (m && !RE_VERSION.test(m[1])) return { path: m[1], line: m[2] ? parseInt(m[2], 10) : null };
  return null;
}
