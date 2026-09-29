import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WorkspaceStateService,
  validateStoredWorkspaceState
} from '../src/main/services/workspace-state.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CATALOG_FINGERPRINT = 'a'.repeat(64);

function cachedCatalog() {
  return {
    taskId: TASK_ID,
    analysisSessionId: '22222222-2222-4222-8222-222222222222',
    reportPairId: 'pair-1',
    fingerprint: CATALOG_FINGERPRINT,
    reportCoverageTotals: {
      instructionCovered: 3,
      instructionMissed: 4,
      branchCovered: 0,
      branchMissed: 1,
      complexityCovered: 1,
      complexityMissed: 1,
      lineCovered: 1,
      lineMissed: 2
    },
    methods: [{
      methodId: 'method-id',
      methodName: 'run',
      descriptor: '()V',
      displaySignature: 'void run()',
      firstLine: 10,
      lastLine: 12,
      jacocoOrder: 0,
      lineCovered: 1,
      lineMissed: 2,
      branchCovered: 0,
      branchMissed: 1,
      instructionCovered: 3,
      instructionMissed: 4,
      complexityCovered: 1,
      complexityMissed: 1,
      coverageGap: true,
      generatable: true,
      unavailableReason: null,
      modifiers: ['public']
    }],
    warnings: [],
    refreshedAt: '2026-08-14T00:00:00.000Z'
  };
}

async function createWorkspaceStateFixture(context, initialState, existingDirectories) {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-state-'));
  const storagePath = join(directory, 'workspace-state.json');
  context.after(() => rm(directory, { recursive: true, force: true }));
  if (Object.keys(initialState).length > 0) {
    await writeFile(storagePath, JSON.stringify({
      version: 1,
      viewStates: {},
      ...initialState
    }), 'utf8');
  }
  return {
    storagePath,
    service: new WorkspaceStateService(
      storagePath,
      String.raw`C:\Users\demo\Documents`,
      String.raw`C:\Users\demo`,
      async (path) => existingDirectories.has(path)
    )
  };
}

test('失效上次工作区只清 last root，保留 picker 与历史视图', async (context) => {
  const fixture = await createWorkspaceStateFixture(context, {
    lastWorkspaceRoot: String.raw`D:\missing\manager`,
    pickerParentDirectory: String.raw`D:\projects`,
    viewStates: {
      'd:/missing/manager': {
        expandedPaths: [String.raw`D:\missing\manager\src`],
        openFilePaths: [],
        activityView: 'explorer'
      }
    }
  }, new Set([String.raw`D:\projects`]));

  assert.deepEqual(await fixture.service.getLastWorkspace(), { state: 'missing' });
  const stored = JSON.parse(await readFile(fixture.storagePath, 'utf8'));
  assert.equal(stored.lastWorkspaceRoot, undefined);
  assert.equal(stored.pickerParentDirectory, String.raw`D:\projects`);
  assert.ok(stored.viewStates['d:/missing/manager']);
});

test('成功选择同时更新恢复根目录和 picker 父目录', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const fixture = await createWorkspaceStateFixture(context, {}, new Set([
    root,
    String.raw`D:\projects`
  ]));

  await fixture.service.rememberWorkspaceSelection(root);
  assert.deepEqual(await fixture.service.getLastWorkspace(), {
    state: 'ready',
    workspaceRoot: root
  });
  assert.equal(await fixture.service.getPickerDefaultPath(), String.raw`D:\projects`);
});

test('视图状态只保存允许字段，不存在生成目标字段', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const fixture = await createWorkspaceStateFixture(context, {}, new Set([root]));
  await fixture.service.saveViewState({
    workspaceRoot: root,
    expandedPaths: [String.raw`D:\projects\manager\src`],
    openFilePaths: [String.raw`D:\projects\manager\src\A.java`],
    activeFilePath: String.raw`D:\projects\manager\src\A.java`,
    activityView: 'explorer',
    generationTargetFilePath: String.raw`D:\projects\manager\src\Target.java`
  });

  const raw = await readFile(fixture.storagePath, 'utf8');
  assert.doesNotMatch(raw, /generationTarget/);
  assert.equal((await fixture.service.getViewState(root))?.activeFilePath,
    String.raw`D:\projects\manager\src\A.java`);
});

test('方法配置标签、活动标签和带指纹的目录按工作区持久化', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const otherRoot = String.raw`D:\projects\other`;
  const sourceFilePath = String.raw`D:\projects\manager\src\main\java\example\Task.java`;
  const fixture = await createWorkspaceStateFixture(context, {}, new Set([root, otherRoot]));
  const catalog = cachedCatalog();

  await fixture.service.saveViewState({
    workspaceRoot: root,
    expandedPaths: [],
    openFilePaths: [sourceFilePath],
    activeFilePath: sourceFilePath,
    activityView: 'explorer',
    workbenchTabs: [
      { kind: 'source', filePath: sourceFilePath },
      {
        kind: 'method_configuration',
        taskId: TASK_ID,
        sourceFilePath,
        qualifiedClassName: 'example.Task',
        catalog
      }
    ],
    activeWorkbenchTabId: `methods:${TASK_ID}`
  });

  const restored = await fixture.service.getViewState(root);
  assert.deepEqual(restored?.workbenchTabs, [
    { kind: 'source', filePath: sourceFilePath },
    {
      kind: 'method_configuration',
      taskId: TASK_ID,
      sourceFilePath,
      qualifiedClassName: 'example.Task',
      catalog
    }
  ]);
  assert.equal(restored?.activeWorkbenchTabId, `methods:${TASK_ID}`);
  assert.equal(restored?.workbenchTabs?.[1]?.catalog?.fingerprint, CATALOG_FINGERPRINT);
  assert.equal(await fixture.service.getViewState(otherRoot), null);
});

test('旧方法目录缺少报告总计时保留标签并丢弃缓存目录', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const sourceFilePath = String.raw`D:\projects\manager\src\main\java\example\Task.java`;
  const { reportCoverageTotals: _legacyMissingField, ...legacyCatalog } = cachedCatalog();
  const fixture = await createWorkspaceStateFixture(context, {
    viewStates: {
      'd:/projects/manager': {
        expandedPaths: [],
        openFilePaths: [sourceFilePath],
        activityView: 'explorer',
        workbenchTabs: [{
          kind: 'method_configuration',
          taskId: TASK_ID,
          sourceFilePath,
          qualifiedClassName: 'example.Task',
          catalog: legacyCatalog
        }],
        activeWorkbenchTabId: `methods:${TASK_ID}`
      }
    }
  }, new Set([root]));

  assert.deepEqual((await fixture.service.getViewState(root))?.workbenchTabs, [{
    kind: 'method_configuration',
    taskId: TASK_ID,
    sourceFilePath,
    qualifiedClassName: 'example.Task'
  }]);
});

test('picker 目录失效时回退到 documents，再回退到 home', async (context) => {
  const fixture = await createWorkspaceStateFixture(context, {
    pickerParentDirectory: String.raw`D:\missing\picker`
  }, new Set([String.raw`C:\Users\demo\Documents`]));
  assert.equal(await fixture.service.getPickerDefaultPath(), String.raw`C:\Users\demo\Documents`);

  const homeFixture = await createWorkspaceStateFixture(context, {
    pickerParentDirectory: String.raw`D:\missing\picker`
  }, new Set([String.raw`C:\Users\demo`]));
  assert.equal(await homeFixture.service.getPickerDefaultPath(), String.raw`C:\Users\demo`);
});

test('兼容读取缺少 version 的旧视图状态，并在下一次写入时升级', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const fixture = await createWorkspaceStateFixture(context, {}, new Set([root]));
  await writeFile(fixture.storagePath, JSON.stringify({
    viewStates: {
      'd:/projects/manager': {
        expandedPaths: [String.raw`D:\projects\manager\src`],
        openFilePaths: [],
        activeFilePath: String.raw`D:\projects\manager\src\A.java`,
        activityView: 'explorer',
        generationTargetFilePath: String.raw`D:\projects\manager\Target.java`
      }
    }
  }), 'utf8');

  assert.equal((await fixture.service.getViewState(root))?.activeFilePath,
    String.raw`D:\projects\manager\src\A.java`);
  await fixture.service.saveViewState({
    workspaceRoot: root,
    expandedPaths: [],
    openFilePaths: [],
    activityView: 'explorer'
  });
  const stored = JSON.parse(await readFile(fixture.storagePath, 'utf8'));
  assert.equal(stored.version, 1);
  assert.doesNotMatch(JSON.stringify(stored), /generationTarget/);
});

test('旧工作区保存的扩展视图在功能移除后回退到资源管理器', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const fixture = await createWorkspaceStateFixture(context, {
    viewStates: {
      'd:/projects/manager': {
        expandedPaths: [],
        openFilePaths: [],
        activityView: 'extensions'
      }
    }
  }, new Set([root]));

  assert.equal((await fixture.service.getViewState(root))?.activityView, 'explorer');
});

test('RAG 知识库活动视图按工作区持久化', async (context) => {
  const root = String.raw`D:\projects\manager`;
  const fixture = await createWorkspaceStateFixture(context, {}, new Set([root]));

  await fixture.service.saveViewState({
    workspaceRoot: root,
    expandedPaths: [],
    openFilePaths: [],
    activityView: 'rag-knowledge'
  });

  assert.equal((await fixture.service.getViewState(root))?.activityView, 'rag-knowledge');
});

test('状态格式校验使用不泄露路径的固定错误', () => {
  assert.throws(
    () => validateStoredWorkspaceState({
      version: 1,
      viewStates: {},
      unexpected: String.raw`D:\private\secret`
    }),
    (error) => error instanceof Error
      && error.message === "工作区状态文件格式无效"
      && !error.message.includes(String.raw`D:\private\secret`)
  );
});
