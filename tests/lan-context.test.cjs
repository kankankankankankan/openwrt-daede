const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../luci-app-daede/htdocs/luci-static/resources/view/daede');
const helper = new Function('baseclass', readFileSync(path.join(root, 'lan-interface.js'), 'utf8'))({ extend: obj => obj });
const source = readFileSync(path.join(root, 'config.js'), 'utf8');

function load({ failed = false, memberSaved = '' } = {}) {
  const writes = [];
  const dev = { getName: () => 'br-lan' };
  const network = {
    getDevices: async () => { if (failed) throw Error('offline'); return [dev]; },
    getNetworks: async () => { if (failed) throw Error('offline'); return [{ getName: () => 'lan', getL2Device: () => dev, isUp: () => true }]; }
  };
  const firewall = { getZone: async () => { if (failed) throw Error('denied'); return null; } };
  const uci = { load: async () => {}, get: () => 'saved-lan', set: (...args) => writes.push(args), save: () => writes.push('save') };
  const view = { extend: obj => obj };
  const backend = { detectBackend: async () => ({ backend: { uci: 'dae' } }) };
  const member = { getStatus: async () => ({ lan_interface: memberSaved }) };
  const api = new Function('uci', 'network', 'firewall', 'view', 'backend', 'member', 'lanInterface', source)(uci, network, firewall, view, backend, member, helper);
  return { api, writes };
}

test('context discovery uses network/firewall APIs without UCI writes and keeps member-specific saved selection', async () => {
  const s = load({ memberSaved: 'member-old' });
  const ctx = await s.api.load();
  assert.equal(ctx.lanRecommendation.value, 'saved-lan');
  assert.equal(ctx.lanRecommendation.recommended, 'br-lan');
  assert.equal(ctx.memberLanRecommendation.value, 'member-old');
  assert.match(ctx.memberLanRecommendation.message, /不存在/);
  assert.deepEqual(s.writes, []);
});

test('failed discovery still loads page and preserves saved selection without guessing', async () => {
  const s = load({ failed: true });
  const ctx = await s.api.load();
  assert.equal(ctx.lanRecommendation.value, 'saved-lan');
  assert.equal(ctx.lanRecommendation.recommended, '');
  assert.deepEqual(ctx.netDevs, []);
  assert.deepEqual(s.writes, []);
});
