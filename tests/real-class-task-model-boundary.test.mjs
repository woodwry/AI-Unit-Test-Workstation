import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
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

const RUN_REAL_TEST = process.env.RUN_REAL_CLASS_TASK_BOUNDARY === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const BUILD_SETTINGS_PATH = process.env.WORKSTATION_BUILD_SETTINGS_PATH
  ?? 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation\\workstation-build-settings.json';
const ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18081';
const AGENT_BOUNDARY_URL = 'http://127.0.0.1:9';
const RESULT_ROOT = resolve('test-results', 'real-class-task-model-boundary');
const EXPECTED_BUILD_SETTINGS = Object.freeze({
  mavenHome: 'D:\\java\\apache-maven-3.5.4',
  javaHome: 'D:\\java\\jdk1.8',
  settingsPath: 'D:\\java\\apache-maven-3.5.4\\conf\\settings.xml',
  localRepository: 'D:\\java\\apache-maven-3.5.4\\repository'
});
const TARGETS = Object.freeze([
  {
    qualifiedClassName: 'com.dtsz.collection.model.service.TaskService',
    sourceFilePath: join(
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
    ),
    methodName: 'getChildZipFile',
    methodId: '3a0612e55cbe809b102be166a7994d6ecfb5cac3fc5785d682d429d415f28442'
  },
  {
    qualifiedClassName: 'com.dtsz.model.sso.service.SSORoleService',
    sourceFilePath: join(
      WORKSPACE_ROOT,
      'collection-user',
      'src',
      'main',
      'java',
      'com',
      'dtsz',
      'model',
      'sso',
      'service',
      'SSORoleService.java'
    ),
    methodName: 'getRole',
    methodId: '79636e81cf353aac3f79ee7ceaa9cb79850529716b562c22f4936ef8bea7f55e'
  }
]);

class ModelBoundaryReachedError extends Error {
  constructor(methodId) {
    super(`MODEL_BOUNDARY_REACHED:${methodId}`);
    this.name = 'ModelBoundaryReachedError';
  }
}

function createGate(expectedCount, timeoutMilliseconds) {
  let resolveGate;
  const values = new Set();
  const gate = new Promise((resolvePromise) => {
    resolveGate = resolvePromise;
  });
  return {
    arrive(value) {
      values.add(value);
      if (values.size >= expectedCount) resolveGate();
    },
    async wait(label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `${label} did not receive ${expectedCount} unique methods; received ${[...values].join(', ')}`
        )), timeoutMilliseconds);
        timer.unref?.();
      });
      try {
        await Promise.race([gate, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function javaSourceSnapshot(directories) {
  const files = new Map();
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.java')) {
        files.set(
          relative(WORKSPACE_ROOT, path).replaceAll('\\', '/'),
          sha256(await readFile(path))
        );
      }
    }
  }
  for (const directory of directories) await visit(directory);
  return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function artifactSnapshot(directories) {
  const files = new Map();
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.set(
          relative(WORKSPACE_ROOT, path).replaceAll('\\', '/'),
          sha256(await readFile(path))
        );
      }
    }
  }
  for (const directory of directories) await visit(directory);
  return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function compactSnapshot(snapshot) {
  return {
    id: snapshot.id,
    qualifiedClassName: snapshot.qualifiedClassName,
    moduleDisplayPath: snapshot.moduleDisplayPath,
    state: snapshot.state,
    preloadState: snapshot.preloadState,
    selectionMode: snapshot.selectionMode,
    selectedMethodIds: [...snapshot.selectedMethodIds],
    methodOrder: [...snapshot.methodOrder],
    currentAtomicStep: snapshot.currentAtomicStep,
    lastError: snapshot.lastError
  };
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

test('real TaskService and SSORoleService tasks overlap and stop before model HTTP', {
  skip: !RUN_REAL_TEST,
  timeout: 30 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const artifactNamespace = `real-boundary-${randomUUID()}`;
  const storageDirectory = join(RESULT_ROOT, runId);
  await mkdir(storageDirectory, { recursive: true });

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const analyzerOrigin = new URL(ANALYZER_URL).origin;
  const agentBoundaryOrigin = new URL(AGENT_BOUNDARY_URL).origin;
  const analyzerHttpRequests = [];
  const forbiddenHttpRequests = [];
  let handleAgentTransport = null;
  const analyzerClient = new AiClient(async (input, init) => {
    const url = new URL(requestUrl(input));
    if (url.origin === analyzerOrigin) {
      const request = {
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        startedAt: new Date().toISOString(),
        finishedAt: null
      };
      analyzerHttpRequests.push(request);
      try {
        return await nativeFetch(input, init);
      } finally {
        request.finishedAt = new Date().toISOString();
      }
    }
    if (url.origin === agentBoundaryOrigin && handleAgentTransport) {
      return handleAgentTransport(url, init);
    }
    forbiddenHttpRequests.push({ method: init?.method ?? 'GET', url: url.href });
    throw new Error(`Forbidden HTTP request: ${url.href}`);
  });
  analyzerClient.setBackendSettings({
    agentServiceUrl: AGENT_BOUNDARY_URL,
    javaAnalyzerUrl: ANALYZER_URL
  });

  const healthResponse = await nativeFetch(new URL('/api/health', ANALYZER_URL), {
    redirect: 'error'
  });
  assert.equal(healthResponse.ok, true, `Java Analyzer health returned ${healthResponse.status}`);

  const expectedMethodIds = new Set(TARGETS.map((target) => target.methodId));
  const modelBoundaryGate = createGate(expectedMethodIds.size, 10 * 60_000);
  const analysisBatchRequests = [];
  const modelBoundaryRequests = [];
  const unexpectedAgentCalls = [];
  let activeAnalysisBatches = 0;
  let maxConcurrentAnalysisBatches = 0;
  let activeModelBoundaries = 0;
  let maxConcurrentModelBoundaries = 0;

  handleAgentTransport = async (url, init) => {
    assert.equal(
      url.pathname,
      '/api/unit-tests/method-generation-sessions/start/stream'
    );
    assert.equal(typeof init?.body, 'string');
    const request = JSON.parse(init.body);
    assert.equal(
      expectedMethodIds.has(request.methodId),
      true,
      `Unexpected model-boundary methodId ${request.methodId}`
    );
    activeModelBoundaries += 1;
    maxConcurrentModelBoundaries = Math.max(
      maxConcurrentModelBoundaries,
      activeModelBoundaries
    );
    modelBoundaryRequests.push({
      classTaskId: request.classTaskId,
      methodId: request.methodId,
      batchId: request.batchId,
      batchIndex: request.batchIndex,
      outputTestClassName: request.outputTestClassName,
      reachedAt: new Date().toISOString(),
      transportInterceptedBeforeNetwork: true
    });
    modelBoundaryGate.arrive(request.methodId);
    try {
      await modelBoundaryGate.wait('model boundary concurrency gate');
      throw new ModelBoundaryReachedError(request.methodId);
    } finally {
      activeModelBoundaries -= 1;
    }
  };

  const aiClient = {
    createMethodAnalysisSession: analyzerClient.createMethodAnalysisSession.bind(analyzerClient),
    heartbeatMethodAnalysisSession: analyzerClient.heartbeatMethodAnalysisSession.bind(analyzerClient),
    refreshMethodAnalysisCoverage: analyzerClient.refreshMethodAnalysisCoverage.bind(analyzerClient),
    generateTargetJacocoReport: analyzerClient.generateTargetJacocoReport.bind(analyzerClient),
    async nextMethodBatch(sessionId, methodId, request, signal) {
      activeAnalysisBatches += 1;
      maxConcurrentAnalysisBatches = Math.max(
        maxConcurrentAnalysisBatches,
        activeAnalysisBatches
      );
      const batchRequest = {
        methodId,
        sessionId,
        reportPairId: request.reportPairId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        batchId: null,
        hasWork: null,
        plannedTestMethods: null
      };
      analysisBatchRequests.push(batchRequest);
      try {
        assert.equal(expectedMethodIds.has(methodId), true, `Unexpected Analyzer methodId ${methodId}`);
        const response = await analyzerClient.nextMethodBatch(
          sessionId,
          methodId,
          request,
          signal
        );
        batchRequest.batchId = response.batchId;
        batchRequest.hasWork = response.hasWork;
        batchRequest.plannedTestMethods = response.plannedTestMethods;
        return response;
      } finally {
        batchRequest.finishedAt = new Date().toISOString();
        activeAnalysisBatches -= 1;
      }
    },
    startMethodGenerationStream: analyzerClient.startMethodGenerationStream.bind(analyzerClient),
    async resumeMethodGenerationStream() {
      unexpectedAgentCalls.push('resumeMethodGenerationStream');
      throw new Error('Agent resume must not run in a model-boundary test.');
    },
    async acknowledgeMethodGenerationEvents() {
      unexpectedAgentCalls.push('acknowledgeMethodGenerationEvents');
      throw new Error('Agent acknowledgement must not run in a model-boundary test.');
    },
    async cancelMethodGeneration() {
      unexpectedAgentCalls.push('cancelMethodGeneration');
      throw new Error('Agent cancellation must not run in a model-boundary test.');
    }
  };

  const shellService = new ShellService();
  const mavenCalls = [];
  let activeMavenCalls = 0;
  let maxConcurrentMavenCalls = 0;
  const measureMaven = async (operation, args, execute) => {
    const call = {
      operation,
      moduleRoot: args[0],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null
    };
    mavenCalls.push(call);
    activeMavenCalls += 1;
    maxConcurrentMavenCalls = Math.max(maxConcurrentMavenCalls, activeMavenCalls);
    try {
      const result = await execute();
      call.exitCode = result.exitCode;
      return result;
    } finally {
      call.finishedAt = new Date().toISOString();
      activeMavenCalls -= 1;
    }
  };
  const measuredShellService = {
    validateBuildSettings: shellService.validateBuildSettings.bind(shellService),
    runMavenModuleTestsWithJacoco: (...args) => measureMaven(
      'runMavenModuleTestsWithJacoco',
      args,
      () => shellService.runMavenModuleTestsWithJacoco(...args)
    ),
    runMavenDirectTestsWithJacoco: (...args) => measureMaven(
      'runMavenDirectTestsWithJacoco',
      args,
      () => shellService.runMavenDirectTestsWithJacoco(...args)
    ),
    runMavenGeneratedTestCompile: (...args) => measureMaven(
      'runMavenGeneratedTestCompile',
      args,
      () => shellService.runMavenGeneratedTestCompile(...args)
    ),
    runMavenGeneratedSurefireTest: (...args) => measureMaven(
      'runMavenGeneratedSurefireTest',
      args,
      () => shellService.runMavenGeneratedSurefireTest(...args)
    ),
    runMavenDirectTestsWithJacocoAppend: (...args) => measureMaven(
      'runMavenDirectTestsWithJacocoAppend',
      args,
      () => shellService.runMavenDirectTestsWithJacocoAppend(...args)
    )
  };

  const persistedBuildSettings = new WorkstationBuildSettingsService(
    BUILD_SETTINGS_PATH,
    'win32',
    'C:\\Users\\wry'
  );
  const storedSettings = await persistedBuildSettings.get();
  assert.ok(storedSettings, `Missing workstation build settings at ${BUILD_SETTINGS_PATH}`);
  assert.deepEqual(
    {
      mavenHome: storedSettings.mavenHome,
      javaHome: storedSettings.javaHome,
      settingsPath: storedSettings.settingsPath,
      localRepository: storedSettings.localRepository
    },
    EXPECTED_BUILD_SETTINGS
  );
  const liveValidation = await shellService.validateBuildSettings(storedSettings, WORKSPACE_ROOT);
  assert.equal(liveValidation.valid, true, liveValidation.error);
  assert.equal(liveValidation.mavenVersion, '3.5.4');
  assert.match(liveValidation.javaVersion ?? '', /^1\.8\.0_451(?:\b|$)/);
  const buildSettings = { ...storedSettings, validation: liveValidation };

  const productionSourceMarker = `${join('src', 'main', 'java')}\\`;
  const moduleRoots = [...new Set(TARGETS.map((target) => (
    target.sourceFilePath.slice(0, target.sourceFilePath.indexOf(productionSourceMarker))
  )))];
  const javaSourceDirectories = moduleRoots.flatMap((moduleRoot) => [
    join(moduleRoot, 'src', 'main', 'java'),
    join(moduleRoot, 'src', 'test')
  ]);
  const productionArtifactDirectories = moduleRoots.map((moduleRoot) => (
    join(moduleRoot, 'target', 'ai-unit-test', 'jacoco', 'preload')
  ));
  const isolatedArtifactDirectories = moduleRoots.map((moduleRoot) => (
    join(moduleRoot, 'target', 'ai-unit-test', 'scopes', artifactNamespace)
  ));
  const sourceFilesBefore = await javaSourceSnapshot(javaSourceDirectories);
  const productionArtifactsBefore = await artifactSnapshot(productionArtifactDirectories);
  const activeTaskStates = new Map();
  const snapshotTimeline = [];
  let maxConcurrentTaskRuns = 0;
  let runtime;
  let finalSnapshots = [];
  const result = {
    runId,
    analyzerUrl: ANALYZER_URL,
    workspaceRoot: WORKSPACE_ROOT,
    buildSettingsPath: BUILD_SETTINGS_PATH,
    buildValidation: liveValidation,
    targets: TARGETS,
    preloadFingerprints: [],
    preparedSnapshots: [],
    catalogs: [],
    finalSnapshots: [],
    analyzerHttpRequests,
    forbiddenHttpRequests,
    analysisBatchRequests,
    modelBoundaryRequests,
    unexpectedAgentCalls,
    mavenCalls,
    maxConcurrentTaskRuns: 0,
    maxConcurrentMavenCalls: 0,
    maxConcurrentAnalysisBatches: 0,
    maxConcurrentModelBoundaries: 0,
    sourceFilesChanged: null,
    productionArtifactsChanged: null,
    error: null
  };

  try {
    runtime = createProductionClassTaskRuntime({
      storageDirectory,
      aiClient,
      shellService: measuredShellService,
      mavenAnalysisContextService: new MavenAnalysisContextService(shellService),
      testWriterService: new TestWriterService(),
      jacocoArtifactsService: new JacocoArtifactsService(undefined, artifactNamespace),
      surefireReportService: new SurefireReportService(),
      buildSettingsService: {
        async get() { return structuredClone(buildSettings); },
        resolveMavenHomeDefaults: persistedBuildSettings.resolveMavenHomeDefaults
          .bind(persistedBuildSettings)
      },
      modelInterfacesService: {
        async getView() {
          return {
            schemaVersion: 2,
            activeInterfaceId: 'model-boundary-probe',
            interfaces: [{
              id: 'model-boundary-probe',
              name: 'Model boundary probe (no HTTP)',
              baseUrl: 'http://127.0.0.1:9/v1',
              model: 'never-called',
              credentialMode: 'direct',
              hasStoredApiKey: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }],
            secureStorageAvailable: true
          };
        },
        async resolveForGeneration() {
          return {
            interfaceId: 'model-boundary-probe',
            interfaceName: 'Model boundary probe (no HTTP)',
            llmConfig: {
              provider: 'custom_openai',
              model: 'never-called',
              baseUrl: 'http://127.0.0.1:9/v1',
              credentials: { apiKey: '' }
            }
          };
        }
      },
      modelCallLogSettingsService: {
        async get() { return { enabled: false }; }
      },
      broadcast(snapshot) {
        activeTaskStates.set(snapshot.id, snapshot.state);
        maxConcurrentTaskRuns = Math.max(
          maxConcurrentTaskRuns,
          [...activeTaskStates.values()].filter((state) => (
            state === 'RUNNING' || state === 'PAUSE_REQUESTED'
          )).length
        );
        snapshotTimeline.push({
          taskId: snapshot.id,
          qualifiedClassName: snapshot.qualifiedClassName,
          state: snapshot.state,
          preloadState: snapshot.preloadState,
          atomicStep: snapshot.currentAtomicStep,
          at: new Date().toISOString()
        });
      }
    });

    await runtime.startup();
    await runtime.addClassTasks({
      workspaceRoot: WORKSPACE_ROOT,
      classFilePaths: TARGETS.map((target) => target.sourceFilePath)
    });
    await runtime.flush();

    const prepared = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT });
    result.preparedSnapshots = prepared.map(compactSnapshot);
    assert.equal(prepared.length, TARGETS.length);
    assert.deepEqual(
      prepared.map((snapshot) => snapshot.state).sort(),
      ['READY', 'READY']
    );
    const preloadCache = JSON.parse(await readFile(
      join(storageDirectory, 'module-preload-cache-v1.json'),
      'utf8'
    ));
    const preloadEntries = Object.values(preloadCache.modules ?? {});
    result.preloadFingerprints = TARGETS.map((target) => {
      const module = preloadEntries.find((entry) => (
        entry.classReportPairs?.[target.qualifiedClassName]
      ));
      assert.ok(module, `Missing preload fingerprint for ${target.qualifiedClassName}`);
      const pair = module.classReportPairs[target.qualifiedClassName];
      assert.equal(module.state, 'READY');
      assert.match(module.fingerprint, /^[0-9a-f]{64}$/);
      assert.equal(pair.fingerprint, module.fingerprint);
      assert.match(pair.reportPairId, /^[0-9a-f]{64}$/);
      return {
        qualifiedClassName: target.qualifiedClassName,
        moduleKey: module.moduleKey,
        fingerprint: module.fingerprint,
        reportPairId: pair.reportPairId
      };
    });

    const taskByClass = new Map(prepared.map((task) => [task.qualifiedClassName, task]));
    const catalogs = await Promise.all(TARGETS.map(async (target) => {
      const task = taskByClass.get(target.qualifiedClassName);
      assert.ok(task, `Missing class task ${target.qualifiedClassName}`);
      const catalog = await runtime.getClassTaskMethods({
        workspaceRoot: WORKSPACE_ROOT,
        taskId: task.id
      });
      const method = catalog.methods.find((item) => item.methodId === target.methodId);
      assert.ok(method, `Analyzer catalog omitted ${target.methodName} (${target.methodId})`);
      assert.equal(method.methodName, target.methodName);
      await runtime.saveMethodSelection({
        workspaceRoot: WORKSPACE_ROOT,
        taskId: task.id,
        selectionMode: 'EXPLICIT',
        selectedMethodIds: [target.methodId],
        methodOrder: [target.methodId],
        ragEnabled: false
      });
      return {
        taskId: task.id,
        qualifiedClassName: target.qualifiedClassName,
        analysisSessionId: catalog.analysisSessionId,
        reportPairId: catalog.reportPairId,
        selectedMethod: method
      };
    }));
    result.catalogs = catalogs;

    await runtime.runAll({ workspaceRoot: WORKSPACE_ROOT });
    finalSnapshots = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT });
    result.finalSnapshots = finalSnapshots.map(compactSnapshot);

    assert.equal(maxConcurrentTaskRuns, 2, 'Both class tasks must be RUNNING concurrently.');
    assert.equal(
      maxConcurrentAnalysisBatches,
      2,
      'Both real Analyzer next-batch calls must overlap.'
    );
    assert.equal(
      maxConcurrentMavenCalls,
      2,
      'The two different Maven modules must preload concurrently.'
    );
    assert.equal(
      maxConcurrentModelBoundaries,
      2,
      'Both tasks must overlap at the model-call boundary.'
    );
    assert.deepEqual(
      new Set(analysisBatchRequests.map((request) => request.methodId)),
      expectedMethodIds
    );
    assert.equal(analysisBatchRequests.length, TARGETS.length);
    assert.equal(analysisBatchRequests.every((request) => request.hasWork === true), true);
    const latestAnalysisStart = Math.max(...analysisBatchRequests.map((request) => (
      Date.parse(request.startedAt)
    )));
    const earliestAnalysisFinish = Math.min(...analysisBatchRequests.map((request) => (
      Date.parse(request.finishedAt)
    )));
    assert.equal(
      latestAnalysisStart < earliestAnalysisFinish,
      true,
      `Analyzer HTTP intervals did not overlap: ${JSON.stringify(analysisBatchRequests)}`
    );
    assert.deepEqual(
      new Set(modelBoundaryRequests.map((request) => request.methodId)),
      expectedMethodIds
    );
    assert.equal(modelBoundaryRequests.length, TARGETS.length);
    assert.equal(forbiddenHttpRequests.length, 0, 'No unexpected HTTP request may be sent.');
    assert.equal(
      modelBoundaryRequests.every((request) => request.transportInterceptedBeforeNetwork),
      true
    );
    assert.deepEqual(unexpectedAgentCalls, []);
    assert.equal(mavenCalls.length, TARGETS.length);
    assert.equal(mavenCalls.every((call) => (
      call.operation === 'runMavenDirectTestsWithJacoco' && call.exitCode === 0
    )), true, JSON.stringify(mavenCalls));
    assert.equal(
      mavenCalls.some((call) => call.operation.startsWith('runMavenGenerated')),
      false,
      'Candidate Maven execution must not begin before the model boundary.'
    );
    assert.equal(finalSnapshots.length, TARGETS.length);
    assert.equal(finalSnapshots.every((snapshot) => (
      snapshot.state === 'FAILED'
      && snapshot.lastError?.message.includes('MODEL_BOUNDARY_REACHED:')
      && snapshot.generatedArtifacts.length === 0
    )), true, JSON.stringify(result.finalSnapshots));

  } catch (error) {
    result.error = errorRecord(error);
    throw error;
  } finally {
    let sourceIntegrityFailure = null;
    if (finalSnapshots.length === 0 && runtime) {
      finalSnapshots = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT })
        .catch(() => []);
      result.finalSnapshots = finalSnapshots.map(compactSnapshot);
    }
    if (runtime) {
      await runtime.beforeQuit().catch((error) => {
        result.shutdownError = errorRecord(error);
      });
    }
    try {
      const sourceFilesAfter = await javaSourceSnapshot(javaSourceDirectories);
      const productionArtifactsAfter = await artifactSnapshot(productionArtifactDirectories);
      result.sourceFilesChanged = JSON.stringify(sourceFilesAfter) !== JSON.stringify(sourceFilesBefore);
      result.productionArtifactsChanged = JSON.stringify(productionArtifactsAfter)
        !== JSON.stringify(productionArtifactsBefore);
      assert.deepEqual(
        sourceFilesAfter,
        sourceFilesBefore,
        'The boundary test must not write or modify Java source files.'
      );
      assert.deepEqual(
        productionArtifactsAfter,
        productionArtifactsBefore,
        'The boundary test must not overwrite workstation JaCoCo preload artifacts.'
      );
    } catch (error) {
      sourceIntegrityFailure = error;
      result.sourceIntegrityError = errorRecord(error);
    }
    await Promise.all(isolatedArtifactDirectories.map((directory) => (
      rm(directory, { recursive: true, force: true })
    ))).catch((error) => {
      result.artifactCleanupError = errorRecord(error);
    });
    result.maxConcurrentTaskRuns = maxConcurrentTaskRuns;
    result.maxConcurrentMavenCalls = maxConcurrentMavenCalls;
    result.maxConcurrentAnalysisBatches = maxConcurrentAnalysisBatches;
    result.maxConcurrentModelBoundaries = maxConcurrentModelBoundaries;
    result.snapshotTimeline = snapshotTimeline;
    result.finishedAt = new Date().toISOString();
    const resultPath = join(storageDirectory, 'result.json');
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`REAL_CLASS_TASK_BOUNDARY_RESULT=${resultPath}\n`);
    if (sourceIntegrityFailure && result.error === null) throw sourceIntegrityFailure;
  }
});
