import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MonacoEditorLifecycle } from '../src/renderer/src/monaco-editor-lifecycle.ts';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createFixture(initializations, overrides = {}) {
  const pendingInitializations = [...initializations];
  const observations = {
    initializationCount: 0,
    attachCount: 0,
    detachCount: 0,
    errors: [],
  };

  const lifecycle = new MonacoEditorLifecycle({
    initializeCoreRuntime() {
      observations.initializationCount += 1;
      if (overrides.initializeCoreRuntime) {
        return overrides.initializeCoreRuntime();
      }
      const initialization = pendingInitializations.shift();
      if (!initialization) {
        throw new Error('missing initialization gate');
      }
      return initialization.promise;
    },
    attach() {
      observations.attachCount += 1;
      overrides.attach?.();
    },
    detach() {
      observations.detachCount += 1;
      overrides.detach?.();
    },
    onError(error) {
      observations.errors.push(error);
      overrides.onError?.(error);
    },
  });

  return { lifecycle, observations };
}

test('runtime resolve 前不 attach，resolve 后恰好 attach 一次', async () => {
  const initialization = createDeferred();
  const { lifecycle, observations } = createFixture([initialization]);

  lifecycle.start();
  assert.equal(observations.attachCount, 0);

  initialization.resolve();
  await flushMicrotasks();

  assert.equal(observations.attachCount, 1);
});

test('当前 generation reject 时报告同一个 Error 且不 attach', async () => {
  const initialization = createDeferred();
  const { lifecycle, observations } = createFixture([initialization]);
  const error = new Error('core runtime failed');

  lifecycle.start();
  initialization.reject(error);
  await flushMicrotasks();

  assert.equal(observations.errors.length, 1);
  assert.strictEqual(observations.errors[0], error);
  assert.equal(observations.attachCount, 0);
});

test('initializeCoreRuntime 同步抛错时报告同一对象且不 attach', () => {
  const initializationError = { kind: 'synchronous-initialize-failure' };
  const { lifecycle, observations } = createFixture([], {
    initializeCoreRuntime() {
      throw initializationError;
    },
  });

  lifecycle.start();

  assert.equal(observations.errors.length, 1);
  assert.strictEqual(observations.errors[0], initializationError);
  assert.equal(observations.attachCount, 0);
});

test('resolve 前 cancel 会忽略迟到 resolve，且不执行 cleanup 或报错', async () => {
  const initialization = createDeferred();
  const { lifecycle, observations } = createFixture([initialization]);
  const run = lifecycle.start();

  run.cancel();
  initialization.resolve();
  await flushMicrotasks();

  assert.equal(observations.attachCount, 0);
  assert.equal(observations.detachCount, 0);
  assert.deepEqual(observations.errors, []);
});

test('cancel 后忽略迟到 reject', async () => {
  const initialization = createDeferred();
  const { lifecycle, observations } = createFixture([initialization]);
  const run = lifecycle.start();

  run.cancel();
  initialization.reject(new Error('late failure'));
  await flushMicrotasks();

  assert.deepEqual(observations.errors, []);
});

test('pending runtime resolve 前 dispose 会忽略迟到 resolve 且保持 terminal', async () => {
  const initialization = createDeferred();
  const { lifecycle, observations } = createFixture([initialization]);

  lifecycle.start();
  lifecycle.dispose();
  initialization.resolve();
  await flushMicrotasks();

  assert.equal(observations.attachCount, 0);
  assert.equal(observations.detachCount, 0);
  assert.deepEqual(observations.errors, []);
  assert.throws(() => lifecycle.start(), /disposed/);
});

test('start、cancel、start 只允许第二代 attach，旧 run 不会 detach 新 generation', async () => {
  const firstInitialization = createDeferred();
  const secondInitialization = createDeferred();
  const { lifecycle, observations } = createFixture([
    firstInitialization,
    secondInitialization,
  ]);

  const firstRun = lifecycle.start();
  firstRun.cancel();
  lifecycle.start();

  secondInitialization.resolve();
  await flushMicrotasks();
  assert.equal(observations.attachCount, 1);

  firstInitialization.resolve();
  await flushMicrotasks();
  firstRun.cancel();
  assert.equal(observations.attachCount, 1);
  assert.equal(observations.detachCount, 0);
});

test('未 cancel 就再次 start 时第二代会使第一代失效', async () => {
  const firstInitialization = createDeferred();
  const secondInitialization = createDeferred();
  const { lifecycle, observations } = createFixture([
    firstInitialization,
    secondInitialization,
  ]);

  lifecycle.start();
  lifecycle.start();

  firstInitialization.resolve();
  await flushMicrotasks();
  assert.equal(observations.attachCount, 0);

  secondInitialization.resolve();
  await flushMicrotasks();
  assert.equal(observations.attachCount, 1);
});

test('第二次 start 隔离旧 generation 的 detach 异常并继续初始化新 generation', async () => {
  const firstInitialization = createDeferred();
  const secondInitialization = createDeferred();
  const detachError = { kind: 'previous-detach-failure' };
  const { lifecycle, observations } = createFixture(
    [firstInitialization, secondInitialization],
    {
      detach() {
        throw detachError;
      },
    },
  );

  lifecycle.start();
  firstInitialization.resolve();
  await flushMicrotasks();
  assert.equal(observations.attachCount, 1);

  assert.doesNotThrow(() => lifecycle.start());
  assert.equal(observations.errors.length, 1);
  assert.strictEqual(observations.errors[0], detachError);
  assert.equal(observations.initializationCount, 2);

  secondInitialization.resolve();
  await flushMicrotasks();
  assert.equal(observations.attachCount, 2);
});

test('旧 session detach 重入 start 时外层 generation 不覆盖或初始化最新 generation', async () => {
  const firstInitialization = createDeferred();
  const latestInitialization = createDeferred();
  let lifecycle;
  let reentered = false;
  const fixture = createFixture([firstInitialization, latestInitialization], {
    detach() {
      if (!reentered) {
        reentered = true;
        lifecycle.start();
      }
    },
  });
  lifecycle = fixture.lifecycle;

  lifecycle.start();
  firstInitialization.resolve();
  await flushMicrotasks();
  assert.equal(fixture.observations.attachCount, 1);

  lifecycle.start();
  assert.equal(fixture.observations.initializationCount, 2);

  latestInitialization.resolve();
  await flushMicrotasks();
  assert.equal(fixture.observations.attachCount, 2);
  assert.deepEqual(fixture.observations.errors, []);
});

test('attach 后 dispose 与旧 run cancel 均幂等，dispose 后不能再 start', async () => {
  const initialization = createDeferred();
  const { lifecycle, observations } = createFixture([initialization]);
  const run = lifecycle.start();

  initialization.resolve();
  await flushMicrotasks();
  assert.equal(observations.attachCount, 1);

  lifecycle.dispose();
  lifecycle.dispose();
  run.cancel();

  assert.equal(observations.detachCount, 1);
  assert.throws(() => lifecycle.start(), /disposed/);
});

test('attach 同步抛错时报告同一对象，之后 cancel 最多 detach 一次', async () => {
  const initialization = createDeferred();
  const attachError = { kind: 'attach-failure' };
  const { lifecycle, observations } = createFixture([initialization], {
    attach() {
      throw attachError;
    },
  });
  const run = lifecycle.start();

  initialization.resolve();
  await flushMicrotasks();

  assert.equal(observations.errors.length, 1);
  assert.strictEqual(observations.errors[0], attachError);
  run.cancel();
  run.cancel();
  lifecycle.dispose();
  assert.equal(observations.detachCount, 1);
});

test('当前 run cancel 的 detach 抛错后状态仍锁定且重复 cancel 幂等', async () => {
  const initialization = createDeferred();
  const detachError = { kind: 'current-detach-failure' };
  const { lifecycle, observations } = createFixture([initialization], {
    detach() {
      throw detachError;
    },
  });
  const run = lifecycle.start();

  initialization.resolve();
  await flushMicrotasks();

  let thrown;
  try {
    run.cancel();
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, detachError);
  assert.doesNotThrow(() => run.cancel());
  assert.equal(observations.detachCount, 1);
  assert.deepEqual(observations.errors, []);
});
