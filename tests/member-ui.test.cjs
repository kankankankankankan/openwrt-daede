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
      replaceWith(child) { this.replacement = child; },
      addEventListener(event, fn) { this.listeners[event] = fn; }
    };
    elements.push(el);
    return el;
  }
  const fs = {
    exec: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: JSON.stringify(typeof response === 'function' ? response(args) : response) }; },
    write: async (path, body, mode) => { calls.push({ path, body, mode }); },
    remove: async (path) => { calls.push({ remove: path }); }
  };
  const document = { listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; }, dispatchEvent(event) { if (this.listeners[event.type]) this.listeners[event.type](event); } };
  const window = { crypto: webcrypto, location: { reload() { calls.push({ reload: true }); } } };
  const CustomEvent = function(type, init) { this.type = type; this.detail = init && init.detail; };
  const api = new Function('baseclass', 'fs', 'ui', 'window', 'document', 'CustomEvent', 'E', source)({ extend: o => o }, fs, {}, window, document, CustomEvent, E);
  return { api, calls, elements, fs, document };
}

function textOf(node) {
  return typeof node === 'string' ? node : node.textContent + (Array.isArray(node.children) ? node.children.map(textOf).join(' ') : '');
}

test('quota card uses real large byte counters and ignores server percent and labels', () => {
  const s = setup();
  assert.equal(typeof s.api.renderUsage, 'function');
  const card = s.api.renderUsage({ memberState: { logged_in: true, quota: {
    planName: '<img src=x onerror=alert(1)>', used: 5 * 1024 ** 3, total: 10 * 1024 ** 3,
    remaining: 1, percent: 99, usedText: 'FAKE', expiresText: '2027-01-01 到期'
  } } });
  const text = textOf(card);
  assert.match(text, /5 GiB/);
  assert.match(text, /10 GiB/);
  assert.match(text, /50%/);
  assert.match(text, /剩余 5 GiB/);
  assert.match(text, /2027-01-01 到期/);
  assert.ok(s.elements.some(e => e.textContent === '<img src=x onerror=alert(1)>'));
  assert.ok(!s.elements.some(e => e.tag === 'img' || e.attrs.innerHTML));
  assert.equal(s.elements.filter(e => e.attrs.role === 'progressbar').length, 1);
  assert.equal(s.elements.find(e => e.attrs.role === 'progressbar').attrs['aria-valuenow'], 50);
  assert.doesNotMatch(text, /FAKE|99%/);
  assert.equal(s.calls.length, 0);
});

test('quota states hide stale counters when logged out or status fails, without retries', () => {
  const stale = { used: 5, total: 10, planName: 'STALE' };
  for (const [ctx, message] of [
    [{ memberState: { logged_in: false, quota: stale } }, /登录会员后查看/],
    [{ memberState: { logged_in: false, quota_status: 'unavailable', quota: stale } }, /暂时无法获取/],
    [{ memberState: { logged_in: true, quota: stale }, memberError: 'busy' }, /暂时无法获取/],
    [{ memberState: { logged_in: true } }, /暂未提供用量/]
  ]) {
    const s = setup(); const card = s.api.renderUsage(ctx);
    assert.match(textOf(card), message);
    assert.doesNotMatch(textOf(card), /STALE|%|0 B/);
    assert.ok(!s.elements.some(e => e.attrs.role === 'progressbar'));
    assert.equal(s.calls.length, 0);
  }
});

test('quota partial counters never become fake zero or unlimited, and complete upload/download can supply used', () => {
  for (const invalid of [undefined, null, '', '0', false, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const s = setup();
    const card = s.api.renderUsage({ memberState: { logged_in: true, quota: { used: invalid, total: 100 } } });
    assert.match(textOf(card), /已用 未提供/);
    assert.doesNotMatch(textOf(card), /%|已用 0 B|无限/);
    assert.ok(!s.elements.some(e => e.attrs.role === 'progressbar'));
  }
  for (const total of [undefined, null, 0]) {
    const s = setup();
    const card = s.api.renderUsage({ memberState: { logged_in: true, quota: { used: 0, total } } });
    assert.match(textOf(card), /已用 0 B \/ 未提供/);
    assert.doesNotMatch(textOf(card), /%|无限/);
    assert.ok(!s.elements.some(e => e.attrs.role === 'progressbar'));
  }
  const s = setup();
  const card = s.api.renderUsage({ memberState: { logged_in: true, quota: { upload: 10, download: 20, total: 100 } } });
  assert.match(textOf(card), /已用 30 B/);
  assert.match(textOf(card), /30%/);
  assert.match(textOf(card), /到期时间未提供/);
});

test('tiny nonzero usage is not rounded to zero and quota is not a nested card', () => {
  const s = setup();
  const card = s.api.renderUsage({ memberState: { logged_in: true, quota: { used: 24 * 1024 ** 2, total: 600 * 1024 ** 3 } } });
  assert.match(textOf(card), /<0.1%/);
  assert.ok(!card.attrs.class.split(' ').includes('dd-card'));
});

test('quota warns at 80 percent, clamps overquota bar, and formats expiry fallback', () => {
  for (const [used, warning, label] of [[0, false, '0%'], [79, false, '79%'], [80, true, '80%'], [120, true, '120%']]) {
    const s = setup();
    const card = s.api.renderUsage({ memberState: { logged_in: true, quota: { used, total: 100, expiresAt: '2027-01-02T00:00:00Z' } } });
    assert.equal(card.attrs.class.includes('dd-quota-warning'), warning);
    assert.ok(textOf(card).includes(label));
    assert.match(textOf(card), /2027/);
    assert.equal(s.elements.find(e => e.attrs.role === 'progressbar').attrs['aria-valuenow'], Math.min(used, 100));
    if (used > 100) { assert.match(textOf(card), /额度已用尽/); assert.match(textOf(card), /剩余 0 B/); }
  }
});

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
  s.elements.find(e => e.tag === 'select').value = 'br-lan';
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

test('successful login refreshes only the member card with current profile and quota', async () => {
  const s = setup(args => args[0] === 'status' ? { ok: true, logged_in: true, mode: 'cloud', quota: { memberName: 'new-member', used: 10, total: 100 } } : { ok: true, logged_in: true });
  const card = s.api.render({ memberState: { mode: 'cloud' }, netDevs: ['br-lan'] });
  const inputs = s.elements.filter(e => e.tag === 'input');
  inputs[0].value = 'https://rules.example'; inputs[1].value = 'tester'; inputs[2].value = 'test-only';
  s.elements.find(e => e.tag === 'select').value = 'br-lan';
  s.elements.find(e => e.textContent === '登录会员').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(card.replacement);
  assert.match(textOf(card.replacement), /new-member/);
  assert.match(textOf(card.replacement), /已用 10 B/);
  assert.equal(s.calls.filter(c => c.command && c.args[0] === 'status').length, 1);
  assert.ok(!s.calls.some(c => c.reload));
  assert.equal(inputs[2].value, '');
});

test('successful login with failed status refresh does not show stale quota or retry login', async () => {
  const s = setup(args => args[0] === 'status' ? { ok: false, error: 'temporary outage' } : { ok: true, logged_in: true });
  const card = s.api.render({ memberState: { mode: 'local', quota: { memberName: 'OLD', used: 50, total: 100 } }, netDevs: ['br-lan'] });
  const inputs = s.elements.filter(e => e.tag === 'input');
  inputs[0].value = 'https://rules.example'; inputs[1].value = 'tester'; inputs[2].value = 'test-only';
  s.elements.find(e => e.tag === 'select').value = 'br-lan';
  s.elements.find(e => e.textContent === '登录会员').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(card.replacement);
  assert.match(textOf(card.replacement), /登录成功/);
  assert.doesNotMatch(textOf(card.replacement), /OLD|已用 50 B/);
  assert.ok(!s.calls.some(c => c.reload));
  assert.equal(s.calls.filter(c => c.command && c.args[0] === 'login').length, 1);
});

test('logout refreshes only the member card and removes the previous profile', async () => {
  const s = setup(args => args[0] === 'status' ? { ok: true, logged_in: false, mode: 'cloud' } : { ok: true });
  const card = s.api.render({ memberState: { logged_in: true, mode: 'cloud', quota: { memberName: 'OLD', used: 10, total: 100 } }, netDevs: ['br-lan'] });
  s.elements.find(e => e.textContent === '退出登录').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(card.replacement);
  assert.doesNotMatch(textOf(card.replacement), /OLD/);
  assert.match(textOf(card.replacement), /未登录/);
  assert.ok(!s.calls.some(c => c.reload));
});

test('logged-out member card hides previous sync time and rule warning', () => {
  const s = setup();
  const card = s.api.render({ memberState: { logged_in: false, last_sync: '2026-09-12T10:00:00Z', warning: 'previous-member-warning', mode: 'cloud' }, netDevs: ['br-lan'] });
  const status = s.elements.find(e => e.attrs.class === 'dd-member-state');
  assert.equal(status.textContent, '未登录');
  assert.doesNotMatch(textOf(card), /最近同步|规则状态|previous-member-warning/);
});

test('failed login clears input and removes staging file without reload', async () => {
  const s = setup({ ok: false, error: '登录失败' });
  s.api.render({ memberState: {}, netDevs: ['br-lan'] });
  const inputs = s.elements.filter(e => e.tag === 'input');
  inputs[0].value = 'https://rules.example'; inputs[1].value = 'test'; inputs[2].value = 'secret';
  s.elements.find(e => e.tag === 'select').value = 'br-lan';
  s.elements.find(e => e.textContent === '登录会员').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(s.calls.some(c => c.remove));
  assert.equal(inputs[2].value, '');
  assert.ok(!s.calls.some(c => c.reload));
  assert.equal(s.elements.find(e => e.attrs.role === 'status').textContent, '登录失败');
});

test('applying cloud config emits state change for immediate page simplification', async () => {
  const s = setup({ ok: true, warning: '' });
  let emitted;
  s.document.addEventListener('daede-member-state', e => { emitted = e.detail; });
  s.api.render({ memberState: { logged_in: true, mode: 'local' }, netDevs: ['br-lan'] });
  s.elements.find(e => e.textContent === '应用云端配置').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(emitted.mode, 'cloud');
});
test('successful clean sync updates the rule status and cloud badge immediately', async () => {
  const s = setup({ ok: true, warning: '', last_sync: '2026-09-12T10:00:00Z' });
  s.api.render({ memberState: { logged_in: true, mode: 'local', warning: 'old warning', last_sync: '2026-09-11T00:00:00Z' }, netDevs: ['br-lan'] });
  s.elements.find(e => e.textContent === '应用云端配置').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(s.elements.find(e => e.attrs.class === 'dd-member-state').textContent, /规则状态：已加载/);
  assert.ok(s.elements.some(e => e.textContent === '云端配置'));
});

test('sync is disabled when logged out or helper unavailable', () => {
  for (const ctx of [{ memberState: {} }, { memberState: { logged_in: true }, memberError: 'unavailable' }]) {
    const s = setup(); s.api.render({ ...ctx, netDevs: ['br-lan'] });
    assert.equal(s.elements.find(e => e.textContent === '应用云端配置').disabled, true);
  }
});

test('member recommendation replaces a different saved selection only on click without clearing password or persisting', async () => {
  const s = setup();
  s.api.render({ memberState: { lan_interface: 'old-lan' }, netDevs: ['br-lan', 'lan1'], lanRecommendation: { value: 'old-lan', recommended: 'br-lan', status: 'saved', message: '推荐 br-lan' } });
  const button = s.elements.find(e => e.textContent === '使用推荐接口');
  const select = s.elements.find(e => e.tag === 'select');
  const password = s.elements.find(e => e.attrs.type === 'password');
  password.value = 'test-only';
  assert.equal(select.value, 'old-lan');
  assert.ok(select.options.some(o => o.value === 'old-lan'));
  assert.equal(button.disabled, false);
  button.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(select.value, 'br-lan');
  assert.equal(password.value, 'test-only');
  assert.equal(s.calls.length, 0);
});

test('member keeps blank selection when no evidence and preserves a saved fallback absent from device list', () => {
  for (const saved of ['', 'stale-lan']) {
    const s = setup();
    s.api.render({ memberState: {}, netDevs: ['eth0'], lanRecommendation: { value: saved, recommended: '', status: 'manual', message: '请手动选择' } });
    const select = s.elements.find(e => e.tag === 'select');
    assert.equal(select.value, saved);
    assert.ok(select.options.some(o => o.value === saved));
    assert.equal(s.calls.length, 0);
  }
});
