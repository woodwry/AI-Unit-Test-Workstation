import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { ClassTaskRegistryService } from '../src/main/services/class-task-registry.service.ts';
import { ClassTaskStore } from '../src/main/services/class-task.store.ts';

const WORKSPACE = 'D:\\work';
const NOW = '2026-08-09T01:00:00.000Z';

function identityService() {
  return {
    comparisonKey(value) {
      return value.replaceAll('\\', '/').toLowerCase();
    },
    async resolve(workspaceRoot, sourceFilePath) {
      const normalized = sourceFilePath.replaceAll('/', '\\');
      const moduleName = normalized.toLowerCase().includes('module-b') ? 'module-b' : 'module-a';
      const moduleRoot = `${workspaceRoot}\\${moduleName}`;
      return {
        workspaceRoot,
        sourceFilePath: normalized,
        moduleKey: `${moduleRoot}\\pom.xml`.replaceAll('\\', '/').toLowerCase(),
        moduleDisplayPath: moduleRoot,
        pomPath: `${moduleRoot}\\pom.xml`
      };
    }
  };
}

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'class-task-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'class-tasks-v2.json');
  const store = new ClassTaskStore(path, () => new Date(NOW));
  let nextId = 1;
  const registry = new ClassTaskRegistryService({
    store,
    identityService: identityService(),
    clock: () => new Date(NOW),
    idFactory: () => `${String(nextId++).padStart(8, '0')}-1111-4111-8111-111111111111`,
    broadcast: options.broadcast
  });
  await registry.initialize();
  return { path, registry, store };
}

function addRequest(...classFilePaths) {
  return { workspaceRoot: WORKSPACE, classFilePaths };
}

function file(name, moduleName = 'module-a') {
  return `${WORKSPACE}\\${moduleName}\\src\\main\\java\\example\\${name}`;
}

function preload(moduleKey, state, overrides = {}) {
  return {
    moduleKey,
    moduleName: moduleKey.includes('module-b') ? 'module-b' : 'module-a',
    modulePath: moduleKey.includes('module-b') ? `${WORKSPACE}\\module-b` : `${WORKSPACE}\\module-a`,
    state,
    fingerprint: state === 'IDLE' ? null : 'a'.repeat(64),
    executionDataPath: state === 'READY' ? `${WORKSPACE}\\target\\jacoco.exec` : null,
    classReportPairs: {},
    classPreloadFailures: {},
    diagnostic: state === 'FAILED' ? {
      command: 'mvn test', exitCode: 1, summary: 'compile failed', repairInstruction: 'repair module'
    } : null,
    updatedAt: NOW,
    ...overrides
  };
}

test('duplicate Windows aliases focus one task and a sixth unique class is rejected', async (t) => {
  const { registry } = await harness(t);
  const first = await registry.add(addRequest(file('TaskService.java')));
  const initial = registry.snapshot(first.addedTaskIds[0]);

  assert.equal(initial.selectionMode, 'EXPLICIT');
  assert.deepEqual(initial.selectedMethodIds, []);
  assert.deepEqual(initial.methodOrder, []);

  const duplicate = await registry.add(addRequest(file('taskservice.java').replaceAll('\\', '/')));

  assert.equal(duplicate.focusedTaskId, first.addedTaskIds[0]);
  assert.deepEqual(duplicate.addedTaskIds, []);
  assert.equal(registry.list().length, 1);

  await registry.add(addRequest(
    file('Second.java'), file('Third.java'), file('Fourth.java'), file('Fifth.java')
  ));
  await assert.rejects(registry.add(addRequest(file('Sixth.java'))), /maximum 5|最多.*5/i);
  assert.equal(registry.list().length, 5);
});

test('capacity is counted independently for each workspace', async (t) => {
  const { registry } = await harness(t);
  const otherWorkspace = 'D:\\other-work';
  await registry.add({
    workspaceRoot: otherWorkspace,
    classFilePaths: [`${otherWorkspace}\\module-a\\src\\main\\java\\example\\Hidden.java`]
  });
  await registry.add(addRequest(
    file('One.java'), file('Two.java'), file('Three.java'), file('Four.java')
  ));

  const fifth = await registry.add(addRequest(file('Five.java')));

  assert.equal(fifth.addedTaskIds.length, 1);
  assert.equal(registry.list(WORKSPACE).length, 5);
  assert.equal(registry.list(otherWorkspace).length, 1);
});

test('reorders only the requested workspace and persists the new order', async (t) => {
  const { path, registry } = await harness(t);
  const otherWorkspace = 'D:\\other-work';
  const added = await registry.add(addRequest(file('One.java'), file('Two.java'), file('Three.java')));
  await registry.add({
    workspaceRoot: otherWorkspace,
    classFilePaths: [`${otherWorkspace}\\module-a\\src\\main\\java\\example\\Other.java`]
  });
  const reorderedIds = [...added.addedTaskIds].reverse();

  const reordered = await registry.reorder(WORKSPACE, reorderedIds);
  const restored = new ClassTaskRegistryService({
    store: new ClassTaskStore(path, () => new Date(NOW)),
    identityService: identityService()
  });
  await restored.initialize();

  assert.deepEqual(reordered.map((task) => task.id), reorderedIds);
  assert.deepEqual(restored.list(WORKSPACE).map((task) => task.id), reorderedIds);
  assert.equal(restored.list(otherWorkspace).length, 1);
});

test('rejects an incomplete or foreign class task order without changing persistence', async (t) => {
  const { registry } = await harness(t);
  const added = await registry.add(addRequest(file('One.java'), file('Two.java')));

  await assert.rejects(registry.reorder(WORKSPACE, [added.addedTaskIds[0]]), /every task/);
  await assert.rejects(registry.reorder(WORKSPACE, [
    added.addedTaskIds[0],
    '99999999-9999-4999-8999-999999999999'
  ]), /every task/);

  assert.deepEqual(registry.list(WORKSPACE).map((task) => task.id), added.addedTaskIds);
});

test('batch add rejects an over-capacity request atomically', async (t) => {
  const { registry } = await harness(t);
  await registry.add(addRequest(file('One.java'), file('Two.java'), file('Three.java'), file('Four.java')));

  await assert.rejects(
    registry.add(addRequest(file('Five.java'), file('Six.java'))),
    /maximum 5|最多.*5/i
  );

  assert.deepEqual(registry.list().map((item) => basename(item.sourceFilePath)).sort(), [
    'Four.java', 'One.java', 'Three.java', 'Two.java'
  ]);
});

test('module preload fan-out updates matching tasks and never a sibling module', async (t) => {
  const { registry } = await harness(t);
  const added = await registry.add(addRequest(
    file('One.java'), file('Two.java'), file('Other.java', 'module-b')
  ));
  const [one, two, other] = added.addedTaskIds;
  assert.equal(registry.snapshot(one).qualifiedClassName, 'example.One');
  const moduleAKey = registry.snapshot(one).moduleKey;
  const moduleBKey = registry.snapshot(other).moduleKey;

  await registry.applyModulePreloadSnapshot(moduleAKey, preload(moduleAKey, 'READY'));
  await registry.applyModulePreloadSnapshot(moduleBKey, preload(moduleBKey, 'READY'));
  await registry.applyModulePreloadSnapshot(moduleAKey, preload(moduleAKey, 'RUNNING'));
  assert.equal(registry.snapshot(one).state, 'PRELOADING');
  assert.equal(registry.snapshot(two).state, 'PRELOADING');
  assert.equal(registry.snapshot(other).state, 'READY');

  await registry.applyModulePreloadSnapshot(moduleAKey, preload(moduleAKey, 'READY'));
  assert.equal(registry.snapshot(one).state, 'READY');
  assert.equal(registry.snapshot(two).state, 'READY');

  await registry.applyModulePreloadSnapshot(moduleAKey, preload(moduleAKey, 'RUNNING'));
  await registry.applyModulePreloadSnapshot(moduleAKey, preload(moduleAKey, 'FAILED'));
  assert.equal(registry.snapshot(one).state, 'PRELOAD_FAILED');
  assert.equal(registry.snapshot(two).state, 'PRELOAD_FAILED');
  assert.equal(registry.snapshot(other).state, 'READY');
});

test('READY preload applies a class-local failure without changing its sibling', async (t) => {
  const { registry } = await harness(t);
  const added = await registry.add(addRequest(file('One.java'), file('Two.java')));
  const [one, two] = added.addedTaskIds;
  const moduleKey = registry.snapshot(one).moduleKey;
  const failedClass = registry.snapshot(one).qualifiedClassName;

  await registry.applyModulePreloadSnapshot(moduleKey, preload(moduleKey, 'READY', {
    classPreloadFailures: {
      [failedClass]: {
        state: 'PRELOAD_FAILED',
        fingerprint: 'a'.repeat(64),
        diagnostic: 'Analyzer target report failed',
        updatedAt: NOW
      }
    }
  }));

  assert.equal(registry.snapshot(one).state, 'PRELOAD_FAILED');
  assert.equal(registry.snapshot(two).state, 'READY');

  await registry.applyModulePreloadSnapshot(moduleKey, preload(moduleKey, 'READY'));
  assert.equal(registry.snapshot(one).state, 'READY');
  assert.equal(registry.snapshot(one).lastError, null);
});

test('a class-specific Analyzer failure changes only the target task', async (t) => {
  const { registry } = await harness(t);
  const added = await registry.add(addRequest(file('One.java'), file('Two.java')));
  const [one, two] = added.addedTaskIds;
  const moduleKey = registry.snapshot(one).moduleKey;
  await registry.applyModulePreloadSnapshot(moduleKey, preload(moduleKey, 'READY'));

  await registry.applyClassPreloadFailure(one, {
    code: 'ANALYZER_FAILED',
    message: 'target report failed',
    moduleName: 'module-a',
    modulePath: `${WORKSPACE}\\module-a`,
    command: null,
    occurredAt: NOW
  });

  assert.equal(registry.snapshot(one).state, 'PRELOAD_FAILED');
  assert.equal(registry.snapshot(two).state, 'READY');
});

test('broadcasts detached redacted snapshots only after a persisted mutation', async (t) => {
  const broadcasts = [];
  const { registry, store } = await harness(t, {
    broadcast(snapshot) {
      broadcasts.push(snapshot);
      snapshot.qualifiedClassName = 'mutated by receiver';
    }
  });
  const added = await registry.add(addRequest(file('One.java')));
  const taskId = added.addedTaskIds[0];
  const moduleKey = registry.snapshot(taskId).moduleKey;

  await registry.applyModulePreloadSnapshot(moduleKey, preload(moduleKey, 'FAILED', {
    diagnostic: {
      command: 'mvn -DapiKey=another-secret test',
      exitCode: 1,
      summary: 'Authorization: Bearer top-secret-token',
      repairInstruction: 'repair module'
    }
  }));
  await registry.applyClassPreloadFailure(taskId, {
    code: 'Authorization: Bearer broadcast-code-secret-marker-94ad',
    message: 'target report failed',
    moduleName: 'module-a',
    modulePath: `${WORKSPACE}\\module-a`,
    command: null,
    occurredAt: NOW
  });

  const persisted = (await store.load()).tasks[taskId];
  assert.equal(persisted.state, 'PRELOAD_FAILED');
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /top-secret-token|another-secret|broadcast-code-secret-marker-94ad/
  );
  assert.doesNotMatch(
    JSON.stringify(broadcasts),
    /top-secret-token|another-secret|broadcast-code-secret-marker-94ad/
  );
  assert.notEqual(registry.snapshot(taskId).qualifiedClassName, 'mutated by receiver');
  assert.ok(broadcasts.length >= 2);
});

test('restores persisted tasks and keeps unfinished preload resumable on startup', async (t) => {
  const { path, registry } = await harness(t);
  const added = await registry.add(addRequest(file('One.java')));
  const taskId = added.addedTaskIds[0];

  const restored = new ClassTaskRegistryService({
    store: new ClassTaskStore(path, () => new Date(NOW)),
    identityService: identityService(),
    clock: () => new Date(NOW)
  });
  await restored.initialize();

  assert.equal(restored.snapshot(taskId).state, 'PRELOADING');
  assert.equal(restored.snapshot(taskId).preloadState, 'IDLE');
  assert.equal(restored.list().length, 1);
});
