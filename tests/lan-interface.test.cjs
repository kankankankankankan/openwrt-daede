const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '../luci-app-daede/htdocs/luci-static/resources/view/daede/lan-interface.js'), 'utf8');
class Base {}
Base.extend = obj => Object.assign(class extends Base {}, { prototypeUnused: obj });
const baseclass = { extend: obj => Object.assign(class extends Base {}, { api: obj }) };
const exported = new Function('baseclass', source)(baseclass);
const { recommendLanInterface } = exported.api || exported;
test('helper exports a LuCI class constructor', () => {
  assert.equal(typeof exported, 'function');
  assert.ok(exported.prototype instanceof Base);
});

function device(name, up = true) {
  return { getName: () => name, isUp: () => up };
}
function protocol(name, l2, up = true) {
  return { getName: () => name, getL2Device: () => l2, isUp: () => up };
}

 test('uses real LuCI Protocol and Device methods and calls isUp()', () => {
  let called = false;
  const lan = protocol('lan', { getName: () => 'br-lan' });
  lan.isUp = () => { called = true; return true; };
  const result = recommendLanInterface({ networks: [lan] });
  assert.equal(called, true);
  assert.equal(result.recommended, 'br-lan');
  assert.equal(result.value, 'br-lan');
  assert.equal(result.status, 'recommended');
});

test('uses firewall zone getNetworks names with real network lookup', () => {
  const result = recommendLanInterface({
    networks: [protocol('home', device('br-home'))],
    zones: [{ getName: () => 'lan', getNetworks: () => ['home'] }]
  });
  assert.equal(result.recommended, 'br-home');
  assert.equal(result.value, 'br-home');
});

test('saved value wins while explicit recommendation remains available', () => {
  const result = recommendLanInterface({ saved: 'old-lan', networks: [protocol('lan', device('br-lan'))] });
  assert.equal(result.value, 'old-lan');
  assert.equal(result.recommended, 'br-lan');
  assert.equal(result.status, 'saved');
});

test('offline protocol is excluded by calling isUp()', () => {
  const result = recommendLanInterface({ networks: [protocol('lan', device('br-lan'), false)] });
  assert.equal(result.recommended, '');
  assert.equal(result.value, '');
  assert.equal(result.status, 'manual');
});

test('does not guess when evidence is ambiguous or absent', () => {
  for (const input of [
    { networks: [protocol('lan', device('br-a')), protocol('lan', device('br-b'))] },
    { networks: [] }
  ]) {
    const result = recommendLanInterface(input);
    assert.equal(result.value, '');
    assert.equal(result.recommended, '');
    assert.equal(result.status, 'manual');
  }
});

test('saved missing device is retained with an explicit warning even if a recommendation exists', () => {
  const result = recommendLanInterface({ saved: 'old-lan', devices: ['br-lan'], networks: [protocol('lan', device('br-lan'))] });
  assert.equal(result.value, 'old-lan');
  assert.equal(result.recommended, 'br-lan');
  assert.match(result.message, /不存在/);
});

test('unknown runtime state is not enough to recommend', () => {
  const result = recommendLanInterface({ networks: [{ getName: () => 'lan', getL2Device: () => device('br-lan') }] });
  assert.equal(result.recommended, '');
});

test('firewall fallback explains its actual source and VLAN bridge is preserved', () => {
  const result = recommendLanInterface({ networks: [protocol('home', device('br-home.10'))], zones: [{ getName: () => 'lan', getNetworks: () => ['home'] }] });
  assert.equal(result.recommended, 'br-home.10');
  assert.match(result.message, /防火墙/);
});

test('config ACL permits read-only firewall discovery', () => {
  const acl = JSON.parse(readFileSync(path.join(__dirname, '../luci-app-daede/root/usr/share/rpcd/acl.d/luci-app-daede.json')));
  assert.ok(acl['luci-app-daede'].read.uci.includes('firewall'));
  assert.ok(!acl['luci-app-daede'].write.uci.includes('firewall'));
});

test('config loads firewall module API instead of network.getZone', () => {
  const config = readFileSync(path.join(__dirname, '../luci-app-daede/htdocs/luci-static/resources/view/daede/config.js'), 'utf8');
  assert.match(config, /require firewall/);
  assert.doesNotMatch(config, /network\.getZone/);
  assert.match(config, /firewall\.getZone/);
});

test('member select preserves missing saved value and has no arbitrary first selection', () => {
  const member = readFileSync(path.join(__dirname, '../luci-app-daede/htdocs/luci-static/resources/view/daede/member.js'), 'utf8');
  assert.match(member, /selectedIndex = -1|placeholder/);
  assert.doesNotMatch(member, /selectedIndex = 0/);
});
