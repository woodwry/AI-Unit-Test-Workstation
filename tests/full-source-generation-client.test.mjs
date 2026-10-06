import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AiClient } from '../src/main/services/ai-client.ts';
import { fullSourceBatch } from './fixtures/full-source.mjs';
import { sourceSha256 } from '../src/main/services/full-source-generation-contract.ts';
const model = { llmConfig: { provider: 'custom_openai', model: 'test', baseUrl: 'https://models.example/v1',
  credentials: { apiKey: 'secret' } } };
function start() {
  const batch = fullSourceBatch();
  return { clientRequestId: randomUUID(), classTaskId: randomUUID(), methodId: batch.methodId,
    batchId: batch.batchId, batchIndex: 1, outputTestClassName: 'TargetTest', expectedPackageName: 'example',
    buildToolchain: { javaVersion: '21', mavenVersion: '3.9.9' }, batch, captureModelCalls: false,
    repairAttemptLimit: 6, unlimitedRepair: false };
}
function event(type, payload, sessionId = randomUUID()) {
  return { sessionId, eventSequence: 1, eventType: type, occurredAt: new Date().toISOString(), progress: null,
    candidate: null, completion: null, modelCall: null, error: null, outputInvalid: null, ...payload };
}
function client(fetchImpl) {
  const result = new AiClient(fetchImpl);
  result.setBackendSettings({ agentServiceUrl: 'http://127.0.0.1:18000', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  return result;
}
test('full-source SSE decodes 126 tests and sends one full-source start', async () => {
  const request = start(), requests = [];
  const candidate = { generationMode: 'FULL_SOURCE', candidateId: randomUUID(), candidateVersion: 1, repairAttempt: 0,
    methodId: request.methodId, batchId: request.batchId, batchIndex: 1, testCode: 'class TargetTest {}',
    generatedCodeSha256: sourceSha256('class TargetTest {}'), outputTestClassName: 'TargetTest',
    ordinaryTestMethodCount: 126, usage: null };
  const c = client(async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(`event: method_generation\ndata: ${JSON.stringify(event('candidate_ready', { candidate }))}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }); });
  const seen = [];
  const turn = await c.startFullSourceGenerationStream(request, model, e => { seen.push(e); });
  assert.equal(turn.candidate.ordinaryTestMethodCount, 126);
  assert.equal(requests.length, 1); assert.equal(requests[0].body.batch.facts.methods.length, 30);
  assert.equal(seen.length, 1);
});
test('invalid output is its own terminal event and no Maven feedback is fabricated', async () => {
  const request = start();
  const outputInvalid = { generationMode: 'FULL_SOURCE', candidateId: randomUUID(), candidateVersion: 1,
    repairAttempt: 0, invalidOutput: '', invalidOutputSha256: sourceSha256(''),
    validationErrors: [{ code: 'EMPTY', message: 'empty' }] };
  const c = client(async () => new Response(`data: ${JSON.stringify(event('output_invalid', { outputInvalid }))}\n\n`));
  const turn = await c.startFullSourceGenerationStream(request, model, () => {});
  assert.equal(turn.kind, 'output_invalid'); assert.deepEqual(turn.outputInvalid, outputInvalid);
});
test('lost initial response never automatically retries a start', async () => {
  let calls = 0; const c = client(async () => { calls++; throw new Error('socket lost'); });
  await assert.rejects(c.startFullSourceGenerationStream(start(), model, () => {}), /socket lost/);
  assert.equal(calls, 1);
});
test('a read failure after a durable session event recovers by status without another start', async () => {
  const request = start(), sessionId = randomUUID(); let calls = 0;
  const candidate = { generationMode: 'FULL_SOURCE', candidateId: randomUUID(), candidateVersion: 1, repairAttempt: 0,
    methodId: request.methodId, batchId: request.batchId, batchIndex: 1, testCode: 'class TargetTest {}',
    generatedCodeSha256: sourceSha256('class TargetTest {}'), outputTestClassName: 'TargetTest', ordinaryTestMethodCount: 2, usage: null };
  const c = client(async (_url, init) => {
    calls++;
    if (init.method === 'POST') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event('progress', { progress:
        { repairAttempt: 0, stage: 'generating', completedTestMethods: 0, remainingTestMethods: 0 } }, sessionId))}\n\n`));
      setTimeout(() => controller.error(new Error('read socket lost')), 10);
    } }));
    return new Response(JSON.stringify({ sessionId, phase: 'running', lastEventSequence: 2, pendingCandidate: candidate,
      pendingOutputInvalid: null, completion: null, terminalError: null,
      events: [{ ...event('candidate_ready', { candidate }, sessionId), eventSequence: 2 }] }));
  });
  const seen = [];
  const turn = await c.startFullSourceGenerationStream(request, model, e => { seen.push(e.eventSequence); });
  assert.equal(turn.kind, 'candidate_ready'); assert.equal(calls, 2); assert.deepEqual(seen, [1,2]);
});
