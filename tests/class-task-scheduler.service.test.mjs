import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClassTaskCheckpointService } from '../src/main/services/class-task-checkpoint.service.ts';
import { ClassTaskRunnerService } from '../src/main/services/class-task-runner.service.ts';
import { ClassTaskSchedulerService } from '../src/main/services/class-task-scheduler.service.ts';
import { decodeMethodGenerationEvent, MethodGenerationRequestError } from '../src/main/services/method-generation-contract.ts';

function task(id, state = 'READY', overrides = {}) {
  return {
    id,
    workspaceRoot: 'D:\\workspace',
    sourceFilePath: `D:\\workspace\\src\\main\\java\\${id}.java`,
    qualifiedClassName: `example.${id}`,
    moduleKey: 'd:/workspace',
    moduleDisplayPath: 'D:\\workspace',
    state,
    preloadState: state === 'PRELOADING' ? 'RUNNING' : state === 'PRELOAD_FAILED' ? 'FAILED' : 'READY',
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['first', 'second'],
    methodOrder: ['first', 'second'],
    currentMethodIndex: -1,
    currentAtomicStep: 'IDLE',
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: false,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  };
}

function catalog(taskId, methodIds = ['first', 'second']) {
  return {
    taskId,
    analysisSessionId: '22222222-2222-4222-8222-222222222222',
    reportPairId: `pair-${taskId}`,
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

function createRegistry(initialTasks) {
  const tasks = new Map(initialTasks.map((entry) => [entry.id, structuredClone(entry)]));
  return {
    list: () => [...tasks.values()].map((entry) => structuredClone(entry)),
    snapshot(id) {
      const found = tasks.get(id);
      if (!found) throw new Error(`Unknown class task: ${id}`);
      return structuredClone(found);
    },
    async save(snapshot) {
      if (!tasks.has(snapshot.id)) throw new Error(`Unknown class task: ${snapshot.id}`);
      tasks.set(snapshot.id, structuredClone(snapshot));
      return structuredClone(snapshot);
    },
    remove(id) { tasks.delete(id); }
  };
}

async function createHarness(t, initialTasks, execution, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'class-scheduler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createRegistry(initialTasks);
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(directory, 'checkpoints.json'),
    taskState: registry,
    clock: () => new Date('2026-08-09T01:00:00.000Z')
  });
  const runner = new ClassTaskRunnerService({ checkpoints, methodExecution: execution });
  const scheduler = new ClassTaskSchedulerService({
    registry,
    checkpoints,
    runner,
    catalogProvider: options.catalogProvider ?? { get: async (taskId) => catalog(taskId) },
    validateTask: options.validateTask ?? (async () => undefined)
  });
  return { checkpoints, registry, runner, scheduler };
}

test('five classes may execute concurrently while every class stays method-serial and ordered', async (t) => {
  const taskIds = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  const activeMethods = new Map();
  const maxMethods = new Map();
  const order = new Map(taskIds.map((id) => [id, []]));
  const activeClasses = new Set();
  let maxConcurrentClasses = 0;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => { releaseFirstWave = resolve; });
  let firstWaveCount = 0;
  const execution = {
    async execute(currentTask, methodId) {
      const active = (activeMethods.get(currentTask.id) ?? 0) + 1;
      activeMethods.set(currentTask.id, active);
      maxMethods.set(currentTask.id, Math.max(maxMethods.get(currentTask.id) ?? 0, active));
      activeClasses.add(currentTask.id);
      maxConcurrentClasses = Math.max(maxConcurrentClasses, activeClasses.size);
      order.get(currentTask.id).push(methodId);
      if (methodId === 'first') {
        firstWaveCount += 1;
        if (firstWaveCount === taskIds.length) releaseFirstWave();
        await firstWave;
      }
      activeMethods.set(currentTask.id, active - 1);
      activeClasses.delete(currentTask.id);
      return null;
    }
  };
  const { scheduler } = await createHarness(t, taskIds.map((id) => task(id)), execution);

  await scheduler.runAll();

  assert.equal(maxConcurrentClasses, 5);
  for (const id of taskIds) {
    assert.equal(maxMethods.get(id), 1);
    assert.deepEqual(order.get(id), ['first', 'second']);
  }
});

test('duplicate runTask calls share one promise, one signal, and one execution', async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const signals = [];
  let calls = 0;
  const { scheduler } = await createHarness(t, [task('Only')], {
    async execute(_task, _methodId, _checkpoint, signal) {
      calls += 1;
      signals.push(signal);
      await blocked;
      return null;
    }
  });

  const first = scheduler.runTask('Only');
  const second = scheduler.runTask('Only');
  assert.equal(first, second);
  release();
  await first;

  assert.equal(calls, 2);
  assert.equal(new Set(signals).size, 1);
});

test('runTask enters running before validation settles and accepts a pause request', async (t) => {
  let markValidationStarted;
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  let releaseValidation;
  const validationBlocked = new Promise((resolve) => { releaseValidation = resolve; });
  let executionCalls = 0;
  let catalogCalls = 0;
  const { registry, scheduler } = await createHarness(t, [task('Retry', 'FAILED')], {
    async execute() {
      executionCalls += 1;
      return null;
    }
  }, {
    validateTask: async () => {
      markValidationStarted();
      await validationBlocked;
    },
    catalogProvider: {
      async get(taskId) {
        catalogCalls += 1;
        return catalog(taskId);
      }
    }
  });

  const run = scheduler.runTask('Retry');
  await validationStarted;
  const whileValidating = registry.snapshot('Retry');
  let pauseResult = null;
  let pauseError = null;
  try {
    pauseResult = await scheduler.requestPause('Retry');
  } catch (error) {
    pauseError = error;
  }
  releaseValidation();
  const runResult = await run;

  assert.equal(whileValidating.state, 'RUNNING');
  assert.equal(pauseError, null);
  assert.equal(pauseResult?.state, 'PAUSE_REQUESTED');
  assert.equal(runResult.state, 'PAUSED');
  assert.equal(catalogCalls, 0);
  assert.equal(executionCalls, 0);
});

test('pause aborts a hung execution and resume continues from the unfinished method', async (t) => {
  let markExecutionStarted;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  let firstSignal;
  const calls = [];
  const { registry, scheduler } = await createHarness(t, [task('Hung')], {
    async execute(_task, methodId, _checkpoint, signal) {
      calls.push(methodId);
      if (calls.length !== 1) return null;
      firstSignal = signal;
      markExecutionStarted();
      await new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return null;
    }
  });

  const running = scheduler.runTask('Hung');
  await executionStarted;
  const requested = await scheduler.requestPause('Hung');
  const paused = await Promise.race([
    running,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('pause did not interrupt the active execution')), 1_000);
    })
  ]);

  assert.equal(requested.state, 'PAUSE_REQUESTED');
  assert.equal(firstSignal.aborted, true);
  assert.equal(firstSignal.reason?.name, 'ClassTaskPauseRequestedError');
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.currentAtomicStep, 'IDLE');
  assert.equal(registry.snapshot('Hung').state, 'PAUSED');

  const completed = await scheduler.resumeTask('Hung');
  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(calls, ['first', 'first', 'second']);
});

test('pauseAtBoundaryAndWait lets the current method finish without aborting it', async (t) => {
  let markExecutionStarted;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  let releaseExecution;
  const executionBlocked = new Promise((resolve) => { releaseExecution = resolve; });
  const calls = [];
  let firstSignal;
  const { registry, scheduler } = await createHarness(t, [task('Boundary')], {
    async execute(_task, methodId, _checkpoint, signal) {
      calls.push(methodId);
      if (methodId === 'first') {
        firstSignal = signal;
        markExecutionStarted();
        await executionBlocked;
      }
      return null;
    }
  });

  const running = scheduler.runTask('Boundary');
  await executionStarted;
  const pausing = scheduler.pauseAtBoundaryAndWait('Boundary');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registry.snapshot('Boundary').state, 'PAUSE_REQUESTED');
  assert.equal(firstSignal.aborted, false);
  releaseExecution();
  const [paused, runResult] = await Promise.all([pausing, running]);
  assert.equal(paused.state, 'PAUSED');
  assert.equal(runResult.state, 'PAUSED');
  assert.deepEqual(calls, ['first']);

  const completed = await scheduler.resumeTask('Boundary');
  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(calls, ['first', 'second']);
});

test('background boundary work waits for the current method and never changes the running state', async (t) => {
  let markExecutionStarted;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  let releaseExecution;
  const executionBlocked = new Promise((resolve) => { releaseExecution = resolve; });
  const calls = [];
  const { registry, scheduler } = await createHarness(t, [task('BackgroundBoundary')], {
    async execute(_task, methodId) {
      calls.push(`start:${methodId}`);
      if (methodId === 'first') {
        markExecutionStarted();
        await executionBlocked;
      }
      calls.push(`finish:${methodId}`);
      return null;
    }
  });

  const running = scheduler.runTask('BackgroundBoundary');
  await executionStarted;
  const background = scheduler.runBackgroundOperationAtBoundary(
    'BackgroundBoundary',
    async () => {
      calls.push('background-result-action');
      return 'accepted';
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registry.snapshot('BackgroundBoundary').state, 'RUNNING');
  assert.deepEqual(calls, ['start:first']);
  releaseExecution();
  assert.equal(await background, 'accepted');
  assert.equal(registry.snapshot('BackgroundBoundary').state, 'RUNNING');
  assert.equal((await running).state, 'COMPLETED');
  assert.deepEqual(calls, [
    'start:first',
    'finish:first',
    'background-result-action',
    'start:second',
    'finish:second'
  ]);
});

test('a READY task preserves durable partial Wave progress after preload recovery', async (t) => {
  const created = await createHarness(t, [task('Recovered', 'READY', {
    selectedMethodIds: ['first'],
    methodOrder: ['first']
  })], {
    async execute() {
      throw new Error('execution must not start after the validation fixture fails');
    }
  }, {
    validateTask: async () => {
      throw new Error('stop after scheduler checkpoint preparation');
    },
    catalogProvider: { get: async () => catalog('Recovered', ['first']) }
  });
  const { checkpoints, scheduler } = created;
  await checkpoints.prepareRun('Recovered', {
    reset: true,
    catalogIdentity: {
      analysisSessionId: 'analysis-before-preload-recovery',
      reportPairId: 'pair-before-preload-recovery'
    },
    resolvedMethodOrder: ['first']
  });
  assert.equal(await checkpoints.dequeueMethodWave('Recovered'), 'first');
  const activeWaveId = 'a'.repeat(64);
  await checkpoints.saveActiveMethodWave('Recovered', {
    waveId: activeWaveId,
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 1,
    startRequest: null,
    methodId: 'first',
    waveIndex: 1,
    selectedScenarioIds: ['scenario-a'],
    remainingScenarioCount: 2,
    wave: null,
    initialUsageRecorded: false,
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
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  const originalPrepareRun = checkpoints.prepareRun.bind(checkpoints);
  const schedulerPreparations = [];
  checkpoints.prepareRun = async (taskId, options) => {
    schedulerPreparations.push(structuredClone(options));
    return originalPrepareRun(taskId, options);
  };

  const failed = await scheduler.runTask('Recovered');

  assert.equal(failed.state, 'FAILED');
  assert.equal(schedulerPreparations[0]?.reset, false);
  const wave = await checkpoints.taskWaveProgress('Recovered');
  assert.equal(wave.activeWave?.waveId, activeWaveId);
  assert.equal(wave.activeWave?.waveIndex, 1);
});

test('runAll skips ineligible tasks and isolates one class failure', async (t) => {
  const started = [];
  const initial = [
    task('Ready'), task('Completed', 'COMPLETED'), task('Terminated', 'TERMINATED'),
    task('PreloadFailed', 'PRELOAD_FAILED'), task('Failed', 'FAILED')
  ];
  const { registry, scheduler } = await createHarness(t, initial, {
    async execute(currentTask, methodId) {
      started.push(`${currentTask.id}:${methodId}`);
      if (currentTask.id === 'Completed') throw new Error('class-local failure');
      return null;
    }
  });
  const results = await scheduler.runAll();

  assert.deepEqual([...new Set(started.map((entry) => entry.split(':')[0]))].sort(),
    ['Completed', 'Ready', 'Terminated']);
  assert.equal(registry.snapshot('Completed').state, 'FAILED');
  assert.equal(registry.snapshot('Ready').state, 'COMPLETED');
  assert.equal(registry.snapshot('Terminated').state, 'COMPLETED');
  assert.equal(results.length, 3);
});

test('invalid backend response pauses resumable work and resumes only unfinished methods', async (t) => {
  const calls = [];
  let fail = true;
  const { scheduler, checkpoints } = await createHarness(t, [task('ProtocolFailure')], {
    async execute(_task, methodId) {
      calls.push(methodId);
      if (methodId === 'second' && fail) decodeMethodGenerationEvent({});
      return null;
    }
  });
  const paused = await scheduler.runTask('ProtocolFailure');
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.lastError?.code, 'METHOD_GENERATION_RESPONSE_INVALID');
  assert.equal(await checkpoints.hasResumableProgress('ProtocolFailure'), true);
  fail = false;
  const completed = await scheduler.resumeTask('ProtocolFailure');
  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(calls, ['first', 'second', 'second']);
});

test('execution failure preserves a safe structured model error code for the card', async (t) => {
  const { registry, scheduler } = await createHarness(t, [task('ModelFailure')], {
    async execute() {
      throw Object.assign(new Error('未找到所选模型。'), { code: 'MODEL_NOT_FOUND' });
    }
  });

  const failed = await scheduler.runTask('ModelFailure');

  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.lastError?.code, 'MODEL_NOT_FOUND');
  assert.equal(registry.snapshot('ModelFailure').lastError?.code, 'MODEL_NOT_FOUND');
});

test('execution failure preserves a safe coverage-artifact error code for recovery', async (t) => {
  const { scheduler, registry } = await createHarness(t, [task('MissingReport')], {
    async execute() {
      throw Object.assign(
        new Error('JaCoCo report was removed'),
        { code: 'REPORT_PATH_MISSING' }
      );
    }
  });

  const failed = await scheduler.runTask('MissingReport');

  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.lastError?.code, 'REPORT_PATH_MISSING');
  assert.equal(registry.snapshot('MissingReport').lastError?.code, 'REPORT_PATH_MISSING');
});

test('incomplete model output pauses resumable progress without repeating completed work', async (t) => {
  let fail = true;
  const calls = [];
  const { scheduler, checkpoints } = await createHarness(t, [task('Incomplete')], {
    async execute(_task, methodId) {
      calls.push(methodId);
      if (methodId === 'second' && fail) {
        throw new MethodGenerationRequestError('MODEL_INVALID_RESPONSE', 'Model returned no Java output');
      }
      return null;
    }
  });
  const paused = await scheduler.runTask('Incomplete');
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.lastError?.code, 'MODEL_INVALID_RESPONSE');
  assert.equal(await checkpoints.hasResumableProgress('Incomplete'), true);
  fail = false;
  assert.equal((await scheduler.resumeTask('Incomplete')).state, 'COMPLETED');
  assert.deepEqual(calls, ['first', 'second', 'second']);
});

test('quota exhaustion pauses resumable progress so a new model can continue it', async (t) => {
  let quotaExhausted = true;
  const calls = [];
  const { scheduler, checkpoints } = await createHarness(t, [task('QuotaExhausted')], {
    async execute(_task, methodId) {
      calls.push(methodId);
      if (methodId === 'second' && quotaExhausted) {
        throw new MethodGenerationRequestError(
          'MODEL_QUOTA_EXHAUSTED',
          'The selected model quota is exhausted'
        );
      }
      return null;
    }
  });

  const paused = await scheduler.runTask('QuotaExhausted');
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.lastError?.code, 'MODEL_QUOTA_EXHAUSTED');
  assert.equal(await checkpoints.hasResumableProgress('QuotaExhausted'), true);

  quotaExhausted = false;
  assert.equal((await scheduler.resumeTask('QuotaExhausted')).state, 'COMPLETED');
  assert.deepEqual(calls, ['first', 'second', 'second']);
});

test('unavailable model pauses resumable progress so the failed work can continue', async (t) => {
  let unavailable = true;
  const calls = [];
  const { scheduler, checkpoints } = await createHarness(t, [task('Unavailable')], {
    async execute(_task, methodId) {
      calls.push(methodId);
      if (methodId === 'second' && unavailable) {
        throw new MethodGenerationRequestError(
          'MODEL_UNAVAILABLE',
          'The selected model is unavailable'
        );
      }
      return null;
    }
  });

  const paused = await scheduler.runTask('Unavailable');
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.lastError?.code, 'MODEL_UNAVAILABLE');
  assert.equal(await checkpoints.hasResumableProgress('Unavailable'), true);

  unavailable = false;
  assert.equal((await scheduler.resumeTask('Unavailable')).state, 'COMPLETED');
  assert.deepEqual(calls, ['first', 'second', 'second']);
});

test('finalization with zero formal test files fails and preserves the model-platform cause', async (t) => {
  let checkpoints;
  const created = await createHarness(t, [task('EmptyResult', 'READY', {
    selectedMethodIds: ['first'],
    methodOrder: ['first']
  })], {
    async execute() { return null; },
    async finalizeRun(currentTask) {
      await checkpoints.recordModelFailure(currentTask.id, {
        code: 'MODEL_RATE_LIMITED',
        message: '已达到大模型平台的请求频率限制。',
        stage: 'generation'
      });
    }
  });
  checkpoints = created.checkpoints;

  const failed = await created.scheduler.runTask('EmptyResult');

  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.generatedArtifacts.length, 0);
  assert.equal(failed.lastError?.code, 'MODEL_NO_FORMAL_TEST_FILE_GENERATED');
  assert.match(failed.lastError?.message ?? '', /MODEL_RATE_LIMITED/);
  assert.match(failed.lastError?.message ?? '', /请求频率限制/);
});

test('finalization with zero formal test files reports a generic project failure without a model cause', async (t) => {
  const { scheduler } = await createHarness(t, [task('EmptyProjectResult', 'READY', {
    selectedMethodIds: ['first'],
    methodOrder: ['first']
  })], {
    async execute() { return null; },
    async finalizeRun() {}
  });

  const failed = await scheduler.runTask('EmptyProjectResult');

  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.generatedArtifacts.length, 0);
  assert.equal(failed.lastError?.code, 'NO_FORMAL_TEST_FILE_GENERATED');
  assert.match(failed.lastError?.message ?? '', /未生成任何正式测试文件/);
});

test('finalization may complete only after at least one formal test file is persisted', async (t) => {
  let registry;
  const created = await createHarness(t, [task('FormalResult', 'READY', {
    selectedMethodIds: ['first'],
    methodOrder: ['first']
  })], {
    async execute() { return null; },
    async finalizeRun(currentTask) {
      const current = registry.snapshot(currentTask.id);
      await registry.save({
        ...current,
        generatedArtifacts: [{
          id: 'artifact-1',
          filePath: 'D:\\workspace\\src\\test\\java\\FormalResult1Test.java',
          testClassName: 'FormalResult1Test',
          ordinaryTestMethodCount: 1,
          methodIds: ['first'],
          sha256: 'a'.repeat(64),
          sealed: true,
          accepted: false,
          createdAt: '2026-08-09T01:00:00.000Z',
          updatedAt: '2026-08-09T01:00:00.000Z'
        }]
      });
    }
  });
  registry = created.registry;

  const completed = await created.scheduler.runTask('FormalResult');

  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.generatedArtifacts.length, 1);
  assert.equal(completed.lastError, null);
});

test('terminateAll touches active tasks only', async (t) => {
  let startedCount = 0;
  let bothStarted;
  const started = new Promise((resolve) => { bothStarted = resolve; });
  const { registry, scheduler } = await createHarness(t, [
    task('RunningA'), task('RunningB'), task('Idle'), task('AlreadyDone', 'COMPLETED')
  ], {
    execute(currentTask, _methodId, _checkpoint, signal) {
      if (currentTask.id === 'Idle') return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        startedCount += 1;
        if (startedCount === 2) bothStarted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });
  const first = scheduler.runTask('RunningA');
  const second = scheduler.runTask('RunningB');
  await started;

  const result = await scheduler.terminateAll();
  await Promise.all([first, second]);

  assert.equal(result.terminatedTaskCount, 2);
  assert.deepEqual(result.snapshots.map((entry) => entry.id).sort(), ['RunningA', 'RunningB']);
  assert.equal(registry.snapshot('RunningA').state, 'TERMINATED');
  assert.equal(registry.snapshot('RunningB').state, 'TERMINATED');
  assert.equal(registry.snapshot('Idle').state, 'READY');
  assert.equal(registry.snapshot('AlreadyDone').state, 'COMPLETED');
});

test('application interruption preserves resumable state instead of terminating active tasks', async (t) => {
  let started;
  const executionStarted = new Promise((resolve) => { started = resolve; });
  const { registry, scheduler } = await createHarness(t, [task('Interrupted')], {
    execute(_currentTask, _methodId, _checkpoint, signal) {
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });
  const running = scheduler.runTask('Interrupted');
  await executionStarted;

  const interrupted = await scheduler.interruptAll();
  const runResult = await running;

  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].state, 'INTERRUPTED');
  assert.equal(runResult.state, 'INTERRUPTED');
  assert.equal(registry.snapshot('Interrupted').state, 'INTERRUPTED');
});

test('terminateTask tolerates the run committing TERMINATED before active lookup resumes', async () => {
  const registry = createRegistry([task('Race', 'READY', {
    selectedMethodIds: ['method'], methodOrder: ['method']
  })]);
  let releaseRunner;
  const runnerBlocked = new Promise((resolve) => { releaseRunner = resolve; });
  let markRunnerStarted;
  const runnerStarted = new Promise((resolve) => { markRunnerStarted = resolve; });
  const checkpoints = {
    snapshot: (taskId) => registry.snapshot(taskId),
    async prepareRun() {},
    async pauseAtBoundary() { return false; },
    async transitionState(taskId, nextState) {
      const current = registry.snapshot(taskId);
      if (current.state === nextState) throw new Error(`duplicate transition to ${nextState}`);
      return registry.save({ ...current, state: nextState, currentAtomicStep: 'IDLE' });
    },
    async requestTermination(taskId) {
      const current = registry.snapshot(taskId);
      await registry.save({ ...current, state: 'STOPPING' });
      releaseRunner();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return registry.snapshot(taskId);
    }
  };
  const scheduler = new ClassTaskSchedulerService({
    registry,
    checkpoints,
    runner: {
      async run() {
        markRunnerStarted();
        await runnerBlocked;
        return 'COMPLETED';
      }
    },
    catalogProvider: { get: async () => catalog('Race', ['method']) },
    validateTask: async () => undefined
  });
  const run = scheduler.runTask('Race');
  await runnerStarted;

  const terminated = await scheduler.terminateTask('Race');
  await run;

  assert.equal(terminated.state, 'TERMINATED');
});

test('concurrent resume callers join one resumed execution', async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let executionCalls = 0;
  const { scheduler } = await createHarness(t, [task('Paused', 'PAUSED')], {
    async execute() {
      executionCalls += 1;
      if (executionCalls === 1) await blocked;
      return null;
    }
  });

  const first = scheduler.resumeTask('Paused');
  const second = scheduler.resumeTask('Paused');
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.state, 'COMPLETED');
  assert.equal(secondResult.state, 'COMPLETED');
  assert.equal(executionCalls, 2);
});

test('terminateAll aborts an active preload validation and settles it as terminated', async (t) => {
  let validationStarted;
  const started = new Promise((resolve) => { validationStarted = resolve; });
  let releaseValidation;
  let validationSignal;
  const { registry, scheduler } = await createHarness(t, [task('Validating')], {
    async execute() { return null; }
  }, {
    validateTask: async (_task, signal) => {
      validationSignal = signal;
      validationStarted();
      await new Promise((resolve, reject) => {
        releaseValidation = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });
  const run = scheduler.runTask('Validating');
  await started;

  const terminating = scheduler.terminateAll();
  await new Promise((resolve) => setImmediate(resolve));
  if (!validationSignal.aborted) releaseValidation();
  const [result, runResult] = await Promise.all([terminating, run]);

  assert.equal(validationSignal.aborted, true);
  assert.equal(result.terminatedTaskCount, 1);
  assert.equal(runResult.state, 'TERMINATED');
  assert.equal(registry.snapshot('Validating').state, 'TERMINATED');
});

test('termination after validation cleanup starts no catalog method work', async (t) => {
  let validationStarted;
  const started = new Promise((resolve) => { validationStarted = resolve; });
  let releaseValidation;
  let executionCalls = 0;
  let validationSignal;
  const { scheduler } = await createHarness(t, [task('Cleanup')], {
    async execute() { executionCalls += 1; return null; }
  }, {
    validateTask: async (_task, signal) => {
      validationSignal = signal;
      validationStarted();
      await new Promise((resolve) => { releaseValidation = resolve; });
    }
  });
  const run = scheduler.runTask('Cleanup');
  await started;

  const terminating = scheduler.terminateAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validationSignal.aborted, true);
  releaseValidation();
  const [termination, snapshot] = await Promise.all([terminating, run]);

  assert.equal(termination.terminatedTaskCount, 1);
  assert.equal(snapshot.state, 'TERMINATED');
  assert.equal(executionCalls, 0);
});

test('terminating a paused task leaves no marker that suppresses its next eligible run', async (t) => {
  let executionCalls = 0;
  const { registry, scheduler } = await createHarness(t, [task('Paused', 'PAUSED')], {
    async execute() { executionCalls += 1; return null; }
  });

  const terminated = await scheduler.terminateTask('Paused');
  const rerun = await scheduler.runTask('Paused');

  assert.equal(terminated.state, 'TERMINATED');
  assert.equal(rerun.state, 'COMPLETED');
  assert.equal(registry.snapshot('Paused').state, 'COMPLETED');
  assert.equal(executionCalls, 2);
});

test('rerunning a terminated task resets completed methods and starts from the first selection', async (t) => {
  const taskId = 'Restart';
  const executionOrder = [];
  const { checkpoints, registry, scheduler } = await createHarness(
    t,
    [task(taskId, 'TERMINATED', { currentMethodIndex: 0 })],
    {
      async execute(_task, methodId) {
        executionOrder.push(methodId);
        return null;
      }
    }
  );
  const methodCatalog = catalog(taskId);
  const catalogIdentity = {
    analysisSessionId: methodCatalog.analysisSessionId,
    reportPairId: methodCatalog.reportPairId
  };
  await checkpoints.prepareRun(taskId, {
    reset: true,
    catalogIdentity,
    resolvedMethodOrder: ['first', 'second']
  });
  await checkpoints.commitMethod(taskId, 'first', catalogIdentity);
  assert.equal(registry.snapshot(taskId).currentMethodIndex, 0);

  const rerun = await scheduler.runTask(taskId);

  assert.equal(rerun.state, 'COMPLETED');
  assert.deepEqual(executionOrder, ['first', 'second']);
  assert.equal(registry.snapshot(taskId).currentMethodIndex, -1);
});

test('READY recovery with an unaccepted formal artifact preserves completed checkpoint work', async (t) => {
  // Mutation caught: treating every READY task as a fresh run replays already published
  // Waves after a failed retry cleans the current unpublished Wave scratch files.
  const taskId = 'Recovered';
  const formalArtifact = {
    id: 'artifact-1',
    filePath: 'D:\\workspace\\src\\test\\java\\Recovered1Test.java',
    testClassName: 'Recovered1Test',
    ordinaryTestMethodCount: 1,
    methodIds: ['first'],
    methodResults: [{
      methodId: 'first',
      methodName: 'first',
      displaySignature: 'first()',
      jacocoOrder: 0,
      ordinaryTestMethodCount: 1
    }],
    sha256: 'a'.repeat(64),
    sealed: true,
    accepted: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
  const executionOrder = [];
  const { checkpoints, scheduler } = await createHarness(
    t,
    [task(taskId, 'READY', {
      currentMethodIndex: 0,
      generatedArtifacts: [formalArtifact]
    })],
    {
      async execute(_task, methodId) {
        executionOrder.push(methodId);
        return null;
      }
    }
  );
  const methodCatalog = catalog(taskId);
  const catalogIdentity = {
    analysisSessionId: methodCatalog.analysisSessionId,
    reportPairId: methodCatalog.reportPairId
  };
  await checkpoints.prepareRun(taskId, {
    reset: true,
    catalogIdentity,
    resolvedMethodOrder: ['first', 'second']
  });
  await checkpoints.commitMethod(taskId, 'first', catalogIdentity);

  const recovered = await scheduler.runTask(taskId, {
    preserveCheckpoint: true
  });

  assert.equal(recovered.state, 'COMPLETED');
  assert.deepEqual(executionOrder, ['second']);
  assert.deepEqual(recovered.generatedArtifacts, [formalArtifact]);
});

test('termination is rechecked after every pre-execution await', async (t) => {
  for (const blockedStage of ['prepare', 'transition', 'catalog']) {
    await t.test(blockedStage, async () => {
      let current = task(`Gate-${blockedStage}`);
      let releaseStage;
      let markStageStarted;
      const stageStarted = new Promise((resolve) => { markStageStarted = resolve; });
      const stageBlocked = new Promise((resolve) => { releaseStage = resolve; });
      let catalogCalls = 0;
      let runnerCalls = 0;
      const registry = {
        list: () => [structuredClone(current)],
        snapshot: () => structuredClone(current)
      };
      const checkpoints = {
        snapshot: () => structuredClone(current),
        async pauseAtBoundary() { return false; },
        async prepareRun() {
          if (blockedStage === 'prepare') {
            markStageStarted();
            await stageBlocked;
          }
          return {
            catalogIdentity: null,
            resolvedMethodOrder: [],
            completedMethodIds: [],
            methods: {}
          };
        },
        async transitionState(_taskId, nextState) {
          current = { ...current, state: nextState };
          const captured = structuredClone(current);
          if (nextState === 'RUNNING' && blockedStage === 'transition') {
            markStageStarted();
            await stageBlocked;
          }
          return captured;
        },
        async requestTermination() {
          current = { ...current, state: 'STOPPING' };
          return structuredClone(current);
        }
      };
      const scheduler = new ClassTaskSchedulerService({
        registry,
        checkpoints,
        runner: {
          async run() { runnerCalls += 1; return 'COMPLETED'; }
        },
        catalogProvider: {
          async get(taskId) {
            catalogCalls += 1;
            if (blockedStage === 'catalog') {
              markStageStarted();
              await stageBlocked;
            }
            return catalog(taskId, ['method']);
          }
        },
        validateTask: async () => undefined
      });
      const run = scheduler.runTask(current.id);
      await stageStarted;

      const terminating = scheduler.terminateTask(current.id);
      await new Promise((resolve) => setImmediate(resolve));
      releaseStage();
      const [runResult, terminateResult] = await Promise.all([run, terminating]);

      assert.equal(runResult.state, 'TERMINATED');
      assert.equal(terminateResult.state, 'TERMINATED');
      assert.equal(catalogCalls, blockedStage === 'catalog' ? 1 : 0);
      assert.equal(runnerCalls, 0);
    });
  }
});
