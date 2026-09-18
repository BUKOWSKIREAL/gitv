#!/usr/bin/env node
'use strict';

const USAGE = `usage: gitv [repo-path] [options]

Visualize a git repository's object graph from its raw files and bytes.

options:
  -p, --port N   port to listen on, integer 0-65535; 0 picks a free port
                 (default 4700; if busy, the next free port is used)
  -m, --max N    maximum objects to display, positive integer (default 8000)
      --no-open  do not open a browser window
      --         stop parsing options (allows paths starting with '-')
  -h, --help     show this help
`;

class UsageError extends Error {}

function intArg(flag, raw, check, what) {
  if (!/^\d+$/.test(raw) || !check(Number(raw)))
    throw new UsageError(`invalid ${flag} value '${raw}': expected ${what}`);
  return Number(raw);
}

const portArg = (flag, raw) =>
  intArg(flag, raw, n => n <= 65535, 'an integer between 0 and 65535');
const maxArg = (flag, raw) =>
  intArg(flag, raw, n => Number.isSafeInteger(n) && n >= 1, 'a positive integer');

// parseArgs(argv) -> { repoPath, port, max, open, help }; throws UsageError.
// Pure and side-effect free so it can be unit-tested.
function parseArgs(argv) {
  const o = { repoPath: '.', port: 4700, max: 8000, open: true, help: false };
  let positional = null, noMoreOpts = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (noMoreOpts || !a.startsWith('-') || a === '-') {
      if (positional !== null)
        throw new UsageError(
          `unexpected extra argument '${a}': only one repo path may be given`);
      positional = a;
      continue;
    }
    if (a === '--') { noMoreOpts = true; continue; }
    if (a === '-h' || a === '--help') { o.help = true; return o; }
    if (a === '--no-open') { o.open = false; continue; }
    const m = a.match(/^(--port|--max|-p|-m)(?:=(.*))?$/);
    if (!m) throw new UsageError(`unknown option '${a}'`);
    const flag = m[1];
    let v = m[2];
    if (v === undefined) {
      if (i + 1 >= argv.length)
        throw new UsageError(`missing value for ${flag}`);
      v = argv[++i];
    }
    if (flag === '--port' || flag === '-p') o.port = portArg(flag, v);
    else o.max = maxArg(flag, v);
  }
  if (positional !== null) o.repoPath = positional;
  return o;
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error('gitv: ' + e.message);
    console.error("try 'gitv --help'");
    process.exit(2);
  }
  if (o.help) { process.stdout.write(USAGE); return; }
  const { start } = require('../src/server');
  // .then() wrapping catches synchronous throws from start() as well as
  // rejections of the promise it returns.
  Promise.resolve()
    .then(() => start(o))
    .catch(e => {
      console.error('gitv: ' + (e && e.message ? e.message : String(e)));
      process.exit(1);
    });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, UsageError, USAGE };
