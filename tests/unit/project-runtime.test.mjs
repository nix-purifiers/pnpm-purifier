// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { executable, inspectNode, ProjectRuntime } from "../../src/project-runtime.mjs";

const self = fileURLToPath(new URL("../../src/pnpm-purifier.mjs", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "host runtime", "bin"); fs.mkdirSync(bin, { recursive: true });
  const node = path.join(bin, "node"); fs.copyFileSync(process.execPath, node, fs.constants.COPYFILE_FICLONE); fs.chmodSync(node, 0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const sdk = path.join(root, "manager"); fs.mkdirSync(path.join(sdk, "bin"), { recursive: true });
  fs.writeFileSync(path.join(sdk, "package.json"), '{"name":"manager-fixture","version":"1"}');
  fs.writeFileSync(path.join(sdk, "token.json"), '{"relativeImport":"preserved"}');
  const manager = path.join(sdk, "bin", "pnpm.cjs");
  fs.writeFileSync(manager, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv[2]==='nested'){const r=spawnSync(process.argv[1],['identity'],{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status;}else{console.log(JSON.stringify({executable:process.execPath,abi:process.versions.modules,relative:require('../token.json').relativeImport}));}\n`, { mode: 0o755 });
  return { root, bin, node, env, manager };
}

test("existing non-store Node identity is queried without a runtime version table", (t) => {
  const { node, env } = fixture(t);
  const info = inspectNode(env);
  assert.equal(info.executable, node);
  assert.equal(info.version, process.versions.node);
  assert.equal(info.abi, process.versions.modules);
  assert.ok(!info.executable.startsWith("/nix/store/"));
});

test("JS manager, relative imports and direct recursive invocation preserve the host runtime", (t) => {
  const { node, env, manager } = fixture(t);
  const original = fs.readFileSync(manager);
  const runtime = new ProjectRuntime({ env, pnpm: manager, self });
  t.after(() => runtime.close());
  for (const mode of ["identity", "nested"]) {
    const r = spawnSync(runtime.command(manager), [mode], { env: runtime.environment(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { executable: node, abi: process.versions.modules, relative: "preserved" });
  }
  assert.deepEqual(fs.readFileSync(manager), original);
});

test("inherited adapter launchers unwrap to the original manager rather than nesting mirrors", (t) => {
  const { env, manager, node } = fixture(t);
  const first = new ProjectRuntime({ env, pnpm: manager, self });
  const second = new ProjectRuntime({ env: first.environment(), pnpm: "pnpm", self });
  t.after(() => { second.close(); first.close(); });
  assert.equal(second.manager, manager);
  const r = spawnSync(second.command("pnpm"), ["nested"], { env: second.environment(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).executable, node);
});

test("invalid ABI identity does not silently fall back to the helper runtime", (t) => {
  const { bin, env } = fixture(t);
  fs.unlinkSync(path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\nprintf \'{"version":"26.13.0","abi":"invalid","executable":"/fake/node","platform":"linux","arch":"x64"}\'\n', { mode: 0o755 });
  assert.throws(() => inspectNode(env), /version\/ABI identity/);
});

test("self managers and cyclic adapter metadata fail before recursive process execution", (t) => {
  const { env, root } = fixture(t);
  const wrapper = path.join(root, "purifier-wrapper");
  fs.writeFileSync(wrapper, `#!/bin/sh\n# ${self}\nexit 0\n`, { mode: 0o755 });
  assert.throws(() => new ProjectRuntime({ env, pnpm: wrapper, self }), /pnpm-purifier itself/);
  const a = path.join(root, "a.cjs"), b = path.join(root, "b.cjs");
  fs.writeFileSync(a, `#!/bin/sh\n// pnpm-purifier runtime source: ${JSON.stringify(b)}\n`, { mode: 0o755 });
  fs.writeFileSync(b, `#!/bin/sh\n// pnpm-purifier runtime source: ${JSON.stringify(a)}\n`, { mode: 0o755 });
  assert.throws(() => new ProjectRuntime({ env, pnpm: a, self }), /Recursive package-manager/);
  const link = path.join(root, "loop"); fs.symlinkSync(link, link);
  assert.throws(() => executable(link, env), /Recursive executable/);
});

test("packaged helper cannot substitute for a missing project runtime", (t) => {
  const { root, node } = fixture(t);
  const empty = path.join(root, "empty"); fs.mkdirSync(empty);
  const env = { PATH: empty, PNPM_PURIFIER_IMPLEMENTATION_HELPER: "1" };
  assert.throws(() => inspectNode(env), /implementation helper is not a project runtime/);
  assert.equal(inspectNode({ ...env, npm_node_execpath: node }).executable, node);
});

test("native package managers retain their executable identity", (t) => {
  const { env } = fixture(t);
  const manager = executable("sh", env);
  const runtime = new ProjectRuntime({ env, pnpm: manager, self });
  t.after(() => runtime.close());
  assert.equal(runtime.manager, manager);
  assert.equal(fs.realpathSync(runtime.command(manager)), manager);
  assert.equal(spawnSync(runtime.command(manager), ["-c", "exit 0"], { env: runtime.environment() }).status, 0);
});

test("supplied-input integrity views execute the selected JS manager under the project Node", (t) => {
  const { env, manager, node, root, bin } = fixture(t);
  const identity = path.join(root, "view-runtime.json");
  fs.writeFileSync(manager, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]!=='view')throw new Error('Unexpected manager operation');fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({executable:process.execPath,args:process.argv.slice(2)}));console.log(JSON.stringify('sha512-fixture'));\n`, { mode: 0o755 });
  const catalog = path.join(root, "catalog.json");
  fs.writeFileSync(catalog, JSON.stringify({ modules: [{ primary: false, name: "@test/input", version: "1.0.0", package: {}, integrity: "sha512-fixture", archive: "unused.tgz" }] }));
  // Only the manager-view boundary is exercised. Matching existing integrity
  // skips publication; Nix and input preparation return local fixture paths.
  const preparer = path.join(root, "prepare-inputs");
  fs.writeFileSync(preparer, `#!${process.execPath}\nconsole.log('[{}]');\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "nix"), `#!${process.execPath}\nconsole.log(process.argv[2]==='build'?${JSON.stringify(root)}:${JSON.stringify(catalog)});\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [self, "publish", "--input", "path:fixture"], {
    cwd: root, encoding: "utf8", env: { ...env, NODE_USE_ENV_PROXY: "1", PNPM_PURIFIER_PNPM: manager, PNPM_PURIFIER_PYTHON: preparer, PNPM_PURIFIER_INPUT_TOOLS: root, pnpm_config_global_pnpmfile: "undefined" },
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(fs.readFileSync(identity));
  assert.equal(value.executable, node);
  assert.deepEqual(value.args, ["view", "@test/input@1.0.0", "dist.integrity", "--json"]);
});
