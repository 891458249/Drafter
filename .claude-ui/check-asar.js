// 验证 dist/win-unpacked/resources/app.asar 的打包内容包含 v0.9.38 改动
const { extractFile } = require('@electron/asar');
const asar = 'D:/ClaudeUI/dist/win-unpacked/resources/app.asar';
const checks = [
  ['main.js', ['resolveBoard', "['media', 'image', 'video', 'audio', 'model']", 's.meta.board', 'aigc:exec', 'canvas:saveUpload', 'assets:list', 'canvas:run', 'canvas:job-status']],
  ['src\\main\\migrations.js', ['mediaBoardStamped', "kind: 'media', board: m.kind", 'repairMediaBoard', '0.12.0']],
  ['src\\main\\aigc.js', ['resolveBoard']],
  ['src\\main\\canvases.js', ['patchTask', 'listAssets', 'saveUpload', 'saveTemplate', 'exportPayload']],
  ['src\\main\\canvasGraph.js', ['fromDrawflow', 'toDrawflow', 'validate', 'nodeSignature']],
  ['src\\main\\canvasJobs.js', ['startJob', 'cancelJob']],
  ['src\\main\\llmtext.js', ['chat/completions', 'complete']],
  ['src\\renderer\\state.js', ['boardOf', 'sectionOfKind', 'mediaShop', 'setBoardClass']],
  ['src\\renderer\\app.js', ['SECTION_MODEL_TYPES', 'sectionOfKind', 'canvas', 'assets']],
  ['src\\renderer\\canvas.js', ['Drawflow', 'aigcExec', 'nodeData', 'runNode', 'runCanvas', 'onJobStatus', 'openSearchMenu']],
  ['src\\renderer\\assets.js', ['assetsList', 'addImageAttachment', 'asset-card']],
  ['src\\renderer\\sessions-ui.js', ['mediaShop', 'shop-filter', 'createFromSidebar']],
  ['src\\renderer\\chat.js', ['setBoardClass', 'AIGC_IMG_EXTS']],
  ['src\\renderer\\input.js', ['boardOf', 'sectionOfKind', 'addImageAttachment']],
  ['src\\index.html', ['data-sec="media"', 'data-sec="canvas"', 'data-sec="assets"', 'shop-filter', 'drawflow']],
  ['src\\styles.css', ['sec-media', 'board-image', 'shop-filter', 'assets-grid', 'drawflow-node']],
  ['node_modules\\drawflow\\dist\\drawflow.min.js', ['Drawflow']],
];
let fail = 0;
for (const [f, needles] of checks) {
  const c = extractFile(asar, f).toString();
  const missing = needles.filter((n) => !c.includes(n));
  if (missing.length) { fail++; console.log('MISSING', f, missing); }
  else console.log('OK     ', f);
}
const ver = extractFile(asar, 'package.json').toString().match(/"version":\s*"([^"]+)"/)[1];
console.log('asar version =', ver);
process.exit(fail ? 1 : 0);
