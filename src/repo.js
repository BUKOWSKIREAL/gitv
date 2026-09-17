'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

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
    const mode = body.slice(i, sp).toString('latin1');
    const nul = body.indexOf(0, sp);
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

const looseCache = new Map(); // file -> {mtimeMs,size,r:{type,size,body,cbuf,header}}

function readLooseFile(f) {
  const st = fs.statSync(f);
  const c = looseCache.get(f);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.r;
  const cbuf = fs.readFileSync(f);
  const raw = zlib.inflateSync(cbuf);
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

const packCache = new Map(); // idxPath -> {mtimeMs, r}

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

function readPack(idxPath) {
  const st = fs.statSync(idxPath);
  const c = packCache.get(idxPath);
  if (c && c.mtimeMs === st.mtimeMs) return c.r;
  const entries = parseIdx(fs.readFileSync(idxPath));
  const packPath = idxPath.replace(/\.idx$/, '.pack');
  const pack = fs.readFileSync(packPath);
  const offBySha = new Map(entries.map(e => [e.sha, e.offset]));
  const decoded = new Map(); // offset -> object

  function decode(off) {
    if (decoded.has(off)) return decoded.get(off);
    let i = off;
    let b = pack[i++];
    const t = (b >> 4) & 7;
    let size = b & 15, shift = 4;
    while (b & 128) { b = pack[i++]; size |= (b & 127) << shift; shift += 7; }
    const entryType = PTYPE[t] || '?' + t;
    let delta = null;
    if (t === 6) {
      let ob = pack[i++], o = ob & 127;
      while (ob & 128) { ob = pack[i++]; o = ((o + 1) << 7) | (ob & 127); }
      delta = { baseOffset: off - o };
    } else if (t === 7) {
      delta = { baseSha: shaOf(pack.slice(i, i + 20)) };
      i += 20;
    }
    const dataStart = i;
    const inf = zlib.inflateSync(pack.slice(i), { info: true });
    const dataEnd = dataStart + inf.engine.bytesWritten;
    let out;
    if (delta) {
      const baseOff = delta.baseOffset != null ? delta.baseOffset : offBySha.get(delta.baseSha);
      const base = decode(baseOff);
      const body = applyDelta(base.body, inf.buffer);
      out = {
        type: base.type, size: body.length, body, entryType, offset: off,
        dataStart, dataEnd, headLen: dataStart - off,
        delta: { ...delta, baseOffset: baseOff, baseSha: delta.baseSha || null, baseType: base.type },
      };
    } else {
      const body = inf.buffer;
      out = {
        type: entryType, size, body, entryType, offset: off,
        dataStart, dataEnd, headLen: dataStart - off, delta: null,
      };
    }
    // logical object form: "<type> <size>\0<body>"
    out.hdrLen = out.type.length + 1 + String(out.size).length + 1;
    out.raw = Buffer.concat([Buffer.from(out.type + ' ' + out.size + '\0'), out.body]);
    decoded.set(off, out);
    return out;
  }

  const objects = new Map();
  for (const e of entries) {
    try {
      const d = decode(e.offset);
      objects.set(e.sha, { ...d, prov: {
        kind: 'pack', pack: path.basename(packPath), idx: path.basename(idxPath),
        offset: e.offset, entryType: d.entryType,
        dataStart: d.dataStart, dataEnd: d.dataEnd, headLen: d.headLen,
        delta: d.delta,
      } });
    } catch (e) { /* undecodable entry: skip */ }
  }
  const r = {
    packFile: path.basename(packPath), packPath, packSize: fs.statSync(packPath).size,
    count: entries.length, objects, _packBuf: pack,
  };
  packCache.set(idxPath, { mtimeMs: st.mtimeMs, r });
  return r;
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

function readIndex(gitDir) {
  const f = path.join(gitDir, 'index');
  if (!fs.existsSync(f)) return { entries: [], file: '.git/index' };
  const buf = fs.readFileSync(f);
  const out = { entries: [], file: '.git/index', fileSize: buf.length };
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') { out.error = 'bad magic'; return out; }
  const ver = buf.readUInt32BE(4), n = buf.readUInt32BE(8);
  out.version = ver; out.count = n;
  if (ver !== 2 && ver !== 3) { out.error = 'v' + ver + ' names unsupported'; return out; }
  let i = 12;
  try {
    for (let k = 0; k < n; k++) {
      const start = i;
      const mode = buf.readUInt32BE(i + 24);
      const size = buf.readUInt32BE(i + 36);
      const mtime = buf.readUInt32BE(i + 8);
      const sha = shaOf(buf.slice(i + 40, i + 60));
      const flags = buf.readUInt16BE(i + 60);
      const stage = (flags >> 12) & 3;
      let nl = flags & 0xfff;
      i += 62;
      if (ver === 3 && (flags & 0x4000)) i += 2;
      let name;
      if (nl === 0xfff) { const e = buf.indexOf(0, i); name = buf.toString('utf8', i, e); i = e; }
      else { name = buf.toString('utf8', i, i + nl); i += nl; }
      // name must be NUL-terminated: 1-8 padding bytes to align entry to 8
      do { i++; } while ((i - start) % 8 !== 0);
      out.entries.push({ path: name, sha, mode: mode.toString(8), stage, size, mtime, offset: start });
    }
  } catch (e) { out.error = String(e.message); }
  return out;
}

function diffPreview(txt) {
  if (!txt) return [];
  return txt.split('\n')
    .filter(l => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')))
    .slice(0, 10)
    .map(l => ({ t: l[0], s: l.slice(1, 42) }));
}

function readStatus(worktree) {
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
    const abs = path.join(worktree, it.path);
    try {
      const st = fs.statSync(abs);
      it.size = st.size;
      if (st.isFile()) {
        const head = fs.readFileSync(abs);
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

function buildState(repoPath, max) {
  const { gitDir, commonDir, worktree } = findRepo(repoPath);
  const objectsDir = path.join(commonDir, 'objects');
  const objs = new Map(); // sha -> rec {sha,type,size,body,prov,...}
  let looseCount = 0, packedCount = 0;

  // loose objects
  try {
    for (const sub of fs.readdirSync(objectsDir)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      const sd = path.join(objectsDir, sub);
      for (const f of fs.readdirSync(sd)) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        const sha = sub + f;
        const fp = path.join(sd, f);
        try {
          const d = readLooseFile(fp);
          looseCount++;
          objs.set(sha, {
            sha, type: d.type, size: d.size, body: d.body,
            prov: { kind: 'loose', path: path.join(sub, f), fileSize: fs.statSync(fp).size },
          });
        } catch (e) {}
      }
    }
  } catch (e) {}

  // packs
  const packs = [];
  const packDir = path.join(objectsDir, 'pack');
  try {
    for (const f of fs.readdirSync(packDir)) {
      if (!f.endsWith('.idx')) continue;
      try {
        const p = readPack(path.join(packDir, f));
        packs.push({ file: p.packFile, count: p.count, size: p.packSize });
        for (const [sha, o] of p.objects) {
          packedCount++;
          if (!objs.has(sha)) objs.set(sha, { sha, type: o.type, size: o.size, body: o.body, prov: o.prov });
        }
      } catch (e) {}
    }
  } catch (e) {}

  const refs = readRefs(gitDir, commonDir);
  const head = readHead(gitDir);
  const index = readIndex(gitDir);
  const status = readStatus(worktree);

  // reachability
  const reachable = new Set();
  const stack = [];
  for (const r of refs) if (r.sha) stack.push(r.sha);
  if (head.type === 'detached' && head.sha) stack.push(head.sha);
  for (const e of index.entries) stack.push(e.sha);
  while (stack.length) {
    const sha = stack.pop();
    if (reachable.has(sha)) continue;
    const o = objs.get(sha);
    if (!o) continue;
    reachable.add(sha);
    if (o.type === 'commit') {
      const c = o._c || (o._c = parseCommit(o.body));
      if (c.tree) stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (o.type === 'tree') {
      const t = o._t || (o._t = parseTree(o.body));
      for (const e of t) stack.push(e.sha);
    } else if (o.type === 'tag') {
      const g = o._g || (o._g = parseTag(o.body));
      if (g.object) stack.push(g.object);
    }
  }

  // emit objects, newest commits first, then trees, blobs, tags
  let list = [...objs.values()];
  const commits = [], trees = [], blobs = [], tags = [];
  for (const o of list) {
    if (o.type === 'commit') { o.data = o._c || (o._c = parseCommit(o.body)); commits.push(o); }
    else if (o.type === 'tree') {
      const t = o._t || (o._t = parseTree(o.body));
      o.data = { entries: t.slice(0, 40), total: t.length };
      trees.push(o);
    } else if (o.type === 'blob') { o.data = { preview: blobPreview(o.body) }; blobs.push(o); }
    else if (o.type === 'tag') { o.data = o._g || (o._g = parseTag(o.body)); tags.push(o); }
  }
  commits.sort((a, b) => (b.data.committer ? b.data.committer.ts : 0) - (a.data.committer ? a.data.committer.ts : 0));

  const total = commits.length + trees.length + blobs.length + tags.length;
  let truncated = false;
  let ordered = [...commits, ...trees, ...blobs, ...tags];
  if (ordered.length > max) { ordered = ordered.slice(0, max); truncated = true; }

  const outObjects = ordered.map(o => ({
    sha: o.sha, type: o.type, size: o.size,
    reachable: reachable.has(o.sha),
    prov: { kind: o.prov.kind, path: o.prov.path, fileSize: o.prov.fileSize,
            pack: o.prov.pack, offset: o.prov.offset, entryType: o.prov.entryType,
            delta: o.prov.delta },
    data: o.data,
  }));

  return {
    repoPath: worktree, gitDir,
    head, refs, packs,
    index: { ...index, entries: index.entries.slice(0, 300) },
    indexTotal: index.entries.length,
    status: status.slice(0, 60),
    statusTotal: status.length,
    objects: outObjects,
    counts: {
      commits: commits.length, trees: trees.length, blobs: blobs.length, tags: tags.length,
      loose: looseCount, packed: packedCount,
      unreachable: outObjects.filter(o => !o.reachable).length,
      shown: outObjects.length, total, truncated,
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
  const { gitDir, commonDir, worktree } = findRepo(repoPath);
  const objectsDir = path.join(commonDir, 'objects');
  // loose?
  const lp = path.join(objectsDir, sha.slice(0, 2), sha.slice(2));
  if (fs.existsSync(lp)) {
    const d = readLooseFile(lp);
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
  for (const f of fs.readdirSync(packDir)) {
    if (!f.endsWith('.idx')) continue;
    const p = readPack(path.join(packDir, f));
    const o = p.objects.get(sha);
    if (!o) continue;
    const buf = p._packBuf;
    const entryBytes = buf.slice(o.offset, Math.min(o.dataEnd, o.offset + 128));
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
  const { gitDir, commonDir } = findRepo(repoPath);
  const loose = path.join(gitDir, name);
  const packed = path.join(commonDir, 'packed-refs');
  if (fs.existsSync(loose)) {
    const buf = fs.readFileSync(loose);
    return { title: name, steps: [
      { k: 'file', path: '.git/' + name },
      { k: 'hex', title: 'file content', ...hex(buf, 64) },
      { k: 'text', text: buf.toString('utf8').trim() },
    ] };
  }
  try {
    const buf = fs.readFileSync(packed);
    const line = buf.toString('utf8').split('\n').find(l => l.slice(41).trim() === name);
    const off = line ? buf.indexOf(line) : 0;
    return { title: name, steps: [
      { k: 'file', path: '.git/packed-refs', note: 'shared ref file' },
      { k: 'hex', title: 'line @' + off, ...hex(Buffer.from(line || ''), 64) },
      { k: 'text', text: line || '' },
    ] };
  } catch (e) { return { title: name, error: String(e) }; }
}

function headDetail(repoPath) {
  const { gitDir } = findRepo(repoPath);
  const buf = fs.readFileSync(path.join(gitDir, 'HEAD'));
  return { title: 'HEAD', steps: [
    { k: 'file', path: '.git/HEAD' },
    { k: 'hex', title: 'file content', ...hex(buf, 64) },
    { k: 'text', text: buf.toString('utf8').trim() },
  ] };
}

function indexDetail(repoPath, entryPath) {
  const { gitDir } = findRepo(repoPath);
  const idx = readIndex(gitDir);
  const e = idx.entries.find(x => x.path === entryPath);
  const f = path.join(gitDir, 'index');
  const buf = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0);
  if (!e) return { title: 'index', steps: [{ k: 'file', path: '.git/index' }] };
  const raw = buf.slice(e.offset, e.offset + 80);
  return { title: entryPath, steps: [
    { k: 'file', path: '.git/index', note: 'entry @' + e.offset + ' · DIRC v' + idx.version },
    { k: 'hex', title: 'entry bytes', ...hex(raw, 80, [{ s: 40, e: 60, c: 'sha' }, { s: 62, e: 62 + Math.min(e.path.length, 18), c: 'name' }]) },
    { k: 'parsed', fields: [
      { k: 'path', v: e.path }, { k: 'mode', v: e.mode },
      { k: 'sha', v: e.sha, sha: e.sha }, { k: 'stage', v: String(e.stage) },
      { k: 'size', v: e.size + ' bytes' },
      { k: 'mtime', v: new Date(e.mtime * 1000).toLocaleString() },
    ] },
  ] };
}

function workdirDetail(repoPath, filePath) {
  const { worktree } = findRepo(repoPath);
  const abs = path.join(worktree, filePath);
  const steps = [{ k: 'file', path: filePath }];
  try {
    const st = fs.statSync(abs);
    steps[0].note = st.size + ' bytes · mtime ' + new Date(st.mtimeMs).toLocaleString();
    const buf = fs.readFileSync(abs);
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
  const ps = new Map(prev.status.map(s => [s.path, s.x + s.y + (s.size || 0)]));
  const ns = new Map(next.status.map(s => [s.path, s.x + s.y + (s.size || 0)]));
  for (const [k, v] of ns) {
    if (!ps.has(k)) c.statusAdded.push(k);
    else if (ps.get(k) !== v) c.statusChanged.push(k);
  }
  for (const k of ps.keys()) if (!ns.has(k)) c.statusRemoved.push(k);
  return c;
}

module.exports = { buildState, findRepo, diffState, objectDetail, refDetail, headDetail, indexDetail, workdirDetail };
