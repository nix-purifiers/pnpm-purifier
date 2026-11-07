#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Cold script installs with independent native controls in a Nix sandbox."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading

source = Path(os.environ['PNPM_TEST_SOURCE'])
pnpm = os.environ['PNPM_TEST_PNPM']
node = os.environ['PNPM_TEST_NODE']
cli = os.environ['PNPM_TEST_CLI']
manifest_path = Path(os.environ['PNPM_TEST_MANIFEST'])
registries = os.environ['PNPM_TEST_REGISTRIES']
result_dir = Path(os.environ['PNPM_TEST_RESULTS'])
result_dir.mkdir()
manifest = json.loads(manifest_path.read_text())
archive = Path(manifest['https/registry.npmjs.org/ms/-/ms-2.0.0.tgz'])
integrity = re.search(r'integrity: ([^}]+)', (source / 'pnpm-lock.yaml').read_text())[1]

# This independent native mirror serves the locked archive, without invoking
# any purifier command or sharing a modules directory/store with its installs.
class NativeRegistry(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ms/-/ms-2.0.0.tgz':
            body = archive.read_bytes()
        elif self.path == '/ms':
            body = json.dumps({'name': 'ms', 'dist-tags': {'latest': '2.0.0'},
                'versions': {'2.0.0': {'name': 'ms', 'version': '2.0.0', 'dist': {
                    'integrity': integrity,
                    'tarball': 'http://' + self.headers['Host'] + '/ms/-/ms-2.0.0.tgz'}}}}).encode()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def execute(args, project, env, success=True, expected='script-installed: 3600000'):
    print('+', json.dumps(args), flush=True)
    result = subprocess.run(args, cwd=project, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, flush=True)
    if success:
        result.check_returncode()
        assert expected in result.stdout, result.stdout
    return result


def prepare(label):
    project = Path.cwd() / label
    shutil.copytree(source, project)
    project.chmod(0o700)
    for path in project.rglob('*'):
        if not path.is_symlink():
            path.chmod(path.stat().st_mode | 0o200)
    store = Path.cwd() / (label + '-store')
    assert not store.exists() and not (project / 'node_modules').exists()
    home = Path.cwd() / (label + '-home')
    runtime = home / 'run'
    runtime.mkdir(parents=True, mode=0o700)
    env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / 'data'),
               XDG_CACHE_HOME=str(home / 'cache'), XDG_RUNTIME_DIR=str(runtime),
               pnpm_config_store_dir=str(store), npm_config_store_dir=str(store),
               pnpm_config_pm_on_fail='ignore', npm_config_manage_package_manager_versions='false',
               # Both controls trust this authored frozen lock. This bypasses
               # mutable registry attestations, not native automatic installs.
               pnpm_config_trust_lockfile='true', NO_COLOR='1')
    return project, store, env


def check_state(project, store, before):
    text = (project / 'node_modules/.modules.yaml').read_text()
    actual = json.loads(text)['storeDir']
    assert Path(actual).resolve().is_relative_to(store.resolve()), actual
    assert (project / 'pnpm-lock.yaml').read_bytes() == before


cases = [
    ['run', 'build'], ['run-script', 'build'], ['test'], ['t'], ['tst'], ['start'],
    ['exec', 'node', 'check.cjs'], ['exec', 'node', '--version'],
    ['run', 'build', '--', '--help'], ['build'], ['-r', 'run', 'member-only'],
    ['--filter', 'script-member', 'member-only'],
    ['--filter', 'script-member', 'run', 'member-only'],
    ['run', '--filter', 'script-member', 'member-only'],
    ['--filter', 'script-member', 'exec', 'node', 'check.cjs'],
    ['exec', '--filter', 'script-member', 'node', 'check.cjs'],
    ['--filter', 'script-member', 'test'],
    ['-C', 'packages/member', 'member-only'],
    ['--dir', 'packages/member', 'member-only'],
    ['--dir=packages/member', 'member-only'],
    ['-Cpackages/member', 'member-only'],
    ['run', '-C', 'packages/member', 'member-only'],
]
server = ThreadingHTTPServer(('127.0.0.1', 0), NativeRegistry)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
receipts = []
try:
    for index, args in enumerate(cases):
        before = (source / 'pnpm-lock.yaml').read_bytes()
        if args == ['start']:
            assert 'start' not in json.loads((source / 'package.json').read_text())['scripts']
        native, native_store, native_env = prepare('native-' + str(index))
        native_env['pnpm_config_registry'] = 'http://127.0.0.1:' + str(server.server_port)
        expected = subprocess.check_output([node, '--version'], text=True).strip() if args == ['exec', 'node', '--version'] else 'script-installed: 3600000'
        execute([pnpm, *args], native, native_env, expected=expected)
        check_state(native, native_store, before)
        project, store, env = prepare('purifier-' + str(index))
        execute([node, cli, 'registry-exec', '--manifest', str(manifest_path),
                 '--registries', registries, '--pin-project', str(project), '--', pnpm, *args], project, env, expected=expected)
        check_state(project, store, before)
        receipts.append({'arguments': args, 'nativeColdInstall': True,
                         'lockedColdInstall': True, 'storesIndependent': True,
                         'storeSettingMatched': True, 'lockUnchanged': True})
    missing = Path.cwd() / 'missing-manifest.json'
    missing.write_text('{}')
    project, store, env = prepare('missing-locked-dependency')
    failure = execute([node, cli, 'registry-exec', '--manifest', str(missing),
                       '--registries', registries, '--pin-project', str(project), '--',
                       pnpm, 'run', 'build'], project, env, success=False)
    assert failure.returncode != 0
    assert 'lock does not hold' in failure.stdout, failure.stdout
    assert 'ms' in failure.stdout and 'UNEXPECTED_STORE' not in failure.stdout
    assert 'script-installed: 3600000' not in failure.stdout
finally:
    server.shutdown()
    server.server_close()
    thread.join()
receipt = {'platform': os.environ['PNPM_TEST_SYSTEM'],
           'pnpmVersion': subprocess.check_output([pnpm, '--version'], text=True).strip(),
           'nodeVersion': subprocess.check_output([node, '--version'], text=True).strip(),
           'cases': receipts, 'missingLockedDependencyRejected': True}
assert receipt['pnpmVersion'] == '12.18.0'
(result_dir / 'cold-script-installs.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('PASS native and locked cold script installs; missing locked dependency rejected', flush=True)
