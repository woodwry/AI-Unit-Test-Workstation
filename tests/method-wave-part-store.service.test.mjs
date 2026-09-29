import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MethodWavePartStoreService } from '../src/main/services/method-wave-part-store.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const METHOD_ID = 'a'.repeat(64);

function partCode(value = 'one') {
  return [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void generated() {',
    `    String value = "${value}";`,
    '  }',
    '}',
    ''
  ].join('\n');
}

test('stores a deterministic Part and sidecar outside Maven test sources and reuses its digest', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'wave-part-store-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new MethodWavePartStoreService();
  const input = {
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'b'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '22222222-2222-4222-8222-222222222222',
    code: partCode()
  };

  const stored = await store.store(input);
  const repeated = await store.store(structuredClone(input));

  assert.equal(stored.testClassName, 'TaskServiceTmp1Part1Test');
  assert.equal(stored.filePath, repeated.filePath);
  assert.equal(stored.sha256, repeated.sha256);
  assert.doesNotMatch(stored.filePath.replaceAll('\\', '/'), /\/src\/test\/java\//i);
  assert.equal(await readFile(stored.filePath, 'utf8'), partCode());
  const sidecar = JSON.parse(await readFile(stored.sidecarPath, 'utf8'));
  assert.deepEqual(sidecar.scenarioIds, ['scenario-1']);
  assert.equal(sidecar.sha256, stored.sha256);

  await assert.rejects(
    store.store({ ...input, code: partCode('changed') }),
    /identity|digest|different/i
  );
});

test('loads a checkpointed Part only when its full identity, path, and digest still match', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'wave-part-load-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new MethodWavePartStoreService();
  const stored = await store.store({
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'b'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '22222222-2222-4222-8222-222222222222',
    code: partCode()
  });

  const loaded = await store.load({
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'b'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: stored.candidateId,
    filePath: stored.filePath,
    sha256: stored.sha256
  });

  assert.equal(loaded.code, partCode());
  assert.equal(loaded.filePath, stored.filePath);
  await assert.rejects(
    store.load({
      workspaceRoot,
      taskId: TASK_ID,
      methodId: METHOD_ID,
      sourceClassName: 'TaskService',
      waveIndex: 1,
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-1'],
      candidateId: stored.candidateId,
      filePath: stored.filePath,
      sha256: 'f'.repeat(64)
    }),
    /identity|digest/i
  );
});

test('clears only the merged Wave Part tree and preserves sibling recovery data', async (t) => {
  // Mutation caught: deleting the whole task tree would break sibling Wave recovery,
  // while retaining the merged Wave leaves its Part sources and sidecars orphaned.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'wave-part-clear-wave-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new MethodWavePartStoreService();
  const base = {
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    partIndex: 1,
    scenarioIds: ['scenario-1']
  };
  const mergedWave = await store.store({
    ...base,
    waveIndex: 1,
    partBatchId: 'b'.repeat(64),
    candidateId: '22222222-2222-4222-8222-222222222222',
    code: partCode('merged')
  });
  const siblingWave = await store.store({
    ...base,
    waveIndex: 2,
    partBatchId: 'c'.repeat(64),
    candidateId: '33333333-3333-4333-8333-333333333333',
    code: partCode('sibling-wave')
  });
  const siblingMethod = await store.store({
    ...base,
    methodId: 'd'.repeat(64),
    waveIndex: 1,
    partBatchId: 'e'.repeat(64),
    candidateId: '44444444-4444-4444-8444-444444444444',
    code: partCode('sibling-method')
  });

  await store.clearWave(workspaceRoot, TASK_ID, METHOD_ID, 1);

  await assert.rejects(access(mergedWave.filePath), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(mergedWave.sidecarPath), (error) => error?.code === 'ENOENT');
  assert.equal((await store.load({
    ...base,
    waveIndex: 2,
    partBatchId: 'c'.repeat(64),
    candidateId: siblingWave.candidateId,
    filePath: siblingWave.filePath,
    sha256: siblingWave.sha256
  })).code, partCode('sibling-wave'));
  assert.equal((await store.load({
    ...base,
    methodId: 'd'.repeat(64),
    waveIndex: 1,
    partBatchId: 'e'.repeat(64),
    candidateId: siblingMethod.candidateId,
    filePath: siblingMethod.filePath,
    sha256: siblingMethod.sha256
  })).code, partCode('sibling-method'));
});

test('clears only one task Part tree before a fresh run reuses Wave indexes', async (t) => {
  // Mutation caught: clearing the whole Part root would delete other cards, while
  // retaining this task's wave-1 sidecar rejects the next run's new candidate ID.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'wave-part-clear-task-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new MethodWavePartStoreService();
  const first = await store.store({
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'b'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '22222222-2222-4222-8222-222222222222',
    code: partCode()
  });
  const otherTask = await store.store({
    workspaceRoot,
    taskId: '33333333-3333-4333-8333-333333333333',
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'c'.repeat(64),
    scenarioIds: ['scenario-2'],
    candidateId: '44444444-4444-4444-8444-444444444444',
    code: partCode('other')
  });

  await store.clearTask(workspaceRoot, TASK_ID);

  await assert.rejects(
    store.load({
      workspaceRoot,
      taskId: TASK_ID,
      methodId: METHOD_ID,
      sourceClassName: 'TaskService',
      waveIndex: 1,
      partIndex: 1,
      partBatchId: 'b'.repeat(64),
      scenarioIds: ['scenario-1'],
      candidateId: first.candidateId,
      filePath: first.filePath,
      sha256: first.sha256
    }),
    /missing/i
  );
  assert.equal((await store.load({
    workspaceRoot,
    taskId: '33333333-3333-4333-8333-333333333333',
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'c'.repeat(64),
    scenarioIds: ['scenario-2'],
    candidateId: otherTask.candidateId,
    filePath: otherTask.filePath,
    sha256: otherTask.sha256
  })).code, partCode('other'));

  const replacement = await store.store({
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'd'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '55555555-5555-4555-8555-555555555555',
    code: partCode('replacement')
  });
  assert.equal(await readFile(replacement.filePath, 'utf8'), partCode('replacement'));
});

test('rejects Part storage below src test java and invalid Part bounds', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'wave-part-store-invalid-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new MethodWavePartStoreService({
    storageDirectory: join(workspaceRoot, 'src', 'test', 'java', '.wave-parts')
  });
  const base = {
    workspaceRoot,
    taskId: TASK_ID,
    methodId: METHOD_ID,
    sourceClassName: 'TaskService',
    waveIndex: 1,
    partIndex: 1,
    partBatchId: 'b'.repeat(64),
    scenarioIds: ['scenario-1'],
    candidateId: '22222222-2222-4222-8222-222222222222',
    code: partCode()
  };

  await assert.rejects(store.store(base), /src.test.java|Maven/i);
  await assert.rejects(
    new MethodWavePartStoreService().store({ ...base, partIndex: 6 }),
    /Part index/i
  );
});
