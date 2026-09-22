"""Run the actual upgrade script with isolated package-manager commands and logs."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'luci-app-daede/root/usr/share/luci-app-daede/update-pkg.sh'

class Upgrade(unittest.TestCase):
    def run_upgrade(self, manager, package, legacy='', fail_update=False, fail_install=False):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            mock = d / manager
            mock.write_text(r'''#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
case "$1" in
 status) [ "$2" != "$LEGACY" ] || printf 'Status: install ok installed\n' ;;
 info) [ "$3" = "$LEGACY" ] ;;
 update) [ "$FAIL_UPDATE" = 0 ] ;;
 upgrade|add) [ "$FAIL_INSTALL" = 0 ] ;;
 list)
   case "$2" in
    --installed) printf 'dae-daede-2026.09.20-r4 x86_64\n' ;;
    -u) : ;;
    *) printf '%s-2026.09.20-r4 x86_64\n' "$2" ;;
   esac ;;
esac
''')
            mock.chmod(0o755)
            (d / 'flock').write_text('#!/bin/sh\nexit 0\n')
            (d / 'flock').chmod(0o755)
            # Relocate temporary state, disable self-copy, and join its worker.
            source = SCRIPT.read_text()
            begin = source.index('case "$0" in')
            end = source.index('LOCK=', begin)
            source = source[:begin] + source[end:]
            source = source.replace('/tmp/', tmp + '/')
            source = source.replace('echo "started in background, see $LOG"', 'wait\necho "started in background, see $LOG"')
            script = d / 'upgrade.sh'
            script.write_text(source)
            calls = d / 'calls'
            env = dict(os.environ, PATH=tmp + ':' + os.environ['PATH'], CALLS=str(calls), LEGACY=legacy, FAIL_UPDATE=str(int(fail_update)), FAIL_INSTALL=str(int(fail_install)))
            result = subprocess.run(['/bin/sh', str(script), package], env=env, text=True, capture_output=True)
            logfile = d / ('luci-app-daede.pkg-' + package + '.log')
            return result, calls.read_text().splitlines(), logfile.read_text() if logfile.exists() else ''

    def test_blocks_legacy_for_core_and_luci(self):
        for manager in ('opkg', 'apk'):
            for package, legacy in (('dae', 'dae'), ('daed', 'daed'), ('luci-app-daede', 'dae'), ('luci-app-daede', 'daed')):
                with self.subTest(manager=manager, package=package, legacy=legacy):
                    result, calls, log = self.run_upgrade(manager, package, legacy=legacy)
                    self.assertEqual(result.returncode, 65)
                    self.assertIn('Migration required', result.stderr)
                    self.assertFalse(any(c.startswith(('update', 'upgrade', 'add')) for c in calls))

    def test_only_upgrades_namespaced_core(self):
        for manager in ('opkg', 'apk'):
            result, calls, log = self.run_upgrade(manager, 'dae')
            self.assertIn('✓ 完成', log)
            self.assertIn('upgrade dae-daede' if manager == 'opkg' else 'add dae-daede=2026.09.20-r4', calls)

    def test_update_failure_never_installs(self):
        for manager in ('opkg', 'apk'):
            result, calls, log = self.run_upgrade(manager, 'dae', fail_update=True)
            self.assertIn('✗ 失败', log)
            self.assertFalse(any(c.startswith(('upgrade', 'add')) for c in calls))

    def test_install_failure_not_reported_as_success(self):
        for manager in ('opkg', 'apk'):
            result, calls, log = self.run_upgrade(manager, 'dae', fail_install=True)
            self.assertIn('✗ 失败', log)
            self.assertNotIn('✓ 完成', log)

if __name__ == '__main__':
    unittest.main()
