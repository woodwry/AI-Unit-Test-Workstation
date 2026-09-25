import type { ClassTaskSnapshot } from '../../../shared/class-task-contracts';

export function describeClassTaskRunAllOutcome(
  requestedCount: number,
  snapshots: readonly Pick<ClassTaskSnapshot, 'state'>[]
): string {
  if (requestedCount > 0 && snapshots.length === 0) {
    return '批量任务未启动，请重启工作站后重试。';
  }

  const failedCount = snapshots.filter((snapshot) =>
    snapshot.state === 'FAILED' || snapshot.state === 'PRELOAD_FAILED'
  ).length;
  if (failedCount > 0) {
    return `批量任务已结束：${failedCount} 个执行失败。`;
  }

  const completedCount = snapshots.filter((snapshot) => snapshot.state === 'COMPLETED').length;
  if (completedCount > 0) {
    return `批量任务已结束：${completedCount} 个执行完成。`;
  }

  return `批量任务已结束：已返回 ${snapshots.length}/${requestedCount} 个任务结果。`;
}

export type ReconcileClassTaskCommandStartOptions = {
  workspaceRoot: string;
  taskId: string;
  initialSnapshot: ClassTaskSnapshot;
  signal: AbortSignal;
  listClassTasks(): Promise<ClassTaskSnapshot[]>;
  onSnapshot(snapshot: ClassTaskSnapshot): void;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMilliseconds?: number;
  maxAttempts?: number;
};

export async function reconcileClassTaskCommandStart(
  options: ReconcileClassTaskCommandStartOptions
): Promise<ClassTaskSnapshot | null> {
  const maxAttempts = options.maxAttempts ?? 40;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 100;
  const wait = options.wait ?? delay;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal.aborted) return null;
    try {
      const snapshots = await options.listClassTasks();
      const snapshot = snapshots.find((candidate) =>
        candidate.id === options.taskId
        && sameWorkspaceRoot(candidate.workspaceRoot, options.workspaceRoot)
      );
      if (snapshot && hasCommandStarted(options.initialSnapshot, snapshot)) {
        options.onSnapshot(snapshot);
        return snapshot;
      }
    } catch {
      // Snapshot broadcasts remain the primary path; polling is best-effort only.
    }
    if (attempt + 1 < maxAttempts) {
      await wait(pollIntervalMilliseconds);
    }
  }
  return null;
}

function hasCommandStarted(
  initialSnapshot: ClassTaskSnapshot,
  currentSnapshot: ClassTaskSnapshot
): boolean {
  return currentSnapshot.updatedAt !== initialSnapshot.updatedAt
    || currentSnapshot.state !== initialSnapshot.state
    || currentSnapshot.currentAtomicStep !== initialSnapshot.currentAtomicStep;
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
