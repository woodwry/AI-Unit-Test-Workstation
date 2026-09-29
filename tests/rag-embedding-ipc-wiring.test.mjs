import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateCreateRagEmbeddingInterfaceRequest,
  validateDeleteRagEmbeddingInterfaceRequest,
  validateRagEmbeddingInterfaceConnectionTestRequest,
  validateSelectRagEmbeddingInterfaceRequest,
  validateUpdateRagEmbeddingInterfaceRequest
} from '../src/main/services/workspace-model-ipc-validation.ts';

const CHANNELS = {
  get: 'rag-embedding-interfaces:get',
  create: 'rag-embedding-interfaces:create',
  update: 'rag-embedding-interfaces:update',
  delete: 'rag-embedding-interfaces:delete',
  select: 'rag-embedding-interfaces:select',
  testConnection: 'rag-embedding-interfaces:test-connection'
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getRegisteredHandlerSource(main, channel) {
  const marker = new RegExp(
    `registerModelHandler\\s*\\(\\s*['\"]${escapeRegExp(channel)}['\"]`
  );
  const match = marker.exec(main);
  assert.ok(match, `missing main-process handler for ${channel}`);

  const nextHandler = main.indexOf('registerModelHandler', match.index + match[0].length);
  return main.slice(match.index, nextHandler < 0 ? main.length : nextHandler);
}

test('shared types and preload expose six named RAG Embedding wrappers on fixed channels', async () => {
  const [types, preload] = await Promise.all([
    readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  ]);

  const sharedContracts = [
    /getRagEmbeddingInterfaces:\s*\(\)\s*=>\s*Promise<RagEmbeddingInterfacesView>/,
    /createRagEmbeddingInterface:\s*\([\s\S]*?request:\s*CreateRagEmbeddingInterfaceRequest[\s\S]*?\)\s*=>\s*Promise<RagEmbeddingInterfacesView>/,
    /updateRagEmbeddingInterface:\s*\([\s\S]*?request:\s*UpdateRagEmbeddingInterfaceRequest[\s\S]*?\)\s*=>\s*Promise<RagEmbeddingInterfacesView>/,
    /deleteRagEmbeddingInterface:\s*\([\s\S]*?request:\s*DeleteRagEmbeddingInterfaceRequest[\s\S]*?\)\s*=>\s*Promise<RagEmbeddingInterfacesView>/,
    /selectRagEmbeddingInterface:\s*\([\s\S]*?request:\s*SelectRagEmbeddingInterfaceRequest[\s\S]*?\)\s*=>\s*Promise<RagEmbeddingInterfacesView>/,
    /testRagEmbeddingInterfaceConnection:\s*\([\s\S]*?request:\s*RagEmbeddingInterfaceConnectionTestRequest[\s\S]*?\)\s*=>\s*Promise<RagEmbeddingInterfaceConnectionTestResult>/
  ];
  for (const contract of sharedContracts) assert.match(types, contract);

  const preloadWrappers = [
    ['getRagEmbeddingInterfaces', CHANNELS.get, false],
    ['createRagEmbeddingInterface', CHANNELS.create, true],
    ['updateRagEmbeddingInterface', CHANNELS.update, true],
    ['deleteRagEmbeddingInterface', CHANNELS.delete, true],
    ['selectRagEmbeddingInterface', CHANNELS.select, true],
    ['testRagEmbeddingInterfaceConnection', CHANNELS.testConnection, true]
  ];
  for (const [method, channel, hasRequest] of preloadWrappers) {
    const requestArgument = hasRequest ? ',\\s*request' : '';
    assert.match(
      preload,
      new RegExp(
        `${method}:\\s*\\([^)]*\\)\\s*=>[\\s\\S]*?ipcRenderer\\.invoke\\(`
          + `['\"]${escapeRegExp(channel)}['\"]${requestArgument}\\)`
      ),
      `preload wrapper ${method} is not wired to ${channel}`
    );
  }

  assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer\b/);
});

test('main registers trusted handlers with their strict validators and permits clearing selection', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const validatorByChannel = new Map([
    [CHANNELS.create, 'validateCreateRagEmbeddingInterfaceRequest'],
    [CHANNELS.update, 'validateUpdateRagEmbeddingInterfaceRequest'],
    [CHANNELS.delete, 'validateDeleteRagEmbeddingInterfaceRequest'],
    [CHANNELS.select, 'validateSelectRagEmbeddingInterfaceRequest'],
    [CHANNELS.testConnection, 'validateRagEmbeddingInterfaceConnectionTestRequest']
  ]);

  for (const channel of Object.values(CHANNELS)) {
    const handler = getRegisteredHandlerSource(main, channel);
    assert.match(handler, /assertTrustedIpcSender\(event\)/, `${channel} does not verify its sender`);
    const validator = validatorByChannel.get(channel);
    if (validator) {
      assert.match(handler, new RegExp(`\\b${validator}\\(request\\)`));
      assert.ok(
        handler.indexOf('assertTrustedIpcSender(event)') < handler.indexOf(`${validator}(request)`),
        `${channel} validates data before rejecting an untrusted sender`
      );
    }
  }

  const validRequests = [
    [validateCreateRagEmbeddingInterfaceRequest, {
      name: 'Embedding', baseUrl: 'https://embedding.example/v1',
      embeddingModel: 'embed-v1', credentialMode: 'direct', apiKey: 'secret'
    }],
    [validateUpdateRagEmbeddingInterfaceRequest, {
      id: 'interface-id', name: 'Embedding', baseUrl: 'https://embedding.example/v1',
      embeddingModel: 'embed-v1', credentialMode: 'direct', apiKey: 'secret'
    }],
    [validateDeleteRagEmbeddingInterfaceRequest, { id: 'interface-id' }],
    [validateSelectRagEmbeddingInterfaceRequest, { id: 'interface-id' }],
    [validateRagEmbeddingInterfaceConnectionTestRequest, {
      baseUrl: 'https://embedding.example/v1', embeddingModel: 'embed-v1',
      credentialMode: 'direct', apiKey: 'secret'
    }]
  ];
  for (const [validate, request] of validRequests) {
    assert.throws(
      () => validate({ ...request, unexpected: true }),
      /字段|请求|无效|Embedding|unknown/i
    );
  }

  assert.deepEqual(validateSelectRagEmbeddingInterfaceRequest({ id: null }), { id: null });
});
