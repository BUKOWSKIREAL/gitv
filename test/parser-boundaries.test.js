'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const repo = require('../src/repo');

test('malformed tree reports an object error rather than looping', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-bounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cp.execFileSync('git', ['init', '-q', dir]);
  const raw = Buffer.from('tree 30\0' + 'x'.repeat(30));
  const sha = crypto.createHash('sha1').update(raw).digest('hex');
  const folder = path.join(dir, '.git', 'objects', sha.slice(0, 2));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, sha.slice(2)), zlib.deflateSync(raw));
  const state = repo.buildState(dir, 10);
  assert.equal(state.objects.length, 0);
  assert.equal(state.counts.errors, 1);
  assert.match(state.errors[0].error, /malformed tree/);
  assert(state.warnings.length > 0);
});

test('buildState and indexDetail use v4 parser and surface split-index errors', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitv-index-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cp.execFileSync('git', ['init', '-q', dir]);
  const git = args => cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'shared-prefix-one.txt'), 'one');
  fs.writeFileSync(path.join(dir, 'shared-prefix-two.txt'), 'two');
  git(['add', '.']);
  git(['update-index', '--index-version=4']);
  const state = repo.buildState(dir, 20);
  assert.equal(state.index.version, 4);
  assert.equal(state.index.error, undefined);
  assert.equal(state.indexTotal, 2);
  const detail = repo.indexDetail(dir, 'shared-prefix-two.txt');
  assert(detail.steps.some(s => /DIRC v4/.test(s.note || '')));
  assert(detail.steps.some(s => s.fields && s.fields.some(f => f.k === 'path' && f.v === 'shared-prefix-two.txt')));
  git(['update-index', '--split-index']);
  assert.match(repo.buildState(dir, 20).index.error, /split index/);
  assert.match(repo.indexDetail(dir, 'shared-prefix-two.txt').error, /split index/);
});
