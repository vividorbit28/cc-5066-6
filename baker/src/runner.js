'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { bake, STATUS_NAME } = require('../src/baker');
const { writeOBJ } = require('../src/mesh');
const { V } = require('../src/math');
const {
  encodePNG, grayscaleToRGBA, statusToRGBA, maskToRGBA, errorToRGBA,
} = require('../src/image');
const { Renderer } = require('../src/render');

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function removePreviousOutputs(outDir) {
  if (!fs.existsSync(outDir)) return;
  const manifestPath = path.join(outDir, 'bake-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const file of old.files ?? []) {
        fs.rmSync(path.join(outDir, file.path ?? file), { force: true });
      }
    } catch {
      // A corrupt manifest must not block rebaking; the next manifest replaces it.
    }
  }
  for (const sub of ['nearest', 'ownership', 'debug']) {
    fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  }
  for (const file of ['policy_comparison.json', 'bake-manifest.json']) {
    fs.rmSync(path.join(outDir, file), { force: true });
  }
}

function prepareOutputDir(outDir, cleanOutput = false) {
  if (cleanOutput) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (!cleanOutput) removePreviousOutputs(outDir);
}

// Run both hit-selection policies, export every texture/diagnostic layer,
// render the low mesh with the baked normals, and serialize hit geometry.
function runBake(low, high, opts, outDir) {
  prepareOutputDir(outDir, opts.cleanOutput === true);
  const results = {};
  for (const policy of ['nearest', 'ownership']) {
    const t0 = Date.now();
    const result = bake(low, high, { ...opts, policy });
    result.elapsedMs = Date.now() - t0;
    results[policy] = result;
    exportTextures(result, path.join(outDir, policy));
    exportHitGeometry(low, result, path.join(outDir, policy, 'debug'));
    exportRenderViews(low, result, path.join(outDir, policy, 'render'));
    exportJSONReport(low, high, result, path.join(outDir, policy, 'report.json'));
  }
  exportComparison(results, outDir);
  exportCage(low, results.ownership, outDir);
  writeBakeManifest(outDir, { low, high, opts, results });
  return results;
}

function exportTextures(result, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { size, layers } = result;
  fs.writeFileSync(path.join(dir, 'normal_tangent.png'),
    encodePNG(size, size, Buffer.from(layers.normal)));
  fs.writeFileSync(path.join(dir, 'distance_abs.png'),
    encodePNG(size, size, Buffer.from(grayscaleToRGBA(layers.distance, size))));
  fs.writeFileSync(path.join(dir, 'distance_signed.png'),
    encodePNG(size, size, Buffer.from(
      grayscaleToRGBA(layers.signedDistance, size, {
        diverging: true, max: Math.max(1e-6, ...layers.signedDistance.map(Math.abs)),
      }))));
  fs.writeFileSync(path.join(dir, 'ray_distance.png'),
    encodePNG(size, size, Buffer.from(grayscaleToRGBA(layers.rayDistance, size))));
  fs.writeFileSync(path.join(dir, 'status.png'),
    encodePNG(size, size, Buffer.from(statusToRGBA(layers.status, size))));
  fs.writeFileSync(path.join(dir, 'hit_mask.png'),
    encodePNG(size, size, Buffer.from(maskToRGBA(layers.hitMask, size))));
  fs.writeFileSync(path.join(dir, 'protected_mask.png'),
    encodePNG(size, size, Buffer.from(maskToRGBA(layers.protectedMask, size,
      [90, 160, 255], [20, 20, 28]))));
  fs.writeFileSync(path.join(dir, 'candidate_count.png'),
    encodePNG(size, size, Buffer.from(grayscaleToRGBA(
      Float32Array.from(layers.candidateCount), size, { min: 0 }))));
  fs.writeFileSync(path.join(dir, 'unknown_mask.png'),
    encodePNG(size, size, Buffer.from(maskToRGBA(layers.unknownMask, size,
      [64, 220, 220], [20, 20, 28]))));
  fs.writeFileSync(path.join(dir, 'normal_error.png'),
    encodePNG(size, size, Buffer.from(errorToRGBA(layers.normalError, size, 2))));
}

// OBJ lines for a sampled subset of rays plus point markers for chosen hits
// and rejected candidates, so the projection direction and cage range are
// inspectable in any model viewer.
function exportHitGeometry(low, result, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const chosenPts = [];
  const rejectedPts = [];
  const missEnds = [];
  const step = Math.max(1, Math.floor(result.size / 24));
  let vCount = 0;
  const addV = (p) => { vCount++; lines.push(`v ${p[0]} ${p[1]} ${p[2]}`); return vCount; };
  for (const r of result.records) {
    if (r.px % step || r.py % step) continue;
    const a = addV(r.rayOrigin);
    const b = addV(r.cageOuter);
    lines.push(`l ${a} ${b}`);
    if (r.chosen) chosenPts.push(r.chosen.point);
    for (const h of r.rejected) rejectedPts.push(h.point);
    if (!r.chosen) missEnds.push(r.cageOuter);
  }
  fs.writeFileSync(path.join(dir, 'rays.obj'), lines.join('\n') + '\n');
  writePointsOBJ(path.join(dir, 'hits_chosen.obj'), chosenPts, [0.1, 0.9, 0.3]);
  writePointsOBJ(path.join(dir, 'hits_rejected.obj'), rejectedPts, [0.95, 0.3, 0.2]);
  writePointsOBJ(path.join(dir, 'miss_ends.obj'), missEnds, [0.9, 0.7, 0.1]);
}

function writePointsOBJ(file, pts, color) {
  // Always write the file (even empty) so a stale point cloud from an earlier
  // run can never be mistaken for current diagnostic output.
  const L = [`# ${pts.length} points rgb(${color.join(',')})`];
  for (const p of pts) L.push(`v ${p[0]} ${p[1]} ${p[2]}`);
  const ids = pts.map((_, i) => i + 1);
  for (let i = 0; i < ids.length; i += 1024) {
    L.push('p ' + ids.slice(i, i + 1024).join(' '));
  }
  fs.writeFileSync(file, L.join('\n') + '\n');
}

function exportCage(low, result, outDir) {
  const dir = path.join(outDir, 'debug');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cage_outer.obj'), writeOBJ(result.cage.outer));
  fs.writeFileSync(path.join(dir, 'cage_inner.obj'), writeOBJ(result.cage.inner));
}

function exportRenderViews(low, result, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const b = low.bounds();
  const span = V.sub(b.max, b.min);
  const dist = Math.max(...span) * 2.2;
  const orthoScale = Math.max(...span) * 0.75;
  const c = b.center;
  const views = {
    front: [c[0], c[1], c[2] + dist],
    side: [c[0] + dist, c[1], c[2]],
    top: [c[0], c[1] + dist, c[2] + 0.01],
    // Three-quarter view guarantees a curved surface presents area rather
    // than an edge, regardless of the mesh's dominant axis.
    iso: [c[0] + dist * 0.7, c[1] + dist * 0.7, c[2] + dist * 0.7],
  };
  for (const [name, eye] of Object.entries(views)) {
    // Light roughly toward the camera so front-facing detail stays lit.
    const light = V.norm(V.add(V.scale(V.sub(c, eye), 0.6), [0.3, 0.8, 0.4]));
    const r1 = new Renderer(512, 512);
    r1.render(low, r1.makeView(eye, b.center, undefined, 35, orthoScale), { light });
    fs.writeFileSync(path.join(dir, `${name}_low_flat.png`),
      encodePNG(512, 512, Buffer.from(r1.color)));
    const r2 = new Renderer(512, 512);
    r2.render(low, r2.makeView(eye, b.center, undefined, 35, orthoScale), {
      bake: result, light,
    });
    fs.writeFileSync(path.join(dir, `${name}_baked.png`),
      encodePNG(512, 512, Buffer.from(r2.color)));
  }
}

function exportJSONReport(low, high, result, file) {
  const total = result.size * result.size;
  const covered = total - result.counts.outside_uv - result.counts.degenerate;
  const report = {
    schema: 'geometry-baker/bake-report/v1',
    size: result.size,
    policy: result.policy,
    outerDistance: result.outerDistance,
    innerDistance: result.innerDistance,
    rayDirection: 'inner_to_outer_normalized(cageOuter-cageInner)',
    tangentConvention: 'T/B/N right-handed; OpenGL-style +Z normal map',
    triangles: { low: low.faces.length, high: high.faces.length },
    parts: low.partNames,
    partIds: low.partIds.length ? low.partIds : low.partNames,
    counts: result.counts,
    protectedTexels: result.layers.protectedMask.reduce((n, v) => n + (v ? 1 : 0), 0),
    unknownCorrespondenceTexels: result.counts.unknown_correspondence,
    coveredTexels: covered,
    hitRate: covered ? result.counts.hit / covered : 0,
    // Correct correspondence is reported separately from raw success:
    // conflict/cross-part/backface texels must not count as clean hits.
    cleanRate: covered ? result.counts.hit / covered : 0,
    conflictRate: covered ? result.counts.conflict / covered : 0,
    missRate: covered ? result.counts.miss / covered : 0,
    unknownRate: covered ? result.counts.unknown_correspondence / covered : 0,
    normalErrorDegrees: result.normalError,
    projectionIdentity: {
      checked: result.projectionIdentity.checked,
      mismatchCount: result.projectionIdentity.mismatchCount,
      firstMismatch: result.projectionIdentity.firstMismatch,
    },
    elapsedMs: result.elapsedMs,
    reasonSamples: sampleReasons(result),
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return report;
}

function sampleReasons(result) {
  const tally = {};
  for (const r of result.records) {
    tally[r.reason] = (tally[r.reason] ?? 0) + 1;
  }
  return tally;
}

function exportComparison(results, outDir) {
  const a = results.nearest;
  const b = results.ownership;
  let diff = 0;
  let backfaceSaved = 0;
  let partProtected = 0;
  for (let i = 0; i < a.records.length; i++) {
    const ra = a.records[i];
    const rb = b.records[i];
    const fa = ra.chosen ? ra.chosen.face : -1;
    const fb = rb.chosen ? rb.chosen.face : -1;
    if (fa !== fb) diff++;
    if (ra.chosen && !ra.chosen.frontFacing && rb.chosen && rb.chosen.frontFacing) backfaceSaved++;
    if (ra.reason === 'cross_part' || rb.reason === 'part_override') partProtected++;
  }
  const cmp = {
    nearest: summarize(a),
    ownership: summarize(b),
    texelChoiceDifferences: diff,
    backfacePenetrationsFixed: backfaceSaved,
    partOwnershipProtections: partProtected,
  };
  fs.writeFileSync(path.join(outDir, 'policy_comparison.json'),
    JSON.stringify(cmp, null, 2));
  return cmp;
}

function summarize(r) {
  return {
    counts: r.counts,
    reasons: r.records.reduce((acc, x) => {
      acc[x.reason] = (acc[x.reason] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function listFilesRecursive(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs, rel));
    else if (entry.name !== 'bake-manifest.json') out.push(rel.split(path.sep).join('/'));
  }
  return out.sort();
}

function writeBakeManifest(outDir, context) {
  const files = listFilesRecursive(outDir).map((rel) => {
    const abs = path.join(outDir, rel);
    const buf = fs.readFileSync(abs);
    return { path: rel, bytes: buf.length, sha256: hashBuffer(buf) };
  });
  const manifest = {
    schema: 'geometry-baker/bake-manifest/v1',
    createdAt: new Date().toISOString(),
    options: {
      size: context.opts.size ?? 256,
      outerDistance: context.opts.outerDistance ?? 0.5,
      innerDistance: context.opts.innerDistance ?? 0.5,
      policy: context.opts.policy ?? 'ownership',
    },
    meshes: {
      low: { faces: context.low.faces.length, parts: context.low.partNames.length },
      high: { faces: context.high.faces.length, parts: context.high.partNames.length },
    },
    files,
  };
  fs.writeFileSync(path.join(outDir, 'bake-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function verifyBakeManifest(outDir) {
  const manifestPath = path.join(outDir, 'bake-manifest.json');
  if (!fs.existsSync(manifestPath)) return { valid: false, errors: ['bake-manifest.json is missing'] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = [];
  for (const file of manifest.files ?? []) {
    const abs = path.join(outDir, file.path);
    if (!fs.existsSync(abs)) {
      errors.push(`missing ${file.path}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.length !== file.bytes) errors.push(`size mismatch ${file.path}`);
    if (hashBuffer(buf) !== file.sha256) errors.push(`sha256 mismatch ${file.path}`);
  }
  const expected = new Set((manifest.files ?? []).map((f) => f.path));
  for (const actual of listFilesRecursive(outDir)) {
    if (!expected.has(actual)) errors.push(`untracked_or_stale_file ${actual}`);
  }
  const valid = errors.length === 0;
  return { valid, ok: valid, errors, manifest };
}

module.exports = { runBake, verifyBakeManifest, prepareOutputDir };
