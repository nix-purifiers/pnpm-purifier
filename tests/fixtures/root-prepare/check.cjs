#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.equal(require('./prepared.json').prepared, true);
assert.equal(Object.hasOwn(require('./package.json'), 'devDependencies'), false);
assert.equal(typeof require('picocolors').red, 'function');
assert.equal(fs.existsSync(path.join(__dirname, 'node_modules/ms')), false);
console.log('prepare retained; development dependency pruned');
