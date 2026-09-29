// Detached lifetime anchor for supervisor.ps1. PowerShell started with DETACHED_PROCESS (no console)
// exits 0 without running anything, so the launcher starts this relay detached instead (escaping the
// launching process's libuv KILL_ON_JOB_CLOSE Job) and the relay starts PowerShell normally. PowerShell
// lives in the relay's own Job: if the relay dies, the supervisor and its private Job go with it.
const { spawn } = require('node:child_process');
const [ps, ...args] = process.argv.slice(2);
const child = spawn(ps, args, { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const quiet = () => {};
process.stdout.on('error', quiet);
process.stderr.on('error', quiet);
child.stdin.on('error', quiet);
process.stdin.pipe(child.stdin);
child.stdout.on('data', (data) => { try { process.stdout.write(data); } catch {} });
child.stderr.on('data', (data) => { try { process.stderr.write(data); } catch {} });
child.on('error', (e) => { try { process.stderr.write(e.message); } catch {} process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
