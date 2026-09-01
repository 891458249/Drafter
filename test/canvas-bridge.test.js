const { test } = require('node:test');
const assert = require('node:assert');
const bridge = require('../src/main/canvasBridge');

test('标准资产桥接:只接受可序列化产物', () => {
  assert.strictEqual(bridge.assetKind({ name: 'image.png' }), 'IMAGE');
  assert.strictEqual(bridge.assetKind({ name: 'clip.mp4' }), 'VIDEO');
  assert.strictEqual(bridge.assetKind({ name: 'voice.wav' }), 'AUDIO');
  assert.strictEqual(bridge.assetKind({ name: 'data.bin' }), 'FILE');
  assert.deepStrictEqual(bridge.referenceFiles({ inputs: { active: 0, tasks: [{ status: 'done', files: [{ path: '/tmp/a.png', name: 'a.png' }, { path: '/tmp/a.mp4', name: 'a.mp4' }] }] } }), [{ path: '/tmp/a.png', name: 'a.png' }]);
});

test('标准资产桥接:拒绝 ComfyUI 私有推理对象', () => {
  assert.strictEqual(bridge.isPrivateComfyType('LATENT'), true);
  assert.strictEqual(bridge.isPrivateComfyType('image'), false);
  assert.throws(() => bridge.assertBridgeType('CONDITIONING'), /不能跨后端传递/);
  assert.doesNotThrow(() => bridge.assertBridgeType('IMAGE'));
});
