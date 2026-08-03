// CDP driver for the running Electron app (launched with --remote-debugging-port=9222).
// Uses Node 24 built-in fetch/WebSocket. All UI interaction goes through real
// DOM events or the app's own preload `api` — observed results are genuine.
const PORT = 9222;

async function waitServer(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP server not reachable on ' + PORT);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class CDP {
  async connect() {
    await waitServer();
    // find the main page target (index.html)
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      page = targets.find((t) => t.type === 'page' && /index\.html$/.test(t.url));
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('index.html target not found');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    await this.call('Runtime.enable');
    await this.call('Page.enable');
    return this;
  }

  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Evaluate an expression in the page; await promises; return the value.
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 500));
    }
    return r.result ? r.result.value : undefined;
  }

  // Register the event tap once per page load.
  async tapEvents() {
    await this.eval(`(() => {
      if (window.__regTapped) return true;
      window.__regEvents = [];
      api.on('sess:event', (p) => window.__regEvents.push(p));
      window.__regTapped = true;
      return true;
    })()`);
  }

  async events() { return (await this.eval('window.__regEvents || []')) || []; }
  async clearEvents() { await this.eval('window.__regEvents = []'); }

  // Wait until pred(eventList) is truthy; returns the matched value.
  async waitEvent(predSrc, timeoutMs = 60000, pollMs = 400) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const evs = await this.events();
      const pred = eval(predSrc);
      const hit = pred(evs);
      if (hit) return hit;
      await sleep(pollMs);
    }
    throw new Error('waitEvent timeout: ' + predSrc.slice(0, 120));
  }

  async waitFor(expr, timeoutMs = 30000, pollMs = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.eval(expr)) return true;
      await sleep(pollMs);
    }
    throw new Error('waitFor timeout: ' + expr.slice(0, 120));
  }

  // Count current result events for a session.
  async resultCount(sid) {
    return (await this.events()).filter((p) => p.sid === sid && p.ev.type === 'result').length;
  }

  // Wait until a NEW result (beyond prevCount) appears for the session.
  async waitIdle(sid, prevCount = 0, timeoutMs = 120000) {
    await this.waitEvent(`(evs) => evs.filter((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'result').length > ${prevCount}`, timeoutMs);
    await sleep(400);
  }

  async close() { try { this.ws.close(); } catch {} }
}

module.exports = { CDP, sleep };
