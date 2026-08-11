// Session manager: multiple parallel Claude Code sessions via the Agent SDK.
// Each session drives one query() with streaming input, so we can:
//  - send additional messages while a turn is running (B5)
//  - interrupt without killing the session (B2)
//  - surface permission requests to the renderer via canUseTool (B1)
//  - resume persisted sessions (B3) and fork side chats (B24)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Notification } = require('electron');
const store = require('./store');
const projects = require('./projects');
const perms = require('./perms');
const keys = require('./keys');
const gems = require('./gems');

// The Agent SDK is ESM-only — load it via dynamic import().
let sdk = null;
let sdkError = null;

// Claude Code 把会话记录存在 ~/.claude/projects/<cwd编码>/<sessionId>.jsonl,
// 编码规则(claude.exe 内函数 A0):非字母数字一律换成 '-',超 200 字符再截断+哈希。
// cwd 变更(adoptDir)后 resume 会在新目录找不到旧记录而失败(v0.9.7 的坑),
// 因此 start() 前要把旧目录的记录复制过来(migrateTranscript)。
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_CONFIG_DIR, 'projects');
function encodeCwdForProjects(cwd) {
  const t = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  if (t.length <= 200) return t;
  let h = 0; // 与 claude.exe 的 att() 相同的字符串哈希
  for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
  return `${t.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}
// 把旧 cwd 目录下的会话记录复制到新 cwd 目录(已存在则跳过,留底不移动)。
// 旧目录找不到时兜底扫描所有记录目录(如连续两次 adopt,记录还停在更早的 cwd)。
// 返回 true 表示记录已就位(或本来就在),resume 可以命中旧上下文。
function migrateTranscript(sessionId, oldCwd, newCwd) {
  if (!sessionId || !newCwd) return false;
  try {
    const dstDir = path.join(CLAUDE_PROJECTS_DIR, encodeCwdForProjects(newCwd));
    const dst = path.join(dstDir, sessionId + '.jsonl');
    if (fs.existsSync(dst)) return true;
    let src = oldCwd ? path.join(CLAUDE_PROJECTS_DIR, encodeCwdForProjects(oldCwd), sessionId + '.jsonl') : null;
    if (!src || !fs.existsSync(src)) {
      src = null;
      for (const d of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
        const p = path.join(CLAUDE_PROJECTS_DIR, d, sessionId + '.jsonl');
        if (fs.existsSync(p)) { src = p; break; }
      }
    }
    if (!src) return false;
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (e) {
    console.error('[sessions] transcript migrate failed:', e.message);
    return false;
  }
}

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

  async start({ resume = false, fork = false, forkAt = null } = {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    // 自愈(v0.9.5):code/chat 会话上残留的新媒体模型(旧版板块切换错绑,发送必 403
    // 「模型未配置」)在启动时清空,回退默认模型
    if (this.meta.model && (!this.meta.kind || this.meta.kind === 'code' || this.meta.kind === 'chat')) {
      try {
        if (keys.modelType(this.meta.keyId, this.meta.model) !== 'chat') {
          this.meta.model = null;
          store.upsertSession({ id: this.id, model: null });
        }
      } catch {}
    }
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
      env: this.m.buildEnv({ ELECTRON_RUN_AS_NODE: '1' }, this.meta.keyId), // 按会话绑定的 Key 注入凭据(v0.8.2)
      settingSources: ['user', 'project', 'local'],
      stderr: (data) => this._emit({ type: 'ui_stderr', text: String(data) }),
      canUseTool: (toolName, input, opts) => this._onPermission(toolName, input, opts),
    };
    if (this.meta.model) options.model = this.meta.model;
    if (this.meta.effort) options.effort = this.meta.effort;
    const exe = resolveClaudeExe();
    if (exe) options.pathToClaudeCodeExecutable = exe; // 打包态指向 app.asar.unpacked(F-001)
    if (resume && this.meta.sdkSessionId) {
      // cwd 变更后(adoptDir / 手动改目录)记录还在旧目录,先迁移再 resume(v0.9.10)
      const norm = (p) => path.resolve(p).toLowerCase();
      const prevCwd = this.meta.prevCwd || null; // adoptDir 切换前会登记
      const cwdChanged = !!prevCwd && norm(prevCwd) !== norm(this.meta.cwd || '');
      if (cwdChanged) {
        migrateTranscript(this.meta.sdkSessionId, prevCwd, this.meta.cwd);
        // 迁移是一次性的:消费后清掉,避免每次启动重复检查
        this.meta.prevCwd = null;
        store.upsertSession({ id: this.id, prevCwd: null });
      }
      // 迁移后新目录仍无记录 → resume 必失败("No conversation found"),
      // 清掉 sdkSessionId 走全新会话,避免每次 send 都失败把会话卡死
      const rec = path.join(CLAUDE_PROJECTS_DIR, encodeCwdForProjects(this.meta.cwd), this.meta.sdkSessionId + '.jsonl');
      if (!fs.existsSync(rec)) {
        this.meta.sdkSessionId = null;
        store.upsertSession({ id: this.id, sdkSessionId: null });
        this._emit({ type: 'ui_error', message: '旧会话记录缺失,已切换为新会话(上文仅保留界面可见部分)' });
      } else {
        options.resume = this.meta.sdkSessionId;
        if (fork) options.forkSession = true;
        // forkAt(v0.9.9):只恢复到指定消息 UUID 为止(编辑重生成/分支的锚点)
        if (forkAt) options.resumeSessionAt = forkAt;
      }
    }
    // project-group context: shared memory + file tags + extra dirs + readonly hook
    let projCtx = null;
    try {
      projCtx = this.meta.projectId ? projects.contextFor(this.meta.projectId, this.meta.cwd) : null;
    } catch (e) { console.error('[sessions] project ctx failed:', e.message); }
    // Gem 自定义助手(v0.9.11):指令注入 systemPrompt append;gem 被删则静默忽略
    let gemAppend = '';
    if (this.meta.gemId) {
      try { gemAppend = gems.composeAppend(gems.byId(this.meta.gemId)); } catch {}
    }
    if (projCtx || gemAppend) {
      const combined = ((projCtx && projCtx.append) || '') + gemAppend;
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: combined };
      // 无项目组时的附加目录由下方 else-if 分支统一处理(行为与旧版一致)
    }
    if (projCtx) {
      // systemPrompt 已在上方统一赋值(含 Gem append 合并)
      // 附加目录 = 项目组共享目录 + 会话级 /add-dir 登记的目录(v0.9.2)
      // 防御性过滤掉与 cwd 相同的目录(v0.9.7)
      const normCwd = (p) => path.resolve(p).toLowerCase();
      const allDirs = [...new Set([...(projCtx.additionalDirectories || []), ...(this.meta.extraDirs || [])])]
        .filter((d) => normCwd(d) !== normCwd(this.meta.cwd || ''));
      if (allDirs.length) options.additionalDirectories = allDirs;
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
    } else if (this.meta.extraDirs && this.meta.extraDirs.length) {
      // 无项目组(v0.9.2 起独立会话也可 /add-dir):只挂附加目录
      options.additionalDirectories = this.meta.extraDirs;
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
    const q = this.q; // v0.9.30:记录本次泵的 query——旧泵 finally 不得覆盖新 query 的状态
    try {
      for await (const msg of q) {
        this._handleMessage(msg);
      }
    } catch (e) {
      this._emit({ type: 'ui_error', message: '会话异常终止:' + (e && e.message || e) });
    } finally {
      if (this.q === q) {
        this.running = false;
        this.busy = false;
        this._emit({ type: 'ui_status', running: false, busy: false });
      }
      // fail any pending permission prompts(无论是否同一 query,旧权限卡都要了结)
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
      // uuid(v0.9.9):编辑重生成/分支的上下文锚点;renderer 的 eventKey 已忽略该字段
      if (msg.uuid) ev.uuid = msg.uuid;
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
        if (msg.usage || cost != null) store.addKeyUsage(this.meta.keyId, cost || 0, msg.usage || {}); // 按 key 归账(v0.8.0)
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
      this.m.onTurnDone(this, ev);
      // /add-dir 在回合中登记:回合结束后重启 query 使目录生效(v0.9.2)
      if (this.needRestart) {
        this.needRestart = false;
        setImmediate(() => {
          if (this.busy) { this.needRestart = true; return; }
          this.stop();
          this.start({ resume: !!this.meta.sdkSessionId });
        });
      }
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

  // content: string | array of content blocks ({type:'text'|'image'|'media_ref',...})
  // echoContent: 持久化回显用的原始内容(v0.9.1 辅助分析注入后,历史仍回放附件卡片)
  // 返回发送时生成的消息 uuid(v0.9.9:编辑重生成/分支的定位锚点;isReplay 消息不带 uuid)
  send(content, echoContent) {
    if (!this.running && !this.starting) this.start({ resume: !!this.meta.sdkSessionId });
    if (!this.queue) return null;
    const uuid = crypto.randomUUID();
    this.queue.push({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.meta.sdkSessionId || undefined,
    });
    this.busy = true;
    this._persistUserEcho(echoContent !== undefined ? echoContent : content, uuid);
    this._emit({ type: 'ui_status', running: true, busy: true });
    return uuid;
  }

  _persistUserEcho(content, uuid) {
    // persist a lightweight echo of what the user sent; keep image data so
    // history replay can render thumbnails
    const ev = { type: 'ui_user_input', content: slimEcho(content) };
    if (uuid) ev.uuid = uuid;
    store.appendSessionEvent(this.id, ev);
  }

  // interrupt 幂等化(v0.9.30):重复调用复用同一在途承诺,6s 超时兜底;
  // 落地时校验「仍属同一 query」才清 busy——旧 query 的 interrupt 在 stop+新
  // query 启动后才落地时,不得覆盖新回合的 busy。
  // 旧实现无防护——用户点过「停止」后再触发第二次 interrupt(如编辑重生成),
  // 对同一 query 重复 interrupt 的第二次调用永不 resolve,调用方 await 卡死。
  async interrupt() {
    if (!(this.q && this.busy) && !this._interrupting) return;
    if (this._interrupting) return this._interrupting;
    const q = this.q;
    const p = (async () => {
      try {
        await Promise.race([
          q.interrupt().catch((e) => {
            this._emit({ type: 'ui_error', message: 'interrupt 失败:' + e.message });
          }),
          new Promise((r) => setTimeout(r, 6000)),
        ]);
      } catch (e) {
        this._emit({ type: 'ui_error', message: 'interrupt 失败:' + e.message });
      } finally {
        if (this._interrupting === p) {
          this._interrupting = null;
          if (this.q === q) {
            this.busy = false;
            this._emit({ type: 'ui_status', running: this.running, busy: false });
          }
        }
      }
    })();
    this._interrupting = p;
    return p;
  }

  async setPermissionMode(mode) {
    this.meta.permissionMode = mode;
    store.upsertSession({ id: this.id, permissionMode: mode });
    if (this.q && this.running) {
      try { await this.q.setPermissionMode(mode); return true; } catch {}
    }
    return false;
  }

  // keyId(v0.8.2):所选模型归属的 Key,用于额度归账;跨 Key 切换时凭据需新会话才生效
  async setModel(model, keyId) {
    this.meta.model = model;
    if (keyId !== undefined) this.meta.keyId = keyId || null;
    store.upsertSession({ id: this.id, model, keyId: this.meta.keyId });
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

  // 绑定/切换/清除 Gem(v0.9.11):systemPrompt 只在 query 启动时读取,
  // 因此运行中的会话需重启 query 生效——复用 addDir 的 needRestart 模式:
  // 回合进行中不打断(回合结束后自动重启),空闲则立即 stop+start(resume 保上下文)。
  async setGem(gemId) {
    this.meta.gemId = gemId || null;
    store.upsertSession({ id: this.id, gemId: this.meta.gemId });
    if (!this.running) return; // 未运行:下次 send 启动即生效
    if (this.busy) { this.needRestart = true; return; }
    this.stop();
    await this.start({ resume: !!this.meta.sdkSessionId });
  }

  // /add-dir(v0.9.2):SDK 流式输入不会执行该斜杠命令,改为客户端登记——
  // 目录持久化到 meta.extraDirs,重启 query(resume 保上下文)后挂进 additionalDirectories。
  // 回合进行中不打断,标记 needRestart,回合结束后自动重启生效。
  async addDir(dir) {
    const norm = (p) => path.resolve(p).toLowerCase();
    // 与主工作目录相同的目录无需登记(v0.9.7):否则会被挂进 additionalDirectories 造成冗余
    if (norm(dir) === norm(this.meta.cwd || '')) return this.meta.extraDirs || [];
    const dirs = this.meta.extraDirs || [];
    if (!dirs.some((d) => norm(d) === norm(dir))) dirs.push(dir);
    this.meta.extraDirs = dirs;
    store.upsertSession({ id: this.id, extraDirs: dirs });
    if (!this.running) return dirs; // 未运行:下次 send 启动即生效
    if (this.busy) { this.needRestart = true; return dirs; }
    this.stop();
    await this.start({ resume: !!this.meta.sdkSessionId });
    return dirs;
  }

  // 修改并重新生成(v0.9.9):UI 日志截断到目标 echo 并替换为编辑后的内容;
  // SDK 侧 fork 到 echo 之前的锚点(resumeSessionAt),再发出编辑后的消息。
  // 返回 { ok, uuid? , error? }
  async editRegenerate(echoUuid, content, echoContent) {
    // 等「停止」等任何在途中断彻底落地(v0.9.30 幂等化后,重复 await 是安全的——
    // 此前用户先点停止再触发的第二次 interrupt 永不 resolve,流程卡死在这行)
    if (this.busy || this._interrupting) await this.interrupt();
    const loc = store.locateEcho(this.id, echoUuid);
    if (!loc.ok) return loc;
    // 非首条消息但找不到前驱锚点(旧版本历史无 uuid):拒绝,避免静默丢失上文
    if (!loc.prevUuid && !loc.isFirst) {
      return { ok: false, error: '该消息之前的历史来自旧版本,缺少上下文锚点,无法重生成' };
    }
    const slim = slimEcho(echoContent !== undefined ? echoContent : content);
    const kept = [...loc.events.slice(0, loc.index), { ...loc.events[loc.index], content: slim }];
    store.writeSessionEvents(this.id, kept); // 校验通过后才落盘
    this.stop();
    // 旧 _pump 的 for-await 要等 claude 子进程退出才会跑 finally(stop 里的
    // close()/SIGKILL 不是瞬时的)——按「当前 query 已换」轮询,而非 setImmediate
    // 假设一个任务间隙(v0.9.30;旧泵 finally 在 this.q 已换时也不会再覆盖状态)
    const oldQ = this.q;
    for (let i = 0; i < 100 && this.q === oldQ && this.running; i++) {
      await new Promise((r) => setTimeout(r, 30)); // 最长 3s
    }
    const canResume = !!(loc.prevUuid && this.meta.sdkSessionId);
    if (!canResume) { // 首条消息或无 SDK 上下文:全新开始
      this.meta.sdkSessionId = null;
      store.upsertSession({ id: this.id, sdkSessionId: null });
    }
    await this.start({ resume: canResume, fork: canResume, forkAt: loc.prevUuid || null });
    const uuid = this.send(content, echoContent);
    return uuid ? { ok: true, uuid } : { ok: false, error: '发送失败:会话未就绪' };
  }

  stop() {
    if (this.queue) this.queue.end();
    if (this.q && typeof this.q.close === 'function') { try { this.q.close(); } catch {} }
    this.running = false;
    this.busy = false;
    // v0.9.30:解除任何在途的 interrupt(它 await 的是旧 query,resolve 后不得
    // 覆盖新 query 的 busy 状态)
    this._interrupting = null;
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

  create({ cwd, model, permissionMode, title, parentId, worktreePath, forkFrom, forkAt, projectId, effort, standalone, kind, keyId, gemId }) {
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
      kind: kind || null, // 板块标记:'chat'(v0.6.0)/'image'/'video'/'audio'/'model'(v0.9.0);null = code
      keyId: keyId || null, // 创建时活跃的 API key(额度归账,v0.8.0)
      gemId: gemId || null, // 绑定的 Gem 自定义助手(v0.9.11)
    };
    store.upsertSession(meta);
    const s = new Session(this, meta);
    this.sessions.set(id, s);
    s.start({ resume: !!forkFrom, fork: !!forkFrom, forkAt: forkAt || null });
    return meta;
  }

  // 从此消息分支(v0.9.9):把源会话日志中「目标 echo 所在回合结束」之前的事件
  // 复制到新会话(同项目/同设置),SDK 侧 fork 到该回合末尾的锚点,新会话带着完整上文继续。
  branch(srcId, echoUuid) {
    const src = this.get(srcId);
    const m = src && src.meta;
    if (!m) return { ok: false, error: '会话不存在' };
    const loc = store.locateEcho(srcId, echoUuid);
    if (!loc.ok) return loc;
    const { prefix, anchorUuid } = store.branchSlice(loc.events, loc.index);
    const canFork = !!(anchorUuid && m.sdkSessionId);
    const meta = this.create({
      cwd: m.cwd, model: m.model, keyId: m.keyId || null, permissionMode: m.permissionMode,
      effort: m.effort || null,
      title: (m.title || '会话') + ' · 分支',
      projectId: m.projectId,
      forkFrom: canFork ? m.sdkSessionId : null,
      forkAt: canFork ? anchorUuid : null,
      standalone: m.standalone || undefined, kind: m.kind || undefined, // 独立/板块会话的分支同侧栏归属
    });
    store.writeSessionEvents(meta.id, prefix);
    return { ok: true, meta, warning: canFork ? null : '无 SDK 上下文锚点,分支只复制了可见历史' };
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

  onTurnDone(session, ev) {
    // 每次回合结束都发系统通知(Windows 右下角 toast,v0.9.13);
    // 非活跃会话额外打点提醒(此前只对非活跃发通知)
    const name = session.meta.title || session.meta.cwd || '会话';
    const dur = ev && ev.duration_ms != null ? ',用时 ' + (ev.duration_ms / 1000).toFixed(1) + 's' : '';
    const err = !!(ev && ev.is_error);
    this.notify(err ? '任务结束(出错)' : '任务完成', `${name} 的回合已结束${dur}`);
    if (session.id !== this.activeId) {
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

function slimEcho(content) {
  return typeof content === 'string' ? content
    : content.map((b) => b.type === 'image'
      ? { type: 'image_ref', mediaType: b.source && b.source.media_type, data: b.source && b.source.data }
      : b);
}

function safeJson(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return String(obj); }
}

module.exports = { SessionManager, resolveClaudeExe, encodeCwdForProjects, migrateTranscript };
