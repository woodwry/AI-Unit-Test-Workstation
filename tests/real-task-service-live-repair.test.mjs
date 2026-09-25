import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import { CandidateChangeValidator } from '../src/main/services/candidate-change-validator.service.ts';
import { ClassTaskFileTransactionService } from '../src/main/services/class-task-file-transaction.service.ts';
import { FormalTestFilePackerService } from '../src/main/services/formal-test-file-packer.service.ts';
import { GeneratedTestFailurePrunerService } from '../src/main/services/generated-test-failure-pruner.service.ts';
import { GeneratedTestNameReservationService } from '../src/main/services/generated-test-name-reservation.service.ts';
import { JavaTestStructureService } from '../src/main/services/java-test-structure.service.ts';
import { MavenAnalysisContextService } from '../src/main/services/maven-analysis-context.service.ts';
import { MavenCandidateExecutorService } from '../src/main/services/maven-candidate-executor.service.ts';
import { MavenRepairDiagnosticService } from '../src/main/services/maven-repair-diagnostic.service.ts';
import { MethodGenerationLogService } from '../src/main/services/method-generation-log.service.ts';
import { MethodTestBundleMergerService } from '../src/main/services/method-test-bundle-merger.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import { SingleMethodGenerationService } from '../src/main/services/single-method-generation.service.ts';
import { SurefireReportService } from '../src/main/services/surefire-report.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';
import { WorkstationBuildSettingsService } from '../src/main/services/workstation-build-settings.service.ts';

const RUN_REAL_TEST = process.env.RUN_REAL_TASK_SERVICE_LIVE_REPAIR === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const MODULE_ROOT = `${WORKSPACE_ROOT}\\collection-core`;
const SOURCE_FILE_PATH = `${MODULE_ROOT}\\src\\main\\java\\com\\dtsz\\collection\\model\\service\\TaskService.java`;
const TEST_DIRECTORY = `${MODULE_ROOT}\\src\\test\\java\\com\\dtsz\\collection\\model\\service`;
const TEST_FILE_PATH = `${TEST_DIRECTORY}\\TaskServiceTmp1Test.java`;
const TARGET_FQN = 'com.dtsz.collection.model.service.TaskService';
const ANALYSIS_PLACEHOLDER_CLASS_NAME = 'TaskServiceLiveRepairAnalysisPlaceholderTest';
const ANALYSIS_PLACEHOLDER_PATH = (
  `${MODULE_ROOT}\\src\\test\\java\\com\\dtsz\\collection\\model\\service\\`
    + `${ANALYSIS_PLACEHOLDER_CLASS_NAME}.java`
);
const TARGET_METHODS = Object.freeze([
  {
    methodId: '19a2ef040a8be37c8e49b4d68eea7020643e5e5e637f186249a63903943a775d',
    methodName: 'getBbq'
  },
  {
    methodId: 'f38799739643bb52d467963a45267f59f7ba7616a01e042ba49a6de2a342a71f',
    methodName: 'lockTask'
  }
]);
const BUILD_SETTINGS_PATH = 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation\\workstation-build-settings.json';
const USER_DATA = 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation';
const ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const AGENT_URL = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:18000';
const REPORT_PATH = `${MODULE_ROOT}\\target\\ai-unit-test\\jacoco\\preload\\34d6957bf4516a1494153d2f36d516974108bb8c2b9b8c3bd24413d8774d28bf\\classes\\81d91af73919fb343ddb3c08061507e73c7643e0c34e6463e9ac8e58afb4d693.xml`;
const BRANCH_PATH = REPORT_PATH.replace(/\.xml$/, '.branches.json');
const EXPECTED_SOURCE_SHA256 = '306e06cb17524082445ece1e447edc39808beb524029cc231b966cce119f4459';
const RESULT_ROOT = process.env.REAL_TASK_SERVICE_RESULT_ROOT?.trim()
  || resolve('test-results', 'real-task-service-live-repair');
const MODEL_LOG_DIRECTORY = process.env.REAL_TASK_SERVICE_MODEL_LOG_DIRECTORY?.trim()
  || 'C:\\Users\\wry\\Desktop\\日志';
const MODEL_NAME = process.env.REAL_TASK_SERVICE_MODEL_NAME?.trim()
  || 'deepseek-v4-pro-0813';
const MODEL_BASE_URL = process.env.REAL_TASK_SERVICE_MODEL_BASE_URL?.trim()
  || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL_API_KEY_ENV = process.env.REAL_TASK_SERVICE_MODEL_API_KEY_ENV?.trim()
  || 'DASHSCOPE_API_KEY';
const EXPECTED_FORMAL_TEST_CLASS_NAME = (
  process.env.REAL_TASK_SERVICE_EXPECTED_FORMAL_TEST_CLASS_NAME?.trim()
  || 'TaskService5Test'
);
const UNLIMITED_REPAIR = process.env.REAL_TASK_SERVICE_UNLIMITED_REPAIR === '1';
const REPAIR_ATTEMPT_LIMIT = Number(
  process.env.REAL_TASK_SERVICE_REPAIR_ATTEMPT_LIMIT ?? '5'
);
const RESET_EXISTING_TEST = process.env.REAL_TASK_SERVICE_RESET_EXISTING_TEST === '1';
const RESUME_RESULT_PATH = process.env.REAL_TASK_SERVICE_RESUME_RESULT_PATH?.trim()
  || null;
const INTERRUPTED_RESULT_DIRECTORY = (
  process.env.REAL_TASK_SERVICE_INTERRUPTED_RESULT_DIRECTORY?.trim() || null
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function taskServiceTemporaryTests() {
  const names = await readdir(TEST_DIRECTORY);
  return names
    .filter((name) => /^TaskServiceTmp\d+Test\.java$/.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
    .map((name) => `${TEST_DIRECTORY}\\${name}`);
}

async function completedModelCallEvidence(expectedBatchCount) {
  const recordsByTask = new Map();
  const dateDirectories = await readdir(MODEL_LOG_DIRECTORY, { withFileTypes: true });
  for (const dateDirectory of dateDirectories) {
    if (!dateDirectory.isDirectory()) continue;
    const datePath = resolve(MODEL_LOG_DIRECTORY, dateDirectory.name);
    const callDirectories = await readdir(datePath, { withFileTypes: true });
    for (const callDirectory of callDirectories) {
      if (!callDirectory.isDirectory()) continue;
      const callPath = resolve(datePath, callDirectory.name);
      const names = await readdir(callPath);
      const infoName = names.find((name) => name.endsWith('调用信息.json'));
      if (!infoName) continue;
      const record = JSON.parse(await readFile(resolve(callPath, infoName), 'utf8'));
      if (
        record.qualifiedClassName !== TARGET_FQN
        || record.methodId !== TARGET_METHODS[0].methodId
        || record.phase !== 'completed'
        || !Number.isSafeInteger(record.batchIndex)
        || record.batchIndex < 1
        || record.batchIndex > expectedBatchCount
      ) {
        continue;
      }
      const taskRecords = recordsByTask.get(record.taskId) ?? [];
      taskRecords.push(record);
      recordsByTask.set(record.taskId, taskRecords);
    }
  }

  const candidates = [...recordsByTask.entries()].map(([taskId, records]) => {
    const batches = new Map();
    for (const record of records) {
      const previous = batches.get(record.batchIndex);
      const isNewerBatchRun = previous && previous.batchId !== record.batchId
        && record.occurredAt > previous.occurredAt;
      const isNewerCandidate = previous && previous.batchId === record.batchId
        && record.candidateVersion > previous.candidateVersion;
      if (!previous || isNewerBatchRun || isNewerCandidate) {
        batches.set(record.batchIndex, record);
      }
    }
    const complete = Array.from(
      { length: expectedBatchCount },
      (_, index) => batches.get(index + 1)
    );
    return {
      taskId,
      records: complete,
      complete: complete.every(Boolean),
      latestAt: records.reduce(
        (latest, record) => record.occurredAt > latest ? record.occurredAt : latest,
        ''
      )
    };
  }).filter(({ complete }) => complete)
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  assert.ok(
    candidates.length > 0,
    `No completed model-call chain covers batches 1-${expectedBatchCount}.`
  );
  return candidates[0];
}

async function loadInterruptedRunEvidence(resultDirectory) {
  if (!resultDirectory) return null;
  assert.equal(
    RESUME_RESULT_PATH,
    null,
    'Configured result.json resume and interrupted-run recovery are mutually exclusive.'
  );
  const resolvedDirectories = resultDirectory.split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  assert.ok(
    resolvedDirectories.length > 0,
    'Interrupted-run recovery requires at least one evidence directory.'
  );
  const temporaryFiles = await taskServiceTemporaryTests();
  assert.ok(
    temporaryFiles.length > 0,
    'Interrupted-run recovery requires the verified TaskServiceTmpNTest.java files.'
  );
  temporaryFiles.forEach((filePath, index) => {
    assert.equal(
      basename(filePath),
      `TaskServiceTmp${index + 1}Test.java`,
      'Interrupted TMP files must form a contiguous sequence starting at 1.'
    );
  });

  const attempts = [];
  for (const directory of resolvedDirectories) {
    const names = (await readdir(directory))
      .filter((name) => /^maven-attempt-\d+\.json$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    for (const name of names) {
      attempts.push(JSON.parse(await readFile(resolve(directory, name), 'utf8')));
    }
  }
  const structure = new JavaTestStructureService();
  const files = [];
  let inProgressFile = null;
  for (const filePath of temporaryFiles) {
    const className = basename(filePath, '.java');
    const qualifiedTestClassName = `com.dtsz.collection.model.service.${className}`;
    const matching = attempts.filter(
      ({ input }) => input?.qualifiedTestClassName === qualifiedTestClassName
    );
    assert.ok(matching.length > 0, `No Maven evidence exists for ${className}.`);
    const latest = matching.at(-1);
    const code = await readFile(filePath, 'utf8');
    const ordinaryTestMethodCount = structure.findTestMethods(code).length;
    assert.ok(ordinaryTestMethodCount > 0, `${className} contains no JUnit test method.`);
    const evidence = {
      filePath,
      sha256: sha256(code),
      ordinaryTestMethodCount,
      mavenAttemptId: latest.input.attemptId,
      mavenStatus: latest.result?.status ?? null
    };
    if (latest.result?.status === 'passed') {
      assert.equal(
        inProgressFile,
        null,
        `${className} follows a non-passing TMP batch and cannot be recovered safely.`
      );
      assert.equal(
        latest.result?.testReport?.generatedTests,
        ordinaryTestMethodCount,
        `${className} test count differs from its passing Surefire report.`
      );
      files.push(evidence);
      continue;
    }
    assert.equal(
      inProgressFile,
      null,
      'Interrupted-run recovery accepts at most one trailing non-passing TMP batch.'
    );
    assert.equal(
      basename(filePath),
      `TaskServiceTmp${files.length + 1}Test.java`,
      'The non-passing TMP batch must immediately follow all passing batches.'
    );
    inProgressFile = evidence;
  }
  const modelCalls = await completedModelCallEvidence(files.length);
  return {
    resultDirectory: resolvedDirectories.at(-1),
    resultDirectories: resolvedDirectories,
    previousRunId: basename(resolvedDirectories.at(-1)),
    temporaryFiles,
    files,
    inProgressFile,
    modelLogTaskId: modelCalls.taskId,
    modelCalls: modelCalls.records
  };
}

async function recoverInterruptedRunState({
  evidence,
  client,
  analysisSessionId,
  reportPairId,
  taskId
}) {
  if (!evidence) return null;
  const completedBatches = [];
  const completedTestMethodPlanIds = [];
  const replayEvents = [];
  const target = TARGET_METHODS[0];
  for (let index = 0; index < evidence.files.length; index += 1) {
    const page = await client.nextMethodBatch(
      analysisSessionId,
      target.methodId,
      {
        reportPairId,
        completedTestMethodPlanIds: [...completedTestMethodPlanIds],
        maxTestMethods: 12
      }
    );
    const batchIndex = index + 1;
    assert.equal(page.hasWork, true, `Analyzer has no work for recovered batch ${batchIndex}.`);
    const modelCall = evidence.modelCalls[index];
    assert.equal(
      page.batchId,
      modelCall.batchId,
      `Analyzer batch ${batchIndex} differs from the completed model-call log.`
    );
    const completedIds = page.methodTestPlan.testMethodPlans.map(
      (plan) => plan.testMethodPlanId
    );
    completedTestMethodPlanIds.push(...completedIds);
    const file = evidence.files[index];
    completedBatches.push({
      taskId,
      methodId: target.methodId,
      batchId: page.batchId,
      batchIndex,
      completedTestMethodPlanIds: [...completedTestMethodPlanIds],
      outcome: 'PASSED',
      candidateVersion: modelCall.candidateVersion,
      tmpFilePath: file.filePath,
      tmpFileSha256: file.sha256,
      ordinaryTestMethodCount: file.ordinaryTestMethodCount
    });
    replayEvents.push({
      batchIndex,
      batchId: page.batchId,
      completedTestMethodPlanIds: [...completedTestMethodPlanIds],
      tmpFilePath: file.filePath,
      tmpFileSha256: file.sha256,
      ordinaryTestMethodCount: file.ordinaryTestMethodCount,
      mavenAttemptId: file.mavenAttemptId,
      modelName: modelCall.modelName,
      modelCallId: modelCall.callId,
      candidateVersion: modelCall.candidateVersion
    });
  }
  return {
    resultPath: null,
    previousRunId: evidence.previousRunId,
    checkpoints: new Map([
      [target.methodId, {
        completedBatches,
        completedTestMethodPlanIds: [...completedTestMethodPlanIds]
      }],
      [TARGET_METHODS[1].methodId, {
        completedBatches: [],
        completedTestMethodPlanIds: []
      }]
    ]),
    staleBatches: [],
    formalizedBundles: new Map(),
    formalArtifacts: [],
    interruptedResultDirectory: evidence.resultDirectory,
    interruptedResultDirectories: evidence.resultDirectories,
    inProgressEvidence: evidence.inProgressFile,
    replayEvents
  };
}

async function loadResumeState(resultPath, taskId) {
  if (!resultPath) return null;
  const history = [];
  const visited = new Set();
  let currentResultPath = resolve(resultPath);
  while (currentResultPath) {
    const identity = currentResultPath.toLowerCase();
    assert.equal(
      visited.has(identity),
      false,
      `Resume result chain contains a cycle: ${currentResultPath}`
    );
    visited.add(identity);
    const previous = JSON.parse(await readFile(currentResultPath, 'utf8'));
    assert.equal(previous.sourceSha256Before, EXPECTED_SOURCE_SHA256);
    assert.equal(previous.sourceSha256After, EXPECTED_SOURCE_SHA256);
    assert.equal(previous.modelName, MODEL_NAME);
    assert.deepEqual(previous.targetMethods, TARGET_METHODS);
    history.push({ resultPath: currentResultPath, result: previous });
    currentResultPath = previous.resumedFromResultPath
      ? resolve(previous.resumedFromResultPath)
      : null;
  }
  history.reverse();

  const commitsByBatch = new Map();
  for (const { result } of history) {
    for (const [kind, value] of result.checkpointEvents ?? []) {
      if (kind !== 'commit') continue;
      commitsByBatch.set(
        `${value.methodId}:${value.batchIndex}`,
        structuredClone(value)
      );
    }
  }
  const commits = [...commitsByBatch.values()];
  const checkpoints = new Map();
  const staleBatches = [];
  for (const target of TARGET_METHODS) {
    const methodCommits = commits
      .filter(({ methodId }) => methodId === target.methodId)
      .sort((left, right) => left.batchIndex - right.batchIndex);
    const completedBatches = [];
    for (const batch of methodCommits) {
      if (
        batch.outcome === 'DROPPED'
        || completedBatches.length !== batch.batchIndex - 1
      ) {
        staleBatches.push(batch);
        continue;
      }
      completedBatches.push({ ...batch, taskId });
    }
    const completedTestMethodPlanIds = completedBatches.at(-1)
      ?.completedTestMethodPlanIds ?? [];
    checkpoints.set(target.methodId, {
      completedBatches,
      completedTestMethodPlanIds: [...completedTestMethodPlanIds]
    });
  }
  const formalizedBundles = new Map();
  const formalArtifactsById = new Map();
  for (const target of TARGET_METHODS) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const result = history[index].result;
      const bundle = (result.bundles ?? []).find(
        (candidate) => candidate.methodId === target.methodId
      );
      const artifacts = (result.formalArtifacts ?? []).filter(
        (artifact) => artifact.methodIds?.includes(target.methodId)
      );
      if (!bundle || artifacts.length === 0) continue;
      for (const artifact of artifacts) {
        const content = await readFile(artifact.filePath);
        assert.equal(
          sha256(content),
          artifact.sha256,
          `Resume formal artifact hash changed: ${artifact.filePath}`
        );
        formalArtifactsById.set(artifact.id, structuredClone(artifact));
      }
      formalizedBundles.set(target.methodId, structuredClone(bundle));
      break;
    }
  }
  const latest = history.at(-1);
  return {
    resultPath: latest.resultPath,
    previousRunId: latest.result.runId ?? null,
    checkpoints,
    staleBatches,
    formalizedBundles,
    formalArtifacts: [...formalArtifactsById.values()]
  };
}

async function currentReportPairId() {
  const snapshot = JSON.parse(await readFile(BRANCH_PATH, 'utf8'));
  assert.match(snapshot.pairId ?? '', /^[0-9a-f]{64}$/);
  assert.equal(snapshot.targetClass, TARGET_FQN);
  assert.equal(snapshot.targetSourceSha256, EXPECTED_SOURCE_SHA256);
  return snapshot.pairId;
}

test('generates, repairs, and packs getBbq and lockTask through live Agent, Analyzer, and Maven', {
  skip: !RUN_REAL_TEST,
  timeout: 4 * 60 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const resultDirectory = resolve(RESULT_ROOT, runId);
  await mkdir(resultDirectory, { recursive: true });
  const taskId = randomUUID();
  let resumeState = await loadResumeState(RESUME_RESULT_PATH, taskId);
  const interruptedEvidence = await loadInterruptedRunEvidence(
    INTERRUPTED_RESULT_DIRECTORY
  );
  const sourceBefore = await readFile(SOURCE_FILE_PATH);
  const temporaryTestsBefore = await taskServiceTemporaryTests();
  const reportPairId = await currentReportPairId();
  assert.equal(sha256(sourceBefore), EXPECTED_SOURCE_SHA256);
  if (resumeState) {
    const expectedTemporaryFiles = new Map();
    for (const [methodId, checkpoint] of resumeState.checkpoints) {
      if (resumeState.formalizedBundles.has(methodId)) continue;
      for (const batch of checkpoint.completedBatches) {
        expectedTemporaryFiles.set(
          batch.tmpFilePath.toLowerCase(),
          batch.tmpFileSha256
        );
      }
    }
    for (const batch of resumeState.staleBatches) {
      if (batch.tmpFilePath && batch.tmpFileSha256) {
        expectedTemporaryFiles.set(
          batch.tmpFilePath.toLowerCase(),
          batch.tmpFileSha256
        );
      }
    }
    assert.deepEqual(
      new Set(temporaryTestsBefore.map((filePath) => filePath.toLowerCase())),
      new Set(expectedTemporaryFiles.keys()),
      'Resume result does not own every existing TaskServiceTmpNTest.java file.'
    );
    for (const filePath of temporaryTestsBefore) {
      const content = await readFile(filePath);
      assert.equal(
        sha256(content),
        expectedTemporaryFiles.get(filePath.toLowerCase()),
        `Resume TMP hash changed: ${filePath}`
      );
    }
    const staleWriter = new TestWriterService();
    for (const batch of resumeState.staleBatches) {
      if (!batch.tmpFilePath || !batch.tmpFileSha256) continue;
      const content = await readFile(batch.tmpFilePath);
      const fileName = batch.tmpFilePath.slice(
        batch.tmpFilePath.lastIndexOf('\\') + 1
      );
      await writeFile(resolve(resultDirectory, `pre-resume-${fileName}`), content);
      await staleWriter.deleteGeneratedTest({
        workspaceRoot: WORKSPACE_ROOT,
        filePath: batch.tmpFilePath,
        expectedSha256: batch.tmpFileSha256
      });
    }
  } else if (interruptedEvidence) {
    assert.deepEqual(
      temporaryTestsBefore.map((filePath) => filePath.toLowerCase()),
      interruptedEvidence.temporaryFiles.map((filePath) => filePath.toLowerCase()),
      'Interrupted-run evidence does not own every existing TaskServiceTmpNTest.java file.'
    );
  } else if (temporaryTestsBefore.length > 0) {
    assert.equal(
      RESET_EXISTING_TEST,
      true,
      'TaskServiceTmpNTest.java must not exist before fresh generation.'
    );
    const staleWriter = new TestWriterService();
    for (const filePath of temporaryTestsBefore) {
      const content = await readFile(filePath);
      const fileName = filePath.slice(filePath.lastIndexOf('\\') + 1);
      await writeFile(resolve(resultDirectory, `pre-run-${fileName}`), content);
      await staleWriter.deleteGeneratedTest({
        workspaceRoot: WORKSPACE_ROOT,
        filePath,
        expectedSha256: sha256(content)
      });
    }
  }
  assert.equal(
    UNLIMITED_REPAIR || Number.isSafeInteger(REPAIR_ATTEMPT_LIMIT),
    true,
    'REAL_TASK_SERVICE_REPAIR_ATTEMPT_LIMIT must be an integer.'
  );
  assert.equal(
    UNLIMITED_REPAIR || REPAIR_ATTEMPT_LIMIT >= 1,
    true,
    'REAL_TASK_SERVICE_REPAIR_ATTEMPT_LIMIT must be at least 1.'
  );

  const shell = new ShellService();
  const buildSettingsService = new WorkstationBuildSettingsService(
    BUILD_SETTINGS_PATH, 'win32', 'C:\\Users\\wry'
  );
  const buildSettings = await buildSettingsService.get();
  assert.ok(buildSettings);
  const validation = await shell.validateBuildSettings(buildSettings, MODULE_ROOT, {
    excludedEnvironmentVariables: [MODEL_API_KEY_ENV]
  });
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.ok(validation.javaVersion && validation.mavenVersion);

  const analysisInput = await new MavenAnalysisContextService(shell).collect({
    workspaceRoot: WORKSPACE_ROOT,
    moduleRoot: MODULE_ROOT,
    targetSourcePath: SOURCE_FILE_PATH,
    targetClass: TARGET_FQN,
    plannedTestClassName: ANALYSIS_PLACEHOLDER_CLASS_NAME,
    plannedRelativeTestPath: relative(WORKSPACE_ROOT, ANALYSIS_PLACEHOLDER_PATH).replaceAll('\\', '/'),
    reportPath: REPORT_PATH,
    branchSnapshotPath: BRANCH_PATH,
    reportPairId,
    buildSettings,
    buildToolchain: {
      javaVersion: validation.javaVersion,
      mavenVersion: validation.mavenVersion
    },
    customModelEnvironmentVariable: MODEL_API_KEY_ENV
  });

  const client = new AiClient();
  client.setBackendSettings({
    agentServiceUrl: AGENT_URL,
    javaAnalyzerUrl: ANALYZER_URL
  });
  const candidateEvents = [];
  const repairContextEvents = [];
  const captureCandidate = (stage, result) => {
    candidateEvents.push({
      stage,
      kind: result.kind,
      eventSequence: result.eventSequence,
      sessionId: result.sessionId,
      candidate: result.kind === 'candidate_ready' ? {
        candidateId: result.candidate.candidateId,
        candidateVersion: result.candidate.candidateVersion,
        repairAttempt: result.candidate.repairAttempt,
        methodId: result.candidate.methodId,
        batchId: result.candidate.batchId,
        batchIndex: result.candidate.batchIndex,
        outputTestClassName: result.candidate.outputTestClassName,
        ordinaryTestMethodCount: result.candidate.ordinaryTestMethodCount,
        generatedCodeSha256: result.candidate.generatedCodeSha256,
        computedCodeSha256: sha256(result.candidate.testCode)
      } : null,
      completion: result.kind === 'completed' ? result.completion : null
    });
    return result;
  };
  const liveAgent = {
    async startMethodGenerationStream(...args) {
      return captureCandidate('start', await client.startMethodGenerationStream(...args));
    },
    async resumeMethodGenerationStream(...args) {
      return captureCandidate('resume', await client.resumeMethodGenerationStream(...args));
    },
    acknowledgeMethodGenerationEvents: client.acknowledgeMethodGenerationEvents.bind(client),
    cancelMethodGeneration: client.cancelMethodGeneration.bind(client)
  };
  const analysisSessionId = randomUUID();
  const analysis = await client.createMethodAnalysisSession({
    ...analysisInput,
    analysisSessionId
  });
  const methodCatalog = await client.getMethodCatalog(analysis.analysisSessionId);
  const analysisBatchEvents = [];
  const seededAnalyzer = {
    heartbeatMethodAnalysisSession: client.heartbeatMethodAnalysisSession.bind(client),
    async nextMethodBatch(...args) {
      const value = await client.nextMethodBatch(...args);
      analysisBatchEvents.push({
        methodId: args[1],
        request: structuredClone(args[2]),
        batchId: value.batchId,
        hasWork: value.hasWork,
        plannedTestMethods: value.plannedTestMethods,
        remainingTestMethods: value.remainingTestMethods
      });
      return value;
    },
    async getMethodRepairContext(...args) {
      try {
        const value = await client.getMethodRepairContext(...args);
        repairContextEvents.push({
          input: structuredClone(args[1]),
          result: structuredClone(value),
          error: null
        });
        return value;
      } catch (error) {
        repairContextEvents.push({
          input: structuredClone(args[1]),
          result: null,
          error: {
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  };
  const interruptedRecovery = await recoverInterruptedRunState({
    evidence: interruptedEvidence,
    client,
    analysisSessionId: analysis.analysisSessionId,
    reportPairId: analysis.reportPairId,
    taskId
  });
  if (interruptedRecovery) {
    resumeState = interruptedRecovery;
  }

  const llmConfig = {
    provider: 'custom_openai',
    model: MODEL_NAME,
    baseUrl: MODEL_BASE_URL,
    credentials: { apiKey: process.env[MODEL_API_KEY_ENV] ?? '' }
  };
  assert.ok(
    llmConfig.credentials.apiKey,
    `${MODEL_API_KEY_ENV} is not configured.`
  );
  const logs = new MethodGenerationLogService();
  await mkdir(MODEL_LOG_DIRECTORY, { recursive: true });
  await logs.begin({ enabled: true, directory: MODEL_LOG_DIRECTORY });
  const repairTelemetry = [];
  const capturedLogs = {
    async record(record) {
      await logs.record(record);
    },
    async recordRepairTelemetry(record) {
      repairTelemetry.push(structuredClone(record));
      await logs.recordRepairTelemetry(record);
    }
  };
  const checkpointEvents = [];
  const modelUsageUpdates = [];
  const mavenAttempts = [];
  const checkpoints = {
    async beginAtomicStep(_taskId, step) { checkpointEvents.push(['begin', step]); },
    async completeAtomicStep(_taskId, step) { checkpointEvents.push(['end', step]); },
    async saveInProgressBatch(value) {
      checkpointEvents.push(['save_in_progress', structuredClone(value)]);
    },
    async clearInProgressBatch(taskId, methodId, batchId) {
      checkpointEvents.push([
        'clear_in_progress',
        { taskId, methodId, batchId }
      ]);
    },
    async commitBatch(value) {
      checkpointEvents.push(['commit', structuredClone(value)]);
    },
    async addModelUsage(taskId, value) {
      modelUsageUpdates.push({ taskId, ...structuredClone(value) });
    }
  };
  const mavenExecutor = new MavenCandidateExecutorService(
    shell,
    new SurefireReportService()
  );
  const capturedMaven = {
    async execute(input) {
      const result = await mavenExecutor.execute(input);
      const attemptNumber = mavenAttempts.length + 1;
      const fileName = `maven-attempt-${String(attemptNumber).padStart(2, '0')}.json`;
      await mkdir(resultDirectory, { recursive: true });
      await writeFile(
        resolve(resultDirectory, fileName),
        `${JSON.stringify({ input, result }, null, 2)}\n`
      );
      mavenAttempts.push({
        attemptNumber,
        fileName,
        scope: input.scope,
        status: result.status,
        testReport: result.testReport ?? null
      });
      return result;
    }
  };
  const writer = new TestWriterService();
  const moduleLock = new ModuleOperationLock();
  const generator = new SingleMethodGenerationService({
    analyzer: seededAnalyzer,
    agent: liveAgent,
    contextProvider: {
      async resolve() {
        return {
          analysisSessionId,
          reportPairId: analysis.reportPairId,
          sourceSha256: analysis.sourceSha256,
          packageName: 'com.dtsz.collection.model.service',
          plannedRelativeTestPath: relative(WORKSPACE_ROOT, TEST_FILE_PATH).replaceAll('\\', '/'),
          moduleRoot: MODULE_ROOT,
          buildSettings,
          buildToolchain: {
            javaVersion: validation.javaVersion,
            mavenVersion: validation.mavenVersion
          },
          modelContext: { llmConfig },
          methodCatalog: methodCatalog.methods,
          captureModelCalls: true,
          excludedEnvironmentVariables: [MODEL_API_KEY_ENV]
        };
      }
    },
    checkpoints,
    moduleLock,
    writer,
    maven: capturedMaven,
    pruner: new GeneratedTestFailurePrunerService(),
    merger: new MethodTestBundleMergerService(),
    logs: capturedLogs,
    diagnostic: new MavenRepairDiagnosticService(),
    candidateChanges: new CandidateChangeValidator()
  });
  const task = {
    id: taskId,
    workspaceRoot: WORKSPACE_ROOT,
    sourceFilePath: SOURCE_FILE_PATH,
    qualifiedClassName: TARGET_FQN,
    moduleKey: `${MODULE_ROOT.toLowerCase().replaceAll('\\', '/')}/pom.xml`,
    moduleDisplayPath: MODULE_ROOT,
    state: 'RUNNING',
    preloadState: 'READY',
    ragEnabled: false,
    repairAttemptLimit: UNLIMITED_REPAIR ? null : REPAIR_ATTEMPT_LIMIT,
    unlimitedRepair: UNLIMITED_REPAIR,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: TARGET_METHODS.map(({ methodId }) => methodId),
    methodOrder: TARGET_METHODS.map(({ methodId }) => methodId),
    currentMethodIndex: -1,
    currentAtomicStep: 'IDLE',
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: false,
    activeGenerationBatch: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    updatedAt: new Date().toISOString()
  };

  const transaction = new ClassTaskFileTransactionService({ writer });
  const packer = new FormalTestFilePackerService({
    taskId,
    workspaceRoot: WORKSPACE_ROOT,
    moduleRoot: MODULE_ROOT,
    moduleKey: task.moduleKey,
    targetFilePath: SOURCE_FILE_PATH,
    qualifiedClassName: TARGET_FQN,
    buildSettings,
    writer,
    reservations: new GeneratedTestNameReservationService(),
    transaction,
    moduleLock,
    maven: capturedMaven
  });
  const bundles = [];
  let formalArtifacts = [];
  let failure = null;
  let logFinishError = null;
  try {
    for (let index = 0; index < TARGET_METHODS.length; index += 1) {
      const target = TARGET_METHODS[index];
      const formalizedBundle = resumeState?.formalizedBundles.get(target.methodId);
      if (formalizedBundle) {
        bundles.push(structuredClone(formalizedBundle));
        continue;
      }
      const checkpointEventOffset = checkpointEvents.length;
      const restoredCheckpoint = resumeState?.checkpoints.get(target.methodId)
        ?? { completedBatches: [], completedTestMethodPlanIds: [] };
      const bundle = await generator.execute(
        { ...task, currentMethodIndex: index - 1 },
        target.methodId,
        restoredCheckpoint,
        new AbortController().signal
      );
      assert.ok(bundle, `${target.methodName} returned no generated result.`);
      assert.equal(bundle.methodId, target.methodId);
      assert.equal(bundle.methodName, target.methodName);
      const artifact = await packer.append(bundle);
      bundles.push({
        methodId: bundle.methodId,
        methodName: bundle.methodName,
        displaySignature: bundle.displaySignature,
        ordinaryTestMethodCount: bundle.ordinaryTestMethodCount,
        passedTestMethods: bundle.passedTestMethods,
        sourceBatchIds: bundle.sourceBatchIds,
        artifactId: artifact.id,
        formalTestClassName: artifact.testClassName,
        formalFilePath: artifact.filePath
      });
      const committed = checkpointEvents
        .slice(checkpointEventOffset)
        .filter(([kind]) => kind === 'commit')
        .map(([, value]) => value);
      for (const batch of [
        ...restoredCheckpoint.completedBatches,
        ...committed
      ]) {
        if (
          (batch.outcome === 'PASSED' || batch.outcome === 'RETAINED')
          && batch.tmpFilePath
          && batch.tmpFileSha256
        ) {
          await writer.deleteGeneratedTest({
            workspaceRoot: WORKSPACE_ROOT,
            filePath: batch.tmpFilePath,
            expectedSha256: batch.tmpFileSha256
          });
        }
      }
    }
    formalArtifacts = await packer.finish();
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    };
  } finally {
    logFinishError = await logs.finish();
  }
  const sourceAfter = await readFile(SOURCE_FILE_PATH);
  const temporaryTestsAfter = await taskServiceTemporaryTests();
  const currentArtifacts = [
    ...(resumeState?.formalArtifacts ?? []),
    ...transaction.artifacts(taskId)
  ].filter((artifact, index, all) => (
    all.findIndex((candidate) => candidate.id === artifact.id) === index
  ));
  const finalArtifact = currentArtifacts[0] ?? formalArtifacts[0] ?? null;
  const formalFilesAfter = await Promise.all(
    currentArtifacts.map(async (artifact) => ({
      artifact,
      content: await readOptional(artifact.filePath)
    }))
  );
  const formalAfter = formalFilesAfter[0]?.content ?? null;
  const result = {
    runId,
    targetMethods: TARGET_METHODS,
    temporaryTestFilePath: TEST_FILE_PATH,
    temporaryTestFilesBefore: temporaryTestsBefore,
    temporaryTestFilesAfter: temporaryTestsAfter,
    temporaryTestFileExistsAfter: temporaryTestsAfter.length > 0,
    projectTestFilePath: finalArtifact?.filePath ?? null,
    projectTestRelativePath: finalArtifact
      ? relative(WORKSPACE_ROOT, finalArtifact.filePath).replaceAll('\\', '/')
      : null,
    projectTestFileExistsAfter: formalAfter !== null,
    projectTestFilePaths: currentArtifacts.map(({ filePath }) => filePath),
    failure,
    sourceSha256Before: sha256(sourceBefore),
    sourceSha256After: sha256(sourceAfter),
    formalTestSha256After: formalAfter ? sha256(formalAfter) : null,
    modelLogDirectory: MODEL_LOG_DIRECTORY,
    modelName: MODEL_NAME,
    modelBaseUrl: MODEL_BASE_URL,
    modelApiKeyEnvironmentVariable: MODEL_API_KEY_ENV,
    expectedFormalTestClassName: EXPECTED_FORMAL_TEST_CLASS_NAME,
    resumedFromResultPath: resumeState?.resultPath ?? null,
    resumedFromRunId: resumeState?.previousRunId ?? null,
    resumedFromInterruptedResultDirectory:
      resumeState?.interruptedResultDirectory ?? null,
    resumedFromInterruptedResultDirectories:
      resumeState?.interruptedResultDirectories ?? [],
    interruptedRecoveryEvents: resumeState?.replayEvents ?? [],
    interruptedInProgressEvidence: resumeState?.inProgressEvidence ?? null,
    modelHistory: [
      ...new Set([
        ...(resumeState?.replayEvents ?? []).map(({ modelName }) => modelName),
        MODEL_NAME
      ])
    ],
    restoredBatchCounts: Object.fromEntries(
      TARGET_METHODS.map(({ methodId, methodName }) => [
        methodName,
        resumeState?.checkpoints.get(methodId)?.completedBatches.length ?? 0
      ])
    ),
    logFinishError,
    candidateEvents,
    analysisBatchEvents,
    repairContextEvents,
    repairTelemetry,
    mavenAttempts,
    bundles,
    formalArtifacts: currentArtifacts,
    checkpointEvents,
    modelUsageUpdates
  };
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(resolve(resultDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`REAL_TASK_SERVICE_LIVE_REPAIR_RESULT=${resolve(resultDirectory, 'result.json')}\n`);
  process.stdout.write(`REAL_TASK_SERVICE_PROJECT_TEST_FILE=${finalArtifact?.filePath ?? ''}\n`);
  assert.equal(sha256(sourceAfter), EXPECTED_SOURCE_SHA256, 'TaskService.java changed.');
  assert.equal(logFinishError, null, logFinishError ?? undefined);
  assert.equal(failure, null, JSON.stringify(failure));
  assert.deepEqual(
    temporaryTestsAfter,
    [],
    'TaskServiceTmpNTest.java was not cleaned after formal packing.'
  );
  assert.equal(bundles.length, TARGET_METHODS.length);
  assert.ok(currentArtifacts.length >= 1);
  assert.ok(finalArtifact);
  assert.equal(finalArtifact.testClassName, EXPECTED_FORMAL_TEST_CLASS_NAME);
  assert.deepEqual(
    [...new Set(currentArtifacts.flatMap(({ methodIds }) => methodIds))],
    TARGET_METHODS.map(({ methodId }) => methodId)
  );
  assert.deepEqual(
    [...new Set(currentArtifacts.flatMap(({ methodResults }) => (
      methodResults.map(({ methodName }) => methodName)
    )))],
    TARGET_METHODS.map(({ methodName }) => methodName)
  );
  for (const { artifact, content } of formalFilesAfter) {
    assert.ok(content, `${artifact.filePath} does not exist.`);
    const code = content.toString('utf8');
    assert.ok(code.includes(`class ${artifact.testClassName}`));
    assert.doesNotMatch(code, /\bclass TaskServiceTmp\d+Test\b/);
  }
  assert.deepEqual(
    new Set(
      [
        ...analysisBatchEvents
          .filter(({ hasWork }) => hasWork)
          .map(({ methodId }) => methodId),
        ...(resumeState?.formalizedBundles.keys() ?? []),
        ...[...(resumeState?.checkpoints.entries() ?? [])]
          .filter(([, checkpoint]) => checkpoint.completedBatches.length > 0)
          .map(([methodId]) => methodId)
      ]
    ),
    new Set(TARGET_METHODS.map(({ methodId }) => methodId))
  );
});
