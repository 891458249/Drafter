// Session manager: multiple parallel Claude Code sessions via the Agent SDK.
// Each session drives one query() with streaming input, so we can:
//  - send additional messages while a turn is running (B5)
//  - interrupt without killing the session (B2)
//  - surface permission requests to the renderer via canUseTool (B1)
//  - resume persisted sessions (B3) and fork side chats (B24)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Notification } = require('electron');
const store = require('./store');
const projects = require('./projects');
const perms = require('./perms');

// The Agent SDK is ESM-only — load it via dynamic import().
let sdk = null;
let sdkError = null;

// Resolve the SDK's bundled claude.exe explicitly. In a packaged app the SDK
// computes a path inside app.asar: fs.exists passes (Electron redirects reads
// to app.asar.unpacked) but the OS cannot spawn a binary out of an archive —
// the real file is under app.asar.unpacked. The win32-x64 package is hoisted
// in dev and nested under the SDK package in the asar, so try all layouts.
function resolveClaudeExe() {
  const BIN = ['@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'];
  const candidates = [];
  try { candidates.push(require.resolve(BIN.join('/'))); } catch {} // hoisted(开发态)
  try { // 嵌套在 SDK 包下(打包态实际布局)
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    candidates.push(path.join(path.dirname(sdkEntry), 'node_modules', ...BIN));
  } catch {}
  try { // Electron resources 兜底
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked',
        'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', ...BIN));
    }
  } catch {}
  for (const c of candidates) {
    const unpacked = path.normalize(c).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return null; // 找不到就让 SDK 自行解析(开发态默认可用)
}
let sdkPromise = null;
function loadSdk() {
  if (sdk) return Promise.resolve(true);
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk')
      .then((m) => { sdk = m; return true; })
      .catch((e) => {
        sdkError = e.message;
        console.error('[sessions] Agent SDK not available:', e.message);
        return false;
      });
  }
  return sdkPromise;
}

// Async queue usable as AsyncIterable<SDKUserMessage> for streaming input.
class AsyncQueue {
  constructor() {
    this.items = [];
    this.resolvers = [];
    this.done = false;
  }
  push(item) {
    if (this.done) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.done = true;
    for (const r of this.resolvers.splice(0)) r({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
      return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

class Session {
  constructor(manager, meta) {
    this.m = manager;
    this.id = meta.id;
    this.meta = meta;               // { id, cwd, model, permissionMode, sdkSessionId, title, parentId, worktreePath, archived }
    this.queue = null;
    this.q = null;
    this.running = false;           // process alive
    this.busy = false;              // a turn is in flight
    this.pendingPerms = new Map();  // reqId -> { resolve, toolName }
    this.autoAllowTools = new Set();// "Always allow" decisions for this session
    this.slashCommands = [];
    this.lastUsage = null;
    this.cumCostUsd = 0;
  }

  async start({ resume = false, fork = false } = {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    // create the queue up-front so send() can push while the SDK loads
    this.queue = new AsyncQueue();
    const ok = await loadSdk();
    if (!ok) {
      this.starting = false;
      this._emit({ type: 'ui_error', message: 'Agent SDK 未安装:' + sdkError });
      return;
    }
    const options = {
      cwd: this.meta.cwd,
      permissionMode: this.meta.permissionMode || 'default',
      includePartialMessages: true,
      env: this.m.buildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      settingSources: ['user', 'project', 'local'],
      stderr: (data) => this._emit({ type: 'ui_stderr', text: String(data) }),
      canUseTool: (toolName, input, opts) => this._onPermission(toolName, input, opts),
    };
    if (this.meta.model) options.model = this.meta.model;
    if (this.meta.effort) options.effort = this.meta.effort;
    const exe = resolveClaudeExe();
    if (exe) options.pathToClaudeCodeExecutable = exe; // 打包态指向 app.asar.unpacked(F-001)
    if (resume && this.meta.sdkSessionId) {
      options.resume = this.meta.sdkSessionId;
      if (fork) options.forkSession = true;
    }
    // project-group context: shared memory + file tags + extra dirs + readonly hook
    let projCtx = null;
    try {
      projCtx = this.meta.projectId ? projects.contextFor(this.meta.projectId, this.meta.cwd) : null;
    } catch (e) { console.error('[sessions] project ctx failed:', e.message); }
    if (projCtx) {
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: projCtx.append };
      if (projCtx.additionalDirectories && projCtx.additionalDirectories.length) {
        options.additionalDirectories = projCtx.additionalDirectories;
      }
      const pid = this.meta.projectId;
      options.hooks = {
        PreToolUse: [{
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [async (hookInput) => {
            try {
              const ti = (hookInput && hookInput.tool_input) || {};
              const fp = ti.file_path || ti.notebook_path;
              if (fp && projects.isReadonly(pid, fp)) {
                return {
                  decision: 'block',
                  reason: `文件 ${fp} 在项目组中被标记为只读,禁止修改。`,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: `文件 ${fp} 被标记为只读,禁止修改;如确需修改请让用户先更改标签`,
                  },
                };
              }
            } catch {}
            return {};
          }],
        }],
      };
    }
    try {
      this.q = sdk.query({ prompt: this.queue, options });
    } catch (e) {
      this.starting = false;
      this._emit({ type: 'ui_error', message: 'query() 启动失败:' + e.message });
      return;
    }
    this.starting = false;
    this.running = true;
    this._pump();
  }

  async _pump() {
    try {
      for await (const msg of this.q) {
        this._handleMessage(msg);
      }
    } catch (e) {
      this._emit({ type: 'ui_error', message: '会话异常终止:' + (e && e.message || e) });
    } finally {
      this.running = false;
      this.busy = false;
      this._emit({ type: 'ui_status', running: false, busy: false });
      // fail any pending permission prompts
      for (const [reqId, p] of this.pendingPerms) {
        try { p.resolve({ behavior: 'deny', message: '会话已结束' }); } catch {}
        this.pendingPerms.delete(reqId);
      }
    }
  }

  _handleMessage(msg) {
    // capture sdk session id
    if (msg.session_id && msg.session_id !== this.meta.sdkSessionId) {
      this.meta.sdkSessionId = msg.session_id;
      store.upsertSession({ id: this.id, sdkSessionId: msg.session_id });
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (Array.isArray(msg.slash_commands)) this.slashCommands = msg.slash_commands;
      this.lastInitModel = msg.model || this.lastInitModel;
      this._emit({ type: 'ui_init', model: msg.model, tools: msg.tools, slashCommands: msg.slash_commands });
      return;
    }
    if (msg.type === 'stream_event') {
      // stream deltas: forward but don't persist
      this.m.send('sess:event', { sid: this.id, ev: { type: 'stream_event', event: msg.event, parent_tool_use_id: msg.parent_tool_use_id || null } });
      return;
    }
    if (msg.type === 'assistant' || msg.type === 'user') {
      const ev = {
        type: msg.type,
        message: msg.message,
        parent_tool_use_id: msg.parent_tool_use_id || null,
      };
      this._emit(ev, true);
      return;
    }
    if (msg.type === 'result') {
      this.busy = false;
      const cost = msg.total_cost_usd != null ? msg.total_cost_usd
        : (msg.cost && msg.cost.total_cost_usd != null ? msg.cost.total_cost_usd : null);
      if (cost != null) this.cumCostUsd += cost;
      this.lastUsage = msg.usage || null;
      // 真实上下文窗口大小:result.modelUsage 按模型给出 contextWindow;
      // usage 字段是整轮多次 API 调用的输入加总,不能当上下文大小用
      let contextWindow = null;
      try {
        const mu = msg.modelUsage || {};
        const vals = Object.values(mu);
        if (vals.length) contextWindow = Math.max(...vals.map((v) => v.contextWindow || 0)) || null;
      } catch {}
      // 累计各模型 token 消耗(用量弹层)
      try {
        if (msg.usage) store.addModelUsage(this.meta.model || this.lastInitModel || 'default', msg.usage, cost || 0);
      } catch {}
      const ev = {
        type: 'result',
        subtype: msg.subtype,
        is_error: !!(msg.is_error || (msg.subtype && msg.subtype.startsWith('error'))),
        duration_ms: msg.duration_ms,
        num_turns: msg.num_turns,
        total_cost_usd: cost,
        cum_cost_usd: this.cumCostUsd,
        usage: msg.usage || null,
        contextWindow,
        result: typeof msg.result === 'string' ? msg.result.slice(0, 2000) : undefined,
      };
      this._emit(ev, true);
      this._emit({ type: 'ui_status', running: this.running, busy: false });
      this.m.onTurnDone(this);
      return;
    }
    if (msg.type === 'compact_boundary' || (msg.type === 'system' && msg.subtype === 'compact_boundary')) {
      this._emit({ type: 'ui_compact' }, true);
      return;
    }
    // anything else: forward raw for debugging
    this.m.send('sess:event', { sid: this.id, ev: { type: 'ui_other', raw: safeJson(msg) } });
  }

  _emit(ev, persist = false) {
    if (persist) store.appendSessionEvent(this.id, ev);
    this.m.send('sess:event', { sid: this.id, ev });
  }

  // --- permission flow (canUseTool) ---
  _onPermission(toolName, input, opts = {}) {
    // hard guard: read-only tagged files can never be modified (backup to the hook)
    try {
      if (this.meta.projectId && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
        const fp = input && (input.file_path || input.notebook_path);
        if (fp && projects.isReadonly(this.meta.projectId, fp)) {
          this._emit({ type: 'ui_error', message: `已拦截对只读文件的修改:${fp}` }, true);
          return Promise.resolve({ behavior: 'deny', message: `文件 ${fp} 被标记为只读,禁止修改` });
        }
      }
    } catch {}
    // auto-allow if the user chose "always" for this tool in this session
    if (this.autoAllowTools.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const reqId = 'perm_' + crypto.randomUUID();
    const suggestions = opts.suggestions || [];
    return new Promise((resolve) => {
      this.pendingPerms.set(reqId, { resolve, toolName, input, suggestions });
      const payload = {
        type: 'ui_permission', reqId, toolName,
        input: safeJson(input),
        isPlan: toolName === 'ExitPlanMode',
        hasSuggestions: suggestions.length > 0,
      };
      this._emit(payload, true);
      this.m.notifyPermission(this, toolName);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          if (this.pendingPerms.has(reqId)) {
            this.pendingPerms.delete(reqId);
            this._emit({ type: 'ui_permission_done', reqId, decision: 'aborted' }, true);
            resolve({ behavior: 'deny', message: '已中断' });
          }
        }, { once: true });
      }
    });
  }

  // decision: 'allow' | 'always' | 'deny'; denyMessage optional
  respondPermission(reqId, decision, denyMessage) {
    const p = this.pendingPerms.get(reqId);
    if (!p) return false;
    this.pendingPerms.delete(reqId);
    this._emit({ type: 'ui_permission_done', reqId, decision }, true);
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: denyMessage || '用户拒绝了此操作' });
      return true;
    }
    if (decision === 'always') {
      this.autoAllowTools.add(p.toolName);
      const res = { behavior: 'allow', updatedInput: p.input };
      if (p.suggestions && p.suggestions.length) res.updatedPermissions = p.suggestions;
      // persist the rule to <cwd>/.claude/settings.local.json so it survives restarts;
      // the current session stays covered by autoAllowTools + updatedPermissions above
      try {
        const rules = perms.rulesFromSuggestions(p.suggestions);
        const wr = perms.addAllowRules(this.meta.cwd, rules.length ? rules : [p.toolName]);
        if (!wr.ok) this._emit({ type: 'ui_error', message: '权限规则持久化失败:' + (wr.error || '未知错误') }, true);
      } catch (e) {
        this._emit({ type: 'ui_error', message: '权限规则持久化失败:' + e.message }, true);
      }
      p.resolve(res);
      return true;
    }
    p.resolve({ behavior: 'allow', updatedInput: p.input });
    return true;
  }

  // content: string | array of content blocks ({type:'text'|'image',...})
  send(content) {
    if (!this.running && !this.starting) this.start({ resume: !!this.meta.sdkSessionId });
    if (!this.queue) return false;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.meta.sdkSessionId || undefined,
    });
    this.busy = true;
    this._persistUserEcho(content);
    this._emit({ type: 'ui_status', running: true, busy: true });
    return true;
  }

  _persistUserEcho(content) {
    // persist a lightweight echo of what the user sent; keep image data so
    // history replay can render thumbnails
    const slim = typeof content === 'string' ? content
      : content.map((b) => b.type === 'image'
        ? { type: 'image_ref', mediaType: b.source && b.source.media_type, data: b.source && b.source.data }
        : b);
    store.appendSessionEvent(this.id, { type: 'ui_user_input', content: slim });
  }

  async interrupt() {
    if (this.q && this.busy) {
      try { await this.q.interrupt(); } catch (e) {
        this._emit({ type: 'ui_error', message: 'interrupt 失败:' + e.message });
      }
      this.busy = false;
      this._emit({ type: 'ui_status', running: this.running, busy: false });
    }
  }

  async setPermissionMode(mode) {
    this.meta.permissionMode = mode;
    store.upsertSession({ id: this.id, permissionMode: mode });
    if (this.q && this.running) {
      try { await this.q.setPermissionMode(mode); return true; } catch {}
    }
    return false;
  }

  async setModel(model) {
    this.meta.model = model;
    store.upsertSession({ id: this.id, model });
    if (this.q && this.running) {
      try { await this.q.setModel(model || undefined); return true; } catch {}
    }
    return false;
  }

  // effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null(默认)
  async setEffort(effort) {
    this.meta.effort = effort || null;
    store.upsertSession({ id: this.id, effort: effort || null });
    if (this.q && this.running) {
      try { await this.q.applyFlagSettings({ effortLevel: effort || null }); return true; } catch {}
    }
    return false;
  }

  stop() {
    if (this.queue) this.queue.end();
    if (this.q && typeof this.q.close === 'function') { try { this.q.close(); } catch {} }
    this.running = false;
    this.busy = false;
  }
}

class SessionManager {
  constructor(getWindow, buildEnv) {
    this.getWindow = getWindow;
    this.buildEnv = buildEnv;
    this.sessions = new Map(); // id -> Session
    this.activeId = null;      // renderer-visible session (for notifications)
  }

  send(channel, payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  async sdkAvailable() {
    const ok = await loadSdk();
    return { ok, error: sdkError };
  }

  list() {
    return store.listSessions().map((meta) => {
      const live = this.sessions.get(meta.id);
      return { ...meta, running: !!(live && live.running), busy: !!(live && live.busy) };
    });
  }

  create({ cwd, model, permissionMode, title, parentId, worktreePath, forkFrom, projectId, effort, standalone, kind }) {
    const id = 's_' + crypto.randomUUID().slice(0, 12);
    const meta = {
      id, cwd, model: model || null,
      effort: effort || null,
      permissionMode: permissionMode || 'default',
      title: title || null, parentId: parentId || null,
      worktreePath: worktreePath || null,
      projectId: projectId || null,
      sdkSessionId: forkFrom || null, archived: false,
      standalone: !!standalone, // 独立会话:不属于任何项目组(v0.5.0 起新会话默认)
      kind: kind || null, // 'chat' = chat 板块会话(v0.6.0)
    };
    store.upsertSession(meta);
    const s = new Session(this, meta);
    this.sessions.set(id, s);
    s.start({ resume: !!forkFrom, fork: !!forkFrom });
    return meta;
  }

  // Reattach a persisted session (after app restart): lazily resumed on first send.
  ensure(id) {
    let s = this.sessions.get(id);
    if (s) return s;
    const meta = store.listSessions().find((x) => x.id === id);
    if (!meta) return null;
    s = new Session(this, meta);
    this.sessions.set(id, s);
    return s;
  }

  get(id) { return this.sessions.get(id) || this.ensure(id); }

  history(id) { return store.readSessionEvents(id); }

  rename(id, title) { store.upsertSession({ id, title }); }

  archive(id, archived = true) {
    store.upsertSession({ id, archived });
    if (archived) {
      const s = this.sessions.get(id);
      if (s) { s.stop(); this.sessions.delete(id); }
    }
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (s) { s.stop(); this.sessions.delete(id); }
    store.deleteSession(id);
  }

  setActive(id) { this.activeId = id; }

  onTurnDone(session) {
    if (session.id !== this.activeId) {
      this.notify('任务完成', (session.meta.title || session.meta.cwd) + ' 的回合已结束');
      this.send('sess:attention', { sid: session.id });
    }
  }

  notifyPermission(session, toolName) {
    if (session.id !== this.activeId) {
      this.notify('需要权限确认', `${session.meta.title || '会话'} 请求使用 ${toolName}`);
      this.send('sess:attention', { sid: session.id });
    }
  }

  notify(title, body) {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch {}
  }

  stopAll() {
    for (const s of this.sessions.values()) s.stop();
  }
}

function safeJson(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return String(obj); }
}

module.exports = { SessionManager, resolveClaudeExe };
