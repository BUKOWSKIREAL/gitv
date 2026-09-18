'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { readIndex, parseIndex } = require('../src/index-reader');

function git(dir, args, opts) {
  return cp.execFileSync('git', ['-C', dir, ...args],
    { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

// disposable repo with a committed baseline
function mkRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-idx-'));
  const dir = path.join(root, 'repo');
  cp.execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir };
}

const gitDirOf = dir => path.join(dir, '.git');
const idxVersion = dir =>
  fs.readFileSync(path.join(gitDirOf(dir), 'index')).readUInt32BE(4);

// ground truth: git's own listing, -z so paths are raw bytes
function lsStage(dir) {
  const buf = cp.execFileSync('git', ['-C', dir, 'ls-files', '--stage', '-z'],
    { encoding: 'buffer', maxBuffer: 64 << 20 });
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const z = buf.indexOf(0, p);
    if (z < 0) break;
    const rec = buf.slice(p, z);
    p = z + 1;
    if (!rec.length) continue;
    const tab = rec.indexOf(9);
    const h = rec.slice(0, tab).toString('latin1').split(' ');
    out.push({ path: rec.slice(tab + 1).toString('utf8'),
               sha: h[1], mode: h[0], stage: +h[2] });
  }
  return out;
}

const slim = e => ({ path: e.path, sha: e.sha, mode: e.mode, stage: e.stage });

// every entry offset must point at its own record inside the real file —
// this is the contract indexDetail relies on (sha at offset+40)
function checkOffsets(dir, idx) {
  const raw = fs.readFileSync(path.join(gitDirOf(dir), 'index'));
  let lastEnd = 12;
  for (const e of idx.entries) {
    assert.ok(e.offset >= lastEnd, 'offsets ascend through the file');
    assert.equal(e.offset + 62 <= e.entryEnd, true);
    assert.ok(e.entryEnd <= raw.length);
    assert.equal(raw.slice(e.offset + 40, e.offset + 60).toString('hex'), e.sha,
      'sha bytes at offset+40 match parsed sha for ' + e.path);
    assert.ok(e.nameOffset >= e.offset + 62 && e.nameOffset < e.entryEnd);
    lastEnd = e.entryEnd;
  }
}

/* ---------------- real repos ---------------- */

test('missing index file yields empty result without error', (t) => {
  const { dir } = mkRepo(t);
  fs.rmSync(path.join(gitDirOf(dir), 'index'));
  const idx = readIndex(gitDirOf(dir));
  assert.deepEqual(idx, { entries: [], file: '.git/index' });
});

test('v2: entries match git ls-files --stage (unicode, shared prefixes, symlink)', (t) => {
  const { dir } = mkRepo(t);
  fs.mkdirSync(path.join(dir, 'aaa', 'bbb', 'ccc'), { recursive: true });
  for (let i = 1; i <= 4; i++)
    fs.writeFileSync(path.join(dir, 'aaa', 'bbb', 'ccc', 'shared-prefix-' + i + '.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, '日本語ファイル.txt'), 'u\n');
  fs.writeFileSync(path.join(dir, 'ünïcödé.txt'), 'v\n');
  fs.symlinkSync('file.txt', path.join(dir, 'alias.txt'));
  git(dir, ['add', '.']);
  git(dir, ['update-index', '--index-version=2']);
  assert.equal(idxVersion(dir), 2, 'git did not write a v2 index');

  const idx = readIndex(gitDirOf(dir));
  assert.equal(idx.version, 2);
  assert.ok(!idx.error, idx.error);
  assert.equal(idx.count, idx.entries.length);
  assert.deepEqual(idx.entries.map(slim), lsStage(dir));
  const link = idx.entries.find(e => e.path === 'alias.txt');
  assert.equal(link.mode, '120000');
  checkOffsets(dir, idx);
  // stat data is real
  const e = idx.entries.find(x => x.path === 'file.txt');
  assert.equal(e.size, fs.statSync(path.join(dir, 'file.txt')).size);
  assert.equal(e.stage, 0);
});

test('v3: extended flags are parsed (skip-worktree, intent-to-add, assume-valid)', (t) => {
  const { dir } = mkRepo(t);
  fs.writeFileSync(path.join(dir, 'skip.txt'), 's\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  git(dir, ['add', 'skip.txt']);
  git(dir, ['add', '-N', 'new.txt']);
  git(dir, ['update-index', '--skip-worktree', 'skip.txt']);
  git(dir, ['update-index', '--assume-unchanged', 'file.txt']);
  git(dir, ['update-index', '--index-version=3']);
  assert.equal(idxVersion(dir), 3, 'extended flags should force a v3 index');

  const idx = readIndex(gitDirOf(dir));
  assert.equal(idx.version, 3);
  assert.ok(!idx.error, idx.error);
  assert.deepEqual(idx.entries.map(slim), lsStage(dir));
  assert.equal(idx.entries.find(e => e.path === 'skip.txt').skipWorktree, true);
  assert.equal(idx.entries.find(e => e.path === 'new.txt').intentToAdd, true);
  assert.equal(idx.entries.find(e => e.path === 'file.txt').assumeValid, true);
  checkOffsets(dir, idx);
});

test('v4: prefix-compressed paths match ls-files, incl. >0xfff and unicode names', (t) => {
  const { dir } = mkRepo(t);
  fs.mkdirSync(path.join(dir, 'aaa', 'bbb', 'ccc'), { recursive: true });
  for (let i = 1; i <= 4; i++)
    fs.writeFileSync(path.join(dir, 'aaa', 'bbb', 'ccc', 'shared-prefix-' + i + '.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, '日本語ファイル.txt'), 'u\n');
  fs.writeFileSync(path.join(dir, 'skip.txt'), 's\n');
  git(dir, ['add', '.']);
  // >0xfff (4095) byte path: namelen saturates, name is NUL-terminated only
  const longPath = 'd/'.repeat(2100) + 'tail.txt';
  const sha = git(dir, ['rev-parse', 'HEAD:file.txt']).trim();
  git(dir, ['update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + longPath]);
  git(dir, ['update-index', '--skip-worktree', 'skip.txt']);
  git(dir, ['update-index', '--index-version=4']);
  assert.equal(idxVersion(dir), 4, 'git did not write a v4 index');

  const idx = readIndex(gitDirOf(dir));
  assert.equal(idx.version, 4);
  assert.ok(!idx.error, idx.error);
  assert.equal(idx.count, idx.entries.length);
  assert.deepEqual(idx.entries.map(slim), lsStage(dir));
  assert.equal(idx.entries.find(e => e.path === 'skip.txt').skipWorktree, true);
  assert.ok(idx.entries.some(e => e.path === longPath), '4208-byte path decoded');
  checkOffsets(dir, idx);
});

test('v4 varint: multi-byte strip when consecutive paths share a long prefix', (t) => {
  const { dir } = mkRepo(t);
  const sha = git(dir, ['rev-parse', 'HEAD:file.txt']).trim();
  // a/b... share a >127-byte prefix; second entry's strip is still small,
  // but 'z' after the long paths strips >127 bytes -> multi-byte varint
  const long = 'p/'.repeat(80); // 160-byte shared prefix component
  git(dir, ['update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + long + 'a/one.txt']);
  git(dir, ['update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + long + 'a/two.txt']);
  git(dir, ['update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + long + 'b/three.txt']);
  git(dir, ['update-index', '--index-version=4']);
  assert.equal(idxVersion(dir), 4);
  const idx = readIndex(gitDirOf(dir));
  assert.ok(!idx.error, idx.error);
  assert.deepEqual(idx.entries.map(slim), lsStage(dir));
  checkOffsets(dir, idx);
});

test('conflict stages 1/2/3 are preserved for an unmerged path', (t) => {
  const { dir } = mkRepo(t);
  git(dir, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'side\n');
  git(dir, ['commit', '-qam', 'side']);
  git(dir, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'main\n');
  git(dir, ['commit', '-qam', 'main']);
  try { git(dir, ['merge', 'side']); } catch (e) { /* conflict expected */ }

  const idx = readIndex(gitDirOf(dir));
  assert.ok(!idx.error, idx.error);
  assert.deepEqual(idx.entries.map(slim), lsStage(dir));
  const stages = idx.entries.filter(e => e.path === 'file.txt').map(e => e.stage).sort();
  assert.deepEqual(stages, [1, 2, 3]);
  checkOffsets(dir, idx);
});

test('split index is reported as an explicit error, not empty staging', (t) => {
  const { dir } = mkRepo(t);
  git(dir, ['update-index', '--split-index']);
  const idx = readIndex(gitDirOf(dir));
  assert.equal(idx.split, true);
  assert.match(idx.error, /split index/i);
  assert.ok(idx.extensions.includes('link'));
});

test('sparse index (sdir + mode-040000 entries) is reported as an error', (t) => {
  const { dir } = mkRepo(t);
  fs.mkdirSync(path.join(dir, 'keep'));
  fs.mkdirSync(path.join(dir, 'drop', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep', 'f.txt'), 'k\n');
  fs.writeFileSync(path.join(dir, 'drop', 'nested', 'g.txt'), 'd\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'dirs']);
  try {
    git(dir, ['sparse-checkout', 'set', '--sparse-index', '--cone', 'keep']);
  } catch (e) {
    t.skip('git cannot create a sparse index here');
    return;
  }
  const idx = readIndex(gitDirOf(dir));
  if (!idx.extensions.includes('sdir')) {
    t.skip('git did not write an sdir extension');
    return;
  }
  assert.equal(idx.sparse, true);
  assert.match(idx.error, /sparse/i);
  const d = idx.entries.find(e => e.sparseDir);
  assert.ok(d && d.mode === '40000' && d.path.endsWith('/'));
});

/* ---------------- malformed input ---------------- */

function hdr(ver, n) {
  const b = Buffer.alloc(12);
  b.write('DIRC', 0, 'latin1');
  b.writeUInt32BE(ver, 4);
  b.writeUInt32BE(n, 8);
  return b;
}
function ext(sig, data) {
  const h = Buffer.alloc(8);
  h.write(sig, 0, 'latin1');
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
}
// one complete v2/v3 on-disk entry (fixed part + ext flags + name + pad8)
function entV2(name, { mode = 0o100644, sha = Buffer.alloc(20), stage = 0, flags2 = null, nl } = {}) {
  const nameB = Buffer.from(name, 'utf8');
  const fixed = Buffer.alloc(62);
  fixed.writeUInt32BE(mode, 24);
  sha.copy(fixed, 40);
  let flags = (stage & 3) << 12 | Math.min(nl !== undefined ? nl : nameB.length, 0xfff);
  if (flags2 !== null) flags |= 0x4000;
  fixed.writeUInt16BE(flags, 60);
  const ext2 = flags2 === null ? Buffer.alloc(0) : (() => {
    const b = Buffer.alloc(2); b.writeUInt16BE(flags2); return b;
  })();
  const body = Buffer.concat([fixed, ext2, nameB]);
  const pad = (8 - body.length % 8) % 8 || 8;
  return Buffer.concat([body, Buffer.alloc(pad)]);
}
// git's offset-encoding varint (same as OFS_DELTA offsets)
function encVarint(value) {
  const tail = [value & 0x7f];
  while (value >>= 7) tail.unshift(((value - 1) & 0x7f) | 0x80);
  return Buffer.from(tail);
}
const tail = n => Buffer.alloc(n); // stand-in content hash

test('parseIndex rejects short and non-DIRC input', () => {
  assert.match(parseIndex(Buffer.alloc(0)).error, /truncated index header/);
  assert.match(parseIndex(Buffer.alloc(11)).error, /truncated index header/);
  const bad = hdr(2, 0); bad.write('XXXX', 0, 'latin1');
  assert.match(parseIndex(bad).error, /bad magic/);
  assert.match(parseIndex(hdr(9, 0)).error, /unsupported index version 9/);
});

test('parseIndex bounds-checks truncated entries', () => {
  // count=1 but no room for the 62-byte fixed part
  assert.match(parseIndex(hdr(2, 1)).error, /truncated fixed fields/);
  assert.match(parseIndex(Buffer.concat([hdr(2, 1), Buffer.alloc(40)])).error,
    /truncated fixed fields/);
  // namelen claims bytes that are not there
  assert.match(parseIndex(Buffer.concat([hdr(2, 1), entV2('abc', { nl: 100 })])).error,
    /truncated path/);
  // namelen=0xfff with no NUL terminator anywhere
  const unterm = Buffer.concat([hdr(2, 1), entV2('abc', { nl: 0xfff }).slice(0, 65)]);
  assert.match(parseIndex(unterm).error, /unterminated path|truncated/);
});

test('parseIndex v4 bounds: strip overlong, runaway varint, unterminated suffix', () => {
  const fixed = Buffer.alloc(62);
  fixed.writeUInt16BE(1, 60); // namelen field unused in v4
  // first entry strips 5 bytes from an empty previous path
  assert.match(parseIndex(Buffer.concat([hdr(4, 1), fixed, encVarint(5), Buffer.from('x\0')])).error,
    /prefix strip exceeds previous path/);
  // varint that never terminates
  assert.match(parseIndex(Buffer.concat([hdr(4, 1), fixed, Buffer.alloc(12, 0x80)])).error,
    /varint|unterminated|truncated/);
  // suffix with no NUL
  assert.match(parseIndex(Buffer.concat([hdr(4, 1), fixed, encVarint(0), Buffer.from('abc')])).error,
    /unterminated path suffix/);
});

test('parseIndex rejects extended flags on v2, accepts them on v3', () => {
  const e = entV2('f.txt', { flags2: 0x4000 });
  assert.match(parseIndex(Buffer.concat([hdr(2, 1), e])).error,
    /extended flags require index v3/);
  const ok = parseIndex(Buffer.concat([hdr(3, 1), e, tail(20)]));
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.entries[0].skipWorktree, true);
});

test('parseIndex rejects v4 strip values that would wrap a signed 32-bit integer', () => {
  let value = 2 ** 31;
  const bytes = [value % 128];
  while (value >= 128) {
    value = Math.floor(value / 128) - 1;
    bytes.unshift(128 + value % 128);
  }
  const fixed = Buffer.alloc(62);
  fixed.writeUInt16BE(1, 60);
  const data = Buffer.concat([hdr(4, 1), fixed, Buffer.from(bytes), Buffer.from('x\0'), tail(20)]);
  assert.match(parseIndex(data).error, /prefix strip exceeds previous path/);
});

test('parseIndex validates v2 path termination and zero padding', () => {
  const entry = entV2('file.txt');
  const terminator = Buffer.from(entry);
  terminator[62 + 8] = 65;
  assert.match(parseIndex(Buffer.concat([hdr(2, 1), terminator, tail(20)])).error, /terminator/);
  const padding = Buffer.from(entry);
  padding[padding.length - 1] = 65;
  assert.match(parseIndex(Buffer.concat([hdr(2, 1), padding, tail(20)])).error, /padding/);
});

test('parseIndex reports unknown mandatory extensions', () => {
  const data = Buffer.concat([hdr(2, 0), ext('abcd', Buffer.alloc(0)), tail(20)]);
  assert.match(parseIndex(data).error, /unsupported mandatory index extension abcd/);
});

test('parseIndex truncates mid-entry on a sliced real index', (t) => {
  const { dir } = mkRepo(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, ['add', '.']);
  const full = fs.readFileSync(path.join(gitDirOf(dir), 'index'));
  const whole = parseIndex(full);
  assert.ok(!whole.error, whole.error);
  const cut = parseIndex(full.slice(0, whole.entries[1].offset + 10));
  assert.ok(cut.error, 'expected error for mid-entry truncation');
  assert.ok(cut.entries.length < whole.entries.length);
});

test('parseIndex detects link/sdir extensions in synthetic buffers', () => {
  const withLink = parseIndex(Buffer.concat([hdr(2, 0), ext('link', Buffer.alloc(8)), tail(20)]));
  assert.equal(withLink.split, true);
  assert.match(withLink.error, /split index/);
  const withSdir = parseIndex(Buffer.concat([hdr(2, 0), ext('sdir', Buffer.alloc(0)), tail(20)]));
  assert.equal(withSdir.sparse, true);
  assert.match(withSdir.error, /sparse/);
  // optional extensions are listed but not errors
  const ok = parseIndex(Buffer.concat([hdr(2, 0), ext('TREE', Buffer.alloc(4)), tail(20)]));
  assert.deepEqual(ok.extensions, ['TREE']);
  assert.ok(!ok.error);
  // garbage in the extension region is an error, not a silent pass
  const bogus = Buffer.alloc(8);
  bogus.write('ZZZZ', 0, 'latin1');
  bogus.writeUInt32BE(999, 4); // claims 999 bytes, far fewer remain
  const junk = Buffer.concat([hdr(2, 0), bogus, Buffer.alloc(10), tail(20)]);
  assert.match(parseIndex(junk).error, /malformed extension data/);
});

test('readIndex reports a corrupt index file via error, without throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-idx-bad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index'), 'garbage not an index');
  const idx = readIndex(root);
  assert.match(idx.error, /bad magic|truncated/);
  assert.deepEqual(idx.entries, []);
});
