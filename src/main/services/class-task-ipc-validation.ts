import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  CLASS_TASK_ATOMIC_STEPS,
  CLASS_TASK_STATES,
  METHOD_SELECTION_MODES,
  MODULE_PRELOAD_STATES,
  type AcceptClassTaskRequest,
  type AddClassTasksRequest,
  type CheckClassTaskMethodsRequest,
  type ClassTaskActiveGenerationBatch,
  type CoverageTotals,
  type ClassMethodCatalog,
  type ClassMethodSummary,
  type ClassTaskResultSnapshot,
  type ClassTaskResultMethod,
  type ClassTaskSnapshot,
  type CoverageContribution,
  type ExactCoverageCounts,
  type GeneratedClassTaskArtifact,
  type GeneratedSourceMethodResult,
  type GetClassTaskMethodsRequest,
  type GetClassTaskResultRequest,
  type ListClassTasksRequest,
  type PauseClassTaskRequest,
  type PublicTaskError,
  type PublicTaskNotice,
  type RemoveClassTaskRequest,
  type ReorderClassTasksRequest,
  type ResumeClassTaskRequest,
  type RetryModulePreloadRequest,
  type RevokeClassTaskRequest,
  type RunAllClassTasksRequest,
  type RunClassTaskRequest,
  type SaveMethodSelectionRequest,
  type StopModulePreloadRequest,
  type TaskIdentityRequest,
  type TerminateAllClassTasksRequest,
  type TerminateClassTaskRequest,
  type WorkspaceRequest
} from '../../shared/class-task-contracts.ts';
import type { ModelTokenUsage } from '../../shared/model-token-usage.ts';

const MAX_PATH_LENGTH = 32_767;
const MAX_CLASS_PATHS = 5;
const MAX_LIST_ENTRIES = 5_000;
const MAX_ID_LENGTH = 1_024;
const MAX_NAME_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 4_096;
const MAX_MODIFIERS = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function validateWorkspaceRequest(value: unknown): WorkspaceRequest {
  const record = requireExactRecord(value, ['workspaceRoot']);
  return { workspaceRoot: requireBoundedPath(record.workspaceRoot, 'workspaceRoot') };
}

export function validateTaskIdentityRequest(value: unknown): TaskIdentityRequest {
  const record = requireExactRecord(value, ['workspaceRoot', 'taskId']);
  return {
    workspaceRoot: requireBoundedPath(record.workspaceRoot, 'workspaceRoot'),
    taskId: requireUuid(record.taskId, 'taskId')
  };
}

export function validateAddClassTasksRequest(value: unknown): AddClassTasksRequest {
  const record = requireExactRecord(value, ['workspaceRoot', 'classFilePaths']);
  const workspaceRoot = requireBoundedPath(record.workspaceRoot, 'workspaceRoot');
  const classFilePaths = requireArray(record.classFilePaths, 'classFilePaths', MAX_CLASS_PATHS)
    .map((entry) => requireJavaPath(entry, workspaceRoot, 'classFilePath'));
  if (classFilePaths.length === 0) throw new Error('classFilePaths 至少需要 1 项');
  assertUnique(classFilePaths.map(normalizedPathKey), 'classFilePaths 包含重复路径');
  return { workspaceRoot, classFilePaths };
}

export function validateSaveMethodSelectionRequest(value: unknown): SaveMethodSelectionRequest {
  const record = requireExactRecord(value, [
    'workspaceRoot', 'taskId', 'selectionMode', 'selectedMethodIds', 'methodOrder', 'ragEnabled',
    'repairAttemptLimit', 'unlimitedRepair'
  ]);
  const identity = validateTaskIdentityRequest({ workspaceRoot: record.workspaceRoot, taskId: record.taskId });
  const selectionMode = requireEnum(record.selectionMode, METHOD_SELECTION_MODES, 'selectionMode');
  const selectedMethodIds = requireIdentifierArray(record.selectedMethodIds, 'selectedMethodIds');
  const methodOrder = requireIdentifierArray(record.methodOrder, 'methodOrder');
  if (!sameEntries(selectedMethodIds, methodOrder)) {
    throw new Error('selectedMethodIds 与 methodOrder 不一致');
  }
  const repairConfiguration = validateRepairConfiguration(
    record.repairAttemptLimit,
    record.unlimitedRepair
  );
  return {
    ...identity,
    selectionMode,
    selectedMethodIds,
    methodOrder,
    ragEnabled: requireBoolean(record.ragEnabled, 'ragEnabled'),
    ...repairConfiguration
  };
}

export function validateRemoveClassTaskRequest(value: unknown): RemoveClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validateReorderClassTasksRequest(value: unknown): ReorderClassTasksRequest {
  const record = requireExactRecord(value, ['workspaceRoot', 'taskIds']);
  const taskIds = requireArray(record.taskIds, 'taskIds', MAX_CLASS_PATHS)
    .map((taskId) => requireUuid(taskId, 'taskId'));
  assertUnique(taskIds, 'taskIds 包含重复 ID');
  return {
    workspaceRoot: requireBoundedPath(record.workspaceRoot, 'workspaceRoot'),
    taskIds
  };
}

export function validateListClassTasksRequest(value: unknown): ListClassTasksRequest {
  return validateWorkspaceRequest(value);
}

export function validateGetClassTaskMethodsRequest(value: unknown): GetClassTaskMethodsRequest {
  const hasForceReload = Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.hasOwn(value, 'forceReload')
  );
  const record = requireExactRecord(
    value,
    hasForceReload ? ['workspaceRoot', 'taskId', 'forceReload'] : ['workspaceRoot', 'taskId']
  );
  const identity = validateTaskIdentityRequest({
    workspaceRoot: record.workspaceRoot,
    taskId: record.taskId
  });
  return hasForceReload
    ? { ...identity, forceReload: requireBoolean(record.forceReload, 'forceReload') }
    : identity;
}

export function validateCheckClassTaskMethodsRequest(
  value: unknown
): CheckClassTaskMethodsRequest {
  const record = requireExactRecord(value, ['workspaceRoot', 'taskId', 'fingerprint']);
  return {
    ...validateTaskIdentityRequest({
      workspaceRoot: record.workspaceRoot,
      taskId: record.taskId
    }),
    fingerprint: requireSha256(record.fingerprint)
  };
}

export function validateRunClassTaskRequest(value: unknown): RunClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validatePauseClassTaskRequest(value: unknown): PauseClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validateResumeClassTaskRequest(value: unknown): ResumeClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validateTerminateClassTaskRequest(value: unknown): TerminateClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validateRunAllClassTasksRequest(value: unknown): RunAllClassTasksRequest {
  return validateWorkspaceRequest(value);
}

export function validateTerminateAllClassTasksRequest(value: unknown): TerminateAllClassTasksRequest {
  return validateWorkspaceRequest(value);
}

export function validateGetClassTaskResultRequest(value: unknown): GetClassTaskResultRequest {
  return validateTaskIdentityRequest(value);
}

export function validateAcceptClassTaskRequest(value: unknown): AcceptClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validateRevokeClassTaskRequest(value: unknown): RevokeClassTaskRequest {
  return validateTaskIdentityRequest(value);
}

export function validateRetryModulePreloadRequest(value: unknown): RetryModulePreloadRequest {
  return validateTaskIdentityRequest(value);
}

export function validateStopModulePreloadRequest(value: unknown): StopModulePreloadRequest {
  return validateTaskIdentityRequest(value);
}

export function validateClassMethodCatalog(value: unknown): ClassMethodCatalog {
  const record = requireRecordWithOptionalFields(value, [
    'taskId', 'analysisSessionId', 'reportPairId', 'reportCoverageTotals',
    'methods', 'warnings', 'refreshedAt'
  ], ['fingerprint']);
  const methods = requireArray(record.methods, 'methods', MAX_LIST_ENTRIES).map(validateClassMethodSummary);
  assertUnique(methods.map((method) => method.methodId), 'methods 包含重复 methodId');
  return {
    taskId: requireUuid(record.taskId, 'taskId'),
    analysisSessionId: requireUuid(record.analysisSessionId, 'analysisSessionId'),
    reportPairId: requireText(record.reportPairId, 'reportPairId', MAX_ID_LENGTH),
    ...(record.fingerprint !== undefined
      ? { fingerprint: requireSha256(record.fingerprint) }
      : {}),
    reportCoverageTotals: validateCoverageTotals(record.reportCoverageTotals),
    methods,
    warnings: requireArray(record.warnings, 'warnings', MAX_LIST_ENTRIES).map(validatePublicTaskNotice),
    refreshedAt: requireIsoTimestamp(record.refreshedAt, 'refreshedAt')
  };
}

export function validateClassTaskSnapshot(value: unknown): ClassTaskSnapshot {
  const record = requireExactRecord(value, [
    'id', 'workspaceRoot', 'sourceFilePath', 'qualifiedClassName', 'moduleKey', 'moduleDisplayPath',
    'state', 'preloadState', 'ragEnabled', 'repairAttemptLimit', 'unlimitedRepair', 'selectionMode',
    'selectedMethodIds', 'methodOrder', 'coveredMethodIds', 'currentMethodIndex',
    'currentAtomicStep', 'activeGenerationBatch', 'tokenUsage', 'modelCallCount',
    'usageReportedCallCount', 'generatedArtifacts', 'coverageBaseline', 'coverageCurrent', 'coverageContributions',
    'completionAttentionPending', 'startedAt', 'pausedAt', 'finishedAt', 'lastError', 'updatedAt'
  ]);
  const workspaceRoot = requireBoundedPath(record.workspaceRoot, 'workspaceRoot');
  const selectedMethodIds = requireIdentifierArray(record.selectedMethodIds, 'selectedMethodIds');
  const methodOrder = requireIdentifierArray(record.methodOrder, 'methodOrder');
  const coveredMethodIds = requireIdentifierArray(record.coveredMethodIds, 'coveredMethodIds');
  if (!sameEntries(selectedMethodIds, methodOrder)) throw new Error('selectedMethodIds 与 methodOrder 不一致');
  const currentMethodIndex = requireInteger(record.currentMethodIndex, 'currentMethodIndex', -1, MAX_LIST_ENTRIES - 1);
  if (currentMethodIndex >= methodOrder.length) throw new Error('currentMethodIndex 超出 methodOrder 范围');
  const currentAtomicStep = requireEnum(
    record.currentAtomicStep,
    CLASS_TASK_ATOMIC_STEPS,
    'currentAtomicStep'
  );
  const activeGenerationBatch = validateActiveGenerationBatch(record.activeGenerationBatch);
  const tokenAccounting = validateTokenAccounting(record);
  if (activeGenerationBatch && currentAtomicStep === 'IDLE') {
    throw new Error('activeGenerationBatch 只能用于正在执行的原子步骤');
  }
  if (
    activeGenerationBatch
    && activeGenerationBatch.methodCount > methodOrder.length - currentMethodIndex - 1
  ) {
    throw new Error('activeGenerationBatch 超出剩余方法范围');
  }
  const generatedArtifacts = requireArray(record.generatedArtifacts, 'generatedArtifacts', MAX_LIST_ENTRIES)
    .map((entry) => validateGeneratedArtifact(entry, workspaceRoot));
  assertUnique(generatedArtifacts.map((artifact) => artifact.id), 'generatedArtifacts 包含重复 id');
  assertUnique(generatedArtifacts.map((artifact) => normalizedPathKey(artifact.filePath)), 'generatedArtifacts 包含重复 filePath');
  const coverageContributions = requireArray(record.coverageContributions, 'coverageContributions', MAX_LIST_ENTRIES)
    .map((entry) => validateCoverageContribution(entry, workspaceRoot));
  assertUnique(coverageContributions.map((item) => item.artifactId), 'coverageContributions 包含重复 artifactId');
  assertContributionsMatchArtifacts(generatedArtifacts, coverageContributions);
  const startedAt = requireNullableTimestamp(record.startedAt, 'startedAt');
  const pausedAt = requireNullableTimestamp(record.pausedAt, 'pausedAt');
  const finishedAt = requireNullableTimestamp(record.finishedAt, 'finishedAt');
  if (startedAt && finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('finishedAt 早于 startedAt');
  }
  if (startedAt && pausedAt && Date.parse(pausedAt) < Date.parse(startedAt)) {
    throw new Error('pausedAt 早于 startedAt');
  }
  const repairConfiguration = validateRepairConfiguration(
    record.repairAttemptLimit,
    record.unlimitedRepair,
    true
  );
  return {
    id: requireUuid(record.id, 'id'),
    workspaceRoot,
    sourceFilePath: requireJavaPath(record.sourceFilePath, workspaceRoot, 'sourceFilePath'),
    qualifiedClassName: requireText(record.qualifiedClassName, 'qualifiedClassName', MAX_NAME_LENGTH),
    moduleKey: requireText(record.moduleKey, 'moduleKey', MAX_ID_LENGTH),
    moduleDisplayPath: requireText(record.moduleDisplayPath, 'moduleDisplayPath', MAX_PATH_LENGTH),
    state: requireEnum(record.state, CLASS_TASK_STATES, '任务状态'),
    preloadState: requireEnum(record.preloadState, MODULE_PRELOAD_STATES, 'preloadState'),
    ragEnabled: requireBoolean(record.ragEnabled, 'ragEnabled'),
    ...repairConfiguration,
    selectionMode: requireEnum(record.selectionMode, METHOD_SELECTION_MODES, 'selectionMode'),
    selectedMethodIds,
    methodOrder,
    coveredMethodIds,
    currentMethodIndex,
    currentAtomicStep,
    activeGenerationBatch,
    ...tokenAccounting,
    generatedArtifacts,
    coverageBaseline: record.coverageBaseline === null ? null : validateExactCoverageCounts(record.coverageBaseline),
    coverageCurrent: record.coverageCurrent === null ? null : validateExactCoverageCounts(record.coverageCurrent),
    coverageContributions,
    completionAttentionPending: requireBoolean(record.completionAttentionPending, 'completionAttentionPending'),
    startedAt,
    pausedAt,
    finishedAt,
    lastError: record.lastError === null ? null : validatePublicTaskError(record.lastError, workspaceRoot),
    updatedAt: requireIsoTimestamp(record.updatedAt, 'updatedAt')
  };
}

function validateActiveGenerationBatch(value: unknown): ClassTaskActiveGenerationBatch | null {
  if (value === null) return null;
  const record = requireExactRecord(value, ['methodCount', 'scenarioCount']);
  return {
    methodCount: requireInteger(record.methodCount, 'activeGenerationBatch.methodCount', 1, MAX_LIST_ENTRIES),
    scenarioCount: requireInteger(record.scenarioCount, 'activeGenerationBatch.scenarioCount', 1, MAX_LIST_ENTRIES)
  };
}

function validateTokenAccounting(record: Record<string, unknown>): {
  tokenUsage: ModelTokenUsage | null;
  modelCallCount: number | null;
  usageReportedCallCount: number | null;
} {
  const modelCallCount = record.modelCallCount === null
    ? null
    : requireInteger(record.modelCallCount, 'modelCallCount', 0);
  const usageReportedCallCount = record.usageReportedCallCount === null
    ? null
    : requireInteger(record.usageReportedCallCount, 'usageReportedCallCount', 0);
  const tokenUsage = record.tokenUsage === null
    ? null
    : validateModelTokenUsage(record.tokenUsage);
  if (modelCallCount === null || usageReportedCallCount === null) {
    if (modelCallCount !== null || usageReportedCallCount !== null || tokenUsage !== null) {
      throw new Error('历史 Token 统计字段必须同时为空');
    }
    return { tokenUsage: null, modelCallCount: null, usageReportedCallCount: null };
  }
  if (usageReportedCallCount > modelCallCount) {
    throw new Error('usageReportedCallCount 不得大于 modelCallCount');
  }
  if ((usageReportedCallCount === 0) !== (tokenUsage === null)) {
    throw new Error('Token 用量与 usageReportedCallCount 不一致');
  }
  return { tokenUsage, modelCallCount, usageReportedCallCount };
}

function validateModelTokenUsage(value: unknown): ModelTokenUsage {
  const record = requireRecordWithOptionalFields(
    value,
    ['inputTokens', 'outputTokens', 'totalTokens'],
    ['cachedInputTokens']
  );
  const result: ModelTokenUsage = {
    inputTokens: record.inputTokens === null
      ? null
      : requireInteger(record.inputTokens, 'tokenUsage.inputTokens', 0),
    outputTokens: record.outputTokens === null
      ? null
      : requireInteger(record.outputTokens, 'tokenUsage.outputTokens', 0),
    totalTokens: record.totalTokens === null
      ? null
      : requireInteger(record.totalTokens, 'tokenUsage.totalTokens', 0)
  };
  if ('cachedInputTokens' in record) {
    result.cachedInputTokens = record.cachedInputTokens === null
      ? null
      : requireInteger(record.cachedInputTokens, 'tokenUsage.cachedInputTokens', 0);
  }
  return result;
}

export function validateClassTaskResultSnapshot(value: unknown): ClassTaskResultSnapshot {
  const record = requireRecordWithOptionalFields(value, [
    'taskId', 'state', 'artifacts', 'generatedMethods', 'tokenUsage', 'modelCallCount',
    'usageReportedCallCount', 'coverageBaseline', 'coverageCurrent', 'coverageContributions',
    'canAccept', 'canRevoke'
  ], ['allScenariosSkipped']);
  const tokenAccounting = validateTokenAccounting(record);
  const artifacts = requireArray(record.artifacts, 'artifacts', MAX_LIST_ENTRIES)
    .map((entry) => validateGeneratedArtifact(entry));
  assertUnique(artifacts.map((artifact) => artifact.id), 'artifacts 包含重复 id');
  assertUnique(artifacts.map((artifact) => normalizedPathKey(artifact.filePath)), 'artifacts 包含重复 filePath');
  const generatedMethods = requireArray(record.generatedMethods, 'generatedMethods', MAX_LIST_ENTRIES)
    .map((entry) => validateClassTaskResultMethod(entry));
  assertUnique(generatedMethods.map((method) => method.methodId), 'generatedMethods 包含重复 methodId');
  assertGeneratedMethodsMatchArtifacts(artifacts, generatedMethods);
  const coverageContributions = requireArray(record.coverageContributions, 'coverageContributions', MAX_LIST_ENTRIES)
    .map((entry) => validateCoverageContribution(entry));
  assertUnique(coverageContributions.map((item) => item.artifactId), 'coverageContributions 包含重复 artifactId');
  assertContributionsMatchArtifacts(artifacts, coverageContributions);
  return {
    taskId: requireUuid(record.taskId, 'taskId'),
    state: requireEnum(record.state, CLASS_TASK_STATES, '任务状态'),
    artifacts,
    generatedMethods,
    ...(record.allScenariosSkipped === undefined
      ? {}
      : {
          allScenariosSkipped: requireBoolean(
            record.allScenariosSkipped,
            'allScenariosSkipped'
          )
        }),
    ...tokenAccounting,
    coverageBaseline: validateExactCoverageCounts(record.coverageBaseline),
    coverageCurrent: validateExactCoverageCounts(record.coverageCurrent),
    coverageContributions,
    canAccept: requireBoolean(record.canAccept, 'canAccept'),
    canRevoke: requireBoolean(record.canRevoke, 'canRevoke')
  };
}

function validateClassMethodSummary(value: unknown): ClassMethodSummary {
  const record = requireExactRecord(value, [
    'methodId', 'methodName', 'descriptor', 'displaySignature', 'firstLine', 'lastLine', 'jacocoOrder',
    'lineCovered', 'lineMissed', 'branchCovered', 'branchMissed', 'instructionCovered',
    'instructionMissed', 'complexityCovered', 'complexityMissed', 'coverageGap', 'generatable',
    'unavailableReason', 'modifiers'
  ]);
  const firstLine = requireInteger(record.firstLine, 'firstLine', 1);
  const lastLine = requireInteger(record.lastLine, 'lastLine', 1);
  if (lastLine < firstLine) throw new Error('method line range 无效');
  const generatable = requireBoolean(record.generatable, 'generatable');
  const unavailableReason = requireNullableText(record.unavailableReason, 'unavailableReason', MAX_TEXT_LENGTH);
  if (generatable && unavailableReason !== null) throw new Error('generatable method 不得包含 unavailableReason');
  const modifiers = requireArray(record.modifiers, 'modifiers', MAX_MODIFIERS)
    .map((modifier) => requireText(modifier, 'modifier', 256));
  assertUnique(modifiers, 'modifiers 包含重复值');
  return {
    methodId: requireText(record.methodId, 'methodId', MAX_ID_LENGTH),
    methodName: requireText(record.methodName, 'methodName', MAX_NAME_LENGTH),
    descriptor: requireText(record.descriptor, 'descriptor', MAX_TEXT_LENGTH),
    displaySignature: requireText(record.displaySignature, 'displaySignature', MAX_TEXT_LENGTH),
    firstLine,
    lastLine,
    jacocoOrder: requireInteger(record.jacocoOrder, 'jacocoOrder', 0),
    lineCovered: requireInteger(record.lineCovered, 'lineCovered', 0),
    lineMissed: requireInteger(record.lineMissed, 'lineMissed', 0),
    branchCovered: requireInteger(record.branchCovered, 'branchCovered', 0),
    branchMissed: requireInteger(record.branchMissed, 'branchMissed', 0),
    instructionCovered: requireInteger(record.instructionCovered, 'instructionCovered', 0),
    instructionMissed: requireInteger(record.instructionMissed, 'instructionMissed', 0),
    complexityCovered: requireInteger(record.complexityCovered, 'complexityCovered', 0),
    complexityMissed: requireInteger(record.complexityMissed, 'complexityMissed', 0),
    coverageGap: requireBoolean(record.coverageGap, 'coverageGap'),
    generatable,
    unavailableReason,
    modifiers
  };
}

function validateGeneratedArtifact(value: unknown, workspaceRoot?: string): GeneratedClassTaskArtifact {
  const record = requireRecordWithOptionalFields(value, [
    'id', 'filePath', 'testClassName', 'ordinaryTestMethodCount', 'methodIds', 'sha256', 'sealed',
    'accepted', 'createdAt', 'updatedAt'
  ], ['methodResults']);
  const filePath = requireBoundedPath(record.filePath, 'artifact filePath');
  if (!filePath.toLowerCase().endsWith('.java')) throw new Error('artifact filePath 必须以 .java 结尾');
  if (workspaceRoot) assertPathInsideWorkspace(filePath, workspaceRoot, 'artifact filePath 位于工作区外');
  const createdAt = requireIsoTimestamp(record.createdAt, 'artifact createdAt');
  const updatedAt = requireIsoTimestamp(record.updatedAt, 'artifact updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('artifact updatedAt 早于 createdAt');
  const ordinaryTestMethodCount = requireInteger(
    record.ordinaryTestMethodCount,
    'ordinaryTestMethodCount',
    0,
    MAX_LIST_ENTRIES
  );
  const methodIds = requireIdentifierArray(record.methodIds, 'artifact methodIds');
  const methodResults = record.methodResults === undefined
    ? undefined
    : requireArray(record.methodResults, 'artifact methodResults', MAX_LIST_ENTRIES)
      .map(validateGeneratedSourceMethodResult);
  if (methodResults) {
    if (
      methodResults.length !== methodIds.length
      || methodResults.some((method, index) => method.methodId !== methodIds[index])
      || methodResults.reduce((sum, method) => sum + method.ordinaryTestMethodCount, 0)
        !== ordinaryTestMethodCount
    ) {
      throw new Error('artifact methodResults 与文件测试数量不一致');
    }
  }
  return {
    id: requireText(record.id, 'artifact id', MAX_ID_LENGTH),
    filePath,
    testClassName: requireText(record.testClassName, 'testClassName', MAX_NAME_LENGTH),
    ordinaryTestMethodCount,
    methodIds,
    ...(methodResults ? { methodResults } : {}),
    sha256: requireSha256(record.sha256),
    sealed: requireBoolean(record.sealed, 'sealed'),
    accepted: requireBoolean(record.accepted, 'accepted'),
    createdAt,
    updatedAt
  };
}

function validateGeneratedSourceMethodResult(value: unknown): GeneratedSourceMethodResult {
  const record = requireExactRecord(value, [
    'methodId', 'methodName', 'displaySignature', 'jacocoOrder', 'ordinaryTestMethodCount'
  ]);
  return {
    methodId: requireText(record.methodId, 'method result methodId', MAX_ID_LENGTH),
    methodName: requireText(record.methodName, 'method result methodName', MAX_NAME_LENGTH),
    displaySignature: requireText(record.displaySignature, 'method result displaySignature', MAX_TEXT_LENGTH),
    jacocoOrder: requireInteger(record.jacocoOrder, 'method result jacocoOrder', 0, MAX_LIST_ENTRIES),
    ordinaryTestMethodCount: requireInteger(
      record.ordinaryTestMethodCount,
      'method result ordinaryTestMethodCount',
      0,
      MAX_LIST_ENTRIES
    )
  };
}

function validateClassTaskResultMethod(value: unknown): ClassTaskResultMethod {
  const record = requireExactRecord(value, [
    'methodId', 'methodName', 'displaySignature', 'jacocoOrder', 'ordinaryTestMethodCount',
    'artifactId', 'filePath', 'testClassName'
  ]);
  const method = validateGeneratedSourceMethodResult({
    methodId: record.methodId,
    methodName: record.methodName,
    displaySignature: record.displaySignature,
    jacocoOrder: record.jacocoOrder,
    ordinaryTestMethodCount: record.ordinaryTestMethodCount
  });
  return {
    ...method,
    artifactId: requireText(record.artifactId, 'result method artifactId', MAX_ID_LENGTH),
    filePath: requireBoundedPath(record.filePath, 'result method filePath'),
    testClassName: requireText(record.testClassName, 'result method testClassName', MAX_NAME_LENGTH)
  };
}

function validateCoverageContribution(value: unknown, workspaceRoot?: string): CoverageContribution {
  const record = requireExactRecord(value, [
    'artifactId', 'filePath', 'addedLineCount', 'lineTotal', 'addedBranchCount', 'branchTotal'
  ]);
  const filePath = requireBoundedPath(record.filePath, 'coverage contribution filePath');
  if (workspaceRoot) assertPathInsideWorkspace(filePath, workspaceRoot, 'coverage contribution filePath 位于工作区外');
  const addedLineCount = requireInteger(record.addedLineCount, 'addedLineCount', 0);
  const lineTotal = requireInteger(record.lineTotal, 'lineTotal', 0);
  const addedBranchCount = requireInteger(record.addedBranchCount, 'addedBranchCount', 0);
  const branchTotal = requireInteger(record.branchTotal, 'branchTotal', 0);
  if (addedLineCount > lineTotal || addedBranchCount > branchTotal) throw new Error('coverage contribution total 无效');
  return {
    artifactId: requireText(record.artifactId, 'artifactId', MAX_ID_LENGTH),
    filePath,
    addedLineCount,
    lineTotal,
    addedBranchCount,
    branchTotal
  };
}

function validateExactCoverageCounts(value: unknown): ExactCoverageCounts {
  const record = requireExactRecord(value, [
    'lineCovered', 'lineMissed', 'lineTotal', 'branchCovered', 'branchMissed', 'branchTotal'
  ]);
  const lineCovered = requireInteger(record.lineCovered, 'lineCovered', 0);
  const lineMissed = requireInteger(record.lineMissed, 'lineMissed', 0);
  const lineTotal = requireInteger(record.lineTotal, 'lineTotal', 0);
  const branchCovered = requireInteger(record.branchCovered, 'branchCovered', 0);
  const branchMissed = requireInteger(record.branchMissed, 'branchMissed', 0);
  const branchTotal = requireInteger(record.branchTotal, 'branchTotal', 0);
  if (lineCovered + lineMissed !== lineTotal) throw new Error('line total 不一致');
  if (branchCovered + branchMissed !== branchTotal) throw new Error('branch total 不一致');
  return { lineCovered, lineMissed, lineTotal, branchCovered, branchMissed, branchTotal };
}

function validateCoverageTotals(value: unknown): CoverageTotals {
  const record = requireExactRecord(value, [
    'instructionCovered', 'instructionMissed', 'branchCovered', 'branchMissed',
    'complexityCovered', 'complexityMissed', 'lineCovered', 'lineMissed'
  ]);
  return {
    instructionCovered: requireInteger(
      record.instructionCovered, 'instructionCovered', 0
    ),
    instructionMissed: requireInteger(
      record.instructionMissed, 'instructionMissed', 0
    ),
    branchCovered: requireInteger(record.branchCovered, 'branchCovered', 0),
    branchMissed: requireInteger(record.branchMissed, 'branchMissed', 0),
    complexityCovered: requireInteger(
      record.complexityCovered, 'complexityCovered', 0
    ),
    complexityMissed: requireInteger(
      record.complexityMissed, 'complexityMissed', 0
    ),
    lineCovered: requireInteger(record.lineCovered, 'lineCovered', 0),
    lineMissed: requireInteger(record.lineMissed, 'lineMissed', 0)
  };
}

function validatePublicTaskNotice(value: unknown): PublicTaskNotice {
  const record = requireExactRecord(value, ['code', 'message']);
  return {
    code: requireText(record.code, 'notice code', 256),
    message: requireText(record.message, 'notice message', MAX_TEXT_LENGTH)
  };
}

function validatePublicTaskError(value: unknown, workspaceRoot: string): PublicTaskError {
  const record = requireExactRecord(value, [
    'code', 'message', 'moduleName', 'modulePath', 'command', 'occurredAt'
  ]);
  const modulePath = record.modulePath === null ? null : requireBoundedPath(record.modulePath, 'error modulePath');
  if (modulePath) assertPathInsideWorkspace(modulePath, workspaceRoot, 'error modulePath 位于工作区外');
  return {
    code: requireText(record.code, 'error code', 256),
    message: requireText(record.message, 'error message', MAX_TEXT_LENGTH),
    moduleName: requireNullableText(record.moduleName, 'error moduleName', MAX_NAME_LENGTH),
    modulePath,
    command: requireNullableText(record.command, 'error command', MAX_TEXT_LENGTH),
    occurredAt: requireIsoTimestamp(record.occurredAt, 'error occurredAt')
  };
}

function requireIdentifierArray(value: unknown, label: string): string[] {
  const entries = requireArray(value, label, MAX_LIST_ENTRIES)
    .map((entry) => requireText(entry, `${label} item`, MAX_ID_LENGTH));
  assertUnique(entries, `${label} 包含重复 ID`);
  return entries;
}

function requireArray(value: unknown, label: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (value.length > maximumLength) throw new Error(`${label} 最多 ${maximumLength} 项`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label} 不得包含空项`);
  }
  return value;
}

function requireExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('请求必须是普通对象');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('未知字段');
  if (keys.some((key) => !(key in record))) throw new Error('请求字段缺失');
  return record;
}

function requireRecordWithOptionalFields(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('请求必须是普通对象');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('未知字段');
  if (requiredKeys.some((key) => !(key in record))) throw new Error('请求字段缺失');
  return record;
}

function requireEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} 无效`);
  return value as T[number];
}

function requireBoundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || !value.trim() || value.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(value) || !isAbsolute(value)
  ) {
    throw new Error(`${label} 路径无效`);
  }
  return value;
}

function requireJavaPath(value: unknown, workspaceRoot: string, label: string): string {
  const path = requireBoundedPath(value, label);
  if (!path.toLowerCase().endsWith('.java')) throw new Error(`${label} 必须以 .java 结尾`);
  assertPathInsideWorkspace(path, workspaceRoot, `${label} 位于工作区外`);
  return path;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`${label} UUID 无效`);
  return value.toLowerCase();
}

function requireSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error('sha256 无效');
  return value.toLowerCase();
}

function requireText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' || !value.trim() || value.length > maximumLength ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error(`${label} 无效`);
  }
  return value.trim();
}

function requireNullableText(value: unknown, label: string, maximumLength: number): string | null {
  return value === null ? null : requireText(value, label, maximumLength);
}

function requireInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} 无效`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 无效`);
  return value;
}

function validateRepairConfiguration(
  repairAttemptLimitValue: unknown,
  unlimitedRepairValue: unknown,
  allowUnconfigured = false
): Pick<ClassTaskSnapshot, 'repairAttemptLimit' | 'unlimitedRepair'> {
  const unlimitedRepair = requireBoolean(unlimitedRepairValue, 'unlimitedRepair');
  if (unlimitedRepair) {
    if (repairAttemptLimitValue !== null) {
      throw new Error('勾选无限制时 repairAttemptLimit 必须为空');
    }
    return { repairAttemptLimit: null, unlimitedRepair: true };
  }
  if (repairAttemptLimitValue === null) {
    if (allowUnconfigured) return { repairAttemptLimit: null, unlimitedRepair: false };
    throw new Error('请填写修复轮次或勾选无限制');
  }
  return {
    repairAttemptLimit: requireInteger(repairAttemptLimitValue, '修复轮次', 1),
    unlimitedRepair: false
  };
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

function requireNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : requireIsoTimestamp(value, label);
}

function assertPathInsideWorkspace(targetPath: string, workspaceRoot: string, message: string): void {
  const targetRelative = relative(resolve(workspaceRoot), resolve(targetPath));
  if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
    throw new Error(message);
  }
}

function normalizedPathKey(value: string): string {
  return resolve(value).toLowerCase();
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function assertContributionsMatchArtifacts(
  artifacts: readonly GeneratedClassTaskArtifact[],
  contributions: readonly CoverageContribution[]
): void {
  const artifactPaths = new Map(
    artifacts.map((artifact) => [artifact.id, normalizedPathKey(artifact.filePath)])
  );
  for (const contribution of contributions) {
    const artifactPath = artifactPaths.get(contribution.artifactId);
    if (artifactPath === undefined) {
      throw new Error('coverageContributions artifactId 无匹配 artifact');
    }
    if (artifactPath !== normalizedPathKey(contribution.filePath)) {
      throw new Error('coverageContributions filePath 与 artifact 不一致');
    }
  }
}

function assertGeneratedMethodsMatchArtifacts(
  artifacts: readonly GeneratedClassTaskArtifact[],
  generatedMethods: readonly ClassTaskResultMethod[]
): void {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const method of generatedMethods) {
    const artifact = artifactsById.get(method.artifactId);
    if (
      !artifact
      || normalizedPathKey(artifact.filePath) !== normalizedPathKey(method.filePath)
      || artifact.testClassName !== method.testClassName
      || !artifact.methodIds.includes(method.methodId)
    ) {
      throw new Error('generatedMethods 未匹配正式测试文件');
    }
  }
}

function sameEntries(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) return false;
  const secondSet = new Set(second);
  return first.every((value) => secondSet.has(value));
}
