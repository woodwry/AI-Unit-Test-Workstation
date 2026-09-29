import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCredentialTransportSafe } from '../src/main/services/ai-client.ts';

const context = {
  llmConfig: {
    provider: 'custom_openai',
    model: 'custom-model',
    displayName: '内部平台',
    baseUrl: 'https://models.example.com/v1',
    apiKeyEnvironmentVariable: 'CUSTOM_MODEL_KEY',
    credentials: { apiKey: '测试密钥-marker' }
  }
};

test('HTTP loopback、远程无密钥和远程 HTTPS 均允许', () => {
  for (const url of [
    'http://localhost:18000',
    'http://127.99.1.2',
    'http://[::1]:18000',
    'https://models.example.com'
  ]) {
    assert.doesNotThrow(() => {
      assertCredentialTransportSafe(url, context.llmConfig);
    });
  }
  assert.doesNotThrow(() => {
    assertCredentialTransportSafe(
      'http://models.example.com',
      { ...context.llmConfig, credentials: {} }
    );
  });
});

test('伪 loopback 域名和非 HTTP(S) 协议会被拒绝', () => {
  assert.throws(
    () => assertCredentialTransportSafe(
      'http://127.0.0.1.evil.example',
      context.llmConfig
    ),
    /远程 agent-service/
  );
  assert.throws(
    () => assertCredentialTransportSafe(
      'ftp://127.0.0.1',
      context.llmConfig
    ),
    /仅允许 HTTP 或 HTTPS/
  );
});
