import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileClassTaskCommandStart
} from '../src/renderer/src/class-tasks/class-task-command-reconciliation.ts';
import * as commandReconciliation from '../src/renderer/src/class-tasks/class-task-command-reconciliation.ts';

test('a pending command recovers a missed RUNNING snapshot from the main-process task list', async () => {
  const failed = task('FAILED', '2026-08-11T08:00:00.000Z');
  const running = task('RUNNING', '2026-08-11T08:01:00.000Z');
  const observed = [];
  let reads = 0;

  const snapshot = await reconcileClassTaskCommandStart({
    workspaceRoot: failed.workspaceRoot,
    taskId: failed.id,
    initialSnapshot: failed,
    signal: new AbortController().signal,
    listClassTasks: async () => {
      reads += 1;
      return reads === 1 ? [failed] : [running];
    },
    onSnapshot: (value) => observed.push(value),
    wait: async () => undefined,
    maxAttempts: 3
  });

  assert.equal(reads, 2);
  assert.equal(snapshot?.state, 'RUNNING');
  assert.deepEqual(observed.map((value) => value.state), ['RUNNING']);
});

test('an empty run-all response reports that the batch never started instead of staying silent', () => {
  assert.equal(
    commandReconciliation.describeClassTaskRunAllOutcome?.(2, []),
    '批量任务未启动，请重启工作站后重试。'
  );
});

test('a completed run-all response reports failed task results', () => {
  assert.equal(
    commandReconciliation.describeClassTaskRunAllOutcome?.(2, [
      { state: 'FAILED' },
      { state: 'FAILED' }
    ]),
    '批量任务已结束：2 个执行失败。'
  );
});

function task(state, updatedAt) {
  return {
    id: 'task-service',
    workspaceRoot: 'D:\\project',
    state,
    updatedAt,
    currentAtomicStep: state === 'RUNNING' ? 'ANALYZE_METHOD' : 'IDLE'
  };
}
