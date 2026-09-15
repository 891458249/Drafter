const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const resources = require('../src/main/debug-resources');
const { hook } = require('../src/main/debug-resources/cli');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-cleanup-test-'));
process.env.DRAFTER_DEBUG_ROOT = temp;
test.after(() => { delete process.env.DRAFTER_DEBUG_ROOT; fs.rmSync(temp, { recursive: true, force: true }); });

test('empty scope is a no-op and scopes cannot traverse directories', async () => {
  assert.deepEqual(await resources.cleanup('../outside'), { ok: true, count: 0, pending: [] });
  assert.equal(path.dirname(resources.scopeDir('../outside')), temp);
});
test('attached callbacks release only their own scope, retry failures and are idempotent', async () => {
  let released = 0;
  resources.attach('A', { name: 'debug connection', release: () => released++, verify: () => true });
  resources.attach('B', { name: 'other session', release: () => released += 10, verify: () => true });
  assert.equal((await resources.cleanup('A')).ok, true);
  assert.equal((await resources.cleanup('A')).ok, true);
  assert.equal(released, 1);
  assert.equal((await resources.verify('B')).ok, false);
  await resources.cleanup('B');
  assert.equal(released, 11);
  let ready = false;
  resources.attach('retry', { name: 'COM', release: () => {}, verify: () => ready });
  assert.equal((await resources.cleanup('retry')).ok, false);
  ready = true;
  assert.equal((await resources.cleanup('retry')).ok, true);
});
test('unknown attached resources never execute stored commands or kill a process', async () => {
  const id = crypto.randomUUID();
  resources.atomicWrite(path.join(resources.scopeDir('unknown'), id, 'state.json'), { version: 1, scope: 'unknown', id, status: 'attached', pid: process.pid, release: 'exit' });
  assert.equal((await resources.cleanup('unknown')).ok, false);
});
test('corrupt state is visible, never reported as clean', async () => {
  const file = path.join(resources.scopeDir('bad'), crypto.randomUUID(), 'state.json');
  resources.atomicWrite(file, { version: 999 });
  await assert.rejects(resources.cleanup('bad'), /Invalid debug resource/);
});
test('hooks supply scoped instructions and avoid infinite Stop block', async () => {
  const start = await hook({ hook_event_name: 'SessionStart', session_id: 'hook', owner_pid: process.pid });
  assert.match(start.hookSpecificOutput.additionalContext, /cli:hook/);
  resources.attach('cli:hook', { name: 'stuck', release: () => {}, verify: () => false });
  assert.equal((await hook({ hook_event_name: 'Stop', session_id: 'hook' })).decision, 'block');
  assert.ok((await hook({ hook_event_name: 'Stop', session_id: 'hook', stop_hook_active: true })).systemMessage);
});
test('hook installation merges settings without replacing existing arrays', () => {
  const { mergeHooks } = require('../scripts/install-debug-cleanup');
  const original = { env: { KEEP: 'yes' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }] } };
  const merged = mergeHooks(original, temp);
  assert.equal(merged.hooks.Stop.length, 2);
  assert.deepEqual(merged.env, original.env);
  assert.deepEqual(mergeHooks(merged, temp), merged);
  assert.equal(original.hooks.Stop.length, 1);
});
test('SDK cleanup hooks isolate query generations and merge with guards', async () => {
  const { createSessionCleanup } = require('../src/main/debug-resources/session');
  const a = createSessionCleanup('same');
  const b = createSessionCleanup('same');
  const input = { session_id: 'sdk' };
  const context = async (session) => (await session.hooks.PreToolUse[0].hooks[0](input)).hookSpecificOutput.additionalContext;
  const scope = (text) => JSON.parse(text.match(/--scope ("[^"]+")/)[1]);
  const scopeA = scope(await context(a));
  const scopeB = scope(await context(b));
  assert.notEqual(scopeA, scopeB);
  let released = false;
  resources.attach(scopeB, { name: 'new query connection', release: () => { released = true; }, verify: () => true });
  await a.cleanup();
  assert.equal(released, false);
  await b.hooks.Stop[0].hooks[0](input);
  assert.equal(released, true);
});
test('Windows argument quoting preserves spaces, quotes and trailing backslashes', () => {
  assert.equal(resources.quote('a b'), '"a b"');
  assert.equal(resources.quote('x"y'), '"x\\"y"');
  assert.equal(resources.quote('x\\'), '"x\\\\"');
});
test('Windows owner death triggers cleanup without a Stop hook', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const { spawn } = require('node:child_process');
  const scope = 'owner-death:' + crypto.randomUUID();
  const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const record = await resources.launch({ scope, ownerPid: owner.pid, exe: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
    owner.kill();
    let report;
    const end = Date.now() + 15000;
    do { await new Promise((r) => setTimeout(r, 250)); report = await resources.verify(scope); } while (!report.ok && Date.now() < end);
    assert.equal(report.ok, true, JSON.stringify(report));
    await assert.rejects(resources.identity(record.pid), (e) => e.code === 3);
  } finally { owner.kill(); await resources.cleanup(scope); }
});
test('Windows private Job releases parent, children and port', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const scope = 'job:' + crypto.randomUUID();
  const marker = path.join(temp, 'ready.json');
  const script = path.join(temp, 'parent.cjs');
  const locked = path.join(temp, 'exclusive.txt');
  const lockScript = path.join(temp, 'lock.ps1');
  fs.writeFileSync(lockScript, `$f=[IO.File]::Open('${locked.replace(/'/g, "''")}', 'OpenOrCreate', 'ReadWrite', 'None'); try { while($true){Start-Sleep 1} } finally {$f.Dispose()}`);
  fs.writeFileSync(script, `const {spawn}=require('child_process'); const fs=require('fs'); const net=require('net');
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',${JSON.stringify(lockScript)}],{stdio:'ignore'});
const server=net.createServer(); server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,child:child.pid,port:server.address().port})));`);
  try {
    await resources.launch({ scope, exe: process.execPath, args: [script] });
    const end = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const { pid, child, port } = JSON.parse(fs.readFileSync(marker));
    while (!fs.existsSync(locked) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(locked));
    assert.throws(() => fs.renameSync(locked, locked + '.moved'));
    const report = await resources.cleanup(scope);
    assert.equal(report.ok, true, JSON.stringify(report));
    await assert.rejects(resources.identity(pid), (e) => e.code === 3);
    await assert.rejects(resources.identity(child), (e) => e.code === 3);
    fs.renameSync(locked, locked + '.moved');
    fs.renameSync(locked + '.moved', locked);
    const server = require('net').createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise((r) => server.close(r));
  } finally { await resources.cleanup(scope); }
});
