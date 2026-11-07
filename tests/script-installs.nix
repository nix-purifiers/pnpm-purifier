# SPDX-License-Identifier: MIT
{ pkgs, buildPnpmProject }:
let
  pnpm = pkgs.callPackage ./current-pnpm.nix { };
  project = buildPnpmProject {
    src = ./fixtures/script-installs;
    inherit pnpm;
  };
in
pkgs.runCommand "pnpm-current-cold-script-installs"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.nodejs
    ];
    PNPM_TEST_SOURCE = ./fixtures/script-installs;
    PNPM_TEST_PNPM = "${pnpm}/bin/pnpm";
    PNPM_TEST_NODE = "${pkgs.nodejs}/bin/node";
    PNPM_TEST_CLI = "${../src}/pnpm-purifier.mjs";
    PNPM_TEST_MANIFEST = project.dependencies;
    PNPM_TEST_REGISTRIES = project.registriesFile;
    PNPM_TEST_SYSTEM = pkgs.stdenv.hostPlatform.system;
  }
  ''
    export PNPM_TEST_RESULTS="$out"
    python ${./script-installs.py}
  ''
