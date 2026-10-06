import { createHash } from 'node:crypto';
import { validateExecutionFeedback, validateRepairContext, usage, decodeCompletion, decodeFailure, decodeModelCall,
  type MethodGenerationSessionEvent, type MethodGenerationSessionStatus,
  type MethodGenerationCompletion } from './method-generation-contract.ts';
import {
  validateInvocationPlan, validateFixturePlan, validateReferencedType,
  type InvocationPlan, type TargetFixturePlan, type ReferencedTypeApi
} from './method-analysis-contract.ts';
import type {
  StartMethodGenerationSessionRequest, MethodCandidate, CandidateExecutionFeedback, MethodGenerationRepairContext
} from './method-generation-contract.ts';
import type { MethodTestBundle } from './class-task-runner.service.ts';

export const FULL_SOURCE_SKILL_PROFILE = 'spring-boot-test-patterns-unit-v2';
export const FULL_SOURCE_SKILL_RULES_SHA256 = '83f64aa9a411c492fbf4b9d0142589fb545ac2d9087194c1d8205deead027894';
export type FullSourceSkillProfile = 'spring-boot-test-patterns-unit-v1' | typeof FULL_SOURCE_SKILL_PROFILE;
export type FullSourceDependencyCallFact = {
  receiverExpression: string; receiverType: string; declaringType: string; methodName: string;
  resolvedSignature: string; candidateSignatures: string[]; argumentExpressions: string[];
  argumentTypes: string[]; returnType: string; declaredExceptions: string[];
  status: 'READY' | 'PARTIAL' | 'ANALYSIS_FAILED';
};
export type FullSourceMethodFacts = {
  methodId: string; declaringType: string; methodName: string; descriptor: string;
  modifiers: string[]; completeMethodSource: string; parameterTypes: string[];
  returnType: string; declaredExceptions: string[]; invocationPlan: InvocationPlan;
  dependencyCalls: FullSourceDependencyCallFact[]; testMethodNamePrefix: string;
};
export type FullSourceClassFacts = {
  factsId: string; reportPairId: string; sourceSha256: string; declaringType: string;
  methods: FullSourceMethodFacts[]; targetFixturePlan: TargetFixturePlan;
  referencedTypes: ReferencedTypeApi[]; necessaryImports: string[];
  warnings: { code: string; message: string }[];
};
export type FullSourceClassBatchPayload = {
  kind: 'full_source'; contractVersion: 1; batchId: string; methodId: string;
  facts: FullSourceClassFacts; skillProfileId: FullSourceSkillProfile; skillRulesSha256: string;
};
export type FullSourceFactsRequest = { reportPairId: string; selectedMethodIds: string[] };
export type StartFullSourceGenerationSessionRequest = Omit<StartMethodGenerationSessionRequest, 'batch' | 'ragContext'> & {
  batch: FullSourceClassBatchPayload;
};
export type FullSourceCandidateResponse = MethodCandidate & { generationMode: 'FULL_SOURCE' };
export type OutputValidationFailureResponse = {
  generationMode: 'FULL_SOURCE'; candidateId: string; candidateVersion: number; repairAttempt: number;
  invalidOutput: string; invalidOutputSha256: string; validationErrors: { code: string; message: string }[];
};
export type ResumeFullSourceGenerationSessionRequest = {
  feedbackId: string; expectedEventSequence: number; candidateId: string; candidateVersion: number; repairAttempt: number;
} & ({ feedbackKind: 'output_validation'; invalidOutput: string; invalidOutputSha256: string;
  validationErrors: { code: string; message: string }[];
} | { feedbackKind: 'maven'; effectiveTestCode: string; effectiveFileSha256: string;
  execution: CandidateExecutionFeedback; repairContext?: MethodGenerationRepairContext;
});
export type FullSourceMethodOutcome = {
  methodId: string; passedTestNames: string[]; retainedFailureMembers: string[];
  deletedTests: { testName: string; reason: string; evidencePath: string }[];
  status: 'PASSED' | 'RETAINED_FAILURE' | 'NO_VALID_TEST';
};
export type FullSourceExecutionOutcome = {
  candidateIds: string[]; bundles: MethodTestBundle[]; methodOutcomes: FullSourceMethodOutcome[];
  terminalStatus: 'PASSED' | 'RETAINED_FAILURE' | 'FAILED';
};
export type FullSourceGenerationEvent = Omit<MethodGenerationSessionEvent, 'eventType' | 'candidate'> & {
  eventType: MethodGenerationSessionEvent['eventType'] | 'output_invalid';
  candidate: FullSourceCandidateResponse | null; outputInvalid: OutputValidationFailureResponse | null;
};
export type FullSourceGenerationStatus = Omit<MethodGenerationSessionStatus, 'events' | 'pendingCandidate'> & {
  pendingCandidate: FullSourceCandidateResponse | null;
  pendingOutputInvalid: OutputValidationFailureResponse | null; events: FullSourceGenerationEvent[];
};
export type FullSourceGenerationTurn = { sessionId: string; eventSequence: number } & (
  { kind: 'candidate_ready'; candidate: FullSourceCandidateResponse }
  | { kind: 'output_invalid'; outputInvalid: OutputValidationFailureResponse }
  | { kind: 'completed'; completion: MethodGenerationCompletion });
export type FullSourceProgressHandler = (event: FullSourceGenerationEvent) => void | Promise<void>;

const invalid = (): never => { throw new TypeError('完整源码生成契约无效。'); };
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some(key => !(key in item))) invalid();
  return item;
}
function text(value: unknown, max = 4000, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) invalid();
  return value as string;
}
function digest(value: unknown): string {
  if (!/^[0-9a-f]{64}$/.test(text(value, 64))) invalid();
  return value as string;
}
function array(value: unknown, max = 20000, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  return value as unknown[];
}
function strings(value: unknown, max = 20000): string[] { return array(value, max).map(v => text(v)); }

export function validateFullSourceFacts(value: unknown, expected?: {
  reportPairId: string; methodIds: readonly string[];
}): FullSourceClassFacts {
  const item = record(value, ['factsId','reportPairId','sourceSha256','declaringType','methods',
    'targetFixturePlan','referencedTypes','necessaryImports','warnings']);
  digest(item.factsId); digest(item.reportPairId); digest(item.sourceSha256); text(item.declaringType, 2000);
  const methods = array(item.methods, 20000, 1).map((raw, i) => {
    const method = record(raw, ['methodId','declaringType','methodName','descriptor','modifiers',
      'completeMethodSource','parameterTypes','returnType','declaredExceptions','invocationPlan',
      'dependencyCalls','testMethodNamePrefix']);
    digest(method.methodId); text(method.methodName, 1024); text(method.descriptor);
    if (method.declaringType !== item.declaringType || method.testMethodNamePrefix !== `m${i + 1}_`) invalid();
    text(method.completeMethodSource, 1_000_000); text(method.returnType, 2000);
    strings(method.modifiers, 256); strings(method.parameterTypes, 256); strings(method.declaredExceptions, 256);
    validateInvocationPlan(method.invocationPlan);
    for (const rawCall of array(method.dependencyCalls)) {
      const call = record(rawCall, ['receiverExpression','receiverType','declaringType','methodName',
        'resolvedSignature','candidateSignatures','argumentExpressions','argumentTypes','returnType',
        'declaredExceptions','status']);
      for (const key of ['receiverExpression','receiverType','declaringType','methodName','resolvedSignature','returnType']) {
        text(call[key], 20000, 0);
      }
      for (const key of ['candidateSignatures','argumentExpressions','declaredExceptions']) strings(call[key]);
      // Analyzer uses an empty entry for an unresolved argument type. Preserve
      // its position and uncertainty instead of rejecting or guessing the fact.
      array(call.argumentTypes).forEach(value => text(value, 4000, 0));
      if (!['READY','PARTIAL','ANALYSIS_FAILED'].includes(call.status as string)) invalid();
    }
    return method as FullSourceMethodFacts;
  });
  if (new Set(methods.map(m => m.methodId)).size !== methods.length) invalid();
  const fixture = validateFixturePlan(item.targetFixturePlan);
  if (fixture.targetClass !== item.declaringType) invalid();
  const types = array(item.referencedTypes).map(validateReferencedType);
  if (new Set(types.map(t => t.qualifiedName)).size !== types.length) invalid();
  strings(item.necessaryImports);
  for (const raw of array(item.warnings)) {
    const issue = record(raw, ['code', 'message']); text(issue.code, 256); text(issue.message, 2000);
  }
  if (expected && (item.reportPairId !== expected.reportPairId || methods.length !== expected.methodIds.length
    || methods.some((m, i) => m.methodId !== expected.methodIds[i]))) invalid();
  return structuredClone(value) as FullSourceClassFacts;
}

export function validateFullSourceBatch(value: unknown): FullSourceClassBatchPayload {
  const item = record(value, ['kind','contractVersion','batchId','methodId','facts','skillProfileId','skillRulesSha256']);
  if (item.kind !== 'full_source' || item.contractVersion !== 1
    || !['spring-boot-test-patterns-unit-v1', FULL_SOURCE_SKILL_PROFILE].includes(item.skillProfileId as string)) invalid();
  digest(item.skillRulesSha256);
  const facts = validateFullSourceFacts(item.facts);
  if (item.batchId !== facts.factsId || item.methodId !== facts.methods[0].methodId) invalid();
  return structuredClone(value) as FullSourceClassBatchPayload;
}

export function validateFullSourceFactsRequest(value: FullSourceFactsRequest): void {
  const item = record(value, ['reportPairId','selectedMethodIds']); digest(item.reportPairId);
  const ids = array(item.selectedMethodIds, 20000, 1).map(digest);
  if (new Set(ids).size !== ids.length) invalid();
}

export function sourceSha256(source: string): string { return createHash('sha256').update(source, 'utf8').digest('hex'); }

function integer(value: unknown, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid();
  return value as number;
}
function uuid(value: unknown): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text(value))) invalid();
  return value as string;
}
export function decodeFullSourceCandidate(value: unknown): FullSourceCandidateResponse {
  const item = record(value, ['generationMode','candidateId','candidateVersion','repairAttempt','methodId',
    'batchId','batchIndex','testCode','generatedCodeSha256','outputTestClassName','ordinaryTestMethodCount','usage']);
  if (item.generationMode !== 'FULL_SOURCE') invalid();
  uuid(item.candidateId); digest(item.methodId); digest(item.batchId);
  if (integer(item.candidateVersion, 1) !== integer(item.repairAttempt, 0) + 1) invalid();
  if (integer(item.batchIndex, 1) > 10000) invalid();
  integer(item.ordinaryTestMethodCount, 1);
  if (!/^[A-Za-z_$][\w$]*$/.test(text(item.outputTestClassName, 512))) invalid();
  if (sourceSha256(text(item.testCode, 1_000_000)) !== digest(item.generatedCodeSha256)) invalid();
  usage(item.usage);
  return structuredClone(value) as FullSourceCandidateResponse;
}
export function validateFullSourceFeedback(value: unknown): ResumeFullSourceGenerationSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const kind = (value as Record<string, unknown>).feedbackKind;
  const correction = kind === 'output_validation';
  if (!correction && kind !== 'maven') invalid();
  const item = record(value, ['feedbackId','expectedEventSequence','candidateId','candidateVersion','repairAttempt','feedbackKind',
    ...(correction ? ['invalidOutput','invalidOutputSha256','validationErrors']
      : ['effectiveTestCode','effectiveFileSha256','execution',
        ...(Object.prototype.hasOwnProperty.call(value, 'repairContext') ? ['repairContext'] : [])])]);
  uuid(item.feedbackId); uuid(item.candidateId); integer(item.expectedEventSequence, 1);
  if (integer(item.candidateVersion, 1) !== integer(item.repairAttempt, 0) + 1) invalid();
  if (correction) {
    if (sourceSha256(text(item.invalidOutput, 1_000_000, 0)) !== digest(item.invalidOutputSha256)) invalid();
    for (const raw of array(item.validationErrors, 20000, 1)) {
      const issue = record(raw, ['code','message']); text(issue.code, 256); text(issue.message, 2000);
    }
  } else {
    if (sourceSha256(text(item.effectiveTestCode, 1_000_000)) !== digest(item.effectiveFileSha256)) invalid();
    validateExecutionFeedback(item.execution);
    if (item.repairContext !== undefined) {
      const execution = item.execution as CandidateExecutionFeedback;
      if (execution.status === 'passed') invalid();
      validateRepairContext(item.repairContext, execution.status);
    }
  }
  return structuredClone(value) as ResumeFullSourceGenerationSessionRequest;
}

export function decodeFullSourceOutputFailure(value: unknown): OutputValidationFailureResponse {
  const item = record(value, ['generationMode','candidateId','candidateVersion','repairAttempt',
    'invalidOutput','invalidOutputSha256','validationErrors']);
  if (item.generationMode !== 'FULL_SOURCE') invalid();
  validateFullSourceFeedback({ feedbackId: '00000000-0000-4000-8000-000000000000', expectedEventSequence: 1,
    ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'generationMode')),
    feedbackKind: 'output_validation' });
  return structuredClone(value) as OutputValidationFailureResponse;
}

export function validateStartFullSourceRequest(value: unknown): StartFullSourceGenerationSessionRequest {
  const item = record(value, ['clientRequestId','classTaskId','methodId','batchId','batchIndex',
    'outputTestClassName','expectedPackageName','buildToolchain','batch','captureModelCalls',
    'repairAttemptLimit','unlimitedRepair']);
  uuid(item.clientRequestId); uuid(item.classTaskId); integer(item.batchIndex, 1);
  const batch = validateFullSourceBatch(item.batch);
  if (item.methodId !== batch.methodId || item.batchId !== batch.batchId) invalid();
  if (!/^[A-Za-z_$][\w$]*$/.test(text(item.outputTestClassName, 512))) invalid();
  if (!/^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?$/.test(text(item.expectedPackageName, 512, 0))) invalid();
  const toolchain = record(item.buildToolchain, ['javaVersion','mavenVersion']);
  text(toolchain.javaVersion, 128); text(toolchain.mavenVersion, 128);
  if (typeof item.captureModelCalls !== 'boolean' || typeof item.unlimitedRepair !== 'boolean') invalid();
  if (item.unlimitedRepair) { if (item.repairAttemptLimit !== null) invalid(); }
  else integer(item.repairAttemptLimit, 1);
  return structuredClone(value) as StartFullSourceGenerationSessionRequest;
}

export function decodeFullSourceEvent(value: unknown, options: {
  previousEventSequence: number; expectedSessionId?: string; request: StartFullSourceGenerationSessionRequest;
}): FullSourceGenerationEvent {
  const item = record(value, ['sessionId','eventSequence','eventType','occurredAt','progress',
    'candidate','completion','modelCall','error','outputInvalid']);
  const sessionId = uuid(item.sessionId);
  if (options.expectedSessionId && sessionId !== options.expectedSessionId) invalid();
  if (integer(item.eventSequence, 1) <= options.previousEventSequence || !Number.isFinite(Date.parse(text(item.occurredAt)))) invalid();
  const payloads = { progress: 'progress', candidate_ready: 'candidate', completed: 'completion',
    model_call: 'modelCall', error: 'error', output_invalid: 'outputInvalid' } as const;
  const key = payloads[item.eventType as keyof typeof payloads];
  if (!key || Object.values(payloads).some(k => k !== key && item[k] !== null) || item[key] === null) invalid();
  const request = options.request;
  const identity = { methodId: request.methodId, batchId: request.batchId, batchIndex: request.batchIndex,
    outputTestClassName: request.outputTestClassName };
  if (key === 'progress') {
    const p = record(item.progress, ['repairAttempt','stage','completedTestMethods','remainingTestMethods']);
    integer(p.repairAttempt, 0); text(p.stage, 128); integer(p.completedTestMethods, 0); integer(p.remainingTestMethods, 0);
    if (p.remainingTestMethods !== 0) invalid();
  } else if (key === 'candidate') {
    const c = decodeFullSourceCandidate(item.candidate);
    if (c.methodId !== request.methodId || c.batchId !== request.batchId || c.batchIndex !== request.batchIndex
      || c.outputTestClassName !== request.outputTestClassName) invalid();
  } else if (key === 'outputInvalid') decodeFullSourceOutputFailure(item.outputInvalid);
  else if (key === 'completion') decodeCompletion(item.completion, identity);
  else if (key === 'modelCall') decodeModelCall(item.modelCall, sessionId, identity);
  else decodeFailure(item.error);
  return structuredClone(value) as FullSourceGenerationEvent;
}

export function decodeFullSourceStatus(value: unknown, request: StartFullSourceGenerationSessionRequest,
  sessionId: string, afterSequence: number): FullSourceGenerationStatus {
  const item = record(value, ['sessionId','phase','lastEventSequence','pendingCandidate',
    'completion','terminalError','events','pendingOutputInvalid']);
  if (uuid(item.sessionId) !== sessionId || !['starting','running','completed','failed','cancelled'].includes(item.phase as string)
    || integer(item.lastEventSequence, 0) < afterSequence) invalid();
  let sequence = afterSequence;
  for (const raw of array(item.events)) {
    const event = decodeFullSourceEvent(raw, { request, expectedSessionId: sessionId, previousEventSequence: sequence });
    sequence = event.eventSequence;
  }
  if (sequence > (item.lastEventSequence as number)) invalid();
  if (item.pendingCandidate !== null) {
    const candidate = decodeFullSourceCandidate(item.pendingCandidate);
    if (candidate.batchId !== request.batchId || candidate.methodId !== request.methodId
      || candidate.batchIndex !== request.batchIndex || candidate.outputTestClassName !== request.outputTestClassName) invalid();
  }
  if (item.pendingOutputInvalid !== null) decodeFullSourceOutputFailure(item.pendingOutputInvalid);
  if (item.pendingCandidate !== null && item.pendingOutputInvalid !== null) invalid();
  if (item.completion !== null) decodeCompletion(item.completion, { methodId: request.methodId, batchId: request.batchId });
  if (item.terminalError !== null) decodeFailure(item.terminalError);
  return structuredClone(value) as FullSourceGenerationStatus;
}
