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

test('连接测试使用未保存的参数草稿，并且不要求接口名称', () => {
  assert.equal(typeof modelInterfaceFormState.buildModelInterfaceConnectionTestRequest, 'function');
  assert.deepEqual(modelInterfaceFormState.buildModelInterfaceConnectionTestRequest(direct({
    name: '', id: 'existing', apiKey: '', requestParameters: [
      { name: 'thinking', value: '{"type":"enabled"}' },
      { name: 'reasoning_effort', value: 'max' }
    ]
  })), { interfaceId: 'existing', baseUrl: 'https://models.example.test/v1',
    model: 'gpt-test', credentialMode: 'direct',
    requestParameters: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } });
});

test('新接口的连接测试支持环境变量，拒绝格式错误的高级参数', () => {
  assert.equal(typeof modelInterfaceFormState.buildModelInterfaceConnectionTestRequest, 'function');
  const build = modelInterfaceFormState.buildModelInterfaceConnectionTestRequest;
  assert.deepEqual(build(direct({ id: 'new', credentialMode: 'environment',
    environmentVariableName: ' TEST_MODEL_KEY ' })), {
    baseUrl: 'https://models.example.test/v1', model: 'gpt-test',
    credentialMode: 'environment', environmentVariableName: 'TEST_MODEL_KEY'
  });
  assert.throws(() => build(direct({ requestParameters: [
    { name: 'thinking', value: '{broken}' }
  ] })), /JSON/);
  assert.throws(() => build(direct({ apiKey: '' })), /API Key/);
});

test('高级请求参数接受裸文本，并保留数字、布尔值和结构化 JSON 类型', () => {
  const draft = direct({ requestParameters: [
    { name: 'mode', value: ' enabled ' },
    { name: 'effort', value: 'max' },
    { name: 'label', value: '单元测试' },
    { name: 'max_tokens', value: '256000' },
    { name: 'enabled', value: 'false' },
    { name: 'optional', value: 'null' },
    { name: 'options', value: '{"type":"enabled"}' },
    { name: 'stop', value: '["END"]' },
    { name: 'string_number', value: '"123"' }
  ] });
  assert.equal(validateModelInterfaceDraft(draft), null);
  assert.deepEqual(buildCreateModelInterfaceRequest(draft).requestParameters, {
    mode: 'enabled', effort: 'max', label: '单元测试', max_tokens: 256000,
    enabled: false, optional: null, options: { type: 'enabled' }, stop: ['END'], string_number: '123'
  });
});

test('格式错误的对象、数组或带引号字符串仍提示错误，不静默转换成文本', () => {
  for (const value of ['{"type":enabled}', '["END",]', '"max', '   ']) {
    const draft = direct({ requestParameters: [{ name: 'option', value }] });
    assert.ok(validateModelInterfaceDraft(draft));
    assert.throws(() => buildCreateModelInterfaceRequest(draft));
  }
});

test('高级请求参数拒绝保留名、危险名、重复名、无效名称和无效 JSON', () => {
  const cases = [
    [{ name: 'stream', value: 'true' }],
    [{ name: 'Tool_Choice', value: '"auto"' }],
    [{ name: '__proto__', value: '{}' }],
    [{ name: 'max tokens', value: '100' }],
    [{ name: 'top_p', value: '0.8' }, { name: 'TOP_P', value: '0.7' }],
    [{ name: 'options', value: '{invalid-json}' }]
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
    { name: 'label', value: 'java' }
  ]);
  assert.equal(draft.apiKey, '');
});

test('恢复参数时普通字符串显示为裸文本，容易混淆类型的字符串能完整往返', () => {
  const values = {
    mode: 'enabled', effort: 'max', booleanText: 'true', numberText: '123', nullText: 'null',
    objectText: '{"type":"enabled"}', brokenJsonText: '{text}', emptyText: '', spacedText: ' max '
  };
  const draft = modelInterfaceFormState.buildModelInterfaceDraft({
    id: '11111111-1111-4111-8111-111111111111', ...direct(), hasStoredApiKey: true,
    requestParameters: values, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z'
  });
  assert.deepEqual(draft.requestParameters.slice(0, 2), [
    { name: 'mode', value: 'enabled' }, { name: 'effort', value: 'max' }
  ]);
  assert.deepEqual(buildUpdateModelInterfaceRequest(draft).requestParameters, values);
});

test('高级请求参数变化会将编辑草稿标记为未保存', () => {
  const initial = direct({ requestParameters: [{ name: 'max_tokens', value: '8192' }] });
  assert.equal(isModelInterfaceDraftDirty(initial, initial), false);
  assert.equal(isModelInterfaceDraftDirty(
    direct({ requestParameters: [{ name: 'max_tokens', value: '16384' }] }),
    initial
  ), true);
});
