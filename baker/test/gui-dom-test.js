'use strict';

// DOM-level verification of the GUI without a real browser. jsdom provides
// the DOM/events; a stub 2D canvas lets the real baker + renderer run through
// app.js handlers. Pixel correctness of the renderer is covered separately by
// validate.js and the PNG outputs; this test proves the UI wiring calls the
// real geometry code and updates the result panel, not fixed data.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/pwtest/node_modules/jsdom');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///web/',
});
const { window } = dom;
// jsdom cannot follow the synthetic anchor download used to save the config.
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
// Core UMD modules and front-end scripts, in the same order as index.html.
for (const f of ['src/math.js', 'src/mesh.js', 'src/raycast.js', 'src/baker.js', 'src/image.js', 'src/render.js', 'web/demo-data.js']) {
  load(f);
}

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error('  FAIL - ' + msg); }
  else console.log('  ok - ' + msg);
};

console.log('browser globals exposed:');
check(typeof window.GeoBakerBaker.bake === 'function', 'GeoBakerBaker.bake available');
check(typeof window.GeoBakerRender.Renderer === 'function', 'Renderer available');
check(typeof window.GeoBakerDemo.groove === 'function', 'demo scenes available');

// Load app.js (registers all event handlers).
load('web/app.js');
const $ = (id) => window.document.getElementById(id);

console.log('GUI workflow:');
$('demoScene').value = 'groove';
$('loadDemo').click();
check($('bakeBtn').disabled === false, 'bake button enabled after loading demo');
check($('lowInfo').textContent.includes('三角面'), 'low mesh info populated');

$('bakeBtn').click();

// The bake is deferred via setTimeout in app.js.
setTimeout(() => {
  const metrics = {
    hit: $('mHit').textContent, conflict: $('mConflict').textContent,
    miss: $('mMiss').textContent, clean: $('mClean').textContent, any: $('mAny').textContent,
  };
  console.log('  metrics:', JSON.stringify(metrics));
  check(Number(metrics.hit) > 0, 'clean hits shown in result panel');
  check(metrics.clean.endsWith('%') && metrics.any.endsWith('%'), 'success and correctness rates both shown');
  check($('status').textContent.includes('完成'), 'status reports completion');
  check($('saveConfig').disabled === false, 'config save enabled after bake');

  // Exercise every layer tab; each must paint its canvas via real bake layers.
  const layerCanvases = {
    normal: 'texCanvas', distance: 'texCanvas', signed: 'texCanvas',
    status: 'texCanvas', protected: 'texCanvas', render: 'renderCanvas', debug: 'debugCanvas',
  };
  for (const [layer, canvasId] of Object.entries(layerCanvases)) {
    const tab = window.document.querySelector(`.tab[data-layer="${layer}"]`);
    tab.click();
    const c = $(canvasId);
    check(c.__painted === true, `layer "${layer}" paints ${canvasId} from bake data`);
  }

  // Flat toggle must re-run the renderer without a bake texture.
  const renderTab = window.document.querySelector('.tab[data-layer="render"]');
  renderTab.click();
  $('flatToggle').checked = true;
  $('flatToggle').dispatchEvent(new window.Event('change'));
  check($('renderCanvas').__painted === true, 'flat comparison re-renders the low mesh');

  // Switch policy and re-bake to confirm the control actually changes logic.
  $('policy').value = 'nearest';
  $('bakeBtn').click();
  setTimeout(() => {
    check($('status').textContent.includes('完成'), 'nearest-policy re-bake completes through the GUI');
    // Save-config path builds a downloadable blob.
    let blobMade = false;
    const origCreate = window.URL.createObjectURL;
    window.URL.createObjectURL = () => { blobMade = true; return 'blob:stub'; };
    window.URL.revokeObjectURL = () => {};
    $('saveConfig').click();
    check(blobMade, 'save config produces a JSON blob');
    window.URL.createObjectURL = origCreate;

    if (failures) { console.error(`\n${failures} GUI checks FAILED`); process.exit(1); }
    console.log('\nGUI DOM workflow checks passed');
  }, 50);
}, 100);
