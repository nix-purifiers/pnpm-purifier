#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Compare independently installed giget with purifier and sandboxed outputs."""
import json
import os
from pathlib import Path
import runpy
import shutil
import tempfile

helpers = runpy.run_path(str(Path(__file__).with_name('version-runtime.py')))
command, ROOT = helpers['command'], helpers['ROOT']


def main():
    assert command('nix', 'config', 'show', 'sandbox') == 'true'
    system = command('nix', 'eval', '--impure', '--raw', '--expr', 'builtins.currentSystem')
    print('producer:', command('git', 'rev-parse', 'HEAD'), 'system:', system, flush=True)
    source_lock_before = (ROOT / 'flake.lock').read_bytes()
    snapshot = json.loads(command('nix', 'flake', 'archive', '--json', '--no-update-lock-file', str(ROOT)))['path']
    assert (ROOT / 'flake.lock').read_bytes() == source_lock_before
    assert Path(snapshot).resolve(strict=True).is_dir()
    assert str(Path(snapshot).resolve()) == snapshot
    command('nix', 'path-info', '--json', snapshot)
    with tempfile.TemporaryDirectory(prefix='pnpm-giget-runtime-') as temporary:
        temporary = Path(temporary)
        command('nix-store', '--add-root', temporary / 'source', '--realise', snapshot)
        (temporary / 'run').mkdir(mode=0o700)
        env = dict(os.environ, PNPM_RUNTIME_SOURCE=snapshot, NO_COLOR='1', pnpm_config_pm_on_fail='ignore',
                   npm_config_manage_package_manager_versions='false',
                   XDG_DATA_HOME=str(temporary / 'data'), XDG_CACHE_HOME=str(temporary / 'cache'),
                   XDG_RUNTIME_DIR=str(temporary / 'run'))
        env.pop('FORCE_COLOR', None)
        prefix = 'let f=builtins.getFlake ("path:"+builtins.getEnv "PNPM_RUNTIME_SOURCE"); p=import f.inputs.nixpkgs {overlays=[f.overlays.default];}; in '
        node = Path(command('nix', 'build', '--impure', '--expr', prefix + 'p.nodejs', '--out-link', temporary / 'node', '--print-out-paths', env=env))
        pnpm = Path(command('nix', 'build', '--impure', '--expr', prefix + 'p.pnpm_11', '--out-link', temporary / 'pnpm', '--print-out-paths', env=env)) / 'bin/pnpm'
        env['PATH'] = str(node / 'bin') + ':' + env['PATH']
        print('Node:', command(node / 'bin/node', '--version', env=env), 'pnpm:', command(pnpm, '--version', env=env), flush=True)
        source = Path(command('nix', 'eval', '--impure', '--raw', '--expr', '(builtins.fetchTree {type="github";owner="unjs";repo="giget";rev="f1dad453055b97a81d5227edce7262c8dcaf53d2";narHash="sha256-hDKGYxozIV8UQTbPpJVs6jrDiPmcHK2EWRZ7WNfSYQ0=";}).outPath'))
        print('sample: unjs/giget f1dad453055b97a81d5227edce7262c8dcaf53d2', flush=True)
        native, project = temporary / 'native', temporary / 'purifier'
        for destination in (native, project):
            shutil.copytree(source, destination)
            destination.chmod(destination.stat().st_mode | 0o700)
            for path in destination.rglob('*'):
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode | 0o200)
        command(pnpm, 'install', '--frozen-lockfile', '--store-dir', temporary / 'native-store', cwd=native, env=env)
        command(pnpm, 'run', 'build', cwd=native, env=env)
        native_help = command(node / 'bin/node', 'dist/cli.mjs', '--help', cwd=native, env=env)
        assert 'giget v3.3.1' in native_help
        cli = Path(command('nix', 'build', str(ROOT) + '#cli', '--out-link', temporary / 'cli', '--print-out-paths')) / 'bin/pnpm-purifier'
        before = (project / 'pnpm-lock.yaml').read_bytes()
        command(cli, 'lock', cwd=project, env=env)
        assert (project / 'pnpm-lock.yaml').read_bytes() == before
        command(cli, 'prefetch', cwd=project, env=env)
        command(cli, 'install', '--frozen-lockfile', '--store-dir', temporary / 'purifier-store', cwd=project, env=env)
        command(cli, 'run', 'build', cwd=project, env=env)
        assert command(node / 'bin/node', 'dist/cli.mjs', '--help', cwd=project, env=env) == native_help
        command('nix', 'build', str(ROOT) + '#checks.' + system + '.real-world', '--out-link', temporary / 'pure', env=env)
        assert (project / 'pnpm-lock.yaml').read_bytes() == before
        print('PASS pinned giget independent native and purifier install/build/help, sandbox build/runtime', flush=True)


if __name__ == '__main__':
    main()
