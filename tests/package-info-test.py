"""Regression fixtures for upstream/date package versions on opkg and apk."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'luci-app-daede/root/usr/share/luci-app-daede/pkg-info.sh'

class PackageInfo(unittest.TestCase):
    def probe(self, manager, installed, latest):
        with tempfile.TemporaryDirectory() as directory:
            bindir = Path(directory)
            for tool in ('awk', 'sort', 'tail'):
                import shutil
                (bindir / tool).symlink_to(shutil.which(tool))
            mock = bindir / manager
            mock.write_text('''#!/bin/sh
case "$1" in
  status) [ -z "$INSTALLED" ] || printf 'Version: %s\\n' "$INSTALLED" ;;
  info) if [ "$MANAGER" = apk ]; then [ -n "$INSTALLED" ]; else printf 'Version: %s\\n' "$LATEST"; fi ;;
  list)
    if [ "$2" = -I ]; then printf '%s-%s x86_64 {test} [installed]\\n' "$3" "$INSTALLED"
    else printf '%s-%s x86_64 {test}\\n' "$2" "$LATEST"; fi ;;
esac
''')
            mock.chmod(0o755)
            result = subprocess.check_output(['/bin/sh', str(SCRIPT), 'dae'], env=dict(os.environ, PATH=directory, MANAGER=manager, INSTALLED=installed, LATEST=latest), text=True)
            return result.rstrip('\n').split('\t')

    def test_versions(self):
        for manager in ('opkg', 'apk'):
            for installed in ('1.0.0-r1', '1.24.0-r1', '2026.09.20-r3', ''):
                with self.subTest(manager=manager, installed=installed):
                    self.assertEqual(self.probe(manager, installed, '2026.09.20-r3'), [installed, '2026.09.20-r3'])

    def test_retired_preset_migration(self):
        source = (ROOT / 'luci-app-daede/root/etc/uci-defaults/90-luci-app-daede-init').read_text()
        block = source[source.index('geo_changed=0'):source.index('# Remove --disable-timestamp')]
        with tempfile.TemporaryDirectory() as directory:
            mock = Path(directory) / 'uci'
            mock.write_text('''#!/bin/sh
case "$2" in
get) case "$3" in
  *geoip_url) echo 'https://ghfast.top/https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat' ;;
  *geosite_url) echo 'https://custom.example/geosite.dat' ;;
esac ;;
*) printf '%s\\n' "$*" >> "$CALLS" ;;
esac
''')
            mock.chmod(0o755)
            calls = Path(directory) / 'calls'
            subprocess.run(['/bin/sh', '-ec', block], check=True, env=dict(os.environ, PATH=directory, CALLS=str(calls)))
            self.assertEqual(calls.read_text().splitlines(), ['-q set daede.config.geoip_url=', '-q commit daede'])

    def test_download_url_after_restoring_old_backup(self):
        source = (ROOT / 'luci-app-daede/root/usr/share/luci-app-daede/update-geo.sh').read_text()
        block = source[:source.index('LOCK=')] + '\nprintf "%s" "$URL"\n'
        with tempfile.TemporaryDirectory() as directory:
            mock = Path(directory) / 'uci'
            mock.write_text('#!/bin/sh\nprintf "%s" "$SAVED_URL"\n')
            mock.chmod(0o755)
            for kind in ('geoip', 'geosite'):
                direct = f'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/{kind}.dat'
                for saved, expected in (('', direct), ('https://ghfast.top/' + direct, direct), ('https://custom.example/data.dat', 'https://custom.example/data.dat')):
                    with self.subTest(kind=kind, saved=saved):
                        result = subprocess.check_output(['/bin/sh', '-c', block, 'test', kind], env=dict(os.environ, PATH=directory, SAVED_URL=saved), text=True)
                        self.assertEqual(result, expected)

if __name__ == '__main__':
    unittest.main()
