'use strict';

(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./mesh') : root.GeoBakerMesh,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoBakerSamples = api;
})(typeof self !== 'undefined' ? self : this, function (meshMod) {
  'use strict';

  const { Mesh } = meshMod;

  // Minimal explicit triangle builder. Each quad is two independently wound
  // triangles; +U is right and +V is up in the supplied UV box.
  class SampleBuilder {
    constructor() {
      this.mesh = new Mesh('maintenance-sample');
    }

    part(id, label = id) {
      let index = this.mesh.partIds.indexOf(id);
      if (index < 0) index = this.mesh.addPart(label, id);
      this.current = index;
      return this;
    }

    quad(id, label, corners, uvBox, height = 0, normalWinding = 1) {
      this.part(id, label);
      const [x0, y0, x1, y1] = corners;
      const [u0, v0, u1, v1] = uvBox;
      const pts = [
        [x0, y0, height], [x1, y0, height], [x1, y1, height], [x0, y1, height],
      ];
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      const base = this.mesh.positions.length;
      pts.forEach((p, i) => {
        this.mesh.positions.push(p);
        this.mesh.uvs.push(uvs[i]);
      });
      const tris = normalWinding >= 0
        ? [[0, 1, 2], [0, 2, 3]]
        : [[0, 2, 1], [0, 3, 2]];
      for (const tri of tris) {
        this.mesh.faces.push(tri.map((k) => base + k));
        this.mesh.uvFaces.push(tri.map((k) => base + k));
        this.mesh.facePart.push(this.current);
      }
      return this;
    }

    bumpQuad(id, label, corners, uvBox, baseZ, amp, segments = 8) {
      this.part(id, label);
      const [x0, y0, x1, y1] = corners;
      const [u0, v0, u1, v1] = uvBox;
      const vertex = (i, j) => {
        const sx = i / segments;
        const sy = j / segments;
        const x = x0 + sx * (x1 - x0);
        const y = y0 + sy * (y1 - y0);
        const z = baseZ + amp * (
          0.5 + 0.5 * Math.sin((sx * 2.0 + 0.17) * Math.PI * 4) *
          Math.cos(sy * Math.PI * 3)
        );
        return [x, y, z];
      };
      const base = this.mesh.positions.length;
      for (let j = 0; j <= segments; j++) {
        for (let i = 0; i <= segments; i++) {
          const sx = i / segments;
          const sy = j / segments;
          this.mesh.positions.push(vertex(i, j));
          this.mesh.uvs.push([u0 + sx * (u1 - u0), v0 + sy * (v1 - v0)]);
        }
      }
      const idx = (i, j) => base + j * (segments + 1) + i;
      for (let j = 0; j < segments; j++) {
        for (let i = 0; i < segments; i++) {
          const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
          this.mesh.faces.push([a, b, c], [a, c, d]);
          this.mesh.uvFaces.push([a, b, c], [a, c, d]);
          this.mesh.facePart.push(this.current, this.current);
        }
      }
      return this;
    }
  }

  const LABELS = {
    screwA: '螺钉',
    screwB: '螺钉',
    shroudLeft: '罩壳',
    shroudRight: '罩壳',
    bracket: '支架',
    cover: '维修盖板',
    coverLeft: '维修盖板/左',
    coverRight: '维修盖板/右',
    rail: '隔壁导轨',
  };

  // UV islands are deliberately separated. World positions are also separated
  // or stacked only where a rejection scenario needs it.
  const LAYOUT = {
    screwA: { world: [0.04, 0.74, 0.24, 0.94], uv: [0.04, 0.74, 0.24, 0.96] },
    screwB: { world: [0.28, 0.74, 0.48, 0.94], uv: [0.28, 0.74, 0.48, 0.96] },
    shroudLeft: { world: [0.54, 0.74, 0.74, 0.94], uv: [0.54, 0.74, 0.74, 0.96] },
    shroudRight: { world: [0.78, 0.74, 0.96, 0.94], uv: [0.78, 0.74, 0.96, 0.96] },
    bracket: { world: [0.04, 0.40, 0.48, 0.66], uv: [0.04, 0.40, 0.48, 0.66] },
    cover: { world: [0.54, 0.34, 0.96, 0.66], uv: [0.54, 0.34, 0.96, 0.66] },
    coverLeft: { world: [0.54, 0.34, 0.75, 0.66], uv: [0.54, 0.34, 0.75, 0.66] },
    coverRight: { world: [0.75, 0.34, 0.96, 0.66], uv: [0.75, 0.34, 0.96, 0.66] },
    rogueCover: { world: [0.08, 0.06, 0.46, 0.28], uv: [0.08, 0.06, 0.46, 0.28] },
    rail: { world: [0.08, 0.06, 0.46, 0.28], uv: [0.56, 0.06, 0.94, 0.28] },
  };

  function addCommonLow(b, { splitCover = false, rogue = false, rename = false } = {}) {
    const bracketLabel = rename ? 'Bracket MK-II' : LABELS.bracket;
    b.quad('screw_a', LABELS.screwA, LAYOUT.screwA.world, LAYOUT.screwA.uv);
    b.quad('screw_b', LABELS.screwB, LAYOUT.screwB.world, LAYOUT.screwB.uv);
    // This shroud was already split in the legacy project and must remain two
    // stable identities even though both display labels are identical.
    b.quad('shroud_left', LABELS.shroudLeft, LAYOUT.shroudLeft.world, LAYOUT.shroudLeft.uv);
    b.quad('shroud_right', LABELS.shroudRight, LAYOUT.shroudRight.world, LAYOUT.shroudRight.uv);
    b.quad('bracket', bracketLabel, LAYOUT.bracket.world, LAYOUT.bracket.uv);
    if (rogue) {
      b.quad('cover_rogue', LABELS.cover, LAYOUT.rogueCover.world, LAYOUT.rogueCover.uv);
    } else if (splitCover) {
      b.quad('cover_left', LABELS.coverLeft, LAYOUT.coverLeft.world, LAYOUT.coverLeft.uv);
      b.quad('cover_right', LABELS.coverRight, LAYOUT.coverRight.world, LAYOUT.coverRight.uv);
    } else {
      b.quad('cover', LABELS.cover, LAYOUT.cover.world, LAYOUT.cover.uv);
    }
    return b.mesh;
  }

  function lowMesh(variant = 'baseline') {
    const b = new SampleBuilder();
    return addCommonLow(b, {
      splitCover: variant === 'split',
      rogue: variant === 'rogue',
      rename: variant === 'renamed',
    });
  }

  function highMesh(variant = 'baseline') {
    const b = new SampleBuilder();
    b.bumpQuad('screw_a', LABELS.screwA, LAYOUT.screwA.world, LAYOUT.screwA.uv, 0.018, 0.035, 6);
    b.bumpQuad('screw_b', LABELS.screwB, LAYOUT.screwB.world, LAYOUT.screwB.uv, 0.022, 0.045, 6);
    b.bumpQuad('shroud_left', LABELS.shroudLeft, LAYOUT.shroudLeft.world, LAYOUT.shroudLeft.uv, 0.012, 0.026, 8);
    b.bumpQuad('shroud_right', LABELS.shroudRight, LAYOUT.shroudRight.world, LAYOUT.shroudRight.uv, 0.014, 0.03, 8);
    b.bumpQuad('bracket', variant === 'renamed' ? 'Bracket MK-II' : LABELS.bracket,
      LAYOUT.bracket.world, LAYOUT.bracket.uv, 0.01, 0.024, 8);

    if (variant === 'split') {
      b.bumpQuad('cover_left', LABELS.coverLeft, LAYOUT.coverLeft.world, LAYOUT.coverLeft.uv, 0.016, 0.035, 8);
      b.bumpQuad('cover_right', LABELS.coverRight, LAYOUT.coverRight.world, LAYOUT.coverRight.uv, 0.018, 0.04, 8);
    } else if (variant === 'rogue') {
      // The legitimate cover source is absent. This neighboring rail occupies
      // the same XY interval but its winding points -Z, so a +Z projection
      // ray can only meet a back-facing foreign surface.
      b.quad('rail_back', LABELS.rail, LAYOUT.rail.world, LAYOUT.rail.uv, -0.02, -1);
    } else {
      b.bumpQuad('cover', LABELS.cover, LAYOUT.cover.world, LAYOUT.cover.uv, 0.016, 0.038, 12);
    }
    return b.mesh;
  }

  function partRules(variant = 'baseline') {
    const rules = {
      screw_a: { accept: ['screw_a'], texture: 'screw_a' },
      screw_b: { accept: ['screw_b'], texture: 'screw_b' },
      shroud_left: { accept: ['shroud_left'], texture: 'shroud' },
      shroud_right: { accept: ['shroud_right'], texture: 'shroud' },
      bracket: { accept: ['bracket'], texture: 'bracket' },
    };
    if (variant === 'split') {
      rules.cover_left = { accept: ['cover_left'], texture: 'cover_left' };
      rules.cover_right = { accept: ['cover_right'], texture: 'cover_right' };
    } else if (variant === 'rogue') {
      rules.cover_rogue = { accept: ['cover'], texture: 'cover' };
    } else {
      rules.cover = { accept: ['cover'], texture: 'cover' };
    }
    return rules;
  }

  function maintenanceSample(variant = 'baseline') {
    if (!['baseline', 'renamed', 'split', 'rogue'].includes(variant)) {
      throw new Error(`unknown maintenance sample variant: ${variant}`);
    }
    return {
      name: `maintenance_${variant}`,
      variant,
      low: lowMesh(variant),
      high: highMesh(variant),
      partRules: partRules(variant),
      layout: LAYOUT,
      conventions: {
        cage: 'p_outer=p+N*outerDistance; p_inner=p-N*innerDistance',
        rayDirection: 'inner_to_outer_normalized(p_outer-p_inner)',
        projectionFacing: 'dot(hit.geometricNormal, rayDirection) >= 0',
        tangentNormal: 'RGB xyz maps tangent T/B/N; neutral (128,128,255) is +Z',
        uvTexelRow: 'py=floor(v*size-0.5); buffer row 0 is v=0 in this implementation',
      },
    };
  }

  return { maintenanceSample, lowMesh, highMesh, partRules, LABELS, LAYOUT, SampleBuilder };
});
