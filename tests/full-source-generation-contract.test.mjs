import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFullSourceBatch, validateFullSourceFacts } from '../src/main/services/full-source-generation-contract.ts';
import { fullSourceBatch, fullSourceFacts } from './fixtures/full-source.mjs';
import { decodeFullSourceCandidate, validateFullSourceFeedback, sourceSha256 } from '../src/main/services/full-source-generation-contract.ts';
import { randomUUID } from 'node:crypto';

test('full source keeps all thirty selected methods without scenario fields', () => {
  assert.equal(validateFullSourceBatch(fullSourceBatch()).facts.methods.length, 30);
  const facts = fullSourceFacts();
  assert.deepEqual(validateFullSourceFacts(facts, { reportPairId: facts.reportPairId,
    methodIds: facts.methods.map(m => m.methodId) }), facts);
});

test('full source accepts the detailed skill while preserving persisted v1 batches', () => {
  const legacy = fullSourceBatch();
  legacy.skillProfileId = 'spring-boot-test-patterns-unit-v1';
  assert.equal(validateFullSourceBatch(legacy).skillProfileId, legacy.skillProfileId);
  const detailed = { ...legacy, skillProfileId: 'spring-boot-test-patterns-unit-v2' };
  assert.equal(validateFullSourceBatch(detailed).skillProfileId, detailed.skillProfileId);
  assert.throws(() => validateFullSourceBatch({ ...legacy, skillProfileId: 'unknown-profile' }));
});

test('full source preserves unresolved dependency argument types from Analyzer without inventing types', () => {
  const facts = fullSourceFacts(1);
  facts.methods[0].dependencyCalls = [
    { receiverExpression: 'taskRepository', receiverType: 'TaskRepository',
      declaringType: '', methodName: 'query', resolvedSignature: '',
      candidateSignatures: ['TaskRepository.query(String,Object[])'],
      argumentExpressions: ['taskQueryHQL', 'taskQueryParams.toArray()'],
      argumentTypes: ['String', ''], returnType: 'java.util.List', declaredExceptions: [], status: 'PARTIAL' },
    { receiverExpression: 'executorService', receiverType: 'ExecutorService',
      declaringType: '', methodName: 'execute', resolvedSignature: '', candidateSignatures: [],
      argumentExpressions: ['this::initTaskCacheRunnable'], argumentTypes: [''],
      returnType: '', declaredExceptions: [], status: 'ANALYSIS_FAILED' }
  ];
  assert.deepEqual(validateFullSourceFacts(facts).methods[0].dependencyCalls, facts.methods[0].dependencyCalls);
  for (const invalidType of [null, 42, {}]) {
    const invalid = structuredClone(facts);
    invalid.methods[0].dependencyCalls[0].argumentTypes[1] = invalidType;
    assert.throws(() => validateFullSourceFacts(invalid));
  }
});

test('full source dynamic candidates and output feedback preserve hashes and exclusivity', () => {
  const value = { generationMode: 'FULL_SOURCE', candidateId: randomUUID(), candidateVersion: 1,
    repairAttempt: 0, methodId: 'a'.repeat(64), batchId: 'b'.repeat(64), batchIndex: 1,
    testCode: 'class TargetTest {}', generatedCodeSha256: sourceSha256('class TargetTest {}'),
    outputTestClassName: 'TargetTest', ordinaryTestMethodCount: 126, usage: null };
  assert.equal(decodeFullSourceCandidate(value).ordinaryTestMethodCount, 126);
  assert.throws(() => decodeFullSourceCandidate({ ...value, generatedCodeSha256: 'c'.repeat(64) }));
  const feedback = { feedbackId: randomUUID(), expectedEventSequence: 1,
    candidateId: value.candidateId, candidateVersion: 1, repairAttempt: 0,
    feedbackKind: 'output_validation', invalidOutput: '', invalidOutputSha256: sourceSha256(''),
    validationErrors: [{ code: 'EMPTY', message: 'Empty output' }] };
  assert.deepEqual(validateFullSourceFeedback(feedback), feedback);
  assert.throws(() => validateFullSourceFeedback({ ...feedback, execution: { status: 'passed' } }));
});
test('full source rejects duplicate selections mixed identities and legacy fields', () => {
  for (const mutate of [
    b => { b.facts.methods[1].methodId = b.methodId; },
    b => { b.facts.methods[1].testMethodNamePrefix = 'm1_'; },
    b => { b.facts.methods[1].declaringType = 'other.Target'; },
    b => { b.batchId = 'b'.repeat(64); },
    b => { b.skillRulesSha256 = 'bad'; },
    b => { b.scenarios = []; },
    b => { b.facts.methods[0].invocationPlan.staticMethod = 'false'; }
  ]) {
    const batch = fullSourceBatch(); mutate(batch);
    assert.throws(() => validateFullSourceBatch(batch));
  }
});
