const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync('resolved.txt', 'utf8'), '1.2.3\n');
assert.deepEqual(JSON.parse(fs.readFileSync('prepared.json')), {
  node: process.execPath,
  abi: process.versions.modules,
  version: '1.2.3',
});
console.log('hoisted dependency CLI ran during prepare with the SDK Node');
