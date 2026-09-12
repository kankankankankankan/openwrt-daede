"""Run the real generator with isolated UCI/core/sysfs fixtures; no router writes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'luci-app-daede/root/usr/share/luci-app-daede/gen-dae-config.sh').read_text()

class GeneratorLAN(unittest.TestCase):
    def run_case(self, lan):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            net = root / 'net'
            net.mkdir()
            for name in ['br-lan', 'eth0.10']:
                (net / name).mkdir()
            active = root / 'config.dae'
            active.write_text('EXISTING CONFIG\n')
            functions = root / 'functions.sh'
            functions.write_text('''uci() { printf 'local'; }
config_load() { :; }
config_get() {
    if [ "$3" = lan_interface ]; then
        eval "$1=\\\"\\$TEST_LAN\\\""
    else
        eval "$1=\\\"\\$4\\\""
    fi
}
config_get_bool() { config_get "$@"; }
config_foreach() { :; }
config_list_foreach() { :; }
''')
            script = SOURCE.replace('. /lib/functions.sh', f'. "{functions}"')
            script = script.replace('CONFIG_DAE="/etc/dae/config.dae"', f'CONFIG_DAE="{active}"')
            script = script.replace('SYS_CLASS_NET="/sys/class/net"', f'SYS_CLASS_NET="{net}"')
            script = script.replace('/tmp/dae-gen.dae', str(root / 'generated.dae'))
            script = script.replace('DAE_BIN="/usr/bin/dae"', 'DAE_BIN="/usr/bin/true"')
            script = script.replace('mkdir -p /etc/dae', ':')
            script = script.replace('/usr/bin/pgrep -x dae', 'false')
            runner = root / 'generator.sh'
            runner.write_text(script)
            env = dict(os.environ, TEST_LAN=lan, DAEDE_SYS_CLASS_NET=str(net), DAEDE_CONFIG_DAE=str(active))
            result = subprocess.run(['sh', str(runner), 'generate'], env=env, capture_output=True, text=True)
            return result, active.read_text()

    def test_missing_interface_preserves_config(self):
        result, active = self.run_case('missing0')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(active, 'EXISTING CONFIG\n')

    def test_list_validates_every_device(self):
        result, active = self.run_case('br-lan, missing0')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(active, 'EXISTING CONFIG\n')

    def test_valid_single_and_multiple_interfaces(self):
        for lan in ['br-lan', 'br-lan,eth0.10', 'br-lan eth0.10']:
            with self.subTest(lan=lan):
                result, active = self.run_case(lan)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('lan_interface: ', active)
                self.assertIn('br-lan', active)

    def test_empty_auto_and_injection_refused(self):
        for lan in ['', 'auto', 'br-lan,auto', 'br-lan;id', ' ', ',']:
            with self.subTest(lan=lan):
                result, active = self.run_case(lan)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(active, 'EXISTING CONFIG\n')

if __name__ == '__main__':
    unittest.main()
