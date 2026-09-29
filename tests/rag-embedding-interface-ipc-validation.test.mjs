import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateCreateRagEmbeddingInterfaceRequest,
  validateDeleteRagEmbeddingInterfaceRequest,
  validateRagEmbeddingInterfaceConnectionTestRequest,
  validateSelectRagEmbeddingInterfaceRequest,
  validateUpdateRagEmbeddingInterfaceRequest
} from '../src/main/services/workspace-model-ipc-validation.ts';

test('RAG Embedding IPC validators normalize exact independent interface requests', () => {
  assert.deepEqual(validateCreateRagEmbeddingInterfaceRequest({
    name: '  Local Embed  ',
    baseUrl: '  http://127.0.0.1:11434/v1  ',
    embeddingModel: '  nomic-embed-text  ',
    credentialMode: 'environment',
    environmentVariableName: '  EMBEDDING_API_KEY  '
  }), {
    name: 'Local Embed',
    baseUrl: 'http://127.0.0.1:11434/v1',
    embeddingModel: 'nomic-embed-text',
    credentialMode: 'environment',
    environmentVariableName: 'EMBEDDING_API_KEY'
  });

  assert.deepEqual(validateUpdateRagEmbeddingInterfaceRequest({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Cloud Embed',
    baseUrl: 'https://embedding.example/v1',
    embeddingModel: 'embed-v2',
    credentialMode: 'direct'
  }), {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Cloud Embed',
    baseUrl: 'https://embedding.example/v1',
    embeddingModel: 'embed-v2',
    credentialMode: 'direct'
  });

  assert.deepEqual(validateDeleteRagEmbeddingInterfaceRequest({ id: 'x' }), { id: 'x' });
  assert.deepEqual(validateSelectRagEmbeddingInterfaceRequest({ id: null }), { id: null });
});

test('RAG Embedding IPC validators reject unknown fields and missing create credentials', () => {
  assert.throws(() => validateCreateRagEmbeddingInterfaceRequest({
    name: 'Embed',
    baseUrl: 'https://embedding.example/v1',
    embeddingModel: 'embed-v1',
    credentialMode: 'direct'
  }), /API Key/i);
  assert.throws(() => validateCreateRagEmbeddingInterfaceRequest({
    name: 'Embed',
    baseUrl: 'https://embedding.example/v1',
    embeddingModel: 'embed-v1',
    credentialMode: 'direct',
    apiKey: 'secret-marker',
    llmConfig: { credentials: { apiKey: 'wrong' } }
  }), /字段|请求|无效|Embedding/i);
});

test('RAG Embedding connection probe accepts an existing stored direct credential', () => {
  assert.deepEqual(validateRagEmbeddingInterfaceConnectionTestRequest({
    interfaceId: '11111111-1111-4111-8111-111111111111',
    baseUrl: 'https://embedding.example/v1',
    embeddingModel: 'embed-v1',
    credentialMode: 'direct'
  }), {
    interfaceId: '11111111-1111-4111-8111-111111111111',
    baseUrl: 'https://embedding.example/v1',
    embeddingModel: 'embed-v1',
    credentialMode: 'direct'
  });
});
