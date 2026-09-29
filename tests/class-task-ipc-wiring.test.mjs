import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CLASS_TASK_CHANNELS } from '../src/shared/class-task-contracts.ts';
import { registerClassTaskIpc } from '../src/main/ipc/class-task.ipc.ts';

const WORKSPACE = 'D:\\workspace';
const OTHER_WORKSPACE = 'D:\\other';
const TASK_ID = '11111111-1111-4111-8111-111111111111';

function requestFor(channel) {
  if (channel === CLASS_TASK_CHANNELS.add) {
    return {
      workspaceRoot: WORKSPACE,
      classFilePaths: [`${WORKSPACE}\\src\\main\\java\\example\\Task.java`]
    };
  }
  if (channel === CLASS_TASK_CHANNELS.reorder) {
    return { workspaceRoot: WORKSPACE, taskIds: [TASK_ID] };
  }
  if (channel === CLASS_TASK_CHANNELS.saveSelection) {
    return {
      workspaceRoot: WORKSPACE,
      taskId: TASK_ID,
      selectionMode: 'EXPLICIT',
      selectedMethodIds: ['method-id'],
      methodOrder: ['method-id'],
      ragEnabled: false,
      repairAttemptLimit: 5,
      unlimitedRepair: false
    };
  }
  if (channel === CLASS_TASK_CHANNELS.checkMethods) {
    return {
      workspaceRoot: WORKSPACE,
      taskId: TASK_ID,
      fingerprint: 'a'.repeat(64)
    };
  }
  if (
    channel === CLASS_TASK_CHANNELS.list
    || channel === CLASS_TASK_CHANNELS.runAll
    || channel === CLASS_TASK_CHANNELS.terminateAll
  ) {
    return { workspaceRoot: WORKSPACE };
  }
  return { workspaceRoot: WORKSPACE, taskId: TASK_ID };
}

function createHarness() {
  const handlers = new Map();
  const removed = [];
  const calls = [];
  const ipcMain = {
    handle(channel, listener) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
      removed.push(channel);
    }
  };
  const runtime = {};
  const methods = [
    'addClassTasks', 'removeClassTask', 'reorderClassTasks', 'listClassTasks', 'getClassTaskMethods',
    'checkClassTaskMethods',
    'saveMethodSelection', 'runTask', 'pauseTask', 'resumeTask', 'terminateTask',
    'runAll', 'terminateAll', 'getTaskResult', 'acceptTaskResult',
    'revokeTaskResult', 'retryModulePreload', 'stopModulePreload'
  ];
  for (const method of methods) {
    runtime[method] = async (request) => {
      calls.push({ method, request });
      return method;
    };
  }
  let trusted = true;
  let activeWorkspaceRoot = WORKSPACE;
  let shuttingDown = false;
  const dispose = registerClassTaskIpc({
    ipcMain,
    runtime,
    isTrustedSender: () => trusted,
    getActiveWorkspaceRoot: () => activeWorkspaceRoot,
    isShuttingDown: () => shuttingDown
  });
  return {
    handlers,
    removed,
    calls,
    dispose,
    setTrusted(value) { trusted = value; },
    setActiveWorkspace(value) { activeWorkspaceRoot = value; },
    setShuttingDown(value) { shuttingDown = value; },
    runtime
  };
}

test('registers every frozen request channel and removes only those handlers on dispose', () => {
  const harness = createHarness();
  const requestChannels = Object.values(CLASS_TASK_CHANNELS)
    .filter((channel) => channel !== CLASS_TASK_CHANNELS.snapshotChanged);

  assert.deepEqual([...harness.handlers.keys()].sort(), [...requestChannels].sort());
  harness.dispose();
  assert.deepEqual([...new Set(harness.removed)].sort(), [...requestChannels].sort());
  assert.equal(harness.handlers.size, 0);
});

test('rejects an untrusted sender before request validation or runtime invocation', async () => {
  const harness = createHarness();
  harness.setTrusted(false);
  const handler = harness.handlers.get(CLASS_TASK_CHANNELS.add);

  await assert.rejects(
    handler({ sender: {} }, { malformed: true }),
    /不受信任|untrusted/i
  );
  assert.deepEqual(harness.calls, []);
});

test('every handler applies an exact validator and active-workspace guard before runtime', async () => {
  const harness = createHarness();
  for (const [channel, handler] of harness.handlers) {
    const request = requestFor(channel);
    await assert.rejects(
      handler({ sender: {} }, { ...request, unexpected: true }),
      /未知字段|unknown field/i,
      `exact request validation was skipped for ${channel}`
    );
    assert.equal(harness.calls.length, 0);

    harness.setActiveWorkspace(OTHER_WORKSPACE);
    await assert.rejects(
      handler({ sender: {} }, request),
      /当前工作区|active workspace/i,
      `workspace authorization was skipped for ${channel}`
    );
    assert.equal(harness.calls.length, 0);

    harness.setActiveWorkspace(WORKSPACE);
    await handler({ sender: {} }, request);
    assert.equal(harness.calls.length, 1, `runtime was not invoked for ${channel}`);
    harness.calls.length = 0;
  }
});

test('shutdown aborts from in-flight runtime calls are resolved without surfacing handler errors', async () => {
  const harness = createHarness();
  harness.runtime.getClassTaskMethods = async () => {
    throw new Error('生成已停止。');
  };
  const handler = harness.handlers.get(CLASS_TASK_CHANNELS.getMethods);

  await assert.rejects(
    handler({ sender: {} }, requestFor(CLASS_TASK_CHANNELS.getMethods)),
    /生成已停止/
  );

  harness.setShuttingDown(true);
  await assert.doesNotReject(
    handler({ sender: {} }, requestFor(CLASS_TASK_CHANNELS.getMethods))
  );
});

test('preload exposes named wrappers, File path resolution, and listener cleanup without raw IPC', async () => {
  const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8');

  assert.match(preload, /addClassTasks:[\s\S]*?ipcRenderer\.invoke\(CLASS_TASK_CHANNELS\.add/);
  assert.match(preload, /reorderClassTasks:[\s\S]*?ipcRenderer\.invoke\(CLASS_TASK_CHANNELS\.reorder/);
  assert.match(preload, /getPathForFile:[\s\S]*?webUtils\.getPathForFile\(file\)/);
  assert.match(preload, /onClassTaskSnapshotChanged:[\s\S]*?removeListener/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
});

test('main installs the production runtime, broadcasts snapshots, and keeps the renderer sandboxed', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

  assert.match(main, /createProductionClassTaskRuntime\s*\(/);
  assert.match(main, /registerClassTaskIpc\s*\(/);
  assert.match(main, /CLASS_TASK_CHANNELS\.snapshotChanged/);
  assert.match(main, /sandbox:\s*true/);
});

test('main removes class-task IPC before shutdown and stops managed backends last', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

  assert.match(
    main,
    /disposeClassTaskIpc\?\.\(\)[\s\S]*?await\s+classTaskRuntime\?\.beforeQuit\(\)[\s\S]*?await\s+managedBackendRuntime\?\.stop\(\)/
  );
});
