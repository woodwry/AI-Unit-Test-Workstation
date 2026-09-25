import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as contracts from '../src/shared/class-task-contracts.ts';

test('class task contracts expose the frozen v2 state vocabularies', () => {
  assert.deepEqual(contracts.METHOD_SELECTION_MODES, ['ALL_BY_DEFAULT', 'EXPLICIT']);
  assert.deepEqual(contracts.MODULE_PRELOAD_STATES, ['IDLE', 'RUNNING', 'READY', 'FAILED']);
  assert.deepEqual(contracts.CLASS_TASK_STATES, [
    'PRELOADING',
    'PRELOAD_FAILED',
    'READY',
    'RUNNING',
    'PAUSE_REQUESTED',
    'PAUSED',
    'STOPPING',
    'TERMINATED',
    'COMPLETED',
    'INTERRUPTED',
    'FAILED'
  ]);
  assert.deepEqual(contracts.CLASS_TASK_ATOMIC_STEPS, [
    'IDLE',
    'ANALYZE_METHOD',
    'MODEL_GENERATION',
    'MODEL_REPAIR',
    'CONFIRM_RESULT',
    'WRITE_CANDIDATE',
    'MAVEN_COMPILE',
    'MAVEN_TEST',
    'PRUNE_FAILED_TESTS',
    'MERGE_METHOD_BATCHES',
    'PACK_FORMAL_FILE',
    'JACOCO_REFRESH'
  ]);
});

test('class task contract maps every named wrapper to its one fixed channel', () => {
  assert.deepEqual(contracts.CLASS_TASK_CHANNELS, {
    add: 'class-task:add',
    remove: 'class-task:remove',
    reorder: 'class-task:reorder',
    list: 'class-task:list',
    getMethods: 'class-task:methods:get',
    checkMethods: 'class-task:methods:check',
    saveSelection: 'class-task:selection:save',
    run: 'class-task:run',
    pause: 'class-task:pause',
    resume: 'class-task:resume',
    terminate: 'class-task:terminate',
    runAll: 'class-task:run-all',
    terminateAll: 'class-task:terminate-all',
    getResult: 'class-task:result:get',
    accept: 'class-task:accept',
    revoke: 'class-task:revoke',
    retryModulePreload: 'module-preload:retry',
    stopModulePreload: 'module-preload:stop',
    snapshotChanged: 'class-task:snapshot-changed'
  });
});

test('class task preload exposes only named fixed-channel wrappers and listener cleanup', async () => {
  const preload = await readFile('src/preload/index.ts', 'utf8');
  const invokeWrappers = {
    addClassTasks: 'add',
    removeClassTask: 'remove',
    reorderClassTasks: 'reorder',
    listClassTasks: 'list',
    getClassTaskMethods: 'getMethods',
    checkClassTaskMethods: 'checkMethods',
    saveClassTaskMethodSelection: 'saveSelection',
    runClassTask: 'run',
    pauseClassTask: 'pause',
    resumeClassTask: 'resume',
    terminateClassTask: 'terminate',
    runAllClassTasks: 'runAll',
    terminateAllClassTasks: 'terminateAll',
    getClassTaskResult: 'getResult',
    acceptClassTask: 'accept',
    revokeClassTask: 'revoke',
    retryModulePreload: 'retryModulePreload',
    stopModulePreload: 'stopModulePreload'
  };
  for (const [wrapper, channelKey] of Object.entries(invokeWrappers)) {
    assert.match(preload, new RegExp(
      `\\b${wrapper}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\(CLASS_TASK_CHANNELS\\.${channelKey},\\s*request\\)`,
      's'
    ));
  }
  assert.match(preload, /\bonClassTaskSnapshotChanged\b/);
  assert.match(preload, /\bgetPathForFile\b/);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.match(preload, /ipcRenderer\.on\(CLASS_TASK_CHANNELS\.snapshotChanged,\s*listener\)/);
  assert.match(preload, /ipcRenderer\.removeListener\([^)]*snapshotChanged[^)]*,\s*listener\)/s);
  assert.doesNotMatch(preload, /\bsaveClassTaskSelection\b/);
  assert.doesNotMatch(preload, /classTask.*(?:ipcRenderer|AbortController|transaction)/i);
});
