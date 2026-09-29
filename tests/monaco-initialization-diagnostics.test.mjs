import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MONACO_STAGE_EVENT,
  getMonacoFailureCause,
  runMonacoStage,
  runMonacoStageAsync,
  toMonacoInitializationFailure
} from '../src/renderer/src/monaco-initialization-diagnostics.ts';

const EXPECTED_STAGE_EVENTS = {
  'core-runtime': 'MONACO_CORE_RUNTIME_FAILURE',
  'theme-registration': 'MONACO_THEME_REGISTRATION_FAILURE',
  'java-language-registration': 'MONACO_JAVA_LANGUAGE_REGISTRATION_FAILURE',
  'java-configuration': 'MONACO_JAVA_CONFIGURATION_FAILURE',
  'java-tokenizer': 'MONACO_JAVA_TOKENIZER_FAILURE',
  'editor-create': 'MONACO_EDITOR_CREATE_FAILURE',
  'attach-callback': 'MONACO_EDITOR_ATTACH_CALLBACK_FAILURE',
  reconcile: 'MONACO_EDITOR_RECONCILE_FAILURE',
  'local-decoration': 'MONACO_LOCAL_DECORATION_FAILURE'
};

function createSensitiveCause(stage) {
  return new TypeError(`sensitive ${stage} C:\\secret\\source.java`);
}

function assertSafeStageLog(observed, event) {
  assert.deepEqual(observed, [[
    `[renderer] ${event}`,
    'TypeError',
    'UNKNOWN'
  ]]);
  assert.doesNotMatch(JSON.stringify(observed), /sensitive|stack|\.java|[A-Za-z]:\\/);
}

test('阶段映射只保留九个本地 Monaco 固定事件', () => {
  assert.deepEqual(MONACO_STAGE_EVENT, EXPECTED_STAGE_EVENTS);
});

test('嵌套阶段保留最内层精确失败和原始 cause', () => {
  const cause = createSensitiveCause('editor-create');
  const inner = toMonacoInitializationFailure('editor-create', cause);
  const outer = toMonacoInitializationFailure('reconcile', inner);

  assert.equal(outer, inner);
  assert.equal(outer.stage, 'editor-create');
  assert.equal(getMonacoFailureCause(outer), cause);
});

test('每个同步阶段只记录安全三元组并继续抛出原始 cause', () => {
  const originalConsoleError = console.error;
  const observed = [];
  console.error = (...args) => observed.push(args);

  try {
    for (const [stage, event] of Object.entries(EXPECTED_STAGE_EVENTS)) {
      const cause = createSensitiveCause(stage);
      assert.throws(
        () => runMonacoStage(stage, () => { throw cause; }),
        (error) => error.stage === stage && error.cause === cause
      );
      assertSafeStageLog(observed.splice(0), event);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('每个异步阶段只记录安全三元组并继续抛出原始 cause', async () => {
  const originalConsoleError = console.error;
  const observed = [];
  console.error = (...args) => observed.push(args);

  try {
    for (const [stage, event] of Object.entries(EXPECTED_STAGE_EVENTS)) {
      const cause = createSensitiveCause(stage);
      await assert.rejects(
        runMonacoStageAsync(stage, async () => { throw cause; }),
        (error) => error.stage === stage && error.cause === cause
      );
      assertSafeStageLog(observed.splice(0), event);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('嵌套 runner 仅记录内层事件，外层不覆盖 stage 或 cause', async () => {
  const originalConsoleError = console.error;
  const observed = [];
  const cause = createSensitiveCause('editor-create');
  console.error = (...args) => observed.push(args);

  try {
    await assert.rejects(
      runMonacoStageAsync('core-runtime', async () =>
        runMonacoStage('editor-create', () => { throw cause; })
      ),
      (error) => error.stage === 'editor-create' && error.cause === cause
    );
  } finally {
    console.error = originalConsoleError;
  }

  assertSafeStageLog(observed, EXPECTED_STAGE_EVENTS['editor-create']);
});
