import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRepairConfiguration
} from '../src/renderer/src/class-tasks/method-configuration-repair-state.ts';

test('finite repair configuration requires one positive integer without a business maximum', () => {
  assert.deepEqual(resolveRepairConfiguration('', false), {
    valid: false,
    message: '请填写修复轮次或勾选无限制'
  });
  for (const value of ['0', '-1', '1.5', 'not-a-number']) {
    assert.deepEqual(resolveRepairConfiguration(value, false), {
      valid: false,
      message: '修复轮次必须是正整数'
    });
  }
  assert.deepEqual(resolveRepairConfiguration('1000000', false), {
    valid: true,
    repairAttemptLimit: 1_000_000,
    unlimitedRepair: false
  });
});

test('unlimited repair disables the finite value semantically', () => {
  assert.deepEqual(resolveRepairConfiguration('', true), {
    valid: true,
    repairAttemptLimit: null,
    unlimitedRepair: true
  });
  assert.deepEqual(resolveRepairConfiguration('7', true), {
    valid: true,
    repairAttemptLimit: null,
    unlimitedRepair: true
  });
});
