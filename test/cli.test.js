'use strict';
/* CLI tests: unit coverage for parseArgs (pure, no server started) plus
 * integration tests that spawn the real bin/gitv.js and check exit codes,
 * stderr, and a live end-to-end server run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, UsageError } = require('../bin/gitv');

const BIN = path.join(__dirname, '..', 'bin', 'gitv.js');
const run = (args, opts) =>
  cp.spawnSync(process.execPath, [BIN, ...args],
    { encoding: 'utf8', timeout: 20000, ...opts });

const isUsageError = e => e instanceof UsageError;

// disposable repo for the end-to-end test
function mkRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-cli-test-'));
  const dir = path.join(root, 'repo');
  const git = a => cp.execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  cp.execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dir;
}

/* ---------------- parseArgs: valid input ---------------- */

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([]),
    { repoPath: '.', port: 4700, max: 8000, open: true, help: false });
});

test('parseArgs: repo path and all options', () => {
  assert.deepEqual(parseArgs(['/some/repo', '-p', '8080', '-m', '500', '--no-open']),
    { repoPath: '/some/repo', port: 8080, max: 500, open: false, help: false });
  assert.equal(parseArgs(['--port', '0']).port, 0);
  assert.equal(parseArgs(['--port=65535']).port, 65535);
  assert.equal(parseArgs(['--max=1']).max, 1);
  assert.equal(parseArgs(['--max', '999999']).max, 999999);
});

test('parseArgs: --help and -h short-circuit', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--port', '1', '--help', 'junk']).help, true);
});

test('parseArgs: -- ends option parsing', () => {
  const o = parseArgs(['--', '-strange-path']);
  assert.equal(o.repoPath, '-strange-path');
  assert.equal(parseArgs(['-']).repoPath, '-'); // bare '-' is a path, not an option
});

/* ---------------- parseArgs: rejected input ---------------- */

test('parseArgs: missing option values', () => {
  for (const args of [['--port'], ['-p'], ['--max'], ['-m'], ['repo', '--port']])
    assert.throws(() => parseArgs(args), /missing value/, args.join(' '));
});

test('parseArgs: invalid ports', () => {
  for (const v of ['abc', '-1', '3.5', '65536', '99999999', '', '0x10', '1e3'])
    assert.throws(() => parseArgs(['--port', v]),
      /an integer between 0 and 65535/, `--port ${v}`);
  assert.throws(() => parseArgs(['--port=abc']), UsageError);
});

test('parseArgs: invalid max', () => {
  for (const v of ['0', '-5', 'abc', '2.5', '', '9'.repeat(40)])
    assert.throws(() => parseArgs(['--max', v]),
      /a positive integer/, `--max ${v}`);
});

test('parseArgs: unknown options', () => {
  for (const a of ['--bogus', '-x', '--port2', '--noopen', '--no-open=x'])
    assert.throws(() => parseArgs([a]), /unknown option/, a);
});

test('parseArgs: multiple repo paths rejected', () => {
  assert.throws(() => parseArgs(['a', 'b']), /only one repo path/);
  assert.throws(() => parseArgs(['a', '--port', '1', 'b']), isUsageError);
});

/* ---------------- spawned CLI ---------------- */

test('cli --help prints usage and exits 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.status, 0, flag);
    assert.match(r.stdout, /usage: gitv/);
    assert.equal(r.stderr, '');
  }
});

test('cli usage errors exit 2 with a stderr message', () => {
  const cases = [
    [['--bogus'], /unknown option '--bogus'/],
    [['--port'], /missing value for --port/],
    [['--port', 'abc'], /invalid --port value 'abc'/],
    [['--port', '65536'], /65535/],
    [['--max', '0'], /invalid --max value '0'/],
    [['one', 'two'], /only one repo path/],
  ];
  for (const [args, re] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
    assert.match(r.stderr, /--help/, 'hints at --help: ' + args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('cli non-repo path exits 1', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-notrepo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = run([dir, '--no-open']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git repository/);
});

test('cli end-to-end: serves a repo on an ephemeral port', async (t) => {
  const dir = mkRepo(t);
  const child = cp.spawn(process.execPath,
    [BIN, dir, '--port', '0', '--no-open'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));

  const url = await new Promise((ok, no) => {
    let out = '';
    const timer = setTimeout(() =>
      no(new Error('timed out waiting for url; stdout: ' + out)), 20000);
    child.stdout.on('data', d => {
      out += d;
      const m = out.match(/gitv: (http:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    child.on('error', no);
    child.on('exit', code =>
      no(new Error(`gitv exited early (code ${code}); stdout: ${out}`)));
  });

  const r = await fetch(url + '/api/state');
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.ok(st.counts && st.objects.length > 0, 'state lists objects');
  assert.ok(st.refs.some(x => x.name === 'refs/heads/main'), 'branch listed');
});
