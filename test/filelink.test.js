// filelink.js 路径识别单测(纯函数,无需 window/document stub)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFilePath, PATH_IN_TEXT_RE } from '../src/renderer/filelink.js';

test('Windows 盘符绝对路径(带冒号,旧正则匹配不上)', () => {
  assert.deepEqual(parseFilePath('C:\\Users\\dingyongzhen\\Documents\\maya\\scripts\\constraint_io.py'),
    { path: 'C:\\Users\\dingyongzhen\\Documents\\maya\\scripts\\constraint_io.py', line: null });
});

test('路径带行号后缀', () => {
  assert.deepEqual(parseFilePath('D:\\tmp\\cons.json:123'), { path: 'D:\\tmp\\cons.json', line: 123 });
  assert.deepEqual(parseFilePath('/tmp/cons.json:7'), { path: '/tmp/cons.json', line: 7 });
});

test('含空格的 Windows 路径', () => {
  assert.deepEqual(parseFilePath('C:\\Users\\ding yongzhen\\a b.py'),
    { path: 'C:\\Users\\ding yongzhen\\a b.py', line: null });
});

test('UNC 与 POSIX 绝对路径', () => {
  assert.deepEqual(parseFilePath('\\\\server\\share\\dir\\file.js'),
    { path: '\\\\server\\share\\dir\\file.js', line: null });
  assert.deepEqual(parseFilePath('/home/user/x.ts'), { path: '/home/user/x.ts', line: null });
});

test('相对路径(沿用旧规则),版本号不报', () => {
  assert.deepEqual(parseFilePath('src/renderer/chat.js'), { path: 'src/renderer/chat.js', line: null });
  assert.equal(parseFilePath('v0.9.13'), null);
  assert.equal(parseFilePath('0.9.13'), null);
});

test('尾部中文标点剥离', () => {
  assert.deepEqual(parseFilePath('C:\\a\\b.py。'), { path: 'C:\\a\\b.py', line: null });
  assert.deepEqual(parseFilePath('C:\\a\\b.py),'), { path: 'C:\\a\\b.py', line: null });
});

test('明显误报:URL / 命令 / 空串', () => {
  assert.equal(parseFilePath('https://example.com/a.js'), null);
  assert.equal(parseFilePath('npm install'), null);
  assert.equal(parseFilePath(''), null);
});

test('正文扫描:无反引号的散文绝对路径', () => {
  PATH_IN_TEXT_RE.lastIndex = 0;
  const m = PATH_IN_TEXT_RE.exec('已写入 C:\\Users\\dyz\\scripts\\constraint_io.py,语法校验通过。');
  assert.ok(m);
  assert.equal(m[0], 'C:\\Users\\dyz\\scripts\\constraint_io.py');
});

test('正文扫描:带行号;URL 中的斜杠路径不匹配', () => {
  PATH_IN_TEXT_RE.lastIndex = 0;
  const m = PATH_IN_TEXT_RE.exec('见 D:\\x\\y.ts:42 处');
  assert.ok(m);
  assert.equal(m[1], 'D:\\x\\y.ts');
  assert.equal(m[2], '42');

  PATH_IN_TEXT_RE.lastIndex = 0;
  assert.equal(PATH_IN_TEXT_RE.exec('打开 https://example.com/a.js 看看'), null);
});
