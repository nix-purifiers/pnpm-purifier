const fs = require('node:fs');
fs.writeFileSync('prepared.json', JSON.stringify({
  node: process.execPath,
  abi: process.versions.modules,
  version: require('semver').valid('1.2.3'),
}));
