import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RagEmbeddingInterfaceConnectionTestService
} from '../src/main/services/rag-embedding-interface-connection-test.service.ts';

test('Embedding connection test calls the configured embeddings endpoint with a minimal probe', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, -0.2] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const result = await new RagEmbeddingInterfaceConnectionTestService().test({
    baseUrl: 'https://embeddings.example.test/v1/',
    embeddingModel: 'embed-v1',
    credentialMode: 'direct',
    apiKey: 'secret-marker'
  });

  assert.deepEqual(result, { ok: true, code: 'success', message: '连接测试成功。' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://embeddings.example.test/v1/embeddings');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-marker');
  assert.deepEqual(calls[0].body, { model: 'embed-v1', input: 'connection-test' });
});

test('Embedding connection test rejects a successful HTTP response without a usable vector', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

  const result = await new RagEmbeddingInterfaceConnectionTestService().test({
    baseUrl: 'https://embeddings.example.test/v1',
    embeddingModel: 'embed-v1',
    credentialMode: 'direct',
    apiKey: 'secret-marker'
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'invalid_response',
    message: '接口未返回有效的 Embedding 向量。'
  });
  assert.equal(JSON.stringify(result).includes('secret-marker'), false);
});
