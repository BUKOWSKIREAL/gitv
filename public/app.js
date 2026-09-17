'use strict';
/* gitv frontend: zones → nodes → edges, drag, pan/zoom, live updates via SSE */

const svg = document.getElementById('svg');
const vp = document.getElementById('vp');
const zonesG = document.getElementById('zones');
const edgesG = document.getElementById('edges');
const nodesG = document.getElementById('nodes');
const drawer = document.getElementById('drawer');
const SVGNS = 'http://www.w3.org/2000/svg';

const el = (t, attrs, parent) => {
  const e = document.createElementNS(SVGNS, t);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const txt = (t, s) => { const e = document.createTextNode(s); t.appendChild(e); return t; };
const short = s => s.slice(0, 7);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/* ---------------- state ---------------- */

let state = null;
const nodes = new Map();   // id -> node {id,kind,x,y,w,h,el,body,def,pinned}
const edgeEls = new Map(); // key -> path el
let edges = [];            // {a,b,k,key}
let selected = null;
const view = { x: 0, y: 0, k: 1 };

/* ---------------- defs from state ---------------- */

function buildDefs() {
  const defs = new Map(), edges = [];
  const oids = new Set(state.objects.map(o => o.sha));
  const objBySha = new Map(state.objects.map(o => [o.sha, o]));

  for (const o of state.objects) {
    let d = { id: o.sha, kind: o.type, obj: o };
    if (o.type === 'commit') { d.w = 34; d.h = 46; }
    else if (o.type === 'tag') { d.w = 30; d.h = 30; }
    else if (o.type === 'tree') {
      const rows = Math.min(o.data.entries.length, 7);
      d.w = Math.max(52, ...o.data.entries.slice(0, 7).map(e => Math.min(e.name.length, 24) * 5.4 + 34));
      d.w = Math.min(d.w, 190);
      d.h = 24 + rows * 11 + (o.data.total > 7 ? 10 : 0);
    } else if (o.type === 'blob') {
      const pv = o.data.preview;
      const lines = pv.lines.length;
      const maxlen = Math.max(4, ...pv.lines.map(l => l.length));
      d.w = Math.max(56, Math.min(maxlen * 4.1 + 14, 170));
      d.h = Math.max(20, 8 + lines * 8.5 + (pv.truncated ? 9 : 0));
    }
    defs.set(d.id, d);
    if (o.type === 'commit') {
      if (o.data.tree && oids.has(o.data.tree))
        edges.push({ a: o.sha, b: o.data.tree, k: 'ctree' });
      for (const p of o.data.parents)
        if (oids.has(p)) edges.push({ a: o.sha, b: p, k: 'parent' });
    } else if (o.type === 'tree') {
      for (const e of o.data.entries.slice(0, 24))
        if (oids.has(e.sha)) edges.push({ a: o.sha, b: e.sha, k: 'child' });
    } else if (o.type === 'tag') {
      if (o.data.object && oids.has(o.data.object))
        edges.push({ a: o.sha, b: o.data.object, k: 'tagref' });
    }
  }

  for (const r of state.refs) {
    const id = 'ref:' + r.name;
    defs.set(id, { id, kind: 'ref', ref: r, w: r.short.length * 6.4 + 20, h: 20 });
    if (r.sha && oids.has(r.sha)) edges.push({ a: id, b: r.sha, k: 'ref' });
  }

  if (state.head.type !== 'none') {
    defs.set('HEAD', { id: 'HEAD', kind: 'head', w: 54, h: 20 });
    const t = state.head.type === 'symbolic' ? 'ref:' + state.head.ref : state.head.sha;
    if (defs.has(t)) edges.push({ a: 'HEAD', b: t, k: 'head' });
    else if (oids.has(t)) edges.push({ a: 'HEAD', b: t, k: 'head' });
  }

  state.index.entries.forEach((e, i) => {
    if (i >= 60) return;
    const id = 'idx:' + e.path;
    const label = e.path.length > 26 ? '…' + e.path.slice(-25) : e.path;
    defs.set(id, { id, kind: 'idx', entry: e, label, w: label.length * 5.2 + 16, h: 19 });
    if (oids.has(e.sha)) edges.push({ a: id, b: e.sha, k: 'idx' });
  });

  state.status.forEach((s, i) => {
    if (i >= 40) return;
    const id = 'wd:' + s.path;
    const lines = s.diff && s.diff.length ? s.diff.map(d => d.t + ' ' + d.s) : (s.lines || []);
    const w = Math.max(120, Math.min(200, Math.max(s.path.length * 5.8, ...lines.map(l => l.length * 4)) + 34));
    const h = 24 + Math.min(lines.length, 6) * 9 + 6;
    defs.set(id, { id, kind: 'wd', st: s, lines, w, h });
  });

  return { defs, edges };
}

/* ---------------- layout ---------------- */

const ZONES = [
  { id: 'wd', label: 'working directory', gap: 16, cols: 6 },
  { id: 'idx', label: 'index · staging', gap: 10, cols: 9 },
  { id: 'refs', label: 'refs · head', gap: 12, cols: 14 },
  { id: 'commit', label: 'commits', gap: 30, cols: 14 },
  { id: 'tree', label: 'trees', gap: 18, cols: 16 },
  { id: 'blob', label: 'blobs', gap: 18, cols: 14 },
  { id: 'tag', label: 'tags', gap: 14, cols: 16 },
];
const zoneOf = d =>
  d.kind === 'wd' ? 'wd' : d.kind === 'idx' ? 'idx'
  : (d.kind === 'ref' || d.kind === 'head') ? 'refs'
  : d.kind === 'commit' ? 'commit' : d.kind === 'tree' ? 'tree'
  : d.kind === 'tag' ? 'tag' : 'blob';

let zoneRects = new Map();

/* Order trees/blobs by discovery order walking from commits:
 * related objects land in adjacent grid cells → short, readable edges. */
function orderGraph(defs) {
  const commits = [], trees = new Map(), blobs = [], others = [];
  for (const d of defs.values()) {
    if (d.kind === 'commit') commits.push(d);
    else if (d.kind === 'tree') trees.set(d.id, d);
    else if (d.kind === 'blob') blobs.push(d);
  }
  const treeOrder = [], blobOrder = [], seenT = new Set(), seenB = new Set();
  const walk = sha => {
    if (seenT.has(sha)) return;
    const t = trees.get(sha);
    if (!t) return;
    seenT.add(sha); treeOrder.push(t);
    for (const e of t.obj.data.entries) if (e.type === 'tree') walk(e.sha);
  };
  for (const c of commits) if (c.obj.data.tree) walk(c.obj.data.tree);
  for (const t of trees.values()) if (!seenT.has(t.id)) { seenT.add(t.id); treeOrder.push(t); }
  for (const t of treeOrder)
    for (const e of t.obj.data.entries)
      if (e.type === 'blob' && !seenB.has(e.sha)) { seenB.add(e.sha); const b = defs.get(e.sha); if (b && b.kind === 'blob') blobOrder.push(b); }
  for (const b of blobs) if (!seenB.has(b.id)) blobOrder.push(b);
  return { treeOrder, blobOrder };
}

function layout(defs) {
  const ord = orderGraph(defs);
  const groups = new Map(ZONES.map(z => [z.id, []]));
  for (const d of defs.values()) groups.get(zoneOf(d)).push(d);
  if (ord.treeOrder.length) groups.set('tree', ord.treeOrder);
  if (ord.blobOrder.length) groups.set('blob', ord.blobOrder);

  const M = 60, BAND = 56;
  let y = M;
  for (const z of ZONES) {
    const g = groups.get(z.id);
    if (!g.length) { zoneRects.set(z.id, null); continue; }
    const cols = Math.max(2, Math.min(z.cols, Math.ceil(Math.sqrt(g.length) * 1.6) || z.cols));
    const cw = Math.max(...g.map(d => d.w)) + z.gap;
    const ch = Math.max(...g.map(d => d.h)) + z.gap;
    const rows = Math.ceil(g.length / cols);
    const rect = { x: M, y: y + BAND, w: cols * cw, h: rows * ch, z };
    zoneRects.set(z.id, rect);
    g.forEach((d, i) => {
      const col = i % cols, row = (i / cols) | 0;
      d.tx = rect.x + col * cw + cw / 2;
      d.ty = rect.y + row * ch + ch / 2;
    });
    y = rect.y + rect.h;
  }
}

function placeNewNodes(defs) {
  // positions: keep existing, put new at their grid cell (with pop anim)
  for (const d of defs.values()) {
    let n = nodes.get(d.id);
    if (!n) {
      n = { id: d.id, x: d.tx, y: d.ty - 30, def: d, pinned: false, settled: false, isNew: true };
      nodes.set(d.id, n);
    }
    n.def = d;
    if (!n.pinned) { n.tx = d.tx; n.ty = d.ty; }
  }
}

/* ---------------- render ---------------- */

function folderGlyph(g) {
  el('rect', { x: -15, y: -9, width: 30, height: 22, rx: 4, class: 'c-tree' }, g);
  el('path', { d: 'M -15 -9 l 0 -4 a 3 3 0 0 1 3 -3 l 7 0 l 3 4 z', class: 'c-tree-tab' }, g);
}

function renderBody(n) {
  const b = n.body;
  b.innerHTML = '';
  const d = n.def, k = d.kind;
  if (k === 'commit') {
    el('circle', { r: 19, class: 'halo' }, b);
    if (d.obj.data.parents.length > 1) el('circle', { r: 17, class: 'c-merge' }, b);
    el('circle', { r: 14, class: 'c-commit' }, b);
    const t = el('text', { y: 32, class: 't-sha' }, b); txt(t, short(d.id));
  } else if (k === 'tag') {
    el('rect', { x: -15, y: -15, width: 30, height: 30, rx: 5, class: 'halo' }, b);
    el('path', { d: 'M 0 -13 L 13 0 L 0 13 L -13 0 Z', class: 'c-tag' }, b);
    const t = el('text', { y: 24, class: 't-sha' }, b); txt(t, short(d.id));
  } else if (k === 'tree') {
    el('rect', { x: -d.w / 2 - 3, y: -d.h / 2 - 3, width: d.w + 6, height: d.h + 6, rx: 7, class: 'halo' }, b);
    el('rect', { x: -d.w / 2, y: -d.h / 2, width: d.w, height: d.h, rx: 6, fill: '#ecfdf5', stroke: '#a7f3d0' }, b);
    // small folder glyph top-left
    const fg = el('g', { transform: `translate(${-d.w / 2 + 13},${-d.h / 2 + 12}) scale(.42)` }, b);
    folderGlyph(fg);
    const ents = d.obj.data.entries;
    ents.slice(0, 7).forEach((e, i) => {
      const t = el('text', { x: -d.w / 2 + 26, y: -d.h / 2 + 16 + i * 11, class: 't-entry' }, b);
      txt(t, (e.name.length > 24 ? e.name.slice(0, 23) + '…' : e.name));
      if (e.type === 'tree') t.setAttribute('fill', '#059669');
      else if (e.type === 'commit') t.setAttribute('fill', '#b45309');
      else t.setAttribute('fill', '#475569');
    });
    if (d.obj.data.total > 7) {
      const t = el('text', { x: -d.w / 2 + 26, y: -d.h / 2 + 16 + 7 * 11, class: 't-more' }, b);
      txt(t, '+' + (d.obj.data.total - 7) + ' more');
    }
  } else if (k === 'blob') {
    const pv = d.obj.data.preview;
    el('rect', { x: -d.w / 2 - 3, y: -d.h / 2 - 3, width: d.w + 6, height: d.h + 6, rx: 7, class: 'halo' }, b);
    el('rect', { x: -d.w / 2, y: -d.h / 2, width: d.w, height: d.h, rx: 5, class: 'c-blob' + (pv.binary ? ' bin' : '') }, b);
    // folded corner
    el('path', { d: `M ${d.w / 2 - 10} ${-d.h / 2} l 10 0 l 0 10 z`, fill: pv.binary ? '#1e293b' : '#e2e8f0' }, b);
    pv.lines.forEach((l, i) => {
      const t = el('text', { x: -d.w / 2 + 7, y: -d.h / 2 + 11 + i * 8.5, class: 't-file' + (pv.binary ? ' bin' : '') }, b);
      txt(t, l);
    });
    if (pv.truncated) {
      const t = el('text', { x: -d.w / 2 + 7, y: d.h / 2 - 5, class: 't-more' }, b);
      txt(t, '⋮');
    }
  } else if (k === 'ref') {
    const r = d.ref;
    const fill = r.kind === 'branch' ? '#0f172a' : r.kind === 'tag' ? '#7e22ce'
      : r.kind === 'remote' ? '#0369a1' : r.kind === 'stash' ? '#b45309' : '#475569';
    el('rect', { x: -d.w / 2 - 3, y: -13, width: d.w + 6, height: 26, rx: 13, class: 'halo' }, b);
    el('rect', { x: -d.w / 2, y: -10, width: d.w, height: 20, rx: 10, fill, class: 'c-ref' }, b);
    const t = el('text', { y: 3.5, 'text-anchor': 'middle', class: 't-name' }, b); txt(t, r.short);
  } else if (k === 'head') {
    el('rect', { x: -d.w / 2 - 3, y: -13, width: d.w + 6, height: 26, rx: 13, class: 'halo' }, b);
    el('rect', { x: -d.w / 2, y: -10, width: d.w, height: 20, rx: 10, class: 'c-head' }, b);
    const t = el('text', { y: 3.5, 'text-anchor': 'middle', class: 't-name' }, b); txt(t, 'HEAD');
  } else if (k === 'idx') {
    el('rect', { x: -d.w / 2 - 3, y: -13, width: d.w + 6, height: 26, rx: 8, class: 'halo' }, b);
    el('rect', { x: -d.w / 2, y: -9.5, width: d.w, height: 19, rx: 5, class: 'c-idx' }, b);
    const t = el('text', { y: 3, 'text-anchor': 'middle', class: 't-idx' }, b); txt(t, d.label);
  } else if (k === 'wd') {
    const s = d.st;
    const code = s.x !== ' ' && s.x !== '?' ? s.x : s.y !== ' ' ? s.y : '?';
    el('rect', { x: -d.w / 2 - 3, y: -d.h / 2 - 3, width: d.w + 6, height: d.h + 6, rx: 9, class: 'halo' }, b);
    el('rect', { x: -d.w / 2, y: -d.h / 2, width: d.w, height: d.h, rx: 7, class: 'c-wd st-' + (s.x === '?' || s.y === '?' ? 'U' : code) }, b);
    const bw = 14;
    el('rect', { x: -d.w / 2 + 5, y: -d.h / 2 + 5, width: bw, height: 14, rx: 4, class: 'bdg-' + (s.x === '?' || s.y === '?' ? 'U' : code) }, b);
    const tb = el('text', { x: -d.w / 2 + 5 + bw / 2, y: -d.h / 2 + 15, class: 't-badge' }, b);
    txt(tb, s.x === '?' || s.y === '?' ? '?' : code);
    const name = s.path.length > 30 ? '…' + s.path.slice(-29) : s.path;
    const tn = el('text', { x: -d.w / 2 + 24, y: -d.h / 2 + 16, class: 't-wdname' }, b);
    txt(tn, name);
    (d.lines || []).slice(0, 6).forEach((l, i) => {
      const diff = s.diff && s.diff[i];
      const t = el('text', { x: -d.w / 2 + 9, y: -d.h / 2 + 30 + i * 9,
        class: 't-file' + (diff ? (diff.t === '+' ? ' t-diffp' : ' t-diffm') : '') }, b);
      txt(t, l.length > 44 ? l.slice(0, 43) + '…' : l);
    });
  }
}

function ensureNodeEl(n) {
  const sig = n.id + '|' + JSON.stringify(n.def).length + '|' + (n.def.lines || []).join('') + (n.def.obj ? n.def.obj.size : '');
  if (n.el) { if (n.sig !== sig) { n.sig = sig; renderBody(n); } return; }
  n.sig = sig;
  const g = el('g', { class: 'n', 'data-id': n.id }, nodesG);
  const b = el('g', { class: 'b' }, g);
  n.el = g; n.body = b;
  if (n.def.obj && !n.def.obj.reachable) g.classList.add('ghost');
  renderBody(n);
  g.addEventListener('pointerdown', e => startDrag(e, n));
  g.addEventListener('click', e => {
    e.stopPropagation();
    if (n._moved) { n._moved = false; return; }
    openDetail(n.id);
  });
}

function edgePath(a, b, k) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (k === 'parent' || k === 'head' || k === 'ref' || k === 'tagref') {
    const mx = a.x + dx * .5;
    return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

function renderEdges() {
  const seen = new Set();
  for (const e of edges) {
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const key = e.key;
    seen.add(key);
    let p = edgeEls.get(key);
    if (!p) {
      p = el('path', { class: 'e e-' + e.k }, edgesG);
      if (e.k === 'parent' || e.k === 'head') p.setAttribute('marker-end', e.k === 'head' ? 'url(#arrB)' : 'url(#arr)');
      edgeEls.set(key, p);
    }
    p.setAttribute('d', edgePath(a, b, e.k));
  }
  for (const [k, p] of edgeEls) if (!seen.has(k)) { p.remove(); edgeEls.delete(k); }
}

function renderZones() {
  zonesG.innerHTML = '';
  for (const z of ZONES) {
    const r = zoneRects.get(z.id);
    if (!r) continue;
    el('rect', { x: r.x - 24, y: r.y - 24, width: r.w + 48, height: r.h + 48, rx: 14, class: 'zone' }, zonesG);
    const t = el('text', { x: r.x - 10, y: r.y - 8, class: 'zone-label' }, zonesG);
    txt(t, z.label);
  }
}

function render() {
  renderZones();
  for (const n of nodes.values()) {
    ensureNodeEl(n);
    n.el.classList.toggle('ghost', !!(n.def.obj && !n.def.obj.reachable));
    const x = n.pinned ? n.x : n.tx, y = n.pinned ? n.y : n.ty;
    n.el.style.transform = `translate(${x}px,${y}px)`;
    if (n.isNew) {
      n.isNew = false;
      n.body.parentNode.classList.add('enter');
      setTimeout(() => n.el && n.el.classList.remove('enter'), 600);
    }
    n.settled = true;
  }
  renderEdges();
}

/* ---------------- apply state / reconcile ---------------- */

function applyState(s, changes) {
  const first = !state;
  state = s;
  const { defs, edges: ed } = buildDefs();
  edges = ed.map(e => ({ ...e, key: e.a + '>' + e.b + ':' + e.k }));

  // remove gone nodes
  for (const [id, n] of nodes) {
    if (!defs.has(id)) {
      n.el.classList.add('exit');
      const dead = n;
      setTimeout(() => { dead.el.remove(); }, 450);
      nodes.delete(id);
      if (selected === id) closeDrawer();
    }
  }

  layout(defs);
  placeNewNodes(defs);

  // updates that need body re-render (workdir content changes)
  if (changes) {
    const bump = id => {
      const n = nodes.get(id);
      if (!n) return;
      const p = el('circle', { r: 18, class: 'ping', fill: 'none', stroke: '#f59e0b', 'stroke-width': 3 }, n.body);
      setTimeout(() => p.remove(), 1000);
    };
    for (const p of [...changes.statusAdded, ...changes.statusChanged]) bump('wd:' + p);
    if (changes.indexChanged) for (const e of s.index.entries.slice(0, 60)) bump('idx:' + e.path);
    for (const name of changes.refsMoved) {
      bump('ref:' + name);
      const r = s.refs.find(x => x.name === name);
      if (r) bump(r.sha);
    }
    if (changes.headChanged) bump('HEAD');
    for (const sha of changes.added) bump(sha);
  }

  render();

  document.getElementById('repo').textContent = s.repoPath.split('/').pop();
  const c = s.counts;
  document.getElementById('stats').textContent =
    `${c.commits} commits · ${c.trees} trees · ${c.blobs} blobs` +
    (c.tags ? ` · ${c.tags} tags` : '') +
    (c.unreachable ? ` · ${c.unreachable} unreachable` : '') +
    (c.truncated ? ` · showing ${c.shown}/${c.total}` : '') +
    (s.packs.length ? ` · ${s.packs.length} pack` : ' · loose');

  if (first) fitView();
}

/* ---------------- pan / zoom / drag ---------------- */

function fitView() {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const n of nodes.values()) {
    const x = n.tx ?? n.x, y = n.ty ?? n.y;
    minX = Math.min(minX, x - n.def.w); maxX = Math.max(maxX, x + n.def.w);
    minY = Math.min(minY, y - n.def.h); maxY = Math.max(maxY, y + n.def.h);
  }
  if (minX > maxX) return;
  const W = innerWidth, H = innerHeight - 60;
  view.k = Math.min(1.1, Math.min(W / (maxX - minX + 160), H / (maxY - minY + 160)));
  view.x = (W - (maxX - minX) * view.k) / 2 - minX * view.k;
  view.y = (H - (maxY - minY) * view.k) / 2 - minY * view.k + 50;
  applyView();
}
function applyView() {
  vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}
function toWorld(e) {
  return { x: (e.clientX - view.x) / view.k, y: (e.clientY - view.y) / view.k };
}

svg.addEventListener('wheel', e => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0012);
  const p = toWorld(e);
  view.k = Math.max(.05, Math.min(4, view.k * f));
  view.x = e.clientX - p.x * view.k;
  view.y = e.clientY - p.y * view.k;
  applyView();
}, { passive: false });

let pan = null;
svg.addEventListener('pointerdown', e => {
  if (e.target.closest('.n')) return;
  pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  svg.classList.add('panning');
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointermove', e => {
  if (pan) {
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    view.x = pan.vx + dx; view.y = pan.vy + dy;
    applyView();
  } else if (dragging) {
    const p = toWorld(e);
    dragging.x = p.x; dragging.y = p.y;
    dragging.el.style.transform = `translate(${p.x}px,${p.y}px)`;
    renderEdges();
  }
});
svg.addEventListener('pointerup', () => { pan = null; svg.classList.remove('panning'); });
svg.addEventListener('click', e => { if (!pan || !pan.moved) { if (!e.target.closest('.n')) closeDrawer(); } });

let dragging = null;
function startDrag(e, n) {
  e.stopPropagation();
  dragging = n;
  n.el.classList.add('drag');
  n.pinned = true;
  const p = toWorld(e);
  n.x = p.x; n.y = p.y;
  const move = ev => {
    const q = toWorld(ev);
    if (Math.abs(q.x - n.x) + Math.abs(q.y - n.y) > 2) n._moved = true;
    n.x = q.x; n.y = q.y;
    n.el.style.transform = `translate(${q.x}px,${q.y}px)`;
    renderEdges();
  };
  const up = () => {
    dragging = null;
    n.el.classList.remove('drag');
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/* ---------------- detail drawer ---------------- */

function hexdump(h) {
  // h = {hex, total, shown, hl:[{s,e,c}]}
  const bytes = h.hex.split(' ').filter(x => x.length);
  let out = '<div class="hexdump">';
  for (let row = 0; row * 16 < bytes.length; row++) {
    out += `<span class="off">${(row * 16).toString(16).padStart(6, '0')}  </span>`;
    for (let i = 0; i < 16 && row * 16 + i < bytes.length; i++) {
      const gi = row * 16 + i;
      const hl = (h.hl || []).find(r => gi >= r.s && gi < r.e);
      out += `<span class="${hl ? 'hl-' + hl.c : ''}">${bytes[gi]}</span>` + (i === 7 ? '  ' : ' ');
    }
    out += '\n';
  }
  if (h.total > h.shown) out += `<div class="hex-more">… ${h.total - h.shown} more bytes</div>`;
  return out + '</div>';
}

function stepHtml(st) {
  if (st.k === 'file') {
    let p = esc(st.path);
    if (st.shaParts)
      p = esc('.git/objects/') + `<span class="seg">${st.shaParts[0]}</span>/<span class="seg">${st.shaParts[1]}</span>`;
    return `<div class="step"><div class="st-t">file</div><div class="f-path">${p}</div>` +
      (st.note ? `<div class="f-note">${esc(st.note)}</div>` : '') + '</div>';
  }
  if (st.k === 'hex')
    return `<div class="step"><div class="st-t">${esc(st.title || 'bytes')}</div>${hexdump(st)}` +
      (st.note ? `<div class="f-note">${esc(st.note)}</div>` : '') + '</div>';
  if (st.k === 'op')
    return `<div class="step op"><span class="opl">⚙ ${esc(st.label)}</span></div>`;
  if (st.k === 'text')
    return `<div class="step"><div class="st-t">content</div><div class="pre">${esc(st.text)}</div></div>`;
  if (st.k === 'parsed')
    return `<div class="step"><div class="st-t">parsed</div><div class="kv">` +
      st.fields.map(f =>
        `<div><span class="k">${esc(f.k)}</span> ` +
        (f.sha ? `<a class="v ${f.t === 'tree' ? 'dir' : f.t === 'commit' ? 'sub' : ''}" data-sha="${f.sha}">${esc(f.v)}</a>`
               : `<span class="v">${esc(f.v)}</span>`) + '</div>').join('') +
      '</div></div>';
  if (st.k === 'diff')
    return `<div class="step"><div class="st-t">diff</div><div class="pre diff">` +
      st.text.split('\n').map(l =>
        `<span class="${l.startsWith('+') ? 'dp' : l.startsWith('-') ? 'dm' : l.startsWith('@@') ? 'dh' : 'dc'}">${esc(l)}</span>`
      ).join('') + '</div></div>';
  return '';
}

async function openDetail(id) {
  selected = id;
  for (const n of nodes.values()) n.el.classList.toggle('sel', n.id === id);
  const d = await (await fetch('/api/detail?id=' + encodeURIComponent(id))).json();
  let head = '';
  if (d.sha) {
    const o = state.objects.find(x => x.sha === d.sha);
    head = `<span class="d-type ${d.type}">${d.type}</span><span class="d-sha">${d.sha}</span>` +
      `<span class="d-note">${d.size} bytes</span>` +
      (o && !o.reachable ? `<span class="d-note unreach">unreachable</span>` : '') +
      (o && o.prov.kind === 'pack' ? `<span class="d-note">${o.prov.pack}@${o.prov.offset}</span>` : '');
  } else head = `<span class="d-type">${esc(d.title || id)}</span>`;
  const steps = (d.steps || []).map((st, i) =>
    (i ? '<div class="step-arrow">→</div>' : '') + stepHtml(st)).join('');
  let extra = '';
  if (d.bodyText) {
    extra = `<div class="step" style="margin-top:12px;max-width:none"><div class="st-t">body</div>` +
      (d.bodyText.binary ? `<div class="hexdump">${esc(d.bodyText.hex)}</div>`
                        : `<div class="pre">${esc(d.bodyText.text)}${d.bodyText.truncated ? '\n…' : ''}</div>`) + '</div>';
  }
  drawer.innerHTML = `<div class="d-head">${head}<span class="d-x">×</span></div>` +
    `<div class="steps">${steps}</div>` + extra;
  drawer.classList.remove('hidden');
  drawer.querySelector('.d-x').onclick = closeDrawer;
  drawer.querySelectorAll('a[data-sha]').forEach(a =>
    a.addEventListener('click', () => openDetail(a.dataset.sha)));
}
function closeDrawer() {
  drawer.classList.add('hidden');
  selected = null;
  for (const n of nodes.values()) n.el.classList.remove('sel');
}

/* ---------------- boot ---------------- */

document.getElementById('legend').innerHTML =
  '<span><i style="background:#fbbf24"></i>commit</span>' +
  '<span><i style="background:#34d399"></i>tree</span>' +
  '<span><i style="background:#fff;border:1px solid #94a3b8"></i>blob</span>' +
  '<span><i style="background:#c084fc"></i>tag</span>' +
  '<span><i style="background:#0f172a"></i>ref</span>' +
  '<span><i style="background:#fefce8;border:1px solid #ca8a04"></i>index</span>' +
  '<span><i style="background:#fff;border:1px solid #f59e0b"></i>workdir</span>';

(async () => {
  const s = await (await fetch('/api/state')).json();
  applyState(s, null);
  if (location.hash.length > 1) openDetail(decodeURIComponent(location.hash.slice(1)));
  const es = new EventSource('/events');
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') applyState(m.state, m.changes);
  };
  es.onerror = () => document.getElementById('live').classList.add('dead');
  es.onopen = () => document.getElementById('live').classList.remove('dead');
})();
