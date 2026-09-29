import assert from 'node:assert/strict';
import test from 'node:test';

import * as validation from '../src/main/services/class-task-ipc-validation.ts';

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';
const workspaceRoot = 'D:\\work';
const timestamp = '2026-08-08T00:00:00.000Z';

const exactCoverage = {
  lineCovered: 3,
  lineMissed: 1,
  lineTotal: 4,
  branchCovered: 1,
  branchMissed: 1,
  branchTotal: 2
};

const validArtifact = {
  id: 'artifact-1',
  filePath: 'D:\\work\\src\\test\\java\\ExampleTest.java',
  testClassName: 'ExampleTest',
  ordinaryTestMethodCount: 1,
  methodIds: ['method-1'],
  methodResults: [{
    methodId: 'method-1',
    methodName: 'run',
    displaySignature: 'void run()',
    jacocoOrder: 0,
    ordinaryTestMethodCount: 1
  }],
  sha256: 'a'.repeat(64),
  sealed: true,
  accepted: false,
  createdAt: timestamp,
  updatedAt: timestamp
};

const validSnapshot = {
  id: TASK_ID,
  workspaceRoot,
  sourceFilePath: 'D:\\work\\src\\main\\java\\Example.java',
  qualifiedClassName: 'com.example.Example',
  moduleKey: 'module-a',
  moduleDisplayPath: 'module-a',
  state: 'READY',
  preloadState: 'READY',
  ragEnabled: false,
  repairAttemptLimit: null,
  unlimitedRepair: false,
  selectionMode: 'ALL_BY_DEFAULT',
  selectedMethodIds: [],
  methodOrder: [],
  coveredMethodIds: [],
  currentMethodIndex: -1,
  currentAtomicStep: 'IDLE',
  activeGenerationBatch: null,
  tokenUsage: { inputTokens: 120, cachedInputTokens: 50, outputTokens: 30, totalTokens: 150 },
  modelCallCount: 2,
  usageReportedCallCount: 2,
  generatedArtifacts: [validArtifact],
  coverageBaseline: exactCoverage,
  coverageCurrent: exactCoverage,
  coverageContributions: [{
    artifactId: 'artifact-1',
    filePath: validArtifact.filePath,
    addedLineCount: 1,
    lineTotal: 4,
    addedBranchCount: 1,
    branchTotal: 2
  }],
  completionAttentionPending: false,
  startedAt: null,
  pausedAt: null,
  finishedAt: null,
  lastError: null,
  updatedAt: timestamp
};

const validCatalog = {
  taskId: TASK_ID,
  analysisSessionId: '223e4567-e89b-42d3-a456-426614174000',
  reportPairId: 'report-pair-1',
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
  methods: [{
    methodId: 'method-1',
    methodName: 'run',
    descriptor: '()V',
    displaySignature: 'void run()',
    firstLine: 10,
    lastLine: 12,
    jacocoOrder: 0,
    lineCovered: 2,
    lineMissed: 1,
    branchCovered: 1,
    branchMissed: 0,
    instructionCovered: 8,
    instructionMissed: 3,
    complexityCovered: 2,
    complexityMissed: 1,
    coverageGap: true,
    generatable: true,
    unavailableReason: null,
    modifiers: ['public']
  }],
  warnings: [{ code: 'PARTIAL_DEBUG_INFO', message: 'Some line metadata is unavailable.' }],
  refreshedAt: timestamp
};

test('class task explicit empty selection and all-by-default are valid exact save requests', () => {
  for (const selectionMode of ['EXPLICIT', 'ALL_BY_DEFAULT']) {
    const selection = validation.validateSaveMethodSelectionRequest({
      workspaceRoot,
      taskId: TASK_ID,
      selectionMode,
      selectedMethodIds: [],
      methodOrder: [],
      ragEnabled: false,
      repairAttemptLimit: 12,
      unlimitedRepair: false
    });
    assert.equal(selection.selectionMode, selectionMode);
    assert.deepEqual(selection.selectedMethodIds, []);
  }
  assert.throws(
    () => validation.validateTaskIdentityRequest({ workspaceRoot, taskId: TASK_ID, selectedMethodIds: [] }),
    /未知字段/
  );
});

test('class task method freshness request accepts only an exact sha256 fingerprint', () => {
  const request = {
    workspaceRoot,
    taskId: TASK_ID,
    fingerprint: 'a'.repeat(64)
  };
  assert.deepEqual(validation.validateCheckClassTaskMethodsRequest(request), request);
  assert.throws(
    () => validation.validateCheckClassTaskMethodsRequest({ ...request, fingerprint: 'stale' }),
    /sha256|fingerprint/i
  );
  assert.throws(
    () => validation.validateCheckClassTaskMethodsRequest({ ...request, unexpected: true }),
    /未知字段/
  );
});

test('class task repair configuration accepts finite or unlimited mode and rejects unconfigured saves', () => {
  const base = {
    workspaceRoot,
    taskId: TASK_ID,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-1'],
    methodOrder: ['method-1'],
    ragEnabled: true
  };
  assert.equal(validation.validateSaveMethodSelectionRequest({
    ...base,
    repairAttemptLimit: 999_999,
    unlimitedRepair: false
  }).repairAttemptLimit, 999_999);
  assert.deepEqual(validation.validateSaveMethodSelectionRequest({
    ...base,
    repairAttemptLimit: null,
    unlimitedRepair: true
  }), {
    ...base,
    repairAttemptLimit: null,
    unlimitedRepair: true
  });

  for (const configuration of [
    { repairAttemptLimit: null, unlimitedRepair: false },
    { repairAttemptLimit: 0, unlimitedRepair: false },
    { repairAttemptLimit: -1, unlimitedRepair: false },
    { repairAttemptLimit: 1.5, unlimitedRepair: false },
    { repairAttemptLimit: '5', unlimitedRepair: false },
    { repairAttemptLimit: 5, unlimitedRepair: true }
  ]) {
    assert.throws(
      () => validation.validateSaveMethodSelectionRequest({ ...base, ...configuration }),
      /修复轮次|repairAttemptLimit|unlimitedRepair/i
    );
  }
});

test('class task add request rejects more than five, non-java, and outside-workspace paths', () => {
  const validPath = 'D:\\work\\src\\Example.java';
  assert.throws(
    () => validation.validateAddClassTasksRequest({
      workspaceRoot,
      classFilePaths: Array.from({ length: 6 }, (_, index) => `D:\\work\\src\\Example${index}.java`)
    }),
    /最多 5/
  );
  assert.throws(
    () => validation.validateAddClassTasksRequest({ workspaceRoot, classFilePaths: ['D:\\work\\README.txt'] }),
    /\.java/
  );
  assert.throws(
    () => validation.validateAddClassTasksRequest({ workspaceRoot, classFilePaths: ['D:\\outside\\Example.java'] }),
    /工作区外/
  );
  assert.deepEqual(validation.validateAddClassTasksRequest({ workspaceRoot, classFilePaths: [validPath] }), {
    workspaceRoot,
    classFilePaths: [validPath]
  });
});

test('class task rejects sparse arrays before recursive DTO construction', () => {
  const sparse = new Array(1);

  assert.throws(() => validation.validateAddClassTasksRequest({
    workspaceRoot,
    classFilePaths: sparse
  }), /空项/);
  assert.throws(() => validation.validateClassMethodCatalog({
    ...validCatalog,
    methods: sparse
  }), /空项/);
  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    generatedArtifacts: [{ ...validArtifact, methodIds: sparse }]
  }), /空项/);
});

test('class task validates the complete frozen snapshot and returns detached nested DTOs', () => {
  const actual = validation.validateClassTaskSnapshot(validSnapshot);
  assert.deepEqual(actual, validSnapshot);
  assert.notEqual(actual, validSnapshot);
  assert.notEqual(actual.generatedArtifacts, validSnapshot.generatedArtifacts);
  assert.notEqual(actual.generatedArtifacts[0], validSnapshot.generatedArtifacts[0]);
  assert.notEqual(actual.coverageCurrent, validSnapshot.coverageCurrent);
  assert.notEqual(actual.coverageContributions, validSnapshot.coverageContributions);
  assert.notEqual(actual.tokenUsage, validSnapshot.tokenUsage);

  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    state: 'QUEUED'
  }), /状态/);
  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    coverageCurrent: { ...exactCoverage, uncoveredLines: [11] }
  }), /未知字段/);
  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    generatedArtifacts: [{ ...validArtifact, methodIds: Array(5_001).fill('method-1') }]
  }), /5000/);
  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    usageReportedCallCount: 3
  }), /usageReportedCallCount|Token/i);
  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    lastError: {
      code: 'FAILED',
      message: 'failed',
      moduleName: null,
      modulePath: null,
      command: null,
      occurredAt: timestamp,
      cause: () => undefined
    }
  }), /未知字段/);
});

test('class task validates every ClassMethodCatalog field recursively', () => {
  const actual = validation.validateClassMethodCatalog(validCatalog);
  assert.deepEqual(actual, validCatalog);
  assert.equal(actual.methods[0].instructionMissed, 3);
  assert.equal(actual.methods[0].complexityMissed, 1);
  assert.deepEqual(actual.reportCoverageTotals, validCatalog.reportCoverageTotals);
  assert.notEqual(actual, validCatalog);
  assert.notEqual(actual.reportCoverageTotals, validCatalog.reportCoverageTotals);
  assert.notEqual(actual.methods, validCatalog.methods);
  assert.notEqual(actual.methods[0].modifiers, validCatalog.methods[0].modifiers);
  assert.notEqual(actual.warnings, validCatalog.warnings);

  assert.throws(() => validation.validateClassMethodCatalog({
    ...validCatalog,
    methods: [{ ...validCatalog.methods[0], modifiers: ['public', { unsafe: true }] }]
  }), /modifier/i);
  assert.throws(() => validation.validateClassMethodCatalog({
    ...validCatalog,
    warnings: [{ code: 'X', message: 'x'.repeat(4_097) }]
  }), /message/i);
  assert.throws(() => validation.validateClassMethodCatalog({
    ...validCatalog,
    methods: [{ ...validCatalog.methods[0], firstLine: 13 }]
  }), /line range/i);
  assert.throws(() => validation.validateClassMethodCatalog({
    ...validCatalog,
    reportCoverageTotals: {
      ...validCatalog.reportCoverageTotals,
      instructionMissed: -1
    }
  }), /instructionMissed/i);
});

test('class task validates the complete result snapshot and exact coverage totals', () => {
  const result = {
    taskId: TASK_ID,
    state: 'COMPLETED',
    artifacts: [validArtifact],
    generatedMethods: [{
      ...validArtifact.methodResults[0],
      artifactId: validArtifact.id,
      filePath: validArtifact.filePath,
      testClassName: validArtifact.testClassName
    }],
    tokenUsage: validSnapshot.tokenUsage,
    modelCallCount: validSnapshot.modelCallCount,
    usageReportedCallCount: validSnapshot.usageReportedCallCount,
    coverageBaseline: exactCoverage,
    coverageCurrent: exactCoverage,
    coverageContributions: validSnapshot.coverageContributions,
    canAccept: true,
    canRevoke: false
  };
  assert.deepEqual(validation.validateClassTaskResultSnapshot(result), result);
  assert.throws(() => validation.validateClassTaskResultSnapshot({
    ...result,
    coverageCurrent: { ...exactCoverage, lineTotal: 5 }
  }), /total/i);
  const allSkipped = {
    ...result,
    artifacts: [],
    generatedMethods: [],
    coverageContributions: [],
    canAccept: false,
    canRevoke: false,
    allScenariosSkipped: true
  };
  assert.deepEqual(validation.validateClassTaskResultSnapshot(allSkipped), allSkipped);
  assert.throws(() => validation.validateClassTaskResultSnapshot({
    ...allSkipped,
    allScenariosSkipped: 'yes'
  }), /allScenariosSkipped/i);
});

test('class task accepts legacy persisted artifacts without per-method display data', () => {
  const { methodResults, ...legacyArtifact } = validArtifact;
  const actual = validation.validateClassTaskSnapshot({
    ...validSnapshot,
    generatedArtifacts: [legacyArtifact]
  });

  assert.equal('methodResults' in actual.generatedArtifacts[0], false);
});

test('class task result rejects duplicate artifact and contribution identities', () => {
  const result = {
    taskId: TASK_ID,
    state: 'COMPLETED',
    artifacts: [validArtifact],
    generatedMethods: [{
      ...validArtifact.methodResults[0],
      artifactId: validArtifact.id,
      filePath: validArtifact.filePath,
      testClassName: validArtifact.testClassName
    }],
    tokenUsage: validSnapshot.tokenUsage,
    modelCallCount: validSnapshot.modelCallCount,
    usageReportedCallCount: validSnapshot.usageReportedCallCount,
    coverageBaseline: exactCoverage,
    coverageCurrent: exactCoverage,
    coverageContributions: validSnapshot.coverageContributions,
    canAccept: true,
    canRevoke: false
  };

  assert.throws(() => validation.validateClassTaskResultSnapshot({
    ...result,
    artifacts: [validArtifact, { ...validArtifact, id: 'artifact-2' }]
  }), /filePath/);
  assert.throws(() => validation.validateClassTaskResultSnapshot({
    ...result,
    coverageContributions: [
      validSnapshot.coverageContributions[0],
      { ...validSnapshot.coverageContributions[0] }
    ]
  }), /artifactId/);
});

test('class task snapshots reject contributions not linked to the matching artifact path', () => {
  assert.throws(() => validation.validateClassTaskSnapshot({
    ...validSnapshot,
    coverageContributions: [{
      ...validSnapshot.coverageContributions[0],
      artifactId: 'missing-artifact'
    }]
  }), /artifactId/);

  assert.throws(() => validation.validateClassTaskResultSnapshot({
    taskId: TASK_ID,
    state: 'COMPLETED',
    artifacts: [validArtifact],
    generatedMethods: [{
      ...validArtifact.methodResults[0],
      artifactId: validArtifact.id,
      filePath: validArtifact.filePath,
      testClassName: validArtifact.testClassName
    }],
    tokenUsage: validSnapshot.tokenUsage,
    modelCallCount: validSnapshot.modelCallCount,
    usageReportedCallCount: validSnapshot.usageReportedCallCount,
    coverageBaseline: exactCoverage,
    coverageCurrent: exactCoverage,
    coverageContributions: [{
      ...validSnapshot.coverageContributions[0],
      filePath: 'D:\\work\\src\\test\\java\\OtherTest.java'
    }],
    canAccept: true,
    canRevoke: false
  }), /filePath/);
});

test('class task exports exact validators for every request channel', () => {
  const identity = { workspaceRoot, taskId: TASK_ID };
  const workspace = { workspaceRoot };
  const cases = [
    ['validateRemoveClassTaskRequest', identity],
    ['validateReorderClassTasksRequest', { ...workspace, taskIds: [TASK_ID] }],
    ['validateListClassTasksRequest', workspace],
    ['validateGetClassTaskMethodsRequest', identity],
    ['validateRunClassTaskRequest', identity],
    ['validatePauseClassTaskRequest', identity],
    ['validateResumeClassTaskRequest', identity],
    ['validateTerminateClassTaskRequest', identity],
    ['validateRunAllClassTasksRequest', workspace],
    ['validateTerminateAllClassTasksRequest', workspace],
    ['validateGetClassTaskResultRequest', identity],
    ['validateAcceptClassTaskRequest', identity],
    ['validateRevokeClassTaskRequest', identity],
    ['validateRetryModulePreloadRequest', identity],
    ['validateStopModulePreloadRequest', identity]
  ];
  for (const [name, input] of cases) {
    assert.equal(typeof validation[name], 'function', `${name} must be exported`);
    assert.deepEqual(validation[name](input), input);
    assert.throws(() => validation[name]({ ...input, unknown: true }), /未知字段/);
  }
});

test('class task reorder requires unique UUIDs and at most five entries', () => {
  const secondTaskId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(validation.validateReorderClassTasksRequest({
    workspaceRoot,
    taskIds: [TASK_ID, secondTaskId]
  }), {
    workspaceRoot,
    taskIds: [TASK_ID, secondTaskId]
  });
  assert.throws(() => validation.validateReorderClassTasksRequest({
    workspaceRoot,
    taskIds: [TASK_ID, TASK_ID]
  }), /重复/);
  assert.throws(() => validation.validateReorderClassTasksRequest({
    workspaceRoot,
    taskIds: Array.from({ length: 6 }, (_, index) => (
      `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`
    ))
  }), /最多 5 项/);
});

test('manual method refresh accepts only a boolean forceReload flag', () => {
  const request = { workspaceRoot, taskId: TASK_ID, forceReload: true };
  let validated;

  assert.doesNotThrow(() => {
    validated = validation.validateGetClassTaskMethodsRequest(request);
  });
  assert.deepEqual(validated, request);
  assert.throws(
    () => validation.validateGetClassTaskMethodsRequest({
      workspaceRoot,
      taskId: TASK_ID,
      forceReload: 'yes'
    }),
    /forceReload/
  );
});

test('class task compares five thousand selected method ids within a linear-time budget', () => {
  const ids = Array.from(
    { length: 5_000 },
    (_, index) => `${'m'.repeat(1_018)}${String(index).padStart(6, '0')}`
  );
  const startedAt = performance.now();
  for (let iteration = 0; iteration < 4; iteration += 1) {
    validation.validateSaveMethodSelectionRequest({
      workspaceRoot,
      taskId: TASK_ID,
      selectionMode: 'EXPLICIT',
      selectedMethodIds: ids,
      methodOrder: [...ids].reverse(),
      ragEnabled: false,
      repairAttemptLimit: 5,
      unlimitedRepair: false
    });
  }
  assert.ok(performance.now() - startedAt < 200);
});
