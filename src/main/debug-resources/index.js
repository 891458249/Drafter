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
    `try { $p=[Diagnostics.Process]::GetProcessById(${pid}); $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { exit 3 }`], { windowsHide: true, timeout: 5000, cwd: os.tmpdir() });
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
async function verify(scope) {
  const items = records(scope);
  const pending = [];
  for (const item of items) {
    if (item.status !== 'released') { pending.push({ id: item.id, reason: item.error || item.status }); continue; }
    if (item.supervisorPid) {
      try {
        if (await identity(item.supervisorPid) === item.supervisorStarted) {
          pending.push({ id: item.id, reason: 'Supervisor has not exited' });
          continue;
        }
      } catch (e) { if (e.code !== 3) { pending.push({ id: item.id, reason: 'Cannot verify supervisor exit' }); continue; } }
    }
    for (const port of item.ports || []) if (!await portFree(port)) pending.push({ id: item.id, reason: `Port ${port} remains occupied (ownership unknown; not terminated)` });
  }
  return { ok: pending.length === 0, count: items.length, pending };
}
async function launch({ scope, exe, args = [], cwd = os.tmpdir(), env, ports = [], ownerPid = process.pid }) {
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
  const child = spawn(psExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Directory', dir], {
    cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let error = '';
  child.stderr.on('data', (data) => { error = (error + data).slice(-4000); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Debug supervisor startup timeout')), 20000);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(error || `Debug supervisor exited: ${code}`)); });
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
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
  return records(scope).find((item) => item.id === id);
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
