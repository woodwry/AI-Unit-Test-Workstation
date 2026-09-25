import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionsForClassTask,
  buildClassTaskCardView,
  describeClassTaskDeleteConfirmation,
  resolveClassTaskDeleteRequest,
  releaseClassTaskCommandDispatch,
  resolveClassTaskCardClick,
  resolveClassTaskIconClick,
  resolveClassTaskTotalControl
} from '../src/renderer/src/class-tasks/class-task-card-view.ts';

test('inactive tasks and handled terminal tasks delete immediately without confirmation', () => {
  for (const task of [
    snapshot('PRELOADING'),
    snapshot('PRELOADING', { preloadState: 'IDLE' }),
    snapshot('PRELOAD_FAILED'),
    snapshot('READY'),
    snapshot('STOPPING'),
    snapshot('FAILED'),
    snapshot('TERMINATED'),
    snapshot('TERMINATED', { generatedArtifacts: [{ ...artifact(), accepted: true }] }),
    snapshot('COMPLETED'),
    snapshot('COMPLETED', { generatedArtifacts: [{ ...artifact(), accepted: true }] })
  ]) {
    assert.deepEqual(resolveClassTaskDeleteRequest(task), {
      kind: 'delete',
      taskId: task.id
    });
  }

  for (const state of [
    'RUNNING',
    'PAUSE_REQUESTED',
    'PAUSED',
    'INTERRUPTED'
  ]) {
    const task = snapshot(state);
    assert.deepEqual(resolveClassTaskDeleteRequest(task), {
      kind: 'confirm_delete',
      taskId: task.id
    });
  }

  for (const task of [
    snapshot('TERMINATED', { generatedArtifacts: [artifact()] }),
    snapshot('COMPLETED', { generatedArtifacts: [artifact()] }),
    snapshot('COMPLETED', {
      generatedArtifacts: [artifact(), { ...artifact(), id: 'artifact-2', accepted: true }]
    })
  ]) {
    assert.deepEqual(resolveClassTaskDeleteRequest(task), {
      kind: 'confirm_delete',
      taskId: task.id
    });
  }
});

test('delete confirmation explains active termination and pending result removal', () => {
  assert.deepEqual(describeClassTaskDeleteConfirmation(snapshot('RUNNING')), {
    title: '终止任务并删除？',
    message: 'TaskService.java 正在执行。删除会先终止当前任务，再移除该任务及其未接受的生成结果。',
    confirmLabel: '终止并删除'
  });
  assert.deepEqual(describeClassTaskDeleteConfirmation(snapshot('READY')), {
    title: '删除任务？',
    message: 'TaskService.java 将从任务列表中移除，未接受的生成结果也会一并删除。',
    confirmLabel: '删除'
  });
  assert.deepEqual(describeClassTaskDeleteConfirmation(
    snapshot('PRELOADING', { preloadState: 'IDLE' })
  ), {
    title: '删除任务？',
    message: 'TaskService.java 将从任务列表中移除，未接受的生成结果也会一并删除。',
    confirmLabel: '删除'
  });
});

test('card actions match every approved state without shifting the action slots', () => {
  assert.deepEqual(actionsForClassTask(snapshot('PRELOADING')), ['locate', 'spinner', 'stop_preload', 'delete']);
  assert.deepEqual(
    actionsForClassTask(snapshot('PRELOADING', { preloadState: 'IDLE' })),
    ['locate', 'retry_preload', 'delete']
  );
  assert.deepEqual(actionsForClassTask(snapshot('PRELOAD_FAILED')), ['locate', 'retry_preload', 'delete']);
  assert.deepEqual(actionsForClassTask(snapshot('READY')), ['run', 'locate', 'configure', 'delete']);
  assert.deepEqual(actionsForClassTask(snapshot('RUNNING')), ['spinner', 'pause', 'terminate', 'locate', 'configure', 'delete']);
  assert.deepEqual(actionsForClassTask(snapshot('PAUSED')), ['resume', 'terminate', 'locate', 'configure', 'delete']);
  assert.deepEqual(actionsForClassTask(snapshot('COMPLETED')), ['run', 'locate', 'configure', 'delete']);
  assert.deepEqual(actionsForClassTask(snapshot('TERMINATED')), ['run', 'locate', 'configure', 'delete']);
  for (const state of ['COMPLETED', 'TERMINATED']) {
    assert.deepEqual(
      actionsForClassTask(snapshot(state, { generatedArtifacts: [artifact()] })),
      ['result', 'locate', 'configure', 'delete']
    );
  }
});

test('card click opens completed or terminated results after generation files are revoked', () => {
  const emptyTask = snapshot('READY');
  const resultTask = snapshot('COMPLETED', { generatedArtifacts: [artifact()] });
  const revokedResultTask = snapshot('COMPLETED', {
    coverageBaseline: coverage(0),
    coverageCurrent: coverage(0)
  });
  const revokedTerminatedResultTask = snapshot('TERMINATED', {
    coverageBaseline: coverage(0),
    coverageCurrent: coverage(0)
  });

  assert.deepEqual(resolveClassTaskCardClick(emptyTask), { kind: 'show_empty_result_hint', taskId: emptyTask.id });
  assert.deepEqual(resolveClassTaskCardClick(resultTask), { kind: 'open_result', taskId: resultTask.id });
  assert.deepEqual(resolveClassTaskCardClick(revokedResultTask), {
    kind: 'open_result',
    taskId: revokedResultTask.id
  });
  assert.deepEqual(resolveClassTaskCardClick(revokedTerminatedResultTask), {
    kind: 'open_result',
    taskId: revokedTerminatedResultTask.id
  });
  assert.deepEqual(resolveClassTaskIconClick(resultTask, 'locate'), { kind: 'locate_source', taskId: resultTask.id });
  assert.deepEqual(resolveClassTaskIconClick(resultTask, 'configure'), { kind: 'open_configuration', taskId: resultTask.id });
});

test('card run rejects every empty selection and accepts an explicit non-empty selection', () => {
  const explicitlyEmpty = snapshot('READY', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: [],
    methodOrder: []
  });
  const explicitlySelected = snapshot('READY', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-1'],
    methodOrder: ['method-1']
  });

  assert.deepEqual(resolveClassTaskIconClick(explicitlyEmpty, 'run'), {
    kind: 'show_method_selection_hint',
    taskId: explicitlyEmpty.id
  });
  assert.deepEqual(resolveClassTaskIconClick(explicitlySelected, 'run'), {
    kind: 'run',
    taskId: explicitlySelected.id
  });
  assert.deepEqual(resolveClassTaskIconClick(snapshot('READY'), 'run'), {
    kind: 'show_method_selection_hint',
    taskId: explicitlyEmpty.id
  });
});

test('card run cannot dispatch a completed or terminated result awaiting accept or revoke', () => {
  const accepted = snapshot('COMPLETED', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-1'],
    methodOrder: ['method-1'],
    generatedArtifacts: [{ ...artifact(), accepted: true }]
  });
  const revoked = snapshot('COMPLETED', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-1'],
    methodOrder: ['method-1'],
    generatedArtifacts: []
  });

  for (const state of ['COMPLETED', 'TERMINATED']) {
    const pending = snapshot(state, {
      selectionMode: 'EXPLICIT',
      selectedMethodIds: ['method-1'],
      methodOrder: ['method-1'],
      generatedArtifacts: [artifact()]
    });
    assert.deepEqual(resolveClassTaskIconClick(pending, 'run'), {
      kind: 'none',
      taskId: pending.id
    });
    assert.deepEqual(resolveClassTaskIconClick(pending, 'result'), {
      kind: 'open_result',
      taskId: pending.id
    });
  }
  assert.deepEqual(resolveClassTaskIconClick(accepted, 'run'), {
    kind: 'run',
    taskId: accepted.id
  });
  assert.deepEqual(resolveClassTaskIconClick(revoked, 'run'), {
    kind: 'run',
    taskId: revoked.id
  });
});

test('accepting or revoking a result resets the card file and test counters', () => {
  const accepted = buildClassTaskCardView(snapshot('COMPLETED', {
    generatedArtifacts: [{ ...artifact(), accepted: true }]
  }));
  const revoked = buildClassTaskCardView(snapshot('COMPLETED', {
    generatedArtifacts: []
  }));
  const nextRun = buildClassTaskCardView(snapshot('RUNNING', {
    generatedArtifacts: [
      { ...artifact(), accepted: true },
      { ...artifact(), id: 'artifact-2', ordinaryTestMethodCount: 3 }
    ]
  }));

  assert.deepEqual(
    [accepted.testFileCount, accepted.testMethodCount],
    [0, 0]
  );
  assert.deepEqual(
    [revoked.testFileCount, revoked.testMethodCount],
    [0, 0]
  );
  assert.deepEqual(
    [nextRun.testFileCount, nextRun.testMethodCount],
    [1, 3]
  );
});

test('total execution counts only tasks with an explicit non-empty method selection', () => {
  const selected = snapshot('READY', {
    selectionMode: 'EXPLICIT',
    selectedMethodIds: ['method-1'],
    methodOrder: ['method-1']
  });
  const unselected = snapshot('READY', {
    id: '22222222-2222-4222-8222-222222222222',
    selectionMode: 'EXPLICIT',
    selectedMethodIds: [],
    methodOrder: []
  });

  assert.deepEqual(resolveClassTaskTotalControl([selected, unselected]), {
    kind: 'run',
    eligibleCount: 1
  });
  assert.deepEqual(resolveClassTaskTotalControl([unselected]), { kind: 'idle' });
});

test('preload failure view exposes module diagnostics and a repair instruction', () => {
  const failed = snapshot('PRELOAD_FAILED', {
    preloadState: 'FAILED',
    lastError: {
      code: 'MODULE_MAVEN_FAILED',
      message: 'test-compile exited with code 1',
      moduleName: 'module-a',
      modulePath: 'D:\\work\\module-a',
      command: 'mvn.cmd -pl module-a test-compile',
      occurredAt: '2026-08-09T00:00:00.000Z'
    }
  });

  const view = buildClassTaskCardView(failed);

  assert.equal(view.statusLabel, 'Maven 执行失败');
  assert.equal(view.error?.modulePath, 'D:\\work\\module-a');
  assert.match(view.error?.command ?? '', /mvn\.cmd/);
  assert.match(view.error?.message ?? '', /请修复该模块后重新检测/);
});

test('analysis failures are not presented as Maven failures', () => {
  const failed = snapshot('PRELOAD_FAILED', {
    preloadState: 'FAILED',
    lastError: {
      code: 'CLASS_PRELOAD_FAILED',
      message: '单方法分析请求失败：404',
      moduleName: 'module-a',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-08-09T00:00:00.000Z'
    }
  });

  const view = buildClassTaskCardView(failed);

  assert.equal(view.statusLabel, '分析失败');
  assert.equal(view.error?.command, '无相关命令');
  assert.match(view.error?.message ?? '', /单方法分析请求失败：404/);
  assert.match(view.error?.message ?? '', /确认本地分析服务/);
  assert.doesNotMatch(view.error?.message ?? '', /修复该模块/);
});

test('dependency context failures ask for a fresh analysis context instead of blaming Maven or the service', () => {
  const failed = snapshot('PRELOAD_FAILED', {
    preloadState: 'FAILED',
    lastError: {
      code: 'CLASS_PRELOAD_FAILED',
      message: '刷新单方法覆盖率失败（DEPENDENCY_CONTEXT_CHANGED）：项目依赖已经变化或无法继续读取。',
      moduleName: 'module-a',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-09-18T00:00:00.000Z'
    }
  });

  const view = buildClassTaskCardView(failed);

  assert.equal(view.statusLabel, '分析失败');
  assert.match(view.error?.message ?? '', /重新建立当前类的分析上下文/);
  assert.doesNotMatch(view.error?.message ?? '', /修复该模块|确认本地分析服务/);
});

test('invalid generated code is presented as an execution failure instead of an unavailable model', () => {
  for (const code of ['GENERATED_TEST_INVALID', 'MODEL_FAILED']) {
    const failed = snapshot('FAILED', {
      lastError: {
        code,
        message: '单方法生成失败：模型输出包含 import 白名单外的类型。',
        moduleName: 'com.dtsz.collection.model.service.TaskService',
        modulePath: 'D:\\work\\collection-core',
        command: null,
        occurredAt: '2026-08-12T12:08:28.344Z'
      }
    });

    const view = buildClassTaskCardView(failed);

    assert.equal(view.statusLabel, '执行失败');
    assert.equal(view.error?.moduleName, 'com.dtsz.collection.model.service.TaskService');
    assert.equal(view.error?.command, '无相关命令');
    assert.match(view.error?.message ?? '', /import 白名单外的类型/);
    assert.match(view.error?.message ?? '', /查看错误详情并修复后重试/);
    assert.doesNotMatch(view.error?.message ?? '', /检查大模型平台/);
  }
});

test('zero-file generation keeps validation failures distinct from provider failures', () => {
  const invalidOutput = buildClassTaskCardView(snapshot('FAILED', {
    lastError: {
      code: 'MODEL_NO_FORMAL_TEST_FILE_GENERATED',
      message: '未生成任何正式测试文件。MODEL_FAILED: 单方法生成失败：模型输出包含 import 白名单外的类型。',
      moduleName: 'example.TaskService',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-08-12T12:08:28.344Z'
    }
  }));
  const rateLimited = buildClassTaskCardView(snapshot('FAILED', {
    lastError: {
      code: 'MODEL_NO_FORMAL_TEST_FILE_GENERATED',
      message: '未生成任何正式测试文件。MODEL_RATE_LIMITED: provider throttled',
      moduleName: 'example.TaskService',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-08-12T12:08:28.344Z'
    }
  }));

  assert.equal(invalidOutput.statusLabel, '执行失败');
  assert.match(invalidOutput.error?.message ?? '', /查看错误详情并修复后重试/);
  assert.equal(rateLimited.statusLabel, '所选模型不可用');
  assert.match(rateLimited.error?.message ?? '', /检查大模型平台状态与接口地址/);
});

test('platform and model failures share the unavailable-model label with distinct guidance', () => {
  const platformFailure = buildClassTaskCardView(snapshot('FAILED', {
    lastError: {
      code: 'MODEL_UNAVAILABLE',
      message: '请求未成功。',
      moduleName: 'example.TaskService',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-08-12T12:08:28.344Z'
    }
  }));
  const modelFailure = buildClassTaskCardView(snapshot('FAILED', {
    lastError: {
      code: 'MODEL_NOT_FOUND',
      message: '请求未成功。',
      moduleName: 'example.TaskService',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-08-12T12:08:28.344Z'
    }
  }));

  assert.equal(platformFailure.statusLabel, '所选模型不可用');
  assert.match(platformFailure.error?.message ?? '', /检查大模型平台状态与接口地址/);
  assert.equal(modelFailure.statusLabel, '所选模型不可用');
  assert.match(modelFailure.error?.message ?? '', /检查模型名称、访问权限与接口配置/);
});

test('paused model failures are shown on the card only as model unavailable', () => {
  const quotaError = {
    code: 'MODEL_QUOTA_EXHAUSTED',
    message: 'The selected model quota is exhausted',
    moduleName: 'example.TaskService',
    modulePath: 'D:\\work\\module-a',
    command: null,
    occurredAt: '2026-08-12T12:08:28.344Z'
  };
  const paused = buildClassTaskCardView(snapshot('PAUSED', {
    currentAtomicStep: 'MODEL_GENERATION',
    lastError: quotaError
  }));
  const unavailable = buildClassTaskCardView(snapshot('PAUSED', {
    currentAtomicStep: 'MODEL_GENERATION',
    lastError: {
      ...quotaError,
      code: 'MODEL_UNAVAILABLE',
      message: 'Provider disconnected'
    }
  }));
  const failed = buildClassTaskCardView(snapshot('FAILED', {
    lastError: quotaError
  }));

  assert.equal(paused.statusLabel, '模型不可用');
  assert.deepEqual(paused.execution, {
    label: '已暂停 · 生成单元测试',
    animated: false
  });
  assert.equal(paused.error, null);
  assert.equal(unavailable.statusLabel, '模型不可用');
  assert.deepEqual(unavailable.execution, {
    label: '已暂停 · 生成单元测试',
    animated: false
  });
  assert.equal(unavailable.error, null);
  assert.equal(failed.statusLabel, '所选模型不可用');
  assert.match(failed.error?.message ?? '', /当前选择的模型不可用/);
  assert.match(failed.error?.message ?? '', /切换可用模型后重试/);
  assert.doesNotMatch(failed.error?.message ?? '', /quota|额度/i);
});

test('non-model execution failures keep a generic card label and guidance', () => {
  const view = buildClassTaskCardView(snapshot('FAILED', {
    lastError: {
      code: 'CLASS_TASK_EXECUTION_FAILED',
      message: '生成文件被外部修改。',
      moduleName: 'example.TaskService',
      modulePath: 'D:\\work\\module-a',
      command: null,
      occurredAt: '2026-08-12T12:08:28.344Z'
    }
  }));

  assert.equal(view.statusLabel, '执行失败');
  assert.match(view.error?.message ?? '', /查看错误详情并修复后重试/);
  assert.doesNotMatch(view.error?.message ?? '', /检查大模型平台/);
});

test('completed and terminated results awaiting accept or revoke request attention', () => {
  const pending = snapshot('COMPLETED', {
    completionAttentionPending: true,
    generatedArtifacts: [artifact()]
  });
  const accepted = snapshot('COMPLETED', {
    completionAttentionPending: true,
    generatedArtifacts: [{ ...artifact(), accepted: true }]
  });
  const revoked = snapshot('COMPLETED', {
    completionAttentionPending: true,
    generatedArtifacts: []
  });

  assert.equal(buildClassTaskCardView(pending).needsAttention, true);
  assert.equal(buildClassTaskCardView(pending, true).needsAttention, false);
  assert.equal(buildClassTaskCardView(accepted).needsAttention, false);
  assert.equal(buildClassTaskCardView(revoked).needsAttention, false);
  assert.equal(buildClassTaskCardView(snapshot('TERMINATED', {
    completionAttentionPending: true,
    generatedArtifacts: [artifact()]
  })).needsAttention, true);
});

test('a running card exposes live elapsed time in HH:MM:SS format', () => {
  const running = snapshot('RUNNING', {
    startedAt: '2026-08-09T00:00:00.000Z'
  });

  const view = buildClassTaskCardView(
    running,
    false,
    Date.parse('2026-08-09T01:02:03.900Z')
  );

  assert.equal(view.elapsedTimeLabel, '01:02:03');
});

test('a paused card freezes elapsed time at the pause boundary', () => {
  const paused = snapshot('PAUSED', {
    startedAt: '2026-08-09T00:00:00.000Z',
    pausedAt: '2026-08-09T00:10:00.000Z',
    updatedAt: '2026-08-09T00:20:00.000Z'
  });

  assert.equal(
    buildClassTaskCardView(
      paused,
      false,
      Date.parse('2026-08-09T02:00:00.000Z')
    ).elapsedTimeLabel,
    '00:10:00'
  );
});

test('active cards expose method bars while stopping and terminated cards retain only the progress text', () => {
  const justStarted = snapshot('RUNNING', {
    methodOrder: ['method-1', 'method-2', 'method-3'],
    currentMethodIndex: -1
  });
  const generatingSecond = snapshot('RUNNING', {
    methodOrder: ['method-1', 'method-2', 'method-3'],
    currentMethodIndex: 0,
    currentAtomicStep: 'MODEL_GENERATION'
  });
  const pauseRequested = snapshot('PAUSE_REQUESTED', {
    methodOrder: ['method-1', 'method-2', 'method-3'],
    currentMethodIndex: 0
  });
  const paused = snapshot('PAUSED', {
    methodOrder: ['method-1', 'method-2', 'method-3'],
    currentMethodIndex: 0
  });
  const stopping = snapshot('STOPPING', {
    methodOrder: ['method-1', 'method-2', 'method-3'],
    currentMethodIndex: 0
  });
  const terminated = snapshot('TERMINATED', {
    methodOrder: ['method-1', 'method-2', 'method-3'],
    currentMethodIndex: 0
  });

  assert.deepEqual(buildClassTaskCardView(justStarted).methodProgress, {
    completed: 0,
    total: 3,
    tone: 'active',
    showBar: true,
    countLabel: '完成 0/3',
    label: '已完成 0/3 个方法'
  });
  assert.deepEqual(buildClassTaskCardView(generatingSecond).methodProgress, {
    completed: 1,
    total: 3,
    tone: 'active',
    showBar: true,
    countLabel: '完成 1/3',
    label: '已完成 1/3 个方法；当前方法处理中',
    activeBatch: {
      methodCount: 1,
      start: 1,
      end: 2
    }
  });
  assert.deepEqual(buildClassTaskCardView(pauseRequested).methodProgress, {
    completed: 1,
    total: 3,
    tone: 'paused',
    showBar: true,
    countLabel: '完成 1/3',
    label: '已完成 1/3 个方法'
  });
  assert.deepEqual(buildClassTaskCardView(paused).methodProgress, {
    completed: 1,
    total: 3,
    tone: 'paused',
    showBar: true,
    countLabel: '完成 1/3',
    label: '已完成 1/3 个方法'
  });
  assert.deepEqual(buildClassTaskCardView(stopping).methodProgress, {
    completed: 1,
    total: 3,
    tone: 'neutral',
    showBar: false,
    countLabel: '完成 1/3',
    label: '已完成 1/3 个方法'
  });
  assert.deepEqual(buildClassTaskCardView(terminated).methodProgress, {
    completed: 1,
    total: 3,
    tone: 'neutral',
    showBar: false,
    countLabel: '完成 1/3',
    label: '已完成 1/3 个方法'
  });
});

test('a terminated task with zero coverage and no generated files does not show stale completed methods', () => {
  const terminated = snapshot('TERMINATED', {
    methodOrder: Array.from({ length: 78 }, (_, index) => `method-${index + 1}`),
    currentMethodIndex: 1,
    generatedArtifacts: [],
    coverageCurrent: coverage(0)
  });

  assert.deepEqual(buildClassTaskCardView(terminated).methodProgress, {
    completed: 0,
    total: 78,
    tone: 'neutral',
    showBar: false,
    countLabel: '完成 0/78',
    label: '已完成 0/78 个方法'
  });
});

test('latest JaCoCo coverage advances method progress beyond a lagging execution checkpoint', () => {
  const running = snapshot('RUNNING', {
    methodOrder: Array.from({ length: 78 }, (_, index) => `method-${index + 1}`),
    currentMethodIndex: 0,
    coveredMethodIds: [
      'method-1',
      'method-8',
      'method-19',
      'method-20',
      'method-21'
    ]
  });

  assert.deepEqual(buildClassTaskCardView(running).methodProgress, {
    completed: 5,
    total: 78,
    tone: 'active',
    showBar: true,
    countLabel: '完成 5/78',
    label: '已完成 5/78 个方法'
  });
});
test('a running scenario batch exposes a provisional progress segment without inflating completed methods', () => {
  const runningBatch = snapshot('RUNNING', {
    methodOrder: ['method-1', 'method-2', 'method-3', 'method-4', 'method-5'],
    currentMethodIndex: 0,
    currentAtomicStep: 'MODEL_GENERATION',
    activeGenerationBatch: {
      methodCount: 2,
      scenarioCount: 5
    }
  });

  assert.deepEqual(buildClassTaskCardView(runningBatch).methodProgress, {
    completed: 1,
    total: 5,
    tone: 'active',
    showBar: true,
    countLabel: '完成 1/5',
    label: '已完成 1/5 个方法；当前批次 2 个方法 / 5 个场景',
    activeBatch: {
      methodCount: 2,
      scenarioCount: 5,
      start: 1,
      end: 3
    }
  });
});

test('an ordinary atomic method step reuses the animated batch segment without inflating completion', () => {
  const runningMethod = snapshot('RUNNING', {
    methodOrder: ['method-1', 'method-2'],
    currentMethodIndex: -1,
    currentAtomicStep: 'MAVEN_TEST',
    activeGenerationBatch: null
  });

  assert.deepEqual(buildClassTaskCardView(runningMethod).methodProgress, {
    completed: 0,
    total: 2,
    tone: 'active',
    showBar: true,
    countLabel: '完成 0/2',
    label: '已完成 0/2 个方法；当前方法处理中',
    activeBatch: {
      methodCount: 1,
      start: 0,
      end: 1
    }
  });
});

test('a finished card freezes elapsed time and invalid timestamps stay hidden', () => {
  const completed = snapshot('COMPLETED', {
    startedAt: '2026-08-09T00:00:00.000Z',
    finishedAt: '2026-08-10T02:03:04.000Z'
  });
  const invalid = snapshot('RUNNING', { startedAt: 'invalid' });

  assert.equal(
    buildClassTaskCardView(completed, false, Date.parse('2026-08-11T00:00:00.000Z')).elapsedTimeLabel,
    '26:03:04'
  );
  assert.equal(buildClassTaskCardView(invalid, false, 0).elapsedTimeLabel, null);
});

test('the first runtime snapshot releases card controls while total dispatch waits for remaining tasks', () => {
  const first = releaseClassTaskCommandDispatch({
    busyTaskIds: new Set(['task-a', 'task-b']),
    totalPendingTaskIds: new Set(['task-a', 'task-b'])
  }, 'task-a');

  assert.deepEqual([...first.busyTaskIds], ['task-b']);
  assert.deepEqual([...first.totalPendingTaskIds], ['task-b']);
  assert.equal(first.totalCommandBusy, true);

  const second = releaseClassTaskCommandDispatch(first, 'task-b');
  assert.deepEqual([...second.busyTaskIds], []);
  assert.deepEqual([...second.totalPendingTaskIds], []);
  assert.equal(second.totalCommandBusy, false);
});

test('execution footer follows the current step without exposing concurrent generation parts', () => {
  const stages = [
    ['IDLE', '正在准备任务'],
    ['ANALYZE_METHOD', '正在分析方法与准备上下文'],
    ['MODEL_GENERATION', '正在生成单元测试'],
    ['MODEL_REPAIR', '正在修复单元测试'],
    ['CONFIRM_RESULT', '正在确认测试结果'],
    ['WRITE_CANDIDATE', '正在写入候选测试代码'],
    ['MAVEN_COMPILE', '正在执行 Maven 编译'],
    ['MAVEN_TEST', '正在执行 Maven 测试验证'],
    ['PRUNE_FAILED_TESTS', '正在进行稳定修复'],
    ['MERGE_METHOD_BATCHES', '正在合并测试代码'],
    ['PACK_FORMAL_FILE', '正在保存单元测试文件'],
    ['JACOCO_REFRESH', '正在刷新 JaCoCo 覆盖率']
  ];
  for (const [currentAtomicStep, label] of stages) {
    assert.deepEqual(buildClassTaskCardView(snapshot('RUNNING', {
      currentAtomicStep,
      activeGenerationBatch: { methodCount: 1, scenarioCount: 25 }
    })).execution, { label, animated: true }, currentAtomicStep);
  }
});

test('execution footer remains active until pause completes and then stops its animation', () => {
  assert.deepEqual(buildClassTaskCardView(snapshot('PAUSE_REQUESTED', {
    currentAtomicStep: 'MODEL_REPAIR'
  })).execution, { label: '正在暂停 · 等待当前步骤结束', animated: true });
  assert.deepEqual(buildClassTaskCardView(snapshot('PAUSED', {
    currentAtomicStep: 'MODEL_REPAIR'
  })).execution, { label: '已暂停 · 修复单元测试', animated: false });
  assert.deepEqual(buildClassTaskCardView(snapshot('PAUSED')).execution, {
    label: '已暂停', animated: false
  });
  assert.deepEqual(buildClassTaskCardView(snapshot('RUNNING', {
    currentAtomicStep: 'MODEL_REPAIR'
  })).execution, { label: '正在修复单元测试', animated: true });
});

test('terminal and waiting cards never display a stale execution footer', () => {
  for (const state of ['READY', 'COMPLETED', 'TERMINATED', 'INTERRUPTED', 'FAILED', 'PRELOAD_FAILED']) {
    assert.equal(buildClassTaskCardView(snapshot(state, {
      currentAtomicStep: 'MODEL_GENERATION'
    })).execution, null, state);
  }
  assert.deepEqual(buildClassTaskCardView(snapshot('STOPPING')).execution, {
    label: '正在终止任务', animated: true
  });
});

test('preload footer distinguishes waiting for preload from active preparation', () => {
  assert.deepEqual(buildClassTaskCardView(snapshot('PRELOADING')).execution, {
    label: '正在预加载构建与覆盖信息', animated: true
  });
  assert.equal(buildClassTaskCardView(snapshot('PRELOADING', { preloadState: 'IDLE' })).execution, null);
});

function snapshot(state, overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceRoot: 'D:\\work',
    sourceFilePath: 'D:\\work\\src\\main\\java\\example\\TaskService.java',
    qualifiedClassName: 'example.TaskService',
    moduleKey: 'module-a',
    moduleDisplayPath: 'module-a',
    state,
    preloadState: state === 'PRELOADING' ? 'RUNNING' : state === 'PRELOAD_FAILED' ? 'FAILED' : 'READY',
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: [],
    coveredMethodIds: [],
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
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  };
}

function artifact() {
  return {
    id: 'artifact-1',
    filePath: 'D:\\work\\src\\test\\java\\example\\TaskService1Test.java',
    testClassName: 'TaskService1Test',
    ordinaryTestMethodCount: 4,
    methodIds: ['method-1'],
    sha256: 'a'.repeat(64),
    sealed: false,
    accepted: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
}

function coverage(lineCovered) {
  return {
    lineCovered,
    lineMissed: 1 - lineCovered,
    lineTotal: 1,
    branchCovered: 0,
    branchMissed: 0,
    branchTotal: 0
  };
}
