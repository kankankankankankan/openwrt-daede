const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const source = readFileSync(__dirname + '/../luci-app-daede/htdocs/luci-static/resources/view/daede/updates.js', 'utf8');
function load(stdout) {
  return new Function('fs', source.slice(0, source.indexOf('return view.extend')) + '\nreturn { probePkg, currentPreset, GEO_PRESETS };')({ exec: async () => ({ stdout }) });
}
test('absent package stays absent when a candidate exists', async () => {
  assert.deepEqual(await load('\t2026.09.20-r3\n').probePkg('dae'), { installed: '', latest: '2026.09.20-r3' });
});
test('installed upstream version is preserved without a candidate', async () => {
  assert.deepEqual(await load('1.0.0-r1\t\n').probePkg('dae'), { installed: '1.0.0-r1', latest: '' });
});
test('only direct presets remain, custom URLs remain editable', () => {
  const api = load('');
  assert.deepEqual(Object.keys(api.GEO_PRESETS), ['loyalsoldier', 'v2fly']);
  assert.equal(api.currentPreset('', ''), 'loyalsoldier');
  assert.equal(api.currentPreset('https://example.test/ip', 'https://example.test/site'), 'custom');
});
