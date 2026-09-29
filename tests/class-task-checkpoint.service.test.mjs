import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ClassTaskCheckpointService
} from '../src/main/services/class-task-checkpoint.service.ts';

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

