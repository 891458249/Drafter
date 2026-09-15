const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FILES } = require('../src/main/debug-resources/runtime');
function mergeHooks(settings, directory) {
  const command = `node "${path.join(directory, 'cli.js')}" hook`;
  const hooks = { ...(settings.hooks || {}) };
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']) {
    const entries = hooks[event] || [];
    if (entries.some((entry) => entry.hooks?.some((h) => h.command === command))) continue;
    hooks[event] = [...entries, {
      ...(['PreToolUse', 'PostToolUseFailure'].includes(event) ? { matcher: 'Bash|PowerShell|mcp__.*' } : {}),
      hooks: [{ type: 'command', command, timeout: 30 }],
    }];
  }
  return { ...settings, hooks };
}
function install(home = path.join(os.homedir(), '.claude')) {
  const target = path.join(home, 'debug-resources');
  const settingsPath = path.join(home, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const manifestPath = path.join(target, 'installed.json');
  const digest = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  for (const file of FILES) {
    const destination = path.join(target, file);
    if (fs.existsSync(destination) && previous[file] !== digest(destination)) throw new Error('Refusing to overwrite unrecognized or modified runtime: ' + destination);
  }
  fs.mkdirSync(target, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(__dirname, '../src/main/debug-resources', file), path.join(target, file));
  fs.writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(FILES.map((file) => [file, digest(path.join(target, file))])), null, 2));
  fs.writeFileSync(settingsPath + '.debug-cleanup.' + Date.now() + '.bak', fs.readFileSync(settingsPath));
  const temp = settingsPath + '.debug-cleanup.tmp';
  fs.writeFileSync(temp, JSON.stringify(mergeHooks(settings, target), null, 2) + '\n');
  fs.renameSync(temp, settingsPath);
  console.log('Installed debug cleanup hooks: ' + settingsPath);
}
if (require.main === module) install(process.argv[2]);
module.exports = { mergeHooks, install };
