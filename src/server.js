'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createRepoWorker } = require('./worker-client');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PUB = path.join(__dirname, '..', 'public');
const PUB_REAL = fs.realpathSync(PUB);
const HOST = '127.0.0.1';

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

async function start({ repoPath = '.', port = 4700, max = 8000, open = true, workerFactory = createRepoWorker } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port: expected integer 0-65535');
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('invalid max: expected positive integer');
  repoPath = path.resolve(repoPath);
  const worker = workerFactory();
  let info;
  try { info = await worker.call('init', [repoPath]); }
  catch (e) {
    await worker.close();
    throw new Error('not a git repository: ' + repoPath, { cause: e });
  }
  const { gitDir, commonDir, worktree } = info;
  console.log('gitv: ' + worktree);

  let state = null, stateJSON = null, closed = false, closing = null;
  let timer = null, building = false, again = false;
  const clients = new Set(), watchers = [];
  const writeEvent = (res, payload) => {
    if (res.destroyed) return;
    if (res.writableLength > 8 * 1024 * 1024) { res.destroy(); return; }
    res.write(payload);
  };
  const send = (res, obj) => writeEvent(res, 'data: ' + JSON.stringify(obj) + '\n\n');
  const broadcast = obj => {
    const payload = 'data: ' + JSON.stringify(obj) + '\n\n';
    for (const res of clients) writeEvent(res, payload);
  };
  const json = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://x'); }
    catch { res.writeHead(400); res.end('bad request'); return; }
    const p = u.pathname;
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('\n');
      clients.add(res);
      send(res, state ? { type: 'state', changes: null, state } : { type: 'loading' });
      res.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state') {
      if (!state) { json(res, 503, { loading: true, error: 'Repository is loading' }); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(stateJSON);
      return;
    }
    if (p === '/api/detail') {
      try {
        const d = await worker.call('detail', [repoPath, u.searchParams.get('id')]);
        json(res, d && d.error && !d.steps ? 404 : 200, d);
      } catch (e) { json(res, e.statusCode || 500, { error: e.message }); }
      return;
    }
    let rel;
    try { rel = decodeURIComponent(p); }
    catch { res.writeHead(400); res.end('bad request'); return; }
    if (rel.includes('\0')) { res.writeHead(400); res.end('bad request'); return; }
    const fp = path.resolve(PUB, '.' + (rel === '/' ? '/index.html' : rel));
    try {
      if (!isInside(PUB, fp) || !isInside(PUB_REAL, fs.realpathSync(fp)) || !fs.statSync(fp).isFile())
        throw new Error('not a public file');
    } catch { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    const stream = fs.createReadStream(fp);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  const close = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const res of clients) res.destroy();
    clients.clear();
    closing = (async () => {
      const stopHTTP = new Promise(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([stopHTTP, worker.close()]);
    })();
    return closing;
  };

  const rebuild = async () => {
    if (closed) return;
    if (building) { again = true; return; }
    building = true;
    try {
      const next = await worker.call('build', [repoPath, max]);
      if (closed) return;
      state = next.state;
      stateJSON = JSON.stringify(state);
      broadcast({ type: 'state', changes: next.changes, state });
    } catch (e) {
      if (!closed) broadcast({ type: 'error', message: e.message });
      if (!state) throw e;
    } finally {
      building = false;
      if (again && !closed) {
        again = false;
        clearTimeout(timer);
        timer = setTimeout(() => { void rebuild().catch(() => {}); }, 60);
      }
    }
  };
  const onChange = () => {
    if (closed) return;
    if (building) { again = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => { void rebuild().catch(() => {}); }, 250);
  };
  const watch = (target, opts, cb) => {
    try { watchers.push(fs.watch(target, opts, cb)); return true; }
    catch { return false; }
  };
  const listen = p => new Promise((resolve, reject) => {
    const onError = e => { server.off('listening', onListen); reject(e); };
    const onListen = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(p, HOST);
  });

  try {
    let p = port;
    for (;;) {
      try { p = await listen(p); break; }
      catch (e) {
        if (e.code !== 'EADDRINUSE' || p === 0 || p >= 65535) throw e;
        p++;
      }
    }
    for (const dir of new Set([gitDir, commonDir])) {
      if (!watch(dir, { recursive: true }, onChange)) {
        watch(dir, {}, onChange);
        watch(path.join(dir, 'refs'), { recursive: true }, onChange);
        watch(path.join(dir, 'objects'), { recursive: true }, onChange);
      }
    }
    watch(worktree, { recursive: true }, (ev, f) => {
      if (!f) return;
      const parts = String(f).split(path.sep);
      if (parts[0] === '.git' || parts.includes('node_modules')) return;
      onChange();
    });
    // HTTP is already listening; static routes and a loading state remain
    // responsive even before the first expensive build completes.
    await rebuild();
    const url = 'http://' + HOST + ':' + p;
    console.log('gitv: ' + url + '  (' + state.counts.shown + ' objects, watching .git)');
    if (open) {
      if (process.platform === 'darwin') execFile('open', [url], () => {});
      else if (process.platform === 'linux') execFile('xdg-open', [url], () => {});
    }
    return { server, port: p, url, close };
  } catch (e) { await close(); throw e; }
}

module.exports = { start };
