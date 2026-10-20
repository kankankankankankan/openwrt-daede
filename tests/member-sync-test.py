#!/usr/bin/env python3
"""2026-09-11: isolated router transaction tests, with no network or host service changes."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest, time

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'luci-app-daede/root/usr/share/luci-app-daede/member-sync.sh'

class MemberSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        for directory in ['tmp', 'etc/dae', 'etc/init.d', 'usr/bin', 'usr/share/libubox', 'usr/share/luci-app-daede', 'sys/class/net/br-lan', 'bin']:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        self.env = dict(os.environ, DAEDE_MEMBER_TEST_ROOT=str(self.root), PATH=str(self.root / 'bin') + ':' + os.environ['PATH'])
        self.write('store.json', json.dumps({'daede.config.active_backend':'dae', 'dae.config.enabled':'0', 'dae.config.config_file':'/etc/dae/custom.dae'}))
        self.write('usr/share/libubox/jshn.sh', '''json_load_file() { J="$(cat "$1")"; }
json_init() { J='{}'; JP=''; }
json_add_object() { JP="$J"; JK="$1"; J='{}'; }
json_close_object() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" object "$JP" "$JK" "$J")"; }
json_add_double() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" number "$J" "$1" "$2")"; }
json_load() { J="$1"; python3 -c 'import json,sys; json.loads(sys.argv[1])' "$J"; }
json_add_string() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" add "$J" "$1" "$2")"; }
json_add_boolean() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" bool "$J" "$1" "$2")"; }
json_dump() { printf '%s\\n' "$J"; }
json_select() { J="$(python3 "$DAEDE_MEMBER_TEST_ROOT/json_bridge.py" select "$J" "$1")"; }
json_get_var() { eval "$1=\\"\\$(python3 \\\"\\$DAEDE_MEMBER_TEST_ROOT/json_bridge.py\\\" get \\\"\\$J\\\" \\\"$2\\\")\\""; }
json_get_type() { eval "$1=\\"\\$(python3 \\\"\\$DAEDE_MEMBER_TEST_ROOT/json_bridge.py\\\" type \\\"\\$J\\\" \\\"$2\\\")\\""; }
json_get_keys() { eval "$1=\\"\\$(python3 \\\"\\$DAEDE_MEMBER_TEST_ROOT/json_bridge.py\\\" keys \\\"\\$J\\\" \\\"$2\\\")\\""; }
''')
        self.write('json_bridge.py', '''import json,sys
op,j,*args=sys.argv[1:]; d=json.loads(j)
if op in ('number','object'):
 d[args[0]]=json.loads(args[1]); print(json.dumps(d))
elif op in ('add','bool'):
 d[args[0]]=args[1] if op=='add' else args[1]=='1'; print(json.dumps(d))
elif op=='keys':
 v=d.get(args[0],[]); print(' '.join(str(i+1) for i in range(len(v))) if isinstance(v,list) else '')
elif op=='select':
 if not isinstance(d,dict) or not isinstance(d.get(args[0]),(dict,list)): sys.exit(1)
 print(json.dumps(d[args[0]]))
elif op=='get':
 v=(d[int(args[0])-1] if isinstance(d,list) else d.get(args[0],'')); print(int(v) if isinstance(v,bool) else v)
else:
 if not isinstance(d,list) and args[0] not in d: print(''); sys.exit()
 v=d[int(args[0])-1] if isinstance(d,list) else d.get(args[0]); print('object' if isinstance(v,dict) else 'array' if isinstance(v,list) else 'null' if v is None else 'boolean' if isinstance(v,bool) else 'int' if isinstance(v,int) else 'double' if isinstance(v,float) else 'string')
''')
        self.write('bin/flock', "#!/usr/bin/env python3\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n", executable=True)
        self.write('bin/setsid', "#!/usr/bin/env python3\nimport os,sys\nos.setsid(); os.execvp(sys.argv[1], sys.argv[1:])\n", executable=True)
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
r=pathlib.Path(os.environ['DAEDE_MEMBER_TEST_ROOT']); conf=pathlib.Path(sys.argv[2]).read_text(); opts=dict(re.findall(r'^(\\S+) = "(.*)"$', conf,re.M)); url=opts['url']; out=pathlib.Path(opts['output']); status=(r/'http-status').read_text().strip() if (r/'http-status').exists() else '200'
if (r/'network-fail').exists(): sys.exit(7)
if url.endswith('/api/login'):
 pathlib.Path(opts['cookie-jar']).write_text('private-session'); result={'ok':True}
elif url.endswith('/api/state'):
 result=json.loads((r/'api-state.json').read_text()) if (r/'api-state.json').exists() else {'ok':True,'user':{'username':'tester'}}
 with (r/'state-calls').open('a') as f: f.write('state\\n')
elif url.endswith('/api/convert'): result=json.loads((r/'api-convert.json').read_text()) if (r/'api-convert.json').exists() else {'job':{'id':'test-job'}}
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
 stop) rm -f "$r/running" "$r/var/log/dae/dae.log";;
 hot_reload) touch "$r/hot-reloaded";;
 restart) if [ -f "$r/restart-fail" ]; then rm "$r/restart-fail"; exit 1; fi; touch "$r/running";;
esac
''', executable=True)
        self.write('bin/sleep', '#!/bin/sh\nexit 0\n', executable=True)
        # 2026-09-22: sync also enables GeoData updates; run the real helper
        # against isolated crontab/service paths, never the host's /etc.
        geo_cron = SCRIPT.with_name('geo-cron.sh').read_text()
        for path in ['/etc/crontabs', '/etc/init.d/cron']:
            geo_cron = geo_cron.replace(path, str(self.root) + path)
        self.write('usr/share/luci-app-daede/geo-cron.sh', geo_cron, executable=True)
        self.write('etc/init.d/cron', '''#!/bin/sh
printf '%s\\n' "$1" >> "$DAEDE_MEMBER_TEST_ROOT/cron-calls"
''', executable=True)
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
    def test_scheduled_sync_never_starts_stopped_service(self):
        self.login()
        store=json.loads((self.root/'store.json').read_text())
        store.update({'daede.member.auto_sync':'1','daede.member.mode':'cloud'})
        self.write('store.json',json.dumps(store))
        self.assertTrue(self.run_action('scheduled')['ok'])
        self.assertFalse((self.root/'running').exists())
        self.assertFalse((self.root/'etc/dae/config.dae').exists())

    def test_unchanged_config_refreshes_without_restart_and_keeps_geo_preferences(self):
        self.login()
        store=json.loads((self.root/'store.json').read_text())
        store.update({'daede.config.geoip_url':'https://example.com/ip.dat',
                      'daede.config.geo_auto':'0','daede.config.geo_auto_freq':'weekly'})
        self.write('store.json',json.dumps(store))
        self.assertTrue(self.run_action('sync')['ok'])
        self.assertTrue(self.run_action('sync')['ok'])
        self.assertTrue((self.root/'hot-reloaded').exists())
        store=json.loads((self.root/'store.json').read_text())
        self.assertEqual(store['daede.config.geoip_url'],'https://example.com/ip.dat')
        self.assertEqual(store['daede.config.geo_auto'],'0')
        cron=self.root/'etc/crontabs/root'
        self.assertTrue(not cron.exists() or 'update-geo.sh' not in cron.read_text())

    def test_scheduled_respects_due_time_and_local_mode(self):
        self.login(); self.write('running','1')
        store=json.loads((self.root/'store.json').read_text())
        store.update({'daede.member.auto_sync':'1','daede.member.mode':'cloud',
                      'daede.member.next_sync':str(int(time.time())+18000)})
        self.write('store.json',json.dumps(store))
        self.assertTrue(self.run_action('scheduled')['ok'])
        self.assertFalse((self.root/'etc/dae/config.dae').exists())
        store.update({'daede.member.mode':'local','daede.member.next_sync':'0'})
        self.write('store.json',json.dumps(store))
        self.assertTrue(self.run_action('scheduled')['ok'])
        self.assertFalse((self.root/'etc/dae/config.dae').exists())

    def test_schedule_five_hours_and_migrates_old_cron(self):
        self.login()
        cron=SCRIPT.with_name('member-sync-cron.sh').read_text()
        for path in ['/etc/crontabs','/etc/init.d/cron']:
            cron=cron.replace(path,str(self.root)+path)
        self.write('usr/share/luci-app-daede/member-sync-cron.sh',cron,executable=True)
        (self.root/'etc/crontabs').mkdir(exist_ok=True)
        self.write('etc/crontabs/root','0 */5 * * * /usr/share/luci-app-daede/member-sync.sh sync >/dev/null 2>&1\n')
        before=int(time.time())
        result=self.run_action('schedule','5')
        self.assertTrue(result['ok'])
        self.assertGreaterEqual(int(result['next_sync']),before+18000)
        self.assertLessEqual(int(result['next_sync']),int(time.time())+18000)
        crontab=(self.root/'etc/crontabs/root').read_text()
        self.assertIn('* * * * * /usr/share/luci-app-daede/member-sync.sh scheduled',crontab)
        self.assertNotIn('member-sync.sh sync ',crontab)
        self.assertTrue(self.run_action('schedule','08')['ok'])

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
    def test_quota_is_whitelisted_from_existing_state_with_large_bytes(self):
        self.login()
        quota = dict(memberName='member-display', planName='<img onerror=alert(1)>', expiresAt='2027-01-01', expiresText='到期', updatedAt='2026-09-12',
                     upload=4294967297, download=8589934592, used=12884901889, total=107374182400, remaining=94489280511)
        user: dict = {k: quota[k] for k in ('planName','expiresAt','expiresText','updatedAt')}
        user.update(username='member-display', id='private-id', subscriptionShortCode='secret-code', baseUrl='secret-url',
                    usage={**{k: quota[k] for k in ('upload','download','used','total','remaining')}, 'percent':99, 'usedText':'untrusted'})
        self.write('api-state.json', json.dumps(dict(ok=True,user=user,jobs=[dict(subscriptionUrl='private-link')])))
        before = (self.root/'state-calls').read_text()
        result = self.run_action('status')
        self.assertEqual(result.get('quota'), quota)
        self.assertEqual((self.root/'state-calls').read_text(), before + 'state\n')
        self.assertNotIn('private-', json.dumps(result))
        self.assertNotIn('secret-', json.dumps(result))

    def test_quota_failure_and_unauthenticated_never_emit_cached_data(self):
        self.login()
        self.write('api-state.json', json.dumps({'ok':True, 'user':{'usage':{'used':123}}}))
        self.assertEqual(self.run_action('status')['quota']['used'], 123)
        for response, expected in [({'ok':True,'user':None}, 'unauthenticated'),
                                   ({'ok':False,'user':{'usage':{'used':123}}}, 'unavailable')]:
            self.write('api-state.json', json.dumps(response))
            state = self.run_action('status')
            self.assertNotIn('quota', state)
            self.assertEqual(state.get('quota_status'), expected)
            self.assertEqual(state['logged_in'], state.get('quota_status') != 'unauthenticated')
        self.write('network-fail','1')
        state = self.run_action('status')
        self.assertNotIn('quota', state)
        self.assertEqual(state.get('quota_status'), 'unavailable')

    def test_malformed_state_does_not_authorize_quota(self):
        self.login()
        for response in [{}, {'user':{'usage':{'used':123}}}, {'ok':'true','user':{'usage':{'used':123}}},
                         {'ok':True,'user':[]}, {'ok':True}]:
            self.write('api-state.json', json.dumps(response))
            state = self.run_action('status')
            self.assertNotIn('quota', state)
            self.assertEqual(state.get('quota_status'), 'unavailable')
            self.assertEqual(state['logged_in'], state.get('quota_status') != 'unauthenticated')

    def test_quota_missing_null_invalid_and_zero_remain_distinct(self):
        self.login()
        for usage, expected in [({}, {}), (None, {}),
                                ({'used':0,'total':0}, {'used':0,'total':0}),
                                ({'upload':None,'download':False,'used':'123','total':-1,'remaining':{}}, {})]:
            self.write('api-state.json', json.dumps({'ok':True,'user':{'usage':usage}}))
            quota = self.run_action('status')['quota']
            self.assertEqual({k:v for k,v in quota.items() if k in ('upload','download','used','total','remaining')}, expected)
            self.assertEqual(quota['expiresAt'], '')

    def test_empty_warnings_do_not_create_false_alarm(self):
        self.login()
        self.write('api-convert.json', json.dumps({'job': {'id': 'test-job', 'warnings': []}}))
        self.assertEqual(self.run_action('sync').get('warning'), '')
        self.assertEqual(json.loads((self.root/'store.json').read_text()).get('daede.member.warning'), '')

    def test_sync_enables_geo_schedule_without_duplicate_entries(self):
        self.assertTrue(self.login()['ok'])
        for _ in range(2):
            result = self.run_action('sync')
            self.assertTrue(result['ok'], result)
        crontab = (self.root/'etc/crontabs/root').read_text()
        self.assertEqual(crontab.count('# luci-app-daede geo-update'), 1)
        self.assertIn('17 4 * * * /usr/share/luci-app-daede/update-geo.sh geoip;', crontab)
        self.assertEqual((self.root/'cron-calls').read_text().splitlines(),
                         ['enable', 'restart', 'enable', 'restart'])
        store = json.loads((self.root/'store.json').read_text())
        self.assertEqual(store['daede.config.geo_auto'], '1')
        self.assertEqual(store['daede.config.geo_auto_freq'], 'daily')
        self.assertEqual(store['daede.config.geoip_url'], 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat')
        self.assertNotIn('ghfast', store['daede.config.geosite_url'])

    def test_geo_schedule_failure_is_reported_after_config_starts(self):
        self.assertTrue(self.login()['ok'])
        self.write('usr/share/luci-app-daede/geo-cron.sh', '#!/bin/sh\nexit 1\n', executable=True)
        result = self.run_action('sync')
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'Configuration is running but data update schedule could not be enabled')
        self.assertTrue((self.root/'running').exists())
        self.assertIn('br-lan', (self.root/'etc/dae/config.dae').read_text())

    def test_real_warnings_and_stale_snapshot_remain_visible(self):
        self.login()
        for fields in [{'warnings': ['unsupported rule']}, {'warnings': [], 'staleSnapshot': True}]:
            self.write('api-convert.json', json.dumps({'job': {'id': 'test-job', **fields}}))
            result = self.run_action('sync')
            self.assertTrue(result.get('ok'))
            self.assertTrue(result.get('warning'))

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
        (self.root/'var/log/dae').mkdir(parents=True)
        self.write('var/log/dae/dae.log', 'fatal: missing routing dataset')
        result = self.run_action('sync')
        self.assertFalse(result['ok'])
        self.assertIn('/tmp/daede-member/last-start.log', result['error'])
        evidence = self.root/'tmp/daede-member/last-start.log'
        self.assertIn('fatal: missing routing dataset', evidence.read_text())
        self.assertEqual(evidence.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root/'var/log/dae/dae.log').exists())
        self.assertEqual((self.root/'etc/dae/config.dae').read_text(),'old')
        self.assertEqual(json.loads((self.root/'store.json').read_text())['dae.config.config_file'],'/etc/dae/custom.dae')
        self.assertTrue((self.root/'running').exists())
    def test_lock_consumes_staged_request(self):
        import fcntl
        lock = open(self.root/'tmp/daede-member-operation.lock', 'w')
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertFalse(self.login()['ok'])
        self.assertFalse(list((self.root/'tmp').glob('daede-member-request.*')))
    def test_status_works_while_mutation_locked(self):
        self.assertTrue(self.login()['ok'])
        import fcntl
        with open(self.root/'tmp/daede-member-operation.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(self.run_action('status')['logged_in'])
            self.assertFalse(self.run_action('sync')['ok'])

    def test_orphan_legacy_lock_does_not_block_new_operations(self):
        (self.root/'tmp/daede-member.lock').mkdir()
        self.assertTrue(self.login()['ok'])

    def test_background_sync_reports_final_result(self):
        self.assertTrue(self.login()['ok'])
        token = 'b' * 32
        self.assertEqual(self.run_action('start', token, 'sync')['job'], token)
        for _ in range(100):
            result = self.run_action('result', token)
            if not result.get('pending'): break
            time.sleep(.1)
        self.assertTrue(result.get('ok'), result)
        self.assertIn('last_sync', result)
        self.assertFalse((self.root/f'tmp/daede-member/job.{token}').exists())

    def test_http_failures_are_distinguished_without_replacing_config(self):
        self.assertTrue(self.login()['ok'])
        self.write('etc/dae/config.dae', 'previous config')
        for code, expected in [('401', '登录已过期'), ('403', 'HTTP 403'), ('554', 'HTTP 554')]:
            self.write('http-status', code)
            result = self.run_action('sync')
            self.assertFalse(result['ok'])
            self.assertIn(expected, result['error'])
            self.assertEqual((self.root/'etc/dae/config.dae').read_text(), 'previous config')

    def test_known_node_warning_explains_skipped_protocols(self):
        self.assertTrue(self.login()['ok'])
        message = '已跳过 7 个不支持协议节点：vmess, anytls'
        self.write('api-convert.json', json.dumps({'job': {'id': 'test-job', 'warnings': [message]}}))
        self.assertEqual(self.run_action('sync')['warning'], '订阅转换提示：' + message)

    def test_unknown_warning_has_no_nonexistent_report_instruction(self):
        self.assertTrue(self.login()['ok'])
        self.write('api-convert.json', json.dumps({'job': {'id': 'test-job', 'warnings': ['unrecognized-private-detail']}}))
        result = self.run_action('sync')
        self.assertTrue(result['ok'])
        self.assertTrue(result['running'])
        self.assertNotIn('报告', result['warning'])
        self.assertNotIn('unrecognized-private-detail', result['warning'])

    def test_placeholder_and_backend_guard(self):
        self.login(); self.write('bad-placeholder','1')
        self.assertFalse(self.run_action('sync')['ok'])
        self.assertFalse((self.root/'etc/dae/config.dae').exists())
        d=json.loads((self.root/'store.json').read_text()); d['daede.config.active_backend']='daed'; self.write('store.json',json.dumps(d))
        self.assertFalse(self.run_action('sync')['ok'])

if __name__=='__main__': unittest.main()
