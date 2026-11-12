// Preparation needs development tooling, as Husky and code generators do.
const fs = require('node:fs');
const ms = require('ms');
if (ms('1s') !== 1000) throw new Error('development tool unavailable');
fs.writeFileSync('prepared.json', JSON.stringify({ prepared: true }) + '\n');
