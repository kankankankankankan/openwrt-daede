#!/usr/bin/env python3
"""2026-09-11: isolated router transaction tests, with no network or host service changes."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'luci-app-daede/root/usr/share/luci-app-daede/member-sync.sh'

class MemberSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        for directory in ['tmp', 'etc/dae', 'etc/init.d', 'usr/bin', 'usr/share/libubox', 'sys/class/net/br-lan', 'bin']:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        self.env = dict(os.environ, DAEDE_MEMBER_TEST_ROOT=str(self.root), PATH=str(self.root / 'bin') + ':' + os.environ['PATH'])
        self.write('store.json', json.dumps({'daede.config.active_backend':'dae', 'dae.config.enabled':'0', 'dae.config.config_file':'/etc/dae/custom.dae'}))
        self.write('usr/share/libubox/jshn.sh', '''json_load_file() { J="$(cat "$1")"; }
json_init() { J='{}'; }
json_load() { J="$1"; python3 -c 'import json,sys; json.loads(sys.argv[1])' "$J"; }
json_add_string() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" add "$J" "$1" "$2")"; }
json_add_boolean() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" bool "$J" "$1" "$2")"; }
json_dump() { printf '%s\\n' "$J"; }
json_select() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" select "$J" "$1")"; }
json_get_var() { eval "$1=\\"\\$(python3 \\\"\\$DAEDE_MEMBER_TEST_ROOT/json_bridge.py\\\" get \\\"\\$J\\\" \\\"$2\\\")\\""; }
json_get_type() { eval "$1=\\"\\$(python3 \\\"\\$DAEDE_MEMBER_TEST_ROOT/json_bridge.py\\\" type \\\"\\$J\\\" \\\"$2\\\")\\""; }
''')
        self.write('json_bridge.py', '''import json,sys
op,j,*args=sys.argv[1:]; d=json.loads(j)
if op in ('add','bool'):
 d[args[0]]=args[1] if op=='add' else args[1]=='1'; print(json.dumps(d))
elif op=='select':
 if args[0] not in d: sys.exit(1)
 print(json.dumps(d[args[0]]))
elif op=='get': print(d.get(args[0],''))
else:
 v=d.get(args[0]); print('object' if isinstance(v,dict) else 'array' if isinstance(v,list) else 'null' if v is None else 'string')
''')
        self.write('bin/uci', '''#!/usr/bin/env python3
import sys,json,os,pathlib
p=pathlib.Path(os.environ['DAEDE_MEMBER_TEST_ROOT'])/'store.json'; d=json.loads(p.read_text()); a=[x for x in sys.argv[1:] if x!='-q']; op=a[0]
if op=='get':
 if a[1] not in d: sys.exit(1)
 print(d[a[1]])
elif op=='set':
 k,v=a[1].split('=',1); d[k]=v
elif op=='export': print(json.dumps(d))
elif op=='import': d=json.load(sys.stdin)
p.write_text(json.dumps(d))
''', executable=True)
        self.write('bin/curl', '''#!/usr/bin/env python3
import os,pathlib,sys,json,re
r=pathlib.Path(os.environ['DAEDE_MEMBER_TEST_ROOT']); conf=pathlib.Path(sys.argv[2]).read_text(); opts=dict(re.findall(r'^(\\S+) = "(.*)"$', conf,re.M)); url=opts['url']; out=pathlib.Path(opts['output']); status='200'
if (r/'network-fail').exists(): sys.exit(7)
if url.endswith('/api/login'):
 pathlib.Path(opts['cookie-jar']).write_text('private-session'); result={'ok':True}
elif url.endswith('/api/state'): result={'user':{'username':'tester'}}
elif url.endswith('/api/convert'): result={'job':{'id':'test-job'}}
elif url.endswith('/config.dae'):
 out.write_text('global { lan_interface: __DAE_LAN_INTERFACE__ }\\n' if not (r/'bad-placeholder').exists() else 'invalid config'); print(status,end=''); sys.exit()
else: result={'ok':True}
out.write_text(json.dumps(result)); print(status,end='')
''', executable=True)
        self.write('usr/bin/dae', '#!/bin/sh\n[ ! -f "$DAEDE_MEMBER_TEST_ROOT/invalid" ]\n', executable=True)
        self.write('etc/init.d/dae', '''#!/bin/sh
r="$DAEDE_MEMBER_TEST_ROOT"
case "$1" in
 running) [ -f "$r/running" ];;
 enabled) [ -f "$r/enabled" ];;
 enable) touch "$r/enabled";;
 disable) rm -f "$r/enabled";;
 stop) rm -f "$r/running";;
 restart) if [ -f "$r/restart-fail" ]; then rm "$r/restart-fail"; exit 1; fi; touch "$r/running";;
esac
''', executable=True)
        self.write('bin/sleep', '#!/bin/sh\nexit 0\n', executable=True)
    def tearDown(self): self.tmp.cleanup()
    def write(self, path, data, executable=False):
        p=self.root/path; p.write_text(data)
        if executable: p.chmod(0o700)
    def run_action(self, action, *args):
        result=subprocess.run(['sh',str(SCRIPT),action,*args],env=self.env,capture_output=True,text=True)
        try: return json.loads(result.stdout)
        except Exception: self.fail(str(result))
    def login(self, url='https://members.example', password='secret'):
        nonce='a'*32
        self.write(f'tmp/daede-member-request.{nonce}.json',json.dumps(dict(url=url,username='tester',password=password,lan_interface='br-lan')))
        return self.run_action('login',nonce)
    def test_login_sync_logout(self):
        self.assertTrue(self.login()['ok'])
        self.assertTrue(self.run_action('status')['logged_in'])
        self.assertTrue(self.run_action('sync')['ok'])
        self.assertIn('br-lan',(self.root/'etc/dae/config.dae').read_text())
        self.assertTrue(self.run_action('logout')['ok'])
        self.assertFalse(self.run_action('status')['logged_in'])
        self.assertEqual(json.loads((self.root/'store.json').read_text())['daede.member.mode'],'cloud')
        self.assertFalse(list((self.root/'tmp').glob('daede-member-work.*')))
        self.assertFalse(list((self.root/'tmp').glob('daede-member-request.*')))
    def test_failed_relogin_preserves_session(self):
        self.assertTrue(self.login()['ok']); self.write('network-fail','1')
        self.assertFalse(self.login()['ok'])
        self.assertEqual((self.root/'tmp/daede-member/cookie').read_text(),'private-session')
    def test_origin_restrictions(self):
        for url in ['http://example.com','https://x@y.com','https://example.com/path','https://example.com?x','https://example.com\nheader']:
            self.assertFalse(self.login(url)['ok'],url)
    def test_validation_keeps_previous(self):
        self.login(); self.write('etc/dae/config.dae','old'); self.write('invalid','1')
        self.assertFalse(self.run_action('sync')['ok'])
        self.assertEqual((self.root/'etc/dae/config.dae').read_text(),'old')
    def test_restart_rollback(self):
        self.login(); self.write('etc/dae/config.dae','old'); self.write('running','1'); self.write('restart-fail','1')
        self.assertFalse(self.run_action('sync')['ok'])
        self.assertEqual((self.root/'etc/dae/config.dae').read_text(),'old')
        self.assertEqual(json.loads((self.root/'store.json').read_text())['dae.config.config_file'],'/etc/dae/custom.dae')
        self.assertTrue((self.root/'running').exists())
    def test_lock_consumes_staged_request(self):
        (self.root/'tmp/daede-member.lock').mkdir()
        self.assertFalse(self.login()['ok'])
        self.assertFalse(list((self.root/'tmp').glob('daede-member-request.*')))
    def test_placeholder_and_backend_guard(self):
        self.login(); self.write('bad-placeholder','1')
        self.assertFalse(self.run_action('sync')['ok'])
        self.assertFalse((self.root/'etc/dae/config.dae').exists())
        d=json.loads((self.root/'store.json').read_text()); d['daede.config.active_backend']='daed'; self.write('store.json',json.dumps(d))
        self.assertFalse(self.run_action('sync')['ok'])

if __name__=='__main__': unittest.main()
