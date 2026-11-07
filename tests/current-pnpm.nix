# SPDX-License-Identifier: MIT
# An exact upstream source build, independent of the older nixpkgs SDK pin.
{ pnpm_12, lib }:
pnpm_12.override {
  version = "12.18.0";
  srcHash = "sha256-4mN9hcQVZcOU8A7pU4FTRR+m6U1NJHKSs/AY+drZD3w=";
  cargoHash = "sha256-zz3ypFc8XRkxeZf7x+cMXuMMdm9GGgFeilDE/4mh5D0=";
  # Upstream Cargo.lock already has webpki-root-certs 1.0.10 and
  # rustls-webpki 0.103.16, the two changes in nixpkgs' 12.9 patch.
  cargoPatches = [ ];
}
