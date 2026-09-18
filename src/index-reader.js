'use strict';
/* Git index (dircache) reader.
 * Extracted from src/repo.js so the on-disk format is unit-testable on its own.
 * Handles index v2/v3 (NUL-padded paths, v3 extended flags) and v4 (pathname
 * prefix compression). Split index ('link' extension) and sparse index
 * ('sdir' extension, mode-040000 directory entries) are detected and reported
 * via `error` instead of silently returning a partial staging view.
 * Entry objects keep the repo.js shape: {path, sha, mode, stage, size, mtime,
 * offset}; `offset` is the absolute file offset indexDetail slices from. */
const fs = require('fs');
const path = require('path');

const HEX = '0123456789abcdef';
function shaOf(buf) {
  let s = '';
  for (const b of buf) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}

/* Walk the extension region between the last entry and the trailing content
 * hash. `trailer` is the assumed hash length (sha1=20, sha256=32, or 0 for
 * index.skipHash). Returns the extension signatures in order, or null when
 * the region does not tile cleanly under that assumption. */
function scanExtensions(buf, p, trailer) {
  const end = buf.length - trailer;
  const sigs = [];
  while (p < end) {
    if (p + 8 > end) return null;
    const size = buf.readUInt32BE(p + 4);
    if (p + 8 + size > end) return null;
    sigs.push(buf.toString('latin1', p, p + 4));
    p += 8 + size;
  }
  return p === end ? sigs : null;
}

/* Parse one index file body. Never throws: malformed or truncated input is
 * reported through `error`, with the entries decoded so far still returned. */
function parseIndex(buf) {
  const out = { entries: [], fileSize: buf.length };
  if (buf.length < 12) { out.error = 'truncated index header'; return out; }
  if (buf.toString('latin1', 0, 4) !== 'DIRC') { out.error = 'bad magic'; return out; }
  const ver = buf.readUInt32BE(4), n = buf.readUInt32BE(8);
  out.version = ver; out.count = n;
  if (ver < 2 || ver > 4) { out.error = 'unsupported index version ' + ver; return out; }
  let i = 12;
  let prev = Buffer.alloc(0); // previous path bytes: v4 prefix compression base
  let sparseDirs = 0;
  try {
    for (let k = 0; k < n; k++) {
      const start = i;
      const fail = m => { throw new Error('entry ' + k + ' @' + start + ': ' + m); };
      if (i + 62 > buf.length) fail('truncated fixed fields');
      const mode = buf.readUInt32BE(i + 24);
      const size = buf.readUInt32BE(i + 36);
      const mtime = buf.readUInt32BE(i + 8);
      const sha = shaOf(buf.slice(i + 40, i + 60));
      const flags = buf.readUInt16BE(i + 60);
      const stage = (flags >> 12) & 3;
      i += 62;
      let flags2 = 0;
      if (flags & 0x4000) {
        if (ver === 2) fail('extended flags require index v3+');
        if (i + 2 > buf.length) fail('truncated extended flags');
        flags2 = buf.readUInt16BE(i);
        i += 2;
      }
      const nameOffset = i;
      let name;
      if (ver === 4) {
        // varint N = bytes to strip from the previous path, then a
        // NUL-terminated suffix S; path = prev[:-N] + S. No padding.
        if (i >= buf.length) fail('truncated path');
        let b = buf[i++], strip = b & 0x7f, vb = 1;
        while (b & 0x80) {
          if (i >= buf.length) fail('truncated path varint');
          b = buf[i++];
          strip = (strip + 1) * 128 + (b & 0x7f);
          if (!Number.isSafeInteger(strip)) fail('path varint out of range');
          if (++vb > 9) fail('path varint too long');
        }
        const e = buf.indexOf(0, i);
        if (e < 0) fail('unterminated path suffix');
        if (strip > prev.length) fail('prefix strip exceeds previous path');
        name = Buffer.concat([prev.slice(0, prev.length - strip), buf.slice(i, e)]);
        i = e + 1;
      } else {
        const nl = flags & 0xfff;
        let e;
        if (nl === 0xfff) {
          e = buf.indexOf(0, i); // long names are NUL-terminated only
          if (e < 0) fail('unterminated path');
        } else {
          e = i + nl;
          if (e > buf.length) fail('truncated path');
        }
        name = buf.slice(i, e);
        if (name.includes(0)) fail('NUL within path');
        if (e >= buf.length || buf[e] !== 0) fail('missing path terminator');
        i = e;
        // NUL terminator plus padding to an 8-byte entry boundary
        do { i++; } while ((i - start) % 8 !== 0);
        if (i > buf.length) fail('truncated padding');
        if (buf.subarray(e, i).some(b => b !== 0)) fail('nonzero path padding');
      }
      prev = name;
      const sparseDir = (mode & 0xf000) === 0x4000;
      if (sparseDir) sparseDirs++;
      out.entries.push({
        path: name.toString('utf8'), sha, mode: mode.toString(8), stage,
        size, mtime, offset: start, nameOffset, entryEnd: i,
        assumeValid: !!(flags & 0x8000),
        skipWorktree: !!(flags2 & 0x4000),
        intentToAdd: !!(flags2 & 0x2000),
        sparseDir,
      });
    }
  } catch (e) { out.error = String(e.message); return out; }
  const sigs = scanExtensions(buf, i, 20) ?? scanExtensions(buf, i, 32) ?? scanExtensions(buf, i, 0);
  out.extensions = sigs || [];
  if (sigs === null) out.error = 'malformed extension data';
  const required = sigs && sigs.find(s => !/^[A-Z]/.test(s) && s !== 'link' && s !== 'sdir');
  if (required) out.error = 'unsupported mandatory index extension ' + required;
  if (sigs && sigs.includes('link')) {
    out.split = true;
    out.error = 'split index (link extension) unsupported';
  }
  if ((sigs && sigs.includes('sdir')) || sparseDirs) {
    out.sparse = true;
    out.sparseDirs = sparseDirs;
    out.error = out.split ? out.error : 'sparse index unsupported';
  }
  return out;
}

function readIndex(gitDir) {
  const f = path.join(gitDir, 'index');
  if (!fs.existsSync(f)) return { entries: [], file: '.git/index' };
  const out = parseIndex(fs.readFileSync(f));
  out.file = '.git/index';
  return out;
}

module.exports = { readIndex, parseIndex };
