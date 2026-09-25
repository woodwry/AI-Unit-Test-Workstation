import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { checkHealthEndpoint } from '../src/main/services/backend-health.service.ts';
import {
  isTrustedWorkspaceModelIpcSender,
  resolvePersistedBackendSettings,
  runTrustedBackendSettingsAction,
  validateBackendSettingsSaveRequest,
  validateCreateModelInterfaceRequest,
  validateRagEmbeddingInterfaceConnectionTestRequest,
  validateSaveWorkstationBuildSettingsRequest,
  validateWorkstationBuildSettingsPathKind,
  validateWorkstationMavenHome
} from '../src/main/services/workspace-model-ipc-validation.ts';

const rendererFile = 'D:\\AI UnitTest\\out\\renderer\\index.html';

test('开发环境只信任协议和 origin 完全一致的顶层 renderer', () => {
  const base = {
    isTopFrame: true,
    isPackaged: false,
    developmentRendererUrl: 'http://localhost:5173/app',
    packagedRendererFile: rendererFile
  };

  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: 'http://localhost:5173/settings?tab=model'
    }),
    true
  );
  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: 'http://localhost:5173.evil.example/'
    }),
    false
  );
  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: 'https://localhost:5173/'
    }),
    false
  );
  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: 'http://localhost:5173/',
      isTopFrame: false
    }),
    false
  );
});

test('打包环境只信任规范化后的唯一 renderer index 文件', () => {
  const target = pathToFileURL(rendererFile);
  target.search = '?tab=model';
  target.hash = '#settings';
  const base = {
    isTopFrame: true,
    isPackaged: true,
    packagedRendererFile: rendererFile
  };

  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: target.href
    }),
    true
  );
  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: pathToFileURL(
        'D:\\AI UnitTest\\out\\renderer\\other.html'
      ).href
    }),
    false
  );
  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: 'https://example.com/index.html'
    }),
    false
  );
});

test('未打包的构建预览在没有开发服务器时只信任唯一 renderer index 文件', () => {
  const base = {
    isTopFrame: true,
    isPackaged: false,
    packagedRendererFile: rendererFile
  };

  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: pathToFileURL(rendererFile).href
    }),
    true
  );
  assert.equal(
    isTrustedWorkspaceModelIpcSender({
      ...base,
      senderUrl: pathToFileURL('D:\\AI UnitTest\\out\\renderer\\other.html').href
    }),
    false
  );
});

test('工作站构建环境请求只接受绝对路径和受支持的选择类型', () => {
  const valid = {
    mavenHome: 'D:\\tools\\maven',
    javaHome: 'D:\\tools\\jdk',
    settingsPath: 'D:\\tools\\maven\\conf\\settings.xml',
    localRepository: 'D:\\m2\\repository'
  };

  assert.deepEqual(
    validateSaveWorkstationBuildSettingsRequest(valid),
    valid
  );
  assert.equal(
    validateWorkstationBuildSettingsPathKind('mavenHome'),
    'mavenHome'
  );
  assert.equal(
    validateWorkstationMavenHome(valid.mavenHome),
    valid.mavenHome
  );
  assert.throws(() =>
    validateSaveWorkstationBuildSettingsRequest({
      ...valid,
      javaHome: 'relative\\jdk'
    })
  );
  assert.throws(() =>
    validateSaveWorkstationBuildSettingsRequest({
      ...valid,
      workspaceRoot: 'D:\\Work\\Demo'
    })
  );
  assert.throws(() =>
    validateWorkstationBuildSettingsPathKind('workspaceRoot')
  );
});

test('大模型接口验证错误不回显 API Key 标记', () => {
  const marker = 'unique-ipc-api-key-marker-94ad';
  let message = '';

  try {
    validateCreateModelInterfaceRequest({
      name: 'Team API',
      baseUrl: 'https://models.example.test/v1',
      model: 'gpt-test',
      credentialMode: 'direct',
      apiKey: marker,
      requestParameters: { stream: true }
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.ok(message);
  assert.doesNotMatch(message, new RegExp(marker));
});

test('当前模型接口只接受 HTTPS 或本机 HTTP Base URL', () => {
  const direct = {
    name: 'Team API',
    model: 'gpt-test',
    credentialMode: 'direct',
    apiKey: 'secret'
  };
  assert.equal(
    validateCreateModelInterfaceRequest({
      ...direct,
      baseUrl: 'http://127.0.0.1:11434/v1/'
    }).baseUrl,
    'http://127.0.0.1:11434/v1'
  );
  assert.throws(() => validateCreateModelInterfaceRequest({
    ...direct,
    baseUrl: 'http://models.example.test/v1'
  }));
  assert.throws(() => validateCreateModelInterfaceRequest({
    ...direct,
    baseUrl: 'https://models.example.test/v1?token=secret'
  }));
  assert.throws(() => validateRagEmbeddingInterfaceConnectionTestRequest({
    baseUrl: 'https://user:secret@models.example.test/v1',
    embeddingModel: 'embedding-test',
    credentialMode: 'direct',
    apiKey: 'secret'
  }));
});

test('后端设置只接受安全的精确字段', () => {
  const valid = {
    agentServiceUrl: 'http://127.0.0.1:18000',
    javaAnalyzerUrl: 'https://analyzer.example.com/java-analyzer'
  };

  assert.deepEqual(validateBackendSettingsSaveRequest(valid), valid);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, agentServiceUrl: 'http://agent.example.com' },
    { ...valid, agentServiceUrl: 'https://user:secret@example.com' },
    {
      ...valid,
      javaAnalyzerUrl: 'https://example.com/path?debug=1'
    },
    { ...valid, javaAnalyzerUrl: 'https://example.com/\nnext' }
  ]) {
    assert.throws(() => validateBackendSettingsSaveRequest(invalid));
  }
});

test('危险的持久化后端地址回退默认值，合法地址保持原值', () => {
  const defaults = {
    agentServiceUrl: 'http://127.0.0.1:18000',
    javaAnalyzerUrl: 'http://127.0.0.1:18001'
  };
  const persisted = {
    agentServiceUrl: 'https://agent.example.com',
    javaAnalyzerUrl: 'https://analyzer.example.com'
  };

  assert.deepEqual(
    resolvePersistedBackendSettings(
      {
        agentServiceUrl: 'http://agent.example.com',
        javaAnalyzerUrl: defaults.javaAnalyzerUrl
      },
      defaults
    ),
    defaults
  );
  assert.deepEqual(
    resolvePersistedBackendSettings(persisted, defaults),
    persisted
  );
});

test('健康检查不会请求危险地址，合法地址只请求精确 health 路径', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    return { ok: true, status: 200 };
  };

  const unsafe = await checkHealthEndpoint(
    'http://agent.example.com',
    fetchImpl
  );
  assert.equal(unsafe.ok, false);
  assert.equal(requestedUrls.length, 0);

  const safe = await checkHealthEndpoint(
    'https://agent.example.com',
    fetchImpl
  );
  assert.equal(safe.ok, true);
  assert.deepEqual(requestedUrls, [
    'https://agent.example.com/api/health'
  ]);
});

test('不可信来源在健康检查之前被拒绝', async () => {
  let calls = 0;

  await assert.rejects(
    runTrustedBackendSettingsAction({
      senderTrusted: false,
      run: async () => {
        calls += 1;
      }
    }),
    /请求来源无效/
  );
  assert.equal(calls, 0);
});

test('大模型接口 IPC 保留高级请求参数的 JSON 类型', () => {
  const request = {
    name: 'Team API',
    baseUrl: 'https://models.example.test/v1',
    model: 'gpt-test',
    credentialMode: 'direct',
    apiKey: 'secret',
    requestParameters: {
      max_tokens: 16384,
      enabled: true,
      label: 'java',
      vendor: { mode: 'strict', stop: ['END'], seed: null }
    }
  };

  assert.deepEqual(validateCreateModelInterfaceRequest(request), request);
});

test('大模型接口 IPC 拒绝保留、危险、超量和非 JSON 高级参数', () => {
  const base = {
    name: 'Team API',
    baseUrl: 'https://models.example.test/v1',
    model: 'gpt-test',
    credentialMode: 'direct',
    apiKey: 'secret'
  };
  const tooMany = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`option_${index}`, index])
  );
  const cases = [
    { stream: true },
    { Tool_Choice: 'auto' },
    { constructor: {} },
    { 'invalid name': 1 },
    tooMany,
    { invalid: undefined },
    { invalid: Number.NaN },
    { large_value: 'x'.repeat(33 * 1024) }
  ];

  for (const requestParameters of cases) {
    assert.throws(() => validateCreateModelInterfaceRequest({
      ...base,
      requestParameters
    }));
  }
});
