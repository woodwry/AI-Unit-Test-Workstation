import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkstationModelInterfacesService } from '../src/main/services/workstation-model-interfaces.service.ts';
import { WorkstationModelInterfacesStore } from '../src/main/services/workstation-model-interfaces.store.ts';
import { WorkstationModelInterfaceCredentialsStore } from '../src/main/services/workstation-model-interface-credentials.store.ts';

function cipher() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`enc:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^enc:/, '') };
}
async function makeService(environment = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'model-interface-'));
  return { directory, service: new WorkstationModelInterfacesService(new WorkstationModelInterfacesStore(join(directory, 'interfaces.json')), new WorkstationModelInterfaceCredentialsStore(join(directory, 'credentials.json')), cipher(), environment) };
}

test('创建、查询和解析活动接口，查询视图不包含 API key', async () => {
  const { directory, service } = await makeService();
  try {
    const view = await service.create({ name: 'Team', baseUrl: 'https://models.example.test/v1', model: 'gpt-test', credentialMode: 'direct', apiKey: 'secret-marker' });
    assert.equal(view.interfaces[0].hasStoredApiKey, true);
    assert.equal(JSON.stringify(view).includes('secret-marker'), false);
    await service.select({ id: view.interfaces[0].id });
    const runtime = await service.resolveForGeneration();
    assert.equal(runtime.llmConfig.provider, 'custom_openai');
    assert.equal(runtime.llmConfig.credentials.apiKey, 'secret-marker');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('接口名称不允许大小写和外层空格重复', async () => {
  const { directory, service } = await makeService();
  try {
    await service.create({ name: 'Team', baseUrl: 'https://models.example.test/v1', model: 'gpt-test', credentialMode: 'environment', environmentVariableName: 'TEAM_KEY' });
    await assert.rejects(() => service.create({ name: ' team ', baseUrl: 'https://models.example.test/v1', model: 'gpt-test', credentialMode: 'environment', environmentVariableName: 'TEAM_KEY' }), /不能重复/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('环境变量模式只在解析运行时读取变量', async () => {
  const { directory, service } = await makeService({ TEAM_KEY: 'environment-secret' });
  try {
    const view = await service.create({ name: 'Env', baseUrl: 'https://models.example.test/v1', model: 'gpt-test', credentialMode: 'environment', environmentVariableName: 'TEAM_KEY' });
    await service.select({ id: view.interfaces[0].id });
    const runtime = await service.resolveForGeneration();
    assert.equal(runtime.credentialEnvironmentVariable, 'TEAM_KEY');
    assert.equal(runtime.llmConfig.credentials.apiKey, 'environment-secret');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('高级请求参数会持久化、出现在视图并进入生成配置', async () => {
  const { directory, service } = await makeService();
  try {
    const requestParameters = {
      max_tokens: 16384,
      vendor: { mode: 'strict', stop: ['END'] }
    };
    const view = await service.create({
      name: 'Parameters',
      baseUrl: 'https://models.example.test/v1',
      model: 'gpt-test',
      credentialMode: 'direct',
      apiKey: 'secret',
      requestParameters
    });
    assert.deepEqual(view.interfaces[0].requestParameters, requestParameters);

    const persisted = JSON.parse(await readFile(join(directory, 'interfaces.json'), 'utf8'));
    assert.deepEqual(Object.values(persisted.interfaces)[0].requestParameters, requestParameters);

    await service.select({ id: view.interfaces[0].id });
    const runtime = await service.resolveForGeneration();
    assert.deepEqual(runtime.llmConfig.requestParameters, requestParameters);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('更新时删除全部高级请求参数会清除旧配置', async () => {
  const { directory, service } = await makeService();
  try {
    const created = await service.create({
      name: 'Parameters',
      baseUrl: 'https://models.example.test/v1',
      model: 'gpt-test',
      credentialMode: 'direct',
      apiKey: 'secret',
      requestParameters: {
        max_tokens: 16384,
        thinking: { type: 'disabled' }
      }
    });
    const id = created.interfaces[0].id;

    const updated = await service.update({
      id,
      name: 'Parameters',
      baseUrl: 'https://models.example.test/v1',
      model: 'gpt-test',
      credentialMode: 'direct'
    });

    assert.equal('requestParameters' in updated.interfaces[0], false);
    const persisted = JSON.parse(await readFile(join(directory, 'interfaces.json'), 'utf8'));
    assert.equal('requestParameters' in persisted.interfaces[id], false);
    await service.select({ id });
    const runtime = await service.resolveForGeneration();
    assert.equal('requestParameters' in runtime.llmConfig, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('未配置高级请求参数时不向后端增加字段，旧配置仍可读取', async () => {
  const { directory, service } = await makeService();
  try {
    const view = await service.create({
      name: 'Default',
      baseUrl: 'https://models.example.test/v1',
      model: 'gpt-test',
      credentialMode: 'direct',
      apiKey: 'secret'
    });
    await service.select({ id: view.interfaces[0].id });
    const runtime = await service.resolveForGeneration();
    assert.equal('requestParameters' in runtime.llmConfig, false);
    assert.equal('requestParameters' in view.interfaces[0], false);

    const legacyDirectory = await mkdtemp(join(tmpdir(), 'model-interface-legacy-'));
    try {
      const id = '11111111-1111-4111-8111-111111111111';
      await writeFile(join(legacyDirectory, 'interfaces.json'), JSON.stringify({
        schemaVersion: 2,
        activeInterfaceId: id,
        interfaces: {
          [id]: {
            id,
            name: 'Legacy',
            baseUrl: 'https://models.example.test/v1',
            model: 'gpt-test',
            credentialMode: 'environment',
            environmentVariableName: 'LEGACY_KEY',
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z'
          }
        }
      }), 'utf8');
      const legacyService = new WorkstationModelInterfacesService(
        new WorkstationModelInterfacesStore(join(legacyDirectory, 'interfaces.json')),
        new WorkstationModelInterfaceCredentialsStore(join(legacyDirectory, 'credentials.json')),
        cipher(),
        { LEGACY_KEY: 'legacy-secret' }
      );
      const legacyRuntime = await legacyService.resolveForGeneration();
      assert.equal('requestParameters' in legacyRuntime.llmConfig, false);
    } finally {
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
