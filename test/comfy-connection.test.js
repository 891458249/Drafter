const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-comfy-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const connections = require('../src/main/comfy/connection-store');
const client = require('../src/main/comfy/client');
const schema = require('../src/main/comfy/schema');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => store.setSetting('comfyConnections', []));

test('ComfyUI connection saves redacted credentials and guards unsafe endpoint settings', () => {
  let r = connections.save({ name: 'Remote', baseUrl: 'https://comfy.example.com/api', authType: 'bearer', secret: 'secret-1234' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.connection.secret, undefined);
  assert.strictEqual(r.connection.secretHint, '…1234');
  assert.strictEqual(r.connection.authConfigured, true);
  assert.strictEqual(connections.byId(r.connection.id).secret, 'secret-1234');

  r = connections.save({ name: 'Bad', baseUrl: 'https://user:pass@example.com', authType: 'none' });
  assert.strictEqual(r.ok, false);
  r = connections.save({ name: 'HTTP', baseUrl: 'http://192.168.1.4:8188', authType: 'none' });
  assert.strictEqual(r.ok, false);
  r = connections.save({ name: 'HTTP', baseUrl: 'http://192.168.1.4:8188', authType: 'none', remoteHttpConfirmed: true });
  assert.strictEqual(r.ok, true);
  r = connections.save({ name: 'TLS', baseUrl: 'https://192.168.1.4:8188', authType: 'none', allowInsecureTls: true });
  assert.strictEqual(r.ok, false);
});

test('ComfyUI HTTP client uses normalized endpoint/auth and submits graph', async () => {
  const connection = { baseUrl: 'https://comfy.example.com/', authType: 'bearer', secret: 'token-9999' };
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ prompt_id: 'p_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await client.submit(connection, { '1': { class_type: 'KSampler', inputs: {} } }, 'client_1', { fetchImpl });
  assert.strictEqual(result.prompt_id, 'p_1');
  assert.strictEqual(seen[0].url, 'https://comfy.example.com/prompt');
  assert.strictEqual(seen[0].opts.headers.authorization, 'Bearer token-9999');
  assert.deepStrictEqual(JSON.parse(seen[0].opts.body), { prompt: { '1': { class_type: 'KSampler', inputs: {} } }, client_id: 'client_1' });
});

test('ComfyUI catalog normalizes untrusted object_info text and widget metadata', () => {
  const catalog = schema.normalizeCatalog({
    KSampler: {
      display_name: '<Sampler>', category: 'sampling',
      input: { required: { seed: ['INT', { default: 1, min: 0, max: 99 }], sampler_name: [['euler', 'dpmpp'], { default: 'euler' }] } },
      output: ['LATENT'], output_name: ['latent'],
    },
  });
  assert.strictEqual(catalog.length, 1);
  assert.strictEqual(catalog[0].displayName, 'Sampler');
  const combo = catalog[0].inputs.find((input) => input.name === 'sampler_name');
  assert.deepStrictEqual(combo.widget.values, ['euler', 'dpmpp']);
  assert.strictEqual(catalog[0].outputs[0], 'LATENT');
});
