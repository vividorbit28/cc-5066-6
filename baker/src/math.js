(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoBakerMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// Minimal 3D math. Vectors are plain [x, y, z] arrays; matrices are
// column-major 3x3 arrays of 9 numbers (same layout as OpenGL/three.js).

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  neg: (a) => [-a[0], -a[1], -a[2]],
  lerp: (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  copy: (a) => [a[0], a[1], a[2]],
};

// Column-major 3x3: element (row r, col c) = m[c*3 + r].
const M = {
  identity: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul: (a, b) => {
    const o = new Array(9);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        o[c * 3 + r] =
          a[0 * 3 + r] * b[c * 3 + 0] +
          a[1 * 3 + r] * b[c * 3 + 1] +
          a[2 * 3 + r] * b[c * 3 + 2];
      }
    }
    return o;
  },
  mulVec: (m, v) => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ],
  transpose(m) {
    return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  },
  // Inverse of a general 3x3 (cofactor expansion).
  inverse(m) {
    const a = m[0], b = m[1], c = m[2];
    const d = m[3], e = m[4], f = m[5];
    const g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return M.identity();
    const inv = 1 / det;
    return [
      A * inv,
      (c * h - b * i) * inv,
      (b * f - c * e) * inv,
      B * inv,
      (a * i - c * g) * inv,
      (c * d - a * f) * inv,
      C * inv,
      (b * g - a * h) * inv,
      (a * e - b * d) * inv,
    ];
  },
};

// Build an orthonormal tangent frame (T, B, N) from a triangle's positions
// and UVs. N comes from the geometric cross product; T/B follow the UV
// parameter gradients so the frame is consistent across shared edges.
function tangentFrame(p0, p1, p2, uv0, uv1, uv2) {
  const e1 = V.sub(p1, p0);
  const e2 = V.sub(p2, p0);
  const d1 = [uv1[0] - uv0[0], uv1[1] - uv0[1]];
  const d2 = [uv2[0] - uv0[0], uv2[1] - uv0[1]];
  const det = d1[0] * d2[1] - d2[0] * d1[1];
  let T, B;
  if (Math.abs(det) < 1e-12) {
    // Degenerate UV: fall back to a geometric frame around the face normal.
    const N = V.norm(V.cross(e1, e2));
    const helper = Math.abs(N[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    T = V.norm(V.cross(helper, N));
    B = V.cross(N, T);
    return { T, B, N, degenerateUV: true };
  }
  const r = 1 / det;
  T = V.norm(V.scale(
    V.sub(V.scale(e1, d2[1]), V.scale(e2, d1[1])), r));
  B = V.norm(V.scale(
    V.sub(V.scale(e2, d1[0]), V.scale(e1, d2[0])), r));
  let N = V.norm(V.cross(e1, e2));
  // Re-orthogonalize (Gram-Schmidt) and make B a right-handed partner.
  T = V.norm(V.sub(T, V.scale(N, V.dot(T, N))));
  B = V.cross(N, T);
  if (V.dot(B, V.scale(
    V.sub(V.scale(e2, d1[0]), V.scale(e1, d2[0])), r)) < 0) {
    B = V.neg(B);
  }
  return { T, B, N, degenerateUV: false };
}

// World->tangent matrix for a frame. Stored column-major.
function worldToTangent(T, B, N) {
  // Rows are T, B, N (world basis expressed in world coords).
  return [
    T[0], T[1], T[2],
    B[0], B[1], B[2],
    N[0], N[1], N[2],
  ];
}

return { V, M, tangentFrame, worldToTangent };
});
