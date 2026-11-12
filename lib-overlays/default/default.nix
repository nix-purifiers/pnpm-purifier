# SPDX-License-Identifier: MIT
#
# The `pnpm-purifier` library namespace: `readLock`, which reads the
# lockfiles of a project into the lock shape of the purifier library
# (lib-overlays/default/read-lock.nix), given the purifier library (`lib.purifier`).
{ ... }:
{

  overlay = final: prev: {
    pnpm-purifier = (prev.pnpm-purifier or { }) // {
      readLock = import ./read-lock.nix { inherit (final) purifier; };
    };
  };

}
