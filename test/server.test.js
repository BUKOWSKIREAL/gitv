'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { start } = require('../src/server');
const { createRepoWorker } = require('../src/worker-client');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await pause(10);
  }
}
function fixture(t, autoCleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-server-'));
  const dir = path.join(root, 'repo');
  cp.execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = args => cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  if (autoCleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, git };
}
async function reservePort(port = 0) {
  const s = net.createServer();
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', resolve);
  });
  return s;
}
const stop = s => new Promise(resolve => s.close(resolve));

// Block the real repository worker synchronously until the parent releases it.
// This makes responsiveness deterministic instead of relying on big/slow repos.
function gatedWorker(root, methods) {
  const filename = path.join(root, 'gated-worker.cjs');
  fs.writeFileSync(filename, `
    const {parentPort} = require('node:worker_threads');
    const fs = require('node:fs');
    const path = require('node:path');
    const methods = new Set(${JSON.stringify(methods)});
    parentPort.on('message', ({method}) => {
      if (!methods.delete(method)) return;
      fs.writeFileSync(path.join(${JSON.stringify(root)}, method + '.started'), '1');
      const release = path.join(${JSON.stringify(root)}, method + '.release');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error('gate timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    });
    require(${JSON.stringify(path.resolve(__dirname, '../src/repo-worker.js'))});
  `);
  return () => createRepoWorker(filename);
}

test('static/loading/state routes respond while real worker is blocked in build or detail', async t => {
  const { root, dir } = fixture(t, false);
  const reservation = await reservePort();
  const port = reservation.address().port;
  await stop(reservation);
  const workerFactory = gatedWorker(root, ['build', 'detail']);
  let handle;
  const starting = start({ repoPath: dir, port, max: 20, open: false, workerFactory });
  starting.catch(() => {});
  t.after(async () => {
    for (const m of ['build', 'detail']) fs.writeFileSync(path.join(root, m + '.release'), '1');
    if (!handle) handle = await starting.catch(() => null);
    if (handle) await handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + port;
  await until(() => fs.existsSync(path.join(root, 'build.started')));
  assert.equal((await fetch(url + '/')).status, 200);
  const loading = await fetch(url + '/api/state');
  assert.equal(loading.status, 503);
  assert.equal((await loading.json()).loading, true);
  fs.writeFileSync(path.join(root, 'build.release'), '1');
  handle = await starting;
  let detailResolved = false;
  const detail = fetch(url + '/api/detail?id=HEAD').then(r => { detailResolved = true; return r; });
  await until(() => fs.existsSync(path.join(root, 'detail.started')));
  assert.equal((await fetch(url + '/app.js')).status, 200);
  assert.equal((await fetch(url + '/api/state')).status, 200);
  assert.equal(detailResolved, false, 'detail worker remains blocked while HTTP responds');
  fs.writeFileSync(path.join(root, 'detail.release'), '1');
  assert.equal((await detail).status, 200);
  await handle.close();
  await handle.close(); // cleanup is idempotent
  assert.equal(handle.server.listening, false);
});

test('linked worktree refreshes when refs in commonDir change', async t => {
  const { root, dir, git } = fixture(t);
  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'linked', linked]);
  const h = await start({ repoPath: linked, port: 0, max: 20, open: false });
  t.after(() => h.close());
  git(['branch', 'new-shared-branch']);
  let found = false;
  const deadline = Date.now() + 10000;
  while (!found && Date.now() < deadline) {
    const state = await (await fetch(h.url + '/api/state')).json();
    found = state.refs.some(r => r.name === 'refs/heads/new-shared-branch');
    if (!found) await pause(25);
  }
  assert.equal(found, true);
});

test('server rejects invalid options without starting a worker', async () => {
  const workerFactory = () => { throw new Error('worker must not start'); };
  for (const port of [-1, 65536, 1.5, NaN, '4700'])
    await assert.rejects(start({ port, workerFactory }), /invalid port/);
  for (const max of [0, -1, Infinity, 1.5, '2'])
    await assert.rejects(start({ max, workerFactory }), /invalid max/);
});

test('busy final port rejects instead of retrying beyond 65535', async t => {
  const { dir } = fixture(t);
  let occupied;
  try { occupied = await reservePort(65535); }
  catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  if (occupied) t.after(() => stop(occupied));
  await assert.rejects(start({ repoPath: dir, port: 65535, max: 20, open: false }), e => e.code === 'EADDRINUSE');
});

test('worker queue is bounded and close rejects pending calls', async t => {
  const { root, dir } = fixture(t);
  const w = gatedWorker(root, ['detail'])();
  t.after(() => w.close());
  const jobs = Array.from({ length: 64 }, () => w.call('detail', [dir, 'HEAD']).catch(e => e));
  await assert.rejects(w.call('detail', [dir, 'HEAD']), e => e.statusCode === 503);
  await until(() => fs.existsSync(path.join(root, 'detail.started')));
  await w.close();
  const results = await Promise.all(jobs);
  assert(results.every(e => e instanceof Error && /closed/.test(e.message)));
});

test('worker startup failure and operation timeout reject without hanging', async t => {
  const { root } = fixture(t);
  const missing = createRepoWorker(path.join(root, 'missing-worker.js'));
  await assert.rejects(missing.call('init', ['.']), /Cannot find module/);
  await missing.close();
  const filename = path.join(root, 'silent-worker.cjs');
  fs.writeFileSync(filename, "require('node:worker_threads').parentPort.on('message', () => {});");
  const silent = createRepoWorker(filename, 100);
  await assert.rejects(silent.call('init', ['.']), /timed out/);
  await silent.close();
});
