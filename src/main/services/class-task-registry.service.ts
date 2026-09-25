import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';

import type {
  AddClassTasksRequest,
  ClassMethodCatalog,
  ClassTaskSnapshot,
  MethodSelectionMode,
  PublicTaskError,
  PublicTaskNotice
} from '../../shared/class-task-contracts.ts';
import {
  LEGAL_CLASS_TASK_TRANSITIONS,
  reconcileSelectionWithCatalog,
  transitionClassTask,
  type SelectionReconciliation
} from './class-task-state-machine.ts';
import {
  type ClassTaskStore,
  type ClassTaskStoreFile
} from './class-task.store.ts';
import {
  ModuleIdentityService,
  type ModuleIdentity
} from './module-identity.service.ts';
import type { ModulePreloadSnapshot } from './module-preload-cache.store.ts';

const MAX_TASKS = 5;
const MAX_TASK_ERROR_TEXT_LENGTH = 4_096;
const CONFIGURABLE_STATES = new Set<ClassTaskSnapshot['state']>([
  'READY', 'COMPLETED', 'TERMINATED', 'INTERRUPTED', 'FAILED'
]);

type IdentityResolver = Pick<ModuleIdentityService, 'resolve' | 'comparisonKey'>;

export type ClassTaskRegistryOptions = {
  store: ClassTaskStore;
  identityService?: IdentityResolver;
  clock?: () => Date;
  idFactory?: () => string;
  broadcast?: (snapshot: ClassTaskSnapshot) => void;
};

export type ClassTaskRegistryAddResult = {
  focusedTaskId: string | null;
  addedTaskIds: string[];
  snapshots: ClassTaskSnapshot[];
};

export class ClassTaskRegistryService {
  private readonly store: ClassTaskStore;
  private readonly identityService: IdentityResolver;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly broadcast?: (snapshot: ClassTaskSnapshot) => void;
  private tasks = new Map<string, ClassTaskSnapshot>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: ClassTaskRegistryOptions) {
    this.store = options.store;
    this.identityService = options.identityService ?? new ModuleIdentityService();
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.broadcast = options.broadcast;
  }

  async initialize(): Promise<ClassTaskSnapshot[]> {
    return this.enqueue(async () => {
      const restored = await this.store.loadForStartup();
      this.tasks = mapFromStore(restored);
      return this.list();
    });
  }

  async reload(): Promise<ClassTaskSnapshot[]> {
    return this.enqueue(async () => {
      const stored = await this.store.load();
      this.tasks = mapFromStore(stored);
      return this.list();
    });
  }

  async add(request: AddClassTasksRequest): Promise<ClassTaskRegistryAddResult> {
    const identities = await Promise.all(
      request.classFilePaths.map((path) => this.identityService.resolve(request.workspaceRoot, path))
    );
    return this.enqueue(async () => {
      const existingByPath = this.pathIndex(request.workspaceRoot);
      const uniqueNew = new Map<string, ModuleIdentity>();
      let focusedTaskId: string | null = null;

      for (const identity of identities) {
        const key = this.identityService.comparisonKey(identity.sourceFilePath);
        const existing = existingByPath.get(key);
        if (existing) {
          focusedTaskId ??= existing.id;
          continue;
        }
        if (!uniqueNew.has(key)) uniqueNew.set(key, identity);
      }

      if (this.list(request.workspaceRoot).length + uniqueNew.size > MAX_TASKS) {
        throw new Error(`Class-task registry supports a maximum 5 unique classes（最多 5 个）。`);
      }

      const next = new Map(this.tasks);
      const addedTaskIds: string[] = [];
      const now = this.clock().toISOString();
      for (const identity of uniqueNew.values()) {
        const task = createTaskSnapshot(identity, this.idFactory(), now);
        next.set(task.id, task);
        addedTaskIds.push(task.id);
        focusedTaskId ??= task.id;
      }
      if (addedTaskIds.length > 0) await this.persist(next, addedTaskIds);

      const resultIds = focusedTaskId
        ? [focusedTaskId, ...addedTaskIds.filter((id) => id !== focusedTaskId)]
        : addedTaskIds;
      return {
        focusedTaskId,
        addedTaskIds,
        snapshots: resultIds.map((id) => this.snapshot(id))
      };
    });
  }

  async remove(taskId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.tasks.has(taskId)) return;
      const next = new Map(this.tasks);
      next.delete(taskId);
      await this.persist(next, []);
    });
  }

  async reorder(
    workspaceRoot: string,
    taskIds: readonly string[]
  ): Promise<ClassTaskSnapshot[]> {
    return this.enqueue(async () => {
      const workspaceKey = this.identityService.comparisonKey(workspaceRoot);
      const currentTasks = [...this.tasks.values()].filter((task) => (
        this.identityService.comparisonKey(task.workspaceRoot) === workspaceKey
      ));
      const currentIds = currentTasks.map((task) => task.id);
      if (
        taskIds.length !== currentIds.length
        || new Set(taskIds).size !== taskIds.length
        || taskIds.some((taskId) => !currentIds.includes(taskId))
      ) {
        throw new Error('Class-task order must contain every task in the current workspace exactly once.');
      }
      if (taskIds.every((taskId, index) => taskId === currentIds[index])) {
        return currentTasks.map(detached);
      }

      const reorderedTasks = taskIds.map((taskId) => this.requireTask(taskId));
      let workspaceIndex = 0;
      const next = new Map<string, ClassTaskSnapshot>();
      for (const [taskId, task] of this.tasks) {
        if (this.identityService.comparisonKey(task.workspaceRoot) !== workspaceKey) {
          next.set(taskId, task);
          continue;
        }
        const replacement = reorderedTasks[workspaceIndex];
        workspaceIndex += 1;
        next.set(replacement.id, replacement);
      }
      await this.persist(next, []);
      return this.list(workspaceRoot);
    });
  }

  list(workspaceRoot?: string): ClassTaskSnapshot[] {
    const workspaceKey = workspaceRoot
      ? this.identityService.comparisonKey(workspaceRoot)
      : null;
    return [...this.tasks.values()]
      .filter((task) => !workspaceKey
        || this.identityService.comparisonKey(task.workspaceRoot) === workspaceKey)
      .map(detached);
  }

  snapshot(taskId: string): ClassTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown class task: ${taskId}`);
    return detached(task);
  }

  async applyModulePreloadSnapshot(
    moduleKey: string,
    moduleSnapshot: ModulePreloadSnapshot
  ): Promise<ClassTaskSnapshot[]> {
    if (this.identityService.comparisonKey(moduleKey)
      !== this.identityService.comparisonKey(moduleSnapshot.moduleKey)) {
      throw new Error('Module preload snapshot key does not match the requested module.');
    }
    return this.enqueue(async () => {
      const next = new Map(this.tasks);
      const changedIds: string[] = [];
      const now = this.clock().toISOString();
      const expectedModuleKey = this.identityService.comparisonKey(moduleKey);
      for (const [taskId, task] of next) {
        if (this.identityService.comparisonKey(task.moduleKey) !== expectedModuleKey) continue;
        const updated = taskFromModuleSnapshot(task, moduleSnapshot, now);
        if (!updated) continue;
        next.set(taskId, updated);
        changedIds.push(taskId);
      }
      if (changedIds.length > 0) await this.persist(next, changedIds);
      return changedIds.map((id) => this.snapshot(id));
    });
  }

  async applyClassPreloadFailure(
    taskId: string,
    error: PublicTaskError
  ): Promise<ClassTaskSnapshot> {
    return this.enqueue(async () => {
      const task = this.requireTask(taskId);
      const next = new Map(this.tasks);
      const now = this.clock().toISOString();
      const failed = transitionToClassFailure(task, error, now);
      if (!failed) throw new Error(`Class task cannot accept a preload failure while ${task.state}.`);
      next.set(taskId, failed);
      await this.persist(next, [taskId]);
      return this.snapshot(taskId);
    });
  }

  async saveSelection(
    taskId: string,
    selectionMode: MethodSelectionMode,
    selectedMethodIds: readonly string[],
    methodOrder: readonly string[],
    ragEnabled: boolean,
    repairAttemptLimit: number | null,
    unlimitedRepair: boolean
  ): Promise<ClassTaskSnapshot> {
    return this.enqueue(async () => {
      const task = applyMethodSelection(
        this.requireTask(taskId),
        selectionMode,
        selectedMethodIds,
        methodOrder,
        ragEnabled,
        repairAttemptLimit,
        unlimitedRepair,
        this.clock().toISOString()
      );
      const next = new Map(this.tasks);
      next.set(taskId, task);
      await this.persist(next, [taskId]);
      return this.snapshot(taskId);
    });
  }

  async reconcileCatalog(
    taskId: string,
    catalog: ClassMethodCatalog
  ): Promise<SelectionReconciliation> {
    return this.enqueue(async () => {
      const result = reconcileSelectionWithCatalog(this.requireTask(taskId), catalog);
      if (sameSelection(this.requireTask(taskId), result.task)) {
        return { task: detached(result.task), notices: detached(result.notices) };
      }
      const next = new Map(this.tasks);
      next.set(taskId, {
        ...result.task,
        updatedAt: this.clock().toISOString()
      });
      await this.persist(next, [taskId]);
      return { task: this.snapshot(taskId), notices: detached(result.notices) };
    });
  }

  private async persist(next: Map<string, ClassTaskSnapshot>, changedIds: string[]): Promise<void> {
    const saved = await this.store.save({
      version: 3,
      tasks: Object.fromEntries(next)
    });
    this.tasks = mapFromStore(saved);
    for (const taskId of changedIds) {
      const snapshot = this.tasks.get(taskId);
      if (!snapshot || !this.broadcast) continue;
      try {
        this.broadcast(detached(snapshot));
      } catch {
        // A renderer listener cannot roll back an already persisted main-process mutation.
      }
    }
  }

  private pathIndex(workspaceRoot?: string): Map<string, ClassTaskSnapshot> {
    const workspaceKey = workspaceRoot
      ? this.identityService.comparisonKey(workspaceRoot)
      : null;
    return new Map([...this.tasks.values()]
      .filter((task) => !workspaceKey
        || this.identityService.comparisonKey(task.workspaceRoot) === workspaceKey)
      .map((task) => [
        this.identityService.comparisonKey(task.sourceFilePath),
        task
      ]));
  }

  private requireTask(taskId: string): ClassTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown class task: ${taskId}`);
    return task;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

export function applyMethodSelection(
  task: ClassTaskSnapshot,
  selectionMode: MethodSelectionMode,
  selectedMethodIds: readonly string[],
  methodOrder: readonly string[],
  ragEnabled: boolean,
  repairAttemptLimit: number | null,
  unlimitedRepair: boolean,
  updatedAt: string
): ClassTaskSnapshot {
  if (!sameEntries(selectedMethodIds, methodOrder)) {
    throw new Error('selectedMethodIds and methodOrder must contain the same unique IDs.');
  }
  if (!CONFIGURABLE_STATES.has(task.state)) {
    throw new Error(`Cannot change method selection or RAG configuration while ${task.state}.`);
  }
  requireRepairConfiguration(repairAttemptLimit, unlimitedRepair);
  return {
    ...task,
    selectionMode,
    selectedMethodIds: [...selectedMethodIds],
    methodOrder: [...methodOrder],
    ragEnabled,
    repairAttemptLimit,
    unlimitedRepair,
    currentMethodIndex: -1,
    activeGenerationBatch: null,
    updatedAt
  };
}

function createTaskSnapshot(
  identity: ModuleIdentity,
  id: string,
  now: string
): ClassTaskSnapshot {
  return {
    id,
    workspaceRoot: identity.workspaceRoot,
    sourceFilePath: identity.sourceFilePath,
    qualifiedClassName: qualifiedClassName(identity.sourceFilePath),
    moduleKey: identity.moduleKey,
    moduleDisplayPath: identity.moduleDisplayPath,
    state: 'PRELOADING',
    preloadState: 'IDLE',
    ragEnabled: false,
    repairAttemptLimit: null,
    unlimitedRepair: false,
    selectionMode: 'EXPLICIT',
    selectedMethodIds: [],
    methodOrder: [],
    coveredMethodIds: [],
    currentMethodIndex: -1,
    currentAtomicStep: 'IDLE',
    activeGenerationBatch: null,
    tokenUsage: null,
    modelCallCount: 0,
    usageReportedCallCount: 0,
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: false,
    startedAt: null,
    pausedAt: null,
    finishedAt: null,
    lastError: null,
    updatedAt: now
  };
}

function taskFromModuleSnapshot(
  task: ClassTaskSnapshot,
  moduleSnapshot: ModulePreloadSnapshot,
  now: string
): ClassTaskSnapshot | null {
  if (moduleSnapshot.state === 'RUNNING') {
    if (task.state === 'PRELOADING') {
      return {
        ...task,
        preloadState: 'RUNNING',
        lastError: null,
        updatedAt: now
      };
    }
    return canTransition(task, 'PRELOADING')
      ? transitionClassTask(task, 'PRELOADING', { now })
      : null;
  }
  if (moduleSnapshot.state === 'READY') {
    const classFailure = moduleSnapshot.classPreloadFailures[task.qualifiedClassName];
    if (classFailure) {
      return transitionToClassFailure(task, {
        code: 'CLASS_PRELOAD_FAILED',
        message: classFailure.diagnostic,
        moduleName: moduleSnapshot.moduleName,
        modulePath: moduleSnapshot.modulePath,
        command: null,
        occurredAt: classFailure.updatedAt
      }, now);
    }
    if (task.state === 'PRELOADING') {
      return transitionClassTask(task, 'READY', { now });
    }
    if (task.state === 'PRELOAD_FAILED') {
      const retrying = transitionClassTask(task, 'PRELOADING', { now });
      return transitionClassTask(retrying, 'READY', { now });
    }
    if (task.state === 'READY' && (task.preloadState !== 'READY' || task.lastError !== null)) {
      return { ...task, preloadState: 'READY', lastError: null, updatedAt: now };
    }
    return null;
  }
  if (moduleSnapshot.state === 'FAILED') {
    const diagnostic = moduleSnapshot.diagnostic;
    const error: PublicTaskError = {
      code: 'MODULE_PRELOAD_FAILED',
      message: diagnostic
        ? moduleFailureMessage(diagnostic.summary, diagnostic.repairInstruction)
        : 'Module preload failed.',
      moduleName: moduleSnapshot.moduleName,
      modulePath: moduleSnapshot.modulePath,
      command: diagnostic?.command ?? null,
      occurredAt: moduleSnapshot.updatedAt
    };
    if (task.state === 'PRELOADING') {
      return transitionClassTask(task, 'PRELOAD_FAILED', { now, error });
    }
    if (task.state === 'PRELOAD_FAILED') {
      return { ...task, preloadState: 'FAILED', lastError: error, updatedAt: now };
    }
    if (!canTransition(task, 'PRELOADING')) return null;
    const preloading = transitionClassTask(task, 'PRELOADING', { now });
    return transitionClassTask(preloading, 'PRELOAD_FAILED', { now, error });
  }
  return task.state === 'PRELOADING' && task.preloadState !== 'IDLE'
    ? { ...task, preloadState: 'IDLE', updatedAt: now }
    : null;
}

function moduleFailureMessage(summary: string, repairInstruction: string): string {
  const repair = compactTaskErrorText(repairInstruction);
  const compactSummary = compactTaskErrorText(summary);
  if (!repair) return compactSummary.slice(0, MAX_TASK_ERROR_TEXT_LENGTH);
  const summaryLimit = Math.max(0, MAX_TASK_ERROR_TEXT_LENGTH - repair.length - 1);
  const boundedSummary = compactSummary.slice(0, summaryLimit).trimEnd();
  return boundedSummary ? `${boundedSummary} ${repair}` : repair.slice(0, MAX_TASK_ERROR_TEXT_LENGTH);
}

function compactTaskErrorText(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]+/g, ' ').trim();
}

function transitionToClassFailure(
  task: ClassTaskSnapshot,
  error: PublicTaskError,
  now: string
): ClassTaskSnapshot | null {
  let preloading = task;
  if (task.state !== 'PRELOADING') {
    if (task.state === 'PRELOAD_FAILED') {
      return { ...task, preloadState: 'READY', lastError: detached(error), updatedAt: now };
    }
    if (!canTransition(task, 'PRELOADING')) return null;
    preloading = transitionClassTask(task, 'PRELOADING', { now });
  }
  return {
    ...transitionClassTask(preloading, 'PRELOAD_FAILED', { now, error }),
    preloadState: 'FAILED'
  };
}

function canTransition(
  task: ClassTaskSnapshot,
  nextState: ClassTaskSnapshot['state']
): boolean {
  return LEGAL_CLASS_TASK_TRANSITIONS[task.state].includes(nextState);
}

function qualifiedClassName(sourceFilePath: string): string {
  const segments = sourceFilePath.split(/[\\/]/).filter(Boolean);
  for (let index = 0; index <= segments.length - 4; index += 1) {
    if (segments[index] !== 'src' || segments[index + 1] !== 'main' || segments[index + 2] !== 'java') {
      continue;
    }
    const classSegments = segments.slice(index + 3);
    const last = classSegments.at(-1) ?? '';
    const extension = extname(last);
    classSegments[classSegments.length - 1] = extension
      ? last.slice(0, -extension.length)
      : last;
    if (classSegments.every(Boolean)) return classSegments.join('.');
  }
  const fileName = basename(sourceFilePath);
  const extension = extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function mapFromStore(file: ClassTaskStoreFile): Map<string, ClassTaskSnapshot> {
  return new Map(Object.entries(file.tasks).map(([key, task]) => [key, detached(task)]));
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length) return false;
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function sameSelection(left: ClassTaskSnapshot, right: ClassTaskSnapshot): boolean {
  return left.selectionMode === right.selectionMode
    && left.ragEnabled === right.ragEnabled
    && left.repairAttemptLimit === right.repairAttemptLimit
    && left.unlimitedRepair === right.unlimitedRepair
    && left.selectedMethodIds.join('\0') === right.selectedMethodIds.join('\0')
    && left.methodOrder.join('\0') === right.methodOrder.join('\0');
}

function requireRepairConfiguration(
  repairAttemptLimit: number | null,
  unlimitedRepair: boolean
): void {
  if (unlimitedRepair) {
    if (repairAttemptLimit !== null) {
      throw new Error('Unlimited repair cannot have a finite repairAttemptLimit.');
    }
    return;
  }
  if (!Number.isSafeInteger(repairAttemptLimit) || (repairAttemptLimit as number) < 1) {
    throw new Error('请填写修复轮次或勾选无限制');
  }
}

function detached<T>(value: T): T {
  return structuredClone(value);
}
