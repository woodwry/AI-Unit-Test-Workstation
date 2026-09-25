import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ClassTaskCheckpointService,
  ClassTaskPausedAtBoundaryError
} from '../src/main/services/class-task-checkpoint.service.ts';
import { ClassTaskRunnerService } from '../src/main/services/class-task-runner.service.ts';
import { ClassTaskSchedulerService } from '../src/main/services/class-task-scheduler.service.ts';

function task(state = 'READY') {
  return {
    id: 'Task', workspaceRoot: 'D:\\workspace', sourceFilePath: 'D:\\workspace\\Task.java',
    qualifiedClassName: 'example.Task', moduleKey: 'd:/workspace', moduleDisplayPath: 'D:\\workspace',
    state, preloadState: 'READY', selectionMode: 'EXPLICIT', selectedMethodIds: ['method'], methodOrder: ['method'],
    currentMethodIndex: -1, currentAtomicStep: 'IDLE', generatedArtifacts: [], coverageBaseline: null,
    coverageCurrent: null, coverageContributions: [], completionAttentionPending: false,
    startedAt: null, finishedAt: null, lastError: null, updatedAt: '2026-08-09T00:00:00.000Z'
  };
}

function catalog() {
  return {
    taskId: 'Task', analysisSessionId: '22222222-2222-4222-8222-222222222222', reportPairId: 'pair',
    reportCoverageTotals: {
      instructionCovered: 0, instructionMissed: 2,
      branchCovered: 0, branchMissed: 0,
      complexityCovered: 0, complexityMissed: 1,
      lineCovered: 0, lineMissed: 1
    },
    methods: [{
      methodId: 'method', methodName: 'method', descriptor: '()V', displaySignature: 'method()',
      firstLine: 1, lastLine: 1, jacocoOrder: 0, lineCovered: 0, lineMissed: 1,
      branchCovered: 0, branchMissed: 0, instructionCovered: 0, instructionMissed: 2,
      complexityCovered: 0, complexityMissed: 1, coverageGap: true, generatable: true,
      unavailableReason: null, modifiers: ['public']
    }], warnings: [], refreshedAt: '2026-08-09T00:00:00.000Z'
  };
}

async function harness(t, methodExecution) {
  const directory = await mkdtemp(join(tmpdir(), 'class-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = task();
  const registry = {
    list: () => [structuredClone(current)],
    snapshot: () => structuredClone(current),
    async save(next) { current = structuredClone(next); return structuredClone(current); }
  };
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'), taskState: registry,
    clock: () => new Date('2026-08-09T01:00:00.000Z')
  });
  const runner = new ClassTaskRunnerService({ checkpoints, methodExecution });
  const scheduler = new ClassTaskSchedulerService({
    registry, checkpoints, runner, catalogProvider: { get: async () => catalog() },
    validateTask: async () => undefined
  });
  return { checkpoints, registry, scheduler };
}

test('pause waits for the atomic transaction and resume uses its saved batch checkpoint', async (t) => {
  let checkpoints;
  let atomicStarted;
  const started = new Promise((resolve) => { atomicStarted = resolve; });
  let finishAtomic;
  const atomicBlocked = new Promise((resolve) => { finishAtomic = resolve; });
  const executionAttempts = [];
  const methodExecution = {
    async execute(currentTask, methodId, checkpoint) {
      if (checkpoint.completedBatches.length === 0) {
        executionAttempts.push('batch-1:MAVEN_TEST');
        await checkpoints.beginAtomicStep(currentTask.id, 'MAVEN_TEST');
        atomicStarted();
        try {
          await atomicBlocked;
        } finally {
          await checkpoints.completeAtomicStep(currentTask.id, 'MAVEN_TEST');
        }
        await checkpoints.commitBatch({
          taskId: currentTask.id, methodId, batchId: 'batch-1', batchIndex: 1,
          completedTestMethodPlanIds: ['plan-1'], outcome: 'PASSED', candidateVersion: 1,
          tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java', tmpFileSha256: 'c'.repeat(64),
          ordinaryTestMethodCount: 1
        });
        await checkpoints.beginAtomicStep(currentTask.id, 'MERGE_METHOD_BATCHES');
      }
      return null;
    }
  };
  const created = await harness(t, methodExecution);
  checkpoints = created.checkpoints;

  const run = created.scheduler.runTask('Task');
  await started;
  await created.scheduler.requestPause('Task');
  assert.equal(created.registry.snapshot('Task').state, 'PAUSE_REQUESTED');
  finishAtomic();
  await run;
  assert.equal(created.registry.snapshot('Task').state, 'PAUSED');

  await created.scheduler.resumeTask('Task');
  assert.equal(created.registry.snapshot('Task').state, 'COMPLETED');
  assert.deepEqual(executionAttempts, ['batch-1:MAVEN_TEST']);
});

test('pause after model generation lets the returned candidate become durable before stopping Maven', async (t) => {
  const created = await harness(t, { async execute() { return null; } });
  await created.checkpoints.transitionState('Task', 'RUNNING');
  await created.checkpoints.beginAtomicStep('Task', 'MODEL_GENERATION');

  await created.checkpoints.requestPause('Task');
  await created.checkpoints.completeAtomicStep('Task', 'MODEL_GENERATION');

  await created.checkpoints.beginAtomicStep('Task', 'WRITE_CANDIDATE');
  assert.equal(created.registry.snapshot('Task').state, 'PAUSE_REQUESTED');
  assert.equal(created.registry.snapshot('Task').currentAtomicStep, 'WRITE_CANDIDATE');
  await created.checkpoints.completeAtomicStep('Task', 'WRITE_CANDIDATE');

  await assert.rejects(
    created.checkpoints.beginAtomicStep('Task', 'MAVEN_COMPILE'),
    ClassTaskPausedAtBoundaryError
  );
  assert.equal(created.registry.snapshot('Task').state, 'PAUSED');
  assert.equal(created.registry.snapshot('Task').currentAtomicStep, 'IDLE');
});

test('termination aborts external work but commits TERMINATED only after transaction cleanup', async (t) => {
  let checkpoints;
  let atomicStarted;
  const started = new Promise((resolve) => { atomicStarted = resolve; });
  let releaseCleanup;
  const cleanupBlocked = new Promise((resolve) => { releaseCleanup = resolve; });
  let abortObserved = false;
  const created = await harness(t, {
    async execute(currentTask, _methodId, _checkpoint, signal) {
      await checkpoints.beginAtomicStep(currentTask.id, 'MAVEN_TEST');
      atomicStarted();
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => { abortObserved = true; resolve(); }, { once: true });
      });
      await cleanupBlocked;
      await checkpoints.completeAtomicStep(currentTask.id, 'MAVEN_TEST');
      throw signal.reason;
    }
  });
  checkpoints = created.checkpoints;
  const run = created.scheduler.runTask('Task');
  await started;

  const terminating = created.scheduler.terminateTask('Task');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abortObserved, true);
  assert.equal(created.registry.snapshot('Task').state, 'STOPPING');
  assert.equal(created.registry.snapshot('Task').currentAtomicStep, 'MAVEN_TEST');

  releaseCleanup();
  await terminating;
  await run;
  assert.equal(created.registry.snapshot('Task').state, 'TERMINATED');
  assert.equal(created.registry.snapshot('Task').currentAtomicStep, 'IDLE');
});

test('a pause or stop boundary prevents a new atomic step from starting', async (t) => {
  const created = await harness(t, { async execute() { return null; } });
  await created.checkpoints.transitionState('Task', 'RUNNING');
  await created.checkpoints.requestPause('Task');

  await assert.rejects(
    created.checkpoints.beginAtomicStep('Task', 'MODEL_GENERATION'),
    { name: 'ClassTaskPausedAtBoundaryError' }
  );
  assert.equal(created.registry.snapshot('Task').state, 'PAUSED');
  assert.equal(created.registry.snapshot('Task').currentAtomicStep, 'IDLE');
});
