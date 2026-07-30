// MCP servers management: read/write mcpServers in ~/.claude.json (global)
// and <project>/.mcp.json (project scope).
const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_PATH = () => path.join(os.homedir(), '.claude.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function listServers(cwd) {
  const out = [];
  const g = readJson(GLOBAL_PATH());
  if (g && g.mcpServers) {
    for (const [name, cfg] of Object.entries(g.mcpServers)) out.push({ name, scope: 'global', config: cfg });
  }
  if (cwd) {
    const p = readJson(path.join(cwd, '.mcp.json'));
    if (p && p.mcpServers) {
      for (const [name, cfg] of Object.entries(p.mcpServers)) out.push({ name, scope: 'project', config: cfg });
    }
  }
  return out;
}

function saveServer(cwd, scope, name, config) {
  try {
    const file = scope === 'project' ? path.join(cwd, '.mcp.json') : GLOBAL_PATH();
    const data = readJson(file) || {};
    data.mcpServers = data.mcpServers || {};
    data.mcpServers[name] = config;
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteServer(cwd, scope, name) {
  try {
    const file = scope === 'project' ? path.join(cwd, '.mcp.json') : GLOBAL_PATH();
    const data = readJson(file);
    if (data && data.mcpServers && data.mcpServers[name] !== undefined) {
      delete data.mcpServers[name];
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listServers, saveServer, deleteServer };
