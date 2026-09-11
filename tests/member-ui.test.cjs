// 2026-09-11: Exercise credential transport and cloud-mode guards without a router.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = readFileSync(require('node:path').join(__dirname, '../luci-app-daede/htdocs/luci-static/resources/view/daede/member.js'), 'utf8');

function setup(response = { ok: true, mode: 'local' }) {
  const calls = [];
  const elements = [];
  function E(tag, attrs = {}, children = []) {
    const el = { tag, attrs, children, value: attrs.value || '', disabled: false, options: [], listeners: {},
      textContent: typeof children === 'string' ? children : '',
      appendChild(child) { this.options.push(child); },
      addEventListener(event, fn) { this.listeners[event] = fn; }
    };
    elements.push(el);
    return el;
  }
  const fs = {
    exec: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: JSON.stringify(response) }; },
    write: async (path, body, mode) => { calls.push({ path, body, mode }); },
    remove: async (path) => { calls.push({ remove: path }); }
  };
  const window = { crypto: webcrypto, location: { reload() { calls.push({ reload: true }); } } };
  const api = new Function('baseclass', 'fs', 'ui', 'window', 'E', source)({ extend: o => o }, fs, {}, window, E);
  return { api, calls, elements, fs };
}

test('cloud state blocks local writers, local state permits them', async () => {
  await assert.rejects(setup({ ok: true, mode: 'cloud' }).api.assertLocal(), /云端配置/);
  await setup().api.assertLocal();
});

test('unavailable or malformed status fails closed', async () => {
  await assert.rejects(setup({ ok: false, error: 'busy' }).api.assertLocal(), /busy/);
  const s = setup();
  s.fs.exec = async () => ({ code: 0, stdout: '<html>wrong service</html>' });
  await assert.rejects(s.api.assertLocal(), /返回异常/);
});

test('login stages credentials privately, passes only random identifier, removes request', async () => {
  const s = setup();
  s.api.render({ memberState: {}, netDevs: ['br-lan'] });
  const inputs = s.elements.filter(e => e.tag === 'input');
  inputs[0].value = 'https://rules.example';
  inputs[1].value = 'test-member';
  inputs[2].value = 'test secret $()\n"';
  s.elements.find(e => e.textContent === '登录会员').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const staged = s.calls.find(c => c.body);
  assert.equal(staged.mode, 384);
  assert.equal(JSON.parse(staged.body).password, 'test secret $()\n"');
  assert.match(staged.path, /^\/tmp\/daede-member-request\.[a-f0-9]{32}\.json$/);
  const request = s.calls.find(c => c.command);
  assert.equal(request.args[0], 'login');
  assert.match(request.args[1], /^[a-f0-9]{32}$/);
  assert.equal(request.args.length, 2);
  assert.ok(s.calls.some(c => c.remove === staged.path));
  assert.equal(inputs[2].value, '');
});

test('failed login clears input and removes staging file without reload', async () => {
  const s = setup({ ok: false, error: '登录失败' });
  s.api.render({ memberState: {}, netDevs: ['br-lan'] });
  const inputs = s.elements.filter(e => e.tag === 'input');
  inputs[0].value = 'https://rules.example'; inputs[1].value = 'test'; inputs[2].value = 'secret';
  s.elements.find(e => e.textContent === '登录会员').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(s.calls.some(c => c.remove));
  assert.equal(inputs[2].value, '');
  assert.ok(!s.calls.some(c => c.reload));
  assert.equal(s.elements.find(e => e.attrs.role === 'status').textContent, '登录失败');
});

test('sync is disabled when logged out or helper unavailable', () => {
  for (const ctx of [{ memberState: {} }, { memberState: { logged_in: true }, memberError: 'unavailable' }]) {
    const s = setup(); s.api.render({ ...ctx, netDevs: ['br-lan'] });
    assert.equal(s.elements.find(e => e.textContent === '同步并启用').disabled, true);
  }
});
