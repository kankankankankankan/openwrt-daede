// 2026-09-22: exercise filter changes after real log rendering and subsequent appends.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const source = readFileSync(join(__dirname, '../luci-app-daede/htdocs/luci-static/resources/view/daede/log.js'), 'utf8');

async function setup(initial) {
  const elements = [];
  function E(tag, attrs = {}, children = []) {
    const classes = new Set((attrs.class || '').split(' '));
    const node = {
      tag, attrs, children: [], listeners: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); },
      set textContent(s) { this.children = [s]; },
      get firstChild() { return this.children[0]; },
      appendChild(c) { this.children.push(...(c.tag === 'fragment' ? c.children : [c])); },
      removeChild(c) { this.children.splice(this.children.indexOf(c), 1); },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this.attrs[name] = value; },
      querySelectorAll(selector) { return this.children.filter(c => c.classList?.contains(selector.slice(1))); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    };
    for (const child of Array.isArray(children) ? children : [children]) node.appendChild(child);
    elements.push(node);
    return node;
  }
  let content = initial;
  let tick;
  // LuCI supplies String.format; scope its small substitute to this test module.
  const previous = String.prototype.format;
  String.prototype.format = function (...args) { let i = 0; return this.replace(/%[ds]/g, () => args[i++]); };
  try {
    const api = new Function('view', 'backend', 'fs', 'poll', 'E', 'document', '_', 'styles', source)(
      { extend: x => x }, {},
      { stat: async () => ({ size: content.length }), read_direct: async () => content },
      { add: fn => { tick = fn; } }, E, { createDocumentFragment: () => E('fragment') }, x => x, { CSS: '' });
    api.render({ name: 'dae', backend: { log: '/fixture/dae.log' } });
    await new Promise(resolve => setImmediate(resolve));
    const pane = elements.find(e => e.attrs.id === 'dd-log-pane');
    const select = elements.find(e => e.tag === 'select');
    const visible = () => pane.children.filter(e => !e.classList.contains('dd-hidden')).map(e => e.textContent);
    return {
      visible,
      filter(value) { select.value = value; select.listeners.change(); return visible(); },
      async append(line) { content += line; await tick(); },
      cleanup() { if (previous === undefined) delete String.prototype.format; else String.prototype.format = previous; }
    };
  } catch (error) {
    if (previous === undefined) delete String.prototype.format; else String.prototype.format = previous;
    throw error;
  }
}

test('level filters remain correct after rendering and while new lines arrive', async () => {
  const s = await setup('time="Sep 22 07:04:59" level=info msg="connected"\n'
    + '[2026-09-22T07:05:00Z] TRACE routing\nDEBUG detail\nWARNING retry\nERROR failed\n');
  try {
    for (const [level, expected] of [['info', 'connected'], ['trace', 'routing'], ['debug', 'detail'], ['warn', 'retry'], ['error', 'failed']]) {
      const rows = s.filter(level);
      assert.equal(rows.length, 1, level);
      assert.ok(rows[0].includes(expected), level);
    }
    s.filter('info');
    await s.append('time="Sep 22 07:06:00" level=info msg="second"\nDEBUG hidden\n');
    assert.equal(s.visible().length, 2);
    s.filter('debug');
    assert.equal(s.filter('info').length, 2);
    assert.equal(s.filter('').length, 7);
  } finally { s.cleanup(); }
});

test('node and proxy filters use word boundaries from the original log', async () => {
  const s = await setup('time="Sep 22 07:04:59" level=info msg="alive"\n'
    + 'INFO group test selects dialer node\nINFO client <-> server\nINFO ordinary\n');
  try {
    assert.equal(s.filter('node_status').length, 2);
    assert.equal(s.filter('proxy_traffic').length, 1);
    assert.equal(s.filter('').length, 4);
  } finally { s.cleanup(); }
});
