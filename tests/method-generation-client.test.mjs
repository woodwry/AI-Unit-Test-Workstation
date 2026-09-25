import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import {
  AiClient,
  isJavaAnalyzerResponseTimeoutError,
  methodGenerationRecoveryPollDelayMilliseconds
} from '../src/main/services/ai-client.ts';
import { MethodAnalysisRequestError } from '../src/main/services/method-analysis-contract.ts';
import {
  decodeMethodGenerationEvent,
  decodeMethodGenerationWaveEvent,
  validateRecoverMethodGenerationRequest,
  validateStartMethodGenerationWaveRequest
} from '../src/main/services/method-generation-contract.ts';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const CLIENT_REQUEST_ID = '223e4567-e89b-42d3-a456-426614174000';
const CLASS_TASK_ID = '323e4567-e89b-42d3-a456-426614174000';
const CANDIDATE_ID = '423e4567-e89b-42d3-a456-426614174000';
const FEEDBACK_ID = '523e4567-e89b-42d3-a456-426614174000';
const METHOD_ID = 'b'.repeat(64);
const REPORT_PAIR_ID = 'a'.repeat(64);
const BATCH_ID = 'c'.repeat(64);
const TEST_CODE = 'package demo;\npublic class TaskServiceTmp1Test {}\n';
const TEST_CODE_SHA = createHash('sha256').update(TEST_CODE).digest('hex');
const WAVE_SESSION_ID = '723e4567-e89b-42d3-a456-426614174000';
const WAVE_ID = 'd'.repeat(64);

test('generation recovery polling backs off from one second to a ten second cap', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((idlePollCount) => (
      methodGenerationRecoveryPollDelayMilliseconds(idlePollCount)
    )),
    [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]
  );
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const modelContext = {
  llmConfig: {
    provider: 'custom_openai',
    model: 'unit-test-model',
    baseUrl: 'https://models.example.com/v1',
    credentials: { apiKey: 'secret-token' }
  }
};

function managedAccess(offset = 0) {
  return {
    agentServiceUrl: `http://127.0.0.1:${30100 + offset}`,
    javaAnalyzerUrl: `http://127.0.0.1:${30200 + offset}`,
    agentServiceAuthorizationHeader: `Bearer managed-secret-${offset}`,
    javaAnalyzerAuthorizationHeader: `Bearer analyzer-secret-${offset}`
  };
}

function oneTestBatch() {
  return {
    batchId: BATCH_ID,
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    hasWork: true,
    method: {
      methodId: METHOD_ID,
      declaringType: 'demo.TaskService',
      methodName: 'run',
      descriptor: '()V',
      firstLine: 10,
      lastLine: 20,
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
        chineseInstruction: '直接调用目标方法'
      },
      activeScenarioIds: ['scenario-1']
    },
    scenarios: [{
      scenarioId: 'scenario-1',
      scenarioSignature: 'run-path-1',
      methodId: METHOD_ID,
      targetLines: [11],
      targetBranches: ['branch-1'],
      chineseDescription: '覆盖未执行分支',
      inputPreparation: [],
      requiredStubIds: [],
      expectedPath: ['returns'],
      loopExitCondition: '',
      loopCoveragePlan: null,
      coverageTargetIds: ['target-1'],
      pathConstraints: [],
      status: 'READY'
    }],
    methodTestPlan: {
      methodId: METHOD_ID,
      analysisStatus: 'READY',
      minimumTestCount: 1,
      remainingTargets: [{
        targetId: 'target-1',
        methodId: METHOD_ID,
        decisionId: 'decision-1',
        instructionIndex: 1,
        sourceLine: 11,
        kind: 'BRANCH',
        direction: 'TRUE',
        covered: false,
        mappingStatus: 'EXACT',
        requiredEdgeIds: ['edge-1']
      }],
      testPathGroups: [{
        groupId: 'group-1',
        methodId: METHOD_ID,
        ordinal: 1,
        scenarioIds: ['scenario-1'],
        targetIds: ['target-1'],
        constraints: [],
        inputRequirements: [],
        mockRequirements: [],
        expectedExit: 'RETURNS',
        singleTargetInvocation: true,
        status: 'READY'
      }],
      testMethodPlans: [{
        testMethodPlanId: 'test-plan-1',
        methodId: METHOD_ID,
        ordinal: 1,
        pathGroupIds: ['group-1'],
        status: 'READY'
      }],
      fallbackReason: ''
    },
    methodStubInventory: {
      methodId: METHOD_ID,
      status: 'READY',
      requiredCallCount: 0,
      unresolvedRequiredCallCount: 0,
      calls: []
    },
    activeStubPlans: [],
    targetFixturePlan: {
      targetClass: 'demo.TaskService',
      targetVariableName: 'target',
      targetClassDeclaration: 'private TaskService target;',
      dependencySourceDeclarations: [],
      constructionMode: 'CONSTRUCTOR',
      constructorParameterTypes: [],
      constructorArgumentFixtureIds: [],
      dependencies: [],
      setupStatements: ['target = new TaskService();'],
      status: 'READY',
      chineseInstruction: '构造目标对象'
    },
    referencedTypes: [],
    necessaryImports: ['org.junit.jupiter.api.Test'],
    plannedTestMethods: 1,
    remainingTestMethods: 0,
    warnings: []
  };
}

function startRequest(overrides = {}) {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    classTaskId: CLASS_TASK_ID,
    methodId: METHOD_ID,
    batchId: BATCH_ID,
    batchIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    expectedPackageName: 'demo',
    buildToolchain: {
      javaVersion: '21.0.5',
      mavenVersion: '3.9.9'
    },
    batch: oneTestBatch(),
    captureModelCalls: false,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    ...overrides
  };
}

function enabledRagContext() {
  return {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: ['D:\\work\\module\\target\\classes'],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: 'f'.repeat(64)
    },
    activeIndex: {
      workspaceId: 'a'.repeat(64),
      scopeId: 'b'.repeat(64),
      indexVersion: 1,
      sourceSetId: 'c'.repeat(64),
      requestedSourceSetFingerprint: '84ca98d235db68f4737289d37526f870dfc4bce041f0ed0cfaec751d66a6e344',
      allowedFqns: ['com.example.Order']
    },
    taskRunId: '623e4567-e89b-42d3-a456-426614174000',
    revokedFqns: []
  };
}

function ragRepairAttempt() {
  return {
    diagnosticFingerprint: '8'.repeat(64),
    activeIndex: structuredClone(enabledRagContext().activeIndex)
  };
}

function prepareRagRepairRequest() {
  return {
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    methodId: METHOD_ID,
    batchId: BATCH_ID,
    batchIndex: 1,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    execution: compileFailureExecution()
  };
}

function compileFailureExecution() {
  return {
    status: 'compile_failed',
    mavenExecutions: [{
      scope: 'method_candidate',
      phase: 'test_compile',
      command: 'mvn test-compile',
      exitCode: 1,
      stdout: '',
      stderr: `${String.raw`D:\work\TaskServiceTmp1Test.java`}:7: unreported exception demo.ReportException`,
      surefireReports: []
    }]
  };
}

function structuredRepairContext(overrides = {}) {
  return {
    status: 'compile_failed',
    compilerErrors: [{
      filePath: String.raw`D:\work\TaskServiceTmp1Test.java`,
      line: 7,
      column: 1,
      category: 'unreported_exception',
      message: 'unreported exception demo.ReportException'
    }],
    affectedTestNames: [],
    exceptions: [],
    generatedTestFrames: [],
    productionFrames: [],
    missingSymbols: [],
    relatedTypeFqns: ['demo.ReportException'],
    truncated: false,
    droppedItemCount: 0,
    analyzerStatus: 'available',
    analyzerWarnings: [],
    sourceSha256: 'd'.repeat(64),
    targetMethod: {
      methodId: METHOD_ID,
      declaringType: 'demo.TaskService',
      methodName: 'run',
      descriptor: '()V',
      modifiers: ['public'],
      firstLine: 10,
      lastLine: 20,
      sourceFirstLine: 10,
      sourceLastLine: 20,
      sourceText: 'public void run() {}',
      sourceComplete: true,
      parameterTypes: [],
      returnType: 'void',
      declaredExceptions: []
    },
    stackMethods: [],
    referencedTypes: [],
    ...overrides
  };
}

function passedFeedbackExecution() {
  return {
    status: 'passed',
    mavenExecutions: [{
      scope: 'method_candidate',
      phase: 'test_compile',
      command: 'mvn test-compile',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }, {
      scope: 'method_candidate',
      phase: 'test',
      command: 'mvn surefire:test',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: [{ fileName: 'TEST-demo.xml', content: '<testsuite />' }]
    }],
    testReport: {
      reportCount: 1,
      tests: 1,
      failures: 0,
      errors: 0,
      skipped: 0,
      generatedTestClassName: 'demo.TaskServiceTmp1Test',
      generatedTests: 1,
      generatedSkipped: 0,
      failureDetails: []
    }
  };
}

function candidate(overrides = {}) {
  return {
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    methodId: METHOD_ID,
    batchId: BATCH_ID,
    batchIndex: 1,
    testCode: TEST_CODE,
    generatedCodeSha256: TEST_CODE_SHA,
    outputTestClassName: 'TaskServiceTmp1Test',
    ordinaryTestMethodCount: 1,
    usage: null,
    ...overrides
  };
}

function event(eventSequence, eventType, payload) {
  return {
    sessionId: SESSION_ID,
    eventSequence,
    eventType,
    occurredAt: '2026-08-09T00:00:00Z',
    progress: null,
    candidate: null,
    completion: null,
    modelCall: null,
    error: null,
    [payload.name]: payload.value
  };
}

function candidateEvent(sequence = 1, overrides = {}) {
  return event(sequence, 'candidate_ready', {
    name: 'candidate',
    value: candidate(overrides)
  });
}

function progressEvent(sequence = 1) {
  return event(sequence, 'progress', {
    name: 'progress',
    value: {
      repairAttempt: 0,
      stage: 'generating',
      completedTestMethods: 0,
      remainingTestMethods: 1
    }
  });
}

function completedModelCallEvent(sequence = 1, usage = null, overrides = {}) {
  return event(sequence, 'model_call', {
    name: 'modelCall',
    value: {
      sessionId: SESSION_ID,
      callId: '623e4567-e89b-42d3-a456-426614174000',
      parentCallId: null,
      phase: 'completed',
      callKind: 'generation',
      methodId: METHOD_ID,
      batchId: BATCH_ID,
      batchIndex: 1,
      repairAttempt: 0,
      candidateVersion: 1,
      modelName: 'unit-test-model',
      startedAt: '2026-08-09T00:00:00Z',
      occurredAt: '2026-08-09T00:00:01Z',
      systemPrompt: null,
      userPrompt: null,
      rawOutput: TEST_CODE,
      processedOutput: TEST_CODE,
      processingValid: true,
      usage,
      errorCode: null,
      statusCode: null,
      errorType: null,
      providerCode: null,
      truncated: false,
      ...overrides
    }
  });
}

test('keeps an empty invalid model output observable so the Agent repair can continue', () => {
  const invalidOutput = completedModelCallEvent(1, {
    inputTokens: 6_286,
    outputTokens: 65_536,
    totalTokens: 71_822
  }, {
    rawOutput: '',
    processedOutput: null,
    processingValid: false,
    processingError: '模型返回的 Java 测试文件为空。'
  });

  const decoded = decodeMethodGenerationEvent(invalidOutput, {
    previousEventSequence: 0,
    identity: { methodId: METHOD_ID, batchId: BATCH_ID, batchIndex: 1 }
  });

  assert.equal(decoded.modelCall.rawOutput, '');
  assert.equal(decoded.modelCall.processedOutput, null);
  assert.equal(decoded.modelCall.processingValid, false);
  assert.equal(
    decoded.modelCall.processingError,
    '模型返回的 Java 测试文件为空。'
  );
  assert.throws(() => decodeMethodGenerationEvent(
    completedModelCallEvent(1, null, { rawOutput: '' }),
    { previousEventSequence: 0 }
  ));
});

test('reports an Analyzer response timeout separately from a connection failure', async () => {
  const client = new AiClient(async () => {
    throw new TypeError('fetch failed', {
      cause: { code: 'UND_ERR_HEADERS_TIMEOUT' }
    });
  });
  client.setBackendSettings({
    agentServiceUrl: 'http://127.0.0.1:30100',
    javaAnalyzerUrl: 'http://127.0.0.1:30200'
  });

  await assert.rejects(
    client.heartbeatMethodAnalysisSession(SESSION_ID),
    (error) => (
      isJavaAnalyzerResponseTimeoutError(error)
      && /Java Analyzer 响应等待时间过长，请稍后重试。/.test(error.message)
    )
  );
});

test('checks the Java Analyzer health endpoint without surfacing a health probe timeout', async () => {
  const calls = [];
  const client = new AiClient(async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return new Response('', { status: 200 });
    throw new TypeError('fetch failed', {
      cause: { code: 'UND_ERR_HEADERS_TIMEOUT' }
    });
  });
  client.setBackendSettings({
    agentServiceUrl: 'http://127.0.0.1:30100',
    javaAnalyzerUrl: 'http://127.0.0.1:30200'
  });

  assert.equal(await client.isJavaAnalyzerHealthy(), true);
  assert.equal(await client.isJavaAnalyzerHealthy(), false);
  assert.equal(calls[0].url, 'http://127.0.0.1:30200/api/health');
  assert.equal(calls[0].init.method, 'GET');
});
test('reports a Java Analyzer connection failure instead of raw fetch failed', async () => {
  const client = new AiClient(async () => {
    throw new TypeError('fetch failed');
  });
  client.setBackendSettings({
    agentServiceUrl: 'http://127.0.0.1:30100',
    javaAnalyzerUrl: 'http://127.0.0.1:30200'
  });

  await assert.rejects(
    client.heartbeatMethodAnalysisSession(SESSION_ID),
    /Java Analyzer 无法连接，请确认服务已启动后重试。/
  );
});

test('preserves the Analyzer error code when heartbeat reports a cancelled session', async () => {
  const client = new AiClient(async () => new Response(JSON.stringify({
    code: 'ANALYSIS_SESSION_CANCELLED',
    message: '分析会话已经取消。'
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' }
  }));
  client.setBackendSettings({
    agentServiceUrl: 'http://127.0.0.1:30100',
    javaAnalyzerUrl: 'http://127.0.0.1:30200'
  });

  await assert.rejects(
    client.heartbeatMethodAnalysisSession(SESSION_ID),
    (error) => (
      error instanceof MethodAnalysisRequestError
      && error.code === 'ANALYSIS_SESSION_CANCELLED'
      && /分析会话已经取消/.test(error.message)
    )
  );
});

test('merged Wave repair events allow up to one hundred twenty-five test methods', () => {
  const options = {
    previousEventSequence: 0,
    identity: {
      methodId: METHOD_ID,
      batchId: BATCH_ID,
      batchIndex: 1,
      outputTestClassName: 'TaskServiceTmp1Test',
      plannedTestMethods: 125
    }
  };
  const decoded = decodeMethodGenerationEvent(event(1, 'candidate_ready', {
    name: 'candidate',
    value: candidate({ ordinaryTestMethodCount: 125 })
  }), options);
  assert.equal(decoded.candidate.ordinaryTestMethodCount, 125);
  assert.throws(() => decodeMethodGenerationEvent(event(1, 'candidate_ready', {
    name: 'candidate',
    value: candidate({ ordinaryTestMethodCount: 126 })
  }), options));
});

test('repair candidates and recovery allow fewer tests without loosening initial generation counts', () => {
  const request = startRequest();
  request.batch.plannedTestMethods = 2;
  const identity = {
    methodId: METHOD_ID, batchId: BATCH_ID, batchIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test', plannedTestMethods: 2
  };
  const repaired = candidate({ candidateVersion: 2, repairAttempt: 1 });
  const decoded = decodeMethodGenerationEvent(event(1, 'candidate_ready', {
    name: 'candidate', value: repaired
  }), { previousEventSequence: 0, identity });
  assert.equal(decoded.candidate.ordinaryTestMethodCount, 1);
  assert.equal(validateRecoverMethodGenerationRequest({
    startRequest: request, candidate: repaired
  }).plannedTestMethods, 2);

  for (const invalidCandidate of [
    candidate(),
    candidate({ candidateVersion: 2, repairAttempt: 1, ordinaryTestMethodCount: 3 }),
    candidate({ candidateVersion: 2, repairAttempt: 1, ordinaryTestMethodCount: 0 })
  ]) {
    assert.throws(() => decodeMethodGenerationEvent(event(1, 'candidate_ready', {
      name: 'candidate', value: invalidCandidate
    }), { previousEventSequence: 0, identity }));
    assert.throws(() => validateRecoverMethodGenerationRequest({
      startRequest: request, candidate: invalidCandidate
    }));
  }
});

test('keeps the original planned count after a repair candidate contains fewer tests', async () => {
  const initialRequest = startRequest();
  initialRequest.batch.plannedTestMethods = 2;
  const secondCandidateId = '723e4567-e89b-42d3-a456-426614174000';
  const thirdCandidateId = '823e4567-e89b-42d3-a456-426614174000';
  const responses = [
    sseResponse([candidateEvent(1, { ordinaryTestMethodCount: 2 })]),
    sseResponse([candidateEvent(2, {
      candidateId: secondCandidateId,
      candidateVersion: 2,
      repairAttempt: 1,
      ordinaryTestMethodCount: 1
    })]),
    sseResponse([
      event(3, 'progress', {
        name: 'progress',
        value: {
          repairAttempt: 2,
          stage: 'repairing',
          completedTestMethods: 0,
          remainingTestMethods: 2
        }
      }),
      candidateEvent(4, {
        candidateId: thirdCandidateId,
        candidateVersion: 3,
        repairAttempt: 2,
        ordinaryTestMethodCount: 1
      })
    ])
  ];
  const client = new AiClient(async () => responses.shift());
  client.setManagedBackendAccessProvider(() => managedAccess());

  const initial = await client.startMethodGenerationStream(
    initialRequest,
    modelContext,
    () => {}
  );
  const repaired = await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: initial.eventSequence,
    candidateId: initial.candidate.candidateId,
    candidateVersion: initial.candidate.candidateVersion,
    repairAttempt: initial.candidate.repairAttempt,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    repairContext: structuredRepairContext()
  }, modelContext, () => {});
  const progress = [];
  const next = await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: 'd23e4567-e89b-42d3-a456-426614174000',
    expectedEventSequence: repaired.eventSequence,
    candidateId: repaired.candidate.candidateId,
    candidateVersion: repaired.candidate.candidateVersion,
    repairAttempt: repaired.candidate.repairAttempt,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    repairContext: structuredRepairContext()
  }, modelContext, (value) => progress.push(value));

  assert.equal(next.kind, 'candidate_ready');
  assert.equal(progress[0].progress.remainingTestMethods, 2);
});
function ragToolExchange(overrides = {}) {
  return {
    sequence: 1,
    toolCallId: 'source-call-1',
    toolName: 'retrieve_java_source',
    modelRequestSequence: 1,
    rawArguments: '{ "query" : "Order" }',
    validatedInput: { query: 'Order' },
    toolMessage: '{"status":"NOT_FOUND","results":[],"nextCursor":null,"degradationCode":null}',
    includedInModelRequestSequence: 2,
    status: 'NOT_FOUND',
    startedAt: '2026-08-09T00:00:00Z',
    completedAt: '2026-08-09T00:00:01Z',
    durationMs: 1_000,
    cacheHit: false,
    physicalAttempts: [{
      attempt: 1,
      status: 'NOT_FOUND',
      toolMessage: '{"status":"NOT_FOUND","results":[],"nextCursor":null,"degradationCode":null}',
      retryScheduled: false,
      startedAt: '2026-08-09T00:00:00Z',
      completedAt: '2026-08-09T00:00:01Z',
      durationMs: 1_000
    }],
    evidenceStatus: 'NO_NEW_EVIDENCE',
    consecutiveNoNewEvidence: 1,
    forcedFinalOutput: false,
    ...overrides
  };
}

test('decodes diagnostic-id RAG exchanges and rejects malformed or unknown arguments', () => {
  for (const validatedInput of [
    { diagnostic_ids: ['E1', 'E2'] },
    { query: 'Order', diagnostic_id: 'E1' }
  ]) {
    const repair = completedModelCallEvent(1, null, {
      callKind: 'repair', repairAttempt: 1, candidateVersion: 2,
      toolExchanges: [ragToolExchange({ validatedInput })]
    });
    assert.deepEqual(decodeMethodGenerationEvent(repair, {
      previousEventSequence: 0
    }).modelCall.toolExchanges[0].validatedInput, validatedInput);
  }
  for (const validatedInput of [
    { diagnostic_ids: [] }, { diagnostic_ids: ['E1', 'E1'] },
    { diagnostic_ids: '["E1"]' }, { diagnostic_ids: ['E 1'] },
    { diagnostic_ids: Array.from({ length: 33 }, (_, i) => `E${i + 1}`) },
    { diagnostic_ids: ['E1'], cursor: 'abcdefghijklmnop' },
    { diagnostic_id: 'E1' }, { diagnostic_ids: ['E1'], unexpected: true }
  ]) {
    assert.throws(() => decodeMethodGenerationEvent(completedModelCallEvent(1, null, {
      callKind: 'repair', repairAttempt: 1, candidateVersion: 2,
      toolExchanges: [ragToolExchange({ validatedInput })]
    }), { previousEventSequence: 0 }));
  }
});

test('retains RAG request and tool traces when a repair fails or is stopped', () => {
  for (const phase of ['failed', 'stopped']) {
    const repair = completedModelCallEvent(1, null, {
      callKind: 'repair', repairAttempt: 1, candidateVersion: 2, phase,
      rawOutput: null, processedOutput: null, processingValid: null, usage: null,
      errorCode: phase === 'failed' ? 'MODEL_UNAVAILABLE' : null,
      requestTraces: ['{"input":[]}'], toolExchanges: [ragToolExchange()]
    });
    assert.equal(decodeMethodGenerationEvent(repair, {
      previousEventSequence: 0
    }).modelCall.toolExchanges.length, 1);
  }
});

test('decodes exact RAG tool exchanges on terminal repair model calls', () => {
  const repair = completedModelCallEvent(1, null, {
    callKind: 'repair',
    repairAttempt: 1,
    candidateVersion: 2,
    toolExchanges: [ragToolExchange()]
  });

  const decoded = decodeMethodGenerationEvent(repair, {
    previousEventSequence: 0,
    identity: { methodId: METHOD_ID, batchId: BATCH_ID, batchIndex: 1 }
  });

  assert.deepEqual(decoded.modelCall.toolExchanges, [ragToolExchange()]);
  assert.throws(() => decodeMethodGenerationEvent(
    completedModelCallEvent(1, null, {
      toolExchanges: [ragToolExchange()]
    }),
    { previousEventSequence: 0 }
  ));
  const unknownNestedField = structuredClone(repair);
  unknownNestedField.modelCall.toolExchanges[0].unexpected = true;
  assert.throws(() => decodeMethodGenerationEvent(
    unknownNestedField,
    { previousEventSequence: 0 }
  ));

  const manyExchanges = completedModelCallEvent(1, null, {
    callKind: 'repair',
    repairAttempt: 1,
    candidateVersion: 2,
    toolExchanges: Array.from({ length: 5 }, (_, index) => ragToolExchange({
      sequence: index + 1,
      toolCallId: `source-call-${index + 1}`,
      modelRequestSequence: index + 1,
      includedInModelRequestSequence: index + 2
    }))
  });
  assert.equal(
    decodeMethodGenerationEvent(manyExchanges, {
      previousEventSequence: 0,
      identity: { methodId: METHOD_ID, batchId: BATCH_ID, batchIndex: 1 }
    }).modelCall.toolExchanges.length,
    5
  );
});

test('decodes RAG tool budget exhaustion as a completed repair model-call trace', () => {
  const repair = completedModelCallEvent(1, null, {
    callKind: 'repair',
    repairAttempt: 1,
    candidateVersion: 2,
    toolExchanges: [
      ragToolExchange({
        sequence: 1,
        status: 'INVALID_ARGUMENTS',
        validatedInput: null,
        physicalAttempts: [],
        evidenceStatus: 'NO_NEW_EVIDENCE',
        consecutiveNoNewEvidence: 1
      }),
      ragToolExchange({
        sequence: 2,
        toolCallId: 'source-call-2',
        modelRequestSequence: 2,
        includedInModelRequestSequence: 3,
        status: 'TOOL_CALL_BUDGET_EXHAUSTED',
        validatedInput: null,
        physicalAttempts: [],
        evidenceStatus: 'NOT_EVALUATED',
        consecutiveNoNewEvidence: 1,
        forcedFinalOutput: true
      })
    ]
  });

  const decoded = decodeMethodGenerationEvent(repair, {
    previousEventSequence: 0,
    identity: { methodId: METHOD_ID, batchId: BATCH_ID, batchIndex: 1 }
  });

  assert.equal(decoded.modelCall.toolExchanges[1].status, 'TOOL_CALL_BUDGET_EXHAUSTED');
  assert.equal(decoded.modelCall.toolExchanges[1].forcedFinalOutput, true);
});
function errorEvent(sequence, code, message) {
  return event(sequence, 'error', {
    name: 'error',
    value: {
      code,
      message,
      stage: 'generation'
    }
  });
}

function completionEvent(sequence = 2, stopReason = 'verified') {
  return event(sequence, 'completed', {
    name: 'completion',
    value: {
      methodId: METHOD_ID,
      batchId: BATCH_ID,
      stopReason,
      bestCandidateId: CANDIDATE_ID,
      aggregateUsage: null,
      modelCallCount: 1,
      usageReportedCallCount: 0
    }
  });
}

function status(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    phase: 'running',
    lastEventSequence: 1,
    pendingCandidate: null,
    completion: null,
    terminalError: null,
    events: [progressEvent()],
    ...overrides
  };
}

function sseResponse(events, statusCode = 200) {
  const body = events.map((value) => (
    `id: ${value.eventSequence}\nevent: method_generation_session\ndata: ${JSON.stringify(value)}\n\n`
  )).join('');
  return new Response(body, {
    status: statusCode,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

function jsonResponse(statusCode, value) {
  return new Response(JSON.stringify(value), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('repeated recovery status requests do not accumulate transport listeners on the task signal', async () => {
  const taskController = new AbortController();
  const transportSignals = [];
  const client = new AiClient(async (input, init) => {
    assert.ok(init.signal);
    transportSignals.push(init.signal);
    // Node fetch registers its own abort listener. Keeping that listener here models the
    // runtime behavior that triggered MaxListenersExceededWarning on a long-lived task signal.
    init.signal.addEventListener('abort', () => {}, { once: true });
    const url = new URL(String(input));
    if (url.pathname.includes('/method-generation-waves/')) {
      return jsonResponse(200, {
        waveSessionId: WAVE_SESSION_ID,
        waveId: WAVE_ID,
        methodId: METHOD_ID,
        waveIndex: 1,
        phase: 'running',
        lastEventSequence: 0,
        terminalParts: [],
        completion: null,
        terminalError: null,
        events: []
      });
    }
    return jsonResponse(200, status({
      lastEventSequence: 0,
      events: []
    }));
  });
  client.setManagedBackendAccessProvider(() => managedAccess(30));

  for (let index = 0; index < 25; index += 1) {
    await client.getMethodGenerationStatus(SESSION_ID, 0, taskController.signal);
    await client.getMethodGenerationWaveStatus(WAVE_SESSION_ID, 0, taskController.signal);
  }

  assert.equal(transportSignals.length, 50);
  assert.equal(new Set(transportSignals).size, 50);
  assert.ok(transportSignals.every((signal) => signal !== taskController.signal));
  assert.equal(getEventListeners(taskController.signal, 'abort').length, 0);
});

test('an isolated recovery status request still forwards task cancellation', async () => {
  const taskController = new AbortController();
  const requestStarted = deferred();
  let requestSignal;
  const client = new AiClient(async (_input, init) => {
    requestSignal = init.signal;
    requestStarted.resolve();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  client.setManagedBackendAccessProvider(() => managedAccess(31));

  const pending = client.getMethodGenerationStatus(SESSION_ID, 0, taskController.signal);
  await requestStarted.promise;
  assert.notEqual(requestSignal, taskController.signal);
  assert.equal(getEventListeners(taskController.signal, 'abort').length, 1);

  const stopReason = new Error('stop recovery polling');
  taskController.abort(stopReason);

  await assert.rejects(pending, (error) => error === stopReason);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason, stopReason);
  assert.equal(getEventListeners(taskController.signal, 'abort').length, 0);
});

function wavePartStart(partIndex) {
  const batch = structuredClone(oneTestBatch());
  const partBatchId = String(partIndex).repeat(64);
  const scenarioId = `wave-scenario-${partIndex}`;
  batch.batchId = partBatchId;
  batch.method.activeScenarioIds = [scenarioId];
  batch.scenarios[0].scenarioId = scenarioId;
  batch.scenarios[0].scenarioSignature = `wave-path-${partIndex}`;
  batch.methodTestPlan.testPathGroups[0].scenarioIds = [scenarioId];
  return {
    partIndex,
    partBatchId,
    scenarioIds: [scenarioId],
    request: startRequest({
      clientRequestId: `${partIndex}23e4567-e89b-42d3-a456-426614174000`,
      batchId: partBatchId,
      batchIndex: partIndex,
      outputTestClassName: `TaskServiceTmp1Part${partIndex}Test`,
      batch
    })
  };
}

function startWaveRequest(partCount = 2) {
  return {
    waveId: WAVE_ID,
    methodId: METHOD_ID,
    waveIndex: 1,
    parts: Array.from({ length: partCount }, (_, index) => wavePartStart(index + 1))
  };
}

function waveCandidate(partIndex) {
  const className = `TaskServiceTmp1Part${partIndex}Test`;
  const code = `package demo;\npublic class ${className} {}\n`;
  return candidate({
    candidateId: `423e4567-e89b-42d3-a456-42661417400${partIndex}`,
    batchId: String(partIndex).repeat(64),
    batchIndex: partIndex,
    testCode: code,
    generatedCodeSha256: createHash('sha256').update(code).digest('hex'),
    outputTestClassName: className
  });
}

function wavePartResult(partIndex, status = 'succeeded') {
  const childSessionId = `623e4567-e89b-42d3-a456-42661417400${partIndex}`;
  const aggregateUsage = status === 'succeeded'
    ? { inputTokens: partIndex, outputTokens: partIndex * 2, totalTokens: partIndex * 3 }
    : null;
  return {
    partIndex,
    partBatchId: String(partIndex).repeat(64),
    scenarioIds: [`wave-scenario-${partIndex}`],
    status,
    childSessionId: status === 'succeeded' ? childSessionId : null,
    candidate: status === 'succeeded' ? waveCandidate(partIndex) : null,
    error: status === 'failed'
      ? { code: 'MODEL_TIMEOUT', message: 'timeout', stage: 'generation' }
      : null,
    aggregateUsage,
    modelCallCount: status === 'succeeded' ? 1 : 0,
    usageReportedCallCount: status === 'succeeded' ? 1 : 0
  };
}

function waveCompletion(parts) {
  const usageParts = parts.flatMap((part) => part.aggregateUsage ? [part.aggregateUsage] : []);
  return {
    parts,
    succeededPartCount: parts.filter((part) => part.status === 'succeeded').length,
    failedPartCount: parts.filter((part) => part.status === 'failed').length,
    cancelledPartCount: parts.filter((part) => part.status === 'cancelled').length,
    aggregateUsage: usageParts.length === 0 ? null : {
      inputTokens: usageParts.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: usageParts.reduce((sum, usage) => sum + usage.outputTokens, 0),
      totalTokens: usageParts.reduce((sum, usage) => sum + usage.totalTokens, 0)
    },
    modelCallCount: parts.reduce((sum, part) => sum + part.modelCallCount, 0),
    usageReportedCallCount: parts.reduce(
      (sum, part) => sum + part.usageReportedCallCount,
      0
    )
  };
}

function waveEvent(eventSequence, eventType, overrides = {}) {
  return {
    waveSessionId: WAVE_SESSION_ID,
    eventSequence,
    waveId: WAVE_ID,
    methodId: METHOD_ID,
    waveIndex: 1,
    eventType,
    occurredAt: '2026-08-19T00:00:00Z',
    partIndex: null,
    partBatchId: null,
    scenarioIds: [],
    childSessionId: null,
    candidateId: null,
    childEvent: null,
    partResult: null,
    completion: null,
    error: null,
    ...overrides
  };
}

function wavePartSucceededEvent(sequence, partIndex) {
  const result = wavePartResult(partIndex);
  return waveEvent(sequence, 'part_succeeded', {
    partIndex,
    partBatchId: result.partBatchId,
    scenarioIds: result.scenarioIds,
    childSessionId: result.childSessionId,
    candidateId: result.candidate.candidateId,
    partResult: result
  });
}

function waveCompletedEvent(sequence, parts) {
  return waveEvent(sequence, 'wave_completed', {
    completion: waveCompletion(parts)
  });
}

function waveSseResponse(events) {
  return new Response(events.map((value) => (
    `id: ${value.eventSequence}\nevent: method_generation_wave\n`
      + `data: ${JSON.stringify(value)}\n\n`
  )).join(''), {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

test('starts one Wave without the same-model global lock and injects config per Part', async () => {
  const directRelease = deferred();
  const calls = [];
  const parts = [wavePartResult(1), wavePartResult(2)];
  const client = new AiClient(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/unit-tests/generate/stream')) {
      await directRelease.promise;
      return new Response([
        ': connected', '', 'event: direct_generation',
        `data: ${JSON.stringify({
          phase: 'completed',
          response: {
            result: 'package demo; class DataVOTmp1Test {}',
            provider: 'custom_openai',
            model: 'unit-test-model',
            generationMode: 'deterministic_prompt',
            usage: null
          }
        })}`,
        '', ''
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/api/unit-tests/method-generation-waves/start/stream')) {
      return waveSseResponse([
        waveEvent(1, 'wave_started'),
        wavePartSucceededEvent(2, 2),
        wavePartSucceededEvent(3, 1),
        waveCompletedEvent(4, parts)
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(1));

  const direct = client.generateUnitTestPrompt('generate data class', modelContext);
  await new Promise((resolve) => setImmediate(resolve));
  const handled = [];
  const wave = client.streamMethodGenerationWave(
    startWaveRequest(),
    modelContext,
    (event) => handled.push(event)
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /method-generation-waves\/start\/stream$/);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.parts.length, 2);
  assert.ok(body.parts.every((part) => (
    JSON.stringify(part.request.llmConfig) === JSON.stringify(modelContext.llmConfig)
  )));
  assert.ok(body.parts.every((part) => !('ragContext' in part.request)));
  const result = await wave;
  assert.equal(result.completion.succeededPartCount, 2);
  assert.deepEqual(result.completion.aggregateUsage, {
    inputTokens: 3,
    outputTokens: 6,
    totalTokens: 9
  });
  assert.equal(result.completion.modelCallCount, 2);
  assert.equal(result.completion.usageReportedCallCount, 2);
  assert.deepEqual(
    result.completion.parts.map((part) => part.partIndex),
    [1, 2]
  );
  assert.deepEqual(handled.map((event) => event.eventSequence), [1, 2, 3, 4]);
  directRelease.resolve();
  await direct;
});

test('Wave event decoder rejects duplicate sequences and mismatched Part identity', () => {
  assert.throws(() => decodeMethodGenerationWaveEvent(
    waveEvent(2, 'wave_started'),
    { previousEventSequence: 2 }
  ), /单方法生成响应无效/);
  const mismatched = wavePartSucceededEvent(3, 1);
  mismatched.partResult.scenarioIds = ['different-scenario'];
  assert.throws(() => decodeMethodGenerationWaveEvent(
    mismatched,
    { previousEventSequence: 2 }
  ), /单方法生成响应无效/);
});

test('Wave event decoder accepts cached input token usage from agent service', () => {
  const succeeded = wavePartResult(1);
  succeeded.aggregateUsage = {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 3,
    totalTokens: 13
  };
  const event = waveEvent(2, 'part_succeeded', {
    partIndex: succeeded.partIndex,
    partBatchId: succeeded.partBatchId,
    scenarioIds: succeeded.scenarioIds,
    childSessionId: succeeded.childSessionId,
    candidateId: succeeded.candidate.candidateId,
    partResult: succeeded
  });

  const decoded = decodeMethodGenerationWaveEvent(event, {
    previousEventSequence: 1,
    identity: validateStartMethodGenerationWaveRequest(startWaveRequest(1))
  });

  assert.deepEqual(decoded.partResult.aggregateUsage, succeeded.aggregateUsage);
});
test('Wave event decoder accepts a failed Part with null candidate identity', () => {
  const failed = wavePartResult(1, 'failed');
  const event = waveEvent(2, 'part_failed', {
    partIndex: failed.partIndex,
    partBatchId: failed.partBatchId,
    scenarioIds: failed.scenarioIds,
    childSessionId: failed.childSessionId,
    candidateId: null,
    partResult: failed
  });

  assert.deepEqual(
    decodeMethodGenerationWaveEvent(event, {
      previousEventSequence: 1,
      identity: validateStartMethodGenerationWaveRequest(startWaveRequest(1))
    }).partResult,
    failed
  );
});

test('Wave event decoder accepts a cancelled Part terminal event', () => {
  const cancelled = wavePartResult(1, 'cancelled');
  const event = waveEvent(2, 'part_cancelled', {
    partIndex: cancelled.partIndex,
    partBatchId: cancelled.partBatchId,
    scenarioIds: cancelled.scenarioIds,
    childSessionId: null,
    candidateId: null,
    partResult: cancelled
  });

  assert.deepEqual(
    decodeMethodGenerationWaveEvent(event, {
      previousEventSequence: 1,
      identity: validateStartMethodGenerationWaveRequest(startWaveRequest(1))
    }).partResult,
    cancelled
  );
});
test('Wave stream resumes status polling from the last handled event sequence', async () => {
  const calls = [];
  const parts = [wavePartResult(1)];
  const client = new AiClient(async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.pathname.endsWith('/start/stream')) {
      return waveSseResponse([waveEvent(1, 'wave_started')]);
    }
    if (url.pathname.endsWith(`/${WAVE_SESSION_ID}`)) {
      return jsonResponse(200, {
        waveSessionId: WAVE_SESSION_ID,
        waveId: WAVE_ID,
        methodId: METHOD_ID,
        waveIndex: 1,
        phase: 'completed',
        lastEventSequence: 3,
        terminalParts: parts,
        completion: waveCompletion(parts),
        terminalError: null,
        events: [
          wavePartSucceededEvent(2, 1),
          waveCompletedEvent(3, parts)
        ]
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(2));

  const result = await client.streamMethodGenerationWave(
    startWaveRequest(1),
    modelContext,
    () => {}
  );

  assert.equal(result.eventSequence, 3);
  assert.equal(result.completion.succeededPartCount, 1);
  assert.match(calls[1], new RegExp(`${WAVE_SESSION_ID}\\?afterEventSequence=1$`));
});

test('Wave stream abandons a heartbeat-only connection and recovers from status', async () => {
  const calls = [];
  const parts = [wavePartResult(1)];
  let streamCancelled = false;
  const client = new AiClient(async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.pathname.endsWith('/start/stream')) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `id: 1\nevent: method_generation_wave\n`
              + `data: ${JSON.stringify(waveEvent(1, 'wave_started'))}\n\n`
              + ': heartbeat\n\n'.repeat(3)
          ));
        },
        cancel() {
          streamCancelled = true;
        }
      });
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    if (url.pathname.endsWith(`/${WAVE_SESSION_ID}`)) {
      return jsonResponse(200, {
        waveSessionId: WAVE_SESSION_ID,
        waveId: WAVE_ID,
        methodId: METHOD_ID,
        waveIndex: 1,
        phase: 'completed',
        lastEventSequence: 3,
        terminalParts: parts,
        completion: waveCompletion(parts),
        terminalError: null,
        events: [
          wavePartSucceededEvent(2, 1),
          waveCompletedEvent(3, parts)
        ]
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(22));
  const abortController = new AbortController();
  const guard = setTimeout(() => {
    abortController.abort(new Error('Wave SSE remained blocked on heartbeats.'));
  }, 2_000);

  let result;
  try {
    result = await client.streamMethodGenerationWave(
      startWaveRequest(1),
      modelContext,
      () => {},
      abortController.signal
    );
  } finally {
    clearTimeout(guard);
  }

  assert.equal(result.eventSequence, 3);
  assert.equal(result.completion.succeededPartCount, 1);
  assert.equal(streamCancelled, true);
  assert.match(calls[1], new RegExp(`${WAVE_SESSION_ID}\\?afterEventSequence=1$`));
});

test('resumes a persisted Wave session from its saved event sequence without a new start request', async () => {
  const calls = [];
  const handled = [];
  const parts = [wavePartResult(1)];
  const client = new AiClient(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(init.method, 'GET');
    return jsonResponse(200, {
      waveSessionId: WAVE_SESSION_ID,
      waveId: WAVE_ID,
      methodId: METHOD_ID,
      waveIndex: 1,
      phase: 'completed',
      lastEventSequence: 3,
      terminalParts: parts,
      completion: waveCompletion(parts),
      terminalError: null,
      events: [
        wavePartSucceededEvent(2, 1),
        waveCompletedEvent(3, parts)
      ]
    });
  });
  client.setManagedBackendAccessProvider(() => managedAccess(21));

  const result = await client.resumeMethodGenerationWaveStream(
    WAVE_SESSION_ID,
    startWaveRequest(1),
    1,
    (event) => handled.push(event.eventSequence)
  );

  assert.equal(result.eventSequence, 3);
  assert.deepEqual(handled, [2, 3]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('afterEventSequence'), '1');
  assert.match(calls[0].url.pathname, /method-generation-waves\/.+$/);
});

test('Wave initial generation rejects RAG context before transport', async () => {
  let calls = 0;
  const client = new AiClient(async () => {
    calls += 1;
    throw new Error('must not call transport');
  });
  const request = startWaveRequest(1);
  request.parts[0].request.ragContext = enabledRagContext();

  await assert.rejects(
    client.streamMethodGenerationWave(request, modelContext, () => {}),
    /单方法生成响应无效/
  );
  assert.equal(calls, 0);
});

test('Wave recovery rejects events already covered by its acknowledged cursor', async () => {
  let calls = 0;
  const parts = [wavePartResult(1)];
  const client = new AiClient(async (input) => {
    calls += 1;
    assert.match(String(input), /method-generation-waves\/recover\/stream$/);
    return waveSseResponse([waveCompletedEvent(2, parts)]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(3));

  await assert.rejects(
    client.recoverMethodGenerationWaveStream({
      recoveryRequestId: '823e4567-e89b-42d3-a456-426614174000',
      startRequest: startWaveRequest(1),
      terminalParts: [],
      lastAcknowledgedEventSequence: 2
    }, modelContext, () => {}),
    /单方法生成响应无效/
  );
  assert.equal(calls, 1);
});

test('recovers unfinished Wave Parts through the strict stream route', async () => {
  const calls = [];
  const parts = [wavePartResult(1)];
  const client = new AiClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return waveSseResponse([waveCompletedEvent(3, parts)]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(4));

  const result = await client.recoverMethodGenerationWaveStream({
    recoveryRequestId: '923e4567-e89b-42d3-a456-426614174000',
    startRequest: startWaveRequest(1),
    terminalParts: [],
    lastAcknowledgedEventSequence: 2
  }, modelContext, () => {});

  assert.equal(result.eventSequence, 3);
  assert.equal(result.completion.succeededPartCount, 1);
  assert.match(calls[0].url, /method-generation-waves\/recover\/stream$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer managed-secret-4');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.lastAcknowledgedEventSequence, 2);
  assert.deepEqual(body.startRequest.parts[0].request.llmConfig, modelContext.llmConfig);
});

test('Wave status, acknowledgement, and cancellation use canonical routes', async () => {
  const calls = [];
  const succeeded = wavePartResult(1);
  const cancelled = wavePartResult(1, 'cancelled');
  const client = new AiClient(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (init.method === 'GET') {
      return jsonResponse(200, {
        waveSessionId: WAVE_SESSION_ID,
        waveId: WAVE_ID,
        methodId: METHOD_ID,
        waveIndex: 1,
        phase: 'running',
        lastEventSequence: 2,
        terminalParts: [succeeded],
        completion: null,
        terminalError: null,
        events: [wavePartSucceededEvent(2, 1)]
      });
    }
    if (url.pathname.endsWith('/ack')) {
      return jsonResponse(200, {
        waveSessionId: WAVE_SESSION_ID,
        acknowledgedThroughEventSequence: 2,
        lastEventSequence: 2
      });
    }
    return jsonResponse(200, {
      waveSessionId: WAVE_SESSION_ID,
      waveId: WAVE_ID,
      methodId: METHOD_ID,
      waveIndex: 1,
      phase: 'cancelled',
      lastEventSequence: 3,
      terminalParts: [cancelled],
      completion: waveCompletion([cancelled]),
      terminalError: null,
      events: []
    });
  });
  client.setManagedBackendAccessProvider(() => managedAccess(5));

  const status = await client.getMethodGenerationWaveStatus(WAVE_SESSION_ID, 1);
  const acknowledgement = await client.acknowledgeMethodGenerationWaveEvents(
    WAVE_SESSION_ID,
    2
  );
  const cancellation = await client.cancelMethodGenerationWave(WAVE_SESSION_ID);

  assert.equal(status.events[0].eventSequence, 2);
  assert.equal(acknowledgement.acknowledgedThroughEventSequence, 2);
  assert.equal(cancellation.phase, 'cancelled');
  assert.equal(calls[0].url.searchParams.get('afterEventSequence'), '1');
  assert.match(calls[1].url.pathname, /method-generation-waves\/.+\/ack$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { throughEventSequence: 2 });
  assert.equal(calls[2].init.method, 'DELETE');
  assert.ok(calls.every(({ init }) => (
    init.headers.Authorization === 'Bearer managed-secret-5'
  )));
});

test('Wave stream rejects a non-Wave SSE event without recovery polling', async () => {
  let calls = 0;
  const client = new AiClient(async () => {
    calls += 1;
    return new Response(
      `event: method_generation_session\ndata: ${JSON.stringify(waveEvent(1, 'wave_started'))}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  client.setManagedBackendAccessProvider(() => managedAccess(6));

  await assert.rejects(
    client.streamMethodGenerationWave(startWaveRequest(1), modelContext, () => {}),
    /单方法生成响应无效/
  );
  assert.equal(calls, 1);
});

function toolCallingProbeTrace() {
  return {
    request: {
      systemPrompt: 'Call rag_tool_probe exactly once.',
      userPrompt: 'probe-nonce',
      toolName: 'rag_tool_probe',
      toolChoice: 'auto'
    },
    toolExchange: {
      toolCallId: 'tool-call-1',
      toolName: 'rag_tool_probe',
      arguments: { token: 'probe-nonce' },
      toolMessage: {
        toolCallId: 'tool-call-1',
        content: 'probe-nonce'
      }
    },
    finalConfirmation: {
      content: 'probe-nonce',
      matchesNonce: true
    },
    outcome: 'supported'
  };
}

test('a same-model direct batch call does not block another class method stream', async () => {
  const directRelease = deferred();
  const calls = [];
  const client = new AiClient(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/unit-tests/generate/stream')) {
      await directRelease.promise;
      return new Response([
        ': connected',
        '',
        'event: direct_generation',
        `data: ${JSON.stringify({
          phase: 'completed',
          response: {
            result: 'package demo; class DataVOTmp1Test {}',
            provider: 'custom_openai',
            model: 'unit-test-model',
            generationMode: 'deterministic_prompt',
            usage: null
          }
        })}`,
        '',
        ''
      ].join('\n'), {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    if (url.endsWith('/api/unit-tests/method-generation-sessions/start/stream')) {
      return sseResponse([candidateEvent()]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const direct = client.generateUnitTestPrompt('generate data class', modelContext);
  await new Promise((resolve) => setImmediate(resolve));
  const streamed = client.startMethodGenerationStream(
    startRequest(),
    modelContext,
    () => {}
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/api\/unit-tests\/generate\/stream$/);
  assert.match(calls[1], /\/start\/stream$/);
  directRelease.resolve();
  const [, result] = await Promise.all([direct, streamed]);
  assert.equal(result.kind, 'candidate_ready');
});

test('same-model method streams for different classes start concurrently', async () => {
  const release = deferred();
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const client = new AiClient(async () => {
    activeCalls += 1;
    maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
    await release.promise;
    activeCalls -= 1;
    return sseResponse([candidateEvent()]);
  });

  const first = client.startMethodGenerationStream(
    startRequest(),
    modelContext,
    () => {}
  );
  const second = client.startMethodGenerationStream(
    startRequest({
      clientRequestId: 'a23e4567-e89b-42d3-a456-426614174000',
      classTaskId: 'b23e4567-e89b-42d3-a456-426614174000'
    }),
    modelContext,
    () => {}
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(maximumActiveCalls, 2);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.kind), [
    'candidate_ready',
    'candidate_ready'
  ]);
});

test('probes the complete tool loop through the fixed authenticated Agent endpoint', async () => {
  const calls = [];
  const controller = new AbortController();
  const responseBody = {
    supported: true,
    cacheHit: false,
    cacheKeyDigest: 'd'.repeat(64),
    trace: toolCallingProbeTrace()
  };
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return jsonResponse(200, responseBody);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(1));

  const result = await client.probeModelToolCalling(
    modelContext,
    true,
    controller.signal
  );

  assert.equal(
    calls[0].url.href,
    'http://127.0.0.1:30101/api/model-capabilities/tool-calling/probe'
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer managed-secret-1');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    llmConfig: modelContext.llmConfig,
    captureModelCalls: true
  });
  assert.deepEqual(result, responseBody);
});

test('tool-loop probe preserves transient provider errors and rejects invalid success bodies', async () => {
  const responses = [
    jsonResponse(504, {
      code: 'MODEL_TIMEOUT',
      message: '模型服务请求超时，请稍后重试。',
      details: {}
    }),
    jsonResponse(200, {
      supported: true,
      cacheHit: false,
      cacheKeyDigest: 'not-a-digest',
      trace: null
    })
  ];
  const client = new AiClient(async () => responses.shift());
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.probeModelToolCalling(modelContext, false),
    (error) => {
      assert.equal(error.code, 'MODEL_TIMEOUT');
      assert.equal(error.message, '模型服务请求超时，请稍后重试。');
      return true;
    }
  );
  await assert.rejects(
    client.probeModelToolCalling(modelContext, false),
    /RAG|工具|响应|无效/i
  );
});

test('starts one-method SSE with unversioned path, current managed token, model config, and signal', async () => {
  const calls = [];
  const progress = [];
  const controller = new AbortController();
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return sseResponse([progressEvent(), candidateEvent(2)]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(1));

  const result = await client.startMethodGenerationStream(
    startRequest(),
    modelContext,
    (value) => progress.push(value),
    controller.signal
  );

  assert.equal(
    calls[0].url.href,
    'http://127.0.0.1:30101/api/unit-tests/method-generation-sessions/start/stream'
  );
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer managed-secret-1');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.signal, controller.signal);
  const startBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(startBody.llmConfig, modelContext.llmConfig);
  assert.equal('assertionPolicy' in startBody, false);
  assert.equal('ragEmbeddingConfig' in startBody, false);
  assert.equal(result.kind, 'candidate_ready');
  assert.equal(result.candidate.candidateVersion, 1);
  assert.equal(result.candidate.repairAttempt, 0);
  assert.deepEqual(progress.map((value) => value.eventSequence), [1, 2]);
});

test('recover HTTP validation failure keeps a safe resumable protocol error', async () => {
  const client = new AiClient(async () => jsonResponse(422, {
    detail: [{ msg: 'validation failed', input: { apiKey: 'secret-token', source: 'PRIVATE-SOURCE' } }]
  }));
  client.setManagedBackendAccessProvider(() => managedAccess(2));
  await assert.rejects(client.recoverMethodGenerationStream({
    startRequest: startRequest(), candidate: candidateEvent(1).candidate
  }, modelContext, () => {}), error => {
    assert.equal(error.code, 'METHOD_GENERATION_REQUEST_FAILED');
    assert.match(error.message, /422/);
    assert.doesNotMatch(error.message, /secret-token|PRIVATE-SOURCE/);
    return true;
  });
});

test('recovers an existing candidate through the dedicated no-generation session endpoint', async () => {
  const calls = [];
  const recoveredEvent = candidateEvent(1, {
    candidateVersion: 2,
    repairAttempt: 1
  });
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return sseResponse([recoveredEvent]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(2));

  const result = await client.recoverMethodGenerationStream(
    {
      startRequest: startRequest(),
      candidate: recoveredEvent.candidate
    },
    modelContext,
    () => {}
  );

  assert.equal(
    calls[0].url.href,
    'http://127.0.0.1:30102/api/unit-tests/method-generation-sessions/recover/stream'
  );
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.recoveryRequestId, CLIENT_REQUEST_ID);
  assert.deepEqual(body.startRequest.llmConfig, modelContext.llmConfig);
  assert.equal('llmConfig' in body, false);
  assert.equal(result.kind, 'candidate_ready');
  assert.equal(result.candidate.candidateVersion, 2);
  assert.equal(result.candidate.repairAttempt, 1);
  const nextStart = { ...startRequest(), clientRequestId: '923e4567-e89b-42d3-a456-426614174000' };
  await client.recoverMethodGenerationStream({ startRequest: nextStart, candidate: recoveredEvent.candidate }, modelContext, () => {});
  const nextBody = JSON.parse(calls[1].init.body);
  assert.equal(nextBody.candidate.candidateId, body.candidate.candidateId);
  assert.notEqual(nextBody.recoveryRequestId, body.recoveryRequestId);
  assert.equal(nextBody.recoveryRequestId, nextStart.clientRequestId);
});

test('accepts provider total tokens that include usage outside input and output tokens', async () => {
  const handled = [];
  const client = new AiClient(async () => sseResponse([
    completedModelCallEvent(1, {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 125
    }),
    candidateEvent(2, {
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 125
      }
    })
  ]));
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.startMethodGenerationStream(
    startRequest({ captureModelCalls: true }),
    modelContext,
    (value) => handled.push(value)
  );

  assert.equal(result.kind, 'candidate_ready');
  assert.deepEqual(result.candidate.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 125
  });
  assert.deepEqual(handled[0].modelCall.usage, result.candidate.usage);
});

test('preserves a safe structured model error from the SSE stream', async () => {
  const client = new AiClient(async () => sseResponse([
    errorEvent(1, 'MODEL_NOT_FOUND', '未找到所选模型。')
  ]));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.startMethodGenerationStream(startRequest(), modelContext, () => {}),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_FOUND');
      assert.match(error.message, /未找到所选模型/);
      return true;
    }
  );
});

test('preserves a safe structured model error returned before SSE starts', async () => {
  const client = new AiClient(async () => jsonResponse(404, {
    code: 'MODEL_NOT_FOUND',
    message: '未找到所选模型。',
    details: {
      provider: 'custom_openai',
      credential: 'secret-token'
    }
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.startMethodGenerationStream(startRequest(), modelContext, () => {}),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_FOUND');
      assert.match(error.message, /未找到所选模型/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    }
  );
});

test('resume distinguishes a missing model from a missing generation session', async () => {
  const responses = [
    sseResponse([candidateEvent()]),
    jsonResponse(404, {
      code: 'MODEL_NOT_FOUND',
      message: '未找到所选模型。',
      details: {}
    })
  ];
  const client = new AiClient(async () => responses.shift());
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(startRequest(), modelContext, () => {});

  await assert.rejects(
    client.resumeMethodGenerationStream(SESSION_ID, {
      feedbackId: FEEDBACK_ID,
      expectedEventSequence: 1,
      candidateId: CANDIDATE_ID,
      candidateVersion: 1,
      repairAttempt: 0,
      effectiveTestCode: TEST_CODE,
      effectiveFileSha256: TEST_CODE_SHA,
      feedbackKind: 'execution',
      execution: passedFeedbackExecution()
    }, modelContext, () => {}),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_FOUND');
      assert.match(error.message, /未找到所选模型/);
      return true;
    }
  );
});

test('interrupted stream recovery preserves a structured terminal model error', async () => {
  let callCount = 0;
  const client = new AiClient(async () => {
    callCount += 1;
    if (callCount === 1) {
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify(progressEvent(1))}\n\n`
            ));
            return;
          }
          controller.error(new Error('socket interrupted'));
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    const terminalError = {
      code: 'MODEL_UNAVAILABLE',
      message: '大模型平台当前不可用。',
      stage: 'generation'
    };
    return jsonResponse(200, status({
      phase: 'failed',
      lastEventSequence: 2,
      terminalError,
      events: [errorEvent(2, terminalError.code, terminalError.message)]
    }));
  });
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.startMethodGenerationStream(startRequest(), modelContext, () => {}),
    (error) => {
      assert.equal(error.code, 'MODEL_UNAVAILABLE');
      assert.match(error.message, /大模型平台当前不可用/);
      return true;
    }
  );
  assert.equal(callCount, 2);
});

test('resume switches from heartbeat-only SSE to pending-candidate status recovery', async () => {
  const calls = [];
  const handled = [];
  const recoveredCandidate = candidate({
    candidateId: 'a23e4567-e89b-42d3-a456-426614174000',
    candidateVersion: 2,
    repairAttempt: 1
  });
  let streamCancelled = false;
  const client = new AiClient(async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.pathname.endsWith('/start/stream')) {
      return sseResponse([candidateEvent()]);
    }
    if (url.pathname.endsWith('/resume/stream')) {
      const modelCall = completedModelCallEvent(2, null, {
        callKind: 'repair',
        repairAttempt: 1,
        candidateVersion: 2
      });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `id: 2\nevent: method_generation_session\n`
              + `data: ${JSON.stringify(modelCall)}\n\n`
              + ': heartbeat\n\n'.repeat(3)
          ));
        },
        cancel() {
          streamCancelled = true;
        }
      });
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    if (url.pathname.endsWith(`/${SESSION_ID}`)) {
      return jsonResponse(200, status({
        phase: 'running',
        lastEventSequence: 3,
        pendingCandidate: recoveredCandidate,
        events: []
      }));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  client.setManagedBackendAccessProvider(() => managedAccess(23));
  await client.startMethodGenerationStream(
    startRequest(),
    modelContext,
    () => {}
  );
  const abortController = new AbortController();
  const guard = setTimeout(() => {
    abortController.abort(new Error('Method SSE remained blocked on heartbeats.'));
  }, 2_000);

  let result;
  try {
    result = await client.resumeMethodGenerationStream(SESSION_ID, {
      feedbackId: FEEDBACK_ID,
      expectedEventSequence: 1,
      candidateId: CANDIDATE_ID,
      candidateVersion: 1,
      repairAttempt: 0,
      effectiveTestCode: TEST_CODE,
      effectiveFileSha256: TEST_CODE_SHA,
      feedbackKind: 'execution',
      execution: compileFailureExecution()
    }, modelContext, (value) => handled.push(value), abortController.signal);
  } finally {
    clearTimeout(guard);
  }

  assert.equal(result.kind, 'candidate_ready');
  assert.equal(result.eventSequence, 3);
  assert.equal(result.candidate.candidateId, recoveredCandidate.candidateId);
  assert.deepEqual(handled.map((value) => value.eventSequence), [2]);
  assert.equal(streamCancelled, true);
  assert.match(calls[2], new RegExp(`${SESSION_ID}\\?afterEventSequence=2$`));
});

test('rejects an invalid nested ragContext before opening an Agent stream', async () => {
  let fetchCalls = 0;
  const client = new AiClient(async () => {
    fetchCalls += 1;
    return sseResponse([candidateEvent()]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  const ragContext = {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: ['D:\\work\\module\\target\\classes'],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: 'f'.repeat(64),
      unexpected: 'must be rejected'
    },
    activeIndex: {
      workspaceId: 'a'.repeat(64),
      scopeId: 'b'.repeat(64),
      indexVersion: 1,
      sourceSetId: 'c'.repeat(64),
      requestedSourceSetFingerprint: '84ca98d235db68f4737289d37526f870dfc4bce041f0ed0cfaec751d66a6e344',
      allowedFqns: ['com.example.Order']
    }
  };

  await assert.rejects(
    client.startMethodGenerationStream(
      startRequest({ ragContext }),
      modelContext,
      () => {}
    ),
    /单方法生成响应无效|鍗曟柟娉曠敓鎴愬搷搴旀棤鏁/
  );
  assert.equal(fetchCalls, 0);
});

test('prepares the latest RAG repair diagnostic through the fixed session endpoint', async () => {
  const calls = [];
  const prepared = {
    status: 'attributable',
    diagnosticFingerprint: '8'.repeat(64),
    requestedFqns: ['com.example.Order'],
    originalDiagnosticText: '[ERROR] cannot find symbol',
    targetMethodKey: 'com.example.Order#run()V',
    degradationCode: null
  };
  const client = new AiClient(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(init.body) });
    return calls.length === 1
      ? sseResponse([candidateEvent()])
      : jsonResponse(200, prepared);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(
    startRequest({ ragContext: enabledRagContext() }),
    modelContext,
    () => {}
  );

  const request = prepareRagRepairRequest();
  const result = await client.prepareRagRepair(SESSION_ID, request);

  assert.deepEqual(result, prepared);
  assert.equal(
    new URL(calls[1].url).pathname,
    `/api/unit-tests/method-generation-sessions/${SESSION_ID}/rag-repair/prepare`
  );
  assert.deepEqual(calls[1].body, request);
  assert.equal(JSON.stringify(calls[1].body).includes('secret-token'), false);
});

test('keeps pending session identity but releases it after completion', async () => {
  const responses = [
    sseResponse([candidateEvent()]),
    sseResponse([completionEvent(2)])
  ];
  const client = new AiClient(async () => responses.shift());
  client.setManagedBackendAccessProvider(() => managedAccess());

  await client.startMethodGenerationStream(
    startRequest(),
    modelContext,
    () => {}
  );
  assert.equal(client.methodGenerationIdentities.size, 1);

  const result = await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: passedFeedbackExecution()
  }, modelContext, () => {});

  assert.equal(result.kind, 'completed');
  assert.equal(client.methodGenerationIdentities.size, 0);
});

test('verified RAG resume sends matching attempt identity and independent Embedding config', async () => {
  const calls = [];
  const responses = [
    sseResponse([candidateEvent()]),
    sseResponse([completionEvent(2)])
  ];
  const client = new AiClient(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return responses.shift();
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(
    startRequest({ ragContext: enabledRagContext() }),
    modelContext,
    () => {}
  );

  const ragEmbeddingConfig = {
    provider: 'custom_openai',
    model: 'embedding-model',
    baseUrl: 'https://embeddings.example/v1',
    credentials: { apiKey: 'embedding-secret' }
  };
  await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    ragRepairAttempt: ragRepairAttempt(),
    ragEmbeddingConfig
  }, modelContext, () => {});

  assert.equal('ragEmbeddingConfig' in calls[0], false);
  assert.deepEqual(calls[1].llmConfig, modelContext.llmConfig);
  assert.deepEqual(calls[1].ragRepairAttempt, ragRepairAttempt());
  assert.deepEqual(calls[1].ragEmbeddingConfig, ragEmbeddingConfig);
});

test('RAG attempt is rejected before transport when the session did not enable RAG', async () => {
  let fetchCalls = 0;
  const client = new AiClient(async () => {
    fetchCalls += 1;
    return sseResponse([candidateEvent()]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(startRequest(), modelContext, () => {});

  await assert.rejects(client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    ragRepairAttempt: ragRepairAttempt(),
    ragEmbeddingConfig: {
      provider: 'custom_openai',
      model: 'embedding-model',
      baseUrl: 'https://embeddings.example/v1',
      credentials: { apiKey: 'embedding-secret' }
    }
  }, modelContext, () => {}), /无效|RAG|invalid/i);
  assert.equal(fetchCalls, 1);
});

test('resume sends a strict structured no-RAG execution repair context', async () => {
  const calls = [];
  const requestHeaders = [];
  const responses = [sseResponse([candidateEvent()]), sseResponse([candidateEvent(2, {
    candidateId: '723e4567-e89b-42d3-a456-426614174000',
    candidateVersion: 2,
    repairAttempt: 1
  })])];
  const client = new AiClient(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    requestHeaders.push(init.headers);
    return responses.shift();
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(startRequest(), modelContext, () => {});

  const execution = compileFailureExecution();
  const repairContext = structuredRepairContext();
  await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution,
    repairContext
  }, modelContext, () => {});

  assert.equal(calls[1].feedbackKind, 'execution');
  assert.deepEqual(calls[1].execution, execution);
  assert.deepEqual(calls[1].repairContext, repairContext);
  assert.equal('candidateRejection' in calls[1], false);
  assert.equal(requestHeaders[1]['Content-Type'], 'application/json');
});

test('structured repair context accepts all twenty-five Part source methods', async () => {
  const calls = [];
  const responses = [sseResponse([candidateEvent()]), sseResponse([candidateEvent(2, {
    candidateId: '733e4567-e89b-42d3-a456-426614174000',
    candidateVersion: 2,
    repairAttempt: 1
  })])];
  const client = new AiClient(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return responses.shift();
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(startRequest(), modelContext, () => {});

  const targetMethod = structuredRepairContext().targetMethod;
  const stackMethods = Array.from({ length: 24 }, (_, index) => ({
    ...targetMethod,
    methodId: createHash('sha256').update(`repair-method-${index + 2}`).digest('hex'),
    methodName: `method${index + 2}`,
    sourceText: `public void method${index + 2}() {}`
  }));
  await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    repairContext: structuredRepairContext({ stackMethods })
  }, modelContext, () => {});

  assert.equal(calls[1].repairContext.stackMethods.length, 24);
});

test('structured repair context accepts repeated parameter types in an exact method signature', async () => {
  const calls = [];
  const responses = [sseResponse([candidateEvent()]), sseResponse([candidateEvent(2, {
    candidateId: '823e4567-e89b-42d3-a456-426614174000',
    candidateVersion: 2,
    repairAttempt: 1
  })])];
  const client = new AiClient(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return responses.shift();
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(startRequest(), modelContext, () => {});
  const repairContext = structuredRepairContext({
    targetMethod: {
      ...structuredRepairContext().targetMethod,
      descriptor: '(Ljava/lang/String;Ljava/lang/String;)V',
      parameterTypes: ['java.lang.String', 'java.lang.String']
    }
  });

  await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    repairContext
  }, modelContext, () => {});

  assert.deepEqual(
    calls[1].repairContext.targetMethod.parameterTypes,
    ['java.lang.String', 'java.lang.String']
  );
});

test('structured repair context accepts up to sixty-four exact referenced types', async () => {
  const calls = [];
  const responses = [sseResponse([candidateEvent()]), sseResponse([candidateEvent(2, {
    candidateId: '923e4567-e89b-42d3-a456-426614174000',
    candidateVersion: 2,
    repairAttempt: 1
  })])];
  const client = new AiClient(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return responses.shift();
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  await client.startMethodGenerationStream(startRequest(), modelContext, () => {});
  const referencedTypes = Array.from({ length: 64 }, (_, index) => ({
    qualifiedName: `demo.RepairType${index}`,
    kind: 'CLASS',
    constructors: [],
    methods: [`public void repairMethod${index}()`],
    enumConstants: []
  }));

  await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 1,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: compileFailureExecution(),
    repairContext: structuredRepairContext({ referencedTypes })
  }, modelContext, () => {});

  assert.equal(calls[1].repairContext.referencedTypes.length, 64);
});

test('structured repair context rejects more than sixty-four referenced types', async () => {
  let fetchCalls = 0;
  const client = new AiClient(async () => {
    fetchCalls += 1;
    return sseResponse([candidateEvent()]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  const referencedTypes = Array.from({ length: 65 }, (_, index) => ({
    qualifiedName: `demo.RepairType${index}`,
    kind: 'CLASS',
    constructors: [],
    methods: [],
    enumConstants: []
  }));

  await assert.rejects(
    client.resumeMethodGenerationStream(SESSION_ID, {
      feedbackId: FEEDBACK_ID,
      expectedEventSequence: 1,
      candidateId: CANDIDATE_ID,
      candidateVersion: 1,
      repairAttempt: 0,
      effectiveTestCode: TEST_CODE,
      effectiveFileSha256: TEST_CODE_SHA,
      feedbackKind: 'execution',
      execution: compileFailureExecution(),
      repairContext: structuredRepairContext({ referencedTypes })
    }, modelContext, () => {})
  );
  assert.equal(fetchCalls, 0);
});

test('resume rejects inconsistent candidate-rejection hashes before HTTP submission', async () => {
  let fetchCalls = 0;
  const client = new AiClient(async () => {
    fetchCalls += 1;
    return sseResponse([candidateEvent()]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.resumeMethodGenerationStream(SESSION_ID, {
      feedbackId: FEEDBACK_ID,
      expectedEventSequence: 1,
      candidateId: CANDIDATE_ID,
      candidateVersion: 1,
      repairAttempt: 0,
      effectiveTestCode: TEST_CODE,
      effectiveFileSha256: TEST_CODE_SHA,
      feedbackKind: 'candidate_rejected',
      execution: compileFailureExecution(),
      repairContext: structuredRepairContext(),
      candidateRejection: {
        acceptedTestCode: TEST_CODE,
        acceptedFileSha256: 'f'.repeat(64),
        violationCodes: ['UNRELATED_TEST_CHANGED'],
        memberNames: ['otherTest'],
        message: 'Unrelated test changed.'
      }
    }, modelContext, () => {}),
    /无效|invalid/i
  );
  assert.equal(fetchCalls, 0);
});

test('passing feedback rejects repair-only context before HTTP submission', async () => {
  let fetchCalls = 0;
  const client = new AiClient(async () => {
    fetchCalls += 1;
    return sseResponse([candidateEvent()]);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.resumeMethodGenerationStream(SESSION_ID, {
      feedbackId: FEEDBACK_ID,
      expectedEventSequence: 1,
      candidateId: CANDIDATE_ID,
      candidateVersion: 1,
      repairAttempt: 0,
      effectiveTestCode: TEST_CODE,
      effectiveFileSha256: TEST_CODE_SHA,
      feedbackKind: 'execution',
      execution: {
        status: 'passed',
        mavenExecutions: [{
          scope: 'method_candidate',
          phase: 'test_compile',
          command: 'mvn test-compile',
          exitCode: 0,
          stdout: '',
          stderr: '',
          surefireReports: []
        }, {
          scope: 'method_candidate',
          phase: 'test',
          command: 'mvn surefire:test',
          exitCode: 0,
          stdout: '',
          stderr: '',
          surefireReports: [{ fileName: 'TEST-demo.xml', content: '<testsuite />' }]
        }],
        testReport: {
          reportCount: 1,
          tests: 1,
          failures: 0,
          errors: 0,
          skipped: 0,
          generatedTestClassName: 'demo.TaskServiceTmp1Test',
          generatedTests: 1,
          generatedSkipped: 0,
          failureDetails: []
        }
      },
      repairContext: structuredRepairContext()
    }, modelContext, () => {}),
    /无效|invalid/i
  );
  assert.equal(fetchCalls, 0);
});

test('agent stream rejects category fields and redacts managed tokens', async () => {
  const observedErrors = [];
  const invalid = candidateEvent(1, {
    accessCategory: 'PUBLIC',
    diagnostic: 'managed-secret-token'
  });
  const client = new AiClient(async () => sseResponse([invalid]));
  client.setManagedBackendAccessProvider(() => ({
    ...managedAccess(),
    agentServiceAuthorizationHeader: 'Bearer managed-secret-token'
  }));

  await assert.rejects(
    client.startMethodGenerationStream(startRequest(), modelContext, () => {}),
    (error) => {
      observedErrors.push(error.message);
      assert.match(error.message, /单方法生成响应无效/);
      return true;
    }
  );
  assert.doesNotMatch(JSON.stringify(observedErrors), /managed-secret-token|secret-token/);
});

test('rejects candidate version, repair attempt, code digest, class, package, and path inconsistencies', async () => {
  const invalidCandidates = [
    candidate({ candidateVersion: 2, repairAttempt: 0 }),
    candidate({ generatedCodeSha256: '0'.repeat(64) }),
    candidate({ outputTestClassName: 'WrongTest' }),
    candidate({ methodId: 'd'.repeat(64) }),
    candidate({ batchId: 'e'.repeat(64) }),
    candidate({ ordinaryTestMethodCount: 2 })
  ];
  for (const invalidCandidate of invalidCandidates) {
    const client = new AiClient(async () => sseResponse([
      event(1, 'candidate_ready', { name: 'candidate', value: invalidCandidate })
    ]));
    client.setManagedBackendAccessProvider(() => managedAccess());
    await assert.rejects(
      client.startMethodGenerationStream(startRequest(), modelContext, () => {}),
      /单方法生成响应无效/
    );
  }
});

test('resume interruptions poll session status from the last handled cursor without retrying feedback', async () => {
  const calls = [];
  const handled = [];
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (calls.length === 1) {
      let sent = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify(progressEvent(4))}\n\n`
            ));
            return;
          }
          controller.error(new Error('socket managed-secret-token'));
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    return jsonResponse(200, status({
      phase: 'completed',
      lastEventSequence: 5,
      completion: completionEvent(5).completion,
      events: [completionEvent(5)]
    }));
  });
  client.setManagedBackendAccessProvider(() => ({
    ...managedAccess(),
    agentServiceAuthorizationHeader: 'Bearer managed-secret-token'
  }));

  const result = await client.resumeMethodGenerationStream(SESSION_ID, {
      feedbackId: FEEDBACK_ID,
      expectedEventSequence: 3,
      candidateId: CANDIDATE_ID,
      candidateVersion: 1,
      repairAttempt: 0,
      effectiveTestCode: TEST_CODE,
      effectiveFileSha256: TEST_CODE_SHA,
      feedbackKind: 'execution',
      execution: {
        status: 'passed',
        mavenExecutions: [{
          scope: 'method_candidate',
          phase: 'test_compile',
          command: 'mvn test-compile',
          exitCode: 0,
          stdout: '',
          stderr: '',
          surefireReports: []
        }, {
          scope: 'method_candidate',
          phase: 'test',
          command: 'mvn surefire:test',
          exitCode: 0,
          stdout: '',
          stderr: '',
          surefireReports: [{ fileName: 'TEST-demo.xml', content: '<testsuite />' }]
        }],
        testReport: {
          reportCount: 1,
          tests: 1,
          failures: 0,
          errors: 0,
          skipped: 0,
          generatedTestClassName: 'TaskServiceTmp1Test',
          generatedTests: 1,
          generatedSkipped: 0,
          failureDetails: []
        }
      }
    }, modelContext, (value) => handled.push(value));

  assert.equal(result.kind, 'completed');
  assert.equal(result.eventSequence, 5);
  assert.deepEqual(handled.map((value) => value.eventSequence), [4, 5]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].url.searchParams.get('afterEventSequence'), '4');
  assert.equal(
    calls.filter(({ url }) => url.pathname.endsWith('/resume/stream')).length,
    1
  );
});

test('resume response-header interruptions recover from the submitted feedback cursor', async () => {
  const calls = [];
  const handled = [];
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (calls.length === 1) {
      throw new TypeError('socket managed-secret-token');
    }
    return jsonResponse(200, status({
      phase: 'completed',
      lastEventSequence: 4,
      completion: completionEvent(4).completion,
      events: [completionEvent(4)]
    }));
  });
  client.setManagedBackendAccessProvider(() => ({
    ...managedAccess(),
    agentServiceAuthorizationHeader: 'Bearer managed-secret-token'
  }));

  const result = await client.resumeMethodGenerationStream(SESSION_ID, {
    feedbackId: FEEDBACK_ID,
    expectedEventSequence: 3,
    candidateId: CANDIDATE_ID,
    candidateVersion: 1,
    repairAttempt: 0,
    effectiveTestCode: TEST_CODE,
    effectiveFileSha256: TEST_CODE_SHA,
    feedbackKind: 'execution',
    execution: passedFeedbackExecution()
  }, modelContext, (value) => handled.push(value));

  assert.equal(result.kind, 'completed');
  assert.equal(result.eventSequence, 4);
  assert.deepEqual(handled.map((value) => value.eventSequence), [4]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].url.searchParams.get('afterEventSequence'), '3');
});

test('status, acknowledgement, and cancellation use canonical routes and responses', async () => {
  const calls = [];
  const responses = [
    jsonResponse(200, status()),
    jsonResponse(200, {
      sessionId: SESSION_ID,
      acknowledgedThroughEventSequence: 1,
      lastEventSequence: 1
    }),
    jsonResponse(200, status({
      phase: 'cancelled',
      lastEventSequence: 2,
      completion: {
        methodId: METHOD_ID,
        batchId: BATCH_ID,
        stopReason: 'stopped',
        bestCandidateId: null,
        aggregateUsage: null,
        modelCallCount: 1,
        usageReportedCallCount: 0
      },
      events: [progressEvent(), completionEvent(2, 'stopped')]
    }))
  ];
  let accessOffset = 1;
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return responses.shift();
  });
  client.setManagedBackendAccessProvider(() => managedAccess(accessOffset++));

  const current = await client.getMethodGenerationStatus(SESSION_ID, 0);
  const acknowledgement = await client.acknowledgeMethodGenerationEvents(SESSION_ID, 1);
  const cancelled = await client.cancelMethodGeneration(SESSION_ID);

  assert.equal(current.phase, 'running');
  assert.equal(acknowledgement.acknowledgedThroughEventSequence, 1);
  assert.equal(cancelled.phase, 'cancelled');
  assert.deepEqual(calls.map(({ url }) => url.href), [
    `http://127.0.0.1:30101/api/unit-tests/method-generation-sessions/${SESSION_ID}?afterEventSequence=0`,
    `http://127.0.0.1:30102/api/unit-tests/method-generation-sessions/${SESSION_ID}/ack`,
    `http://127.0.0.1:30103/api/unit-tests/method-generation-sessions/${SESSION_ID}`
  ]);
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'POST', 'DELETE']);
});

test('status rejects unknown phases, non-monotonic events, and wrong completion identities', async () => {
  const invalidStatuses = [
    status({ phase: 'waiting_for_feedback' }),
    status({
      lastEventSequence: 2,
      events: [progressEvent(2), progressEvent(1)]
    }),
    status({
      phase: 'completed',
      lastEventSequence: 2,
      completion: {
        methodId: 'd'.repeat(64),
        batchId: BATCH_ID,
        stopReason: 'verified',
        bestCandidateId: CANDIDATE_ID,
        aggregateUsage: null,
        modelCallCount: 1,
        usageReportedCallCount: 0
      },
      events: [completionEvent(2)]
    })
  ];
  for (const invalidStatus of invalidStatuses) {
    const client = new AiClient(async () => jsonResponse(200, invalidStatus));
    client.setManagedBackendAccessProvider(() => managedAccess());
    await assert.rejects(
      client.getMethodGenerationStatus(SESSION_ID, 0),
      /单方法生成响应无效/
    );
  }
});
