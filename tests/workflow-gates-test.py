"""2026-09-22: execute workflow gates with local files and a fake gh; no GitHub writes."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40


def workflow_step(filename, name):
    source = (ROOT / '.github/workflows' / filename).read_text()
    return source.split('      - name: ' + name + '\n', 1)[1].split('\n      - ', 1)[0]


class WorkflowGates(unittest.TestCase):
    def test_upstream_sync_workflow_has_conflict_stop_and_merge_gate(self):
        source = (ROOT / '.github/workflows/upstream-sync.yml').read_text()
        self.assertIn("UPSTREAM_REPOSITORY: kenzok8/openwrt-daede", source)
        self.assertIn("git merge --no-ff --no-edit", source)
        self.assertIn("git diff --name-only --diff-filter=U", source)
        self.assertIn('gh pr merge "$pr_number" --merge --delete-branch', source)
        self.assertIn('select(.name == "tests")', source)
        self.assertIn("pull_request:", (ROOT / '.github/workflows/upstream-sync-check.yml').read_text())

    def release_gate(self, outcome, missing=None):
        step = workflow_step('release.yml', 'Require all release packages')
        self.assertIn('SDK_OUTCOME: ${{ steps.sdk.outcome }}', step)
        self.assertIn('id: sdk', workflow_step('release.yml', 'Build packages'))
        script = textwrap.dedent(step.split('        run: |\n', 1)[1])
        script = script.replace('${{ matrix.arch }}', 'x86_64').replace('${{ matrix.sdk }}', '24.10')
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / 'bin/packages/x86_64/daede'
            output.mkdir(parents=True)
            for package in ['dae-daede', 'daed-daede', 'luci-app-daede', 'vmlinux-btf']:
                if package != missing:
                    (output / (package + '_1.0_x86_64.ipk')).touch()
            return subprocess.run(['bash', '-c', script], cwd=d,
                                  env=dict(os.environ, SDK_OUTCOME=outcome), capture_output=True, text=True)

    def test_failed_sdk_cannot_release_leftover_packages(self):
        for outcome in ['failure', 'cancelled', 'skipped', '']:
            result = self.release_gate(outcome)
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_success_requires_every_package(self):
        self.assertEqual(self.release_gate('success').returncode, 0)
        for package in ['dae-daede', 'daed-daede', 'luci-app-daede', 'vmlinux-btf']:
            self.assertNotEqual(self.release_gate('success', missing=package).returncode, 0, package)

    def test_installer_selects_independent_core_packages(self):
        source = (ROOT / 'scripts/install.sh').read_text()
        function = re.search(r'^wanted_pkgs\(\) \{.*?^\}', source, re.M | re.S).group()
        for core, packages in [('dae', ['dae-daede']), ('daed', ['daed-daede']),
                               ('both', ['dae-daede', 'daed-daede'])]:
            result = subprocess.run(['sh', '-c', function + '\nwanted_pkgs'],
                env=dict(os.environ, DAEDE_CORE=core), capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.splitlines(), packages + ['luci-app-daede'])

    def test_installer_blocks_legacy_packages_before_resolution(self):
        source = (ROOT / 'scripts/install.sh').read_text()
        function = re.search(r'^reject_legacy_core\(\) \{.*?^\}', source, re.M | re.S).group()
        self.assertLess(source.index('reject_legacy_core || exit 1'), source.index('ARCH="$(detect_arch'))
        for manager in ['opkg', 'apk']:
            for legacy in ['', 'dae', 'daed']:
                # Mock only the read-only queries; mutation calls fail the test.
                mock = r'''opkg() {
  [ "$1" = status ] || exit 99
  [ "$2" != "$LEGACY" ] || printf 'Package: %s\nStatus: install ok installed\n' "$2"
}
apk() {
  [ "$1 $2" = 'info --exists' ] || exit 99
  [ "$3" = "$LEGACY" ]
}
'''
                result = subprocess.run(['sh', '-c', mock + function + '\nreject_legacy_core'],
                    env=dict(os.environ, PM=manager, LEGACY=legacy), capture_output=True, text=True)
                self.assertEqual(result.returncode, 1 if legacy else 0, result.stdout + result.stderr)
                if legacy:
                    self.assertIn('automatic migration is disabled', result.stdout)
                    self.assertIn('Back up configuration', result.stdout)

    def test_release_manifest_uses_new_package_identity(self):
        step = workflow_step('release.yml', 'Organize feed structure')
        script = textwrap.dedent(step.split('        run: |\n', 1)[1])
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            feed = root / 'artifacts/packages-sdk24.10-x86_64/feed'
            feed.mkdir(parents=True)
            packages = ['dae-daede', 'daed-daede', 'luci-app-daede']
            for package in packages:
                (feed / (package + '_1.0_x86_64.ipk')).write_bytes(b'package')
            subprocess.run(['bash', '-c', script], cwd=d, capture_output=True, check=True)
            manifest = (root / 'feed/24.10/x86_64/manifest-daede.txt').read_text()
            for package in packages:
                self.assertIn(package + '=' + package + '_1.0_x86_64.ipk', manifest)
            self.assertNotRegex(manifest, r'(?m)^(dae|daed)=')

    def wait_release(self, states):
        step = workflow_step('auto-bump.yml', 'Dispatch and wait for release')
        # Extract only the two real functions, never the dispatch/push portion.
        functions = [textwrap.dedent(re.search(
            r'^          ' + name + r'\(\) \{.*?^          \}', step, re.M | re.S).group())
            for name in ['require_sha', 'wait_run']]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'states.json').write_text(json.dumps(states))
            mock = root / 'gh'
            mock.write_text('''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['TEST_ROOT'])
assert sys.argv[1:3] == ['run', 'view'], 'Only read-only polling is allowed'
counter = root / 'counter'
index = int(counter.read_text()) if counter.exists() else 0
states = json.loads((root / 'states.json').read_text())
if index >= len(states): sys.exit('unexpected extra poll')
counter.write_text(str(index + 1))
expression = sys.argv[sys.argv.index('--jq') + 1]
subprocess.run(['jq', '-r', expression], input=json.dumps(states[index]), text=True, check=True)
''')
            mock.chmod(0o700)
            script = 'set -euo pipefail\nsleep() { :; }\n' + '\n'.join(functions) + '\nwait_run 123\n'
            result = subprocess.run(['bash', '-c', script], cwd=d, timeout=10,
                env=dict(os.environ, TEST_ROOT=d, TESTED_SHA=SHA, PATH=d + ':' + os.environ['PATH'],
                         release_completed_marker=str(root / 'completed')), capture_output=True, text=True)
            return result, (root / 'completed').exists()

    def test_pending_empty_conclusions_preserve_release_sha(self):
        result, completed = self.wait_release([
            dict(status='queued', conclusion='', headSha=SHA),
            dict(status='in_progress', conclusion=None, headSha=SHA),
            dict(status='completed', conclusion='success', headSha=SHA),
        ])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(completed)

    def test_failed_release_and_wrong_commit_are_rejected(self):
        for state in [dict(status='completed', conclusion='failure', headSha=SHA),
                      dict(status='completed', conclusion='success', headSha='b' * 40),
                      dict(status='queued', conclusion='', headSha='')]:
            result, _ = self.wait_release([state])
            self.assertNotEqual(result.returncode, 0, result.stdout)


if __name__ == '__main__':
    unittest.main()
