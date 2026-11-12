const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.equal(require("./tests/fixtures/node_modules/versionless-package").answer, 42);
assert.equal(fs.existsSync(path.join(__dirname, "node_modules/host-only/marker")), false);
assert.equal(fs.existsSync(path.join(__dirname, "../../node_modules/host-only/marker")), false);
fs.writeFileSync("verified.json", JSON.stringify({ fixture: 42, hostModulesExcluded: true }));
