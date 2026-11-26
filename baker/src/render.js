(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./math') : root.GeoBakerMath);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoBakerRender = api;
})(typeof self !== 'undefined' ? self : this, function (mathMod) {
'use strict';
const { V, M, tangentFrame } = mathMod;

// Tiny z-buffer rasterizer. It renders the LOW-poly mesh and, when a bake
// result is supplied, perturbs its normals from the tangent-space texture —
// this proves the baked detail actually shades the low mesh rather than
// displaying a screenshot of the high mesh.
class Renderer {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.color = new Uint8ClampedArray(width * height * 4);
    this.depth = new Float32Array(width * height).fill(Infinity);
    this.normalView = new Uint8ClampedArray(width * height * 3);
  }

  clear() {
    this.color.fill(0);
    for (let i = 0; i < this.w * this.h; i++) {
      this.color[i * 4 + 3] = 255;
      this.depth[i] = Infinity;
    }
  }

  // Camera looks from `eye` toward `target`; orthographic when orthoScale>0.
  makeView(eye, target, up = [0, 1, 0], fovY = 35, orthoScale = 0) {
    const f = V.norm(V.sub(target, eye));
    const s = V.norm(V.cross(f, up));
    const u = V.cross(s, f);
    const aspect = this.w / this.h;
    const t = Math.tan((fovY * Math.PI / 180) / 2);
    const project = (p) => {
      const rel = V.sub(p, eye);
      const x = V.dot(rel, s);
      const y = V.dot(rel, u);
      const z = V.dot(rel, f);
      let cx, cy, cw;
      if (orthoScale > 0) {
        cx = x / (orthoScale * aspect);
        cy = y / orthoScale;
        cw = 1;
      } else {
        cx = x / (z * t * aspect);
        cy = y / (z * t);
        cw = 1 / z;
      }
      return {
        sx: (cx * 0.5 + 0.5) * this.w,
        sy: (1 - (cy * 0.5 + 0.5)) * this.h,
        z, w: cw, view: [x, y, z],
      };
    };
    return { project, basis: { s, u, f }, eye, orthoScale };
  }

  render(mesh, camera, opts = {}) {
    this.clear();
    const bake = opts.bake ?? null;
    const lightDir = V.norm(opts.light ?? [-0.4, 0.8, 0.6]);
    const baseColor = opts.baseColor ?? [0.78, 0.72, 0.62];
    const vNormals = mesh.vertexNormals();
    const frames = mesh.faces.map((f, fi) => {
      if (!mesh.uvFaces[fi]) return null;
      const uf = mesh.uvFaces[fi];
      return tangentFrame(
        mesh.positions[f[0]], mesh.positions[f[1]], mesh.positions[f[2]],
        mesh.uvs[uf[0]], mesh.uvs[uf[1]], mesh.uvs[uf[2]]);
    });

    for (let fi = 0; fi < mesh.faces.length; fi++) {
      const f = mesh.faces[fi];
      const camVerts = f.map((vi) => camera.project(mesh.positions[vi]));
      // Back-face cull. Screen-space winding flips relative to world winding
      // because the camera looks down its own -Z axis, so a front-facing
      // triangle (normal toward the eye) yields a negative signed area here.
      const area2 = edge2(camVerts[0], camVerts[1], camVerts[2]);
      if (area2 >= 0) continue;
      this.rasterTriangle(fi, f, camVerts, {
        mesh, vNormals, frames, bake, lightDir, baseColor, camera,
      });
    }
    return this.color;
  }

  rasterTriangle(fi, f, cv, ctx) {
    const minX = Math.max(0, Math.floor(Math.min(cv[0].sx, cv[1].sx, cv[2].sx)));
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(cv[0].sx, cv[1].sx, cv[2].sx)));
    const minY = Math.max(0, Math.floor(Math.min(cv[0].sy, cv[1].sy, cv[2].sy)));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(cv[0].sy, cv[1].sy, cv[2].sy)));
    const area = edge2(cv[0], cv[1], cv[2]);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const q = { sx: px + 0.5, sy: py + 0.5 };
        const w0 = edge2(cv[1], cv[2], q) / area;
        const w1 = edge2(cv[2], cv[0], q) / area;
        const w2 = edge2(cv[0], cv[1], q) / area;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        // Perspective-correct interpolation of 1/z and barycentrics.
        const iw = w0 * cv[0].w + w1 * cv[1].w + w2 * cv[2].w;
        const z = 1 / iw;
        const idx = py * this.w + px;
        if (z >= this.depth[idx]) continue;
        this.depth[idx] = z;
        const b = [w0 * cv[0].w * z, w1 * cv[1].w * z, w2 * cv[2].w * z];

        const n0 = ctx.vNormals[f[0]], n1 = ctx.vNormals[f[1]], n2 = ctx.vNormals[f[2]];
        let N = V.norm([
          b[0] * n0[0] + b[1] * n1[0] + b[2] * n2[0],
          b[0] * n0[1] + b[1] * n1[1] + b[2] * n2[1],
          b[0] * n0[2] + b[1] * n1[2] + b[2] * n2[2],
        ]);

        let uv = [0, 0];
        const uf = ctx.mesh.uvFaces[fi];
        if (uf) {
          const t0 = ctx.mesh.uvs[uf[0]], t1 = ctx.mesh.uvs[uf[1]], t2 = ctx.mesh.uvs[uf[2]];
          uv = [
            b[0] * t0[0] + b[1] * t1[0] + b[2] * t2[0],
            b[0] * t0[1] + b[1] * t1[1] + b[2] * t2[1],
          ];
        }

        if (ctx.bake && uf) {
          const tn = sampleNormal(ctx.bake, uv);
          if (tn) {
            const fr = ctx.frames[fi];
            const T = V.norm(V.sub(fr.T, V.scale(N, V.dot(fr.T, N))));
            const B = V.cross(N, T);
            N = V.norm([
              T[0] * tn[0] + B[0] * tn[1] + N[0] * tn[2],
              T[1] * tn[0] + B[1] * tn[1] + N[1] * tn[2],
              T[2] * tn[0] + B[2] * tn[1] + N[2] * tn[2],
            ]);
          }
        }

        const shade = Math.max(0, V.dot(N, ctx.lightDir));
        const viewDir = V.norm(V.sub(ctx.camera.eye, this.interpPos(ctx.mesh, f, b)));
        const half = V.norm(V.add(ctx.lightDir, viewDir));
        const spec = 0.25 * Math.pow(Math.max(0, V.dot(N, half)), 24);
        const ambient = 0.22;
        const lit = ambient + 0.7 * shade + spec;
        const pi = idx * 4;
        this.color[pi] = ctx.baseColor[0] * 255 * lit;
        this.color[pi + 1] = ctx.baseColor[1] * 255 * lit;
        this.color[pi + 2] = ctx.baseColor[2] * 255 * lit;
        this.color[pi + 3] = 255;
        this.normalView[idx * 3] = N[0] * 127 + 128;
        this.normalView[idx * 3 + 1] = N[1] * 127 + 128;
        this.normalView[idx * 3 + 2] = N[2] * 127 + 128;
      }
    }
  }

  interpPos(mesh, f, b) {
    const p0 = mesh.positions[f[0]], p1 = mesh.positions[f[1]], p2 = mesh.positions[f[2]];
    return [
      b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0],
      b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1],
      b[0] * p0[2] + b[1] * p1[2] + b[2] * p2[2],
    ];
  }
}

function edge2(a, b, p) {
  return (b.sx - a.sx) * (p.sy - a.sy) - (b.sy - a.sy) * (p.sx - a.sx);
}

// Bilinear tangent-space normal lookup. A nearest-texel fetch turns the
// high-res facet noise into hard diagonal seams; interpolation across the
// four surrounding texels gives continuous shading on the low mesh. Missed
// texels (no hit mask) contribute nothing.
function sampleNormal(bake, uv) {
  const { size, layers } = bake;
  const fx = uv[0] * size - 0.5;
  const fy = uv[1] * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let acc = [0, 0, 0];
  let weight = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const px = Math.max(0, Math.min(size - 1, x0 + i));
      const py = Math.max(0, Math.min(size - 1, y0 + j));
      const idx = py * size + px;
      if (!layers.hitMask[idx]) continue;
      const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
      const k = idx * 4;
      acc[0] += w * (layers.normal[k] / 255 * 2 - 1);
      acc[1] += w * (layers.normal[k + 1] / 255 * 2 - 1);
      acc[2] += w * (layers.normal[k + 2] / 255 * 2 - 1);
      weight += w;
    }
  }
  if (weight === 0) return null;
  const l = Math.hypot(acc[0], acc[1], acc[2]) || 1;
  return [acc[0] / l, acc[1] / l, acc[2] / l];
}

return { Renderer, sampleNormal };
});
