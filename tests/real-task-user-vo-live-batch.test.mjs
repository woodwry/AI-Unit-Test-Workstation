import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  writeFile
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import { createProductionClassTaskRuntime } from '../src/main/services/class-task-runtime.service.ts';
import { JacocoArtifactsService } from '../src/main/services/jacoco-artifacts.service.ts';
import { MavenAnalysisContextService } from '../src/main/services/maven-analysis-context.service.ts';
import { ModelCallLogSettingsService } from '../src/main/services/model-call-log-settings.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import { SurefireReportService } from '../src/main/services/surefire-report.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';
import { WorkstationBuildSettingsService } from '../src/main/services/workstation-build-settings.service.ts';
import { WorkstationModelInterfaceCredentialsStore } from '../src/main/services/workstation-model-interface-credentials.store.ts';
import { WorkstationModelInterfacesService } from '../src/main/services/workstation-model-interfaces.service.ts';
import { WorkstationModelInterfacesStore } from '../src/main/services/workstation-model-interfaces.store.ts';

const RUN_REAL_TEST = process.env.RUN_REAL_TASK_USER_VO_BATCH === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const MODULE_ROOT = join(WORKSPACE_ROOT, 'collection-core');
const SOURCE_FILE_PATH = join(
  MODULE_ROOT,
  'src',
  'main',
  'java',
  'com',
  'dtsz',
  'collection',
  'view',
  'vo',
  'TaskUserVO.java'
);
const TEST_DIRECTORY = join(
  MODULE_ROOT,
  'src',
  'test',
  'java',
  'com',
  'dtsz',
  'collection',
  'view',
  'vo'
);
const QUALIFIED_CLASS_NAME = 'com.dtsz.collection.view.vo.TaskUserVO';
const EXPECTED_METHOD_COUNT = 28;
const EXPECTED_MODEL = 'deepseek-v4-flash';
const USER_DATA_DIRECTORY = process.env.WORKSTATION_USER_DATA_DIRECTORY
  ?? 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:18000';
const JAVA_ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const RESULT_ROOT = resolve('test-results', 'real-task-user-vo-live-batch');

class TrackingTestWriterService extends TestWriterService {
  activeTemporaryFiles = new Set();
  temporaryEvents = [];
  maxConcurrentTemporaryFiles = 0;

  async writePreparedGeneratedTest(prepared) {
    const written = await super.writePreparedGeneratedTest(prepared);
    if (isTaskUserTemporaryFile(written.testFilePath)) {
      this.activeTemporaryFiles.add(written.testFilePath);
      this.maxConcurrentTemporaryFiles = Math.max(
        this.maxConcurrentTemporaryFiles,
        this.activeTemporaryFiles.size
      );
      this.temporaryEvents.push({
        operation: 'created',
        fileName: basename(written.testFilePath),
        activeCount: this.activeTemporaryFiles.size,
        at: new Date().toISOString()
      });
    }
    return written;
  }

  async deleteGeneratedTest(input) {
    await super.deleteGeneratedTest(input);
    if (isTaskUserTemporaryFile(input.filePath)) {
      this.activeTemporaryFiles.delete(input.filePath);
      this.temporaryEvents.push({
        operation: 'deleted',
        fileName: basename(input.filePath),
        activeCount: this.activeTemporaryFiles.size,
        at: new Date().toISOString()
      });
    }
  }
}

test('real TaskUserVO sends all 28 selected methods in one model call', {
  skip: !RUN_REAL_TEST,
  timeout: 60 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const storageDirectory = join(RESULT_ROOT, runId);
  const artifactNamespace = `real-task-user-vo-${randomUUID()}`;
  await mkdir(storageDirectory, { recursive: true });

  const sourceBefore = await readFile(SOURCE_FILE_PATH);
  const existingFiles = await taskUserTestFiles();
  assert.deepEqual(existingFiles, [], 'Fresh verification requires no existing TaskUserVO test files.');

  const nativeFetch = globalThis.fetch.bind(globalThis);
  for (const healthUrl of [
    new URL('/api/health', AGENT_SERVICE_URL),
    new URL('/api/health', JAVA_ANALYZER_URL)
  ]) {
    const response = await nativeFetch(healthUrl, { redirect: 'error' });
    assert.equal(response.ok, true, `${healthUrl.origin} health returned ${response.status}`);
  }

  const client = new AiClient();
  client.setBackendSettings({
    agentServiceUrl: AGENT_SERVICE_URL,
    javaAnalyzerUrl: JAVA_ANALYZER_URL
  });
  const modelCalls = [];
  const forbiddenSingleMethodFallbacks = [];
  const measuredAiClient = {
    createMethodAnalysisSession: client.createMethodAnalysisSession.bind(client),
    probeModelToolCalling: client.probeModelToolCalling.bind(client),
    heartbeatMethodAnalysisSession: client.heartbeatMethodAnalysisSession.bind(client),
    classifyUnitTestTarget: client.classifyUnitTestTarget.bind(client),
    nextMethodBatch: client.nextMethodBatch.bind(client),
    getMethodRepairContext: client.getMethodRepairContext.bind(client),
    refreshMethodAnalysisCoverage: client.refreshMethodAnalysisCoverage.bind(client),
    async startMethodGenerationStream(request) {
      forbiddenSingleMethodFallbacks.push({
        operation: 'startMethodGenerationStream',
        methodId: request?.methodId ?? null,
        at: new Date().toISOString()
      });
      throw new Error('SINGLE_METHOD_FALLBACK_DETECTED');
    },
    async recoverMethodGenerationStream(request) {
      forbiddenSingleMethodFallbacks.push({
        operation: 'recoverMethodGenerationStream',
        methodId: request?.methodId ?? null,
        at: new Date().toISOString()
      });
      throw new Error('SINGLE_METHOD_FALLBACK_DETECTED');
    },
    prepareRagRepair: client.prepareRagRepair.bind(client),
    resumeMethodGenerationStream: client.resumeMethodGenerationStream.bind(client),
    acknowledgeMethodGenerationEvents: client.acknowledgeMethodGenerationEvents.bind(client),
    cancelMethodGeneration: client.cancelMethodGeneration.bind(client),
    async generateUnitTestPrompt(prompt, modelContext, signal) {
      if (modelCalls.length >= 1) {
        throw new Error('UNEXPECTED_EXTRA_BATCH_MODEL_CALL');
      }
      const call = {
        model: modelContext.llmConfig.model,
        promptCharacters: prompt.length,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outputCharacters: null,
        usage: null,
        error: null
      };
      modelCalls.push(call);
      try {
        const generated = await client.generateUnitTestPrompt(prompt, modelContext, signal);
        call.finishedAt = new Date().toISOString();
        call.outputCharacters = generated.result.length;
        call.usage = generated.usage;
        return generated;
      } catch (error) {
        call.finishedAt = new Date().toISOString();
        call.error = errorRecord(error);
        throw error;
      }
    },
    generateTargetJacocoReport: client.generateTargetJacocoReport.bind(client)
  };

  const shell = new ShellService();
  const mavenCalls = [];
  const measureMaven = async (operation, args, execute) => {
    const call = {
      operation,
      testTarget: Array.isArray(args[2]) ? [...args[2]] : args[2] ?? null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null
    };
    mavenCalls.push(call);
    try {
      const result = await execute();
      call.exitCode = result.exitCode;
      return result;
    } catch (error) {
      call.error = errorRecord(error);
      throw error;
    } finally {
      call.finishedAt = new Date().toISOString();
    }
  };
  const measuredShell = {
    validateBuildSettings: shell.validateBuildSettings.bind(shell),
    runMavenModuleTestsWithJacoco: (...args) => measureMaven(
      'runMavenModuleTestsWithJacoco', args,
      () => shell.runMavenModuleTestsWithJacoco(...args)
    ),
    runMavenDirectTestsWithJacoco: (...args) => measureMaven(
      'runMavenDirectTestsWithJacoco', args,
      () => shell.runMavenDirectTestsWithJacoco(...args)
    ),
    runMavenGeneratedTestCompile: (...args) => measureMaven(
      'runMavenGeneratedTestCompile', args,
      () => shell.runMavenGeneratedTestCompile(...args)
    ),
    runMavenGeneratedSurefireTest: (...args) => measureMaven(
      'runMavenGeneratedSurefireTest', args,
      () => shell.runMavenGeneratedSurefireTest(...args)
    ),
    runMavenDirectTestsWithJacocoAppend: (...args) => measureMaven(
      'runMavenDirectTestsWithJacocoAppend', args,
      () => shell.runMavenDirectTestsWithJacocoAppend(...args)
    )
  };

  const buildSettingsStore = new WorkstationBuildSettingsService(
    join(USER_DATA_DIRECTORY, 'workstation-build-settings.json'),
    'win32',
    'C:\\Users\\wry'
  );
  const storedBuildSettings = await buildSettingsStore.get();
  assert.ok(storedBuildSettings, 'Workstation build settings are missing.');
  const validation = await shell.validateBuildSettings(storedBuildSettings, WORKSPACE_ROOT);
  assert.equal(validation.valid, true, validation.error);
  const buildSettings = { ...storedBuildSettings, validation };

  const unavailableCipher = {
    isEncryptionAvailable: () => false,
    encryptString() { throw new Error('Direct credential encryption is unavailable in this test.'); },
    decryptString() { throw new Error('Direct credential decryption is unavailable in this test.'); }
  };
  const modelInterfaces = new WorkstationModelInterfacesService(
    new WorkstationModelInterfacesStore(
      join(USER_DATA_DIRECTORY, 'workstation-model-interfaces.json')
    ),
    new WorkstationModelInterfaceCredentialsStore(
      join(USER_DATA_DIRECTORY, 'workstation-model-interface-credentials.json')
    ),
    unavailableCipher
  );
  const modelRuntime = await modelInterfaces.resolveForGeneration();
  assert.equal(modelRuntime.llmConfig.model, EXPECTED_MODEL);
  const logSettings = new ModelCallLogSettingsService(
    join(USER_DATA_DIRECTORY, 'model-call-log-settings.json')
  );
  const activeLogSettings = await logSettings.get();
  assert.equal(activeLogSettings.enabled, true, 'Model-call logging must be enabled.');

  const writer = new TrackingTestWriterService();
  const snapshotTimeline = [];
  const observedGenerationBatches = new Map();
  let runtime;
  let catalog;
  let finalSnapshot;
  let runError = null;
  const startedAt = Date.now();
  try {
    runtime = createProductionClassTaskRuntime({
      storageDirectory,
      aiClient: measuredAiClient,
      shellService: measuredShell,
      mavenAnalysisContextService: new MavenAnalysisContextService(shell),
      testWriterService: writer,
      jacocoArtifactsService: new JacocoArtifactsService(undefined, artifactNamespace),
      surefireReportService: new SurefireReportService(),
      buildSettingsService: {
        async get() { return structuredClone(buildSettings); },
        resolveMavenHomeDefaults: buildSettingsStore.resolveMavenHomeDefaults
          .bind(buildSettingsStore)
      },
      modelInterfacesService: modelInterfaces,
      modelCallLogSettingsService: logSettings,
      broadcast(snapshot) {
        snapshotTimeline.push({
          state: snapshot.state,
          atomicStep: snapshot.currentAtomicStep,
          completedMethodCount: snapshot.currentMethodIndex + 1,
          activeGenerationBatch: snapshot.activeGenerationBatch
            ? { ...snapshot.activeGenerationBatch }
            : null,
          at: new Date().toISOString()
        });
        if (snapshot.activeGenerationBatch) {
          const key = `${snapshot.activeGenerationBatch.methodCount}/${snapshot.activeGenerationBatch.scenarioCount}`;
          if (!observedGenerationBatches.has(key)) {
            observedGenerationBatches.set(key, {
              ...snapshot.activeGenerationBatch,
              firstSeenAt: new Date().toISOString()
            });
          }
        }
      }
    });

    await runtime.startup();
    await runtime.addClassTasks({
      workspaceRoot: WORKSPACE_ROOT,
      classFilePaths: [SOURCE_FILE_PATH]
    });
    await runtime.flush();
    const [taskSnapshot] = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT });
    assert.ok(taskSnapshot, 'TaskUserVO class task was not created.');
    assert.equal(taskSnapshot.state, 'READY', JSON.stringify(taskSnapshot.lastError));

    catalog = await runtime.getClassTaskMethods({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: taskSnapshot.id
    });
    const selectedMethods = catalog.methods.filter((method) => method.generatable);
    assert.equal(selectedMethods.length, EXPECTED_METHOD_COUNT);
    const methodIds = selectedMethods.map((method) => method.methodId);
    await runtime.saveMethodSelection({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: taskSnapshot.id,
      selectionMode: 'EXPLICIT',
      selectedMethodIds: methodIds,
      methodOrder: methodIds,
      ragEnabled: false,
      repairAttemptLimit: 3,
      unlimitedRepair: false
    });
    finalSnapshot = await runtime.runTask({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: taskSnapshot.id
    });
  } catch (error) {
    runError = errorRecord(error);
  } finally {
    if (runtime) {
      if (!finalSnapshot) {
        [finalSnapshot] = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT })
          .catch(() => []);
      }
      await runtime.beforeQuit().catch((error) => {
        runError ??= errorRecord(error);
      });
    }
  }

  const sourceAfter = await readFile(SOURCE_FILE_PATH);
  const filesAfter = await taskUserTestFiles();
  const temporaryFilesAfter = filesAfter.filter((name) => /^TaskUserVOTmp\d+Test\.java$/.test(name));
  const formalFilesAfter = filesAfter.filter((name) => /^TaskUserVO\d+Test\.java$/.test(name));
  const formalFileDetails = await Promise.all(formalFilesAfter.map(async (fileName) => {
    const content = await readFile(join(TEST_DIRECTORY, fileName), 'utf8');
    return {
      fileName,
      sha256: sha256(content),
      testMethodCount: [...content.matchAll(/@Test\b/g)].length
    };
  }));
  const compileTargets = mavenCalls
    .filter((call) => call.operation === 'runMavenGeneratedTestCompile')
    .map((call) => call.testTarget);
  const surefireTargets = mavenCalls
    .filter((call) => call.operation === 'runMavenGeneratedSurefireTest')
    .map((call) => call.testTarget);
  const result = {
    runId,
    storageDirectory,
    artifactNamespace,
    workspaceRoot: WORKSPACE_ROOT,
    sourceFilePath: SOURCE_FILE_PATH,
    sourceSha256Before: sha256(sourceBefore),
    sourceSha256After: sha256(sourceAfter),
    modelInterface: {
      id: modelRuntime.interfaceId,
      name: modelRuntime.interfaceName,
      model: modelRuntime.llmConfig.model,
      baseUrl: modelRuntime.llmConfig.baseUrl
    },
    modelLogDirectory: activeLogSettings.directory ?? null,
    elapsedMilliseconds: Date.now() - startedAt,
    catalogMethodCount: catalog?.methods.length ?? null,
    generatableMethodCount: catalog?.methods.filter((method) => method.generatable).length ?? null,
    selectedMethods: catalog?.methods.filter((method) => method.generatable).map((method) => ({
      methodId: method.methodId,
      methodName: method.methodName,
      displaySignature: method.displaySignature
    })) ?? [],
    finalSnapshot: finalSnapshot ? {
      id: finalSnapshot.id,
      state: finalSnapshot.state,
      currentMethodIndex: finalSnapshot.currentMethodIndex,
      lastError: finalSnapshot.lastError,
      artifacts: finalSnapshot.generatedArtifacts.map((artifact) => ({
        fileName: basename(artifact.filePath),
        testClassName: artifact.testClassName,
        ordinaryTestMethodCount: artifact.ordinaryTestMethodCount,
        methodIds: [...artifact.methodIds],
        sealed: artifact.sealed
      }))
    } : null,
    observedGenerationBatches: [...observedGenerationBatches.values()],
    modelCalls,
    forbiddenSingleMethodFallbacks,
    mavenCalls,
    compileTargets,
    surefireTargets,
    temporaryEvents: writer.temporaryEvents,
    maxConcurrentTemporaryFiles: writer.maxConcurrentTemporaryFiles,
    filesAfter,
    temporaryFilesAfter,
    formalFileDetails,
    snapshotTimeline,
    runError
  };
  const resultPath = join(storageDirectory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`REAL_TASK_USER_VO_BATCH_RESULT=${resultPath}\n`);

  assert.equal(runError, null, JSON.stringify(runError));
  assert.ok(finalSnapshot);
  assert.equal(finalSnapshot.state, 'COMPLETED', JSON.stringify(finalSnapshot.lastError));
  assert.equal(sha256(sourceAfter), sha256(sourceBefore), 'TaskUserVO.java changed.');
  assert.equal(forbiddenSingleMethodFallbacks.length, 0, 'Batch generation fell back to one model call per method.');
  assert.equal(modelCalls.length, 1, JSON.stringify(modelCalls));
  assert.equal(writer.maxConcurrentTemporaryFiles, 1);
  assert.deepEqual(temporaryFilesAfter, []);
  assert.deepEqual(formalFilesAfter, ['TaskUserVO1Test.java', 'TaskUserVO2Test.java']);
  assert.deepEqual(
    formalFileDetails.map((file) => file.testMethodCount),
    [15, 13]
  );
  assert.deepEqual(
    finalSnapshot.generatedArtifacts.map((artifact) => artifact.ordinaryTestMethodCount),
    [15, 13]
  );
  assert.equal(
    new Set(finalSnapshot.generatedArtifacts.flatMap((artifact) => artifact.methodIds)).size,
    EXPECTED_METHOD_COUNT
  );
  assert.deepEqual(
    compileTargets.filter((target) => target.includes('TaskUserVOTmp')),
    ['com.dtsz.collection.view.vo.TaskUserVOTmp1Test']
  );
  assert.deepEqual(
    [...new Set(compileTargets.filter((target) => !target.includes('TaskUserVOTmp')))],
    [
      'com.dtsz.collection.view.vo.TaskUserVO1Test',
      'com.dtsz.collection.view.vo.TaskUserVO2Test'
    ]
  );
  assert.deepEqual(surefireTargets, compileTargets);
});

async function taskUserTestFiles() {
  const entries = await readdir(TEST_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^TaskUserVO(?:Tmp)?\d+Test\.java$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function isTaskUserTemporaryFile(filePath) {
  return /^TaskUserVOTmp\d+Test\.java$/.test(basename(filePath));
}

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
