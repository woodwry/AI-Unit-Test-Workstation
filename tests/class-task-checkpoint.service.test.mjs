import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ClassTaskCheckpointService
} from '../src/main/services/class-task-checkpoint.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';
import { createExecutableModuleMavenReadyQueue } from '../src/main/services/module-maven-ready-queue.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CATALOG = {
  analysisSessionId: '22222222-2222-4222-8222-222222222222',
  reportPairId: 'a'.repeat(64)
};
const METHOD_1 = '1'.repeat(64);
const METHOD_2 = '2'.repeat(64);
const METHOD_3 = '3'.repeat(64);
const SCENARIO_ID = '3f0d9173d7f34faabbba4c89cdd3a415';
const PART_BATCH_ID = 'c'.repeat(64);

function snapshot(overrides = {}) {
  return {
    id: TASK_ID,
    currentMethodIndex: -1,
    currentAtomicStep: 'IDLE',
    activeGenerationBatch: null,
    tokenUsage: null,
    modelCallCount: 0,
    usageReportedCallCount: 0,
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...overrides
  };
}

function taskState(initial = snapshot()) {
  let current = { ...initial };
  return {
    snapshot() {
      return { ...current };
    },
    async save(next) {
      current = { ...next };
      return { ...current };
    }
  };
}

for (const action of ['accept', 'revoke']) {
  test(`queued ${action} waits outside the module lock between Maven compile and test`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'class-task-boundary-lock-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const moduleKey = 'collection-core';
    const lock = new ModuleOperationLock();
    const state = taskState(snapshot({ state: 'RUNNING', moduleKey }));
    const checkpoints = new ClassTaskCheckpointService({
      storagePath: join(root, 'class-task-checkpoints-v2.json'),
      taskState: state,
      canDrainBackgroundOperations: () => !lock.isLocked(moduleKey)
    });
    const events = [];
    let background;
    const queue = createExecutableModuleMavenReadyQueue({
      moduleLock: lock,
      idFactory: () => 'batch-1',
      maven: {
        async executeBatch(input) {
          await input.onPhaseStart('test_compile');
          events.push('compile');
          // A result action submitted while compilation is active must acquire
          // this same lock for its JaCoCo baseline checkpoint/recalculation.
          background = checkpoints.runBackgroundOperationAtBoundary(TASK_ID, () =>
            lock.runExclusive(moduleKey, async () => { events.push(action); return action; })
          );
          await input.onPhaseComplete('test_compile');
          await input.onPhaseStart('test');
          events.push('test');
          await input.onPhaseComplete('test');
          return new Map([['candidate-1', {
            candidateId: 'candidate-1', status: 'passed', mavenExecutions: []
          }]]);
        }
      }
    });
    const execution = queue.enqueue({
      moduleKey, environmentFingerprint: 'same', taskId: TASK_ID,
      candidateId: 'candidate-1', moduleRoot: root, buildSettings: {},
      scope: 'method_candidate', filePath: join(root, 'Tmp1Test.java'),
      projectFilePath: join(root, 'Tmp1Test.java'), isolationFilePath: join(root, 'isolated.java'),
      qualifiedTestClassName: 'example.Tmp1Test',
      async onBatchStart() {}, async activate() {}, async isolate() {},
      onPhaseStart: phase => checkpoints.beginAtomicStep(TASK_ID,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST'),
      onPhaseComplete: phase => checkpoints.completeAtomicStep(TASK_ID,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST')
    });
    let timer;
    try {
      const result = await Promise.race([
        execution,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })
      ]);
      assert.notEqual(result, null, 'Maven is deadlocked at the result-action boundary');
      assert.equal(result.status, 'passed');
      assert.deepEqual(events, ['compile', 'test']);
      await new Promise(resolve => setImmediate(resolve));
      await checkpoints.waitIfPausedAtBoundary(TASK_ID);
      assert.equal(await background, action);
      assert.deepEqual(events, ['compile', 'test', action]);
      assert.equal(state.snapshot().state, 'RUNNING');
      assert.equal(state.snapshot().currentAtomicStep, 'IDLE');
    } finally { clearTimeout(timer); }
  });
}

test('prepareRun reconciles already generated artifact methods into checkpoint completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const storagePath = join(root, 'class-task-checkpoints-v2.json');
  await writeFile(storagePath, JSON.stringify({
    version: 5,
    tasks: {
      [TASK_ID]: {
        catalogIdentity: CATALOG,
        resolvedMethodOrder: [METHOD_1, METHOD_2, METHOD_3],
        completedMethodIds: [],
        methods: {},
        ragRun: null,
        waveState: {
          methodQueue: [METHOD_2, METHOD_3],
          activeMethodId: METHOD_1,
          methods: {},
          activeWave: {
            waveId: 'b'.repeat(64),
            waveSessionId: null,
            recoveryRequestId: null,
            eventSequence: 1,
            startRequest: null,
            methodId: METHOD_1,
            waveIndex: 1,
            selectedScenarioIds: [SCENARIO_ID],
            remainingScenarioCount: 0,
            wave: null,
            initialUsageRecorded: true,
            parts: [{
              partIndex: 1,
              partBatchId: PART_BATCH_ID,
              scenarioIds: [SCENARIO_ID],
              status: 'PENDING',
              eventSequence: 0,
              candidateId: null,
              isolatedFilePath: null,
              fileSha256: null,
              failureReason: null
            }]
          },
          candidates: {},
          migrationInterrupted: false
        }
      }
    }
  }), 'utf8');
  const service = new ClassTaskCheckpointService({
    storagePath,
    taskState: taskState()
  });

  const progress = await service.prepareRun(TASK_ID, {
    reset: false,
    catalogIdentity: CATALOG,
    resolvedMethodOrder: [METHOD_1, METHOD_2, METHOD_3],
    completedMethodIdsFromArtifacts: [METHOD_1, METHOD_2]
  });
  const wave = await service.taskWaveProgress(TASK_ID);
  const raw = JSON.parse(await readFile(storagePath, 'utf8')).tasks[TASK_ID];

  assert.deepEqual(progress.completedMethodIds, [METHOD_1, METHOD_2]);
  assert.deepEqual(wave.methodQueue, [METHOD_3]);
  assert.equal(wave.activeMethodId, null);
  assert.equal(wave.activeWave, null);
  assert.deepEqual(raw.completedMethodIds, [METHOD_1, METHOD_2]);
});

test('prepareRun reset clears public coverage progress from a previous execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-checkpoint-reset-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const storagePath = join(root, 'class-task-checkpoints-v2.json');
  const state = taskState(snapshot({
    coveredMethodIds: [METHOD_1, METHOD_2],
    coverageContributions: [{ methodId: METHOD_1 }]
  }));
  const service = new ClassTaskCheckpointService({
    storagePath,
    taskState: state
  });

  await service.prepareRun(TASK_ID, { reset: true });

  assert.deepEqual(state.snapshot().coveredMethodIds, []);
  assert.deepEqual(state.snapshot().coverageContributions, []);
});

test('keeps successful Parts when a rebuilt report also finds older artifacts for the active method', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-partial-wave-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storagePath = join(root, 'checkpoints.json');
  const activeWave = {
    waveId: 'b'.repeat(64), waveSessionId: null, recoveryRequestId: null,
    eventSequence: 8, startRequest: null, methodId: METHOD_1, waveIndex: 1,
    selectedScenarioIds: [SCENARIO_ID, 'second-scenario'], remainingScenarioCount: 0,
    wave: null, initialUsageRecorded: false,
    parts: [{
      partIndex: 1, partBatchId: PART_BATCH_ID, scenarioIds: [SCENARIO_ID],
      status: 'SUCCEEDED', eventSequence: 7,
      childSessionId: '33333333-3333-4333-8333-333333333333',
      candidateId: '44444444-4444-4444-8444-444444444444',
      isolatedFilePath: join(root, 'saved-part.java'), fileSha256: 'd'.repeat(64), failureReason: null
    }, {
      partIndex: 2, partBatchId: 'e'.repeat(64), scenarioIds: ['second-scenario'],
      status: 'RUNNING', eventSequence: 8,
      childSessionId: '55555555-5555-4555-8555-555555555555',
      candidateId: null, isolatedFilePath: null, fileSha256: null, failureReason: null
    }]
  };
  await writeFile(storagePath, JSON.stringify({ version: 5, tasks: {
    [TASK_ID]: {
      catalogIdentity: CATALOG, resolvedMethodOrder: [METHOD_1, METHOD_2],
      completedMethodIds: [], methods: {}, ragRun: null,
      waveState: { methodQueue: [METHOD_2], activeMethodId: METHOD_1, methods: {},
        activeWave, candidates: {}, migrationInterrupted: false }
    }
  } }), 'utf8');
  const service = new ClassTaskCheckpointService({ storagePath, taskState: taskState() });
  const before = await service.taskWaveProgress(TASK_ID);
  await service.prepareRun(TASK_ID, {
    reset: false, catalogIdentity: { ...CATALOG, reportPairId: 'f'.repeat(64) },
    resolvedMethodOrder: [METHOD_1, METHOD_2],
    completedMethodIdsFromArtifacts: [METHOD_1]
  });
  const after = await service.taskWaveProgress(TASK_ID);
  assert.deepEqual((await service.taskProgress(TASK_ID)).completedMethodIds, []);
  assert.deepEqual(after.activeWave, before.activeWave);
  assert.equal(after.activeMethodId, METHOD_1);
  assert.deepEqual(after.methodQueue, [METHOD_2]);
});
