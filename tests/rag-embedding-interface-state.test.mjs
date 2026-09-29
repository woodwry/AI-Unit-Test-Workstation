import assert from 'node:assert/strict';
import test from 'node:test';

const state = await import('../src/renderer/src/rag-embedding-interface-state.ts').catch(() => ({}));

const directDraft = {
  name: 'Local Embed',
  baseUrl: 'https://embedding.example.test/v1/',
  embeddingModel: 'text-embedding-3-small',
  credentialMode: 'direct',
  environmentVariableName: '',
  apiKey: 'secret'
};

test('RAG embedding search matches name, model, URL, and environment variable without changing order', () => {
  assert.equal(typeof state.filterRagEmbeddingInterfaces, 'function');
  const interfaces = [
    {
      id: 'first',
      name: 'Remote Vector',
      baseUrl: 'https://vector.example.test/v1',
      embeddingModel: 'bge-m3',
      credentialMode: 'environment',
      environmentVariableName: 'VECTOR_API_KEY'
    },
    {
      id: 'second',
      name: 'Local Embed',
      baseUrl: 'http://127.0.0.1:11434/v1',
      embeddingModel: 'nomic-embed-text',
      credentialMode: 'direct'
    }
  ];

  assert.deepEqual(
    state.filterRagEmbeddingInterfaces(interfaces, 'vector').map((item) => item.id),
    ['first']
  );
  assert.deepEqual(
    state.filterRagEmbeddingInterfaces(interfaces, 'NOMIC').map((item) => item.id),
    ['second']
  );
  assert.deepEqual(
    state.filterRagEmbeddingInterfaces(interfaces, 'api_key').map((item) => item.id),
    ['first']
  );
  assert.deepEqual(
    state.filterRagEmbeddingInterfaces(interfaces, '').map((item) => item.id),
    ['first', 'second']
  );
});

test('opening an existing RAG embedding interface enters edit mode without exposing its saved API key', () => {
  assert.equal(typeof state.reduceRagEmbeddingEditorState, 'function');
  const item = {
    id: 'embed-1',
    name: 'Team Embed',
    baseUrl: 'https://embedding.example.test/v1',
    embeddingModel: 'text-embedding-3-large',
    credentialMode: 'environment',
    environmentVariableName: 'TEAM_EMBEDDING_API_KEY'
  };

  const next = state.reduceRagEmbeddingEditorState(
    state.createInitialRagEmbeddingEditorState(),
    { type: 'edit-started', item }
  );

  assert.equal(next.mode, 'edit');
  assert.equal(next.editingId, 'embed-1');
  assert.deepEqual(next.draft, {
    id: 'embed-1',
    name: 'Team Embed',
    baseUrl: 'https://embedding.example.test/v1',
    embeddingModel: 'text-embedding-3-large',
    credentialMode: 'environment',
    environmentVariableName: 'TEAM_EMBEDDING_API_KEY',
    apiKey: ''
  });
});

test('changing a RAG embedding draft clears stale save and connection feedback', () => {
  const opened = state.reduceRagEmbeddingEditorState(
    state.createInitialRagEmbeddingEditorState(),
    { type: 'create-started' }
  );
  const withFailure = state.reduceRagEmbeddingEditorState(opened, {
    type: 'connection-result-shown',
    result: { ok: false, code: 'network_error', message: 'old failure' }
  });
  const changedDraft = { ...directDraft, name: 'Changed' };

  const next = state.reduceRagEmbeddingEditorState(withFailure, {
    type: 'draft-changed',
    draft: changedDraft
  });

  assert.equal(next.mode, 'create');
  assert.equal(next.feedback, '');
  assert.equal(next.connectionResult, null);
  assert.deepEqual(next.draft, changedDraft);
});

test('RAG embedding create request normalizes the URL and carries only direct credentials', () => {
  assert.equal(state.validateRagEmbeddingInterfaceDraft(directDraft, { mode: 'create' }), null);
  assert.deepEqual(state.buildCreateRagEmbeddingInterfaceRequest(directDraft), {
    name: 'Local Embed',
    baseUrl: 'https://embedding.example.test/v1',
    embeddingModel: 'text-embedding-3-small',
    credentialMode: 'direct',
    apiKey: 'secret'
  });
});

test('RAG embedding environment credential requires a valid environment variable and omits API key', () => {
  const invalid = {
    ...directDraft,
    credentialMode: 'environment',
    environmentVariableName: 'bad-name',
    apiKey: 'must-not-leak'
  };
  assert.equal(
    state.validateRagEmbeddingInterfaceDraft(invalid, { mode: 'create' }),
    '环境变量名格式无效。'
  );

  const valid = { ...invalid, environmentVariableName: 'EMBEDDING_API_KEY' };
  assert.equal(state.validateRagEmbeddingInterfaceDraft(valid, { mode: 'create' }), null);
  assert.deepEqual(state.buildCreateRagEmbeddingInterfaceRequest(valid), {
    name: 'Local Embed',
    baseUrl: 'https://embedding.example.test/v1',
    embeddingModel: 'text-embedding-3-small',
    credentialMode: 'environment',
    environmentVariableName: 'EMBEDDING_API_KEY'
  });
});

test('RAG embedding update may retain a saved direct API key while duplicate names are rejected', () => {
  const updateDraft = { ...directDraft, id: 'embed-1', apiKey: '' };
  assert.equal(
    state.validateRagEmbeddingInterfaceDraft(updateDraft, {
      mode: 'update',
      existingNames: ['Other Interface']
    }),
    null
  );
  assert.deepEqual(state.buildUpdateRagEmbeddingInterfaceRequest(updateDraft), {
    id: 'embed-1',
    name: 'Local Embed',
    baseUrl: 'https://embedding.example.test/v1',
    embeddingModel: 'text-embedding-3-small',
    credentialMode: 'direct'
  });
  assert.equal(
    state.validateRagEmbeddingInterfaceDraft(updateDraft, {
      mode: 'update',
      existingNames: [' local embed ']
    }),
    '接口名称不能重复。'
  );
});

test('RAG embedding connection test excludes display-only name and uses the saved interface identity', () => {
  assert.equal(typeof state.buildRagEmbeddingConnectionTestRequest, 'function');
  assert.deepEqual(
    state.buildRagEmbeddingConnectionTestRequest(
      { ...directDraft, id: 'embed-1', apiKey: '' },
      'embed-1'
    ),
    {
      interfaceId: 'embed-1',
      baseUrl: 'https://embedding.example.test/v1',
      embeddingModel: 'text-embedding-3-small',
      credentialMode: 'direct'
    }
  );
});

test('RAG is configurable only when a resolvable active Embedding interface is ready', async () => {
  assert.equal(typeof state.inspectRagConfigurationReadiness, 'function');
  const activeInterface = {
    schemaVersion: 1,
    interfaces: [{
      id: 'embed-1',
      name: 'Embedding',
      baseUrl: 'https://embedding.example/v1',
      embeddingModel: 'embed-v1',
      credentialMode: 'direct'
    }],
    activeInterfaceId: 'embed-1',
    activeInterfaceConfigured: true,
    secureStorageAvailable: true
  };

  assert.equal(await state.inspectRagConfigurationReadiness({
    getRagEmbeddingInterfaces: async () => activeInterface
  }), true);
  assert.equal(await state.inspectRagConfigurationReadiness({
    getRagEmbeddingInterfaces: async () => ({
      ...activeInterface,
      activeInterfaceConfigured: false
    })
  }), false);
  assert.equal(await state.inspectRagConfigurationReadiness({
    getRagEmbeddingInterfaces: async () => ({
      ...activeInterface,
      activeInterfaceId: null,
      activeInterfaceConfigured: false
    })
  }), false);
});
