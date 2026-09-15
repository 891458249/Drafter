const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const FILES = ['index.js', 'rules.js', 'cli.js', 'supervisor.ps1'];
function runtimeDirectory() {
  if (!__dirname.includes('app.asar')) return __dirname;
  const content = FILES.map((file) => fs.readFileSync(path.join(__dirname, file)));
  const hash = crypto.createHash('sha256');
  for (const value of content) hash.update(value);
  const dir = path.join(os.homedir(), '.claude', 'debug-runtime', hash.digest('hex'));
  fs.mkdirSync(dir, { recursive: true });
  FILES.forEach((file, i) => { if (!fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), content[i]); });
  return dir;
}
module.exports = { runtimeDirectory, FILES };
