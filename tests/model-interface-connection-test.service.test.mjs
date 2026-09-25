import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelInterfaceConnectionTestService } from '../src/main/services/model-interface-connection-test.service.ts';

test('连接测试只请求 /models 并成功返回', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return new Response('{}', { status: 200 }); };
  try {
    const result = await new ModelInterfaceConnectionTestService().test({ baseUrl: 'https://models.example.test/v1/', model: 'gpt-test', credentialMode: 'direct', apiKey: 'secret' });
    assert.deepEqual(result, { ok: true, code: 'success', message: '连接测试成功。' });
    assert.equal(calls[0][0], 'https://models.example.test/v1/models');
    assert.equal(calls[0][1].method, 'GET');
    assert.equal(calls[0][1].headers.Authorization, 'Bearer secret');
  } finally { globalThis.fetch = original; }
});

test('404/405/501 固定显示平台不支持测试连接', async () => {
  const original = globalThis.fetch;
  for (const status of [404, 405, 501]) {
    globalThis.fetch = async () => new Response('', { status });
    const result = await new ModelInterfaceConnectionTestService().test({ baseUrl: 'https://models.example.test/v1', model: 'gpt-test', credentialMode: 'direct', apiKey: 'secret' });
    assert.deepEqual(result, { ok: false, code: 'unsupported', message: '平台不支持测试连接。' });
  }
  globalThis.fetch = original;
});

test('模型列表未包含文档中的模型别名时仍判定连接与鉴权成功', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    object: 'list',
    data: [
      { id: 'moonshot-v1-8k', object: 'model' },
      { id: 'kimi-k2.5', object: 'model' }
    ]
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  try {
    const result = await new ModelInterfaceConnectionTestService({
      KIMI_API_KEY: 'secret'
    }).test({
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
      credentialMode: 'environment',
      environmentVariableName: 'KIMI_API_KEY'
    });

    assert.deepEqual(result, {
      ok: true,
      code: 'success',
      message: '连接测试成功。'
    });
  } finally {
    globalThis.fetch = original;
  }
});
