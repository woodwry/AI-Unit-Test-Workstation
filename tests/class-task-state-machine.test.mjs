import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGAL_CLASS_TASK_TRANSITIONS,
  reconcileSelectionWithCatalog,
  resolveExecutionOrder,
  transitionClassTask
} from '../src/main/services/class-task-state-machine.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

function task(state = 'READY', overrides = {}) {
  return {
    id: TASK_ID,
    workspaceRoot: 'D:\\work',
    sourceFilePath: 'D:\\work\\src\\TaskService.java',
    qualifiedClassName: 'example.TaskService',
    moduleKey: 'd:/work/pom.xml',
    moduleDisplayPath: 'D:\\work',
    state,
    preloadState: state === 'PRELOADING' ? 'RUNNING' : 'READY',
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: [],
    currentMethodIndex: -1,
    currentAtomicStep: state === 'RUNNING' ? 'MODEL_GENERATION' : 'IDLE',
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: false,
    startedAt: state === 'RUNNING' || state === 'PAUSED' ? '2026-08-09T00:00:00.000Z' : null,
    pausedAt: state === 'PAUSED' ? '2026-08-09T00:30:00.000Z' : null,
    finishedAt: null,
    lastError: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  };
}

function method(methodId, jacocoOrder, generatable = true) {
  return {
    methodId,
    methodName: methodId,
    descriptor: '()V',
    displaySignature: `${methodId}()`,
    firstLine: jacocoOrder + 1,
    lastLine: jacocoOrder + 1,
    jacocoOrder,
    lineCovered: 0,
    lineMissed: 1,
    branchCovered: 0,
    branchMissed: 0,
    coverageGap: true,
    generatable,
    unavailableReason: generatable ? null : 'synthetic',
    modifiers: ['public']
  };
}

function catalog(methods) {
  return {
    taskId: TASK_ID,
    analysisSessionId: '22222222-2222-4222-8222-222222222222',
    reportPairId: 'pair-1',
    methods,
    warnings: [],
    refreshedAt: '2026-08-09T00:00:00.000Z'
  };
}

test('accepts every frozen transition and rejects transitions outside the table', () => {
  for (const [from, destinations] of Object.entries(LEGAL_CLASS_TASK_TRANSITIONS)) {
    for (const to of destinations) {
      assert.equal(
        transitionClassTask(task(from), to, { now: '2026-08-09T01:00:00.000Z' }).state,
        to,
        `${from} -> ${to}`
      );
    }
  }

  assert.throws(() => transitionClassTask(task('READY'), 'COMPLETED'), /READY.*COMPLETED/);
  assert.throws(() => transitionClassTask(task('PRELOADING'), 'RUNNING'), /PRELOADING.*RUNNING/);
});

test('normalizes run, resume, terminal, and preload timestamps consistently', () => {
  const now = '2026-08-09T01:00:00.000Z';
  const started = transitionClassTask(task('READY', {
    finishedAt: '2026-08-08T23:00:00.000Z',
    lastError: {
      code: 'OLD', message: 'old', moduleName: null, modulePath: null,
      command: null, occurredAt: '2026-08-08T23:00:00.000Z'
    }
  }), 'RUNNING', { now });
  assert.equal(started.startedAt, now);
  assert.equal(started.finishedAt, null);
  assert.equal(started.lastError, null);

  const resumed = transitionClassTask(task('PAUSED', {
    updatedAt: '2026-08-09T00:45:00.000Z'
  }), 'RUNNING', { now });
  assert.equal(resumed.startedAt, '2026-08-09T00:30:00.000Z');
  assert.equal(resumed.pausedAt, null);

  const stoppingAfterPause = transitionClassTask(task('PAUSED', {
    updatedAt: '2026-08-09T00:45:00.000Z'
  }), 'STOPPING', { now });
  assert.equal(stoppingAfterPause.startedAt, '2026-08-09T00:30:00.000Z');
  assert.equal(stoppingAfterPause.pausedAt, null);

  const paused = transitionClassTask(task('PAUSE_REQUESTED', {
    startedAt: '2026-08-09T00:00:00.000Z'
  }), 'PAUSED', { now });
  assert.equal(paused.pausedAt, now);

  const completed = transitionClassTask(task('RUNNING', {
    methodOrder: ['first', 'second'],
    currentMethodIndex: 1
  }), 'COMPLETED', { now });
  assert.equal(completed.finishedAt, now);
  assert.equal(completed.currentAtomicStep, 'IDLE');
  assert.equal(completed.currentMethodIndex, -1);
  assert.equal(completed.completionAttentionPending, true);

  const terminated = transitionClassTask(task('STOPPING', {
    methodOrder: ['first', 'second'],
    currentMethodIndex: 0
  }), 'TERMINATED', { now });
  assert.equal(terminated.finishedAt, now);
  assert.equal(terminated.currentAtomicStep, 'IDLE');
  assert.equal(terminated.currentMethodIndex, 0);
  assert.equal(terminated.completionAttentionPending, true);

  const preloading = transitionClassTask(task('COMPLETED', {
    startedAt: '2026-08-09T00:00:00.000Z',
    finishedAt: '2026-08-09T00:30:00.000Z',
    completionAttentionPending: true
  }), 'PRELOADING', { now });
  assert.equal(preloading.preloadState, 'RUNNING');
  assert.equal(preloading.startedAt, null);
  assert.equal(preloading.finishedAt, null);
  assert.equal(preloading.completionAttentionPending, false);
});

test('explicit empty selection blocks execution and explicit order remains stable', () => {
  const currentCatalog = catalog([
    method('third', 2), method('first', 0), method('second', 1)
  ]);
  assert.throws(
    () => resolveExecutionOrder(task('READY', {
      selectionMode: 'EXPLICIT', selectedMethodIds: [], methodOrder: []
    }), currentCatalog),
    /at least one|至少.*方法/i
  );

  assert.deepEqual(resolveExecutionOrder(task('READY', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['second', 'first'],
    methodOrder: ['second', 'first']
  }), currentCatalog), ['second', 'first']);
});

test('catalog refresh retains selected IDs in saved order and reports stale removals', () => {
  const result = reconcileSelectionWithCatalog(task('READY', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['second', 'removed', 'first'],
    methodOrder: ['second', 'removed', 'first']
  }), catalog([method('first', 0), method('second', 1), method('new', 2)]));

  assert.deepEqual(result.task.selectedMethodIds, ['second', 'first']);
  assert.deepEqual(result.task.methodOrder, ['second', 'first']);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0].message, /removed/);
});

test('legacy default-all state cannot expand an empty selection into every method', () => {
  const defaultTask = task('READY', {
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: []
  });
  assert.throws(
    () => resolveExecutionOrder(defaultTask, catalog([
      method('new-first', 0), method('not-generatable', 1, false), method('new-last', 2)
    ])),
    /at least one|至少.*方法/i
  );
});
