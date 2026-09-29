import assert from 'node:assert/strict';
import test from 'node:test';
import { canCloseModelSettings } from '../src/renderer/src/model-settings-request-state.ts';

test('保存或删除 pending 时拒绝关闭，settle 后成功失败都允许关闭', () => {
  assert.equal(canCloseModelSettings(true), false);
  assert.equal(canCloseModelSettings(false), true);
});
