import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import { CandidateChangeValidator } from '../src/main/services/candidate-change-validator.service.ts';
import { ClassTaskFileTransactionService } from '../src/main/services/class-task-file-transaction.service.ts';
import { FormalTestFilePackerService } from '../src/main/services/formal-test-file-packer.service.ts';
import { GeneratedTestFailurePrunerService } from '../src/main/services/generated-test-failure-pruner.service.ts';
import { GeneratedTestNameReservationService } from '../src/main/services/generated-test-name-reservation.service.ts';
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

const RUN_REAL_TEST = process.env.RUN_REAL_TASK_SERVICE_FLOW_SMOKE === '1';
const VERIFY_EXISTING = process.env.VERIFY_REAL_TASK_SERVICE_FLOW_SMOKE === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const MODULE_ROOT = `${WORKSPACE_ROOT}\\collection-core`;
const SOURCE_FILE_PATH = `${MODULE_ROOT}\\src\\main\\java\\com\\dtsz\\collection\\model\\service\\TaskService.java`;
const TEST_DIRECTORY = `${MODULE_ROOT}\\src\\test\\java\\com\\dtsz\\collection\\model\\service`;
const TARGET_FQN = 'com.dtsz.collection.model.service.TaskService';
const TARGET_METHOD = Object.freeze({
  methodId: '2a70ba6e44d42fea754587cb89adaf3ceab037106ba79f6c5570e5e0d02db37f',
  methodName: 'getDimensionsFilter'
});
const TEMPORARY_BATCH_INDEX_OFFSET = 23;
const TEMPORARY_CLASS_NAME = 'TaskServiceTmp24Test';
const TEMPORARY_FILE_PATH = `${TEST_DIRECTORY}\\${TEMPORARY_CLASS_NAME}.java`;
const ANALYSIS_CLASS_NAME = 'TaskServiceFlowSmokeAnalysisPlaceholderTest';
const ANALYSIS_FILE_PATH = `${TEST_DIRECTORY}\\${ANALYSIS_CLASS_NAME}.java`;
const BUILD_SETTINGS_PATH = 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation\\workstation-build-settings.json';
const ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const AGENT_URL = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:18000';
const MODEL_NAME = process.env.REAL_FLOW_MODEL_NAME ?? 'qwen3.8-2.4t-a95b';
const MODEL_BASE_URL = process.env.REAL_FLOW_MODEL_BASE_URL
  ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL_API_KEY_ENV = process.env.REAL_FLOW_MODEL_API_KEY_ENV ?? 'DASHSCOPE_API_KEY';
const MODEL_LOG_DIRECTORY = process.env.REAL_FLOW_MODEL_LOG_DIRECTORY
  ?? 'C:\\Users\\wry\\Desktop\\日志';
const RESULT_ROOT = process.env.REAL_TASK_SERVICE_FLOW_RESULT_ROOT?.trim()
  || resolve('test-results', 'real-task-service-flow-smoke');
const REPORT_PATH = `${MODULE_ROOT}\\target\\ai-unit-test\\jacoco\\preload\\34d6957bf4516a1494153d2f36d516974108bb8c2b9b8c3bd24413d8774d28bf\\classes\\81d91af73919fb343ddb3c08061507e73c7643e0c34e6463e9ac8e58afb4d693.xml`;
const BRANCH_PATH = REPORT_PATH.replace(/\.xml$/, '.branches.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null
  };
}

test('runs one complete real TaskService generation flow without exhaustive path generation', {
  skip: !RUN_REAL_TEST,
  timeout: 60 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const resultDirectory = resolve(RESULT_ROOT, runId);
  await mkdir(resultDirectory, { recursive: true });
  const taskId = randomUUID();
  const sourceBefore = await readFile(SOURCE_FILE_PATH);
  const temporaryBefore = await readFile(TEMPORARY_FILE_PATH).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(temporaryBefore, null, `${TEMPORARY_CLASS_NAME}.java already exists.`);

  const healthChecks = await Promise.all([
    fetch(new URL('/api/health', AGENT_URL)),
    fetch(new URL('/api/health', ANALYZER_URL))
  ]);
  healthChecks.forEach((response) => assert.equal(response.ok, true));

  const shell = new ShellService();
  const buildSettingsService = new WorkstationBuildSettingsService(
    BUILD_SETTINGS_PATH,
    'win32',
    'C:\\Users\\wry'
  );
  const buildSettings = await buildSettingsService.get();
  assert.ok(buildSettings, 'Workstation build settings are missing.');
  const validation = await shell.validateBuildSettings(buildSettings, MODULE_ROOT, {
    excludedEnvironmentVariables: [MODEL_API_KEY_ENV]
  });
  assert.equal(validation.valid, true, JSON.stringify(validation));

  const branchSnapshot = JSON.parse(await readFile(BRANCH_PATH, 'utf8'));
  assert.equal(branchSnapshot.targetClass, TARGET_FQN);
  assert.match(branchSnapshot.pairId ?? '', /^[0-9a-f]{64}$/);
  assert.equal(branchSnapshot.targetSourceSha256, sha256(sourceBefore));

  const analysisInput = await new MavenAnalysisContextService(shell).collect({
    workspaceRoot: WORKSPACE_ROOT,
    moduleRoot: MODULE_ROOT,
    targetSourcePath: SOURCE_FILE_PATH,
    targetClass: TARGET_FQN,
    plannedTestClassName: ANALYSIS_CLASS_NAME,
    plannedRelativeTestPath: relative(WORKSPACE_ROOT, ANALYSIS_FILE_PATH).replaceAll('\\', '/'),
    reportPath: REPORT_PATH,
    branchSnapshotPath: BRANCH_PATH,
    reportPairId: branchSnapshot.pairId,
    buildSettings,
    buildToolchain: {
      javaVersion: validation.javaVersion,
      mavenVersion: validation.mavenVersion
    },
    customModelEnvironmentVariable: MODEL_API_KEY_ENV
  });

  const client = new AiClient();
  client.setBackendSettings({ agentServiceUrl: AGENT_URL, javaAnalyzerUrl: ANALYZER_URL });
  const analysisSessionId = randomUUID();
  const analysis = await client.createMethodAnalysisSession({
    ...analysisInput,
    analysisSessionId
  });
  const methodCatalog = await client.getMethodCatalog(analysis.analysisSessionId);
  const targetCatalogEntry = methodCatalog.methods.find(
    (method) => method.methodId === TARGET_METHOD.methodId
  );
  assert.ok(targetCatalogEntry, 'Target TaskService method is absent from the Analyzer catalog.');
  assert.equal(targetCatalogEntry.methodName, TARGET_METHOD.methodName);
  assert.equal(targetCatalogEntry.lineMissed, 1);

  const apiKey = process.env[MODEL_API_KEY_ENV] ?? '';
  assert.ok(apiKey, `${MODEL_API_KEY_ENV} is not configured.`);
  const llmConfig = {
    provider: 'custom_openai',
    model: MODEL_NAME,
    baseUrl: MODEL_BASE_URL,
    credentials: { apiKey }
  };

  const logs = new MethodGenerationLogService();
  await mkdir(MODEL_LOG_DIRECTORY, { recursive: true });
  await logs.begin({ enabled: true, directory: MODEL_LOG_DIRECTORY });
  const checkpointEvents = [];
  const modelUsage = [];
  const batchEvents = [];
  const candidateEvents = [];
  const mavenAttempts = [];
  let logFinishError = null;

  const analyzer = {
    heartbeatMethodAnalysisSession: client.heartbeatMethodAnalysisSession.bind(client),
    async nextMethodBatch(...args) {
      const response = await client.nextMethodBatch(...args);
      batchEvents.push({
        batchId: response.batchId,
        hasWork: response.hasWork,
        plannedTestMethods: response.plannedTestMethods,
        remainingTestMethods: response.remainingTestMethods
      });
      return response;
    },
    getMethodRepairContext: client.getMethodRepairContext.bind(client)
  };
  const agent = {
    async startMethodGenerationStream(...args) {
      const result = await client.startMethodGenerationStream(...args);
      candidateEvents.push({
        stage: 'start',
        kind: result.kind,
        candidateVersion: result.kind === 'candidate_ready'
          ? result.candidate.candidateVersion
          : null,
        repairAttempt: result.kind === 'candidate_ready'
          ? result.candidate.repairAttempt
          : null
      });
      return result;
    },
    async resumeMethodGenerationStream(...args) {
      const result = await client.resumeMethodGenerationStream(...args);
      candidateEvents.push({
        stage: 'resume',
        kind: result.kind,
        candidateVersion: result.kind === 'candidate_ready'
          ? result.candidate.candidateVersion
          : null,
        repairAttempt: result.kind === 'candidate_ready'
          ? result.candidate.repairAttempt
          : null
      });
      return result;
    },
    acknowledgeMethodGenerationEvents: client.acknowledgeMethodGenerationEvents.bind(client),
    cancelMethodGeneration: client.cancelMethodGeneration.bind(client)
  };
  const checkpoints = {
    async beginAtomicStep(_taskId, value) { checkpointEvents.push(['begin', value]); },
    async completeAtomicStep(_taskId, value) { checkpointEvents.push(['end', value]); },
    async saveInProgressBatch(value) {
      checkpointEvents.push(['save_in_progress', structuredClone(value)]);
    },
    async clearInProgressBatch(_taskId, methodId, batchId) {
      checkpointEvents.push(['clear_in_progress', { methodId, batchId }]);
    },
    async commitBatch(value) { checkpointEvents.push(['commit', structuredClone(value)]); },
    async addModelUsage(_taskId, value) { modelUsage.push(structuredClone(value)); }
  };

  const rawMaven = new MavenCandidateExecutorService(shell, new SurefireReportService());
  const maven = {
    async execute(input) {
      const result = await rawMaven.execute(input);
      const attemptNumber = mavenAttempts.length + 1;
      const fileName = `maven-attempt-${String(attemptNumber).padStart(2, '0')}.json`;
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
    analyzer,
    agent,
    contextProvider: {
      async resolve() {
        return {
          analysisSessionId,
          reportPairId: analysis.reportPairId,
          sourceSha256: analysis.sourceSha256,
          packageName: 'com.dtsz.collection.model.service',
          plannedRelativeTestPath: relative(WORKSPACE_ROOT, TEMPORARY_FILE_PATH).replaceAll('\\', '/'),
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
    maven,
    pruner: new GeneratedTestFailurePrunerService(),
    merger: new MethodTestBundleMergerService(),
    logs,
    diagnostic: new MavenRepairDiagnosticService(),
    candidateChanges: new CandidateChangeValidator()
  });
  const taskSnapshot = {
    id: taskId,
    workspaceRoot: WORKSPACE_ROOT,
    sourceFilePath: SOURCE_FILE_PATH,
    qualifiedClassName: TARGET_FQN,
    moduleKey: `${MODULE_ROOT.toLowerCase().replaceAll('\\', '/')}/pom.xml`,
    moduleDisplayPath: MODULE_ROOT,
    state: 'RUNNING',
    preloadState: 'READY',
    ragEnabled: false,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: [TARGET_METHOD.methodId],
    methodOrder: [TARGET_METHOD.methodId],
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

  let bundle = null;
  let artifact = null;
  let formalArtifacts = [];
  let failure = null;
  const transaction = new ClassTaskFileTransactionService({ writer });
  const packer = new FormalTestFilePackerService({
    taskId,
    workspaceRoot: WORKSPACE_ROOT,
    moduleRoot: MODULE_ROOT,
    moduleKey: taskSnapshot.moduleKey,
    targetFilePath: SOURCE_FILE_PATH,
    qualifiedClassName: TARGET_FQN,
    buildSettings,
    writer,
    reservations: new GeneratedTestNameReservationService(),
    transaction,
    moduleLock,
    maven
  });
  try {
    bundle = await generator.execute(
      taskSnapshot,
      TARGET_METHOD.methodId,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal,
      { temporaryBatchIndexOffset: TEMPORARY_BATCH_INDEX_OFFSET }
    );
    assert.ok(bundle, 'TaskService smoke generation returned no bundle.');
    artifact = await packer.append(bundle);
    const committed = checkpointEvents
      .filter(([kind]) => kind === 'commit')
      .map(([, value]) => value);
    for (const batch of committed) {
      if (batch.tmpFilePath && batch.tmpFileSha256) {
        await writer.deleteGeneratedTest({
          workspaceRoot: WORKSPACE_ROOT,
          filePath: batch.tmpFilePath,
          expectedSha256: batch.tmpFileSha256
        });
      }
    }
    formalArtifacts = await packer.finish();
  } catch (error) {
    failure = errorRecord(error);
  } finally {
    logFinishError = await logs.finish();
  }

  const sourceAfter = await readFile(SOURCE_FILE_PATH);
  const temporaryAfter = await readFile(TEMPORARY_FILE_PATH).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const result = {
    runId,
    resultDirectory,
    targetMethod: TARGET_METHOD,
    model: { provider: 'custom_openai', model: MODEL_NAME, baseUrl: MODEL_BASE_URL },
    sourceSha256Before: sha256(sourceBefore),
    sourceSha256After: sha256(sourceAfter),
    targetCatalogEntry,
    batchEvents,
    candidateEvents,
    checkpointEvents,
    modelUsage,
    mavenAttempts,
    bundle,
    artifact,
    formalArtifacts,
    temporaryFileRemaining: temporaryAfter !== null,
    modelLogDirectory: MODEL_LOG_DIRECTORY,
    logFinishError: logFinishError ? errorRecord(logFinishError) : null,
    failure
  };
  const resultPath = resolve(resultDirectory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`REAL_TASK_SERVICE_FLOW_SMOKE_RESULT=${resultPath}\n`);

  assert.equal(failure, null, JSON.stringify(failure));
  assert.equal(sha256(sourceAfter), sha256(sourceBefore), 'TaskService.java changed.');
  assert.equal(temporaryAfter, null, `${TEMPORARY_CLASS_NAME}.java was not cleaned.`);
  assert.ok(bundle.ordinaryTestMethodCount > 0);
  assert.equal(bundle.sourceBatchIds.length, 1);
  assert.ok(artifact);
  assert.ok(formalArtifacts.length >= 1);
  assert.equal(mavenAttempts.every((attempt) => attempt.status === 'passed'), true);
  assert.equal(logFinishError, null);
});

test('verifies the completed TaskService smoke artifacts without another model call', {
  skip: !VERIFY_EXISTING,
  timeout: 15 * 60_000
}, async () => {
  const evidenceDirectory = process.env.REAL_TASK_SERVICE_FLOW_EVIDENCE_DIR?.trim();
  assert.ok(evidenceDirectory, 'REAL_TASK_SERVICE_FLOW_EVIDENCE_DIR is required.');
  const firstAttempt = JSON.parse(await readFile(
    resolve(evidenceDirectory, 'maven-attempt-01.json'),
    'utf8'
  ));
  const secondAttempt = JSON.parse(await readFile(
    resolve(evidenceDirectory, 'maven-attempt-02.json'),
    'utf8'
  ));
  assert.equal(firstAttempt.result.status, 'passed');
  assert.equal(firstAttempt.input.qualifiedTestClassName, `com.dtsz.collection.model.service.${TEMPORARY_CLASS_NAME}`);
  assert.equal(secondAttempt.result.status, 'passed');
  assert.equal(secondAttempt.input.qualifiedTestClassName, 'com.dtsz.collection.model.service.TaskService5Test');

  const formalPath = `${TEST_DIRECTORY}\\TaskService5Test.java`;
  const formalCode = await readFile(formalPath, 'utf8');
  assert.match(formalCode, /class\s+TaskService5Test\b/);
  assert.match(formalCode, /taskService\.getDimensionsFilter\(dimensions\)/);
  const temporaryCode = await readFile(TEMPORARY_FILE_PATH).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(temporaryCode, null, `${TEMPORARY_CLASS_NAME}.java still exists.`);

  const maven = new MavenCandidateExecutorService(
    new ShellService(),
    new SurefireReportService()
  );
  const verification = await maven.execute({
    ...secondAttempt.input,
    attemptId: randomUUID()
  });
  assert.equal(verification.status, 'passed');
  const resultPath = resolve(evidenceDirectory, 'evidence-verification.json');
  await writeFile(resultPath, `${JSON.stringify({
    verifiedAt: new Date().toISOString(),
    formalPath,
    formalSha256: sha256(formalCode),
    firstAttempt: {
      status: firstAttempt.result.status,
      qualifiedTestClassName: firstAttempt.input.qualifiedTestClassName
    },
    secondAttempt: {
      status: secondAttempt.result.status,
      qualifiedTestClassName: secondAttempt.input.qualifiedTestClassName
    },
    verification
  }, null, 2)}\n`);
  process.stdout.write(`REAL_TASK_SERVICE_FLOW_EVIDENCE=${resultPath}\n`);
});
