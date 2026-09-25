import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClassTaskRagRunService
} from '../src/main/services/class-task-rag-runtime.service.ts';

const FINGERPRINT = 'f'.repeat(64);
const ANALYSIS_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_PAIR_ID = 'a'.repeat(64);
const METHOD_ID = 'b'.repeat(64);
const SOURCE_SET_ID = 'c'.repeat(64);
const SOURCE_SET_FINGERPRINT = '84ca98d235db68f4737289d37526f870dfc4bce041f0ed0cfaec751d66a6e344';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const TASK_RUN_ID = '33333333-3333-4333-8333-333333333333';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resources(taskId = TASK_ID) {
  return {
    taskId,
    ragSubscription: null,
    ragRunContext: undefined,
    ragTaskRun: undefined,
    ragPreflightEnabled: undefined,
    ragToolCallingProbe: null,
    resolvedModelRuntime: null,
    resolvedRagEmbeddingRuntime: null
  };
}

function input(overrides = {}) {
  return {
    taskId: TASK_ID,
    ragEnabled: true,
    analysisSessionId: ANALYSIS_SESSION_ID,
    reportPairId: REPORT_PAIR_ID,
    methodIds: [METHOD_ID],
    analysisInput: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      targetSourcePath: 'D:\\work\\module\\src\\main\\java\\com\\example\\Order.java',
      targetClass: 'com.example.Order',
      sourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: [
        'D:\\work\\module\\target\\classes',
        'D:\\m2\\repository\\demo\\dep\\1.0\\dep-1.0.jar'
      ],
      jdkMajorVersion: 21,
      buildContextFingerprint: FINGERPRINT
    },
    buildSettings: {
      mavenHome: 'D:\\maven',
      javaHome: 'D:\\jdk'
    },
    signal: new AbortController().signal,
    ...overrides
  };
}

function modelRuntime(model = 'chat-model') {
  return {
    interfaceId: 'model-interface',
    interfaceName: 'Model interface',
    llmConfig: {
      provider: 'custom_openai',
      model,
      baseUrl: 'https://models.example/v1',
      credentials: { apiKey: 'must-not-enter-rag-context' }
    }
  };
}

function embeddingRuntime() {
  return {
    interfaceId: 'embedding-interface',
    interfaceName: 'Embedding interface',
    embeddingModel: 'embed-local',
    embeddingConfig: {
      provider: 'custom_openai',
      model: 'embed-local',
      baseUrl: 'https://embeddings.example/v1',
      credentials: { apiKey: 'embedding-secret' }
    }
  };
}

function preparationResult(status = 'reused', vectorStatus = 'ready') {
  return {
    status,
    vectorStatus,
    workspaceId: 'a'.repeat(64),
    scopeId: 'b'.repeat(64),
    buildFingerprint: FINGERPRINT,
    pageCount: 0,
    addedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    skippedDependencyCount: 0,
    degradationCode: null
  };
}

function activeIndex() {
  return {
    workspaceId: 'a'.repeat(64),
    scopeId: 'b'.repeat(64),
    indexVersion: 1,
    sourceSetId: SOURCE_SET_ID,
    requestedSourceSetFingerprint: SOURCE_SET_FINGERPRINT,
    allowedFqns: ['com.example.Order']
  };
}

function toolCallingProbe(overrides = {}) {
  return {
    supported: true,
    cacheHit: false,
    cacheKeyDigest: 'd'.repeat(64),
    trace: null,
    ...overrides
  };
}

function preflightInput(value = input(), overrides = {}) {
  return {
    taskId: value.taskId,
    ragEnabled: value.ragEnabled,
    captureModelCalls: false,
    signal: value.signal,
    ...overrides
  };
}

async function prepareRun(service, state, value = input()) {
  await service.preflightRun(state, preflightInput(value));
  await service.prepareIndex(state, value);
}

function harness({
  embeddingRuntimeValue = embeddingRuntime(),
  embeddingRuntimeError = null,
  ready = Promise.resolve(preparationResult()),
  subscribeError = null,
  probeResult = toolCallingProbe(),
  probeError = null,
  waitMilliseconds = 120_000,
  checkpointRagRun = null,
  ensureError = null,
  ensureResult = { status: 'published', addedMethodCount: 13, reusedMethodCount: 0 }
} = {}) {
  const events = [];
  const subscriptions = [];
  let modelCalls = 0;
  let activeModelName = 'chat-model';
  let embeddingCalls = 0;
  let probeCalls = 0;
  const probeCaptures = [];
  let defaultsCalls = 0;
  let releaseCalls = 0;
  let releaseAllCalls = 0;
  const durableRagRuns = new Map();
  if (checkpointRagRun) durableRagRuns.set(TASK_ID, structuredClone(checkpointRagRun));
  const savedRagRuns = [];
  const clearedRagRuns = [];
  const releasedTaskRuns = [];
  let ensureCalls = 0;
  const ensureInputs = [];
  const generatedTaskRunIds = [
    TASK_RUN_ID,
    '55555555-5555-4555-8555-555555555555'
  ];
  const service = new ClassTaskRagRunService({
    indexCoordinator: {
      async subscribeInitial(value) {
        events.push('subscribe');
        if (subscribeError) throw subscribeError;
        const context = structuredClone(value.context);
        const prepared = ready.then((result) => {
          if ((result.status === 'reused' || result.status === 'published')
            && result.vectorStatus === 'ready') {
            context.activeIndex = activeIndex();
          }
          return result;
        });
        subscriptions.push({ ...value, context });
        return {
          context,
          ready: prepared,
          async release() {
            releaseCalls += 1;
            events.push('release');
          }
        };
      },
      async releaseAll() {
        releaseAllCalls += 1;
      }
    },
    modelInterfaces: {
      async resolveForGeneration() {
        modelCalls += 1;
        events.push('model');
        return modelRuntime(activeModelName);
      }
    },
    modelCapabilities: {
      async probeModelToolCalling(modelContext, captureModelCalls, signal) {
        probeCalls += 1;
        events.push('probe');
        assert.deepEqual(modelContext, { llmConfig: modelRuntime().llmConfig });
        probeCaptures.push(captureModelCalls);
        assert.equal(signal?.aborted, false);
        if (probeError) throw probeError;
        return structuredClone(probeResult);
      }
    },
    checkpoints: {
      async taskProgress(taskId) {
        return { ragRun: structuredClone(durableRagRuns.get(taskId) ?? null) };
      },
      async saveRagRun(taskId, ragRun) {
        savedRagRuns.push({ taskId, ragRun: structuredClone(ragRun) });
        durableRagRuns.set(taskId, structuredClone(ragRun));
        return structuredClone(ragRun);
      },
      async clearRagRun(taskId, taskRunId) {
        clearedRagRuns.push({ taskId, taskRunId });
        if (durableRagRuns.get(taskId)?.taskRunId === taskRunId) {
          durableRagRuns.delete(taskId);
        }
      }
    },
    knowledge: {
      async ensureTaskKnowledge(value) {
        ensureCalls += 1;
        events.push('ensure');
        ensureInputs.push(structuredClone({ ...value, signal: undefined }));
        if (ensureError) throw ensureError;
        return structuredClone(ensureResult);
      }
    },
    taskRuns: {
      async releaseRagTaskRun(taskRunId, request) {
        releasedTaskRuns.push({ taskRunId, request: structuredClone(request) });
      }
    },
    embeddingInterfaces: {
      async resolveRuntime() {
        embeddingCalls += 1;
        events.push('embedding');
        if (embeddingRuntimeError) throw embeddingRuntimeError;
        return structuredClone(embeddingRuntimeValue);
      }
    },
    async resolveMavenHomeDefaults() {
      defaultsCalls += 1;
      events.push('maven-defaults');
      return {
        settingsPath: 'D:\\maven\\conf\\settings.xml',
        localRepository: 'D:\\m2\\repository'
      };
    },
    waitMilliseconds,
    idFactory: () => generatedTaskRunIds.shift()
      ?? '66666666-6666-4666-8666-666666666666',
    telemetry(event, fields) {
      events.push(`${event}:${fields.status}`);
    }
  });
  return {
    service,
    events,
    subscriptions,
    get modelCalls() { return modelCalls; },
    get embeddingCalls() { return embeddingCalls; },
    get probeCalls() { return probeCalls; },
    get probeCaptures() { return probeCaptures; },
    get defaultsCalls() { return defaultsCalls; },
    get releaseCalls() { return releaseCalls; },
    get releaseAllCalls() { return releaseAllCalls; },
    get durableRagRun() { return structuredClone(durableRagRuns.get(TASK_ID) ?? null); },
    get savedRagRuns() { return structuredClone(savedRagRuns); },
    get clearedRagRuns() { return structuredClone(clearedRagRuns); },
    get releasedTaskRuns() { return structuredClone(releasedTaskRuns); },
    get ensureCalls() { return ensureCalls; },
    get ensureInputs() { return structuredClone(ensureInputs); },
    setModelName(value) { activeModelName = value; }
  };
}

test('RAG preflight never probes model tool calling or records a probe', async () => {
  const h = harness({ probeResult: toolCallingProbe({ supported: false }) });
  const state = resources();
  const recorded = [];
  const preflight = preflightInput(input(), {
    captureModelCalls: true,
    recordToolCallingProbe: async (probe, modelName) => {
      recorded.push({ probe, modelName });
    }
  });

  await h.service.preflightRun(state, preflight);
  await h.service.preflightRun(state, preflight);

  assert.equal(h.probeCalls, 0);
  assert.deepEqual(h.probeCaptures, []);
  assert.deepEqual(recorded, []);
  assert.equal(state.ragToolCallingProbe, null);
});

test('RAG-disabled runs resolve the model once but never read settings or subscribe', async () => {
  const h = harness();
  const state = resources();

  await prepareRun(h.service, state, input({ ragEnabled: false }));
  await prepareRun(h.service, state, input({ ragEnabled: true }));

  assert.equal(h.modelCalls, 1);
  assert.equal(h.embeddingCalls, 0);
  assert.equal(h.probeCalls, 0);
  assert.equal(h.subscriptions.length, 0);
  assert.equal(h.savedRagRuns.length, 0);
  assert.equal(h.ensureCalls, 0);
  assert.equal(h.releasedTaskRuns.length, 0);
  assert.equal(state.ragRunContext, null);
  assert.deepEqual(state.resolvedModelRuntime, modelRuntime());
  assert.equal(state.resolvedRagEmbeddingRuntime, null);
});

test('refreshing a paused run replaces only its cached generation model runtime', async () => {
  const h = harness();
  const state = resources();
  await prepareRun(h.service, state, input());
  const subscription = state.ragSubscription;
  const taskRun = structuredClone(state.ragTaskRun);

  h.setModelName('newly-selected-model');
  assert.equal(
    typeof h.service.refreshModelRuntime,
    'function',
    'paused-run resume needs an explicit model-runtime refresh boundary'
  );
  await h.service.refreshModelRuntime(state);

  assert.equal(h.modelCalls, 2);
  assert.equal(state.resolvedModelRuntime.llmConfig.model, 'newly-selected-model');
  assert.equal(state.ragSubscription, subscription);
  assert.deepEqual(state.ragTaskRun, taskRun);
  assert.equal(h.embeddingCalls, 1);
});

test('RAG-enabled runs capture one exact credential-free context and await readiness', async () => {
  const h = harness();
  const state = resources();

  await prepareRun(h.service, state, input());
  await prepareRun(h.service, state, input({
    buildSettings: {
      mavenHome: 'D:\\changed-maven',
      javaHome: 'D:\\changed-jdk',
      localRepository: 'D:\\changed-repository'
    }
  }));

  assert.equal(h.modelCalls, 1);
  assert.equal(h.probeCalls, 0);
  assert.equal(h.defaultsCalls, 1);
  assert.equal(h.subscriptions.length, 1);
  assert.deepEqual(state.ragRunContext, {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: [
        'D:\\work\\module\\target\\classes',
        'D:\\m2\\repository\\demo\\dep\\1.0\\dep-1.0.jar'
      ],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: FINGERPRINT
    },
    activeIndex: activeIndex(),
    taskRunId: TASK_RUN_ID,
    revokedFqns: []
  });
  assert.equal(JSON.stringify(state.ragRunContext).includes('must-not-enter'), false);
  assert.deepEqual(h.subscriptions[0].embeddingContext, {
    embeddingConfig: embeddingRuntime().embeddingConfig
  });
  assert.equal(h.subscriptions[0].analysisSessionId, ANALYSIS_SESSION_ID);
  assert.equal(h.subscriptions[0].reportPairId, REPORT_PAIR_ID);
  assert.deepEqual(h.subscriptions[0].methodIds, [METHOD_ID]);
  assert.deepEqual(state.resolvedRagEmbeddingRuntime, embeddingRuntime());
  assert.deepEqual(state.ragTaskRun, {
    taskRunId: TASK_RUN_ID,
    revokedFqns: []
  });
  assert.deepEqual(h.savedRagRuns, [{
    taskId: TASK_ID,
    ragRun: { taskRunId: TASK_RUN_ID, revokedFqns: [] }
  }]);
  assert.deepEqual(h.events.slice(0, 7), [
    'model', 'embedding',
    'maven-defaults', 'ensure', 'rag_run_knowledge:published',
    'subscribe', 'rag_run_index:reused'
  ]);
});

test('an interrupted RAG execution restores its task-run identity and revocations', async () => {
  const restoredRun = {
    taskRunId: '44444444-4444-4444-8444-444444444444',
    revokedFqns: ['com.example.Removed']
  };
  const h = harness({ checkpointRagRun: restoredRun });
  const state = resources();

  await prepareRun(h.service, state, input());

  assert.equal(h.savedRagRuns.length, 0);
  assert.equal(state.ragRunContext.taskRunId, restoredRun.taskRunId);
  assert.deepEqual(state.ragRunContext.revokedFqns, restoredRun.revokedFqns);
  assert.deepEqual(state.ragTaskRun, {
    ...restoredRun
  });
});

test('RAG generation ensures the current task class before subscribing to global knowledge', async () => {
  const h = harness();
  const state = resources();
  await prepareRun(h.service, state, input());
  assert.equal(h.ensureCalls, 1);
  assert.equal(h.subscriptions.length, 1);
  assert.equal(state.ragRunContext.enabled, true);
  assert.equal(h.events.indexOf('ensure') < h.events.indexOf('subscribe'), true);
  assert.deepEqual(h.ensureInputs[0], {
    workspaceRoot: 'D:\\work',
    moduleRoot: 'D:\\work\\module',
    targetSourcePath: 'D:\\work\\module\\src\\main\\java\\com\\example\\Order.java',
    targetClass: 'com.example.Order',
    embeddingConfig: embeddingRuntime().embeddingConfig,
    signal: undefined
  });
});

test('task knowledge build failure stops a RAG-enabled generation with the cause', async () => {
  const h = harness({ ensureError: new Error('embedding failed') });
  const state = resources();
  await assert.rejects(
    () => prepareRun(h.service, state, input()),
    (error) => {
      assert.equal(error.code, 'RAG_KNOWLEDGE_PREPARATION_FAILED');
      assert.match(error.message, /embedding failed/);
      return true;
    }
  );
  assert.equal(h.ensureCalls, 1);
  assert.equal(h.subscriptions.length, 0);
  assert.equal(state.ragRunContext, null);
  assert.equal(state.resolvedRagEmbeddingRuntime, null);
  assert.equal(h.events.includes('rag_run_index:failed'), true);
});
test('an explicitly saved local repository is used without reading Maven defaults', async () => {
  const h = harness();
  const state = resources();

  await prepareRun(h.service, state, input({
    buildSettings: {
      mavenHome: 'D:\\maven',
      javaHome: 'D:\\jdk',
      localRepository: 'D:\\custom-repository'
    }
  }));

  assert.equal(h.defaultsCalls, 0);
  assert.equal(state.ragRunContext.scope.localRepository, 'D:\\custom-repository');
});

test('no active Embedding interface fails preflight without subscribing to an FTS-only index', async () => {
  const h = harness({ embeddingRuntimeValue: null });
  const state = resources();

  await assert.rejects(
    h.service.preflightRun(state, preflightInput()),
    /数据库|Embedding|RAG/i
  );

  assert.equal(state.ragRunContext, undefined);
  assert.equal(state.resolvedRagEmbeddingRuntime, null);
  assert.equal(h.subscriptions.length, 0);
  assert.equal(h.events.includes('rag_run_index:failed'), false);
});

test('an unresolvable Embedding interface is a fatal startup error without subscribing', async () => {
  const h = harness({ embeddingRuntimeError: new Error('credential unavailable') });
  const state = resources();

  await assert.rejects(
    h.service.preflightRun(state, preflightInput()),
    /credential unavailable/
  );

  assert.deepEqual(state.resolvedModelRuntime, modelRuntime());
  assert.equal(state.ragRunContext, undefined);
  assert.equal(state.resolvedRagEmbeddingRuntime, null);
  assert.equal(h.subscriptions.length, 0);
  assert.equal(h.events.includes('rag_run_index:failed'), false);
});

test('a model marked unsupported for tool calling still passes RAG preflight', async () => {
  const h = harness({
    probeResult: toolCallingProbe({ supported: false })
  });
  const state = resources();

  await h.service.preflightRun(state, preflightInput());

  assert.deepEqual(h.events.slice(0, 2), ['model', 'embedding']);
  assert.equal(h.probeCalls, 0);
  assert.equal(state.ragToolCallingProbe, null);
  assert.equal(state.ragPreflightEnabled, true);
  assert.equal(state.resolvedRagEmbeddingRuntime.embeddingModel, 'embed-local');
});

test('configured tool-probe failures are ignored because preflight does not call the probe', async () => {
  const transient = Object.assign(new Error('模型服务请求超时，请稍后重试。'), {
    code: 'MODEL_TIMEOUT'
  });
  const h = harness({ probeError: transient });
  const state = resources();

  await h.service.preflightRun(state, preflightInput());

  assert.equal(h.probeCalls, 0);
  assert.equal(state.ragToolCallingProbe, null);
  assert.equal(state.ragPreflightEnabled, true);
  assert.equal(state.ragRunContext, undefined);
  assert.equal(h.subscriptions.length, 0);
});

test('a reused or published index without ready vectors is released and downgraded to non-RAG', async () => {
  for (const [status, vectorStatus] of [
    ['reused', 'disabled'],
    ['published', 'degraded']
  ]) {
    const h = harness({ ready: Promise.resolve(preparationResult(status, vectorStatus)) });
    const state = resources();

    await prepareRun(h.service, state, input());

    assert.equal(state.ragRunContext, null);
    assert.equal(state.resolvedRagEmbeddingRuntime, null);
    assert.equal(state.ragSubscription, null);
    assert.equal(h.releaseCalls, 1);
    assert.equal(h.events.includes('rag_run_index:failed'), true);
  }
});

test('index wait timeout keeps the shared subscription and context alive', async () => {
  const gate = deferred();
  const h = harness({ ready: gate.promise, waitMilliseconds: 5 });
  const state = resources();

  await prepareRun(h.service, state, input());

  assert.equal(h.releaseCalls, 0);
  assert.equal(h.subscriptions.length, 1);
  assert.equal(state.ragRunContext.enabled, true);
  assert.equal(h.events.includes('rag_run_index:timed_out'), true);
  gate.resolve(preparationResult('published'));
  await gate.promise;
  assert.equal(h.releaseCalls, 0);
});

test('a timed-out index is downgraded later when its vectors finish non-ready', async () => {
  const gate = deferred();
  const h = harness({ ready: gate.promise, waitMilliseconds: 1 });
  const state = resources();

  await prepareRun(h.service, state, input());
  assert.equal(state.ragRunContext.enabled, true);

  gate.resolve(preparationResult('reused', 'disabled'));
  await gate.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.ragRunContext, null);
  assert.equal(state.resolvedRagEmbeddingRuntime, null);
  assert.equal(state.ragSubscription, null);
  assert.equal(h.releaseCalls, 1);
  assert.equal(h.events.includes('rag_run_index:failed'), true);
});

test('configuration and subscription failures are fatal while asynchronous readiness can degrade', async () => {
  const subscribeFailure = harness({ subscribeError: new Error('index unavailable') });
  const subscribeState = resources();
  await assert.rejects(
    () => prepareRun(subscribeFailure.service, subscribeState, input()),
    (error) => error.code === 'RAG_KNOWLEDGE_PREPARATION_FAILED'
      && /index unavailable/.test(error.message)
  );
  assert.equal(subscribeState.ragRunContext, null);
  assert.equal(subscribeState.resolvedRagEmbeddingRuntime, null);
  assert.equal(subscribeState.ragSubscription, null);

  const readyFailure = harness({ ready: Promise.reject(new Error('build failed')) });
  const readyState = resources();
  await prepareRun(readyFailure.service, readyState, input());
  assert.equal(readyState.ragRunContext, null);
  assert.equal(readyState.resolvedRagEmbeddingRuntime, null);
  assert.equal(readyFailure.releaseCalls, 1);
  assert.equal(readyFailure.events.includes('rag_run_index:failed'), true);
});

test('terminal release is idempotent and clears Agent plus durable task-run authorization', async () => {
  const gate = deferred();
  const h = harness({ ready: gate.promise, waitMilliseconds: 1 });
  const first = resources();
  await prepareRun(h.service, first, input());

  await h.service.releaseRun(first);
  await h.service.releaseRun(first);

  assert.equal(h.releaseCalls, 1);
  assert.deepEqual(h.releasedTaskRuns, [{
    taskRunId: TASK_RUN_ID,
    request: undefined
  }]);
  assert.deepEqual(h.clearedRagRuns, [{ taskId: TASK_ID, taskRunId: TASK_RUN_ID }]);
  assert.equal(h.durableRagRun, null);
  assert.equal(first.ragRunContext, undefined);
  assert.equal(first.ragTaskRun, undefined);
  assert.equal(first.resolvedModelRuntime, null);
  assert.equal(first.resolvedRagEmbeddingRuntime, null);
  gate.resolve(preparationResult());
});

test('clean suspension releases local resources but restores the same interrupted task run', async () => {
  const h = harness();
  const state = resources();

  await prepareRun(h.service, state, input());
  await h.service.suspendRun(state);
  await prepareRun(h.service, state, input());

  assert.equal(h.modelCalls, 2);
  assert.equal(h.subscriptions.length, 2);
  assert.equal(h.releasedTaskRuns.length, 0);
  assert.equal(h.clearedRagRuns.length, 0);
  assert.equal(h.savedRagRuns.length, 1);
  assert.equal(state.ragTaskRun.taskRunId, TASK_RUN_ID);
  assert.equal(state.ragRunContext.taskRunId, TASK_RUN_ID);
  assert.equal(state.ragRunContext.enabled, true);
});

test('suspendAll preserves checkpoints while releasing every local index subscription', async () => {
  const gate = deferred();
  const h = harness({ ready: gate.promise, waitMilliseconds: 1 });
  const secondTaskId = '22222222-2222-4222-8222-222222222222';
  const first = resources();
  const second = resources(secondTaskId);
  await prepareRun(h.service, first, input());
  await prepareRun(h.service, second, input({ taskId: secondTaskId }));

  await h.service.suspendAll([first, second]);

  assert.equal(h.releaseCalls, 2);
  assert.equal(h.releaseAllCalls, 1);
  assert.equal(h.releasedTaskRuns.length, 0);
  assert.equal(h.clearedRagRuns.length, 0);
  assert.equal(first.ragRunContext, undefined);
  assert.equal(second.ragRunContext, undefined);
  gate.resolve(preparationResult());
});

test('task cancellation interrupts readiness waiting instead of being treated as RAG degradation', async () => {
  const gate = deferred();
  const h = harness({ ready: gate.promise });
  const state = resources();
  const controller = new AbortController();
  await h.service.preflightRun(
    state,
    preflightInput(input({ signal: controller.signal }))
  );
  const preparing = h.service.prepareIndex(
    state,
    input({ signal: controller.signal })
  );
  await Promise.resolve();
  await Promise.resolve();

  controller.abort(new Error('task terminated'));

  await assert.rejects(preparing, /task terminated/);
  assert.equal(h.events.includes('rag_run_index:failed'), false);
  await h.service.releaseRun(state);
  assert.equal(h.releaseCalls, 1);
  gate.resolve(preparationResult());
});
