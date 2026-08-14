// migrations.js 数据迁移/自愈框架(v0.9.17)
// 覆盖:semver 比较、transcript 自愈(健康/迁移/降级)、meta 去重、版本门控与版本戳
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-migrations-test-'));
installElectronStub(tmp);
// 必须在 require 之前:sessions.js 模块加载时按 CLAUDE_CONFIG_DIR 定位记录根目录
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-cfg');
const store = require('../src/main/store');
const { run, compareVersions } = require('../src/main/migrations');
const { encodeCwdForProjects } = require('../src/main/sessions');

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
const STORE_FILE = path.join(tmp, 'drafter-store.json');
const CWD = 'D:\\HealProject';
const SID = 'sdk-session-abc';

function seedTranscript(cwd, sid = SID) {
  const dir = path.join(PROJECTS, encodeCwdForProjects(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), '{"type":"user"}\n');
}

function seedSession(patch = {}) {
  store.upsertSession({ id: 'sess-1', cwd: CWD, title: '自愈对象', sdkSessionId: SID, ...patch });
}

beforeEach(() => {
  try { fs.unlinkSync(STORE_FILE); } catch {}
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('compareVersions:三段数字比较,缺段按 0', () => {
  assert.ok(compareVersions('0.9.17', '0.9.16') > 0);
  assert.ok(compareVersions('0.9.16', '0.9.17') < 0);
  assert.strictEqual(compareVersions('0.9.17', '0.9.17'), 0);
  assert.ok(compareVersions('0.10.0', '0.9.99') > 0);
  assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
});

test('自愈:记录健康(就在当前 cwd 目录)的会话原样保留', () => {
  seedTranscript(CWD);
  seedSession();
  const report = run('0.9.17');
  const meta = store.listSessions().find((x) => x.id === 'sess-1');
  assert.strictEqual(meta.sdkSessionId, SID, 'sdkSessionId 不应被清');
  assert.ok(!report.transcriptLost && !report.transcriptMigrated, '健康会话不产生修复记录');
});

test('自愈:记录在旧目录 → 迁移到当前 cwd 目录并消费 prevCwd', () => {
  const oldCwd = 'C:\\Users\\someone';
  seedTranscript(oldCwd); // 记录停在旧 cwd(adoptDir 后没迁移的存量坑)
  seedSession({ prevCwd: oldCwd });
  const report = run('0.9.17');
  const dst = path.join(PROJECTS, encodeCwdForProjects(CWD), SID + '.jsonl');
  assert.ok(fs.existsSync(dst), '记录应已复制到当前 cwd 目录');
  const meta = store.listSessions().find((x) => x.id === 'sess-1');
  assert.strictEqual(meta.sdkSessionId, SID, '迁移成功保留 sdkSessionId,resume 可用');
  assert.strictEqual(meta.prevCwd, null, 'prevCwd 已被消费');
  assert.strictEqual(report.transcriptMigrated, 1);
});

test('自愈:记录全盘皆无 → 清 sdkSessionId 降级全新会话(不卡死)', () => {
  seedSession(); // 没有任何 transcript
  const report = run('0.9.17');
  const meta = store.listSessions().find((x) => x.id === 'sess-1');
  assert.strictEqual(meta.sdkSessionId, null, '记录缺失必须清掉,否则 resume 必失败卡死');
  assert.ok(meta.resumeLostAt, '应记录降级时间');
  assert.strictEqual(report.transcriptLost, 1);
  assert.deepStrictEqual(report.lostSessions, ['自愈对象']);
});

test('自愈:会话 meta 按 id 去重(历史脏数据)', () => {
  store.update((s) => {
    s.sessions = [
      { id: 'a', cwd: 'D:\\x' },
      { id: 'a', cwd: 'D:\\x', title: 'dup' },
      { id: 'b', cwd: 'D:\\y' },
      { cwd: 'D:\\no-id' }, // 无 id 的脏数据
    ];
  });
  const report = run('0.9.17');
  const ids = store.listSessions().map((x) => x.id);
  assert.deepStrictEqual(ids, ['a', 'b']);
  assert.strictEqual(report.metaDeduped, 2);
});

test('版本迁移:dataVersion 门控——旧版本执行一次,重跑跳过,版本戳只前进', () => {
  let calls = 0;
  const mig = [{ version: '0.9.17', desc: '测试迁移', run: () => { calls++; } }];
  run('0.9.17', mig);
  assert.strictEqual(calls, 1, '首次(无 dataVersion)应执行');
  assert.strictEqual(store.getSetting('dataVersion'), '0.9.17');
  run('0.9.17', mig);
  assert.strictEqual(calls, 1, '同版本重跑应跳过');
  run('0.9.18', mig);
  assert.strictEqual(calls, 1, '0.9.17 的迁移对 0.9.18 数据已执行过,仍跳过');
  assert.strictEqual(store.getSetting('dataVersion'), '0.9.18', '版本戳前进');
  run('0.9.16', mig);
  assert.strictEqual(store.getSetting('dataVersion'), '0.9.18', '回退安装旧版不降低版本戳');
});

test('版本迁移:单个迁移抛错不影响其他迁移与版本戳', () => {
  let ok = 0;
  const mig = [
    { version: '0.9.17', desc: '会炸的迁移', run: () => { throw new Error('boom'); } },
    { version: '0.9.17', desc: '正常迁移', run: () => { ok++; } },
  ];
  const report = run('0.9.17', mig);
  assert.strictEqual(ok, 1);
  assert.strictEqual(report.migrations[0].ok, false);
  assert.strictEqual(report.migrations[1].ok, true);
  assert.strictEqual(store.getSetting('dataVersion'), '0.9.17');
});
