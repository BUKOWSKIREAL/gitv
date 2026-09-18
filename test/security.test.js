'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const repo = require('../src/repo');
const { start } = require('../src/server');

const PUB = path.join(__dirname, '..', 'public');

function git(dir, args) {
  return cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

// disposable repo in a temp root; `root` also holds a secret file outside the worktree
function mkRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-test-'));
  const dir = path.join(root, 'repo');
  cp.execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'console.log(1)\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir };
}

function is400(e) { return e && e.statusCode === 400; }

async function startServer(t, dir) {
  const h = await start({ repoPath: dir, port: 0, max: 100, open: false });
  t.after(() => h.close());
  return h;
}

/* ---------------- workdirDetail ---------------- */

test('workdirDetail serves a normal file', (t) => {
  const { dir } = mkRepo(t);
  const d = repo.workdirDetail(dir, 'file.txt');
  assert.equal(d.title, 'file.txt');
  const text = d.steps.find(s => s.k === 'text');
  assert.ok(text && text.text.includes('hello'));
});

test('workdirDetail serves files in subdirectories', (t) => {
  const { dir } = mkRepo(t);
  const d = repo.workdirDetail(dir, 'src/a.js');
  assert.ok(d.steps.find(s => s.k === 'text').text.includes('console.log'));
});

test('workdirDetail reports missing files without throwing', (t) => {
  const { dir } = mkRepo(t);
  const d = repo.workdirDetail(dir, 'gone.txt');
  assert.ok(d.steps.some(s => s.k === 'text' && /deleted/.test(s.text)));
});

test('workdirDetail rejects ../ traversal', (t) => {
  const { dir } = mkRepo(t);
  for (const bad of ['../secret.txt', '../../etc/passwd', 'src/../../secret.txt', '..'])
    assert.throws(() => repo.workdirDetail(dir, bad), is400, bad);
});

test('workdirDetail rejects absolute paths and NUL bytes', (t) => {
  const { dir } = mkRepo(t);
  assert.throws(() => repo.workdirDetail(dir, '/etc/passwd'), is400);
  assert.throws(() => repo.workdirDetail(dir, 'file.txt\0.jpg'), is400);
  assert.throws(() => repo.workdirDetail(dir, ''), is400);
});

test('workdirDetail blocks symlink escapes', (t) => {
  const { root, dir } = mkRepo(t);
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'link.txt'));
  fs.symlinkSync(root, path.join(dir, 'dirlink'));
  assert.throws(() => repo.workdirDetail(dir, 'link.txt'), is400);
  assert.throws(() => repo.workdirDetail(dir, 'dirlink/secret.txt'), is400);
});

test('workdirDetail allows symlink to file inside worktree', (t) => {
  const { dir } = mkRepo(t);
  fs.symlinkSync('file.txt', path.join(dir, 'inner-link.txt'));
  const d = repo.workdirDetail(dir, 'inner-link.txt');
  assert.ok(d.steps.find(s => s.k === 'text').text.includes('hello'));
});

test('workdirDetail rejects .git metadata, lexical and via symlink', (t) => {
  const { dir } = mkRepo(t);
  assert.throws(() => repo.workdirDetail(dir, '.git/config'), is400);
  assert.throws(() => repo.workdirDetail(dir, '.git'), is400);
  assert.throws(() => repo.workdirDetail(dir, '.git/refs/heads/main'), is400);
  // .gitignore is a normal worktree file, not metadata
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  assert.ok(repo.workdirDetail(dir, '.gitignore').steps.length);
  // symlinks whose realpath lands in the git dir are also metadata
  fs.symlinkSync(path.join(dir, '.git', 'config'), path.join(dir, 'cfglink'));
  fs.symlinkSync(path.join(dir, '.git'), path.join(dir, 'gitlink'));
  assert.throws(() => repo.workdirDetail(dir, 'cfglink'), is400);
  assert.throws(() => repo.workdirDetail(dir, 'gitlink/config'), is400);
  assert.throws(() => repo.workdirDetail(dir, 'gitlink'), is400);
});

test('workdirDetail allows a file named ..notes', (t) => {
  const { dir } = mkRepo(t);
  fs.writeFileSync(path.join(dir, '..notes'), 'dotdot file\n');
  const d = repo.workdirDetail(dir, '..notes');
  assert.ok(d.steps.find(s => s.k === 'text').text.includes('dotdot'));
});

test('buildState status preview does not follow symlinks or read metadata', (t) => {
  const { root, dir } = mkRepo(t);
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'leak.txt'));
  fs.symlinkSync(path.join(dir, '.git', 'config'), path.join(dir, 'meta.txt'));
  const state = repo.buildState(dir, 100);
  const leak = state.status.find(s => s.path === 'leak.txt');
  const meta = state.status.find(s => s.path === 'meta.txt');
  assert.ok(leak && meta, 'symlinks reported as untracked');
  assert.ok(!JSON.stringify(state.status).includes('TOP SECRET'));
  assert.ok(!JSON.stringify(state.status).includes('test@example.com'));
  assert.equal(leak.lines, undefined);
  assert.equal(meta.lines, undefined);
});

/* ---------------- refDetail ---------------- */

test('refDetail serves a normal branch ref', (t) => {
  const { dir } = mkRepo(t);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  const d = repo.refDetail(dir, 'refs/heads/main');
  assert.equal(d.title, 'refs/heads/main');
  assert.equal(d.steps.find(s => s.k === 'text').text, sha);
});

test('refDetail rejects anything but git-valid refs/... names', (t) => {
  const { dir } = mkRepo(t);
  const bad = [
    'HEAD', 'config', 'objects/pack/x', '../config', 'refs/../../config',
    'refs//heads', 'refs/heads/..x', 'refs/', 'refs', 'refs/heads/x.',
    'refs/heads/x.lock', 'refs/@{y}', 'refs/heads/@', 'refs/heads/a b',
    'refs/heads/~x', 'refs/heads/a:b', 'refs/heads/.hidden',
  ];
  for (const b of bad) assert.throws(() => repo.refDetail(dir, b), is400, b);
});

test('refDetail accepts unicode and unusual but valid ref names', (t) => {
  const { dir } = mkRepo(t);
  // created through git, which runs check-ref-format itself
  git(dir, ['branch', 'üñí-日本語']);
  git(dir, ['branch', '%2e%2e']);
  const sha = git(dir, ['rev-parse', 'üñí-日本語']).trim();
  const d = repo.refDetail(dir, 'refs/heads/üñí-日本語');
  assert.equal(d.steps.find(s => s.k === 'text').text, sha);
  // %-encoding is never decoded, so this is just an ordinary ref file
  const d2 = repo.refDetail(dir, 'refs/heads/%2e%2e');
  assert.equal(d2.steps.find(s => s.k === 'text').text, sha);
  assert.ok(repo.isValidRefName('refs/heads/üñí-日本語'));
  assert.ok(!repo.isValidRefName('refs/heads/trailing.'));
});

test('refDetail refuses ref files that resolve outside refs/', (t) => {
  const { dir } = mkRepo(t);
  // symlink inside refs/ pointing at .git/config must not leak config
  const evil = path.join(dir, '.git', 'refs', 'heads', 'evil');
  fs.symlinkSync(path.join('..', '..', 'config'), evil);
  assert.throws(() => repo.refDetail(dir, 'refs/heads/evil'), is400);
  // a symlink to another real ref is fine
  const alias = path.join(dir, '.git', 'refs', 'heads', 'alias');
  fs.symlinkSync('main', alias);
  const sha = git(dir, ['rev-parse', 'main']).trim();
  const d = repo.refDetail(dir, 'refs/heads/alias');
  assert.equal(d.steps.find(s => s.k === 'text').text, sha);
});

test('refDetail falls back to packed-refs in commonDir', (t) => {
  const { dir } = mkRepo(t);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['pack-refs', '--all']);
  const d = repo.refDetail(dir, 'refs/heads/main');
  assert.ok(d.steps.some(s => s.path === '.git/packed-refs'));
  assert.equal(d.steps.find(s => s.k === 'text').text.slice(0, 40), sha);
});

test('refDetail resolves shared refs from a linked worktree', (t) => {
  const { dir, root } = mkRepo(t);
  const wt = path.join(root, 'wt');
  git(dir, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  // in the linked worktree, loose branch refs live in the shared commonDir
  const sha = git(dir, ['rev-parse', 'main']).trim();
  const d = repo.refDetail(wt, 'refs/heads/main');
  assert.equal(d.steps.find(s => s.k === 'text').text, sha);
  const d2 = repo.refDetail(wt, 'refs/heads/feature');
  assert.equal(d2.steps.find(s => s.k === 'text').text, git(dir, ['rev-parse', 'feature']).trim());
});

test('refDetail reports missing refs without throwing', (t) => {
  const { dir } = mkRepo(t);
  const d = repo.refDetail(dir, 'refs/heads/nope');
  assert.equal(d.error, 'ref not found');
});

/* ---------------- objectDetail ---------------- */

test('objectDetail serves a real object', (t) => {
  const { dir } = mkRepo(t);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  const d = repo.objectDetail(dir, sha);
  assert.equal(d.sha, sha);
  assert.equal(d.type, 'commit');
});

test('objectDetail rejects non-40-hex ids', (t) => {
  const { dir } = mkRepo(t);
  const bad = ['', 'abc', 'HEAD', 'a'.repeat(39), 'a'.repeat(41),
    'g'.repeat(40), '../..'.padEnd(40, '.'), 'A'.repeat(40)];
  for (const b of bad) assert.throws(() => repo.objectDetail(dir, b), is400, JSON.stringify(b));
});

test('objectDetail reports missing objects', (t) => {
  const { dir } = mkRepo(t);
  const d = repo.objectDetail(dir, '0'.repeat(40));
  assert.equal(d.error, 'not found');
});

/* ---------------- diffState ---------------- */

test('diffState detects equal-size content changes (alpha -> omega)', (t) => {
  const { dir } = mkRepo(t);
  fs.writeFileSync(path.join(dir, 'sig.txt'), 'alpha\n');
  git(dir, ['add', 'sig.txt']);
  const s1 = repo.buildState(dir, 100);
  fs.writeFileSync(path.join(dir, 'sig.txt'), 'omega\n'); // identical size
  const s2 = repo.buildState(dir, 100);
  const c = repo.diffState(s1, s2);
  assert.ok(c.statusChanged.includes('sig.txt'));
  // sanity: unchanged rebuild produces no change
  const c2 = repo.diffState(s2, repo.buildState(dir, 100));
  assert.ok(!c2.statusChanged.includes('sig.txt'));
});

/* ---------------- server ---------------- */

test('server binds to 127.0.0.1 only', async (t) => {
  const { dir } = mkRepo(t);
  const h = await startServer(t, dir);
  assert.equal(h.server.address().address, '127.0.0.1');
});

test('server returns 4xx for invalid detail ids', async (t) => {
  const { dir } = mkRepo(t);
  const h = await startServer(t, dir);
  const get = id => fetch(h.url + '/api/detail?id=' + encodeURIComponent(id));
  for (const id of ['wd:../secret.txt', 'wd:/etc/passwd', 'ref:../config', 'ref:HEAD',
                    'ref:refs/../../config', 'notasha', 'a'.repeat(39)]) {
    const r = await get(id);
    assert.equal(r.status, 400, id);
    const body = await r.json();
    assert.ok(body.error, id);
  }
  const r = await fetch(h.url + '/api/detail'); // missing id
  assert.equal(r.status, 400);
});

test('server still serves normal details', async (t) => {
  const { dir } = mkRepo(t);
  const h = await startServer(t, dir);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  for (const id of ['HEAD', 'ref:refs/heads/main', 'wd:file.txt', 'idx:file.txt', sha]) {
    const r = await fetch(h.url + '/api/detail?id=' + encodeURIComponent(id));
    assert.equal(r.status, 200, id);
    const d = await r.json();
    assert.ok(d.steps && d.steps.length, id);
  }
  // unknown object: explicit 4xx with JSON error
  const r = await fetch(h.url + '/api/detail?id=' + '0'.repeat(40));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not found');
});

test('server serves static files safely', async (t) => {
  const { dir } = mkRepo(t);
  const h = await startServer(t, dir);
  // a symlink inside public/ pointing outside, and a directory
  const subdir = fs.mkdtempSync(path.join(PUB, '.sec-test-'));
  const link = path.join(subdir, 'outside');
  const route = '/' + path.basename(subdir);
  fs.symlinkSync(path.join(path.dirname(dir), 'secret.txt'), link);
  t.after(() => fs.rmSync(subdir, { recursive: true, force: true }));

  let r = await fetch(h.url + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);

  r = await fetch(h.url + '/app.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);

  // traversal attempts, plain and percent-encoded, cannot escape public/
  for (const p of ['/../package.json', '/%2e%2e/%2e%2e/package.json',
                   '/%2e%2e%2f%2e%2e%2fpackage.json', '/..%5c..%5cpackage.json']) {
    r = await fetch(h.url + p);
    assert.equal(r.status, 404, p);
  }

  r = await fetch(h.url + '/nope.js');
  assert.equal(r.status, 404);

  // symlink pointing outside public/ is refused
  r = await fetch(h.url + route + '/outside');
  assert.equal(r.status, 404);

  // directory request yields 404, not a crash
  r = await fetch(h.url + route);
  assert.equal(r.status, 404);

  // malformed percent-encoding and NUL bytes are bad requests
  r = await fetch(h.url + '/%');
  assert.equal(r.status, 400);
  r = await fetch(h.url + '/%00');
  assert.equal(r.status, 400);

  // still alive after all of the above
  r = await fetch(h.url + '/api/state');
  assert.equal(r.status, 200);
  assert.ok((await r.json()).counts);
});
