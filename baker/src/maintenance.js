'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoBakerMaintenance = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sourceKey(rec) {
    if (!rec) return 'outside_uv';
    if (rec.status === 'unknown_correspondence') return 'unknown_correspondence';
    if (!rec.chosen) return `unavailable:${rec.reason}`;
    const id = rec.chosen.partId ?? rec.projectionIdentity?.hitPartId ?? `part_${rec.chosen.part}`;
    return `${id}:face_${rec.chosen.face}`;
  }

  function sourceMap(result) {
    const map = new Map();
    for (const rec of result.records) {
      map.set(rec.py * result.size + rec.px, {
        index: rec.py * result.size + rec.px,
        px: rec.px,
        py: rec.py,
        key: sourceKey(rec),
        identityValid: rec.identityValid ?? false,
        status: rec.status,
        partId: rec.lowPartId,
        normalErrorDeg: rec.normalErrorDeg ?? null,
      });
    }
    return map;
  }

  // Returns the first texel (linear UV order) whose projection source differs.
  // A label-only rename must produce null here.
  function firstSourceChange(before, after) {
    const a = sourceMap(before);
    const b = sourceMap(after);
    const n = before.size * before.size;
    for (let index = 0; index < n; index++) {
      const ra = a.get(index);
      const rb = b.get(index);
      const ka = ra?.key ?? 'outside_uv';
      const kb = rb?.key ?? 'outside_uv';
      if (ka !== kb) {
        return {
          index,
          px: index % before.size,
          py: Math.floor(index / before.size),
          before: ka,
          after: kb,
          beforeIdentityValid: ra?.identityValid ?? false,
          afterIdentityValid: rb?.identityValid ?? false,
          partId: rb?.partId ?? ra?.partId ?? null,
        };
      }
    }
    return null;
  }

  function countSourceChanges(before, after) {
    const a = sourceMap(before);
    const b = sourceMap(after);
    let changed = 0;
    const samples = [];
    for (const [index, ra] of a) {
      const rb = b.get(index);
      if (!rb || ra.key !== rb.key) {
        changed++;
        if (samples.length < 10) {
          samples.push({
            index, px: index % before.size, py: Math.floor(index / before.size),
            before: ra.key, after: rb?.key ?? 'outside_uv',
          });
        }
      }
    }
    return { changed, samples, first: samples[0] ?? null };
  }

  function textureReports(result, options = {}) {
    const normalErrorMaxDeg = options.normalErrorMaxDeg ?? 2;
    const textures = new Map();
    const ensure = (id) => {
      if (!textures.has(id)) {
        textures.set(id, {
          id, texels: 0, hit: 0, conflict: 0, miss: 0,
          unknown_correspondence: 0, identityMismatch: 0,
          normalErrorMaxDeg: 0, parts: new Set(),
        });
      }
      return textures.get(id);
    };

    for (const rec of result.records) {
      const textureId = rec.projectionRule?.texture;
      if (!textureId) continue;
      const t = ensure(textureId);
      t.texels++;
      t.parts.add(rec.lowPartId);
      if (rec.status === 'hit') t.hit++;
      else if (rec.status === 'conflict') t.conflict++;
      else if (rec.status === 'miss') t.miss++;
      else if (rec.status === 'unknown_correspondence') t.unknown_correspondence++;
      if (rec.identityValid === false && rec.chosen) t.identityMismatch++;
      if (Number.isFinite(rec.normalErrorDeg)) {
        t.normalErrorMaxDeg = Math.max(t.normalErrorMaxDeg, rec.normalErrorDeg);
      }
    }

    return Array.from(textures.values()).map((t) => {
      const problems = [];
      if (t.texels === 0) problems.push('empty_texture_region');
      if (t.hit !== t.texels) problems.push('not_all_texels_have_clean_identity_sources');
      if (t.conflict) problems.push(`conflict_texels:${t.conflict}`);
      if (t.miss) problems.push(`miss_texels:${t.miss}`);
      if (t.unknown_correspondence) problems.push(`unknown_correspondence_texels:${t.unknown_correspondence}`);
      if (t.identityMismatch) problems.push(`identity_mismatches:${t.identityMismatch}`);
      if (t.normalErrorMaxDeg > normalErrorMaxDeg) {
        problems.push(`normal_error_above_${normalErrorMaxDeg}_deg`);
      }
      return {
        ...t,
        parts: Array.from(t.parts),
        publishable: problems.length === 0,
        problems,
      };
    });
  }

  return { sourceKey, sourceMap, firstSourceChange, countSourceChanges, textureReports };
});
