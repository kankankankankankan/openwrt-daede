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
            for package in ['dae', 'daed', 'luci-app-daede', 'vmlinux-btf']:
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
        for package in ['dae', 'daed', 'luci-app-daede', 'vmlinux-btf']:
            self.assertNotEqual(self.release_gate('success', missing=package).returncode, 0, package)

    def wait_release(self, states):
        step = workflow_step('auto-bump.yml', 'Assemble + gate build on staging')
        # Extract only the two real functions, never the dispatch portion.
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
argv = sys.argv[1:]
if argv[:2] == ['workflow', 'run']:
    print('https://github.com/test/repo/actions/runs/90210')
    sys.exit(0)
assert argv[:2] == ['run', 'view'], 'Only read-only polling is allowed'
counter = root / 'counter'
index = int(counter.read_text()) if counter.exists() else 0
states = json.loads((root / 'states.json').read_text())
if index >= len(states): sys.exit('unexpected extra poll')
counter.write_text(str(index + 1))
expression = argv[argv.index('--jq') + 1]
subprocess.run(['jq', '-r', expression], input=json.dumps(states[index]), text=True, check=True)
''')
            mock.chmod(0o700)
            script = 'set -euo pipefail\nsleep() { :; }\n' + '\n'.join(functions) + '\nwait_run 123\n'
            result = subprocess.run(['bash', '-c', script], cwd=d, timeout=10,
                env=dict(os.environ, TEST_ROOT=d, TESTED_SHA=SHA,
                         STAGING='auto-bump-staging-1-1', PATH=d + ':' + os.environ['PATH']),
                capture_output=True, text=True)
            return result

    def test_pending_empty_conclusions_keep_waiting_until_success(self):
        result = self.wait_release([
            dict(status='queued', conclusion=''),
            dict(status='in_progress', conclusion=None),
            dict(status='completed', conclusion='success'),
        ])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_run_conclusion_is_rejected(self):
        result = self.wait_release([dict(status='completed', conclusion='failure')])
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def run_gate(self, states):
        step = workflow_step('auto-bump.yml', 'Assemble + gate build on staging')
        # Extract the dispatch gate and keep the real staging fetch replaced by
        # a stub so no network git remote is needed.
        functions = [textwrap.dedent(re.search(
            r'^          ' + name + r'\(\) \{.*?^          \}', step, re.M | re.S).group())
            for name in ['require_sha', 'wait_run', 'run_and_wait']]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'states.json').write_text(json.dumps(states))
            mock = root / 'gh'
            mock.write_text('''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['TEST_ROOT'])
argv = sys.argv[1:]
if argv[:2] == ['workflow', 'run']:
    print('https://github.com/test/repo/actions/runs/90210')
    sys.exit(0)
assert argv[:2] == ['run', 'view'], 'Only read-only polling is allowed'
counter = root / 'counter'
index = int(counter.read_text()) if counter.exists() else 0
states = json.loads((root / 'states.json').read_text())
if index >= len(states): sys.exit('unexpected extra poll')
counter.write_text(str(index + 1))
expression = argv[argv.index('--jq') + 1]
subprocess.run(['jq', '-r', expression], input=json.dumps(states[index]), text=True, check=True)
''')
            mock.chmod(0o700)
            script = ('set -euo pipefail\nsleep() { :; }\n' + '\n'.join(functions)
                      + '\nfetch_staging_sha() { printf \'%s\\n\' "$TESTED_SHA"; }\n'
                      + 'run_and_wait mock-gate.yml "$TESTED_SHA"\n')
            result = subprocess.run(['bash', '-c', script], cwd=d, timeout=10,
                env=dict(os.environ, TEST_ROOT=d, TESTED_SHA=SHA,
                         STAGING='auto-bump-staging-1-1', PATH=d + ':' + os.environ['PATH']),
                capture_output=True, text=True)
            return result

    def test_run_gate_rejects_wrong_or_missing_head_sha(self):
        for head in ['b' * 40, '']:
            result = self.run_gate([dict(status='queued', conclusion='', headSha=head)])
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_run_gate_accepts_expected_head_sha_and_waits(self):
        result = self.run_gate([
            dict(status='queued', conclusion='', headSha=SHA),
            dict(status='in_progress', conclusion=None, headSha=SHA),
            dict(status='completed', conclusion='success', headSha=SHA),
        ])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
