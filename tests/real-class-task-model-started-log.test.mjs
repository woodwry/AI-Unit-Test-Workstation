import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import {
  createProductionClassTaskRuntime
} from '../src/main/services/class-task-runtime.service.ts';
import {
  JacocoArtifactsService
} from '../src/main/services/jacoco-artifacts.service.ts';
import {
  MavenAnalysisContextService
} from '../src/main/services/maven-analysis-context.service.ts';
import {
  ModelCallLogSettingsService
} from '../src/main/services/model-call-log-settings.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import {
  SurefireReportService
} from '../src/main/services/surefire-report.service.ts';
import {
  TestWriterService
} from '../src/main/services/test-writer.service.ts';
import {
  WorkstationBuildSettingsService
} from '../src/main/services/workstation-build-settings.service.ts';

const RUN_REAL_TEST = process.env.RUN_REAL_CLASS_TASK_STARTED_LOG === '1';
const USER_DATA_DIRECTORY = process.env.WORKSTATION_USER_DATA_DIRECTORY
  ?? 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation';
const WORKSPACE_ROOT = process.env.REAL_CLASS_TASK_WORKSPACE_ROOT
  ?? 'D:\\DTSZTMP\\collection';
const SOURCE_FILE_PATH = process.env.REAL_CLASS_TASK_SOURCE_FILE_PATH ?? join(
  WORKSPACE_ROOT,
  'collection-core',
  'src',
  'main',
  'java',
  'com',
  'dtsz',
  'collection',
  'model',
  'service',
  'TaskService.java'
);
const PRODUCTION_SOURCE_MARKER = `${join('src', 'main', 'java')}\\`;
const MODULE_ROOT = SOURCE_FILE_PATH.slice(
  0,
  SOURCE_FILE_PATH.indexOf(PRODUCTION_SOURCE_MARKER)
);
const QUALIFIED_CLASS_NAME = process.env.REAL_CLASS_TASK_QUALIFIED_CLASS_NAME
  ?? 'com.dtsz.collection.model.service.TaskService';
const METHOD_NAME = process.env.REAL_CLASS_TASK_METHOD_NAME ?? 'getChildZipFile';
const TASK_ID = process.env.REAL_CLASS_TASK_ID ?? randomUUID();
const METHOD_ID = process.env.REAL_CLASS_TASK_METHOD_ID
  ?? '3a0612e55cbe809b102be166a7994d6ecfb5cac3fc5785d682d429d415f28442';
const EXPECTED_MODEL = process.env.NO_NETWORK_BOUNDARY_MODEL ?? 'glm-5.2';
const EXPECTED_BASE_URL = (
  process.env.NO_NETWORK_BOUNDARY_BASE_URL ?? 'http://127.0.0.1:9/v1'
).replace(/\/+$/, '');
const REPAIR_ATTEMPT_LIMIT = Number.parseInt(
  process.env.REAL_CLASS_TASK_REPAIR_ATTEMPT_LIMIT ?? '5',
  10
);
const UNLIMITED_REPAIR = process.env.REAL_CLASS_TASK_UNLIMITED_REPAIR === '1';
const RAG_ENABLED = process.env.REAL_CLASS_TASK_RAG_ENABLED === '1';
const PLACEHOLDER_API_KEY = 'local-boundary-placeholder-not-a-secret';
const EXCLUDED_REAL_CREDENTIAL = 'HUNYUAN_API_KEY';
const AGENT_URL = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:18000';
const ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const BOUNDARY_MARKER_PATH = process.env.NO_NETWORK_BOUNDARY_MARKER_PATH;
const RESULT_ROOT = resolve('test-results', 'real-class-task-model-started-log');

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function requireLoopbackHttpUrl(value, label) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  assert.ok(
    (url.protocol === 'http:' || url.protocol === 'https:')
      && (host === 'localhost' || host === '::1' || host.startsWith('127.')),
    `${label} must use a loopback HTTP URL.`
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function javaSourceSnapshot(directory) {
  const files = new Map();
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.java')) {
        files.set(relative(directory, path).replaceAll('\\', '/'), sha256(await readFile(path)));
      }
    }
  }
  await visit(directory);
  return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function allFiles(directory) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

async function findStartedLog(directory, earliestStartedAt) {
  const candidates = (await allFiles(directory)).filter((path) => path.endsWith('.json'));
  for (const path of candidates) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    if (
      metadata.taskId !== TASK_ID
      || metadata.qualifiedClassName !== QUALIFIED_CLASS_NAME
      || metadata.methodId !== METHOD_ID
      || metadata.methodName !== METHOD_NAME
      || metadata.modelName !== EXPECTED_MODEL
      || metadata.phase !== 'started'
      || Date.parse(metadata.startedAt) < earliestStartedAt
    ) {
      continue;
    }
    const callDirectory = dirname(path);
    const promptFiles = (await allFiles(callDirectory)).filter((item) => item.endsWith('.md'));
    assert.equal(promptFiles.length, 2, 'The started call must write both prompt files.');
    for (const promptFile of promptFiles) {
      assert.ok((await stat(promptFile)).size > 0, `Prompt log is empty: ${promptFile}`);
    }
    return { metadataPath: path, callDirectory, promptFiles, metadata };
  }
  return null;
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error)
  };
}

test('real class-task call writes a started model log and is then stopped', {
  skip: !RUN_REAL_TEST,
  timeout: 30 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const storageDirectory = join(RESULT_ROOT, runId);
  await mkdir(storageDirectory, { recursive: true });
  const result = {
    runId,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    methodName: METHOD_NAME,
    qualifiedClassName: QUALIFIED_CLASS_NAME,
    agentUrl: AGENT_URL,
    analyzerUrl: ANALYZER_URL,
    startedAt: new Date().toISOString(),
    modelName: null,
    repairAttemptLimit: REPAIR_ATTEMPT_LIMIT,
    unlimitedRepair: UNLIMITED_REPAIR,
    ragEnabled: RAG_ENABLED,
    logDirectory: null,
    logFiles: [],
    boundaryMarker: null,
    stopped: false,
    sourceFilesChanged: null,
    finalTaskState: null,
    error: null
  };
  const resultPath = join(storageDirectory, 'result.json');
  const sourceDirectory = join(MODULE_ROOT, 'src');
  const sourcesBefore = await javaSourceSnapshot(sourceDirectory);
  const startedGate = deferred();
  const progressBarrier = deferred();
  let runtime;
  let startedEvent = null;
  let taskRunPromise = null;
  let aiClient = null;

  try {
    requireLoopbackHttpUrl(AGENT_URL, 'Agent Service');
    requireLoopbackHttpUrl(ANALYZER_URL, 'Java Analyzer');
    for (const [name, url] of [
      ['Agent Service', new URL('/api/health', AGENT_URL)],
      ['Java Analyzer', new URL('/api/health', ANALYZER_URL)]
    ]) {
      const response = await fetch(url, { redirect: 'error' });
      assert.equal(response.ok, true, `${name} health returned ${response.status}.`);
    }

    const buildSettingsService = new WorkstationBuildSettingsService(
      join(USER_DATA_DIRECTORY, 'workstation-build-settings.json'),
      'win32',
      'C:\\Users\\wry'
    );
    const logSettingsService = new ModelCallLogSettingsService(
      join(USER_DATA_DIRECTORY, 'model-call-log-settings.json')
    );
    const modelInterfacesService = {
      async getView() {
        const now = new Date().toISOString();
        return {
          schemaVersion: 2,
          activeInterfaceId: 'no-network-model-boundary',
          interfaces: [{
            id: 'no-network-model-boundary',
            name: 'No-network model boundary',
            baseUrl: EXPECTED_BASE_URL,
            model: EXPECTED_MODEL,
            credentialMode: 'environment',
            environmentVariableName: EXCLUDED_REAL_CREDENTIAL,
            hasStoredApiKey: false,
            createdAt: now,
            updatedAt: now
          }],
          secureStorageAvailable: false
        };
      },
      async resolveForGeneration() {
        return {
          interfaceId: 'no-network-model-boundary',
          interfaceName: 'No-network model boundary',
          credentialEnvironmentVariable: EXCLUDED_REAL_CREDENTIAL,
          llmConfig: {
            provider: 'custom_openai',
            model: EXPECTED_MODEL,
            baseUrl: EXPECTED_BASE_URL,
            credentials: { apiKey: PLACEHOLDER_API_KEY }
          }
        };
      }
    };
    const modelRuntime = await modelInterfacesService.resolveForGeneration();
    assert.equal(modelRuntime.llmConfig.provider, 'custom_openai');
    assert.equal(modelRuntime.llmConfig.model, EXPECTED_MODEL);
    assert.equal(modelRuntime.llmConfig.baseUrl, EXPECTED_BASE_URL);
    const apiKey = modelRuntime.llmConfig.credentials.apiKey;
    assert.equal(apiKey, PLACEHOLDER_API_KEY);
    result.modelName = modelRuntime.llmConfig.model;

    const logSettings = await logSettingsService.get();
    assert.equal(logSettings.enabled, true, 'Model-call logging is disabled.');
    assert.ok(logSettings.directory, 'Model-call log directory is missing.');

    aiClient = new AiClient();
    aiClient.setBackendSettings({
      agentServiceUrl: AGENT_URL,
      javaAnalyzerUrl: ANALYZER_URL
    });
    const originalStart = aiClient.startMethodGenerationStream.bind(aiClient);
    const observeStartedModelCall = async (event, identity) => {
      const modelCall = event.modelCall ?? event.childEvent?.modelCall ?? null;
      if (!startedEvent && modelCall?.phase === 'started') {
        startedEvent = {
          ...identity(event),
          callId: modelCall.callId,
          modelName: modelCall.modelName,
          startedAt: modelCall.startedAt
        };
        startedGate.resolve(startedEvent);
        await progressBarrier.promise;
      }
    };
    aiClient.startMethodGenerationStream = async (request, context, onProgress, signal) => (
      originalStart(
        request,
        context,
        async (event) => {
          await onProgress(event);
          await observeStartedModelCall(event, (current) => ({
            sessionId: current.sessionId,
            waveSessionId: null
          }));
        },
        signal
      )
    );
    const originalWave = aiClient.streamMethodGenerationWave.bind(aiClient);
    aiClient.streamMethodGenerationWave = async (
      request,
      context,
      onProgress,
      signal
    ) => originalWave(
      request,
      context,
      async (event) => {
        await onProgress(event);
        await observeStartedModelCall(event, (current) => ({
          sessionId: current.childEvent?.sessionId ?? null,
          waveSessionId: current.waveSessionId
        }));
      },
      signal
    );

    const shellService = new ShellService();
    let taskIdAssigned = false;
    runtime = createProductionClassTaskRuntime({
      storageDirectory,
      aiClient,
      shellService,
      mavenAnalysisContextService: new MavenAnalysisContextService(shellService),
      testWriterService: new TestWriterService(),
      jacocoArtifactsService: new JacocoArtifactsService(),
      surefireReportService: new SurefireReportService(),
      buildSettingsService,
      modelInterfacesService,
      modelCallLogSettingsService: logSettingsService,
      broadcast() {},
      idFactory() {
        if (!taskIdAssigned) {
          taskIdAssigned = true;
          return TASK_ID;
        }
        return randomUUID();
      }
    });

    await runtime.startup();
    const existingTask = (await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT }))
      .find((task) => task.id === TASK_ID);
    if (existingTask) {
      if (existingTask.state === 'PRELOAD_FAILED') {
        await runtime.retryModulePreload({
          workspaceRoot: WORKSPACE_ROOT,
          taskId: TASK_ID
        });
      }
    } else {
      await runtime.addClassTasks({
        workspaceRoot: WORKSPACE_ROOT,
        classFilePaths: [SOURCE_FILE_PATH]
      });
    }
    const catalog = await runtime.getClassTaskMethods({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: TASK_ID
    });
    const method = catalog.methods.find((item) => item.methodId === METHOD_ID);
    assert.ok(method, `Analyzer catalog omitted ${METHOD_NAME} (${METHOD_ID}).`);
    assert.equal(method.methodName, METHOD_NAME);
    await runtime.saveMethodSelection({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: TASK_ID,
      selectionMode: 'EXPLICIT',
      selectedMethodIds: [METHOD_ID],
      methodOrder: [METHOD_ID],
      ragEnabled: RAG_ENABLED,
      repairAttemptLimit: UNLIMITED_REPAIR ? null : REPAIR_ATTEMPT_LIMIT,
      unlimitedRepair: UNLIMITED_REPAIR
    });

    const modelCallStartBoundary = Date.now() - 1_000;
    taskRunPromise = runtime.runTask({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: TASK_ID
    });
    taskRunPromise.then(
      (snapshot) => {
        if (!startedEvent) startedGate.reject(new Error(
          `Class task ended before the model boundary: ${snapshot.state}; ${snapshot.lastError?.message ?? 'no task error'}`
        ));
      },
      (error) => {
        if (!startedEvent) startedGate.reject(error);
      }
    );
    const observed = await withTimeout(
      startedGate.promise,
      20 * 60_000,
      'started model-call event'
    );
    const startedLog = await withTimeout((async () => {
      while (true) {
        const found = await findStartedLog(logSettings.directory, modelCallStartBoundary);
        if (found) return found;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    })(), 5_000, 'started model-call log');

    const loggedFiles = await allFiles(startedLog.callDirectory);
    assert.equal(
      startedLog.metadata.truncated,
      false,
      'The started model-call log is truncated and does not contain the complete prompt.'
    );
    for (const path of loggedFiles) {
      const content = await readFile(path, 'utf8');
      assert.equal(content.includes(apiKey), false, `A model-call log contains the API key: ${path}`);
    }
    result.logDirectory = startedLog.callDirectory;
    result.logFiles = loggedFiles.map((path) => relative(logSettings.directory, path));
    assert.ok(
      BOUNDARY_MARKER_PATH,
      'NO_NETWORK_BOUNDARY_MARKER_PATH is required for the no-network Agent.'
    );
    const boundaryMarker = await withTimeout((async () => {
      while (true) {
        try {
          return JSON.parse(await readFile(BOUNDARY_MARKER_PATH, 'utf8'));
        } catch (error) {
          if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    })(), 5_000, 'no-network model-boundary marker');
    assert.deepEqual(
      {
        boundary: boundaryMarker.boundary,
        modelName: boundaryMarker.modelName,
        baseUrl: boundaryMarker.baseUrl
      },
      {
        boundary: 'before-model-transport',
        modelName: EXPECTED_MODEL,
        baseUrl: EXPECTED_BASE_URL
      }
    );
    assert.ok(boundaryMarker.systemPromptCharacters > 0);
    assert.ok(boundaryMarker.userPromptCharacters > 0);
    assert.equal(JSON.stringify(boundaryMarker).includes(apiKey), false);
    result.boundaryMarker = boundaryMarker;

    const taskTermination = runtime.terminateTask({
      workspaceRoot: WORKSPACE_ROOT,
      taskId: TASK_ID
    });
    await withTimeout(
      observed.waveSessionId
        ? aiClient.cancelMethodGenerationWave(observed.waveSessionId)
        : aiClient.cancelMethodGeneration(observed.sessionId),
      10_000,
      'Agent model-boundary cancellation'
    );
    progressBarrier.resolve();
    await taskTermination;
    await withTimeout(taskRunPromise.catch(() => undefined), 60_000, 'class-task shutdown');
    assert.equal(
      JSON.parse(await readFile(startedLog.metadataPath, 'utf8')).phase,
      'started',
      'Stopping at the boundary must leave the persisted call metadata at phase=started.'
    );
    result.stopped = true;
    const finalTask = (await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT }))[0];
    result.finalTaskState = finalTask?.state ?? null;

    const sourcesAfter = await javaSourceSnapshot(sourceDirectory);
    result.sourceFilesChanged = JSON.stringify(sourcesBefore) !== JSON.stringify(sourcesAfter);
    assert.deepEqual(sourcesAfter, sourcesBefore, 'The log-boundary run modified Java source files.');
  } catch (error) {
    result.error = safeError(error);
    throw error;
  } finally {
    progressBarrier.resolve();
    if (aiClient && (startedEvent?.waveSessionId || startedEvent?.sessionId)) {
      await withTimeout(
        startedEvent.waveSessionId
          ? aiClient.cancelMethodGenerationWave(startedEvent.waveSessionId)
          : aiClient.cancelMethodGeneration(startedEvent.sessionId),
        10_000,
        'Agent cleanup cancellation'
      ).catch(() => undefined);
    }
    if (runtime) {
      if (!result.stopped) {
        await runtime.terminateTask({
          workspaceRoot: WORKSPACE_ROOT,
          taskId: TASK_ID
        }).catch(() => undefined);
      }
      await runtime.beforeQuit().catch(() => undefined);
    }
    result.finishedAt = new Date().toISOString();
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`REAL_CLASS_TASK_STARTED_LOG_RESULT=${resultPath}\n`);
  }
});
