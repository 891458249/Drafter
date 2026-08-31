const { test } = require('node:test');
const assert = require('node:assert');
const { ComfySocket, wsUrl } = require('../src/main/comfy/socket');

test('Comfy websocket converts HTTP endpoint and passes client id', () => {
  assert.strictEqual(wsUrl({ baseUrl: 'https://comfy.example.com/base/' }, 'a b'), 'wss://comfy.example.com/base/ws?clientId=a%20b');
  assert.strictEqual(wsUrl({ baseUrl: 'http://127.0.0.1:8188' }, 'id'), 'ws://127.0.0.1:8188/ws?clientId=id');
});

test('Comfy websocket forwards parsed events and reconnects after close', () => {
  const events = [], states = [], timers = [];
  class FakeWebSocket {
    static list = [];
    constructor(url) { this.url = url; FakeWebSocket.list.push(this); }
    close() { this.onclose(); }
  }
  const socket = new ComfySocket({ connection: { baseUrl: 'http://127.0.0.1:8188' }, clientId: 'x', WebSocketImpl: FakeWebSocket, onEvent: (event) => events.push(event), onState: (state) => states.push(state), setTimer: (fn) => { timers.push(fn); return 1; }, clearTimer: () => {} });
  socket.start();
  const ws = FakeWebSocket.list[0];
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'progress', data: { value: 1 } }) });
  ws.onclose();
  assert.deepStrictEqual(events[0], { type: 'progress', data: { value: 1 } });
  assert.ok(states.some((state) => state.status === 'connected'));
  assert.strictEqual(timers.length, 1);
  timers[0]();
  assert.strictEqual(FakeWebSocket.list.length, 2);
  socket.stop();
});
