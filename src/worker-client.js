'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// A single worker serializes repository reads. Bound queued work and lifetime
// so a slow repository cannot accumulate unlimited pending HTTP requests.
function createRepoWorker(filename = path.join(__dirname, 'repo-worker.js'), timeoutMs = 60000) {
  const worker = new Worker(filename);
  const pending = new Map();
  let nextId = 0, failure = null, closing = null;
  const fail = error => {
    if (!failure) failure = error;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(failure);
    }
    pending.clear();
  };
  worker.on('message', ({ id, result, error }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    if (error) job.reject(Object.assign(new Error(error.message), { statusCode: error.statusCode }));
    else job.resolve(result);
  });
  worker.on('error', fail);
  worker.on('exit', code => fail(new Error('repository worker exited (' + code + ')')));

  const close = () => {
    if (!closing) {
      fail(Object.assign(new Error('repository worker closed'), { statusCode: 503 }));
      closing = worker.terminate();
    }
    return closing;
  };
  const call = (method, args) => {
    if (failure) return Promise.reject(failure);
    if (pending.size >= 64)
      return Promise.reject(Object.assign(new Error('repository worker busy; retry shortly'), { statusCode: 503 }));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        fail(Object.assign(new Error('repository operation timed out'), { statusCode: 503 }));
        void close();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, method, args }); }
      catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  };
  return { call, close };
}

module.exports = { createRepoWorker };
