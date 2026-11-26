'use strict';

// Browser-side equivalents of test/make_models.js. They build the same three
// challenging scenes (deep groove, thin shell, adjacent separate parts) and
// serialize to OBJ text so the GUI exercises the real parseOBJ -> bake path
// rather than feeding in canned texture data.
(function (root) {
  function makeBuilder() {
    return {
      positions: [], uvs: [], faces: [], uvFaces: [], facePart: [], partNames: [],
      currentPart: 0,
      part(name) {
        let id = this.partNames.indexOf(name);
        if (id < 0) { id = this.partNames.length; this.partNames.push(name); }
        this.currentPart = id;
      },
      vertex(p, uv) {
        this.positions.push(p); this.uvs.push(uv);
        return this.positions.length - 1;
      },
      faceTri(a, b, c) {
        this.faces.push([a, b, c]);
        this.uvFaces.push([a, b, c]);
        this.facePart.push(this.currentPart);
      },
    };
  }

  function toOBJ(b, name) {
    const L = [`# ${name}`];
    for (const p of b.positions) L.push(`v ${p[0]} ${p[1]} ${p[2]}`);
    for (const t of b.uvs) L.push(`vt ${t[0]} ${t[1]}`);
    let last = -1;
    b.faces.forEach((f, i) => {
      const part = b.facePart[i];
      if (part !== last) { L.push(`o ${b.partNames[part]}`); last = part; }
      L.push(`f ${f[0] + 1}/${f[0] + 1} ${f[1] + 1}/${f[1] + 1} ${f[2] + 1}/${f[2] + 1}`);
    });
    return L.join('\n') + '\n';
  }

  function heightfield(b, part, nx, ny, h, uvBox, jitter) {
    b.part(part);
    const base = b.positions.length;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        let x = i / nx, y = j / ny;
        if (jitter && i > 0 && i < nx && j > 0 && j < ny) {
          const hs = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
          const ht = Math.sin(i * 269.5 + j * 183.3) * 19341.173;
          x += ((hs - Math.floor(hs)) - 0.5) * jitter / nx;
          y += ((ht - Math.floor(ht)) - 0.5) * jitter / ny;
        }
        b.vertex([x, y, h(i / nx, j / ny)], [
          uvBox[0] + (i / nx) * (uvBox[2] - uvBox[0]),
          uvBox[1] + (j / ny) * (uvBox[3] - uvBox[1]),
        ]);
      }
    }
    const idx = (i, j) => base + j * (nx + 1) + i;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = idx(i, j), c = idx(i + 1, j), d = idx(i + 1, j + 1), e = idx(i, j + 1);
        b.faceTri(a, c, d); b.faceTri(a, d, e);
      }
    }
  }

  function groove() {
    const low = makeBuilder();
    heightfield(low, 'slab', 24, 24, () => 0, [0.05, 0.05, 0.95, 0.95], 0);
    const high = makeBuilder();
    heightfield(high, 'slab', 96, 96, (x, y) => {
      const g = Math.abs(x - 0.5);
      const groove = g < 0.06 ? -0.35 * (1 - g / 0.06) : 0;
      return groove + 0.03 * Math.sin(y * Math.PI * 6);
    }, [0.05, 0.05, 0.95, 0.95], 0.6);
    return { low: toOBJ(low, 'groove_low'), high: toOBJ(high, 'groove_high') };
  }

  function shell() {
    function build(detail) {
      const b = makeBuilder();
      const seg = 40, rows = 12, radius = 0.5, thick = 0.04;
      b.part('shell_outer');
      const base = b.positions.length;
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= seg; i++) {
          const t = i / seg, ang = Math.PI * (1 - t), y = j / rows;
          const r = radius + (detail ? 0.025 * Math.sin(t * Math.PI * 14) : 0);
          b.vertex([Math.cos(ang) * r, y, Math.sin(ang) * r],
            [0.05 + t * 0.9, 0.05 + y * 0.9]);
        }
      }
      const idx = (i, j) => base + j * (seg + 1) + i;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < seg; i++) {
          const a = idx(i, j), c = idx(i + 1, j), d = idx(i + 1, j + 1), e = idx(i, j + 1);
          b.faceTri(a, c, d); b.faceTri(a, d, e);
        }
      }
      b.part('shell_inner');
      const ib = b.positions.length;
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= seg; i++) {
          const t = i / seg, ang = Math.PI * (1 - t), y = j / rows;
          b.vertex([Math.cos(ang) * (radius - thick), y, Math.sin(ang) * (radius - thick)],
            [0.05 + t * 0.9, 0.05 + y * 0.9]);
        }
      }
      const iidx = (i, j) => ib + j * (seg + 1) + i;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < seg; i++) {
          const a = iidx(i, j), c = iidx(i + 1, j), d = iidx(i + 1, j + 1), e = iidx(i, j + 1);
          b.faceTri(a, d, c); b.faceTri(a, e, d);
        }
      }
      return b;
    }
    return {
      low: toOBJ(build(false), 'shell_low'),
      high: toOBJ(build(true), 'shell_high'),
    };
  }

  function adjacent() {
    function patch(b, part, x0, x1, nx, ny, h, uvBox) {
      b.part(part);
      const base = b.positions.length;
      for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) {
          const lx = i / nx, y = j / ny, x = x0 + lx * (x1 - x0);
          b.vertex([x, y, h(lx, y)], [
            uvBox[0] + lx * (uvBox[2] - uvBox[0]),
            uvBox[1] + y * (uvBox[3] - uvBox[1]),
          ]);
        }
      }
      const idx = (i, j) => base + j * (nx + 1) + i;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const a = idx(i, j), c = idx(i + 1, j), d = idx(i + 1, j + 1), e = idx(i, j + 1);
          b.faceTri(a, c, d); b.faceTri(a, d, e);
        }
      }
    }
    function build(detail) {
      const b = makeBuilder();
      const mk = (x0, x1, part, uvBox, phase) => patch(
        b, part, x0, x1, 28, 28,
        (lx, y) => detail ? 0.04 * Math.sin((lx + phase) * Math.PI * 6) * Math.sin(y * Math.PI * 6) : 0,
        uvBox);
      mk(0.05, 0.42, 'box_left', [0.05, 0.05, 0.47, 0.95], 0);
      mk(0.58, 0.95, 'box_right', [0.53, 0.05, 0.95, 0.95], 0.5);
      return b;
    }
    return {
      low: toOBJ(build(false), 'adjacent_low'),
      high: toOBJ(build(true), 'adjacent_high'),
    };
  }

  function fold() {
    function heightfieldLocal(b, part, nx, ny, h, uvBox, jitter) {
      b.part(part);
      const base = b.positions.length;
      for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) {
          let x = i / nx, y = j / ny;
          if (jitter && i > 0 && i < nx && j > 0 && j < ny) {
            const hs = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
            const ht = Math.sin(i * 269.5 + j * 183.3) * 19341.173;
            x += ((hs - Math.floor(hs)) - 0.5) * jitter / nx;
            y += ((ht - Math.floor(ht)) - 0.5) * jitter / ny;
          }
          b.vertex([x, y, h(i / nx, j / ny)], [
            uvBox[0] + (i / nx) * (uvBox[2] - uvBox[0]),
            uvBox[1] + (j / ny) * (uvBox[3] - uvBox[1]),
          ]);
        }
      }
      const idx = (i, j) => base + j * (nx + 1) + i;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const a = idx(i, j), c = idx(i + 1, j), d = idx(i + 1, j + 1), e = idx(i, j + 1);
          b.faceTri(a, c, d); b.faceTri(a, d, e);
        }
      }
    }
    const high = makeBuilder();
    heightfieldLocal(high, 'skin', 32, 32, (x, y) =>
      0.1 + 0.04 * Math.sin(x * Math.PI * 4) * Math.sin(y * Math.PI * 4),
      [0.05, 0.05, 0.95, 0.95], 0.5);
    heightfieldLocal(high, 'fold', 32, 32, () => 0.05,
      [0.05, 0.05, 0.95, 0.95], 0);
    const low = makeBuilder();
    heightfieldLocal(low, 'skin', 20, 20, () => 0, [0.05, 0.05, 0.95, 0.95], 0);
    return { low: toOBJ(low, 'fold_low'), high: toOBJ(high, 'fold_high') };
  }

  function maintenance(variant = 'baseline') {
    const sample = root.GeoBakerSamples.maintenanceSample(variant);
    return {
      low: root.GeoBakerMesh.writeOBJ(sample.low),
      high: root.GeoBakerMesh.writeOBJ(sample.high),
      partRules: sample.partRules,
    };
  }

  root.GeoBakerDemo = {
    groove, shell, adjacent, fold,
    maintenance: () => maintenance('baseline'),
    rogue: () => maintenance('rogue'),
  };
})(typeof self !== 'undefined' ? self : this);
