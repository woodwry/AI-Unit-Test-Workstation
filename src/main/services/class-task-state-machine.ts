import type {
  ClassMethodCatalog,
  ClassTaskSnapshot,
  ClassTaskState,
  PublicTaskError,
  PublicTaskNotice
} from '../../shared/class-task-contracts.ts';

export const LEGAL_CLASS_TASK_TRANSITIONS: Record<ClassTaskState, readonly ClassTaskState[]> = {
  PRELOADING: ['READY', 'PRELOAD_FAILED', 'INTERRUPTED'],
  PRELOAD_FAILED: ['PRELOADING'],
  READY: ['RUNNING', 'PRELOADING'],
  RUNNING: ['PAUSE_REQUESTED', 'STOPPING', 'COMPLETED', 'FAILED', 'INTERRUPTED'],
  PAUSE_REQUESTED: ['PAUSED', 'STOPPING', 'FAILED', 'INTERRUPTED'],
  PAUSED: ['RUNNING', 'STOPPING'],
  STOPPING: ['TERMINATED', 'FAILED'],
  TERMINATED: ['RUNNING', 'PRELOADING'],
  COMPLETED: ['RUNNING', 'PRELOADING'],
  INTERRUPTED: ['RUNNING', 'PRELOADING'],
  FAILED: ['RUNNING', 'PRELOADING']
};

export type TransitionClassTaskOptions = {
  now?: string;
  error?: PublicTaskError | null;
};

export function transitionClassTask(
  snapshot: ClassTaskSnapshot,
  nextState: ClassTaskState,
  options: TransitionClassTaskOptions = {}
): ClassTaskSnapshot {
  if (!LEGAL_CLASS_TASK_TRANSITIONS[snapshot.state].includes(nextState)) {
    throw new Error(`Illegal class-task transition: ${snapshot.state} -> ${nextState}`);
  }

  const now = options.now ?? new Date().toISOString();
  const next: ClassTaskSnapshot = {
    ...structuredClone(snapshot),
    state: nextState,
    updatedAt: now
  };

  if (snapshot.state === 'PAUSED' && (nextState === 'RUNNING' || nextState === 'STOPPING')) {
    next.startedAt = startedAtAfterPause(snapshot, now);
    next.pausedAt = null;
  }

  if (nextState === 'PRELOADING') {
    next.preloadState = 'RUNNING';
    next.currentAtomicStep = 'IDLE';
    next.activeGenerationBatch = null;
    next.currentMethodIndex = -1;
    next.startedAt = null;
    next.pausedAt = null;
    next.finishedAt = null;
    next.lastError = null;
    next.completionAttentionPending = false;
  } else if (nextState === 'PRELOAD_FAILED') {
    next.preloadState = 'FAILED';
    next.currentAtomicStep = 'IDLE';
    next.activeGenerationBatch = null;
    if (options.error !== undefined) next.lastError = structuredClone(options.error);
  } else if (nextState === 'READY') {
    next.preloadState = 'READY';
    next.currentAtomicStep = 'IDLE';
    next.activeGenerationBatch = null;
    next.lastError = null;
  } else if (nextState === 'RUNNING') {
    next.activeGenerationBatch = null;
    if (snapshot.state !== 'PAUSED') {
      next.startedAt = now;
    }
    next.pausedAt = null;
    next.finishedAt = null;
    next.lastError = null;
    next.completionAttentionPending = false;
  } else if (nextState === 'PAUSED') {
    next.currentAtomicStep = 'IDLE';
    next.activeGenerationBatch = null;
    next.pausedAt = now;
    if (options.error !== undefined) next.lastError = structuredClone(options.error);
  } else if (isFinishedState(nextState)) {
    next.pausedAt = null;
    next.finishedAt = now;
    next.currentAtomicStep = 'IDLE';
    next.activeGenerationBatch = null;
    if (nextState !== 'TERMINATED') next.currentMethodIndex = -1;
    next.completionAttentionPending = nextState === 'COMPLETED' || nextState === 'TERMINATED';
    if (options.error !== undefined) next.lastError = structuredClone(options.error);
  }

  return next;
}

function startedAtAfterPause(
  snapshot: Pick<ClassTaskSnapshot, 'startedAt' | 'pausedAt'>,
  resumedAt: string
): string | null {
  if (!snapshot.startedAt || !snapshot.pausedAt) return snapshot.startedAt;
  const startedMs = Date.parse(snapshot.startedAt);
  const pausedMs = Date.parse(snapshot.pausedAt);
  const resumedMs = Date.parse(resumedAt);
  if (
    !Number.isFinite(startedMs)
    || !Number.isFinite(pausedMs)
    || !Number.isFinite(resumedMs)
    || pausedMs < startedMs
    || resumedMs < pausedMs
  ) {
    return snapshot.startedAt;
  }
  return new Date(startedMs + resumedMs - pausedMs).toISOString();
}

export function resolveExecutionOrder(
  task: ClassTaskSnapshot,
  catalog: ClassMethodCatalog
): string[] {
  requireMatchingCatalog(task, catalog);
  const generatable = new Set(
    catalog.methods.filter((method) => method.generatable).map((method) => method.methodId)
  );
  if (task.selectionMode === 'ALL_BY_DEFAULT') {
    throw new Error('Explicit selection requires at least one method（请先选择至少一个方法）。');
  }
  if (task.methodOrder.length === 0) {
    throw new Error('Explicit selection requires at least one method（至少选择一个方法）。');
  }
  const order = task.methodOrder.filter((methodId) => generatable.has(methodId));
  if (order.length === 0) {
    throw new Error('Explicit selection requires at least one currently generatable method（至少选择一个方法）。');
  }
  return order;
}

export type SelectionReconciliation = {
  task: ClassTaskSnapshot;
  notices: PublicTaskNotice[];
};

export function reconcileSelectionWithCatalog(
  task: ClassTaskSnapshot,
  catalog: ClassMethodCatalog
): SelectionReconciliation {
  requireMatchingCatalog(task, catalog);
  const next = structuredClone(task);
  if (task.selectionMode !== 'EXPLICIT') return { task: next, notices: [] };

  const available = new Set(catalog.methods.map((method) => method.methodId));
  const retained = task.methodOrder.filter((methodId) => available.has(methodId));
  const removed = task.methodOrder.filter((methodId) => !available.has(methodId));
  next.methodOrder = retained;
  next.selectedMethodIds = [...retained];
  if (removed.length === 0) return { task: next, notices: [] };

  return {
    task: next,
    notices: [{
      code: 'STALE_METHOD_SELECTION_REMOVED',
      message: `Removed methods no longer present in the refreshed catalog: ${removed.join(', ')}`
    }]
  };
}

function requireMatchingCatalog(task: ClassTaskSnapshot, catalog: ClassMethodCatalog): void {
  if (catalog.taskId !== task.id) {
    throw new Error(`Method catalog belongs to another task: ${catalog.taskId}`);
  }
}

function isFinishedState(state: ClassTaskState): boolean {
  return state === 'TERMINATED'
    || state === 'COMPLETED'
    || state === 'INTERRUPTED'
    || state === 'FAILED';
}
