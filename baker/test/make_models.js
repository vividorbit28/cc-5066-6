'use strict';

const fs = require('fs');
const path = require('path');
const { Mesh, writeOBJ } = require('../src/mesh');
const { V } = require('../src/math');

// Helpers to append grid surfaces with explicit UVs and part labels.
class Builder {
  constructor() {
    this.mesh = new Mesh();
    this.currentPart = 0;
  }
  part(name) {
    let id = this.mesh.partNames.indexOf(name);
    if (id < 0) {
      id = this.mesh.partNames.length;
      this.mesh.partNames.push(name);
    }
    this.currentPart = id;
    return this;
  }
  addVertex(p, uv) {
    this.mesh.positions.push(p);
    this.mesh.uvs.push(uv);
    return this.mesh.positions.length - 1;
  }
  tri(a, b, c, ua, ub, uc) {
    const base = this.mesh.positions.length;
    this.addVertex(a, ua);
    this.addVertex(b, ub);
    this.addVertex(c, uc);
    this.mesh.faces.push([base, base + 1, base + 2]);
    this.mesh.uvFaces.push([base, base + 1, base + 2]);
    this.mesh.facePart.push(this.currentPart ?? 0);
  }
}

// A heightfield surface z = h(x,y) over [0,1]^2, gridded, with planar UVs.
// jitter>0 displaces interior vertices in XY so a high-poly grid does not
// line up edge-for-edge with the low-poly texel lattice (which would make
// every ray skim a mesh edge and hide real intersection behavior).
function heightfield(builder, part, nx, ny, h, uvBox = [0, 0, 1, 1], jitter = 0) {
  builder.part(part);
  const base = builder.mesh.positions.length;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      let x = i / nx;
      let y = j / ny;
      if (jitter > 0 && i > 0 && i < nx && j > 0 && j < ny) {
        // Deterministic, non-aligned hash offset, bounded to half a cell.
        const hs = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
        const ht = Math.sin(i * 269.5 + j * 183.3) * 19341.173;
        x += ((hs - Math.floor(hs)) - 0.5) * jitter / nx;
        y += ((ht - Math.floor(ht)) - 0.5) * jitter / ny;
      }
      builder.addVertex([x, y, h(i / nx, j / ny)], [
        uvBox[0] + (i / nx) * (uvBox[2] - uvBox[0]),
        uvBox[1] + (j / ny) * (uvBox[3] - uvBox[1]),
      ]);
    }
  }
  const idx = (i, j) => base + j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      // cross(e1,e2) points +Z, i.e. toward the outer cage / ray target,
      // so a +Z travelling ray strikes the front face.
      builder.mesh.faces.push([a, b, c], [a, c, d]);
      builder.mesh.uvFaces.push([a, b, c], [a, c, d]);
      builder.mesh.facePart.push(builder.currentPart, builder.currentPart);
    }
  }
}

// --- Scene A: deep groove slab -------------------------------------------------
// Low model: flat slab. High model: same slab with a narrow deep V-groove
// carved through it. The groove walls are steep enough that a naive nearest
// triangle ray can grab the opposite wall.
function grooveScene() {
  const low = new Builder();
  heightfield(low, 'slab', 24, 24, () => 0, [0.05, 0.05, 0.95, 0.95]);

  const high = new Builder();
  heightfield(high, 'slab', 96, 96, (x, y) => {
    const g = Math.abs(x - 0.5);
    // Deep narrow groove along Y, plus a shallow cross ripple.
    const groove = g < 0.06 ? -0.35 * (1 - g / 0.06) : 0;
    const ripple = 0.03 * Math.sin(y * Math.PI * 6);
    return groove + ripple;
  }, [0.05, 0.05, 0.95, 0.95], 0.6);
  return { low: low.mesh, high: high.mesh, name: 'groove' };
}

// --- Scene B: thin shell -------------------------------------------------------
// A curved thin shell (half cylinder). High model has fine ribbing; the low
// model is smooth. The shell thickness is comparable to the cage distance, so
// the inner back face can be wrongly hit unless part/front-face rules apply.
function shellScene() {
  const seg = 40;
  const rows = 12;
  const radius = 0.5;
  const thick = 0.04;

  function build(detail, ribs) {
    const b = new Builder();
    b.part('shell_outer');
    const base = b.mesh.positions.length;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        const ang = Math.PI * (1 - t); // 0..pi
        const y = j / rows;
        const r = radius + (ribs ? 0.025 * Math.sin(t * Math.PI * 14) : 0);
        b.addVertex(
          [Math.cos(ang) * r, y, Math.sin(ang) * r],
          [0.05 + t * 0.9, 0.05 + y * 0.9],
        );
      }
    }
    const idx = (i, j) => base + j * (seg + 1) + i;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < seg; i++) {
        const a = idx(i, j), c = idx(i + 1, j), d = idx(i + 1, j + 1), e = idx(i, j + 1);
        // Winding so outer normals point radially away from the cylinder axis.
        b.mesh.faces.push([a, c, d], [a, d, e]);
        b.mesh.uvFaces.push([a, c, d], [a, d, e]);
        b.mesh.facePart.push(0, 0);
      }
    }
    // Inner back wall, distinct part, slightly smaller radius.
    b.part('shell_inner');
    const ib = b.mesh.positions.length;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        const ang = Math.PI * (1 - t);
        const y = j / rows;
        const r = radius - thick;
        b.addVertex(
          [Math.cos(ang) * r, y, Math.sin(ang) * r],
          [0.05 + t * 0.9, 0.05 + y * 0.9],
        );
      }
    }
    const iidx = (i, j) => ib + j * (seg + 1) + i;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < seg; i++) {
        const a = iidx(i, j), c = iidx(i + 1, j), d = iidx(i + 1, j + 1), e = iidx(i, j + 1);
        // Inner wall normal faces the cavity/axis, opposite the outward ray.
        b.mesh.faces.push([a, d, c], [a, e, d]);
        b.mesh.uvFaces.push([a, d, c], [a, e, d]);
        b.mesh.facePart.push(1, 1);
      }
    }
    return b.mesh;
  }
  return { low: build(false, false), high: build(true, true), name: 'shell' };
}

// --- Scene C: adjacent separate parts ------------------------------------------
// Two side-by-side boxes with a real empty gap in world X. High boxes carry
// bumps; a naive nearest-triangle baker can jump the gap and bake the
// neighbor's detail where a ray escapes through the gap toward the other box.
function adjacentScene() {
  // Rectangular patch over world [x0,x1] x [0,1], mapped to a UV sub-rect.
  function patch(builder, part, x0, x1, nx, ny, h, uvBox) {
    builder.part(part);
    const base = builder.mesh.positions.length;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const lx = i / nx;
        const y = j / ny;
        const x = x0 + lx * (x1 - x0);
        builder.addVertex([x, y, h(lx, y)], [
          uvBox[0] + lx * (uvBox[2] - uvBox[0]),
          uvBox[1] + y * (uvBox[3] - uvBox[1]),
        ]);
      }
    }
    const idx = (i, j) => base + j * (nx + 1) + i;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
        builder.mesh.faces.push([a, b, c], [a, c, d]);
        builder.mesh.uvFaces.push([a, b, c], [a, c, d]);
        builder.mesh.facePart.push(builder.currentPart, builder.currentPart);
      }
    }
  }

  function build(detail) {
    const b = new Builder();
    // Left box world X [0.05,0.42], right box [0.58,0.95]; gap 0.16 wide.
    const mk = (x0, x1, part, uvBox, phase) => patch(
      b, part, x0, x1, 28, 28,
      (lx, y) => detail ? 0.04 * Math.sin((lx + phase) * Math.PI * 6) *
        Math.sin(y * Math.PI * 6) : 0,
      uvBox);
    mk(0.05, 0.42, 'box_left', [0.05, 0.05, 0.47, 0.95], 0);
    mk(0.58, 0.95, 'box_right', [0.53, 0.05, 0.95, 0.95], 0.5);
    return b.mesh;
  }
  return { low: build(false), high: build(true), name: 'adjacent' };
}

// --- Scene D: folded thin sheet ------------------------------------------------
// The high mesh is a thin sheet whose edge folds back underneath. From the
// inner cage, the folded-back wall (a distinct part) is geometrically closer
// than the outer skin, so a part-unaware nearest ray bakes the wrong back
// surface while part ownership keeps the correct outer skin.
function foldScene() {
  function build(detail) {
    const b = new Builder();
    // Outer skin the low mesh actually represents.
    heightfield(b, 'skin', 32, 32, (x, y) => {
      const base = 0.1;
      return detail ? base + 0.04 * Math.sin(x * Math.PI * 4) * Math.sin(y * Math.PI * 4) : base;
    }, [0.05, 0.05, 0.95, 0.95], detail ? 0.5 : 0);
    // Folded-back wall: separate part, lower height -> closer to inner cage.
    heightfield(b, 'fold', 32, 32, (x, y) => 0.05,
      [0.05, 0.05, 0.95, 0.95], 0);
    return b.mesh;
  }
  const high = build(true);
  // Low mesh: single-part flat sheet at z=0 (only the skin is represented).
  const lowB = new Builder();
  heightfield(lowB, 'skin', 20, 20, () => 0, [0.05, 0.05, 0.95, 0.95], 0);
  return { low: lowB.mesh, high, name: 'fold' };
}

function main() {
  const out = path.join(__dirname, '..', 'output', 'models');
  fs.mkdirSync(out, { recursive: true });
  for (const scene of [grooveScene(), shellScene(), adjacentScene(), foldScene()]) {
    fs.writeFileSync(path.join(out, `${scene.name}_low.obj`), writeOBJ(scene.low));
    fs.writeFileSync(path.join(out, `${scene.name}_high.obj`), writeOBJ(scene.high));
    console.log(`wrote ${scene.name}: low ${scene.low.faces.length} tris / ` +
      `${scene.low.partNames.length} parts, high ${scene.high.faces.length} tris`);
  }
}

if (require.main === module) main();
module.exports = { grooveScene, shellScene, adjacentScene, foldScene, heightfield, Builder };
