'use strict';
const { parentPort } = require('node:worker_threads');
const repo = require('./repo');
let previous = null;

parentPort.on('message', ({ id, method, args }) => {
  try {
    let result;
    if (method === 'init') result = repo.findRepo(args[0]);
    else if (method === 'build') {
      const state = repo.buildState(...args);
      result = { state, changes: previous ? repo.diffState(previous, state) : null };
      previous = state;
    } else if (method === 'detail') {
      const [repoPath, key] = args;
      if (!key) throw Object.assign(new Error('missing id'), { statusCode: 400 });
      if (key === 'HEAD') result = repo.headDetail(repoPath);
      else if (key.startsWith('ref:')) result = repo.refDetail(repoPath, key.slice(4));
      else if (key.startsWith('idx:')) result = repo.indexDetail(repoPath, key.slice(4));
      else if (key.startsWith('wd:')) result = repo.workdirDetail(repoPath, key.slice(3));
      else result = repo.objectDetail(repoPath, key);
    } else throw new Error('unknown worker operation');
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: { message: e.message, statusCode: e.statusCode || 500 } });
  }
});
