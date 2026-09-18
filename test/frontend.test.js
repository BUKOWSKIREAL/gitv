'use strict';
/* Frontend tests for public/app.js.
 * Runs the real app script in a node:vm context against a minimal DOM stub —
 * no browser, no jsdom, no dependencies. RAF/clock are deterministic so node
 * motion can be stepped frame by frame. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(
  process.env.APP_JS || path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* ---------------- minimal DOM ---------------- */

class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { for (const x of c) this.s.add(x); }
  remove(...c) { for (const x of c) this.s.delete(x); }
  toggle(c, f) {
    const on = f === undefined ? !this.s.has(c) : !!f;
    if (on) this.s.add(c); else this.s.delete(c);
    return on;
  }
  contains(c) { return this.s.has(c); }
}

class TextNode {
  constructor(t) { this.textContent = String(t); this.parentNode = null; }
  remove() {
    const p = this.parentNode;
    if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); this.parentNode = null; }
  }
}

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.classList = new ClassList();
    this._html = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  remove() {
    const p = this.parentNode;
    if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); this.parentNode = null; }
  }
  addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f); }
  removeEventListener(t, f) {
    const l = this.listeners[t];
    if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  }
  fire(t, ev) { for (const f of (this.listeners[t] || []).slice()) f(ev); }
  set innerHTML(v) { this._setVia = 'innerHTML'; this._html = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._setVia = 'textContent'; this._html = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
  get textContent() { return this._html; }
  querySelector() { return new El('stub'); } // innerHTML isn't parsed; return a benign stand-in
  querySelectorAll() { return []; }
  setPointerCapture() {}
  closest() { return null; }
}

// visible text under an element (TextNodes have no .children)
const textOf = el => el.children === undefined
  ? String(el.textContent ?? '')
  : el.children.map(textOf).join(' ');

/* ---------------- harness ---------------- */

function harness(state, opts = {}) {
  const byId = new Map();
  const get = id => {
    if (!byId.has(id)) {
      const e = new El(id === 'svg' ? 'svg' : 'div');
      if (id === 'drawer') e.classList.add('hidden'); // matches index.html
      byId.set(id, e);
    }
    return byId.get(id);
  };
  let now = 0;
  const rafQ = [];
  const winL = {};
  let es = null;
  // /api/state response; override via opts.stateRes {ok,status,body}
  const stateRes = opts.stateRes || { ok: true, status: 200, body: state };
  // /api/detail handler: async id => {ok,status,body} (may throw or stay pending)
  const detail = opts.detail || (async () => ({ ok: false, status: 404, body: { error: 'not found' } }));

  const sandbox = {
    document: {
      getElementById: get,
      createElementNS: (ns, t) => new El(t),
      createTextNode: t => new TextNode(t),
    },
    innerWidth: 1600, innerHeight: 1000,
    location: { hash: '' },
    performance: { now: () => now },
    requestAnimationFrame: cb => { rafQ.push(cb); return rafQ.length; },
    setTimeout, clearTimeout,
    addEventListener: (t, f) => (winL[t] || (winL[t] = [])).push(f),
    removeEventListener: (t, f) => {
      const l = winL[t];
      if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
    },
    fetch: async url => {
      if (url === '/api/state')
        return { ok: stateRes.ok, status: stateRes.status, json: async () => stateRes.body };
      if (url.startsWith('/api/detail')) {
        const r = await detail(decodeURIComponent(url.split('id=')[1]), url);
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    EventSource: class { constructor() { es = this; } },
    console,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(APP, ctx, { filename: 'public/app.js' });

  const run = src => vm.runInContext(src, ctx);
  // drain pending promise continuations from the boot IIFE (fetch -> json -> applyState)
  const flush = async () => {
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
  };
  // advance fake clock and fire all queued RAF callbacks for that frame
  const step = ms => { now += ms; for (const cb of rafQ.splice(0)) cb(now); };
  const settle = () => { let g = 0; while (rafQ.length && g++ < 500) step(60); };
  const fireWin = (t, ev) => { for (const f of (winL[t] || []).slice()) f(ev); };
  const push = (s, changes) =>
    es.onmessage({ data: JSON.stringify({ type: 'state', state: s, changes: changes || null }) });

  return { run, flush, step, settle, fireWin, push, byId, rafQ,
           get es() { return es; }, get now() { return now; } };
}

/* ---------------- fixtures (shape mirrors src/repo.js buildState) ---------------- */

const O = (sha, type, data) => ({
  sha, type, size: 42, reachable: true,
  prov: { kind: 'loose', path: sha.slice(0, 2) + '/' + sha.slice(2) },
  data,
});
const commit = (sha, tree, parents = []) =>
  O(sha, 'commit', { tree, parents, subject: 's ' + sha, committer: { ts: 1 } });
const tree = (sha, entries) => O(sha, 'tree', { entries, total: entries.length });
const blob = (sha, lines) => O(sha, 'blob', { preview: { lines, binary: false, truncated: false } });
const ent = (name, sha, type = 'blob') => ({ mode: '100644', name, sha, type });

function mkState(over = {}) {
  return {
    repoPath: '/r/demo', gitDir: '/r/demo/.git',
    head: { type: 'none' }, refs: [], packs: [],
    index: { entries: [] }, indexTotal: 0,
    status: [], statusTotal: 0,
    objects: [],
    counts: { commits: 0, trees: 0, blobs: 0, tags: 0, loose: 0, packed: 0,
              unreachable: 0, shown: 0, total: 0, truncated: false },
    time: 0,
    ...over,
  };
}

const baseState = () => mkState({
  objects: [
    commit('c1', 't1'),
    tree('t1', [ent('a.txt', 'b1'), ent('sub', 't2', 'tree')]),
    tree('t2', [ent('b.txt', 'b2')]),
    blob('b1', ['alpha']),
    blob('b2', ['beta']),
  ],
  refs: [{ name: 'refs/heads/main', sha: 'c1', sym: null, file: 'x', source: 'loose', short: 'main', kind: 'branch' }],
  head: { type: 'symbolic', ref: 'refs/heads/main' },
  index: { entries: [{ path: 'a.txt', sha: 'b1', mode: '100644', stage: 0, size: 5, mtime: 1, offset: 0 }] },
  status: [{ path: 'f.txt', x: ' ', y: 'M', size: 5, lines: ['line one'], diff: [{ t: '+', s: 'line one' }] }],
});

/* ---------------- assertions ---------------- */

// every edge path must start/end exactly at its endpoint nodes' rendered x/y
function assertEdgesGlued(h, msg) {
  const ds = new Map(h.run(`[...edgeEls].map(([k, p]) => [k, p.getAttribute('d')])`));
  const eds = h.run(`edges.map(e => [e.key, e.a, e.b])`);
  const pos = new Map(h.run(`[...nodes].map(([id, n]) => [id, [n.x, n.y]])`));
  assert.ok(eds.length > 0, 'expected edges');
  for (const [key, a, b] of eds) {
    const d = ds.get(key);
    assert.ok(d, `${msg}: no path for ${key}`);
    const nums = d.match(/-?[\d.]+/g).map(Number);
    const [ax, ay] = pos.get(a), [bx, by] = pos.get(b);
    assert.ok(Math.abs(nums[0] - ax) < 1e-9 && Math.abs(nums[1] - ay) < 1e-9,
      `${msg}: ${key} starts at ${nums[0]},${nums[1]} but node ${a} is at ${ax},${ay}`);
    assert.ok(Math.abs(nums[nums.length - 2] - bx) < 1e-9 && Math.abs(nums[nums.length - 1] - by) < 1e-9,
      `${msg}: ${key} ends at ${nums[nums.length - 2]},${nums[nums.length - 1]} but node ${b} is at ${bx},${by}`);
  }
}

// displayed transform must equal the same x/y the edges use
function assertTransforms(h, msg) {
  const bad = h.run(
    `[...nodes.values()].filter(n => n.el.style.transform !== 'translate(' + n.x + 'px,' + n.y + 'px)').map(n => n.id)`);
  assert.equal(bad.length, 0, `${msg}: transform != x/y for ${bad}`);
}

/* ---------------- tests ---------------- */

test('first render: node transform and edge endpoints share n.x/n.y every frame', async () => {
  const h = harness(baseState());
  await h.flush(); // boot fetch + applyState

  assert.ok(h.run('nodes.size') >= 8, 'nodes created'); // objs + ref + HEAD + idx + wd
  assert.equal(h.run('edges.length'), h.run('edgeEls.size'));
  assert.ok(h.run('edgeEls.size') >= 6); // ctree, child×2, ref, head, idx

  // nodes enter at ty-30 and tween down — edges must track mid-flight too
  assert.ok(h.run(`nodes.get('c1').y !== nodes.get('c1').ty`), 'entry drop-in armed');
  h.step(120);
  assertEdgesGlued(h, 'mid-entry');
  assertTransforms(h, 'mid-entry');

  h.settle();
  assertEdgesGlued(h, 'settled');
  assertTransforms(h, 'settled');
  assert.ok(h.run(`[...nodes.values()].every(n => n.pinned || (n.x === n.tx && n.y === n.ty))`),
    'all nodes reached layout targets');
});

test('relayout: edges stay attached to nodes throughout the move', async () => {
  const h = harness(baseState());
  await h.flush();
  h.settle();
  const oldT1y = h.run(`nodes.get('t1').y`);

  // add commits -> commit zone grows -> every zone below shifts down
  const s2 = baseState();
  for (let i = 2; i <= 6; i++)
    s2.objects.push(commit('c' + i, 't1'));
  s2.objects[0].data.parents = ['c2'];
  s2.counts.commits = 6;
  h.push(s2, null);

  const newT1ty = h.run(`nodes.get('t1').ty`);
  assert.notEqual(newT1ty, oldT1y, 'relayout actually moved t1');
  assert.ok(h.run(`nodes.get('t1').anim`), 'move tween armed');

  h.step(150); // mid-flight
  const midY = h.run(`nodes.get('t1').y`);
  assert.ok(midY !== newT1ty, 'still moving');
  assertEdgesGlued(h, 'mid-relayout');
  assertTransforms(h, 'mid-relayout');

  h.settle();
  assertEdgesGlued(h, 'after relayout');
  assertTransforms(h, 'after relayout');
  assert.equal(h.run(`nodes.get('t1').y`), newT1ty);
});

test('drag: pinned node follows pointer in world coords, edges track it, relayout keeps it', async () => {
  const h = harness(baseState());
  await h.flush();
  h.settle();

  const g = h.run(`nodes.get('b2').el`);
  g.fire('pointerdown', { clientX: 10, clientY: 10, pointerId: 1, stopPropagation() {} });
  assert.equal(h.run(`nodes.get('b2').pinned`), true);
  assert.equal(h.run('dragging === null'), false);

  const ev = { clientX: 555, clientY: 333 };
  h.byId.get('svg').fire('pointermove', ev);
  h.fireWin('pointermove', ev);

  const want = h.run('toWorld({clientX: 555, clientY: 333})');
  assert.ok(Math.abs(h.run(`nodes.get('b2').x`) - want.x) < 1e-9, 'x follows pointer');
  assert.ok(Math.abs(h.run(`nodes.get('b2').y`) - want.y) < 1e-9, 'y follows pointer');
  assertEdgesGlued(h, 'during drag'); // t2->b2 end glued to b2
  assertTransforms(h, 'during drag');

  h.fireWin('pointerup', {});
  assert.equal(h.run('dragging === null'), true);

  // relayout must not move a pinned node, and edges must stay on it
  const px = h.run(`nodes.get('b2').x`), py = h.run(`nodes.get('b2').y`);
  const s2 = baseState();
  for (let i = 2; i <= 6; i++) s2.objects.push(commit('c' + i, 't1'));
  h.push(s2, null);
  h.step(150);
  assert.equal(h.run(`nodes.get('b2').x`), px, 'pinned x unmoved mid-relayout');
  assert.equal(h.run(`nodes.get('b2').y`), py, 'pinned y unmoved mid-relayout');
  assertEdgesGlued(h, 'relayout with pinned');
  h.settle();
  assertEdgesGlued(h, 'settled with pinned');
});

test('equal-length content change re-renders body (sig uses real content)', async () => {
  const s1 = baseState();
  const h = harness(s1);
  await h.flush();
  h.settle();

  h.run(`__rb = 0; renderBody = (f => n => { __rb++; return f(n); })(renderBody)`);
  const before = textOf(h.run(`nodes.get('b1').body`));
  assert.ok(before.includes('alpha'));

  // same serialized length as 'alpha' -> old length-based sig would miss this
  const s2 = baseState();
  s2.objects.find(o => o.sha === 'b1').data.preview.lines = ['omega'];
  h.push(s2, null);
  h.settle();

  assert.equal(h.run('__rb'), 1, 'body re-rendered exactly once');
  assert.ok(textOf(h.run(`nodes.get('b1').body`)).includes('omega'));
  assertEdgesGlued(h, 'after content update');

  // identical state -> sig stable -> no spurious re-render
  h.push(s2, null);
  assert.equal(h.run('__rb'), 1, 'no re-render on identical content');
});

test('notices: index.error, partial graph suppresses ghost, warnings', async () => {
  const s = baseState();
  s.index = { entries: [], error: 'v4 split index unsupported' };
  s.reachabilityComplete = false;
  s.warnings = ['pack scan <slow> skipped'];
  s.objects.find(o => o.sha === 'b1').reachable = false;
  const h = harness(s);
  await h.flush();
  h.settle();

  const n = h.byId.get('notice');
  assert.ok(n.textContent.includes('v4 split index unsupported'), 'index.error shown');
  assert.ok(n.textContent.includes('partial graph'), 'partial graph shown');
  assert.ok(n.textContent.includes('pack scan <slow> skipped'), 'warning shown');
  assert.notEqual(n._setVia, 'innerHTML', 'notice must not be written via innerHTML');
  // unreachable object NOT ghosted while reachability is incomplete
  assert.equal(h.run(`nodes.get('b1').el.classList.contains('ghost')`), false);

  // reachability completes -> ghost appears, partial notice gone, index error stays
  const s2 = baseState();
  s2.index = { entries: [], error: 'v4 split index unsupported' };
  s2.objects.find(o => o.sha === 'b1').reachable = false;
  h.push(s2, null);
  h.settle();
  assert.equal(h.run(`nodes.get('b1').el.classList.contains('ghost')`), true);
  assert.ok(!n.textContent.includes('partial graph'));
  assert.ok(n.textContent.includes('v4 split index unsupported'));
});

test('detail: backend error object renders escaped message', async () => {
  const h = harness(baseState(), {
    detail: async id => ({ ok: false, status: 500, body: { error: `object <${id}> not found & "gone"` } }),
  });
  await h.flush();
  h.settle();

  h.run(`openDetail('b1')`);
  await h.flush();
  const drawer = h.byId.get('drawer');
  assert.equal(drawer.classList.contains('hidden'), false, 'drawer opens');
  assert.ok(drawer.innerHTML.includes('error'), 'error badge/step present');
  assert.ok(drawer.innerHTML.includes('&lt;b1&gt;'), 'error text escaped');
  assert.ok(drawer.innerHTML.includes('&amp;'), 'ampersand escaped');
  assert.ok(!drawer.innerHTML.includes('<b1>'), 'no raw injected markup');
});

test('detail: fetch failure shows error instead of blank drawer', async () => {
  const h = harness(baseState(), {
    detail: async () => { throw new Error('conn refused'); },
  });
  await h.flush();
  h.settle();

  h.run(`openDetail('c1')`);
  await h.flush();
  const drawer = h.byId.get('drawer');
  assert.equal(drawer.classList.contains('hidden'), false);
  assert.ok(drawer.innerHTML.includes('conn refused'));
});

test('detail: stale responses cannot clobber newer selection or closed drawer', async () => {
  const pending = new Map();
  const h = harness(baseState(), {
    detail: id => new Promise(r => pending.set(id, r)),
  });
  await h.flush();
  h.settle();

  // select c1 then t1; c1 resolves late -> must be dropped
  h.run(`openDetail('c1')`);
  h.run(`openDetail('t1')`);
  pending.get('c1')({ ok: true, body: { title: 'STALE-C1', steps: [] } });
  await h.flush();
  assert.ok(!h.byId.get('drawer').innerHTML.includes('STALE-C1'), 'stale response dropped');

  pending.get('t1')({ ok: true, body: { title: 'FRESH-T1', steps: [] } });
  await h.flush();
  assert.ok(h.byId.get('drawer').innerHTML.includes('FRESH-T1'), 'newest response wins');

  // close while a request is in flight -> late response must not reopen it
  h.run(`openDetail('b2')`);
  h.run('closeDrawer()');
  pending.get('b2')({ ok: true, body: { title: 'LATE-B2', steps: [] } });
  await h.flush();
  assert.equal(h.byId.get('drawer').classList.contains('hidden'), true, 'stays closed');
  assert.ok(!h.byId.get('drawer').innerHTML.includes('LATE-B2'));
});

test('startup: 503 shows notice, SSE null/loading ignored, later state recovers', async () => {
  const h = harness(baseState(), {
    stateRes: { ok: false, status: 503, body: { error: 'index still building' } },
  });
  await h.flush();

  assert.equal(h.run('nodes.size'), 0, 'no graph yet');
  assert.ok(h.byId.get('notice').textContent.includes('index still building'));

  // null / loading pushes are ignored
  h.push(null);
  h.push({ loading: true });
  assert.equal(h.run('nodes.size'), 0);

  // real state over SSE -> graph builds, transient notice clears
  h.push(baseState());
  h.settle();
  assert.ok(h.run('nodes.size') > 0, 'graph built after recovery');
  assert.equal(h.byId.get('notice').textContent, '', 'notice cleared by good state');
  assertEdgesGlued(h, 'post-recovery');
});

test('SSE type:error surfaces message in notice', async () => {
  const h = harness(baseState());
  await h.flush();
  h.settle();

  h.es.onmessage({ data: JSON.stringify({ type: 'error', message: 'watcher died <x>' }) });
  const n = h.byId.get('notice');
  assert.ok(n.textContent.includes('watcher died <x>'));
  assert.notEqual(n._setVia, 'innerHTML', 'error shown as text, not HTML');

  // recovered by next good state
  h.push(baseState());
  assert.equal(n.textContent, '');
});
