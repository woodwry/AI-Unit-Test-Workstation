import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClassTaskRegistryService } from '../src/main/services/class-task-registry.service.ts';
import { ClassTaskStore } from '../src/main/services/class-task.store.ts';


const TASK_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-10T01:00:00.000Z';


function legacySnapshot(overrides = {}) {
  return {
    id: TASK_ID,
    workspaceRoot: 'D:\\work',
    sourceFilePath: 'D:\\work\\module\\src\\main\\java\\example\\Task.java',
    qualifiedClassName: 'example.Task',
    moduleKey: 'd:/work/module/pom.xml',
    moduleDisplayPath: 'D:\\work\\module',
    state: 'READY',
    preloadState: 'READY',
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: [],
    currentMethodIndex: -1,
    currentAtomicStep: 'IDLE',
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: false,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides
  };
}


function identityService() {
  return {
    comparisonKey(value) {
      return value.replaceAll('\\', '/').toLowerCase();
    },
    async resolve(workspaceRoot, sourceFilePath) {
      return {
        workspaceRoot,
        sourceFilePath,
        moduleKey: 'd:/work/module/pom.xml',
        moduleDisplayPath: 'D:\\work\\module',
        pomPath: 'D:\\work\\module\\pom.xml'
      };
    }
  };
}


test('legacy version 2 tasks migrate to strict version 3 with RAG disabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'class-task-rag-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'class-tasks-v2.json');
  await writeFile(path, `${JSON.stringify({ version: 2, tasks: { [TASK_ID]: legacySnapshot() } }, null, 2)}\n`);

  const loaded = await new ClassTaskStore(path).load();

  assert.equal(loaded.version, 3);
  assert.equal(loaded.tasks[TASK_ID].ragEnabled, false);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.version, 3);
  assert.equal(persisted.tasks[TASK_ID].ragEnabled, false);

  const store = new ClassTaskStore(join(directory, 'strict.json'));
  for (const ragEnabled of ['true', null, 1]) {
    await assert.rejects(
      store.save({
        version: 3,
        tasks: { [TASK_ID]: { ...legacySnapshot(), ragEnabled } }
      }),
      /ragEnabled|boolean|布尔|无效/i
    );
  }
});


test('new tasks default to false and configuration save changes selection and RAG atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'class-task-rag-save-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ClassTaskStore(join(directory, 'tasks.json'));
  const registry = new ClassTaskRegistryService({
    store,
    identityService: identityService(),
    clock: () => new Date(NOW),
    idFactory: () => TASK_ID
  });
  await registry.initialize();
  await registry.add({
    workspaceRoot: 'D:\\work',
    classFilePaths: ['D:\\work\\module\\src\\main\\java\\example\\Task.java']
  });
  assert.equal(registry.snapshot(TASK_ID).ragEnabled, false);
  assert.equal(registry.snapshot(TASK_ID).repairAttemptLimit, null);
  assert.equal(registry.snapshot(TASK_ID).unlimitedRepair, false);
  registry.tasks.set(TASK_ID, {
    ...registry.snapshot(TASK_ID),
    state: 'READY',
    preloadState: 'READY'
  });

  const saved = await registry.saveSelection(
    TASK_ID,
    'EXPLICIT',
    ['method-b', 'method-a'],
    ['method-b', 'method-a'],
    true,
    12,
    false
  );

  assert.equal(saved.ragEnabled, true);
  assert.equal(saved.repairAttemptLimit, 12);
  assert.equal(saved.unlimitedRepair, false);
  assert.deepEqual(saved.methodOrder, ['method-b', 'method-a']);
  assert.equal((await store.load()).tasks[TASK_ID].ragEnabled, true);

  await assert.rejects(
    registry.saveSelection(
      TASK_ID,
      'EXPLICIT',
      ['must-not-save'],
      ['must-not-save'],
      false,
      null,
      false
    ),
    /请填写修复轮次|repairAttemptLimit|unlimitedRepair/i
  );
  const unchanged = registry.snapshot(TASK_ID);
  assert.equal(unchanged.ragEnabled, true);
  assert.equal(unchanged.repairAttemptLimit, 12);
  assert.deepEqual(unchanged.methodOrder, ['method-b', 'method-a']);
  assert.deepEqual((await store.load()).tasks[TASK_ID].methodOrder, ['method-b', 'method-a']);

  for (const state of ['PRELOADING', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING']) {
    registry.tasks.set(TASK_ID, { ...registry.snapshot(TASK_ID), state });
    await assert.rejects(
      registry.saveSelection(TASK_ID, 'EXPLICIT', ['new'], ['new'], false, 3, false),
      new RegExp(`configuration|selection|RAG|${state}`, 'i')
    );
    assert.equal((await store.load()).tasks[TASK_ID].ragEnabled, true);
    assert.deepEqual((await store.load()).tasks[TASK_ID].methodOrder, ['method-b', 'method-a']);
  }
});


test('method configuration has one class-level RAG checkbox in the approved header actions', async () => {
  const source = await readFile(
    new URL('../src/renderer/src/class-tasks/MethodConfigurationTab.tsx', import.meta.url),
    'utf8'
  );

  assert.equal((source.match(/<strong>RAG<\/strong>/g) ?? []).length, 1);
  assert.match(source, /type="checkbox"[\s\S]*checked=\{ragEnabled\}/);
  assert.doesNotMatch(source, /role="columnheader"[^>]*>\s*RAG/);
  assert.doesNotMatch(source, /class-task-method-row[\s\S]{0,500}<strong>RAG<\/strong>/);
  assert.doesNotMatch(source, /class-task-class-options/);
  assert.match(source, /class-task-method-heading-actions/);
  assert.match(source, /ragConfigurationState === 'unconfigured'/);
  assert.doesNotMatch(source, /window\.workstation\.getRagSettings\(\)/);
  assert.match(source, /window\.workstation\.getRagEmbeddingInterfaces\(\)/);
  assert.match(source, /inspectRagConfigurationReadiness/);
  assert.match(source, /请先在设置中完成 Embedding 配置/);
  assert.match(source, /class-task-rag-option.*unconfigured/s);
  assert.match(source, /title="基于RAG提升单元测试质量"/);
  assert.match(source, /class-task-rag-warning[\s\S]*class-task-rag-option/);
  const option = source.indexOf('class-task-rag-option');
  const headingActions = source.indexOf('className="class-task-method-heading-actions"');
  const toolbar = source.indexOf('className="class-task-method-toolbar"');
  const table = source.indexOf('className="class-task-method-table"');
  assert.ok(headingActions > -1 && headingActions < option && option < toolbar && toolbar < table);
  assert.doesNotMatch(source, /setRagEnabled\(event\.target\.checked\)/);
  assert.match(source, /setRagEnabled\(configured\)/);
  assert.match(source, /const configured = await inspectRagConfiguration/);
  assert.match(source, /if \(!configured\) return/);
  assert.match(source, /const ragUnconfigured = ragConfigurationState === 'unconfigured'/);
  assert.match(
    source,
    /const selectionLocked = isSaving[\s\S]*ragConfigurationState === 'checking'/
  );
  assert.match(source, /aria-disabled=\{!method\.generatable \|\| selectionLocked\}/);
  assert.match(source, /tabIndex=\{method\.generatable && !selectionLocked \? 0 : -1\}/);
  assert.match(
    source,
    /onClick=\{\(\) => \{[\s\S]{0,120}if \(!method\.generatable \|\| selectionLocked\) return;[\s\S]{0,220}toggleMethodSelection/
  );
  assert.match(source, /disabled=\{!method\.generatable \|\| selectionLocked\}/);
  assert.match(source, /onSave\(\{[\s\S]*ragEnabled/);
});
