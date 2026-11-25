const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const source = readFileSync(__dirname + '/../luci-app-daede/htdocs/luci-static/resources/view/daede/updates.js', 'utf8');
function load(stdout, code = 0, status = 'success') {
  return new Function('fs', 'L', source.slice(0, source.indexOf('return view.extend')) + '\nreturn { probePkg, probeIndex, currentPreset, GEO_PRESETS };')({ exec: async () => ({ code, stdout }), read_direct: async () => status }, { resolveDefault: (value, fallback) => Promise.resolve(value).catch(() => fallback) });
}
test('absent package stays absent when a candidate exists', async () => {
  assert.deepEqual(await load('\t2026.09.20-r3\n').probePkg('dae'), { installed: '', latest: '2026.09.20-r3', state: 'absent' });
});
test('installed upstream version is preserved without a candidate', async () => {
  assert.deepEqual(await load('1.0.0-r1\t\n').probePkg('dae'), { installed: '1.0.0-r1', latest: '', state: 'absent' });
});
test('only direct presets remain, custom URLs remain editable', () => {
  const api = load('');
  assert.deepEqual(Object.keys(api.GEO_PRESETS), ['loyalsoldier', 'v2fly']);
  assert.equal(api.currentPreset('', ''), 'loyalsoldier');
  assert.equal(api.currentPreset('https://example.test/ip', 'https://example.test/site'), 'custom');
});

test('package query failure remains visible instead of claiming absence', async () => {
  assert.deepEqual(await load('', 1).probePkg('dae'), { installed: '', latest: '', state: 'error' });
});

test('index refresh distinguishes success, failure and pending state', async () => {
  for (const [value, expected] of [['success\n', 'success'], ['failed\n', 'failed'], ['', 'running']])
    assert.equal(await load('', 0, value).probeIndex(), expected);
});
