import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClassTaskCheckpointService } from '../src/main/services/class-task-checkpoint.service.ts';
import { ModulePreloadCacheStore } from '../src/main/services/module-preload-cache.store.ts';
import { ClassTaskRuntimeService } from '../src/main/services/class-task-runtime.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

function runningTask() {
  return {
    id: TASK_ID,
    workspaceRoot: 'D:\\workspace',
    sourceFilePath: 'D:\\workspace\\src\\main\\java\\example\\Task.java',
    qualifiedClassName: 'example.Task',
    moduleKey: 'd:/workspace/pom.xml',
    moduleDisplayPath: 'D:\\workspace',
    state: 'RUNNING', preloadState: 'READY', selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [], methodOrder: [], currentMethodIndex: -1,
    currentAtomicStep: 'MAVEN_TEST', generatedArtifacts: [], coverageBaseline: null,
    coverageCurrent: null, coverageContributions: [], completionAttentionPending: false,
    startedAt: '2026-08-09T00:00:00.000Z', finishedAt: null, lastError: null,
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
}

test('quit aborts work, persists INTERRUPTED, flushes task state, then flushes preload cache', async () => {
  const events = [];
  let current = runningTask();
  const runtime = new ClassTaskRuntimeService({
    registry: {
      async initialize() { return [structuredClone(current)]; },
      async add() { throw new Error('unused'); },
      async remove() {},
      list() { return [structuredClone(current)]; },
      snapshot() { return structuredClone(current); },
      async save(snapshot) {
        assert.equal(events.at(-1), 'abort-tasks');
        assert.equal(snapshot.state, 'INTERRUPTED');
        assert.equal(snapshot.currentAtomicStep, 'IDLE');
        current = structuredClone(snapshot);
        events.push('mark-interrupted');
        return structuredClone(current);
      },
      async saveSelection() { throw new Error('unused'); }
    },
    scheduler: {
      async runTask() { throw new Error('unused'); },
      async requestPause() { throw new Error('unused'); },
      async resumeTask() { throw new Error('unused'); },
      async terminateTask() { throw new Error('unused'); },
      async interruptAll() { return []; },
      async terminateAll() { return { terminatedTaskCount: 1, snapshots: [] }; }
    },
    coordinator: {
      async restore() {}, async prepare() { throw new Error('unused'); }, async finish() {},
      async remove() {}, async getResult() { return null; }, async accept() {}, async revoke() {},
      async retryClassPreload() {}, async stopClassPreload() {},
      async abort() { events.push('abort-tasks'); }
    },
    flushTaskState: async () => events.push('flush-tasks'),
    flushPreloadCache: async () => events.push('flush-cache'),
    clock: () => new Date('2026-08-09T03:00:00.000Z')
  });

  await runtime.beforeQuit();

  assert.deepEqual(events, [
    'abort-tasks', 'mark-interrupted', 'flush-tasks', 'flush-cache'
  ]);
  assert.equal(current.finishedAt, '2026-08-09T03:00:00.000Z');
});

test('beforeQuit is idempotent and never restarts model work', async () => {
  let abortCalls = 0;
  let flushCalls = 0;
  const current = { ...runningTask(), state: 'READY', currentAtomicStep: 'IDLE' };
  const runtime = new ClassTaskRuntimeService({
    registry: {
      async initialize() { return [current]; }, async add() { throw new Error('unused'); },
      async remove() {}, list() { return [current]; }, snapshot() { return current; },
      async save(value) { return value; }, async saveSelection() { throw new Error('unused'); }
    },
    scheduler: {
      async runTask() { throw new Error('model work must not restart'); },
      async requestPause() {}, async resumeTask() {}, async terminateTask() {},
      async interruptAll() { return []; },
      async terminateAll() { return { terminatedTaskCount: 0, snapshots: [] }; }
    },
    coordinator: {
      async restore() {}, async prepare() { throw new Error('model work must not restart'); },
      async finish() {}, async remove() {}, async getResult() { return null; },
      async accept() {}, async revoke() {}, async retryClassPreload() {},
      async stopClassPreload() {}, async abort() { abortCalls += 1; }
    },
    flushTaskState: async () => { flushCalls += 1; },
    flushPreloadCache: async () => { flushCalls += 1; }
  });

  await Promise.all([runtime.beforeQuit(), runtime.beforeQuit()]);

  assert.equal(abortCalls, 1);
  assert.equal(flushCalls, 2);
});

test('beforeQuit still marks and flushes task state when cancellation fails', async () => {
  const events = [];
  let current = runningTask();
  const runtime = new ClassTaskRuntimeService({
    registry: {
      async initialize() { return [structuredClone(current)]; },
      async add() { throw new Error('unused'); },
      async remove() {},
      list() { return [structuredClone(current)]; },
      snapshot() { return structuredClone(current); },
      async save(snapshot) {
        current = structuredClone(snapshot);
        events.push('mark-interrupted');
        return structuredClone(current);
      },
      async saveSelection() { throw new Error('unused'); }
    },
    scheduler: {
      async runTask() { throw new Error('unused'); },
      async requestPause() { throw new Error('unused'); },
      async resumeTask() { throw new Error('unused'); },
      async terminateTask() { throw new Error('unused'); },
      async interruptAll() {
        events.push('interrupt-all');
        throw new Error('scheduler cancellation failed');
      },
      async terminateAll() { throw new Error('unused'); }
    },
    coordinator: {
      async restore() {}, async prepare() { throw new Error('unused'); }, async finish() {},
      async remove() {}, async getResult() { return null; }, async accept() {}, async revoke() {},
      async retryClassPreload() {}, async stopClassPreload() {},
      async abort() {
        events.push('abort-tasks');
        throw new Error('coordinator cancellation failed');
      }
    },
    flushTaskState: async () => events.push('flush-tasks'),
    flushPreloadCache: async () => events.push('flush-cache'),
    clock: () => new Date('2026-08-09T03:00:00.000Z')
  });

  await assert.rejects(runtime.beforeQuit(), AggregateError);

  assert.deepEqual(events, [
    'interrupt-all', 'abort-tasks', 'mark-interrupted', 'flush-tasks', 'flush-cache'
  ]);
  assert.equal(current.state, 'INTERRUPTED');
});

test('checkpoint flush waits for an in-flight public task save', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-flush-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = { ...runningTask(), state: 'READY', currentAtomicStep: 'IDLE' };
  let releaseSave;
  const saveBlocked = new Promise((resolve) => { releaseSave = resolve; });
  let markSaveStarted;
  const saveStarted = new Promise((resolve) => { markSaveStarted = resolve; });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'),
    taskState: {
      snapshot: () => structuredClone(current),
      async save(snapshot) {
        markSaveStarted();
        await saveBlocked;
        current = structuredClone(snapshot);
        return structuredClone(current);
      }
    }
  });
  const transition = checkpoints.transitionState(TASK_ID, 'RUNNING');
  await saveStarted;
  let flushed = false;
  const flushing = checkpoints.flush().then(() => { flushed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed, false);

  releaseSave();
  await Promise.all([transition, flushing]);
  assert.equal(flushed, true);
});

test('module preload cache flush observes a queued durable snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'preload-cache-flush-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new ModulePreloadCacheStore(join(directory, 'preload.json'));
  const snapshot = {
    moduleKey: 'd:/workspace/pom.xml', moduleName: 'workspace', modulePath: 'D:\\workspace',
    state: 'READY', fingerprint: 'a'.repeat(64), executionDataPath: 'D:\\workspace\\target\\jacoco.exec',
    classReportPairs: {}, classPreloadFailures: {}, diagnostic: null,
    updatedAt: '2026-08-09T03:00:00.000Z'
  };

  const writing = cache.set(snapshot);
  await cache.flush();

  assert.deepEqual(await cache.get(snapshot.moduleKey), snapshot);
  await writing;
});
