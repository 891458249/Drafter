// Shared ComfyUI WebSocket transport. It is deliberately independent of Electron and reconnects safely.
'use strict';

function wsUrl(connection, clientId) {
  const base = new URL(connection.baseUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = (base.pathname.replace(/\/+$/, '') || '') + '/ws';
  base.search = `clientId=${encodeURIComponent(clientId)}`;
  return base.toString();
}

class ComfySocket {
  constructor({ connection, clientId, onEvent = () => {}, onState = () => {}, WebSocketImpl = global.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout, reconnectMs = 1500 } = {}) {
    this.connection = connection;
    this.clientId = clientId;
    this.onEvent = onEvent;
    this.onState = onState;
    this.WebSocketImpl = WebSocketImpl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.reconnectMs = reconnectMs;
    this.ws = null;
    this.timer = null;
    this.closed = false;
  }

  start() {
    if (this.closed) return;
    if (typeof this.WebSocketImpl !== 'function') { this.onState({ status: 'unsupported' }); return; }
    this.connect();
  }

  connect() {
    if (this.closed || this.ws) return;
    try {
      this.ws = new this.WebSocketImpl(wsUrl(this.connection, this.clientId));
      this.ws.onopen = () => this.onState({ status: 'connected' });
      this.ws.onmessage = (event) => this.receive(event.data);
      this.ws.onerror = () => this.onState({ status: 'error' });
      this.ws.onclose = () => {
        this.ws = null;
        this.onState({ status: this.closed ? 'closed' : 'disconnected' });
        if (!this.closed) this.timer = this.setTimer(() => { this.timer = null; this.connect(); }, this.reconnectMs);
      };
    } catch (error) {
      this.ws = null;
      this.onState({ status: 'error', error: error.message });
      if (!this.closed) this.timer = this.setTimer(() => { this.timer = null; this.connect(); }, this.reconnectMs);
    }
  }

  receive(data) {
    if (typeof data !== 'string') { this.onEvent({ type: 'preview_binary', data }); return; }
    try {
      const event = JSON.parse(data);
      if (event && typeof event.type === 'string') this.onEvent(event);
    } catch { this.onState({ status: 'protocol_error' }); }
  }

  stop() {
    this.closed = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

module.exports = { ComfySocket, wsUrl };
