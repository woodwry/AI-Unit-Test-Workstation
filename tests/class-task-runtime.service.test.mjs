import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ClassTaskRuntimeService,
  analysisResponseTimeoutRetryDelayMilliseconds,
  createProductionClassTaskRuntime,
  recoverPersistedWaveCandidateMoves,
  shouldIncludeTaskOwnedArtifactsInFingerprint,
  shouldPreserveFailedRunWaveCheckpoint,
  shouldRefreshCoverageForArtifact,
  shouldCleanupCompletedBatchTemporaryFile,
  shouldDiscardBatchTemporaryFileOnRestart
} from '../src/main/services/class-task-runtime.service.ts';
import { JacocoArtifactsService } from '../src/main/services/jacoco-artifacts.service.ts';
import {
  MethodAnalysisRequestError,
  MethodAnalysisResponseInvalidError
} from '../src/main/services/method-analysis-contract.ts';
import { MethodGenerationRequestError } from '../src/main/services/method-generation-contract.ts';
import { ClassTaskApplicationInterruptedError } from '../src/main/services/class-task-interruption.ts';
import { ClassTaskFileTransactionService } from '../src/main/services/class-task-file-transaction.service.ts';
import { MethodWavePartStoreService } from '../src/main/services/method-wave-part-store.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';

const WORKSPACE = 'D:\\workspace';
const TASK_ID = '11111111-1111-4111-8111-111111111111';

test('Analyzer response timeout retries use capped exponential delays', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((retryIndex) => (
      analysisResponseTimeoutRetryDelayMilliseconds(retryIndex, 1_000, 8_000)
    )),
    [1_000, 2_000, 4_000, 8_000, 8_000]
  );
});

function waveScratchTaskDirectory(workspaceRoot, directoryName) {
  return join(
    workspaceRoot,
    '.ai-unit-test',
    directoryName,
    createHash('sha256').update(TASK_ID, 'utf8').digest('hex').slice(0, 24)
  );
}

test('temporary cleanup preserves final-round failed test files', () => {
  const retained = {
    outcome: 'DROPPED',
    tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java',
    tmpFileSha256: 'a'.repeat(64)
  };
  const verified = { ...retained, outcome: 'PASSED' };
  const formalized = { ...retained, outcome: 'RETAINED' };

  assert.equal(shouldCleanupCompletedBatchTemporaryFile(retained), false);
  assert.equal(shouldCleanupCompletedBatchTemporaryFile(verified), true);
  assert.equal(shouldCleanupCompletedBatchTemporaryFile(formalized), true);
});

test('fresh generation discards both passed and dropped owned TMP batches', () => {
  const dropped = {
    outcome: 'DROPPED',
    tmpFilePath: 'D:\\workspace\\TaskTmp1Test.java',
    tmpFileSha256: 'a'.repeat(64)
  };
  const passed = { ...dropped, outcome: 'PASSED' };

  assert.equal(shouldDiscardBatchTemporaryFileOnRestart(dropped), true);
  assert.equal(shouldDiscardBatchTemporaryFileOnRestart(passed), true);
  assert.equal(shouldDiscardBatchTemporaryFileOnRestart({
    ...dropped,
    tmpFilePath: null,
    tmpFileSha256: null
  }), false);
});

test('coverage refresh waits until a formal file contains an active test method', () => {
  assert.equal(shouldRefreshCoverageForArtifact({ ordinaryTestMethodCount: 0 }), false);
  assert.equal(shouldRefreshCoverageForArtifact({ ordinaryTestMethodCount: 1 }), true);
});

test('failed-run Wave checkpoint is preserved for a recoverable model-repair candidate', () => {
  const methodId = 'method-id';
  const waveId = 'b'.repeat(64);
  const candidateId = '66666666-6666-4666-8666-666666666666';
  const candidate = {
    candidateId,
    methodId,
    waveId,
    status: 'MODEL_REPAIR',
    llmRepairAttemptsUsed: 3,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-1',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: `${WORKSPACE}\\.ai-unit-test\\method-wave-candidates\\${candidateId}\\TaskTmp1Test.java`,
      sha256: 'a'.repeat(64),
      location: 'ISOLATED'
    },
    moveTransaction: null
  };
  const wave = {
    methodQueue: [],
    activeMethodId: methodId,
    methods: {},
    activeWave: {
      eventSequence: 3,
      startRequest: null,
      methodId,
      waveId,
      waveIndex: 1,
      selectedScenarioIds: ['scenario-1'],
      remainingScenarioCount: 0,
      wave: null,
      initialUsageRecorded: true,
      parts: []
    },
    candidates: { [candidateId]: candidate },
    migrationInterrupted: false
  };

  assert.equal(shouldPreserveFailedRunWaveCheckpoint(wave, new Set()), true);
});

test('failed-run Wave checkpoint is not preserved for completed or blocked-only work', () => {
  const methodId = 'method-id';
  const waveId = 'b'.repeat(64);
  const candidateId = '66666666-6666-4666-8666-666666666666';
  const baseWave = {
    methodQueue: [],
    activeMethodId: null,
    methods: {},
    activeWave: null,
    candidates: {},
    migrationInterrupted: false
  };
  const blockedCandidate = {
    candidateId,
    methodId,
    waveId,
    status: 'BLOCKED',
    llmRepairAttemptsUsed: 5,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-1',
    stableRepair: {
      phase: 'BLOCKED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: null,
    moveTransaction: null
  };

  assert.equal(
    shouldPreserveFailedRunWaveCheckpoint({
      ...baseWave,
      candidates: { [candidateId]: blockedCandidate }
    }, new Set()),
    false
  );
  assert.equal(
    shouldPreserveFailedRunWaveCheckpoint({
      ...baseWave,
      methods: {
        [methodId]: {
          completedScenarioIds: [],
          skippedScenarioIds: [],
          nextWaveIndex: 2,
          remainingScenarioCount: 0,
          completedWaves: [{
            waveId,
            waveIndex: 1,
            selectedScenarioIds: ['scenario-1'],
            completedScenarioIds: ['scenario-1'],
            skippedScenarioIds: [],
            remainingScenarioCount: 0,
            candidateIds: [candidateId]
          }]
        }
      }
    }, new Set([methodId])),
    false
  );
});
test('task-owned tests enter the project fingerprint only after completion or termination', () => {
  assert.equal(shouldIncludeTaskOwnedArtifactsInFingerprint('COMPLETED'), true);
  assert.equal(shouldIncludeTaskOwnedArtifactsInFingerprint('TERMINATED'), true);
  for (const state of [
    'PRELOADING', 'READY', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED',
    'STOPPING', 'INTERRUPTED', 'FAILED', 'PRELOAD_FAILED'
  ]) {
    assert.equal(shouldIncludeTaskOwnedArtifactsInFingerprint(state), false, state);
  }
});

test('startup recovery completes a half-moved Wave candidate and clears its journal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wave-candidate-startup-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const sourcePath = join(
    workspaceRoot,
    '.ai-unit-test',
    'wave-candidates',
    'candidate-1',
    'TaskTmp1Test.java'
  );
  const targetPath = join(
    workspaceRoot,
    'module-a',
    'src',
    'test',
    'java',
    'example',
    'TaskTmp1Test.java'
  );
  const code = 'package example; public class TaskTmp1Test {}\n';
  const digest = createHash('sha256').update(code).digest('hex');
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, code, 'utf8');
  const candidate = {
    candidateId: '66666666-6666-4666-8666-666666666666',
    methodId: 'a'.repeat(64),
    waveId: 'b'.repeat(64),
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
      path: sourcePath,
      sha256: digest,
      location: 'ISOLATED'
    },
    moveTransaction: {
      sourcePath,
      targetPath,
      sha256: digest,
      phase: 'PREPARED'
    }
  };
  const saved = [];

  await recoverPersistedWaveCandidateMoves({
    taskId: TASK_ID,
    workspaceRoot,
    candidates: { [candidate.candidateId]: candidate },
    transaction: new ClassTaskFileTransactionService({
      writer: new TestWriterService()
    }),
    async saveCandidate(value) {
      saved.push(structuredClone(value));
      return structuredClone(value);
    }
  });

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].managedFile, {
    path: targetPath,
    sha256: digest,
    location: 'PROJECT'
  });
  assert.equal(saved[0].moveTransaction, null);
  await access(targetPath);
  await assert.rejects(access(sourcePath), (error) => error?.code === 'ENOENT');
});

test('startup isolates a Wave move hash conflict without deleting files or blocking sibling tasks', async (t) => {
  // Mutation caught: allowing one recoverWaveCandidateMove rejection to escape restore()
  // prevents the Workstation from opening every persisted class task.
  const h = await productionWaveRuntimeHarness(t);
  const siblingTaskId = '22222222-2222-4222-8222-222222222222';
  const candidateId = '66666666-6666-4666-8666-666666666666';
  const methodId = 'a'.repeat(64);
  const waveId = 'b'.repeat(64);
  const sourcePath = join(
    h.workspaceRoot,
    '.ai-unit-test',
    'wave-candidates',
    candidateId,
    'TaskTmp1Test.java'
  );
  const targetPath = join(
    h.workspaceRoot,
    'module-a',
    'src',
    'test',
    'java',
    'example',
    'TaskTmp1Test.java'
  );
  const expectedCode = 'package example; public class TaskTmp1Test {}\n';
  const conflictingCode = 'package example; public class TaskTmp1Test { int changed; }\n';
  const expectedSha256 = createHash('sha256').update(expectedCode).digest('hex');
  await mkdir(dirname(sourcePath), { recursive: true });
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(sourcePath, expectedCode, 'utf8');
  await writeFile(targetPath, conflictingCode, 'utf8');

  const taskStorePath = join(h.storageDirectory, 'class-tasks-v2.json');
  const taskStore = JSON.parse(await readFile(taskStorePath, 'utf8'));
  const siblingSourcePath = join(
    h.workspaceRoot,
    'module-a',
    'src',
    'main',
    'java',
    'example',
    'Sibling.java'
  );
  await writeFile(
    siblingSourcePath,
    'package example; public class Sibling {}\n',
    'utf8'
  );
  taskStore.tasks[siblingTaskId] = task(siblingTaskId, 'READY', {
    workspaceRoot: h.workspaceRoot,
    sourceFilePath: siblingSourcePath,
    qualifiedClassName: 'example.Sibling',
    moduleKey: taskStore.tasks[TASK_ID].moduleKey,
    moduleDisplayPath: taskStore.tasks[TASK_ID].moduleDisplayPath
  });
  await writeFile(taskStorePath, JSON.stringify(taskStore), 'utf8');

  const candidate = {
    candidateId,
    methodId,
    waveId,
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
      path: sourcePath,
      sha256: expectedSha256,
      location: 'ISOLATED'
    },
    moveTransaction: {
      sourcePath,
      targetPath,
      sha256: expectedSha256,
      phase: 'PREPARED'
    }
  };
  await writeFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    JSON.stringify({
      version: 5,
      tasks: {
        [TASK_ID]: storedTaskCheckpoint({
          candidates: { [candidateId]: candidate }
        }),
        [siblingTaskId]: storedTaskCheckpoint()
      }
    }),
    'utf8'
  );

  const restored = await h.runtime.startup();
  const conflicted = restored.find((snapshot) => snapshot.id === TASK_ID);
  const sibling = restored.find((snapshot) => snapshot.id === siblingTaskId);

  assert.equal(conflicted?.state, 'INTERRUPTED');
  assert.equal(conflicted?.lastError?.code, 'WAVE_CANDIDATE_MOVE_RECOVERY_FAILED');
  assert.match(conflicted?.lastError?.message ?? '', /candidate.*66666666/i);
  assert.match(conflicted?.lastError?.message ?? '', /digest.*checkpoint/i);
  assert.equal(sibling?.state, 'READY');
  assert.equal(await readFile(sourcePath, 'utf8'), expectedCode);
  assert.equal(await readFile(targetPath, 'utf8'), conflictingCode);
});

test('startup isolates an interrupted MAVEN_RUNNING Wave TMP before any class preload', async (t) => {
  // Mutation caught: deferring project TMP isolation until executeWave lets prepareTask run
  // module-wide Maven against the unfinished generated source after Workstation restarts.
  const h = await productionWaveRuntimeHarness(t);
  const candidateId = '99999999-9999-4999-8999-999999999999';
  const code = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskTmp1Test {',
    '  @Test void unfinished() { invalid source; }',
    '}',
    ''
  ].join('\n');
  const digest = createHash('sha256').update(code).digest('hex');
  const isolationFilePath = join(
    waveScratchTaskDirectory(h.workspaceRoot, 'method-wave-candidates'),
    candidateId,
    'TaskTmp1Test.java'
  );
  await mkdir(dirname(h.tmpFilePath), { recursive: true });
  await writeFile(h.tmpFilePath, code, 'utf8');

  const taskStorePath = join(h.storageDirectory, 'class-tasks-v2.json');
  const taskStore = JSON.parse(await readFile(taskStorePath, 'utf8'));
  taskStore.tasks[TASK_ID] = {
    ...taskStore.tasks[TASK_ID],
    state: 'INTERRUPTED',
    startedAt: '2026-08-22T00:00:00.000Z',
    finishedAt: '2026-08-22T00:01:00.000Z'
  };
  await writeFile(taskStorePath, JSON.stringify(taskStore), 'utf8');

  const candidate = {
    candidateId,
    methodId: h.methodId,
    waveId: 'c'.repeat(64),
    status: 'MAVEN_RUNNING',
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
      path: h.tmpFilePath,
      sha256: digest,
      location: 'PROJECT'
    },
    moveTransaction: null
  };
  await writeFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    JSON.stringify({
      version: 5,
      tasks: {
        [TASK_ID]: storedTaskCheckpoint({
          candidates: { [candidateId]: candidate }
        })
      }
    }),
    'utf8'
  );

  let classReportCount = 0;
  const originalClassReport = h.runtimeOptions.aiClient
    .generateTargetJacocoReport.bind(h.runtimeOptions.aiClient);
  h.runtimeOptions.aiClient.generateTargetJacocoReport = async (...args) => {
    classReportCount += 1;
    await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
    await access(isolationFilePath);
    return originalClassReport(...args);
  };

  const [restored] = await h.runtime.startup();
  assert.equal(restored.state, 'INTERRUPTED');
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  await access(isolationFilePath);

  await h.runtime.getClassTaskMethods({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(classReportCount, 1);

  const stored = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  assert.deepEqual(stored.tasks[TASK_ID].waveState.candidates[candidateId], {
    ...candidate,
    status: 'READY_FOR_MAVEN',
    managedFile: {
      path: isolationFilePath,
      sha256: digest,
      location: 'ISOLATED'
    }
  });
});

test('startup adopts a changed managed Wave TMP before isolating it from class preload', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  const candidateId = '88888888-8888-4888-8888-888888888888';
  const staleCode = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskTmp1Test {',
    '  @Test void beforeInterruption() {}',
    '}',
    ''
  ].join('\n');
  const currentCode = staleCode.replace(
    'beforeInterruption() {}',
    'afterInterruption() { MissingType value = null; }'
  );
  const staleDigest = createHash('sha256').update(staleCode).digest('hex');
  const currentDigest = createHash('sha256').update(currentCode).digest('hex');
  const isolationFilePath = join(
    waveScratchTaskDirectory(h.workspaceRoot, 'method-wave-candidates'),
    candidateId,
    'TaskTmp1Test.java'
  );
  await mkdir(dirname(h.tmpFilePath), { recursive: true });
  await writeFile(h.tmpFilePath, currentCode, 'utf8');

  const taskStorePath = join(h.storageDirectory, 'class-tasks-v2.json');
  const taskStore = JSON.parse(await readFile(taskStorePath, 'utf8'));
  taskStore.tasks[TASK_ID] = {
    ...taskStore.tasks[TASK_ID],
    state: 'INTERRUPTED',
    startedAt: '2026-08-22T00:00:00.000Z',
    finishedAt: '2026-08-22T00:01:00.000Z'
  };
  await writeFile(taskStorePath, JSON.stringify(taskStore), 'utf8');

  const candidate = {
    candidateId,
    methodId: h.methodId,
    waveId: 'c'.repeat(64),
    status: 'MAVEN_RUNNING',
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
      path: h.tmpFilePath,
      sha256: staleDigest,
      location: 'PROJECT'
    },
    moveTransaction: null
  };
  await writeFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    JSON.stringify({
      version: 5,
      tasks: {
        [TASK_ID]: storedTaskCheckpoint({
          candidates: { [candidateId]: candidate }
        })
      }
    }),
    'utf8'
  );

  let classReportCount = 0;
  const originalClassReport = h.runtimeOptions.aiClient
    .generateTargetJacocoReport.bind(h.runtimeOptions.aiClient);
  h.runtimeOptions.aiClient.generateTargetJacocoReport = async (...args) => {
    classReportCount += 1;
    await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
    assert.equal(await readFile(isolationFilePath, 'utf8'), currentCode);
    return originalClassReport(...args);
  };

  const [restored] = await h.runtime.startup();
  assert.equal(restored.state, 'INTERRUPTED');
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  assert.equal(await readFile(isolationFilePath, 'utf8'), currentCode);

  await h.runtime.getClassTaskMethods({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(classReportCount, 1);

  const stored = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  assert.deepEqual(stored.tasks[TASK_ID].waveState.candidates[candidateId], {
    ...candidate,
    status: 'READY_FOR_MAVEN',
    managedFile: {
      path: isolationFilePath,
      sha256: currentDigest,
      location: 'ISOLATED'
    }
  });
});

function storedTaskCheckpoint({ candidates = {} } = {}) {
  return {
    catalogIdentity: null,
    resolvedMethodOrder: [],
    completedMethodIds: [],
    methods: {},
    ragRun: null,
    waveState: {
      methodQueue: [],
      activeMethodId: null,
      methods: {},
      activeWave: null,
      candidates,
      migrationInterrupted: false
    }
  };
}

function task(id = TASK_ID, state = 'READY', overrides = {}) {
  return {
    id,
    workspaceRoot: WORKSPACE,
    sourceFilePath: `${WORKSPACE}\\src\\main\\java\\example\\Task.java`,
    qualifiedClassName: 'example.Task',
    moduleKey: 'd:/workspace/module-a/pom.xml',
    moduleDisplayPath: `${WORKSPACE}\\module-a`,
    state,
    preloadState: state === 'PRELOADING' ? 'RUNNING' : 'READY',
    ragEnabled: false,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-id'],
    methodOrder: ['method-id'],
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

function generatedArtifact(accepted = false) {
  return {
    id: 'artifact-1',
    filePath: `${WORKSPACE}\\src\\test\\java\\example\\Task1Test.java`,
    testClassName: 'Task1Test',
    ordinaryTestMethodCount: 1,
    methodIds: ['method-id'],
    sha256: 'a'.repeat(64),
    sealed: true,
    accepted,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
}

function catalog(taskId = TASK_ID) {
  return {
    taskId,
    analysisSessionId: '22222222-2222-4222-8222-222222222222',
    reportPairId: 'pair',
    reportCoverageTotals: {
      instructionCovered: 0,
      instructionMissed: 2,
      branchCovered: 0,
      branchMissed: 0,
      complexityCovered: 0,
      complexityMissed: 1,
      lineCovered: 0,
      lineMissed: 2
    },
    methods: [{
      methodId: 'method-id', methodName: 'method', descriptor: '()V',
      displaySignature: 'method()', firstLine: 1, lastLine: 2, jacocoOrder: 0,
      lineCovered: 0, lineMissed: 2, branchCovered: 0, branchMissed: 0,
      instructionCovered: 0, instructionMissed: 4, complexityCovered: 0, complexityMissed: 1,
      coverageGap: true, generatable: true, unavailableReason: null,
      modifiers: ['public']
    }],
    warnings: [],
    refreshedAt: '2026-08-09T00:00:00.000Z'
  };
}

function harness(initial = [task()], options = {}) {
  const tasks = new Map(initial.map((entry) => [entry.id, structuredClone(entry)]));
  const events = [];
  const prepareCalls = [];
  const schedulerRunCalls = [];
  const recordedTaskExecutions = [];
  const registry = {
    async initialize() { events.push('initialize'); return this.list(); },
    async add(request) {
      events.push(`add:${request.classFilePaths.length}`);
      const added = task();
      tasks.set(added.id, added);
      return { focusedTaskId: added.id, addedTaskIds: [added.id], snapshots: [structuredClone(added)] };
    },
    async remove(taskId) { events.push(`remove:${taskId}`); tasks.delete(taskId); },
    list(workspaceRoot) {
      return [...tasks.values()]
        .filter((entry) => !workspaceRoot || entry.workspaceRoot === workspaceRoot)
        .map((entry) => structuredClone(entry));
    },
    snapshot(taskId) { return structuredClone(tasks.get(taskId)); },
    async save(snapshot) { tasks.set(snapshot.id, structuredClone(snapshot)); return structuredClone(snapshot); },
    async saveSelection(taskId, selectionMode, selectedMethodIds, methodOrder, ragEnabled) {
      events.push(`selection:${selectionMode}:${methodOrder.join(',')}`);
      const current = tasks.get(taskId);
      const next = {
        ...current,
        selectionMode,
        selectedMethodIds: [...selectedMethodIds],
        methodOrder: [...methodOrder],
        ragEnabled
      };
      tasks.set(taskId, next);
      return structuredClone(next);
    }
  };
  const coordinator = {
    async restore(snapshots) { events.push(`restore:${snapshots.length}`); },
    async prepare(taskId, _signal, options) {
      events.push(`prepare:${taskId}`);
      prepareCalls.push({ taskId, forceReload: options?.forceReload === true });
      return catalog(taskId);
    },
    async restart(taskId) { events.push(`restart:${taskId}`); },
    async isMethodCatalogCurrent(taskId, fingerprint) {
      events.push(`check-methods:${taskId}:${fingerprint}`);
      return fingerprint === 'a'.repeat(64);
    },
    peekPreparedMethodCatalog(taskId) {
      events.push(`peek-methods:${taskId}`);
      return catalog(taskId);
    },
    peekPreparedCoverageReport() { return null; },
    async finish(taskId) { events.push(`finish:${taskId}`); },
    async remove(taskId) { events.push(`release:${taskId}`); },
    async getResult(taskId) { events.push(`result:${taskId}`); return null; },
    async accept(taskId) { events.push(`accept:${taskId}`); return { taskId }; },
    async revoke(taskId) { events.push(`revoke:${taskId}`); return { taskId }; },
    async retryClassPreload(taskId) { events.push(`retry:${taskId}`); },
    async stopClassPreload(taskId) { events.push(`stop:${taskId}`); },
    async refreshGenerationModel(taskId) { events.push(`refresh-model:${taskId}`); },
    async releaseRun(taskId) { events.push(`release-run:${taskId}`); },
    async abort() { events.push('abort-preloads'); }
  };
  const scheduler = {
    async runTask(taskId, options) {
      schedulerRunCalls.push({
        taskId,
        options: structuredClone(options ?? {})
      });
      events.push(`run:${taskId}`);
      const current = tasks.get(taskId);
      const next = { ...current, state: 'COMPLETED' };
      tasks.set(taskId, next);
      return structuredClone(next);
    },
    async requestPause(taskId) { events.push(`pause:${taskId}`); return registry.snapshot(taskId); },
    async pauseAtBoundaryAndWait(taskId) {
      events.push(`pause-boundary:${taskId}`);
      return registry.snapshot(taskId);
    },
    async runBackgroundOperationAtBoundary(taskId, operation) {
      events.push(`background-boundary:${taskId}`);
      return operation();
    },
    async resumeTask(taskId) { events.push(`resume:${taskId}`); return registry.snapshot(taskId); },
    async terminateTask(taskId) { events.push(`terminate:${taskId}`); return registry.snapshot(taskId); },
    async interruptAll() { events.push('interrupt-all'); return []; },
    async terminateAll() { events.push('terminate-all'); return { terminatedTaskCount: 0, snapshots: [] }; }
  };
  const runtime = new ClassTaskRuntimeService({
    registry,
    scheduler,
    coordinator,
    reportTotals: options.reportTotals,
    recordTaskExecution: async () => { recordedTaskExecutions.push('recorded'); },
    flushTaskState: async () => events.push('flush-tasks'),
    flushPreloadCache: async () => events.push('flush-cache'),
    clock: () => new Date('2026-08-09T02:00:00.000Z')
  });
  return {
    runtime,
    registry,
    coordinator,
    scheduler,
    events,
    prepareCalls,
    schedulerRunCalls,
    recordedTaskExecutions,
    tasks
  };
}

test('startup restores persisted ownership without automatically starting generation', async () => {
  const { runtime, events } = harness();

  const snapshots = await runtime.startup();

  assert.equal(snapshots.length, 1);
  assert.deepEqual(events, ['initialize', 'restore:1']);
  assert.equal(events.some((entry) => entry.startsWith('run:')), false);
});

test('startup resumes only persisted Maven preloads without starting interrupted generation', async () => {
  const preloadTaskId = '22222222-2222-4222-8222-222222222222';
  const generationTaskId = '33333333-3333-4333-8333-333333333333';
  const { runtime, events } = harness([
    task(preloadTaskId, 'PRELOADING', { preloadState: 'IDLE' }),
    task(generationTaskId, 'INTERRUPTED')
  ]);

  await runtime.startup();
  await runtime.flush();

  assert.equal(events.includes(`prepare:${preloadTaskId}`), true);
  assert.equal(events.includes(`prepare:${generationTaskId}`), false);
  assert.equal(events.some((entry) => entry.startsWith('run:')), false);
});

test('closing the Workstation interrupts generation without using user termination semantics', async () => {
  const { runtime, events } = harness([task(TASK_ID, 'RUNNING')]);
  await runtime.startup();

  await runtime.beforeQuit();

  assert.equal(events.includes('interrupt-all'), true);
  assert.equal(events.includes('terminate-all'), false);
  assert.equal(events.includes('abort-preloads'), true);
});

test('startup rechecks every persisted preload failure in the background', async () => {
  // Mutation caught: handling only PRELOADING leaves failed cards waiting for a manual refresh.
  const firstFailedTaskId = '44444444-4444-4444-8444-444444444444';
  const secondFailedTaskId = '55555555-5555-4555-8555-555555555555';
  const { runtime, coordinator, events } = harness([
    task(firstFailedTaskId, 'PRELOAD_FAILED', { preloadState: 'FAILED' }),
    task(secondFailedTaskId, 'PRELOAD_FAILED', { preloadState: 'FAILED' }),
    task(TASK_ID, 'READY')
  ]);
  let releaseRetries;
  const retryGate = new Promise((resolve) => { releaseRetries = resolve; });
  coordinator.retryClassPreload = async (taskId) => {
    events.push(`retry:${taskId}`);
    await retryGate;
  };

  const startup = runtime.startup();
  const startupOutcome = await observeSettlement(startup);
  releaseRetries();
  await startup;
  await runtime.flush();

  assert.equal(startupOutcome.status, 'fulfilled', 'automatic rechecks must not block Workstation startup');
  assert.deepEqual(
    events.filter((entry) => entry.startsWith('retry:')),
    [`retry:${firstFailedTaskId}`, `retry:${secondFailedTaskId}`]
  );
  assert.equal(events.some((entry) => entry.startsWith('run:')), false);
});

test('opening methods rechecks a preload failure before reading its catalog', async () => {
  // Mutation caught: calling prepare() directly can return a catalog while leaving the card
  // in PRELOAD_FAILED with its stale Analyzer error.
  const failed = task(TASK_ID, 'PRELOAD_FAILED', {
    preloadState: 'FAILED',
    lastError: {
      code: 'CLASS_PRELOAD_FAILED',
      message: '单方法分析请求失败：400',
      moduleName: 'module-a',
      modulePath: `${WORKSPACE}\\module-a`,
      command: null,
      occurredAt: '2026-08-09T00:00:00.000Z'
    }
  });
  const { runtime, coordinator, events, tasks } = harness([task()]);
  coordinator.retryClassPreload = async (taskId) => {
    events.push(`retry:${taskId}`);
    tasks.set(taskId, task(taskId, 'READY', {
      preloadState: 'READY',
      lastError: null
    }));
  };
  await runtime.startup();
  tasks.set(TASK_ID, failed);
  events.length = 0;

  const methods = await runtime.getClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID
  });

  assert.equal(methods.taskId, TASK_ID);
  assert.deepEqual(events, [`retry:${TASK_ID}`, `prepare:${TASK_ID}`]);
  assert.equal(tasks.get(TASK_ID).state, 'READY');
  assert.equal(tasks.get(TASK_ID).lastError, null);
});

test('opening methods reports a failed recheck without preparing the class twice', async () => {
  const refreshedError = {
    code: 'CLASS_PRELOAD_FAILED',
    message: '单方法分析请求失败（TARGET_SOURCE_PARSE_FAILED）：目标源码无法解析。',
    moduleName: 'module-a',
    modulePath: `${WORKSPACE}\\module-a`,
    command: null,
    occurredAt: '2026-08-09T02:00:00.000Z'
  };
  const { runtime, coordinator, events, tasks } = harness([task()]);
  coordinator.retryClassPreload = async (taskId) => {
    events.push(`retry:${taskId}`);
    tasks.set(taskId, task(taskId, 'PRELOAD_FAILED', {
      preloadState: 'FAILED',
      lastError: refreshedError
    }));
  };
  await runtime.startup();
  tasks.set(TASK_ID, task(TASK_ID, 'PRELOAD_FAILED', {
    preloadState: 'FAILED',
    lastError: { ...refreshedError, message: '单方法分析请求失败：400' }
  }));
  events.length = 0;

  await assert.rejects(
    runtime.getClassTaskMethods({ workspaceRoot: WORKSPACE, taskId: TASK_ID }),
    new RegExp('TARGET_SOURCE_PARSE_FAILED')
  );

  assert.deepEqual(events, [`retry:${TASK_ID}`]);
});

test('cached method catalog freshness check returns the latest prepared coverage without preparing methods', async () => {
  const { runtime, events } = harness();
  await runtime.startup();
  events.length = 0;

  const current = await runtime.checkClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID,
    fingerprint: 'a'.repeat(64)
  });

  assert.deepEqual(current, { current: true, catalog: catalog() });
  assert.deepEqual(events, [
    `check-methods:${TASK_ID}:${'a'.repeat(64)}`,
    `peek-methods:${TASK_ID}`
  ]);
  assert.equal(events.some((entry) => entry.startsWith('prepare:')), false);
});

test('method catalog final row uses the JaCoCo totals for the current class', async () => {
  const reportCoverageTotals = {
    instructionCovered: 46,
    instructionMissed: 4313,
    branchCovered: 2,
    branchMissed: 617,
    complexityCovered: 5,
    complexityMissed: 406,
    lineCovered: 13,
    lineMissed: 1081
  };
  const { runtime } = harness([task()], {
    reportTotals: {
      async read() {
        return structuredClone(reportCoverageTotals);
      }
    }
  });
  await runtime.startup();

  const methods = await runtime.getClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID
  });
  const freshness = await runtime.checkClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID,
    fingerprint: 'a'.repeat(64)
  });

  assert.deepEqual(methods.reportCoverageTotals, reportCoverageTotals);
  assert.deepEqual(freshness.catalog?.reportCoverageTotals, reportCoverageTotals);
});

test('active method catalog refresh uses the matching task report instead of stale shared totals', async () => {
  const staleSharedTotals = {
    instructionCovered: 0,
    instructionMissed: 4359,
    branchCovered: 0,
    branchMissed: 619,
    complexityCovered: 0,
    complexityMissed: 411,
    lineCovered: 0,
    lineMissed: 1094
  };
  const taskCoverageTotals = {
    instructionCovered: 46,
    instructionMissed: 4313,
    branchCovered: 2,
    branchMissed: 617,
    complexityCovered: 5,
    complexityMissed: 406,
    lineCovered: 13,
    lineMissed: 1081
  };
  const { runtime, coordinator, events } = harness([task(TASK_ID, 'RUNNING')], {
    reportTotals: {
      async read() {
        events.push('read-shared-report');
        return structuredClone(staleSharedTotals);
      },
      async readReport(reportPath, qualifiedClassName) {
        events.push(`read-task-report:${reportPath}:${qualifiedClassName}`);
        return structuredClone(taskCoverageTotals);
      }
    }
  });
  const latestCatalog = {
    ...catalog(),
    fingerprint: 'a'.repeat(64),
    reportPairId: 'active-pair',
    methods: catalog().methods.map((method) => ({
      ...method,
      lineCovered: 1,
      lineMissed: 1,
      instructionCovered: 2,
      instructionMissed: 2
    }))
  };
  coordinator.peekPreparedMethodCatalog = (taskId) => {
    events.push(`peek-methods:${taskId}`);
    return structuredClone(latestCatalog);
  };
  coordinator.peekPreparedCoverageReport = () => ({
    reportPath: 'D:\\workspace\\module-a\\target\\ai-unit-test\\jacoco\\tasks\\task-id\\current.xml',
    reportPairId: 'active-pair'
  });
  coordinator.isMethodCatalogCurrent = async () => {
    throw new Error('active refresh must not inspect mutable generated test files');
  };
  await runtime.startup();
  events.length = 0;

  const current = await runtime.checkClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID,
    fingerprint: 'a'.repeat(64)
  });

  assert.deepEqual(current, {
    current: true,
    catalog: {
      ...latestCatalog,
      reportCoverageTotals: taskCoverageTotals
    }
  });
  assert.deepEqual(events, [
    `peek-methods:${TASK_ID}`,
    'read-task-report:D:\\workspace\\module-a\\target\\ai-unit-test\\jacoco\\tasks\\task-id\\current.xml:example.Task'
  ]);
});

test('active method catalog refresh never falls back to a shared report while its task report is unavailable', async () => {
  const taskCoverageTotals = {
    instructionCovered: 46,
    instructionMissed: 4313,
    branchCovered: 2,
    branchMissed: 617,
    complexityCovered: 5,
    complexityMissed: 406,
    lineCovered: 13,
    lineMissed: 1081
  };
  const { runtime, coordinator, events } = harness([task(TASK_ID, 'RUNNING')], {
    reportTotals: {
      async read() {
        throw new Error('active tasks must not read the shared JaCoCo report');
      },
      async readReport(reportPath) {
        events.push(`read-task-report:${reportPath}`);
        return null;
      }
    }
  });
  const latestCatalog = {
    ...catalog(),
    fingerprint: 'a'.repeat(64),
    reportPairId: 'active-pair',
    reportCoverageTotals: taskCoverageTotals
  };
  coordinator.peekPreparedMethodCatalog = () => structuredClone(latestCatalog);
  coordinator.peekPreparedCoverageReport = () => ({
    reportPath: 'D:\\workspace\\module-a\\target\\ai-unit-test\\jacoco\\tasks\\task-id\\current.xml',
    reportPairId: 'active-pair'
  });
  coordinator.isMethodCatalogCurrent = async () => true;
  await runtime.startup();
  events.length = 0;

  const current = await runtime.checkClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID,
    fingerprint: 'a'.repeat(64)
  });

  assert.deepEqual(current, { current: true, catalog: latestCatalog });
  assert.deepEqual(events, [
    'read-task-report:D:\\workspace\\module-a\\target\\ai-unit-test\\jacoco\\tasks\\task-id\\current.xml'
  ]);
});

test('manual method refresh asks the coordinator to rebuild its prepared catalog', async () => {
  const { runtime, prepareCalls } = harness();
  await runtime.startup();
  prepareCalls.length = 0;

  await runtime.getClassTaskMethods({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID,
    forceReload: true
  });

  assert.deepEqual(prepareCalls, [{ taskId: TASK_ID, forceReload: true }]);
});

test('commands translate requests to the registry, coordinator, and scheduler', async () => {
  const { runtime, events } = harness([]);
  await runtime.startup();
  const added = await runtime.addClassTasks({
    workspaceRoot: WORKSPACE,
    classFilePaths: [`${WORKSPACE}\\src\\main\\java\\example\\Task.java`]
  });
  assert.equal(added.length, 1);
  await runtime.flush();

  const methods = await runtime.getClassTaskMethods({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  assert.equal(methods.taskId, TASK_ID);
  const selected = await runtime.saveMethodSelection({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-id'],
    methodOrder: ['method-id'],
    ragEnabled: true
  });
  assert.deepEqual(selected.methodOrder, ['method-id']);
  assert.equal(selected.ragEnabled, true);

  const completed = await runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  assert.equal(completed.state, 'COMPLETED');
  await runtime.pauseTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.resumeTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.terminateTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.getTaskResult({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.acceptTaskResult({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.revokeTaskResult({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.retryModulePreload({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.stopModulePreload({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.deepEqual(events.filter((entry) => /^(add|prepare|selection|run|finish|release-run|pause|resume|terminate:|result|accept|revoke|retry|stop)/.test(entry)), [
    'add:1', `prepare:${TASK_ID}`, `prepare:${TASK_ID}`, `prepare:${TASK_ID}`,
    'selection:EXPLICIT:method-id', `run:${TASK_ID}`, `finish:${TASK_ID}`,
    `release-run:${TASK_ID}`, `pause:${TASK_ID}`, `resume:${TASK_ID}`,
    `finish:${TASK_ID}`, `release-run:${TASK_ID}`, `terminate:${TASK_ID}`,
    `release-run:${TASK_ID}`,
    `result:${TASK_ID}`, `accept:${TASK_ID}`, `revoke:${TASK_ID}`,
    `retry:${TASK_ID}`,
    `stop:${TASK_ID}`
  ]);
});

test('terminal completion and failure release a run while pause preserves it', async () => {
  const completedHarness = harness();
  await completedHarness.runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  assert.deepEqual(
    completedHarness.events.filter((entry) => entry.startsWith('release-run:')),
    [`release-run:${TASK_ID}`]
  );

  const pausedHarness = harness([task(TASK_ID, 'RUNNING')]);
  await pausedHarness.runtime.pauseTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  assert.equal(
    pausedHarness.events.some((entry) => entry.startsWith('release-run:')),
    false
  );

  const failedHarness = harness();
  failedHarness.scheduler.runTask = async (taskId) => {
    const failed = task(taskId, 'FAILED');
    failedHarness.tasks.set(taskId, failed);
    return structuredClone(failed);
  };
  const failed = await failedHarness.runtime.runTask({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID
  });
  assert.equal(failed.state, 'FAILED');
  assert.deepEqual(
    failedHarness.events.filter((entry) => entry.startsWith('release-run:')),
    [`release-run:${TASK_ID}`]
  );
});

test('rerunning a terminated task discards the prior run before scheduling fresh generation', async () => {
  const { runtime, events } = harness([
    task(TASK_ID, 'TERMINATED', { currentMethodIndex: 0 })
  ]);

  const completed = await runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(
    events.filter((entry) => /^(restart:|run:|finish:|release-run:)/.test(entry)),
    [
      `restart:${TASK_ID}`,
      `run:${TASK_ID}`,
      `finish:${TASK_ID}`,
      `release-run:${TASK_ID}`
    ]
  );
});

test('rerunning a zero-formal-file failure discards skipped Wave checkpoints before generation', async () => {
  const failed = task(TASK_ID, 'FAILED', {
    lastError: {
      code: 'MODEL_NO_FORMAL_TEST_FILE_GENERATED',
      message: '未生成任何正式测试文件。MODEL_RATE_LIMITED: provider throttled',
      moduleName: 'example.Task',
      modulePath: `${WORKSPACE}\\module-a`,
      command: null,
      occurredAt: '2026-08-09T00:00:00.000Z'
    }
  });
  const { runtime, events } = harness([failed]);

  const completed = await runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(
    events.filter((entry) => /^(restart:|run:|finish:|release-run:)/.test(entry)),
    [
      `restart:${TASK_ID}`,
      `run:${TASK_ID}`,
      `finish:${TASK_ID}`,
      `release-run:${TASK_ID}`
    ]
  );
});

test('failed refresh explicitly preserves a partial-Wave checkpoint for the READY scheduler run', async () => {
  // Mutation caught: retryClassPreload changes FAILED to READY, so omitting this explicit
  // option makes the scheduler treat a partial-Wave recovery as a brand-new class run.
  const failed = task(TASK_ID, 'FAILED', {
    generatedArtifacts: [generatedArtifact(false)]
  });
  const {
    runtime,
    coordinator,
    schedulerRunCalls,
    tasks
  } = harness([failed]);
  coordinator.refreshFailedRunIfStale = async (taskId) => {
    tasks.set(taskId, task(taskId, 'READY', {
      generatedArtifacts: [generatedArtifact(false)]
    }));
    return { refreshed: true, preserveCheckpoint: true };
  };

  const completed = await runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(schedulerRunCalls, [{
    taskId: TASK_ID,
    options: { preserveCheckpoint: true }
  }]);
});

test('checkpoint-preserving restart keeps durable Wave Part files', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const partStore = new MethodWavePartStoreService();
  const stored = await partStore.store({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    methodId: h.methodId,
    sourceClassName: 'Task',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'd'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '66666666-6666-4666-8666-666666666666',
    code: 'package example; public class TaskTmp1Part1Test {}\n'
  });

  await h.runtime.coordinator.restart(TASK_ID, undefined, {
    resetGenerationCheckpoint: false
  });

  await access(stored.filePath);
});

test('checkpoint-resetting restart clears Wave Part files', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const partStore = new MethodWavePartStoreService();
  const stored = await partStore.store({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    methodId: h.methodId,
    sourceClassName: 'Task',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'd'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '66666666-6666-4666-8666-666666666666',
    code: 'package example; public class TaskTmp1Part1Test {}\n'
  });

  await h.runtime.coordinator.restart(TASK_ID);

  await assert.rejects(access(stored.filePath), { code: 'ENOENT' });
});

test('a completed task awaiting accept or revoke rejects an individual rerun before restart', async () => {
  const pending = task(TASK_ID, 'COMPLETED', {
    generatedArtifacts: [generatedArtifact(false)]
  });
  const { runtime, events, registry } = harness([pending]);

  await assert.rejects(
    runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID }),
    /请先接受或撤回本次生成结果/
  );

  assert.deepEqual(
    events.filter((entry) => /^(restart:|run:|finish:|release-run:)/.test(entry)),
    []
  );
  assert.equal(registry.snapshot(TASK_ID).state, 'COMPLETED');
});

test('a terminated task awaiting accept or revoke rejects an individual rerun before restart', async () => {
  const pending = task(TASK_ID, 'TERMINATED', {
    generatedArtifacts: [generatedArtifact(false)]
  });
  const { runtime, events, registry } = harness([pending]);

  await assert.rejects(
    runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID }),
    /请先接受或撤回本次生成结果/
  );

  assert.deepEqual(
    events.filter((entry) => /^(restart:|run:|finish:|release-run:)/.test(entry)),
    []
  );
  assert.equal(registry.snapshot(TASK_ID).state, 'TERMINATED');
});

test('completed tasks can rerun after their result is accepted or revoked', async () => {
  for (const generatedArtifacts of [[generatedArtifact(true)], []]) {
    const { runtime, events } = harness([
      task(TASK_ID, 'COMPLETED', { generatedArtifacts })
    ]);

    const completed = await runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

    assert.equal(completed.state, 'COMPLETED');
    assert.deepEqual(
      events.filter((entry) => /^(restart:|run:)/.test(entry)),
      [`restart:${TASK_ID}`, `run:${TASK_ID}`]
    );
  }
});

test('an explicitly empty method selection is rejected before the scheduler starts', async () => {
  const current = task(TASK_ID, 'READY', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: [],
    methodOrder: []
  });
  const { runtime, events, registry } = harness([current]);

  await assert.rejects(
    runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID }),
    /at least one|至少.*方法/i
  );

  assert.equal(events.some((entry) => entry.startsWith('run:')), false);
  assert.equal(registry.snapshot(TASK_ID).state, 'READY');
});

test('a legacy default-all empty selection is rejected before the scheduler starts', async () => {
  const defaultAll = task(TASK_ID, 'READY', {
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: []
  });
  const { runtime, events, registry } = harness([defaultAll]);

  await assert.rejects(
    runtime.runTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID }),
    /at least one|至少.*方法/i
  );

  assert.equal(events.some((entry) => entry.startsWith('run:')), false);
  assert.equal(registry.snapshot(TASK_ID).state, 'READY');
});

test('run-all skips a ready default-all task with no selected methods', async () => {
  const defaultAll = task(TASK_ID, 'READY', {
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: []
  });
  const preloading = task('22222222-2222-4222-8222-222222222222', 'PRELOADING');
  const { runtime, events } = harness([defaultAll, preloading]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results, []);
  assert.deepEqual(events.filter((entry) => entry.startsWith('run:')), []);
});

test('run-all affects only eligible tasks in the requested workspace', async () => {
  const other = task('33333333-3333-4333-8333-333333333333', 'READY', {
    workspaceRoot: 'D:\\other', sourceFilePath: 'D:\\other\\Task.java'
  });
  const blocked = task('44444444-4444-4444-8444-444444444444', 'PRELOAD_FAILED');
  const unselected = task('55555555-5555-4555-8555-555555555555', 'READY', {
    selectionMode: 'EXPLICIT', selectedMethodIds: [], methodOrder: []
  });
  const { runtime, events } = harness([task(), other, blocked, unselected]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results.map((entry) => entry.id), [TASK_ID]);
  assert.deepEqual(events.filter((entry) => entry.startsWith('run:')), [`run:${TASK_ID}`]);
});

test('run-all skips completed tasks whose result still awaits accept or revoke', async () => {
  const pending = task(TASK_ID, 'COMPLETED', {
    generatedArtifacts: [generatedArtifact(false)]
  });
  const ready = task('88888888-8888-4888-8888-888888888888', 'READY');
  const { runtime, events } = harness([pending, ready]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results.map((entry) => entry.id), [ready.id]);
  assert.deepEqual(events.filter((entry) => entry.startsWith('restart:')), []);
  assert.deepEqual(events.filter((entry) => entry.startsWith('run:')), [`run:${ready.id}`]);
});

test('run-all skips terminated tasks whose result still awaits accept or revoke', async () => {
  const pending = task(TASK_ID, 'TERMINATED', {
    generatedArtifacts: [generatedArtifact(false)]
  });
  const ready = task('99999999-9999-4999-8999-999999999999', 'READY');
  const { runtime, events } = harness([pending, ready]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results.map((entry) => entry.id), [ready.id]);
  assert.deepEqual(events.filter((entry) => entry.startsWith('restart:')), []);
  assert.deepEqual(events.filter((entry) => entry.startsWith('run:')), [`run:${ready.id}`]);
});

test('run-all resumes paused tasks instead of skipping or restarting them', async () => {
  const paused = task(TASK_ID, 'PAUSED');
  const ready = task('88888888-8888-4888-8888-888888888888', 'READY');
  const { runtime, events } = harness([paused, ready]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results.map((entry) => entry.id), [paused.id, ready.id]);
  assert.deepEqual(
    events.filter((entry) => /^(resume|run):/.test(entry)).sort(),
    [`resume:${paused.id}`, `run:${ready.id}`].sort()
  );
});

test('run-all records each started or resumed class task exactly once', async () => {
  const paused = task(TASK_ID, 'PAUSED');
  const ready = task('88888888-8888-4888-8888-888888888888', 'READY');
  const { runtime, recordedTaskExecutions } = harness([paused, ready]);

  await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.equal(recordedTaskExecutions.length, 2);
});
test('run-all retries a selected failed task while skipping an unselected ready task', async () => {
  const failed = task(TASK_ID, 'FAILED');
  const unselectedReady = task('66666666-6666-4666-8666-666666666666', 'READY', {
    selectionMode: 'EXPLICIT', selectedMethodIds: [], methodOrder: []
  });
  const { runtime, events } = harness([failed, unselectedReady]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results.map((entry) => entry.id), [TASK_ID]);
  assert.deepEqual(events.filter((entry) => entry.startsWith('run:')), [`run:${TASK_ID}`]);
});

test('run-all retries every selected failed task when the whole workspace has failed', async () => {
  const first = task(TASK_ID, 'FAILED');
  const second = task('77777777-7777-4777-8777-777777777777', 'FAILED');
  const { runtime, events } = harness([first, second]);

  const results = await runtime.runAll({ workspaceRoot: WORKSPACE });

  assert.deepEqual(results.map((entry) => entry.id), [first.id, second.id]);
  assert.deepEqual(
    events.filter((entry) => entry.startsWith('run:')),
    [`run:${first.id}`, `run:${second.id}`]
  );
});

test('run-all omits a task deleted after its result settles while a sibling is still running', async () => {
  // Mutation caught: returning Promise.allSettled values directly resurrects the deleted task
  // in the renderer when the slower sibling finally lets the total command resolve.
  const first = task(TASK_ID, 'READY');
  const second = task('77777777-7777-4777-8777-777777777777', 'READY');
  const firstRelease = runtimeDeferred();
  const { runtime, scheduler, tasks, events } = harness([first, second]);
  scheduler.runTask = async (taskId) => {
    events.push(`run:${taskId}`);
    if (taskId === first.id) await firstRelease.promise;
    const current = tasks.get(taskId);
    const next = {
      ...current,
      state: taskId === second.id ? 'TERMINATED' : 'COMPLETED'
    };
    tasks.set(taskId, next);
    return structuredClone(next);
  };

  const runningAll = runtime.runAll({ workspaceRoot: WORKSPACE });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.removeClassTask({ workspaceRoot: WORKSPACE, taskId: second.id });
  firstRelease.resolve();

  const results = await runningAll;

  assert.deepEqual(results.map((entry) => entry.id), [first.id]);
  assert.deepEqual(
    (await runtime.listClassTasks({ workspaceRoot: WORKSPACE })).map((entry) => entry.id),
    [first.id]
  );
});

test('remove terminates active work, releases owned resources, then removes persisted state', async () => {
  const { runtime, events } = harness([task(TASK_ID, 'RUNNING')]);

  await runtime.removeClassTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.deepEqual(events, [
    `terminate:${TASK_ID}`,
    `release:${TASK_ID}`,
    `remove:${TASK_ID}`
  ]);
});

test('remove is idempotent when a stale renderer repeats deletion for an absent task', async () => {
  // Mutation caught: requiring the task before removal makes an already deleted ghost card
  // impossible to clear because the main process rejects every repeated delete request.
  const { runtime, events } = harness([task()]);

  await runtime.removeClassTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });
  await runtime.removeClassTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.deepEqual(events, [
    `release:${TASK_ID}`,
    `remove:${TASK_ID}`
  ]);
  assert.deepEqual(await runtime.listClassTasks({ workspaceRoot: WORKSPACE }), []);
});

test('accept runs at a background boundary without changing an active task to paused', async () => {
  const { runtime, coordinator, registry, events } = harness([
    task(TASK_ID, 'RUNNING', { generatedArtifacts: [generatedArtifact(false)] })
  ]);
  const result = {
    taskId: TASK_ID,
    state: 'RUNNING',
    artifacts: [generatedArtifact(false)],
    coverageBaseline: {
      lineCovered: 0, lineMissed: 1, lineTotal: 1,
      branchCovered: 0, branchMissed: 0, branchTotal: 0
    },
    coverageCurrent: {
      lineCovered: 1, lineMissed: 0, lineTotal: 1,
      branchCovered: 0, branchMissed: 0, branchTotal: 0
    },
    coverageContributions: [],
    canAccept: true,
    canRevoke: true
  };
  coordinator.getResult = async (taskId) => {
    events.push('result:' + taskId);
    return structuredClone(result);
  };
  coordinator.accept = async (taskId) => {
    events.push('accept:' + taskId);
    return { ...structuredClone(result), state: 'RUNNING', canAccept: false, canRevoke: false };
  };

  const visibleResult = await runtime.getTaskResult({
    workspaceRoot: WORKSPACE,
    taskId: TASK_ID
  });
  assert.equal(visibleResult.canAccept, true);
  assert.equal(visibleResult.canRevoke, true);
  const accepted = await runtime.acceptTaskResult({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.equal(accepted.state, 'RUNNING');
  assert.equal(registry.snapshot(TASK_ID).state, 'RUNNING');
  assert.deepEqual(events, [
    'result:' + TASK_ID,
    'background-boundary:' + TASK_ID,
    'accept:' + TASK_ID
  ]);
  assert.equal(events.some((entry) => entry.startsWith('terminate:')), false);
  assert.equal(events.some((entry) => entry.startsWith('release-run:')), false);
});

test('revoke runs at a background boundary without changing an active task to paused', async () => {
  const { runtime, coordinator, registry, events } = harness([
    task(TASK_ID, 'RUNNING', { generatedArtifacts: [generatedArtifact(false)] })
  ]);
  const revokeOptions = [];
  coordinator.revoke = async (taskId, options) => {
    events.push('revoke:' + taskId);
    revokeOptions.push(structuredClone(options));
    return {
      taskId,
      state: 'RUNNING',
      artifacts: [],
      generatedMethods: [],
      allScenariosSkipped: false,
      tokenUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0,
      coverageBaseline: {
        lineCovered: 0, lineMissed: 1, lineTotal: 1,
        branchCovered: 0, branchMissed: 0, branchTotal: 0
      },
      coverageCurrent: {
        lineCovered: 0, lineMissed: 1, lineTotal: 1,
        branchCovered: 0, branchMissed: 0, branchTotal: 0
      },
      coverageContributions: [],
      canAccept: false,
      canRevoke: false
    };
  };

  const revoked = await runtime.revokeTaskResult({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.equal(revoked.state, 'RUNNING');
  assert.equal(registry.snapshot(TASK_ID).state, 'RUNNING');
  assert.deepEqual(revokeOptions, [{ preserveRun: true }]);
  assert.deepEqual(events, [
    'background-boundary:' + TASK_ID,
    'revoke:' + TASK_ID
  ]);
  assert.equal(events.some((entry) => entry.startsWith('terminate:')), false);
  assert.equal(events.some((entry) => entry.startsWith('release-run:')), false);
});

test('production composition restores empty state without starting backend, model, or Maven work', async (t) => {
  const storageDirectory = await mkdtemp(join(tmpdir(), 'class-task-runtime-empty-'));
  t.after(() => rm(storageDirectory, { recursive: true, force: true }));
  const externalCalls = [];
  const forbidden = (name) => async () => {
    externalCalls.push(name);
    throw new Error(`${name} must not run during startup`);
  };
  const runtime = createProductionClassTaskRuntime({
    storageDirectory,
    aiClient: new Proxy({}, { get: (_target, key) => forbidden(`ai:${String(key)}`) }),
    shellService: new Proxy({}, { get: (_target, key) => forbidden(`shell:${String(key)}`) }),
    mavenAnalysisContextService: { collect: forbidden('analysis-context') },
    testWriterService: {},
    jacocoArtifactsService: {},
    surefireReportService: {},
    buildSettingsService: { get: forbidden('build-settings') },
    modelInterfacesService: {
      getView: forbidden('model-view'),
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast() {}
  });

  assert.deepEqual(await runtime.startup(), []);
  await runtime.beforeQuit();
  assert.deepEqual(externalCalls, []);
});

test('reopening an empty fully checkpointed paused task rebuilds its packer before reporting no formal file', async (t) => {
  // Mutation caught: reading resources.packer before restored methods initialize the generator
  // makes a resumed 13/13-style task fail with "has no formal-file packer".
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-restored-packer-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const storageDirectory = join(root, 'state');
  const analysisSessionId = '22222222-2222-4222-8222-222222222222';
  const reportPairId = 'a'.repeat(64);
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(
    sourceFilePath,
    'package example; public class Task { public void method() {} }',
    'utf8'
  );
  await writeFile(join(storageDirectory, 'class-tasks-v2.json'), JSON.stringify({
    version: 3,
    tasks: {
      [TASK_ID]: task(TASK_ID, 'PAUSED', {
        workspaceRoot,
        sourceFilePath,
        moduleKey: `${moduleRoot.replaceAll('\\', '/').toLowerCase()}/pom.xml`,
        moduleDisplayPath: moduleRoot,
        repairAttemptLimit: 5,
        unlimitedRepair: false,
        currentMethodIndex: 0,
        startedAt: '2026-08-17T00:00:00.000Z'
      })
    }
  }), 'utf8');
  await writeFile(join(storageDirectory, 'class-task-checkpoints-v2.json'), JSON.stringify({
    version: 3,
    tasks: {
      [TASK_ID]: {
        catalogIdentity: { analysisSessionId, reportPairId },
        resolvedMethodOrder: ['method-id'],
        completedMethodIds: ['method-id'],
        methods: {
          'method-id': {
            completedBatches: [],
            completedTestMethodPlanIds: []
          }
        }
      }
    }
  }), 'utf8');

  const coverage = {
    lineCovered: 0,
    lineMissed: 1,
    lineTotal: 1,
    branchCovered: 0,
    branchMissed: 0,
    branchTotal: 0
  };
  const jacoco = restoredPackerJacocoArtifacts(reportPairId);
  let createdAnalysisSessionId = analysisSessionId;
  const forbiddenCalls = [];
  const deletedAnalysisSessionIds = [];
  const forbidden = (name) => async () => {
    forbiddenCalls.push(name);
    throw new Error(`${name} must not run when every method is already checkpointed`);
  };
  const methodCatalog = () => ({
    analysisSessionId: createdAnalysisSessionId,
    reportPairId,
    methods: [{
      methodId: 'method-id',
      methodName: 'method',
      descriptor: '()V',
      displaySignature: 'method()',
      firstLine: 1,
      lastLine: 1,
      jacocoOrder: 0,
      lineCovered: 0,
      lineMissed: 1,
      branchCovered: 0,
      branchMissed: 0,
      instructionCovered: 0,
      instructionMissed: 1,
      complexityCovered: 0,
      complexityMissed: 1,
      coverageGap: true,
      generatable: true,
      unavailableReason: null,
      modifiers: ['public']
    }],
    warnings: []
  });
  const aiClient = {
    async generateTargetJacocoReport(request) {
      return {
        generated: true,
        reportPath: request.outputPath,
        branchSnapshotPath: request.branchSnapshotOutputPath,
        pairId: reportPairId,
        targetClass: request.targetClass,
        generatedAt: '2026-08-17T00:00:00.000Z',
        message: 'generated'
      };
    },
    async createMethodAnalysisSession(request) {
      createdAnalysisSessionId = request.analysisSessionId;
      return {
        analysisSessionId: createdAnalysisSessionId,
        reportPairId,
        sourceSha256: 'b'.repeat(64),
        dependencyContextSha256: 'c'.repeat(64),
        packageName: 'example',
        testClassName: 'TaskTmp1Test',
        suggestedRelativeTestPath: 'module-a/src/test/java/example/TaskTmp1Test.java',
        warnings: []
      };
    },
    async refreshMethodAnalysisCoverage() {
      return { reportPairId, coverage, catalog: methodCatalog() };
    },
    async heartbeatMethodAnalysisSession() { return true; },
    async deleteMethodAnalysisSession(sessionId) {
      deletedAnalysisSessionIds.push(sessionId);
    },
    probeModelToolCalling: forbidden('probe-model'),
    classifyUnitTestTarget: forbidden('classify-target'),
    nextMethodBatch: forbidden('next-method-batch'),
    getMethodRepairContext: forbidden('repair-context'),
    startMethodGenerationStream: forbidden('start-generation'),
    recoverMethodGenerationStream: forbidden('recover-generation'),
    prepareRagRepair: forbidden('prepare-rag-repair'),
    resumeMethodGenerationStream: forbidden('resume-generation'),
    acknowledgeMethodGenerationEvents: forbidden('ack-generation'),
    cancelMethodGeneration: forbidden('cancel-generation'),
    generateUnitTestPrompt: forbidden('generation-prompt')
  };
  const shellService = {
    async validateBuildSettings() {
      throw new Error('persisted validation must be reused');
    },
    async runMavenCompile() {
      return {
        command: 'fake-mvn compile',
        cwd: moduleRoot,
        exitCode: 0,
        stdout: '',
        stderr: ''
      };
    },
    runMavenModuleTestsWithJacoco: forbidden('module-tests'),
    runMavenDirectTestsWithJacoco: forbidden('direct-tests'),
    runMavenGeneratedTestCompile: forbidden('generated-compile'),
    runMavenGeneratedSurefireTest: forbidden('generated-test'),
    runMavenDirectTestsWithJacocoAppend: forbidden('coverage-append')
  };
  const runtime = createProductionClassTaskRuntime({
    storageDirectory,
    aiClient,
    shellService,
    mavenAnalysisContextService: {
      async collect(input) {
        return {
          workspaceRoot: input.workspaceRoot,
          moduleRoot: input.moduleRoot,
          targetSourcePath: input.targetSourcePath,
          targetClass: input.targetClass,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath,
          reportPath: input.reportPath,
          branchSnapshotPath: input.branchSnapshotPath,
          reportPairId: input.reportPairId,
          sourceRoots: [join(moduleRoot, 'src', 'main', 'java')],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: 'd'.repeat(64),
          warnings: []
        };
      }
    },
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: jacoco,
    surefireReportService: {},
    buildSettingsService: {
      async get() {
        return {
          mavenHome: 'C:\\fixture-maven',
          javaHome: 'C:\\fixture-jdk',
          settingsPath: null,
          localRepository: null,
          validation: {
            valid: true,
            command: 'fake-mvn --version',
            mavenVersion: '3.9.16',
            javaVersion: '21.0.8',
            javaRuntime: 'fake-jdk',
            checkedAt: '2026-08-17T00:00:00.000Z'
          }
        };
      }
    },
    modelInterfacesService: {
      async getView() {
        return { schemaVersion: 2, activeInterfaceId: null, interfaces: [], secureStorageAvailable: true };
      },
      async resolveForGeneration() {
        return {
          interfaceId: 'fixture-model',
          interfaceName: 'Fixture model',
          llmConfig: {
            provider: 'custom_openai',
            model: 'never-called',
            baseUrl: 'http://127.0.0.1:9/v1',
            credentials: { apiKey: '' }
          }
        };
      }
    },
    modelCallLogSettingsService: { async get() { return { enabled: false }; } },
    broadcast() {},
    idFactory: () => analysisSessionId
  });
  t.after(async () => {
    const [shutdown] = await Promise.allSettled([runtime.beforeQuit()]);
    await rm(root, { recursive: true, force: true });
    if (shutdown.status === 'rejected') throw shutdown.reason;
  });

  const [restored] = await runtime.startup();
  assert.equal(restored.state, 'PAUSED');
  assert.equal(restored.currentMethodIndex, 0);

  const completed = await runtime.resumeTask({ workspaceRoot, taskId: TASK_ID });

  assert.equal(completed.state, 'FAILED', completed.lastError?.message);
  assert.equal(completed.lastError?.code, 'NO_FORMAL_TEST_FILE_GENERATED');
  assert.deepEqual(forbiddenCalls, []);
  assert.deepEqual(deletedAnalysisSessionIds, [analysisSessionId, analysisSessionId]);
});

test('production composition uses the Wave path and deletes its TMP only after formal publication', async (t) => {
  // Mutation caught: omitting the production Coordinator Wave ports makes the Runner call
  // nextMethodBatch; deleting before packer.append succeeds loses the only passing TMP.
  const h = await productionWaveRuntimeHarness(t, {
    markMethodCoveredAfterRefresh: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  const firstBoundary = await Promise.race([
    h.waveStarted.promise.then(() => ({ kind: 'wave-started' })),
    running.then((snapshot) => ({ kind: 'task-ended', snapshot }))
  ]);
  assert.equal(
    firstBoundary.kind,
    'wave-started',
    firstBoundary.snapshot?.lastError?.message
  );
  h.releaseWave.resolve();
  const deletionBoundary = await Promise.race([
    h.tmpDeleteStarted.promise.then(() => ({ kind: 'tmp-deleted' })),
    running.then((snapshot) => ({ kind: 'task-ended', snapshot }))
  ]);
  assert.equal(
    deletionBoundary.kind,
    'tmp-deleted',
    deletionBoundary.snapshot?.lastError?.message
  );
  await h.runtime.pauseTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });
  h.releaseTmpDelete.resolve();

  const paused = await running;
  await h.runtime.flush();

  assert.equal(paused.state, 'PAUSED', paused.lastError?.message);
  assert.deepEqual(h.analyzerCalls.map((call) => call.kind), ['wave']);
  assert.deepEqual(h.analyzerCalls[0].request, {
    reportPairId: h.reportPairId,
    methods: [{
      methodId: h.methodId,
      completedScenarioIds: [],
      skippedScenarioIds: []
    }],
    maxScenarios: 25,
    partSize: 5
  });
  assert.equal(paused.generatedArtifacts.length, 1);
  assert.deepEqual(paused.coveredMethodIds, [h.methodId]);
  const [artifact] = paused.generatedArtifacts;
  assert.equal(artifact.testClassName, 'Task1Test');
  assert.deepEqual(artifact.methodIds, [h.methodId]);
  await access(artifact.filePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');

  const stored = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  const candidates = Object.values(stored.tasks[TASK_ID].waveState.candidates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'PASSED');
  assert.equal(candidates[0].managedFile, null);
  await assert.rejects(
    access(join(
      waveScratchTaskDirectory(h.workspaceRoot, 'method-wave-candidates'),
      candidates[0].candidateId
    )),
    (error) => error?.code === 'ENOENT'
  );
});

test('a completed task fingerprints its generated formal test as a project file', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const baselineCatalog = await h.runtime.getClassTaskMethods({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();
  const completed = await running;

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(completed.generatedArtifacts.length, 1);
  assert.equal(await h.runtime.checkClassTaskMethods({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    fingerprint: baselineCatalog.fingerprint
  }).then((freshness) => freshness.current), false);
});

test('refreshing a completed pending result preserves its pre-generation baseline and delta', async (t) => {
  const h = await productionWaveRuntimeHarness(t, { trackCoverageFromMaven: true });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();
  const completed = await running;
  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);

  const beforeRefresh = await h.runtime.getTaskResult({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  assert.ok(beforeRefresh);
  assert.equal(beforeRefresh.coverageBaseline.lineCovered, 0);
  assert.equal(beforeRefresh.coverageCurrent.lineCovered, 1);
  assert.equal(beforeRefresh.coverageContributions[0]?.addedLineCount, 1);

  await h.runtime.getClassTaskMethods({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    forceReload: true
  });
  const afterRefresh = await h.runtime.getTaskResult({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });

  assert.ok(afterRefresh);
  assert.equal(afterRefresh.state, 'COMPLETED');
  assert.deepEqual(afterRefresh.coverageBaseline, beforeRefresh.coverageBaseline);
  assert.deepEqual(afterRefresh.coverageCurrent, beforeRefresh.coverageCurrent);
  assert.deepEqual(afterRefresh.coverageContributions, beforeRefresh.coverageContributions);
  assert.equal(afterRefresh.artifacts[0]?.accepted, false);
  assert.equal(afterRefresh.canAccept, true);
  assert.equal(afterRefresh.canRevoke, true);
});

test('long-running Wave generation keeps its Analyzer session alive', async (t) => {
  // Mutation caught: heartbeating only before executeWave lets Java Analyzer reap the
  // session after 20 minutes while a slow model is still generating its response.
  const h = await productionWaveRuntimeHarness(t, {
    analysisSessionHeartbeatIntervalMilliseconds: 10
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  const heartbeatCountAtWaveStart = h.heartbeatCallCount();
  let periodicHeartbeatObserved = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (h.heartbeatCallCount() > heartbeatCountAtWaveStart) {
      periodicHeartbeatObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(periodicHeartbeatObserved, true);
  const terminated = await h.runtime.terminateTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  const ended = await running;
  assert.equal(terminated.state, 'TERMINATED');
  assert.equal(ended.state, 'TERMINATED');
});

test('a healthy Analyzer heartbeat timeout keeps the task RUNNING and retries', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    analysisSessionHeartbeatIntervalMilliseconds: 10,
    analysisResponseTimeoutRetryInitialDelayMilliseconds: 1,
    analysisResponseTimeoutRetryMaxDelayMilliseconds: 4,
    failHeartbeatOnceWithResponseTimeout: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  let timeoutRetried = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (h.analyzerHealthCheckCount() === 1 && h.heartbeatCallCount() >= 3) {
      timeoutRetried = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(timeoutRetried, true);
  const [snapshot] = await h.runtime.listClassTasks({ workspaceRoot: h.workspaceRoot });
  assert.equal(snapshot.state, 'RUNNING');
  assert.equal(snapshot.lastError, null);

  await h.runtime.terminateTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });
  assert.equal((await running).state, 'TERMINATED');
});

test('a healthy busy Analyzer session keeps the task RUNNING and retries', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    analysisResponseTimeoutRetryInitialDelayMilliseconds: 1,
    analysisResponseTimeoutRetryMaxDelayMilliseconds: 4,
    failClassWaveOnceWithBusySession: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;

  const [snapshot] = await h.runtime.listClassTasks({ workspaceRoot: h.workspaceRoot });
  assert.equal(snapshot.state, 'RUNNING');
  assert.equal(snapshot.lastError, null);
  assert.equal(h.analyzerHealthCheckCount(), 1);
  assert.equal(h.analyzerCalls.filter(({ kind }) => kind === 'wave').length, 2);

  h.releaseWave.resolve();
  h.releaseTmpDelete.resolve();
  const completed = await running;
  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
});
test('an expired Analyzer session while taking the first class Wave is rebuilt before model generation', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    failClassWaveOnceWithMissingSession: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;

  const [snapshot] = await h.runtime.listClassTasks({ workspaceRoot: h.workspaceRoot });
  assert.equal(snapshot.state, 'RUNNING');
  assert.equal(snapshot.lastError, null);
  assert.equal(h.analysisSessionCreationCount(), 2);
  assert.equal(h.analyzerCalls.filter(({ kind }) => kind === 'wave').length, 2);
  assert.notEqual(h.analyzerCalls[0].sessionId, h.analyzerCalls[1].sessionId);
  assert.equal(h.waveStreamCalls.length, 1, 'model generation must start once after recovery');

  h.releaseWave.resolve();
  h.releaseTmpDelete.resolve();
  const completed = await running;
  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
});

test('a healthy Analyzer invalid class-Wave response keeps the task RUNNING and retries', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    analysisResponseTimeoutRetryInitialDelayMilliseconds: 1,
    analysisResponseTimeoutRetryMaxDelayMilliseconds: 4,
    failClassWaveOnceWithInvalidResponse: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;

  const [snapshot] = await h.runtime.listClassTasks({ workspaceRoot: h.workspaceRoot });
  assert.equal(snapshot.state, 'RUNNING');
  assert.equal(snapshot.lastError, null);
  assert.equal(h.analyzerHealthCheckCount(), 1);
  assert.equal(h.analyzerCalls.filter(({ kind }) => kind === 'wave').length, 2);

  h.releaseWave.resolve();
  h.releaseTmpDelete.resolve();
  const completed = await running;
  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
});

test('a cancelled Analyzer heartbeat rebuilds the session and resumes the persisted Wave', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    analysisSessionHeartbeatIntervalMilliseconds: 10,
    failHeartbeatOnceWithCancelledSession: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  let failedHeartbeatObserved = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (h.cancelledHeartbeatCount() === 1) {
      failedHeartbeatObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(failedHeartbeatObserved, true);
  h.releaseWave.resolve();
  h.releaseTmpDelete.resolve();

  const completed = await running;

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(h.analysisSessionCreationCount(), 2);
  assert.equal(h.waveStreamCalls.length, 1, 'the completed model Wave must not run again');
  await access(h.formalFilePath);
});

test('a model call failure keeps successful Part scratch for the next retry', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    failWaveOnceAfterSucceededPart: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  const failed = await running;

  assert.equal(failed.state, 'PAUSED');
  assert.equal(failed.lastError?.code, 'MODEL_UNAVAILABLE');
  assert.equal(h.waveStreamCalls.length, 1);
  const stored = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  const activeWave = stored.tasks[TASK_ID].waveState.activeWave;
  assert.equal(activeWave.parts[0].status, 'SUCCEEDED');
  await access(activeWave.parts[0].isolatedFilePath);
});

test('retrying a model failure uses the newly selected model without restarting the Wave', async (t) => {
  const h = await productionWaveRuntimeHarness(t, {
    failWaveOnceAfterSucceededPart: true
  });
  await h.runtime.startup();
  const firstRun = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  const failed = await firstRun;
  assert.equal(failed.state, 'PAUSED');

  h.setModelName('fallback-kimi-k3');
  h.releaseTmpDelete.resolve();
  const completed = await h.runtime.resumeTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.deepEqual(h.waveModelNames, ['fixture', 'fallback-kimi-k3']);
  assert.equal(h.waveStreamCalls.length, 1, 'initial Wave generation must not restart');
  assert.equal(h.waveRecoveryCalls(), 1);
});

test('resume refreshes the selected generation model before continuing the paused checkpoint', async () => {
  const h = harness([task(TASK_ID, 'PAUSED')]);
  await h.runtime.startup();
  h.events.length = 0;

  await h.runtime.resumeTask({ workspaceRoot: WORKSPACE, taskId: TASK_ID });

  assert.deepEqual(h.events, [
    `refresh-model:${TASK_ID}`,
    `resume:${TASK_ID}`
  ]);
});

test('refreshing a paused run model invalidates generators that captured the old runtime', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const resources = h.runtime.coordinator.resources.get(TASK_ID);
  const transaction = resources.transaction;
  resources.generator = { capturedModel: 'fixture' };
  resources.batchGenerator = { capturedModel: 'fixture' };

  h.setModelName('newly-selected-model');
  await h.runtime.coordinator.refreshGenerationModel(TASK_ID);

  assert.equal(resources.resolvedModelRuntime.llmConfig.model, 'newly-selected-model');
  assert.equal(resources.generator, null);
  assert.equal(resources.batchGenerator, null);
  assert.equal(resources.transaction, transaction, 'resume must preserve generated-file ownership');
});

test('a legacy generic missing-report failure refreshes coverage artifacts before retry', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const registry = h.runtime.coordinator.dependencies.registry;
  await registry.save({
    ...registry.snapshot(TASK_ID),
    state: 'FAILED',
    lastError: {
      code: 'CLASS_TASK_EXECUTION_FAILED',
      message: '单方法分析请求失败（REPORT_PATH_OUTSIDE_WORKSPACE）：JaCoCo 报告必须位于当前工作区内。',
      moduleName: 'Task',
      modulePath: h.workspaceRoot,
      command: null,
      occurredAt: '2026-09-14T06:49:24.757Z'
    }
  });

  const refresh = await h.runtime.coordinator.refreshFailedRunIfStale(TASK_ID);

  assert.equal(refresh.refreshed, true);
  assert.equal(refresh.preserveCheckpoint, false);
  assert.equal(registry.snapshot(TASK_ID).state, 'READY');
});

test('failed refresh preserves a model-repair Wave checkpoint even when recovery files are missing', async (t) => {
  // Mutation caught: omitting resetGenerationCheckpoint:false lets restart() use its default
  // reset behavior, deleting the MODEL_REPAIR checkpoint and submitting the same Wave as
  // first generation again.
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const checkpoints = h.runtime.coordinator.dependencies.checkpoints;
  const registry = h.runtime.coordinator.dependencies.registry;
  const waveId = 'a'.repeat(64);
  const candidateId = '66666666-6666-4666-8666-666666666666';
  await checkpoints.prepareRun(TASK_ID, {
    reset: true,
    catalogIdentity: { analysisSessionId: 'analysis-old', reportPairId: 'pair-old' },
    resolvedMethodOrder: [h.methodId]
  });
  assert.equal(await checkpoints.dequeueMethodWave(TASK_ID), h.methodId);
  await checkpoints.saveActiveMethodWave(TASK_ID, {
    waveId,
    waveSessionId: '11111111-1111-4111-8111-111111111111',
    recoveryRequestId: null,
    eventSequence: 4,
    startRequest: null,
    methodId: h.methodId,
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
      isolatedFilePath: join(h.workspaceRoot, '.ai-unit-test', 'missing-part', 'TaskTmp1Part1Test.java'),
      fileSha256: 'c'.repeat(64),
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }]
  });
  await checkpoints.saveWaveCandidate(TASK_ID, {
    candidateId,
    methodId: h.methodId,
    waveId,
    status: 'MODEL_REPAIR',
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-before-retry',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: join(h.workspaceRoot, '.ai-unit-test', 'missing-candidate', 'TaskTmp1Test.java'),
      sha256: 'd'.repeat(64),
      location: 'ISOLATED'
    },
    moveTransaction: null
  });
  await registry.save({
    ...registry.snapshot(TASK_ID),
    state: 'FAILED',
    lastError: {
      code: 'MODEL_PERMISSION_DENIED',
      message: 'simulated model permission failure',
      moduleName: 'Task',
      modulePath: h.workspaceRoot,
      command: null,
      occurredAt: '2026-09-04T00:00:00.000Z'
    }
  });

  const refresh = await h.runtime.coordinator.refreshFailedRunIfStale(TASK_ID);

  assert.equal(refresh.refreshed, true);
  assert.equal(refresh.preserveCheckpoint, true);
  const wave = await checkpoints.taskWaveProgress(TASK_ID);
  assert.equal(wave.activeMethodId, h.methodId);
  assert.equal(wave.activeWave?.waveId, waveId);
  assert.equal(wave.candidates[candidateId]?.status, 'MODEL_REPAIR');
});
test('restart with a refreshed coverage pair resumes the merged TMP at Maven without initial regeneration', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const checkpoints = h.runtime.coordinator.dependencies.checkpoints;
  const saveWaveCandidate = checkpoints.saveWaveCandidate.bind(checkpoints);
  let crashAtReady = true;
  checkpoints.saveWaveCandidate = async (...args) => {
    const saved = await saveWaveCandidate(...args);
    if (saved.status === 'READY_FOR_MAVEN' && crashAtReady) {
      crashAtReady = false;
      throw new ClassTaskApplicationInterruptedError();
    }
    return saved;
  };

  const firstRun = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  const firstBoundary = await Promise.race([
    h.waveStarted.promise.then(() => ({ kind: 'wave-started' })),
    firstRun.then((snapshot) => ({ kind: 'task-ended', snapshot }))
  ]);
  assert.equal(
    firstBoundary.kind,
    'wave-started',
    firstBoundary.snapshot?.lastError?.message
  );
  h.releaseWave.resolve();
  const interrupted = await firstRun;

  assert.equal(interrupted.state, 'INTERRUPTED');
  assert.equal(h.waveStreamCalls.length, 1);
  assert.equal(h.candidateMavenCompileCalls(), 0);
  const checkpointPath = join(h.storageDirectory, 'class-task-checkpoints-v2.json');
  const failedCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const failedCandidate = Object.values(
    failedCheckpoint.tasks[TASK_ID].waveState.candidates
  )[0];
  assert.equal(failedCandidate.status, 'READY_FOR_MAVEN');
  assert.equal(failedCandidate.managedFile.location, 'PROJECT');
  await access(failedCandidate.managedFile.path);

  await h.runtime.beforeQuit();
  h.setReportPairId('f'.repeat(64));

  const resumedRuntime = createProductionClassTaskRuntime(h.runtimeOptions);
  const [restored] = await resumedRuntime.startup();
  assert.equal(restored.state, 'INTERRUPTED');
  const restoredCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const restoredCandidate = Object.values(
    restoredCheckpoint.tasks[TASK_ID].waveState.candidates
  )[0];
  assert.equal(restoredCandidate.status, 'READY_FOR_MAVEN');
  assert.equal(restoredCandidate.managedFile.location, 'ISOLATED');

  h.releaseTmpDelete.resolve();
  const resumedRun = resumedRuntime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  const completed = await resumedRun;
  await resumedRuntime.beforeQuit();

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(h.waveStreamCalls.length, 1, 'initial Wave generation must not restart');
  assert.equal(h.candidateMavenCompileCalls(), 1, 'the recovered TMP must run Maven');
  assert.equal(
    h.analyzerCalls.length,
    1,
    'a recovered completed Wave must finish from its persisted scenario ledger'
  );
  await access(h.formalFilePath);
});

test('a cached preparation quarantines an unowned stale Wave TMP before writing the next candidate', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  await h.runtime.coordinator.prepare(TASK_ID);
  await mkdir(dirname(h.tmpFilePath), { recursive: true });
  await writeFile(h.tmpFilePath, [
    'package example;',
    'public class TaskTmp1Test {}',
    ''
  ].join('\n'), 'utf8');

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  h.releaseTmpDelete.resolve();
  const completed = await running;
  await h.runtime.beforeQuit();

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(h.waveStreamCalls.length, 1);
  await access(h.formalFilePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
});

test('failed retry keeps a Maven-passed Wave TMP after its Part scratch was cleared', async (t) => {
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const originalFormalizeWave = h.runtime.coordinator.formalizeWaveGroup.bind(
    h.runtime.coordinator
  );
  let failBeforeFormalPublication = true;
  h.runtime.coordinator.formalizeWaveGroup = async (...args) => {
    if (failBeforeFormalPublication) {
      failBeforeFormalPublication = false;
      throw new MethodGenerationRequestError(
        'MODEL_UNAVAILABLE',
        'simulated failure after the Maven-passed candidate checkpoint'
      );
    }
    return originalFormalizeWave(...args);
  };

  const firstRun = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  const failed = await firstRun;

  assert.equal(failed.state, 'PAUSED');
  assert.equal(failed.lastError?.code, 'MODEL_UNAVAILABLE');
  const storedAfterFailure = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  const activeWave = storedAfterFailure.tasks[TASK_ID].waveState.activeWave;
  const candidate = Object.values(
    storedAfterFailure.tasks[TASK_ID].waveState.candidates
  )[0];
  assert.equal(candidate.status, 'PASSED');
  await access(candidate.managedFile.path);
  await assert.rejects(
    access(activeWave.parts[0].isolatedFilePath),
    (error) => error?.code === 'ENOENT'
  );
  await h.runtime.beforeQuit();

  h.releaseTmpDelete.resolve();
  const resumedRuntime = createProductionClassTaskRuntime(h.runtimeOptions);
  await resumedRuntime.startup();
  const completed = await resumedRuntime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await resumedRuntime.beforeQuit();

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(h.waveStreamCalls.length, 1, 'the passed Wave must not regenerate');
  await access(h.formalFilePath);
});

test('formalization rebuilds the packer after runtime result resources roll over', async (t) => {
  // Accepting an earlier formal result replaces the task file transaction and clears the
  // packer. A Wave that already finished Maven must still publish against the new transaction.
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const acceptedCode = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'public class Task1Test {',
    '  @Test void acceptedEarlier() { new Task().run(); }',
    '}',
    ''
  ].join('\n');
  const acceptedArtifact = {
    id: 'accepted-artifact-before-current-wave',
    filePath: h.formalFilePath,
    testClassName: 'Task1Test',
    ordinaryTestMethodCount: 1,
    methodIds: ['accepted-method-id'],
    methodResults: [{
      methodId: 'accepted-method-id',
      methodName: 'acceptedEarlier',
      displaySignature: 'acceptedEarlier()',
      jacocoOrder: 0,
      ordinaryTestMethodCount: 1
    }],
    sha256: createHash('sha256').update(acceptedCode).digest('hex'),
    sealed: true,
    accepted: true,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:01:00.000Z'
  };
  const nextFormalFilePath = join(dirname(h.formalFilePath), 'Task2Test.java');
  const originalFormalizeWaveGroup = h.runtime.coordinator.formalizeWaveGroup.bind(
    h.runtime.coordinator
  );
  let rolledOver = false;
  h.runtime.coordinator.formalizeWaveGroup = async (...args) => {
    if (!rolledOver) {
      rolledOver = true;
      const resources = h.runtime.coordinator.resources.get(TASK_ID);
      assert.ok(resources);
      await writeFile(h.formalFilePath, acceptedCode, 'utf8');
      resources.acceptedArtifacts = [acceptedArtifact];
      resources.transaction = h.runtime.coordinator.createTransaction();
      resources.packer = null;
      resources.generator = null;
    }
    return originalFormalizeWaveGroup(...args);
  };

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  h.releaseTmpDelete.resolve();
  const completed = await running;

  assert.equal(rolledOver, true);
  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(h.waveStreamCalls.length, 1, 'the Maven-passed Wave must not regenerate');
  assert.equal(await readFile(h.formalFilePath, 'utf8'), acceptedCode);
  await access(nextFormalFilePath);
  assert.deepEqual(
    completed.generatedArtifacts.map((artifact) => [artifact.testClassName, artifact.accepted]),
    [['Task1Test', true], ['Task2Test', false]]
  );
  const nextResult = await h.runtime.getTaskResult({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(nextResult?.canAccept, true);
  assert.equal(nextResult?.canRevoke, true);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
});

test('restart commits an already published Wave after its TMP was cleaned without regenerating', async (t) => {
  // Mutation caught: requiring a PASSED candidate to retain a project TMP makes the
  // formal-file-published -> TMP-cleaned -> Wave-not-committed crash window unrecoverable.
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  const shuttingDown = h.runtime.beforeQuit();
  h.releaseTmpDelete.resolve();

  const interrupted = await running;
  await shuttingDown;
  assert.equal(interrupted.state, 'INTERRUPTED', interrupted.lastError?.message);
  await access(h.formalFilePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  assert.equal(h.waveStreamCalls.length, 1);

  const resumedRuntime = createProductionClassTaskRuntime(h.runtimeOptions);
  const [restored] = await resumedRuntime.startup();
  assert.equal(restored.state, 'INTERRUPTED');
  const completed = await resumedRuntime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await resumedRuntime.beforeQuit();

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.equal(h.waveStreamCalls.length, 1, 'the original Agent Wave must not run again');
  assert.equal(
    h.analyzerCalls.length,
    1,
    'a published completed Wave must finish without planning the same scenario again'
  );
  await access(h.formalFilePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  const stored = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  assert.equal(stored.tasks[TASK_ID].waveState.activeWave, null);
  assert.equal(
    stored.tasks[TASK_ID].waveState.methods[h.methodId]?.completedWaves.length,
    1,
    JSON.stringify(stored.tasks[TASK_ID].waveState)
  );
});

test('failed retry keeps a published Wave when its cleaned Part files are no longer present', async (t) => {
  // Mutation caught: failed-run freshness checks must not require Part scratch after the
  // same Wave has already been published as a formal artifact. Restarting here deletes
  // the formal file, discards cumulative model usage, and regenerates the Wave.
  const usage = { inputTokens: 11, outputTokens: 17, totalTokens: 28 };
  const broadcasts = [];
  const h = await productionWaveRuntimeHarness(t, {
    failCoverageRefreshAfterFormalOnce: true,
    candidateUsage: usage,
    broadcast(snapshot) {
      broadcasts.push(structuredClone(snapshot));
    }
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();

  const failed = await running;
  assert.equal(failed.state, 'FAILED');
  assert.deepEqual(failed.tokenUsage, usage);
  assert.equal(failed.modelCallCount, 1);
  assert.equal(failed.usageReportedCallCount, 1);
  assert.equal(h.waveStreamCalls.length, 1);
  await access(h.formalFilePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  await h.runtime.beforeQuit();

  const resumedRuntime = createProductionClassTaskRuntime(h.runtimeOptions);
  const [restored] = await resumedRuntime.startup();
  assert.equal(restored.state, 'FAILED');
  const resumedBroadcastOffset = broadcasts.length;
  const completed = await resumedRuntime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await resumedRuntime.beforeQuit();

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  assert.deepEqual(completed.tokenUsage, usage);
  assert.equal(completed.modelCallCount, 1);
  assert.equal(completed.usageReportedCallCount, 1);
  const resumedBroadcasts = broadcasts.slice(resumedBroadcastOffset);
  assert.ok(resumedBroadcasts.length > 0);
  assert.ok(resumedBroadcasts.every((snapshot) => (
    snapshot.modelCallCount === 1
    && snapshot.usageReportedCallCount === 1
    && snapshot.tokenUsage?.totalTokens === usage.totalTokens
  )), 'failed retry must not broadcast a transient zero model-usage snapshot');
  assert.equal(h.waveStreamCalls.length, 1, 'the published Wave must not run again');
  await access(h.formalFilePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
});

test('reformalizing a regenerated passing Wave keeps the already published artifact', async (t) => {
  // Mutation caught: comparing regenerated method count or refreshed JaCoCo display order
  // with the published artifact turns a recoverable post-publication retry into a failure.
  const h = await productionWaveRuntimeHarness(t, {
    failCoverageRefreshAfterFormalOnce: true
  });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();

  const failed = await running;
  assert.equal(failed.state, 'FAILED');
  await access(h.formalFilePath);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');

  const checkpointPath = join(h.storageDirectory, 'class-task-checkpoints-v2.json');
  const checkpointStore = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const candidates = Object.values(
    checkpointStore.tasks[TASK_ID].waveState.candidates
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'PASSED');
  assert.equal(candidates[0].managedFile, null);

  const [taskSnapshot] = await h.runtime.listClassTasks({
    workspaceRoot: h.workspaceRoot
  });
  const runningTask = {
    ...taskSnapshot,
    state: 'RUNNING',
    lastError: null,
    finishedAt: null
  };
  await h.runtime.coordinator.dependencies.registry.save(runningTask);
  await h.runtime.coordinator.formalizeWave(runningTask, {
    methodId: h.methodId,
    sourceMethodId: h.methodId,
    waveIndex: 1,
    hasRemainingScenarios: false,
    methodName: 'run',
    displaySignature: 'run()',
    jacocoOrder: 7,
    code: [
      'package example;',
      'import org.junit.jupiter.api.Test;',
      'public class TaskTmp1Test {',
      '  @Test void regeneratedOne() { new Task().run(); }',
      '  @Test void regeneratedTwo() { new Task().run(); }',
      '}',
      ''
    ].join('\n'),
    ordinaryTestMethodCount: 2,
    passedTestMethods: ['regeneratedOne', 'regeneratedTwo'],
    sourceBatchIds: [candidates[0].candidateId]
  }, new AbortController().signal);

  const publishedCode = await readFile(h.formalFilePath, 'utf8');
  assert.match(publishedCode, /void m1_generated\(\)/);
  assert.doesNotMatch(publishedCode, /regeneratedOne|regeneratedTwo/);
});

test('failed retry preserves a formal file when a later method candidate is missing', async (t) => {
  // Mutation caught: a missing candidate for the active method must not revoke a formal
  // artifact already published by an earlier method in the same class task.
  const h = await productionWaveRuntimeHarness(t, {
    failCoverageRefreshAfterFormalOnce: true
  });
  await h.runtime.startup();
  const running = h.runtime.runTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });
  await h.waveStarted.promise;
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();
  const failed = await running;
  assert.equal(failed.state, 'FAILED');
  await access(h.formalFilePath);
  await h.runtime.beforeQuit();

  const secondMethodId = 'f'.repeat(64);
  const taskStorePath = join(h.storageDirectory, 'class-tasks-v2.json');
  const taskStore = JSON.parse(await readFile(taskStorePath, 'utf8'));
  taskStore.tasks[TASK_ID].selectedMethodIds = [h.methodId, secondMethodId];
  taskStore.tasks[TASK_ID].methodOrder = [h.methodId, secondMethodId];
  await writeFile(taskStorePath, JSON.stringify(taskStore), 'utf8');

  const checkpointPath = join(h.storageDirectory, 'class-task-checkpoints-v2.json');
  const checkpointStore = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const checkpoint = checkpointStore.tasks[TASK_ID];
  const firstActiveWave = checkpoint.waveState.activeWave;
  checkpoint.resolvedMethodOrder = [h.methodId, secondMethodId];
  checkpoint.completedMethodIds = [h.methodId];
  checkpoint.waveState.methods[h.methodId] = {
    completedScenarioIds: [...firstActiveWave.selectedScenarioIds],
    skippedScenarioIds: [],
    nextWaveIndex: 2,
    remainingScenarioCount: 0,
    completedWaves: [{
      waveId: firstActiveWave.waveId,
      waveIndex: 1,
      selectedScenarioIds: [...firstActiveWave.selectedScenarioIds],
      completedScenarioIds: [...firstActiveWave.selectedScenarioIds],
      skippedScenarioIds: [],
      remainingScenarioCount: 0,
      candidateIds: []
    }]
  };
  checkpoint.waveState.methods[secondMethodId] = {
    completedScenarioIds: [],
    skippedScenarioIds: [],
    nextWaveIndex: 1,
    remainingScenarioCount: null,
    completedWaves: []
  };
  checkpoint.waveState.methodQueue = [];
  checkpoint.waveState.activeMethodId = secondMethodId;
  checkpoint.waveState.activeWave = {
    ...firstActiveWave,
    waveId: '9'.repeat(64),
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: secondMethodId,
    selectedScenarioIds: ['scenario-second-1'],
    remainingScenarioCount: 0,
    wave: null,
    parts: [{
      ...firstActiveWave.parts[0],
      partBatchId: '8'.repeat(64),
      scenarioIds: ['scenario-second-1'],
      status: 'SUCCEEDED',
      childSessionId: null,
      candidateId: '99999999-9999-4999-8999-999999999999',
      isolatedFilePath: join(
        h.workspaceRoot,
        '.ai-unit-test',
        'missing',
        'TaskTmp1Part1Test.java'
      ),
      fileSha256: '7'.repeat(64),
      failureReason: null
    }]
  };
  await writeFile(checkpointPath, JSON.stringify(checkpointStore), 'utf8');

  const resumedRuntime = createProductionClassTaskRuntime({
    ...h.runtimeOptions,
    buildSettingsService: { async get() { return null; } }
  });
  const [restored] = await resumedRuntime.startup();
  assert.equal(restored.state, 'FAILED');
  const retried = await resumedRuntime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  await resumedRuntime.beforeQuit();

  assert.equal(retried.state, 'PRELOAD_FAILED');
  assert.equal(retried.generatedArtifacts.length, 1);
  assert.equal(retried.generatedArtifacts[0].filePath, h.formalFilePath);
  await access(h.formalFilePath);
});

test('production formal publication failure deletes Wave TMP, Part, and isolation scratch', async (t) => {
  // Mutation caught: terminal failure without scratch cleanup leaves project TMP files and
  // both hidden Wave trees behind even though this run cannot be resumed.
  const h = await productionWaveRuntimeHarness(t, { failFormalPublication: true });
  await h.runtime.startup();

  const running = h.runtime.runTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  const firstBoundary = await Promise.race([
    h.waveStarted.promise.then(() => ({ kind: 'wave-started' })),
    running.then((snapshot) => ({ kind: 'task-ended', snapshot }))
  ]);
  assert.equal(
    firstBoundary.kind,
    'wave-started',
    firstBoundary.snapshot?.lastError?.message
  );
  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();

  const failed = await running;
  await h.runtime.flush();

  assert.equal(failed.state, 'FAILED');
  assert.match(failed.lastError?.message ?? '', /verification/i);
  assert.deepEqual(h.analyzerCalls.map((call) => call.kind), ['wave']);
  assert.deepEqual(failed.generatedArtifacts, []);
  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(h.formalFilePath), (error) => error?.code === 'ENOENT');

  const stored = JSON.parse(await readFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    'utf8'
  ));
  const candidates = Object.values(stored.tasks[TASK_ID].waveState.candidates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'PASSED');
  assert.equal(candidates[0].managedFile, null);
  assert.equal(candidates[0].moveTransaction, null);
  await assert.rejects(
    access(waveScratchTaskDirectory(h.workspaceRoot, 'method-wave-candidates')),
    (error) => error?.code === 'ENOENT'
  );
  await assert.rejects(
    access(waveScratchTaskDirectory(h.workspaceRoot, 'method-wave-parts')),
    (error) => error?.code === 'ENOENT'
  );
});

test('terminating a production run deletes orphan Wave Part and isolated TMP trees', async (t) => {
  // Mutation caught: handling only FAILED releases leaves the same scratch trees behind
  // when the user explicitly terminates an active card.
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const running = h.runtime.runTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });
  await h.waveStarted.promise;

  const storedPart = await new MethodWavePartStoreService().store({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    methodId: h.methodId,
    sourceClassName: 'Task',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'd'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '66666666-6666-4666-8666-666666666666',
    code: 'package example; public class TaskTmp1Part1Test {}\n'
  });
  const candidateRoot = waveScratchTaskDirectory(
    h.workspaceRoot,
    'method-wave-candidates'
  );
  const orphanTmp = join(candidateRoot, 'orphan-candidate', 'TaskTmp1Test.java');
  await mkdir(dirname(orphanTmp), { recursive: true });
  await writeFile(orphanTmp, 'package example; public class TaskTmp1Test {}\n', 'utf8');

  const terminated = await h.runtime.terminateTask({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID
  });
  const ended = await running;

  assert.equal(terminated.state, 'TERMINATED');
  assert.equal(ended.state, 'TERMINATED');
  await assert.rejects(access(storedPart.filePath), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(candidateRoot), (error) => error?.code === 'ENOENT');
});

test('completing a production run deletes orphan isolated Wave TMP trees', async (t) => {
  // Mutation caught: completed runs used to skip terminal scratch cleanup, so a candidate
  // discarded during catalog reconciliation remained forever outside the checkpoint.
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const running = h.runtime.runTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });
  await h.waveStarted.promise;

  const candidateRoot = waveScratchTaskDirectory(
    h.workspaceRoot,
    'method-wave-candidates'
  );
  const orphanTmp = join(candidateRoot, 'discarded-candidate', 'TaskTmp1Test.java');
  await mkdir(dirname(orphanTmp), { recursive: true });
  await writeFile(orphanTmp, 'package example; public class TaskTmp1Test {}\n', 'utf8');

  h.releaseWave.resolve();
  await h.tmpDeleteStarted.promise;
  h.releaseTmpDelete.resolve();
  const completed = await running;

  assert.equal(completed.state, 'COMPLETED', completed.lastError?.message);
  await assert.rejects(access(candidateRoot), (error) => error?.code === 'ENOENT');
});

test('removing an interrupted production task deletes its project TMP and Wave Part tree', async (t) => {
  // Mutation caught: releaseRun preserves recovery files for interruption, but an explicit
  // card deletion must consume the persisted Wave ownership before removing its checkpoint.
  const h = await productionWaveRuntimeHarness(t);
  const candidateId = '66666666-6666-4666-8666-666666666666';
  const waveId = 'c'.repeat(64);
  const tmpSource = 'package example; public class TaskTmp1Test {}\n';
  const tmpSha256 = createHash('sha256').update(tmpSource).digest('hex');
  await mkdir(dirname(h.tmpFilePath), { recursive: true });
  await writeFile(h.tmpFilePath, tmpSource, 'utf8');
  const storedPart = await new MethodWavePartStoreService().store({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    methodId: h.methodId,
    sourceClassName: 'Task',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'd'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId,
    code: 'package example; public class TaskTmp1Part1Test {}\n'
  });
  const taskStatePath = join(h.storageDirectory, 'class-tasks-v2.json');
  const taskState = JSON.parse(await readFile(taskStatePath, 'utf8'));
  taskState.tasks[TASK_ID].state = 'INTERRUPTED';
  await writeFile(taskStatePath, JSON.stringify(taskState), 'utf8');
  await writeFile(
    join(h.storageDirectory, 'class-task-checkpoints-v2.json'),
    JSON.stringify({
      version: 5,
      tasks: {
        [TASK_ID]: {
          catalogIdentity: null,
          resolvedMethodOrder: [],
          completedMethodIds: [],
          methods: {},
          ragRun: null,
          waveState: {
            methodQueue: [],
            activeMethodId: null,
            methods: {},
            activeWave: null,
            candidates: {
              [candidateId]: {
                candidateId,
                methodId: h.methodId,
                waveId,
                status: 'PASSED',
                llmRepairAttemptsUsed: 2,
                repairAttemptLimit: 5,
                unlimitedRepair: false,
                lastMavenBatchId: null,
                stableRepair: {
                  phase: 'NOT_STARTED',
                  iteration: 0,
                  annotatedMemberIds: []
                },
                managedFile: {
                  path: h.tmpFilePath,
                  sha256: tmpSha256,
                  location: 'PROJECT'
                },
                moveTransaction: null
              }
            },
            migrationInterrupted: false
          }
        }
      }
    }),
    'utf8'
  );
  await h.runtime.startup();
  h.releaseTmpDelete.resolve();

  await h.runtime.removeClassTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });

  await assert.rejects(access(h.tmpFilePath), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(storedPart.filePath), (error) => error?.code === 'ENOENT');
  assert.deepEqual(await h.runtime.listClassTasks({ workspaceRoot: h.workspaceRoot }), []);
});

test('application interruption preserves Wave scratch needed for recovery', async (t) => {
  // Mutation caught: treating every non-running release as terminal destroys durable
  // recovery inputs when closing the Workstation or pausing execution.
  const h = await productionWaveRuntimeHarness(t);
  await h.runtime.startup();
  const running = h.runtime.runTask({ workspaceRoot: h.workspaceRoot, taskId: TASK_ID });
  await h.waveStarted.promise;

  const storedPart = await new MethodWavePartStoreService().store({
    workspaceRoot: h.workspaceRoot,
    taskId: TASK_ID,
    methodId: h.methodId,
    sourceClassName: 'Task',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'd'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '66666666-6666-4666-8666-666666666666',
    code: 'package example; public class TaskTmp1Part1Test {}\n'
  });
  const orphanTmp = join(
    waveScratchTaskDirectory(h.workspaceRoot, 'method-wave-candidates'),
    'orphan-candidate',
    'TaskTmp1Test.java'
  );
  await mkdir(dirname(orphanTmp), { recursive: true });
  await writeFile(orphanTmp, 'package example; public class TaskTmp1Test {}\n', 'utf8');

  const shuttingDown = h.runtime.beforeQuit();
  const interrupted = await running;
  await shuttingDown;

  assert.equal(interrupted.state, 'INTERRUPTED');
  await access(storedPart.filePath);
  await access(storedPart.sidecarPath);
  await access(orphanTmp);
});

test('startup keeps a missing result actionable so it can be accepted', async (t) => {
  // A missing generated file is still a pending result: accept records the user's decision
  // without restoring or reading the file.
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-missing-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const missingTestFilePath = join(
    moduleRoot,
    'src',
    'test',
    'java',
    'example',
    'Task1Test.java'
  );
  const storageDirectory = join(root, 'state');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');
  const staleArtifact = {
    id: 'artifact-1',
    filePath: missingTestFilePath,
    testClassName: 'Task1Test',
    ordinaryTestMethodCount: 1,
    methodIds: ['method-id'],
    sha256: createHash('sha256').update('missing generated test').digest('hex'),
    sealed: false,
    accepted: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
  await writeFile(join(storageDirectory, 'class-tasks-v2.json'), JSON.stringify({
    version: 3,
    tasks: {
      [TASK_ID]: task(TASK_ID, 'FAILED', {
        workspaceRoot,
        sourceFilePath,
        qualifiedClassName: 'example.Task',
        moduleKey: `${moduleRoot.replaceAll('\\', '/').toLowerCase()}/pom.xml`,
        moduleDisplayPath: moduleRoot,
        generatedArtifacts: [staleArtifact],
        coverageBaseline: {
          lineCovered: 0, lineMissed: 1, lineTotal: 1,
          branchCovered: 0, branchMissed: 0, branchTotal: 0
        },
        coverageCurrent: {
          lineCovered: 1, lineMissed: 0, lineTotal: 1,
          branchCovered: 0, branchMissed: 0, branchTotal: 0
        },
        coverageContributions: [{
          artifactId: staleArtifact.id,
          filePath: missingTestFilePath,
          addedLineCount: 1,
          lineTotal: 1,
          addedBranchCount: 0,
          branchTotal: 0
        }],
        startedAt: '2026-08-09T00:00:00.000Z',
        finishedAt: '2026-08-09T00:01:00.000Z',
        lastError: {
          code: 'CLASS_TASK_EXECUTION_FAILED',
          message: 'previous generation failed',
          moduleName: 'example.Task',
          modulePath: moduleRoot,
          command: null,
          occurredAt: '2026-08-09T00:01:00.000Z'
        }
      })
    }
  }), 'utf8');
  const externalCalls = [];
  const forbidden = (name) => async () => {
    externalCalls.push(name);
    throw new Error(`${name} must not run during stale artifact recovery`);
  };
  const runtime = createProductionClassTaskRuntime({
    storageDirectory,
    aiClient: new Proxy({}, { get: (_target, key) => forbidden(`ai:${String(key)}`) }),
    shellService: new Proxy({}, { get: (_target, key) => forbidden(`shell:${String(key)}`) }),
    mavenAnalysisContextService: { collect: forbidden('analysis-context') },
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: {},
    surefireReportService: {},
    buildSettingsService: { get: forbidden('build-settings') },
    modelInterfacesService: {
      getView: forbidden('model-view'),
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast() {}
  });

  const [restored] = await runtime.startup();

  assert.equal(restored.state, 'FAILED');
  assert.deepEqual(restored.generatedArtifacts, [staleArtifact]);

  const available = await runtime.getTaskResult({ workspaceRoot, taskId: TASK_ID });
  assert.equal(available?.artifacts[0]?.id, staleArtifact.id);
  assert.equal(available?.canAccept, true);

  const accepted = await runtime.acceptTaskResult({ workspaceRoot, taskId: TASK_ID });
  assert.equal(accepted.artifacts[0]?.accepted, true);
  assert.equal(accepted.canAccept, false);
  assert.equal(accepted.canRevoke, false);
  assert.deepEqual(externalCalls, []);
  await runtime.beforeQuit();
});

test('completed result lookup keeps a deleted test file actionable', async (t) => {
  // Result visibility comes from persisted task metadata so accept or revoke remains possible
  // even when the generated file was deleted outside the application.
  const fixture = await completedResultFileFixture(t);

  const initial = await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(initial?.artifacts.length, 1);

  await rm(fixture.testFilePath);

  const missing = await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(missing?.artifacts[0]?.filePath, fixture.testFilePath);
  assert.equal(missing?.canAccept, true);
  assert.equal(missing?.canRevoke, true);
  const [preserved] = await fixture.runtime.listClassTasks({
    workspaceRoot: fixture.workspaceRoot
  });
  assert.deepEqual(preserved.generatedArtifacts, [fixture.artifact]);
  assert.deepEqual(fixture.externalCalls, []);
});

test('accept succeeds when the test file is deleted after the result opens', async (t) => {
  // Accept records the result decision and deliberately performs no file operation.
  const fixture = await completedResultFileFixture(t);
  assert.ok(await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  }));
  await rm(fixture.testFilePath);

  const accepted = await fixture.runtime.acceptTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(accepted.artifacts[0]?.accepted, true);
  assert.equal(accepted.canAccept, false);
  assert.equal(accepted.canRevoke, false);
  assert.deepEqual(accepted.coverageBaseline, accepted.coverageCurrent);
  assert.deepEqual(accepted.coverageContributions, []);
  await assert.rejects(access(fixture.testFilePath), { code: 'ENOENT' });
  const [persisted] = await fixture.runtime.listClassTasks({
    workspaceRoot: fixture.workspaceRoot
  });
  assert.equal(persisted.generatedArtifacts[0]?.accepted, true);
  assert.deepEqual(persisted.coverageBaseline, persisted.coverageCurrent);
  assert.deepEqual(persisted.coverageContributions, []);
  const reopened = await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(reopened?.artifacts[0]?.accepted, true);
  assert.equal(reopened?.canAccept, false);
  assert.equal(reopened?.canRevoke, false);
  assert.deepEqual(reopened?.coverageBaseline, reopened?.coverageCurrent);
  assert.deepEqual(reopened?.coverageContributions, []);
  assert.deepEqual(fixture.externalCalls, []);
});

test('revoke succeeds when the test file is already missing', async (t) => {
  // Revoke treats deletion as idempotent and still clears result metadata and coverage.
  const fixture = await completedResultFileFixture(t);
  assert.ok(await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  }));
  await rm(fixture.testFilePath);

  const revoked = await fixture.runtime.revokeTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(revoked.artifacts.length, 0);
  assert.deepEqual(revoked.coverageCurrent, revoked.coverageBaseline);
  assert.equal(revoked.canAccept, false);
  assert.equal(revoked.canRevoke, false);
  const [persisted] = await fixture.runtime.listClassTasks({
    workspaceRoot: fixture.workspaceRoot
  });
  assert.deepEqual(persisted.generatedArtifacts, []);
  assert.deepEqual(persisted.coverageCurrent, persisted.coverageBaseline);
  assert.deepEqual(persisted.coverageContributions, []);
  assert.deepEqual(fixture.externalCalls, []);
});

test('accept leaves an externally modified test file unchanged', async (t) => {
  const fixture = await completedResultFileFixture(t);
  assert.ok(await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  }));
  const userEdit = 'package example; public class Task1Test { void userEdit() {} }';
  await writeFile(fixture.testFilePath, userEdit, 'utf8');

  const accepted = await fixture.runtime.acceptTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(accepted.artifacts[0]?.accepted, true);
  assert.equal(await readFile(fixture.testFilePath, 'utf8'), userEdit);
  assert.deepEqual(fixture.externalCalls, []);
});

test('revoke deletes an externally modified test file', async (t) => {
  const fixture = await completedResultFileFixture(t);
  assert.ok(await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  }));
  await writeFile(
    fixture.testFilePath,
    'package example; public class Task1Test { void userEdit() {} }',
    'utf8'
  );

  const revoked = await fixture.runtime.revokeTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(revoked.artifacts.length, 0);
  await assert.rejects(access(fixture.testFilePath), { code: 'ENOENT' });
  assert.deepEqual(fixture.externalCalls, []);
});

test('revoke removes an available pending result and restores persisted baseline without Analyzer or Maven', async (t) => {
  // Mutation caught: preparing or recalculating coverage after deleting the result can leave
  // a half-revoked task when Analyzer refresh fails: the file is gone but stale metadata remains.
  const fixture = await completedResultFileFixture(t);

  const revoked = await fixture.runtime.revokeTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(revoked.artifacts.length, 0);
  assert.deepEqual(revoked.coverageCurrent, revoked.coverageBaseline);
  assert.equal(revoked.canAccept, false);
  assert.equal(revoked.canRevoke, false);
  await assert.rejects(access(fixture.testFilePath), { code: 'ENOENT' });
  const [persisted] = await fixture.runtime.listClassTasks({
    workspaceRoot: fixture.workspaceRoot
  });
  assert.deepEqual(persisted.generatedArtifacts, []);
  assert.deepEqual(persisted.coverageCurrent, persisted.coverageBaseline);
  assert.deepEqual(persisted.coverageContributions, []);
  assert.deepEqual(fixture.externalCalls, []);
});

test('revoke deletes only pending files and preserves previously accepted files', async (t) => {
  const fixture = await completedResultFileFixture(t, 'COMPLETED', {
    includeAcceptedArtifact: true
  });

  const revoked = await fixture.runtime.revokeTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(revoked.artifacts.length, 1);
  assert.equal(revoked.artifacts[0]?.accepted, true);
  assert.equal(revoked.artifacts[0]?.filePath, fixture.acceptedTestFilePath);
  assert.equal(
    await readFile(fixture.acceptedTestFilePath, 'utf8'),
    fixture.acceptedTestFileContent
  );
  await assert.rejects(access(fixture.testFilePath), { code: 'ENOENT' });
  const [persisted] = await fixture.runtime.listClassTasks({
    workspaceRoot: fixture.workspaceRoot
  });
  assert.deepEqual(persisted.generatedArtifacts, [fixture.acceptedArtifact]);
  assert.deepEqual(fixture.externalCalls, []);
});

test('revoke on a paused task deletes only pending files and keeps the task paused', async (t) => {
  const fixture = await completedResultFileFixture(t, 'PAUSED');

  const revoked = await fixture.runtime.revokeTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });

  assert.equal(revoked.state, 'PAUSED');
  assert.equal(revoked.canAccept, false);
  assert.equal(revoked.canRevoke, false);
  await assert.rejects(access(fixture.testFilePath), { code: 'ENOENT' });
  const [persisted] = await fixture.runtime.listClassTasks({
    workspaceRoot: fixture.workspaceRoot
  });
  assert.equal(persisted.state, 'PAUSED');
  assert.deepEqual(persisted.generatedArtifacts, []);
  assert.deepEqual(persisted.coverageCurrent, persisted.coverageBaseline);
  assert.deepEqual(fixture.externalCalls, []);
});

test('a terminated pending result remains actionable and visible after revoke', async (t) => {
  const fixture = await completedResultFileFixture(t, 'TERMINATED');

  const pending = await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(pending?.state, 'TERMINATED');
  assert.equal(pending?.canAccept, true);
  assert.equal(pending?.canRevoke, true);

  const revoked = await fixture.runtime.revokeTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(revoked.state, 'TERMINATED');
  assert.equal(revoked.artifacts.length, 0);

  const reopened = await fixture.runtime.getTaskResult({
    workspaceRoot: fixture.workspaceRoot,
    taskId: TASK_ID
  });
  assert.equal(reopened?.state, 'TERMINATED');
  assert.equal(reopened?.artifacts.length, 0);
  assert.equal(reopened?.canAccept, false);
  assert.equal(reopened?.canRevoke, false);
  assert.deepEqual(fixture.externalCalls, []);
});

test('production composition persists and broadcasts a class-local preload failure without model or Maven calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const sourceDirectory = join(workspaceRoot, 'module-a', 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(workspaceRoot, 'module-a', 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');
  const broadcasts = [];
  const forbiddenCalls = [];
  const forbidden = (name) => async () => {
    forbiddenCalls.push(name);
    throw new Error(`${name} must not run when build settings are absent`);
  };
  const runtime = createProductionClassTaskRuntime({
    storageDirectory: join(root, 'state'),
    aiClient: new Proxy({}, { get: (_target, key) => forbidden(`ai:${String(key)}`) }),
    shellService: new Proxy({}, { get: (_target, key) => forbidden(`shell:${String(key)}`) }),
    mavenAnalysisContextService: { collect: forbidden('analysis-context') },
    testWriterService: {},
    jacocoArtifactsService: {},
    surefireReportService: {},
    buildSettingsService: { get: async () => null },
    modelInterfacesService: {
      getView: forbidden('model-view'),
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast(snapshot) { broadcasts.push(structuredClone(snapshot)); }
  });
  await runtime.startup();

  const [added] = await runtime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });
  await runtime.flush();
  const [persisted] = await runtime.listClassTasks({ workspaceRoot });

  assert.equal(added.state, 'PRELOADING');
  assert.equal(persisted.state, 'PRELOAD_FAILED');
  assert.equal(persisted.lastError.code, 'BUILD_SETTINGS_UNAVAILABLE');
  assert.equal(broadcasts.at(-1).state, 'PRELOAD_FAILED');
  assert.deepEqual(forbiddenCalls, []);
  await runtime.beforeQuit();
});

test('a legacy preload cache cannot leave a class task permanently running', async (t) => {
  // Mutation caught: rejecting an older class-pair shape also breaks the failure-state writeback.
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-legacy-preload-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const storageDirectory = join(root, 'state');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');
  await writeFile(join(storageDirectory, 'module-preload-cache-v1.json'), JSON.stringify({
    version: 1,
    modules: {
      'legacy-module': {
        moduleKey: 'legacy-module',
        moduleName: 'legacy',
        modulePath: moduleRoot,
        state: 'READY',
        fingerprint: 'a'.repeat(64),
        executionDataPath: join(moduleRoot, 'target', 'legacy.exec'),
        classReportPairs: {
          'example.Legacy': {
            qualifiedClassName: 'example.Legacy',
            fingerprint: 'a'.repeat(64),
            reportPairId: 'b'.repeat(64),
            reportPath: join(moduleRoot, 'target', 'Legacy.xml'),
            branchSnapshotPath: join(moduleRoot, 'target', 'Legacy.branches.json'),
            generatedAt: '2026-08-09T01:02:03.000Z'
          }
        },
        classPreloadFailures: {},
        diagnostic: null,
        updatedAt: '2026-08-09T01:02:03.000Z'
      }
    }
  }), 'utf8');

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory,
    maven
  }));
  t.after(() => runtime.beforeQuit());
  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });
  await maven.compileStarted;
  maven.finish({
    command: 'fake-mvn compile',
    cwd: moduleRoot,
    exitCode: 0,
    stdout: '',
    stderr: ''
  });
  await runtime.flush();

  const [persisted] = await runtime.listClassTasks({ workspaceRoot });
  assert.equal(persisted.state, 'PRELOAD_FAILED');
  assert.equal(persisted.preloadState, 'FAILED');
  assert.equal(maven.moduleCallCount, 0);
  assert.equal(maven.compileCallCount, 1);
  assert.equal(maven.directCallCount, 0);
});

test('an unreadable preload cache reports failure instead of leaving a class task running', async (t) => {
  // Mutation caught: rereading the same corrupt cache inside failure handling strands RUNNING cards.
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-corrupt-preload-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const storageDirectory = join(root, 'state');
  const cachePath = join(storageDirectory, 'module-preload-cache-v1.json');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');
  await writeFile(cachePath, '{invalid-main', 'utf8');
  await writeFile(`${cachePath}.bak`, '{invalid-backup', 'utf8');

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory,
    maven
  }));
  t.after(() => runtime.beforeQuit().catch(() => undefined));
  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });

  let persisted;
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    [persisted] = await runtime.listClassTasks({ workspaceRoot });
    if (persisted?.state !== 'PRELOADING') break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(persisted.state, 'PRELOAD_FAILED');
  assert.equal(persisted.preloadState, 'FAILED');
  assert.equal(persisted.lastError?.code, 'CLASS_PRELOAD_FAILED');
  assert.equal(maven.moduleCallCount, 0);
  assert.equal(maven.directCallCount, 0);
});

test('adding a class starts only its direct-test coverage command, never the full module suite', async (t) => {
  // Mutation caught: restoring the prepareTask -> ensureReady call starts the module-wide Maven command.
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-class-only-preload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Only.java');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Only {}', 'utf8');
  await writeFile(
    join(testDirectory, 'OnlyTest.java'),
    'package example; public class OnlyTest { Only target; }',
    'utf8'
  );

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven
  }));
  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });

  const firstCommand = await Promise.race([
    maven.moduleStarted.then(() => 'module'),
    maven.directStarted.then(() => 'direct')
  ]);
  await runtime.beforeQuit();

  assert.equal(firstCommand, 'direct');
  assert.equal(maven.moduleCallCount, 0);
  assert.equal(maven.directCallCount, 1);
});

test('aggregate backend readiness cannot block Workstation targeted Maven preparation', async (t) => {
  // Mutation caught: guarding class preload with the aggregate managed-runtime
  // check makes an unavailable Agent Service block local fingerprint/Maven work.
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-local-preload-first-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Only.java');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Only {}', 'utf8');
  await writeFile(
    join(testDirectory, 'OnlyTest.java'),
    'package example; public class OnlyTest { Only target; }',
    'utf8'
  );

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven,
    assertBackendReady() {
      throw new Error('Agent Service is unavailable.');
    }
  }));
  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });

  const firstOutcome = await Promise.race([
    maven.directStarted.then(() => 'targeted-maven-started'),
    runtime.flush().then(() => 'preparation-finished')
  ]);
  await runtime.beforeQuit();

  assert.equal(firstOutcome, 'targeted-maven-started');
  assert.equal(maven.moduleCallCount, 0);
  assert.equal(maven.directCallCount, 1);
});

test('class preload isolates an unowned same-class TMP before Maven starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-orphan-project-tmp-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const orphanTmpPath = join(testDirectory, 'TaskTmp3Test.java');
  const unrelatedTmpPath = join(testDirectory, 'OtherTmp1Test.java');
  const orphanCode = 'package example; public class TaskTmp3Test {}\n';
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');
  await writeFile(orphanTmpPath, orphanCode, 'utf8');
  await writeFile(
    unrelatedTmpPath,
    'package example; public class OtherTmp1Test {}\n',
    'utf8'
  );

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven
  }));
  t.after(async () => {
    await Promise.allSettled([runtime.beforeQuit()]);
    await rm(root, { recursive: true, force: true });
  });
  await runtime.startup();
  const [added] = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: [sourceFilePath]
  });

  await maven.compileStarted;

  await assert.rejects(access(orphanTmpPath), (error) => error?.code === 'ENOENT');
  await access(unrelatedTmpPath);
  const orphanTaskRoot = join(
    workspaceRoot,
    '.ai-unit-test',
    'orphan-wave-candidates',
    createHash('sha256').update(added.id, 'utf8').digest('hex').slice(0, 24)
  );
  const orphanIds = await readdir(orphanTaskRoot);
  assert.equal(orphanIds.length, 1);
  assert.equal(
    await readFile(join(orphanTaskRoot, orphanIds[0], 'TaskTmp3Test.java'), 'utf8'),
    orphanCode
  );
});

test('keeps a class PRELOADING and exponentially retries when a healthy Analyzer response times out', async (t) => {
  // Mutation caught: publishing READY after only the class report exposes the card
  // before Analyzer and JaCoCo preparation have completed.
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-pending-analyzer-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');

  let markAnalyzerRetryStarted;
  let rejectAnalyzer;
  let analyzerCalls = 0;
  let analyzerHealthChecks = 0;
  const createdAnalysisSessionIds = [];
  const deletedAnalysisSessionIds = [];
  const analyzerRetryStarted = new Promise((resolve) => {
    markAnalyzerRetryStarted = resolve;
  });
  const pairId = 'a'.repeat(64);
  const broadcasts = [];
  const maven = controlledPreloadMaven();
  const options = productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven,
    broadcast(snapshot) {
      broadcasts.push(structuredClone(snapshot));
    }
  });
  const runtime = createProductionClassTaskRuntime({
    ...options,
    analysisResponseTimeoutRetryInitialDelayMilliseconds: 1,
    analysisResponseTimeoutRetryMaxDelayMilliseconds: 4,
    aiClient: {
      async generateTargetJacocoReport(request) {
        const report = Buffer.from('<report name="example.Task"/>', 'utf8');
        await mkdir(dirname(request.outputPath), { recursive: true });
        await writeFile(request.outputPath, report);
        await writeFile(request.branchSnapshotOutputPath, JSON.stringify({
          schemaVersion: 1,
          pairId,
          reportSha256: createHash('sha256').update(report).digest('hex')
        }), 'utf8');
        return {
          generated: true,
          reportPath: request.outputPath,
          branchSnapshotPath: request.branchSnapshotOutputPath,
          pairId,
          targetClass: request.targetClass,
          generatedAt: '2026-08-10T00:00:00.000Z',
          message: 'generated'
        };
      },
      async createMethodAnalysisSession(request, signal) {
        analyzerCalls += 1;
        createdAnalysisSessionIds.push(request.analysisSessionId);
        if (analyzerCalls === 1) {
          throw Object.assign(new Error('Java Analyzer 响应等待时间过长，请稍后重试。'), {
            name: 'BackendResponseTimeoutError',
            code: 'BACKEND_RESPONSE_TIMEOUT',
            backendName: 'Java Analyzer'
          });
        }
        markAnalyzerRetryStarted();
        return new Promise((_resolve, reject) => {
          rejectAnalyzer = reject;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      async isJavaAnalyzerHealthy() {
        analyzerHealthChecks += 1;
        return true;
      },
      async deleteMethodAnalysisSession(sessionId) {
        deletedAnalysisSessionIds.push(sessionId);
      }
    },
    testWriterService: {
      async planGeneratedTestLocation() {
        return {
          testClassName: 'TaskGenerated1Test',
          relativeTestPath: 'src/test/java/example/TaskGenerated1Test.java'
        };
      }
    },
    mavenAnalysisContextService: {
      async collect(input) {
        return {
          workspaceRoot: input.workspaceRoot,
          moduleRoot: input.moduleRoot,
          targetSourcePath: input.targetSourcePath,
          targetClass: input.targetClass,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath,
          reportPath: input.reportPath,
          branchSnapshotPath: input.branchSnapshotPath,
          reportPairId: input.reportPairId,
          sourceRoots: [join(moduleRoot, 'src', 'main', 'java')],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: 'b'.repeat(64),
          warnings: []
        };
      }
    }
  });
  t.after(async () => {
    await runtime.beforeQuit();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.startup();

  const [added] = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: [sourceFilePath]
  });
  await maven.compileStarted;
  maven.finish({
    command: 'fake-mvn compile',
    cwd: moduleRoot,
    exitCode: 0,
    stdout: '',
    stderr: ''
  });
  const retryStarted = await Promise.race([
    analyzerRetryStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250))
  ]);
  assert.equal(retryStarted, true, 'healthy Analyzer timeout should schedule a retry');

  const [pending] = await runtime.listClassTasks({ workspaceRoot });
  const readyBroadcasts = broadcasts.filter(
    (snapshot) => snapshot.id === added.id && snapshot.state === 'READY'
  ).length;
  assert.deepEqual(
    {
      state: pending.state,
      preloadState: pending.preloadState,
      readyBroadcasts
    },
    {
      state: 'PRELOADING',
      preloadState: 'RUNNING',
      readyBroadcasts: 0
    },
    'Analyzer session is still pending, so the task must not publish READY.'
  );
  assert.equal(analyzerCalls, 2);
  assert.equal(analyzerHealthChecks, 1);
  assert.equal(new Set(createdAnalysisSessionIds).size, 2);
  assert.equal(deletedAnalysisSessionIds.length, 1);

  rejectAnalyzer(new Error('strict Analyzer request rejected'));
  await runtime.flush();
  const [failed] = await runtime.listClassTasks({ workspaceRoot });
  assert.deepEqual(
    {
      state: failed.state,
      preloadState: failed.preloadState,
      readyBroadcasts: broadcasts.filter(
        (snapshot) => snapshot.id === added.id && snapshot.state === 'READY'
      ).length
    },
    {
      state: 'PRELOAD_FAILED',
      preloadState: 'FAILED',
      readyBroadcasts: 0
    }
  );
  assert.equal(deletedAnalysisSessionIds.length, 2);
  for (const sessionId of deletedAnalysisSessionIds) {
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
  }
});

test('transient invalid branch snapshots stay PRELOADING and retry with fresh class reports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-stale-branch-snapshot-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');

  const pairId = 'a'.repeat(64);
  let analyzerCalls = 0;
  let coverageRefreshCalls = 0;
  let reportCalls = 0;
  const createdAnalysisSessionIds = [];
  const deletedAnalysisSessionIds = [];
  const maven = controlledPreloadMaven();
  const options = productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven
  });
  const runtime = createProductionClassTaskRuntime({
    ...options,
    analysisResponseTimeoutRetryInitialDelayMilliseconds: 1,
    analysisResponseTimeoutRetryMaxDelayMilliseconds: 1,
    aiClient: {
      async generateTargetJacocoReport(request) {
        reportCalls += 1;
        const report = Buffer.from('<report name="example.Task"/>', 'utf8');
        await mkdir(dirname(request.outputPath), { recursive: true });
        await writeFile(request.outputPath, report);
        await writeFile(request.branchSnapshotOutputPath, JSON.stringify({
          schemaVersion: 1,
          pairId,
          targetClass: request.targetClass,
          executionDataSha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
          reportSha256: createHash('sha256').update(report).digest('hex'),
          methods: []
        }), 'utf8');
        return {
          generated: true,
          reportPath: request.outputPath,
          branchSnapshotPath: request.branchSnapshotOutputPath,
          pairId,
          targetClass: request.targetClass,
          generatedAt: '2026-08-19T00:00:00.000Z',
          message: 'generated'
        };
      },
      async createMethodAnalysisSession(request) {
        analyzerCalls += 1;
        createdAnalysisSessionIds.push(request.analysisSessionId);
        return {
          analysisSessionId: request.analysisSessionId,
          reportPairId: pairId,
          sourceSha256: 'c'.repeat(64),
          dependencyContextSha256: 'd'.repeat(64),
          packageName: 'example',
          testClassName: 'TaskGenerated1Test',
          suggestedRelativeTestPath: 'src/test/java/example/TaskGenerated1Test.java',
          warnings: []
        };
      },
      async refreshMethodAnalysisCoverage(sessionId) {
        coverageRefreshCalls += 1;
        if (coverageRefreshCalls <= 2) {
          throw new MethodAnalysisRequestError(
            'BRANCH_SNAPSHOT_INVALID',
            '单方法分析请求失败（BRANCH_SNAPSHOT_INVALID）：快照与当前字节码不匹配。'
          );
        }
        return {
          reportPairId: pairId,
          coverage: {
            lineCovered: 0,
            lineMissed: 0,
            lineTotal: 0,
            branchCovered: 0,
            branchMissed: 0,
            branchTotal: 0
          },
          catalog: {
            analysisSessionId: sessionId,
            reportPairId: pairId,
            methods: [],
            warnings: []
          }
        };
      },
      async deleteMethodAnalysisSession(sessionId) {
        deletedAnalysisSessionIds.push(sessionId);
      }
    },
    testWriterService: {
      async planGeneratedTestLocation() {
        return {
          testClassName: 'TaskGenerated1Test',
          relativeTestPath: 'src/test/java/example/TaskGenerated1Test.java'
        };
      }
    },
    mavenAnalysisContextService: {
      async collect(input) {
        return {
          workspaceRoot: input.workspaceRoot,
          moduleRoot: input.moduleRoot,
          targetSourcePath: input.targetSourcePath,
          targetClass: input.targetClass,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath,
          reportPath: input.reportPath,
          branchSnapshotPath: input.branchSnapshotPath,
          reportPairId: input.reportPairId,
          sourceRoots: [join(moduleRoot, 'src', 'main', 'java')],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: 'b'.repeat(64),
          warnings: []
        };
      }
    }
  });
  t.after(async () => {
    await runtime.beforeQuit();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });

  await maven.compileStarted;
  maven.finish({
    command: 'fake-mvn compile',
    cwd: moduleRoot,
    exitCode: 0,
    stdout: '',
    stderr: ''
  });
  for (let attempt = 0; attempt < 500 && maven.compileCallCount < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [whileRetrying] = await runtime.listClassTasks({ workspaceRoot });
  assert.equal(maven.compileCallCount, 2, 'the first fresh class report was not started');
  assert.equal(whileRetrying.state, 'PRELOADING');
  assert.equal(whileRetrying.lastError, null);
  maven.finish({
    command: 'fake-mvn compile',
    cwd: moduleRoot,
    exitCode: 0,
    stdout: '',
    stderr: ''
  });
  for (let attempt = 0; attempt < 500 && maven.compileCallCount < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(maven.compileCallCount, 3, 'the second fresh class report was not started');
  maven.finish({
    command: 'fake-mvn compile',
    cwd: moduleRoot,
    exitCode: 0,
    stdout: '',
    stderr: ''
  });
  await runtime.flush();

  const [ready] = await runtime.listClassTasks({ workspaceRoot });
  assert.equal(ready.state, 'READY', JSON.stringify(ready.lastError));
  assert.equal(ready.lastError, null);
  assert.equal(analyzerCalls, 3);
  assert.equal(coverageRefreshCalls, 3);
  assert.equal(reportCalls, 3);
  assert.deepEqual(deletedAnalysisSessionIds, createdAnalysisSessionIds.slice(0, 2));
});

test('recoverable Analyzer cancellation uses a fresh session before capacity recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-analyzer-capacity-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const firstSourcePath = join(sourceDirectory, 'One.java');
  const secondSourcePath = join(sourceDirectory, 'Two.java');
  const reportPairId = 'a'.repeat(64);
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(firstSourcePath, 'package example; public class One { void run() {} }', 'utf8');
  await writeFile(secondSourcePath, 'package example; public class Two { void run() {} }', 'utf8');

  const events = [];
  const createAttempts = new Map();
  const coverage = {
    lineCovered: 0,
    lineMissed: 1,
    lineTotal: 1,
    branchCovered: 0,
    branchMissed: 0,
    branchTotal: 0
  };
  const methodCatalog = (sessionId) => ({
    analysisSessionId: sessionId,
    reportPairId,
    methods: [{
      methodId: 'method-id',
      methodName: 'run',
      descriptor: '()V',
      displaySignature: 'run()',
      firstLine: 1,
      lastLine: 1,
      jacocoOrder: 0,
      lineCovered: 0,
      lineMissed: 1,
      branchCovered: 0,
      branchMissed: 0,
      instructionCovered: 0,
      instructionMissed: 1,
      complexityCovered: 0,
      complexityMissed: 1,
      coverageGap: true,
      generatable: true,
      unavailableReason: null,
      modifiers: ['public']
    }],
    warnings: []
  });
  const forbidden = (name) => async () => {
    throw new Error(`${name} must not run during class preload`);
  };
  const aiClient = {
    async generateTargetJacocoReport(request) {
      return {
        generated: true,
        reportPath: request.outputPath,
        branchSnapshotPath: request.branchSnapshotOutputPath,
        pairId: reportPairId,
        targetClass: request.targetClass,
        generatedAt: '2026-08-19T00:00:00.000Z',
        message: 'generated'
      };
    },
    async createMethodAnalysisSession(request) {
      const attempt = (createAttempts.get(request.targetClass) ?? 0) + 1;
      createAttempts.set(request.targetClass, attempt);
      events.push(`create:${request.targetClass}:${request.analysisSessionId}`);
      if (request.targetClass === 'example.One' && attempt === 1) {
        throw new MethodAnalysisRequestError(
          'ANALYSIS_SESSION_CANCELLED',
          '��U��ߛݽ�ANALYSIS_SESSION_CANCELLE�	Zg�������'
        );
      }
      if (request.targetClass === 'example.Two' && attempt === 1) {
        throw new MethodAnalysisRequestError(
          'ANALYSIS_CAPACITY_REACHED',
          '单方法分析请求失败（ANALYSIS_CAPACITY_REACHED）：Java 分析会话已满，请稍后重试。'
        );
      }
      return {
        analysisSessionId: request.analysisSessionId,
        reportPairId,
        sourceSha256: 'b'.repeat(64),
        dependencyContextSha256: 'c'.repeat(64),
        packageName: 'example',
        testClassName: `${request.targetClass.split('.').at(-1)}Tmp1Test`,
        suggestedRelativeTestPath: 'src/test/java/example/Tmp1Test.java',
        warnings: []
      };
    },
    async refreshMethodAnalysisCoverage(sessionId) {
      return { reportPairId, coverage, catalog: methodCatalog(sessionId) };
    },
    async deleteMethodAnalysisSession(sessionId) {
      events.push(`delete:${sessionId}`);
    },
    async heartbeatMethodAnalysisSession() { return true; },
    probeModelToolCalling: forbidden('probe-model'),
    classifyUnitTestTarget: forbidden('classify-target'),
    nextMethodBatch: forbidden('next-method-batch'),
    getMethodRepairContext: forbidden('repair-context'),
    startMethodGenerationStream: forbidden('start-generation'),
    recoverMethodGenerationStream: forbidden('recover-generation'),
    prepareRagRepair: forbidden('prepare-rag-repair'),
    releaseRagTaskRun: forbidden('release-rag-run'),
    resumeMethodGenerationStream: forbidden('resume-generation'),
    acknowledgeMethodGenerationEvents: forbidden('ack-generation'),
    cancelMethodGeneration: forbidden('cancel-generation'),
    generateUnitTestPrompt: forbidden('generation-prompt')
  };
  const shellService = {
    async validateBuildSettings() {
      throw new Error('persisted build validation must be reused');
    },
    async runMavenCompile() {
      return {
        command: 'fake-mvn compile',
        cwd: moduleRoot,
        exitCode: 0,
        stdout: '',
        stderr: ''
      };
    },
    runMavenModuleTestsWithJacoco: forbidden('module-tests'),
    runMavenDirectTestsWithJacoco: forbidden('direct-tests'),
    runMavenGeneratedTestCompile: forbidden('generated-compile'),
    runMavenGeneratedSurefireTest: forbidden('generated-test'),
    runMavenDirectTestsWithJacocoAppend: forbidden('coverage-append')
  };
  const runtime = createProductionClassTaskRuntime({
    storageDirectory: join(root, 'state'),
    analysisResponseTimeoutRetryInitialDelayMilliseconds: 1,
    analysisResponseTimeoutRetryMaxDelayMilliseconds: 1,
    aiClient,
    shellService,
    mavenAnalysisContextService: {
      async collect(input) {
        return {
          workspaceRoot: input.workspaceRoot,
          moduleRoot: input.moduleRoot,
          targetSourcePath: input.targetSourcePath,
          targetClass: input.targetClass,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath,
          reportPath: input.reportPath,
          branchSnapshotPath: input.branchSnapshotPath,
          reportPairId: input.reportPairId,
          sourceRoots: [sourceDirectory],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: 'd'.repeat(64),
          warnings: []
        };
      }
    },
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: restoredPackerJacocoArtifacts(reportPairId),
    surefireReportService: {},
    buildSettingsService: {
      async get() {
        return {
          mavenHome: 'C:\\fixture-maven',
          javaHome: 'C:\\fixture-jdk',
          settingsPath: null,
          localRepository: null,
          validation: {
            valid: true,
            command: 'fake-mvn --version',
            mavenVersion: '3.9.16',
            javaVersion: '21.0.8',
            javaRuntime: 'fixture-jdk',
            checkedAt: '2026-08-19T00:00:00.000Z'
          }
        };
      }
    },
    modelInterfacesService: {
      async getView() {
        return { schemaVersion: 2, activeInterfaceId: null, interfaces: [], secureStorageAvailable: true };
      },
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast() {}
  });
  t.after(async () => {
    const [shutdown] = await Promise.allSettled([runtime.beforeQuit()]);
    await rm(root, { recursive: true, force: true });
    if (shutdown.status === 'rejected') throw shutdown.reason;
  });

  await runtime.startup();
  const [first] = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: [firstSourcePath]
  });
  await runtime.flush();
  const firstCreates = events.filter((event) => event.startsWith('create:example.One:'));
  assert.equal(createAttempts.get('example.One'), 2);
  assert.equal(firstCreates.length, 2);
  assert.equal(new Set(firstCreates.map((event) => event.split(':').at(-1))).size, 2);
  const cancelledSessionId = firstCreates[0].split(':').at(-1);
  const firstSessionId = firstCreates[1].split(':').at(-1);
  assert.ok(events.indexOf(`delete:${cancelledSessionId}`) >= 0);
  assert.ok(
    events.indexOf(`delete:${cancelledSessionId}`) < events.indexOf(firstCreates[1]),
    'the cancelled session must be released before its replacement is created'
  );
  assert.equal((await runtime.listClassTasks({ workspaceRoot }))[0].state, 'READY');

  const [second] = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: [secondSourcePath]
  });
  await runtime.flush();

  const tasks = await runtime.listClassTasks({ workspaceRoot });
  assert.deepEqual(tasks.map((entry) => entry.state), ['READY', 'READY']);
  assert.equal(createAttempts.get('example.Two'), 2);
  const firstDeleteIndex = events.indexOf(`delete:${firstSessionId}`);
  const secondSuccessfulCreateIndex = events.findLastIndex(
    (event) => event.startsWith('create:example.Two:')
  );
  assert.ok(firstDeleteIndex >= 0, `inactive task ${first.id} did not release its Analyzer session`);
  assert.ok(firstDeleteIndex < secondSuccessfulCreateIndex);

  const secondSessionId = events[secondSuccessfulCreateIndex].split(':').at(-1);
  await runtime.removeClassTask({ workspaceRoot, taskId: second.id });
  assert.ok(events.includes(`delete:${secondSessionId}`));
});

test('same-module classes run independent targeted Maven commands and report their own failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-shared-preload-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePaths = ['One.java', 'Two.java']
    .map((fileName) => join(sourceDirectory, fileName));
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await Promise.all(sourceFilePaths.map((sourceFilePath) => writeFile(
    sourceFilePath,
    `package example; public class ${sourceFilePath.split(/[\\/]/).at(-1).replace(/\.java$/, '')} {}`,
    'utf8'
  )));
  await Promise.all(['One', 'Two'].map((className) => writeFile(
    join(testDirectory, `${className}Test.java`),
    `package example; public class ${className}Test { ${className} target; }`,
    'utf8'
  )));

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven
  }));
  t.after(() => runtime.beforeQuit());
  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: sourceFilePaths });
  await maven.directStarted;

  maven.finish({
    command: 'fake-mvn -Dtest=example.OneTest',
    cwd: moduleRoot,
    exitCode: 1,
    stdout: '[ERROR] first generated test failed\n[ERROR] second generated test failed',
    stderr: ''
  });
  await waitForMavenCalls(maven, 2);
  maven.finish({
    command: 'fake-mvn -Dtest=example.TwoTest',
    cwd: moduleRoot,
    exitCode: 1,
    stdout: '[ERROR] second direct test failed',
    stderr: ''
  });
  await runtime.flush();

  const tasks = await runtime.listClassTasks({ workspaceRoot });
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((task) => task.state),
    ['PRELOAD_FAILED', 'PRELOAD_FAILED'],
    JSON.stringify(tasks, null, 2)
  );
  assert.deepEqual(tasks.map((task) => task.preloadState), ['FAILED', 'FAILED']);
  assert.deepEqual(
    tasks.map((task) => task.lastError?.code),
    ['CLASS_PRELOAD_MAVEN_FAILED', 'CLASS_PRELOAD_MAVEN_FAILED']
  );
  assert.equal(maven.moduleCallCount, 0);
  assert.equal(maven.directCallCount, 2);
});

test('same-module Maven cannot replace analyzer inputs between context collection and initial refresh', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-analyzer-input-lock-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const firstSourcePath = join(sourceDirectory, 'One.java');
  const secondSourcePath = join(sourceDirectory, 'Two.java');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(firstSourcePath, 'package example; public class One { public void run() {} }', 'utf8');
  await writeFile(secondSourcePath, 'package example; public class Two { public void run() {} }', 'utf8');
  await writeFile(
    join(testDirectory, 'OneTest.java'),
    'package example; public class OneTest { One target; }',
    'utf8'
  );
  await writeFile(
    join(testDirectory, 'TwoTest.java'),
    'package example; public class TwoTest { Two target; }',
    'utf8'
  );

  const firstAnalyzerCreateStarted = runtimeDeferred();
  const releaseFirstAnalyzerCreate = runtimeDeferred();
  let analyzerCreateCount = 0;
  const coverage = {
    lineCovered: 0,
    lineMissed: 1,
    lineTotal: 1,
    branchCovered: 0,
    branchMissed: 0,
    branchTotal: 0
  };
  const catalog = (sessionId, reportPairId) => ({
    analysisSessionId: sessionId,
    reportPairId,
    methods: [{
      methodId: 'method-id',
      methodName: 'run',
      descriptor: '()V',
      displaySignature: 'public void run()',
      firstLine: 1,
      lastLine: 1,
      jacocoOrder: 0,
      lineCovered: 0,
      lineMissed: 1,
      branchCovered: 0,
      branchMissed: 0,
      instructionCovered: 0,
      instructionMissed: 1,
      complexityCovered: 0,
      complexityMissed: 1,
      coverageGap: true,
      generatable: true,
      unavailableReason: null,
      modifiers: ['public']
    }],
    warnings: []
  });
  const forbidden = (name) => async () => {
    throw new Error(`${name} must not run during class preload`);
  };
  const aiClient = {
    async generateTargetJacocoReport(request) {
      return {
        generated: true,
        reportPath: request.outputPath,
        branchSnapshotPath: request.branchSnapshotOutputPath,
        pairId: createHash('sha256').update(request.targetClass, 'utf8').digest('hex'),
        targetClass: request.targetClass,
        generatedAt: '2026-09-18T00:00:00.000Z',
        message: 'generated'
      };
    },
    async createMethodAnalysisSession(request) {
      analyzerCreateCount += 1;
      if (analyzerCreateCount === 1) {
        firstAnalyzerCreateStarted.resolve();
        await releaseFirstAnalyzerCreate.promise;
      }
      return {
        analysisSessionId: request.analysisSessionId,
        reportPairId: request.reportPairId,
        sourceSha256: 'b'.repeat(64),
        dependencyContextSha256: 'c'.repeat(64),
        packageName: 'example',
        testClassName: `${request.targetClass.split('.').at(-1)}Tmp1Test`,
        suggestedRelativeTestPath: 'src/test/java/example/Tmp1Test.java',
        warnings: []
      };
    },
    async refreshMethodAnalysisCoverage(sessionId, request) {
      return {
        reportPairId: request.reportPairId,
        coverage,
        catalog: catalog(sessionId, request.reportPairId)
      };
    },
    async heartbeatMethodAnalysisSession() { return true; },
    async deleteMethodAnalysisSession() {},
    probeModelToolCalling: forbidden('probe-model'),
    classifyUnitTestTarget: forbidden('classify-target'),
    nextMethodBatch: forbidden('next-method-batch'),
    getMethodRepairContext: forbidden('repair-context'),
    startMethodGenerationStream: forbidden('start-generation'),
    recoverMethodGenerationStream: forbidden('recover-generation'),
    prepareRagRepair: forbidden('prepare-rag-repair'),
    releaseRagTaskRun: forbidden('release-rag-run'),
    resumeMethodGenerationStream: forbidden('resume-generation'),
    acknowledgeMethodGenerationEvents: forbidden('ack-generation'),
    cancelMethodGeneration: forbidden('cancel-generation'),
    generateUnitTestPrompt: forbidden('generation-prompt')
  };
  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime({
    storageDirectory: join(root, 'state'),
    aiClient,
    shellService: maven.shellService,
    mavenAnalysisContextService: {
      async collect(input) {
        return {
          workspaceRoot: input.workspaceRoot,
          moduleRoot: input.moduleRoot,
          targetSourcePath: input.targetSourcePath,
          targetClass: input.targetClass,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath,
          reportPath: input.reportPath,
          branchSnapshotPath: input.branchSnapshotPath,
          reportPairId: input.reportPairId,
          sourceRoots: [sourceDirectory],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: 'd'.repeat(64),
          warnings: []
        };
      }
    },
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: restoredPackerJacocoArtifacts('a'.repeat(64)),
    surefireReportService: {},
    buildSettingsService: {
      async get() {
        return {
          mavenHome: 'C:\\fixture-maven',
          javaHome: 'C:\\fixture-jdk',
          settingsPath: null,
          localRepository: null,
          validation: {
            valid: true,
            command: 'fake-mvn --version',
            mavenVersion: '3.9.16',
            javaVersion: '21.0.8',
            javaRuntime: 'fixture-jdk',
            checkedAt: '2026-09-18T00:00:00.000Z'
          }
        };
      }
    },
    modelInterfacesService: {
      async getView() {
        return { schemaVersion: 2, activeInterfaceId: null, interfaces: [], secureStorageAvailable: true };
      },
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast() {},
    idFactory: sequentialUuidFactory()
  });
  t.after(async () => {
    releaseFirstAnalyzerCreate.resolve();
    await Promise.allSettled([runtime.beforeQuit()]);
    await rm(root, { recursive: true, force: true });
  });

  await runtime.startup();
  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [firstSourcePath] });
  await maven.directStarted;
  maven.finish(successfulCommand('fake-mvn -Dtest=example.OneTest', moduleRoot));
  await firstAnalyzerCreateStarted.promise;

  await runtime.addClassTasks({ workspaceRoot, classFilePaths: [secondSourcePath] });
  for (let attempt = 0; attempt < 5_000 && maven.directCallCount < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    maven.directCallCount,
    1,
    'same-module Maven replaced target/classes before the Analyzer initial refresh finished'
  );

  releaseFirstAnalyzerCreate.resolve();
  await waitForMavenCalls(maven, 2);
  maven.finish(successfulCommand('fake-mvn -Dtest=example.TwoTest', moduleRoot));
  await runtime.flush();

  const tasks = await runtime.listClassTasks({ workspaceRoot });
  assert.deepEqual(tasks.map((task) => task.state), ['READY', 'READY']);
});

test('cancelling a method-catalog waiter does not stop the shared class Maven preparation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-detached-preload-waiter-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Only.java');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Only {}', 'utf8');
  await writeFile(
    join(testDirectory, 'OnlyTest.java'),
    'package example; public class OnlyTest { Only target; }',
    'utf8'
  );

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven
  }));
  t.after(async () => {
    await runtime.beforeQuit();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.startup();
  const [added] = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: [sourceFilePath]
  });
  await maven.directStarted;

  const waiterController = new AbortController();
  const waitingForCatalog = runtime.coordinator.prepare(
    added.id,
    waiterController.signal
  );
  waiterController.abort(new Error('method-catalog waiter closed'));
  await assert.rejects(waitingForCatalog, /method-catalog waiter closed/);

  assert.equal(
    maven.abortCount,
    0,
    'a detached UI waiter must not own the shared Maven preparation'
  );
  maven.finish({
    command: 'fake-mvn -Dtest=example.OnlyTest',
    cwd: moduleRoot,
    exitCode: 1,
    stdout: '[ERROR] controlled Maven failure',
    stderr: ''
  });
  await runtime.flush();

  const [finished] = await runtime.listClassTasks({ workspaceRoot });
  assert.equal(finished.state, 'PRELOAD_FAILED', finished.lastError?.message);
  assert.equal(finished.lastError?.code, 'CLASS_PRELOAD_MAVEN_FAILED');
  assert.equal(maven.abortCount, 0);
});

test('removing one active class cancels only its targeted Maven command and preserves its sibling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-remove-preloading-sibling-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePaths = ['One.java', 'Two.java']
    .map((fileName) => join(sourceDirectory, fileName));
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await Promise.all(sourceFilePaths.map((sourceFilePath) => writeFile(
    sourceFilePath,
    `package example; public class ${sourceFilePath.split(/[\\/]/).at(-1).replace(/\.java$/, '')} {}`,
    'utf8'
  )));
  await Promise.all(['One', 'Two'].map((className) => writeFile(
    join(testDirectory, `${className}Test.java`),
    `package example; public class ${className}Test { ${className} target; }`,
    'utf8'
  )));

  const maven = controlledPreloadMaven();
  const broadcasts = [];
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven,
    broadcast(snapshot) {
      broadcasts.push(structuredClone(snapshot));
    }
  }));
  t.after(() => runtime.beforeQuit());
  await runtime.startup();
  const added = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: sourceFilePaths
  });
  await maven.directStarted;
  const activeTestClassName = maven.directTestCalls[0]?.[0];
  const removed = added.find((task) => `${task.qualifiedClassName}Test` === activeTestClassName);
  const sibling = added.find((task) => task.id !== removed?.id);
  assert.ok(removed, `No task matched active Maven test class ${activeTestClassName}.`);
  assert.ok(sibling, 'The active Maven task must have one sibling.');
  const removing = runtime.removeClassTask({
    workspaceRoot,
    taskId: removed.id
  });
  const earlyOutcome = await observeSettlement(removing);
  await waitForMavenCalls(maven, 2);
  maven.finish({
    command: `fake-mvn -Dtest=${sibling.qualifiedClassName}Test`,
    cwd: moduleRoot,
    exitCode: 1,
    stdout: '[ERROR] direct test failed',
    stderr: ''
  });
  await removing;
  await runtime.flush();

  assert.equal(earlyOutcome.status, 'fulfilled');
  assert.equal(maven.abortCount, 1);
  assert.equal(maven.moduleCallCount, 0);
  const remaining = await runtime.listClassTasks({ workspaceRoot });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, sibling.id);
  assert.equal(remaining[0].state, 'PRELOAD_FAILED');
  assert.equal(remaining[0].lastError?.code, 'CLASS_PRELOAD_MAVEN_FAILED');
  assert.equal(
    broadcasts.some((entry) => entry.id === sibling.id && entry.state === 'PRELOAD_FAILED'),
    true
  );
});

test('removing the last active card stops its class-targeted Maven command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-remove-last-preloading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Only.java');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Only {}', 'utf8');
  await writeFile(
    join(testDirectory, 'OnlyTest.java'),
    'package example; public class OnlyTest { Only target; }',
    'utf8'
  );

  const maven = controlledPreloadMaven();
  const runtime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory: join(root, 'state'),
    maven
  }));
  t.after(() => runtime.beforeQuit());
  await runtime.startup();
  const [only] = await runtime.addClassTasks({
    workspaceRoot,
    classFilePaths: [sourceFilePath]
  });
  await maven.directStarted;

  const removing = runtime.removeClassTask({ workspaceRoot, taskId: only.id });
  const earlyOutcome = await observeSettlement(removing);
  if (earlyOutcome.status === 'pending') {
    maven.finish({
      command: 'fake-mvn preload-with-jacoco',
      cwd: moduleRoot,
      exitCode: 0,
      stdout: '',
      stderr: ''
    });
  }
  await removing;

  assert.equal(earlyOutcome.status, 'fulfilled');
  assert.equal(maven.abortCount, 1);
  assert.deepEqual(await runtime.listClassTasks({ workspaceRoot }), []);
});

test('a manually stopped class preload resumes its targeted Maven command after reopening', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-manual-stop-preload-'));
  let firstRuntime;
  let secondRuntime;
  t.after(async () => {
    const shutdowns = await Promise.allSettled([
      firstRuntime?.beforeQuit() ?? Promise.resolve(),
      secondRuntime?.beforeQuit() ?? Promise.resolve()
    ]);
    await rm(root, { recursive: true, force: true });
    const failures = shutdowns.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime cleanup failed.');
  });
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Only.java');
  const storageDirectory = join(root, 'state');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Only {}', 'utf8');
  await writeFile(
    join(testDirectory, 'OnlyTest.java'),
    'package example; public class OnlyTest { Only target; }',
    'utf8'
  );

  const firstMaven = controlledPreloadMaven();
  firstRuntime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory,
    maven: firstMaven
  }));
  await firstRuntime.startup();
  const [added] = await firstRuntime.addClassTasks({
    workspaceRoot,
    classFilePaths: [sourceFilePath]
  });
  await firstMaven.directStarted;
  await firstRuntime.stopModulePreload({ workspaceRoot, taskId: added.id });

  const [stopped] = await firstRuntime.listClassTasks({ workspaceRoot });
  assert.equal(firstMaven.abortCount, 1);
  assert.equal(stopped.state, 'PRELOADING');
  assert.equal(stopped.preloadState, 'IDLE');
  assert.equal(stopped.currentAtomicStep, 'IDLE');
  assert.equal(stopped.lastError, null);

  await firstRuntime.beforeQuit();
  const secondMaven = controlledPreloadMaven();
  secondRuntime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory,
    maven: secondMaven
  }));
  const [restored] = await secondRuntime.startup();
  assert.equal(restored.state, 'PRELOADING');
  assert.equal(restored.preloadState, 'IDLE');

  const resumed = await Promise.race([
    secondMaven.directStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000))
  ]);
  assert.equal(resumed, true);
  assert.equal(secondMaven.moduleCallCount, 0);
  const [runningAgain] = await secondRuntime.listClassTasks({ workspaceRoot });
  assert.equal(runningAgain.state, 'PRELOADING');
  assert.equal(runningAgain.preloadState, 'RUNNING');
});

test('reopening after an interrupted preload automatically starts Maven again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-resume-preload-'));
  let firstRuntime;
  let secondRuntime;
  t.after(async () => {
    const shutdowns = await Promise.allSettled([
      firstRuntime?.beforeQuit() ?? Promise.resolve(),
      secondRuntime?.beforeQuit() ?? Promise.resolve()
    ]);
    await rm(root, { recursive: true, force: true });
    const failures = shutdowns.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime cleanup failed.');
  });
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Only.java');
  const storageDirectory = join(root, 'state');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Only {}', 'utf8');
  await writeFile(
    join(testDirectory, 'OnlyTest.java'),
    'package example; public class OnlyTest { Only target; }',
    'utf8'
  );

  const firstMaven = controlledPreloadMaven();
  firstRuntime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory,
    maven: firstMaven
  }));
  await firstRuntime.startup();
  await firstRuntime.addClassTasks({ workspaceRoot, classFilePaths: [sourceFilePath] });
  await firstMaven.directStarted;
  await firstRuntime.beforeQuit();

  const secondMaven = controlledPreloadMaven();
  secondRuntime = createProductionClassTaskRuntime(productionPreloadOptions({
    storageDirectory,
    maven: secondMaven
  }));
  const [restored] = await secondRuntime.startup();
  assert.equal(restored.state, 'PRELOADING');
  assert.equal(restored.preloadState, 'IDLE');

  const resumed = await Promise.race([
    secondMaven.directStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000))
  ]);
  assert.equal(resumed, true);
  const [runningAgain] = await secondRuntime.listClassTasks({ workspaceRoot });
  assert.equal(runningAgain.state, 'PRELOADING');
  assert.equal(runningAgain.preloadState, 'RUNNING');
  assert.equal(secondMaven.moduleCallCount, 0);
});

async function observeSettlement(promise) {
  let outcome = { status: 'pending' };
  void promise.then(
    () => { outcome = { status: 'fulfilled' }; },
    (reason) => { outcome = { status: 'rejected', reason }; }
  );
  for (let attempt = 0; attempt < 5_000 && outcome.status === 'pending'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return outcome;
}

async function waitForMavenCalls(maven, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (maven.directCallCount >= expected) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${expected} targeted Maven calls, got ${maven.directCallCount}.`);
}
async function completedResultFileFixture(
  t,
  resultState = 'COMPLETED',
  { includeAcceptedArtifact = false } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-result-file-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const testDirectory = join(moduleRoot, 'src', 'test', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const testFilePath = join(testDirectory, 'Task1Test.java');
  const acceptedTestFilePath = join(testDirectory, 'Task0Test.java');
  const storageDirectory = join(root, 'state');
  const testFileContent = 'package example; public class Task1Test {}';
  const acceptedTestFileContent = 'package example; public class Task0Test {}';
  const artifact = {
    id: 'artifact-1',
    filePath: testFilePath,
    testClassName: 'Task1Test',
    ordinaryTestMethodCount: 1,
    methodIds: ['method-id'],
    methodResults: [{
      methodId: 'method-id',
      methodName: 'method',
      displaySignature: 'method()',
      jacocoOrder: 0,
      ordinaryTestMethodCount: 1
    }],
    sha256: createHash('sha256').update(testFileContent).digest('hex'),
    sealed: true,
    accepted: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:01:00.000Z'
  };
  const acceptedArtifact = {
    ...artifact,
    id: 'accepted-artifact-1',
    filePath: acceptedTestFilePath,
    testClassName: 'Task0Test',
    methodIds: ['accepted-method-id'],
    methodResults: [{
      methodId: 'accepted-method-id',
      methodName: 'acceptedMethod',
      displaySignature: 'acceptedMethod()',
      jacocoOrder: 0,
      ordinaryTestMethodCount: 1
    }],
    sha256: createHash('sha256').update(acceptedTestFileContent).digest('hex'),
    accepted: true,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:01:00.000Z'
  };
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(sourceFilePath, 'package example; public class Task {}', 'utf8');
  await writeFile(testFilePath, testFileContent, 'utf8');
  if (includeAcceptedArtifact) {
    await writeFile(acceptedTestFilePath, acceptedTestFileContent, 'utf8');
  }
  await writeFile(join(storageDirectory, 'class-tasks-v2.json'), JSON.stringify({
    version: 3,
    tasks: {
      [TASK_ID]: task(TASK_ID, resultState, {
        workspaceRoot,
        sourceFilePath,
        qualifiedClassName: 'example.Task',
        moduleKey: `${moduleRoot.replaceAll('\\', '/').toLowerCase()}/pom.xml`,
        moduleDisplayPath: moduleRoot,
        generatedArtifacts: includeAcceptedArtifact
          ? [acceptedArtifact, artifact]
          : [artifact],
        coverageBaseline: {
          lineCovered: 0, lineMissed: 1, lineTotal: 1,
          branchCovered: 0, branchMissed: 0, branchTotal: 0
        },
        coverageCurrent: {
          lineCovered: 1, lineMissed: 0, lineTotal: 1,
          branchCovered: 0, branchMissed: 0, branchTotal: 0
        },
        coverageContributions: [{
          artifactId: artifact.id,
          filePath: testFilePath,
          addedLineCount: 1,
          lineTotal: 1,
          addedBranchCount: 0,
          branchTotal: 0
        }],
        startedAt: '2026-08-09T00:00:00.000Z',
        finishedAt: '2026-08-09T00:01:00.000Z'
      })
    }
  }), 'utf8');

  const externalCalls = [];
  const forbidden = (name) => async () => {
    externalCalls.push(name);
    throw new Error(`${name} must not run while reading or rejecting a missing result file`);
  };
  const runtime = createProductionClassTaskRuntime({
    storageDirectory,
    aiClient: new Proxy({}, { get: (_target, key) => forbidden(`ai:${String(key)}`) }),
    shellService: new Proxy({}, { get: (_target, key) => forbidden(`shell:${String(key)}`) }),
    mavenAnalysisContextService: { collect: forbidden('analysis-context') },
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: {},
    surefireReportService: {},
    buildSettingsService: { get: forbidden('build-settings') },
    modelInterfacesService: {
      getView: forbidden('model-view'),
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast() {}
  });
  await runtime.startup();
  t.after(async () => {
    const [shutdown] = await Promise.allSettled([runtime.beforeQuit()]);
    await rm(root, { recursive: true, force: true });
    if (shutdown.status === 'rejected') throw shutdown.reason;
  });
  return {
    runtime,
    workspaceRoot,
    testFilePath,
    testFileContent,
    artifact,
    acceptedTestFilePath,
    acceptedTestFileContent,
    acceptedArtifact,
    externalCalls
  };
}

async function productionWaveRuntimeHarness(t, {
  failFormalPublication = false,
  failCoverageRefreshAfterFormalOnce = false,
  failHeartbeatOnceWithCancelledSession = false,
  failHeartbeatOnceWithResponseTimeout = false,
  failClassWaveOnceWithBusySession = false,
  failClassWaveOnceWithInvalidResponse = false,
  failClassWaveOnceWithMissingSession = false,
  failWaveOnceAfterSucceededPart = false,
  candidateUsage = null,
  markMethodCoveredAfterRefresh = false,
  trackCoverageFromMaven = false,
  analysisSessionHeartbeatIntervalMilliseconds,
  analysisResponseTimeoutRetryInitialDelayMilliseconds,
  analysisResponseTimeoutRetryMaxDelayMilliseconds,
  broadcast = () => undefined
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'class-task-runtime-production-wave-'));
  const workspaceRoot = join(root, 'workspace');
  const moduleRoot = join(workspaceRoot, 'module-a');
  const sourceDirectory = join(moduleRoot, 'src', 'main', 'java', 'example');
  const sourceFilePath = join(sourceDirectory, 'Task.java');
  const storageDirectory = join(root, 'state');
  const methodId = 'a'.repeat(64);
  const reportPairId = 'b'.repeat(64);
  let currentReportPairId = reportPairId;
  const waveBatchId = 'c'.repeat(64);
  const partBatchId = 'd'.repeat(64);
  const scenarioId = 'scenario-1';
  const tmpFilePath = join(moduleRoot, 'src', 'test', 'java', 'example', 'TaskTmp1Test.java');
  const formalFilePath = join(moduleRoot, 'src', 'test', 'java', 'example', 'Task1Test.java');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(
    sourceFilePath,
    'package example; public class Task { public void run() {} }',
    'utf8'
  );
  await writeFile(join(storageDirectory, 'class-tasks-v2.json'), JSON.stringify({
    version: 3,
    tasks: {
      [TASK_ID]: task(TASK_ID, 'READY', {
        workspaceRoot,
        sourceFilePath,
        moduleKey: `${moduleRoot.replaceAll('\\', '/').toLowerCase()}/pom.xml`,
        moduleDisplayPath: moduleRoot,
        selectedMethodIds: [methodId],
        methodOrder: [methodId],
        repairAttemptLimit: 5,
        unlimitedRepair: false
      })
    }
  }), 'utf8');

  const waveStarted = runtimeDeferred();
  const releaseWave = runtimeDeferred();
  const tmpDeleteStarted = runtimeDeferred();
  const releaseTmpDelete = runtimeDeferred();
  const analyzerCalls = [];
  const waveStreamCalls = [];
  const waveModelNames = [];
  let heartbeatCallCount = 0;
  let analyzerHealthCheckCount = 0;
  let cancelledHeartbeatCount = 0;
  let analysisSessionCreationCount = 0;
  let pendingCancelledHeartbeat = failHeartbeatOnceWithCancelledSession;
  let pendingResponseTimeoutHeartbeat = failHeartbeatOnceWithResponseTimeout;
  let pendingClassWaveBusySession = failClassWaveOnceWithBusySession;
  let pendingClassWaveInvalidResponse = failClassWaveOnceWithInvalidResponse;
  let pendingClassWaveMissingSession = failClassWaveOnceWithMissingSession;
  let pendingWaveFailure = failWaveOnceAfterSucceededPart;
  let waveHasStarted = false;
  let pendingCoverageRefreshFailure = failCoverageRefreshAfterFormalOnce;
  let methodCovered = false;
  let mavenCoverageCovered = false;
  const coverage = () => ({
    lineCovered: trackCoverageFromMaven && mavenCoverageCovered ? 1 : 0,
    lineMissed: trackCoverageFromMaven && mavenCoverageCovered ? 0 : 1,
    lineTotal: 1,
    branchCovered: 0,
    branchMissed: 0,
    branchTotal: 0
  });
  let analysisSessionId = null;
  const methodCatalog = () => ({
    analysisSessionId,
    reportPairId: currentReportPairId,
    methods: [{
      methodId,
      methodName: 'run',
      descriptor: '()V',
      displaySignature: 'run()',
      firstLine: 1,
      lastLine: 1,
      jacocoOrder: 0,
      lineCovered: methodCovered ? 1 : 0,
      lineMissed: methodCovered ? 0 : 1,
      branchCovered: 0,
      branchMissed: 0,
      instructionCovered: methodCovered ? 1 : 0,
      instructionMissed: methodCovered ? 0 : 1,
      complexityCovered: methodCovered ? 1 : 0,
      complexityMissed: methodCovered ? 0 : 1,
      coverageGap: !methodCovered,
      generatable: true,
      unavailableReason: null,
      modifiers: ['public']
    }],
    warnings: []
  });
  const currentScenario = {
    scenarioId,
    scenarioSignature: 'run-path-1',
    methodId,
    targetLines: [1],
    targetBranches: [],
    chineseDescription: '直接调用 run',
    inputPreparation: [],
    requiredStubIds: [],
    expectedPath: [],
    loopExitCondition: '',
    loopCoveragePlan: null,
    coverageTargetIds: ['target-1'],
    pathConstraints: [],
    status: 'COMPLETE'
  };
  const wave = {
    waveBatchId,
    reportPairId,
    methodId,
    hasWork: true,
    selectedScenarioIds: [scenarioId],
    remainingScenarioCount: 0,
    parts: [{
      partIndex: 1,
      partBatchId,
      scenarioIds: [scenarioId],
      method: {
        methodId,
        declaringType: 'example.Task',
        methodName: 'run',
        descriptor: '()V',
        firstLine: 1,
        lastLine: 1,
        completeMethodSource: 'public void run() {}',
        modifiers: ['public'],
        parameterTypes: [],
        returnType: 'void',
        declaredExceptions: [],
        invocationPlan: {
          strategy: 'DIRECT',
          receiverExpression: 'target',
          reflectionMethodName: '',
          parameterClassLiterals: [],
          staticMethod: false,
          returnType: 'void',
          declaredExceptions: [],
          chineseInstruction: '直接调用'
        },
        activeScenarioIds: [scenarioId]
      },
      scenarios: [currentScenario],
      methodTestPlan: {
        methodId,
        analysisStatus: 'COMPLETE',
        minimumTestCount: 1,
        remainingTargets: [{
          targetId: 'target-1',
          methodId,
          decisionId: 'decision-1',
          instructionIndex: 0,
          sourceLine: 1,
          kind: 'LINE',
          direction: 'ENTER',
          covered: false,
          mappingStatus: 'MAPPED',
          requiredEdgeIds: []
        }],
        testPathGroups: [{
          groupId: 'group-1',
          methodId,
          ordinal: 1,
          scenarioIds: [scenarioId],
          targetIds: ['target-1'],
          constraints: [],
          inputRequirements: [],
          mockRequirements: [],
          expectedExit: 'RETURNS',
          singleTargetInvocation: true,
          status: 'COMPLETE'
        }],
        testMethodPlans: [{
          testMethodPlanId: 'plan-1',
          methodId,
          ordinal: 1,
          pathGroupIds: ['group-1'],
          status: 'COMPLETE'
        }],
        fallbackReason: ''
      },
      methodStubInventory: {
        methodId,
        status: 'COMPLETE',
        requiredCallCount: 0,
        unresolvedRequiredCallCount: 0,
        calls: []
      },
      activeStubPlans: [],
      targetFixturePlan: {
        targetClass: 'example.Task',
        targetVariableName: 'target',
        targetClassDeclaration: 'private Task target;',
        dependencySourceDeclarations: [],
        constructionMode: 'CONSTRUCTOR',
        constructorParameterTypes: [],
        constructorArgumentFixtureIds: [],
        dependencies: [],
        setupStatements: ['target = new Task();'],
        status: 'COMPLETE',
        chineseInstruction: '创建测试对象'
      },
      referencedTypes: [],
      necessaryImports: ['org.junit.jupiter.api.Test']
    }],
    warnings: []
  };
  const classWave = {
    waveBatchId,
    reportPairId,
    methodId,
    remainingScenarioCount: 0,
    hasWork: true,
    selectedMethodIds: [methodId],
    selectedScenarioIds: [scenarioId],
    remainingScenarioCountByMethod: { [methodId]: 0 },
    completedMethodIds: [methodId],
    parts: wave.parts.map((part) => ({
      ...structuredClone(part),
      methodSlices: [{
        methodId,
        testMethodNamePrefix: 'm1_',
        batch: structuredClone(part)
      }]
    })),
    warnings: []
  };

  const waveSessionId = '44444444-4444-4444-8444-444444444444';
  const childSessionId = '55555555-5555-4555-8555-555555555555';
  const candidateId = '66666666-6666-4666-8666-666666666666';
  const occurredAt = '2026-08-19T00:00:00.000Z';
  const event = (eventSequence, eventType, changes = {}) => ({
    waveSessionId,
    eventSequence,
    waveId: waveBatchId,
    methodId,
    waveIndex: 1,
    eventType,
    occurredAt,
    partIndex: null,
    partBatchId: null,
    scenarioIds: [],
    childSessionId: null,
    candidateId: null,
    childEvent: null,
    partResult: null,
    completion: null,
    error: null,
    ...changes
  });
  let activeModelName = 'fixture';
  let waveRecoveryCallCount = 0;
  const aiClient = {
    async generateTargetJacocoReport(request) {
      return {
        generated: true,
        reportPath: request.outputPath,
        branchSnapshotPath: request.branchSnapshotOutputPath,
        pairId: currentReportPairId,
        targetClass: request.targetClass,
        generatedAt: occurredAt,
        message: 'generated'
      };
    },
    async createMethodAnalysisSession(request) {
      analysisSessionCreationCount += 1;
      analysisSessionId = request.analysisSessionId;
      return {
        analysisSessionId,
        reportPairId: currentReportPairId,
        sourceSha256: 'e'.repeat(64),
        dependencyContextSha256: 'f'.repeat(64),
        packageName: 'example',
        testClassName: 'TaskTmp1Test',
        suggestedRelativeTestPath:
          'module-a/src/test/java/example/TaskTmp1Test.java',
        warnings: []
      };
    },
    async refreshMethodAnalysisCoverage() {
      if (pendingCoverageRefreshFailure) {
        try {
          await access(formalFilePath);
          pendingCoverageRefreshFailure = false;
          throw new Error('ANALYSIS_SESSION_NOT_FOUND: analysis session expired');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (markMethodCoveredAfterRefresh) {
        try {
          await access(formalFilePath);
          methodCovered = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (trackCoverageFromMaven) methodCovered = mavenCoverageCovered;
      return {
        reportPairId: currentReportPairId,
        coverage: coverage(),
        catalog: methodCatalog()
      };
    },
    async heartbeatMethodAnalysisSession() {
      heartbeatCallCount += 1;
      if (pendingResponseTimeoutHeartbeat && waveHasStarted) {
        pendingResponseTimeoutHeartbeat = false;
        throw Object.assign(new Error('Java Analyzer 响应等待时间过长，请稍后重试。'), {
          name: 'BackendResponseTimeoutError',
          code: 'BACKEND_RESPONSE_TIMEOUT',
          backendName: 'Java Analyzer'
        });
      }
      if (pendingCancelledHeartbeat && waveHasStarted) {
        pendingCancelledHeartbeat = false;
        cancelledHeartbeatCount += 1;
        throw new MethodAnalysisRequestError(
          'ANALYSIS_SESSION_CANCELLED',
          '检查单方法分析会话失败（ANALYSIS_SESSION_CANCELLED）：分析会话已经取消。'
        );
      }
      return true;
    },
    async isJavaAnalyzerHealthy() {
      analyzerHealthCheckCount += 1;
      return true;
    },
    async deleteMethodAnalysisSession() {},
    async nextMethodBatch() {
      analyzerCalls.push({ kind: 'legacy' });
      throw new Error('The production Runner must not use nextMethodBatch.');
    },
    async nextMethodWave(_sessionId, actualMethodId, request) {
      assert.equal(actualMethodId, methodId);
      analyzerCalls.push({ kind: 'wave', request: structuredClone(request) });
      return structuredClone(wave);
    },
    async nextClassScenarioWave(sessionId, request) {
      analyzerCalls.push({ kind: 'wave', sessionId, request: structuredClone(request) });
      if (pendingClassWaveMissingSession) {
        pendingClassWaveMissingSession = false;
        throw new MethodAnalysisRequestError(
          'ANALYSIS_SESSION_NOT_FOUND',
          '读取类级场景 Wave 失败（ANALYSIS_SESSION_NOT_FOUND）：分析会话不存在。'
        );
      }
      if (pendingClassWaveBusySession) {
        pendingClassWaveBusySession = false;
        throw new MethodAnalysisRequestError(
          'ANALYSIS_SESSION_BUSY',
          '读取类级场景 Wave 失败（ANALYSIS_SESSION_BUSY）：分析会话正在处理另一个请求。'
        );
      }
      if (pendingClassWaveInvalidResponse) {
        pendingClassWaveInvalidResponse = false;
        throw new MethodAnalysisResponseInvalidError();
      }
      const methodProgress = request.methods.find((entry) => entry.methodId === methodId);
      const processedScenarioIds = new Set([
        ...(methodProgress?.completedScenarioIds ?? []),
        ...(methodProgress?.skippedScenarioIds ?? [])
      ]);
      if (processedScenarioIds.has(scenarioId)) {
        return {
          waveBatchId: null,
          reportPairId: request.reportPairId,
          methodId,
          remainingScenarioCount: 0,
          hasWork: false,
          selectedMethodIds: [],
          selectedScenarioIds: [],
          remainingScenarioCountByMethod: Object.fromEntries(
            request.methods.map((entry) => [entry.methodId, 0])
          ),
          completedMethodIds: request.methods.map((entry) => entry.methodId),
          parts: [],
          warnings: []
        };
      }
      return {
        ...structuredClone(classWave),
        reportPairId: request.reportPairId
      };
    },
    async streamMethodGenerationWave(request, modelContext, onProgress, signal) {
      waveStreamCalls.push(structuredClone(request));
      waveModelNames.push(modelContext.llmConfig.model);
      waveHasStarted = true;
      waveStarted.resolve();
      await waitForReleaseOrAbort(releaseWave.promise, signal);
      const part = request.parts[0];
      const testCode = [
        'package example;',
        'import org.junit.jupiter.api.Test;',
        `public class ${part.request.outputTestClassName} {`,
        '  @Test void m1_generated() { new Task().run(); }',
        '}',
        ''
      ].join('\n');
      const candidate = {
        candidateId,
        candidateVersion: 1,
        repairAttempt: 0,
        methodId,
        batchId: partBatchId,
        batchIndex: 1,
        testCode,
        generatedCodeSha256: createHash('sha256').update(testCode).digest('hex'),
        outputTestClassName: part.request.outputTestClassName,
        ordinaryTestMethodCount: 1,
        usage: candidateUsage
      };
      const partResult = {
        partIndex: 1,
        partBatchId,
        scenarioIds: [scenarioId],
        status: 'succeeded',
        childSessionId,
        candidate,
        error: null,
        aggregateUsage: candidateUsage,
        modelCallCount: candidateUsage ? 1 : 0,
        usageReportedCallCount: candidateUsage ? 1 : 0
      };
      const completion = {
        parts: [partResult],
        succeededPartCount: 1,
        failedPartCount: 0,
        cancelledPartCount: 0,
        aggregateUsage: candidateUsage,
        modelCallCount: candidateUsage ? 1 : 0,
        usageReportedCallCount: candidateUsage ? 1 : 0
      };
      await onProgress(event(1, 'wave_started'));
      await onProgress(event(2, 'part_succeeded', {
        partIndex: 1,
        partBatchId,
        scenarioIds: [scenarioId],
        childSessionId,
        candidateId,
        partResult
      }));
      if (pendingWaveFailure) {
        pendingWaveFailure = false;
        throw new MethodGenerationRequestError(
          'MODEL_UNAVAILABLE',
          '大模型平台当前不可用。'
        );
      }
      await onProgress(event(3, 'wave_completed', { completion }));
      return { waveSessionId, eventSequence: 3, completion };
    },
    async resumeMethodGenerationWaveStream() {
      throw new MethodGenerationRequestError(
        'MODEL_UNAVAILABLE',
        'The previous model Wave session is unavailable.'
      );
    },
    async recoverMethodGenerationWaveStream(request, modelContext, onProgress) {
      waveRecoveryCallCount += 1;
      waveModelNames.push(modelContext.llmConfig.model);
      const parts = request.terminalParts.map((part) => structuredClone(part));
      const completion = {
        parts,
        succeededPartCount: parts.filter((part) => part.status === 'succeeded').length,
        failedPartCount: parts.filter((part) => part.status === 'failed').length,
        cancelledPartCount: parts.filter((part) => part.status === 'cancelled').length,
        aggregateUsage: null,
        modelCallCount: 0,
        usageReportedCallCount: 0
      };
      const eventSequence = request.lastAcknowledgedEventSequence + 1;
      await onProgress(event(eventSequence, 'wave_completed', { completion }));
      return { waveSessionId, eventSequence, completion };
    },
    async acknowledgeMethodGenerationWaveEvents(_sessionId, sequence) {
      return {
        waveSessionId,
        acknowledgedThroughEventSequence: sequence,
        lastEventSequence: sequence
      };
    },
    async cancelMethodGeneration() {
      return { sessionId: childSessionId, phase: 'cancelled' };
    },
    async cancelMethodGenerationWave() {
      throw new Error('Wave cancellation was not expected.');
    }
  };

  let currentTestClasses = [];
  let candidateMavenCompileCallCount = 0;
  const shellService = {
    async validateBuildSettings() {
      throw new Error('persisted build validation must be reused');
    },
    async runMavenCompile() {
      if (trackCoverageFromMaven) mavenCoverageCovered = false;
      return successfulCommand('fake-mvn compile', moduleRoot);
    },
    async runMavenModuleTestsWithJacoco() {
      return successfulCommand('fake-mvn module-test', moduleRoot);
    },
    async runMavenDirectTestsWithJacoco(_root, _settings, testClasses) {
      if (trackCoverageFromMaven) {
        mavenCoverageCovered = testClasses.some((name) => name.endsWith('.Task1Test'));
      }
      return successfulCommand('fake-mvn direct-test', moduleRoot);
    },
    async runMavenGeneratedTestCompile(_root, _settings, testClasses) {
      currentTestClasses = Array.isArray(testClasses) ? [...testClasses] : [testClasses];
      const compilesWaveCandidate = currentTestClasses.some(
        (name) => name.endsWith('.TaskTmp1Test')
      );
      if (compilesWaveCandidate) candidateMavenCompileCallCount += 1;
      return successfulCommand('fake-mvn test-compile', moduleRoot);
    },
    async runMavenGeneratedSurefireTest(_root, _settings, testClasses) {
      currentTestClasses = Array.isArray(testClasses) ? [...testClasses] : [testClasses];
      const isFormal = currentTestClasses.some((name) => name.endsWith('.Task1Test'));
      return successfulCommand(
        'fake-mvn surefire:test',
        moduleRoot,
        failFormalPublication && isFormal ? 1 : 0
      );
    },
    async runMavenDirectTestsWithJacocoAppend(_root, _settings, testClasses) {
      if (trackCoverageFromMaven) {
        mavenCoverageCovered = testClasses.some((name) => name.endsWith('.Task1Test'));
      }
      return successfulCommand('fake-mvn jacoco-append', moduleRoot);
    }
  };
  const surefireReportService = {
    async prepareAttempt() { return join(moduleRoot, 'target', 'fixture-surefire'); },
    async readAttemptArtifacts() {
      return [{
        fileName: 'TEST-fixture.xml',
        content: [
          '<testsuite name="fixture" tests="1" failures="0" errors="0" skipped="0">',
          ...currentTestClasses.map((name) => (
            `  <testcase classname="${name}" name="generated"/>`
          )),
          '</testsuite>'
        ].join('\n')
      }];
    },
    async parseAttempt(_directory, qualifiedTestClassName) {
      const failed = failFormalPublication && qualifiedTestClassName.endsWith('.Task1Test');
      return {
        reportCount: 1,
        tests: 1,
        failures: failed ? 1 : 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName: qualifiedTestClassName,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: failed ? [{
          suiteName: 'fixture',
          testClassName: qualifiedTestClassName,
          testName: 'generated',
          kind: 'failure',
          message: 'formal publication failed'
        }] : []
      };
    }
  };
  const writer = new TestWriterService();
  const deleteGeneratedTest = writer.deleteGeneratedTest.bind(writer);
  writer.deleteGeneratedTest = async (input) => {
    const result = await deleteGeneratedTest(input);
    if (input.filePath === tmpFilePath) {
      tmpDeleteStarted.resolve();
      await releaseTmpDelete.promise;
    }
    return result;
  };
  const runtimeOptions = {
    storageDirectory,
    aiClient,
    shellService,
    mavenAnalysisContextService: {
      async collect(input) {
        return {
          workspaceRoot: input.workspaceRoot,
          moduleRoot: input.moduleRoot,
          targetSourcePath: input.targetSourcePath,
          targetClass: input.targetClass,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath,
          reportPath: input.reportPath,
          branchSnapshotPath: input.branchSnapshotPath,
          reportPairId: input.reportPairId,
          sourceRoots: [sourceDirectory],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: '1'.repeat(64),
          warnings: []
        };
      }
    },
    testWriterService: writer,
    jacocoArtifactsService: restoredPackerJacocoArtifacts(reportPairId),
    surefireReportService,
    buildSettingsService: {
      async get() {
        return {
          mavenHome: 'C:\\fixture-maven',
          javaHome: 'C:\\fixture-jdk',
          settingsPath: null,
          localRepository: null,
          validation: {
            valid: true,
            command: 'fake-mvn --version',
            mavenVersion: '3.9.16',
            javaVersion: '21.0.8',
            javaRuntime: 'fixture-jdk',
            checkedAt: occurredAt
          }
        };
      }
    },
    modelInterfacesService: {
      async getView() {
        return {
          schemaVersion: 2,
          activeInterfaceId: null,
          interfaces: [],
          secureStorageAvailable: true
        };
      },
      async resolveForGeneration() {
        return {
          interfaceId: 'fixture-model',
          interfaceName: 'Fixture model',
          llmConfig: {
            provider: 'custom_openai',
            model: activeModelName,
            baseUrl: 'http://127.0.0.1:9/v1',
            credentials: { apiKey: '' }
          }
        };
      }
    },
    modelCallLogSettingsService: { async get() { return { enabled: false }; } },
    broadcast,
    idFactory: sequentialUuidFactory(),
    ...(analysisSessionHeartbeatIntervalMilliseconds === undefined
      ? {}
      : { analysisSessionHeartbeatIntervalMilliseconds }),
    ...(analysisResponseTimeoutRetryInitialDelayMilliseconds === undefined
      ? {}
      : { analysisResponseTimeoutRetryInitialDelayMilliseconds }),
    ...(analysisResponseTimeoutRetryMaxDelayMilliseconds === undefined
      ? {}
      : { analysisResponseTimeoutRetryMaxDelayMilliseconds })
  };
  const runtime = createProductionClassTaskRuntime(runtimeOptions);
  t.after(async () => {
    const [shutdown] = await Promise.allSettled([runtime.beforeQuit()]);
    await rm(root, { recursive: true, force: true });
    if (shutdown.status === 'rejected') throw shutdown.reason;
  });
  return {
    runtime,
    workspaceRoot,
    storageDirectory,
    methodId,
    reportPairId,
    tmpFilePath,
    formalFilePath,
    analyzerCalls,
    waveStreamCalls,
    waveModelNames,
    waveRecoveryCalls: () => waveRecoveryCallCount,
    candidateMavenCompileCalls: () => candidateMavenCompileCallCount,
    setModelName(value) { activeModelName = value; },
    setReportPairId(value) { currentReportPairId = value; },
    heartbeatCallCount: () => heartbeatCallCount,
    analyzerHealthCheckCount: () => analyzerHealthCheckCount,
    cancelledHeartbeatCount: () => cancelledHeartbeatCount,
    analysisSessionCreationCount: () => analysisSessionCreationCount,
    waveStarted,
    releaseWave,
    tmpDeleteStarted,
    releaseTmpDelete,
    runtimeOptions
  };
}

function runtimeDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForReleaseOrAbort(release, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    release.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function successfulCommand(command, cwd, exitCode = 0) {
  return { command, cwd, exitCode, stdout: '', stderr: '' };
}

function sequentialUuidFactory() {
  let value = 100;
  return () => `77777777-7777-4777-8777-${String(value++).padStart(12, '0')}`;
}

function restoredPackerJacocoArtifacts(defaultPairId) {
  let currentPair = null;
  const validatedPair = (paths, pairId = defaultPairId) => ({
    reportPath: paths.reportPath,
    branchSnapshotPath: paths.branchSnapshotPath,
    pairId
  });
  return {
    paths(moduleRoot) {
      return { targetDirectory: join(moduleRoot, 'target') };
    },
    async prepareModulePreload(moduleRoot, fingerprint) {
      const versionDirectory = join(moduleRoot, 'target', 'fixture-preload', fingerprint);
      return {
        versionDirectory,
        executionDataPath: join(versionDirectory, 'jacoco.exec'),
        surefireReportsDirectory: join(versionDirectory, 'surefire-reports')
      };
    },
    async initializeEmptyExecutionData(_moduleRoot, executionDataPath) {
      return executionDataPath;
    },
    async validateModuleExecutionData(_moduleRoot, executionDataPath) {
      return executionDataPath;
    },
    async prepareClassPreloadPair(moduleRoot, fingerprint) {
      const directory = join(moduleRoot, 'target', 'fixture-preload', fingerprint, 'class');
      return {
        reportPath: join(directory, 'jacoco.xml'),
        branchSnapshotPath: join(directory, 'jacoco.branches.json')
      };
    },
    async readValidatedPair(_targetDirectory, paths, pairId) {
      currentPair = validatedPair(paths, pairId);
      return structuredClone(currentPair);
    },
    async removeClassPreloadPair() {},
    async removeModulePreload() {},
    taskSessionPaths(moduleRoot, taskId) {
      const targetDirectory = join(moduleRoot, 'target');
      const taskDirectory = join(targetDirectory, 'fixture-tasks', taskId);
      return {
        targetDirectory,
        taskDirectory,
        versionsDirectory: join(taskDirectory, 'versions'),
        baselineExecutionDataPath: join(taskDirectory, 'baseline.exec'),
        currentExecutionDataPath: join(taskDirectory, 'current.exec'),
        baseline: {
          reportPath: join(taskDirectory, 'baseline-jacoco.xml'),
          branchSnapshotPath: join(taskDirectory, 'baseline-jacoco.branches.json')
        },
        current: {
          reportPath: join(taskDirectory, 'current-jacoco.xml'),
          branchSnapshotPath: join(taskDirectory, 'current-jacoco.branches.json')
        }
      };
    },
    async prepareTaskSession(moduleRoot, taskId, executionDataPath, baselinePair) {
      const targetDirectory = join(moduleRoot, 'target');
      const taskDirectory = join(targetDirectory, 'fixture-tasks', taskId);
      currentPair = structuredClone(baselinePair);
      return {
        targetDirectory,
        taskDirectory,
        versionsDirectory: join(taskDirectory, 'versions'),
        baselineExecutionDataPath: executionDataPath,
        currentExecutionDataPath: executionDataPath,
        baseline: {
          reportPath: baselinePair.reportPath,
          branchSnapshotPath: baselinePair.branchSnapshotPath
        },
        current: {
          reportPath: baselinePair.reportPath,
          branchSnapshotPath: baselinePair.branchSnapshotPath
        }
      };
    },
    async prepareTaskVersion(moduleRoot, taskId, versionId) {
      const session = this.taskSessionPaths(moduleRoot, taskId);
      const versionDirectory = join(session.versionsDirectory, versionId);
      return {
        versionId,
        versionDirectory,
        executionDataPath: join(versionDirectory, 'jacoco.exec'),
        surefireReportsDirectory: join(versionDirectory, 'surefire'),
        pair: {
          reportPath: join(versionDirectory, 'coverage.xml'),
          branchSnapshotPath: join(versionDirectory, 'coverage.branches.json')
        }
      };
    },
    async promoteTaskVersion(_moduleRoot, _taskId, _version, sourcePair) {
      currentPair = structuredClone(sourcePair);
      return structuredClone(currentPair);
    },
    async promoteTaskBaseline() {
      if (!currentPair) throw new Error('Fixture JaCoCo session has no baseline pair.');
      return structuredClone(currentPair);
    },
    async removeTaskVersion() {},
    async readExactCoverageSnapshot(_moduleRoot, pair, counts) {
      return {
        pair: structuredClone(pair),
        counts: structuredClone(counts),
        lineIds: ['method-id@line:1'],
        coveredLineIds: counts.lineCovered > 0 ? ['method-id@line:1'] : [],
        branchIds: [],
        coveredBranchIds: []
      };
    },
    async currentTaskPair() {
      if (!currentPair) throw new Error('Fixture JaCoCo session has no current pair.');
      return structuredClone(currentPair);
    },
    async removeTaskSession() {}
  };
}

function controlledPreloadMaven() {
  let markModuleStarted;
  let markCompileStarted;
  let markDirectStarted;
  let abortCount = 0;
  let moduleCallCount = 0;
  let compileCallCount = 0;
  let directCallCount = 0;
  const directTestCalls = [];
  const pendingCalls = [];
  const moduleStarted = new Promise((resolve) => {
    markModuleStarted = resolve;
  });
  const compileStarted = new Promise((resolve) => {
    markCompileStarted = resolve;
  });
  const directStarted = new Promise((resolve) => {
    markDirectStarted = resolve;
  });
  const run = (options) => {
    let resolveCall;
    let rejectCall;
    const call = {
      settled: false,
      resolve(value) {
        if (call.settled) return;
        call.settled = true;
        resolveCall(value);
      },
      reject(error) {
        if (call.settled) return;
        call.settled = true;
        rejectCall(error);
      }
    };
    const result = new Promise((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    pendingCalls.push(call);
    if (options?.signal?.aborted) {
      call.reject(options.signal.reason);
      return result;
    }
    const abort = () => {
      abortCount += 1;
      call.reject(options.signal.reason);
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    return result.finally(() => options?.signal?.removeEventListener('abort', abort));
  };
  return {
    started: moduleStarted,
    moduleStarted,
    compileStarted,
    directStarted,
    get moduleCallCount() {
      return moduleCallCount;
    },
    get directCallCount() {
      return directCallCount;
    },
    get directTestCalls() {
      return directTestCalls.map((testClasses) => [...testClasses]);
    },    get compileCallCount() {
      return compileCallCount;
    },
    get abortCount() {
      return abortCount;
    },
    finish(commandResult) {
      const pending = pendingCalls.find((call) => !call.settled);
      if (!pending) throw new Error('No Maven command is waiting for a result.');
      pending.resolve(commandResult);
    },
    shellService: {
      async validateBuildSettings() {
        throw new Error('validated build settings must be reused');
      },
      runMavenCompile(_moduleRoot, _settings, options) {
        compileCallCount += 1;
        markCompileStarted();
        return run(options);
      },
      runMavenModuleTestsWithJacoco(_moduleRoot, _settings, _exec, _reports, options) {
        moduleCallCount += 1;
        markModuleStarted();
        return run(options);
      },
      runMavenDirectTestsWithJacoco(_moduleRoot, _settings, tests, _exec, _reports, options) {
        directCallCount += 1;
        directTestCalls.push([...tests]);
        markDirectStarted();
        return run(options);
      },      async runMavenGeneratedTestCompile() {
        throw new Error('generated test compilation must not run during preload');
      },
      async runMavenGeneratedSurefireTest() {
        throw new Error('generated tests must not run during preload');
      },
      async runMavenDirectTestsWithJacocoAppend() {
        throw new Error('generated coverage must not run during preload');
      }
    }
  };
}

function productionPreloadOptions({
  storageDirectory,
  maven,
  broadcast = () => undefined,
  assertBackendReady
}) {
  const forbidden = (name) => async () => {
    throw new Error(`${name} must not run before module preload succeeds`);
  };
  return {
    storageDirectory,
    aiClient: new Proxy({}, { get: (_target, key) => forbidden(`ai:${String(key)}`) }),
    shellService: maven.shellService,
    mavenAnalysisContextService: { collect: forbidden('analysis-context') },
    testWriterService: {},
    jacocoArtifactsService: new JacocoArtifactsService(),
    surefireReportService: {},
    buildSettingsService: {
      async get() {
        return {
          mavenHome: 'C:\\fixture-maven',
          javaHome: 'C:\\fixture-jdk',
          validation: {
            valid: true,
            command: 'fake-mvn --version',
            mavenVersion: '3.9.16',
            javaVersion: '21.0.8',
            javaRuntime: 'fake-jdk',
            checkedAt: '2026-08-09T00:00:00.000Z'
          }
        };
      }
    },
    modelInterfacesService: {
      async getView() {
        return { activeInterfaceId: null, interfaces: [] };
      },
      resolveForGeneration: forbidden('model-runtime')
    },
    modelCallLogSettingsService: { get: forbidden('log-settings') },
    broadcast,
    assertBackendReady
  };
}
