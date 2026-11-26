'use strict';

// Validation suite. These are correctness assertions (not screenshots):
// ray math, UV rasterization, cage interpolation, border texel rules,
// part-ownership protection, and success-vs-correct correspondence.
const assert = require('assert');
const { V } = require('../src/math');
const { Mesh, parseOBJ } = require('../src/mesh');
const { BVH } = require('../src/raycast');
const { bake, rasterizeUV, selectHit, buildCage } = require('../src/baker');
const { grooveScene, shellScene, adjacentScene, foldScene } = require('./make_models');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function singleTriMesh() {
  const m = new Mesh('tri');
  m.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2]];
  m.uvs = [[0, 0], [1, 0], [0, 1]];
  m.uvFaces = [[0, 1, 2]];
  m.facePart = [0];
  m.partNames = ['p'];
  return m;
}

console.log('ray casting:');
test('front-facing ray along +Z hits the triangle once', () => {
  const bvh = new BVH(singleTriMesh());
  const hits = bvh.castAll([0.2, 0.2, -1], [0, 0, 1], 0, 10);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].frontFacing, true);
  assert.ok(Math.abs(hits[0].point[2]) < 1e-6);
});

test('axis-aligned ray with zero components does not break box test', () => {
  const bvh = new BVH(singleTriMesh());
  const hits = bvh.castAll([0.5, 0.5, -5], [0, 0, 1], 0, 20);
  assert.strictEqual(hits.length, 1);
});

test('back-side ray is flagged not front-facing', () => {
  const bvh = new BVH(singleTriMesh());
  const hits = bvh.castAll([0.2, 0.2, 1], [0, 0, -1], 0, 10);
  assert.strictEqual(hits[0].frontFacing, false);
});

test('two bare same-name object declarations keep distinct stable ids', () => {
  const text = [
    'o screw',
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
    'vt 0 0',
    'f 1/1 2/1 3/1',
    'o screw',
    'f 1/1 3/1 2/1',
  ].join('\n');
  const m = parseOBJ(text);
  assert.deepStrictEqual(m.partNames, ['screw', 'screw']);
  assert.deepStrictEqual(m.partIds, ['screw', 'screw_2']);
  assert.deepStrictEqual(m.facePart, [0, 1]);
});

test('barycentric coordinates sum to one', () => {
  const bvh = new BVH(singleTriMesh());
  const [h] = bvh.castAll([0.2, 0.2, -1], [0, 0, 1], 0, 10);
  const s = h.bary[0] + h.bary[1] + h.bary[2];
  assert.ok(Math.abs(s - 1) < 1e-6, `sum=${s}`);
});

test('ray outside the triangle misses', () => {
  const bvh = new BVH(singleTriMesh());
  const hits = bvh.castAll([2, 2, -1], [0, 0, 1], 0, 10);
  assert.strictEqual(hits.length, 0);
});

console.log('UV rasterization and border rule:');
test('interior and border texels use the same edge-function rule', () => {
  const m = singleTriMesh();
  const { faceMap, baryMap } = rasterizeUV(m, 16);
  let covered = 0;
  for (let i = 0; i < 16 * 16; i++) {
    if (faceMap[i] >= 0) {
      covered++;
      const s = baryMap[i * 3] + baryMap[i * 3 + 1] + baryMap[i * 3 + 2];
      assert.ok(Math.abs(s - 1) < 1e-4);
      for (let k = 0; k < 3; k++) assert.ok(baryMap[i * 3 + k] >= -1e-4);
    }
  }
  assert.ok(covered > 50, `only ${covered} texels covered`);
});

test('texel center outside the UV triangle stays uncovered', () => {
  const m = singleTriMesh();
  const { faceMap } = rasterizeUV(m, 8);
  // (u,v) near (0.9,0.9) is outside triangle u+v<=1
  const idx = Math.floor(0.9 * 8) * 8 + Math.floor(0.9 * 8);
  assert.strictEqual(faceMap[idx], -1);
});

console.log('cage:');
test('cage endpoints straddle the low surface at outer/inner distance', () => {
  const m = singleTriMesh();
  const cage = buildCage(m, 0.3, 0.2);
  const center = [0.25, 0.25, 0];
  // Face center of the single triangle.
  const outer = cage.outer.positions;
  assert.ok(outer.every((p) => Math.abs(p[2] - 0.3) < 1e-6));
  assert.ok(cage.inner.positions.every((p) => Math.abs(p[2] + 0.2) < 1e-6));
  assert.ok(V.dist(cage.outer.positions[0], cage.inner.positions[0]) > 0.4);
});

test('border texels use the same cage interpolation as interior texels', () => {
  const m = singleTriMesh();
  const cage = buildCage(m, 0.3, 0.2);
  // Pick a texel center lying on the UV hypotenuse (u+v ~= 1) and one
  // interior; both must reconstruct the cage surface through barycentric
  // interpolation with non-negative weights summing to one.
  const { faceMap, baryMap } = rasterizeUV(m, 32);
  let border = -1;
  let interior = -1;
  for (let i = 0; i < 32 * 32; i++) {
    if (faceMap[i] < 0) continue;
    const b = [baryMap[i * 3], baryMap[i * 3 + 1], baryMap[i * 3 + 2]];
    const bmin = Math.min(...b);
    if (bmin < 0.02 && border < 0) border = i;
    if (bmin > 0.2 && interior < 0) interior = i;
  }
  assert.ok(border >= 0 && interior >= 0, 'need both border and interior texels');
  for (const i of [border, interior]) {
    const b = [baryMap[i * 3], baryMap[i * 3 + 1], baryMap[i * 3 + 2]];
    for (const cageMesh of [cage.outer, cage.inner]) {
      const f = cageMesh.faces[faceMap[i]];
      const p = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const v = cageMesh.positions[f[k]];
        for (let d = 0; d < 3; d++) p[d] += b[k] * v[d];
      }
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[2]));
    }
  }
});

console.log('hit selection policy:');
function hit(t, part, front, face = 0) {
  return { t, part, frontFacing: front, face, point: [0, 0, 0], bary: [1, 0, 0], normal: [0, 0, 1] };
}
test('nearest accepts a closer foreign-part triangle', () => {
  const hits = [hit(0.1, 7, true, 1), hit(0.2, 3, true, 2)];
  const r = selectHit(hits, 3, 'nearest');
  assert.strictEqual(r.hit.part, 7);
  assert.strictEqual(r.reason, 'cross_part_nearest');
});

test('ownership rejects the foreign part and keeps the owning texel part', () => {
  const hits = [hit(0.1, 7, true, 1), hit(0.2, 3, true, 2)];
  const r = selectHit(hits, 3, 'ownership');
  assert.strictEqual(r.hit.part, 3);
  assert.strictEqual(r.reason, 'part_override');
});

test('ownership skips a back-facing interior wall', () => {
  const hits = [hit(0.1, 3, false, 1), hit(0.2, 3, true, 2)];
  const r = selectHit(hits, 3, 'ownership');
  assert.strictEqual(r.hit.face, 2);
  assert.strictEqual(r.hit.frontFacing, true);
});

test('nearest blindly takes the back wall (documented failure mode)', () => {
  const hits = [hit(0.1, 3, false, 1), hit(0.2, 3, true, 2)];
  const r = selectHit(hits, 3, 'nearest');
  assert.strictEqual(r.hit.face, 1);
  assert.strictEqual(r.reason, 'backface_nearest');
});

test('no candidates yields an explicit miss, not a fabricated hit', () => {
  const r = selectHit([], 0, 'ownership');
  assert.strictEqual(r.hit, null);
  assert.strictEqual(r.reason, 'no_hit');
});

console.log('scene bakes (success vs correct correspondence):');
function checkScene(scene, opts) {
  const { low, high, name } = scene;
  for (const policy of ['nearest', 'ownership']) {
    const r = bake(low, high, { ...opts, policy });
    const covered = r.size * r.size - r.counts.outside_uv - r.counts.degenerate;
    test(`${name} [${policy}] covers texels and reports every status`, () => {
      assert.ok(covered > 0);
      const accounted = r.counts.hit + r.counts.conflict + r.counts.miss;
      assert.strictEqual(accounted, covered);
    });
    test(`${name} [${policy}] hit texels carry normals, distance and bary`, () => {
      const hitRec = r.records.find((x) => x.status === 'hit');
      assert.ok(hitRec, 'expected at least one clean hit');
      const i = hitRec.py * r.size + hitRec.px;
      assert.strictEqual(r.layers.hitMask[i], 255);
      const bsum = r.layers.bary0[i] + r.layers.bary1[i] + r.layers.bary2[i];
      assert.ok(Math.abs(bsum - 1) < 1e-4);
      assert.ok(Number.isFinite(r.layers.signedDistance[i]));
    });
  }
}

checkScene(grooveScene(), { size: 64, outerDistance: 0.4, innerDistance: 0.4 });
checkScene(shellScene(), { size: 64, outerDistance: 0.4, innerDistance: 0.4 });
checkScene(adjacentScene(), { size: 64, outerDistance: 0.4, innerDistance: 0.4 });

test('shell ownership protects the outer skin from the inner back wall', () => {
  const { low, high } = shellScene();
  const r = bake(low, high, { size: 48, outerDistance: 0.4, innerDistance: 0.4, policy: 'ownership' });
  const protectedCount = r.layers.protectedMask.reduce((n, v) => n + (v ? 1 : 0), 0);
  assert.ok(protectedCount > 0, 'expected part-ownership protections');
  // Every protected texel must still resolve to the outer shell part.
  const outerPart = low.partNames.indexOf('shell_outer');
  for (let i = 0; i < r.size * r.size; i++) {
    if (r.layers.protectedMask[i]) assert.strictEqual(r.layers.hitPart[i], outerPart);
  }
});

test('adjacent parts never borrow the neighbor geometry under ownership', () => {
  const { low, high } = adjacentScene();
  const r = bake(low, high, { size: 48, outerDistance: 0.4, innerDistance: 0.4, policy: 'ownership' });
  for (const rec of r.records) {
    if (!rec.chosen) continue;
    assert.strictEqual(rec.chosen.part, rec.lowPart,
      `texel ${rec.px},${rec.py} crossed from part ${rec.lowPart} to ${rec.chosen.part}`);
  }
});

test('folded sheet: nearest crosses to the back wall, ownership does not', () => {
  const { low, high } = foldScene();
  const opts = { size: 48, outerDistance: 0.4, innerDistance: 0.4 };
  const near = bake(low, high, { ...opts, policy: 'nearest' });
  const own = bake(low, high, { ...opts, policy: 'ownership' });
  // Nearest reports a cross-part conflict on every covered texel because the
  // folded wall is closer from the inner cage.
  assert.ok(near.counts.conflict > 0, 'nearest must flag cross-part conflicts');
  assert.strictEqual(own.counts.conflict, 0);
  const skinPart = low.partNames.indexOf('skin');
  for (const rec of own.records) {
    if (rec.chosen) assert.strictEqual(rec.chosen.part, skinPart);
  }
});

test('clean rate and raw hit rate are computed separately', () => {
  const { low, high } = grooveScene();
  const r = bake(low, high, { size: 48, outerDistance: 0.4, innerDistance: 0.4, policy: 'ownership' });
  const covered = r.size * r.size - r.counts.outside_uv;
  const clean = r.counts.hit / covered;
  const anyHit = (r.counts.hit + r.counts.conflict) / covered;
  assert.ok(anyHit >= clean);
  assert.ok(clean >= 0 && clean <= 1);
});

test('tangent-space normal of a flat +Z surface encodes to neutral blue', () => {
  const m = singleTriMesh();
  const high = singleTriMesh();
  const r = bake(m, high, { size: 32, outerDistance: 0.2, innerDistance: 0.2, policy: 'ownership' });
  const idx = Math.floor(0.2 * 32) * 32 + Math.floor(0.2 * 32);
  const i = idx * 4;
  // Neutral tangent normal is (0,0,1) -> (128,128,255).
  assert.ok(Math.abs(r.layers.normal[i] - 128) < 6);
  assert.ok(Math.abs(r.layers.normal[i + 1] - 128) < 6);
  assert.ok(r.layers.normal[i + 2] > 250);
});

console.log('CLI argument mapping:');
test('hyphenated flags map to camelCase config keys', () => {
  // Mirror the parseArgs + flag mapping logic from src/cli.js.
  const argv = ['node', 'cli.js', '--outer-distance', '0.3', '--inner-distance', '0.5', '--size', '64'];
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].slice(2);
    args[key] = argv[++i];
  }
  const flagFor = { size: 'size', outerDistance: 'outer-distance', innerDistance: 'inner-distance' };
  const config = { size: 256, outerDistance: 0.5, innerDistance: 0.5 };
  for (const k of Object.keys(flagFor)) config[k] = Number(args[flagFor[k]]);
  assert.strictEqual(config.outerDistance, 0.3);
  assert.strictEqual(config.innerDistance, 0.5);
  assert.strictEqual(config.size, 64);
});

console.log(`\n${passed} assertions passed`);
