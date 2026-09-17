#!/usr/bin/env node
'use strict';
const { start } = require('../src/server');

const args = process.argv.slice(2);
let repoPath = '.', port = 4700, max = 8000, open = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' || a === '-p') port = +args[++i];
  else if (a === '--max' || a === '-m') max = +args[++i];
  else if (a === '--no-open') open = false;
  else if (a === '--help' || a === '-h') {
    console.log('usage: gitv [repo-path] [--port N] [--max N] [--no-open]');
    process.exit(0);
  } else repoPath = a;
}

start({ repoPath, port, max, open });
