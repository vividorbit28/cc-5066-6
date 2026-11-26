(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./math') : root.GeoBakerMath);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoBakerMesh = api;
})(typeof self !== 'undefined' ? self : this, function (mathMod) {
'use strict';
const { V } = mathMod;

// A triangle mesh with optional per-face part ownership and a UV atlas.
// positions: [[x,y,z],...]  faces: [[i0,i1,i2],...]
// uvs: [[u,v],...]          uvFaces: [[j0,j1,j2],...] (may equal faces length)
// facePart: [partId,...]    partNames: [string,...]
class Mesh {
  constructor(name = 'mesh') {
    this.name = name;
    this.positions = [];
    this.faces = [];
    this.uvs = [];
    this.uvFaces = [];
    this.facePart = [];
    this.partNames = [];
    // Stable identities are independent of display labels. Two screws may
    // both have partNames "screw" while retaining screw_a/screw_b here.
    this.partIds = [];
    this.sourceObjectNames = [];
  }

  partIdentity(partIndex) {
    const i = partIndex ?? 0;
    return {
      index: i,
      id: this.partIds[i] ?? this.partNames[i] ?? `part_${i}`,
      label: this.partNames[i] ?? `part${i}`,
    };
  }

  addPart(label, id = null) {
    const index = this.partNames.length;
    const safeLabel = String(label ?? `part_${index + 1}`);
    this.partNames.push(safeLabel);
    this.partIds.push(id ?? makePartId(safeLabel, index));
    return index;
  }

  bounds() {
    let mn = [Infinity, Infinity, Infinity];
    let mx = [-Infinity, -Infinity, -Infinity];
    for (const p of this.positions) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < mn[k]) mn[k] = p[k];
        if (p[k] > mx[k]) mx[k] = p[k];
      }
    }
    return { min: mn, max: mx, center: V.scale(V.add(mn, mx), 0.5) };
  }

  faceNormal(fi) {
    const f = this.faces[fi];
    const a = this.positions[f[0]];
    const b = this.positions[f[1]];
    const c = this.positions[f[2]];
    return V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
  }

  // Smooth vertex normals averaged from adjacent faces; per-face normals
  // are kept separately by callers that need faceted shading.
  vertexNormals() {
    const n = this.positions.map(() => [0, 0, 0]);
    this.faces.forEach((f, fi) => {
      const fn = this.faceNormal(fi);
      for (const idx of f) {
        n[idx][0] += fn[0];
        n[idx][1] += fn[1];
        n[idx][2] += fn[2];
      }
    });
    return n.map(V.norm);
  }

  // Sample a point + frame on face fi at barycentric coords (b0,b1,b2).
  sample(fi, b) {
    const f = this.faces[fi];
    const p0 = this.positions[f[0]];
    const p1 = this.positions[f[1]];
    const p2 = this.positions[f[2]];
    const point = [
      b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0],
      b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1],
      b[0] * p0[2] + b[1] * p1[2] + b[2] * p2[2],
    ];
    let uv = [0, 0];
    if (this.uvFaces[fi]) {
      const uf = this.uvFaces[fi];
      const u0 = this.uvs[uf[0]];
      const u1 = this.uvs[uf[1]];
      const u2 = this.uvs[uf[2]];
      uv = [
        b[0] * u0[0] + b[1] * u1[0] + b[2] * u2[0],
        b[0] * u0[1] + b[1] * u1[1] + b[2] * u2[1],
      ];
    }
    return { point, uv };
  }
}

function parseOBJ(text, name = 'mesh', options = {}) {
  const mesh = new Mesh(name);
  const pos = [];
  const uv = [];
  const partIndex = new Map();
  const countsByBaseId = new Map();
  let currentPart = -1;
  let activeDeclaration = null;
  let pendingPartId = null;
  let facesSinceDeclaration = 0;

  const makeUniqueId = (label) => {
    const base = slugifyPartId(label) || 'part';
    const seen = countsByBaseId.get(base) ?? 0;
    countsByBaseId.set(base, seen + 1);
    // The first occurrence keeps the natural id; later same-label objects get
    // a stable suffix instead of being merged by their display name.
    return seen === 0 ? base : `${base}_${seen + 1}`;
  };

  const ensureDefault = () => {
    if (currentPart >= 0) return currentPart;
    currentPart = mesh.addPart('default', 'default');
    partIndex.set('default', currentPart);
    return currentPart;
  };

  const useNamedPart = (label, kind) => {
    const textLabel = label || 'default';
    const declaration = `${kind}:${textLabel}`;
    // Repeated identical declaration lines with no new object boundary are
    // harmless in many exporters. A second `o screw` after faces is a new,
    // distinct same-name component and must not collapse into the first.
    if (options.mergeGroupsByName !== false && kind === 'g' && partIndex.has(textLabel)) {
      currentPart = partIndex.get(textLabel);
      activeDeclaration = declaration;
      facesSinceDeclaration = 0;
      return currentPart;
    }
    if (
      activeDeclaration === declaration && !pendingPartId &&
      (kind !== 'o' || facesSinceDeclaration === 0)
    ) {
      return currentPart;
    }
    const index = mesh.addPart(textLabel, pendingPartId ?? makeUniqueId(textLabel));
    pendingPartId = null;
    if (kind === 'g') partIndex.set(textLabel, index);
    currentPart = index;
    activeDeclaration = declaration;
    facesSinceDeclaration = 0;
    return index;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/^#\s*part-id:\s*(\S+)/);
      if (m) pendingPartId = m[1];
      continue;
    }
    const tok = line.split(/\s+/);
    switch (tok[0]) {
      case 'v':
        pos.push([Number(tok[1]), Number(tok[2]), Number(tok[3])]);
        break;
      case 'vt':
        uv.push([Number(tok[1]), Number(tok[2] ?? 0)]);
        break;
      case 'o':
      case 'g':
        if (tok[1]) useNamedPart(tok.slice(1).join(' '), tok[0]);
        break;
      case 'usemtl':
        if (tok[1]) useNamedPart(tok[1], 'usemtl');
        break;
      case 'f': {
        const vi = [];
        const ti = [];
        for (let k = 1; k < tok.length; k++) {
          const components = tok[k].split('/');
          vi.push(resolveIndex(Number(components[0]), pos.length));
          ti.push(components[1] ? resolveIndex(Number(components[1]), uv.length) : -1);
        }
        const part = ensureDefault();
        facesSinceDeclaration++;
        // Fan-triangulate polygons.
        for (let k = 1; k + 1 < vi.length; k++) {
          mesh.faces.push([vi[0], vi[k], vi[k + 1]]);
          mesh.facePart.push(part);
          if (ti[0] >= 0) {
            mesh.uvFaces.push([ti[0], ti[k], ti[k + 1]]);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  mesh.positions = pos;
  mesh.uvs = uv;
  if (mesh.uvFaces.length !== mesh.faces.length) mesh.uvFaces = [];
  return mesh;
}

function slugifyPartId(label) {
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveIndex(idx, count) {
  return idx > 0 ? idx - 1 : count + idx;
}

function makePartId(label, index) {
  const slug = slugifyPartId(label);
  return slug || `part_${index}`;
}

// Serialize a mesh (used for the saved cage and for diagnostics).
function writeOBJ(mesh) {
  const L = [];
  L.push(`# ${mesh.name} — written by geometry baker`);
  for (const p of mesh.positions) L.push(`v ${p[0]} ${p[1]} ${p[2]}`);
  for (const t of mesh.uvs) L.push(`vt ${t[0]} ${t[1]}`);
  let lastPart = -1;
  mesh.faces.forEach((f, fi) => {
    const part = mesh.facePart[fi] ?? 0;
    if (part !== lastPart) {
      L.push(`# part-id: ${mesh.partIds[part] ?? mesh.partNames[part] ?? `part_${part}`}`);
      L.push(`o ${mesh.partNames[part] ?? `part${part}`}`);
      lastPart = part;
    }
    if (mesh.uvFaces[fi]) {
      const uf = mesh.uvFaces[fi];
      L.push(`f ${f[0] + 1}/${uf[0] + 1} ${f[1] + 1}/${uf[1] + 1} ${f[2] + 1}/${uf[2] + 1}`);
    } else {
      L.push(`f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`);
    }
  });
  return L.join('\n') + '\n';
}

return { Mesh, parseOBJ, writeOBJ };
});
