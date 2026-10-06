import { randomUUID } from 'node:crypto';
import type { ClassTaskSnapshot, ClassTaskModelUsageIncrement } from '../../shared/class-task-contracts.ts';
import {
  validateFullSourceBatch, decodeFullSourceCandidate, validateFullSourceFeedback,
  decodeFullSourceOutputFailure, validateStartFullSourceRequest,
  type FullSourceClassBatchPayload, type FullSourceCandidateResponse,
  type OutputValidationFailureResponse, type StartFullSourceGenerationSessionRequest,
  type ResumeFullSourceGenerationSessionRequest, type FullSourceMethodOutcome
} from './full-source-generation-contract.ts';
import { sourceSha256 } from './full-source-generation-contract.ts';
import { validateExecutionFeedback, decodeCompletion, usage,
  type CandidateExecutionFeedback, type MethodGenerationCompletion } from './method-generation-contract.ts';

export type ClassTaskExecutionMode = 'LEGACY_WAVE' | 'FULL_SOURCE';
export type FullSourceFrozenIdentity = {
  analysisSessionId: string; reportPairId: string; methodIds: readonly string[];
  repairAttemptLimit: number | null; unlimitedRepair: boolean;
};
export type FullSourceRunCheckpoint = {
  executionMode: 'FULL_SOURCE'; contractVersion: 1;
  identity: FullSourceFrozenIdentity; clientRequestId: string;
  batch: FullSourceClassBatchPayload | null;
  startRequest: StartFullSourceGenerationSessionRequest | null;
  initialCallState: 'NOT_ISSUED' | 'ISSUED' | 'RESULT_RECEIVED';
  sessionId: string | null; sessionCancelled: boolean; eventSequence: number; repairAttemptsUsed: number;
  candidate: FullSourceCandidateResponse | null;
  outputFailure: OutputValidationFailureResponse | null;
  lastValidCandidate: FullSourceCandidateResponse | null;
  pendingFeedback: ResumeFullSourceGenerationSessionRequest | null;
  managedFile: { path: string; sha256: string; location: 'ISOLATED' | 'PROJECT' } | null;
  pendingReplacement: { originalSha256: string; replacementSha256: string; code: string } | null;
  moveTransaction: { sourcePath: string; targetPath: string; sha256: string; phase: 'PREPARED' | 'MOVED' } | null;
  stableRepair: { phase: 'NOT_STARTED' | 'TEST_METHODS' | 'SHARED_MEMBERS' | 'PASSED' | 'BLOCKED';
    iteration: number; annotatedMemberIds: string[] };
  deletedTests: FullSourceMethodOutcome['deletedTests'];
  execution: CandidateExecutionFeedback | null;
  completion: MethodGenerationCompletion | null;
  accountedModelCallIds: string[];
  usageBaseline: ClassTaskModelUsageIncrement | null;
  modelUsage: ClassTaskModelUsageIncrement;
  publication: { phase: 'PREPARED' | 'VERIFIED'; candidateId: string; candidateSha256: string;
    formalPath: string; formalSha256: string; startedAt: string } | null;
  methodOutcomes: FullSourceMethodOutcome[];
};

export function resolveExecutionMode(task: Pick<ClassTaskSnapshot, 'ragEnabled' | 'executionMode'>,
  progress: { executionMode?: ClassTaskExecutionMode; fullSource?: unknown;
    resolvedMethodOrder?: readonly string[]; methods?: object; waveState?: object }): ClassTaskExecutionMode {
  if (progress.executionMode) return progress.executionMode;
  if (progress.fullSource) return 'FULL_SOURCE';
  if (task.executionMode) return task.executionMode;
  if (task.ragEnabled || progress.resolvedMethodOrder?.length || Object.keys(progress.methods ?? {}).length
    || Object.values(progress.waveState ?? {}).some(v => Array.isArray(v) ? v.length > 0
      : v && typeof v === 'object' ? Object.keys(v).length > 0 : v !== null && v !== false)) return 'LEGACY_WAVE';
  return 'FULL_SOURCE';
}

const fail = (): never => { throw new TypeError('完整源码 checkpoint 身份或状态无效。'); };
const hash = (v: unknown): void => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(); };
const id = (v: unknown): void => { if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(v)) fail(); };
const integer = (v: unknown): void => { if (!Number.isSafeInteger(v) || (v as number) < 0) fail(); };
function exact(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !(k in r))) fail();
  return r;
}
export function validateFullSourceIdentity(value: unknown): FullSourceFrozenIdentity {
  const r = exact(value, ['analysisSessionId','reportPairId','methodIds','repairAttemptLimit','unlimitedRepair']);
  id(r.analysisSessionId); hash(r.reportPairId);
  if (!Array.isArray(r.methodIds) || !r.methodIds.length || r.methodIds.length > 20000
    || new Set(r.methodIds).size !== r.methodIds.length) fail();
  (r.methodIds as unknown[]).forEach(hash);
  if (typeof r.unlimitedRepair !== 'boolean') fail();
  if (r.unlimitedRepair) { if (r.repairAttemptLimit !== null) fail(); }
  else { integer(r.repairAttemptLimit); if ((r.repairAttemptLimit as number) < 1) fail(); }
  return structuredClone(value) as FullSourceFrozenIdentity;
}
export function newFullSourceCheckpoint(identity: FullSourceFrozenIdentity): FullSourceRunCheckpoint {
  return { executionMode: 'FULL_SOURCE', contractVersion: 1, identity: validateFullSourceIdentity(identity),
    clientRequestId: randomUUID(), batch: null, startRequest: null, initialCallState: 'NOT_ISSUED',
    sessionId: null, sessionCancelled: false, eventSequence: 0, repairAttemptsUsed: 0, candidate: null, outputFailure: null,
    lastValidCandidate: null, pendingFeedback: null, managedFile: null, pendingReplacement: null, moveTransaction: null,
    stableRepair: { phase: 'NOT_STARTED', iteration: 0, annotatedMemberIds: [] }, deletedTests: [], execution: null,
    completion: null, accountedModelCallIds: [], usageBaseline: null,
    modelUsage: { tokenUsage: null, modelCallCount: 0, usageReportedCallCount: 0 }, publication: null, methodOutcomes: [] };
}
export function validateFullSourceCheckpoint(value: unknown): FullSourceRunCheckpoint {
  const r = exact(value, Object.keys(newFullSourceCheckpoint({ analysisSessionId: '00000000-0000-4000-8000-000000000000',
    reportPairId: 'a'.repeat(64), methodIds: ['b'.repeat(64)], repairAttemptLimit: 1, unlimitedRepair: false })));
  if (r.executionMode !== 'FULL_SOURCE' || r.contractVersion !== 1) fail();
  const identity = validateFullSourceIdentity(r.identity); id(r.clientRequestId);
  if (!['NOT_ISSUED','ISSUED','RESULT_RECEIVED'].includes(r.initialCallState as string)) fail();
  if (r.sessionId !== null) id(r.sessionId);
  if (typeof r.sessionCancelled !== 'boolean' || r.sessionCancelled && !r.sessionId) fail();
  integer(r.eventSequence); integer(r.repairAttemptsUsed);
  if (!identity.unlimitedRepair && (r.repairAttemptsUsed as number) > identity.repairAttemptLimit!) fail();
  const batch = r.batch === null ? null : validateFullSourceBatch(r.batch);
  if (batch && (batch.facts.reportPairId !== identity.reportPairId
    || JSON.stringify(batch.facts.methods.map(m => m.methodId)) !== JSON.stringify(identity.methodIds))) fail();
  if (r.startRequest !== null) {
    const request = validateStartFullSourceRequest(r.startRequest);
    if (JSON.stringify(request.batch) !== JSON.stringify(batch) || request.clientRequestId !== r.clientRequestId
      || request.repairAttemptLimit !== identity.repairAttemptLimit || request.unlimitedRepair !== identity.unlimitedRepair) fail();
  }
  for (const key of ['candidate', 'lastValidCandidate']) {
    if (r[key] === null) continue;
    const c = decodeFullSourceCandidate(r[key]);
    if (!batch || c.batchId !== batch.batchId || c.methodId !== batch.methodId
      || c.repairAttempt > (r.repairAttemptsUsed as number)) fail();
  }
  const pendingFeedback = r.pendingFeedback === null ? null : validateFullSourceFeedback(r.pendingFeedback);
  if (r.outputFailure !== null) {
    const output = decodeFullSourceOutputFailure(r.outputFailure);
    // A streamed correction starts consuming the next attempt before a new
    // output arrives. Keep the exact preceding failure and feedback durable.
    const correctionInFlight = r.repairAttemptsUsed === output.repairAttempt + 1
      && pendingFeedback?.feedbackKind === 'output_validation'
      && pendingFeedback.candidateId === output.candidateId
      && pendingFeedback.candidateVersion === output.candidateVersion
      && pendingFeedback.repairAttempt === output.repairAttempt;
    if (output.repairAttempt !== r.repairAttemptsUsed && !correctionInFlight) fail();
  }
  if (r.candidate !== null && r.outputFailure !== null) fail();
  if (r.execution !== null) validateExecutionFeedback(r.execution);
  if (r.completion !== null) {
    if (!batch) fail();
    decodeCompletion(r.completion, { methodId: batch!.methodId, batchId: batch!.batchId });
  }
  if (r.managedFile !== null) {
    const f = exact(r.managedFile, ['path','sha256','location']); hash(f.sha256);
    if (typeof f.path !== 'string' || !f.path || !['ISOLATED','PROJECT'].includes(f.location as string)) fail();
  }
  if (r.moveTransaction !== null) {
    const m = exact(r.moveTransaction, ['sourcePath','targetPath','sha256','phase']); hash(m.sha256);
    if (!['PREPARED','MOVED'].includes(m.phase as string) || typeof m.sourcePath !== 'string'
      || typeof m.targetPath !== 'string' || !m.sourcePath || !m.targetPath) fail();
  }
  if (r.pendingReplacement !== null) {
    const pending = exact(r.pendingReplacement, ['originalSha256','replacementSha256','code']);
    hash(pending.originalSha256); hash(pending.replacementSha256);
    if (!r.managedFile || (r.managedFile as { sha256: string }).sha256 !== pending.originalSha256
      || r.moveTransaction !== null || typeof pending.code !== 'string' || pending.code.length > 1_000_000
      || sourceSha256(pending.code) !== pending.replacementSha256) fail();
  }
  const stable = exact(r.stableRepair, ['phase','iteration','annotatedMemberIds']); integer(stable.iteration);
  if (!['NOT_STARTED','TEST_METHODS','SHARED_MEMBERS','PASSED','BLOCKED'].includes(stable.phase as string)
    || !Array.isArray(stable.annotatedMemberIds) || stable.annotatedMemberIds.some(v => typeof v !== 'string' || !v)) fail();
  if (!Array.isArray(r.deletedTests) || r.deletedTests.some(v => !v || typeof v !== 'object'
    || Object.keys(v).sort().join(',') !== 'evidencePath,reason,testName'
    || Object.values(v).some(n => typeof n !== 'string' || !n))) fail();
  if (!Array.isArray(r.accountedModelCallIds) || new Set(r.accountedModelCallIds).size !== r.accountedModelCallIds.length) fail();
  (r.accountedModelCallIds as unknown[]).forEach(id);
  for (const raw of [r.usageBaseline, r.modelUsage]) {
    if (raw === null) continue;
    const u = exact(raw, ['tokenUsage','modelCallCount','usageReportedCallCount']);
    integer(u.modelCallCount); integer(u.usageReportedCallCount); usage(u.tokenUsage);
    if ((u.usageReportedCallCount as number) > (u.modelCallCount as number)) fail();
  }
  if (r.modelUsage === null || (r.modelUsage as ClassTaskModelUsageIncrement).modelCallCount !== (r.accountedModelCallIds as unknown[]).length) fail();
  if (r.publication !== null) {
    const p = exact(r.publication, ['phase','candidateId','candidateSha256','formalPath','formalSha256','startedAt']);
    if (!['PREPARED','VERIFIED'].includes(p.phase as string) || typeof p.formalPath !== 'string' || !p.formalPath
      || typeof p.startedAt !== 'string' || !Number.isFinite(Date.parse(p.startedAt))) fail();
    id(p.candidateId); hash(p.candidateSha256); hash(p.formalSha256);
    if (!r.candidate || p.candidateId !== (r.candidate as FullSourceCandidateResponse).candidateId
      || !r.managedFile || p.candidateSha256 !== (r.managedFile as { sha256: string }).sha256
      || p.phase === 'VERIFIED' && (!r.execution || (r.execution as CandidateExecutionFeedback).status !== 'passed')) fail();
  }
  if (!Array.isArray(r.methodOutcomes)) fail();
  const seen = new Set<string>();
  for (const raw of r.methodOutcomes as unknown[]) {
    const o = exact(raw, ['methodId','passedTestNames','retainedFailureMembers','deletedTests','status']);
    if (!identity.methodIds.includes(o.methodId as string) || seen.has(o.methodId as string)) fail();
    seen.add(o.methodId as string);
    for (const key of ['passedTestNames','retainedFailureMembers']) {
      if (!Array.isArray(o[key]) || (o[key] as unknown[]).some(n => typeof n !== 'string' || !n)
        || new Set(o[key] as unknown[]).size !== (o[key] as unknown[]).length) fail();
    }
    if (!['PASSED','RETAINED_FAILURE','NO_VALID_TEST'].includes(o.status as string)) fail();
    if (o.status === 'PASSED' && !(o.passedTestNames as string[]).length) fail();
    if (!Array.isArray(o.deletedTests)) fail();
    for (const d of o.deletedTests as unknown[]) {
      const item = exact(d, ['testName','reason','evidencePath']);
      if (Object.values(item).some(v => typeof v !== 'string' || !v)) fail();
    }
  }
  return structuredClone(value) as FullSourceRunCheckpoint;
}
export function assertFullSourceTransition(previous: FullSourceRunCheckpoint, next: FullSourceRunCheckpoint): void {
  const reboundSession = previous.sessionId !== next.sessionId && previous.sessionId !== null
    && next.sessionId !== null && previous.candidate !== null && previous.outputFailure === null
    && next.candidate?.candidateId === previous.candidate.candidateId
    && next.candidate?.generatedCodeSha256 === previous.candidate.generatedCodeSha256
    && next.repairAttemptsUsed === previous.repairAttemptsUsed;
  if (JSON.stringify(previous.identity) !== JSON.stringify(next.identity)
    || previous.clientRequestId !== next.clientRequestId
    || previous.batch && JSON.stringify(previous.batch) !== JSON.stringify(next.batch)
    || previous.startRequest && JSON.stringify(previous.startRequest) !== JSON.stringify(next.startRequest)
    || previous.sessionId && previous.sessionId !== next.sessionId && !reboundSession
    || next.eventSequence < previous.eventSequence && !reboundSession || next.repairAttemptsUsed < previous.repairAttemptsUsed
    || next.repairAttemptsUsed > previous.repairAttemptsUsed + 1
    || previous.sessionCancelled && !next.sessionCancelled
    || ['NOT_ISSUED','ISSUED','RESULT_RECEIVED'].indexOf(next.initialCallState)
      < ['NOT_ISSUED','ISSUED','RESULT_RECEIVED'].indexOf(previous.initialCallState)
    || previous.publication?.phase === 'VERIFIED' && JSON.stringify(previous.publication) !== JSON.stringify(next.publication)) fail();
  if (JSON.stringify(previous.usageBaseline) !== JSON.stringify(next.usageBaseline)
    || previous.accountedModelCallIds.some(id => !next.accountedModelCallIds.includes(id))
    || next.modelUsage.modelCallCount < previous.modelUsage.modelCallCount
    || previous.accountedModelCallIds.length === next.accountedModelCallIds.length
      && JSON.stringify(previous.modelUsage) !== JSON.stringify(next.modelUsage)) fail();
  const oldId = previous.candidate?.candidateId ?? previous.outputFailure?.candidateId ?? previous.lastValidCandidate?.candidateId;
  const newId = next.candidate?.candidateId ?? next.outputFailure?.candidateId ?? next.lastValidCandidate?.candidateId;
  if (oldId && newId !== oldId) fail();
}
