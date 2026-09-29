import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClassTaskStore } from '../src/main/services/class-task.store.ts';

const IDS = {
  running: '11111111-1111-4111-8111-111111111111',
  preloading: '22222222-2222-4222-8222-222222222222',
  paused: '33333333-3333-4333-8333-333333333333',
  completed: '44444444-4444-4444-8444-444444444444',
  extra: '55555555-5555-4555-8555-555555555555',
  sixth: '66666666-6666-4666-8666-666666666666'
};

function snapshot(id, state = 'READY', overrides = {}) {
  const started = ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING', 'COMPLETED'].includes(state)
    ? '2026-08-09T01:00:00.000Z'
    : null;
  const finished = state === 'COMPLETED' ? '2026-08-09T01:05:00.000Z' : null;
  return {
    id,
    workspaceRoot: 'D:\\work',
    sourceFilePath: `D:\\work\\src\\${id}.java`,
    qualifiedClassName: `example.Task${id[0]}`,
    moduleKey: 'd:/work/pom.xml',
    moduleDisplayPath: 'D:\\work',
    state,
    preloadState: state === 'PRELOADING' ? 'RUNNING' : 'READY',
    ragEnabled: false,
    repairAttemptLimit: null,
    unlimitedRepair: false,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: [],
    methodOrder: [],
    coveredMethodIds: [],
    currentMethodIndex: -1,
    currentAtomicStep: state === 'RUNNING' ? 'MODEL_GENERATION' : 'IDLE',
    activeGenerationBatch: null,
    tokenUsage: null,
    modelCallCount: 0,
    usageReportedCallCount: 0,
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: state === 'COMPLETED',
    startedAt: started,
    pausedAt: state === 'PAUSED' ? (overrides.updatedAt ?? started) : null,
    finishedAt: finished,
    lastError: null,
    updatedAt: finished ?? started ?? '2026-08-09T00:59:00.000Z',
    ...overrides
  };
}

async function makeStore(t, clock = () => new Date('2026-08-09T02:00:00.000Z')) {
  const directory = await mkdtemp(join(tmpdir(), 'class-task-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'class-tasks-v2.json');
  return { path, store: new ClassTaskStore(path, clock) };
}

test('persists and reopens the exact version 3 class-task file', async (t) => {
  const { path, store } = await makeStore(t);
  const expected = { version: 3, tasks: { [IDS.running]: snapshot(IDS.running, 'READY', {
    tokenUsage: { inputTokens: 1_200, outputTokens: 300, totalTokens: 1_500 },
    modelCallCount: 1,
    usageReportedCallCount: 1
  }) } };

  await store.save(expected);

  assert.deepEqual(await new ClassTaskStore(path).load(), expected);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), expected);
});

test('loads a newer cached-token snapshot by migrating only unsupported counters', async (t) => {
  const { path } = await makeStore(t);
  const task = snapshot(IDS.running, 'READY', {
    tokenUsage: {
      inputTokens: 1_200,
      cachedInputTokens: 400,
      uncachedInputTokens: null,
      outputTokens: 300,
      totalTokens: 1_500
    },
    modelCallCount: 1,
    usageReportedCallCount: 1
  });
  await writeFile(path, JSON.stringify({
    version: 3,
    tasks: { [task.id]: task }
  }), 'utf8');

  const loaded = await new ClassTaskStore(path).load();

  assert.deepEqual(loaded.tasks[task.id].tokenUsage, {
    inputTokens: 1_200,
    cachedInputTokens: 400,
    outputTokens: 300,
    totalTokens: 1_500
  });
  assert.deepEqual(
    JSON.parse(await readFile(path, 'utf8')).tasks[task.id].tokenUsage,
    loaded.tasks[task.id].tokenUsage
  );
});

test('migrates old task snapshots without token accounting as unknown instead of zero', async (t) => {
  const { path } = await makeStore(t);
  const legacy = snapshot(IDS.completed, 'COMPLETED');
  delete legacy.tokenUsage;
  delete legacy.modelCallCount;
  delete legacy.usageReportedCallCount;
  await writeFile(path, JSON.stringify({
    version: 3,
    tasks: { [legacy.id]: legacy }
  }), 'utf8');

  const loaded = await new ClassTaskStore(path).load();

  assert.equal(loaded.tasks[legacy.id].tokenUsage, null);
  assert.equal(loaded.tasks[legacy.id].modelCallCount, null);
  assert.equal(loaded.tasks[legacy.id].usageReportedCallCount, null);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).tasks[legacy.id].modelCallCount, null);
});

test('migrates snapshots without JaCoCo-covered method identities', async (t) => {
  const { path } = await makeStore(t);
  const legacy = snapshot(IDS.running, 'READY');
  delete legacy.coveredMethodIds;
  await writeFile(path, JSON.stringify({
    version: 3,
    tasks: { [legacy.id]: legacy }
  }), 'utf8');

  const loaded = await new ClassTaskStore(path).load();

  assert.deepEqual(loaded.tasks[legacy.id].coveredMethodIds, []);
  assert.deepEqual(
    JSON.parse(await readFile(path, 'utf8')).tasks[legacy.id].coveredMethodIds,
    []
  );
});

test('migrates a paused snapshot without pausedAt using its last update as the pause boundary', async (t) => {
  const { path } = await makeStore(t);
  const legacy = snapshot(IDS.paused, 'PAUSED', {
    updatedAt: '2026-08-09T01:10:00.000Z'
  });
  delete legacy.pausedAt;
  await writeFile(path, JSON.stringify({
    version: 3,
    tasks: { [legacy.id]: legacy }
  }), 'utf8');

  const loaded = await new ClassTaskStore(path).load();

  assert.equal(loaded.tasks[legacy.id].pausedAt, '2026-08-09T01:10:00.000Z');
  assert.equal(
    JSON.parse(await readFile(path, 'utf8')).tasks[legacy.id].pausedAt,
    '2026-08-09T01:10:00.000Z'
  );
});

test('startup keeps unfinished Maven preload resumable and interrupts only generated work', async (t) => {
  const { store } = await makeStore(t);
  await store.save({
    version: 3,
    tasks: {
      [IDS.running]: snapshot(IDS.running, 'RUNNING'),
      [IDS.preloading]: snapshot(IDS.preloading, 'PRELOADING'),
      [IDS.paused]: snapshot(IDS.paused, 'PAUSED'),
      [IDS.completed]: snapshot(IDS.completed, 'COMPLETED', {
        completionAttentionPending: false
      }),
      [IDS.extra]: snapshot(IDS.extra, 'INTERRUPTED', {
        preloadState: 'IDLE',
        finishedAt: '2026-08-09T01:30:00.000Z'
      })
    }
  });

  const restored = await store.loadForStartup();

  assert.equal(restored.tasks[IDS.running].state, 'INTERRUPTED');
  assert.equal(restored.tasks[IDS.running].selectionMode, 'EXPLICIT');
  assert.deepEqual(restored.tasks[IDS.running].selectedMethodIds, []);
  assert.deepEqual(restored.tasks[IDS.running].methodOrder, []);
  assert.equal(restored.tasks[IDS.preloading].state, 'PRELOADING');
  assert.equal(restored.tasks[IDS.preloading].preloadState, 'IDLE');
  assert.equal(restored.tasks[IDS.extra].state, 'PRELOADING');
  assert.equal(restored.tasks[IDS.extra].preloadState, 'IDLE');
  assert.equal(restored.tasks[IDS.extra].finishedAt, null);
  assert.equal(restored.tasks[IDS.running].finishedAt, '2026-08-09T02:00:00.000Z');
  assert.equal(restored.tasks[IDS.running].currentAtomicStep, 'IDLE');
  assert.equal(restored.tasks[IDS.paused].state, 'PAUSED');
  assert.equal(restored.tasks[IDS.completed].state, 'COMPLETED');
});

test('startup changes an unprocessed completed task with no formal test files to failed', async (t) => {
  const { store } = await makeStore(t);
  await store.save({
    version: 3,
    tasks: {
      [IDS.completed]: snapshot(IDS.completed, 'COMPLETED')
    }
  });

  const restored = await store.loadForStartup();

  assert.equal(restored.tasks[IDS.completed].state, 'FAILED');
  assert.equal(restored.tasks[IDS.completed].generatedArtifacts.length, 0);
  assert.equal(restored.tasks[IDS.completed].completionAttentionPending, false);
  assert.equal(restored.tasks[IDS.completed].lastError?.code, 'NO_FORMAL_TEST_FILE_GENERATED');
  assert.match(restored.tasks[IDS.completed].lastError?.message ?? '', /未生成任何正式测试文件/);
});

test('startup preserves a revoked completed result with no pending formal files', async (t) => {
  const { store } = await makeStore(t);
  await store.save({
    version: 3,
    tasks: {
      [IDS.completed]: snapshot(IDS.completed, 'COMPLETED', {
        completionAttentionPending: false
      })
    }
  });

  const restored = await store.loadForStartup();

  assert.equal(restored.tasks[IDS.completed].state, 'COMPLETED');
  assert.equal(restored.tasks[IDS.completed].generatedArtifacts.length, 0);
  assert.equal(restored.tasks[IDS.completed].completionAttentionPending, false);
  assert.equal(restored.tasks[IDS.completed].lastError, null);
});

test('startup preserves a ready task and defers cache validation until it is requested', async (t) => {
  const { store } = await makeStore(t);
  await store.save({
    version: 3,
    tasks: {
      [IDS.running]: snapshot(IDS.running, 'READY')
    }
  });

  const restored = await store.loadForStartup();

  assert.equal(restored.tasks[IDS.running].state, 'READY');
  assert.equal(restored.tasks[IDS.running].preloadState, 'READY');
  assert.equal(restored.tasks[IDS.running].currentAtomicStep, 'IDLE');
});

test('startup preserves empty selection and migrates legacy default-all tasks to empty explicit selection', async (t) => {
  const { store } = await makeStore(t);
  await store.save({
    version: 3,
    tasks: {
      [IDS.running]: snapshot(IDS.running, 'READY', {
        selectionMode: 'EXPLICIT',
        selectedMethodIds: [],
        methodOrder: []
      }),
      [IDS.extra]: snapshot(IDS.extra, 'READY', {
        selectionMode: 'ALL_BY_DEFAULT',
        selectedMethodIds: [],
        methodOrder: []
      })
    }
  });

  const restored = await store.loadForStartup();

  assert.equal(restored.tasks[IDS.running].selectionMode, 'EXPLICIT');
  assert.deepEqual(restored.tasks[IDS.running].selectedMethodIds, []);
  assert.deepEqual(restored.tasks[IDS.running].methodOrder, []);
  assert.equal(restored.tasks[IDS.extra].selectionMode, 'EXPLICIT');
  assert.deepEqual(restored.tasks[IDS.extra].selectedMethodIds, []);
  assert.deepEqual(restored.tasks[IDS.extra].methodOrder, []);
});

test('rejects a persistence key that does not match the snapshot id', async (t) => {
  const { store } = await makeStore(t);

  await assert.rejects(
    store.save({ version: 3, tasks: { wrong: snapshot(IDS.running) } }),
    /key.*id|键.*id/i
  );
});

test('rejects private fields and bounds public errors while redacting persisted diagnostics', async (t) => {
  const { path, store } = await makeStore(t);
  const unsafe = { ...snapshot(IDS.running), sourceCode: 'class Secret {}' };
  await assert.rejects(
    store.save({ version: 3, tasks: { [unsafe.id]: unsafe } }),
    /unknown|field|字段/i
  );

  const unbounded = snapshot(IDS.running, 'FAILED', {
    lastError: {
      code: 'FAILED',
      message: 'x'.repeat(4_097),
      moduleName: null,
      modulePath: null,
      command: null,
      occurredAt: '2026-08-09T01:00:00.000Z'
    }
  });
  await assert.rejects(store.save({ version: 3, tasks: { [unbounded.id]: unbounded } }));

  const safe = snapshot(IDS.running, 'FAILED', {
    lastError: {
      code: 'Authorization: Bearer code-secret-marker-94ad',
      message: 'Authorization: Bearer top-secret-token',
      moduleName: 'orders',
      modulePath: 'D:\\work',
      command: 'mvn -DapiKey=another-secret test',
      occurredAt: '2026-08-09T01:00:00.000Z'
    }
  });
  await store.save({ version: 3, tasks: { [safe.id]: safe } });
  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /top-secret-token|another-secret|code-secret-marker-94ad/);
  assert.match(raw, /REDACTED/);
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['version', 'tasks']);
});

test('serializes concurrent updates without losing class tasks', async (t) => {
  const { store } = await makeStore(t);

  await Promise.all([
    store.update((file) => ({
      ...file,
      tasks: { ...file.tasks, [IDS.running]: snapshot(IDS.running) }
    })),
    store.update((file) => ({
      ...file,
      tasks: { ...file.tasks, [IDS.extra]: snapshot(IDS.extra) }
    }))
  ]);

  assert.deepEqual(Object.keys((await store.load()).tasks).sort(), [IDS.extra, IDS.running].sort());
});

test('allows more than five persisted tasks when each workspace stays within capacity', async (t) => {
  const { store } = await makeStore(t);
  const tasks = {
    [IDS.running]: snapshot(IDS.running),
    [IDS.preloading]: snapshot(IDS.preloading),
    [IDS.paused]: snapshot(IDS.paused),
    [IDS.completed]: snapshot(IDS.completed),
    [IDS.extra]: snapshot(IDS.extra),
    [IDS.sixth]: snapshot(IDS.sixth, 'READY', {
      workspaceRoot: 'D:\\other-work',
      sourceFilePath: 'D:\\other-work\\src\\Sixth.java',
      moduleKey: 'd:/other-work/pom.xml',
      moduleDisplayPath: 'D:\\other-work'
    })
  };

  await store.save({ version: 3, tasks });

  assert.equal(Object.keys((await store.load()).tasks).length, 6);
});

test('rejects more than five persisted tasks in the same workspace', async (t) => {
  const { store } = await makeStore(t);
  const tasks = {
    [IDS.running]: snapshot(IDS.running),
    [IDS.preloading]: snapshot(IDS.preloading),
    [IDS.paused]: snapshot(IDS.paused),
    [IDS.completed]: snapshot(IDS.completed),
    [IDS.extra]: snapshot(IDS.extra),
    [IDS.sixth]: snapshot(IDS.sixth)
  };

  await assert.rejects(
    store.save({ version: 3, tasks }),
    /maximum 5 tasks per workspace/
  );
});

test('flush waits for queued persistence', async (t) => {
  const { path, store } = await makeStore(t);
  void store.update((file) => ({
    ...file,
    tasks: { [IDS.running]: snapshot(IDS.running) }
  }));

  await store.flush();

  assert.ok(JSON.parse(await readFile(path, 'utf8')).tasks[IDS.running]);
});
