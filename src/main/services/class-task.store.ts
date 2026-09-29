import { resolve } from 'node:path';

import type { ClassTaskSnapshot } from '../../shared/class-task-contracts.ts';
import { AtomicJsonStore } from './atomic-json-store.ts';
import { validateClassTaskSnapshot } from './class-task-ipc-validation.ts';
import { sanitizePublicText } from './maven-command.ts';

const MAX_TASKS = 5;
const INTERRUPT_ON_STARTUP_STATES = new Set([
  'RUNNING', 'PAUSE_REQUESTED', 'STOPPING'
]);

export type ClassTaskStoreFile = {
  version: 3;
  tasks: Record<string, ClassTaskSnapshot>;
};

type ClassTaskStoreUpdater = (
  value: ClassTaskStoreFile
) => ClassTaskStoreFile | void | Promise<ClassTaskStoreFile | void>;

export class ClassTaskStore {
  private readonly store: AtomicJsonStore<ClassTaskStoreFile>;
  private readonly clock: () => Date;
  private migrationPending = false;

  constructor(storagePath: string, clock: () => Date = () => new Date()) {
    this.clock = clock;
    this.store = new AtomicJsonStore(
      storagePath,
      (value) => validateClassTaskStoreFile(value, true, () => {
        this.migrationPending = true;
      }),
      () => ({ version: 3, tasks: {} })
    );
  }

  async load(): Promise<ClassTaskStoreFile> {
    const loaded = await this.store.read();
    if (this.migrationPending) {
      this.migrationPending = false;
      await this.store.write(loaded);
      this.migrationPending = false;
    }
    return loaded;
  }

  async save(value: ClassTaskStoreFile): Promise<ClassTaskStoreFile> {
    const validated = validateClassTaskStoreFile(value, false);
    await this.store.write(validated);
    return validated;
  }

  async update(updater: ClassTaskStoreUpdater): Promise<ClassTaskStoreFile> {
    return this.store.update(async (current) => {
      const result = await updater(current);
      return validateClassTaskStoreFile(result ?? current, false);
    });
  }

  async loadForStartup(): Promise<ClassTaskStoreFile> {
    const now = this.clock().toISOString();
    return this.update((current) => ({
      version: 3,
      tasks: Object.fromEntries(Object.entries(current.tasks).map(([key, task]) => {
        const selectedTask = task.selectionMode === 'ALL_BY_DEFAULT'
          ? {
              ...task,
              selectionMode: 'EXPLICIT' as const,
              selectedMethodIds: [],
              methodOrder: []
            }
          : task;
        if (
          selectedTask.state === 'COMPLETED'
          && selectedTask.generatedArtifacts.length === 0
          && selectedTask.completionAttentionPending
        ) {
          return [key, {
            ...selectedTask,
            state: 'FAILED' as const,
            currentAtomicStep: 'IDLE' as const,
            activeGenerationBatch: null,
            completionAttentionPending: false,
            lastError: {
              code: 'NO_FORMAL_TEST_FILE_GENERATED',
              message: '未生成任何正式测试文件。请查看生成日志中的失败详情。',
              moduleName: selectedTask.qualifiedClassName,
              modulePath: selectedTask.moduleDisplayPath,
              command: null,
              occurredAt: now
            },
            updatedAt: now
          }];
        }
        if (
          selectedTask.state === 'PRELOADING'
          || (selectedTask.state === 'INTERRUPTED' && selectedTask.preloadState === 'IDLE')
        ) {
          return [key, {
            ...selectedTask,
            state: 'PRELOADING' as const,
            preloadState: 'IDLE' as const,
            currentAtomicStep: 'IDLE' as const,
            activeGenerationBatch: null,
            startedAt: null,
            pausedAt: null,
            finishedAt: null,
            lastError: null,
            completionAttentionPending: false,
            updatedAt: now
          }];
        }
        if (!INTERRUPT_ON_STARTUP_STATES.has(selectedTask.state)) return [key, selectedTask];
        return [key, {
          ...selectedTask,
          state: 'INTERRUPTED' as const,
          currentAtomicStep: 'IDLE' as const,
          activeGenerationBatch: null,
          pausedAt: null,
          finishedAt: now,
          completionAttentionPending: false,
          updatedAt: now
        }];
      }))
    }));
  }

  async flush(): Promise<void> {
    await this.store.read();
  }
}

function validateClassTaskStoreFile(
  value: unknown,
  allowLegacyVersion: boolean,
  onMigration?: () => void
): ClassTaskStoreFile {
  const record = requirePlainRecord(value, 'class-task store');
  requireExactFields(record, ['version', 'tasks'], 'class-task store');
  if (record.version !== 3 && (!allowLegacyVersion || record.version !== 2)) {
    throw new TypeError('class-task store version must be 3.');
  }
  const version = record.version as 2 | 3;
  if (version === 2) onMigration?.();
  const rawTasks = requirePlainRecord(record.tasks, 'class-task store tasks');
  const entries = Object.entries(rawTasks);
  const validatedEntries = entries.map(([key, task]) => {
    const validatedKey = requireTaskKey(key);
    const migratedTask = migrateStoredTask(task, version);
    if (migratedTask !== task) onMigration?.();
    const validatedTask = validateClassTaskSnapshot(sanitizeSnapshotError(migratedTask));
    if (validatedKey !== validatedTask.id) {
      throw new TypeError('class-task store key must match snapshot id.');
    }
    return [validatedKey, validatedTask] as const;
  });
  const workspaceCounts = new Map<string, number>();
  for (const [, task] of validatedEntries) {
    const workspaceKey = normalizeWorkspaceKey(task.workspaceRoot);
    const count = (workspaceCounts.get(workspaceKey) ?? 0) + 1;
    if (count > MAX_TASKS) {
      throw new TypeError(`class-task store supports a maximum ${MAX_TASKS} tasks per workspace.`);
    }
    workspaceCounts.set(workspaceKey, count);
  }
  return {
    version: 3,
    tasks: Object.fromEntries(validatedEntries)
  };
}

function migrateStoredTask(value: unknown, version: 2 | 3): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const task = value as Record<string, unknown>;
  const migratedTokenUsage = migrateStoredTokenUsage(task.tokenUsage);
  const needsMigration = version === 2
    || !('repairAttemptLimit' in task)
    || !('unlimitedRepair' in task)
    || !('coveredMethodIds' in task)
    || !('activeGenerationBatch' in task)
    || !('tokenUsage' in task)
    || migratedTokenUsage !== task.tokenUsage
    || !('modelCallCount' in task)
    || !('usageReportedCallCount' in task)
    || !('pausedAt' in task);
  if (!needsMigration) return value;
  return {
    ...task,
    ...(version === 2 ? { ragEnabled: false } : {}),
    ...(!('repairAttemptLimit' in task) ? { repairAttemptLimit: null } : {}),
    ...(!('unlimitedRepair' in task) ? { unlimitedRepair: false } : {}),
    ...(!('coveredMethodIds' in task) ? { coveredMethodIds: [] } : {}),
    ...(!('activeGenerationBatch' in task) ? { activeGenerationBatch: null } : {}),
    ...(!('tokenUsage' in task)
      ? { tokenUsage: null }
      : { tokenUsage: migratedTokenUsage }),
    ...(!('modelCallCount' in task) ? { modelCallCount: null } : {}),
    ...(!('usageReportedCallCount' in task) ? { usageReportedCallCount: null } : {}),
    ...(!('pausedAt' in task)
      ? { pausedAt: task.state === 'PAUSED' ? legacyPauseBoundary(task) : null }
      : {})
  };
}

function migrateStoredTokenUsage(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const usage = value as Record<string, unknown>;
  if (!('uncachedInputTokens' in usage)) {
    return value;
  }
  const migrated = { ...usage };
  delete migrated.uncachedInputTokens;
  return migrated;
}

function legacyPauseBoundary(task: Record<string, unknown>): unknown {
  if (typeof task.updatedAt !== 'string') return task.updatedAt;
  if (typeof task.startedAt !== 'string') return task.updatedAt;
  const updatedMs = Date.parse(task.updatedAt);
  const startedMs = Date.parse(task.startedAt);
  return Number.isFinite(updatedMs) && Number.isFinite(startedMs) && updatedMs < startedMs
    ? task.startedAt
    : task.updatedAt;
}

function sanitizeSnapshotError(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  if (!snapshot.lastError || typeof snapshot.lastError !== 'object' || Array.isArray(snapshot.lastError)) {
    return value;
  }
  const error = snapshot.lastError as Record<string, unknown>;
  return {
    ...snapshot,
    lastError: {
      ...error,
      code: typeof error.code === 'string' ? sanitizePublicText(error.code) : error.code,
      message: typeof error.message === 'string' ? sanitizePublicText(error.message) : error.message,
      command: typeof error.command === 'string' ? sanitizePublicText(error.command) : error.command,
      moduleName: typeof error.moduleName === 'string' ? sanitizePublicText(error.moduleName) : error.moduleName
    }
  };
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`${label} contains unknown field: ${unknown}`);
  const missing = allowedFields.find((key) => !(key in record));
  if (missing) throw new TypeError(`${label} is missing field: ${missing}`);
}

function normalizeWorkspaceKey(value: string): string {
  const normalized = resolve(value).split(/[\\/]/).join('/');
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function requireTaskKey(value: string): string {
  if (!value || value.length > 1_024) throw new TypeError('class-task store key is invalid.');
  return value;
}
