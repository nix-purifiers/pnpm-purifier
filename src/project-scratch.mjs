// SPDX-License-Identifier: MIT
// Temporary project copies must not borrow an ancestor repository's hooks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const allocated = new Set();
const targetVariables = new Set([
  "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS",
]);
function reject(reason) {
  throw new Error(`pnpm-purifier: unsafe temporary project: ${reason}; set TMPDIR to a directory outside every Git repository and remove repository-target Git overrides`);
}
function physical(file) {
  let ancestor = path.resolve(file);
  const tail = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      return path.join(fs.realpathSync(ancestor), ...tail);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
export function assertGitFree(directory, environment = process.env) {
  for (const [key, value] of Object.entries(environment)) {
    if (value && (targetVariables.has(key) || /^GIT_CONFIG_(COUNT|KEY_.*|VALUE_.*)$/.test(key))) reject(`ambient ${key}`);
  }
  const canonical = fs.realpathSync(directory);
  for (let ancestor = canonical; ; ancestor = path.dirname(ancestor)) {
    try {
      fs.lstatSync(path.join(ancestor, ".git"));
      reject(`Git metadata in ${ancestor}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  return canonical;
}
export function assertProjectScratch(directory, environment = process.env) {
  const canonical = assertGitFree(directory, environment);
  const git = environment.PNPM_PURIFIER_GIT || "git";
  const config = spawnSync(git, ["config", "--includes", "--show-origin", "--null", "--get-regexp", "^core\\.(hookspath|worktree)$"], {
    cwd: canonical, env: environment, encoding: "utf8",
  });
  if (config.error || ![0, 1].includes(config.status)) reject(`cannot audit effective Git configuration: ${config.error?.message || config.stderr}`);
  const fields = config.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const origin = fields[index];
    const entry = fields[index + 1];
    const newline = entry.indexOf("\n");
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    if (!value || !within(canonical, physical(path.resolve(canonical, value)))) reject(`external ${key} from ${origin}`);
  }
  return canonical;
}
export function projectScratch(prefix) {
  const parent = assertGitFree(os.tmpdir());
  // Audit before allocation too; the actual allocated context is checked below.
  assertProjectScratch(parent);
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) reject(`non-private scratch ${directory}`);
  assertProjectScratch(directory);
  allocated.add(directory);
  return directory;
}
export function guardScratchRun(directory, environment = process.env) {
  const absolute = path.resolve(directory);
  if ([...allocated].some((root) => within(root, absolute))) assertProjectScratch(absolute, environment);
}
