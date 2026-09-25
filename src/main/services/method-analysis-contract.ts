import type { GenerationAnalysisInput } from '../../shared/types';

export const METHOD_ANALYSIS_RESPONSE_INVALID = '单方法分析响应无效。';
const METHOD_ANALYSIS_RESPONSE_INVALID_CODE = 'METHOD_ANALYSIS_RESPONSE_INVALID';
export const MAX_SINGLE_METHOD_BATCH_TEST_METHODS = 20_000;

export const METHOD_ID_PATTERN = /^[0-9a-f]{64}$/;
export const REPORT_PAIR_ID_PATTERN = /^[0-9a-f]{64}$/;
export const ANALYSIS_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MethodAnalysisRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MethodAnalysisRequestError';
    this.code = code;
  }
}

export class MethodAnalysisResponseInvalidError extends Error {
  readonly code = METHOD_ANALYSIS_RESPONSE_INVALID_CODE;

  constructor(options?: ErrorOptions) {
    super(METHOD_ANALYSIS_RESPONSE_INVALID, options);
    this.name = 'MethodAnalysisResponseInvalidError';
  }
}

export function isMethodAnalysisResponseInvalidError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === METHOD_ANALYSIS_RESPONSE_INVALID_CODE
    && candidate.message === METHOD_ANALYSIS_RESPONSE_INVALID;
}

export type AnalysisStatus = 'READY' | 'PARTIAL' | 'ANALYSIS_FAILED';
export type CoverageMappingStatus = 'EXACT' | 'UNRELIABLE';
export type TypeOrigin =
  | 'PROJECT_SOURCE'
  | 'PROJECT_GENERATED'
  | 'PROJECT_BINARY'
  | 'JDK'
  | 'BINARY_DEPENDENCY'
  | 'UNRESOLVED';
export type DependencyRole =
  | 'INJECTED_COLLABORATOR'
  | 'REMOTE_CLIENT'
  | 'DATA_OBJECT'
  | 'STATIC_UTILITY'
  | 'INTERNAL_METHOD'
  | 'METHOD_PARAMETER'
  | 'LOCAL_OBJECT';

export type MethodAnalysisWarning = {
  code: string;
  message: string;
};

export type CreateMethodAnalysisSessionRequest = Readonly<
  Omit<GenerationAnalysisInput, 'warnings'> & { analysisSessionId: string }
>;

export type CreateMethodAnalysisSessionResponse = {
  analysisSessionId: string;
  reportPairId: string;
  sourceSha256: string;
  dependencyContextSha256: string;
  packageName: string;
  testClassName: string;
  suggestedRelativeTestPath: string;
  warnings: MethodAnalysisWarning[];
};

export type MethodSummary = {
  methodId: string;
  methodName: string;
  descriptor: string;
  displaySignature: string;
  firstLine: number;
  lastLine: number;
  jacocoOrder: number;
  lineCovered: number;
  lineMissed: number;
  branchCovered: number;
  branchMissed: number;
  instructionCovered: number;
  instructionMissed: number;
  complexityCovered: number;
  complexityMissed: number;
  coverageGap: boolean;
  generatable: boolean;
  unavailableReason: string | null;
  modifiers: string[];
};

export type CoverageTotals = {
  instructionCovered: number;
  instructionMissed: number;
  branchCovered: number;
  branchMissed: number;
  complexityCovered: number;
  complexityMissed: number;
  lineCovered: number;
  lineMissed: number;
};

export type MethodCatalogResponse = {
  analysisSessionId: string;
  reportPairId: string;
  reportCoverageTotals: CoverageTotals;
  methods: MethodSummary[];
  warnings: MethodAnalysisWarning[];
};

export type SingleMethodBatchRequest = {
  reportPairId: string;
  completedTestMethodPlanIds: string[];
  maxTestMethods: number;
};

export type SingleMethodWaveRequest = {
  reportPairId: string;
  completedScenarioIds: string[];
  skippedScenarioIds: string[];
  maxScenarios: 25;
  partSize: 5;
};

export type ClassScenarioWaveRequest = {
  reportPairId: string;
  methods: Array<{
    methodId: string;
    completedScenarioIds: string[];
    skippedScenarioIds: string[];
  }>;
  maxScenarios: 25;
  partSize: 5;
};

export type InvocationPlan = {
  strategy: string;
  receiverExpression: string;
  reflectionMethodName: string;
  parameterClassLiterals: string[];
  staticMethod: boolean;
  returnType: string;
  declaredExceptions: string[];
  chineseInstruction: string;
};

export type DependencyFixture = {
  fixtureId: string;
  receiverExpression: string;
  receiverType: string;
  receiverDeclaration: string;
  typeOrigin: TypeOrigin;
  dependencyRole: DependencyRole;
  preparationMode: string;
  annotations: string[];
  status: AnalysisStatus;
  chineseInstruction: string;
};

export type TargetFixturePlan = {
  targetClass: string;
  targetVariableName: string;
  targetClassDeclaration: string;
  dependencySourceDeclarations: string[];
  constructionMode: string;
  constructorParameterTypes: string[];
  constructorArgumentFixtureIds: string[];
  dependencies: DependencyFixture[];
  setupStatements: string[];
  status: AnalysisStatus;
  chineseInstruction: string;
};

export type StubCall = {
  callSiteId: string;
  entryMethodId: string;
  actualCallOwnerMethodId: string;
  sourceLine: number;
  receiverExpression: string;
  receiverType: string;
  receiverDeclaration: string;
  typeOrigin: TypeOrigin;
  dependencyRole: DependencyRole;
  declaringType: string;
  resolvedSignature: string;
  candidateSignatures: string[];
  argumentExpressions: string[];
  argumentTypes: string[];
  returnType: string;
  declaredExceptions: string[];
  downstreamUse: string;
  mockMode: string;
  required: boolean;
  status: AnalysisStatus;
  uncertaintyReason: string;
  sourceEvidence: string;
};

export type MethodStubInventory = {
  methodId: string;
  status: AnalysisStatus;
  requiredCallCount: number;
  unresolvedRequiredCallCount: number;
  calls: StubCall[];
};

export type LoopCoveragePlan = {
  coverageGroupId: string;
  sourceParameter: string;
  collectionExpression: string;
  itemVariable: string;
  itemSeparator: string;
  mergeScenariosInOneTest: true;
};

export type ConditionExpectation = {
  operandIndex: number;
  expression: string;
  expected: boolean;
};

export type ConditionPathVariant = {
  variantId: string;
  expectations: ConditionExpectation[];
  coverageTargetIds: string[];
};

export type CoverageTarget = {
  targetId: string;
  methodId: string;
  decisionId: string;
  instructionIndex: number;
  sourceLine: number;
  kind: string;
  direction: string;
  covered: boolean;
  mappingStatus: CoverageMappingStatus;
  requiredEdgeIds: string[];
};

export type PathConstraint = {
  constraintKey: string;
  kind: string;
  operator: string;
  values: string[];
  scope: string;
  sequenceIndex: number;
  mappingStatus: CoverageMappingStatus;
  description: string;
};

export type ScenarioPlan = {
  scenarioId: string;
  scenarioSignature: string;
  methodId: string;
  targetLines: number[];
  targetBranches: string[];
  chineseDescription: string;
  inputPreparation: string[];
  requiredStubIds: string[];
  expectedPath: string[];
  loopExitCondition: string;
  loopCoveragePlan: LoopCoveragePlan | null;
  conditionPathVariants: ConditionPathVariant[];
  coverageTargetIds: string[];
  pathConstraints: PathConstraint[];
  status: AnalysisStatus;
};

export type StubPlan = {
  stubId: string;
  callSiteId: string;
  methodId: string;
  actualCallOwnerMethodId: string;
  scenarioId: string;
  conditionPathVariantId: string;
  resolvedSignature: string;
  argumentMatchers: string[];
  action: string;
  returnOrExceptionSequence: string[];
  downstreamBranchBinding: string;
  invocationCount: number;
  mockMode: string;
  suggestedJava: string;
  compactMock?: string;
  status: AnalysisStatus;
};

export type SingleMethodGenerationPacket = {
  methodId: string;
  declaringType: string;
  methodName: string;
  descriptor: string;
  firstLine: number;
  lastLine: number;
  completeMethodSource: string;
  coverageAnnotatedMethodSource?: string | null;
  modifiers: string[];
  parameterTypes: string[];
  returnType: string;
  declaredExceptions: string[];
  invocationPlan: InvocationPlan;
  activeScenarioIds: string[];
};

export type TestPathGroup = {
  groupId: string;
  methodId: string;
  ordinal: number;
  scenarioIds: string[];
  targetIds: string[];
  constraints: PathConstraint[];
  inputRequirements: string[];
  mockRequirements: string[];
  expectedExit: string;
  singleTargetInvocation: true;
  status: AnalysisStatus;
  conditionPathVariantIds?: Record<string, string>;
};

export type TestMethodPlan = {
  testMethodPlanId: string;
  methodId: string;
  ordinal: number;
  pathGroupIds: string[];
  status: AnalysisStatus;
};

export type MethodTestPlan = {
  methodId: string;
  analysisStatus: AnalysisStatus;
  minimumTestCount: number;
  remainingTargets: CoverageTarget[];
  testPathGroups: TestPathGroup[];
  testMethodPlans: TestMethodPlan[];
  fallbackReason: string;
};

export type ReferencedMethodContractApi = {
  signature: string;
  documentation: string;
};

export type ReferencedTypeApi = {
  qualifiedName: string;
  kind: 'CLASS' | 'INTERFACE' | 'ENUM' | 'RECORD';
  constructors: string[];
  methods: string[];
  enumConstants: string[];
  methodContracts?: ReferencedMethodContractApi[];
};
type SingleMethodBatchCommon = {
  reportPairId: string;
  methodId: string;
  warnings: MethodAnalysisWarning[];
};

export type SingleMethodWorkBatch = SingleMethodBatchCommon & {
  batchId: string;
  hasWork: true;
  method: SingleMethodGenerationPacket;
  scenarios: ScenarioPlan[];
  methodTestPlan: MethodTestPlan;
  methodStubInventory: MethodStubInventory;
  activeStubPlans: StubPlan[];
  targetFixturePlan: TargetFixturePlan;
  referencedTypes: ReferencedTypeApi[];
  necessaryImports: string[];
  plannedTestMethods: number;
  remainingTestMethods: number;
};

export type SingleMethodNoWorkBatch = SingleMethodBatchCommon & {
  batchId: null;
  hasWork: false;
  method: null;
  scenarios: [];
  methodTestPlan: null;
  methodStubInventory: null;
  activeStubPlans: [];
  targetFixturePlan: null;
  referencedTypes: [];
  necessaryImports: [];
  plannedTestMethods: 0;
  remainingTestMethods: 0;
};

export type SingleMethodBatchResponse =
  | SingleMethodWorkBatch
  | SingleMethodNoWorkBatch;

export type SingleMethodWorkPart = {
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  method: SingleMethodGenerationPacket;
  scenarios: ScenarioPlan[];
  methodTestPlan: MethodTestPlan;
  methodStubInventory: MethodStubInventory;
  activeStubPlans: StubPlan[];
  targetFixturePlan: TargetFixturePlan;
  referencedTypes: ReferencedTypeApi[];
  necessaryImports: string[];
};

type SingleMethodWaveCommon = {
  reportPairId: string;
  methodId: string;
  remainingScenarioCount: number;
  warnings: MethodAnalysisWarning[];
};

export type SingleMethodWorkWave = SingleMethodWaveCommon & {
  waveBatchId: string;
  hasWork: true;
  selectedScenarioIds: string[];
  parts: SingleMethodWorkPart[];
};

export type SingleMethodNoWorkWave = SingleMethodWaveCommon & {
  waveBatchId: null;
  hasWork: false;
  selectedScenarioIds: [];
  remainingScenarioCount: 0;
  parts: [];
};

export type SingleMethodWaveResponse =
  | SingleMethodWorkWave
  | SingleMethodNoWorkWave;

export type ClassScenarioMethodSlice = {
  methodId: string;
  testMethodNamePrefix: string;
  batch: SingleMethodWorkPart;
};

export type ClassScenarioWorkPart = SingleMethodWorkPart & {
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  methodSlices: ClassScenarioMethodSlice[];
};

type ClassScenarioWaveCommon = {
  reportPairId: string;
  remainingScenarioCountByMethod: Record<string, number>;
  completedMethodIds: string[];
  warnings: MethodAnalysisWarning[];
};

export type ClassScenarioWorkWave = ClassScenarioWaveCommon & {
  waveBatchId: string;
  methodId: string;
  remainingScenarioCount: number;
  hasWork: true;
  selectedMethodIds: string[];
  selectedScenarioIds: string[];
  parts: ClassScenarioWorkPart[];
};

export type ClassScenarioNoWorkWave = ClassScenarioWaveCommon & {
  waveBatchId: null;
  methodId: string;
  remainingScenarioCount: 0;
  hasWork: false;
  selectedMethodIds: [];
  selectedScenarioIds: [];
  parts: [];
};

export type ClassScenarioWaveResponse = ClassScenarioWorkWave | ClassScenarioNoWorkWave;

export type RefreshMethodAnalysisCoverageRequest = {
  reportPath: string;
  branchSnapshotPath: string;
  reportPairId: string;
};

export type ExactCoverageCounts = {
  lineCovered: number;
  lineMissed: number;
  lineTotal: number;
  branchCovered: number;
  branchMissed: number;
  branchTotal: number;
};

export type RefreshMethodAnalysisCoverageResponse = {
  reportPairId: string;
  coverage: ExactCoverageCounts;
  catalog: MethodCatalogResponse;
};

export type MethodRepairStackFrame = {
  ownerFqn: string;
  methodName: string;
  descriptor: string | null;
  sourceLine: number;
};

export type MethodRepairContextRequest = {
  reportPairId: string;
  methodId: string;
  currentClassFrames: MethodRepairStackFrame[];
  relatedTypeFqns: string[];
  missingSymbols: string[];
};

export type RepairMethodSource = {
  methodId: string;
  declaringType: string;
  methodName: string;
  descriptor: string;
  modifiers: string[];
  firstLine: number;
  lastLine: number;
  sourceFirstLine: number;
  sourceLastLine: number;
  sourceText: string;
  sourceComplete: boolean;
  parameterTypes: string[];
  returnType: string;
  declaredExceptions: string[];
};

export type MethodRepairContextResponse = {
  reportPairId: string;
  sourceSha256: string;
  targetMethod: RepairMethodSource;
  stackMethods: RepairMethodSource[];
  referencedTypes: ReferencedTypeApi[];
  warnings: MethodAnalysisWarning[];
  truncated: boolean;
};

type UnknownRecord = Record<string, unknown>;

const ANALYSIS_STATUSES = new Set<AnalysisStatus>([
  'READY', 'PARTIAL', 'ANALYSIS_FAILED'
]);
const MAPPING_STATUSES = new Set<CoverageMappingStatus>(['EXACT', 'UNRELIABLE']);
const TYPE_ORIGINS = new Set<TypeOrigin>([
  'PROJECT_SOURCE', 'PROJECT_GENERATED', 'PROJECT_BINARY', 'JDK',
  'BINARY_DEPENDENCY', 'UNRESOLVED'
]);
const DEPENDENCY_ROLES = new Set<DependencyRole>([
  'INJECTED_COLLABORATOR', 'REMOTE_CLIENT', 'DATA_OBJECT', 'STATIC_UTILITY',
  'INTERNAL_METHOD', 'METHOD_PARAMETER', 'LOCAL_OBJECT'
]);

function invalid(): never {
  throw new Error(METHOD_ANALYSIS_RESPONSE_INVALID);
}

function invalidResponse(cause?: unknown): never {
  throw new MethodAnalysisResponseInvalidError({ cause });
}

function record(value: unknown, keys: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as UnknownRecord;
  const actual = Object.keys(candidate);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid();
  }
  return candidate;
}

function array(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function text(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function nullableText(value: unknown, maximum: number): string | null {
  return value === null || value === '' ? null : text(value, maximum);
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid();
  }
  return value as number;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function member<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) invalid();
  return value as T;
}

function uuid(value: unknown): string {
  const result = text(value, 64);
  if (!ANALYSIS_SESSION_ID_PATTERN.test(result)) invalid();
  return result;
}

function sha256(value: unknown): string {
  const result = text(value, 64);
  if (!METHOD_ID_PATTERN.test(result)) invalid();
  return result;
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
  minimumItems = 0,
  minimumLength = 0
): string[] {
  return array(value, maximumItems, minimumItems).map((item) =>
    text(item, maximumLength, minimumLength));
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function warning(value: unknown): MethodAnalysisWarning {
  const item = record(value, ['code', 'message']);
  return { code: text(item.code, 256), message: text(item.message, 2_000) };
}

function warnings(value: unknown): MethodAnalysisWarning[] {
  return array(value, 20).map(warning);
}

function status(value: unknown): AnalysisStatus {
  return member(value, ANALYSIS_STATUSES);
}

function mappingStatus(value: unknown): CoverageMappingStatus {
  return member(value, MAPPING_STATUSES);
}

function validatePathConstraint(value: unknown): PathConstraint {
  const item = record(value, [
    'constraintKey', 'kind', 'operator', 'values', 'scope', 'sequenceIndex',
    'mappingStatus', 'description'
  ]);
  text(item.constraintKey, 2_000);
  text(item.kind, 128);
  text(item.operator, 128);
  stringArray(item.values, 1_000, 8_000);
  text(item.scope, 128);
  integer(item.sequenceIndex, -1);
  mappingStatus(item.mappingStatus);
  text(item.description, 8_000);
  return item as PathConstraint;
}

function validateCoverageTarget(value: unknown, methodId: string): CoverageTarget {
  const item = record(value, [
    'targetId', 'methodId', 'decisionId', 'instructionIndex', 'sourceLine',
    'kind', 'direction', 'covered', 'mappingStatus', 'requiredEdgeIds'
  ]);
  text(item.targetId, 1_024);
  if (sha256(item.methodId) !== methodId) invalid();
  text(item.decisionId, 1_024, 0);
  integer(item.instructionIndex, -1);
  integer(item.sourceLine, -1);
  text(item.kind, 128);
  text(item.direction, 8_000);
  if (bool(item.covered)) invalid();
  mappingStatus(item.mappingStatus);
  const edgeIds = stringArray(item.requiredEdgeIds, 4_000, 1_024);
  unique(edgeIds);
  return item as CoverageTarget;
}

function validateLoopCoveragePlan(value: unknown): LoopCoveragePlan {
  const item = record(value, [
    'coverageGroupId', 'sourceParameter', 'collectionExpression', 'itemVariable',
    'itemSeparator', 'mergeScenariosInOneTest'
  ]);
  text(item.coverageGroupId, 1_024);
  text(item.sourceParameter, 1_024);
  text(item.collectionExpression, 8_000);
  text(item.itemVariable, 1_024);
  text(item.itemSeparator, 1_024, 0);
  if (item.mergeScenariosInOneTest !== true) invalid();
  return item as LoopCoveragePlan;
}

function validateConditionExpectation(value: unknown): ConditionExpectation {
  const item = record(value, ['operandIndex', 'expression', 'expected']);
  integer(item.operandIndex, 0);
  text(item.expression, 8_000);
  bool(item.expected);
  return item as ConditionExpectation;
}

function validateConditionPathVariant(value: unknown): ConditionPathVariant {
  const item = record(value, ['variantId', 'expectations', 'coverageTargetIds']);
  text(item.variantId, 1_024);
  const expectations = array(item.expectations, 20_000)
    .map(validateConditionExpectation);
  if (expectations.length === 0) invalid();
  unique(expectations.map((expectation) => String(expectation.operandIndex)));
  const targetIds = stringArray(item.coverageTargetIds, 20_000, 1_024);
  unique(targetIds);
  return item as ConditionPathVariant;
}

function validateScenario(value: unknown, methodId: string): ScenarioPlan {
  const item = record(value, [
    'scenarioId', 'scenarioSignature', 'methodId', 'targetLines', 'targetBranches',
    'chineseDescription', 'inputPreparation', 'requiredStubIds', 'expectedPath',
    'loopExitCondition', 'loopCoveragePlan', 'conditionPathVariants',
    'coverageTargetIds', 'pathConstraints', 'status'
  ]);
  text(item.scenarioId, 1_024);
  text(item.scenarioSignature, 4_000);
  if (sha256(item.methodId) !== methodId) invalid();
  array(item.targetLines, 20_000).forEach((line) => integer(line, 0));
  stringArray(item.targetBranches, 20_000, 8_000);
  text(item.chineseDescription, 8_000);
  stringArray(item.inputPreparation, 1_000, 8_000);
  stringArray(item.requiredStubIds, 2_000, 1_024);
  stringArray(item.expectedPath, 2_000, 8_000);
  text(item.loopExitCondition, 8_000, 0);
  if (item.loopCoveragePlan !== null) validateLoopCoveragePlan(item.loopCoveragePlan);
  const conditionPathVariants = array(item.conditionPathVariants, 20_000)
    .map(validateConditionPathVariant);
  unique(conditionPathVariants.map((variant) => variant.variantId));
  const targetIds = stringArray(item.coverageTargetIds, 20_000, 1_024);
  unique(targetIds);
  array(item.pathConstraints, 20_000).forEach(validatePathConstraint);
  status(item.status);
  return item as ScenarioPlan;
}

function validateInvocationPlan(value: unknown): InvocationPlan {
  const item = record(value, [
    'strategy', 'receiverExpression', 'reflectionMethodName',
    'parameterClassLiterals', 'staticMethod', 'returnType', 'declaredExceptions',
    'chineseInstruction'
  ]);
  text(item.strategy, 128);
  text(item.receiverExpression, 2_000);
  text(item.reflectionMethodName, 1_024, 0);
  stringArray(item.parameterClassLiterals, 256, 2_000);
  bool(item.staticMethod);
  text(item.returnType, 2_000);
  stringArray(item.declaredExceptions, 256, 2_000);
  text(item.chineseInstruction, 8_000);
  return item as InvocationPlan;
}

function validateMethodPacket(value: unknown, methodId: string): SingleMethodGenerationPacket {
  const item = record(value, [
    'methodId', 'declaringType', 'methodName', 'descriptor', 'firstLine', 'lastLine',
    'completeMethodSource', 'modifiers', 'parameterTypes', 'returnType',
    'declaredExceptions', 'invocationPlan', 'activeScenarioIds',
    ...(value && typeof value === 'object' && 'coverageAnnotatedMethodSource' in value
      ? ['coverageAnnotatedMethodSource'] : [])
  ]);
  if (sha256(item.methodId) !== methodId) invalid();
  text(item.declaringType, 2_000);
  text(item.methodName, 1_024);
  text(item.descriptor, 2_000);
  const firstLine = integer(item.firstLine, 0);
  if (integer(item.lastLine, 0) < firstLine) invalid();
  text(item.completeMethodSource, 1_000_000);
  if (item.coverageAnnotatedMethodSource !== undefined
    && item.coverageAnnotatedMethodSource !== null) {
    text(item.coverageAnnotatedMethodSource, 2_000_000);
  }
  stringArray(item.modifiers, 256, 128);
  stringArray(item.parameterTypes, 256, 2_000);
  text(item.returnType, 2_000);
  stringArray(item.declaredExceptions, 256, 2_000);
  validateInvocationPlan(item.invocationPlan);
  const activeScenarioIds = stringArray(item.activeScenarioIds, 20_000, 1_024);
  unique(activeScenarioIds);
  return item as SingleMethodGenerationPacket;
}

function validateTestPathGroup(value: unknown, methodId: string): TestPathGroup {
  const item = record(value, [
    'groupId', 'methodId', 'ordinal', 'scenarioIds', 'targetIds', 'constraints',
    'inputRequirements', 'mockRequirements', 'expectedExit',
    'singleTargetInvocation', 'status',
    ...(value && typeof value === 'object' && 'conditionPathVariantIds' in value
      ? ['conditionPathVariantIds'] : [])
  ]);
  text(item.groupId, 1_024);
  if (sha256(item.methodId) !== methodId) invalid();
  integer(item.ordinal, 1, 20_000);
  const scenarioIds = stringArray(item.scenarioIds, 20_000, 1_024);
  const targetIds = stringArray(item.targetIds, 20_000, 1_024, 1);
  unique(scenarioIds);
  unique(targetIds);
  if (item.conditionPathVariantIds !== undefined) {
    const selected = item.conditionPathVariantIds;
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) invalid();
    const entries = Object.entries(selected);
    if (entries.length > 20_000) invalid();
    for (const [scenarioId, variantId] of entries) {
      if (!scenarioIds.includes(scenarioId)) invalid();
      text(variantId, 1_024);
    }
  }
  array(item.constraints, 20_000).forEach(validatePathConstraint);
  stringArray(item.inputRequirements, 20_000, 8_000);
  stringArray(item.mockRequirements, 20_000, 8_000);
  text(item.expectedExit, 128);
  if (item.singleTargetInvocation !== true) invalid();
  status(item.status);
  return item as TestPathGroup;
}

function validateTestMethodPlan(value: unknown, methodId: string): TestMethodPlan {
  const item = record(value, [
    'testMethodPlanId', 'methodId', 'ordinal', 'pathGroupIds', 'status'
  ]);
  text(item.testMethodPlanId, 1_024);
  if (sha256(item.methodId) !== methodId) invalid();
  integer(item.ordinal, 1, MAX_SINGLE_METHOD_BATCH_TEST_METHODS);
  const groupIds = stringArray(item.pathGroupIds, 3, 1_024, 1);
  unique(groupIds);
  status(item.status);
  return item as TestMethodPlan;
}

function validateMethodTestPlan(value: unknown, methodId: string): MethodTestPlan {
  const item = record(value, [
    'methodId', 'analysisStatus', 'minimumTestCount', 'remainingTargets',
    'testPathGroups', 'testMethodPlans', 'fallbackReason'
  ]);
  if (sha256(item.methodId) !== methodId) invalid();
  const analysisStatus = status(item.analysisStatus);
  const minimumTestCount = integer(
    item.minimumTestCount,
    0,
    MAX_SINGLE_METHOD_BATCH_TEST_METHODS
  );
  const fallbackReason = text(item.fallbackReason, 8_000, 0);
  const remainingTargets = array(item.remainingTargets, 20_000).map((target) =>
    validateCoverageTarget(target, methodId));
  const targetIds = remainingTargets.map((target) => target.targetId);
  unique(targetIds);
  const targetSet = new Set(targetIds);
  const groups = array(item.testPathGroups, 20_000).map((group) =>
    validateTestPathGroup(group, methodId));
  const groupIds = groups.map((group) => group.groupId);
  unique(groupIds);
  if (groups.some((group, index) => group.ordinal !== index + 1
    || group.targetIds.some((id) => !targetSet.has(id)))) invalid();
  const groupedTargetIds = new Set(groups.flatMap((group) => group.targetIds));
  const unresolvedTargetsAllowed = analysisStatus === 'PARTIAL'
    && fallbackReason.length > 0;
  if (!unresolvedTargetsAllowed && groupedTargetIds.size !== targetSet.size) invalid();
  const plans = array(item.testMethodPlans, MAX_SINGLE_METHOD_BATCH_TEST_METHODS).map((plan) =>
    validateTestMethodPlan(plan, methodId));
  const planIds = plans.map((plan) => plan.testMethodPlanId);
  unique(planIds);
  if (plans.length !== minimumTestCount
    || plans.some((plan, index) => plan.ordinal !== index + 1)) invalid();
  const groupById = new Map(groups.map((group) => [group.groupId, group]));
  const assigned = plans.flatMap((plan) => plan.pathGroupIds);
  unique(assigned);
  if (assigned.length !== groups.length
    || assigned.some((id) => !groupById.has(id))
    || plans.some((plan) => plan.pathGroupIds.length > 1
      && plan.pathGroupIds.some((id) => groupById.get(id)?.expectedExit.startsWith('THROWS')))) {
    invalid();
  }
  return item as MethodTestPlan;
}

function validateStubCall(value: unknown, methodId: string): StubCall {
  const item = record(value, [
    'callSiteId', 'entryMethodId', 'actualCallOwnerMethodId', 'sourceLine',
    'receiverExpression', 'receiverType', 'receiverDeclaration', 'typeOrigin',
    'dependencyRole', 'declaringType', 'resolvedSignature', 'candidateSignatures',
    'argumentExpressions', 'argumentTypes', 'returnType', 'declaredExceptions',
    'downstreamUse', 'mockMode', 'required', 'status', 'uncertaintyReason',
    'sourceEvidence'
  ]);
  text(item.callSiteId, 1_024);
  if (sha256(item.entryMethodId) !== methodId) invalid();
  text(item.actualCallOwnerMethodId, 2_000);
  integer(item.sourceLine, 0);
  text(item.receiverExpression, 2_000);
  text(item.receiverType, 2_000);
  text(item.receiverDeclaration, 8_000, 0);
  member(item.typeOrigin, TYPE_ORIGINS);
  member(item.dependencyRole, DEPENDENCY_ROLES);
  text(item.declaringType, 2_000);
  text(item.resolvedSignature, 4_000, 0);
  stringArray(item.candidateSignatures, 256, 4_000);
  stringArray(item.argumentExpressions, 256, 8_000);
  stringArray(item.argumentTypes, 256, 2_000);
  text(item.returnType, 2_000);
  stringArray(item.declaredExceptions, 256, 2_000);
  text(item.downstreamUse, 8_000, 0);
  text(item.mockMode, 128);
  bool(item.required);
  status(item.status);
  text(item.uncertaintyReason, 8_000, 0);
  text(item.sourceEvidence, 8_000);
  return item as StubCall;
}

function validateStubInventory(value: unknown, methodId: string): MethodStubInventory {
  const item = record(value, [
    'methodId', 'status', 'requiredCallCount', 'unresolvedRequiredCallCount', 'calls'
  ]);
  if (sha256(item.methodId) !== methodId) invalid();
  status(item.status);
  const required = integer(item.requiredCallCount, 0);
  if (integer(item.unresolvedRequiredCallCount, 0) > required) invalid();
  const calls = array(item.calls, 2_000).map((call) => validateStubCall(call, methodId));
  unique(calls.map((call) => call.callSiteId));
  return item as MethodStubInventory;
}

function validateStubPlan(value: unknown, methodId: string): StubPlan {
  const hasCompactMock = value !== null && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'compactMock');
  const item = record(value, [
    'stubId', 'callSiteId', 'methodId', 'actualCallOwnerMethodId', 'scenarioId',
    'conditionPathVariantId', 'resolvedSignature', 'argumentMatchers', 'action',
    'returnOrExceptionSequence', 'downstreamBranchBinding', 'invocationCount',
    'mockMode', 'suggestedJava', 'status', ...(hasCompactMock ? ['compactMock'] : [])
  ]);
  text(item.stubId, 1_024);
  text(item.callSiteId, 1_024);
  if (sha256(item.methodId) !== methodId) invalid();
  text(item.actualCallOwnerMethodId, 2_000);
  text(item.scenarioId, 1_024);
  text(item.conditionPathVariantId, 1_024, 0);
  text(item.resolvedSignature, 4_000);
  stringArray(item.argumentMatchers, 256, 8_000);
  text(item.action, 128);
  stringArray(item.returnOrExceptionSequence, 256, 20_000);
  text(item.downstreamBranchBinding, 8_000, 0);
  integer(item.invocationCount, 0);
  text(item.mockMode, 128);
  text(item.suggestedJava, 20_000);
  if (hasCompactMock) text(item.compactMock, 20_000, 0);
  status(item.status);
  return item as StubPlan;
}

function validateDependencyFixture(value: unknown): DependencyFixture {
  const item = record(value, [
    'fixtureId', 'receiverExpression', 'receiverType', 'receiverDeclaration',
    'typeOrigin', 'dependencyRole', 'preparationMode', 'annotations', 'status',
    'chineseInstruction'
  ]);
  text(item.fixtureId, 1_024);
  text(item.receiverExpression, 2_000);
  text(item.receiverType, 2_000);
  text(item.receiverDeclaration, 8_000, 0);
  member(item.typeOrigin, TYPE_ORIGINS);
  member(item.dependencyRole, DEPENDENCY_ROLES);
  text(item.preparationMode, 128);
  stringArray(item.annotations, 256, 8_000);
  status(item.status);
  text(item.chineseInstruction, 8_000);
  return item as DependencyFixture;
}

function validateFixturePlan(value: unknown): TargetFixturePlan {
  const item = record(value, [
    'targetClass', 'targetVariableName', 'targetClassDeclaration',
    'dependencySourceDeclarations', 'constructionMode', 'constructorParameterTypes',
    'constructorArgumentFixtureIds', 'dependencies', 'setupStatements', 'status',
    'chineseInstruction'
  ]);
  text(item.targetClass, 2_000);
  text(item.targetVariableName, 1_024);
  text(item.targetClassDeclaration, 20_000);
  stringArray(item.dependencySourceDeclarations, 1_000, 20_000);
  text(item.constructionMode, 128);
  stringArray(item.constructorParameterTypes, 256, 2_000);
  stringArray(item.constructorArgumentFixtureIds, 256, 1_024);
  const dependencies = array(item.dependencies, 1_000).map(validateDependencyFixture);
  unique(dependencies.map((dependency) => dependency.fixtureId));
  stringArray(item.setupStatements, 1_000, 20_000);
  status(item.status);
  text(item.chineseInstruction, 8_000);
  return item as TargetFixturePlan;
}

function validateReferencedType(value: unknown): ReferencedTypeApi {
  const hasMethodContracts = value !== null && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'methodContracts');
  const item = record(value, [
    'qualifiedName', 'kind', 'constructors', 'methods', 'enumConstants',
    ...(hasMethodContracts ? ['methodContracts'] : [])
  ]);
  text(item.qualifiedName, 2_000);
  member(item.kind, new Set<ReferencedTypeApi['kind']>([
    'CLASS', 'INTERFACE', 'ENUM', 'RECORD'
  ]));
  stringArray(item.constructors, 256, 4_000);
  const methods = stringArray(item.methods, 256, 4_000);
  stringArray(item.enumConstants, 256, 1_024);
  if (hasMethodContracts) {
    let documentationLength = 0;
    const contracts = array(item.methodContracts, Math.min(16, methods.length));
    const signatures = contracts.map((value) => {
      const contract = record(value, ['signature', 'documentation']);
      const signature = text(contract.signature, 4_000);
      documentationLength += text(contract.documentation, 1_600).length;
      if (!methods.includes(signature)) invalid();
      return signature;
    });
    if (documentationLength > 8_000) invalid();
    unique(signatures);
  }
  return item as ReferencedTypeApi;
}
function validateMethodSummary(value: unknown, expectedOrder: number): MethodSummary {
  const item = record(value, [
    'methodId', 'methodName', 'descriptor', 'displaySignature', 'firstLine',
    'lastLine', 'jacocoOrder', 'lineCovered', 'lineMissed', 'branchCovered',
    'branchMissed', 'instructionCovered', 'instructionMissed', 'complexityCovered',
    'complexityMissed', 'coverageGap', 'generatable', 'unavailableReason', 'modifiers'
  ]);
  sha256(item.methodId);
  text(item.methodName, 1_024);
  text(item.descriptor, 2_000);
  text(item.displaySignature, 4_000);
  const firstLine = integer(item.firstLine, 0);
  if (integer(item.lastLine, 0) < firstLine || integer(item.jacocoOrder, 0) !== expectedOrder) {
    invalid();
  }
  integer(item.lineCovered, 0);
  integer(item.lineMissed, 0);
  integer(item.branchCovered, 0);
  integer(item.branchMissed, 0);
  integer(item.instructionCovered, 0);
  integer(item.instructionMissed, 0);
  integer(item.complexityCovered, 0);
  integer(item.complexityMissed, 0);
  bool(item.coverageGap);
  const generatable = bool(item.generatable);
  const unavailableReason = nullableText(item.unavailableReason, 2_000);
  if (generatable === (unavailableReason !== null)) invalid();
  stringArray(item.modifiers, 256, 128);
  return { ...item, unavailableReason } as MethodSummary;
}

function validateCoverageTotals(value: unknown): CoverageTotals {
  const item = record(value, [
    'instructionCovered', 'instructionMissed', 'branchCovered', 'branchMissed',
    'complexityCovered', 'complexityMissed', 'lineCovered', 'lineMissed'
  ]);
  integer(item.instructionCovered, 0);
  integer(item.instructionMissed, 0);
  integer(item.branchCovered, 0);
  integer(item.branchMissed, 0);
  integer(item.complexityCovered, 0);
  integer(item.complexityMissed, 0);
  integer(item.lineCovered, 0);
  integer(item.lineMissed, 0);
  return item as CoverageTotals;
}

function decodeCatalog(
  value: unknown,
  expectedSessionId: string,
  expectedReportPairId?: string
): MethodCatalogResponse {
  const item = record(value, [
    'analysisSessionId', 'reportPairId', 'reportCoverageTotals', 'methods', 'warnings'
  ]);
  if (uuid(item.analysisSessionId) !== expectedSessionId) invalid();
  const reportPairId = sha256(item.reportPairId);
  if (expectedReportPairId && reportPairId !== expectedReportPairId) invalid();
  const reportCoverageTotals = validateCoverageTotals(item.reportCoverageTotals);
  const methods = array(item.methods, 5_000).map(validateMethodSummary);
  unique(methods.map((method) => method.methodId));
  warnings(item.warnings);
  return { ...item, reportCoverageTotals, methods } as MethodCatalogResponse;
}

export function decodeCreateMethodAnalysisSessionResponse(
  value: unknown,
  request: CreateMethodAnalysisSessionRequest
): CreateMethodAnalysisSessionResponse {
  try {
    const item = record(value, [
      'analysisSessionId', 'reportPairId', 'sourceSha256', 'dependencyContextSha256',
      'packageName', 'testClassName', 'suggestedRelativeTestPath', 'warnings'
    ]);
    if (uuid(item.analysisSessionId) !== request.analysisSessionId
      || sha256(item.reportPairId) !== request.reportPairId) invalid();
    sha256(item.sourceSha256);
    sha256(item.dependencyContextSha256);
    const packageName = text(item.packageName, 512, 0);
    const testClassName = text(item.testClassName, 512);
    const suggestedRelativeTestPath = text(item.suggestedRelativeTestPath, 4_096);
    return {
      analysisSessionId: request.analysisSessionId,
      reportPairId: request.reportPairId,
      sourceSha256: item.sourceSha256 as string,
      dependencyContextSha256: item.dependencyContextSha256 as string,
      packageName,
      testClassName,
      suggestedRelativeTestPath,
      warnings: warnings(item.warnings)
    };
  } catch (error) {
    invalidResponse(error);
  }
}

export function decodeMethodCatalogResponse(
  value: unknown,
  expectedSessionId: string
): MethodCatalogResponse {
  try {
    return decodeCatalog(value, expectedSessionId);
  } catch (error) {
    invalidResponse(error);
  }
}

export function decodeSingleMethodBatchResponse(
  value: unknown,
  expected: {
    sessionId: string;
    methodId: string;
    reportPairId: string;
    maxTestMethods: number;
  }
): SingleMethodBatchResponse {
  try {
    uuid(expected.sessionId);
    const item = record(value, [
      'batchId', 'reportPairId', 'methodId', 'hasWork', 'method', 'scenarios',
      'methodTestPlan', 'methodStubInventory', 'activeStubPlans',
      'targetFixturePlan', 'referencedTypes', 'necessaryImports',
      'plannedTestMethods', 'remainingTestMethods', 'warnings'
    ]);
    if (sha256(item.reportPairId) !== expected.reportPairId
      || sha256(item.methodId) !== expected.methodId) invalid();
    warnings(item.warnings);
    if (item.hasWork === false) {
      if (item.batchId !== null || item.method !== null
        || array(item.scenarios, 0).length !== 0 || item.methodTestPlan !== null
        || item.methodStubInventory !== null || array(item.activeStubPlans, 0).length !== 0
        || item.targetFixturePlan !== null || array(item.referencedTypes, 0).length !== 0
        || array(item.necessaryImports, 0).length !== 0
        || item.plannedTestMethods !== 0 || item.remainingTestMethods !== 0) invalid();
      return item as SingleMethodNoWorkBatch;
    }
    if (item.hasWork !== true) invalid();
    sha256(item.batchId);
    const method = validateMethodPacket(item.method, expected.methodId);
    const scenarios = array(item.scenarios, 20_000).map((scenario) =>
      validateScenario(scenario, expected.methodId));
    const scenarioIds = scenarios.map((scenario) => scenario.scenarioId);
    unique(scenarioIds);
    if (new Set(method.activeScenarioIds).size !== scenarioIds.length
      || method.activeScenarioIds.some((id) => !scenarioIds.includes(id))) invalid();
    const methodTestPlan = validateMethodTestPlan(item.methodTestPlan, expected.methodId);
    if (methodTestPlan.testPathGroups.some((group) =>
      group.scenarioIds.some((id) => !scenarioIds.includes(id)))) invalid();
    validateStubInventory(item.methodStubInventory, expected.methodId);
    const stubPlans = array(item.activeStubPlans, 20_000).map((plan) =>
      validateStubPlan(plan, expected.methodId));
    if (stubPlans.some((plan) => !scenarioIds.includes(plan.scenarioId))) invalid();
    validateFixturePlan(item.targetFixturePlan);
    array(item.referencedTypes, 20_000).forEach(validateReferencedType);
    stringArray(item.necessaryImports, 20_000, 4_000);
    const planned = integer(
      item.plannedTestMethods,
      1,
      MAX_SINGLE_METHOD_BATCH_TEST_METHODS
    );
    if (planned > expected.maxTestMethods
      || planned !== methodTestPlan.minimumTestCount
      || planned !== methodTestPlan.testMethodPlans.length) invalid();
    integer(item.remainingTestMethods, 0);
    return item as SingleMethodWorkBatch;
  } catch (error) {
    invalidResponse(error);
  }
}

function validateSingleMethodWavePart(
  value: unknown,
  expectedMethodId: string,
  expectedPartIndex: number
): SingleMethodWorkPart {
  const item = record(value, [
    'partIndex', 'partBatchId', 'scenarioIds', 'method', 'scenarios',
    'methodTestPlan', 'methodStubInventory', 'activeStubPlans',
    'targetFixturePlan', 'referencedTypes', 'necessaryImports'
  ]);
  if (integer(item.partIndex, 1, 5) !== expectedPartIndex) invalid();
  sha256(item.partBatchId);
  const scenarioIds = stringArray(item.scenarioIds, 5, 1_024, 1, 1);
  unique(scenarioIds);
  const method = validateMethodPacket(item.method, expectedMethodId);
  const scenarios = array(item.scenarios, 5, 1).map((scenario) =>
    validateScenario(scenario, expectedMethodId));
  const suppliedScenarioIds = scenarios.map((scenario) => scenario.scenarioId);
  if (scenarioIds.some((id, index) => suppliedScenarioIds[index] !== id)
    || method.activeScenarioIds.some((id, index) => scenarioIds[index] !== id)
    || method.activeScenarioIds.length !== scenarioIds.length) invalid();
  const methodTestPlan = validateMethodTestPlan(item.methodTestPlan, expectedMethodId);
  const plannedScenarios = methodTestPlan.testPathGroups.flatMap((group) => group.scenarioIds);
  if (plannedScenarios.some((id) => !scenarioIds.includes(id))
    || new Set(plannedScenarios).size !== scenarioIds.length
    || scenarioIds.some((id) => !plannedScenarios.includes(id))) invalid();
  const methodStubInventory = validateStubInventory(
    item.methodStubInventory,
    expectedMethodId
  );
  const activeStubPlans = array(item.activeStubPlans, 20_000).map((plan) =>
    validateStubPlan(plan, expectedMethodId));
  if (activeStubPlans.some((plan) => !scenarioIds.includes(plan.scenarioId))) invalid();
  const targetFixturePlan = validateFixturePlan(item.targetFixturePlan);
  const referencedTypes = array(item.referencedTypes, 20_000).map(validateReferencedType);
  const necessaryImports = stringArray(item.necessaryImports, 20_000, 4_000);
  return {
    partIndex: expectedPartIndex,
    partBatchId: item.partBatchId as string,
    scenarioIds,
    method,
    scenarios,
    methodTestPlan,
    methodStubInventory,
    activeStubPlans,
    targetFixturePlan,
    referencedTypes,
    necessaryImports
  };
}

export function decodeSingleMethodWaveResponse(
  value: unknown,
  expected: {
    sessionId: string;
    methodId: string;
    reportPairId: string;
  }
): SingleMethodWaveResponse {
  try {
    uuid(expected.sessionId);
    const item = record(value, [
      'waveBatchId', 'reportPairId', 'methodId', 'hasWork',
      'selectedScenarioIds', 'remainingScenarioCount', 'parts', 'warnings'
    ]);
    if (sha256(item.reportPairId) !== expected.reportPairId
      || sha256(item.methodId) !== expected.methodId) invalid();
    const decodedWarnings = warnings(item.warnings);
    if (item.hasWork === false) {
      if (item.waveBatchId !== null
        || array(item.selectedScenarioIds, 0).length !== 0
        || integer(item.remainingScenarioCount, 0) !== 0
        || array(item.parts, 0).length !== 0) invalid();
      return {
        waveBatchId: null,
        reportPairId: expected.reportPairId,
        methodId: expected.methodId,
        hasWork: false,
        selectedScenarioIds: [],
        remainingScenarioCount: 0,
        parts: [],
        warnings: decodedWarnings
      };
    }
    if (item.hasWork !== true) invalid();
    const waveBatchId = sha256(item.waveBatchId);
    const selectedScenarioIds = stringArray(
      item.selectedScenarioIds,
      25,
      1_024,
      1,
      1
    );
    unique(selectedScenarioIds);
    const parts = array(item.parts, 5, 1).map((part, index) =>
      validateSingleMethodWavePart(part, expected.methodId, index + 1));
    unique(parts.map((part) => part.partBatchId));
    const partScenarioIds = parts.flatMap((part) => part.scenarioIds);
    let partScenarioIndex = 0;
    for (const selectedScenarioId of selectedScenarioIds) {
      if (selectedScenarioId === partScenarioIds[partScenarioIndex]) {
        partScenarioIndex += 1;
      }
    }
    if (partScenarioIndex !== partScenarioIds.length) invalid();
    return {
      waveBatchId,
      reportPairId: expected.reportPairId,
      methodId: expected.methodId,
      hasWork: true,
      selectedScenarioIds,
      remainingScenarioCount: integer(item.remainingScenarioCount, 0),
      parts,
      warnings: decodedWarnings
    };
  } catch (error) {
    if (process.env.AI_UNIT_TEST_DEBUG_ANALYSIS_CONTRACT === '1') {
      throw error;
    }
    invalidResponse(error);
  }
}

function validateExactCoverage(value: unknown): ExactCoverageCounts {
  const item = record(value, [
    'lineCovered', 'lineMissed', 'lineTotal', 'branchCovered', 'branchMissed',
    'branchTotal'
  ]);
  const lineCovered = integer(item.lineCovered, 0);
  const lineMissed = integer(item.lineMissed, 0);
  const lineTotal = integer(item.lineTotal, 0);
  const branchCovered = integer(item.branchCovered, 0);
  const branchMissed = integer(item.branchMissed, 0);
  const branchTotal = integer(item.branchTotal, 0);
  if (lineCovered + lineMissed !== lineTotal
    || branchCovered + branchMissed !== branchTotal) invalid();
  return item as ExactCoverageCounts;
}

export function decodeRefreshMethodAnalysisCoverageResponse(
  value: unknown,
  expectedSessionId: string,
  expectedReportPairId: string
): RefreshMethodAnalysisCoverageResponse {
  try {
    const item = record(value, ['reportPairId', 'coverage', 'catalog']);
    if (sha256(item.reportPairId) !== expectedReportPairId) invalid();
    const coverage = validateExactCoverage(item.coverage);
    const catalog = decodeCatalog(item.catalog, expectedSessionId, expectedReportPairId);
    return { reportPairId: expectedReportPairId, coverage, catalog };
  } catch (error) {
    invalidResponse(error);
  }
}

function validateRepairMethodSource(value: unknown): RepairMethodSource {
  const item = record(value, [
    'methodId', 'declaringType', 'methodName', 'descriptor', 'modifiers',
    'firstLine', 'lastLine', 'sourceFirstLine', 'sourceLastLine',
    'sourceText', 'sourceComplete', 'parameterTypes', 'returnType',
    'declaredExceptions'
  ]);
  text(item.methodId, 4_096);
  text(item.declaringType, 2_000);
  text(item.methodName, 1_024);
  text(item.descriptor, 2_000);
  stringArray(item.modifiers, 256, 128);
  const firstLine = integer(item.firstLine, 1);
  const lastLine = integer(item.lastLine, firstLine);
  if (lastLine < firstLine) invalid();
  const sourceFirstLine = integer(item.sourceFirstLine, firstLine);
  const sourceLastLine = integer(item.sourceLastLine, sourceFirstLine);
  const sourceComplete = bool(item.sourceComplete);
  if (sourceFirstLine < firstLine || sourceLastLine > lastLine
    || sourceLastLine < sourceFirstLine
    || sourceLastLine - sourceFirstLine + 1 > 300
    || (sourceComplete
      && (sourceFirstLine !== firstLine || sourceLastLine !== lastLine))) invalid();
  text(item.sourceText, 1_000_000);
  stringArray(item.parameterTypes, 256, 2_000);
  text(item.returnType, 2_000);
  stringArray(item.declaredExceptions, 256, 2_000);
  return item as RepairMethodSource;
}

export function validateMethodRepairContextRequest(
  request: MethodRepairContextRequest
): MethodRepairContextRequest {
  try {
    const reportPairId = sha256(request.reportPairId);
    const methodId = text(request.methodId, 4_096);
    const currentClassFrames = array(request.currentClassFrames, 32).map((value) => {
      const frame = record(value, [
        'ownerFqn', 'methodName', 'descriptor', 'sourceLine'
      ]);
      const descriptor = frame.descriptor === null
        ? null
        : text(frame.descriptor, 2_000);
      return {
        ownerFqn: text(frame.ownerFqn, 2_000),
        methodName: text(frame.methodName, 1_024),
        descriptor,
        sourceLine: integer(frame.sourceLine, 1)
      };
    });
    return {
      reportPairId,
      methodId,
      currentClassFrames,
      relatedTypeFqns: stringArray(request.relatedTypeFqns, 64, 2_000, 0, 1),
      missingSymbols: stringArray(request.missingSymbols, 64, 1_024, 0, 1)
    };
  } catch {
    invalid();
  }
}

export function decodeMethodRepairContextResponse(
  value: unknown,
  expected: { reportPairId: string }
): MethodRepairContextResponse {
  try {
    const item = record(value, [
      'reportPairId', 'sourceSha256', 'targetMethod', 'stackMethods',
      'referencedTypes', 'warnings', 'truncated'
    ]);
    if (sha256(item.reportPairId) !== expected.reportPairId) invalid();
    const targetMethod = validateRepairMethodSource(item.targetMethod);
    const stackMethods = array(item.stackMethods, 12).map(
      validateRepairMethodSource
    );
    unique([
      targetMethod.methodId,
      ...stackMethods.map((method) => method.methodId)
    ]);
    if (stackMethods.some((method) =>
      method.declaringType !== targetMethod.declaringType)) invalid();
    const referencedTypes = array(item.referencedTypes, 64).map(
      validateReferencedType
    );
    unique(referencedTypes.map((type) => type.qualifiedName));
    return {
      reportPairId: expected.reportPairId,
      sourceSha256: sha256(item.sourceSha256),
      targetMethod,
      stackMethods,
      referencedTypes,
      warnings: warnings(item.warnings),
      truncated: bool(item.truncated)
    };
  } catch (error) {
    invalidResponse(error);
  }
}

export function validateSingleMethodBatchRequest(
  request: SingleMethodBatchRequest
): void {
  try {
    sha256(request.reportPairId);
    const completed = stringArray(request.completedTestMethodPlanIds, 20_000, 1_024);
    unique(completed);
    integer(request.maxTestMethods, 1, MAX_SINGLE_METHOD_BATCH_TEST_METHODS);
  } catch {
    invalid();
  }
}

export function validateSingleMethodWaveRequest(
  request: SingleMethodWaveRequest
): void {
  try {
    sha256(request.reportPairId);
    const completed = stringArray(request.completedScenarioIds, 20_000, 4_096, 0, 1);
    const skipped = stringArray(request.skippedScenarioIds, 20_000, 4_096, 0, 1);
    unique(completed);
    unique(skipped);
    if (completed.some((id) => skipped.includes(id))) invalid();
    if (request.maxScenarios !== 25 || request.partSize !== 5) invalid();
  } catch {
    invalid();
  }
}

export function decodeClassScenarioWaveResponse(
  value: unknown,
  expected: { sessionId: string; reportPairId: string; methodIds: readonly string[] }
): ClassScenarioWaveResponse {
  try {
    uuid(expected.sessionId);
    expected.methodIds.forEach(sha256);
    unique([...expected.methodIds]);
    const item = record(value, [
      'waveBatchId', 'reportPairId', 'hasWork', 'selectedMethodIds',
      'selectedScenarioIds', 'remainingScenarioCountByMethod',
      'completedMethodIds', 'parts', 'warnings'
    ]);
    if (sha256(item.reportPairId) !== expected.reportPairId) invalid();
    const allowedMethods = new Set(expected.methodIds);
    const remainingRecord = item.remainingScenarioCountByMethod;
    if (!remainingRecord || typeof remainingRecord !== 'object'
      || Array.isArray(remainingRecord)) invalid();
    const remainingScenarioCountByMethod: Record<string, number> = {};
    for (const [methodId, count] of Object.entries(remainingRecord)) {
      if (!allowedMethods.has(sha256(methodId))) invalid();
      remainingScenarioCountByMethod[methodId] = integer(count, 0);
    }
    if (Object.keys(remainingScenarioCountByMethod).length !== expected.methodIds.length
      || expected.methodIds.some((methodId) => !(methodId in remainingScenarioCountByMethod))) {
      invalid();
    }
    const completedMethodIds = stringArray(item.completedMethodIds, 20_000, 64)
      .map(sha256);
    unique(completedMethodIds);
    if (completedMethodIds.some((methodId) => !allowedMethods.has(methodId)
      || remainingScenarioCountByMethod[methodId] !== 0)) invalid();
    const decodedWarnings = warnings(item.warnings);
    if (item.hasWork === false) {
      if (item.waveBatchId !== null
        || array(item.selectedMethodIds, 0).length !== 0
        || array(item.selectedScenarioIds, 0).length !== 0
        || array(item.parts, 0).length !== 0) invalid();
      return {
        waveBatchId: null,
        methodId: expected.methodIds[0],
        remainingScenarioCount: 0,
        reportPairId: expected.reportPairId,
        hasWork: false,
        selectedMethodIds: [],
        selectedScenarioIds: [],
        remainingScenarioCountByMethod,
        completedMethodIds,
        parts: [],
        warnings: decodedWarnings
      };
    }
    if (item.hasWork !== true) invalid();
    const waveBatchId = sha256(item.waveBatchId);
    const selectedMethodIds = stringArray(item.selectedMethodIds, 20_000, 64, 1, 1)
      .map(sha256);
    unique(selectedMethodIds);
    if (selectedMethodIds.some((methodId) => !allowedMethods.has(methodId))) invalid();
    const selectedScenarioIds = stringArray(item.selectedScenarioIds, 25, 1_024, 1, 1);
    unique(selectedScenarioIds);
    const parts = array(item.parts, 5, 1).map((rawPart, index) => {
      const part = record(rawPart, [
        'partIndex', 'partBatchId', 'scenarioIds', 'methodSlices'
      ]);
      if (integer(part.partIndex, 1, 5) !== index + 1) invalid();
      const partBatchId = sha256(part.partBatchId);
      const scenarioIds = stringArray(part.scenarioIds, 5, 1_024, 1, 1);
      unique(scenarioIds);
      const methodSlices = array(part.methodSlices, 5, 1).map((rawSlice) => {
        const slice = record(rawSlice, ['methodId', 'testMethodNamePrefix', 'batch']);
        const methodId = sha256(slice.methodId);
        if (!selectedMethodIds.includes(methodId)) invalid();
        const testMethodNamePrefix = text(slice.testMethodNamePrefix, 128, 1);
        if (!/^[A-Za-z_$][\w$]*_$/u.test(testMethodNamePrefix)) invalid();
        return {
          methodId,
          testMethodNamePrefix,
          batch: validateSingleMethodWavePart(slice.batch, methodId, index + 1)
        };
      });
      const supplied = methodSlices.flatMap((slice) => slice.batch.scenarioIds);
      if (supplied.length !== scenarioIds.length
        || supplied.some((scenarioId, scenarioIndex) => (
          scenarioIds[scenarioIndex] !== scenarioId
        ))) invalid();
      const firstBatch = methodSlices[0].batch;
      return {
        ...structuredClone(firstBatch),
        partIndex: index + 1,
        partBatchId,
        scenarioIds,
        methodSlices
      };
    });
    const suppliedScenarioIds = parts.flatMap((part) => part.scenarioIds);
    if (suppliedScenarioIds.length !== selectedScenarioIds.length
      || suppliedScenarioIds.some((scenarioId, index) => (
        selectedScenarioIds[index] !== scenarioId
      ))) invalid();
    return {
      waveBatchId,
      // The first requested method owns the durable class-Wave checkpoint even
      // when this Wave's first selected scenario belongs to a later method.
      methodId: expected.methodIds[0],
      remainingScenarioCount: Object.values(remainingScenarioCountByMethod)
        .reduce((sum, count) => sum + count, 0),
      reportPairId: expected.reportPairId,
      hasWork: true,
      selectedMethodIds,
      selectedScenarioIds,
      remainingScenarioCountByMethod,
      completedMethodIds,
      parts,
      warnings: decodedWarnings
    };
  } catch (error) {
    if (process.env.AI_UNIT_TEST_DEBUG_ANALYSIS_CONTRACT === '1') throw error;
    invalidResponse(error);
  }
}

export function validateClassScenarioWaveRequest(
  request: ClassScenarioWaveRequest
): void {
  try {
    sha256(request.reportPairId);
    if (request.methods.length < 1 || request.methods.length > 20_000) invalid();
    unique(request.methods.map((method) => sha256(method.methodId)));
    for (const method of request.methods) {
      const completed = stringArray(method.completedScenarioIds, 20_000, 4_096, 0, 1);
      const skipped = stringArray(method.skippedScenarioIds, 20_000, 4_096, 0, 1);
      unique(completed);
      unique(skipped);
      if (completed.some((id) => skipped.includes(id))) invalid();
    }
    if (request.maxScenarios !== 25 || request.partSize !== 5) invalid();
  } catch {
    invalid();
  }
}
