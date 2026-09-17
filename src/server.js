'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const repo = require('./repo');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PUB = path.join(__dirname, '..', 'public');

function start({ repoPath, port, max, open }) {
  let info;
  try { info = repo.findRepo(repoPath); }
  catch (e) {
    console.error('not a git repository: ' + path.resolve(repoPath));
    process.exit(1);
  }
  const { gitDir, worktree } = info;
  console.log('gitv: ' + worktree);

  let state = repo.buildState(repoPath, max);
  const clients = new Set();

  const send = (res, obj) => {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };
  const broadcast = obj => { for (const res of clients) send(res, obj); };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('\n');
      clients.add(res);
      send(res, { type: 'state', changes: null, state });
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    if (p === '/api/detail') {
      const id = u.searchParams.get('id') || '';
      let d;
      try {
        if (id === 'HEAD') d = repo.headDetail(repoPath);
        else if (id.startsWith('ref:')) d = repo.refDetail(repoPath, id.slice(4));
        else if (id.startsWith('idx:')) d = repo.indexDetail(repoPath, id.slice(4));
        else if (id.startsWith('wd:')) d = repo.workdirDetail(repoPath, id.slice(3));
        else d = repo.objectDetail(repoPath, id);
      } catch (e) { d = { error: String(e.message) }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(d));
      return;
    }
    const fp = path.join(PUB, p === '/' ? 'index.html' : p);
    if (!fp.startsWith(PUB) || !fs.existsSync(fp)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });

  // ---- watch ----
  let timer = null, building = false, again = false;
  const rebuild = () => {
    if (building) { again = true; return; }
    building = true;
    try {
      const next = repo.buildState(repoPath, max);
      const changes = repo.diffState(state, next);
      state = next;
      broadcast({ type: 'state', changes, state });
    } catch (e) { broadcast({ type: 'error', message: String(e.message) }); }
    building = false;
    if (again) { again = false; setTimeout(rebuild, 60); }
  };
  const onChange = () => { clearTimeout(timer); timer = setTimeout(rebuild, 250); };

  try { fs.watch(gitDir, { recursive: true }, onChange); } catch (e) {
    fs.watch(gitDir, onChange);
    fs.watch(path.join(gitDir, 'refs'), { recursive: true }, onChange);
  }
  try {
    fs.watch(worktree, { recursive: true }, (ev, f) => {
      if (!f) return;
      if (f.startsWith('.git/') || f === '.git' || f.includes('node_modules')) return;
      onChange();
    });
  } catch (e) { /* worktree watch optional */ }

  const tryPort = p => new Promise((ok, no) => {
    server.once('error', e => e.code === 'EADDRINUSE' ? no() : (() => { throw e; })());
    server.listen(p, () => ok(p));
  });
  (async () => {
    let p = port;
    for (;;) {
      try { p = await tryPort(p); break; }
      catch (e) { p++; }
    }
    const url = 'http://localhost:' + p;
    console.log('gitv: ' + url + '  (' + state.counts.shown + ' objects, watching .git)');
    if (open) execFile('open', [url], () => {});
  })();
}

module.exports = { start };
