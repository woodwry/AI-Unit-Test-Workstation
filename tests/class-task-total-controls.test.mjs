import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classTaskTotalRunEligibleIds,
  resolveClassTaskTotalControl
} from '../src/renderer/src/class-tasks/class-task-card-view.ts';

test('total control starts every eligible pending task before offering termination', () => {
  const mixed = [task('RUNNING', 'running'), task('READY', 'ready'), task('TERMINATED', 'terminated')];
  assert.deepEqual(resolveClassTaskTotalControl(mixed), { kind: 'run', eligibleCount: 2 });

  const activeOnly = [task('RUNNING', 'one'), task('PAUSE_REQUESTED', 'two'), task('STOPPING', 'three')];
  assert.deepEqual(resolveClassTaskTotalControl(activeOnly), { kind: 'terminate', activeCount: 3 });
});

test('one paused task switches the total control from terminate to execute', () => {
  const tasks = [
    task('RUNNING', 'running'),
    task('PAUSED', 'paused'),
    task('PAUSE_REQUESTED', 'pausing')
  ];

  assert.deepEqual(resolveClassTaskTotalControl(tasks), { kind: 'run', eligibleCount: 1 });
  assert.deepEqual(classTaskTotalRunEligibleIds(tasks), ['paused']);
});

test('preloading and failed-preload tasks are excluded from total execution', () => {
  assert.deepEqual(
    resolveClassTaskTotalControl([task('PRELOADING', 'one'), task('PRELOAD_FAILED', 'two')]),
    { kind: 'idle' }
  );
});

test('one ready legacy default-all task cannot enable total execution without selected methods', () => {
  const defaultAll = {
    ...task('READY', 'default-all'),
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: []
  };

  assert.deepEqual(
    resolveClassTaskTotalControl([
      defaultAll,
      task('PRELOADING', 'preloading-one'),
      task('PRELOADING', 'preloading-two')
    ]),
    { kind: 'idle' }
  );
});

test('total execution counts only runnable tasks that do not already have a command in flight', () => {
  const tasks = [
    task('PRELOADING', 'preloading'),
    task('READY', 'already-dispatched'),
    task('READY', 'available')
  ];

  assert.deepEqual(
    resolveClassTaskTotalControl(tasks, new Set(['preloading', 'already-dispatched'])),
    { kind: 'run', eligibleCount: 1 }
  );
});

test('one selected failed task enables total execution when another task has not failed', () => {
  const selectedFailure = task('FAILED', 'selected-failure');
  const unselectedReady = {
    ...task('READY', 'unselected-ready'),
    selectedMethodIds: []
  };

  assert.deepEqual(
    resolveClassTaskTotalControl([selectedFailure, unselectedReady]),
    { kind: 'run', eligibleCount: 1 }
  );
});

test('total execution retries every selected task when every task has failed', () => {
  const failedTasks = [
    task('FAILED', 'failed-one'),
    task('FAILED', 'failed-two')
  ];

  assert.deepEqual(resolveClassTaskTotalControl(failedTasks), { kind: 'run', eligibleCount: 2 });
  assert.deepEqual(classTaskTotalRunEligibleIds(failedTasks), ['failed-one', 'failed-two']);
});

test('total execution excludes completed and terminated results awaiting accept or revoke', () => {
  const pendingCompleted = {
    ...task('COMPLETED', 'pending'),
    generatedArtifacts: [{ accepted: false }]
  };
  const pendingTerminated = {
    ...task('TERMINATED', 'terminated-pending'),
    generatedArtifacts: [{ accepted: false }]
  };
  const accepted = {
    ...task('COMPLETED', 'accepted'),
    generatedArtifacts: [{ accepted: true }]
  };
  const revoked = task('COMPLETED', 'revoked');

  assert.deepEqual(
    resolveClassTaskTotalControl([pendingCompleted, pendingTerminated, accepted, revoked]),
    { kind: 'run', eligibleCount: 2 }
  );
  assert.deepEqual(
    classTaskTotalRunEligibleIds([pendingCompleted, pendingTerminated, accepted, revoked]),
    ['accepted', 'revoked']
  );
  assert.deepEqual(
    resolveClassTaskTotalControl([pendingCompleted, pendingTerminated]),
    { kind: 'idle' }
  );
});

function task(state, id) {
  return {
    id,
    state,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method'],
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    generatedArtifacts: []
  };
}
