#!/usr/bin/env node
'use strict';

// Command-line helper for the geometry baker. The graphical entry point is
// web/index.html (see doc/usage.md); the CLI exists for batch runs and CI.
const fs = require('fs');
const path = require('path');
const { parseOBJ } = require('../src/mesh');
const { runBake } = require('../src/runner');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`geometry baker CLI (auxiliary — graphical entry: web/index.html)

Usage:
  node cli.js --low low.obj --high high.obj --out dir/ [options]

Options:
  --size N            texture resolution (default 256)
  --outer-distance F  cage push-out distance (default 0.5)
  --inner-distance F  cage push-in distance (default 0.5)
  --config file.json  load all settings from a saved config
  --save-config file  write the resolved config and exit after baking
  --help              show this message
`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.low && !args.config)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  let config = {
    size: 256,
    outerDistance: 0.5,
    innerDistance: 0.5,
  };
  if (args.config) {
    config = { ...config, ...JSON.parse(fs.readFileSync(args.config, 'utf8')) };
  }
  if (args.low) config.lowPath = args.low;
  if (args.high) config.highPath = args.high;
  if (args.out) config.outDir = args.out;
  // CLI flags use hyphens (--outer-distance) while the config uses camelCase.
  const flagFor = { size: 'size', outerDistance: 'outer-distance', innerDistance: 'inner-distance' };
  for (const k of ['size', 'outerDistance', 'innerDistance']) {
    if (args[flagFor[k]] !== undefined) config[k] = Number(args[flagFor[k]]);
  }
  if (!config.lowPath || !config.highPath || !config.outDir) {
    console.error('error: --low, --high and --out are required');
    process.exit(1);
  }
  const low = parseOBJ(fs.readFileSync(config.lowPath, 'utf8'), 'low');
  const high = parseOBJ(fs.readFileSync(config.highPath, 'utf8'), 'high');
  const outDir = path.resolve(config.outDir);
  const results = runBake(low, high, {
    size: config.size,
    outerDistance: config.outerDistance,
    innerDistance: config.innerDistance,
  }, outDir);
  if (args['save-config']) {
    fs.writeFileSync(args['save-config'], JSON.stringify(config, null, 2));
  }
  for (const [policy, r] of Object.entries(results)) {
    console.log(`[${policy}] ${JSON.stringify(r.counts)} ` +
      `elapsed ${r.elapsedMs}ms -> ${path.join(outDir, policy)}`);
  }
}

if (require.main === module) main();
