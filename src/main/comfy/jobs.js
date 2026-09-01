// ComfyUI remote-prompt runner. History polling is authoritative; a future socket adapter can feed observe().
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ComfySocket } = require('./socket');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const FILE_TYPES = new Set(['images', 'gifs', 'audio', 'videos']);

function outputItems(outputs = {}) {
  const out = [];
  for (const [nodeId, nodeOutput] of Object.entries(outputs || {})) {
    for (const [kind, files] of Object.entries(nodeOutput || {})) {
      if (!FILE_TYPES.has(kind) || !Array.isArray(files)) continue;
      for (const file of files) {
        if (file && file.filename) out.push({ nodeId, kind, filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      }
    }
  }
  return out;
}

function normalizeHistory(promptId, entry) {
  if (!entry) return { status: 'running', outputs: {} };
  const status = entry.status && entry.status.status_str;
  if (status === 'error') return { status: 'failed', error: entry.status.messages && JSON.stringify(entry.status.messages).slice(0, 1000), outputs: entry.outputs || {} };
  return { status: 'completed', outputs: entry.outputs || {} };
}

class ComfyJobs {
  constructor({ client, connections, emit = () => {}, pollMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout, SocketClass = ComfySocket, outputDir = null } = {}) {
    this.client = client;
    this.connections = connections;
    this.emit = emit;
    this.pollMs = pollMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.SocketClass = SocketClass;
    this.outputDir = outputDir;
    this.jobs = new Map();
    this.sockets = new Map();
  }

  ensureSocket(connection) {
    if (this.sockets.has(connection.id)) return;
    const clientId = crypto.randomUUID();
    const socket = new this.SocketClass({
      connection,
      clientId,
      onEvent: (event) => this.observe(connection.id, event),
      onState: (state) => this.emit({ backend: 'comfy', connectionId: connection.id, socket: state }),
    });
    this.sockets.set(connection.id, socket);
    socket.start();
  }

  summary(job) {
    return { jobId: job.jobId, promptId: job.promptId, connectionId: job.connectionId, canvasId: job.canvasId, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt || null, error: job.error || null, outputs: job.outputs || {}, files: job.files || [] };
  }

  list(canvasId) {
    return [...this.jobs.values()].filter((job) => !canvasId || job.canvasId === canvasId).map((job) => this.summary(job)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async submit({ connectionId, canvasId, prompt, clientId }) {
    const connection = this.connections.byId(connectionId);
    if (!connection) return { ok: false, error: 'ComfyUI 连接不存在' };
    this.ensureSocket(connection);
    const socket = this.sockets.get(connectionId);
    const result = await this.client.submit(connection, prompt, clientId || (socket && socket.clientId) || crypto.randomUUID());
    if (!result.prompt_id) return { ok: false, error: 'ComfyUI 未返回 prompt_id', nodeErrors: result.node_errors || null };
    const job = { jobId: 'comfy_' + crypto.randomUUID().slice(0, 12), promptId: String(result.prompt_id), connectionId, canvasId, status: 'queued', createdAt: Date.now(), outputs: {}, timer: null };
    this.jobs.set(job.jobId, job);
    this.push(job, { status: 'queued', nodeErrors: result.node_errors || null });
    this.poll(job);
    return { ok: true, job: this.summary(job), nodeErrors: result.node_errors || null };
  }

  wait(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.reject(new Error('ComfyUI 任务不存在'));
    if (TERMINAL.has(job.status)) return Promise.resolve(this.summary(job));
    return new Promise((resolve) => {
      const timer = this.setTimer(() => resolve(this.wait(jobId)), Math.min(this.pollMs, 250));
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  push(job, extra) {
    this.emit({ backend: 'comfy', jobId: job.jobId, canvasId: job.canvasId, promptId: job.promptId, ...extra });
  }

  async poll(job) {
    if (TERMINAL.has(job.status)) return;
    const connection = this.connections.byId(job.connectionId);
    if (!connection) { job.status = 'failed'; job.error = 'ComfyUI 连接已删除'; this.finish(job); return; }
    try {
      const history = await this.client.history(connection, job.promptId);
      const entry = history[job.promptId] || history;
      const update = normalizeHistory(job.promptId, entry && entry.outputs ? entry : null);
      if (update.status === 'completed') { job.status = update.status; job.outputs = update.outputs; await this.finish(job); return; }
      if (update.status === 'failed') { job.status = update.status; job.error = update.error; await this.finish(job); return; }
      if (job.status !== 'running') { job.status = 'running'; this.push(job, { status: 'running' }); }
    } catch (error) {
      job.lastPollError = error.message;
      this.push(job, { status: job.status, warning: error.message });
    }
    job.timer = this.setTimer(() => this.poll(job), this.pollMs);
  }

  async downloadOutputs(job, connection) {
    if (!this.outputDir) return [];
    const dir = path.join(this.outputDir, job.jobId);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    const used = new Set();
    for (const item of outputItems(job.outputs)) {
      const response = await this.client.view(connection, item);
      const raw = String(item.filename).replace(/[\\/:*?"<>|]/g, '_').slice(-160) || 'output';
      let name = raw;
      let n = 1;
      while (used.has(name) || fs.existsSync(path.join(dir, name))) {
        const ext = path.extname(raw); const stem = raw.slice(0, raw.length - ext.length);
        name = `${stem}-${n++}${ext}`;
      }
      used.add(name);
      const data = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(path.join(dir, name), data);
      files.push({ path: path.join(dir, name), name, nodeId: item.nodeId, kind: item.kind });
    }
    return files;
  }

  async finish(job) {
    if (job.timer) { this.clearTimer(job.timer); job.timer = null; }
    const connection = this.connections.byId(job.connectionId);
    if (job.status === 'completed' && connection) {
      try { job.files = await this.downloadOutputs(job, connection); }
      catch (error) { job.error = `ComfyUI 输出下载失败: ${error.message}`; job.status = 'completed_with_errors'; }
    }
    job.finishedAt = Date.now();
    this.push(job, { status: job.status, outputs: job.outputs, files: job.files || [], error: job.error || null });
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL.has(job.status)) return false;
    const connection = this.connections.byId(job.connectionId);
    try {
      if (connection) {
        if (job.status === 'queued') await this.client.deleteQueued(connection, job.promptId);
        else await this.client.interrupt(connection);
      }
    } catch (error) { job.lastCancelError = error.message; }
    job.status = 'cancelled';
    await this.finish(job);
    return true;
  }

  observe(connectionId, event) {
    if (!event || !event.data) return;
    const promptId = event.data.prompt_id && String(event.data.prompt_id);
    const job = [...this.jobs.values()].find((candidate) => candidate.connectionId === connectionId && (!promptId || candidate.promptId === promptId));
    if (!job || TERMINAL.has(job.status)) return;
    if (event.type === 'progress') this.push(job, { status: 'running', nodeId: event.data.node, progress: { value: event.data.value, max: event.data.max } });
    else if (event.type === 'executing') this.push(job, { status: 'running', nodeId: event.data.node || null });
    else if (event.type === 'execution_error') {
      job.status = 'failed'; job.error = event.data.exception_message || 'ComfyUI 节点执行失败';
      this.finish(job).catch(() => {});
    }
  }
}

module.exports = { ComfyJobs, normalizeHistory };
