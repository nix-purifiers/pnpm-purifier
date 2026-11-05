const fs = require('node:fs');
fs.mkdirSync('public', {recursive: true});
fs.writeFileSync('public/proof.mjs', "import { answer } from './helper.mjs'; export default answer;\n");
fs.writeFileSync('public/helper.mjs', 'export const answer = 42;\n');
