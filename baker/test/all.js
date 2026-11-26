'use strict';

// Single entry point for all checks and the full deliverable bake.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
function run(scriptRel, label) {
  console.log(`\n=== ${label} ===`);
  execFileSync(process.execPath, [path.join(__dirname, scriptRel)], {
    cwd: root, stdio: 'inherit',
  });
}

run('make_models.js', 'generating test models');
run('validate.js', 'geometry & policy assertions');
run('gui-dom-test.js', 'graphical UI workflow (jsdom)');

// Full-resolution deliverable bake for every scene.
const { parseOBJ } = require('../src/mesh');
const { runBake } = require('../src/runner');
const scenes = ['groove', 'shell', 'adjacent', 'fold'];
for (const name of scenes) {
  const low = parseOBJ(fs.readFileSync(path.join(root, 'output/models', `${name}_low.obj`), 'utf8'));
  const high = parseOBJ(fs.readFileSync(path.join(root, 'output/models', `${name}_high.obj`), 'utf8'));
  runBake(low, high, { size: 256, outerDistance: 0.4, innerDistance: 0.4 },
    path.join(root, 'output/runs', name));
  console.log(`baked ${name} at 256px`);
}
console.log('\nall checks and deliverable bakes complete');
