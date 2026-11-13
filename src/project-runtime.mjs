// SPDX-License-Identifier: MIT
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const marker = "// pnpm-purifier runtime source: ";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function executable(command, env = process.env) {
  const candidates = command.includes(path.sep) ? [path.resolve(command)] : (env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir || ".", command));
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch (error) {
      if (error.code === "ELOOP") throw new Error(`Recursive executable link: ${file}`);
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Required executable is not on PATH: ${command}`);
}

export function inspectNode(env = process.env) {
  let selected;
  try { selected = executable("node", env); }
  catch (error) {
    if (!error.message.startsWith("Required executable")) throw error;
    if (env.npm_node_execpath) selected = executable(env.npm_node_execpath, env);
    else if (env.PNPM_PURIFIER_IMPLEMENTATION_HELPER !== "1") selected = process.execPath;
    else throw new Error("Local adoption needs the existing project Node on PATH; the implementation helper is not a project runtime");
  }
  const query = 'JSON.stringify({executable:process.execPath,version:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch})';
  const result = spawnSync(selected, ["-p", query], { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect the existing project Node runtime ${selected}: ${result.error?.message ?? result.stderr}`);
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw new Error(`The existing runtime ${selected} did not return Node runtime identity`); }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.version ?? "") || !/^\d+$/.test(info.abi ?? "") || !path.isAbsolute(info.executable ?? "") || !info.platform || !info.arch) {
    throw new Error(`The existing runtime ${selected} lacks usable Node version/ABI identity`);
  }
  return { ...info, executable: executable(info.executable, env) };
}

function programSource(file, self, seen = new Set()) {
  file = fs.realpathSync(file);
  if (seen.has(file)) throw new Error(`Recursive package-manager launcher: ${file}`);
  seen.add(file);
  const data = fs.readFileSync(file);
  const text = data.subarray(0, 16384).toString("utf8");
  if (file === self || (text.startsWith("#!") && text.includes(self))) throw new Error(`Package manager resolves to pnpm-purifier itself: ${file}`);
  const line = text.split("\n").find(value => value.startsWith(marker));
  if (line) return programSource(JSON.parse(line.slice(marker.length)), self, seen);
  return { file, data };
}

export class ProjectRuntime {
  constructor({ env = process.env, pnpm, self }) {
    this.originalEnv = { ...env };
    this.node = inspectNode(env);
    this.self = fs.realpathSync(self);
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-runtime-"));
    this.bin = path.join(this.directory, "bin");
    fs.mkdirSync(this.bin);
    fs.symlinkSync(this.node.executable, path.join(this.bin, "node"));
    this.programs = new Map();
    try {
      this.manager = this.add("pnpm", executable(pnpm, env));
      for (const name of ["npm", "npx"]) {
        let file;
        try { file = executable(name, env); } catch (error) { if (!error.message.startsWith("Required executable")) throw error; }
        if (file) this.add(name, file);
      }
    } catch (error) { this.close(); throw error; }
  }

  add(name, file) {
    const original = programSource(file, this.self);
    const head = original.data.subarray(0, 1024).toString("utf8").split("\n")[0];
    let target = original.file;
    if (/\.[cm]?js$/.test(original.file) || /^#!.*\bnode(?:\s|$)/.test(head)) {
      let root = path.dirname(original.file);
      while (!fs.existsSync(path.join(root, "package.json")) && path.dirname(root) !== root) root = path.dirname(root);
      if (path.dirname(root) === root) root = path.dirname(original.file);
      const destination = path.join(this.directory, name);
      const relative = path.relative(root, original.file).split(path.sep);
      const mirror = (source, output, parts) => {
        fs.mkdirSync(output);
        for (const entry of fs.readdirSync(source)) {
          if (entry === parts[0]) {
            if (parts.length > 1) mirror(path.join(source, entry), path.join(output, entry), parts.slice(1));
          } else fs.symlinkSync(path.join(source, entry), path.join(output, entry));
        }
      };
      mirror(root, destination, relative);
      target = path.join(destination, ...relative);
      const shell = executable("sh", this.originalEnv);
      if (/\s/.test(shell)) throw new Error(`Helper shell path cannot be used as an interpreter: ${shell}`);
      const body = original.data.toString("utf8").replace(/^#![^\n]*\n/, "");
      fs.writeFileSync(target, `#!${shell}\n':' //; exec ${quote(this.node.executable)} "$0" "$@"\n${marker}${JSON.stringify(original.file)}\n${body}`, { mode: 0o755 });
    }
    const shim = path.join(this.bin, name);
    fs.symlinkSync(target, shim);
    this.programs.set(original.file, shim);
    this.programs.set(fs.realpathSync(file), shim);
    return original.file;
  }

  environment(env = this.originalEnv) {
    return { ...env, PATH: this.bin + path.delimiter + (env.PATH ?? this.originalEnv.PATH ?? "") };
  }

  command(command) {
    let file;
    try { file = executable(command, this.originalEnv); } catch { return command; }
    return this.programs.get(file) ?? command;
  }

  close() { fs.rmSync(this.directory, { recursive: true, force: true }); }
}
