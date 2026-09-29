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
test('stale managed running state reconciles only after both identities and ports are free', { skip: process.platform !== 'win32' }, async () => {
  const scope = 'stale:' + crypto.randomUUID();
  const id = crypto.randomUUID();
  const dir = path.join(resources.scopeDir(scope), id);
  const state = { version: 1, scope, id, status: 'running', pid: 2147483647, started: 'old', supervisorPid: 2147483646, supervisorStarted: 'old', ports: [] };
  resources.atomicWrite(path.join(dir, 'state.json'), state);
  fs.writeFileSync(path.join(dir, 'stop'), 'cleanup');
  assert.equal((await resources.verify(scope)).ok, true);
  assert.equal(resources.records(scope)[0].status, 'released');
  assert.deepEqual(await resources.cleanup(scope), { ok: true, count: 1, pending: [] });

  const activeScope = 'active:' + crypto.randomUUID();
  const started = await resources.identity(process.pid);
  const active = { ...state, scope: activeScope, status: 'running', id: crypto.randomUUID(), supervisorPid: process.pid, supervisorStarted: started };
  resources.atomicWrite(path.join(resources.scopeDir(activeScope), active.id, 'state.json'), active);
  assert.equal((await resources.verify(activeScope)).ok, false);
  assert.equal(resources.records(activeScope)[0].status, 'running');
  const childScope = 'active-child:' + crypto.randomUUID();
  const child = { ...state, scope: childScope, id: crypto.randomUUID(), pid: process.pid, started };
  resources.atomicWrite(path.join(resources.scopeDir(childScope), child.id, 'state.json'), child);
  assert.equal((await resources.verify(childScope)).ok, false);
  assert.equal(resources.records(childScope)[0].status, 'running');

  const unknownScope = 'unknown-identity:' + crypto.randomUUID();
  const unknown = { ...state, scope: unknownScope, id: crypto.randomUUID(), supervisorStarted: null };
  resources.atomicWrite(path.join(resources.scopeDir(unknownScope), unknown.id, 'state.json'), unknown);
  assert.equal((await resources.verify(unknownScope)).ok, false);
  assert.equal(resources.records(unknownScope)[0].status, 'running');

  const server = require('node:net').createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const portScope = 'occupied:' + crypto.randomUUID();
    const occupied = { ...state, scope: portScope, id: crypto.randomUUID(), ports: [server.address().port] };
    resources.atomicWrite(path.join(resources.scopeDir(portScope), occupied.id, 'state.json'), occupied);
    assert.equal((await resources.verify(portScope)).ok, false);
    assert.equal(resources.records(portScope)[0].status, 'running');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
test('Stop reports a main-scope cleanup failure once', async () => {
  const { createSessionCleanup } = require('../src/main/debug-resources/session');
  const events = [];
  const session = createSessionCleanup('stop-once', (event) => events.push(event));
  const scope = JSON.parse(session.prompt.match(/--scope ("[^"]+")/)[1]);
  resources.attach(scope, { name: 'unreleased', release: () => {}, verify: () => false });
  const result = await session.hooks.Stop[0].hooks[0]({ session_id: 'stop-once' });
  assert.equal(result.decision, 'block');
  assert.equal(events.filter((event) => event.type === 'ui_error').length, 1);
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
  // 旧版安装残留的逐工具调用条目:不再注入任何内容
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', session_id: 'hook' }), {});
  assert.deepEqual(await hook({ hook_event_name: 'PostToolUseFailure', session_id: 'hook' }), {});
  resources.attach('cli:hook', { name: 'stuck', release: () => {}, verify: () => false });
  assert.equal((await hook({ hook_event_name: 'Stop', session_id: 'hook' })).decision, 'block');
  assert.ok((await hook({ hook_event_name: 'Stop', session_id: 'hook', stop_hook_active: true })).systemMessage);
});
test('hook installation merges settings without replacing existing arrays', () => {
  const { mergeHooks } = require('../scripts/install-debug-cleanup');
  const original = { env: { KEEP: 'yes' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }] } };
  const merged = mergeHooks(original, temp);
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.PreToolUse, undefined);
  assert.deepEqual(merged.env, original.env);
  assert.deepEqual(mergeHooks(merged, temp), merged);
  assert.equal(original.hooks.Stop.length, 1);
  // 旧版装进去的 PreToolUse/PostToolUseFailure 条目被移除,其他条目保留
  const command = `node "${path.join(temp, 'cli.js')}" hook`;
  const legacy = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }, { hooks: [{ type: 'command', command: 'mine' }] }],
    PostToolUseFailure: [{ hooks: [{ type: 'command', command }] }] } };
  const upgraded = mergeHooks(legacy, temp);
  assert.deepEqual(upgraded.hooks.PreToolUse, [{ hooks: [{ type: 'command', command: 'mine' }] }]);
  assert.equal(upgraded.hooks.PostToolUseFailure, undefined);
});
test('stale starting record with no process is retired after the startup window', async () => {
  const scope = 'stale-starting:' + crypto.randomUUID();
  const id = crypto.randomUUID();
  const file = path.join(resources.scopeDir(scope), id, 'state.json');
  resources.atomicWrite(file, { version: 1, scope, id, status: 'starting', ports: [] });
  assert.equal((await resources.verify(scope)).ok, false); // fresh: launch may still be in progress
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(file, old, old);
  assert.deepEqual(await resources.verify(scope), { ok: true, count: 1, pending: [] });
  assert.equal(resources.records(scope)[0].status, 'released');
});
test('Windows managed target survives the launching process and logs its output', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const { execFile } = require('node:child_process');
  const scope = 'survive:' + crypto.randomUUID();
  const cli = path.join(__dirname, '../src/main/debug-resources/cli.js');
  // 与模型的 Bash 工具相同:一个短命进程执行 launch 后立即退出
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath, [cli, 'launch', '--scope', scope, '--owner', String(process.pid), '--cwd', temp, '--',
    process.execPath, '-e', 'console.log("hello-from-target"); setInterval(()=>{},1000)'], { env: { ...process.env, DRAFTER_DEBUG_ROOT: temp } }, (e, out) => e ? reject(e) : resolve(out)));
  const record = JSON.parse(stdout.trim().split('\n').pop());
  try {
    assert.equal(record.status, 'running');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await resources.identity(record.pid), record.started); // 仍存活
    assert.match(fs.readFileSync(record.log, 'utf8'), /hello-from-target/);
  } finally {
    const report = await resources.cleanup(scope);
    assert.equal(report.ok, true, JSON.stringify(report));
  }
  await assert.rejects(resources.identity(record.pid), (e) => e.code === 3);
});
test('Windows --wait runs in the foreground and returns output and exit code', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const scope = 'wait:' + crypto.randomUUID();
  const done = await resources.launch({ scope, exe: process.execPath, args: ['-e', 'console.log("out-line"); console.error("err-line"); process.exit(3)'], wait: 20000 });
  assert.equal(done.status, 'released');
  assert.equal(done.exitCode, 3);
  assert.equal(done.timedOut, false);
  assert.match(done.output, /out-line/);
  assert.match(done.output, /err-line/);
  assert.deepEqual(await resources.verify(scope), { ok: true, count: 1, pending: [] });

  const slow = 'wait-timeout:' + crypto.randomUUID();
  const stopped = await resources.launch({ scope: slow, exe: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], wait: 1000 });
  assert.equal(stopped.timedOut, true);
  assert.equal(stopped.status, 'released');
  await assert.rejects(resources.identity(stopped.pid), (e) => e.code === 3);
});
test('SDK cleanup hooks isolate query generations and merge with guards', async () => {
  const { createSessionCleanup } = require('../src/main/debug-resources/session');
  const a = createSessionCleanup('same');
  const b = createSessionCleanup('same');
  const input = { session_id: 'sdk' };
  const scope = (text) => JSON.parse(text.match(/--scope ("[^"]+")/)[1]);
  const scopeA = scope(a.prompt);
  const scopeB = scope(b.prompt);
  assert.notEqual(scopeA, scopeB);
  // 规则只随系统提示下发一次,不再逐次工具调用注入
  assert.equal(b.hooks.PreToolUse, undefined);
  assert.equal(b.hooks.PostToolUseFailure, undefined);
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
