// SPDX-License-Identifier: MIT
// Generated state is private, append-only, and never part of the project tree.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

// Resolve existing ancestors too, so a not-yet-created cache cannot hide a
// symlink into the project behind its missing final component.
function physical(file) {
  let parent = path.resolve(file);
  const tail = [];
  for (;;) {
    try {
      fs.lstatSync(parent);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      tail.unshift(path.basename(parent));
      parent = next;
      continue;
    }
    return path.join(fs.realpathSync(parent), ...tail);
  }
}

function within(parent, file) {
  const relative = path.relative(parent, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function ownedDirectory(directory, privateMode) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.getuid && stat.uid !== process.getuid())
      || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw new Error(`pnpm-purifier: unsafe generated-state directory: ${directory}`);
  }
}

function privateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  ownedDirectory(directory, true);
  return directory;
}

function cacheBase(project, environment) {
  const configured = environment.XDG_CACHE_HOME;
  const chosen = configured && path.isAbsolute(configured)
    ? configured : path.join(os.homedir(), ".cache");
  const base = physical(chosen);
  if (within(project, base)) {
    throw new Error("pnpm-purifier: XDG_CACHE_HOME must resolve outside the project");
  }
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (physical(base) !== base || within(project, physical(base))) {
    throw new Error("pnpm-purifier: generated-state cache location changed during creation");
  }
  ownedDirectory(base, false);
  return base;
}

function fileIdentity(file) {
  try {
    return { path: physical(file), sha256: digest(fs.readFileSync(file)) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { path: physical(file), sha256: null };
  }
}

export function dependencyState(root, options) {
  const project = fs.realpathSync(root);
  const snapshot = stable({
    schema: 1,
    project,
    toolLock: fileIdentity(options.toolLockfile),
    supplementalLock: fileIdentity(options.lockfile),
    manifest: fileIdentity(path.join(project, "package.json")),
    workspace: fileIdentity(path.join(project, "pnpm-workspace.yaml")),
    npmrc: fileIdentity(path.join(project, ".npmrc")),
    inputs: options.inputs ?? null,
    library: options.library ?? null,
    nixpkgs: options.nixpkgs ?? null,
    builder: options.builder ?? null,
    platform: process.platform,
    arch: process.arch,
  });
  return { project, projectHash: digest(project), dependencyHash: digest(JSON.stringify(snapshot)), snapshot };
}

export function writeStateJson(file, value) {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function createStateOperation(root, options, kind, environment = process.env) {
  if (!["realize", "inputs"].includes(kind)) throw new Error("pnpm-purifier: invalid state operation");
  const identity = dependencyState(root, options);
  let directory = cacheBase(identity.project, environment);
  for (const component of ["pnpm-purifier", "v1", identity.projectHash, identity.dependencyHash, "operations"]) {
    directory = privateDirectory(path.join(directory, component));
  }
  directory = fs.mkdtempSync(path.join(directory, `${kind}-`));
  ownedDirectory(directory, true);
  const roots = privateDirectory(path.join(directory, "roots"));
  const operation = { ...identity, root, options, directory, roots };
  writeStateJson(path.join(directory, "operation.json"), { kind, ...identity });
  return operation;
}

export function assertStateUnchanged(operation) {
  if (dependencyState(operation.root, operation.options).dependencyHash !== operation.dependencyHash) {
    throw new Error("pnpm-purifier: dependency inputs changed during state realization; rerun explicitly");
  }
}

export function targetRoot(operation, storePath) {
  if (path.dirname(storePath) !== "/nix/store") throw new Error("pnpm-purifier: expected a store root");
  return path.join(operation.roots, path.basename(storePath));
}
