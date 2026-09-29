import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModelInterfaces } from '../src/renderer/src/model-interface-search.ts';

const item = (overrides = {}) => ({ id: '11111111-1111-4111-8111-111111111111', name: 'Team API', model: 'gpt-5', baseUrl: 'https://one.test/v1', credentialMode: 'environment', environmentVariableName: 'TEAM_KEY', hasStoredApiKey: false, createdAt: '', updatedAt: '', ...overrides });

test('模糊查询覆盖名称、模型、Base URL 和环境变量名', () => {
  const one = item();
  assert.deepEqual(filterModelInterfaces([one], 'GPT-5'), [one]);
  assert.deepEqual(filterModelInterfaces([one], 'one.test'), [one]);
  assert.deepEqual(filterModelInterfaces([one], 'team_key'), [one]);
});
test('模糊查询不会匹配 API key', () => {
  const one = item();
  assert.deepEqual(filterModelInterfaces([one], 'secret-marker'), []);
});
