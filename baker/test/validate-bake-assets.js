'use strict';

// Clean-directory bake-material validation.
//
// This script never validates the hand-edited/committed output tree. It creates
// or empties a directory, generates geometry from code, bakes there, reads the
// JSON/PNG materials back from disk, independently re-bakes, and verifies
// hashes/manifests. Therefore a stale or falsified report cannot pass merely
// because a file exists.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const bakerRoot = path.join(__dirname, '..');
const { parseOBJ } = require('../src/mesh');
const { bake } = require('../src/baker');
const { runBake, verifyBakeManifest } = require('../src/runner');
const { writeOBJ } = require('../src/mesh');
const scenes = require('./make_models');
const rulesDoc = require('../projection-rules.json');

function parseArgs(argv) {
  const args = { size: rulesDoc.sceneChecks.size };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--clean-dir') args.cleanDir = path.resolve(argv[++i]);
    else if (argv[i] === '--size') args.size = Number(argv[++i]);
  }
  return args;
}

function cleanDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function assertPNG(file, size) {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${file} must be a PNG`);
  assert.strictEqual(buf.readUInt32BE(16), size, `${file} width must match bake size`);
  assert.strictEqual(buf.readUInt32BE(20), size, `${file} height must match bake size`);
}

function validateScene(name, workDir, size) {
  const scene = scenes[`${name}Scene`]();
  const outDir = path.join(workDir, 'runs', name);
  const opts = {
    size,
    outerDistance: rulesDoc.sceneChecks.outerDistance,
    innerDistance: rulesDoc.sceneChecks.innerDistance,
    cleanOutput: true,
  };
  runBake(scene.low, scene.high, opts, outDir);

  const manifestCheck = verifyBakeManifest(outDir);
  assert.ok(manifestCheck.valid, `${name} manifest errors: ${manifestCheck.errors.join('; ')}`);

  for (const policy of ['nearest', 'ownership']) {
    const policyDir = path.join(outDir, policy);
    const reportPath = path.join(policyDir, 'report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const expected = bake(scene.low, scene.high, { ...opts, policy });

    assert.deepStrictEqual(report.counts, expected.counts,
      `${name}/${policy} report counts disagree with fresh bake`);
    assert.strictEqual(report.size, size);
    assert.ok(Math.abs(report.normalErrorDegrees.max - expected.normalError.max) < 1e-9);
    assert.strictEqual(report.projectionIdentity.mismatchCount,
      expected.projectionIdentity.mismatchCount);
    assertPNG(path.join(policyDir, 'normal_tangent.png'), size);
    assertPNG(path.join(policyDir, 'status.png'), size);
    assertPNG(path.join(policyDir, 'normal_error.png'), size);
    assertPNG(path.join(policyDir, 'unknown_mask.png'), size);
  }

  const comparison = JSON.parse(fs.readFileSync(path.join(outDir, 'policy_comparison.json'), 'utf8'));
  assert.ok(comparison.texelChoiceDifferences >= 0);
  if (name === 'fold') assert.ok(comparison.texelChoiceDifferences > 0);
  return {
    scene: name,
    files: manifestCheck.manifest.files.length,
    ownershipCounts: JSON.parse(fs.readFileSync(path.join(outDir, 'ownership', 'report.json'), 'utf8')).counts,
  };
}

function checkStaleMaterialCleanup(workDir, size) {
  const scene = scenes.grooveScene();
  const outDir = path.join(workDir, 'stale-check');
  runBake(scene.low, scene.high, { size: 48, outerDistance: 0.4, innerDistance: 0.4, cleanOutput: true }, outDir);
  const stale = path.join(outDir, 'ownership', 'stale-old-texture.png');
  fs.writeFileSync(stale, 'stale');
  assert.ok(fs.existsSync(stale));
  runBake(scene.low, scene.high, { size: 48, outerDistance: 0.4, innerDistance: 0.4 }, outDir);
  assert.ok(!fs.existsSync(stale), 'previous policy directory/materials must be removed on rebake');
  const check = verifyBakeManifest(outDir);
  assert.ok(check.valid, check.errors.join('; '));
  return { removed: path.relative(workDir, stale) };
}

function checkCLIInCleanDirectory(workDir) {
  const modelDir = path.join(workDir, 'cli-models');
  const cliOut = path.join(workDir, 'cli-run');
  fs.mkdirSync(modelDir, { recursive: true });
  const scene = scenes.adjacentScene();
  const lowPath = path.join(modelDir, 'adjacent_low.obj');
  const highPath = path.join(modelDir, 'adjacent_high.obj');
  fs.writeFileSync(lowPath, writeOBJ(scene.low));
  fs.writeFileSync(highPath, writeOBJ(scene.high));
  execFileSync(process.execPath, [
    path.join(bakerRoot, 'src', 'cli.js'),
    '--low', lowPath,
    '--high', highPath,
    '--out', cliOut,
    '--size', '64',
    '--outer-distance', '0.4',
    '--inner-distance', '0.4',
  ], { cwd: workDir, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(cliOut, 'ownership', 'report.json'), 'utf8'));
  assert.ok(report.counts.hit > 0);
  const check = verifyBakeManifest(cliOut);
  assert.ok(check.valid, check.errors.join('; '));
  return { cwd: workDir, out: cliOut, hit: report.counts.hit };
}

function main() {
  const args = parseArgs(process.argv);
  const cleanDir = args.cleanDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bake-assets-'));
  cleanDirectory(cleanDir);
  console.log(`validating bake materials in clean directory: ${cleanDir}`);
  const evidence = { schema: 'geometry-baker/bake-asset-validation/v1', cleanDir, scenes: [] };
  try {
    for (const name of ['groove', 'shell', 'adjacent', 'fold']) {
      const detail = validateScene(name, cleanDir, args.size);
      evidence.scenes.push(detail);
      console.log(`  ok - ${name}: ${detail.files} hashed materials verified`);
    }
    evidence.staleCleanup = checkStaleMaterialCleanup(cleanDir, args.size);
    console.log('  ok - stale rebake materials are removed');
    evidence.cli = checkCLIInCleanDirectory(cleanDir);
    console.log('  ok - CLI bake reproduces verified materials from clean cwd');
    evidence.ok = true;
    fs.writeFileSync(path.join(cleanDir, 'bake-asset-validation.json'), JSON.stringify(evidence, null, 2));
    console.log(`\nbake asset validation passed; evidence: ${path.join(cleanDir, 'bake-asset-validation.json')}`);
  } catch (err) {
    fs.writeFileSync(path.join(cleanDir, 'bake-asset-validation-FAILED.json'),
      JSON.stringify({ ok: false, error: err.stack || err.message }, null, 2));
    console.error(`\nbake asset validation FAILED: ${err.stack || err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { validateScene, verifyBakeManifest };
