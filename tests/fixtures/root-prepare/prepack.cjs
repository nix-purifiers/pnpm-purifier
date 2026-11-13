const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
delete manifest.devDependencies;
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
