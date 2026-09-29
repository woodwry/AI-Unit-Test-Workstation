import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

const RUN_REAL_TEST = process.env.RUN_REAL_INDEX_VO_GENERATION === '1';
const USER_DATA_DIRECTORY = process.env.WORKSTATION_USER_DATA_DIRECTORY
  ?? 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation';
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
  'IndexVO.java'
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
const QUALIFIED_CLASS_NAME = 'com.dtsz.collection.view.vo.IndexVO';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:18101';
const JAVA_ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const RESULT_ROOT = resolve('test-results', 'real-index-vo-live-generation');

test('real IndexVO uses the saved selection and completes one-shot VO generation', {
  skip: !RUN_REAL_TEST,
  timeout: 90 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const storageDirectory = join(RESULT_ROOT, runId);
  const artifactNamespace = `real-index-vo-${randomUUID()}`;
  await mkdir(storageDirectory, { recursive: true });

  const sourceBefore = await readFile(SOURCE_FILE_PATH);
  const filesBefore = await indexVoTestFiles();
  assert.deepEqual(filesBefore, [], 'Fresh verification requires no existing IndexVO test files.');

  for (const healthUrl of [
    new URL('/api/health', AGENT_SERVICE_URL),
    new URL('/api/health', JAVA_ANALYZER_URL)
  ]) {
    const response = await fetch(healthUrl, { redirect: 'error' });
    assert.equal(response.ok, true, `${healthUrl.origin} health returned ${response.status}`);
  }

  const savedTaskDocument = JSON.parse(await readFile(
    join(USER_DATA_DIRECTORY, 'class-tasks-v2.json'),
    'utf8'
  ));
  const savedTask = Object.values(savedTaskDocument.tasks).find((taskSnapshot) => (
    taskSnapshot.qualifiedClassName === QUALIFIED_CLASS_NAME
  ));
  assert.ok(savedTask, 'Saved IndexVO task configuration is missing.');
  assert.equal(savedTask.selectionMode, 'EXPLICIT');
  assert.ok(savedTask.selectedMethodIds.length > 0, 'Saved IndexVO selection is empty.');

  const shell = new ShellService();
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
  const logSettings = new ModelCallLogSettingsService(
    join(USER_DATA_DIRECTORY, 'model-call-log-settings.json')
  );
  const activeLogSettings = await logSettings.get();
  assert.equal(activeLogSettings.enabled, true, 'Model-call logging must be enabled.');

  const client = new AiClient();
  client.setBackendSettings({
    agentServiceUrl: AGENT_SERVICE_URL,
    javaAnalyzerUrl: JAVA_ANALYZER_URL
  });
  const directModelCalls = [];
  const waveModelCalls = [];
  const originalDirectGeneration = client.generateUnitTestPrompt.bind(client);
  client.generateUnitTestPrompt = async (prompt, context, signal) => {
    const call = {
      promptCharacters: prompt.length,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outputCharacters: null,
      error: null
    };
    directModelCalls.push(call);
    try {
      const result = await originalDirectGeneration(prompt, context, signal);
      call.finishedAt = new Date().toISOString();
      call.outputCharacters = result.result.length;
      return result;
    } catch (error) {
      call.finishedAt = new Date().toISOString();
      call.error = safeError(error);
      throw error;
    }
  };
  const originalWaveGeneration = client.streamMethodGenerationWave.bind(client);
  client.streamMethodGenerationWave = async (request, context, onProgress, signal) => {
    waveModelCalls.push({
      methodId: request.methodId,
      waveId: request.waveId,
      partCount: request.parts.length,
      startedAt: new Date().toISOString()
    });
    return originalWaveGeneration(request, context, onProgress, signal);
  };

  const snapshots = [];
  let runtime;
  let catalog;
  let finalSnapshot;
  let runError = null;
  const startedAt = Date.now();
  try {
    runtime = createProductionClassTaskRuntime({
      storageDirectory,
      aiClient: client,
      shellService: shell,
      mavenAnalysisContextService: new MavenAnalysisContextService(shell),
      testWriterService: new TestWriterService(),
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
        snapshots.push({
          state: snapshot.state,
          currentAtomicStep: snapshot.currentAtomicStep,
          activeGenerationBatch: snapshot.activeGenerationBatch,
          updatedAt: snapshot.updatedAt
        });
      }
    });
    await runtime.startup();
    await runtime.addClassTasks({
      workspaceRoot: WORKSPACE_ROOT,
      classFilePaths: [SOURCE_FILE_PATH]
    });
    await runtime.flush();
    const [createdTask] = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT });
    assert.ok(createdTask, 'IndexVO task was not created.');
    assert.equal(createdTask.state, 'READY', JSON.stringify(createdTask.lastError));

    catalog = await runtime.getClassTaskMethods({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: createdTask.id
    });
    const catalogIds = new Set(catalog.methods.map((method) => method.methodId));
    const missingIds = savedTask.selectedMethodIds.filter((methodId) => !catalogIds.has(methodId));
    assert.deepEqual(missingIds, [], 'Saved IndexVO selection no longer matches the analyzer catalog.');
    await runtime.saveMethodSelection({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: createdTask.id,
      selectionMode: 'EXPLICIT',
      selectedMethodIds: [...savedTask.selectedMethodIds],
      methodOrder: [...savedTask.methodOrder],
      ragEnabled: savedTask.ragEnabled,
      repairAttemptLimit: savedTask.repairAttemptLimit,
      unlimitedRepair: savedTask.unlimitedRepair
    });
    finalSnapshot = await runtime.runTask({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: createdTask.id
    });
  } catch (error) {
    runError = safeError(error);
  } finally {
    if (runtime) {
      if (!finalSnapshot) {
        [finalSnapshot] = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT })
          .catch(() => []);
      }
      await runtime.beforeQuit().catch((error) => {
        runError ??= safeError(error);
      });
    }
  }

  const sourceAfter = await readFile(SOURCE_FILE_PATH);
  const filesAfter = await indexVoTestFiles();
  const temporaryFiles = filesAfter.filter((name) => name.includes('Tmp'));
  const formalFiles = filesAfter.filter((name) => !name.includes('Tmp'));
  const result = {
    runId,
    storageDirectory,
    artifactNamespace,
    workspaceRoot: WORKSPACE_ROOT,
    sourceFilePath: SOURCE_FILE_PATH,
    sourceSha256Before: sha256(sourceBefore),
    sourceSha256After: sha256(sourceAfter),
    selectedMethodCount: savedTask.selectedMethodIds.length,
    selectedMethods: catalog?.methods.filter((method) => (
      savedTask.selectedMethodIds.includes(method.methodId)
    )).map((method) => ({
      methodId: method.methodId,
      displaySignature: method.displaySignature
    })) ?? [],
    modelInterface: {
      id: modelRuntime.interfaceId,
      name: modelRuntime.interfaceName,
      model: modelRuntime.llmConfig.model,
      baseUrl: modelRuntime.llmConfig.baseUrl
    },
    modelLogDirectory: activeLogSettings.directory ?? null,
    elapsedMilliseconds: Date.now() - startedAt,
    directModelCalls,
    waveModelCalls,
    finalSnapshot: finalSnapshot ? {
      id: finalSnapshot.id,
      state: finalSnapshot.state,
      currentMethodIndex: finalSnapshot.currentMethodIndex,
      lastError: finalSnapshot.lastError,
      generatedArtifacts: finalSnapshot.generatedArtifacts.map((artifact) => ({
        fileName: basename(artifact.filePath),
        ordinaryTestMethodCount: artifact.ordinaryTestMethodCount,
        methodIds: artifact.methodIds
      }))
    } : null,
    filesAfter,
    temporaryFiles,
    formalFiles,
    snapshots,
    runError
  };
  const resultPath = join(storageDirectory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`REAL_INDEX_VO_RESULT=${resultPath}\n`);

  assert.equal(runError, null, JSON.stringify(runError));
  assert.ok(finalSnapshot);
  assert.equal(finalSnapshot.state, 'COMPLETED', JSON.stringify(finalSnapshot.lastError));
  assert.equal(sha256(sourceAfter), sha256(sourceBefore), 'IndexVO.java changed.');
  assert.equal(directModelCalls.length, 1, JSON.stringify(directModelCalls));
  assert.equal(waveModelCalls.length, 0, JSON.stringify(waveModelCalls));
  assert.deepEqual(temporaryFiles, []);
  assert.ok(formalFiles.length > 0, 'IndexVO formal test file was not generated.');
});

async function indexVoTestFiles() {
  const entries = await readdir(TEST_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => (
      entry.isFile()
      && /^IndexVO(?:Tmp\d+(?:Part\d+)?|\d+)Test\.java$/.test(entry.name)
    ))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null
  };
}
