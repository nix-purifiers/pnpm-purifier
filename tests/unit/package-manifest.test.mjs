// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertProductionDependenciesUnchanged } from "../../src/package-manifest.mjs";

test("packing can remove development tooling and scripts while retaining production dependencies", () => {
  const original = { version: "1.0.0", dependencies: { b: "2", a: "1" }, devDependencies: { tooling: "3" }, scripts: { prepack: "clean" }, packageManager: "pnpm@10.34.7" };
  const packed = { version: "1.0.1", dependencies: { a: "1", b: "2" } };
  assertProductionDependenciesUnchanged(original, packed);
  assert.equal(original.devDependencies.tooling, "3");
});

test("production dependency and peer metadata changes are rejected", () => {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "dependenciesMeta"]) {
    assert.throws(() => assertProductionDependenciesUnchanged({ [field]: { dependency: "1" } }, { [field]: { dependency: "2" } }), new RegExp(field));
    assert.throws(() => assertProductionDependenciesUnchanged({ [field]: { dependency: "1" } }, {}), new RegExp(field));
  }
});

test("empty and absent production sections are equivalent", () => {
  assertProductionDependenciesUnchanged({ dependencies: {}, devDependencies: { tooling: "1" } }, {});
  assertProductionDependenciesUnchanged({}, { dependencies: {} });
});

test("the build-time manifest check diagnoses drift without modifying either file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "package-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installed = path.join(directory, "installed.json");
  const packed = path.join(directory, "packed.json");
  const helper = fileURLToPath(new URL("../../src/package-manifest.mjs", import.meta.url));
  fs.writeFileSync(installed, '{"dependencies":{"example":"1"},"devDependencies":{"tooling":"1"}}');
  fs.writeFileSync(packed, '{"dependencies":{"example":"1"}}');
  const initial = fs.readFileSync(installed, "utf8");
  assert.equal(spawnSync(process.execPath, [helper, installed, packed]).status, 0);
  fs.writeFileSync(packed, '{"dependencies":{"example":"2"}}');
  const failure = spawnSync(process.execPath, [helper, installed, packed], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Production dependency metadata changed.*dependencies/);
  assert.equal(fs.readFileSync(installed, "utf8"), initial);
  assert.equal(fs.readFileSync(packed, "utf8"), '{"dependencies":{"example":"2"}}');
});
