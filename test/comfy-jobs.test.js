const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ComfyJobs } = require('../src/main/comfy/jobs');

function makeJobs(historyResponses = []) {
  const events = [];
  const client = {
    submit: async () => ({ prompt_id: 'prompt_1' }),
    history: async () => historyResponses.shift() || {},
    interrupt: async () => ({}),
    deleteQueued: async () => ({}),
    view: async () => new Response(Buffer.from('image-data')),
  };
  const connections = { byId: (id) => id === 'server_1' ? { id, baseUrl: 'http://127.0.0.1:8188', authType: 'none' } : null };
  const FakeSocket = class {
    constructor({ clientId }) { this.clientId = clientId; }
    start() {}
    stop() {}
  };
  const jobs = new ComfyJobs({ client, connections, emit: (event) => events.push(event), pollMs: 1, setTimer: () => null, SocketClass: FakeSocket });
  return { jobs, events };
}

test('Comfy jobs submit prompt and reconcile durable history outputs', async () => {
  const { jobs, events } = makeJobs([{ prompt_1: { outputs: { '7': { images: [{ filename: 'out.png' }] } } } }]);
  const result = await jobs.submit({ connectionId: 'server_1', canvasId: 'cv_1', prompt: { '7': { class_type: 'SaveImage', inputs: {} } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(result.ok, true);
  const job = jobs.list('cv_1')[0];
  assert.strictEqual(job.status, 'completed');
  assert.deepStrictEqual(job.outputs['7'].images[0].filename, 'out.png');
  assert.ok(events.some((event) => event.status === 'queued'));
  assert.ok(events.some((event) => event.status === 'completed'));
});

test('Comfy jobs map websocket progress and cancel queued prompts', async () => {
  const { jobs, events } = makeJobs([{}]);
  const result = await jobs.submit({ connectionId: 'server_1', canvasId: 'cv_1', prompt: {} });
  await new Promise((resolve) => setImmediate(resolve));
  jobs.observe('server_1', { type: 'progress', data: { prompt_id: 'prompt_1', node: '5', value: 3, max: 20 } });
  assert.ok(events.some((event) => event.nodeId === '5' && event.progress.value === 3));
  assert.strictEqual(await jobs.cancel(result.job.jobId), true);
  assert.strictEqual(jobs.list()[0].status, 'cancelled');
});
