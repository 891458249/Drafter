const { test } = require('node:test');
const assert = require('node:assert');
const { projectPrompt } = require('../src/main/comfy/bridge');

test('Comfy bridge projects API text into external STRING input', async () => {
  const graph = {
    text: { class_type: 'drafter/text', inputs: { text: '一只猫' } },
    comfy: { class_type: 'CLIPTextEncode', inputs: { text: ['text', 0], _comfyConnectionId: 'c1', _comfyInputTypes: { text: 'STRING' } } },
  };
  const prompt = await projectPrompt(graph);
  assert.strictEqual(prompt.comfy.inputs.text, '一只猫');
});

test('Comfy bridge uploads API image and rejects private input types', async () => {
  const graph = {
    image: { class_type: 'drafter/image', inputs: { active: 0, tasks: [{ status: 'done', files: [{ path: '/tmp/cat.png', name: 'cat.png' }] }] } },
    comfy: { class_type: 'VAEEncode', inputs: { pixels: ['image', 0], _comfyConnectionId: 'c1', _comfyInputTypes: { pixels: 'IMAGE' } } },
  };
  const prompt = await projectPrompt(graph, { uploadImage: async (file) => { assert.strictEqual(file.name, 'cat.png'); return 'bridge/cat.png'; } });
  assert.deepStrictEqual(prompt.comfy.inputs.pixels, ['drafter_bridge_0', 0]);
  assert.strictEqual(prompt.drafter_bridge_0.class_type, 'LoadImage');
  graph.comfy.inputs._comfyInputTypes.pixels = 'LATENT';
  await assert.rejects(() => projectPrompt(graph), /私有运行态/);
});
