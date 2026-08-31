const { test } = require('node:test');
const assert = require('node:assert');
const format = require('../src/main/comfy/format');

const schema = {
  KSampler: { input: { required: { model: ['MODEL'], seed: ['INT', { default: 1 }], latent_image: ['LATENT'] }, optional: { cfg: ['FLOAT', { default: 7 }] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base.safetensors']] } } },
};

test('Comfy prompt cleaner strips Drafter runtime state but preserves graph links', () => {
  const prompt = {
    '1': { class_type: 'KSampler', inputs: { model: ['2', 0], seed: 42, tasks: [{ status: 'done' }], _v: 'cache' } },
  };
  assert.deepStrictEqual(format.cleanPrompt(prompt), {
    '1': { class_type: 'KSampler', inputs: { model: ['2', 0], seed: 42 } },
  });
});

test('Comfy workflow converts to portable prompt with named links and layout', () => {
  const workflow = {
    nodes: [
      { id: 2, type: 'CheckpointLoaderSimple', pos: [20, 30], widgets_values: ['base.safetensors'], inputs: [] },
      { id: 1, type: 'KSampler', title: 'Sampler', pos: [100, 200], widgets_values: [99], inputs: [{ name: 'model' }, { name: 'seed' }, { name: 'latent_image' }] },
    ],
    links: [[7, 2, 0, 1, 0, 'MODEL']],
  };
  const imported = format.importAny(workflow, schema);
  assert.strictEqual(imported.format, 'workflow');
  assert.deepStrictEqual(imported.prompt['1'].inputs.model, ['2', 0]);
  assert.strictEqual(imported.prompt['1'].inputs.seed, 99);
  assert.strictEqual(imported.layout['1'].title, 'Sampler');
  assert.strictEqual(imported.prompt['2'].inputs.ckpt_name, 'base.safetensors');
});

test('Comfy prompt exports a workflow without any secret or runtime fields', () => {
  const workflow = format.promptToWorkflow({
    '1': { class_type: 'KSampler', inputs: { model: ['2', 0], seed: 99, tasks: [{ private: true }] } },
    '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
  }, schema, { '1': { pos: [1, 2], title: 'Sampler' } });
  assert.strictEqual(workflow.nodes.length, 2);
  assert.deepStrictEqual(workflow.links[0].slice(1, 5), [2, 0, 1, 0]);
  assert.ok(JSON.stringify(workflow).includes('base.safetensors'));
  assert.ok(!JSON.stringify(workflow).includes('private'));
});

test('Comfy format rejects unrelated JSON', () => {
  assert.throws(() => format.importAny({ app: 'drafter-canvas' }), /ComfyUI/);
});
