#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise each packaged pnpm major with independent native and Nix installs.

Version numbers and paths come from the committed flake lock. Each lane locks,
prefetches, installs, builds and tests, mutates dependencies, then builds the
same project in Nix's sandbox. No node_modules or pnpm store is shared between
native and purifier installs.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def command(*args, cwd=ROOT, env=None):
    print('+', shlex.join(str(arg) for arg in args), flush=True)
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, text=True, stdout=subprocess.PIPE)
    print(result.stdout, end='', flush=True)
    result.check_returncode()
    return result.stdout.strip()


def assert_store(project, expected):
    text = (project / 'node_modules/.modules.yaml').read_text()
    try:
        actual = json.loads(text)['storeDir']
    except json.JSONDecodeError:
        actual = re.search(r'^storeDir: (.+)$', text, re.MULTILINE)[1].strip('"\'')
    assert Path(actual).resolve().is_relative_to(expected.resolve()), actual


def assert_missing_locked_graph(cli, temporary, env):
    project = temporary / 'missing-locked-graph'
    shutil.copytree(ROOT / 'tests/fixtures/sources', project)
    (project / 'server.js').write_text('console.log("MISSING_LOCK_SCRIPT_MUST_NOT_RUN");\n')
    missing = ROOT / 'tests/fixtures/negative/missing-entry.lock.json'
    cold_env = dict(env, pnpm_config_store_dir=str(temporary / 'missing-graph-store'),
                    npm_config_store_dir=str(temporary / 'missing-graph-store'),
                    pnpm_config_registry='http://127.0.0.1:9/')
    result = subprocess.run([str(cli), '--lockfile', str(missing), 'start'], cwd=project,
                            env=cold_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, flush=True)
    assert result.returncode != 0
    assert '3171b26' in result.stdout and 'pnpm-purifier lock' in result.stdout, result.stdout
    assert 'MISSING_LOCK_SCRIPT_MUST_NOT_RUN' not in result.stdout
    assert 'UNEXPECTED_STORE' not in result.stdout
    print('PASS actual wrapper rejects missing locked graph before fallback start', flush=True)
    return {'status': result.returncode, 'missingLockedGitEntryRejected': True,
            'fallbackScriptNotExecuted': True, 'output': result.stdout}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--current-only', action='store_true',
                        help='Run only the exact maintained pnpm 12.18.0 lane')
    options = parser.parse_args()
    assert command('nix', 'config', 'show', 'sandbox') == 'true'
    system = command('nix', 'eval', '--impure', '--raw', '--expr', 'builtins.currentSystem')
    print('source:', command('git', 'rev-parse', 'HEAD'), 'system:', system, flush=True)
    source_lock_before = (ROOT / 'flake.lock').read_bytes()
    snapshot = json.loads(command('nix', 'flake', 'archive', '--json', '--no-update-lock-file', str(ROOT)))['path']
    assert (ROOT / 'flake.lock').read_bytes() == source_lock_before
    assert Path(snapshot).resolve(strict=True).is_dir()
    assert str(Path(snapshot).resolve()) == snapshot
    command('nix', 'path-info', '--json', snapshot)
    with tempfile.TemporaryDirectory(prefix='pnpm-version-runtime-') as temporary:
        temporary = Path(temporary)
        (temporary / 'run').mkdir(mode=0o700)
        env = dict(os.environ, PNPM_RUNTIME_SOURCE=snapshot, NO_COLOR='1', pnpm_config_pm_on_fail='ignore',
                   npm_config_manage_package_manager_versions='false',
                   XDG_DATA_HOME=str(temporary / 'data'), XDG_CACHE_HOME=str(temporary / 'cache'),
                   XDG_RUNTIME_DIR=str(temporary / 'run'))
        env.pop('FORCE_COLOR', None)
        command('nix-store', '--add-root', temporary / 'source', '--realise', snapshot)
        cli = Path(command('nix', 'build', str(ROOT) + '#cli', '--out-link', temporary / 'cli', '--print-out-paths')) / 'bin/pnpm-purifier'
        prefix = 'let f=builtins.getFlake ("path:"+builtins.getEnv "PNPM_RUNTIME_SOURCE"); p=import f.inputs.nixpkgs {overlays=[f.overlays.default];}; in '
        sdk = Path(command('nix', 'build', '--impure', '--expr', prefix + 'p.nodejs', '--out-link', temporary / 'node', '--print-out-paths', env=env))
        env['PATH'] = str(sdk / 'bin') + ':' + env['PATH']
        print('Node:', command(sdk / 'bin/node', '--version', env=env), flush=True)
        for major in (("current",) if options.current_only else (10, 11, 12)):
            sdk_expression = (
                'p.callPackage (builtins.getEnv "PNPM_RUNTIME_SOURCE" + "/tests/current-pnpm.nix") {}'
                if major == 'current' else f'p.pnpm_{major}')
            native = Path(command('nix', 'build', '--impure', '--expr', prefix + sdk_expression, '--out-link', temporary / f'pnpm-{major}', '--print-out-paths', env=env)) / 'bin/pnpm'
            version = command(native, '--version', env=env)
            assert version == '12.18.0' if major == 'current' else version.split('.')[0] == str(major), version
            print('pnpm lane:', version, flush=True)
            env['PNPM_PURIFIER_PNPM'] = str(native)
            project = temporary / f'project-{major}'
            project.mkdir()
            manifest = {'name': 'version-probe', 'version': '1.0.0', 'type': 'module',
                        'packageManager': 'pnpm@' + version, 'bin': {'version-probe': 'index.js'},
                        'scripts': {'build': 'node build.js', 'test': 'node index.js'},
                        'dependencies': {'ms': '2.1.3'}}
            (project / 'package.json').write_text(json.dumps(manifest))
            (project / 'index.js').write_text('#!/usr/bin/env node\nimport assert from "node:assert/strict";import ms from "ms";assert.equal(ms("1h"),3600000);console.log("milliseconds: "+ms("1h"));\n')
            (project / 'server.js').write_bytes((project / 'index.js').read_bytes())
            (project / 'build.js').write_text('import fs from "node:fs";fs.writeFileSync("built.txt","built\\n");\n')
            ordinary = temporary / f'native-{major}'
            shutil.copytree(project, ordinary)
            native_env = dict(env, pnpm_config_store_dir=str(temporary / f'native-store-{major}'),
                              npm_config_store_dir=str(temporary / f'native-store-{major}'))
            command(native, 'install', '--store-dir', temporary / f'native-store-{major}', cwd=ordinary, env=native_env)
            command(native, 'run', 'build', cwd=ordinary, env=native_env)
            expected = command(native, 'test', cwd=ordinary, env=native_env)
            assert 'milliseconds: 3600000' in expected, expected
            assert_store(ordinary, temporary / f'native-store-{major}')
            purifier_store = temporary / f'purifier-store-{major}'
            env.update(pnpm_config_store_dir=str(purifier_store),
                       npm_config_store_dir=str(purifier_store))
            command(cli, 'lock', cwd=project, env=env)
            command(cli, 'prefetch', cwd=project, env=env)
            command(cli, 'install', '--frozen-lockfile', '--store-dir', purifier_store, cwd=project, env=env)
            command(cli, 'run', 'build', cwd=project, env=env)
            actual = command(cli, 'test', cwd=project, env=env)
            assert 'milliseconds: 3600000' in actual, actual
            assert_store(project, purifier_store)
            assert (ordinary / 'built.txt').read_bytes() == (project / 'built.txt').read_bytes()
            if major == 'current':
                # An unreachable configured registry makes a routing bypass
                # fail: only the purifier's locked mirror can supply ms.
                cold_cases = [('exec-version', ['exec', 'node', '--version']),
                              ('script-help', ['run', 'build', '--', '--help']),
                              ('declared-script', ['build']),
                              ('fallback-start', ['start'])]
                for label, arguments in cold_cases:
                    shutil.rmtree(project / 'node_modules')
                    purifier_store = temporary / ('cold-wrapper-' + label)
                    assert not purifier_store.exists()
                    lock_before = (project / 'pnpm-lock.yaml').read_bytes()
                    cold_env = dict(env, pnpm_config_store_dir=str(purifier_store),
                                    npm_config_store_dir=str(purifier_store),
                                    pnpm_config_registry='http://127.0.0.1:9/')
                    output = command(cli, *arguments, cwd=project, env=cold_env)
                    if label == 'exec-version':
                        assert 'v24.21.0' in output, output
                    elif label == 'fallback-start':
                        assert 'milliseconds: 3600000' in output, output
                    assert_store(project, purifier_store)
                    assert (project / 'node_modules/ms/package.json').is_file()
                    assert (project / 'pnpm-lock.yaml').read_bytes() == lock_before
                    env.update(pnpm_config_store_dir=str(purifier_store),
                               npm_config_store_dir=str(purifier_store))
                    assert 'milliseconds: 3600000' in command(cli, 'test', cwd=project, env=env)
                    print('PASS actual wrapper cold route', label, flush=True)
                workspace_source = ROOT / 'tests/fixtures/script-installs'
                workspace_template = temporary / 'workspace-prefetch'
                shutil.copytree(workspace_source, workspace_template)
                command(cli, 'prefetch', cwd=workspace_template, env=env)
                workspace_cases = [['-r', 'run', 'member-only'],
                                   ['--filter', 'script-member', 'member-only'],
                                   ['run', '--filter', 'script-member', 'member-only'],
                                   ['exec', '--filter', 'script-member', 'node', 'check.cjs'],
                                   ['-C', 'packages/member', 'member-only'],
                                   ['--dir', 'packages/member', 'member-only'],
                                   ['--dir=packages/member', 'member-only'],
                                   ['-Cpackages/member', 'member-only'],
                                   ['run', '-C', 'packages/member', 'member-only']]
                for index, arguments in enumerate(workspace_cases):
                    workspace = temporary / f'cold-workspace-{index}'
                    shutil.copytree(workspace_source, workspace)
                    store = temporary / f'cold-workspace-store-{index}'
                    assert not store.exists() and not (workspace / 'node_modules').exists()
                    before_workspace_lock = (workspace / 'pnpm-lock.yaml').read_bytes()
                    cold_env = dict(env, pnpm_config_store_dir=str(store),
                                    npm_config_store_dir=str(store),
                                    pnpm_config_registry='http://127.0.0.1:9/')
                    output = command(cli, *arguments, cwd=workspace, env=cold_env)
                    assert 'script-installed: 3600000' in output, output
                    assert_store(workspace, store)
                    assert (workspace / 'packages/member/node_modules/ms/package.json').is_file()
                    assert (workspace / 'pnpm-lock.yaml').read_bytes() == before_workspace_lock
                    print('PASS actual wrapper cold workspace route', arguments, flush=True)
            if major == 'current':
                assert_missing_locked_graph(cli, temporary, env)
            command(cli, 'add', 'picocolors@1.1.0', '--save-exact', '--store-dir', purifier_store, cwd=project, env=env)
            assert json.loads((project / 'package.json').read_text())['dependencies']['picocolors'] == '1.1.0'
            command(cli, 'remove', 'picocolors', '--store-dir', purifier_store, cwd=project, env=env)
            assert 'picocolors' not in json.loads((project / 'package.json').read_text())['dependencies']
            command(cli, 'prefetch', cwd=project, env=env)
            # Switch the same working tree to native pnpm and back, each time
            # with fresh modules/stores and a frozen tool lockfile.
            for tool, label in ((native, 'native-switch'), (cli, 'purifier-switch')):
                shutil.rmtree(project / 'node_modules')
                switched_env = dict(env, pnpm_config_store_dir=str(temporary / f'{label}-{major}'),
                                    npm_config_store_dir=str(temporary / f'{label}-{major}'))
                command(tool, 'install', '--frozen-lockfile', '--store-dir', temporary / f'{label}-{major}', cwd=project, env=switched_env)
                assert 'milliseconds: 3600000' in command(tool, 'test', cwd=project, env=switched_env)
                assert_store(project, temporary / f'{label}-{major}')
            before = (project / 'pnpm-lock.yaml').read_bytes()
            env['PNPM_RUNTIME_PROJECT'] = str(project)
            expression = prefix + '(p.pnpm-purifier.buildPnpmProject {src=/. + builtins.getEnv "PNPM_RUNTIME_PROJECT";pnpm=' + sdk_expression + ';}).packages.version-probe'
            env['PNPM_PURIFIER_PNPM'] = str(native)
            installed = Path(command('nix', 'build', '--impure', '--expr', expression, '--out-link', temporary / f'pure-{major}', '--print-out-paths', env=env))
            assert command(installed / 'bin/version-probe', env=env) == 'milliseconds: 3600000'
            assert (project / 'pnpm-lock.yaml').read_bytes() == before
            print('PASS pnpm', version, 'native/lock/prefetch/install/build/test/add/remove/switch/pure-build', flush=True)


if __name__ == '__main__':
    main()
