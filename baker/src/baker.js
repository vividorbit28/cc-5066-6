(function (root, factory) {
  let api;
  if (typeof module === 'object' && module.exports) {
    api = factory(require('./math'), require('./raycast'), require('./mesh'));
    module.exports = api;
  } else {
    api = factory(root.GeoBakerMath, root.GeoBakerRaycast, root.GeoBakerMesh);
    root.GeoBakerBaker = api;
  }
})(typeof self !== 'undefined' ? self : this, function (mathMod, rayMod, meshMod) {
'use strict';
const { V, M, tangentFrame, worldToTangent } = mathMod;
const { BVH } = rayMod;
const { Mesh } = meshMod;

// Texel status codes used by the diagnostic layers.
const STATUS = {
  HIT: 0,
  MISS: 1,
  CONFLICT: 2,
  OUTSIDE_UV: 3,
  DEGENERATE: 4,
  UNKNOWN_CORRESPONDENCE: 5,
};
const STATUS_NAME = ['hit', 'miss', 'conflict', 'outside_uv', 'degenerate', 'unknown_correspondence'];

// Expand the low mesh along its vertex normals to build an outer cage.
// Two cage surfaces are stored: outer (push-out) and inner (push-in).
function buildCage(low, outerDist, innerDist) {
  const vn = low.vertexNormals();
  const outer = new Mesh(low.name + '_cage_outer');
  const inner = new Mesh(low.name + '_cage_inner');
  outer.positions = low.positions.map((p, i) => V.add(p, V.scale(vn[i], outerDist)));
  inner.positions = low.positions.map((p, i) => V.sub(p, V.scale(vn[i], innerDist)));
  for (const m of [outer, inner]) {
    m.faces = low.faces.map((f) => f.slice());
    m.uvFaces = low.uvFaces.map((f) => f.slice());
    m.uvs = low.uvs.map((t) => t.slice());
    m.facePart = low.facePart.slice();
    m.partNames = low.partNames.slice();
  }
  return { outer, inner };
}

// Rasterize every UV triangle into per-texel face + barycentric coverage.
// The same rule is used at borders and interior texels: point-in-triangle
// in UV space, with the edge function evaluated at the texel center.
function rasterizeUV(low, size) {
  const faceMap = new Int32Array(size * size).fill(-1);
  const baryMap = new Float32Array(size * size * 3);
  for (let fi = 0; fi < low.faces.length; fi++) {
    const uf = low.uvFaces[fi];
    if (!uf) continue;
    const a = low.uvs[uf[0]];
    const b = low.uvs[uf[1]];
    const c = low.uvs[uf[2]];
    const minU = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * size));
    const maxU = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * size));
    const minV = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * size));
    const maxV = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * size));
    const area = edge(a, b, c);
    if (Math.abs(area) < 1e-12) continue;
    for (let py = minV; py <= maxV; py++) {
      for (let px = minU; px <= maxU; px++) {
        // Texel center in normalized UV coordinates.
        const q = [(px + 0.5) / size, (py + 0.5) / size];
        const w0 = edge(b, c, q) / area;
        const w1 = edge(c, a, q) / area;
        const w2 = edge(a, b, q) / area;
        const tol = -1e-4;
        if (w0 < tol || w1 < tol || w2 < tol) continue;
        const idx = py * size + px;
        const bw = [Math.max(w0, 0), Math.max(w1, 0), Math.max(w2, 0)];
        const sum = bw[0] + bw[1] + bw[2] || 1;
        bw[0] /= sum; bw[1] /= sum; bw[2] /= sum;
        if (faceMap[idx] < 0) {
          faceMap[idx] = fi;
          baryMap.set(bw, idx * 3);
        } else {
          // Overlapping UV islands: nearest-to-centroid wins, other flagged.
          faceMap[idx] = pickOverlap(low, faceMap[idx], fi, q);
          baryMap.set(bw, idx * 3);
        }
      }
    }
  }
  return { faceMap, baryMap };
}

function edge(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function pickOverlap(low, fiA, fiB, q) {
  const centroid = (fi) => {
    const uf = low.uvFaces[fi];
    const t = low.uvs;
    return [
      (t[uf[0]][0] + t[uf[1]][0] + t[uf[2]][0]) / 3,
      (t[uf[0]][1] + t[uf[1]][1] + t[uf[2]][1]) / 3,
    ];
  };
  const ca = centroid(fiA);
  const cb = centroid(fiB);
  const da = (ca[0] - q[0]) ** 2 + (ca[1] - q[1]) ** 2;
  const db = (cb[0] - q[0]) ** 2 + (cb[1] - q[1]) ** 2;
  // Identical UV islands can have reversed triangle winding; summation order
  // must not turn a tie into a different owning face.
  return db + 1e-12 < da ? fiB : fiA;
}

// Choose among candidate hits using one of two explicit policies.
//   nearest: smallest ray parameter, no part awareness.
//   ownership: prefer hits on the same part as the low-poly texel, then
//              nearest front-facing hit within that part; this prevents
//              thin-shell back faces and unrelated neighboring parts from
//              stealing texels.
function selectHit(hits, lowPart, policy, allowedParts = null) {
  if (!hits.length) return { hit: null, rejected: [], reason: 'no_hit' };
  const isOwningPart = (h) => {
    if (!allowedParts) return h.part === lowPart;
    return allowedParts.includes(h.partId) || allowedParts.includes(h.part);
  };
  const front = hits.filter((h) => h.frontFacing);
  const back = hits.filter((h) => !h.frontFacing);

  if (policy === 'nearest') {
    // Deliberately part-unaware: the closest triangle wins even when it is
    // a back wall or a neighboring component. The diagnostic layers record
    // why this is often wrong so the two policies can be compared.
    const chosen = hits[0];
    if (!chosen.frontFacing) {
      return { hit: chosen, rejected: hits.slice(1), reason: 'backface_nearest' };
    }
    const closerSamePart = hits.slice(1).some((h) => h.frontFacing && isOwningPart(h));
    if (!isOwningPart(chosen)) {
      return { hit: chosen, rejected: hits.slice(1), reason: 'cross_part_nearest' };
    }
    return { hit: chosen, rejected: hits.slice(1), reason: 'ok' };
  }

  // ownership: never let a different component or a back-facing interior
  // wall steal a texel. Within the owning part/filter set take the nearest
  // projection-facing hit.
  const samePartFront = front.filter(isOwningPart);
  if (samePartFront.length) {
    const chosen = samePartFront[0];
    const rejected = hits.filter((h) => h !== chosen);
    // Any front-facing hit on another part is a cross-component risk even
    // if it lies farther along the ray; record it rather than hiding it.
    const crossedPart = rejected.some((h) => h.frontFacing && !isOwningPart(h));
    const passedBack = rejected.some((h) => !h.frontFacing);
    let reason = 'ok';
    if (crossedPart) reason = 'part_override';
    else if (passedBack) reason = 'backface_rejected';
    return { hit: chosen, rejected, reason };
  }
  // No usable same-part front hit. A front hit on another part is kept but
  // explicitly flagged cross_part rather than silently accepted.
  if (front.length) {
    return { hit: front[0], rejected: hits.filter((h) => h !== front[0]), reason: 'cross_part' };
  }
  return { hit: null, rejected: hits, reason: back.length ? 'backface_only' : 'no_hit' };
}

// Collapse duplicate intersections produced when a ray grazes a shared edge
// (the same surface reported by two adjacent triangles). Hits count as
// distinct only when they differ in part, facing, or ray distance.
function dedupHits(hits) {
  const out = [];
  for (const h of hits) {
    const dup = out.some((o) => o.part === h.part && o.frontFacing === h.frontFacing &&
      Math.abs(o.t - h.t) <= 1e-4 * Math.max(1, h.t));
    if (!dup) out.push(h);
  }
  return out;
}

function bake(low, high, options = {}) {
  const size = options.size ?? 256;
  const outerDist = options.outerDistance ?? 0.5;
  const innerDist = options.innerDistance ?? 0.5;
  const policy = options.policy ?? 'ownership'; // 'nearest' | 'ownership'
  const smoothHigh = options.smoothHighNormals ?? true;
  const partRules = options.partRules ?? null;
  const normalErrorWarnDeg = options.normalErrorWarnDeg ?? 2.0;

  if (!low.uvFaces.length) throw new Error('low mesh has no UVs; cannot bake');
  const bvh = new BVH(high);
  const cage = buildCage(low, outerDist, innerDist);
  const vNormals = low.vertexNormals();
  const highVNormals = smoothHigh ? high.vertexNormals() : null;

  // Per-face tangent frames for the low mesh.
  const frames = low.faces.map((f, fi) => {
    const uf = low.uvFaces[fi];
    return tangentFrame(
      low.positions[f[0]], low.positions[f[1]], low.positions[f[2]],
      low.uvs[uf[0]], low.uvs[uf[1]], low.uvs[uf[2]],
    );
  });

  const { faceMap, baryMap } = rasterizeUV(low, size);
  const layers = createLayers(size);
  let counts = {
    hit: 0, miss: 0, conflict: 0, outside_uv: 0, degenerate: 0,
    unknown_correspondence: 0, normal_error_warn: 0, identity_mismatch: 0,
  };
  const normalErrors = [];
  const identityMismatches = [];
  const records = [];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = py * size + px;
      const fi = faceMap[idx];
      if (fi < 0) {
        layers.status[idx] = STATUS.OUTSIDE_UV;
        counts.outside_uv++;
        continue;
      }
      const b = [baryMap[idx * 3], baryMap[idx * 3 + 1], baryMap[idx * 3 + 2]];
      const f = low.faces[fi];
      const fr = frames[fi];
      const lowPart = low.facePart[fi] ?? 0;
      const lowPartId = low.partIds?.[lowPart] ?? low.partNames?.[lowPart] ?? `part_${lowPart}`;
      const rule = partRules?.[lowPartId] ?? partRules?.[lowPart] ?? null;
      const allowedParts = rule?.accept ?? null;

      // Interpolated low-poly surface point, smooth normal and cage points.
      const p0 = low.positions[f[0]], p1 = low.positions[f[1]], p2 = low.positions[f[2]];
      const lowPoint = [
        b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0],
        b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1],
        b[0] * p0[2] + b[1] * p1[2] + b[2] * p2[2],
      ];
      const n0 = vNormals[f[0]], n1 = vNormals[f[1]], n2 = vNormals[f[2]];
      const lowNormal = V.norm([
        b[0] * n0[0] + b[1] * n1[0] + b[2] * n2[0],
        b[0] * n0[1] + b[1] * n1[1] + b[2] * n2[1],
        b[0] * n0[2] + b[1] * n1[2] + b[2] * n2[2],
      ]);
      // Cage endpoints use the same barycentric interpolation on the
      // pushed-out / pushed-in cage meshes so border texels follow the
      // identical projection rule as interior texels.
      const cageOuterPoint = interpCage(cage.outer, fi, b);
      const cageInnerPoint = interpCage(cage.inner, fi, b);

      if (fr.degenerateUV) {
        layers.status[idx] = STATUS.DEGENERATE;
        counts.degenerate++;
        continue;
      }

      if (rule?.correspondence === 'unknown' || rule?.unknown === true) {
        layers.status[idx] = STATUS.UNKNOWN_CORRESPONDENCE;
        layers.unknownMask[idx] = 255;
        counts.unknown_correspondence++;
        const rec = {
          px, py, face: fi, bary: b, lowPoint, lowNormal, lowPart, lowPartId,
          reason: 'unknown_correspondence', status: 'unknown_correspondence',
          projectionRule: rule, candidates: [], rejected: [], chosen: null,
        };
        records.push(rec);
        continue;
      }

      // Ray runs from the inner cage wall through the surface to the outer
      // wall. Direction is the interpolated low normal; both sides of the
      // shell are searched, so concave grooves are reached without a
      // globally enlarged ray range.
      const origin = cageInnerPoint;
      const dir = V.norm(V.sub(cageOuterPoint, cageInnerPoint));
      const segLen = V.dist(cageOuterPoint, cageInnerPoint);
      const hits = dedupHits(bvh.castAll(origin, dir, 0, segLen));
      const { hit, rejected, reason } = selectHit(hits, lowPart, policy, allowedParts);
      layers.candidateCount[idx] = hits.length;

      // Tangent frame at the texel: face T/B with the interpolated normal.
      const T = V.norm(V.sub(fr.T, V.scale(lowNormal, V.dot(fr.T, lowNormal))));
      const B = V.cross(lowNormal, T);
      const w2t = worldToTangent(T, B, lowNormal);

      const rec = {
        px, py, face: fi, bary: b, lowPoint, lowNormal,
        rayOrigin: origin, rayDir: dir, cageOuter: cageOuterPoint,
        cageInner: cageInnerPoint, lowPart, lowPartId,
        lowPartLabel: low.partNames?.[lowPart] ?? `part${lowPart}`,
        projectionRule: rule, allowedParts, candidates: hits, rejected,
        reason, status: null,
      };

      if (!hit) {
        layers.status[idx] = STATUS.MISS;
        // Encode the ray length as distance even on miss, in a separate
        // diagnostic channel; normal defaults to the low-poly normal.
        writeNormal(layers.normal, idx, lowNormal, w2t);
        layers.distance[idx] = segLen;
        layers.signedDistance[idx] = 0;
        layers.hitMask[idx] = 0;
        counts.miss++;
        rec.status = 'miss';
        records.push(rec);
        continue;
      }

      // High-poly normal: smooth vertex normals transformed consistently,
      // otherwise the geometric face normal.
      let highNormal;
      if (highVNormals) {
        const hf = high.faces[hit.face];
        const hn0 = highVNormals[hf[0]], hn1 = highVNormals[hf[1]], hn2 = highVNormals[hf[2]];
        highNormal = V.norm([
          hit.bary[0] * hn0[0] + hit.bary[1] * hn1[0] + hit.bary[2] * hn2[0],
          hit.bary[0] * hn0[1] + hit.bary[1] * hn1[1] + hit.bary[2] * hn2[1],
          hit.bary[0] * hn0[2] + hit.bary[1] * hn1[2] + hit.bary[2] * hn2[2],
        ]);
      } else {
        highNormal = hit.normal;
      }
      // Signed displacement along the low normal: positive = high surface
      // sits outside the low surface. This is the explicitly supported
      // distance channel (not an unsigned ray depth).
      const signed = V.dot(V.sub(hit.point, lowPoint), lowNormal);
      const rayT = hit.t;

      writeNormal(layers.normal, idx, highNormal, w2t);
      const encodedN = [
        layers.normal[idx * 4] / 127.5 - 1,
        layers.normal[idx * 4 + 1] / 127.5 - 1,
        layers.normal[idx * 4 + 2] / 127.5 - 1,
      ];
      const decodedWorld = V.norm([
        T[0] * encodedN[0] + B[0] * encodedN[1] + lowNormal[0] * encodedN[2],
        T[1] * encodedN[0] + B[1] * encodedN[1] + lowNormal[1] * encodedN[2],
        T[2] * encodedN[0] + B[2] * encodedN[1] + lowNormal[2] * encodedN[2],
      ]);
      const normalErrorDeg = angleDeg(decodedWorld, highNormal);
      layers.normalError[idx] = normalErrorDeg;
      normalErrors.push(normalErrorDeg);
      if (normalErrorDeg > normalErrorWarnDeg) counts.normal_error_warn++;
      layers.normalWorld.set(highNormal, idx * 3);
      layers.distance[idx] = Math.abs(signed);
      layers.signedDistance[idx] = signed;
      layers.rayDistance[idx] = rayT;
      layers.hitMask[idx] = 255;
      layers.hitFace[idx] = hit.face;
      layers.hitPart[idx] = hit.part;
      layers.bary0[idx] = hit.bary[0];
      layers.bary1[idx] = hit.bary[1];
      layers.bary2[idx] = hit.bary[2];
      layers.candidateCount[idx] = hits.length;

      // A texel is a true conflict only when the chosen output is itself
      // suspect: a cross-part or back-facing triangle was accepted, or two
      // front candidates are effectively tied in ray distance. A
      // successfully *rejected* foreign/back candidate (part_override,
      // backface_rejected) is a clean, protected hit and is recorded in the
      // protection layer instead.
      const isConflict = reason === 'cross_part' ||
        reason === 'cross_part_nearest' || reason === 'backface_nearest' ||
        (hits.length > 1 && hits.some((h) => h !== hit && h.frontFacing &&
          Math.abs(h.t - hit.t) <= 1e-3 * Math.max(1, hit.t)));
      const isProtected = reason === 'part_override' || reason === 'backface_rejected';
      const identityValid = !!hit && (!allowedParts
        ? hit.part === lowPart
        : allowedParts.includes(hit.partId) || allowedParts.includes(hit.part));
      if (hit && !identityValid) {
        counts.identity_mismatch++;
        identityMismatches.push({
          px, py, lowPart, lowPartId, hitPart: hit.part, hitPartId: hit.partId,
          face: hit.face, reason,
        });
      }
      rec.identityValid = identityValid;
      rec.projectionIdentity = {
        lowPartId, expectedPartIds: allowedParts ?? [lowPartId],
        hitPartId: hit?.partId ?? null, hitFace: hit?.face ?? -1,
        valid: identityValid,
      };
      rec.normalErrorDeg = normalErrorDeg;
      if (isProtected) layers.protectedMask[idx] = 255;
      if (isConflict) {
        layers.status[idx] = STATUS.CONFLICT;
        counts.conflict++;
        rec.status = 'conflict';
      } else {
        layers.status[idx] = STATUS.HIT;
        counts.hit++;
        rec.status = 'hit';
      }
      rec.chosen = hit;
      records.push(rec);
    }
  }

  const normalError = summarizeAngles(normalErrors);
  return {
    size, policy, outerDistance: outerDist, innerDistance: innerDist,
    cage, layers, counts, records, frames, statusCodes: STATUS,
    normalError,
    projectionIdentity: {
      checked: normalErrors.length,
      mismatchCount: counts.identity_mismatch,
      firstMismatch: identityMismatches[0] ?? null,
      mismatches: identityMismatches,
    },
  };
}

function interpCage(cageMesh, fi, b) {
  const f = cageMesh.faces[fi];
  const p0 = cageMesh.positions[f[0]];
  const p1 = cageMesh.positions[f[1]];
  const p2 = cageMesh.positions[f[2]];
  return [
    b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0],
    b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1],
    b[0] * p0[2] + b[1] * p1[2] + b[2] * p2[2],
  ];
}

function createLayers(size) {
  const n = size * size;
  return {
    normal: new Uint8ClampedArray(n * 4),       // tangent-space normal RGBA
    normalWorld: new Float32Array(n * 3),        // world normal for renderer
    distance: new Float32Array(n),               // |signed displacement|
    signedDistance: new Float32Array(n),         // signed along low normal
    rayDistance: new Float32Array(n),            // raw ray parameter
    hitMask: new Uint8Array(n),
    protectedMask: new Uint8Array(n),
    unknownMask: new Uint8Array(n),
    normalError: new Float32Array(n),
    hitFace: new Int32Array(n).fill(-1),
    hitPart: new Int32Array(n).fill(-1),
    status: new Uint8Array(n),
    candidateCount: new Uint8Array(n),
    bary0: new Float32Array(n),
    bary1: new Float32Array(n),
    bary2: new Float32Array(n),
  };
}

// Encode a tangent-space normal as 0..255 RGBA (OpenGL-style +Z convention).
function writeNormal(buf, idx, nWorld, w2t) {
  const t = M.mulVec(w2t, nWorld);
  const tn = V.norm(t);
  buf[idx * 4 + 0] = (tn[0] * 0.5 + 0.5) * 255;
  buf[idx * 4 + 1] = (tn[1] * 0.5 + 0.5) * 255;
  buf[idx * 4 + 2] = (tn[2] * 0.5 + 0.5) * 255;
  buf[idx * 4 + 3] = 255;
}

function angleDeg(a, b) {
  const d = Math.max(-1, Math.min(1, V.dot(V.norm(a), V.norm(b))));
  return Math.acos(d) * 180 / Math.PI;
}

function summarizeAngles(values) {
  if (!values.length) return { count: 0, mean: 0, max: 0, p95: 0 };
  const sorted = Float64Array.from(values).sort();
  const sum = values.reduce((a, b) => a + b, 0);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: values.length,
    mean: sum / values.length,
    max: sorted[sorted.length - 1],
    p95: sorted[p95Index],
  };
}

return { bake, buildCage, rasterizeUV, selectHit, STATUS, STATUS_NAME };
});
