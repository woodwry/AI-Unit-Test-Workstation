import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ClassTaskCheckpointService,
  ClassTaskPausedAtBoundaryError,
  ClassTaskRegistryStateAdapter
} from '../src/main/services/class-task-checkpoint.service.ts';
import { ClassTaskRegistryService } from '../src/main/services/class-task-registry.service.ts';
import { ClassTaskStore } from '../src/main/services/class-task.store.ts';
import { ClassTaskRunnerService } from '../src/main/services/class-task-runner.service.ts';
import { ClassTaskSchedulerService } from '../src/main/services/class-task-scheduler.service.ts';

const CATALOG_IDENTITY = { analysisSessionId: 'analysis', reportPairId: 'pair' };

test('incomplete planning without cached scenarios pauses once and keeps the method unfinished', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  let requests = 0;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave(_task, methodId) {
        requests += 1;
        return { waveBatchId: null, reportPairId: 'pair', methodId, hasWork: false,
          selectedScenarioIds: [], remainingScenarioCount: 0, parts: [],
          warnings: [{ code: 'SCENARIO_PLANNING_INCOMPLETE', message: '仍有目标未完成划分' }] };
      },
      async executeWave() { throw new Error('an empty cache must not execute a Wave'); },
      async execute() { throw new Error('legacy execution must not run'); }
    }
  });
  assert.equal(await runner.run(task(), ['A'], CATALOG_IDENTITY, new AbortController().signal), 'PAUSED');
  assert.equal(requests, 1);
  assert.equal(state.snapshot().state, 'PAUSED');
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, []);
  assert.equal((await checkpoints.taskWaveProgress('Task')).activeMethodId, 'A');

  await checkpoints.transitionState('Task', 'RUNNING');
  assert.equal(await runner.run(state.snapshot(), ['A'], CATALOG_IDENTITY, new AbortController().signal), 'PAUSED');
  assert.equal(requests, 2, 'unchanged incomplete planning must pause, not endlessly requeue');
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, []);
});

test('incomplete planning drains cached Waves then pauses with an unknown remainder instead of a fake scenario', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  let requests = 0;
  let finalized = 0;
  const executed = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave(_task, methodId, request) {
        requests += 1;
        assert.equal(requests <= 2, true, 'only the two cached Waves should be requested before pausing');
        assert.deepEqual(request.completedScenarioIds, requests === 1 ? [] : ['scenario-1']);
        const scenarioIds = [`scenario-${requests}`];
        return {
          waveBatchId: createHash('sha256').update(`incomplete-wave-${requests}`).digest('hex'),
          reportPairId: 'pair', methodId, hasWork: true, selectedScenarioIds: scenarioIds,
          remainingScenarioCount: requests === 1 ? 1 : 0,
          parts: [{ partIndex: 1,
            partBatchId: createHash('sha256').update(`incomplete-part-${requests}`).digest('hex'), scenarioIds }],
          warnings: [{ code: 'SCENARIO_PLANNING_INCOMPLETE', message: '缓存之外仍有目标未完成划分' }]
        };
      },
      async executeWave(_task, wave) {
        assert.equal(state.snapshot().state, 'RUNNING', 'available cached scenarios should run before the safety pause');
        executed.push(...wave.selectedScenarioIds);
        return { completedScenarioIds: [...wave.selectedScenarioIds], skippedScenarioIds: [], candidateIds: [] };
      },
      async execute() { throw new Error('legacy execution must not run'); },
      async finalizeRun() { finalized += 1; }
    }
  });
  assert.equal(await runner.run(task(), ['A'], CATALOG_IDENTITY, new AbortController().signal), 'PAUSED');
  assert.equal(requests, 2);
  assert.deepEqual(executed, ['scenario-1', 'scenario-2']);
  assert.equal(finalized, 0);
  assert.equal(state.snapshot().state, 'PAUSED');
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, []);
  const progress = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(progress.methodQueue, ['A']);
  assert.equal(progress.activeMethodId, null);
  assert.equal(progress.activeWave, null);
  assert.equal(progress.methods.A.nextWaveIndex, 3);
  assert.deepEqual(progress.methods.A.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.equal(progress.methods.A.remainingScenarioCount, null, 'null means planning is unresolved, not one real scenario');
  assert.equal(progress.methods.A.completedWaves.at(-1).remainingScenarioCount, 0, 'the completed Wave preserves the real cached count');
});

test('suspended source-tree search requeues the method without marking it complete', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const order = [];
  let first = true;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave(_task, methodId) {
        order.push(methodId);
        const pending = methodId === 'A' && first;
        first = false;
        return { waveBatchId: null, reportPairId: 'pair', methodId, hasWork: false,
          selectedScenarioIds: [], remainingScenarioCount: 0, parts: [],
          warnings: pending ? [{ code: 'SCENARIO_SEARCH_PENDING', message: '源码搜索挂起' }] : [] };
      },
      async executeWave() { throw new Error('search-only response must not invoke the model'); },
      async execute() { throw new Error('legacy execution must not run'); }
    }
  });
  assert.equal(await runner.run(task(), ['A', 'B'], CATALOG_IDENTITY, new AbortController().signal), 'COMPLETED');
  assert.deepEqual(order, ['A', 'B', 'A']);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, ['B', 'A']);
});

function task(id = 'Task', state = 'RUNNING', overrides = {}) {
  return {
    id, workspaceRoot: 'D:\\workspace', sourceFilePath: `D:\\workspace\\${id}.java`,
    qualifiedClassName: `example.${id}`, moduleKey: 'd:/workspace', moduleDisplayPath: 'D:\\workspace',
    state, preloadState: 'READY', ragEnabled: false, selectionMode: 'ALL_BY_DEFAULT', selectedMethodIds: [], methodOrder: [],
    currentMethodIndex: -1, currentAtomicStep: 'IDLE', activeGenerationBatch: null,
    tokenUsage: null, modelCallCount: 0, usageReportedCallCount: 0,
    generatedArtifacts: [], coverageBaseline: null, coverageCurrent: null,
    coverageContributions: [], completionAttentionPending: false,
    startedAt: '2026-08-09T00:00:00.000Z', finishedAt: null, lastError: null,
    updatedAt: '2026-08-09T00:00:00.000Z', ...overrides
  };
}

function statePort(initial) {
  let current = structuredClone(initial);
  const history = [];
  return {
    snapshot: () => structuredClone(current),
    async save(next) {
      current = structuredClone(next);
      history.push(structuredClone(current));
      return structuredClone(current);
    },
    history: () => structuredClone(history)
  };
}

function methodCatalog(taskId, methodIds) {
  return {
    taskId,
    analysisSessionId: 'analysis',
    reportPairId: 'pair',
    methods: methodIds.map((methodId, jacocoOrder) => ({
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
      generatable: true,
      unavailableReason: null,
      modifiers: ['public']
    })),
    warnings: [],
    refreshedAt: '2026-08-09T00:00:00.000Z'
  };
}

async function checkpointsFor(t, initial = task()) {
  const directory = await mkdtemp(join(tmpdir(), 'class-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = statePort(initial);
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'), taskState: state,
    clock: () => new Date('2026-08-09T01:00:00.000Z')
  });
  return { checkpoints, state, storagePath: join(directory, 'checkpoints.json') };
}

function classWaveCheckpoint(waveId, slices, completedMethodIds = []) {
  const scenarioIds = slices.flatMap((slice) => slice.scenarioIds);
  const selectedMethodIds = slices.map((slice) => slice.methodId);
  const wave = {
    waveBatchId: waveId,
    reportPairId: 'pair',
    methodId: 'A',
    remainingScenarioCount: 0,
    hasWork: true,
    selectedMethodIds,
    selectedScenarioIds: scenarioIds,
    remainingScenarioCountByMethod: Object.fromEntries(
      selectedMethodIds.map((methodId) => [methodId, 0])
    ),
    completedMethodIds,
    parts: [{
      partIndex: 1,
      partBatchId: createHash('sha256').update(`${waveId}:part`).digest('hex'),
      scenarioIds,
      methodSlices: slices.map((slice, index) => ({
        methodId: slice.methodId,
        testMethodNamePrefix: `m${index + 1}_`,
        batch: {
          method: { methodId: slice.methodId },
          scenarioIds: [...slice.scenarioIds]
        }
      }))
    }],
    warnings: []
  };
  return {
    waveId,
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: scenarioIds,
    remainingScenarioCount: 0,
    wave,
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: wave.parts[0].partBatchId,
      scenarioIds,
      status: 'PENDING',
      eventSequence: 0,
      childSessionId: null,
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  };
}

test('runner executes one method at a time in catalog order', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  let active = 0;
  let maximum = 0;
  const order = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) {
        active += 1;
        maximum = Math.max(maximum, active);
        order.push(methodId);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return null;
      }
    }
  });

  const outcome = await runner.run(
    task(),
    ['zeta', 'alpha', 'middle'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.equal(maximum, 1);
  assert.deepEqual(order, ['zeta', 'alpha', 'middle']);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds,
    ['zeta', 'alpha', 'middle']);
});

test('runner schedules one 25-by-5 class Wave across source-method boundaries', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const requests = [];
  const executed = [];
  const waveId = createHash('sha256').update('class-wave').digest('hex');
  const partId = createHash('sha256').update('class-part').digest('hex');
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextClassWave(_task, request) {
        requests.push(structuredClone(request));
        return {
          waveBatchId: waveId,
          reportPairId: 'pair',
          methodId: 'A',
          remainingScenarioCount: 0,
          hasWork: true,
          selectedMethodIds: ['A', 'B'],
          selectedScenarioIds: ['a-1', 'a-2', 'a-3', 'b-1', 'b-2'],
          remainingScenarioCountByMethod: { A: 0, B: 0 },
          completedMethodIds: ['A', 'B'],
          parts: [{
            partIndex: 1,
            partBatchId: partId,
            scenarioIds: ['a-1', 'a-2', 'a-3', 'b-1', 'b-2'],
            methodSlices: [{
              methodId: 'A',
              testMethodNamePrefix: 'm1_',
              batch: { method: { methodId: 'A' }, scenarioIds: ['a-1', 'a-2', 'a-3'] }
            }, {
              methodId: 'B',
              testMethodNamePrefix: 'm2_',
              batch: { method: { methodId: 'B' }, scenarioIds: ['b-1', 'b-2'] }
            }]
          }],
          warnings: []
        };
      },
      async executeWave(_task, wave) {
        executed.push([...wave.selectedScenarioIds]);
        return {
          completedScenarioIds: [...wave.selectedScenarioIds],
          skippedScenarioIds: [],
          candidateIds: []
        };
      },
      async execute() { throw new Error('class Wave must bypass legacy method execution'); }
    }
  });

  const outcome = await runner.run(
    task(),
    ['A', 'B'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.deepEqual(requests, [{
    reportPairId: 'pair',
    methods: [{ methodId: 'A', completedScenarioIds: [], skippedScenarioIds: [] },
      { methodId: 'B', completedScenarioIds: [], skippedScenarioIds: [] }],
    maxScenarios: 25,
    partSize: 5
  }]);
  assert.deepEqual(executed, [['a-1', 'a-2', 'a-3', 'b-1', 'b-2']]);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, ['A', 'B']);
});

test('class Wave model failure keeps selected methods incomplete and resumes the same Wave', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  const waveId = createHash('sha256').update('failed-class-wave').digest('hex');
  const partId = createHash('sha256').update('failed-class-part').digest('hex');
  let selectionCalls = 0;
  let executionCalls = 0;
  let failModel = true;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextClassWave() {
        selectionCalls += 1;
        if (selectionCalls > 1) throw new Error('the failed class Wave must be resumed, not selected again');
        return {
          waveBatchId: waveId,
          reportPairId: 'pair',
          methodId: 'A',
          remainingScenarioCount: 0,
          hasWork: true,
          selectedMethodIds: ['A', 'B'],
          selectedScenarioIds: ['a-1', 'b-1'],
          remainingScenarioCountByMethod: { A: 0, B: 0 },
          completedMethodIds: ['A', 'B'],
          parts: [{
            partIndex: 1,
            partBatchId: partId,
            scenarioIds: ['a-1', 'b-1'],
            methodSlices: [{
              methodId: 'A',
              testMethodNamePrefix: 'm1_',
              batch: { method: { methodId: 'A' }, scenarioIds: ['a-1'] }
            }, {
              methodId: 'B',
              testMethodNamePrefix: 'm2_',
              batch: { method: { methodId: 'B' }, scenarioIds: ['b-1'] }
            }]
          }],
          warnings: []
        };
      },
      async executeWave(_task, wave) {
        executionCalls += 1;
        if (failModel) {
          return {
            completedScenarioIds: [],
            skippedScenarioIds: [...wave.selectedScenarioIds],
            candidateIds: [],
            modelFailure: {
              code: 'MODEL_RATE_LIMITED',
              message: '已达到大模型平台的请求频率限制。',
              stage: 'generation'
            }
          };
        }
        return {
          completedScenarioIds: [...wave.selectedScenarioIds],
          skippedScenarioIds: [],
          candidateIds: []
        };
      },
      async execute() { throw new Error('class Wave must bypass legacy method execution'); }
    }
  });

  await assert.rejects(
    runner.run(task(), ['A', 'B'], CATALOG_IDENTITY, new AbortController().signal),
    (error) => {
      assert.equal(error.name, 'MethodGenerationRequestError');
      assert.equal(error.code, 'MODEL_RATE_LIMITED');
      return true;
    }
  );

  let progress = await checkpoints.taskProgress('Task');
  let wave = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(progress.completedMethodIds, []);
  assert.equal(state.snapshot().currentMethodIndex, -1);
  assert.equal(state.snapshot().lastError?.code, 'MODEL_RATE_LIMITED');
  assert.equal(wave.activeMethodId, 'A');
  assert.deepEqual(wave.methodQueue, ['B']);
  assert.equal(wave.activeWave?.waveId, waveId);
  assert.deepEqual(wave.methods.A.completedScenarioIds, []);
  assert.deepEqual(wave.methods.A.skippedScenarioIds, []);

  failModel = false;
  assert.equal(await runner.run(
    state.snapshot(),
    ['A', 'B'],
    CATALOG_IDENTITY,
    new AbortController().signal
  ), 'COMPLETED');

  progress = await checkpoints.taskProgress('Task');
  wave = await checkpoints.taskWaveProgress('Task');
  assert.equal(selectionCalls, 1);
  assert.equal(executionCalls, 2);
  assert.deepEqual(progress.completedMethodIds, ['A', 'B']);
  assert.equal(state.snapshot().currentMethodIndex, 1);
  assert.equal(wave.activeWave, null);
});
test('class Wave carries a partially consumed method and untouched methods into the next FIFO request', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const requests = [];
  const aScenarios = Array.from({ length: 15 }, (_, index) => `a-${index + 1}`);
  const bScenarios = Array.from({ length: 10 }, (_, index) => `b-${index + 1}`);
  const waveId = createHash('sha256').update('partial-class-wave').digest('hex');
  let executions = 0;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextClassWave(_task, request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          const partSpecs = [
            { methodId: 'A', prefix: 'm1_', scenarioIds: aScenarios.slice(0, 5) },
            { methodId: 'A', prefix: 'm1_', scenarioIds: aScenarios.slice(5, 10) },
            { methodId: 'A', prefix: 'm1_', scenarioIds: aScenarios.slice(10, 15) },
            { methodId: 'B', prefix: 'm2_', scenarioIds: bScenarios.slice(0, 5) },
            { methodId: 'B', prefix: 'm2_', scenarioIds: bScenarios.slice(5, 10) }
          ];
          return {
            waveBatchId: waveId,
            reportPairId: 'pair',
            methodId: 'A',
            remainingScenarioCount: 24,
            hasWork: true,
            selectedMethodIds: ['A', 'B'],
            selectedScenarioIds: [...aScenarios, ...bScenarios],
            remainingScenarioCountByMethod: { A: 0, B: 24, C: 0 },
            completedMethodIds: ['A'],
            parts: partSpecs.map((part, index) => ({
              partIndex: index + 1,
              partBatchId: createHash('sha256')
                .update(`${waveId}:part:${index + 1}`)
                .digest('hex'),
              scenarioIds: [...part.scenarioIds],
              methodSlices: [{
                methodId: part.methodId,
                testMethodNamePrefix: part.prefix,
                batch: {
                  method: { methodId: part.methodId },
                  scenarioIds: [...part.scenarioIds]
                }
              }]
            })),
            warnings: []
          };
        }

        const persisted = await checkpoints.taskWaveProgress('Task');
        assert.equal(persisted.activeMethodId, 'B');
        assert.deepEqual(persisted.methodQueue, ['C']);
        assert.equal(persisted.methods.B.remainingScenarioCount, 24);
        assert.deepEqual(persisted.methods.B.completedScenarioIds, bScenarios);
        assert.deepEqual(
          persisted.methods.B.completedWaves.map((wave) => wave.remainingScenarioCount),
          [24]
        );
        return {
          waveBatchId: null,
          reportPairId: 'pair',
          methodId: 'B',
          remainingScenarioCount: 0,
          hasWork: false,
          selectedMethodIds: [],
          selectedScenarioIds: [],
          remainingScenarioCountByMethod: { B: 0, C: 0 },
          completedMethodIds: ['B', 'C'],
          parts: [],
          warnings: []
        };
      },
      async executeWave(_task, wave) {
        executions += 1;
        return {
          completedScenarioIds: [...wave.selectedScenarioIds],
          skippedScenarioIds: [],
          candidateIds: []
        };
      },
      async execute() { throw new Error('class Wave must bypass legacy method execution'); }
    }
  });

  const outcome = await runner.run(
    task(),
    ['A', 'B', 'C'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.equal(executions, 1);
  assert.deepEqual(requests[0].methods, [
    { methodId: 'A', completedScenarioIds: [], skippedScenarioIds: [] },
    { methodId: 'B', completedScenarioIds: [], skippedScenarioIds: [] },
    { methodId: 'C', completedScenarioIds: [], skippedScenarioIds: [] }
  ]);
  assert.deepEqual(requests[1].methods, [
    { methodId: 'B', completedScenarioIds: bScenarios, skippedScenarioIds: [] },
    { methodId: 'C', completedScenarioIds: [], skippedScenarioIds: [] }
  ]);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds,
    ['A', 'B', 'C']);
});

test('formalized class Wave records processed scenarios and completes without coverage-driven replan', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const requests = [];
  const waveId = createHash('sha256').update('coverage-replan-wave').digest('hex');
  const partId = createHash('sha256').update('coverage-replan-part').digest('hex');
  const candidateId = '66666666-6666-4666-8666-666666666666';
  let formalized = 0;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextClassWave(_task, request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          return {
            waveBatchId: waveId,
            reportPairId: 'pair',
            methodId: 'A',
            remainingScenarioCount: 0,
            hasWork: true,
            selectedMethodIds: ['A'],
            selectedScenarioIds: ['a-1'],
            remainingScenarioCountByMethod: { A: 0 },
            completedMethodIds: ['A'],
            parts: [{
              partIndex: 1,
              partBatchId: partId,
              scenarioIds: ['a-1'],
              methodSlices: [{
                methodId: 'A',
                testMethodNamePrefix: 'm1_',
                batch: { method: { methodId: 'A' }, scenarioIds: ['a-1'] }
              }]
            }],
            warnings: []
          };
        }
        return {
          waveBatchId: null,
          reportPairId: 'pair-after-refresh',
          methodId: 'A',
          remainingScenarioCount: 0,
          hasWork: false,
          selectedMethodIds: [],
          selectedScenarioIds: [],
          remainingScenarioCountByMethod: { A: 0 },
          completedMethodIds: ['A'],
          parts: [],
          warnings: []
        };
      },
      async executeWave() {
        return {
          completedScenarioIds: ['a-1'],
          skippedScenarioIds: [],
          candidateIds: [candidateId],
          bundles: [{ sourceMethodId: 'A', code: 'class Generated {}' }]
        };
      },
      async formalizeWaveGroup() {
        formalized += 1;
      },
      async execute() { throw new Error('class Wave must bypass legacy method execution'); }
    }
  });

  const outcome = await runner.run(
    task(),
    ['A'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.equal(formalized, 1);
  assert.equal(requests.length, 1,
    'a completed planned scenario must not be scheduled again because coverage is below 100%');
  const progress = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(progress.methods.A.completedScenarioIds, ['a-1']);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, ['A']);
});

test('class Wave checkpoint atomically clears stale scenario ledger and requeues after coverage refresh', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['A', 'B']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const active = classWaveCheckpoint(
    createHash('sha256').update('atomic-coverage-replan').digest('hex'),
    [{ methodId: 'A', scenarioIds: ['a-1'] }],
    ['A']
  );
  await checkpoints.saveActiveMethodWave('Task', active);

  await checkpoints.commitActiveClassWave('Task', {
    waveId: active.waveId,
    completedScenarioIds: ['a-1'],
    skippedScenarioIds: [],
    remainingScenarioCount: 0,
    candidateIds: ['66666666-6666-4666-8666-666666666666'],
    planningIncomplete: false,
    replanSelectedMethodsAfterCoverageRefresh: true
  });

  const progress = await checkpoints.taskWaveProgress('Task');
  assert.equal(progress.activeMethodId, null);
  assert.equal(progress.activeWave, null);
  assert.deepEqual(progress.methodQueue, ['B', 'A']);
  assert.deepEqual(progress.methods.A.completedScenarioIds, []);
  assert.deepEqual(progress.methods.A.skippedScenarioIds, []);
  assert.equal(progress.methods.A.remainingScenarioCount, null);
  assert.deepEqual(progress.methods.A.completedWaves[0].completedScenarioIds, ['a-1'],
    'the completed Wave remains available as audit history');
});

test('coverage refresh clears stale scenario ledgers for every unfinished method without changing FIFO or Wave history', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['A', 'B']
  });

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const first = classWaveCheckpoint(
    createHash('sha256').update('old-report-class-wave').digest('hex'),
    [{ methodId: 'A', scenarioIds: ['a-old'] },
      { methodId: 'B', scenarioIds: ['b-stable'] }]
  );
  await checkpoints.saveActiveMethodWave('Task', first);
  await checkpoints.commitActiveClassWave('Task', {
    waveId: first.waveId,
    completedScenarioIds: ['a-old', 'b-stable'],
    skippedScenarioIds: [],
    remainingScenarioCount: 0,
    candidateIds: [],
    planningIncomplete: false
  });

  const beforeRefresh = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(beforeRefresh.methodQueue, ['A', 'B']);
  assert.deepEqual(beforeRefresh.methods.B.completedScenarioIds, ['b-stable']);
  assert.equal(beforeRefresh.methods.B.nextWaveIndex, 2);
  assert.equal(beforeRefresh.methods.B.completedWaves.length, 1);

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const refreshed = classWaveCheckpoint(
    createHash('sha256').update('new-report-class-wave').digest('hex'),
    [{ methodId: 'A', scenarioIds: ['a-refresh'] }]
  );
  refreshed.waveIndex = 2;
  await checkpoints.saveActiveMethodWave('Task', refreshed);
  await checkpoints.commitActiveClassWave('Task', {
    waveId: refreshed.waveId,
    completedScenarioIds: ['a-refresh'],
    skippedScenarioIds: [],
    remainingScenarioCount: 0,
    candidateIds: [],
    planningIncomplete: false,
    replanSelectedMethodsAfterCoverageRefresh: true
  });

  const afterRefresh = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(afterRefresh.methodQueue, ['B', 'A']);
  assert.deepEqual(afterRefresh.methods.B.completedScenarioIds, []);
  assert.deepEqual(afterRefresh.methods.B.skippedScenarioIds, []);
  assert.equal(afterRefresh.methods.B.remainingScenarioCount, null);
  assert.equal(afterRefresh.methods.B.nextWaveIndex, 2);
  assert.equal(afterRefresh.methods.B.completedWaves.length, 1);

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'B');
  const replanned = classWaveCheckpoint(
    createHash('sha256').update('replanned-stable-scenario').digest('hex'),
    [{ methodId: 'B', scenarioIds: ['b-stable'] }]
  );
  replanned.methodId = 'B';
  replanned.wave.methodId = 'B';
  replanned.waveIndex = 2;
  await checkpoints.saveActiveMethodWave('Task', replanned);
  assert.deepEqual(
    (await checkpoints.taskWaveProgress('Task')).activeWave.selectedScenarioIds,
    ['b-stable']
  );
});

test('restart resumes the persisted class Wave without requesting or executing its Parts again', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['A', 'B']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const active = classWaveCheckpoint(
    createHash('sha256').update('persisted-class-wave').digest('hex'),
    [{ methodId: 'A', scenarioIds: ['a-1', 'a-2'] },
      { methodId: 'B', scenarioIds: ['b-1'] }],
    ['A', 'B']
  );
  await checkpoints.saveActiveMethodWave('Task', active);

  const restored = new ClassTaskCheckpointService({
    storagePath,
    taskState: state,
    clock: () => new Date('2026-08-09T01:00:00.000Z')
  });
  let executed = 0;
  const runner = new ClassTaskRunnerService({
    checkpoints: restored,
    methodExecution: {
      async nextClassWave() {
        throw new Error('persisted class Wave must not be requested again');
      },
      async executeWave(_task, wave) {
        executed += 1;
        assert.deepEqual(wave, active.wave);
        return {
          completedScenarioIds: [...wave.selectedScenarioIds],
          skippedScenarioIds: [],
          candidateIds: []
        };
      },
      async execute() { throw new Error('legacy execution must not run'); }
    }
  });

  const outcome = await runner.run(
    state.snapshot(),
    ['A', 'B'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.equal(executed, 1);
  const progress = await restored.taskWaveProgress('Task');
  assert.equal(progress.activeWave, null);
  assert.deepEqual(progress.methods.A.completedScenarioIds, ['a-1', 'a-2']);
  assert.deepEqual(progress.methods.B.completedScenarioIds, ['b-1']);
});

test('class Wave recovery rejects a scenario already processed by its actual source method', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['A', 'B']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const first = classWaveCheckpoint(
    createHash('sha256').update('first-class-wave').digest('hex'),
    [{ methodId: 'B', scenarioIds: ['b-processed'] }]
  );
  await checkpoints.saveActiveMethodWave('Task', first);
  await checkpoints.commitActiveClassWave('Task', {
    waveId: first.waveId,
    completedScenarioIds: ['b-processed'],
    skippedScenarioIds: [],
    remainingScenarioCount: 0,
    candidateIds: [],
    planningIncomplete: false
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const repeated = classWaveCheckpoint(
    createHash('sha256').update('second-class-wave').digest('hex'),
    [{ methodId: 'A', scenarioIds: ['a-new'] },
      { methodId: 'B', scenarioIds: ['b-processed'] }]
  );

  await assert.rejects(
    checkpoints.saveActiveMethodWave('Task', repeated),
    /must not repeat processed scenarios/
  );
});

test('runner preserves a failed Wave for retry without completing its method', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  const remaining = new Map([
    ['A', 55],
    ['B', 10],
    ['C', 40]
  ]);
  const order = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave(_task, methodId, request) {
        const persisted = await checkpoints.taskWaveProgress('Task');
        assert.equal(persisted.activeMethodId, methodId);
        assert.equal(persisted.activeWave, null);
        const before = remaining.get(methodId);
        const count = Math.min(before, 15);
        const after = before - count;
        remaining.set(methodId, after);
        order.push(`${methodId}${count}`);
        assert.deepEqual(
          [...request.completedScenarioIds, ...request.skippedScenarioIds].sort(),
          [
            ...(persisted.methods[methodId]?.completedScenarioIds ?? []),
            ...(persisted.methods[methodId]?.skippedScenarioIds ?? [])
          ].sort()
        );
        const selectedScenarioIds = Array.from(
          { length: count },
          (_, index) => `${methodId}-scenario-${before - count + index + 1}`
        );
        return {
          waveBatchId: createHash('sha256')
            .update(`${methodId}:${before}`)
            .digest('hex'),
          reportPairId: CATALOG_IDENTITY.reportPairId,
          methodId,
          hasWork: true,
          selectedScenarioIds,
          remainingScenarioCount: after,
          parts: Array.from({ length: Math.ceil(count / 3) }, (_, partOffset) => {
            const scenarioIds = selectedScenarioIds.slice(partOffset * 3, partOffset * 3 + 3);
            return {
              partIndex: partOffset + 1,
              partBatchId: createHash('sha256')
                .update(`${methodId}:${before}:${partOffset}`)
                .digest('hex'),
              scenarioIds
            };
          }),
          warnings: []
        };
      },
      async executeWave(_task, wave) {
        if (wave.methodId === 'B') {
          return {
            completedScenarioIds: [],
            skippedScenarioIds: [...wave.selectedScenarioIds],
            candidateIds: [],
            modelFailure: {
              code: 'MODEL_RATE_LIMITED',
              message: '已达到大模型平台的请求频率限制。',
              stage: 'generation'
            }
          };
        }
        const skippedScenarioIds = wave.methodId === 'A' && wave.remainingScenarioCount === 25
          ? wave.selectedScenarioIds.slice(-3)
          : [];
        return {
          completedScenarioIds: wave.selectedScenarioIds.filter(
            (scenarioId) => !skippedScenarioIds.includes(scenarioId)
          ),
          skippedScenarioIds,
          candidateIds: []
        };
      },
      async execute() {
        throw new Error('legacy method execution must not run in Wave mode');
      }
    }
  });

  await assert.rejects(
    runner.run(
      task(),
      ['A', 'B', 'C'],
      CATALOG_IDENTITY,
      new AbortController().signal
    ),
    (error) => {
      assert.equal(error.name, 'MethodGenerationRequestError');
      assert.equal(error.code, 'MODEL_RATE_LIMITED');
      return true;
    }
  );

  assert.deepEqual(order, ['A15', 'B10']);
  const wave = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(wave.methodQueue, ['C', 'A']);
  assert.equal(wave.activeMethodId, 'B');
  assert.notEqual(wave.activeWave, null);
  assert.equal(wave.methods.A.completedScenarioIds.length, 15);
  assert.equal(wave.methods.A.skippedScenarioIds.length, 0);
  assert.equal(wave.methods.B.completedScenarioIds.length, 0);
  assert.equal(wave.methods.B.skippedScenarioIds.length, 0);
  assert.equal(state.snapshot().state, 'RUNNING');
  assert.equal(state.snapshot().lastError?.code, 'MODEL_RATE_LIMITED');
  assert.equal(state.snapshot().currentMethodIndex, -1);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds, []);
});

test('runner preserves historical processed scenarios after reportPairId changes', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 1,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a-1'],
    remainingScenarioCount: 1,
    wave: null,
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a-1'],
      status: 'SUCCEEDED',
      eventSequence: 1,
      childSessionId: null,
      candidateId: '11111111-1111-4111-8111-111111111111',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'e'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  await checkpoints.commitActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    completedScenarioIds: ['scenario-a-1'],
    skippedScenarioIds: [],
    remainingScenarioCount: 1,
    candidateIds: []
  });

  const requests = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave(_task, methodId, request) {
        requests.push(structuredClone(request));
        return {
          waveBatchId: 'c'.repeat(64),
          reportPairId: newIdentity.reportPairId,
          methodId,
          hasWork: true,
          selectedScenarioIds: ['scenario-a-2'],
          remainingScenarioCount: 0,
          parts: [{
            partIndex: 1,
            partBatchId: 'd'.repeat(64),
            scenarioIds: ['scenario-a-2']
          }],
          warnings: []
        };
      },
      async executeWave(_task, wave) {
        return {
          completedScenarioIds: [...wave.selectedScenarioIds],
          skippedScenarioIds: [],
          candidateIds: []
        };
      },
      async execute() {
        throw new Error('legacy execution must not run in Wave mode');
      }
    }
  });

  const outcome = await runner.run(
    task(),
    ['A'],
    newIdentity,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.deepEqual(requests, [{
    reportPairId: newIdentity.reportPairId,
    completedScenarioIds: ['scenario-a-1'],
    skippedScenarioIds: [],
    maxScenarios: 25,
    partSize: 5
  }]);
});

test('runner prioritizes one selected data-class group even when Wave ports are available', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const events = [];
  const methodIds = ['method-get-name', 'method-set-name', 'method-to-string'];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async planExecutionGroups(_task, pendingMethodIds) {
        events.push(`plan:${pendingMethodIds.join(',')}`);
        return [[...pendingMethodIds]];
      },
      async executeGroup(_task, selectedMethodIds) {
        events.push(`group:${selectedMethodIds.join(',')}`);
        return true;
      },
      async nextWave() {
        throw new Error('selected data-class methods must not enter Wave generation');
      },
      async executeWave() {
        throw new Error('selected data-class methods must not execute a Wave');
      },
      async execute() {
        throw new Error('selected data-class methods must not fall back to single-method generation');
      }
    }
  });

  assert.equal(await runner.run(
    task('Task', 'RUNNING', {
      selectionMode: 'EXPLICIT',
      selectedMethodIds: methodIds,
      methodOrder: methodIds
    }),
    methodIds,
    CATALOG_IDENTITY,
    new AbortController().signal
  ), 'COMPLETED');
  assert.deepEqual(events, [
    'plan:method-get-name,method-set-name,method-to-string',
    'group:method-get-name,method-set-name,method-to-string'
  ]);
  assert.deepEqual(
    (await checkpoints.taskProgress('Task')).completedMethodIds,
    methodIds
  );
});

test('runner lets a one-method data-class group bypass Wave generation', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const events = [];
  const methodId = 'method-equals';
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async planExecutionGroups() { return [[methodId]]; },
      async executeGroup() {
        events.push('group');
        return true;
      },
      async nextWave() { throw new Error('one selected VO method must not enter Wave'); },
      async executeWave() { throw new Error('one selected VO method must not execute Wave'); },
      async execute() { throw new Error('one selected VO method must not use legacy generation'); }
    }
  });

  assert.equal(await runner.run(
    task(),
    [methodId],
    CATALOG_IDENTITY,
    new AbortController().signal
  ), 'COMPLETED');
  assert.deepEqual(events, ['group']);
});

test('runner resumes the persisted Analyzer Wave without selecting the same scenarios again', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const methodId = 'A';
  const wave = {
    waveBatchId: 'a'.repeat(64),
    reportPairId: CATALOG_IDENTITY.reportPairId,
    methodId,
    hasWork: true,
    selectedScenarioIds: ['scenario-a-1'],
    remainingScenarioCount: 0,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a-1']
    }],
    warnings: []
  };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: [methodId]
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), methodId);
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: wave.waveBatchId,
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId,
    waveIndex: 1,
    selectedScenarioIds: [...wave.selectedScenarioIds],
    remainingScenarioCount: 0,
    wave,
    parts: [{
      partIndex: 1,
      partBatchId: wave.parts[0].partBatchId,
      scenarioIds: [...wave.parts[0].scenarioIds],
      status: 'PENDING',
      eventSequence: 0,
      childSessionId: null,
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null
    }]
  });
  let executed = 0;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave() {
        throw new Error('persisted Wave recovery must not call Analyzer nextWave');
      },
      async executeWave(_task, recoveredWave) {
        executed += 1;
        assert.deepEqual(recoveredWave, wave);
        return {
          completedScenarioIds: ['scenario-a-1'],
          skippedScenarioIds: [],
          candidateIds: []
        };
      }
    }
  });

  assert.equal(await runner.run(
    task(),
    [methodId],
    CATALOG_IDENTITY,
    new AbortController().signal
  ), 'COMPLETED');
  assert.equal(executed, 1);
});

test('runner formalizes a passing Wave before committing its Wave checkpoint', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const events = [];
  const requests = [];
  const methodId = 'method-1';
  const waveId = createHash('sha256').update('wave-1').digest('hex');
  const bundle = {
    methodId,
    sourceMethodId: methodId,
    waveIndex: 1,
    hasRemainingScenarios: false,
    methodName: 'sourceMethod',
    displaySignature: 'public void sourceMethod()',
    jacocoOrder: 0,
    code: 'class TaskTmp1Test {}',
    ordinaryTestMethodCount: 1,
    passedTestMethods: ['coversPath'],
    sourceBatchIds: ['11111111-1111-4111-8111-111111111111']
  };
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async nextWave(_task, _methodId, request) {
        requests.push(structuredClone(request));
        if (requests.length > 1) {
          return {
            waveBatchId: null,
            reportPairId: CATALOG_IDENTITY.reportPairId,
            methodId,
            hasWork: false,
            selectedScenarioIds: [],
            remainingScenarioCount: 0,
            parts: [],
            warnings: []
          };
        }
        return {
          waveBatchId: waveId,
          reportPairId: CATALOG_IDENTITY.reportPairId,
          methodId,
          hasWork: true,
          selectedScenarioIds: ['scenario-1'],
          remainingScenarioCount: 0,
          parts: [{
            partIndex: 1,
            partBatchId: createHash('sha256').update('part-1').digest('hex'),
            scenarioIds: ['scenario-1']
          }],
          warnings: []
        };
      },
      async executeWave() {
        events.push('execute-wave');
        return {
          completedScenarioIds: ['scenario-1'],
          skippedScenarioIds: [],
          candidateIds: [...bundle.sourceBatchIds],
          bundle
        };
      },
      async formalizeWave(_task, actualBundle) {
        const waveState = await checkpoints.taskWaveProgress('Task');
        assert.equal(waveState.activeWave?.waveId, waveId);
        assert.deepEqual(waveState.methods[methodId]?.completedWaves ?? [], []);
        assert.deepEqual(actualBundle, bundle);
        events.push('formalize-wave');
      },
      async execute() {
        throw new Error('legacy execution must not run');
      },
      async finalizeRun() {
        events.push('finalize-run');
      }
    }
  });

  await runner.run(
    task('Task', 'RUNNING', {
      selectionMode: 'EXPLICIT',
      selectedMethodIds: [methodId],
      methodOrder: [methodId]
    }),
    [methodId],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.deepEqual(events, ['execute-wave', 'formalize-wave', 'finalize-run']);
  assert.equal(requests.length, 1,
    'a passing completed Wave must not rerun the same planned scenario after JaCoCo refresh');
  assert.deepEqual(
    (await checkpoints.taskWaveProgress('Task')).methods[methodId].completedScenarioIds,
    ['scenario-1']
  );
  assert.equal(
    (await checkpoints.taskWaveProgress('Task')).methods[methodId].completedWaves.length,
    1
  );
});

test('atomic scenario-batch progress is published without advancing completed methods and clears at the boundary', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);

  await checkpoints.beginAtomicStep('Task', 'MODEL_GENERATION', {
    methodCount: 4,
    scenarioCount: 15
  });

  assert.equal(state.snapshot().currentMethodIndex, -1);
  assert.deepEqual(state.snapshot().activeGenerationBatch, {
    methodCount: 4,
    scenarioCount: 15
  });

  await checkpoints.completeAtomicStep('Task', 'MODEL_GENERATION');
  assert.equal(state.snapshot().activeGenerationBatch, null);
});

test('model usage from resumed sessions and different model configs accumulates until a new run', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);

  await checkpoints.addModelUsage('Task', {
    tokenUsage: { inputTokens: 1_200, cachedInputTokens: 200, outputTokens: 300, totalTokens: 1_500 },
    modelCallCount: 1,
    usageReportedCallCount: 1
  });
  await checkpoints.addModelUsage('Task', {
    tokenUsage: { inputTokens: 800, cachedInputTokens: 100, outputTokens: 200, totalTokens: 1_000 },
    modelCallCount: 1,
    usageReportedCallCount: 1
  });
  await checkpoints.addModelUsage('Task', {
    tokenUsage: null,
    modelCallCount: 1,
    usageReportedCallCount: 0
  });

  assert.deepEqual(state.snapshot().tokenUsage, {
    inputTokens: 2_000,
    cachedInputTokens: 300,
    outputTokens: 500,
    totalTokens: 2_500
  });
  assert.equal(state.snapshot().modelCallCount, 3);
  assert.equal(state.snapshot().usageReportedCallCount, 2);

  await checkpoints.prepareRun('Task', { reset: false });
  assert.equal(state.snapshot().modelCallCount, 3);
  await checkpoints.prepareRun('Task', { reset: true });
  assert.equal(state.snapshot().modelCallCount, 0);
  assert.equal(state.snapshot().usageReportedCallCount, 0);
  assert.equal(state.snapshot().tokenUsage, null);
});

test('runner commits a verified scenario batch without invoking the single-method path', async (t) => {
  const runningTask = task('Task', 'RUNNING', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['first', 'second', 'third'],
    methodOrder: ['first', 'second', 'third']
  });
  const { checkpoints, state } = await checkpointsFor(t, runningTask);
  const events = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async planExecutionGroups(_task, pendingMethodIds) {
        events.push(`plan:${pendingMethodIds.join(',')}`);
        return [['first', 'second'], ['third']];
      },
      async executeGroup(_task, methodIds, methodCheckpoints) {
        events.push(`group:${methodIds.join(',')}`);
        assert.deepEqual(Object.keys(methodCheckpoints), ['first', 'second']);
        return true;
      },
      async formalizeCompletedMethods(_task, methodIds) {
        const progress = await checkpoints.taskProgress('Task');
        assert.deepEqual(
          methodIds.map((methodId) => progress.completedMethodIds.includes(methodId)),
          methodIds.map(() => true),
          'group methods must be durable before their TMP files are formalized'
        );
        events.push(`formalize:${methodIds.join(',')}`);
      },
      async execute(_task, methodId) {
        events.push(`single:${methodId}`);
        return null;
      }
    }
  });

  const outcome = await runner.run(
    runningTask,
    ['first', 'second', 'third'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(outcome, 'COMPLETED');
  assert.deepEqual(events, [
    'plan:first,second,third',
    'group:first,second',
    'formalize:first,second',
    'single:third',
    'formalize:third'
  ]);
  assert.deepEqual(
    state.history()
      .map((snapshot) => snapshot.currentMethodIndex)
      .filter((index) => index >= 0),
    [1, 2]
  );
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds,
    ['first', 'second', 'third']);
});

test('runner safely falls back to the existing path when a scenario batch is not verified', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const events = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async planExecutionGroups() { return [['first', 'second']]; },
      async executeGroup() {
        events.push('group');
        return false;
      },
      async execute(_task, methodId) {
        events.push(`single:${methodId}`);
        return null;
      }
    }
  });

  await runner.run(
    task(),
    ['first', 'second'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.deepEqual(events, ['group', 'single:first', 'single:second']);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds,
    ['first', 'second']);
});

test('public task progress advances only after each method commit succeeds', async (t) => {
  const runningTask = task('Task', 'RUNNING', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['first', 'second'],
    methodOrder: ['first', 'second']
  });
  const { checkpoints, state } = await checkpointsFor(t, runningTask);
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const firstDidStart = new Promise((resolve) => { firstStarted = resolve; });
  let secondStarted;
  const secondDidStart = new Promise((resolve) => { secondStarted = resolve; });
  let releaseSecond;
  const secondMayFinish = new Promise((resolve) => { releaseSecond = resolve; });
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) {
        if (methodId === 'first') {
          firstStarted();
          await firstMayFinish;
        } else {
          secondStarted();
          await secondMayFinish;
        }
        return null;
      }
    }
  });

  const run = runner.run(
    runningTask,
    ['first', 'second'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );
  await firstDidStart;
  assert.equal(state.snapshot().currentMethodIndex, -1);

  releaseFirst();
  await secondDidStart;
  assert.equal(state.snapshot().currentMethodIndex, 0);

  releaseSecond();
  await run;
  assert.equal(state.snapshot().currentMethodIndex, 1);
});

test('runner immediately formalizes each method after its checkpoint becomes durable', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const events = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) {
        events.push(`execute:${methodId}`);
        return {
          methodId,
          code: 'class TaskTmp1Test {}',
          ordinaryTestMethodCount: 1,
          passedTestMethods: ['coversPath'],
          sourceBatchIds: ['batch-1']
        };
      },
      async formalizeCompletedMethods(_task, methodIds) {
        const progress = await checkpoints.taskProgress('Task');
        assert.equal(
          progress.completedMethodIds.includes(methodIds[0]),
          true,
          'a method must be durable before its TMP files are formalized'
        );
        events.push(`formalize:${methodIds.join(',')}`);
      },
      async finalizeRun(_task, methodOrder) {
        const progress = await checkpoints.taskProgress('Task');
        assert.deepEqual(progress.completedMethodIds, ['first', 'second']);
        assert.deepEqual(methodOrder, ['first', 'second']);
        events.push('finalize:first,second');
      }
    }
  });

  await runner.run(
    task(),
    ['first', 'second'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.deepEqual(events, [
    'execute:first',
    'formalize:first',
    'execute:second',
    'formalize:second',
    'finalize:first,second'
  ]);
});

test('runner resumes from completed method identities without gaps or duplicate execution', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['one', 'two', 'three', 'four']
  });
  await checkpoints.commitMethod('Task', 'one', CATALOG_IDENTITY);
  await checkpoints.commitMethod('Task', 'two', CATALOG_IDENTITY);
  await assert.rejects(
    checkpoints.commitMethod('Task', 'four', CATALOG_IDENTITY),
    /next method checkpoint must be three/i
  );
  const executed = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: { async execute(_task, methodId) { executed.push(methodId); return null; } }
  });

  await runner.run(
    task(),
    ['one', 'two', 'three', 'four'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.deepEqual(executed, ['three', 'four']);
});

test('public task progress includes recovered completed methods after the run order changes', async (t) => {
  const runningTask = task('Task', 'RUNNING', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['new', 'old'],
    methodOrder: ['new', 'old']
  });
  const { checkpoints, state } = await checkpointsFor(t, runningTask);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['old']
  });
  await checkpoints.commitMethod('Task', 'old', oldIdentity);
  let progressBeforeNewMethod = null;
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute() {
        progressBeforeNewMethod = state.snapshot().currentMethodIndex;
        return null;
      }
    }
  });

  await runner.run(
    state.snapshot(),
    ['new', 'old'],
    newIdentity,
    new AbortController().signal
  );

  assert.equal(progressBeforeNewMethod, 0);
  assert.equal(state.snapshot().currentMethodIndex, 1);
});

test('runner keeps recovered TMP files until remaining methods finish and then finalizes once', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['one', 'two']
  });
  await checkpoints.commitMethod('Task', 'one', CATALOG_IDENTITY);
  const events = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) {
        events.push(`execute:${methodId}`);
        return null;
      },
      async cleanupCompletedMethod(_task, methodId) {
        events.push(`cleanup:${methodId}`);
      },
      async finalizeRun(_task, methodOrder) {
        events.push(`finalize:${methodOrder.join(',')}`);
      }
    }
  });

  await runner.run(
    task(),
    ['one', 'two'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.deepEqual(events, ['execute:two', 'finalize:one,two']);
});

test('pause after the last method keeps finalization pending and resume reports an empty formal result', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  const events = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) {
        events.push(`execute:${methodId}`);
        await checkpoints.requestPause('Task');
        return null;
      },
      async finalizeRun(_task, methodOrder) {
        events.push(`finalize:${methodOrder.join(',')}`);
      }
    }
  });

  const paused = await runner.run(
    state.snapshot(),
    ['only'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(paused, 'PAUSED');
  assert.equal(state.snapshot().state, 'PAUSED');
  assert.deepEqual(events, ['execute:only']);

  await checkpoints.transitionState('Task', 'RUNNING');
  const completed = await runner.run(
    state.snapshot(),
    ['only'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.equal(completed, 'NO_FORMAL_TEST_FILE');
  assert.deepEqual(events, ['execute:only', 'finalize:only']);
});

test('cancellation during methodCheckpoint prevents method execution', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  let markCheckpointStarted;
  const checkpointStarted = new Promise((resolve) => { markCheckpointStarted = resolve; });
  let releaseCheckpoint;
  const checkpointBlocked = new Promise((resolve) => { releaseCheckpoint = resolve; });
  const originalMethodCheckpoint = checkpoints.methodCheckpoint.bind(checkpoints);
  checkpoints.methodCheckpoint = async (...args) => {
    markCheckpointStarted();
    await checkpointBlocked;
    return originalMethodCheckpoint(...args);
  };
  const executionAttempts = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) { executionAttempts.push(methodId); return null; }
    }
  });
  const controller = new AbortController();
  const run = runner.run(
    state.snapshot(),
    ['method'],
    CATALOG_IDENTITY,
    controller.signal
  );
  await checkpointStarted;

  controller.abort(new Error('cancelled while method checkpoint was loading'));
  releaseCheckpoint();

  await assert.rejects(run, /cancelled while method checkpoint was loading/);
  assert.deepEqual(executionAttempts, []);
});

test('termination during methodCheckpoint prevents method execution', async (t) => {
  const { checkpoints, state } = await checkpointsFor(t);
  let markCheckpointStarted;
  const checkpointStarted = new Promise((resolve) => { markCheckpointStarted = resolve; });
  let releaseCheckpoint;
  const checkpointBlocked = new Promise((resolve) => { releaseCheckpoint = resolve; });
  const originalMethodCheckpoint = checkpoints.methodCheckpoint.bind(checkpoints);
  checkpoints.methodCheckpoint = async (...args) => {
    markCheckpointStarted();
    await checkpointBlocked;
    return originalMethodCheckpoint(...args);
  };
  const executionAttempts = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) { executionAttempts.push(methodId); return null; }
    }
  });
  const run = runner.run(
    state.snapshot(),
    ['method'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );
  await checkpointStarted;

  await checkpoints.requestTermination('Task');
  releaseCheckpoint();

  await assert.rejects(run, { name: 'ClassTaskTerminationBoundaryError' });
  assert.deepEqual(executionAttempts, []);
});

test('restart reconciles reordered and inserted catalogs by completed method identity', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', { reset: true });
  const attempts = [];
  let failSecond = true;
  const execution = {
    async execute(_task, methodId) {
      attempts.push(methodId);
      if (methodId === 'second' && failSecond) {
        failSecond = false;
        throw new Error('simulated process exit');
      }
      return null;
    }
  };
  const initialRunner = new ClassTaskRunnerService({ checkpoints, methodExecution: execution });

  await assert.rejects(
    initialRunner.run(
      state.snapshot(),
      ['first', 'second'],
      { analysisSessionId: 'analysis-a', reportPairId: 'pair-a' },
      new AbortController().signal
    ),
    /simulated process exit/
  );

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const restoredRunner = new ClassTaskRunnerService({ checkpoints: restored, methodExecution: execution });
  await restoredRunner.run(
    state.snapshot(),
    ['inserted', 'second', 'first'],
    { analysisSessionId: 'analysis-b', reportPairId: 'pair-b' },
    new AbortController().signal
  );

  assert.deepEqual(attempts, ['first', 'second', 'inserted', 'second']);
  assert.deepEqual(await restored.taskProgress('Task'), {
    catalogIdentity: { analysisSessionId: 'analysis-b', reportPairId: 'pair-b' },
    resolvedMethodOrder: ['inserted', 'second', 'first'],
    completedMethodIds: ['first', 'inserted', 'second'],
    methods: {},
    ragRun: null
  });
});

test('a new catalog identity keeps completed methods but drops unfinished batch progress', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['completed', 'partial']
  });
  const batch = (methodId) => ({
    taskId: 'Task',
    methodId,
    batchId: `batch-${methodId}`,
    batchIndex: 1,
    completedTestMethodPlanIds: [`plan-${methodId}`],
    outcome: 'PASSED',
    candidateVersion: 1,
    tmpFilePath: `D:\\workspace\\${methodId}Test.java`,
    tmpFileSha256: 'd'.repeat(64),
    ordinaryTestMethodCount: 1
  });
  await checkpoints.commitBatch(batch('completed'));
  await checkpoints.commitMethod('Task', 'completed', oldIdentity);
  await checkpoints.commitBatch(batch('partial'));

  const reconciled = await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['partial', 'completed']
  });

  assert.deepEqual(reconciled.completedMethodIds, ['completed']);
  assert.equal(reconciled.methods.completed.completedBatches.length, 1);
  assert.equal(reconciled.methods.partial, undefined);
  await assert.rejects(
    checkpoints.commitMethod('Task', 'partial', oldIdentity),
    /stale catalog identity/i
  );
  await checkpoints.commitMethod('Task', 'partial', newIdentity);
});

test('batch checkpoints survive service restart and identical retries do not duplicate them', async (t) => {
  const initial = task();
  const { checkpoints, state, storagePath } = await checkpointsFor(t, initial);
  const batch = {
    taskId: 'Task', methodId: 'method', batchId: 'batch-1', batchIndex: 1,
    completedTestMethodPlanIds: ['plan-1', 'plan-2'], outcome: 'PASSED', candidateVersion: 2,
    tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java', tmpFileSha256: 'a'.repeat(64),
    ordinaryTestMethodCount: 2
  };
  await checkpoints.commitBatch(batch);
  await checkpoints.commitBatch(structuredClone(batch));

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const method = await restored.methodCheckpoint('Task', 'method');

  assert.equal(method.completedBatches.length, 1);
  assert.deepEqual(method.completedTestMethodPlanIds, ['plan-1', 'plan-2']);
  await assert.rejects(
    restored.commitBatch({ ...batch, outcome: 'DROPPED' }),
    /conflicting batch checkpoint/i
  );
});

test('batch checkpoints accept candidate versions beyond the former five-repair limit', async (t) => {
  const { checkpoints } = await checkpointsFor(t);

  await checkpoints.commitBatch({
    taskId: 'Task',
    methodId: 'method',
    batchId: 'batch-1',
    batchIndex: 1,
    completedTestMethodPlanIds: ['plan-1'],
    outcome: 'PASSED',
    candidateVersion: 42,
    tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java',
    tmpFileSha256: 'a'.repeat(64),
    ordinaryTestMethodCount: 1
  });

  const checkpoint = await checkpoints.methodCheckpoint('Task', 'method');
  assert.equal(checkpoint.completedBatches[0].candidateVersion, 42);
});

test('an in-progress TMP candidate survives restart and is cleared atomically by batch commit', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const methodId = 'b'.repeat(64);
  const batchId = 'c'.repeat(64);
  const code = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskTmp1Test {',
    '  @Test void candidate() {}',
    '}',
    ''
  ].join('\n');
  const digest = createHash('sha256').update(code, 'utf8').digest('hex');
  const { checkpoints, state, storagePath } = await checkpointsFor(
    t,
    task(taskId)
  );
  const inProgressBatch = {
    taskId,
    methodId,
    batchId,
    batchIndex: 1,
    sourceSha256: 'd'.repeat(64),
    startRequest: {
      clientRequestId: '22222222-2222-4222-8222-222222222222',
      classTaskId: taskId,
      methodId,
      batchId,
      batchIndex: 1,
      outputTestClassName: 'TaskTmp1Test',
      expectedPackageName: 'example',
      buildToolchain: { javaVersion: '21', mavenVersion: '3.9.9' },
      batch: {
        hasWork: true,
        methodId,
        batchId,
        plannedTestMethods: 1
      },
      captureModelCalls: true,
      repairAttemptLimit: 5,
      unlimitedRepair: false
    },
    candidate: {
      candidateId: '33333333-3333-4333-8333-333333333333',
      candidateVersion: 2,
      repairAttempt: 1,
      methodId,
      batchId,
      batchIndex: 1,
      testCode: code,
      generatedCodeSha256: digest,
      outputTestClassName: 'TaskTmp1Test',
      ordinaryTestMethodCount: 1,
      usage: null
    },
    tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java',
    tmpFileSha256: digest
  };

  await checkpoints.saveInProgressBatch(inProgressBatch);
  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  assert.deepEqual(
    (await restored.methodCheckpoint(taskId, methodId)).inProgressBatch,
    inProgressBatch
  );

  await restored.commitBatch({
    taskId,
    methodId,
    batchId,
    batchIndex: 1,
    completedTestMethodPlanIds: ['plan-1'],
    outcome: 'PASSED',
    candidateVersion: 2,
    tmpFilePath: inProgressBatch.tmpFilePath,
    tmpFileSha256: digest,
    ordinaryTestMethodCount: 1
  });

  const committed = await restored.methodCheckpoint(taskId, methodId);
  assert.equal(committed.inProgressBatch, undefined);
  assert.equal(committed.completedBatches.length, 1);
});

test('commitBatch rejects gaps and completed-plan rollback before writing', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const base = {
    taskId: 'Task', methodId: 'method', batchId: 'batch-1', batchIndex: 1,
    completedTestMethodPlanIds: ['plan-1'], outcome: 'PASSED', candidateVersion: 1,
    tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java', tmpFileSha256: 'b'.repeat(64),
    ordinaryTestMethodCount: 1
  };
  await checkpoints.commitBatch(base);
  await assert.rejects(
    checkpoints.commitBatch({ ...base, batchId: 'batch-3', batchIndex: 3, completedTestMethodPlanIds: ['plan-1', 'plan-3'] }),
    /next batch index/i
  );
  await assert.rejects(
    checkpoints.commitBatch({ ...base, batchId: 'batch-2', batchIndex: 2, completedTestMethodPlanIds: ['plan-2'] }),
    /preserve completed plan ids/i
  );
});

test('RAG task-run identity and sorted revocations survive restart until the matching run clears', async (t) => {
  const taskRunId = '11111111-1111-4111-8111-111111111112';
  const otherTaskRunId = '22222222-2222-4222-8222-222222222222';
  const { checkpoints, state, storagePath } = await checkpointsFor(t);

  await checkpoints.saveRagRun('Task', {
    taskRunId,
    revokedFqns: []
  });
  await checkpoints.mergeRagRevocations('Task', taskRunId, [
    'com.example.Zeta',
    'com.example.Alpha',
    'com.example.Zeta'
  ]);

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  assert.deepEqual((await restored.taskProgress('Task')).ragRun, {
    taskRunId,
    revokedFqns: ['com.example.Alpha', 'com.example.Zeta']
  });

  await restored.clearRagRun('Task', otherTaskRunId);
  assert.equal((await restored.taskProgress('Task')).ragRun?.taskRunId, taskRunId);
  await restored.clearRagRun('Task', taskRunId);
  assert.equal((await restored.taskProgress('Task')).ragRun, null);
});

test('checkpoint v3 migration starts without an authorized RAG task run', async (t) => {
  const { state, storagePath } = await checkpointsFor(t);
  await writeFile(storagePath, JSON.stringify({
    version: 3,
    tasks: {
      Task: {
        catalogIdentity: null,
        resolvedMethodOrder: [],
        completedMethodIds: [],
        methods: {}
      }
    }
  }));
  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });

  assert.equal((await restored.taskProgress('Task')).ragRun, null);
});

test('checkpoint recovery rejects unknown persisted fields', async (t) => {
  const { state, storagePath } = await checkpointsFor(t);
  await writeFile(storagePath, JSON.stringify({
    version: 2,
    tasks: {},
    unexpected: 'must not be accepted'
  }));
  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });

  await assert.rejects(restored.taskProgress('Task'));
});

test('checkpoint v1 migration accepts only provably empty positional progress', async (t) => {
  const { state, storagePath } = await checkpointsFor(t);
  const emptyTasks = Object.fromEntries(
    ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((taskId) => [
      taskId,
      { currentMethodIndex: 0, methods: {} }
    ])
  );
  await writeFile(storagePath, JSON.stringify({
    version: 1,
    tasks: emptyTasks
  }));
  const emptyMigration = new ClassTaskCheckpointService({ storagePath, taskState: state });

  assert.deepEqual(await emptyMigration.taskProgress('Six'), {
    catalogIdentity: null,
    resolvedMethodOrder: [],
    completedMethodIds: [],
    methods: {},
    ragRun: null
  });

  await writeFile(storagePath, JSON.stringify({
    version: 1,
    tasks: { Task: { currentMethodIndex: 1, methods: {} } }
  }));
  const progressedMigration = new ClassTaskCheckpointService({ storagePath, taskState: state });
  await assert.rejects(progressedMigration.taskProgress('Task'));
});

test('checkpoint recovery rejects duplicate batches and historical plan rollback', async (t) => {
  const { state, storagePath } = await checkpointsFor(t);
  const batch = (batchId, batchIndex, completedTestMethodPlanIds) => ({
    taskId: 'Task', methodId: 'method', batchId, batchIndex,
    completedTestMethodPlanIds, outcome: 'PASSED', candidateVersion: 1,
    tmpFilePath: `D:\\workspace\\TaskTmp${batchIndex}Test.java`,
    tmpFileSha256: String(batchIndex).repeat(64), ordinaryTestMethodCount: 1
  });
  const invalidMethods = [
    {
      completedBatches: [batch('duplicate', 1, ['one']), batch('duplicate', 2, ['one', 'two'])],
      completedTestMethodPlanIds: ['one', 'two']
    },
    {
      completedBatches: [batch('first', 1, ['one', 'two']), batch('second', 2, ['one'])],
      completedTestMethodPlanIds: ['one']
    },
    { completedBatches: [], completedTestMethodPlanIds: ['orphan'] }
  ];

  for (const method of invalidMethods) {
    await writeFile(storagePath, JSON.stringify({
      version: 2,
      tasks: {
        Task: {
          catalogIdentity: CATALOG_IDENTITY,
          resolvedMethodOrder: ['method'],
          completedMethodIds: [],
          methods: { method }
        }
      }
    }));
    const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
    await assert.rejects(restored.taskProgress('Task'));
  }
});

test('checkpoint v5 persists an immutable FIFO Wave queue and reusable terminal Part', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['A', 'B', 'C']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const activeWave = {
    waveId: 'a'.repeat(64),
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a-1', 'scenario-a-2'],
    remainingScenarioCount: 30,
    wave: null,
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a-1'],
      status: 'SUCCEEDED',
      eventSequence: 7,
      childSessionId: null,
      candidateId: '22222222-2222-4222-8222-222222222222',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskServiceTmp1Part1Test.java',
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        totalTokens: 12
      },
      modelCallCount: 1,
      usageReportedCallCount: 1
    }, {
      partIndex: 2,
      partBatchId: 'd'.repeat(64),
      scenarioIds: ['scenario-a-2'],
      status: 'PENDING',
      eventSequence: 0,
      childSessionId: null,
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  };
  await checkpoints.saveActiveMethodWave('Task', activeWave);

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const recovered = await restored.taskWaveProgress('Task');
  assert.deepEqual(recovered.methodQueue, ['B', 'C']);
  assert.equal(recovered.activeMethodId, 'A');
  assert.deepEqual(recovered.activeWave, activeWave);

  recovered.methodQueue.push('A');
  recovered.activeWave.parts[0].scenarioIds.push('mutated');
  const unchanged = await restored.taskWaveProgress('Task');
  assert.deepEqual(unchanged.methodQueue, ['B', 'C']);
  assert.deepEqual(unchanged.activeWave.parts[0].scenarioIds, ['scenario-a-1']);
});

test('checkpoint v5 downgrades a newer model-tool Wave to an interrupted empty Wave', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['A', 'B']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a-1'],
    remainingScenarioCount: 1,
    wave: null,
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a-1'],
      status: 'PENDING',
      eventSequence: 0,
      childSessionId: null,
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  const stored = JSON.parse(await readFile(storagePath, 'utf8'));
  const newerWave = stored.tasks.Task.waveState.activeWave;
  newerWave.modelRunBindingDigest = 'c'.repeat(64);
  newerWave.usageRecordedWaveSessionId = '11111111-1111-4111-8111-111111111111';
  newerWave.parts[0].accountedModelCallIds = ['model-call-1'];
  newerWave.parts[0].declarations = [];
  newerWave.parts[0].scenarioMethods = {};
  newerWave.parts[0].aggregateUsage = {
    inputTokens: 10,
    cachedInputTokens: 4,
    uncachedInputTokens: 6,
    outputTokens: 2,
    totalTokens: 12
  };
  newerWave.parts[0].modelCallCount = 1;
  newerWave.parts[0].usageReportedCallCount = 1;
  const serialized = JSON.stringify(stored);
  await writeFile(`${storagePath}`, serialized, 'utf8');
  await writeFile(`${storagePath}.bak`, serialized, 'utf8');

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const progress = await restored.taskProgress('Task');
  const wave = await restored.taskWaveProgress('Task');

  assert.deepEqual(progress.catalogIdentity, CATALOG_IDENTITY);
  assert.deepEqual(progress.resolvedMethodOrder, ['A', 'B']);
  assert.deepEqual(progress.completedMethodIds, []);
  assert.deepEqual(wave, {
    methodQueue: [],
    activeMethodId: null,
    methods: {},
    activeWave: null,
    candidates: {},
    migrationInterrupted: true
  });
});

test('checkpoint v5 rejects duplicate queue membership and overlapping processed scenarios', async (t) => {
  const { state, storagePath } = await checkpointsFor(t);
  const waveState = {
    methodQueue: ['A', 'A'],
    activeMethodId: null,
    methods: {
      A: {
        completedScenarioIds: ['scenario-1'],
        skippedScenarioIds: ['scenario-1'],
        nextWaveIndex: 1,
        remainingScenarioCount: null,
        completedWaves: []
      }
    },
    activeWave: null,
    candidates: {},
    migrationInterrupted: false
  };
  await writeFile(storagePath, JSON.stringify({
    version: 5,
    tasks: {
      Task: {
        catalogIdentity: CATALOG_IDENTITY,
        resolvedMethodOrder: ['A'],
        completedMethodIds: [],
        methods: {},
        ragRun: null,
        waveState
      }
    }
  }));

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  await assert.rejects(restored.taskWaveProgress('Task'), {
    name: 'AtomicJsonStoreCorruptError'
  });
});

test('checkpoint v5 keeps candidate file identity and an interrupted move transaction', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  await checkpoints.saveWaveCandidate('Task', {
    candidateId: '33333333-3333-4333-8333-333333333333',
    methodId: 'A',
    waveId: 'a'.repeat(64),
    status: 'READY_FOR_MAVEN',
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: null,
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: 'D:\\workspace\\TaskServiceTmp1Test.java',
      sha256: 'e'.repeat(64),
      location: 'ISOLATED'
    },
    moveTransaction: {
      sourcePath: 'D:\\workspace\\isolated\\TaskServiceTmp1Test.java',
      targetPath: 'D:\\workspace\\src\\test\\java\\TaskServiceTmp1Test.java',
      sha256: 'e'.repeat(64),
      phase: 'PREPARED'
    }
  });

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const candidate = (await restored.taskWaveProgress('Task')).candidates[
    '33333333-3333-4333-8333-333333333333'
  ];
  assert.equal(candidate.managedFile.sha256, 'e'.repeat(64));
  assert.equal(candidate.moveTransaction.phase, 'PREPARED');

  await assert.rejects(
    restored.saveWaveCandidate('Task', {
      ...candidate,
      moveTransaction: { ...candidate.moveTransaction, sha256: 'invalid' }
    }),
    /SHA-256/i
  );
});

test('rotating only the Analyzer session keeps the active Wave checkpoint', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-same' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-same' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 2,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a'],
    remainingScenarioCount: 0,
    wave: null,
    initialUsageRecorded: true,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a'],
      status: 'SUCCEEDED',
      eventSequence: 2,
      childSessionId: '22222222-2222-4222-8222-222222222222',
      candidateId: '33333333-3333-4333-8333-333333333333',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      modelCallCount: 1,
      usageReportedCallCount: 1
    }]
  });

  await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['A']
  });

  const progress = await checkpoints.taskProgress('Task');
  const wave = await checkpoints.taskWaveProgress('Task');
  assert.deepEqual(progress.catalogIdentity, newIdentity);
  assert.equal(wave.activeMethodId, 'A');
  assert.equal(wave.activeWave?.waveId, 'a'.repeat(64));
  assert.equal(wave.activeWave?.parts[0].status, 'SUCCEEDED');
  assert.equal(wave.activeWave?.parts[0].modelCallCount, 1);
  assert.deepEqual(wave.methodQueue, []);
});

test('crash recovery drops a stale running Wave and replans with the committed history', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis', reportPairId: 'pair-new' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const oldWaveId = createHash('sha256').update('old-report-wave').digest('hex');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: oldWaveId,
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['old-scenario'],
    remainingScenarioCount: 1,
    wave: null,
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: createHash('sha256').update('old-report-part').digest('hex'),
      scenarioIds: ['old-scenario'],
      status: 'SUCCEEDED',
      eventSequence: 0,
      childSessionId: null,
      candidateId: '33333333-3333-4333-8333-333333333333',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  await checkpoints.commitActiveMethodWave('Task', {
    waveId: oldWaveId,
    completedScenarioIds: ['old-scenario'],
    skippedScenarioIds: [],
    remainingScenarioCount: 1,
    candidateIds: []
  });

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  const newWaveId = createHash('sha256').update('new-report-running-wave').digest('hex');
  const newPartId = createHash('sha256').update('new-report-running-part').digest('hex');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: newWaveId,
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 1,
    startRequest: null,
    methodId: 'A',
    waveIndex: 2,
    selectedScenarioIds: ['new-scenario'],
    remainingScenarioCount: 0,
    wave: {
      waveBatchId: newWaveId,
      reportPairId: newIdentity.reportPairId,
      methodId: 'A',
      hasWork: true,
      selectedScenarioIds: ['new-scenario'],
      remainingScenarioCount: 0,
      parts: [{
        partIndex: 1,
        partBatchId: newPartId,
        scenarioIds: ['new-scenario']
      }],
      warnings: []
    },
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: newPartId,
      scenarioIds: ['new-scenario'],
      status: 'RUNNING',
      eventSequence: 1,
      childSessionId: '22222222-2222-4222-8222-222222222222',
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const requests = [];
  const runner = new ClassTaskRunnerService({
    checkpoints: restored,
    methodExecution: {
      async nextWave(_task, methodId, request) {
        requests.push(structuredClone(request));
        return {
          waveBatchId: null,
          reportPairId: newIdentity.reportPairId,
          methodId,
          hasWork: false,
          selectedScenarioIds: [],
          remainingScenarioCount: 0,
          parts: [],
          warnings: []
        };
      },
      async executeWave() {
        throw new Error('the stale running Wave must be discarded before execution');
      },
      async execute() {
        throw new Error('legacy execution must not run');
      }
    }
  });

  assert.equal(await runner.run(
    state.snapshot(),
    ['A'],
    newIdentity,
    new AbortController().signal
  ), 'COMPLETED');
  assert.deepEqual(requests, [{
    reportPairId: newIdentity.reportPairId,
    completedScenarioIds: ['old-scenario'],
    skippedScenarioIds: [],
    maxScenarios: 25,
    partSize: 5
  }]);
  const recovered = await restored.taskWaveProgress('Task');
  assert.equal(recovered.activeMethodId, null);
  assert.equal(recovered.activeWave, null);
  assert.deepEqual(recovered.methodQueue, []);
  assert.deepEqual(recovered.methods.A.completedScenarioIds, []);
  assert.deepEqual(recovered.methods.A.skippedScenarioIds, []);
  assert.equal(recovered.methods.A.remainingScenarioCount, 0);
  assert.deepEqual((await restored.taskProgress('Task')).catalogIdentity, newIdentity);
});

test('a changed catalog interrupts the active Wave but preserves passing managed candidates', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 1,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a'],
    remainingScenarioCount: 1,
    wave: null,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a'],
      status: 'RUNNING',
      eventSequence: 1,
      childSessionId: '22222222-2222-4222-8222-222222222222',
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null
    }]
  });
  const passedCandidateId = '33333333-3333-4333-8333-333333333333';
  await checkpoints.saveWaveCandidate('Task', {
    candidateId: passedCandidateId,
    methodId: 'A',
    waveId: 'c'.repeat(64),
    status: 'PASSED',
    llmRepairAttemptsUsed: 1,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-old',
    stableRepair: {
      phase: 'PASSED',
      iteration: 1,
      annotatedMemberIds: ['method:old:1']
    },
    managedFile: {
      path: 'D:\\workspace\\TaskServiceTmp1Test.java',
      sha256: 'd'.repeat(64),
      location: 'PROJECT'
    },
    moveTransaction: null
  });

  await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['A']
  });

  const wave = await checkpoints.taskWaveProgress('Task');
  assert.equal(wave.activeMethodId, null);
  assert.equal(wave.activeWave, null);
  assert.deepEqual(wave.methodQueue, ['A']);
  assert.deepEqual(Object.keys(wave.candidates), [passedCandidateId]);
  assert.equal(wave.candidates[passedCandidateId].managedFile.path,
    'D:\\workspace\\TaskServiceTmp1Test.java');
});

test('a changed catalog preserves the active Wave when its matching candidate already passed Maven', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  const waveId = 'a'.repeat(64);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId,
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 2,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a'],
    remainingScenarioCount: 1,
    wave: null,
    initialUsageRecorded: true,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a'],
      status: 'SUCCEEDED',
      eventSequence: 2,
      childSessionId: '22222222-2222-4222-8222-222222222222',
      candidateId: '33333333-3333-4333-8333-333333333333',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  const candidateId = '44444444-4444-4444-8444-444444444444';
  await checkpoints.saveWaveCandidate('Task', {
    candidateId,
    methodId: 'A',
    waveId,
    status: 'PASSED',
    llmRepairAttemptsUsed: 2,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-2',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: 'D:\\workspace\\TaskServiceTmp1Test.java',
      sha256: 'd'.repeat(64),
      location: 'PROJECT'
    },
    moveTransaction: null
  });

  await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['A']
  });

  const wave = await checkpoints.taskWaveProgress('Task');
  assert.equal(wave.activeMethodId, 'A');
  assert.equal(wave.activeWave?.waveId, waveId);
  assert.deepEqual(wave.methodQueue, []);
  assert.equal(wave.candidates[candidateId].managedFile.location, 'PROJECT');
});

test('a changed report pair preserves an active Wave waiting for Maven repair', async (t) => {
  // Mutation caught: preserving only PASSED candidates makes a restarted Workstation drop
  // its merged TMP and call the model for the same Wave scenarios as first generation again.
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  const waveId = 'a'.repeat(64);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId,
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 2,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a'],
    remainingScenarioCount: 1,
    wave: null,
    initialUsageRecorded: true,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a'],
      status: 'SUCCEEDED',
      eventSequence: 2,
      childSessionId: '22222222-2222-4222-8222-222222222222',
      candidateId: '33333333-3333-4333-8333-333333333333',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  const candidateId = '44444444-4444-4444-8444-444444444444';
  await checkpoints.saveWaveCandidate('Task', {
    candidateId,
    methodId: 'A',
    waveId,
    status: 'READY_FOR_MAVEN',
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-before-restart',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: 'D:\\workspace\\isolated\\TaskServiceTmp1Test.java',
      sha256: 'd'.repeat(64),
      location: 'ISOLATED'
    },
    moveTransaction: null
  });

  await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['A']
  });

  const wave = await checkpoints.taskWaveProgress('Task');
  assert.equal(wave.activeMethodId, 'A');
  assert.equal(wave.activeWave?.waveId, waveId);
  assert.deepEqual(wave.methodQueue, []);
  assert.equal(wave.candidates[candidateId]?.status, 'READY_FOR_MAVEN');
  assert.equal(wave.candidates[candidateId]?.managedFile?.location, 'ISOLATED');
});

test('a changed report pair preserves a completed Wave whose zero-attempt repair candidate can be rebuilt', async (t) => {
  // The merged TMP may have been cleaned after a failed refresh while every original Part
  // remains durable. Reusing the candidate ID lets recovery merge those Parts again instead
  // of submitting the same scenarios to the model as first generation.
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  const waveId = 'a'.repeat(64);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId,
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 3,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a'],
    remainingScenarioCount: 1,
    wave: null,
    initialUsageRecorded: true,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a'],
      status: 'SUCCEEDED',
      eventSequence: 2,
      childSessionId: '22222222-2222-4222-8222-222222222222',
      candidateId: '33333333-3333-4333-8333-333333333333',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  const candidateId = '44444444-4444-4444-8444-444444444444';
  await checkpoints.saveWaveCandidate('Task', {
    candidateId,
    methodId: 'A',
    waveId,
    status: 'MODEL_REPAIR',
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-before-refresh',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: null,
    moveTransaction: null
  });

  await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['A']
  });

  const wave = await checkpoints.taskWaveProgress('Task');
  assert.equal(wave.activeMethodId, 'A');
  assert.equal(wave.activeWave?.waveId, waveId);
  assert.deepEqual(wave.methodQueue, []);
  assert.equal(wave.candidates[candidateId]?.status, 'MODEL_REPAIR');
  assert.equal(wave.candidates[candidateId]?.llmRepairAttemptsUsed, 0);
  assert.equal(wave.candidates[candidateId]?.managedFile, null);
});

test('a changed catalog clears published scenario IDs while preserving Wave audit history and retry order', async (t) => {
  // Scenario IDs belong to one report pair, while Wave history remains useful audit evidence.
  const { checkpoints } = await checkpointsFor(t);
  const oldIdentity = { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' };
  const newIdentity = { analysisSessionId: 'analysis-new', reportPairId: 'pair-new' };
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: oldIdentity,
    resolvedMethodOrder: ['A', 'B']
  });

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'A');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 1,
    startRequest: null,
    methodId: 'A',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a-1'],
    remainingScenarioCount: 2,
    wave: null,
    initialUsageRecorded: true,
    parts: [{
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-a-1'],
      status: 'SUCCEEDED',
      eventSequence: 1,
      childSessionId: null,
      candidateId: '11111111-1111-4111-8111-111111111111',
      isolatedFilePath: 'D:\\workspace\\isolated\\TaskTmp1Part1Test.java',
      fileSha256: 'e'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  await checkpoints.commitActiveMethodWave('Task', {
    waveId: 'a'.repeat(64),
    completedScenarioIds: ['scenario-a-1'],
    skippedScenarioIds: [],
    remainingScenarioCount: 2,
    candidateIds: []
  });

  assert.equal(await checkpoints.dequeueMethodWave('Task'), 'B');
  await checkpoints.saveActiveMethodWave('Task', {
    waveId: 'c'.repeat(64),
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: 'B',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-b-1'],
    remainingScenarioCount: 0,
    wave: null,
    initialUsageRecorded: false,
    parts: [{
      partIndex: 1,
      partBatchId: 'd'.repeat(64),
      scenarioIds: ['scenario-b-1'],
      status: 'RUNNING',
      eventSequence: 0,
      childSessionId: null,
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });

  await checkpoints.prepareRun('Task', {
    reset: false,
    catalogIdentity: newIdentity,
    resolvedMethodOrder: ['A', 'B']
  });

  const wave = await checkpoints.taskWaveProgress('Task');
  assert.equal(wave.activeMethodId, null);
  assert.equal(wave.activeWave, null);
  assert.deepEqual(wave.methodQueue, ['B', 'A']);
  assert.deepEqual(wave.methods.A.completedScenarioIds, []);
  assert.equal(wave.methods.A.nextWaveIndex, 2);
  assert.equal(wave.methods.A.completedWaves.length, 1);
});

test('Wave candidate repair attempts increment only immediately before that candidate model request and rollback unfinished attempts', async (t) => {
  const { checkpoints } = await checkpointsFor(t);
  const base = (candidateId, status, llmRepairAttemptsUsed) => ({
    candidateId,
    methodId: 'A',
    waveId: 'a'.repeat(64),
    status,
    llmRepairAttemptsUsed,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-1',
    stableRepair: {
      phase: status === 'PASSED' ? 'PASSED' : 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: `D:\\workspace\\${candidateId}.java`,
      sha256: candidateId[0].repeat(64),
      location: status === 'PASSED' ? 'PROJECT' : 'ISOLATED'
    },
    moveTransaction: null
  });
  const candidateA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const candidateB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const candidateC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await checkpoints.saveWaveCandidate('Task', base(candidateA, 'MODEL_REPAIR', 2));
  await checkpoints.saveWaveCandidate('Task', base(candidateB, 'PASSED', 0));
  await checkpoints.saveWaveCandidate('Task', base(candidateC, 'MODEL_REPAIR', 1));

  await checkpoints.beginWaveCandidateModelRepair('Task', candidateA);
  await checkpoints.beginWaveCandidateModelRepair('Task', candidateC);

  const candidates = (await checkpoints.taskWaveProgress('Task')).candidates;
  assert.equal(candidates[candidateA].llmRepairAttemptsUsed, 3);
  assert.equal(candidates[candidateB].llmRepairAttemptsUsed, 0);
  assert.equal(candidates[candidateC].llmRepairAttemptsUsed, 2);
  assert.equal(candidates[candidateA].lastMavenBatchId, 'maven-batch-1');

  const rolledBack = await checkpoints.rollbackWaveCandidateModelRepair('Task', candidateA);
  assert.equal(rolledBack.llmRepairAttemptsUsed, 2);

  const afterRollback = (await checkpoints.taskWaveProgress('Task')).candidates;
  assert.equal(afterRollback[candidateA].llmRepairAttemptsUsed, 2);
  assert.equal(afterRollback[candidateB].llmRepairAttemptsUsed, 0);
  assert.equal(afterRollback[candidateC].llmRepairAttemptsUsed, 2);
  assert.equal(afterRollback[candidateA].lastMavenBatchId, 'maven-batch-1');
  await assert.rejects(
    checkpoints.rollbackWaveCandidateModelRepair('Task', candidateB),
    /not ready to rollback/
  );
});

test('checkpoint v4 migration preserves passing managed files without fabricating Wave state', async (t) => {
  const { state, storagePath } = await checkpointsFor(t);
  const passingBatch = {
    taskId: 'Task',
    methodId: 'finished',
    batchId: 'legacy-batch',
    batchIndex: 1,
    completedTestMethodPlanIds: ['legacy-plan'],
    outcome: 'PASSED',
    candidateVersion: 3,
    tmpFilePath: 'D:\\workspace\\FinishedTest.java',
    tmpFileSha256: 'f'.repeat(64),
    ordinaryTestMethodCount: 1
  };
  await writeFile(storagePath, JSON.stringify({
    version: 4,
    tasks: {
      Task: {
        catalogIdentity: CATALOG_IDENTITY,
        resolvedMethodOrder: ['finished', 'unfinished'],
        completedMethodIds: ['finished'],
        methods: {
          finished: {
            completedBatches: [passingBatch],
            completedTestMethodPlanIds: ['legacy-plan']
          },
          unfinished: {
            completedBatches: [],
            completedTestMethodPlanIds: []
          }
        },
        ragRun: null
      }
    }
  }));

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });
  const legacy = await restored.taskProgress('Task');
  const wave = await restored.taskWaveProgress('Task');
  assert.equal(legacy.methods.finished.completedBatches[0].tmpFilePath,
    'D:\\workspace\\FinishedTest.java');
  assert.equal(legacy.methods.unfinished.inProgressBatch, undefined);
  assert.deepEqual(wave.methodQueue, []);
  assert.equal(wave.activeWave, null);
  assert.deepEqual(wave.candidates, {});
  assert.equal(wave.migrationInterrupted, true);
});

test('checkpoint storage persists more than five tasks across workspaces', async (t) => {
  const { checkpoints, state, storagePath } = await checkpointsFor(t);
  const batchFor = (taskId) => ({
    taskId, methodId: 'method', batchId: 'batch', batchIndex: 1,
    completedTestMethodPlanIds: ['plan'], outcome: 'DROPPED', candidateVersion: 1,
    tmpFilePath: null, tmpFileSha256: null, ordinaryTestMethodCount: 0
  });
  for (const taskId of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) {
    await checkpoints.commitBatch(batchFor(taskId));
  }

  const restored = new ClassTaskCheckpointService({ storagePath, taskState: state });

  for (const taskId of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) {
    assert.equal((await restored.methodCheckpoint(taskId, 'method')).completedBatches.length, 1);
  }
});

test('an inactive explicit selection change preserves completed identities and runs new methods', async (t) => {
  const explicit = task('Task', 'INTERRUPTED', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['old-method'],
    methodOrder: ['old-method'],
    currentMethodIndex: -1
  });
  const { checkpoints, state } = await checkpointsFor(t, explicit);
  await checkpoints.prepareRun('Task', {
    reset: true,
    catalogIdentity: CATALOG_IDENTITY,
    resolvedMethodOrder: ['old-method']
  });
  await checkpoints.commitBatch({
    taskId: 'Task', methodId: 'old-method', batchId: 'batch', batchIndex: 1,
    completedTestMethodPlanIds: ['plan'], outcome: 'DROPPED', candidateVersion: 1,
    tmpFilePath: null, tmpFileSha256: null, ordinaryTestMethodCount: 0
  });
  await checkpoints.commitMethod('Task', 'old-method', CATALOG_IDENTITY);
  await state.save({
    ...state.snapshot(),
    selectedMethodIds: ['new-method', 'old-method'],
    methodOrder: ['new-method', 'old-method'],
    currentMethodIndex: -1
  });
  const executed = [];
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: {
      async execute(_task, methodId) { executed.push(methodId); return null; }
    }
  });

  await runner.run(
    state.snapshot(),
    ['new-method', 'old-method'],
    CATALOG_IDENTITY,
    new AbortController().signal
  );

  assert.deepEqual(executed, ['new-method']);
  assert.deepEqual((await checkpoints.taskProgress('Task')).completedMethodIds,
    ['old-method', 'new-method']);
  assert.equal((await checkpoints.methodCheckpoint('Task', 'old-method')).completedBatches.length, 1);
});

test('Task 7 registry and store compose through one synchronized execution-state adapter', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const directory = await mkdtemp(join(tmpdir(), 'class-registry-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = () => new Date('2026-08-09T01:00:00.000Z');
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'), clock);
  await store.save({
    version: 3,
    tasks: { [taskId]: task(taskId, 'READY', { startedAt: null }) }
  });
  const registry = new ClassTaskRegistryService({ store, clock });
  await registry.reload();
  const broadcasts = [];
  const state = new ClassTaskRegistryStateAdapter({
    registry,
    store,
    broadcast: (snapshot) => broadcasts.push(snapshot.state)
  });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'), taskState: state, clock
  });

  await checkpoints.transitionState(taskId, 'RUNNING');
  await checkpoints.requestPause(taskId);
  await assert.rejects(
    checkpoints.beginAtomicStep(taskId, 'MODEL_GENERATION'),
    ClassTaskPausedAtBoundaryError
  );

  assert.equal(state.snapshot(taskId).state, 'PAUSED');
  assert.equal(state.list()[0].state, 'PAUSED');
  assert.equal(registry.snapshot(taskId).state, 'PAUSED');
  assert.equal((await store.load()).tasks[taskId].state, 'PAUSED');
  assert.deepEqual(broadcasts, ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED']);
});

test('reordering preserves an active execution overlay and its persisted state', async (t) => {
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-reorder-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [firstId]: task(firstId, 'READY', { startedAt: null }),
      [secondId]: task(secondId, 'READY', { startedAt: null })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });
  await state.save({
    ...state.snapshot(firstId),
    state: 'RUNNING',
    startedAt: '2026-08-09T01:00:00.000Z',
    updatedAt: '2026-08-09T01:00:00.000Z'
  });

  const reordered = await state.reorder('D:\\workspace', [secondId, firstId]);
  const persisted = await store.load();

  assert.deepEqual(reordered.map((snapshot) => snapshot.id), [secondId, firstId]);
  assert.equal(state.snapshot(firstId).state, 'RUNNING');
  assert.equal(persisted.tasks[firstId].state, 'RUNNING');
  assert.deepEqual(Object.keys(persisted.tasks), [secondId, firstId]);
});

test('real Task 7 storage accepts an explicit execution plan', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const cases = [
    {
      selectionMode: 'EXPLICIT',
      selectedMethodIds: ['second', 'first'],
      methodOrder: ['second', 'first'],
      expected: ['second', 'first']
    }
  ];
  for (const selection of cases) {
    const directory = await mkdtemp(join(tmpdir(), 'class-real-store-run-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
    await store.save({
      version: 3,
      tasks: {
        [taskId]: task(taskId, 'READY', {
          startedAt: null,
          selectionMode: selection.selectionMode,
          selectedMethodIds: selection.selectedMethodIds,
          methodOrder: selection.methodOrder
        })
      }
    });
    const registry = new ClassTaskRegistryService({ store });
    await registry.reload();
    const state = new ClassTaskRegistryStateAdapter({ registry, store });
    const checkpoints = new ClassTaskCheckpointService({
      storagePath: join(directory, 'checkpoints.json'),
      taskState: state
    });
    const executed = [];
    const runner = new ClassTaskRunnerService({
      checkpoints,
      methodExecution: {
        async execute(_task, methodId) { executed.push(methodId); return null; }
      }
    });
    const scheduler = new ClassTaskSchedulerService({
      registry: state,
      checkpoints,
      runner,
      catalogProvider: { get: async () => methodCatalog(taskId, ['first', 'second']) },
      validateTask: async () => undefined
    });

    const completed = await scheduler.runTask(taskId);

    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.currentMethodIndex, -1);
    assert.deepEqual(executed, selection.expected);
    assert.equal((await store.load()).tasks[taskId].state, 'COMPLETED');
    assert.equal((await store.load()).tasks[taskId].currentMethodIndex, -1);
  }
});

test('a stable execution commit never startup-recovers a sibling live preload', async (t) => {
  const runningId = '11111111-1111-4111-8111-111111111111';
  const preloadingId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-preload-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [runningId]: task(runningId, 'READY', { startedAt: null }),
      [preloadingId]: task(preloadingId, 'READY', {
        startedAt: null,
        moduleKey: 'd:/other',
        moduleDisplayPath: 'D:\\other'
      })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  await registry.applyModulePreloadSnapshot('d:/other', {
    moduleKey: 'd:/other', moduleName: 'other', modulePath: 'D:\\other', state: 'RUNNING',
    fingerprint: null, executionDataPath: null, classReportPairs: {}, classPreloadFailures: {},
    diagnostic: null, updatedAt: '2026-08-09T01:00:00.000Z'
  });
  const state = new ClassTaskRegistryStateAdapter({ registry, store });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'), taskState: state
  });

  await checkpoints.transitionState(runningId, 'RUNNING');
  await checkpoints.transitionState(runningId, 'COMPLETED');

  assert.equal(state.snapshot(preloadingId).state, 'PRELOADING');
  assert.equal(registry.snapshot(preloadingId).state, 'PRELOADING');
  assert.equal((await store.load()).tasks[preloadingId].state, 'PRELOADING');
});

test('adapter saves a READY overlay selection while a sibling remains PRELOADING', async (t) => {
  const readyId = '11111111-1111-4111-8111-111111111111';
  const preloadingId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-selection-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [readyId]: task(readyId, 'PRELOADING', { preloadState: 'RUNNING', startedAt: null }),
      [preloadingId]: task(preloadingId, 'PRELOADING', {
        preloadState: 'RUNNING',
        startedAt: null,
        moduleKey: 'd:/other',
        moduleDisplayPath: 'D:\\other'
      })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });

  await state.save({
    ...state.snapshot(readyId),
    state: 'READY',
    preloadState: 'READY',
    updatedAt: '2026-08-09T01:00:00.000Z'
  });

  assert.equal(state.snapshot(readyId).state, 'READY');
  assert.equal(registry.snapshot(readyId).state, 'PRELOADING');

  const saved = await state.saveSelection(
    readyId,
    'EXPLICIT',
    ['chosen'],
    ['chosen'],
    true,
    5,
    false
  );
  const persisted = (await store.load()).tasks;

  assert.equal(saved.state, 'READY');
  assert.deepEqual(saved.methodOrder, ['chosen']);
  assert.equal(saved.ragEnabled, true);
  assert.equal(persisted[readyId].state, 'READY');
  assert.deepEqual(persisted[readyId].methodOrder, ['chosen']);
  assert.equal(persisted[readyId].ragEnabled, true);
  assert.equal(persisted[preloadingId].state, 'PRELOADING');
});

test('catalog refresh preserves a newly saved overlay selection while a sibling remains PRELOADING', async (t) => {
  const readyId = '11111111-1111-4111-8111-111111111111';
  const preloadingId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-selection-refresh-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [readyId]: task(readyId, 'PRELOADING', { preloadState: 'RUNNING', startedAt: null }),
      [preloadingId]: task(preloadingId, 'PRELOADING', {
        preloadState: 'RUNNING',
        startedAt: null,
        moduleKey: 'd:/other',
        moduleDisplayPath: 'D:\\other'
      })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });

  await state.save({
    ...state.snapshot(readyId),
    state: 'READY',
    preloadState: 'READY',
    updatedAt: '2026-08-09T01:00:00.000Z'
  });
  await state.saveSelection(
    readyId,
    'EXPLICIT',
    ['chosen'],
    ['chosen'],
    true,
    7,
    false
  );

  const refreshed = await state.reconcileCatalog(
    readyId,
    methodCatalog(readyId, ['chosen', 'other'])
  );
  const persisted = (await store.load()).tasks[readyId];
  const restarted = new ClassTaskRegistryService({ store });
  await restarted.reload();

  for (const snapshot of [refreshed.task, persisted, restarted.snapshot(readyId)]) {
    assert.equal(snapshot.state, 'READY');
    assert.deepEqual(snapshot.selectedMethodIds, ['chosen']);
    assert.deepEqual(snapshot.methodOrder, ['chosen']);
    assert.equal(snapshot.ragEnabled, true);
    assert.equal(snapshot.repairAttemptLimit, 7);
    assert.equal(snapshot.unlimitedRepair, false);
  }
  assert.equal(state.snapshot(preloadingId).state, 'PRELOADING');
});

test('adapter-coordinated registry mutation cannot overwrite a sibling execution overlay', async (t) => {
  const runningId = '11111111-1111-4111-8111-111111111111';
  const idleId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-mutation-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [runningId]: task(runningId, 'READY', { startedAt: null }),
      [idleId]: task(idleId, 'READY', { startedAt: null })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'), taskState: state
  });
  await checkpoints.transitionState(runningId, 'RUNNING');

  await state.saveSelection(idleId, 'EXPLICIT', ['chosen'], ['chosen'], false, 5, false);

  assert.equal(state.snapshot(runningId).state, 'RUNNING');
  assert.equal((await store.load()).tasks[runningId].state, 'RUNNING');
  assert.deepEqual(state.snapshot(idleId).methodOrder, ['chosen']);
});

test('adapter rejects selection changes while an execution plan is live', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  for (const activeState of ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING']) {
    const directory = await mkdtemp(join(tmpdir(), 'class-selection-lock-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
    await store.save({
      version: 3,
      tasks: {
        [taskId]: task(taskId, 'READY', {
          startedAt: null,
          selectionMode: 'EXPLICIT',
          selectedMethodIds: ['old'],
          methodOrder: ['old']
        })
      }
    });
    const registry = new ClassTaskRegistryService({ store });
    await registry.reload();
    const state = new ClassTaskRegistryStateAdapter({ registry, store });
    const checkpoints = new ClassTaskCheckpointService({
      storagePath: join(directory, 'checkpoints.json'),
      taskState: state
    });
    await checkpoints.transitionState(taskId, 'RUNNING');
    if (activeState === 'PAUSE_REQUESTED' || activeState === 'PAUSED') {
      await checkpoints.requestPause(taskId);
    }
    if (activeState === 'PAUSED') {
      await assert.rejects(
        checkpoints.beginAtomicStep(taskId, 'MODEL_GENERATION'),
        ClassTaskPausedAtBoundaryError
      );
    }
    if (activeState === 'STOPPING') await checkpoints.requestTermination(taskId);

    await assert.rejects(
      state.saveSelection(taskId, 'EXPLICIT', ['new'], ['new'], false),
      new RegExp(`cannot change method selection while ${activeState}`, 'i')
    );
    await assert.rejects(
      state.reconcileCatalog(taskId, methodCatalog(taskId, ['new'])),
      new RegExp(`cannot reconcile method selection while ${activeState}`, 'i')
    );
    assert.deepEqual(state.snapshot(taskId).methodOrder, ['old']);
    assert.deepEqual((await store.load()).tasks[taskId].methodOrder, ['old']);
  }
});

for (const executionState of ['RUNNING', 'PAUSED']) {
test(`execution catalog reconciliation preserves ${executionState} while removing stale methods`, async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const directory = await mkdtemp(join(tmpdir(), 'class-running-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [taskId]: task(taskId, 'READY', {
        startedAt: null,
        selectionMode: 'EXPLICIT',
        selectedMethodIds: ['stale'],
        methodOrder: ['stale']
      })
    }
  });
  const broadcasts = [];
  const registry = new ClassTaskRegistryService({
    store,
    broadcast: (snapshot) => broadcasts.push(structuredClone(snapshot))
  });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({
    registry,
    store,
    broadcast: (snapshot) => broadcasts.push(structuredClone(snapshot))
  });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'),
    taskState: state
  });
  await checkpoints.transitionState(taskId, 'RUNNING');
  if (executionState === 'PAUSED') {
    await checkpoints.requestPause(taskId);
    await checkpoints.pauseAtBoundary(taskId);
  }
  broadcasts.length = 0;

  const reconciled = await state.reconcileCatalogForExecution(
    taskId,
    methodCatalog(taskId, ['new'])
  );
  const persisted = (await store.load()).tasks[taskId];

  assert.equal(reconciled.task.state, executionState);
  assert.deepEqual(reconciled.task.methodOrder, []);
  assert.deepEqual(reconciled.notices.map((notice) => notice.code), [
    'STALE_METHOD_SELECTION_REMOVED'
  ]);
  assert.equal(state.snapshot(taskId).state, executionState);
  assert.equal(persisted.state, executionState);
  assert.deepEqual(persisted.methodOrder, []);
  assert.equal(broadcasts.every((snapshot) => snapshot.state === executionState), true);
});
}

test('a late preload failure cannot overwrite an active execution overlay', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const directory = await mkdtemp(join(tmpdir(), 'class-running-preload-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: { [taskId]: task(taskId, 'READY', { startedAt: null }) }
  });
  const broadcasts = [];
  const registry = new ClassTaskRegistryService({
    store,
    broadcast: (snapshot) => broadcasts.push(structuredClone(snapshot))
  });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({
    registry,
    store,
    broadcast: (snapshot) => broadcasts.push(structuredClone(snapshot))
  });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'),
    taskState: state
  });
  await checkpoints.transitionState(taskId, 'RUNNING');
  broadcasts.length = 0;

  const result = await state.applyClassPreloadFailure(taskId, {
    code: 'CLASS_PRELOAD_FAILED',
    message: 'late preparation failure',
    moduleName: 'example.Task',
    modulePath: 'D:\\workspace',
    command: null,
    occurredAt: '2026-08-09T01:00:00.000Z'
  });

  assert.equal(result.state, 'RUNNING');
  assert.equal(state.snapshot(taskId).state, 'RUNNING');
  assert.equal((await store.load()).tasks[taskId].state, 'RUNNING');
  assert.equal(broadcasts.some((snapshot) => snapshot.state === 'PRELOAD_FAILED'), false);
});

test('adapter reconciles an Analyzer catalog during PRELOADING while user selection stays locked', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const directory = await mkdtemp(join(tmpdir(), 'class-preload-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [taskId]: task(taskId, 'PRELOADING', {
        preloadState: 'RUNNING',
        startedAt: null,
        selectionMode: 'EXPLICIT',
        selectedMethodIds: ['stale'],
        methodOrder: ['stale']
      })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.initialize();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });

  await assert.rejects(
    state.saveSelection(taskId, 'EXPLICIT', ['new'], ['new'], false),
    /cannot change method selection while PRELOADING/i
  );
  const reconciled = await state.reconcileCatalog(taskId, methodCatalog(taskId, ['new']));

  assert.equal(reconciled.task.state, 'PRELOADING');
  assert.deepEqual(reconciled.task.methodOrder, []);
  assert.deepEqual(reconciled.notices.map((notice) => notice.code), [
    'STALE_METHOD_SELECTION_REMOVED'
  ]);
  assert.deepEqual((await store.load()).tasks[taskId].methodOrder, []);
});

test('adapter queue preserves a selection committed before a stale execution transition', async (t) => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const directory = await mkdtemp(join(tmpdir(), 'class-selection-transition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [taskId]: task(taskId, 'READY', {
        startedAt: null,
        selectionMode: 'EXPLICIT',
        selectedMethodIds: ['old'],
        methodOrder: ['old']
      })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });
  const stale = state.snapshot(taskId);

  const selection = state.saveSelection(
    taskId,
    'EXPLICIT',
    ['new'],
    ['new'],
    false,
    5,
    false
  );
  const transition = state.save({
    ...stale,
    state: 'RUNNING',
    startedAt: '2026-08-09T01:00:00.000Z',
    updatedAt: '2026-08-09T01:00:00.000Z'
  });
  const [, running] = await Promise.all([selection, transition]);

  assert.equal(running.state, 'RUNNING');
  assert.deepEqual(running.methodOrder, ['new']);
  assert.deepEqual(state.snapshot(taskId).methodOrder, ['new']);
  assert.deepEqual((await store.load()).tasks[taskId].methodOrder, ['new']);
});

test('removing an idle task preserves a sibling live overlay for restart recovery', async (t) => {
  const activeId = '11111111-1111-4111-8111-111111111111';
  const idleId = '22222222-2222-4222-8222-222222222222';
  for (const activeState of ['RUNNING', 'PAUSE_REQUESTED']) {
    const directory = await mkdtemp(join(tmpdir(), 'class-remove-adapter-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
    await store.save({
      version: 3,
      tasks: {
        [activeId]: task(activeId, 'READY', { startedAt: null }),
        [idleId]: task(idleId, 'READY', { startedAt: null })
      }
    });
    const registry = new ClassTaskRegistryService({ store });
    await registry.reload();
    const state = new ClassTaskRegistryStateAdapter({ registry, store });
    const checkpoints = new ClassTaskCheckpointService({
      storagePath: join(directory, 'checkpoints.json'), taskState: state
    });
    await checkpoints.transitionState(activeId, 'RUNNING');
    if (activeState === 'PAUSE_REQUESTED') await checkpoints.requestPause(activeId);

    await state.remove(idleId);

    const persisted = await store.load();
    assert.equal(persisted.tasks[activeId].state, activeState);
    assert.equal(persisted.tasks[idleId], undefined);
    const restarted = new ClassTaskRegistryService({ store });
    await restarted.initialize();
    assert.equal(restarted.snapshot(activeId).state, 'INTERRUPTED');
    assert.throws(() => restarted.snapshot(idleId), /Unknown class task/);
  }
});

test('the first persisted removal write already contains every live sibling overlay', async (t) => {
  const activeId = '11111111-1111-4111-8111-111111111111';
  const idleId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-remove-first-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [activeId]: task(activeId, 'READY', { startedAt: null }),
      [idleId]: task(idleId, 'READY', { startedAt: null })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.reload();
  const state = new ClassTaskRegistryStateAdapter({ registry, store });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'), taskState: state
  });
  await checkpoints.transitionState(activeId, 'RUNNING');
  const originalSave = store.save.bind(store);
  const originalUpdate = store.update.bind(store);
  let persistedWrites = 0;
  const crashAfterFirstWrite = (persisted) => {
    persistedWrites += 1;
    if (persistedWrites === 1) throw new Error('simulated crash after first persisted removal write');
    return persisted;
  };
  store.save = async (value) => crashAfterFirstWrite(await originalSave(value));
  store.update = async (updater) => crashAfterFirstWrite(await originalUpdate(updater));

  await assert.rejects(
    state.remove(idleId),
    /simulated crash after first persisted removal write/
  );

  assert.equal(persistedWrites, 1);
  const persisted = await store.load();
  assert.equal(persisted.tasks[activeId].state, 'RUNNING');
  assert.equal(persisted.tasks[idleId], undefined);
});

test('removing an idle task does not startup-recover a live preload sibling', async (t) => {
  const preloadingId = '11111111-1111-4111-8111-111111111111';
  const idleId = '22222222-2222-4222-8222-222222222222';
  const directory = await mkdtemp(join(tmpdir(), 'class-remove-live-preload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'class-tasks.json'));
  await store.save({
    version: 3,
    tasks: {
      [preloadingId]: task(preloadingId, 'READY', {
        startedAt: null,
        moduleKey: 'd:/other',
        moduleDisplayPath: 'D:\\other'
      }),
      [idleId]: task(idleId, 'READY', { startedAt: null })
    }
  });
  const registry = new ClassTaskRegistryService({ store });
  await registry.initialize();
  await registry.applyModulePreloadSnapshot('d:/other', {
    moduleKey: 'd:/other', moduleName: 'other', modulePath: 'D:\\other', state: 'RUNNING',
    fingerprint: null, executionDataPath: null, classReportPairs: {}, classPreloadFailures: {},
    diagnostic: null, updatedAt: '2026-08-09T01:00:00.000Z'
  });
  const state = new ClassTaskRegistryStateAdapter({ registry, store });

  await state.remove(idleId);

  assert.equal(state.snapshot(preloadingId).state, 'PRELOADING');
  assert.equal(registry.snapshot(preloadingId).state, 'PRELOADING');
  assert.equal((await store.load()).tasks[preloadingId].state, 'PRELOADING');
});
