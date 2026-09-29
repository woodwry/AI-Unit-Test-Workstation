import assert from 'node:assert/strict';
import test from 'node:test';

import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('same-module work is FIFO while different modules overlap', async () => {
  const lock = new ModuleOperationLock();
  const timeline = [];
  const owner = deferred();
  const otherModule = deferred();
  assert.equal(lock.isLocked('module-a'), false);
  const first = lock.runExclusive('module-a', async () => {
    timeline.push('a1:start');
    await owner.promise;
    timeline.push('a1:end');
  });
  const second = lock.runExclusive('module-a', async () => {
    timeline.push('a2:start');
    timeline.push('a2:end');
  });
  const overlapping = lock.runExclusive('module-b', async () => {
    timeline.push('b1:start');
    await otherModule.promise;
    timeline.push('b1:end');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lock.isLocked('module-a'), true);
  assert.equal(lock.isLocked('module-b'), true);
  assert.equal(lock.isLocked('module-c'), false);
  assert.deepEqual(timeline, ['a1:start', 'b1:start']);
  owner.resolve();
  otherModule.resolve();
  await Promise.all([first, second, overlapping]);
  assert.equal(lock.isLocked('module-a'), false);
  assert.equal(lock.isLocked('module-b'), false);
  assert.ok(timeline.indexOf('a1:end') < timeline.indexOf('a2:start'));
  assert.ok(timeline.indexOf('b1:start') < timeline.indexOf('a1:end'));
});

test('aborting a queued operation never lets a later operation bypass the active owner', async () => {
  const lock = new ModuleOperationLock();
  const timeline = [];
  const owner = deferred();
  const controller = new AbortController();
  const first = lock.runExclusive('module-a', async () => {
    timeline.push('a1:start');
    await owner.promise;
    timeline.push('a1:end');
  });
  const cancelled = lock.runExclusive('module-a', async () => {
    timeline.push('cancelled:start');
  }, controller.signal);
  const third = lock.runExclusive('module-a', async () => {
    timeline.push('a3:start');
  });

  controller.abort();
  await assert.rejects(cancelled, /取消/);
  assert.deepEqual(timeline, ['a1:start']);
  owner.resolve();
  await Promise.all([first, third]);
  assert.ok(timeline.indexOf('a1:end') < timeline.indexOf('a3:start'));
  assert.equal(timeline.includes('cancelled:start'), false);
});

test('queued same-module work reports wait boundaries before it owns the module', async () => {
  const lock = new ModuleOperationLock();
  const timeline = [];
  const owner = deferred();
  const first = lock.runExclusive('module-a', async () => {
    timeline.push('a1:start');
    await owner.promise;
    timeline.push('a1:end');
  });
  const second = lock.runExclusive(
    'module-a',
    async () => {
      timeline.push('a2:start');
    },
    undefined,
    {
      async onWaitStart() {
        timeline.push('a2:wait-start');
      },
      async onWaitEnd() {
        timeline.push('a2:wait-end');
      }
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeline.includes('a2:wait-start'), true);
  assert.equal(timeline.includes('a2:start'), false);
  owner.resolve();
  await Promise.all([first, second]);
  assert.ok(timeline.indexOf('a2:wait-start') < timeline.indexOf('a1:end'));
  assert.ok(timeline.indexOf('a1:end') < timeline.indexOf('a2:wait-end'));
  assert.ok(timeline.indexOf('a2:wait-end') < timeline.indexOf('a2:start'));
});
