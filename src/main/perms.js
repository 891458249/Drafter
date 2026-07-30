// Permission rule persistence: read-modify-write <cwd>/.claude/settings.local.json
// (Claude Code official local settings format: permissions.allow/deny/ask).
// Preserves unrelated keys; backs up the original file before rebuilding
// when the existing JSON is corrupted — never silently wipes it.
const fs = require('fs');
const path = require('path');

function settingsPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

function readSettings(cwd) {
  const p = settingsPath(cwd);
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ok = json && typeof json === 'object' && !Array.isArray(json);
    return { ok: true, json: ok ? json : {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, json: {} };
    return { ok: false, error: e.message };
  }
}

function backupCorrupted(cwd) {
  const p = settingsPath(cwd);
  const bak = p + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(p, bak); } catch {}
  return bak;
}

function writeSettings(cwd, json) {
  const p = settingsPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
}

// SDK PermissionSuggestion → Claude Code rule string, e.g. "Bash(npm test:*)" / "Edit".
function ruleToString(r) {
  if (typeof r === 'string') return r.trim() || null;
  if (!r || typeof r !== 'object') return null;
  const tool = String(r.toolName || r.tool || '').trim();
  if (!tool) return null;
  const content = String(r.ruleContent || '').trim();
  return content ? `${tool}(${content})` : tool;
}

// Extract allow-rule strings from canUseTool opts.suggestions.
function rulesFromSuggestions(suggestions) {
  const out = [];
  for (const s of suggestions || []) {
    if (typeof s === 'string') { if (s.trim()) out.push(s.trim()); continue; }
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'addRules' && Array.isArray(s.rules)) {
      if (s.behavior && s.behavior !== 'allow') continue;
      for (const r of s.rules) {
        const str = ruleToString(r);
        if (str) out.push(str);
      }
    } else {
      const str = ruleToString(s);
      if (str) out.push(str);
    }
  }
  return [...new Set(out)];
}

// Add rules to permissions.allow. Returns { ok, added, backup?, error? }.
function addAllowRules(cwd, rules) {
  const list = [...new Set((rules || []).map((r) => String(r || '').trim()).filter(Boolean))];
  if (!list.length) return { ok: true, added: [] };
  const r = readSettings(cwd);
  if (!r.ok) {
    // corrupted JSON: back up the original, then rebuild with just our rules
    const backup = backupCorrupted(cwd);
    try {
      writeSettings(cwd, { permissions: { allow: list } });
    } catch (e) {
      return { ok: false, error: e.message, backup };
    }
    return { ok: true, added: list, backup };
  }
  const json = r.json;
  if (!json.permissions || typeof json.permissions !== 'object') json.permissions = {};
  const allow = Array.isArray(json.permissions.allow) ? json.permissions.allow : [];
  const added = [];
  for (const rule of list) {
    if (!allow.includes(rule)) { allow.push(rule); added.push(rule); }
  }
  json.permissions.allow = allow;
  try {
    writeSettings(cwd, json);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, added };
}

function listRules(cwd) {
  const r = readSettings(cwd);
  if (!r.ok) return { ok: false, error: r.error, path: settingsPath(cwd) };
  const perms = (r.json && r.json.permissions) || {};
  return {
    ok: true,
    path: settingsPath(cwd),
    allow: Array.isArray(perms.allow) ? perms.allow : [],
    deny: Array.isArray(perms.deny) ? perms.deny : [],
    ask: Array.isArray(perms.ask) ? perms.ask : [],
  };
}

function removeRule(cwd, kind, rule) {
  if (!['allow', 'deny', 'ask'].includes(kind)) return { ok: false, error: '未知规则类型:' + kind };
  const r = readSettings(cwd);
  if (!r.ok) return { ok: false, error: r.error };
  const json = r.json;
  if (!json.permissions || typeof json.permissions !== 'object') json.permissions = {};
  const arr = Array.isArray(json.permissions[kind]) ? json.permissions[kind] : [];
  const next = arr.filter((x) => x !== rule);
  if (next.length === arr.length) return { ok: true, removed: false };
  json.permissions[kind] = next;
  try {
    writeSettings(cwd, json);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, removed: true };
}

module.exports = { settingsPath, rulesFromSuggestions, addAllowRules, listRules, removeRule };
