const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ComfyJobs } = require('../src/main/comfy/jobs');

test('Comfy job downloads history outputs into the owned asset directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-comfy-output-'));
  const files = [];
  const client = {
    submit: async () => ({ prompt_id: 'prompt_download' }),
    history: async () => ({ prompt_download: { outputs: { '12': { images: [{ filename: 'a.png', subfolder: 'safe', type: 'output' }] } } } }),
    view: async (_connection, item) => { files.push(item); return new Response(Buffer.from('png')); },
    interrupt: async () => ({}), deleteQueued: async () => ({}),
  };
  const connection = { id: 'server', baseUrl: 'http://127.0.0.1:8188', authType: 'none' };
  const FakeSocket = class { constructor({ clientId }) { this.clientId = clientId; } start() {} };
  const jobs = new ComfyJobs({ client, connections: { byId: () => connection }, outputDir: dir, setTimer: () => null, SocketClass: FakeSocket });
  try {
    const result = await jobs.submit({ connectionId: 'server', canvasId: 'cv_1', prompt: {} });
    await new Promise((resolve) => setImmediate(resolve));
    const job = jobs.list()[0];
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.files.length, 1);
    assert.strictEqual(fs.readFileSync(job.files[0].path, 'utf8'), 'png');
    assert.deepStrictEqual(files[0], { nodeId: '12', kind: 'images', filename: 'a.png', subfolder: 'safe', type: 'output' });
    assert.ok(job.files[0].path.startsWith(path.join(dir, result.job.jobId)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
