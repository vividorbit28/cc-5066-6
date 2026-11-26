'use strict';

// Executable projection-rule maintenance checks.
//
// It intentionally creates its evidence in a clean/empty directory (a temp
// directory by default, or --clean-dir <dir>). Nothing here trusts hand-edited
// reports: every identity and normal-error number comes from a fresh bake.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const { parseOBJ, writeOBJ } = require('../src/mesh');
const { bake } = require('../src/baker');
const { encodePNG } = require('../src/image');
const { maintenanceSample } = require('../src/samples');
const { firstSourceChange, textureReports } = require('../src/maintenance');
const { writeSampleSet } = require('./make_maintenance_sample');
const rulesDoc = require('../projection-rules.json');
const legacyScenes = require('./make_models');

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--clean-dir') args.cleanDir = path.resolve(argv[++i]);
    else if (argv[i] === '--report') args.report = path.resolve(argv[++i]);
  }
  return args;
}

function cleanDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function checkDocs() {
  const usage = fs.readFileSync(path.join(root, 'doc', 'usage.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const allDocs = `${usage}\n${readme}`;
  const required = [
    'web/index.html',
    '命令行',
    '仅辅助',
    'inner_to_outer',
    'unknown_correspondence',
    '投影身份',
    '法线误差',
    '净目录',
    '256',
    '0.5',
    '外部工具',
  ];
  for (const token of required) {
    assert.ok(allDocs.includes(token), `documentation must mention "${token}"`);
  }
  assert.ok(usage.includes('npm run validate:assets'), 'usage must list clean asset validation');
  assert.ok(usage.includes('npm run validate:maintenance'), 'usage must list maintenance validation');
  assert.ok(/默认[^\n]*256/.test(allDocs), 'docs must identify size default 256');
  assert.ok(allDocs.includes('0.5'), 'docs must identify cage distance default 0.5');
  assert.ok(allDocs.includes(rulesDoc.maintenanceSample.expectedSplitFirstChange.px.toString()));
  assert.ok(allDocs.includes(rulesDoc.maintenanceSample.expectedSplitFirstChange.py.toString()));
}

function checkPackagedOBJIdentities(sampleDir) {
  const text = fs.readFileSync(path.join(sampleDir, 'assembly_low.obj'), 'utf8');
  const low = parseOBJ(text, 'assembly_low');
  for (const id of rulesDoc.maintenanceSample.requiredStablePartIds) {
    assert.ok(low.partIds.includes(id), `missing stable part id ${id}`);
  }
  const screwLabels = low.partIds
    .map((id, i) => ({ id, label: low.partNames[i] }))
    .filter((p) => p.id.startsWith('screw_'));
  assert.strictEqual(screwLabels.length, 2);
  assert.ok(screwLabels.every((p) => p.label === rulesDoc.maintenanceSample.duplicateLabel),
    'both screws must retain the same display label');
  const shroud = low.partIds.filter((id) => id.startsWith('shroud_'));
  assert.deepStrictEqual(shroud, rulesDoc.maintenanceSample.legacySplitPartIds);
  return { screwLabels, shroud };
}

function bakeVariant(variant) {
  const sample = maintenanceSample(variant);
  const opts = rulesDoc.maintenanceSample;
  const result = bake(sample.low, sample.high, {
    size: opts.size,
    outerDistance: opts.outerDistance,
    innerDistance: opts.innerDistance,
    policy: opts.policy,
    partRules: sample.partRules,
    normalErrorWarnDeg: opts.normalErrorMaxDegrees,
  });
  return { sample, result };
}

function writeTexturePNGs(dir, result, textures) {
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {};
  for (const texture of textures) {
    const file = path.join(dir, `${texture.id}_normal.png`);
    const png = encodePNG(result.size, result.size, Buffer.from(result.layers.normal));
    fs.writeFileSync(file, png);
    hashes[texture.id] = { file: path.basename(file), sha256: hashBuffer(png) };
  }
  return hashes;
}

function publishConfirmedVersions(workDir, baseline, rogue, rogueTextures) {
  const confirmedDir = path.join(workDir, 'confirmed');
  const publishDir = path.join(workDir, 'publish');
  const withheldDir = path.join(workDir, 'withheld');
  fs.mkdirSync(confirmedDir, { recursive: true });
  cleanDirectory(publishDir);
  fs.mkdirSync(withheldDir, { recursive: true });

  const baselineTextures = textureReports(baseline.result, {
    normalErrorMaxDeg: rulesDoc.maintenanceSample.normalErrorMaxDegrees,
  });
  assert.ok(baselineTextures.every((t) => t.publishable),
    `baseline textures must be publishable: ${JSON.stringify(baselineTextures)}`);
  const confirmedHashes = writeTexturePNGs(confirmedDir, baseline.result, baselineTextures);
  fs.writeFileSync(path.join(confirmedDir, 'confirmed-manifest.json'),
    JSON.stringify({ schema: 'confirmed-textures/v1', textures: confirmedHashes }, null, 2));

  // Deliberately stale published material must not survive the release sync.
  const staleCover = path.join(publishDir, `${rulesDoc.maintenanceSample.rogue.withheldTexture}_normal.png`);
  fs.writeFileSync(staleCover, 'stale-not-a-real-png');

  const rogueById = new Map(rogueTextures.map((t) => [t.id, t]));
  const release = [];
  for (const texture of baselineTextures) {
    const rogueReport = rogueById.get(texture.id);
    const invalidNow = rogueReport && !rogueReport.publishable;
    const target = path.join(publishDir, `${texture.id}_normal.png`);
    if (invalidNow) {
      fs.rmSync(target, { force: true });
      const info = {
        texture: texture.id,
        published: false,
        reason: 'no_legal_projection_source',
        rogueReport,
        confirmedArtifactRetained: path.relative(workDir,
          path.join(confirmedDir, `${texture.id}_normal.png`)),
      };
      fs.writeFileSync(path.join(withheldDir, `${texture.id}.json`), JSON.stringify(info, null, 2));
      release.push({ id: texture.id, published: false, withheld: true });
    } else {
      fs.copyFileSync(path.join(confirmedDir, `${texture.id}_normal.png`), target);
      const buf = fs.readFileSync(target);
      assert.strictEqual(hashBuffer(buf), confirmedHashes[texture.id].sha256);
      release.push({ id: texture.id, published: true, sha256: confirmedHashes[texture.id].sha256 });
    }
  }
  fs.writeFileSync(path.join(publishDir, 'release-manifest.json'),
    JSON.stringify({ schema: 'release-manifest/v1', release }, null, 2));

  const withheldId = rulesDoc.maintenanceSample.rogue.withheldTexture;
  assert.ok(!fs.existsSync(path.join(publishDir, `${withheldId}_normal.png`)),
    'invalid texture must not be published');
  assert.ok(fs.existsSync(path.join(withheldDir, `${withheldId}.json`)));
  for (const id of ['screw_a', 'screw_b', 'shroud', 'bracket']) {
    assert.ok(fs.existsSync(path.join(publishDir, `${id}_normal.png`)),
      `confirmed ${id} must remain published`);
  }
  return { release, confirmedHashes };
}

function checkRogueRay(rogue) {
  const cfg = rulesDoc.maintenanceSample.rogue;
  const records = rogue.result.records.filter((r) => r.lowPartId === cfg.lowPartId);
  assert.ok(records.length > 0, 'rogue part must cover texels');
  assert.ok(records.every((r) => r.status === 'miss'), 'rogue texels must miss legal source');
  assert.ok(records.every((r) => r.reason === cfg.requiredReason),
    `rogue rays must be ${cfg.requiredReason}, got ${[...new Set(records.map((r) => r.reason))]}`);
  const withNeighborBackface = records.filter((r) => r.candidates.some((h) =>
    h.partId === cfg.forbiddenSourcePartId && h.frontFacing === false));
  assert.ok(withNeighborBackface.length > 0,
    'sample must contain execution evidence of the neighboring back-face ray');
  assert.ok(records.every((r) => !r.candidates.some((h) => h.partId !== cfg.forbiddenSourcePartId)),
    'rogue rays may only meet the designed neighboring part');
  return {
    texels: records.length,
    backfaceOnlyTexels: withNeighborBackface.length,
    example: (({ px, py, reason, candidates }) => ({
      px, py, reason,
      candidates: candidates.map((h) => ({ partId: h.partId, frontFacing: h.frontFacing, t: h.t })),
    }))(withNeighborBackface[0]),
  };
}

function checkUnknownRegion() {
  const sample = maintenanceSample('baseline');
  sample.partRules.bracket = { correspondence: 'unknown', texture: 'bracket' };
  const r = bake(sample.low, sample.high, {
    size: 64, outerDistance: 0.2, innerDistance: 0.2, partRules: sample.partRules,
  });
  assert.ok(r.counts.unknown_correspondence > 0, 'unknown correspondence region must be marked');
  assert.ok(r.layers.unknownMask.some((v) => v === 255));
  const reports = textureReports(r);
  const bracket = reports.find((t) => t.id === 'bracket');
  assert.ok(bracket.problems.some((p) => p.startsWith('unknown_correspondence_texels')));
  assert.strictEqual(bracket.publishable, false);
  return { count: r.counts.unknown_correspondence, bracket };
}

function checkLegacyScenes() {
  const cfg = rulesDoc.sceneChecks;
  const out = [];
  for (const name of cfg.scenes) {
    const scene = legacyScenes[`${name}Scene`]();
    const ownership = bake(scene.low, scene.high, {
      size: cfg.size, outerDistance: cfg.outerDistance, innerDistance: cfg.innerDistance,
      policy: 'ownership',
    });
    const nearest = name === 'fold' || name === 'shell' || name === 'adjacent'
      ? bake(scene.low, scene.high, {
        size: cfg.size, outerDistance: cfg.outerDistance, innerDistance: cfg.innerDistance,
        policy: 'nearest',
      })
      : null;
    assert.strictEqual(ownership.projectionIdentity.mismatchCount, 0,
      `${name} ownership must have no projection identity mismatches`);
    assert.ok(ownership.normalError.max <= cfg.normalErrorMaxDegrees,
      `${name} normal error ${ownership.normalError.max} > ${cfg.normalErrorMaxDegrees}`);
    if (name === 'shell') {
      assert.ok(ownership.layers.protectedMask.some((v) => v), 'thin shell must trigger protection');
    }
    if (name === 'adjacent') {
      for (const rec of ownership.records) {
        if (rec.chosen) assert.strictEqual(rec.chosen.part, rec.lowPart);
      }
    }
    if (name === 'fold') {
      assert.ok(nearest.counts.conflict > 0, 'fold nearest must expose wrong cross-part source');
      assert.strictEqual(ownership.counts.conflict, 0);
    }
    out.push({
      scene: name,
      counts: ownership.counts,
      normalErrorDegrees: ownership.normalError,
      identity: ownership.projectionIdentity.mismatchCount,
      nearestConflicts: nearest?.counts.conflict ?? null,
    });
  }
  return out;
}

function writeCageEvidence(workDir, baseline) {
  const dir = path.join(workDir, 'cage-and-filters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cage_outer.obj'), writeOBJ(baseline.result.cage.outer));
  fs.writeFileSync(path.join(dir, 'cage_inner.obj'), writeOBJ(baseline.result.cage.inner));
  fs.writeFileSync(path.join(dir, 'part-filters.json'), JSON.stringify(baseline.sample.partRules, null, 2));
  return dir;
}

function runMaintenanceValidation(cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-maintenance-'))) {
  cleanDirectory(cleanDir);
  const sampleDir = path.join(cleanDir, 'sample');
  writeSampleSet(sampleDir);
  const evidence = {
    schema: 'geometry-baker/maintenance-validation/v1',
    cleanDir,
    rules: path.relative(root, path.join(root, 'projection-rules.json')),
    checks: [],
  };
  const record = (name, fn) => {
    try {
      const detail = fn();
      evidence.checks.push({ name, ok: true, detail: detail ?? null });
      console.log(`  ok - ${name}`);
      return detail;
    } catch (err) {
      evidence.checks.push({ name, ok: false, error: err.message });
      console.error(`  FAIL - ${name}: ${err.message}`);
      throw err;
    }
  };

  console.log('maintenance conventions and docs:');
  record('documentation parameters and entry points agree', checkDocs);
  const identities = record('packaged OBJ keeps duplicate labels and stable ids',
    () => checkPackagedOBJIdentities(sampleDir));
  evidence.identities = identities;

  console.log('rename/split projection identities:');
  const baseline = record('baseline maintenance bake', () => bakeVariant('baseline'));
  const renamed = record('renamed-label maintenance bake', () => bakeVariant('renamed'));
  const split = record('real split maintenance bake', () => bakeVariant('split'));
  const rogue = record('rogue neighbor-backface bake', () => bakeVariant('rogue'));

  const renameChange = firstSourceChange(baseline.result, renamed.result);
  record('label-only rename changes no projection source', () => {
    assert.strictEqual(renameChange, null);
    return { firstChangedTexel: null };
  });
  const splitChange = firstSourceChange(baseline.result, split.result);
  record('real split relocates first reclaimed source texel', () => {
    const expected = rulesDoc.maintenanceSample.expectedSplitFirstChange;
    assert.ok(splitChange, 'split must change at least one source');
    assert.strictEqual(splitChange.px, expected.px);
    assert.strictEqual(splitChange.py, expected.py);
    assert.strictEqual(splitChange.index, expected.index);
    assert.strictEqual(splitChange.after.split(':')[0], expected.afterPartId);
    return splitChange;
  });
  evidence.sourceChanges = { rename: renameChange, split: splitChange };

  record('cage and part filters are executable artifacts', () => writeCageEvidence(cleanDir, baseline));

  console.log('rogue source and publication:');
  const rogueEvidence = record('rogue ray only hits rejected neighbor backface',
    () => checkRogueRay(rogue));
  evidence.rogueRay = rogueEvidence;
  const baselineTextures = textureReports(baseline.result, {
    normalErrorMaxDeg: rulesDoc.maintenanceSample.normalErrorMaxDegrees,
  });
  const rogueTextures = textureReports(rogue.result, {
    normalErrorMaxDeg: rulesDoc.maintenanceSample.normalErrorMaxDegrees,
  });
  const publication = record('invalid texture withheld; confirmed peers published',
    () => publishConfirmedVersions(cleanDir, baseline, rogue, rogueTextures));
  evidence.publication = publication.release;

  record('unknown correspondence regions are marked and withheld', checkUnknownRegion);

  console.log('legacy thin-shell and adjacent-surface checks:');
  evidence.legacyScenes = record('projection identity and normal error evidence', checkLegacyScenes);

  evidence.ok = true;
  const reportPath = path.join(cleanDir, 'maintenance-validation.json');
  fs.writeFileSync(reportPath, JSON.stringify(evidence, jsonSetReplacer, 2));
  return { ok: true, cleanDir, reportPath, evidence };
}

function jsonSetReplacer(key, value) {
  return value instanceof Set ? Array.from(value) : value;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    const out = runMaintenanceValidation(args.cleanDir);
    if (args.report) {
      fs.mkdirSync(path.dirname(args.report), { recursive: true });
      fs.copyFileSync(out.reportPath, args.report);
    }
    console.log(`\nmaintenance validation passed; evidence: ${out.reportPath}`);
  } catch (err) {
    console.error(`\nmaintenance validation FAILED: ${err.stack || err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { runMaintenanceValidation, cleanDirectory };
