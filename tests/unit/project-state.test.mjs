// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertStateUnchanged,
  createStateOperation,
  dependencyState,
  targetRoot,
  writeStateJson,
} from "../../src/project-state.mjs";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "purifier-state-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project's λ");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"state-fixture"}\n');
  const options = { toolLockfile: path.join(root, "pnpm-lock.yaml"), lockfile: path.join(base, "external-lock.json") };
  fs.writeFileSync(options.toolLockfile, "lock-A\n");
  const cache = path.join(base, "cache's λ");
  return { base, root, options, cache, env: { XDG_CACHE_HOME: cache } };
}

test("state has canonical project identity, fresh dependency snapshots and exclusive operations", (t) => {
  const f = fixture(t);
  const alias = path.join(f.base, "alias");
  fs.symlinkSync(f.root, alias, "dir");
  const a = dependencyState(f.root, f.options);
  assert.deepEqual(dependencyState(alias, f.options), a);
  const one = createStateOperation(f.root, f.options, "realize", f.env);
  const two = createStateOperation(alias, f.options, "realize", f.env);
  assert.notEqual(one.directory, two.directory);
  assert.equal(one.dependencyHash, two.dependencyHash);
  assert.equal(fs.statSync(one.directory).mode & 0o077, 0);
  assert.ok(!one.directory.startsWith(f.root + path.sep));
  fs.writeFileSync(f.options.toolLockfile, "lock-B\n");
  assert.throws(() => assertStateUnchanged(one), /dependency inputs changed/);
  const b = createStateOperation(f.root, f.options, "realize", f.env);
  assert.notEqual(b.dependencyHash, a.dependencyHash);
  fs.writeFileSync(f.options.toolLockfile, "lock-A\n");
  assert.equal(dependencyState(f.root, f.options).dependencyHash, a.dependencyHash);
  assertStateUnchanged(one);
  assert.ok(fs.existsSync(two.directory));
});

test("outside-project cache validation rejects aliases, dangling links and unsafe namespaces", (t) => {
  const f = fixture(t);
  assert.throws(() => createStateOperation(f.root, f.options, "realize", { XDG_CACHE_HOME: path.join(f.root, "cache") }), /outside the project/);
  const alias = path.join(f.base, "cache-alias");
  fs.symlinkSync(f.root, alias, "dir");
  assert.throws(() => createStateOperation(f.root, f.options, "realize", { XDG_CACHE_HOME: path.join(alias, "missing") }), /outside the project/);
  const dangling = path.join(f.base, "dangling");
  fs.symlinkSync(path.join(f.root, "missing"), dangling, "dir");
  assert.throws(() => createStateOperation(f.root, f.options, "realize", { XDG_CACHE_HOME: dangling }));
  fs.mkdirSync(f.cache, { mode: 0o700 });
  fs.symlinkSync(f.root, path.join(f.cache, "pnpm-purifier"), "dir");
  assert.throws(() => createStateOperation(f.root, f.options, "realize", f.env), /unsafe generated-state/);
  assert.ok(!fs.existsSync(path.join(f.root, "v1")));
});

test("persisted views remain private and actual tool targets never share a role link", (t) => {
  const f = fixture(t);
  const state = createStateOperation(f.root, f.options, "inputs", f.env);
  const file = path.join(state.directory, "input-views.json");
  writeStateJson(file, [{ repository: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-repository" }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const later = createStateOperation(f.root, f.options, "inputs", f.env);
  assert.notEqual(later.directory, state.directory);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), [{ repository: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-repository" }]);
  assert.notEqual(targetRoot(state, "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-node"), targetRoot(state, "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-node"));
  assert.throws(() => targetRoot(state, "/tmp/node"), /store root/);
  assert.ok(!fs.existsSync(path.join(f.root, ".pnpm-purifier")));
});

// A child manifest can change without a simultaneous lockfile write.
test("known workspace importer manifests detect drift, restoration and missing files", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.options.toolLockfile, "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  'packages/child': {}\n  packages/missing: {}\n");
  const child = path.join(f.root, "packages/child/package.json");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  const original = '{"name":"child","dependencies":{"ms":"2.1.3"}}\n';
  fs.writeFileSync(child, original);
  const one = createStateOperation(f.root, f.options, "realize", f.env);
  assert.equal(one.snapshot.importerManifests.length, 3);
  assert.equal(one.snapshot.importerManifests.find((file) => file.path.endsWith("/missing/package.json")).sha256, null);
  fs.writeFileSync(child, '{"name":"child","dependencies":{"ms":"2.1.2"}}\n');
  assert.throws(() => assertStateUnchanged(one), /dependency inputs changed/);
  const two = createStateOperation(f.root, f.options, "realize", f.env);
  assert.notEqual(two.dependencyHash, one.dependencyHash);
  fs.writeFileSync(child, original);
  assertStateUnchanged(one);
  assert.equal(dependencyState(f.root, f.options).dependencyHash, one.dependencyHash);
  fs.unlinkSync(child);
  assert.throws(() => assertStateUnchanged(one), /dependency inputs changed/);
  fs.writeFileSync(child, original);
  const missing = path.join(f.root, "packages/missing/package.json");
  fs.mkdirSync(path.dirname(missing), { recursive: true });
  fs.writeFileSync(missing, '{"name":"new-child"}\n');
  assert.throws(() => assertStateUnchanged(one), /dependency inputs changed/);
  assert.ok(fs.existsSync(two.directory));
});

test("workspace importer identity rejects lexical and physical escapes", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.options.toolLockfile, "lockfileVersion: '9.0'\nimporters:\n  ../outside: {}\n");
  assert.throws(() => dependencyState(f.root, f.options), /escapes the project/);
  fs.symlinkSync(f.base, path.join(f.root, "alias"), "dir");
  fs.writeFileSync(f.options.toolLockfile, "lockfileVersion: '9.0'\nimporters:\n  alias: {}\n");
  assert.throws(() => dependencyState(f.root, f.options), /escapes the project/);
});
