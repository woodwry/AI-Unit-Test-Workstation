import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RagEmbeddingInterfacesService } from '../src/main/services/rag-embedding-interfaces.service.ts';
import { RagEmbeddingInterfacesStore } from '../src/main/services/rag-embedding-interfaces.store.ts';
import { RagEmbeddingInterfaceCredentialsStore } from '../src/main/services/rag-embedding-interface-credentials.store.ts';

function cipher() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => Buffer.from(value).toString().replace(/^sealed:/, '')
  };
}

async function makeService(environment = {}, credentialCipher = cipher()) {
  const directory = await mkdtemp(join(tmpdir(), 'rag-embedding-interface-'));
  const settingsPath = join(directory, 'rag-embedding-interfaces.json');
  const credentialsPath = join(directory, 'rag-embedding-interface-credentials.json');
  const settingsStore = new RagEmbeddingInterfacesStore(settingsPath);
  const credentialsStore = new RagEmbeddingInterfaceCredentialsStore(credentialsPath);
  const service = new RagEmbeddingInterfacesService(
    settingsStore,
    credentialsStore,
    credentialCipher,
    environment
  );
  return { directory, settingsPath, credentialsPath, settingsStore, credentialsStore, service };
}

const directRequest = {
  name: 'Local Embeddings',
  baseUrl: 'https://embeddings.example.test/v1/',
  embeddingModel: 'text-embedding-test',
  credentialMode: 'direct',
  apiKey: 'embedding-secret-marker'
};

test('creates, lists, selects, and resolves an independent embedding interface without exposing its API key', async () => {
  const fixture = await makeService();
  try {
    const created = await fixture.service.create(directRequest);
    assert.equal(created.activeInterfaceId, null);
    assert.equal(created.activeInterfaceConfigured, false);
    assert.equal(created.interfaces.length, 1);
    assert.deepEqual(Object.keys(created.interfaces[0]).sort(), [
      'baseUrl',
      'createdAt',
      'credentialMode',
      'embeddingModel',
      'hasStoredApiKey',
      'id',
      'name',
      'updatedAt'
    ]);
    assert.equal(created.interfaces[0].baseUrl, 'https://embeddings.example.test/v1');
    assert.equal(created.interfaces[0].hasStoredApiKey, true);
    assert.equal(JSON.stringify(created).includes(directRequest.apiKey), false);

    const listed = await fixture.service.getView();
    assert.deepEqual(listed, created);
    assert.deepEqual(await fixture.service.list(), created);
    const selected = await fixture.service.select({ id: created.interfaces[0].id });
    assert.equal(selected.activeInterfaceConfigured, true);

    const runtime = await fixture.service.resolveRuntime();
    assert.deepEqual(runtime, {
      interfaceId: created.interfaces[0].id,
      interfaceName: 'Local Embeddings',
      embeddingModel: 'text-embedding-test',
      embeddingConfig: {
        provider: 'custom_openai',
        model: 'text-embedding-test',
        baseUrl: 'https://embeddings.example.test/v1',
        credentials: { apiKey: directRequest.apiKey }
      }
    });

    const settingsJson = await readFile(fixture.settingsPath, 'utf8');
    const credentialsJson = await readFile(fixture.credentialsPath, 'utf8');
    assert.equal(settingsJson.includes(directRequest.apiKey), false);
    assert.equal(credentialsJson.includes(directRequest.apiKey), false);
    assert.equal(JSON.parse(settingsJson).activeInterfaceId, created.interfaces[0].id);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('reuses a stored API key for connection tests only with the exact saved endpoint and model', async () => {
  const fixture = await makeService();
  try {
    const view = await fixture.service.create(directRequest);
    const interfaceId = view.interfaces[0].id;
    const exactRequest = {
      interfaceId,
      baseUrl: 'https://embeddings.example.test/v1',
      embeddingModel: 'text-embedding-test',
      credentialMode: 'direct'
    };

    assert.equal(
      await fixture.service.resolveStoredApiKeyForConnectionTest(exactRequest),
      directRequest.apiKey
    );
    assert.equal(await fixture.service.resolveStoredApiKeyForConnectionTest({
      ...exactRequest,
      baseUrl: 'https://attacker.example/v1'
    }), undefined);
    assert.equal(await fixture.service.resolveStoredApiKeyForConnectionTest({
      ...exactRequest,
      embeddingModel: 'different-model'
    }), undefined);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('resolves environment credentials only at runtime and never marks them as stored API keys', async () => {
  const fixture = await makeService({ RAG_EMBEDDING_KEY_TEST: 'environment-embedding-secret' });
  try {
    const view = await fixture.service.create({
      name: 'Environment Embeddings',
      baseUrl: 'http://127.0.0.1:8080/v1',
      embeddingModel: 'embed-local',
      credentialMode: 'environment',
      environmentVariableName: 'RAG_EMBEDDING_KEY_TEST'
    });
    assert.equal(view.interfaces[0].hasStoredApiKey, false);
    assert.equal(view.interfaces[0].environmentVariableName, 'RAG_EMBEDDING_KEY_TEST');
    await fixture.service.select({ id: view.interfaces[0].id });

    const runtime = await fixture.service.resolveRuntime();
    assert.equal(runtime.credentialEnvironmentVariable, 'RAG_EMBEDDING_KEY_TEST');
    assert.equal(runtime.embeddingConfig.credentials.apiKey, 'environment-embedding-secret');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('reports an active Embedding interface as unconfigured when its runtime credential cannot resolve', async () => {
  const fixture = await makeService({});
  try {
    const created = await fixture.service.create({
      name: 'Missing Environment Embeddings',
      baseUrl: 'http://127.0.0.1:8080/v1',
      embeddingModel: 'embed-local',
      credentialMode: 'environment',
      environmentVariableName: 'MISSING_RAG_EMBEDDING_KEY'
    });

    const selected = await fixture.service.select({ id: created.interfaces[0].id });

    assert.equal(selected.activeInterfaceId, created.interfaces[0].id);
    assert.equal(selected.activeInterfaceConfigured, false);
    await assert.rejects(() => fixture.service.resolveRuntime(), /MISSING_RAG_EMBEDDING_KEY/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('updates credentials safely and removes encrypted credentials when switching to environment mode', async () => {
  const fixture = await makeService({ RAG_EMBEDDING_UPDATED_KEY: 'environment-secret' });
  try {
    let view = await fixture.service.create(directRequest);
    const id = view.interfaces[0].id;
    await fixture.service.select({ id });

    view = await fixture.service.update({
      id,
      name: 'Renamed Embeddings',
      baseUrl: directRequest.baseUrl,
      embeddingModel: 'embed-renamed',
      credentialMode: 'direct'
    });
    assert.equal(view.interfaces[0].hasStoredApiKey, true);
    assert.equal((await fixture.service.resolveRuntime()).embeddingConfig.credentials.apiKey, directRequest.apiKey);

    view = await fixture.service.update({
      id,
      name: 'Environment Embeddings',
      baseUrl: directRequest.baseUrl,
      embeddingModel: 'embed-environment',
      credentialMode: 'environment',
      environmentVariableName: 'RAG_EMBEDDING_UPDATED_KEY'
    });
    assert.equal(view.interfaces[0].hasStoredApiKey, false);
    assert.equal(await fixture.credentialsStore.get(id), undefined);
    assert.equal((await fixture.service.resolveRuntime()).embeddingConfig.credentials.apiKey, 'environment-secret');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('requires a new API key when changing an environment interface to API-key mode', async () => {
  const fixture = await makeService({ RAG_EMBEDDING_SWITCH_KEY: 'environment-secret' });
  try {
    const view = await fixture.service.create({
      name: 'Environment Embeddings',
      baseUrl: 'https://embeddings.example.test/v1',
      embeddingModel: 'embed-environment',
      credentialMode: 'environment',
      environmentVariableName: 'RAG_EMBEDDING_SWITCH_KEY'
    });
    const id = view.interfaces[0].id;

    await assert.rejects(() => fixture.service.update({
      id,
      name: 'API Embeddings',
      baseUrl: 'https://embeddings.example.test/v1',
      embeddingModel: 'embed-api',
      credentialMode: 'direct'
    }), /API Key/);

    const unchanged = await fixture.service.getView();
    assert.equal(unchanged.interfaces[0].credentialMode, 'environment');
    assert.equal(unchanged.interfaces[0].environmentVariableName, 'RAG_EMBEDDING_SWITCH_KEY');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('deleting the active interface clears only the independent embedding selection and credential', async () => {
  const fixture = await makeService();
  try {
    const view = await fixture.service.create(directRequest);
    const id = view.interfaces[0].id;
    await fixture.service.select({ id });
    const deleted = await fixture.service.delete({ id });

    assert.equal(deleted.activeInterfaceId, null);
    assert.deepEqual(deleted.interfaces, []);
    assert.equal(await fixture.credentialsStore.get(id), undefined);
    assert.equal(await fixture.service.resolveRuntime(), null);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('reports hasStoredApiKey from the independent credential store rather than credential mode alone', async () => {
  const fixture = await makeService();
  try {
    const view = await fixture.service.create(directRequest);
    const id = view.interfaces[0].id;
    await fixture.credentialsStore.delete(id);

    const withoutCredential = await fixture.service.getView();
    assert.equal(withoutCredential.interfaces[0].credentialMode, 'direct');
    assert.equal(withoutCredential.interfaces[0].hasStoredApiKey, false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects duplicate names and invalid endpoint, model, and environment variable values', async () => {
  const fixture = await makeService();
  try {
    await fixture.service.create({
      name: 'Team Embeddings',
      baseUrl: 'https://embeddings.example.test/v1',
      embeddingModel: 'embed-model',
      credentialMode: 'environment',
      environmentVariableName: 'TEAM_EMBEDDING_KEY'
    });
    await assert.rejects(() => fixture.service.create({
      name: ' team embeddings ',
      baseUrl: 'https://embeddings.example.test/v1',
      embeddingModel: 'embed-model',
      credentialMode: 'environment',
      environmentVariableName: 'TEAM_EMBEDDING_KEY'
    }), /名称.*重复/);
    await assert.rejects(() => fixture.service.create({
      ...directRequest,
      name: 'Insecure Remote',
      baseUrl: 'http://embeddings.example.test/v1'
    }), /Base URL/);
    await assert.rejects(() => fixture.service.create({
      ...directRequest,
      name: 'Missing Model',
      embeddingModel: '   '
    }), /Embedding 模型/);
    await assert.rejects(() => fixture.service.create({
      name: 'Bad Environment',
      baseUrl: 'https://embeddings.example.test/v1',
      embeddingModel: 'embed-model',
      credentialMode: 'environment',
      environmentVariableName: 'BAD-NAME'
    }), /环境变量/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('never repeats a submitted API key in secure-storage errors', async () => {
  const secret = 'do-not-repeat-this-secret';
  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error(`cipher leaked ${secret}`); },
    decryptString: () => { throw new Error(`cipher leaked ${secret}`); }
  };
  const fixture = await makeService({}, unavailable);
  try {
    await assert.rejects(
      () => fixture.service.create({ ...directRequest, apiKey: secret }),
      (error) => error instanceof Error && !error.message.includes(secret) && /安全存储/.test(error.message)
    );
    assert.deepEqual((await fixture.service.getView()).interfaces, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('replaces secret-bearing cipher failures with a bounded product error', async () => {
  const secret = 'cipher-error-secret-marker';
  const failingCipher = {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error(`failed to encrypt ${secret}`); },
    decryptString: () => { throw new Error(`failed to decrypt ${secret}`); }
  };
  const fixture = await makeService({}, failingCipher);
  try {
    await assert.rejects(
      () => fixture.service.create({ ...directRequest, apiKey: secret }),
      (error) => error instanceof Error
        && !error.message.includes(secret)
        && error.message === 'API Key 安全加密失败，请重试。'
    );
    assert.deepEqual((await fixture.service.getView()).interfaces, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('serializes concurrent creates without losing either embedding interface', async () => {
  const fixture = await makeService();
  try {
    await Promise.all([
      fixture.service.create({ ...directRequest, name: 'Embedding A', apiKey: 'secret-a' }),
      fixture.service.create({ ...directRequest, name: 'Embedding B', apiKey: 'secret-b' })
    ]);
    assert.deepEqual(
      (await fixture.service.getView()).interfaces.map((item) => item.name),
      ['Embedding A', 'Embedding B']
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
