import assert from 'node:assert/strict';
import test from 'node:test';

import * as tabState from '../src/renderer/src/class-tasks/workbench-tab-state.ts';

const {
  activateWorkbenchTab,
  closeWorkbenchTab,
  createEmptyWorkbenchTabs,
  openMethodConfigurationTab,
  openSourceTab
} = tabState;

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceFilePath: 'D:\\workspace\\src\\main\\java\\example\\TaskService.java',
  qualifiedClassName: 'example.TaskService'
};

test('source and method configuration tabs coexist and activate independently', () => {
  const withSource = openSourceTab(createEmptyWorkbenchTabs(), TASK);
  const withConfiguration = openMethodConfigurationTab(withSource, TASK);

  assert.deepEqual(
    withConfiguration.items.map((item) => item.kind),
    ['source', 'method_configuration']
  );
  assert.equal(withConfiguration.activeId, `methods:${TASK.id}`);

  const reactivated = openSourceTab(withConfiguration, TASK);
  assert.equal(reactivated.items.length, 2);
  assert.equal(reactivated.activeId, `source:${TASK.sourceFilePath}`);
});

test('closing the active tab selects its nearest remaining neighbor', () => {
  const sourceId = `source:${TASK.sourceFilePath}`;
  const configurationId = `methods:${TASK.id}`;
  const state = activateWorkbenchTab(
    openMethodConfigurationTab(openSourceTab(createEmptyWorkbenchTabs(), TASK), TASK),
    sourceId
  );

  const closedSource = closeWorkbenchTab(state, sourceId);
  assert.deepEqual(closedSource.items.map((item) => item.id), [configurationId]);
  assert.equal(closedSource.activeId, configurationId);

  const closedLast = closeWorkbenchTab(closedSource, configurationId);
  assert.deepEqual(closedLast, createEmptyWorkbenchTabs());
});

test('restores the persisted source and method tabs in order with the method tab active', () => {
  const restorePersistedWorkbenchTabs = tabState.restorePersistedWorkbenchTabs;
  assert.equal(typeof restorePersistedWorkbenchTabs, 'function');
  if (typeof restorePersistedWorkbenchTabs !== 'function') return;

  const restored = restorePersistedWorkbenchTabs({
    persistedTabs: [
      { kind: 'source', filePath: TASK.sourceFilePath },
      {
        kind: 'method_configuration',
        taskId: TASK.id,
        sourceFilePath: TASK.sourceFilePath,
        qualifiedClassName: TASK.qualifiedClassName
      }
    ],
    availableSourceFilePaths: [TASK.sourceFilePath],
    activeId: `methods:${TASK.id}`
  });

  assert.deepEqual(restored.items.map((item) => item.kind), ['source', 'method_configuration']);
  assert.equal(restored.activeId, `methods:${TASK.id}`);
});
