import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiClient,
  isJavaAnalyzerResponseTimeoutError
} from '../src/main/services/ai-client.ts';
import {
  isMethodAnalysisResponseInvalidError,
  MethodAnalysisRequestError
} from '../src/main/services/method-analysis-contract.ts';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const METHOD_ID = 'b'.repeat(64);
const SECOND_METHOD_ID = 'e'.repeat(64);
const REPORT_PAIR_ID = 'a'.repeat(64);
const BATCH_ID = 'c'.repeat(64);

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function managedAccess() {
  return {
    agentServiceUrl: 'http://127.0.0.1:30100',
    javaAnalyzerUrl: 'http://127.0.0.1:30200',
    agentServiceAuthorizationHeader: 'Bearer agent-token',
    javaAnalyzerAuthorizationHeader: 'Bearer analyzer-token'
  };
}

function methodSummary(overrides = {}) {
  return {
    methodId: METHOD_ID,
    methodName: 'run',
    descriptor: '()V',
    displaySignature: 'run()',
    firstLine: 10,
    lastLine: 30,
    jacocoOrder: 0,
    lineCovered: 2,
    lineMissed: 5,
    branchCovered: 1,
    branchMissed: 3,
    instructionCovered: 40,
    instructionMissed: 60,
    complexityCovered: 18,
    complexityMissed: 77,
    coverageGap: true,
    generatable: true,
    unavailableReason: null,
    modifiers: ['public'],
    ...overrides
  };
}

function catalog(overrides = {}) {
  return {
    analysisSessionId: SESSION_ID,
    reportPairId: REPORT_PAIR_ID,
    reportCoverageTotals: {
      instructionCovered: 29,
      instructionMissed: 11,
      branchCovered: 7,
      branchMissed: 3,
      complexityCovered: 6,
      complexityMissed: 4,
      lineCovered: 5,
      lineMissed: 4
    },
    methods: [methodSummary()],
    warnings: [],
    ...overrides
  };
}

function scenario(index) {
  const ordinal = index + 1;
  return {
    scenarioId: `scenario-${ordinal}`,
    scenarioSignature: `run-path-${ordinal}`,
    methodId: METHOD_ID,
    targetLines: [10 + ordinal],
    targetBranches: [`branch-${ordinal}`],
    chineseDescription: `场景 ${ordinal}`,
    inputPreparation: [],
    requiredStubIds: [],
    expectedPath: [`path-${ordinal}`],
    loopExitCondition: '',
    loopCoveragePlan: null,
    conditionPathVariants: [{
      variantId: `variant-${ordinal}`,
      expectations: [{
        operandIndex: 0,
        expression: `flag${ordinal}`,
        expected: true
      }],
      coverageTargetIds: [`target-${ordinal}`]
    }],
    coverageTargetIds: [`target-${ordinal}`],
    pathConstraints: [],
    status: 'READY'
  };
}

function coverageTarget(index) {
  const ordinal = index + 1;
  return {
    targetId: `target-${ordinal}`,
    methodId: METHOD_ID,
    decisionId: `decision-${ordinal}`,
    instructionIndex: ordinal,
    sourceLine: 10 + ordinal,
    kind: 'BRANCH',
    direction: ordinal % 2 === 0 ? 'FALSE' : 'TRUE',
    covered: false,
    mappingStatus: 'EXACT',
    requiredEdgeIds: [`edge-${ordinal}`]
  };
}

function pathGroup(index) {
  const ordinal = index + 1;
  return {
    groupId: `group-${ordinal}`,
    methodId: METHOD_ID,
    ordinal,
    scenarioIds: [`scenario-${ordinal}`],
    targetIds: [`target-${ordinal}`],
    constraints: [],
    inputRequirements: [],
    mockRequirements: [],
    expectedExit: 'RETURNS',
    singleTargetInvocation: true,
    status: 'READY'
  };
}

function testMethodPlan(index) {
  const ordinal = index + 1;
  return {
    testMethodPlanId: `test-plan-${ordinal}`,
    methodId: METHOD_ID,
    ordinal,
    pathGroupIds: [`group-${ordinal}`],
    status: 'READY'
  };
}

function workBatch(overrides = {}, methodCount = 12) {
  const indexes = Array.from({ length: methodCount }, (_, index) => index);
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
      lastLine: 30,
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
      activeScenarioIds: indexes.map((index) => `scenario-${index + 1}`)
    },
    scenarios: indexes.map(scenario),
    methodTestPlan: {
      methodId: METHOD_ID,
      analysisStatus: 'READY',
      minimumTestCount: methodCount,
      remainingTargets: indexes.map(coverageTarget),
      testPathGroups: indexes.map(pathGroup),
      testMethodPlans: indexes.map(testMethodPlan),
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
    plannedTestMethods: methodCount,
    remainingTestMethods: 5,
    warnings: [],
    ...overrides
  };
}

function wavePart(partIndex, startScenarioIndex = (partIndex - 1) * 5) {
  const indexes = Array.from({ length: 5 }, (_, index) => startScenarioIndex + index);
  const base = workBatch();
  const scenarios = indexes.map(scenario);
  const scenarioIds = scenarios.map((item) => item.scenarioId);
  return {
    partIndex,
    partBatchId: String(partIndex).repeat(64),
    scenarioIds,
    method: {
      ...base.method,
      activeScenarioIds: scenarioIds
    },
    scenarios,
    methodTestPlan: {
      methodId: METHOD_ID,
      analysisStatus: 'READY',
      minimumTestCount: 5,
      remainingTargets: indexes.map(coverageTarget),
      testPathGroups: indexes.map((globalIndex, localIndex) => ({
        ...pathGroup(globalIndex),
        ordinal: localIndex + 1
      })),
      testMethodPlans: indexes.map((globalIndex, localIndex) => ({
        ...testMethodPlan(globalIndex),
        ordinal: localIndex + 1
      })),
      fallbackReason: ''
    },
    methodStubInventory: base.methodStubInventory,
    activeStubPlans: [],
    targetFixturePlan: base.targetFixturePlan,
    referencedTypes: [],
    necessaryImports: ['org.junit.jupiter.api.Test']
  };
}

function workWave(overrides = {}) {
  const parts = [wavePart(1), wavePart(2), wavePart(3), wavePart(4), wavePart(5)];
  return {
    waveBatchId: 'd'.repeat(64),
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    hasWork: true,
    selectedScenarioIds: parts.flatMap((part) => part.scenarioIds),
    remainingScenarioCount: 30,
    parts,
    warnings: [],
    ...overrides
  };
}

function classWaveSlice(methodId, prefix, count, second = false) {
  let part = wavePart(1);
  if (second) {
    part = JSON.parse(JSON.stringify(part)
      .replaceAll(METHOD_ID, methodId)
      .replaceAll('scenario-', 'second-scenario-')
      .replaceAll('target-', 'second-target-')
      .replaceAll('decision-', 'second-decision-')
      .replaceAll('group-', 'second-group-')
      .replaceAll('plan-', 'second-plan-')
      .replaceAll('path-', 'second-path-')
      .replaceAll('variant-', 'second-variant-')
      .replaceAll('flag', 'secondFlag'));
    part.method.methodName = 'second';
    part.method.completeMethodSource = 'public void second() {}';
  }
  const retainedScenarioIds = new Set(part.scenarioIds.slice(0, count));
  const retainedTargetIds = new Set(
    part.scenarios.slice(0, count).flatMap((item) => item.coverageTargetIds)
  );
  const retainedGroupIds = new Set(
    part.methodTestPlan.testPathGroups.slice(0, count).map((item) => item.groupId)
  );
  part.scenarioIds = part.scenarioIds.slice(0, count);
  part.scenarios = part.scenarios.filter((item) => retainedScenarioIds.has(item.scenarioId));
  part.method.activeScenarioIds = [...part.scenarioIds];
  part.methodTestPlan.minimumTestCount = count;
  part.methodTestPlan.remainingTargets = part.methodTestPlan.remainingTargets.filter(
    (item) => retainedTargetIds.has(item.targetId)
  );
  part.methodTestPlan.testPathGroups = part.methodTestPlan.testPathGroups.filter(
    (item) => retainedGroupIds.has(item.groupId)
  );
  part.methodTestPlan.testMethodPlans = part.methodTestPlan.testMethodPlans.filter(
    (item) => item.pathGroupIds.some((id) => retainedGroupIds.has(id))
  );
  return { methodId, testMethodNamePrefix: prefix, batch: part };
}

function classWorkWaveResponse() {
  const first = classWaveSlice(METHOD_ID, 'm1_', 3);
  const second = classWaveSlice(SECOND_METHOD_ID, 'm2_', 2, true);
  const scenarioIds = [first, second].flatMap((slice) => slice.batch.scenarioIds);
  return {
    waveBatchId: 'f'.repeat(64),
    reportPairId: REPORT_PAIR_ID,
    hasWork: true,
    selectedMethodIds: [METHOD_ID, SECOND_METHOD_ID],
    selectedScenarioIds: scenarioIds,
    remainingScenarioCountByMethod: { [METHOD_ID]: 0, [SECOND_METHOD_ID]: 0 },
    completedMethodIds: [METHOD_ID, SECOND_METHOD_ID],
    parts: [{
      partIndex: 1,
      partBatchId: '9'.repeat(64),
      scenarioIds,
      methodSlices: [first, second]
    }],
    warnings: []
  };
}

test('posts one class scenario Wave request and decodes mixed source-method slices', async () => {
  const calls = [];
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return jsonResponse(200, classWorkWaveResponse());
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  const request = {
    reportPairId: REPORT_PAIR_ID,
    methods: [{
      methodId: METHOD_ID,
      completedScenarioIds: ['done-a'],
      skippedScenarioIds: []
    }, {
      methodId: SECOND_METHOD_ID,
      completedScenarioIds: [],
      skippedScenarioIds: ['skip-b']
    }],
    maxScenarios: 25,
    partSize: 5
  };

  const result = await client.nextClassScenarioWave(SESSION_ID, request);

  assert.equal(
    calls[0].url.href,
    `http://127.0.0.1:30200/api/generation-analysis/sessions/${SESSION_ID}/next-class-wave`
  );
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer analyzer-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.deepEqual(result.selectedMethodIds, [METHOD_ID, SECOND_METHOD_ID]);
  assert.deepEqual(
    result.parts[0].methodSlices.map((slice) => [
      slice.methodId,
      slice.testMethodNamePrefix,
      slice.batch.scenarioIds.length
    ]),
    [[METHOD_ID, 'm1_', 3], [SECOND_METHOD_ID, 'm2_', 2]]
  );
  assert.deepEqual(result.selectedScenarioIds, result.parts[0].scenarioIds);
});

test('decodes a busy class-Wave response as a retryable analysis error', async () => {
  const client = new AiClient(async () => jsonResponse(429, {
    code: 'ANALYSIS_SESSION_BUSY',
    message: '分析会话正在处理另一个请求，请稍后重试。'
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.nextClassScenarioWave(SESSION_ID, {
      reportPairId: REPORT_PAIR_ID,
      methods: [{
        methodId: METHOD_ID,
        completedScenarioIds: [],
        skippedScenarioIds: []
      }],
      maxScenarios: 25,
      partSize: 5
    }),
    (error) => {
      assert.equal(error instanceof MethodAnalysisRequestError, true);
      assert.equal(error.code, 'ANALYSIS_SESSION_BUSY');
      assert.match(error.message, /分析会话正在处理另一个请求/);
      return true;
    }
  );
});
test('times out a stalled generation-analysis request with a retryable Analyzer error', async () => {
  let requestWasAborted = false;
  const client = new AiClient(
    async (_url, init) => new Promise((resolve, reject) => {
      const delayedResponse = setTimeout(
        () => resolve(jsonResponse(200, classWorkWaveResponse())),
        100
      );
      init.signal?.addEventListener('abort', () => {
        requestWasAborted = true;
        clearTimeout(delayedResponse);
        reject(init.signal.reason);
      }, { once: true });
    }),
    { javaAnalyzerResponseTimeoutMilliseconds: 10 }
  );
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.nextClassScenarioWave(SESSION_ID, {
      reportPairId: REPORT_PAIR_ID,
      methods: [{
        methodId: METHOD_ID,
        completedScenarioIds: [],
        skippedScenarioIds: []
      }],
      maxScenarios: 25,
      partSize: 5
    }),
    (error) => {
      assert.equal(isJavaAnalyzerResponseTimeoutError(error), true);
      return true;
    }
  );
  assert.equal(requestWasAborted, true);
});

test('preserves the caller abort reason while the analysis timeout is armed', async () => {
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const client = new AiClient(
    async (_url, init) => new Promise((_resolve, reject) => {
      markRequestStarted();
      init.signal.addEventListener('abort', () => {
        reject(init.signal.reason);
      }, { once: true });
    }),
    { javaAnalyzerResponseTimeoutMilliseconds: 1_000 }
  );
  client.setManagedBackendAccessProvider(() => managedAccess());
  const controller = new AbortController();
  const callerReason = new Error('caller stopped analysis');

  const pending = client.nextClassScenarioWave(SESSION_ID, {
    reportPairId: REPORT_PAIR_ID,
    methods: [{
      methodId: METHOD_ID,
      completedScenarioIds: [],
      skippedScenarioIds: []
    }],
    maxScenarios: 25,
    partSize: 5
  }, controller.signal);
  await requestStarted;
  controller.abort(callerReason);

  await assert.rejects(pending, (error) => {
    assert.equal(error, callerReason);
    assert.equal(isJavaAnalyzerResponseTimeoutError(error), false);
    return true;
  });
});

test('distinguishes an invalid Analyzer class-Wave response from an invalid local request', async () => {
  let fetchCalls = 0;
  const client = new AiClient(async () => {
    fetchCalls += 1;
    return jsonResponse(200, {
      ...classWorkWaveResponse(),
      unexpectedField: true
    });
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  const request = {
    reportPairId: REPORT_PAIR_ID,
    methods: [{
      methodId: METHOD_ID,
      completedScenarioIds: [],
      skippedScenarioIds: []
    }, {
      methodId: SECOND_METHOD_ID,
      completedScenarioIds: [],
      skippedScenarioIds: []
    }],
    maxScenarios: 25,
    partSize: 5
  };

  await assert.rejects(
    client.nextClassScenarioWave(SESSION_ID, request),
    (error) => {
      assert.equal(isMethodAnalysisResponseInvalidError(error), true);
      return true;
    }
  );
  assert.equal(fetchCalls, 1);

  await assert.rejects(
    client.nextClassScenarioWave(SESSION_ID, { ...request, maxScenarios: 24 }),
    (error) => {
      assert.equal(isMethodAnalysisResponseInvalidError(error), false);
      assert.match(error.message, /单方法分析响应无效/);
      return true;
    }
  );
  assert.equal(fetchCalls, 1, 'local request validation must fail before the Analyzer call');
});

test('requests and strictly decodes one fixed 25-by-5 method Wave', async () => {
  const calls = [];
  const client = new AiClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return jsonResponse(200, workWave());
  });
  client.setManagedBackendAccessProvider(() => managedAccess());
  const request = {
    reportPairId: REPORT_PAIR_ID,
    completedScenarioIds: ['already-complete'],
    skippedScenarioIds: ['already-skipped'],
    maxScenarios: 25,
    partSize: 5
  };

  const result = await client.nextMethodWave(SESSION_ID, METHOD_ID, request);

  assert.equal(
    calls[0].url.href,
    `http://127.0.0.1:30200/api/generation-analysis/sessions/${SESSION_ID}`
      + `/methods/${METHOD_ID}/next-wave`
  );
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer analyzer-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.deepEqual(result.parts.map((part) => part.partIndex), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    result.selectedScenarioIds,
    result.parts.flatMap((part) => part.scenarioIds)
  );
  assert.equal(result.remainingScenarioCount, 30);
  assert.deepEqual(result.parts[0].scenarios[0].conditionPathVariants, [{
    variantId: 'variant-1',
    expectations: [{ operandIndex: 0, expression: 'flag1', expected: true }],
    coverageTargetIds: ['target-1']
  }]);
});

test('accepts bounded called-method contracts and legacy types without the field', async () => {
  const response = workWave();
  const signature = 'public String interpret(String expression)';
  response.parts[0].referencedTypes = [{
    qualifiedName: 'demo.ExpressionEngine',
    kind: 'CLASS',
    constructors: ['public ExpressionEngine()'],
    methods: [signature],
    enumConstants: [],
    methodContracts: [{
      signature,
      documentation: '表达式必须以标记字符开头，否则返回 null。'
    }]
  }, {
    qualifiedName: 'demo.LegacyType',
    kind: 'CLASS',
    constructors: [],
    methods: [],
    enumConstants: []
  }];
  const client = new AiClient(async () => jsonResponse(200, response));
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.nextMethodWave(SESSION_ID, METHOD_ID, {
    reportPairId: REPORT_PAIR_ID,
    completedScenarioIds: [],
    skippedScenarioIds: [],
    maxScenarios: 25,
    partSize: 5
  });

  assert.equal(
    result.parts[0].referencedTypes[0].methodContracts[0].documentation,
    '表达式必须以标记字符开头，否则返回 null。'
  );
  assert.equal(result.parts[0].referencedTypes[1].methodContracts, undefined);
});
test('preserves optional Analyzer coverage-annotated source in every Wave part', async () => {
  for (const annotated of [null, '/* [未覆盖行] */ public void run() {}']) {
    const response = workWave();
    for (const part of response.parts) part.method.coverageAnnotatedMethodSource = annotated;
    const client = new AiClient(async () => jsonResponse(200, response));
    client.setManagedBackendAccessProvider(() => managedAccess());
    const result = await client.nextMethodWave(SESSION_ID, METHOD_ID, {
      reportPairId: REPORT_PAIR_ID, completedScenarioIds: [], skippedScenarioIds: [],
      maxScenarios: 25, partSize: 5
    });
    assert.equal(result.parts.length, 5);
    for (const part of result.parts) {
      assert.equal(part.method.coverageAnnotatedMethodSource, annotated);
      assert.equal(part.method.completeMethodSource, response.parts[0].method.completeMethodSource);
    }
  }
});

test('decodes a stub plan bound to one internal condition-path variant', async () => {
  const response = workWave();
  response.parts[0].activeStubPlans = [{
    stubId: 'stub-1',
    callSiteId: 'call-1',
    methodId: METHOD_ID,
    actualCallOwnerMethodId: METHOD_ID,
    scenarioId: 'scenario-1',
    conditionPathVariantId: 'variant-1',
    resolvedSignature: 'demo.Dependency#enabled()Z',
    argumentMatchers: [],
    action: 'RETURN_SEQUENCE',
    returnOrExceptionSequence: ['true'],
    downstreamBranchBinding: 'flag1=true',
    invocationCount: 1,
    mockMode: 'MOCKITO',
    suggestedJava: 'when(dependency.enabled()).thenReturn(true);',
    status: 'READY'
  }];
  const client = new AiClient(async () => jsonResponse(200, response));
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.nextMethodWave(SESSION_ID, METHOD_ID, {
    reportPairId: REPORT_PAIR_ID,
    completedScenarioIds: [],
    skippedScenarioIds: [],
    maxScenarios: 25,
    partSize: 5
  });

  assert.equal(
    result.parts[0].activeStubPlans[0].conditionPathVariantId,
    'variant-1'
  );
});

test('accepts optional compact Mock without changing full Java and rejects invalid text', async () => {
  const fullJava = 'when(dependency.enabled()).thenReturn(true);';
  for (const compactMock of [undefined, '', '实例调用：dependency.enabled()；返回序列：[true]', 123, 'x'.repeat(20_001)]) {
    const response = workWave();
    response.parts[0].activeStubPlans = [{
      stubId: 'stub-1', callSiteId: 'call-1', methodId: METHOD_ID,
      actualCallOwnerMethodId: METHOD_ID, scenarioId: 'scenario-1', conditionPathVariantId: '',
      resolvedSignature: 'demo.Dependency.enabled()', argumentMatchers: [], action: 'THEN_RETURN',
      returnOrExceptionSequence: ['true'], downstreamBranchBinding: 'flag1=true', invocationCount: 1,
      mockMode: 'MOCKITO', suggestedJava: fullJava, status: 'READY',
      ...(compactMock === undefined ? {} : { compactMock })
    }];
    const client = new AiClient(async () => jsonResponse(200, response));
    client.setManagedBackendAccessProvider(() => managedAccess());
    const execution = client.nextMethodWave(SESSION_ID, METHOD_ID, {
      reportPairId: REPORT_PAIR_ID, completedScenarioIds: [], skippedScenarioIds: [],
      maxScenarios: 25, partSize: 5
    });
    if (typeof compactMock === 'number' || compactMock?.length > 20_000) {
      await assert.rejects(execution, /单方法分析响应无效/);
    } else {
      const result = await execution;
      assert.equal(result.parts[0].activeStubPlans[0].suggestedJava, fullJava);
      assert.equal(result.parts[0].activeStubPlans[0].compactMock ?? '', compactMock ?? '');
    }
  }
});

test('rejects malformed method Wave unions, duplicate scenarios, and non-fixed request sizes', async () => {
  const invalidUnionClient = new AiClient(async () => jsonResponse(200, workWave({
    selectedScenarioIds: workWave().selectedScenarioIds.slice(1)
  })));
  invalidUnionClient.setManagedBackendAccessProvider(() => managedAccess());
  const duplicate = workWave();
  duplicate.parts[1] = structuredClone(duplicate.parts[0]);
  duplicate.parts[1].partIndex = 2;
  duplicate.parts[1].partBatchId = '2'.repeat(64);
  const duplicateClient = new AiClient(async () => jsonResponse(200, duplicate));
  duplicateClient.setManagedBackendAccessProvider(() => managedAccess());
  const request = {
    reportPairId: REPORT_PAIR_ID,
    completedScenarioIds: [],
    skippedScenarioIds: [],
    maxScenarios: 25,
    partSize: 5
  };

  await assert.rejects(
    invalidUnionClient.nextMethodWave(SESSION_ID, METHOD_ID, request),
    /单方法分析响应无效/
  );
  await assert.rejects(
    duplicateClient.nextMethodWave(SESSION_ID, METHOD_ID, request),
    /单方法分析响应无效/
  );
  await assert.rejects(
    invalidUnionClient.nextMethodWave(SESSION_ID, METHOD_ID, {
      ...request,
      maxScenarios: 24
    }),
    /单方法分析响应无效/
  );
  await assert.rejects(
    invalidUnionClient.nextMethodWave(SESSION_ID, METHOD_ID, {
      ...request,
      completedScenarioIds: ['same'],
      skippedScenarioIds: ['same']
    }),
    /单方法分析响应无效/
  );
});

function analysisRequest() {
  return {
    analysisSessionId: SESSION_ID,
    workspaceRoot: 'D:\\work',
    moduleRoot: 'D:\\work\\module',
    targetSourcePath: 'D:\\work\\module\\src\\main\\java\\demo\\TaskService.java',
    targetClass: 'demo.TaskService',
    plannedTestClassName: 'TaskServiceTmp1Test',
    plannedRelativeTestPath: 'src/test/java/demo/TaskServiceTmp1Test.java',
    reportPath: 'D:\\work\\module\\target\\site\\jacoco\\jacoco.xml',
    branchSnapshotPath: 'D:\\work\\module\\target\\site\\jacoco\\jacoco.branches.json',
    reportPairId: REPORT_PAIR_ID,
    sourceRoots: ['D:\\work\\module\\src\\main\\java'],
    classpathEntries: [],
    javaHome: 'D:\\java\\jdk21',
    jdkMajorVersion: 21,
    buildContextFingerprint: 'd'.repeat(64)
  };
}

test('surfaces the Analyzer error code and message when analysis session creation is rejected', async () => {
  const client = new AiClient(async () => jsonResponse(400, {
    code: 'TARGET_SOURCE_PARSE_FAILED',
    message: '目标源码无法完整解析，请先修复 Java 语法错误。'
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.createMethodAnalysisSession(analysisRequest()),
    (error) => {
      assert.ok(error instanceof MethodAnalysisRequestError);
      assert.equal(error.code, 'TARGET_SOURCE_PARSE_FAILED');
      assert.equal(
        error?.message,
        '单方法分析请求失败（TARGET_SOURCE_PARSE_FAILED）：目标源码无法完整解析，请先修复 Java 语法错误。'
      );
      return true;
    }
  );
});

test('redacts and bounds Analyzer analysis errors before exposing them', async () => {
  const client = new AiClient(async () => jsonResponse(400, {
    code: 'TARGET_SOURCE_PARSE_FAILED',
    message: `Authorization: Bearer analyzer-token ${'x'.repeat(8_192)}`
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.createMethodAnalysisSession(analysisRequest()),
    (error) => {
      assert.match(error?.message ?? '', /TARGET_SOURCE_PARSE_FAILED/);
      assert.doesNotMatch(error?.message ?? '', /analyzer-token/);
      assert.ok((error?.message?.length ?? Infinity) <= 4_096);
      return true;
    }
  );
});

test('surfaces the Analyzer error code and message when coverage refresh is rejected', async () => {
  const client = new AiClient(async () => jsonResponse(409, {
    code: 'DEPENDENCY_CONTEXT_CHANGED',
    message: '项目依赖已经变化，请重新开始生成以刷新分析上下文。'
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.refreshMethodAnalysisCoverage(SESSION_ID, {
      reportPath: 'D:\\work\\module\\target\\site\\jacoco\\after.xml',
      branchSnapshotPath: 'D:\\work\\module\\target\\site\\jacoco\\after.branches.json',
      reportPairId: REPORT_PAIR_ID
    }),
    (error) => {
      assert.equal(
        error?.message,
        '刷新单方法覆盖率失败（DEPENDENCY_CONTEXT_CHANGED）：'
          + '项目依赖已经变化，请重新开始生成以刷新分析上下文。'
      );
      return true;
    }
  );
});

test('does not expose an arbitrary coverage-refresh error body', async () => {
  const client = new AiClient(async () => new Response(
    'Authorization: Bearer analyzer-token internal stack trace',
    { status: 409, headers: { 'Content-Type': 'text/plain' } }
  ));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.refreshMethodAnalysisCoverage(SESSION_ID, {
      reportPath: 'D:\\work\\module\\target\\site\\jacoco\\after.xml',
      branchSnapshotPath: 'D:\\work\\module\\target\\site\\jacoco\\after.branches.json',
      reportPairId: REPORT_PAIR_ID
    }),
    (error) => {
      assert.equal(error?.message, '刷新单方法覆盖率失败：409');
      assert.doesNotMatch(error?.message ?? '', /analyzer-token|stack trace/);
      return true;
    }
  );
});

test('uses canonical Analyzer paths, dynamic managed access, Bearer, redirect refusal, and AbortSignal', async () => {
  const requests = [];
  const controller = new AbortController();
  const responses = [
    {
      analysisSessionId: SESSION_ID,
      reportPairId: REPORT_PAIR_ID,
      sourceSha256: 'e'.repeat(64),
      dependencyContextSha256: 'f'.repeat(64),
      packageName: 'demo',
      testClassName: 'TaskServiceTmp1Test',
      suggestedRelativeTestPath: 'src/test/java/demo/TaskServiceTmp1Test.java',
      warnings: []
    },
    catalog(),
    {
      reportPairId: '9'.repeat(64),
      coverage: {
        lineCovered: 8,
        lineMissed: 2,
        lineTotal: 10,
        branchCovered: 4,
        branchMissed: 2,
        branchTotal: 6
      },
      catalog: catalog({ reportPairId: '9'.repeat(64) })
    }
  ];
  const accesses = [1, 2, 3].map((index) => ({
    ...managedAccess(),
    javaAnalyzerUrl: `http://127.0.0.1:${30200 + index}`,
    javaAnalyzerAuthorizationHeader: `Bearer analyzer-token-${index}`
  }));
  const client = new AiClient(async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    return jsonResponse(200, responses.shift());
  });
  client.setManagedBackendAccessProvider(() => accesses.shift());

  const created = await client.createMethodAnalysisSession({
    ...analysisRequest(),
    warnings: [{ code: 'CLASSPATH_COLLECTION_FAILED', message: 'local context only' }],
    unexpectedField: 'must not cross the Analyzer HTTP boundary'
  }, controller.signal);
  const returnedCatalog = await client.getMethodCatalog(SESSION_ID, controller.signal);
  await client.refreshMethodAnalysisCoverage(SESSION_ID, {
    reportPath: 'D:\\work\\module\\target\\site\\jacoco\\after.xml',
    branchSnapshotPath: 'D:\\work\\module\\target\\site\\jacoco\\after.branches.json',
    reportPairId: '9'.repeat(64)
  }, controller.signal);

  assert.deepEqual(requests.map(({ url }) => url.href), [
    'http://127.0.0.1:30201/api/generation-analysis/sessions',
    `http://127.0.0.1:30202/api/generation-analysis/sessions/${SESSION_ID}/methods`,
    `http://127.0.0.1:30203/api/generation-analysis/sessions/${SESSION_ID}/refresh-coverage`
  ]);
  assert.deepEqual(requests.map(({ init }) => new Headers(init.headers).get('authorization')), [
    'Bearer analyzer-token-1',
    'Bearer analyzer-token-2',
    'Bearer analyzer-token-3'
  ]);
  assert.ok(requests.every(({ init }) => init.redirect === 'error'));
  assert.ok(requests.every(({ init }) => init.signal instanceof AbortSignal));
  assert.ok(requests.every(({ init }) => (
    init.signal !== controller.signal && init.signal.aborted === false
  )));
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), analysisRequest());
  assert.equal(returnedCatalog.methods[0].instructionCovered, 40);
  assert.equal(returnedCatalog.methods[0].instructionMissed, 60);
  assert.equal(returnedCatalog.methods[0].complexityCovered, 18);
  assert.equal(returnedCatalog.methods[0].complexityMissed, 77);
  assert.deepEqual(returnedCatalog.reportCoverageTotals, {
    instructionCovered: 29,
    instructionMissed: 11,
    branchCovered: 7,
    branchMissed: 3,
    complexityCovered: 6,
    complexityMissed: 4,
    lineCovered: 5,
    lineMissed: 4
  });
  assert.equal('assertionPolicy' in created, false);
});

test('deletes an Analyzer method-analysis session through the managed backend', async () => {
  const requests = [];
  const controller = new AbortController();
  const client = new AiClient(async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    return new Response(null, { status: 204 });
  });
  client.setManagedBackendAccessProvider(() => ({
    ...managedAccess(),
    javaAnalyzerAuthorizationHeader: 'Bearer analyzer-delete-token'
  }));

  await client.deleteMethodAnalysisSession(SESSION_ID, controller.signal);

  assert.equal(
    requests[0].url.href,
    `http://127.0.0.1:30200/api/generation-analysis/sessions/${SESSION_ID}`
  );
  assert.equal(requests[0].init.method, 'DELETE');
  assert.equal(requests[0].init.redirect, 'error');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.notEqual(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.signal.aborted, false);
  assert.equal(
    new Headers(requests[0].init.headers).get('authorization'),
    'Bearer analyzer-delete-token'
  );
});

test('accepts and normalizes the Analyzer empty-string unavailable reason in refreshed coverage', async () => {
  // Mutation caught: rejecting '' breaks compatibility with an already-running Analyzer during upgrade.
  const client = new AiClient(async () => jsonResponse(200, {
    reportPairId: REPORT_PAIR_ID,
    coverage: {
      lineCovered: 8,
      lineMissed: 2,
      lineTotal: 10,
      branchCovered: 4,
      branchMissed: 2,
      branchTotal: 6
    },
    catalog: catalog({
      methods: [methodSummary({ unavailableReason: '' })]
    })
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.refreshMethodAnalysisCoverage(SESSION_ID, {
    reportPath: 'D:\\work\\module\\target\\site\\jacoco\\after.xml',
    branchSnapshotPath: 'D:\\work\\module\\target\\site\\jacoco\\after.branches.json',
    reportPairId: REPORT_PAIR_ID
  });

  assert.equal(result.catalog.methods[0].generatable, true);
  assert.equal(result.catalog.methods[0].unavailableReason, null);
});

test('enforces every Analyzer method availability and unavailable-reason combination', async (context) => {
  const cases = [
    {
      name: 'rejects a generatable method with a non-empty unavailable reason',
      generatable: true,
      unavailableReason: 'must not exist',
      rejected: true
    },
    {
      name: 'rejects an unavailable method with a null reason',
      generatable: false,
      unavailableReason: null,
      rejected: true
    },
    {
      name: 'rejects an unavailable method with an empty reason',
      generatable: false,
      unavailableReason: '',
      rejected: true
    },
    {
      name: 'preserves a non-empty reason for an unavailable method',
      generatable: false,
      unavailableReason: 'not present in the current JaCoCo report',
      rejected: false
    }
  ];

  for (const current of cases) {
    await context.test(current.name, async () => {
      const client = new AiClient(async () => jsonResponse(200, {
        reportPairId: REPORT_PAIR_ID,
        coverage: {
          lineCovered: 8,
          lineMissed: 2,
          lineTotal: 10,
          branchCovered: 4,
          branchMissed: 2,
          branchTotal: 6
        },
        catalog: catalog({
          methods: [methodSummary({
            generatable: current.generatable,
            unavailableReason: current.unavailableReason
          })]
        })
      }));
      client.setManagedBackendAccessProvider(() => managedAccess());
      const refresh = () => client.refreshMethodAnalysisCoverage(SESSION_ID, {
        reportPath: 'D:\\work\\module\\target\\site\\jacoco\\after.xml',
        branchSnapshotPath: 'D:\\work\\module\\target\\site\\jacoco\\after.branches.json',
        reportPairId: REPORT_PAIR_ID
      });

      if (current.rejected) {
        await assert.rejects(refresh(), /单方法分析响应无效/);
        return;
      }
      const result = await refresh();
      assert.equal(
        result.catalog.methods[0].unavailableReason,
        'not present in the current JaCoCo report'
      );
    });
  }
});

test('requests one analyzer method by encoded stable id and validates report pair', async () => {
  const requests = [];
  const client = new AiClient(async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    return jsonResponse(200, workBatch());
  });
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.nextMethodBatch(SESSION_ID, METHOD_ID, {
    reportPairId: REPORT_PAIR_ID,
    completedTestMethodPlanIds: [],
    maxTestMethods: 12
  });

  assert.equal(
    requests[0].url.pathname,
    `/api/generation-analysis/sessions/${SESSION_ID}/methods/${METHOD_ID}/next-batch`
  );
  assert.equal(result.methodId, METHOD_ID);
  assert.equal(result.plannedTestMethods, 12);
  assert.equal(result.methodTestPlan.testMethodPlans.length, 12);
});

test('accepts a complete data-class method plan beyond the removed twelve-test page limit', async () => {
  const client = new AiClient(async () => jsonResponse(200, workBatch({}, 13)));
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.nextMethodBatch(SESSION_ID, METHOD_ID, {
    reportPairId: REPORT_PAIR_ID,
    completedTestMethodPlanIds: [],
    maxTestMethods: 20_000
  });

  assert.equal(result.plannedTestMethods, 13);
  assert.equal(result.methodTestPlan.testMethodPlans.length, 13);
});

test('posts exact method repair context and strictly decodes the Analyzer response', async () => {
  const requests = [];
  const controller = new AbortController();
  const request = {
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    currentClassFrames: [{
      ownerFqn: 'demo.TaskService',
      methodName: 'updateUser',
      descriptor: null,
      sourceLine: 965
    }],
    relatedTypeFqns: ['demo.ReportUnit'],
    missingSymbols: ['getReportUnitType']
  };
  const response = {
    reportPairId: REPORT_PAIR_ID,
    sourceSha256: 'e'.repeat(64),
    targetMethod: {
      methodId: 'demo.TaskService#run()V',
      declaringType: 'demo.TaskService',
      methodName: 'run',
      descriptor: '()V',
      modifiers: ['public'],
      firstLine: 10,
      lastLine: 30,
      sourceFirstLine: 10,
      sourceLastLine: 30,
      sourceText: 'public void run() {}',
      sourceComplete: true,
      parameterTypes: [],
      returnType: 'void',
      declaredExceptions: []
    },
    stackMethods: [{
      methodId: 'demo.TaskService#updateUser()V',
      declaringType: 'demo.TaskService',
      methodName: 'updateUser',
      descriptor: '()V',
      modifiers: ['private'],
      firstLine: 900,
      lastLine: 1320,
      sourceFirstLine: 955,
      sourceLastLine: 1254,
      sourceText: 'private void updateUser() {}',
      sourceComplete: false,
      parameterTypes: [],
      returnType: 'void',
      declaredExceptions: ['demo.ReportException']
    }],
    referencedTypes: Array.from({ length: 24 }, (_, index) => ({
      qualifiedName: index === 0 ? 'demo.ReportUnit' : `demo.RepairType${index}`,
      kind: 'CLASS',
      constructors: [],
      methods: index === 0
        ? ['public demo.ReportUnitType getReportUnitType()']
        : [`public void repairMethod${index}()`],
      enumConstants: []
    })),
    warnings: [],
    truncated: false
  };
  const client = new AiClient(async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    return jsonResponse(200, response);
  });
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.getMethodRepairContext(
    SESSION_ID,
    request,
    controller.signal
  );

  assert.equal(
    requests[0].url.pathname,
    `/api/generation-analysis/sessions/${SESSION_ID}/repair-context`
  );
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.notEqual(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.signal.aborted, false);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), request);
  assert.equal(result.stackMethods[0].methodName, 'updateUser');
  assert.equal(result.stackMethods[0].sourceComplete, false);
  assert.equal(result.stackMethods[0].sourceFirstLine, 955);
  assert.equal(result.referencedTypes[0].methods[0],
    'public demo.ReportUnitType getReportUnitType()');
  assert.equal(result.referencedTypes.length, 24);

  const invalidClient = new AiClient(async () => jsonResponse(200, {
    ...response,
    unknownField: true
  }));
  invalidClient.setManagedBackendAccessProvider(() => managedAccess());
  await assert.rejects(
    invalidClient.getMethodRepairContext(SESSION_ID, request),
    /单方法分析响应无效/
  );

  const oversizedClient = new AiClient(async () => jsonResponse(200, {
    ...response,
    referencedTypes: Array.from({ length: 65 }, (_, index) => ({
      qualifiedName: `demo.OversizedRepairType${index}`,
      kind: 'CLASS',
      constructors: [],
      methods: [],
      enumConstants: []
    }))
  }));
  oversizedClient.setManagedBackendAccessProvider(() => managedAccess());
  await assert.rejects(
    oversizedClient.getMethodRepairContext(SESSION_ID, request)
  );
});

test('accepts unresolved remaining targets on a partial Analyzer page', async () => {
  const batch = workBatch();
  const unresolvedTarget = {
    ...coverageTarget(12),
    mappingStatus: 'UNRELIABLE'
  };
  const client = new AiClient(async () => jsonResponse(200, {
    ...batch,
    methodTestPlan: {
      ...batch.methodTestPlan,
      analysisStatus: 'PARTIAL',
      remainingTargets: [
        ...batch.methodTestPlan.remainingTargets,
        unresolvedTarget
      ],
      fallbackReason: 'BRANCH_MAPPING_UNRELIABLE'
    }
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.nextMethodBatch(SESSION_ID, METHOD_ID, {
    reportPairId: REPORT_PAIR_ID,
    completedTestMethodPlanIds: [],
    maxTestMethods: 12
  });

  assert.equal(result.hasWork, true);
  assert.equal(result.methodTestPlan.remainingTargets.at(-1).targetId, 'target-13');
});

test('rejects mismatched method provenance, report identities, test counts, and unknown fields', async () => {
  const invalidResponses = [
    workBatch({ methodId: 'd'.repeat(64) }),
    workBatch({ reportPairId: 'e'.repeat(64) }),
    workBatch({ plannedTestMethods: 11 }),
    { ...workBatch(), accessCategory: 'PUBLIC' }
  ];
  for (const invalidResponse of invalidResponses) {
    const client = new AiClient(async () => jsonResponse(200, invalidResponse));
    client.setManagedBackendAccessProvider(() => managedAccess());
    await assert.rejects(
      client.nextMethodBatch(SESSION_ID, METHOD_ID, {
        reportPairId: REPORT_PAIR_ID,
        completedTestMethodPlanIds: [],
        maxTestMethods: 12
      }),
      /单方法分析响应无效/
    );
  }
});

test('accepts only an empty exact no-work page', async () => {
  const noWork = {
    batchId: null,
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    hasWork: false,
    method: null,
    scenarios: [],
    methodTestPlan: null,
    methodStubInventory: null,
    activeStubPlans: [],
    targetFixturePlan: null,
    referencedTypes: [],
    necessaryImports: [],
    plannedTestMethods: 0,
    remainingTestMethods: 0,
    warnings: []
  };
  const client = new AiClient(async () => jsonResponse(200, noWork));
  client.setManagedBackendAccessProvider(() => managedAccess());
  const result = await client.nextMethodBatch(SESSION_ID, METHOD_ID, {
    reportPairId: REPORT_PAIR_ID,
    completedTestMethodPlanIds: ['test-plan-1'],
    maxTestMethods: 12
  });
  assert.equal(result.hasWork, false);

  const invalidClient = new AiClient(async () => jsonResponse(200, {
    ...noWork,
    necessaryImports: ['org.junit.jupiter.api.Test']
  }));
  invalidClient.setManagedBackendAccessProvider(() => managedAccess());
  await assert.rejects(
    invalidClient.nextMethodBatch(SESSION_ID, METHOD_ID, {
      reportPairId: REPORT_PAIR_ID,
      completedTestMethodPlanIds: [],
      maxTestMethods: 12
    }),
    /单方法分析响应无效/
  );
});

test('rejects duplicate catalog identities and inconsistent exact coverage totals', async () => {
  const invalidCatalogClient = new AiClient(async () => jsonResponse(200, catalog({
    methods: [methodSummary(), methodSummary({ jacocoOrder: 1 })]
  })));
  invalidCatalogClient.setManagedBackendAccessProvider(() => managedAccess());
  await assert.rejects(
    invalidCatalogClient.getMethodCatalog(SESSION_ID),
    /单方法分析响应无效/
  );

  const invalidCoverageClient = new AiClient(async () => jsonResponse(200, {
    reportPairId: REPORT_PAIR_ID,
    coverage: {
      lineCovered: 8,
      lineMissed: 3,
      lineTotal: 10,
      branchCovered: 4,
      branchMissed: 2,
      branchTotal: 6
    },
    catalog: catalog()
  }));
  invalidCoverageClient.setManagedBackendAccessProvider(() => managedAccess());
  await assert.rejects(
    invalidCoverageClient.refreshMethodAnalysisCoverage(SESSION_ID, {
      reportPath: 'after.xml',
      branchSnapshotPath: 'after.branches.json',
      reportPairId: REPORT_PAIR_ID
    }),
    /单方法分析响应无效/
  );

  const invalidReportTotalsClient = new AiClient(async () => jsonResponse(200, catalog({
    reportCoverageTotals: {
      instructionCovered: 29,
      instructionMissed: -1,
      branchCovered: 7,
      branchMissed: 3,
      complexityCovered: 6,
      complexityMissed: 4,
      lineCovered: 5,
      lineMissed: 4
    }
  })));
  invalidReportTotalsClient.setManagedBackendAccessProvider(() => managedAccess());
  await assert.rejects(
    invalidReportTotalsClient.getMethodCatalog(SESSION_ID),
    /单方法分析响应无效/
  );
});
