import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveTokenUsageDisplay
} from '../src/renderer/src/model-token-usage.ts';

test('未调用模型时显示三个零', () => {
  assert.deepEqual(
    resolveTokenUsageDisplay(undefined, 0, 0),
    { input: '0', output: '0', total: '0' }
  );
});

test('模型已调用但供应商未上报时显示未上报', () => {
  assert.deepEqual(
    resolveTokenUsageDisplay(undefined, 2, 0),
    { input: '未上报', output: '未上报', total: '未上报' }
  );
});

test('使用千分位显示供应商上报的 Token', () => {
  assert.deepEqual(
    resolveTokenUsageDisplay({
      inputTokens: 12_345,
      outputTokens: 678,
      totalTokens: 13_023
    }, 2, 2),
    { input: '12,345', output: '678', total: '13,023' }
  );
});

test('部分字段缺失时只把缺失字段显示为未上报', () => {
  assert.deepEqual(
    resolveTokenUsageDisplay({ inputTokens: 10 }, 1, 1),
    { input: '10', output: '未上报', total: '未上报' }
  );
});

test('旧后端没有计数和 usage 时保持未知语义', () => {
  assert.deepEqual(
    resolveTokenUsageDisplay(undefined, undefined, undefined),
    { input: '未上报', output: '未上报', total: '未上报' }
  );
});
