'use strict';
/* Performance/regression tests for src/repo.js.
 * Proves --max bounds the number of object bodies inflated in JS (not just
 * the emitted slice), that pack reads/decoding are lazy and bounded, that
 * delta objects resolve identically to git, that detail/preview reads never
 * pull whole files just to slice a prefix, and that reachability never
 * marks unproven objects unreachable. Parser-level only — server/worker
 * behavior is covered elsewhere. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');
const repo = require('../src/repo');
const { LIMITS, Lru, looseCache, packCache } = repo.internals;


const git = (dir, a, opts) =>
  cp.execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', ...opts });

// count zlib.inflateSync calls made synchronously inside fn()
function countInflates(fn) {
  const orig = zlib.inflateSync;
  let n = 0;
  zlib.inflateSync = function (...a) { n++; return orig.apply(this, a); };
  try {
    const r = fn(); // read n only after fn() has run
    return { n, r };
  } finally { zlib.inflateSync = orig; }
}

const objectCount = dir =>
  git(dir, ['cat-file', '--batch-all-objects', '--batch-check']).trim()
    .split('\n').filter(Boolean).length;

// loose-object repo: `commits` commits over a shared, append-grown file
function mkRepo(t, commits = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-perf-'));
  const dir = path.join(root, 'repo');
  cp.execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'line\n'.repeat(200));
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), 'file ' + i + '\n');
    fs.appendFileSync(path.join(dir, 'shared.txt'), 'change ' + i + '\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'c' + i]);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dir;
}

// same but repacked so every object lives in a pack (with deltas)
function mkPackedRepo(t, commits = 4, ofsDelta = true) {
  const dir = mkRepo(t, commits);
  git(dir, ['-c', 'repack.usedeltabaseoffset=' + ofsDelta, 'repack', '-adfq']);
  git(dir, ['prune-packed', '-q']);
  return dir;
}

/* ---------------- independent Git parity ---------------- */

for (const packed of [false, true]) test((packed ? 'packed' : 'loose') + ' objects and details agree with Git', t => {
  const dir = mkRepo(t, 3);
  git(dir, ['tag', '-a', 'v1', '-m', 'release']);
  if (packed) {
    git(dir, ['repack', '-adfq']);
    git(dir, ['prune-packed', '-q']);
  }
  const expected = git(dir, ['cat-file', '--batch-all-objects', '--batch-check']).trim().split('\n');
  const state = repo.buildState(dir, 10000);
  assert.equal(state.objects.length, expected.length);
  for (const line of expected) {
    const [sha, type, size] = line.split(' ');
    const object = state.objects.find(o => o.sha === sha);
    assert(object, sha);
    assert.equal(object.type, type);
    assert.equal(object.size, Number(size));
    const detail = repo.objectDetail(dir, sha);
    assert.equal(detail.type, type);
    assert.equal(detail.size, Number(size));
    const body = git(dir, ['cat-file', type, sha]);
    if (type === 'blob') assert.equal(detail.bodyText.text, body);
    if (type === 'commit') {
      assert.equal(object.data.tree, body.match(/^tree (\w+)/)[1]);
      assert.equal(object.data.message, body.slice(body.indexOf('\n\n') + 2));
    }
    if (type === 'tag') assert.equal(object.data.object, body.match(/^object (\w+)/)[1]);
    if (type === 'tree') {
      const names = git(dir, ['ls-tree', '-z', sha]).split('\0').filter(Boolean).map(x => x.slice(x.indexOf('\t') + 1));
      assert.deepEqual(object.data.entries.map(e => e.name), names);
    }
    assert(detail.steps.some(s => s.k === 'hex'));
  }
});

/* ---------------- --max bounds decoding ---------------- */

test('--max inflates only the selected bodies (loose repo)', (t) => {
  const dir = mkRepo(t, 4);
  const total = objectCount(dir);
  const { n, r: st } = countInflates(() => repo.buildState(dir, 2));
  assert.equal(st.objects.length, 2);
  assert.equal(st.counts.total, total);
  assert.equal(st.counts.truncated, true);
  assert.equal(n, 2, 'exactly the selected objects were inflated');
});

test('--max inflates only selected bodies + bounded delta bases (packed repo)', (t) => {
  const dir = mkPackedRepo(t, 4);
  const total = objectCount(dir);
  assert.ok(total >= 10, 'fixture has enough objects');
  const { n, r: st } = countInflates(() => repo.buildState(dir, 2));
  assert.equal(st.objects.length, 2);
  assert.equal(st.counts.total, total);
  assert.equal(st.counts.packed, total); // everything packed
  assert.ok(n >= 2 && n <= 2 + 8,
    'only selected bodies + a bounded delta chain were inflated, got ' + n);
  assert.ok(n < total, n + ' inflates < ' + total + ' objects');
  // no undecoded nodes emitted: every object carries parsed data
  assert.ok(st.objects.every(o => o.data));
});

test('full builds still decode everything; small builds are a fraction', (t) => {
  const loose = mkRepo(t, 4), packed = mkPackedRepo(t, 4);
  const { n: looseFull } = countInflates(() => repo.buildState(loose, 10000));
  const { n: packedFull } = countInflates(() => repo.buildState(packed, 10000));
  assert.equal(looseFull, objectCount(loose));
  assert.equal(packedFull, objectCount(packed));
  t.diagnostic('full builds inflate every object: loose=' + looseFull +
    ' packed=' + packedFull);
});

test('rebuild hits warm caches: zero reinflation', (t) => {
  const loose = mkRepo(t, 2), packed = mkPackedRepo(t, 2);
  repo.buildState(loose, 10000);
  repo.buildState(packed, 10000);
  const { n } = countInflates(() => {
    repo.buildState(loose, 10000);
    repo.buildState(packed, 10000);
  });
  assert.equal(n, 0);
});

/* ---------------- lazy pack reads ---------------- */

test('pack detail reads bounded entry windows, not the whole packfile', (t) => {
  const dir = mkRepo(t, 2);
  // incompressible content so the pack is meaningfully bigger than an entry
  const rnd = require('crypto').randomBytes(400 * 1024);
  fs.writeFileSync(path.join(dir, 'rnd.bin'), rnd);
  git(dir, ['add', 'rnd.bin']);
  git(dir, ['commit', '-qm', 'rnd']);
  git(dir, ['repack', '-adq']);
  git(dir, ['prune-packed', '-q']);
  const packPath = fs.readdirSync(path.join(dir, '.git', 'objects', 'pack'))
    .find(f => f.endsWith('.pack'));
  const packSize = fs.statSync(path.join(dir, '.git', 'objects', 'pack', packPath)).size;
  assert.ok(packSize > 200 * 1024, 'fixture pack is sizeable: ' + packSize);

  // no buildState first: decode happens fresh inside objectDetail. A small
  // object's detail must read only its own window, not the whole packfile
  // (the old eager path always read every byte of it).
  const sha = git(dir, ['rev-parse', 'HEAD']).trim(); // the commit: ~200B
  const origRead = fs.readSync;
  let bytes = 0, calls = 0;
  fs.readSync = (fd, buf, off, len, pos) => {
    const r = origRead(fd, buf, off, len, pos);
    bytes += r; calls++;
    return r;
  };
  let d;
  try { d = repo.objectDetail(dir, sha); } finally { fs.readSync = origRead; }
  assert.equal(d.type, 'commit');
  assert.ok(bytes < packSize / 4,
    'read ' + bytes + 'B across ' + calls + ' calls vs pack ' + packSize + 'B');
  // and the big blob's window is bounded by its declared size, not the file
  const blobSha = git(dir, ['rev-parse', 'HEAD:rnd.bin']).trim();
  bytes = 0; calls = 0;
  fs.readSync = (fd, buf, off, len, pos) => {
    const r = origRead(fd, buf, off, len, pos);
    bytes += r; calls++;
    return r;
  };
  try { d = repo.objectDetail(dir, blobSha); } finally { fs.readSync = origRead; }
  assert.equal(d.type, 'blob');
  assert.equal(d.size, rnd.length);
  assert.ok(bytes <= rnd.length + (rnd.length >>> 3) + 8192 + 96,
    'entry window bounded: ' + bytes + 'B for a ' + rnd.length + 'B object');
});

/* ---------------- delta correctness ---------------- */

function assertDeltaDetailsAgreeWithGit(t, dir, label) {
  const st = repo.buildState(dir, 10000);
  const deltas = st.objects.filter(o => o.prov && o.prov.delta);
  assert.ok(deltas.length > 0, label + ': fixture produced delta objects');
  for (const o of deltas) {
    const d = repo.objectDetail(dir, o.sha);
    assert.equal(d.type, git(dir, ['cat-file', '-t', o.sha]).trim(), label + ' type ' + o.sha);
    assert.equal(d.size, +git(dir, ['cat-file', '-s', o.sha]).trim(), label + ' size ' + o.sha);
    assert.ok(d.steps.some(s => s.k === 'op' && /delta →/.test(s.label)),
      label + ': delta step shown for ' + o.sha);
    if (d.type === 'blob')
      assert.equal(d.bodyText.text, git(dir, ['cat-file', 'blob', o.sha]),
        label + ' body ' + o.sha);
    if (d.type === 'commit') {
      const head = git(dir, ['cat-file', 'commit', o.sha]).split('\n\n')[0];
      const tree = /tree ([0-9a-f]{40})/.exec(head)[1];
      const field = d.steps.find(s => s.k === 'parsed').fields.find(f => f.k === 'tree');
      assert.equal(field.v, tree, label + ' commit tree ' + o.sha);
    }
  }
  t.diagnostic(label + ': ' + deltas.length + ' delta objects verified against git');
}

test('ofs-delta objects agree with git', (t) => {
  assertDeltaDetailsAgreeWithGit(t, mkPackedRepo(t, 4, true), 'ofs-delta');
});

test('ref-delta objects agree with git', (t) => {
  const dir = mkPackedRepo(t, 4, false); // repack.usedeltabaseoffset=false
  assertDeltaDetailsAgreeWithGit(t, dir, 'ref-delta');
});

/* ---------------- oversized objects ---------------- */

test('oversized objects: explicit detail error, skipped+reported in state', (t) => {
  const dir = mkRepo(t, 1);
  const big = git(dir, ['hash-object', '-w', '--stdin'],
    { input: 'x'.repeat(LIMITS.maxObjBytes + 1024) }).trim();
  const st = repo.buildState(dir, 10000);
  assert.ok(!st.objects.some(o => o.sha === big), 'oversized object not emitted');
  assert.ok(st.errors.some(e => e.sha === big && /too large/.test(e.error)));
  assert.equal(st.counts.errors, st.errors.length);
  assert.ok(st.counts.errors >= 1);
  assert.equal(st.counts.total, st.objects.length + st.errors.length);
  const d = repo.objectDetail(dir, big);
  assert.match(d.error, /too large/);
  assert.ok(!d.steps);
});

test('oversized packed object: same behavior through pack decode', (t) => {
  const dir = mkPackedRepo(t, 1);
  fs.writeFileSync(path.join(dir, 'large.txt'), 'y'.repeat(LIMITS.maxObjBytes + 2048));
  git(dir, ['add', 'large.txt']);
  git(dir, ['commit', '-qm', 'large']);
  const big = git(dir, ['rev-parse', 'HEAD:large.txt']).trim();
  git(dir, ['repack', '-adq']);
  git(dir, ['prune-packed', '-q']);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'objects', big.slice(0, 2), big.slice(2))), false);
  const idx = fs.readdirSync(path.join(dir, '.git', 'objects', 'pack')).find(f => f.endsWith('.idx'));
  assert(git(dir, ['verify-pack', '-v', path.join(dir, '.git', 'objects', 'pack', idx)]).includes(big));
  const st = repo.buildState(dir, 10000);
  assert.ok(!st.objects.some(o => o.sha === big));
  assert.ok(st.errors.some(e => e.sha === big && /too large/.test(e.error)));
  const d = repo.objectDetail(dir, big);
  assert.match(d.error, /too large/);
  assert.ok(!d.steps);
});

/* ---------------- bounded previews ---------------- */

test('workdir and status previews never read whole large files', (t) => {
  const dir = mkRepo(t, 1);
  const bin = path.join(dir, 'big.bin');
  const txt = path.join(dir, 'big.txt');
  fs.writeFileSync(bin, Buffer.alloc(3 << 20));          // 3MB NULs -> binary
  fs.writeFileSync(txt, 'row\n'.repeat(1 << 19));        // ~2MB text
  const orig = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (p, ...a) => { reads.push(String(p)); return orig.call(fs, p, ...a); };
  try {
    const d = repo.workdirDetail(dir, 'big.bin');
    assert.ok(d.steps.find(s => s.k === 'hex'), 'binary preview via hex step');
    const d2 = repo.workdirDetail(dir, 'big.txt');
    const text = d2.steps.find(s => s.k === 'text');
    assert.ok(text && text.text.length <= 6000);
    const st = repo.buildState(dir, 1000);
    for (const it of [st.status.find(s => s.path === 'big.bin'),
                      st.status.find(s => s.path === 'big.txt')]) {
      assert.ok(it, 'status entry present');
      assert.ok(it.lines.length <= 6, 'preview lines bounded');
    }
  } finally { fs.readFileSync = orig; }
  assert.ok(!reads.some(p => p.endsWith('big.bin') || p.endsWith('big.txt')),
    'no whole-file reads of the large files: ' + reads.filter(p => /big/.test(p)));
});

/* ---------------- caches bounded ---------------- */

test('Lru evicts oldest by entry count and byte weight', () => {
  const l = new Lru(2, Infinity, () => 1);
  l.set('a', 1); l.set('b', 2); l.set('c', 3);
  assert.equal(l.m.size, 2);
  assert.equal(l.get('a'), undefined);
  assert.equal(l.get('b'), 2);

  const lb = new Lru(10, 10, v => v.length);
  lb.set('x', 'aaaa'); lb.set('y', 'bbbbbb'); // exactly at byte budget
  lb.set('z', 'c');                           // 11 bytes -> evict oldest
  assert.equal(lb.get('x'), undefined);
  assert.equal(lb.m.size, 2);
  assert.ok(lb.bytes <= 10);
});

test('live caches stay under their configured caps', (t) => {
  const loose = mkRepo(t, 3), packed = mkPackedRepo(t, 3);
  repo.buildState(loose, 10000);
  repo.buildState(packed, 10000);
  for (const o of repo.buildState(packed, 10000).objects)
    repo.objectDetail(packed, o.sha);
  assert.ok(looseCache.m.size <= LIMITS.looseCache.entries);
  assert.ok(looseCache.bytes <= LIMITS.looseCache.bytes);
  assert.ok(packCache.m.size <= LIMITS.packCache.entries);
  for (const c of packCache.m.values()) {
    assert.ok(c.pack.decoded.m.size <= LIMITS.decodedCache.entries);
    assert.ok(c.pack.decoded.bytes <= LIMITS.decodedCache.bytes);
  }
});

/* ---------------- reachability ---------------- */

test('full builds mark proven-unreachable objects; truncated builds never lie', (t) => {
  const dir = mkRepo(t, 2);
  const orphan = git(dir, ['hash-object', '-w', '--stdin'], { input: 'orphan\n' }).trim();
  const full = repo.buildState(dir, 10000);
  assert.equal(full.reachabilityComplete, true);
  assert.equal(full.objects.find(o => o.sha === orphan).reachable, false);
  assert.equal(full.counts.unreachable, 1);

  const tr = repo.buildState(dir, 1);
  assert.equal(tr.reachabilityComplete, false);
  assert.ok(tr.objects.every(o => o.reachable === true),
    'unproven objects are marked reachable (ghost styling suppressed)');
  assert.equal(tr.counts.unreachable, 0);
});

/* ---------------- accurate counts under truncation ---------------- */

test('type/provenance counts stay exact when --max truncates', t => {
  const dir = mkPackedRepo(t, 4);
  const rows = git(dir, ['cat-file', '--batch-all-objects', '--batch-check']).trim().split('\n');
  const st = repo.buildState(dir, 5);
  for (const [type, key] of [['commit', 'commits'], ['tree', 'trees'], ['blob', 'blobs'], ['tag', 'tags']])
    assert.equal(st.counts[key], rows.filter(r => r.split(' ')[1] === type).length);
  assert.equal(st.counts.total, rows.length);
  assert.equal(st.counts.loose, 0);
  assert.equal(st.counts.packed, rows.length);
  assert.equal(st.counts.shown, 5);
  assert.equal(st.counts.truncated, true);
  assert.equal(st.reachabilityComplete, false);
  assert.ok(st.objects.every(o => o.data && o.reachable === true));
});
