'use strict';

// DOM-level verification of the GUI without a real browser. jsdom provides
// DOM/events; a stub 2D canvas lets the real baker + renderer run through
// app.js handlers, including actual File selection.
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('/tmp/pwtest/node_modules/jsdom'));
} catch {
  ({ JSDOM } = require('jsdom'));
}

const html = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///web/',
});
const { window } = dom;
window.HTMLAnchorElement.prototype.click = function () {};

function makeImageData(size) {
  return { data: new Uint8ClampedArray(size * size * 4), width: size, height: size };
}
class StubCtx {
  constructor(canvas) { this.canvas = canvas; this.draws = 0; }
  createImageData(w, h) { return makeImageData(Math.max(w, h)); }
  putImageData() { this.draws++; this.canvas.__painted = true; }
  fillRect() { this.draws++; this.canvas.__painted = true; }
  strokeRect() { this.draws++; }
  beginPath() {} moveTo() {} lineTo() {} stroke() { this.draws++; } fillRect2() {}
  setLineDash() {} getImageData() { return makeImageData(this.canvas.width); }
}
window.HTMLCanvasElement.prototype.getContext = function () {
  if (!this.__ctx) this.__ctx = new StubCtx(this);
  return this.__ctx;
};
window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,STUB'; };
if (!window.performance || typeof window.performance.now !== 'function') {
  Object.defineProperty(window, 'performance', {
    value: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 }, configurable: true,
  });
}
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

function load(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  window.eval(code);
}
for (const f of [
  'src/math.js', 'src/mesh.js', 'src/raycast.js', 'src/baker.js', 'src/image.js',
  'src/render.js', 'src/samples.js', 'src/maintenance.js', 'web/demo-data.js',
]) load(f);

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error('  FAIL - ' + msg); }
  else console.log('  ok - ' + msg);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = (id) => window.document.getElementById(id);

function selectFile(inputId, fileRel) {
  const abs = path.resolve(__dirname, '..', fileRel);
  const content = fs.readFileSync(abs, 'utf8');
  const file = new window.File([content], path.basename(abs), { type: 'text/plain' });
  Object.defineProperty($(inputId), 'files', { value: [file], configurable: true });
  $(inputId).dispatchEvent(new window.Event('change', { bubbles: true }));
}

console.log('browser globals exposed:');
check(typeof window.GeoBakerBaker.bake === 'function', 'GeoBakerBaker.bake available');
check(typeof window.GeoBakerRender.Renderer === 'function', 'Renderer available');
check(typeof window.GeoBakerDemo.groove === 'function', 'demo scenes available');
check(typeof window.GeoBakerSamples.maintenanceSample === 'function', 'maintenance sample available in GUI');
check(typeof window.GeoBakerMaintenance.textureReports === 'function', 'maintenance reporting available in GUI');

load('web/app.js');

console.log('GUI workflow:');
$('demoScene').value = 'groove';
$('loadDemo').click();
check($('bakeBtn').disabled === false, 'bake button enabled after loading demo');
check($('lowInfo').textContent.includes('三角面'), 'low mesh info populated');

$('bakeBtn').click();

async function run() {
  await delay(180);
  const metrics = {
    hit: $('mHit').textContent, conflict: $('mConflict').textContent,
    miss: $('mMiss').textContent, clean: $('mClean').textContent, any: $('mAny').textContent,
    normalError: $('mNormalError').textContent, identity: $('mIdentity').textContent,
  };
  console.log('  metrics:', JSON.stringify(metrics));
  check(Number(metrics.hit) > 0, 'clean hits shown in result panel');
  check(metrics.clean.endsWith('%') && metrics.any.endsWith('%'), 'success and correctness rates both shown');
  check(metrics.normalError.includes('°'), 'normal error/projection deviation metric shown');
  check(metrics.identity === '0', 'projection identity mismatch metric is zero for groove');
  check($('status').textContent.includes('完成'), 'status reports completion');
  check($('runState').textContent.includes('完成'), 'running state resolves to visible completion state');
  check($('status').dataset.running === 'false', 'data-running is false after completion');
  check(!$('anomalyPanel').classList.contains('hidden'), 'texture/deviation detail panel is rendered');
  check($('saveConfig').disabled === false, 'config save enabled after bake');

  const layerCanvases = {
    normal: 'texCanvas', distance: 'texCanvas', signed: 'texCanvas',
    status: 'texCanvas', error: 'texCanvas', unknown: 'texCanvas',
    protected: 'texCanvas', render: 'renderCanvas', debug: 'debugCanvas',
  };
  for (const [layer, canvasId] of Object.entries(layerCanvases)) {
    const tab = window.document.querySelector(`.tab[data-layer="${layer}"]`);
    check(!!tab, `tab "${layer}" exists`);
    tab.click();
    const c = $(canvasId);
    check(c.__painted === true, `layer "${layer}" paints ${canvasId} from bake data`);
  }

  const renderTab = window.document.querySelector('.tab[data-layer="render"]');
  renderTab.click();
  $('flatToggle').checked = true;
  $('flatToggle').dispatchEvent(new window.Event('change'));
  check($('renderCanvas').__painted === true, 'flat comparison re-renders the low mesh');

  console.log('actual file input workflow:');
  selectFile('lowFile', 'output/models/groove_low.obj');
  await delay(40);
  selectFile('highFile', 'output/models/groove_high.obj');
  await delay(80);
  check($('lowInfo').textContent.includes('三角面'), 'selected low OBJ is parsed through FileReader');
  check($('highInfo').textContent.includes('三角面'), 'selected high OBJ is parsed through FileReader');
  check($('bakeBtn').disabled === false, 'bake enabled after actually choosing both files');
  $('bakeBtn').click();
  check($('bakeBtn').dataset.running === 'true' || $('status').dataset.running === 'true',
    'running status is visible while file-selected bake starts');
  await delay(220);
  check($('status').textContent.includes('完成'), 'file-selected high/low bake runs through the real GUI');
  check($('texCanvas').__painted === true, 'file-selected bake presents texture details');

  console.log('policy comparison workflow:');
  $('policy').value = 'nearest';
  $('bakeBtn').click();
  await delay(220);
  check($('status').textContent.includes('完成'), 'nearest-policy re-bake completes through the GUI');
  let blobMade = false;
  const origCreate = window.URL.createObjectURL;
  window.URL.createObjectURL = () => { blobMade = true; return 'blob:stub'; };
  window.URL.revokeObjectURL = () => {};
  $('saveConfig').click();
  check(blobMade, 'save config produces a JSON blob');
  window.URL.createObjectURL = origCreate;

  console.log('rogue maintenance sample anomaly workflow:');
  $('demoScene').value = 'rogue';
  $('policy').value = 'ownership';
  $('loadDemo').click();
  $('bakeBtn').click();
  await delay(220);
  const anomalyText = $('anomalyList').textContent;
  check($('status').textContent.includes('完成'), 'rogue sample bake runs to completion');
  check(anomalyText.includes('贴图细节'), 'anomaly panel marks texture-detail problems');
  check(anomalyText.includes('投射偏差'), 'anomaly panel marks projection-deviation problems');
  check(Number($('mMiss').textContent) > 0, 'rogue sample shows missed legal sources in GUI');

  if (failures) {
    console.error(`\n${failures} GUI checks FAILED`);
    process.exit(1);
  }
  console.log('\nGUI DOM workflow checks passed');
}

run().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
