import { createHash } from 'node:crypto';
import type {
  BackendLlmConfig,
  BuildToolchainContext,
  ModelTokenUsage
} from '../../shared/types';
import type { SurefireExecutionReport } from './surefire-report.service.ts';
import {
  ANALYSIS_SESSION_ID_PATTERN,
  METHOD_ID_PATTERN,
  type ReferencedTypeApi,
  type RepairMethodSource,
  type SingleMethodWorkBatch
} from './method-analysis-contract.ts';
import type { MavenRepairDiagnostic } from './maven-repair-diagnostic.service.ts';
import {
  validateRagActiveIndexIdentity,
  validateRagRepairContext,
  type RagActiveIndexIdentity,
  type RagRepairContext
} from './rag-index-contract.ts';

export const METHOD_GENERATION_RESPONSE_INVALID = '单方法生成响应无效。';
export const MAX_METHOD_GENERATION_SESSION_TEST_METHODS = 125;
export const MAX_METHOD_REPAIR_CONTEXT_METHODS = 32;

export type SurefireReportArtifact = {
  fileName: string;
  content: string;
};

export type MavenCommandEvidence = {
  scope: 'method_candidate' | 'pruned_method_candidate';
  phase: 'test_compile' | 'test';
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  surefireReports: SurefireReportArtifact[];
};

export type CandidateExecutionFeedback = {
  status: 'compile_failed' | 'test_failed' | 'passed';
  mavenExecutions: MavenCommandEvidence[];
  testReport?: SurefireExecutionReport;
};

export type MethodGenerationRepairContext = MavenRepairDiagnostic & {
  analyzerStatus: 'available' | 'fallback';
  analyzerWarnings: string[];
  sourceSha256: string;
  targetMethod: RepairMethodSource;
  stackMethods: RepairMethodSource[];
  referencedTypes: ReferencedTypeApi[];
};

export type CandidateRejectionFeedback = {
  acceptedTestCode: string;
  acceptedFileSha256: string;
  violationCodes: string[];
  memberNames: string[];
  message: string;
};

export type PrepareRagRepairRequest = {
  expectedEventSequence: number;
  candidateId: string;
  candidateVersion: number;
  repairAttempt: number;
  methodId: string;
  batchId: string;
  batchIndex: number;
  effectiveTestCode: string;
  effectiveFileSha256: string;
  execution: CandidateExecutionFeedback;
  repairContext?: MethodGenerationRepairContext;
};

export type RagRepairAttemptContext = {
  diagnosticFingerprint: string;
  activeIndex: RagActiveIndexIdentity;
};

export type StartMethodGenerationSessionRequest = {
  clientRequestId: string;
  classTaskId: string;
  methodId: string;
  batchId: string;
  batchIndex: number;
  outputTestClassName: string;
  expectedPackageName: string;
  buildToolchain: BuildToolchainContext;
  batch: SingleMethodWorkBatch | ClassScenarioWorkBatch;
  captureModelCalls: boolean;
  repairAttemptLimit: number | null;
  unlimitedRepair: boolean;
  ragContext?: RagRepairContext;
};

export type ClassScenarioGenerationMethodSlice = {
  methodId: string;
  testMethodNamePrefix: string;
  batch: SingleMethodWorkBatch;
};

export type ClassScenarioWorkBatch = Pick<
  SingleMethodWorkBatch,
  | 'batchId'
  | 'reportPairId'
  | 'methodId'
  | 'hasWork'
  | 'necessaryImports'
  | 'plannedTestMethods'
  | 'remainingTestMethods'
  | 'warnings'
> & {
  methodSlices: ClassScenarioGenerationMethodSlice[];
};

export type RecoverMethodGenerationSessionRequest = {
  startRequest: StartMethodGenerationSessionRequest;
  candidate: MethodCandidate;
};

export type ResumeMethodGenerationSessionRequest = {
  feedbackId: string;
  expectedEventSequence: number;
  candidateId: string;
  candidateVersion: number;
  repairAttempt: number;
  effectiveTestCode: string;
  effectiveFileSha256: string;
  feedbackKind: 'execution' | 'candidate_rejected';
  execution: CandidateExecutionFeedback;
  repairContext?: MethodGenerationRepairContext;
  candidateRejection?: CandidateRejectionFeedback;
  ragRepairAttempt?: RagRepairAttemptContext;
  ragEmbeddingConfig?: BackendLlmConfig;
};

export type MethodGenerationModelContext = {
  llmConfig: BackendLlmConfig;
};

export type MethodCandidate = {
  candidateId: string;
  candidateVersion: number;
  repairAttempt: number;
  methodId: string;
  batchId: string;
  batchIndex: number;
  testCode: string;
  generatedCodeSha256: string;
  outputTestClassName: string;
  ordinaryTestMethodCount: number;
  usage: ModelTokenUsage | null;
};

export type MethodGenerationProgress = {
  repairAttempt: number;
  stage: string;
  completedTestMethods: number;
  remainingTestMethods: number;
};

export type MethodGenerationCompletion = {
  methodId: string;
  batchId: string;
  stopReason: 'verified' | 'repair_exhausted' | 'stopped';
  bestCandidateId: string | null;
  aggregateUsage: ModelTokenUsage | null;
  modelCallCount: number;
  usageReportedCallCount: number;
};

export type RagToolValidatedInput = {
  diagnostic_ids?: string[];
  diagnostic_id?: string;
  owner_fqn?: string;
  method_name?: string;
  jvm_descriptor?: string;
  source_line?: number;
  query?: string;
  cursor?: string;
};

export type RagToolPhysicalAttempt = {
  attempt: number;
  status: string;
  toolMessage: string;
  retryScheduled: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type RagToolExchange = {
  sequence: number;
  toolCallId: string;
  toolName: string;
  modelRequestSequence: number;
  rawArguments: string;
  validatedInput: RagToolValidatedInput | null;
  toolMessage: string;
  includedInModelRequestSequence: number;
  status: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cacheHit: boolean;
  physicalAttempts: RagToolPhysicalAttempt[];
  evidenceStatus: 'NEW_EVIDENCE' | 'NO_NEW_EVIDENCE' | 'NOT_EVALUATED';
  consecutiveNoNewEvidence: number;
  forcedFinalOutput: boolean;
};

export type MethodGenerationModelCall = {
  sessionId: string;
  callId: string;
  parentCallId: string | null;
  phase: 'started' | 'completed' | 'failed' | 'stopped' | 'skipped';
  callKind: 'generation' | 'repair';
  methodId: string;
  batchId: string;
  batchIndex: number;
  repairAttempt: number;
  candidateVersion: number;
  modelName: string;
  startedAt: string;
  occurredAt: string;
  systemPrompt: string | null;
  userPrompt: string | null;
  rawOutput: string | null;
  processedOutput: string | null;
  processingValid: boolean | null;
  processingError?: string | null;
  usage: ModelTokenUsage | null;
  errorCode: string | null;
  statusCode: number | null;
  errorType: string | null;
  providerCode: string | null;
  truncated: boolean;
  requestTraces?: string[];
  toolExchanges?: RagToolExchange[];
};

export type MethodGenerationFailure = {
  code: string;
  message: string;
  stage: string | null;
};

export type MethodGenerationSessionEvent = {
  sessionId: string;
  eventSequence: number;
  eventType: 'progress' | 'candidate_ready' | 'completed' | 'model_call' | 'error';
  occurredAt: string;
  progress: MethodGenerationProgress | null;
  candidate: MethodCandidate | null;
  completion: MethodGenerationCompletion | null;
  modelCall: MethodGenerationModelCall | null;
  error: MethodGenerationFailure | null;
};

export type MethodGenerationSessionStatus = {
  sessionId: string;
  phase: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  lastEventSequence: number;
  pendingCandidate: MethodCandidate | null;
  completion: MethodGenerationCompletion | null;
  terminalError: MethodGenerationFailure | null;
  events: MethodGenerationSessionEvent[];
};

export type MethodGenerationEventsAcknowledgement = {
  sessionId: string;
  acknowledgedThroughEventSequence: number;
  lastEventSequence: number;
};

export type MethodGenerationTurnResult =
  | {
      kind: 'candidate_ready';
      sessionId: string;
      eventSequence: number;
      candidate: MethodCandidate;
    }
  | {
      kind: 'completed';
      sessionId: string;
      eventSequence: number;
      completion: MethodGenerationCompletion;
    };

export type MethodGenerationWavePartStartRequest = {
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  request: StartMethodGenerationSessionRequest;
};

export type StartMethodGenerationWaveRequest = {
  waveId: string;
  methodId: string;
  waveIndex: number;
  parts: MethodGenerationWavePartStartRequest[];
};

export type MethodGenerationWavePartResult = {
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  status: 'succeeded' | 'failed' | 'cancelled';
  childSessionId: string | null;
  candidate: MethodCandidate | null;
  error: MethodGenerationFailure | null;
  aggregateUsage: ModelTokenUsage | null;
  modelCallCount: number;
  usageReportedCallCount: number;
};

export type MethodGenerationWaveCompletion = {
  parts: MethodGenerationWavePartResult[];
  succeededPartCount: number;
  failedPartCount: number;
  cancelledPartCount: number;
  aggregateUsage: ModelTokenUsage | null;
  modelCallCount: number;
  usageReportedCallCount: number;
};

export type MethodGenerationWaveEvent = {
  waveSessionId: string;
  eventSequence: number;
  waveId: string;
  methodId: string;
  waveIndex: number;
  eventType:
    | 'wave_started'
    | 'part_started'
    | 'part_event'
    | 'part_succeeded'
    | 'part_failed'
    | 'part_cancelled'
    | 'wave_completed'
    | 'wave_cancelled'
    | 'error';
  occurredAt: string;
  partIndex: number | null;
  partBatchId: string | null;
  scenarioIds: string[];
  childSessionId: string | null;
  candidateId: string | null;
  childEvent: MethodGenerationSessionEvent | null;
  partResult: MethodGenerationWavePartResult | null;
  completion: MethodGenerationWaveCompletion | null;
  error: MethodGenerationFailure | null;
};

export type MethodGenerationWaveStatus = {
  waveSessionId: string;
  waveId: string;
  methodId: string;
  waveIndex: number;
  phase: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  lastEventSequence: number;
  terminalParts: MethodGenerationWavePartResult[];
  completion: MethodGenerationWaveCompletion | null;
  terminalError: MethodGenerationFailure | null;
  events: MethodGenerationWaveEvent[];
};

export type RecoverMethodGenerationWaveRequest = {
  recoveryRequestId: string;
  startRequest: StartMethodGenerationWaveRequest;
  terminalParts: MethodGenerationWavePartResult[];
  lastAcknowledgedEventSequence: number;
};

export type MethodGenerationWaveEventsAcknowledgement = {
  waveSessionId: string;
  acknowledgedThroughEventSequence: number;
  lastEventSequence: number;
};

export type MethodGenerationWaveTurnResult = {
  waveSessionId: string;
  eventSequence: number;
  completion: MethodGenerationWaveCompletion;
};

export type MethodGenerationWaveProgressHandler = (
  event: MethodGenerationWaveEvent
) => void | Promise<void>;

export class MethodGenerationRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MethodGenerationRequestError';
    this.code = code;
  }
}

export type MethodGenerationProgressHandler = (
  event: MethodGenerationSessionEvent
) => void | Promise<void>;

export type MethodGenerationIdentity = {
  methodId: string;
  batchId: string;
  batchIndex?: number;
  outputTestClassName?: string;
  plannedTestMethods?: number;
  ragEnabled?: boolean;
};

export type MethodGenerationWaveIdentity = {
  waveId: string;
  methodId: string;
  waveIndex: number;
  parts: Array<{
    partIndex: number;
    partBatchId: string;
    scenarioIds: string[];
    generationIdentity: MethodGenerationIdentity;
  }>;
};

type UnknownRecord = Record<string, unknown>;

const EVENT_TYPES = new Set<MethodGenerationSessionEvent['eventType']>([
  'progress', 'candidate_ready', 'completed', 'model_call', 'error'
]);
const PHASES = new Set<MethodGenerationSessionStatus['phase']>([
  'starting', 'running', 'completed', 'failed', 'cancelled'
]);
const STOP_REASONS = new Set<MethodGenerationCompletion['stopReason']>([
  'verified', 'repair_exhausted', 'stopped'
]);
const MODEL_PHASES = new Set<MethodGenerationModelCall['phase']>([
  'started', 'completed', 'failed', 'stopped', 'skipped'
]);
const MODEL_KINDS = new Set<MethodGenerationModelCall['callKind']>([
  'generation', 'repair'
]);
const RAG_EVIDENCE_STATUSES = new Set<RagToolExchange['evidenceStatus']>([
  'NEW_EVIDENCE', 'NO_NEW_EVIDENCE', 'NOT_EVALUATED'
]);
const WAVE_EVENT_TYPES = new Set<MethodGenerationWaveEvent['eventType']>([
  'wave_started', 'part_started', 'part_event', 'part_succeeded',
  'part_failed', 'part_cancelled', 'wave_completed', 'wave_cancelled', 'error'
]);
const WAVE_PART_STATUSES = new Set<MethodGenerationWavePartResult['status']>([
  'succeeded', 'failed', 'cancelled'
]);

function invalid(): never {
  throw new MethodGenerationRequestError('METHOD_GENERATION_RESPONSE_INVALID', METHOD_GENERATION_RESPONSE_INVALID);
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

function recordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as UnknownRecord;
  const actual = Object.keys(candidate);
  if (required.some((key) => !actual.includes(key))
    || actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    invalid();
  }
  return candidate;
}

function array(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function uniqueStrings(
  value: unknown,
  maximum: number,
  itemMaximum: number,
  minimum = 0,
  pattern?: RegExp
): string[] {
  const result = array(value, maximum, minimum).map((item) => text(item, itemMaximum));
  if (new Set(result).size !== result.length
    || pattern && result.some((item) => !pattern.test(item))) invalid();
  return result;
}

function stringList(value: unknown, maximum: number, itemMaximum: number): string[] {
  return array(value, maximum).map((item) => text(item, itemMaximum));
}

function text(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function nullableText(value: unknown, maximum: number, minimum = 1): string | null {
  return value === null ? null : text(value, maximum, minimum);
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

function isoDate(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) invalid();
  return result;
}

function nullableInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | null {
  return value === null ? null : integer(value, minimum, maximum);
}

function usage(value: unknown): ModelTokenUsage | null {
  if (value === null) return null;
  const item = recordWithOptional(
    value,
    ['inputTokens', 'outputTokens', 'totalTokens'],
    ['cachedInputTokens']
  );
  const inputTokens = nullableInteger(item.inputTokens, 0, 1_000_000_000);
  const outputTokens = nullableInteger(item.outputTokens, 0, 1_000_000_000);
  const totalTokens = nullableInteger(item.totalTokens, 0, 1_000_000_000);
  const result: ModelTokenUsage = { inputTokens, outputTokens, totalTokens };
  if ('cachedInputTokens' in item) {
    result.cachedInputTokens = nullableInteger(item.cachedInputTokens, 0, 1_000_000_000);
  }
  return result;
}

function mergeIdentity(
  current: MethodGenerationIdentity | undefined,
  next: MethodGenerationIdentity
): MethodGenerationIdentity {
  if (current) {
    if (current.methodId !== next.methodId || current.batchId !== next.batchId
      || current.batchIndex !== undefined && next.batchIndex !== undefined
        && current.batchIndex !== next.batchIndex
      || current.outputTestClassName !== undefined
        && next.outputTestClassName !== undefined
        && current.outputTestClassName !== next.outputTestClassName) invalid();
  }
  return {
    methodId: next.methodId,
    batchId: next.batchId,
    batchIndex: current?.batchIndex ?? next.batchIndex,
    outputTestClassName:
      current?.outputTestClassName ?? next.outputTestClassName,
    plannedTestMethods: current?.plannedTestMethods ?? next.plannedTestMethods,
    ragEnabled: current?.ragEnabled ?? next.ragEnabled
  };
}

function decodeCandidate(
  value: unknown,
  expected?: MethodGenerationIdentity
): MethodCandidate {
  const item = record(value, [
    'candidateId', 'candidateVersion', 'repairAttempt', 'methodId', 'batchId',
    'batchIndex', 'testCode', 'generatedCodeSha256', 'outputTestClassName',
    'ordinaryTestMethodCount', 'usage'
  ]);
  uuid(item.candidateId);
  const candidateVersion = integer(item.candidateVersion, 1);
  const repairAttempt = integer(item.repairAttempt, 0);
  if (candidateVersion !== repairAttempt + 1) invalid();
  const methodId = sha256(item.methodId);
  const batchId = sha256(item.batchId);
  const batchIndex = integer(item.batchIndex, 1, 10_000);
  const testCode = text(item.testCode, 1_000_000);
  const generatedCodeSha256 = sha256(item.generatedCodeSha256);
  if (createHash('sha256').update(testCode, 'utf8').digest('hex')
    !== generatedCodeSha256) invalid();
  const outputTestClassName = text(item.outputTestClassName, 512);
  if (!/^[A-Za-z_$][\w$]*$/.test(outputTestClassName)) invalid();
  const ordinaryTestMethodCount = integer(
    item.ordinaryTestMethodCount,
    1,
    MAX_METHOD_GENERATION_SESSION_TEST_METHODS
  );
  usage(item.usage);
  if (expected) {
    mergeIdentity(expected, {
      methodId,
      batchId,
      batchIndex,
      outputTestClassName,
      plannedTestMethods: ordinaryTestMethodCount
    });
    if (expected.plannedTestMethods !== undefined
      && (repairAttempt === 0
        ? ordinaryTestMethodCount !== expected.plannedTestMethods
        : ordinaryTestMethodCount > expected.plannedTestMethods)) invalid();
  }
  return item as MethodCandidate;
}

function decodeProgress(
  value: unknown,
  expected?: MethodGenerationIdentity
): MethodGenerationProgress {
  const item = record(value, [
    'repairAttempt', 'stage', 'completedTestMethods', 'remainingTestMethods'
  ]);
  integer(item.repairAttempt, 0);
  text(item.stage, 128);
  const completed = integer(
    item.completedTestMethods,
    0,
    MAX_METHOD_GENERATION_SESSION_TEST_METHODS
  );
  const remaining = integer(item.remainingTestMethods, 0);
  if (expected?.plannedTestMethods !== undefined
    && (completed > expected.plannedTestMethods
      || remaining > expected.plannedTestMethods)) invalid();
  return item as MethodGenerationProgress;
}

function decodeCompletion(
  value: unknown,
  expected?: MethodGenerationIdentity
): MethodGenerationCompletion {
  const item = record(value, [
    'methodId', 'batchId', 'stopReason', 'bestCandidateId', 'aggregateUsage',
    'modelCallCount', 'usageReportedCallCount'
  ]);
  const methodId = sha256(item.methodId);
  const batchId = sha256(item.batchId);
  member(item.stopReason, STOP_REASONS);
  if (item.bestCandidateId !== null) uuid(item.bestCandidateId);
  usage(item.aggregateUsage);
  const modelCallCount = integer(item.modelCallCount, 0);
  if (integer(item.usageReportedCallCount, 0) > modelCallCount) invalid();
  if (expected) mergeIdentity(expected, { methodId, batchId });
  return item as MethodGenerationCompletion;
}

function decodeFailure(value: unknown): MethodGenerationFailure {
  const item = record(value, ['code', 'message', 'stage']);
  const code = text(item.code, 128);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) invalid();
  text(item.message, 1_000);
  nullableText(item.stage, 128);
  return item as MethodGenerationFailure;
}

function decodeModelCall(
  value: unknown,
  expectedSessionId: string,
  expected?: MethodGenerationIdentity
): MethodGenerationModelCall {
  const item = recordWithOptional(value, [
    'sessionId', 'callId', 'parentCallId', 'phase', 'callKind', 'methodId',
    'batchId', 'batchIndex', 'repairAttempt', 'candidateVersion', 'modelName',
    'startedAt', 'occurredAt', 'systemPrompt', 'userPrompt', 'rawOutput',
    'processedOutput', 'processingValid', 'usage', 'errorCode', 'statusCode',
    'errorType', 'providerCode', 'truncated'
  ], ['toolExchanges', 'requestTraces', 'processingError']);
  if (uuid(item.sessionId) !== expectedSessionId) invalid();
  uuid(item.callId);
  if (item.parentCallId !== null) uuid(item.parentCallId);
  const phase = member(item.phase, MODEL_PHASES);
  const callKind = member(item.callKind, MODEL_KINDS);
  const methodId = sha256(item.methodId);
  const batchId = sha256(item.batchId);
  const batchIndex = integer(item.batchIndex, 1, 10_000);
  const repairAttempt = integer(item.repairAttempt, 0);
  const candidateVersion = integer(item.candidateVersion, 1);
  if (candidateVersion !== repairAttempt + 1
    || (callKind === 'generation') !== (repairAttempt === 0)) invalid();
  text(item.modelName, 512);
  const startedAt = isoDate(item.startedAt);
  const occurredAt = isoDate(item.occurredAt);
  if (Date.parse(occurredAt) < Date.parse(startedAt)) invalid();
  const systemPrompt = nullableText(item.systemPrompt, 500_000);
  const userPrompt = nullableText(item.userPrompt, 500_000);
  const rawOutput = nullableText(item.rawOutput, 500_000, 0);
  const processedOutput = nullableText(item.processedOutput, 500_000);
  const processingValid = item.processingValid === null
    ? null
    : bool(item.processingValid);
  const processingError = item.processingError === undefined
    ? null
    : nullableText(item.processingError, 1_000);
  const tokenUsage = usage(item.usage);
  const errorCode = nullableText(item.errorCode, 128);
  const statusCode = nullableInteger(item.statusCode, 100, 599);
  const errorType = nullableText(item.errorType, 128);
  const providerCode = nullableText(item.providerCode, 128);
  bool(item.truncated);
  const requestTraces = item.requestTraces === undefined
    ? undefined
    : decodeRequestTraces(item.requestTraces);
  const toolExchanges = item.toolExchanges === undefined
    ? undefined
    : decodeRagToolExchanges(item.toolExchanges);
  if (errorCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/.test(errorCode)) invalid();
  if (errorType !== null && !/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(errorType)) invalid();
  if (providerCode !== null && !/^[A-Z][A-Z0-9_.-]{0,127}$/.test(providerCode)) invalid();
  const failureFields = [errorCode, statusCode, errorType, providerCode];
  if (phase === 'started') {
    if (systemPrompt === null || userPrompt === null || rawOutput !== null
      || processedOutput !== null || processingValid !== null || tokenUsage !== null
      || processingError !== null
      || requestTraces !== undefined
      || failureFields.some((field) => field !== null)) invalid();
  } else if (systemPrompt !== null || userPrompt !== null) {
    invalid();
  } else if (phase === 'completed') {
    if (rawOutput === null || processingValid === null
      || (processedOutput !== null) !== processingValid
      || failureFields.some((field) => field !== null)) invalid();
    if (processingValid && rawOutput.length === 0) invalid();
    if (processingValid && processingError !== null) invalid();
  } else {
    if (phase === 'failed' && errorCode === null) invalid();
    if ((phase === 'stopped' || phase === 'skipped')
      && failureFields.some((field) => field !== null)) invalid();
    if (rawOutput !== null || processedOutput !== null || processingValid !== null
      || processingError !== null || tokenUsage !== null) invalid();
  }
  const terminalAttempt = phase === 'completed' || phase === 'failed' || phase === 'stopped';
  if (requestTraces !== undefined && !terminalAttempt) invalid();
  if (toolExchanges !== undefined
    && (callKind !== 'repair' || !terminalAttempt)) invalid();
  if (expected) mergeIdentity(expected, { methodId, batchId, batchIndex });
  return item as MethodGenerationModelCall;
}

function decodeRequestTraces(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  if (value.length > 128) invalid();
  return value.map((item) => text(item, 1_000_000, 0));
}

function decodeRagToolExchanges(value: unknown): RagToolExchange[] {
  if (!Array.isArray(value)) invalid();
  const exchanges = value.map((exchangeValue) => {
    const exchange = record(exchangeValue, [
      'sequence', 'toolCallId', 'toolName', 'modelRequestSequence',
      'rawArguments', 'validatedInput', 'toolMessage',
      'includedInModelRequestSequence', 'status', 'startedAt', 'completedAt',
      'durationMs', 'cacheHit', 'physicalAttempts', 'evidenceStatus',
      'consecutiveNoNewEvidence', 'forcedFinalOutput'
    ]);
    const modelRequestSequence = integer(exchange.modelRequestSequence, 1);
    if (integer(exchange.includedInModelRequestSequence, 2)
      !== modelRequestSequence + 1) invalid();
    text(exchange.toolCallId, 256);
    text(exchange.toolName, 256);
    text(exchange.rawArguments, 100_000, 0);
    decodeRagToolValidatedInput(exchange.validatedInput);
    text(exchange.toolMessage, 100_000);
    const status = text(exchange.status, 128);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(status)) invalid();
    const startedAt = isoDate(exchange.startedAt);
    const completedAt = isoDate(exchange.completedAt);
    if (Date.parse(completedAt) < Date.parse(startedAt)) invalid();
    integer(exchange.durationMs, 0, 86_400_000);
    const cacheHit = bool(exchange.cacheHit);
    const physicalAttempts = decodeRagToolPhysicalAttempts(exchange.physicalAttempts);
    const evidenceStatus = member(exchange.evidenceStatus, RAG_EVIDENCE_STATUSES);
    const consecutiveNoNewEvidence = integer(
      exchange.consecutiveNoNewEvidence,
      0,
      3
    );
    const forcedFinalOutput = bool(exchange.forcedFinalOutput);
    if (cacheHit && (
      status !== 'CACHE_HIT'
      || exchange.validatedInput === null
      || physicalAttempts.length !== 0
      || evidenceStatus !== 'NO_NEW_EVIDENCE'
    )) invalid();
    if (physicalAttempts.length > 0
      && (cacheHit || exchange.validatedInput === null)) invalid();
    if (evidenceStatus === 'NEW_EVIDENCE'
      && (cacheHit || consecutiveNoNewEvidence !== 0)) invalid();
    if (forcedFinalOutput) {
      const allowedByNoNewEvidenceLimit = status === 'NO_NEW_EVIDENCE_LIMIT_REACHED'
        && consecutiveNoNewEvidence === 3;
      const allowedByToolBudget = status === 'TOOL_CALL_BUDGET_EXHAUSTED';
      if (!allowedByNoNewEvidenceLimit && !allowedByToolBudget) invalid();
    }
    return exchange as RagToolExchange;
  });
  if (exchanges.some((exchange, index) => exchange.sequence !== index + 1)
    || new Set(exchanges.map((exchange) => exchange.toolCallId)).size
      !== exchanges.length) invalid();
  return exchanges;
}

function decodeRagToolPhysicalAttempts(value: unknown): RagToolPhysicalAttempt[] {
  const attempts = array(value, 4).map((attemptValue) => {
    const attempt = record(attemptValue, [
      'attempt', 'status', 'toolMessage', 'retryScheduled',
      'startedAt', 'completedAt', 'durationMs'
    ]);
    integer(attempt.attempt, 1, 4);
    const status = text(attempt.status, 128);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(status)) invalid();
    text(attempt.toolMessage, 100_000);
    bool(attempt.retryScheduled);
    const startedAt = isoDate(attempt.startedAt);
    const completedAt = isoDate(attempt.completedAt);
    if (Date.parse(completedAt) < Date.parse(startedAt)) invalid();
    integer(attempt.durationMs, 0, 86_400_000);
    return attempt as RagToolPhysicalAttempt;
  });
  if (attempts.some((attempt, index) => (
    attempt.attempt !== index + 1
    || attempt.retryScheduled !== (index < attempts.length - 1)
  ))) invalid();
  return attempts;
}

function decodeRagToolValidatedInput(value: unknown): void {
  if (value === null) return;
  const input = recordWithOptional(value, [], [
    'owner_fqn', 'method_name', 'jvm_descriptor', 'source_line', 'query', 'cursor',
    'diagnostic_ids', 'diagnostic_id'
  ]);
  if (Object.keys(input).length === 0) invalid();
  const diagnosticId = (value: unknown): string => {
    const id = text(value, 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) invalid();
    return id;
  };
  if (input.diagnostic_ids !== undefined) {
    const ids = array(input.diagnostic_ids, 32).map(diagnosticId);
    if (ids.length === 0 || new Set(ids).size !== ids.length || input.cursor !== undefined) invalid();
  }
  if (input.diagnostic_id !== undefined) diagnosticId(input.diagnostic_id);
  const ownerFqn = input.owner_fqn === undefined
    ? undefined
    : text(input.owner_fqn, 2_000, 3);
  const methodName = input.method_name === undefined
    ? undefined
    : text(input.method_name, 1_024);
  const descriptor = input.jvm_descriptor === undefined
    ? undefined
    : text(input.jvm_descriptor, 32_768, 3);
  if ((methodName === undefined) !== (descriptor === undefined)) invalid();
  if (methodName !== undefined && ownerFqn === undefined) invalid();
  if (input.source_line !== undefined) {
    integer(input.source_line, 1, 10_000_000);
    if (ownerFqn === undefined) invalid();
  }
  if (input.query !== undefined) text(input.query, 4_000);
  if (input.cursor !== undefined) text(input.cursor, 16_384, 16);
  if (ownerFqn === undefined && input.query === undefined && input.cursor === undefined
    && input.diagnostic_ids === undefined) invalid();
  if (descriptor !== undefined
    && (!descriptor.startsWith('(') || !descriptor.includes(')'))) invalid();
}

export function decodeMethodGenerationEvent(
  value: unknown,
  options: {
    expectedSessionId?: string;
    previousEventSequence: number;
    identity?: MethodGenerationIdentity;
  }
): MethodGenerationSessionEvent {
  try {
    const item = record(value, [
      'sessionId', 'eventSequence', 'eventType', 'occurredAt', 'progress',
      'candidate', 'completion', 'modelCall', 'error'
    ]);
    const sessionId = uuid(item.sessionId);
    if (options.expectedSessionId && sessionId !== options.expectedSessionId) invalid();
    const eventSequence = integer(item.eventSequence, 1, 1_000_000_000);
    if (eventSequence <= options.previousEventSequence) invalid();
    const eventType = member(item.eventType, EVENT_TYPES);
    isoDate(item.occurredAt);
    const payloads = [item.progress, item.candidate, item.completion, item.modelCall, item.error];
    if (payloads.filter((payload) => payload !== null).length !== 1) invalid();
    const progress = eventType === 'progress'
      ? decodeProgress(item.progress, options.identity)
      : null;
    const candidate = eventType === 'candidate_ready'
      ? decodeCandidate(item.candidate, options.identity)
      : null;
    const completion = eventType === 'completed'
      ? decodeCompletion(item.completion, options.identity)
      : null;
    const modelCall = eventType === 'model_call'
      ? decodeModelCall(item.modelCall, sessionId, options.identity)
      : null;
    const error = eventType === 'error' ? decodeFailure(item.error) : null;
    if ((eventType !== 'progress' && item.progress !== null)
      || (eventType !== 'candidate_ready' && item.candidate !== null)
      || (eventType !== 'completed' && item.completion !== null)
      || (eventType !== 'model_call' && item.modelCall !== null)
      || (eventType !== 'error' && item.error !== null)) invalid();
    return {
      sessionId,
      eventSequence,
      eventType,
      occurredAt: item.occurredAt as string,
      progress,
      candidate,
      completion,
      modelCall,
      error
    };
  } catch {
    invalid();
  }
}

function inferIdentity(
  value: UnknownRecord,
  supplied?: MethodGenerationIdentity
): MethodGenerationIdentity | undefined {
  let identity = supplied;
  const mergeCandidate = (candidateValue: unknown): void => {
    if (!candidateValue || typeof candidateValue !== 'object' || Array.isArray(candidateValue)) return;
    const candidate = candidateValue as UnknownRecord;
    if (typeof candidate.methodId === 'string' && typeof candidate.batchId === 'string') {
      identity = mergeIdentity(identity, {
        methodId: sha256(candidate.methodId),
        batchId: sha256(candidate.batchId),
        batchIndex: typeof candidate.batchIndex === 'number'
          ? integer(candidate.batchIndex, 1, 10_000)
          : undefined,
        outputTestClassName: typeof candidate.outputTestClassName === 'string'
          ? text(candidate.outputTestClassName, 512)
          : undefined,
        plannedTestMethods: typeof candidate.ordinaryTestMethodCount === 'number'
          ? integer(
            candidate.ordinaryTestMethodCount,
            1,
            MAX_METHOD_GENERATION_SESSION_TEST_METHODS
          )
          : undefined
      });
    }
  };
  const mergeCompletion = (completionValue: unknown): void => {
    if (!completionValue || typeof completionValue !== 'object' || Array.isArray(completionValue)) return;
    const completion = completionValue as UnknownRecord;
    if (typeof completion.methodId === 'string' && typeof completion.batchId === 'string') {
      identity = mergeIdentity(identity, {
        methodId: sha256(completion.methodId),
        batchId: sha256(completion.batchId)
      });
    }
  };
  mergeCandidate(value.pendingCandidate);
  mergeCompletion(value.completion);
  if (Array.isArray(value.events)) {
    for (const eventValue of value.events) {
      if (!eventValue || typeof eventValue !== 'object' || Array.isArray(eventValue)) continue;
      const event = eventValue as UnknownRecord;
      mergeCandidate(event.candidate);
      mergeCompletion(event.completion);
      if (event.modelCall && typeof event.modelCall === 'object' && !Array.isArray(event.modelCall)) {
        const modelCall = event.modelCall as UnknownRecord;
        if (typeof modelCall.methodId === 'string' && typeof modelCall.batchId === 'string') {
          identity = mergeIdentity(identity, {
            methodId: sha256(modelCall.methodId),
            batchId: sha256(modelCall.batchId),
            batchIndex: typeof modelCall.batchIndex === 'number'
              ? integer(modelCall.batchIndex, 1, 10_000)
              : undefined
          });
        }
      }
    }
  }
  return identity;
}

export function decodeMethodGenerationStatus(
  value: unknown,
  expectedSessionId: string,
  afterEventSequence: number,
  suppliedIdentity?: MethodGenerationIdentity
): MethodGenerationSessionStatus {
  try {
    const item = record(value, [
      'sessionId', 'phase', 'lastEventSequence', 'pendingCandidate', 'completion',
      'terminalError', 'events'
    ]);
    if (uuid(item.sessionId) !== expectedSessionId) invalid();
    const phase = member(item.phase, PHASES);
    const lastEventSequence = integer(item.lastEventSequence, 0, 1_000_000_000);
    if (lastEventSequence < afterEventSequence) invalid();
    const identity = inferIdentity(item, suppliedIdentity);
    const pendingCandidate = item.pendingCandidate === null
      ? null
      : decodeCandidate(item.pendingCandidate, identity);
    const completion = item.completion === null
      ? null
      : decodeCompletion(item.completion, identity);
    const terminalError = item.terminalError === null
      ? null
      : decodeFailure(item.terminalError);
    if ((phase === 'completed' || phase === 'cancelled') !== (completion !== null)
      || (phase === 'failed') !== (terminalError !== null)
      || (phase === 'starting' && pendingCandidate !== null)) invalid();
    const rawEvents = Array.isArray(item.events) ? item.events : invalid();
    if (rawEvents.length > 200) invalid();
    let previous = afterEventSequence;
    const events = rawEvents.map((eventValue) => {
      const decoded = decodeMethodGenerationEvent(eventValue, {
        expectedSessionId,
        previousEventSequence: previous,
        identity
      });
      previous = decoded.eventSequence;
      return decoded;
    });
    if (previous > lastEventSequence) invalid();
    return {
      sessionId: expectedSessionId,
      phase,
      lastEventSequence,
      pendingCandidate,
      completion,
      terminalError,
      events
    };
  } catch {
    invalid();
  }
}

export function decodeMethodGenerationAcknowledgement(
  value: unknown,
  expectedSessionId: string,
  expectedSequence: number
): MethodGenerationEventsAcknowledgement {
  try {
    const item = record(value, [
      'sessionId', 'acknowledgedThroughEventSequence', 'lastEventSequence'
    ]);
    if (uuid(item.sessionId) !== expectedSessionId) invalid();
    const acknowledged = integer(item.acknowledgedThroughEventSequence, 0);
    const last = integer(item.lastEventSequence, 0);
    if (acknowledged !== expectedSequence || acknowledged > last) invalid();
    return {
      sessionId: expectedSessionId,
      acknowledgedThroughEventSequence: acknowledged,
      lastEventSequence: last
    };
  } catch {
    invalid();
  }
}

function wavePartIdentity(
  identity: MethodGenerationWaveIdentity | undefined,
  partIndex: number
) {
  return identity?.parts.find((part) => part.partIndex === partIndex);
}

function decodeMethodGenerationWavePartResult(
  value: unknown,
  identity?: MethodGenerationWaveIdentity
): MethodGenerationWavePartResult {
  const item = recordWithOptional(value, [
    'partIndex', 'partBatchId', 'scenarioIds', 'status', 'childSessionId',
    'candidate', 'error'
  ], ['aggregateUsage', 'modelCallCount', 'usageReportedCallCount']);
  const partIndex = integer(item.partIndex, 1, 5);
  const partBatchId = sha256(item.partBatchId);
  const scenarioIds = uniqueStrings(item.scenarioIds, 5, 4_096, 1);
  const expected = wavePartIdentity(identity, partIndex);
  if (expected && (expected.partBatchId !== partBatchId
    || expected.scenarioIds.length !== scenarioIds.length
    || expected.scenarioIds.some((id, index) => scenarioIds[index] !== id))) invalid();
  const status = member(item.status, WAVE_PART_STATUSES);
  const childSessionId = item.childSessionId === null ? null : uuid(item.childSessionId);
  const candidate = item.candidate === null
    ? null
    : decodeCandidate(item.candidate, expected?.generationIdentity ?? {
        methodId: identity?.methodId ?? sha256((item.candidate as UnknownRecord).methodId),
        batchId: partBatchId
      });
  const error = item.error === null ? null : decodeFailure(item.error);
  const aggregateUsage = item.aggregateUsage === undefined ? null : item.aggregateUsage;
  usage(aggregateUsage);
  const modelCallCount = item.modelCallCount === undefined
    ? 0
    : integer(item.modelCallCount, 0);
  const usageReportedCallCount = item.usageReportedCallCount === undefined
    ? 0
    : integer(item.usageReportedCallCount, 0);
  if (usageReportedCallCount > modelCallCount) invalid();
  if (status === 'succeeded') {
    if (!childSessionId || !candidate || error) invalid();
  } else if (status === 'failed') {
    if (candidate || !error) invalid();
  } else if (childSessionId || candidate || error) invalid();
  return {
    partIndex,
    partBatchId,
    scenarioIds,
    status,
    childSessionId,
    candidate,
    error,
    aggregateUsage: aggregateUsage as ModelTokenUsage | null,
    modelCallCount,
    usageReportedCallCount
  };
}

function decodeMethodGenerationWaveCompletion(
  value: unknown,
  identity?: MethodGenerationWaveIdentity
): MethodGenerationWaveCompletion {
  const item = recordWithOptional(value, [
    'parts', 'succeededPartCount', 'failedPartCount', 'cancelledPartCount'
  ], ['aggregateUsage', 'modelCallCount', 'usageReportedCallCount']);
  const parts = array(item.parts, 5, 1).map((part) =>
    decodeMethodGenerationWavePartResult(part, identity));
  if (parts.some((part, index) => part.partIndex !== index + 1)) invalid();
  const succeededPartCount = integer(item.succeededPartCount, 0, 5);
  const failedPartCount = integer(item.failedPartCount, 0, 5);
  const cancelledPartCount = integer(item.cancelledPartCount, 0, 5);
  const aggregateUsage = item.aggregateUsage === undefined ? null : item.aggregateUsage;
  usage(aggregateUsage);
  const modelCallCount = item.modelCallCount === undefined
    ? 0
    : integer(item.modelCallCount, 0);
  const usageReportedCallCount = item.usageReportedCallCount === undefined
    ? 0
    : integer(item.usageReportedCallCount, 0);
  if (usageReportedCallCount > modelCallCount) invalid();
  if (succeededPartCount !== parts.filter((part) => part.status === 'succeeded').length
    || failedPartCount !== parts.filter((part) => part.status === 'failed').length
    || cancelledPartCount !== parts.filter((part) => part.status === 'cancelled').length
    || identity && parts.length !== identity.parts.length) invalid();
  const candidateIds = parts.flatMap((part) =>
    part.candidate ? [part.candidate.candidateId] : []);
  if (new Set(candidateIds).size !== candidateIds.length) invalid();
  return {
    parts,
    succeededPartCount,
    failedPartCount,
    cancelledPartCount,
    aggregateUsage: aggregateUsage as ModelTokenUsage | null,
    modelCallCount,
    usageReportedCallCount
  };
}

export function decodeMethodGenerationWaveEvent(
  value: unknown,
  options: {
    expectedWaveSessionId?: string;
    previousEventSequence: number;
    identity?: MethodGenerationWaveIdentity;
  }
): MethodGenerationWaveEvent {
  try {
    const item = record(value, [
      'waveSessionId', 'eventSequence', 'waveId', 'methodId', 'waveIndex',
      'eventType', 'occurredAt', 'partIndex', 'partBatchId', 'scenarioIds',
      'childSessionId', 'candidateId', 'childEvent', 'partResult',
      'completion', 'error'
    ]);
    const waveSessionId = uuid(item.waveSessionId);
    if (options.expectedWaveSessionId
      && options.expectedWaveSessionId !== waveSessionId) invalid();
    const eventSequence = integer(item.eventSequence, 1, 1_000_000_000);
    if (eventSequence <= options.previousEventSequence) invalid();
    const waveId = sha256(item.waveId);
    const methodId = sha256(item.methodId);
    const waveIndex = integer(item.waveIndex, 1, 10_000);
    if (options.identity && (
      options.identity.waveId !== waveId
      || options.identity.methodId !== methodId
      || options.identity.waveIndex !== waveIndex
    )) invalid();
    const eventType = member(item.eventType, WAVE_EVENT_TYPES);
    const occurredAt = isoDate(item.occurredAt);
    const isPartEvent = new Set([
      'part_started', 'part_event', 'part_succeeded', 'part_failed', 'part_cancelled'
    ]).has(eventType);
    const partIndex = item.partIndex === null ? null : integer(item.partIndex, 1, 5);
    const partBatchId = item.partBatchId === null ? null : sha256(item.partBatchId);
    const scenarioIds = uniqueStrings(item.scenarioIds, 5, 4_096, 0);
    if (isPartEvent !== (partIndex !== null && partBatchId !== null
      && scenarioIds.length > 0)) invalid();
    const expectedPart = partIndex === null
      ? undefined
      : wavePartIdentity(options.identity, partIndex);
    if (expectedPart && (expectedPart.partBatchId !== partBatchId
      || expectedPart.scenarioIds.some((id, index) => scenarioIds[index] !== id)
      || expectedPart.scenarioIds.length !== scenarioIds.length)) invalid();
    const childSessionId = item.childSessionId === null ? null : uuid(item.childSessionId);
    const candidateId = item.candidateId === null ? null : uuid(item.candidateId);
    const childEvent = item.childEvent === null
      ? null
      : decodeMethodGenerationEvent(item.childEvent, {
          expectedSessionId: childSessionId ?? undefined,
          previousEventSequence: 0,
          identity: expectedPart?.generationIdentity
        });
    const partResult = item.partResult === null
      ? null
      : decodeMethodGenerationWavePartResult(item.partResult, options.identity);
    const completion = item.completion === null
      ? null
      : decodeMethodGenerationWaveCompletion(item.completion, options.identity);
    const error = item.error === null ? null : decodeFailure(item.error);
    const payloadCount = [childEvent, partResult, completion, error]
      .filter((payload) => payload !== null).length;
    if (eventType === 'wave_started' || eventType === 'part_started') {
      if (payloadCount !== 0) invalid();
    } else if (payloadCount !== 1) invalid();
    if ((eventType === 'part_event') !== (childEvent !== null)
      || (eventType === 'part_succeeded' || eventType === 'part_failed'
        || eventType === 'part_cancelled') !== (partResult !== null)
      || (eventType === 'wave_completed' || eventType === 'wave_cancelled')
        !== (completion !== null)
      || (eventType === 'error') !== (error !== null)) invalid();
    if (partResult && (partResult.partIndex !== partIndex
      || partResult.partBatchId !== partBatchId
      || partResult.scenarioIds.some((id, index) => scenarioIds[index] !== id)
      || partResult.childSessionId !== childSessionId
      || (partResult.candidate?.candidateId ?? null) !== candidateId
      || eventType === 'part_succeeded' && partResult.status !== 'succeeded'
      || eventType === 'part_failed' && partResult.status !== 'failed'
      || eventType === 'part_cancelled' && partResult.status !== 'cancelled')) invalid();
    if (childEvent && childEvent.sessionId !== childSessionId) invalid();
    return {
      waveSessionId,
      eventSequence,
      waveId,
      methodId,
      waveIndex,
      eventType,
      occurredAt,
      partIndex,
      partBatchId,
      scenarioIds,
      childSessionId,
      candidateId,
      childEvent,
      partResult,
      completion,
      error
    };
  } catch {
    invalid();
  }
}

export function decodeMethodGenerationWaveStatus(
  value: unknown,
  expectedWaveSessionId: string,
  afterEventSequence: number,
  identity?: MethodGenerationWaveIdentity
): MethodGenerationWaveStatus {
  try {
    const item = record(value, [
      'waveSessionId', 'waveId', 'methodId', 'waveIndex', 'phase',
      'lastEventSequence', 'terminalParts', 'completion', 'terminalError', 'events'
    ]);
    if (uuid(item.waveSessionId) !== expectedWaveSessionId) invalid();
    const waveId = sha256(item.waveId);
    const methodId = sha256(item.methodId);
    const waveIndex = integer(item.waveIndex, 1, 10_000);
    if (identity && (identity.waveId !== waveId || identity.methodId !== methodId
      || identity.waveIndex !== waveIndex)) invalid();
    const phase = member(item.phase, PHASES);
    const lastEventSequence = integer(item.lastEventSequence, 0, 1_000_000_000);
    if (lastEventSequence < afterEventSequence) invalid();
    const terminalParts = array(item.terminalParts, 5).map((part) =>
      decodeMethodGenerationWavePartResult(part, identity));
    if (terminalParts.some((part, index) => index > 0
      && part.partIndex <= terminalParts[index - 1].partIndex)) invalid();
    const completion = item.completion === null
      ? null
      : decodeMethodGenerationWaveCompletion(item.completion, identity);
    const terminalError = item.terminalError === null ? null : decodeFailure(item.terminalError);
    if ((phase === 'completed' || phase === 'cancelled') !== (completion !== null)
      || (phase === 'failed') !== (terminalError !== null)) invalid();
    let previous = afterEventSequence;
    const events = array(item.events, 200).map((raw) => {
      const decoded = decodeMethodGenerationWaveEvent(raw, {
        expectedWaveSessionId,
        previousEventSequence: previous,
        identity
      });
      previous = decoded.eventSequence;
      return decoded;
    });
    if (previous > lastEventSequence) invalid();
    return {
      waveSessionId: expectedWaveSessionId,
      waveId,
      methodId,
      waveIndex,
      phase,
      lastEventSequence,
      terminalParts,
      completion,
      terminalError,
      events
    };
  } catch {
    invalid();
  }
}

export function decodeMethodGenerationWaveAcknowledgement(
  value: unknown,
  expectedWaveSessionId: string,
  expectedSequence: number
): MethodGenerationWaveEventsAcknowledgement {
  try {
    const item = record(value, [
      'waveSessionId', 'acknowledgedThroughEventSequence', 'lastEventSequence'
    ]);
    if (uuid(item.waveSessionId) !== expectedWaveSessionId) invalid();
    const acknowledged = integer(item.acknowledgedThroughEventSequence, 0);
    const lastEventSequence = integer(item.lastEventSequence, 0);
    if (acknowledged !== expectedSequence || acknowledged > lastEventSequence) invalid();
    return {
      waveSessionId: expectedWaveSessionId,
      acknowledgedThroughEventSequence: acknowledged,
      lastEventSequence
    };
  } catch {
    invalid();
  }
}

export function validateStartMethodGenerationWaveRequest(
  request: StartMethodGenerationWaveRequest
): MethodGenerationWaveIdentity {
  try {
    const item = record(request, ['waveId', 'methodId', 'waveIndex', 'parts']);
    const waveId = sha256(item.waveId);
    const methodId = sha256(item.methodId);
    const waveIndex = integer(item.waveIndex, 1, 10_000);
    const seenScenarios = new Set<string>();
    let classTaskId = '';
    const parts = array(item.parts, 5, 1).map((raw, index) => {
      const part = record(raw, ['partIndex', 'partBatchId', 'scenarioIds', 'request']);
      const partIndex = integer(part.partIndex, 1, 5);
      if (partIndex !== index + 1) invalid();
      const partBatchId = sha256(part.partBatchId);
      const scenarioIds = uniqueStrings(part.scenarioIds, 5, 4_096, 1);
      if (scenarioIds.some((id) => seenScenarios.has(id))) invalid();
      scenarioIds.forEach((id) => seenScenarios.add(id));
      const start = part.request as StartMethodGenerationSessionRequest;
      const generationIdentity = validateStartMethodGenerationRequest(start);
      if (start.ragContext !== undefined || generationIdentity.ragEnabled
        || generationIdentity.methodId !== methodId
        || generationIdentity.batchId !== partBatchId) invalid();
      const requestScenarios = 'methodSlices' in start.batch
        ? start.batch.methodSlices.flatMap((slice) => (
            slice.batch.scenarios.map((scenario) => scenario.scenarioId)
          ))
        : start.batch.scenarios.map((scenario) => scenario.scenarioId);
      if (requestScenarios.length !== scenarioIds.length
        || requestScenarios.some((id, scenarioIndex) => scenarioIds[scenarioIndex] !== id)) {
        invalid();
      }
      const currentClassTaskId = uuid(start.classTaskId);
      if (classTaskId && currentClassTaskId !== classTaskId) invalid();
      classTaskId = currentClassTaskId;
      return {
        partIndex,
        partBatchId,
        scenarioIds,
        generationIdentity
      };
    });
    if (new Set(parts.map((part) => part.partBatchId)).size !== parts.length) invalid();
    return { waveId, methodId, waveIndex, parts };
  } catch {
    invalid();
  }
}

export function validateRecoverMethodGenerationWaveRequest(
  request: RecoverMethodGenerationWaveRequest
): MethodGenerationWaveIdentity {
  try {
    uuid(request.recoveryRequestId);
    const identity = validateStartMethodGenerationWaveRequest(request.startRequest);
    integer(request.lastAcknowledgedEventSequence, 0, 1_000_000_000);
    const terminalParts = array(request.terminalParts, 5).map((part) =>
      decodeMethodGenerationWavePartResult(part, identity));
    if (terminalParts.some((part, index) => part.status === 'cancelled'
      || index > 0 && part.partIndex <= terminalParts[index - 1].partIndex)) invalid();
    return identity;
  } catch {
    invalid();
  }
}

export function validateStartMethodGenerationRequest(
  request: StartMethodGenerationSessionRequest
): MethodGenerationIdentity {
  try {
    uuid(request.clientRequestId);
    uuid(request.classTaskId);
    const methodId = sha256(request.methodId);
    const batchId = sha256(request.batchId);
    const batchIndex = integer(request.batchIndex, 1, 10_000);
    const unlimitedRepair = bool(request.unlimitedRepair);
    if (unlimitedRepair) {
      if (request.repairAttemptLimit !== null) invalid();
    } else {
      integer(request.repairAttemptLimit, 1);
    }
    const outputTestClassName = text(request.outputTestClassName, 512);
    if (!/^[A-Za-z_$][\w$]*$/.test(outputTestClassName)) invalid();
    const expectedPackageName = text(request.expectedPackageName, 512, 0);
    if (expectedPackageName && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(
      expectedPackageName
    )) invalid();
    text(request.buildToolchain.javaVersion, 128);
    text(request.buildToolchain.mavenVersion, 128);
    bool(request.captureModelCalls);
    if (request.ragContext !== undefined) {
      validateRagRepairContext(request.ragContext);
    }
    if (!request.batch.hasWork || request.batch.methodId !== methodId
      || request.batch.batchId !== batchId) invalid();
    return {
      methodId,
      batchId,
      batchIndex,
      outputTestClassName,
      plannedTestMethods: integer(
        request.batch.plannedTestMethods,
        1,
        MAX_METHOD_GENERATION_SESSION_TEST_METHODS
      ),
      ragEnabled: request.ragContext !== undefined
    };
  } catch {
    invalid();
  }
}

export function validateRecoverMethodGenerationRequest(
  request: RecoverMethodGenerationSessionRequest
): MethodGenerationIdentity {
  try {
    const identity = validateStartMethodGenerationRequest(request.startRequest);
    decodeCandidate(request.candidate, identity);
    return identity;
  } catch {
    invalid();
  }
}

function validateExecutionFeedback(value: unknown): CandidateExecutionFeedback {
  const item = recordWithOptional(value, ['status', 'mavenExecutions'], ['testReport']);
  const status = member(item.status, new Set<CandidateExecutionFeedback['status']>([
    'compile_failed', 'test_failed', 'passed'
  ]));
  const executions = array(item.mavenExecutions, 8, 1).map((executionValue) => {
    const execution = record(executionValue, [
      'scope', 'phase', 'command', 'exitCode', 'stdout', 'stderr', 'surefireReports'
    ]);
    const phase = member(execution.phase, new Set<MavenCommandEvidence['phase']>([
      'test_compile', 'test'
    ]));
    member(execution.scope, new Set<MavenCommandEvidence['scope']>([
      'method_candidate', 'pruned_method_candidate'
    ]));
    text(execution.command, 200_000);
    integer(execution.exitCode, -(2 ** 31), 2 ** 31 - 1);
    text(execution.stdout, 8_000_000, 0);
    text(execution.stderr, 8_000_000, 0);
    const reports = array(execution.surefireReports, 200).map((reportValue) => {
      const report = record(reportValue, ['fileName', 'content']);
      text(report.fileName, 4_096);
      text(report.content, 8_000_000);
      return report as SurefireReportArtifact;
    });
    if (phase === 'test_compile' && reports.length > 0) invalid();
    return execution as MavenCommandEvidence;
  });
  const last = executions.at(-1) as MavenCommandEvidence;
  if (status === 'compile_failed') {
    if (last.phase !== 'test_compile' || last.exitCode === 0 || item.testReport !== undefined) {
      invalid();
    }
  } else {
    if (!executions.some((execution) => (
      execution.phase === 'test_compile' && execution.exitCode === 0
    )) || last.phase !== 'test') invalid();
    if (status === 'passed' && (last.exitCode !== 0 || item.testReport === undefined)) invalid();
    if (status === 'test_failed' && last.exitCode === 0 && !(
      last.scope === 'pruned_method_candidate'
      && item.testReport === undefined
      && last.surefireReports.length === 0
    )) invalid();
  }
  if (item.testReport !== undefined) validateSurefireReport(item.testReport, status);
  return item as CandidateExecutionFeedback;
}

function validateSurefireReport(
  value: unknown,
  status: CandidateExecutionFeedback['status']
): void {
  const item = record(value, [
    'reportCount', 'tests', 'failures', 'errors', 'skipped',
    'generatedTestClassName', 'generatedTests', 'generatedSkipped', 'failureDetails'
  ]);
  integer(item.reportCount, 1, 200);
  const tests = integer(item.tests, 1, 1_000_000);
  const failures = integer(item.failures, 0, 1_000_000);
  const errors = integer(item.errors, 0, 1_000_000);
  const skipped = integer(item.skipped, 0, 1_000_000);
  text(item.generatedTestClassName, 512);
  const generatedTests = integer(item.generatedTests, 1, 1_000_000);
  const generatedSkipped = integer(item.generatedSkipped, 0, 1_000_000);
  if (failures + errors + skipped > tests
    || generatedTests > tests || generatedSkipped > generatedTests) invalid();
  const details = array(item.failureDetails, 20).map((detailValue) => {
    const detail = recordWithOptional(detailValue, [
      'suiteName', 'testClassName', 'testName', 'kind'
    ], ['type', 'message', 'detail']);
    text(detail.suiteName, 512);
    text(detail.testClassName, 512);
    text(detail.testName, 512);
    member(detail.kind, new Set(['failure', 'error']));
    for (const [key, maximum] of [['type', 512], ['message', 1_000], ['detail', 2_000]] as const) {
      if (detail[key] !== undefined && detail[key] !== null) text(detail[key], maximum, 0);
    }
    return detail;
  });
  if (details.filter((detail) => detail.kind === 'failure').length > failures
    || details.filter((detail) => detail.kind === 'error').length > errors) invalid();
  if (status === 'passed' && (
    failures !== 0 || errors !== 0 || generatedTests <= generatedSkipped
  )) invalid();
  if (status === 'test_failed' && failures + errors === 0) invalid();
}

function validateRepairMethod(value: unknown): RepairMethodSource {
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
  stringList(item.modifiers, 256, 128);
  const firstLine = integer(item.firstLine, 1, 2 ** 31 - 1);
  const lastLine = integer(item.lastLine, 1, 2 ** 31 - 1);
  const sourceFirstLine = integer(item.sourceFirstLine, 1, 2 ** 31 - 1);
  const sourceLastLine = integer(item.sourceLastLine, 1, 2 ** 31 - 1);
  const sourceComplete = bool(item.sourceComplete);
  if (lastLine < firstLine || sourceFirstLine < firstLine
    || sourceLastLine > lastLine || sourceLastLine < sourceFirstLine
    || sourceLastLine - sourceFirstLine + 1 > 300
    || (sourceComplete
      && (sourceFirstLine !== firstLine || sourceLastLine !== lastLine))) invalid();
  text(item.sourceText, 1_000_000);
  stringList(item.parameterTypes, 256, 2_000);
  text(item.returnType, 2_000);
  stringList(item.declaredExceptions, 256, 2_000);
  return item as RepairMethodSource;
}

function validateStackFrame(value: unknown): void {
  const item = record(value, ['ownerFqn', 'methodName', 'sourceFile', 'sourceLine']);
  text(item.ownerFqn, 2_000);
  text(item.methodName, 1_024);
  text(item.sourceFile, 4_096);
  integer(item.sourceLine, 1, 2 ** 31 - 1);
}

function validateRepairContext(
  value: unknown,
  executionStatus: CandidateExecutionFeedback['status']
): MethodGenerationRepairContext {
  const item = record(value, [
    'status', 'compilerErrors', 'affectedTestNames', 'exceptions',
    'generatedTestFrames', 'productionFrames', 'missingSymbols',
    'relatedTypeFqns', 'truncated', 'droppedItemCount', 'analyzerStatus',
    'analyzerWarnings', 'sourceSha256', 'targetMethod', 'stackMethods',
    'referencedTypes'
  ]);
  const status = member(item.status, new Set(['compile_failed', 'test_failed']));
  if (status !== executionStatus) invalid();
  array(item.compilerErrors, 32).forEach((errorValue) => {
    const error = record(errorValue, ['filePath', 'line', 'column', 'category', 'message']);
    text(error.filePath, 32_767);
    integer(error.line, 1, 2 ** 31 - 1);
    integer(error.column, 1, 2 ** 31 - 1);
    const category = text(error.category, 128);
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(category)) invalid();
    text(error.message, 4_000);
  });
  uniqueStrings(item.affectedTestNames, 32, 512);
  array(item.exceptions, 20).forEach((exceptionValue) => {
    const exception = record(exceptionValue, [
      'testName', 'testLocation', 'type', 'message', 'failingLocation',
      'failingStatement', 'stackFrames'
    ]);
    if (exception.testName !== null) text(exception.testName, 512);
    if (exception.testLocation !== null) validateStackFrame(exception.testLocation);
    text(exception.type, 2_000);
    text(exception.message, 2_000, 0);
    if (exception.failingLocation !== null) validateStackFrame(exception.failingLocation);
    if (exception.failingStatement !== null) text(exception.failingStatement, 4_000);
    array(exception.stackFrames, 12).forEach(validateStackFrame);
  });
  array(item.generatedTestFrames, 32).forEach(validateStackFrame);
  array(item.productionFrames, 32).forEach(validateStackFrame);
  uniqueStrings(item.missingSymbols, 64, 1_024);
  uniqueStrings(item.relatedTypeFqns, 64, 2_000);
  const truncated = bool(item.truncated);
  const droppedItemCount = integer(item.droppedItemCount, 0, 1_000_000);
  if (truncated !== (droppedItemCount > 0)) invalid();
  member(item.analyzerStatus, new Set(['available', 'fallback']));
  uniqueStrings(item.analyzerWarnings, 64, 2_000);
  sha256(item.sourceSha256);
  const targetMethod = validateRepairMethod(item.targetMethod);
  const stackMethods = array(
    item.stackMethods,
    MAX_METHOD_REPAIR_CONTEXT_METHODS - 1
  ).map(validateRepairMethod);
  const methodIds = [targetMethod.methodId, ...stackMethods.map((method) => method.methodId)];
  if (new Set(methodIds).size !== methodIds.length
    || stackMethods.some((method) => method.declaringType !== targetMethod.declaringType)) invalid();
  array(item.referencedTypes, 64).forEach((typeValue) => {
    const hasMethodContracts = typeValue !== null && typeof typeValue === 'object'
      && Object.prototype.hasOwnProperty.call(typeValue, 'methodContracts');
    const type = record(typeValue, [
      'qualifiedName', 'kind', 'constructors', 'methods', 'enumConstants',
      ...(hasMethodContracts ? ['methodContracts'] : [])
    ]);
    text(type.qualifiedName, 2_000);
    member(type.kind, new Set(['CLASS', 'INTERFACE', 'ENUM', 'RECORD']));
    uniqueStrings(type.constructors, 256, 4_000);
    const methods = uniqueStrings(type.methods, 256, 4_000);
    uniqueStrings(type.enumConstants, 256, 1_024);
    if (hasMethodContracts) {
      let documentationLength = 0;
      const signatures = array(type.methodContracts, Math.min(16, methods.length))
        .map((contractValue) => {
          const contract = record(contractValue, ['signature', 'documentation']);
          const signature = text(contract.signature, 4_000);
          documentationLength += text(contract.documentation, 1_600).length;
          if (!methods.includes(signature)) invalid();
          return signature;
        });
      if (documentationLength > 8_000 || new Set(signatures).size !== signatures.length) {
        invalid();
      }
    }
  });
  return item as MethodGenerationRepairContext;
}

function validateCandidateRejection(value: unknown): CandidateRejectionFeedback {
  const item = record(value, [
    'acceptedTestCode', 'acceptedFileSha256', 'violationCodes', 'memberNames', 'message'
  ]);
  const code = text(item.acceptedTestCode, 1_000_000);
  if (sha256(item.acceptedFileSha256)
    !== createHash('sha256').update(code, 'utf8').digest('hex')) invalid();
  uniqueStrings(item.violationCodes, 32, 128, 1, /^[A-Z][A-Z0-9_]{0,127}$/);
  uniqueStrings(item.memberNames, 64, 1_024);
  text(item.message, 2_000);
  return item as CandidateRejectionFeedback;
}

export function validatePrepareRagRepairRequest(
  value: unknown
): PrepareRagRepairRequest {
  try {
    const item = recordWithOptional(value, [
      'expectedEventSequence', 'candidateId', 'candidateVersion', 'repairAttempt',
      'methodId', 'batchId', 'batchIndex', 'effectiveTestCode',
      'effectiveFileSha256', 'execution'
    ], ['repairContext']);
    const expectedEventSequence = integer(item.expectedEventSequence, 1, 1_000_000_000);
    const candidateId = uuid(item.candidateId);
    const candidateVersion = integer(item.candidateVersion, 1);
    const repairAttempt = integer(item.repairAttempt, 0);
    if (candidateVersion !== repairAttempt + 1) invalid();
    const methodId = sha256(item.methodId);
    const batchId = sha256(item.batchId);
    const batchIndex = integer(item.batchIndex, 1, 10_000);
    const effectiveTestCode = text(item.effectiveTestCode, 1_000_000);
    const effectiveFileSha256 = sha256(item.effectiveFileSha256);
    if (effectiveFileSha256
      !== createHash('sha256').update(effectiveTestCode, 'utf8').digest('hex')) invalid();
    const execution = validateExecutionFeedback(item.execution);
    const repairContext = item.repairContext === undefined
      ? undefined
      : validateRepairContext(item.repairContext, execution.status);
    return {
      expectedEventSequence,
      candidateId,
      candidateVersion,
      repairAttempt,
      methodId,
      batchId,
      batchIndex,
      effectiveTestCode,
      effectiveFileSha256,
      execution,
      ...(repairContext ? { repairContext } : {})
    };
  } catch {
    invalid();
  }
}

function validateRagRepairAttempt(value: unknown): RagRepairAttemptContext {
  const item = record(value, ['diagnosticFingerprint', 'activeIndex']);
  return {
    diagnosticFingerprint: sha256(item.diagnosticFingerprint),
    activeIndex: validateRagActiveIndexIdentity(item.activeIndex)
  };
}

export function validateResumeMethodGenerationRequest(
  request: ResumeMethodGenerationSessionRequest,
  identity?: MethodGenerationIdentity
): void {
  try {
    const item = recordWithOptional(request, [
      'feedbackId', 'expectedEventSequence', 'candidateId', 'candidateVersion',
      'repairAttempt', 'effectiveTestCode', 'effectiveFileSha256',
      'feedbackKind', 'execution'
    ], [
      'repairContext', 'candidateRejection', 'ragRepairAttempt', 'ragEmbeddingConfig'
    ]);
    uuid(item.feedbackId);
    uuid(item.candidateId);
    integer(item.expectedEventSequence, 1, 1_000_000_000);
    const version = integer(item.candidateVersion, 1);
    const attempt = integer(item.repairAttempt, 0);
    if (version !== attempt + 1) invalid();
    const code = text(item.effectiveTestCode, 1_000_000);
    if (sha256(item.effectiveFileSha256)
      !== createHash('sha256').update(code, 'utf8').digest('hex')) invalid();
    const feedbackKind = member(item.feedbackKind, new Set([
      'execution', 'candidate_rejected'
    ]));
    const execution = validateExecutionFeedback(item.execution);
    const ragRepairAttempt = item.ragRepairAttempt === undefined
      ? undefined
      : validateRagRepairAttempt(item.ragRepairAttempt);
    if (execution.status === 'passed') {
      if (feedbackKind !== 'execution'
        || item.repairContext !== undefined
        || item.candidateRejection !== undefined
        || ragRepairAttempt !== undefined
        || item.ragEmbeddingConfig !== undefined) invalid();
    } else {
      const repairContext = item.repairContext === undefined
        ? undefined
        : validateRepairContext(item.repairContext, execution.status);
      if (ragRepairAttempt !== undefined) {
        if (
          identity?.ragEnabled !== true
          || item.ragEmbeddingConfig === undefined
          || feedbackKind !== 'execution'
          || repairContext !== undefined
          || item.candidateRejection !== undefined
        ) invalid();
      } else if (item.ragEmbeddingConfig !== undefined) {
        invalid();
      } else if (feedbackKind === 'candidate_rejected') {
        if (!repairContext || item.candidateRejection === undefined) invalid();
        validateCandidateRejection(item.candidateRejection);
      } else if (item.candidateRejection !== undefined) {
        invalid();
      }
    }
  } catch {
    invalid();
  }
}

export class MethodGenerationStreamInterruptedError extends Error {
  readonly sessionId: string;
  readonly lastEventSequence: number;

  constructor(sessionId: string, lastEventSequence: number) {
    super('单方法生成连接中断，可从内部状态恢复。');
    this.name = 'MethodGenerationStreamInterruptedError';
    this.sessionId = sessionId;
    this.lastEventSequence = lastEventSequence;
  }
}

export class MethodGenerationSessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('单方法生成会话不存在，后端服务可能已经重启。');
    this.name = 'MethodGenerationSessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class MethodGenerationWaveStreamInterruptedError extends Error {
  readonly waveSessionId: string;
  readonly lastEventSequence: number;

  constructor(waveSessionId: string, lastEventSequence: number) {
    super('单方法 Wave 连接中断，可从内部状态恢复。');
    this.name = 'MethodGenerationWaveStreamInterruptedError';
    this.waveSessionId = waveSessionId;
    this.lastEventSequence = lastEventSequence;
  }
}

export class MethodGenerationWaveNotFoundError extends Error {
  readonly waveSessionId: string;

  constructor(waveSessionId: string) {
    super('单方法 Wave 会话不存在，后端服务可能已经重启。');
    this.name = 'MethodGenerationWaveNotFoundError';
    this.waveSessionId = waveSessionId;
  }
}
