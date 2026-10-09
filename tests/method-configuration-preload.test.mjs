import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CircleAlert, RefreshCw, Settings } from 'lucide-react';
import { methodCoverageRefreshBlockReason } from '../src/renderer/src/class-tasks/method-configuration-refresh-state.ts';

const app = await readFile('src/renderer/src/App.tsx', 'utf8');
function productionFunction(name, environment) {
  const start = app.indexOf(`  async function ${name}(`) >= 0
    ? app.indexOf(`  async function ${name}(`) : app.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const closing = /\r?\n {2}\}\r?\n/.exec(app.slice(start));
  assert.ok(closing, `${name} must be complete`);
  const end = start + closing.index + closing[0].length;
  const source = stripTypeScriptTypes(app.slice(start, end), { mode: 'transform' });
  return new Function(...Object.keys(environment), `${source}; return ${name};`)(...Object.values(environment));
}

function harness(state = 'PRELOADING') {
  const task = { id: 'task-a', workspaceRoot: 'D:/fixture', qualifiedClassName: 'example.TaskService', state };
  const catalog = { taskId: task.id, methods: [] };
  const states = {};
  const catalogs = {};
  const statuses = [];
  let calls = 0;
  let request = async () => catalog;
  const environment = {
    deletedClassTaskIdsRef: { current: new Set() },
    classTaskSnapshotsRef: { current: { [task.id]: task } },
    classTaskMethodCatalogRequestIdsRef: { current: new Map() },
    classTaskMethodCatalogRequestSequenceRef: { current: 0 },
    workspaceLoadRequestRef: { current: 1 },
    activeWorkspaceRootRef: { current: task.workspaceRoot },
    setStatus: (message) => statuses.push(message),
    setClassTaskMethodCatalogLoadStates: (update) => Object.assign(states, { value: update(states.value ?? {}) }),
    setClassTaskCatalogs: (update) => Object.assign(catalogs, { value: update(catalogs.value ?? {}) }),
    isSameWorkspaceRoot: (a, b) => a === b,
    omitRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)),
    toErrorMessage: (error) => error.message,
    methodCoverageRefreshBlockReason,
    window: { workstation: { getClassTaskMethods: async () => { calls += 1; return request(); } } }
  };
  const refresh = productionFunction('refreshClassTaskCatalogIfNeeded', environment);
  return {
    task, catalog, states, catalogs, statuses, environment, refresh,
    input: { workspaceRoot: task.workspaceRoot, taskId: task.id, qualifiedClassName: task.qualifiedClassName, workspaceLoadRequestId: 1 },
    calls: () => calls,
    request: (next) => { request = next; },
    synchronize() {
      return productionFunction('synchronizeMethodConfigurationPreload', {
        ...environment, workspaceRoot: task.workspaceRoot,
        activeMethodConfigurationTask: task,
        activeMethodConfigurationLoadState: states.value?.[task.id],
        classTaskCatalogs: catalogs.value ?? {},
        refreshClassTaskCatalogIfNeeded: refresh
      })();
    }
  };
}

test('opening method configuration during preload waits without invoking the catalog IPC', async () => {
  const h = harness();
  await h.refresh(h.input);
  assert.equal(h.calls(), 0);
  assert.equal(h.states.value[h.task.id].status, 'waiting_for_preload');
  assert.doesNotMatch(h.statuses.join('\n'), /失败/);
});

test('preload completion automatically reads the catalog once', async () => {
  const h = harness();
  await h.refresh(h.input);
  h.task.state = 'READY';
  h.synchronize();
  h.synchronize();
  await new Promise(setImmediate);
  assert.equal(h.calls(), 1);
  assert.equal(h.states.value[h.task.id], undefined);
  assert.equal(h.catalogs.value[h.task.id], h.catalog);
});

test('starting preload replaces an old catalog failure with a waiting state', () => {
  const h = harness();
  h.states.value = { [h.task.id]: { status: 'error', message: 'old failure' } };
  h.synchronize();
  assert.equal(h.states.value[h.task.id].status, 'waiting_for_preload');
  assert.equal(h.calls(), 0);
  assert.equal(h.statuses.at(-1), '正在加载方法与覆盖率信息...');
});

test('a real preload failure exits loading without starting another preload', async () => {
  const h = harness();
  await h.refresh(h.input);
  h.task.state = 'PRELOAD_FAILED';
  h.task.lastError = { message: 'Maven compilation failed' };
  h.synchronize();
  assert.equal(h.states.value[h.task.id].status, 'error');
  assert.equal(h.states.value[h.task.id].message, h.task.lastError.message);
  assert.equal(h.calls(), 0);
});

test('a catalog request that races with preload waits instead of reporting a load failure', async () => {
  const h = harness('READY');
  h.request(async () => {
    h.task.state = 'PRELOADING';
    throw new Error('当前类正在预加载，请稍后再打开方法列表。');
  });
  await h.refresh(h.input);
  assert.equal(h.calls(), 1);
  assert.equal(h.states.value[h.task.id].status, 'waiting_for_preload');
  assert.doesNotMatch(h.statuses.join('\n'), /失败/);
});

test('a late busy reply after preload completion still refreshes the catalog', async () => {
  const h = harness('READY');
  let first = true;
  h.request(async () => {
    if (first) { first = false; throw new Error('当前类正在预加载，请稍后再打开方法列表。'); }
    return h.catalog;
  });
  await h.refresh(h.input);
  await new Promise(setImmediate);
  assert.equal(h.calls(), 2);
  assert.equal(h.states.value[h.task.id], undefined);
  assert.equal(h.catalogs.value[h.task.id], h.catalog);
});

test('repeated busy replies without a preloading snapshot do not create an unbounded retry loop', async () => {
  const h = harness('READY');
  h.request(async () => {
    if (h.calls() <= 2) throw new Error('当前类正在预加载，请稍后再打开方法列表。');
    throw new Error('unexpected extra request');
  });
  await h.refresh(h.input);
  await new Promise(setImmediate);
  h.synchronize();
  await new Promise(setImmediate);
  assert.equal(h.calls(), 2);
  assert.equal(h.states.value[h.task.id].status, 'error');
});

test('a stale busy reply cannot refresh a workspace that has been closed', async () => {
  const h = harness('READY');
  h.request(async () => {
    h.environment.workspaceLoadRequestRef.current += 1;
    h.environment.activeWorkspaceRootRef.current = 'D:/other-workspace';
    throw new Error('当前类正在预加载，请稍后再打开方法列表。');
  });
  await h.refresh(h.input);
  await new Promise(setImmediate);
  assert.equal(h.calls(), 1);
  assert.equal(h.states.value[h.task.id].status, 'loading');
  assert.equal(h.environment.classTaskMethodCatalogRequestIdsRef.current.size, 0);
});

test('genuine catalog failures retain the retryable error state', async () => {
  const h = harness('READY');
  h.request(async () => { throw new Error('report is unavailable'); });
  await h.refresh(h.input);
  assert.equal(h.calls(), 1);
  assert.equal(h.states.value[h.task.id].status, 'error');
  assert.match(h.statuses.at(-1), /方法配置加载失败/);
});

test('manual refresh does not request or reset an active task catalog', async () => {
  for (const state of ['PRELOADING', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING']) {
    const h = harness(state);
    h.catalogs.value = { [h.task.id]: h.catalog };
    await h.refresh({ ...h.input, cachedCatalog: h.catalog, forceReload: true, manualRefresh: true });
    assert.equal(h.calls(), 0, state);
    assert.equal(h.states.value?.[h.task.id], undefined, state);
    assert.equal(h.catalogs.value[h.task.id], h.catalog);
    assert.match(h.statuses.at(-1), /不能手动刷新/);
  }
});

test('a failed manual refresh keeps the catalog and clears its warning on a successful retry', async () => {
  const h = harness('READY');
  h.catalogs.value = { [h.task.id]: h.catalog };
  h.request(async () => { throw new Error('Maven report failed'); });
  const input = { ...h.input, cachedCatalog: h.catalog, forceReload: true, manualRefresh: true };
  await h.refresh(input);
  assert.deepEqual(h.states.value[h.task.id], { status: 'refresh_error', message: 'Maven report failed' });
  assert.equal(h.catalogs.value[h.task.id], h.catalog);
  assert.match(h.statuses.at(-1), /刷新失败，已保留/);
  h.request(async () => h.catalog);
  await h.refresh(input);
  assert.equal(h.calls(), 2);
  assert.equal(h.states.value[h.task.id], undefined);
});

test('manual refresh without an existing catalog still reports a genuine load failure', async () => {
  const h = harness('READY');
  h.request(async () => { throw new Error('Maven report failed'); });
  await h.refresh({ ...h.input, forceReload: true, manualRefresh: true });
  assert.equal(h.states.value[h.task.id].status, 'error');
});

function renderProductionPane(taskState, loadState, withCatalog = false) {
  const normalized = app.replaceAll('\r\n', '\n');
  const start = normalized.indexOf('                activeMethodConfigurationTask\n');
  const end = normalized.indexOf('\n              ) : selectedFile ?', start);
  assert.ok(start > 0 && end > start, 'production method pane must exist');
  const waitingStart = normalized.indexOf('  const activeMethodConfigurationWaitingForPreload =');
  const waitingEnd = normalized.indexOf(';', waitingStart) + 1;
  const waiting = normalized.slice(waitingStart, waitingEnd);
  const env = {
    activeMethodConfigurationTask: { id: 'task-a', state: taskState },
    activeMethodConfigurationLoadState: loadState,
    activeMethodConfigurationCatalog: withCatalog ? { methods: [] } : null,
    activeWorkbenchTab: { taskId: 'task-a', qualifiedClassName: 'example.TaskService' },
    savingMethodSelectionTaskId: null, methodSelectionSaveErrors: {},
    refreshClassTaskMethodConfiguration() {}, saveClassTaskMethodConfiguration() {},
    retryClassTaskMethodConfiguration() {}, CircleAlert, RefreshCw, Settings,
    MethodConfigurationTab: () => React.createElement('div', { className: 'catalog-stub' }, 'catalog')
  };
  const compiled = ts.transpileModule(
    `function pane() { ${waiting}\n return <>${'{'}${normalized.slice(start, end)}${'}'}</>; }`,
    { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS }, fileName: 'pane.tsx' }
  ).outputText;
  const pane = new Function('require', 'exports', ...Object.keys(env), `${compiled}; return pane;`)(
    createRequire(import.meta.url), {}, ...Object.values(env)
  );
  return renderToStaticMarkup(React.createElement(pane));
}

test('the production pane shows loading during preload even with a stale error or cached catalog', () => {
  for (const cached of [false, true]) {
    const html = renderProductionPane('PRELOADING', { status: 'error', message: 'old failure' }, cached);
    assert.match(html, /role="status"/);
    assert.match(html, /正在加载方法与覆盖率信息/);
    assert.doesNotMatch(html, /读取失败|class-task-method-retry|catalog-stub/);
  }
});

test('the production pane returns to its catalog or genuine error after loading', () => {
  assert.match(renderProductionPane('READY', undefined, true), /catalog-stub/);
  const html = renderProductionPane('PRELOAD_FAILED', { status: 'error', message: 'real failure' });
  assert.match(html, /覆盖率信息读取失败/);
  assert.match(html, /重试/);
  assert.doesNotMatch(html, /class-task-method-loading/);
});
