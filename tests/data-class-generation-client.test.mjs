import assert from 'node:assert/strict';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';

const LLM_CONFIG = {
  provider: 'openai-compatible',
  model: 'model',
  baseUrl: 'https://model.example/v1',
  credentials: { apiKey: 'secret' },
  parameters: {}
};

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function directGenerationResponse(payload) {
  return new Response([
    ': connected',
    '',
    ': heartbeat',
    '',
    'event: direct_generation',
    `data: ${JSON.stringify({ phase: 'completed', response: payload })}`,
    '',
    ''
  ].join('\n'), {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

test('target classification uses the existing analyzer class-level endpoint', async () => {
  const calls = [];
  const client = new AiClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      targetClass: 'example.UserVO',
      packageName: 'example',
      className: 'UserVO',
      classKind: 'DATA_EXPLICIT_ACCESSORS',
      features: {
        lombokAnnotations: [],
        hasServiceAnnotation: false,
        hasDependencyInjectionAnnotations: false,
        dataClassName: true
      }
    });
  });
  client.setBackendSettings({
    agentServiceUrl: 'http://127.0.0.1:18000',
    javaAnalyzerUrl: 'http://127.0.0.1:18080'
  });

  const result = await client.classifyUnitTestTarget(
    'D:\\workspace\\module',
    'example.UserVO'
  );

  assert.equal(result.classKind, 'DATA_EXPLICIT_ACCESSORS');
  assert.equal(calls[0].url, 'http://127.0.0.1:18080/api/analyze/classify-target');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    projectPath: 'D:\\workspace\\module',
    targetClass: 'example.UserVO',
    targetMethod: null
  });
});

test('direct batch generation keeps one streaming model call alive through heartbeats', async () => {
  const calls = [];
  const client = new AiClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return directGenerationResponse({
      result: 'package example; class UserVOTmp1Test {}',
      provider: 'openai-compatible',
      model: 'model',
      generationMode: 'deterministic_prompt',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    });
  });

  const result = await client.generateUnitTestPrompt(
    'generate the batch',
    { llmConfig: LLM_CONFIG }
  );

  assert.equal(result.result, 'package example; class UserVOTmp1Test {}');
  assert.equal(result.usage?.totalTokens, 120);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:18000/api/unit-tests/generate/stream');
  assert.equal(calls[0].init.headers.Accept, 'text/event-stream');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.prompt, 'generate the batch');
  assert.equal(body.llmConfig.credentials.apiKey, 'secret');
});

test('direct batch generation surfaces a terminal stream error without a second request', async () => {
  let calls = 0;
  const client = new AiClient(async () => {
    calls += 1;
    return new Response([
      ': connected',
      '',
      'event: direct_generation',
      `data: ${JSON.stringify({
        phase: 'failed',
        error: {
          code: 'MODEL_TIMEOUT',
          message: '大模型响应超时。',
          statusCode: 504
        }
      })}`,
      '',
      ''
    ].join('\n'), {
      headers: { 'Content-Type': 'text/event-stream' }
    });
  });

  await assert.rejects(
    client.generateUnitTestPrompt('generate once', { llmConfig: LLM_CONFIG }),
    (error) => error?.code === 'MODEL_TIMEOUT'
      && error.message === '批量测试生成失败：大模型响应超时。'
  );
  assert.equal(calls, 1);
});

test('same-model batch generation calls are FIFO instead of invoking the provider concurrently', async () => {
  const firstRelease = deferred();
  const startedPrompts = [];
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const client = new AiClient(async (_input, init) => {
    const prompt = JSON.parse(init.body).prompt;
    startedPrompts.push(prompt);
    activeCalls += 1;
    maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
    if (prompt === 'first class') await firstRelease.promise;
    activeCalls -= 1;
    return directGenerationResponse({
      result: `package example; class ${prompt === 'first class' ? 'First' : 'Second'}Test {}`,
      provider: 'openai-compatible',
      model: 'model',
      generationMode: 'deterministic_prompt',
      usage: null
    });
  });

  const first = client.generateUnitTestPrompt(
    'first class',
    { llmConfig: LLM_CONFIG }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = client.generateUnitTestPrompt(
    'second class',
    { llmConfig: LLM_CONFIG }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startedPrompts, ['first class']);
  firstRelease.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(startedPrompts, ['first class', 'second class']);
  assert.equal(maximumActiveCalls, 1);
});

test('different model configurations can still invoke their providers concurrently', async () => {
  const release = deferred();
  const startedModels = [];
  const client = new AiClient(async (_input, init) => {
    const body = JSON.parse(init.body);
    startedModels.push(body.llmConfig.model);
    await release.promise;
    return directGenerationResponse({
      result: 'package example; class GeneratedTest {}',
      provider: 'openai-compatible',
      model: body.llmConfig.model,
      generationMode: 'deterministic_prompt',
      usage: null
    });
  });

  const first = client.generateUnitTestPrompt('first', { llmConfig: {
    ...LLM_CONFIG,
    model: 'model-a'
  } });
  const second = client.generateUnitTestPrompt('second', { llmConfig: {
    ...LLM_CONFIG,
    model: 'model-b'
  } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(new Set(startedModels), new Set(['model-a', 'model-b']));
  release.resolve();
  await Promise.all([first, second]);
});
