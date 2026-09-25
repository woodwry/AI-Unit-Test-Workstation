import test from 'node:test';
import assert from 'node:assert/strict';
import * as modelInterfaceFormState from '../src/renderer/src/model-interface-form-state.ts';
import {
  buildCreateModelInterfaceRequest,
  buildUpdateModelInterfaceRequest,
  isModelInterfaceDraftDirty,
  normalizeInterfaceNameForComparison,
  validateModelInterfaceDraft
} from '../src/renderer/src/model-interface-form-state.ts';

const direct = (overrides = {}) => ({
  name: ' Team API ', baseUrl: 'https://models.example.test/v1/', model: 'gpt-test',
  credentialMode: 'direct', environmentVariableName: '', apiKey: 'secret',
  requestParameters: [], ...overrides
});

test('接口名称比较会忽略首尾空格和大小写', () => {
  assert.equal(normalizeInterfaceNameForComparison('  Team API '), 'team api');
});
test('创建请求会清理名称和 Base URL', () => {
  assert.deepEqual(buildCreateModelInterfaceRequest(direct()), {
    name: 'Team API', baseUrl: 'https://models.example.test/v1', model: 'gpt-test',
    credentialMode: 'direct', apiKey: 'secret'
  });
});
test('环境变量模式不把 API key 带入请求', () => {
  const draft = direct({ credentialMode: 'environment', environmentVariableName: ' TEAM_KEY ', apiKey: 'secret' });
  assert.deepEqual(buildCreateModelInterfaceRequest(draft), {
    name: 'Team API', baseUrl: 'https://models.example.test/v1', model: 'gpt-test',
    credentialMode: 'environment', environmentVariableName: 'TEAM_KEY'
  });
});
test('直接模式创建必须填写 key，编辑可留空保留旧 key', () => {
  assert.equal(validateModelInterfaceDraft(direct({ apiKey: '' }), { mode: 'create' }), '请输入 API Key。');
  assert.equal(validateModelInterfaceDraft(direct({ apiKey: '' }), { mode: 'update' }), null);
});
test('名称重复不区分大小写', () => {
  assert.equal(validateModelInterfaceDraft(direct({ name: 'team api' }), { existingNames: [' Team API '] }), '接口名称不能重复。');
});
test('更新请求保留 id', () => {
  assert.equal(buildUpdateModelInterfaceRequest({ ...direct(), id: '11111111-1111-4111-8111-111111111111' }).id, '11111111-1111-4111-8111-111111111111');
});

test('高级请求参数按 JSON 类型写入创建请求，空配置不增加字段', () => {
  assert.deepEqual(buildCreateModelInterfaceRequest(direct({
    requestParameters: [
      { name: 'max_tokens', value: '16384' },
      { name: 'include_reasoning', value: 'true' },
      { name: 'response_label', value: '"java"' },
      { name: 'vendor.options', value: '{"mode":"strict","stop":["END"],"seed":null}' }
    ]
  })), {
    name: 'Team API',
    baseUrl: 'https://models.example.test/v1',
    model: 'gpt-test',
    credentialMode: 'direct',
    apiKey: 'secret',
    requestParameters: {
      max_tokens: 16384,
      include_reasoning: true,
      response_label: 'java',
      'vendor.options': { mode: 'strict', stop: ['END'], seed: null }
    }
  });

  assert.equal('requestParameters' in buildCreateModelInterfaceRequest(direct()), false);
});

test('高级请求参数拒绝保留名、危险名、重复名、无效名称和无效 JSON', () => {
  const cases = [
    [{ name: 'stream', value: 'true' }],
    [{ name: 'Tool_Choice', value: '"auto"' }],
    [{ name: '__proto__', value: '{}' }],
    [{ name: 'max tokens', value: '100' }],
    [{ name: 'top_p', value: '0.8' }, { name: 'TOP_P', value: '0.7' }],
    [{ name: 'max_tokens', value: 'not-json' }]
  ];

  for (const requestParameters of cases) {
    assert.ok(validateModelInterfaceDraft(direct({ requestParameters })));
  }
});

test('高级请求参数限制数量和总体 JSON 大小', () => {
  const tooMany = Array.from({ length: 33 }, (_, index) => ({
    name: `option_${index}`,
    value: String(index)
  }));
  assert.match(validateModelInterfaceDraft(direct({ requestParameters: tooMany })) ?? '', /最多配置 32 项/);
  assert.match(validateModelInterfaceDraft(direct({
    requestParameters: [{ name: 'large_value', value: JSON.stringify('x'.repeat(33 * 1024)) }]
  })) ?? '', /总大小不能超过 32 KiB/);
});

test('接口视图能恢复为可编辑的 JSON 参数草稿', () => {
  assert.equal(typeof modelInterfaceFormState.buildModelInterfaceDraft, 'function');
  const draft = modelInterfaceFormState.buildModelInterfaceDraft({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Team API',
    baseUrl: 'https://models.example.test/v1',
    model: 'gpt-test',
    credentialMode: 'direct',
    hasStoredApiKey: true,
    requestParameters: {
      max_tokens: 16384,
      vendor: { mode: 'strict' },
      label: 'java'
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z'
  });

  assert.deepEqual(draft.requestParameters, [
    { name: 'max_tokens', value: '16384' },
    { name: 'vendor', value: '{"mode":"strict"}' },
    { name: 'label', value: '"java"' }
  ]);
  assert.equal(draft.apiKey, '');
});

test('高级请求参数变化会将编辑草稿标记为未保存', () => {
  const initial = direct({ requestParameters: [{ name: 'max_tokens', value: '8192' }] });
  assert.equal(isModelInterfaceDraftDirty(initial, initial), false);
  assert.equal(isModelInterfaceDraftDirty(
    direct({ requestParameters: [{ name: 'max_tokens', value: '16384' }] }),
    initial
  ), true);
});
