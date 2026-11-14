// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertGitFree, assertProjectScratch, projectScratch, guardScratchRun } from "../../src/project-scratch.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purifier-scratch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  return { root, env };
}
test("temporary project ancestry rejects real, aliased and dangling Git entries", (t) => {
  const f = fixture(t);
  assert.equal(assertGitFree(f.root, f.env), fs.realpathSync(f.root));
  const outer = path.join(f.root, "outer");
  fs.mkdirSync(outer);
  fs.mkdirSync(path.join(outer, ".git"));
  const child = path.join(outer, "child");
  fs.mkdirSync(child);
  assert.throws(() => assertGitFree(child, f.env), /Git metadata/);
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(child, alias, "dir");
  assert.throws(() => assertGitFree(alias, f.env), /Git metadata/);
  const dangling = path.join(f.root, "dangling");
  fs.mkdirSync(dangling);
  fs.symlinkSync(path.join(f.root, "absent"), path.join(dangling, ".git"));
  assert.throws(() => assertGitFree(dangling, f.env), /Git metadata/);
});
test("scratch Git audit rejects environment and effective external target config", (t) => {
  const f = fixture(t);
  for (const overrides of [{ GIT_DIR: f.root }, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: f.root }]) {
    assert.throws(() => assertProjectScratch(f.root, { ...f.env, ...overrides }), /ambient GIT_/);
  }
  const config = path.join(f.root, "gitconfig");
  fs.writeFileSync(config, '[user]\n  name = ordinary caller\n');
  const env = { ...f.env, GIT_CONFIG_GLOBAL: config };
  assert.equal(assertProjectScratch(f.root, env), fs.realpathSync(f.root));
  fs.appendFileSync(config, '[core]\n  hooksPath = /outside/hooks\n');
  assert.throws(() => assertProjectScratch(f.root, env), /external core.hookspath/);
  const included = path.join(f.root, "included");
  fs.writeFileSync(included, '[core]\n  worktree = /outside/worktree\n');
  fs.writeFileSync(config, `[include]\n  path = ${included}\n`);
  assert.throws(() => assertProjectScratch(f.root, env), /external core.worktree/);
});
test("allocated project scratch is private and rechecked immediately before a child", (t) => {
  const directory = projectScratch("purifier-owned-scratch-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(fs.statSync(directory).mode & 0o077, 0);
  const child = path.join(directory, "project");
  fs.mkdirSync(child);
  guardScratchRun(child);
  fs.writeFileSync(path.join(directory, ".git"), "gitdir: outside\n");
  assert.throws(() => guardScratchRun(child), /Git metadata/);
});
