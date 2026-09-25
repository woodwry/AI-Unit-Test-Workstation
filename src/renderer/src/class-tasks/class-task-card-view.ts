import {
  hasPendingClassTaskResult,
  type ClassTaskAtomicStep,
  type ClassTaskSnapshot,
  type ClassTaskState,
  type PublicTaskError
} from '../../../shared/class-task-contracts.ts';

export type ClassTaskCardAction =
  | 'run'
  | 'result'
  | 'spinner'
  | 'pause'
  | 'resume'
  | 'terminate'
  | 'locate'
  | 'configure'
  | 'retry_preload'
  | 'stop_preload'
  | 'delete';

export type ClassTaskCardIntent =
  | { kind: 'show_empty_result_hint'; taskId: string }
  | { kind: 'show_method_selection_hint'; taskId: string }
  | { kind: 'open_result'; taskId: string }
  | { kind: 'locate_source'; taskId: string }
  | { kind: 'open_configuration'; taskId: string }
  | { kind: 'run'; taskId: string }
  | { kind: 'pause'; taskId: string }
  | { kind: 'resume'; taskId: string }
  | { kind: 'terminate'; taskId: string }
  | { kind: 'retry_preload'; taskId: string }
  | { kind: 'stop_preload'; taskId: string }
  | { kind: 'delete'; taskId: string }
  | { kind: 'none'; taskId: string };

export type ClassTaskCardErrorView = {
  moduleName: string;
  modulePath: string;
  command: string;
  message: string;
};

export type ClassTaskCardView = {
  className: string;
  fileName: string;
  statusLabel: string;
  statusTone: 'neutral' | 'active' | 'success' | 'danger' | 'warning';
  elapsedTimeLabel: string | null;
  execution: { label: string; animated: boolean } | null;
  methodProgress: {
    completed: number;
    total: number;
    tone: 'active' | 'paused' | 'neutral';
    showBar: boolean;
    countLabel: string;
    label: string;
    activeBatch?: {
      methodCount: number;
      scenarioCount?: number;
      start: number;
      end: number;
    };
  } | null;
  testFileCount: number;
  testMethodCount: number;
  needsAttention: boolean;
  error: ClassTaskCardErrorView | null;
};

export type ClassTaskTotalControl =
  | { kind: 'run'; eligibleCount: number }
  | { kind: 'terminate'; activeCount: number }
  | { kind: 'idle' };

export type ClassTaskCommandDispatchState = {
  busyTaskIds: ReadonlySet<string>;
  totalPendingTaskIds: ReadonlySet<string>;
};

export type ReleasedClassTaskCommandDispatch = ClassTaskCommandDispatchState & {
  totalCommandBusy: boolean;
};

const RUN_ALL_ELIGIBLE_STATES = new Set<ClassTaskState>([
  'READY', 'COMPLETED', 'TERMINATED', 'INTERRUPTED', 'FAILED', 'PAUSED'
]);
const ACTIVE_STATES = new Set<ClassTaskState>([
  'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'
]);
const METHOD_PROGRESS_STATES = new Set<ClassTaskState>([
  'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING', 'TERMINATED'
]);
const EMPTY_BUSY_TASK_IDS: ReadonlySet<string> = new Set();
export function resolveClassTaskDeleteRequest(
  task: Pick<ClassTaskSnapshot, 'id' | 'state' | 'preloadState' | 'generatedArtifacts'>
): Extract<ClassTaskCardIntent, { kind: 'delete' }> | { kind: 'confirm_delete'; taskId: string } {
  const requiresConfirmation = task.state === 'RUNNING'
    || task.state === 'PAUSE_REQUESTED'
    || task.state === 'PAUSED'
    || task.state === 'INTERRUPTED'
    || hasPendingClassTaskResult(task);
  return requiresConfirmation
    ? { kind: 'confirm_delete', taskId: task.id }
    : { kind: 'delete', taskId: task.id };
}

export function describeClassTaskDeleteConfirmation(
  task: Pick<ClassTaskSnapshot, 'sourceFilePath' | 'state' | 'preloadState'>
): { title: string; message: string; confirmLabel: string } {
  const fileName = task.sourceFilePath.split(/[\\/]/).pop() ?? task.sourceFilePath;
  if (task.state === 'PRELOADING' && task.preloadState === 'RUNNING') {
    return {
      title: '停止预加载并删除？',
      message: `${fileName} 正在预加载。删除会先停止当前检测，再移除该任务。`,
      confirmLabel: '停止并删除'
    };
  }
  if (ACTIVE_STATES.has(task.state)) {
    return {
      title: '终止任务并删除？',
      message: `${fileName} 正在执行。删除会先终止当前任务，再移除该任务及其未接受的生成结果。`,
      confirmLabel: '终止并删除'
    };
  }
  return {
    title: '删除任务？',
    message: `${fileName} 将从任务列表中移除，未接受的生成结果也会一并删除。`,
    confirmLabel: '删除'
  };
}

export function actionsForClassTask(
  task: Pick<ClassTaskSnapshot, 'state' | 'preloadState' | 'generatedArtifacts'>
): ClassTaskCardAction[] {
  switch (task.state) {
    case 'PRELOADING':
      return task.preloadState === 'RUNNING'
        ? ['locate', 'spinner', 'stop_preload', 'delete']
        : ['locate', 'retry_preload', 'delete'];
    case 'PRELOAD_FAILED':
      return ['locate', 'retry_preload', 'delete'];
    case 'READY':
    case 'INTERRUPTED':
    case 'FAILED':
      return ['run', 'locate', 'configure', 'delete'];
    case 'COMPLETED':
    case 'TERMINATED':
      return [
        hasPendingClassTaskResult(task) ? 'result' : 'run',
        'locate',
        'configure',
        'delete'
      ];
    case 'RUNNING':
      return ['spinner', 'pause', 'terminate', 'locate', 'configure', 'delete'];
    case 'PAUSE_REQUESTED':
      return ['spinner', 'terminate', 'locate', 'configure', 'delete'];
    case 'PAUSED':
      return ['resume', 'terminate', 'locate', 'configure', 'delete'];
    case 'STOPPING':
      return ['spinner', 'locate', 'configure', 'delete'];
  }
}

export function resolveClassTaskCardClick(task: ClassTaskSnapshot): ClassTaskCardIntent {
  const hasRevokedCompletedResult = (
    task.state === 'COMPLETED' || task.state === 'TERMINATED'
  )
    && task.coverageBaseline !== null
    && task.coverageCurrent !== null;
  return task.generatedArtifacts.length > 0 || hasRevokedCompletedResult
    ? { kind: 'open_result', taskId: task.id }
    : { kind: 'show_empty_result_hint', taskId: task.id };
}

export function resolveClassTaskIconClick(
  task: ClassTaskSnapshot,
  action: ClassTaskCardAction
): ClassTaskCardIntent {
  switch (action) {
    case 'locate':
      return { kind: 'locate_source', taskId: task.id };
    case 'configure':
      return { kind: 'open_configuration', taskId: task.id };
    case 'result':
      return { kind: 'open_result', taskId: task.id };
    case 'run':
      if (hasPendingClassTaskResult(task)) return { kind: 'none', taskId: task.id };
      return requiresClassTaskMethodSelection(task)
        ? { kind: 'show_method_selection_hint', taskId: task.id }
        : { kind: 'run', taskId: task.id };
    case 'pause':
      return { kind: 'pause', taskId: task.id };
    case 'resume':
      return { kind: 'resume', taskId: task.id };
    case 'terminate':
      return { kind: 'terminate', taskId: task.id };
    case 'retry_preload':
      return { kind: 'retry_preload', taskId: task.id };
    case 'stop_preload':
      return { kind: 'stop_preload', taskId: task.id };
    case 'delete':
      return { kind: 'delete', taskId: task.id };
    case 'spinner':
      return { kind: 'none', taskId: task.id };
  }
}

export function requiresClassTaskMethodSelection(
  task: Pick<
    ClassTaskSnapshot,
    'selectionMode' | 'selectedMethodIds' | 'repairAttemptLimit' | 'unlimitedRepair'
  >
): boolean {
  return task.selectionMode !== 'EXPLICIT'
    || task.selectedMethodIds.length === 0
    || (!task.unlimitedRepair && task.repairAttemptLimit === null);
}

export function resolveClassTaskTotalControl(
  tasks: readonly Pick<
    ClassTaskSnapshot,
    | 'id'
    | 'state'
    | 'selectionMode'
    | 'selectedMethodIds'
    | 'repairAttemptLimit'
    | 'unlimitedRepair'
    | 'generatedArtifacts'
  >[],
  busyTaskIds: ReadonlySet<string> = EMPTY_BUSY_TASK_IDS
): ClassTaskTotalControl {
  const eligibleCount = classTaskTotalRunEligibleIds(tasks, busyTaskIds).length;
  if (eligibleCount > 0) {
    return { kind: 'run', eligibleCount };
  }

  const activeCount = tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;
  return activeCount > 0 ? { kind: 'terminate', activeCount } : { kind: 'idle' };
}

export function classTaskTotalRunEligibleIds(
  tasks: readonly Pick<
    ClassTaskSnapshot,
    | 'id'
    | 'state'
    | 'selectionMode'
    | 'selectedMethodIds'
    | 'repairAttemptLimit'
    | 'unlimitedRepair'
    | 'generatedArtifacts'
  >[],
  busyTaskIds: ReadonlySet<string> = EMPTY_BUSY_TASK_IDS
): string[] {
  return tasks
    .filter((task) => isClassTaskTotalRunEligible(task, busyTaskIds.has(task.id)))
    .map((task) => task.id);
}

export function isClassTaskTotalRunEligible(
  task: Pick<
    ClassTaskSnapshot,
    | 'state'
    | 'selectionMode'
    | 'selectedMethodIds'
    | 'repairAttemptLimit'
    | 'unlimitedRepair'
    | 'generatedArtifacts'
  >,
  commandBusy = false
): boolean {
  return !commandBusy
    && RUN_ALL_ELIGIBLE_STATES.has(task.state)
    && !hasPendingClassTaskResult(task)
    && !requiresClassTaskMethodSelection(task);
}

export function releaseClassTaskCommandDispatch(
  state: ClassTaskCommandDispatchState,
  taskId: string
): ReleasedClassTaskCommandDispatch {
  const busyTaskIds = new Set(state.busyTaskIds);
  const totalPendingTaskIds = new Set(state.totalPendingTaskIds);
  busyTaskIds.delete(taskId);
  totalPendingTaskIds.delete(taskId);
  return {
    busyTaskIds,
    totalPendingTaskIds,
    totalCommandBusy: totalPendingTaskIds.size > 0
  };
}

export function buildClassTaskCardView(
  task: ClassTaskSnapshot,
  attentionAcknowledged = false,
  nowMs = Date.now()
): ClassTaskCardView {
  const status = statusFor(task);
  const methodProgress = methodProgressFor(task);
  const error = task.state === 'PRELOAD_FAILED'
    ? preloadErrorView(task.lastError, task)
    : task.state === 'FAILED'
      ? executionErrorView(task.lastError, task)
      : null;
  const pendingArtifacts = task.generatedArtifacts.filter((artifact) => !artifact.accepted);

  return {
    className: task.qualifiedClassName.split('.').pop() ?? task.qualifiedClassName,
    fileName: task.sourceFilePath.split(/[\\/]/).pop() ?? task.sourceFilePath,
    statusLabel: status.label,
    statusTone: status.tone,
    elapsedTimeLabel: elapsedTimeLabelFor(task, nowMs),
    execution: executionFor(task),
    methodProgress,
    testFileCount: pendingArtifacts.length,
    testMethodCount: pendingArtifacts.reduce(
      (sum, artifact) => sum + artifact.ordinaryTestMethodCount,
      0
    ),
    needsAttention:
      task.completionAttentionPending &&
      hasPendingClassTaskResult(task) &&
      !attentionAcknowledged,
    error
  };
}

const EXECUTION_STEP_LABELS: Record<ClassTaskAtomicStep, string> = {
  IDLE: '准备任务',
  ANALYZE_METHOD: '分析方法与准备上下文',
  MODEL_GENERATION: '生成单元测试',
  MODEL_REPAIR: '修复单元测试',
  CONFIRM_RESULT: '确认测试结果',
  WRITE_CANDIDATE: '写入候选测试代码',
  MAVEN_COMPILE: '执行 Maven 编译',
  MAVEN_TEST: '执行 Maven 测试验证',
  PRUNE_FAILED_TESTS: '进行稳定修复',
  MERGE_METHOD_BATCHES: '合并测试代码',
  PACK_FORMAL_FILE: '保存单元测试文件',
  JACOCO_REFRESH: '刷新 JaCoCo 覆盖率'
};

function executionFor(task: ClassTaskSnapshot): ClassTaskCardView['execution'] {
  if (task.state === 'PRELOADING') {
    return task.preloadState === 'RUNNING'
      ? { label: '正在预加载构建与覆盖信息', animated: true }
      : null;
  }
  if (task.state === 'PAUSE_REQUESTED') {
    return { label: '正在暂停 · 等待当前步骤结束', animated: true };
  }
  if (task.state === 'STOPPING') return { label: '正在终止任务', animated: true };
  if (task.state === 'PAUSED') {
    return {
      label: task.currentAtomicStep === 'IDLE'
        ? '已暂停'
        : `已暂停 · ${EXECUTION_STEP_LABELS[task.currentAtomicStep]}`,
      animated: false
    };
  }
  if (task.state !== 'RUNNING') return null;
  return { label: `正在${EXECUTION_STEP_LABELS[task.currentAtomicStep]}`, animated: true };
}

function methodProgressFor(
  task: Pick<
    ClassTaskSnapshot,
    | 'state'
    | 'methodOrder'
    | 'coveredMethodIds'
    | 'currentMethodIndex'
    | 'currentAtomicStep'
    | 'activeGenerationBatch'
    | 'generatedArtifacts'
    | 'coverageCurrent'
  >
): ClassTaskCardView['methodProgress'] {
  const total = task.methodOrder.length;
  if (!METHOD_PROGRESS_STATES.has(task.state) || total === 0) return null;

  const recordedCompleted = Math.max(0, Math.min(task.currentMethodIndex + 1, total));
  const coveredMethodIds = new Set(task.coveredMethodIds ?? []);
  const coverageCompleted = task.methodOrder.reduce(
    (count, methodId) => count + (coveredMethodIds.has(methodId) ? 1 : 0),
    0
  );
  const hasNoGeneratedResult = task.generatedArtifacts.length === 0
    && task.coverageCurrent !== null
    && task.coverageCurrent.lineCovered === 0
    && task.coverageCurrent.branchCovered === 0;
  const completed = task.state === 'TERMINATED' && hasNoGeneratedResult
    ? coverageCompleted
    : Math.max(recordedCompleted, coverageCompleted);
  const showBar = task.state === 'RUNNING'
    || task.state === 'PAUSE_REQUESTED'
    || task.state === 'PAUSED';
  const countLabel = `完成 ${completed}/${total}`;
  const explicitActiveEnd = task.activeGenerationBatch
    ? Math.min(total, completed + task.activeGenerationBatch.methodCount)
    : completed;
  const explicitActiveBatch = task.activeGenerationBatch && explicitActiveEnd > completed
    ? {
        methodCount: explicitActiveEnd - completed,
        scenarioCount: task.activeGenerationBatch.scenarioCount,
        start: completed,
        end: explicitActiveEnd
      }
    : null;
  const inferredSingleMethodBatch = !explicitActiveBatch
    && (task.state === 'RUNNING' || task.state === 'PAUSE_REQUESTED')
    && task.currentAtomicStep !== 'IDLE'
    && completed < total
    ? {
        methodCount: 1,
        start: completed,
        end: completed + 1
      }
    : null;
  const activeBatch = explicitActiveBatch ?? inferredSingleMethodBatch;
  return {
    completed,
    total,
    tone: task.state === 'RUNNING'
      ? 'active'
      : task.state === 'PAUSE_REQUESTED' || task.state === 'PAUSED'
        ? 'paused'
        : 'neutral',
    showBar,
    countLabel,
    label: activeBatch
      ? 'scenarioCount' in activeBatch
        ? `已完成 ${completed}/${total} 个方法；当前批次 ${activeBatch.methodCount} 个方法 / ${activeBatch.scenarioCount} 个场景`
        : `已完成 ${completed}/${total} 个方法；当前方法处理中`
      : `已完成 ${completed}/${total} 个方法`,
    ...(activeBatch ? { activeBatch } : {})
  };
}

function elapsedTimeLabelFor(
  task: Pick<ClassTaskSnapshot, 'state' | 'startedAt' | 'pausedAt' | 'finishedAt'>,
  nowMs: number
): string | null {
  if (!task.startedAt) return null;
  const startedMs = Date.parse(task.startedAt);
  const finishedMs = task.state === 'PAUSED'
    ? Date.parse(task.pausedAt ?? '')
    : task.finishedAt
      ? Date.parse(task.finishedAt)
      : ACTIVE_STATES.has(task.state)
        ? nowMs
        : Number.NaN;
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
    return null;
  }

  const elapsedSeconds = Math.floor((finishedMs - startedMs) / 1_000);
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function statusFor(task: Pick<ClassTaskSnapshot, 'state' | 'lastError'>): {
  label: string;
  tone: ClassTaskCardView['statusTone'];
} {
  switch (task.state) {
    case 'PRELOADING': return { label: '正在预加载', tone: 'active' };
    case 'PRELOAD_FAILED': {
      const kind = preloadFailureKind(task.lastError);
      return {
        label: kind === 'maven'
          ? 'Maven 执行失败'
          : kind === 'build'
            ? '构建环境异常'
            : '分析失败',
        tone: 'danger'
      };
    }
    case 'READY': return { label: '待执行', tone: 'neutral' };
    case 'RUNNING': return { label: '执行中', tone: 'active' };
    case 'PAUSE_REQUESTED': return { label: '正在暂停', tone: 'warning' };
    case 'PAUSED': return isModelFailure(task.lastError)
      ? { label: '模型不可用', tone: 'warning' }
      : { label: '已暂停', tone: 'warning' };
    case 'STOPPING': return { label: '正在终止', tone: 'warning' };
    case 'TERMINATED': return { label: '已终止', tone: 'danger' };
    case 'COMPLETED': return { label: '已完成', tone: 'success' };
    case 'INTERRUPTED': return { label: '已中断', tone: 'warning' };
    case 'FAILED': return { label: executionFailureStatusLabel(task.lastError), tone: 'danger' };
  }
}

function preloadErrorView(
  error: PublicTaskError | null,
  task: Pick<ClassTaskSnapshot, 'moduleDisplayPath'>
): ClassTaskCardErrorView {
  const kind = preloadFailureKind(error);
  const detail = error?.message?.trim() || (
    kind === 'maven'
      ? 'Maven 执行未成功。'
      : kind === 'build'
        ? '工作站构建环境不可用。'
        : '当前类分析未成功。'
  );
  const instruction = isDependencyContextFailure(error)
    ? '请重新检测以重新建立当前类的分析上下文'
    : kind === 'maven'
      ? '请修复该模块后重新检测'
      : kind === 'build'
        ? '请检查工作站构建环境后重新检测'
        : '请确认本地分析服务已启动且版本正确，然后重新检测';
  return {
    moduleName: error?.moduleName?.trim() || task.moduleDisplayPath,
    modulePath: error?.modulePath?.trim() || task.moduleDisplayPath,
    command: error?.command?.trim() || (kind === 'maven' ? '未提供 Maven 命令' : '无相关命令'),
    message: `${detail}\n${instruction}`
  };
}

function preloadFailureKind(error: PublicTaskError | null): 'maven' | 'build' | 'analysis' {
  const code = error?.code?.trim().toUpperCase() ?? '';
  if (code.includes('MAVEN') || code === 'MODULE_PRELOAD_FAILED') return 'maven';
  if (code.startsWith('BUILD_SETTINGS_')) return 'build';
  return 'analysis';
}

function isDependencyContextFailure(error: PublicTaskError | null): boolean {
  return `${error?.code ?? ''}\n${error?.message ?? ''}`
    .toUpperCase()
    .includes('DEPENDENCY_CONTEXT_CHANGED');
}

function executionErrorView(
  error: PublicTaskError | null,
  task: Pick<ClassTaskSnapshot, 'moduleDisplayPath'>
): ClassTaskCardErrorView {
  const quotaUnavailable = isModelQuotaUnavailable(error);
  const detail = quotaUnavailable
    ? '当前选择的模型不可用。'
    : error?.message?.trim() || '当前类的单元测试生成未成功。';
  const kind = executionFailureKind(error);
  const instruction = quotaUnavailable
    ? '请切换可用模型后重试'
    : kind === 'platform'
      ? '请检查大模型平台状态与接口地址后重试'
      : kind === 'model'
        ? '请检查模型名称、访问权限与接口配置后重试'
        : '请查看错误详情并修复后重试';
  return {
    moduleName: error?.moduleName?.trim() || task.moduleDisplayPath,
    modulePath: error?.modulePath?.trim() || task.moduleDisplayPath,
    command: error?.command?.trim() || '无相关命令',
    message: `${detail}\n${instruction}`
  };
}

function executionFailureStatusLabel(error: PublicTaskError | null): string {
  switch (executionFailureKind(error)) {
    case 'platform':
    case 'model': return '所选模型不可用';
    case 'other': return '执行失败';
  }
}

function executionFailureKind(
  error: PublicTaskError | null
): 'platform' | 'model' | 'other' {
  const failureCodes = executionFailureCodes(error);
  const message = error?.message?.trim().toLowerCase() ?? '';
  const platformCodes = new Set([
    'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_RATE_LIMITED', 'MODEL_QUOTA_EXHAUSTED',
    'MODEL_AUTHENTICATION_FAILED', 'MODEL_PERMISSION_DENIED'
  ]);
  if ([...failureCodes].some((failureCode) => platformCodes.has(failureCode))) {
    return 'platform';
  }
  const modelCodes = new Set([
    'MODEL_NOT_FOUND', 'MODEL_NAME_REQUIRED', 'MODEL_CAPABILITY_UNSUPPORTED',
    'MODEL_TOOL_CALLING_UNSUPPORTED'
  ]);
  if ([...failureCodes].some((failureCode) => modelCodes.has(failureCode))) {
    return 'model';
  }
  if (/平台.*(?:不可用|超时|频率限制)|身份验证失败|接口.*(?:不可用|不支持)|请求失败：(?:401|403|429|5\d\d)/i.test(message)) {
    return 'platform';
  }
  if (/(?:未找到|无权访问|不支持).{0,8}(?:所选)?模型|模型名称|模型.*(?:不存在|不可用)/i.test(message)) {
    return 'model';
  }
  return 'other';
}

function isModelQuotaUnavailable(error: PublicTaskError | null): boolean {
  return executionFailureCodes(error).has('MODEL_QUOTA_EXHAUSTED');
}

function isModelFailure(error: PublicTaskError | null): boolean {
  return [...executionFailureCodes(error)].some((code) => code.startsWith('MODEL_'));
}

function executionFailureCodes(error: PublicTaskError | null): Set<string> {
  const code = error?.code?.trim().toUpperCase() ?? '';
  const message = error?.message?.trim().toLowerCase() ?? '';
  return new Set([
    code,
    ...[...message.matchAll(/\b(MODEL_[A-Z0-9_]+)\s*:/gi)]
      .map((match) => match[1].toUpperCase())
  ]);
}
