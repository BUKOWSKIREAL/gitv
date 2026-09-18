'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
const { readIndex } = require('./index-reader');

/* ---------------- resource limits ----------------
 * Object body decoding and previews are bounded. Metadata enumeration and
 * index parsing still scale with repository size:
 *  - maxObjBytes    cap on one resolved object body (loose or pack)
 *  - looseInput     cap on compressed loose-file bytes read
 *  - pack windows   each decode reads ~size*1.125+8KB at the entry offset,
 *                   never the whole packfile
 *  - caches         loose results, pack handles and decoded entries are LRU
 *                   bounded by entry count and byte weight
 *  - deltaDepth     delta-base recursion cap (git defaults to ~50)
 *  - previewRead    head bytes read for worktree/status previews
 * --max bounds how many selected objects are decoded/emitted; delta bases
 * needed to resolve those may add a bounded number of extra decodes. */
const LIMITS = {
  maxObjBytes: 8 << 20,
  looseInputBytes: (8 << 20) + ((8 << 20) >> 3) + (64 << 10), // ~9.4MB
  previewRead: 64 << 10,
  deltaDepth: 64,
  looseCache: { entries: 256, bytes: 64 << 20 },
  decodedCache: { entries: 512, bytes: 64 << 20 },
  packCache: { entries: 8 },
  packedRefsBytes: 16 << 20,
  errors: 100,
};

// minimal LRU: Map insertion order = oldest-first; evicts while over budget
class Lru {
  constructor(maxEntries, maxBytes, weigh, onEvict) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes == null ? Infinity : maxBytes;
    this.weigh = weigh || (() => 1);
    this.onEvict = onEvict;
    this.m = new Map();
    this.bytes = 0;
  }
  get(k) {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k, v) {
    if (this.m.has(k)) this.delete(k);
    this.m.set(k, v);
    this.bytes += this.weigh(v);
    while (this.m.size > this.maxEntries || this.bytes > this.maxBytes)
      this.delete(this.m.keys().next().value);
  }
  delete(k) {
    const v = this.m.get(k);
    if (v === undefined) return;
    this.m.delete(k);
    this.bytes -= this.weigh(v);
    if (this.onEvict) { try { this.onEvict(v); } catch (e) {} }
  }
}

function tooLarge(what) {
  const e = new Error(what + ' too large');
  e.tooLarge = true;
  return e;
}

function inflateBounded(cbuf, what) {
  try {
    return zlib.inflateSync(cbuf, { maxOutputLength: LIMITS.maxObjBytes });
  } catch (e) {
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(what);
    throw e;
  }
}

function readAt(fd, off, len) {
  const buf = Buffer.allocUnsafe(Math.max(0, len));
  const n = fs.readSync(fd, buf, 0, buf.length, off);
  return buf.slice(0, n);
}

function readFileSlice(f, off, len) {
  const fd = fs.openSync(f, 'r');
  try { return readAt(fd, off, len); } finally { fs.closeSync(fd); }
}

const readFileHead = (f, n) => readFileSlice(f, 0, n);

const HEX = '0123456789abcdef';
function shaOf(buf) {
  let s = '';
  for (const b of buf) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}
function hexStr(buf, max) {
  const b = max && buf.length > max ? buf.slice(0, max) : buf;
  let s = '';
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15] + ' ';
  return { hex: s.trim(), total: buf.length, shown: b.length };
}
function isBinary(buf) {
  return buf.slice(0, 8192).includes(0);
}

function git(repo, args) {
  return cp.execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 << 20,
  });
}
function tryGit(repo, args) {
  try { return git(repo, args); } catch (e) { return ''; }
}

function findRepo(p) {
  const abs = path.resolve(p);
  const gitDir = git(abs, ['rev-parse', '--absolute-git-dir']).trim();
  const worktree = tryGit(abs, ['rev-parse', '--show-toplevel']).trim() || abs;
  // linked worktrees share most of .git via a commondir file
  let commonDir = gitDir;
  try {
    const cd = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    commonDir = path.resolve(gitDir, cd);
  } catch (e) {}
  return { gitDir, commonDir, worktree };
}

/* ---------------- input validation ---------------- */

function invalid(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// lexical containment: p must be strictly inside root
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// resolve symlinks; p must stay inside rootReal (an already-realpathed root).
// returns the real path, false if it escapes, or null if p cannot be resolved.
function realInside(rootReal, p) {
  let real;
  try { real = fs.realpathSync(p); } catch (e) { return null; }
  return isInside(rootReal, real) || real === rootReal ? real : false;
}

// resolve a user/status-supplied path for reading inside the worktree.
// rejects escapes, absolute paths, NULs, and .git metadata — both lexically
// and after symlink resolution (a symlink to .git/config is still metadata).
function safeWorktreePath(info, filePath) {
  const { worktree, gitDir, commonDir } = info;
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || path.isAbsolute(filePath))
    throw invalid('invalid path');
  const abs = path.resolve(worktree, filePath);
  if (!isInside(worktree, abs)) throw invalid('path escapes worktree');
  if (path.relative(worktree, abs).split(path.sep)[0] === '.git')
    throw invalid('path is git metadata');
  const real = realInside(fs.realpathSync(worktree), abs);
  if (real === false) throw invalid('path escapes worktree');
  if (real !== null) {
    for (const gd of new Set([gitDir, commonDir])) {
      let gdReal;
      try { gdReal = fs.realpathSync(gd); } catch (e) { continue; }
      if (real === gdReal || isInside(gdReal, real)) throw invalid('path is git metadata');
    }
  }
  return abs;
}

// git check-ref-format rules, additionally requiring the refs/ prefix.
// unicode names are allowed; anything git would reject is rejected.
const REF_BAD_CHARS = /[\x00-\x20\x7f ~^:?*\[\\]/;
function isValidRefName(name) {
  if (typeof name !== 'string' || name.length > 1024 || !name.startsWith('refs/')) return false;
  if (REF_BAD_CHARS.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (name.endsWith('/') || name.endsWith('.')) return false;
  for (const seg of name.split('/'))
    if (!seg || seg === '@' || seg.startsWith('.') || seg.endsWith('.lock')) return false;
  return true;
}

function isValidObjectId(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
}

/* ---------------- object bodies ---------------- */

function parseIdent(s) {
  const m = s.match(/^(.*?) <(.*?)> (\d+) ([+-]\d+)$/);
  return m ? { name: m[1], email: m[2], ts: +m[3], tz: m[4] } : { name: s, ts: 0 };
}

function parseCommit(body) {
  const s = body.toString('utf8');
  const sep = s.indexOf('\n\n');
  const head = s.slice(0, sep), msg = s.slice(sep + 2);
  const c = { parents: [], message: msg, subject: msg.split('\n')[0] };
  for (const l of head.split('\n')) {
    if (l.startsWith('tree ')) c.tree = l.slice(5).trim();
    else if (l.startsWith('parent ')) c.parents.push(l.slice(7).trim());
    else if (l.startsWith('author ')) c.author = parseIdent(l.slice(7));
    else if (l.startsWith('committer ')) c.committer = parseIdent(l.slice(10));
  }
  return c;
}

function parseTree(body) {
  const es = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(32, i);
    if (sp < i) throw new Error('malformed tree mode');
    const mode = body.slice(i, sp).toString('latin1');
    const nul = body.indexOf(0, sp);
    if (nul < sp || nul + 21 > body.length) throw new Error('malformed tree entry');
    const name = body.slice(sp + 1, nul).toString('utf8');
    const sha = shaOf(body.slice(nul + 1, nul + 21));
    i = nul + 21;
    es.push({
      mode, name, sha,
      type: mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob',
    });
  }
  return es;
}

function parseTag(body) {
  const s = body.toString('utf8');
  const sep = s.indexOf('\n\n');
  const head = s.slice(0, sep), msg = s.slice(sep + 2);
  const t = { message: msg, subject: msg.split('\n')[0] };
  for (const l of head.split('\n')) {
    if (l.startsWith('object ')) t.object = l.slice(7).trim();
    else if (l.startsWith('type ')) t.targetType = l.slice(5).trim();
    else if (l.startsWith('tag ')) t.tag = l.slice(4).trim();
    else if (l.startsWith('tagger ')) t.tagger = parseIdent(l.slice(7));
  }
  return t;
}

function blobPreview(body) {
  const binary = isBinary(body);
  if (binary) {
    const lines = [];
    for (let o = 0; o < Math.min(body.length, 48); o += 16)
      lines.push(hexStr(body.slice(o, o + 16)).hex);
    return { binary: true, lines, truncated: body.length > 48 };
  }
  const text = body.toString('utf8');
  const all = text.split('\n');
  const lines = all.slice(0, 6).map(s => s.slice(0, 40));
  return { binary: false, lines, truncated: all.length > 6 || text.length > 240,
           lineCount: all.length };
}

/* ---------------- loose objects ---------------- */

const looseCache = new Lru(LIMITS.looseCache.entries, LIMITS.looseCache.bytes,
  c => c.r.raw.length + c.r.cbuf.length + 256); // file -> {mtimeMs,size,r}

function readLooseFile(f) {
  const st = fs.statSync(f);
  const c = looseCache.get(f);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.r;
  if (st.size > LIMITS.looseInputBytes)
    throw tooLarge('loose object file ' + st.size + ' bytes');
  const cbuf = fs.readFileSync(f);
  const raw = inflateBounded(cbuf, 'loose object');
  const nul = raw.indexOf(0);
  const header = raw.slice(0, nul).toString('latin1');
  const sp = header.indexOf(' ');
  const r = {
    type: header.slice(0, sp), size: +header.slice(sp + 1),
    body: raw.slice(nul + 1), raw, nul, cbuf,
  };
  looseCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, r });
  return r;
}

/* ---------------- packfiles ---------------- */

// idxPath -> {mtimeMs, pack}; evicted packs have their fd closed
const packCache = new Lru(LIMITS.packCache.entries, Infinity, () => 1,
  c => c.pack.close());

function parseIdx(buf) {
  if (buf.readUInt32BE(0) !== 0xff744f63 || buf.readUInt32BE(4) !== 2)
    throw new Error('idx v2 only');
  const n = buf.readUInt32BE(8 + 255 * 4);
  const shaBase = 8 + 256 * 4;
  const offBase = shaBase + n * 20 + n * 4;
  const bigBase = offBase + n * 4;
  const entries = [];
  for (let i = 0; i < n; i++) {
    const sha = shaOf(buf.slice(shaBase + i * 20, shaBase + i * 20 + 20));
    let off = buf.readUInt32BE(offBase + i * 4);
    if (off & 0x80000000)
      off = Number(buf.readBigUInt64BE(bigBase + (off & 0x7fffffff) * 8));
    entries.push({ sha, offset: off });
  }
  return entries;
}

const PTYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

function applyDelta(base, delta) {
  let i = 0;
  const v = () => { let r = 0, s = 0, b; do { b = delta[i++]; r |= (b & 127) << s; s += 7; } while (b & 128); return r; };
  v(); // source size
  const dst = v();
  if (dst > LIMITS.maxObjBytes) throw tooLarge('delta result ' + dst + ' bytes');
  const out = Buffer.alloc(dst);
  let o = 0;
  while (i < delta.length) {
    const cmd = delta[i++];
    if (cmd & 128) {
      let co = 0, cs = 0;
      if (cmd & 1) co |= delta[i++];
      if (cmd & 2) co |= delta[i++] << 8;
      if (cmd & 4) co |= delta[i++] << 16;
      if (cmd & 8) co |= delta[i++] << 24;
      if (cmd & 16) cs |= delta[i++];
      if (cmd & 32) cs |= delta[i++] << 8;
      if (cmd & 64) cs |= delta[i++] << 16;
      if (!cs) cs = 0x10000;
      base.copy(out, o, co, co + cs); o += cs;
    } else if (cmd) {
      delta.copy(out, o, i, i + cmd); i += cmd; o += cmd;
    } else throw new Error('delta cmd 0');
  }
  return out;
}

// Open a pack lazily: the .idx is parsed for offsets and the .pack is read
// only in bounded windows at entry offsets — never whole-file. Decoded
// objects (incl. delta bases) live in a byte-weighted LRU.
function getPack(idxPath) {
  const st = fs.statSync(idxPath);
  const c = packCache.get(idxPath);
  if (c && c.mtimeMs === st.mtimeMs) return c.pack;
  packCache.delete(idxPath); // stale mtime: drop and close any old fd
  const entries = parseIdx(fs.readFileSync(idxPath));
  const packPath = idxPath.replace(/\.idx$/, '.pack');
  const pack = {
    idxPath, packPath, packFile: path.basename(packPath),
    packSize: fs.statSync(packPath).size,
    count: entries.length,
    offBySha: new Map(entries.map(e => [e.sha, e.offset])),
    fd: -1,
    decoded: new Lru(LIMITS.decodedCache.entries, LIMITS.decodedCache.bytes,
      d => d.raw.length + d.body.length + 256),
    close() {
      if (this.fd >= 0) { try { fs.closeSync(this.fd); } catch (e) {} this.fd = -1; }
    },
    read(off, len) {
      if (!Number.isSafeInteger(off) || off < 12 || off >= this.packSize)
        throw new Error('invalid pack offset');
      // Build-local references can outlive LRU eviction. Open per bounded
      // read so reopening an evicted pack cannot leak a file descriptor.
      return readFileSlice(this.packPath, off, Math.min(len, this.packSize - off));
    },
    // entry header varint + optional delta base ref: at most ~40 real bytes
    head(off) {
      const h = this.read(off, 96);
      let i = 0;
      if (!h.length) throw new Error('short pack entry @' + off);
      let b = h[i++];
      const t = (b >> 4) & 7;
      let size = b & 15, shift = 4;
      while (b & 128) {
        if (i >= h.length) throw new Error('bad entry header @' + off);
        b = h[i++]; size += (b & 127) * 2 ** shift; shift += 7;
        if (!Number.isSafeInteger(size)) throw tooLarge('pack entry');
      }
      let delta = null;
      if (t === 6) {
        let ob = h[i++], o = ob & 127;
        while (ob & 128) {
          if (i >= h.length) throw new Error('truncated delta offset');
          ob = h[i++]; o = (o + 1) * 128 + (ob & 127);
          if (!Number.isSafeInteger(o)) throw new Error('invalid delta offset');
        }
        delta = { baseOffset: off - o };
      } else if (t === 7) {
        delta = { baseSha: shaOf(h.slice(i, i + 20)) };
        i += 20;
      }
      return { entryType: PTYPE[t] || '?' + t, size, dataStart: off + i, headLen: i, delta };
    },
    decode(off, depth) {
      if (depth > LIMITS.deltaDepth) throw new Error('delta chain too deep');
      const hit = this.decoded.get(off);
      if (hit) return hit;
      const h = this.head(off);
      // `size` is the entry's inflated size (delta payload for delta
      // entries); an honest stream fits in ~size*1.125+8KB compressed, and
      // anything lying about it trips maxOutputLength instead.
      if (h.size > LIMITS.maxObjBytes) throw tooLarge('pack entry ' + h.size + ' bytes');
      const win = this.read(h.dataStart, h.size + (h.size >>> 3) + 8192);
      let inf;
      try {
        inf = zlib.inflateSync(win, { info: true, maxOutputLength: LIMITS.maxObjBytes });
      } catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge('pack entry');
        throw e;
      }
      const dataEnd = h.dataStart + inf.engine.bytesWritten;
      let out;
      if (h.delta) {
        const baseOff = h.delta.baseOffset != null
          ? h.delta.baseOffset : this.offBySha.get(h.delta.baseSha);
        if (baseOff == null) throw new Error('delta base not in pack');
        const base = this.decode(baseOff, depth + 1);
        const body = applyDelta(base.body, inf.buffer);
        out = {
          type: base.type, size: body.length, body, entryType: h.entryType,
          offset: off, dataStart: h.dataStart, dataEnd, headLen: h.headLen,
          delta: { ...h.delta, baseOffset: baseOff,
                   baseSha: h.delta.baseSha || null, baseType: base.type },
        };
      } else {
        out = {
          type: h.entryType, size: h.size, body: inf.buffer,
          entryType: h.entryType, offset: off, dataStart: h.dataStart,
          dataEnd, headLen: h.headLen, delta: null,
        };
      }
      // logical object form: "<type> <size>\0<body>"
      out.hdrLen = out.type.length + 1 + String(out.size).length + 1;
      out.raw = Buffer.concat([Buffer.from(out.type + ' ' + out.size + '\0'), out.body]);
      this.decoded.set(off, out);
      return out;
    },
  };
  packCache.set(idxPath, { mtimeMs: st.mtimeMs, pack });
  return pack;
}

// sha -> {type, size} for every object in the repo without inflating
// bodies in JS; git itself resolves delta types/sizes. Larger maxBuffer
// than `git()`: ~70B/object of output, 256MB covers several million.
function catFileTypes(worktree) {
  let out = '';
  try {
    out = cp.execFileSync('git', ['-C', worktree, 'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      { encoding: 'utf8', maxBuffer: 256 << 20 });
  } catch (e) { throw new Error('git object enumeration failed', { cause: e }); }
  const m = new Map();
  for (const line of out.split('\n')) {
    const sp1 = line.indexOf(' '), sp2 = line.indexOf(' ', sp1 + 1);
    if (sp1 !== 40 || sp2 < 0) continue;
    m.set(line.slice(0, 40), {
      type: line.slice(sp1 + 1, sp2), size: +line.slice(sp2 + 1),
    });
  }
  return m;
}

/* ---------------- refs / HEAD / index / status ---------------- */

function readRefs(gitDir, commonDir) {
  const refs = [];
  const seen = new Set();
  const roots = [path.join(gitDir, 'refs'), path.join(commonDir, 'refs')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const walk = d => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else {
          const rel = 'refs/' + path.relative(root, p).replace(/\\/g, '/');
          if (seen.has(rel)) continue;
          seen.add(rel);
          let sha = null, sym = null;
          try {
            const c = fs.readFileSync(p, 'utf8').trim();
            if (c.startsWith('ref:')) sym = c.slice(4).trim();
            else if (/^[0-9a-f]{40}$/.test(c)) sha = c;
          } catch (e) {}
          refs.push({ name: rel, sha, sym, file: p, source: 'loose' });
        }
      }
    };
    walk(root);
  }
  // packed-refs
  try {
    const pr = path.join(commonDir, 'packed-refs');
    const txt = fs.readFileSync(pr, 'utf8');
    let last = null;
    for (const line of txt.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('^')) { if (last) last.peeled = line.slice(1); continue; }
      const sha = line.slice(0, 40), name = line.slice(41).trim();
      const ex = refs.find(r => r.name === name);
      if (ex) { if (!ex.sha) ex.sha = sha; }
      else refs.push({ name, sha, sym: null, file: pr, source: 'packed' });
      last = refs.find(r => r.name === name);
    }
  } catch (e) {}
  for (const r of refs) {
    r.short = r.name.replace(/^refs\/(heads|tags|remotes)\//, '').replace(/^refs\//, '');
    r.kind = r.name.startsWith('refs/heads/') ? 'branch'
      : r.name.startsWith('refs/tags/') ? 'tag'
      : r.name.startsWith('refs/remotes/') ? 'remote'
      : r.name === 'refs/stash' ? 'stash' : 'other';
    // resolve symref chain
    if (r.sym) {
      let cur = r.sym, depth = 0;
      while (depth++ < 5) {
        const t = refs.find(x => x.name === cur);
        if (!t) break;
        if (t.sha) { r.sha = t.sha; break; }
        if (t.sym) cur = t.sym; else break;
      }
    }
  }
  return refs.filter(r => r.sha || r.sym);
}

function readHead(gitDir) {
  try {
    const c = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (c.startsWith('ref:')) return { type: 'symbolic', ref: c.slice(4).trim(), content: c };
    return { type: 'detached', sha: c, content: c };
  } catch (e) { return { type: 'none' }; }
}

function diffPreview(txt) {
  if (!txt) return [];
  return txt.split('\n')
    .filter(l => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')))
    .slice(0, 10)
    .map(l => ({ t: l[0], s: l.slice(1, 42) }));
}

function readStatus(info) {
  const { worktree } = info;
  const out = tryGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const items = [];
  const toks = out.split('\0');
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.length < 4) continue;
    const x = t[0], y = t[1], p = t.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') k++; // skip orig path
    items.push({ path: p, x, y });
  }
  for (const it of items.slice(0, 60)) {
    try {
      const abs = safeWorktreePath(info, it.path); // no reads via symlinks/metadata
      const st = fs.statSync(abs);
      it.size = st.size;
      if (st.isFile()) {
        const head = readFileHead(abs, LIMITS.previewRead);
        it.binary = isBinary(head);
        if (!it.binary)
          it.lines = head.toString('utf8').split('\n').slice(0, 6).map(s => s.slice(0, 40));
        else {
          it.lines = [];
          for (let o = 0; o < Math.min(head.length, 32); o += 16)
            it.lines.push(hexStr(head.slice(o, o + 16)).hex);
        }
      }
    } catch (e) { it.missing = true; }
    if (it.x !== ' ' && it.x !== '?')
      it.diff = diffPreview(tryGit(worktree, ['diff', '--cached', '--no-color', '-U1', '--', it.path]));
    if ((!it.diff || !it.diff.length) && it.y === 'M')
      it.diff = diffPreview(tryGit(worktree, ['diff', '--no-color', '-U1', '--', it.path]));
  }
  return items;
}

/* ---------------- assemble state ---------------- */

// decode one selected object to a rec {sha,type,size,body,prov}
function decodeSelected(sel, packByIdx) {
  const prov = sel.prov;
  if (prov.kind === 'loose') {
    const d = readLooseFile(prov.abs);
    return { sha: sel.sha, type: d.type, size: d.size, body: d.body,
             prov: { ...prov, fileSize: d.cbuf.length } };
  }
  const pack = packByIdx.get(prov.idx);
  if (!pack) throw new Error('pack not loaded');
  const d = pack.decode(prov.offset, 0);
  return {
    sha: sel.sha, type: d.type, size: d.size, body: d.body,
    prov: { ...prov, entryType: d.entryType, dataStart: d.dataStart,
            dataEnd: d.dataEnd, headLen: d.headLen, delta: d.delta },
  };
}

function buildState(repoPath, max) {
  const info = findRepo(repoPath);
  const { gitDir, commonDir, worktree } = info;
  const objectsDir = path.join(commonDir, 'objects');

  // ---- metadata-first enumeration: provenance per object, no bodies ----
  const metas = new Map(); // sha -> prov; loose first (wins), then packs
  let looseCount = 0, packedCount = 0;
  try {
    for (const sub of fs.readdirSync(objectsDir)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      const sd = path.join(objectsDir, sub);
      for (const f of fs.readdirSync(sd)) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        looseCount++;
        metas.set(sub + f, { kind: 'loose', path: path.join(sub, f),
                             abs: path.join(sd, f) });
      }
    }
  } catch (e) {}

  const packs = [], packByIdx = new Map();
  try {
    const packDir = path.join(objectsDir, 'pack');
    for (const f of fs.readdirSync(packDir)) {
      if (!f.endsWith('.idx')) continue;
      try {
        const p = getPack(path.join(packDir, f));
        packs.push({ file: p.packFile, count: p.count, size: p.packSize });
        packByIdx.set(p.idxPath, p);
        for (const sha of p.offBySha.keys()) {
          packedCount++;
          if (!metas.has(sha))
            metas.set(sha, { kind: 'pack', pack: p.packFile, idx: p.idxPath,
                             offset: p.offBySha.get(sha) });
        }
      } catch (e) {}
    }
  } catch (e) {}

  // accurate type/size per object via git, still without inflating in JS
  const types = catFileTypes(worktree);
  if (metas.size && !types.size)
    throw new Error('git object enumeration failed');

  const refs = readRefs(gitDir, commonDir);
  const head = readHead(gitDir);
  const index = readIndex(gitDir);
  const status = readStatus(info);

  // bucket in enumeration order; type counts are exact regardless of --max
  const commits = [], trees = [], blobs = [], tags = [], other = [];
  for (const [sha, prov] of metas) {
    const t = types.get(sha);
    const sel = { sha, prov, msize: t ? t.size : undefined };
    if (!t) other.push(sel);
    else if (t.type === 'commit') commits.push(sel);
    else if (t.type === 'tree') trees.push(sel);
    else if (t.type === 'blob') blobs.push(sel);
    else if (t.type === 'tag') tags.push(sel);
    else other.push(sel);
  }

  // ---- select at most `max` objects to decode. --max bounds the bodies
  // inflated in JS, not just the emitted slice; delta bases pulled in by a
  // selected object are extra but bounded by depth and the decode LRU. ----
  const ordered = [...commits, ...trees, ...blobs, ...tags];
  const truncated = ordered.length > max;
  const selected = truncated ? ordered.slice(0, max) : ordered;

  const recs = new Map(); // sha -> decoded+parsed rec
  const errors = [];
  let errorCount = 0;
  const fail = (sha, e) => {
    errorCount++;
    if (errors.length < LIMITS.errors)
      errors.push({ sha, error: String(e && e.message || e) });
  };
  for (const sel of selected) {
    // git's resolved size catches oversized objects (incl. delta results)
    // before any bytes are read
    if (sel.msize != null && sel.msize > LIMITS.maxObjBytes) {
      fail(sel.sha, 'object ' + sel.msize + ' bytes too large');
      continue;
    }
    let rec;
    try { rec = decodeSelected(sel, packByIdx); }
    catch (e) { fail(sel.sha, e); continue; }
    try {
      if (rec.type === 'commit') rec.data = rec._c = parseCommit(rec.body);
      else if (rec.type === 'tree') {
        const t = rec._t = parseTree(rec.body);
        rec.data = { entries: t.slice(0, 40), total: t.length };
      } else if (rec.type === 'blob') rec.data = { preview: blobPreview(rec.body) };
      else if (rec.type === 'tag') rec.data = rec._g = parseTag(rec.body);
      else throw new Error('unknown object type ' + rec.type);
    } catch (e) { fail(sel.sha, e); continue; }
    recs.set(sel.sha, rec);
  }

  // reachability walks only decoded selections; it never inflates extra
  // objects just to color the graph. An edge into an unselected (or
  // unrenderable) object leaves its subtree unproven -> incomplete.
  let reachabilityComplete = true;
  const reachable = new Set();
  const stack = [];
  for (const r of refs) if (r.sha) stack.push(r.sha);
  if (head.type === 'detached' && head.sha) stack.push(head.sha);
  for (const e of index.entries) stack.push(e.sha);
  while (stack.length) {
    const sha = stack.pop();
    if (reachable.has(sha)) continue;
    const o = recs.get(sha);
    if (!o) {
      if (metas.has(sha)) reachabilityComplete = false;
      continue;
    }
    reachable.add(sha);
    if (o.type === 'commit') {
      if (o._c.tree) stack.push(o._c.tree);
      for (const p of o._c.parents) stack.push(p);
    } else if (o.type === 'tree') {
      for (const e of o._t) stack.push(e.sha);
    } else if (o.type === 'tag') {
      if (o._g.object) stack.push(o._g.object);
    }
  }

  // emit objects, newest commits first, then trees, blobs, tags
  const ts = s => (recs.get(s.sha).data.committer ? recs.get(s.sha).data.committer.ts : 0);
  const shownCommits = commits.filter(s => recs.has(s.sha)).sort((a, b) => ts(b) - ts(a));
  const orderedShown = [
    ...shownCommits,
    ...trees.filter(s => recs.has(s.sha)),
    ...blobs.filter(s => recs.has(s.sha)),
    ...tags.filter(s => recs.has(s.sha)),
  ];

  const outObjects = orderedShown.map(s => {
    const o = recs.get(s.sha);
    return {
      sha: o.sha, type: o.type, size: o.size,
      // unproven objects are marked reachable so ghost styling is
      // suppressed; reachabilityComplete tells the UI not to trust false.
      reachable: reachable.has(o.sha) || !reachabilityComplete,
      prov: { kind: o.prov.kind, path: o.prov.path, fileSize: o.prov.fileSize,
              pack: o.prov.pack, offset: o.prov.offset, entryType: o.prov.entryType,
              delta: o.prov.delta },
      data: o.data,
    };
  });

  return {
    repoPath: worktree, gitDir,
    head, refs, packs,
    index: { ...index, entries: index.entries.slice(0, 300) },
    indexTotal: index.entries.length,
    status: status.slice(0, 60),
    statusTotal: status.length,
    objects: outObjects,
    errors,
    warnings: errorCount ? [errorCount + ' object(s) could not be displayed; see state.errors'] : [],
    reachabilityComplete,
    counts: {
      commits: commits.length, trees: trees.length, blobs: blobs.length, tags: tags.length,
      loose: looseCount, packed: packedCount,
      unreachable: outObjects.filter(o => !o.reachable).length,
      shown: outObjects.length, total: ordered.length, truncated,
      errors: errorCount,
    },
    time: Date.now(),
  };
}

/* ---------------- detail (parse story) ---------------- */

function hex(buf, max, hl) {
  const h = hexStr(buf, max || 160);
  return { ...h, hl: hl || [] };
}

function objectDetail(repoPath, sha) {
  if (!isValidObjectId(sha)) throw invalid('invalid object id');
  const { gitDir, commonDir } = findRepo(repoPath);
  const objectsDir = path.join(commonDir, 'objects');
  // loose?
  const lp = path.join(objectsDir, sha.slice(0, 2), sha.slice(2));
  if (fs.existsSync(lp)) {
    let d;
    try { d = readLooseFile(lp); }
    catch (e) {
      if (e && e.tooLarge) return { sha, error: 'object too large to display' };
      throw e;
    }
    const steps = [
      { k: 'file', path: '.git/objects/' + sha.slice(0, 2) + '/' + sha.slice(2),
        note: fs.statSync(lp).size + ' bytes on disk', shaParts: [sha.slice(0, 2), sha.slice(2)] },
      { k: 'hex', title: 'stored bytes (zlib stream)', ...hex(d.cbuf, 128) },
      { k: 'op', label: 'inflate' },
      { k: 'hex', title: 'decompressed', ...hex(d.raw, 160, [{ s: 0, e: d.nul + 1, c: 'hdr' }]),
        note: '"' + d.type + ' ' + d.size + '\\0" + body' },
      { k: 'parsed', fields: parsedFields(d.type, d.body) },
    ];
    return { sha, type: d.type, size: d.size, steps, bodyText: bodyText(d.type, d.body) };
  }
  // pack?
  const packDir = path.join(objectsDir, 'pack');
  let idxFiles = [];
  try { idxFiles = fs.readdirSync(packDir); } catch (e) {}
  for (const f of idxFiles) {
    if (!f.endsWith('.idx')) continue;
    let p;
    try { p = getPack(path.join(packDir, f)); } catch (e) { continue; }
    const off = p.offBySha.get(sha);
    if (off == null) continue;
    let o;
    try { o = p.decode(off, 0); }
    catch (e) {
      if (e && e.tooLarge) return { sha, error: 'object too large to display' };
      return { sha, error: 'unreadable object: ' + String(e.message || e) };
    }
    const entryBytes = p.read(o.offset, Math.min(o.dataEnd - o.offset, 128));
    const steps = [
      { k: 'file', path: '.git/objects/pack/' + p.packFile,
        note: p.count + ' objects · offset ' + o.offset },
      { k: 'hex', title: 'pack entry @' + o.offset,
        ...hex(entryBytes, 128, [
          { s: 0, e: o.dataStart - o.offset, c: 'hdr' },
        ]),
        note: o.entryType + ' · size ' + o.size },
    ];
    if (o.delta) {
      steps.push({ k: 'op', label: o.entryType === 'ofs-delta'
        ? 'delta → base @' + o.delta.baseOffset
        : 'delta → base ' + (o.delta.baseSha || '').slice(0, 10) });
    }
    steps.push({ k: 'op', label: 'inflate' });
    steps.push({ k: 'hex', title: 'resolved object', ...hex(o.raw, 160, [{ s: 0, e: o.hdrLen, c: 'hdr' }]) });
    steps.push({ k: 'parsed', fields: parsedFields(o.type, o.body) });
    return { sha, type: o.type, size: o.size, steps, bodyText: bodyText(o.type, o.body) };
  }
  return { sha, error: 'not found' };
}

function parsedFields(type, body) {
  if (type === 'commit') {
    const c = parseCommit(body);
    return [
      { k: 'type', v: 'commit' },
      { k: 'tree', v: c.tree, sha: c.tree },
      ...(c.parents.length ? c.parents.map((p, i) => ({ k: 'parent' + (c.parents.length > 1 ? ' ' + (i + 1) : ''), v: p, sha: p })) : []),
      { k: 'author', v: c.author.name + ' <' + c.author.email + '>' },
      { k: 'date', v: new Date(c.author.ts * 1000).toLocaleString() },
      { k: 'message', v: c.message.trim().slice(0, 300) },
    ];
  }
  if (type === 'tree') {
    return parseTree(body).slice(0, 60).map(e => ({
      k: e.mode, v: e.name, sha: e.sha, t: e.type,
    }));
  }
  if (type === 'tag') {
    const t = parseTag(body);
    return [
      { k: 'object', v: t.object, sha: t.object },
      { k: 'type', v: t.targetType },
      { k: 'tag', v: t.tag },
      { k: 'tagger', v: t.tagger ? t.tagger.name : '' },
      { k: 'message', v: (t.message || '').trim().slice(0, 200) },
    ];
  }
  return [{ k: 'type', v: 'blob' }, { k: 'size', v: body.length + ' bytes' }];
}

function bodyText(type, body) {
  if (type !== 'blob') return null;
  if (isBinary(body)) return { binary: true, hex: hexStr(body, 512).hex };
  return { binary: false, text: body.toString('utf8').slice(0, 6000), truncated: body.length > 6000 };
}

function refDetail(repoPath, name) {
  if (!isValidRefName(name)) throw invalid('invalid ref name');
  const { gitDir, commonDir } = findRepo(repoPath);
  // loose ref: per-worktree refs live in gitDir, shared refs in commonDir
  for (const base of new Set([gitDir, commonDir])) {
    const loose = path.join(base, name);
    if (!isInside(base, loose) || !fs.existsSync(loose)) continue;
    // a loose ref must resolve inside <base>/refs — a symlink to config
    // or objects elsewhere in the git dir is not a ref payload
    let real;
    try {
      const refsReal = fs.realpathSync(path.join(base, 'refs'));
      real = fs.realpathSync(loose);
      if (real !== refsReal && !isInside(refsReal, real)) real = false;
    } catch (e) { real = null; }
    if (real === false) throw invalid('ref escapes refs dir');
    if (real === null) continue; // unresolvable (dangling symlink): not readable
    const buf = fs.readFileSync(loose);
    return { title: name, steps: [
      { k: 'file', path: '.git/' + name, note: base !== gitDir ? 'shared (commondir)' : undefined },
      { k: 'hex', title: 'file content', ...hex(buf, 64) },
      { k: 'text', text: buf.toString('utf8').trim() },
    ] };
  }
  try {
    const pr = path.join(commonDir, 'packed-refs');
    if (realInside(fs.realpathSync(commonDir), pr) !== fs.realpathSync(pr))
      return { title: name, error: 'ref not found' };
    if (fs.statSync(pr).size > LIMITS.packedRefsBytes)
      return { title: name, error: 'packed-refs too large' };
    const buf = fs.readFileSync(pr);
    const line = buf.toString('utf8').split('\n').find(l => l.slice(41).trim() === name);
    if (!line) return { title: name, error: 'ref not found' };
    const off = buf.indexOf(line);
    return { title: name, steps: [
      { k: 'file', path: '.git/packed-refs', note: 'shared ref file' },
      { k: 'hex', title: 'line @' + off, ...hex(Buffer.from(line), 64) },
      { k: 'text', text: line },
    ] };
  } catch (e) { return { title: name, error: 'ref not found' }; }
}

function headDetail(repoPath) {
  const { gitDir } = findRepo(repoPath);
  const buf = readFileHead(path.join(gitDir, 'HEAD'), 4096);
  return { title: 'HEAD', steps: [
    { k: 'file', path: '.git/HEAD' },
    { k: 'hex', title: 'file content', ...hex(buf, 64) },
    { k: 'text', text: buf.toString('utf8').trim() },
  ] };
}

function indexDetail(repoPath, entryPath) {
  const { gitDir } = findRepo(repoPath);
  const idx = readIndex(gitDir);
  if (idx.error) return { title: 'index', error: idx.error };
  const e = idx.entries.find(x => x.path === entryPath);
  if (!e) return { title: 'index', steps: [{ k: 'file', path: '.git/index' }] };
  const f = path.join(gitDir, 'index');
  let raw = Buffer.alloc(0);
  try { raw = readFileSlice(f, e.offset, 80); } catch (e) {}
  // name field starts after the fixed fields (+2 more for v3+ extended flags)
  const nameOff = (e.nameOffset != null ? e.nameOffset : e.offset + 62) - e.offset;
  return { title: entryPath, steps: [
    { k: 'file', path: '.git/index', note: 'entry @' + e.offset + ' · DIRC v' + idx.version },
    { k: 'hex', title: 'entry bytes', ...hex(raw, 80, [{ s: 40, e: 60, c: 'sha' }, { s: nameOff, e: nameOff + Math.min(e.path.length, 18), c: 'name' }]) },
    { k: 'parsed', fields: [
      { k: 'path', v: e.path }, { k: 'mode', v: e.mode },
      { k: 'sha', v: e.sha, sha: e.sha }, { k: 'stage', v: String(e.stage) },
      { k: 'size', v: e.size + ' bytes' },
      { k: 'mtime', v: new Date(e.mtime * 1000).toLocaleString() },
    ] },
  ] };
}

function workdirDetail(repoPath, filePath) {
  const info = findRepo(repoPath);
  const { worktree } = info;
  const abs = safeWorktreePath(info, filePath);
  const steps = [{ k: 'file', path: filePath }];
  try {
    const st = fs.statSync(abs);
    steps[0].note = st.size + ' bytes · mtime ' + new Date(st.mtimeMs).toLocaleString();
    const buf = readFileHead(abs, LIMITS.previewRead);
    if (isBinary(buf)) steps.push({ k: 'hex', title: 'bytes', ...hex(buf, 128) });
    else steps.push({ k: 'text', text: buf.toString('utf8').slice(0, 6000) });
  } catch (e) { steps.push({ k: 'text', text: '(deleted)' }); }
  const d1 = tryGit(worktree, ['diff', '--no-color', '-U2', '--', filePath]);
  const d2 = tryGit(worktree, ['diff', '--cached', '--no-color', '-U2', '--', filePath]);
  const diff = (d2 || '') + (d1 ? (d2 ? '\n' : '') + d1 : '');
  if (diff) steps.push({ k: 'diff', text: diff.split('\n').slice(0, 120).join('\n') });
  return { title: filePath, steps };
}

/* ---------------- state diff ---------------- */

function diffState(prev, next) {
  const c = { added: [], removed: [], refsMoved: [], refsAdded: [], refsRemoved: [],
              headChanged: false, indexChanged: false,
              statusAdded: [], statusRemoved: [], statusChanged: [] };
  const p = new Map(prev.objects.map(o => [o.sha, o]));
  const n = new Map(next.objects.map(o => [o.sha, o]));
  for (const sha of n.keys()) if (!p.has(sha)) c.added.push(sha);
  for (const sha of p.keys()) if (!n.has(sha)) c.removed.push(sha);
  const pr = new Map(prev.refs.map(r => [r.name, r.sha]));
  const nr = new Map(next.refs.map(r => [r.name, r.sha]));
  for (const [k, v] of nr) {
    if (!pr.has(k)) c.refsAdded.push(k);
    else if (pr.get(k) !== v) c.refsMoved.push(k);
  }
  for (const k of pr.keys()) if (!nr.has(k)) c.refsRemoved.push(k);
  const ph = prev.head.ref || prev.head.sha, nh = next.head.ref || next.head.sha;
  c.headChanged = ph !== nh;
  const pi = new Set(prev.index.entries.map(e => e.path + ':' + e.sha + ':' + e.stage));
  const ni = new Set(next.index.entries.map(e => e.path + ':' + e.sha + ':' + e.stage));
  c.indexChanged = pi.size !== ni.size || [...pi].some(x => !ni.has(x));
  // signature must catch same-size content changes, so include the
  // preview lines and staged/unstaged diff hunks, not just status+size
  const statusSig = s => s.x + s.y + (s.size || 0) + (s.missing ? 1 : 0)
    + '|' + (s.lines || []).join('\n') + '|' + JSON.stringify(s.diff || []);
  const ps = new Map(prev.status.map(s => [s.path, statusSig(s)]));
  const ns = new Map(next.status.map(s => [s.path, statusSig(s)]));
  for (const [k, v] of ns) {
    if (!ps.has(k)) c.statusAdded.push(k);
    else if (ps.get(k) !== v) c.statusChanged.push(k);
  }
  for (const k of ps.keys()) if (!ns.has(k)) c.statusRemoved.push(k);
  return c;
}

// test/debug hooks: bounds and the bounded caches themselves
const internals = { LIMITS, Lru, looseCache, packCache };

module.exports = { buildState, findRepo, diffState, objectDetail, refDetail, headDetail, indexDetail, workdirDetail, isValidRefName, isValidObjectId, internals };
