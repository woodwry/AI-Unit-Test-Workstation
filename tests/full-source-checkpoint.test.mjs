import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClassTaskCheckpointService } from '../src/main/services/class-task-checkpoint.service.ts';
import { resolveExecutionMode } from '../src/main/services/full-source-checkpoint.ts';
import { fullSourceBatch } from './fixtures/full-source.mjs';
import { sourceSha256 } from '../src/main/services/full-source-generation-contract.ts';

test('execution mode respects historical false tasks and frozen mode', () => {
  assert.equal(resolveExecutionMode({ ragEnabled: false }, {}), 'FULL_SOURCE');
  assert.equal(resolveExecutionMode({ ragEnabled: true }, {}), 'LEGACY_WAVE');
  for (const progress of [{ resolvedMethodOrder: ['old'] }, { methods: { old: {} } },
    { waveState: { candidates: { old: {} } } }, { executionMode: 'LEGACY_WAVE' }]) {
    assert.equal(resolveExecutionMode({ ragEnabled: false }, progress), 'LEGACY_WAVE');
  }
  assert.equal(resolveExecutionMode({ ragEnabled: true }, { executionMode: 'FULL_SOURCE' }), 'FULL_SOURCE');
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'full-source-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let task = { id: randomUUID(), ragEnabled: false, currentMethodIndex: -1, state: 'RUNNING',
    modelCallCount: 3, usageReportedCallCount: 1, tokenUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
  const storagePath = join(root, 'checkpoint.json');
  const taskState = { snapshot: () => structuredClone(task), save: async value => (task = structuredClone(value)) };
  const service = () => new ClassTaskCheckpointService({ storagePath, taskState });
  const batch = fullSourceBatch();
  const identity = { analysisSessionId: randomUUID(), reportPairId: batch.facts.reportPairId,
    methodIds: batch.facts.methods.map(m => m.methodId), repairAttemptLimit: 6, unlimitedRepair: false };
  return { service, storagePath, identity, batch, taskId: task.id, getTask: () => task };
}

test('normal APIs freeze full-source selection and initial-issued state across reload', async t => {
  const f = await fixture(t); const cp = f.service();
  const prepared = await cp.prepareFullSourceRun(f.taskId, f.identity);
  assert.equal(prepared.initialCallState, 'NOT_ISSUED');
  assert.equal(f.getTask().executionMode, 'FULL_SOURCE');
  const frozen = { ...prepared, batch: f.batch, initialCallState: 'ISSUED' };
  await cp.saveFullSourceProgress(f.taskId, frozen);
  assert.deepEqual(await f.service().fullSourceProgress(f.taskId), frozen);
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...frozen, initialCallState: 'NOT_ISSUED' }));
  await assert.rejects(cp.prepareFullSourceRun(f.taskId, { ...f.identity, methodIds: [...f.identity.methodIds].reverse() }));
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...frozen,
    batch: { ...f.batch, skillRulesSha256: 'b'.repeat(64) } }));
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...frozen, repairAttemptsUsed: 7 }));
  const stored = JSON.parse(await readFile(f.storagePath, 'utf8'));
  assert.equal(stored.tasks[f.taskId].waveState.activeWave, null);
  assert.equal('scenarios' in stored.tasks[f.taskId].fullSource, false);
});

test('actual terminal usage is counted once across replay and public-store crash', async t => {
  const f = await fixture(t), cp = f.service();
  const prepared = await cp.prepareFullSourceRun(f.taskId, f.identity);
  await cp.saveFullSourceProgress(f.taskId, { ...prepared, batch: f.batch });
  const call = { callId: randomUUID(), methodId: f.batch.methodId, batchId: f.batch.batchId,
    phase: 'completed', repairAttempt: 0, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  const originalSave = cp.savePublicTask.bind(cp);
  cp.savePublicTask = async () => { throw new Error('simulated public-store failure'); };
  await assert.rejects(cp.recordFullSourceModelCall(f.taskId, call), /public-store/);
  cp.savePublicTask = originalSave;
  await f.service().recordFullSourceModelCall(f.taskId, call);
  await f.service().recordFullSourceModelCall(f.taskId, call);
  assert.equal(f.getTask().modelCallCount, 4);
  assert.equal(f.getTask().usageReportedCallCount, 2);
  assert.equal(f.getTask().tokenUsage.totalTokens, 13);
  const next = { ...call, callId: randomUUID(), repairAttempt: 1, phase: 'failed', usage: null };
  await cp.recordFullSourceModelCall(f.taskId, next);
  assert.equal(f.getTask().modelCallCount, 5);
  assert.equal(f.getTask().usageReportedCallCount, 2);
  await assert.rejects(cp.recordFullSourceModelCall(f.taskId, { ...next, callId: randomUUID(), repairAttempt: 7 }));
  assert.equal(f.getTask().modelCallCount, 5);
  const progress = await cp.fullSourceProgress(f.taskId);
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...progress,
    modelUsage: { ...progress.modelUsage, tokenUsage: null } }));
});

test('damaged full-source persistence cannot become a fresh initial call', async t => {
  const f = await fixture(t); await f.service().prepareFullSourceRun(f.taskId, f.identity);
  const raw = JSON.parse(await readFile(f.storagePath, 'utf8'));
  raw.tasks[f.taskId].fullSource.initialCallState = 'FORGED';
  await writeFile(f.storagePath, JSON.stringify(raw));
  await writeFile(`${f.storagePath}.bak`, JSON.stringify(raw));
  await assert.rejects(f.service().prepareFullSourceRun(f.taskId, f.identity), /存储文件/);
});

test('an older invalid output may only survive the next attempt with its exact correction feedback', async t => {
  const f = await fixture(t), cp = f.service();
  const prepared = await cp.prepareFullSourceRun(f.taskId, f.identity);
  const outputFailure = { generationMode: 'FULL_SOURCE', candidateId: randomUUID(), candidateVersion: 1,
    repairAttempt: 0, invalidOutput: '', invalidOutputSha256: sourceSha256(''),
    validationErrors: [{ code: 'EMPTY', message: 'Empty output' }] };
  const received = await cp.saveFullSourceProgress(f.taskId, { ...prepared, batch: f.batch,
    initialCallState: 'RESULT_RECEIVED', outputFailure });
  const pendingFeedback = { feedbackId: randomUUID(), expectedEventSequence: 1,
    candidateId: outputFailure.candidateId, candidateVersion: 1, repairAttempt: 0,
    feedbackKind: 'output_validation', invalidOutput: '', invalidOutputSha256: sourceSha256(''),
    validationErrors: outputFailure.validationErrors };
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...received, repairAttemptsUsed: 1 }));
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...received, repairAttemptsUsed: 1,
    pendingFeedback: { ...pendingFeedback, candidateId: randomUUID() } }));
  const during = await cp.saveFullSourceProgress(f.taskId, { ...received, repairAttemptsUsed: 1, pendingFeedback });
  assert.deepEqual(await f.service().fullSourceProgress(f.taskId), during);
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...during, repairAttemptsUsed: 2 }));
});

test('completion cannot name another batch or publish outcomes without verified evidence', async t => {
  const f = await fixture(t), cp = f.service();
  const prepared = await cp.prepareFullSourceRun(f.taskId, f.identity);
  const completion = { methodId: f.batch.methodId, batchId: 'e'.repeat(64), stopReason: 'repair_exhausted',
    bestCandidateId: null, aggregateUsage: null, modelCallCount: 1, usageReportedCallCount: 0 };
  await assert.rejects(cp.saveFullSourceProgress(f.taskId, { ...prepared, batch: f.batch, completion }));
  const full = await cp.saveFullSourceProgress(f.taskId, { ...prepared, batch: f.batch,
    completion: { ...completion, batchId: f.batch.batchId }, methodOutcomes: f.identity.methodIds.map(methodId => ({
      methodId, status: 'PASSED', passedTestNames: ['m1_fake'], retainedFailureMembers: [], deletedTests: [] })) });
  await assert.rejects(cp.commitFullSourceResults(f.taskId), /验证证据/);
  assert.equal((await cp.taskProgress(f.taskId)).completedMethodIds.length, 0);
});
