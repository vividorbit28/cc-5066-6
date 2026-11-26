'use strict';

// Materialize the maintenance fixture as ordinary OBJ files plus a projection
// rule manifest. The generated directory is a re-bakeable part set; checks do
// not require hand-edited JSON or textures.
const fs = require('fs');
const path = require('path');
const { writeOBJ } = require('../src/mesh');
const { maintenanceSample, partRules } = require('../src/samples');
const rulesDoc = require('../projection-rules.json');

function writeSampleSet(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const variants = ['baseline', 'renamed', 'split', 'rogue'];
  const files = [];
  for (const variant of variants) {
    const sample = maintenanceSample(variant);
    const lowFile = variant === 'baseline' ? 'assembly_low.obj' : `${variant}_low.obj`;
    const highFile = variant === 'baseline' ? 'assembly_high.obj' : `${variant}_high.obj`;
    fs.writeFileSync(path.join(outDir, lowFile), writeOBJ(sample.low));
    fs.writeFileSync(path.join(outDir, highFile), writeOBJ(sample.high));
    files.push(lowFile, highFile);
  }

  const manifest = {
    schema: 'geometry-baker/maintenance-part-set/v1',
    projectionRules: './projection-maintenance.json',
    conventions: rulesDoc.conventions,
    bake: rulesDoc.maintenanceSample,
    files: {
      baseline: { low: 'assembly_low.obj', high: 'assembly_high.obj' },
      renamed: { low: 'renamed_low.obj', high: 'renamed_high.obj' },
      split: { low: 'split_low.obj', high: 'split_high.obj' },
      rogue: { low: 'rogue_low.obj', high: 'rogue_high.obj' },
    },
    partRulesByVariant: {
      baseline: partRules('baseline'),
      renamed: partRules('renamed'),
      split: partRules('split'),
      rogue: partRules('rogue'),
    },
    notes: [
      'screw_a and screw_b intentionally share the display label 螺钉.',
      'shroud_left and shroud_right are the legacy project already-split shroud.',
      'A rename changes partNames only; partIds and projection sources stay stable.',
      'A real split changes partIds/rules; affected texels must claim the new source.',
      'The rogue variant removes the legal cover and leaves only rail_back, facing away from the ray.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'maintenance-manifest.json'), JSON.stringify(manifest, null, 2));

  const projectionMaintenance = {
    schema: 'geometry-baker/projection-maintenance/v1',
    ...rulesDoc,
    partRules: partRules('baseline'),
    textureOutputs: {
      screw_a: 'screw_a_normal.png',
      screw_b: 'screw_b_normal.png',
      shroud: 'shroud_normal.png',
      bracket: 'bracket_normal.png',
      cover: 'cover_normal.png',
      cover_left: 'cover_left_normal.png',
      cover_right: 'cover_right_normal.png',
      cover_rogue: 'cover_rogue_normal.png',
    },
    unknownCorrespondence: {
      statusCode: 5,
      statusName: 'unknown_correspondence',
      color: [64, 220, 220],
      action: 'mark and withhold; never infer a source from a label or external tool default',
    },
  };
  fs.writeFileSync(path.join(outDir, 'projection-maintenance.json'),
    JSON.stringify(projectionMaintenance, null, 2));
  files.push('maintenance-manifest.json', 'projection-maintenance.json');
  return { outDir, files };
}

function main() {
  const outDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'samples', 'maintenance');
  const { files } = writeSampleSet(outDir);
  console.log(`wrote maintenance part set to ${outDir} (${files.length} files)`);
}

if (require.main === module) main();
module.exports = { writeSampleSet };
