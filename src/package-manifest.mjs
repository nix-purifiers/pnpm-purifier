// SPDX-License-Identifier: MIT
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Lifecycle scripts may clean development metadata before packing, but they
// cannot select a different production graph after the frozen installation.
export function assertProductionDependenciesUnchanged(installed, prepared) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "dependenciesMeta"]) {
    if (!isDeepStrictEqual(installed[field] ?? {}, prepared[field] ?? {})) {
      throw new Error(`Production dependency metadata changed during lifecycle scripts: ${field}. Update and lock it before building.`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installedFile, preparedFile] = process.argv.slice(2);
  if (!installedFile || !preparedFile) throw new Error("usage: package-manifest.mjs INSTALLED_JSON PREPARED_JSON");
  assertProductionDependenciesUnchanged(JSON.parse(fs.readFileSync(installedFile, "utf8")), JSON.parse(fs.readFileSync(preparedFile, "utf8")));
}
