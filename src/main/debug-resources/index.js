const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const activeScopes = new Set();
const callbacks = new Map();
const inFlight = new Map();
const root = () => process.env.DRAFTER_DEBUG_ROOT || path.join(os.homedir(), '.claude', 'debug-resource-state');
const scopeKey = (scope) => crypto.createHash('sha256').update(String(scope)).digest('hex');
const scopeDir = (scope) => path.join(root(), scopeKey(scope));
const psExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process id');
  const { stdout } = await exec(psExe(), ['-NoProfile', '-NonInteractive', '-Command',
    `try { $p=[Diagnostics.Process]::GetProcessById(${pid}); $p.StartTime.ToUniversalTime().Ticks.ToString() } catch [System.ArgumentException] { exit 3 } catch { exit 4 }`], { windowsHide: true, timeout: 5000, cwd: os.tmpdir() });
  return stdout.trim();
}
async function hookOwner() {
  const { stdout } = await exec(psExe(), ['-NoProfile', '-NonInteractive', '-Command',
    `$rows=Get-CimInstance Win32_Process; $id=${process.pid}; for($i=0;$i -lt 20;$i++){ $row=$rows | Where-Object ProcessId -eq $id | Select-Object -First 1; if(-not $row){break}; if($row.Name -match '^claude(\\.exe)?$'){ $row.ProcessId; exit 0 }; $id=$row.ParentProcessId }; exit 3`], { windowsHide: true, timeout: 10000, cwd: os.tmpdir() });
  return Number(stdout.trim());
}
function quote(arg) {
  return '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function records(scope) {
  const dir = scopeDir(scope);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter((name) => /^[0-9a-f-]{36}$/.test(name)).map((id) => {
    const file = path.join(dir, id, 'state.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.scope !== scope || value.id !== id || !['starting', 'running', 'released', 'failed', 'attached'].includes(value.status)) throw new Error('Invalid debug resource state: ' + file);
    return value;
  });
}
async function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}
async function originalProcessGone(pid, started) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !started) return false;
  try { return await identity(pid) !== started; }
  catch (e) { if (e.code === 3) return true; throw e; }
}
const STARTUP_TIMEOUT = 20000;
async function reconcile(scope, item) {
  // A launch that never reached `running` has no recorded process. Once the startup
  // window has passed, its supervisor is gone and closing the supervisor's only Job
  // handle already terminated anything it created, so the record can be retired.
  if (item.status === 'starting' && !item.pid && !item.supervisorPid) {
    let age = 0;
    try { age = Date.now() - fs.statSync(path.join(scopeDir(scope), item.id, 'state.json')).mtimeMs; } catch { return item; }
    if (age < STARTUP_TIMEOUT * 2) return item;
    const current = records(scope).find((record) => record.id === item.id);
    if (!current || current.status !== 'starting' || current.pid || current.supervisorPid) return current || item;
    const released = { ...current, status: 'released', error: 'Launch never reached running' };
    atomicWrite(path.join(scopeDir(scope), item.id, 'state.json'), released);
    return released;
  }
  if (!['running', 'failed'].includes(item.status) || !item.pid || !item.started || !item.supervisorPid || !item.supervisorStarted) return item;
  try {
    if (!await originalProcessGone(item.supervisorPid, item.supervisorStarted) ||
        !await originalProcessGone(item.pid, item.started)) return item;
    for (const port of item.ports || []) if (!await portFree(port)) return item;
  } catch { return item; }
  // The supervisor is gone; re-read before writing to avoid reverting an update it already saved.
  const current = records(scope).find((record) => record.id === item.id);
  if (!current || !['running', 'failed'].includes(current.status) ||
      current.pid !== item.pid || current.started !== item.started ||
      current.supervisorPid !== item.supervisorPid || current.supervisorStarted !== item.supervisorStarted) return current || item;
  const released = { ...current, status: 'released', error: null };
  atomicWrite(path.join(scopeDir(scope), item.id, 'state.json'), released);
  return released;
}
async function verify(scope) {
  const items = records(scope);
  const pending = [];
  for (const recorded of items) {
    const item = await reconcile(scope, recorded);
    if (item.status !== 'released') { pending.push({ id: item.id, reason: item.error || item.status }); continue; }
    for (const [pid, started, name] of [[item.supervisorPid, item.supervisorStarted, 'Supervisor'], [item.pid, item.started, 'Debug process']]) {
      if (!pid) continue;
      try {
        if (!await originalProcessGone(pid, started)) pending.push({ id: item.id, reason: `${name} has not exited or has no recorded identity` });
      } catch { pending.push({ id: item.id, reason: `Cannot verify ${name.toLowerCase()} exit` }); }
    }
    for (const port of item.ports || []) if (!await portFree(port)) pending.push({ id: item.id, reason: `Port ${port} remains occupied (ownership unknown; not terminated)` });
  }
  return { ok: pending.length === 0, count: items.length, pending };
}
async function launch({ scope, exe, args = [], cwd = os.tmpdir(), env, ports = [], ownerPid = process.pid, wait = 0 }) {
  if (process.platform !== 'win32') throw new Error('Managed debug launch currently requires Windows; use explicit finally cleanup on this platform');
  if (!scope || !path.isAbsolute(exe) || !path.isAbsolute(cwd)) throw new Error('scope and absolute exe/cwd are required');
  if (!ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error('Invalid debug ports');
  const ownerStarted = await identity(ownerPid);
  const id = crypto.randomUUID();
  const dir = path.join(scopeDir(scope), id);
  atomicWrite(path.join(dir, 'state.json'), { version: 1, id, scope, status: 'starting', ports });
  activeScopes.add(scope);
  // The supervisor script and cwd live outside the software being tested.
  const script = path.join(dir, 'supervisor.ps1');
  fs.copyFileSync(path.join(__dirname, 'supervisor.ps1'), script);
  const relay = path.join(dir, 'relay.js');
  fs.copyFileSync(path.join(__dirname, 'relay.js'), relay);
  // libuv puts every non-detached child into the parent's KILL_ON_JOB_CLOSE Job, so a short-lived
  // `cli.js launch` would take the supervisor (and its target) down on exit. PowerShell cannot run
  // detached (no console), so a detached node relay hosts it; see relay.js.
  const child = spawn(process.execPath, [relay, psExe(), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Directory', dir], {
    cwd: os.tmpdir(), windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let error = '';
  let output = '';
  child.stderr.on('data', (data) => { error = (error + data).slice(-4000); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Debug supervisor startup timeout')), STARTUP_TIMEOUT);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(error || `Debug supervisor exited: ${code}`)); });
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-200);
      if (/(^|\n)ready\r?\n/.test(output)) { clearTimeout(timer); resolve(); }
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ id, scope, exe, command: [exe, ...args].map(quote).join(' '), cwd, env, ports, ownerPid, ownerStarted }) + '\n');
  try { await ready; }
  catch (e) {
    fs.writeFileSync(path.join(dir, 'stop'), 'startup failed');
    child.kill(); // Closing the only Job handle also terminates suspended/started children.
    atomicWrite(path.join(dir, 'state.json'), { version: 1, id, scope, status: 'failed', error: e.message, ports });
    throw e;
  }
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  const record = records(scope).find((item) => item.id === id);
  return wait ? waitForExit(scope, id, wait) : record;
}
function tail(file, bytes = 8000) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return (size > bytes ? '…(truncated)\n' : '') + buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Foreground mode: block until the target exits (or the timeout stops it), then return
// its exit code and output. The record is released by then, so nothing is left to clean.
async function waitForExit(scope, id, timeoutMs) {
  const dir = path.join(scopeDir(scope), id);
  const end = Date.now() + timeoutMs;
  let timedOut = false;
  for (;;) {
    const item = records(scope).find((r) => r.id === id);
    if (!item || ['released', 'failed'].includes(item.status)) {
      return { ...item, timedOut, output: tail(path.join(dir, 'output.log')) };
    }
    if (!timedOut && Date.now() > end) { timedOut = true; fs.writeFileSync(path.join(dir, 'stop'), 'wait timeout'); }
    if (timedOut && Date.now() > end + 15000) return { ...item, timedOut, output: tail(path.join(dir, 'output.log')) };
    await delay(100);
  }
}
function attach(scope, { name, release, verify: check }) {
  if (typeof release !== 'function' || typeof check !== 'function') throw new Error('Attached debug resources require release and verify callbacks');
  const id = crypto.randomUUID();
  atomicWrite(path.join(scopeDir(scope), id, 'state.json'), { version: 1, id, scope, name, status: 'attached', ports: [] });
  callbacks.set(id, { release, check });
  activeScopes.add(scope);
  return id;
}
async function bounded(work, ms, message) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function cleanup(scope) {
  if (inFlight.has(scope)) return inFlight.get(scope);
  const work = (async () => {
    const items = records(scope);
    for (const item of items) {
      if (item.status === 'released') continue;
      const dir = path.join(scopeDir(scope), item.id);
      const callback = callbacks.get(item.id);
      if (callback) {
        try {
          await bounded(callback.release, 5000, 'Connection release timeout');
          const checked = await bounded(callback.check, 2000, 'Connection verification timeout');
          if (!checked) throw new Error('Connection release not verified');
          atomicWrite(path.join(dir, 'state.json'), { ...item, status: 'released', error: null });
          callbacks.delete(item.id);
        } catch (e) { atomicWrite(path.join(dir, 'state.json'), { ...item, status: 'failed', error: e.message }); }
      } else if (item.status !== 'attached') {
        // A stop request addresses this private supervisor, never a PID from disk.
        fs.writeFileSync(path.join(dir, 'stop'), 'cleanup');
      }
    }
    const deadline = Date.now() + 10000;
    let report;
    do {
      report = await verify(scope);
      if (report.ok || !items.some((r) => r.supervisorPid || r.status === 'starting')) break;
      await delay(200);
    } while (Date.now() < deadline);
    if (report.ok) activeScopes.delete(scope);
    return report;
  })();
  inFlight.set(scope, work);
  try { return await work; } finally { inFlight.delete(scope); }
}
async function cleanupAll() {
  return Promise.all([...activeScopes].map((scope) => cleanup(scope).catch((e) => ({ ok: false, pending: [{ reason: e.message }] }))));
}
function track(scope) { activeScopes.add(scope); return scope; }
module.exports = { launch, attach, cleanup, cleanupAll, verify, records, track, quote, identity, hookOwner, scopeDir, atomicWrite };
