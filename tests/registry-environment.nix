# SPDX-License-Identifier: MIT
{ pkgs, buildPnpmProject }:
let
  project = buildPnpmProject {
    src = ./fixtures/versions/10;
    pnpm = pkgs.pnpm_10;
  };
in
pkgs.runCommand "pnpm-project-registry-environment"
  {
    ${if pkgs.stdenv.hostPlatform.isDarwin then "__darwinAllowLocalNetworking" else null} = true;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpm_10
    ];
  }
  ''
    ${pkgs.python3}/bin/python3 ${./loopback.py}
    export HOME="$TMPDIR/home" XDG_RUNTIME_DIR="$TMPDIR/run"
    mkdir -p "$HOME" "$XDG_RUNTIME_DIR" project
    cp -r ${./fixtures/versions/10}/. project/
    chmod -R u+w project
    cd project
    # A project setting takes precedence over the generated user config.
    echo 'registry=https://registry.npmjs.org/' > .npmrc
    sha256sum package.json pnpm-lock.yaml .npmrc > before
    node ${../src}/pnpm-purifier.mjs registry-exec \
      --manifest ${project.dependencies} --registries ${project.registriesFile} -- \
      pnpm install --frozen-lockfile --ignore-scripts \
        --config.fetch-retries=0 --store-dir "$TMPDIR/fresh-store"
    node -e 'if (require("ms")("1h") !== 3600000) process.exit(1)'
    sha256sum -c before
    touch "$out"
  ''
