(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./math') : root.GeoBakerMath);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoBakerRaycast = api;
})(typeof self !== 'undefined' ? self : this, function (mathMod) {
'use strict';
const { V } = mathMod;

const EPS = 1e-9;

// Bounding-volume hierarchy over triangles plus Möller–Trumbore ray casts.
// Every hit is returned, ordered by distance, so the baker can compare hit
// selection strategies instead of blindly accepting the nearest triangle.
class BVH {
  constructor(mesh, leafSize = 4) {
    this.mesh = mesh;
    this.leafSize = leafSize;
    const n = mesh.faces.length;
    this.tris = new Array(n);
    for (let i = 0; i < n; i++) this.tris[i] = i;
    this.nodes = [];
    this.root = this.build(0, n);
  }

  triBounds(idx) {
    const f = this.mesh.faces[idx];
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const vi of f) {
      const p = this.mesh.positions[vi];
      for (let k = 0; k < 3; k++) {
        if (p[k] < mn[k]) mn[k] = p[k];
        if (p[k] > mx[k]) mx[k] = p[k];
      }
    }
    return { mn, mx };
  }

  unionBounds(a, b) {
    const mn = [0, 0, 0];
    const mx = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(a.mn[k], b.mn[k]);
      mx[k] = Math.max(a.mx[k], b.mx[k]);
    }
    return { mn, mx };
  }

  build(lo, hi) {
    let b = this.triBounds(this.tris[lo]);
    for (let i = lo + 1; i < hi; i++) b = this.unionBounds(b, this.triBounds(this.tris[i]));
    const node = { b, lo, hi, left: -1, right: -1 };
    const id = this.nodes.length;
    this.nodes.push(node);
    const count = hi - lo;
    if (count <= this.leafSize) return id;

    const ext = [b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const slice = this.tris.slice(lo, hi);
    slice.sort((i, j) => {
      const ca = V.scale(V.add(
        V.add(this.mesh.positions[this.mesh.faces[i][0]], this.mesh.positions[this.mesh.faces[i][1]]),
        this.mesh.positions[this.mesh.faces[i][2]]), 1 / 3);
      const cb = V.scale(V.add(
        V.add(this.mesh.positions[this.mesh.faces[j][0]], this.mesh.positions[this.mesh.faces[j][1]]),
        this.mesh.positions[this.mesh.faces[j][2]]), 1 / 3);
      return ca[axis] - cb[axis];
    });
    for (let k = 0; k < slice.length; k++) this.tris[lo + k] = slice[k];
    const mid = lo + (count >> 1);
    node.left = this.build(lo, mid);
    node.right = this.build(mid, hi);
    return id;
  }

  intersectBox(node, orig, dir, invDir, neg) {
    const b = node.b;
    let tmin = 0;
    let tmax = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dir[k]) < EPS) {
        // Parallel ray: it must already lie within this slab.
        if (orig[k] < b.mn[k] - EPS || orig[k] > b.mx[k] + EPS) return false;
        continue;
      }
      let t1 = (b.mn[k] - orig[k]) * invDir[k];
      let t2 = (b.mx[k] - orig[k]) * invDir[k];
      if (neg[k]) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    return tmax >= tmin;
  }

  // All intersections of ray (orig, dir) with t in [tmin,tmax].
  // Each hit: { face, t, point, bary, frontFacing, normal }.
  castAll(orig, dir, tmin = 0, tmax = Infinity) {
    const invDir = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    const neg = [dir[0] < 0, dir[1] < 0, dir[2] < 0];
    const hits = [];
    const stack = [this.root];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (!this.intersectBox(node, orig, dir, invDir, neg)) continue;
      if (node.left < 0) {
        for (let i = node.lo; i < node.hi; i++) {
          const h = this.intersectTri(this.tris[i], orig, dir, tmin, tmax);
          if (h) hits.push(h);
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    // Deterministic order: ray distance, then part, then face index. Ties
    // (shared-edge duplicates) must always resolve to the same triangle so
    // adjacent texels do not flicker between faces.
    hits.sort((a, b) => (a.t - b.t) || (a.part - b.part) || (a.face - b.face));
    return hits;
  }

  intersectTri(faceIdx, orig, dir, tmin, tmax) {
    const f = this.mesh.faces[faceIdx];
    const a = this.mesh.positions[f[0]];
    const b = this.mesh.positions[f[1]];
    const c = this.mesh.positions[f[2]];
    const e1 = V.sub(b, a);
    const e2 = V.sub(c, a);
    const p = V.cross(dir, e2);
    const det = V.dot(e1, p);
    if (Math.abs(det) < EPS) return null;
    const invDet = 1 / det;
    const tvec = V.sub(orig, a);
    const u = V.dot(tvec, p) * invDet;
    if (u < -EPS || u > 1 + EPS) return null;
    const q = V.cross(tvec, e1);
    const v = V.dot(dir, q) * invDet;
    if (v < -EPS || u + v > 1 + EPS) return null;
    const t = V.dot(e2, q) * invDet;
    if (t < tmin - EPS || t > tmax + EPS) return null;
    const w = 1 - u - v;
    const n = V.norm(V.cross(e1, e2));
    const point = V.add(orig, V.scale(dir, t));
    return {
      face: faceIdx,
      t: Math.max(t, 0),
      point,
      bary: [w, u, v],
      normal: n,
      // Front-facing means the geometric normal points back toward the ray
      // origin (the ray strikes the outside of the surface), so n and the
      // ray direction have a positive dot. A negative dot means we hit an
      // interior/back wall, i.e. a penetration. A tolerance keeps grazing
      // groove-wall hits stable under floating-point error.
      frontFacing: V.dot(n, dir) >= -1e-4,
      part: this.mesh.facePart[faceIdx] ?? 0,
      partId: this.mesh.partIds?.[this.mesh.facePart[faceIdx] ?? 0] ??
        this.mesh.partNames?.[this.mesh.facePart[faceIdx] ?? 0] ??
        `part_${this.mesh.facePart[faceIdx] ?? 0}`,
    };
  }
}

return { BVH };
});
