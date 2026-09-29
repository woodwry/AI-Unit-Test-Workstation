import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExecutableModuleMavenReadyQueue,
  ModuleMavenReadyQueueService
} from '../src/main/services/module-maven-ready-queue.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function candidate(moduleKey, taskId, candidateId, environmentFingerprint = 'env-1') {
  return { moduleKey, taskId, candidateId, environmentFingerprint };
}

test('batches FIFO-ready candidates per module without overlapping one module', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const batches = [];
  let activeModuleA = 0;
  const queue = new ModuleMavenReadyQueueService({
    moduleLock: new ModuleOperationLock(),
    async executeBatch(items) {
      const moduleKey = items[0].moduleKey;
      if (moduleKey === 'module-a') {
        activeModuleA += 1;
        assert.equal(activeModuleA, 1, 'same-module Maven batches must never overlap');
      }
      batches.push(items.map((item) => item.candidateId));
      if (items[0].candidateId === 'A1') {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (moduleKey === 'module-a') activeModuleA -= 1;
      return new Map(items.map((item) => [item.candidateId, {
        candidateId: item.candidateId,
        status: 'passed'
      }]));
    }
  });

  const first = queue.enqueue(candidate('module-a', 'task-a', 'A1'));
  await firstStarted.promise;
  const second = queue.enqueue(candidate('module-a', 'task-b', 'B1'));
  const duplicateCard = queue.enqueue(candidate('module-a', 'task-b', 'B2'));
  const third = queue.enqueue(candidate('module-a', 'task-c', 'C1'));
  releaseFirst.resolve();

  const results = await Promise.all([first, second, duplicateCard, third]);

  assert.deepEqual(batches, [['A1'], ['B1', 'C1'], ['B2']]);
  assert.deepEqual(results.map((item) => item.candidateId), ['A1', 'B1', 'B2', 'C1']);
});

test('runs a repaired class after the already-ready B and C class batch', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const middleStarted = deferred();
  const releaseMiddle = deferred();
  const batches = [];
  const queue = new ModuleMavenReadyQueueService({
    moduleLock: new ModuleOperationLock(),
    async executeBatch(items) {
      const ids = items.map((item) => item.candidateId);
      batches.push(ids);
      if (ids[0] === 'A-first') {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else if (ids.includes('B-first')) {
        middleStarted.resolve();
        await releaseMiddle.promise;
      }
      return new Map(items.map((item) => [item.candidateId, {
        candidateId: item.candidateId,
        status: 'passed'
      }]));
    }
  });

  const first = queue.enqueue(candidate('module-a', 'task-a', 'A-first'));
  await firstStarted.promise;
  const second = queue.enqueue(candidate('module-a', 'task-b', 'B-first'));
  const third = queue.enqueue(candidate('module-a', 'task-c', 'C-first'));
  releaseFirst.resolve();
  await middleStarted.promise;
  const repair = queue.enqueue(candidate('module-a', 'task-a', 'A-repair'));
  releaseMiddle.resolve();

  await Promise.all([first, second, third, repair]);

  assert.deepEqual(batches, [
    ['A-first'],
    ['B-first', 'C-first'],
    ['A-repair']
  ]);
});

test('caps a batch at five and lets different modules execute concurrently', async () => {
  const bothStarted = deferred();
  const release = deferred();
  const activeModules = new Set();
  const batches = [];
  const queue = new ModuleMavenReadyQueueService({
    moduleLock: new ModuleOperationLock(),
    async executeBatch(items) {
      const moduleKey = items[0].moduleKey;
      activeModules.add(moduleKey);
      batches.push(items.map((item) => item.candidateId));
      if (activeModules.size === 2) bothStarted.resolve();
      await release.promise;
      activeModules.delete(moduleKey);
      return new Map(items.map((item) => [item.candidateId, {
        candidateId: item.candidateId,
        status: 'passed'
      }]));
    }
  });

  const moduleA = Array.from({ length: 6 }, (_, index) => queue.enqueue(candidate(
    'module-a',
    `task-a-${index + 1}`,
    `A${index + 1}`
  )));
  const moduleB = queue.enqueue(candidate('module-b', 'task-b', 'B1'));
  await bothStarted.promise;
  assert.deepEqual([...activeModules].sort(), ['module-a', 'module-b']);
  release.resolve();
  await Promise.all([...moduleA, moduleB]);

  assert.ok(batches.some((batch) => batch.length === 5));
  assert.ok(batches.every((batch) => batch.length <= 5));
});

test('production queue executes different cards in one Maven batch and preserves per-candidate placement', async () => {
  const buildSettings = {
    mavenHome: 'D:\\tools\\maven',
    javaHome: 'D:\\tools\\jdk',
    settingsPath: 'D:\\tools\\maven\\conf\\settings.xml',
    localRepository: 'D:\\m2'
  };
  const batches = [];
  const placements = [];
  const phases = [];
  const maven = {
    async executeBatch(input) {
      batches.push({
        attemptId: input.attemptId,
        candidateIds: input.candidates.map((item) => item.candidateId),
        classNames: input.candidates.map((item) => item.qualifiedTestClassName)
      });
      await input.placement.activate(input.candidates);
      await input.onPhaseStart('test_compile');
      await input.onPhaseComplete('test_compile');
      await input.placement.isolate([input.candidates[1]]);
      return new Map([
        [input.candidates[0].candidateId, {
          candidateId: input.candidates[0].candidateId,
          status: 'passed',
          mavenExecutions: []
        }],
        [input.candidates[1].candidateId, {
          candidateId: input.candidates[1].candidateId,
          status: 'test_failed',
          mavenExecutions: []
        }]
      ]);
    }
  };
  let batchIndex = 0;
  const queue = createExecutableModuleMavenReadyQueue({
    moduleLock: new ModuleOperationLock(),
    maven,
    idFactory: () => `batch-${++batchIndex}`
  });
  const executableCandidate = (taskId, candidateId, className) => ({
    moduleKey: 'module-a',
    environmentFingerprint: 'same-maven-environment',
    taskId,
    candidateId,
    moduleRoot: 'D:\\work\\manager-core',
    buildSettings,
    scope: 'method_candidate',
    filePath: `D:\\work\\manager-core\\src\\test\\java\\demo\\${className}.java`,
    qualifiedTestClassName: `demo.${className}`,
    excludedEnvironmentVariables: ['MODEL_API_KEY'],
    async onBatchStart(id) { phases.push(`${candidateId}:batch:${id}`); },
    async onPhaseStart(phase) { phases.push(`${candidateId}:start:${phase}`); },
    async onPhaseComplete(phase) { phases.push(`${candidateId}:complete:${phase}`); },
    async activate() { placements.push(`${candidateId}:activate`); },
    async isolate() { placements.push(`${candidateId}:isolate`); }
  });

  const [first, second] = await Promise.all([
    queue.enqueue(executableCandidate('task-a', 'candidate-a', 'ATmp1Test')),
    queue.enqueue(executableCandidate('task-b', 'candidate-b', 'BTmp1Test'))
  ]);

  assert.deepEqual(batches, [{
    attemptId: 'batch-1',
    candidateIds: ['candidate-a', 'candidate-b'],
    classNames: ['demo.ATmp1Test', 'demo.BTmp1Test']
  }]);
  assert.deepEqual(placements, [
    'candidate-a:activate',
    'candidate-b:activate',
    'candidate-b:isolate'
  ]);
  assert.deepEqual(phases, [
    'candidate-a:batch:batch-1',
    'candidate-b:batch:batch-1',
    'candidate-a:start:test_compile',
    'candidate-b:start:test_compile',
    'candidate-a:complete:test_compile',
    'candidate-b:complete:test_compile'
  ]);
  assert.equal(first.status, 'passed');
  assert.equal(second.status, 'test_failed');
});
