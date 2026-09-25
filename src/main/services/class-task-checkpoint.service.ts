import type {
  ClassMethodCatalog,
  ClassTaskActiveGenerationBatch,
  ClassTaskAtomicStep,
  ClassTaskModelUsageIncrement,
  ClassTaskSnapshot,
  ClassTaskState,
  PublicTaskError
} from '../../shared/class-task-contracts.ts';
import type { ModelTokenUsage } from '../../shared/model-token-usage.ts';
import { AtomicJsonStore } from './atomic-json-store.ts';
import {
  applyMethodSelection,
  ClassTaskRegistryService
} from './class-task-registry.service.ts';
import { ClassTaskStore } from './class-task.store.ts';
import {
  reconcileSelectionWithCatalog,
  type SelectionReconciliation,
  transitionClassTask
} from './class-task-state-machine.ts';
import {
  validateStartMethodGenerationWaveRequest,
  validateRecoverMethodGenerationRequest,
  type MethodGenerationFailure,
  type MethodCandidate,
  type StartMethodGenerationSessionRequest,
  type StartMethodGenerationWaveRequest
} from './method-generation-contract.ts';
import type {
  ClassScenarioWorkWave,
  SingleMethodWorkWave
} from './method-analysis-contract.ts';
import { sanitizePublicText } from './maven-command.ts';

const NEWER_MODEL_TOOL_WAVE_FIELDS = new Set([
  'deferredScenarioIds',
  'modelRunBindingDigest',
  'usageRecordedWaveSessionId',
  'accountedModelCallIds',
  'scenarioMethods',
  'declarations',
  'partTestMethodNames',
  'scenarioMethodMappings',
  'completedPartIndexes',
  'uncachedInputTokens',
  'modelConfigurationRevision',
  'toolCapabilityCacheKeyDigest',
  'toolCallingSupported',
  'capabilityCacheKeyDigest',
  'contextMode',
  'concurrentForkSupported'
]);

export type MethodBatchCheckpoint = {
  taskId: string;
  methodId: string;
  batchId: string;
  batchIndex: number;
  completedTestMethodPlanIds: string[];
  outcome: 'PASSED' | 'RETAINED' | 'DROPPED';
  candidateVersion: number;
  tmpFilePath: string | null;
  tmpFileSha256: string | null;
  ordinaryTestMethodCount: number;
};

export type InProgressMethodBatchCheckpoint = {
  taskId: string;
  methodId: string;
  batchId: string;
  batchIndex: number;
  sourceSha256: string;
  startRequest: StartMethodGenerationSessionRequest;
  candidate: MethodCandidate;
  tmpFilePath: string;
  tmpFileSha256: string;
};

export type MethodExecutionCheckpoint = {
  completedBatches: MethodBatchCheckpoint[];
  completedTestMethodPlanIds: string[];
  inProgressBatch?: InProgressMethodBatchCheckpoint;
};

export type ClassTaskCatalogIdentity = {
  analysisSessionId: string;
  reportPairId: string;
};

export type ClassTaskRagRunCheckpoint = {
  taskRunId: string;
  revokedFqns: string[];
};

export type ClassTaskRunCheckpoint = {
  catalogIdentity: ClassTaskCatalogIdentity | null;
  resolvedMethodOrder: string[];
  completedMethodIds: string[];
  methods: Record<string, MethodExecutionCheckpoint>;
  ragRun: ClassTaskRagRunCheckpoint | null;
};

export type MethodWavePartCheckpoint = {
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  eventSequence: number;
  childSessionId: string | null;
  candidateId: string | null;
  isolatedFilePath: string | null;
  fileSha256: string | null;
  failureReason: string | null;
  aggregateUsage: ModelTokenUsage | null;
  modelCallCount: number;
  usageReportedCallCount: number;
};

export type ActiveMethodWaveCheckpoint = {
  waveId: string;
  waveSessionId: string | null;
  recoveryRequestId: string | null;
  eventSequence: number;
  startRequest: StartMethodGenerationWaveRequest | null;
  methodId: string;
  waveIndex: number;
  selectedScenarioIds: string[];
  remainingScenarioCount: number;
  wave: SingleMethodWorkWave | ClassScenarioWorkWave | null;
  initialUsageRecorded: boolean;
  parts: MethodWavePartCheckpoint[];
};

export type CompletedMethodWaveCheckpoint = {
  waveId: string;
  waveIndex: number;
  selectedScenarioIds: string[];
  completedScenarioIds: string[];
  skippedScenarioIds: string[];
  remainingScenarioCount: number;
  candidateIds: string[];
};

export type MethodWaveProgressCheckpoint = {
  completedScenarioIds: string[];
  skippedScenarioIds: string[];
  nextWaveIndex: number;
  remainingScenarioCount: number | null;
  completedWaves: CompletedMethodWaveCheckpoint[];
};

export type WaveCandidateCheckpoint = {
  candidateId: string;
  methodId: string;
  waveId: string;
  status:
    | 'GENERATED'
    | 'READY_FOR_MAVEN'
    | 'MAVEN_RUNNING'
    | 'MODEL_REPAIR'
    | 'STABLE_REPAIR'
    | 'PASSED'
    | 'BLOCKED';
  llmRepairAttemptsUsed: number;
  repairAttemptLimit: number | null;
  unlimitedRepair: boolean;
  lastMavenBatchId: string | null;
  stableRepair: {
    phase: 'NOT_STARTED' | 'TEST_METHODS' | 'SHARED_MEMBERS' | 'PASSED' | 'BLOCKED';
    iteration: number;
    annotatedMemberIds: string[];
  };
  managedFile: {
    path: string;
    sha256: string;
    location: 'ISOLATED' | 'PROJECT';
  } | null;
  moveTransaction: {
    sourcePath: string;
    targetPath: string;
    sha256: string;
    phase: 'PREPARED' | 'MOVED';
  } | null;
};

export type ClassTaskWaveCheckpoint = {
  methodQueue: string[];
  activeMethodId: string | null;
  methods: Record<string, MethodWaveProgressCheckpoint>;
  activeWave: ActiveMethodWaveCheckpoint | null;
  candidates: Record<string, WaveCandidateCheckpoint>;
  migrationInterrupted: boolean;
};

export type CommitActiveMethodWaveInput = {
  waveId: string;
  completedScenarioIds: string[];
  skippedScenarioIds: string[];
  remainingScenarioCount: number;
  candidateIds: string[];
  /** 已有缓存耗尽，但分析仍有未完成目标；这不是额外的真实场景数量。 */
  planningIncomplete?: boolean;
  /**
   * 正式候选已生成新的 JaCoCo 快照。当前 Wave 的完成预测属于旧快照，
   * 所选方法必须清空旧场景账本并在队尾等待新快照重新规划。
   */
  replanSelectedMethodsAfterCoverageRefresh?: boolean;
};

type StoredClassTaskRunCheckpoint = ClassTaskRunCheckpoint & {
  waveState: ClassTaskWaveCheckpoint;
};

type CheckpointStoreFile = {
  version: 5;
  tasks: Record<string, StoredClassTaskRunCheckpoint>;
};

export type ClassTaskStatePersistencePort = {
  snapshot(taskId: string): ClassTaskSnapshot;
  save(snapshot: ClassTaskSnapshot): Promise<ClassTaskSnapshot>;
  remove?(taskId: string): Promise<void>;
};

export type ClassTaskRegistryStateAdapterOptions = {
  registry: ClassTaskRegistryService;
  store: ClassTaskStore;
  broadcast?: (snapshot: ClassTaskSnapshot) => void;
  clock?: () => Date;
};

export type ClassTaskCheckpointServiceOptions = {
  storagePath: string;
  taskState: ClassTaskStatePersistencePort;
  clock?: () => Date;
};

export type PrepareClassTaskRunOptions = {
  reset: boolean;
  preserveModelUsage?: boolean;
  catalogIdentity?: ClassTaskCatalogIdentity;
  resolvedMethodOrder?: readonly string[];
};

type ClassTaskBackgroundBoundaryOperation = {
  run(): Promise<void>;
};

export class ClassTaskPausedAtBoundaryError extends Error {
  constructor() {
    super('Class task paused at an atomic boundary.');
    this.name = 'ClassTaskPausedAtBoundaryError';
  }
}

export class ClassTaskTerminationBoundaryError extends Error {
  constructor() {
    super('Class task termination prevents a new atomic step.');
    this.name = 'ClassTaskTerminationBoundaryError';
  }
}

const UNSYNCHRONIZED_EXECUTION_STATES = new Set<ClassTaskState>([
  'PRELOADING', 'RUNNING', 'PAUSE_REQUESTED', 'STOPPING'
]);
const USER_SELECTION_LOCKED_STATES = new Set<ClassTaskState>([
  'PRELOADING', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'
]);
const CATALOG_RECONCILIATION_LOCKED_STATES = new Set<ClassTaskState>([
  'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'
]);
const PAUSE_DRAIN_STEPS = new Set<Exclude<ClassTaskAtomicStep, 'IDLE'>>([
  'WRITE_CANDIDATE'
]);

/**
 * Makes Task 7's registry/store usable as the scheduler's canonical state port.
 * Active snapshots are overlaid while work is in flight. Once every task is at
 * a restart-stable boundary, the Task 7 registry is safely reloaded from disk.
 */
export class ClassTaskRegistryStateAdapter implements ClassTaskStatePersistencePort {
  private readonly registry: ClassTaskRegistryService;
  private readonly store: ClassTaskStore;
  private readonly broadcast?: (snapshot: ClassTaskSnapshot) => void;
  private readonly clock: () => Date;
  private readonly overlays = new Map<string, ClassTaskSnapshot>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: ClassTaskRegistryStateAdapterOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.broadcast = options.broadcast;
    this.clock = options.clock ?? (() => new Date());
  }

  snapshot(taskId: string): ClassTaskSnapshot {
    const overlay = this.overlays.get(taskId);
    return detached(overlay ?? this.registry.snapshot(taskId));
  }

  list(workspaceRoot?: string): ClassTaskSnapshot[] {
    return this.registry.list(workspaceRoot).map((task) =>
      detached(this.overlays.get(task.id) ?? task)
    );
  }

  async save(snapshot: ClassTaskSnapshot): Promise<ClassTaskSnapshot> {
    return this.enqueue(async () => {
      const saved = await this.store.update((current) => {
        if (!(snapshot.id in current.tasks)) {
          throw new Error(`Unknown class task: ${snapshot.id}`);
        }
        const durableSnapshot = preserveSelection(snapshot, current.tasks[snapshot.id]);
        return {
          ...current,
          tasks: { ...current.tasks, [snapshot.id]: detached(durableSnapshot) }
        };
      });
      let persisted = detached(saved.tasks[snapshot.id]);
      this.overlays.set(snapshot.id, persisted);
      this.publish(persisted);

      const hasActiveTask = Object.values(saved.tasks)
        .some((task) => UNSYNCHRONIZED_EXECUTION_STATES.has(task.state));
      if (!hasActiveTask) {
        await this.registry.reload();
        this.overlays.clear();
        persisted = this.registry.snapshot(snapshot.id);
      }
      return detached(persisted);
    });
  }

  async remove(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      this.overlays.delete(taskId);
      const originalSave = this.store.save;
      const hadOwnSave = Object.prototype.hasOwnProperty.call(this.store, 'save');
      this.store.save = async (value) => {
        const tasks = { ...value.tasks };
        for (const [overlayTaskId, overlay] of this.overlays) {
          if (overlayTaskId in tasks) tasks[overlayTaskId] = detached(overlay);
        }
        return originalSave.call(this.store, { ...value, tasks });
      };
      try {
        await this.registry.remove(taskId);
      } finally {
        if (hadOwnSave) this.store.save = originalSave;
        else Reflect.deleteProperty(this.store, 'save');
      }
    });
  }

  add(
    request: Parameters<ClassTaskRegistryService['add']>[0]
  ): ReturnType<ClassTaskRegistryService['add']> {
    return this.mutateRegistry(() => this.registry.add(request));
  }

  reorder(
    ...args: Parameters<ClassTaskRegistryService['reorder']>
  ): ReturnType<ClassTaskRegistryService['reorder']> {
    return this.enqueue(async () => {
      const originalSave = this.store.save;
      const hadOwnSave = Object.prototype.hasOwnProperty.call(this.store, 'save');
      this.store.save = async (value) => {
        const tasks = { ...value.tasks };
        for (const [taskId, overlay] of this.overlays) {
          if (taskId in tasks) tasks[taskId] = detached(overlay);
        }
        return originalSave.call(this.store, { ...value, tasks });
      };
      try {
        await this.registry.reorder(...args);
        return this.list(args[0]);
      } finally {
        if (hadOwnSave) this.store.save = originalSave;
        else Reflect.deleteProperty(this.store, 'save');
      }
    });
  }

  applyModulePreloadSnapshot(
    ...args: Parameters<ClassTaskRegistryService['applyModulePreloadSnapshot']>
  ): ReturnType<ClassTaskRegistryService['applyModulePreloadSnapshot']> {
    return this.enqueue(async () => {
      const result = await this.registry.applyModulePreloadSnapshot(...args);
      for (const task of result) {
        if (this.overlays.get(task.id)?.state === 'PRELOADING') {
          this.overlays.delete(task.id);
        }
      }
      await this.restoreOverlays();
      return result.map((task) => detached(
        this.overlays.get(task.id) ?? this.registry.snapshot(task.id)
      ));
    });
  }

  applyClassPreloadFailure(
    ...args: Parameters<ClassTaskRegistryService['applyClassPreloadFailure']>
  ): ReturnType<ClassTaskRegistryService['applyClassPreloadFailure']> {
    return this.enqueue(async () => {
      const executionOverlay = this.overlays.get(args[0]);
      if (executionOverlay && CATALOG_RECONCILIATION_LOCKED_STATES.has(executionOverlay.state)) {
        return detached(executionOverlay);
      }
      const result = await this.registry.applyClassPreloadFailure(...args);
      this.overlays.delete(result.id);
      await this.restoreOverlays();
      return detached(result);
    });
  }

  saveSelection(
    ...args: Parameters<ClassTaskRegistryService['saveSelection']>
  ): ReturnType<ClassTaskRegistryService['saveSelection']> {
    return this.enqueue(async () => {
      const state = this.snapshot(args[0]).state;
      if (USER_SELECTION_LOCKED_STATES.has(state)) {
        throw new Error(`Cannot change method selection while ${state}.`);
      }
      const overlay = this.overlays.get(args[0]);
      if (overlay) {
        const selected = applyMethodSelection(
          overlay,
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
          args[6],
          this.clock().toISOString()
        );
        const saved = await this.store.update((current) => {
          if (!(selected.id in current.tasks)) {
            throw new Error(`Unknown class task: ${selected.id}`);
          }
          return {
            ...current,
            tasks: { ...current.tasks, [selected.id]: detached(selected) }
          };
        });
        const persisted = detached(saved.tasks[selected.id]);
        this.overlays.set(selected.id, persisted);
        this.publish(persisted);
        return detached(persisted);
      }
      const saved = await this.registry.saveSelection(...args);
      await this.restoreOverlays();
      return detached(saved);
    });
  }

  reconcileCatalog(
    ...args: Parameters<ClassTaskRegistryService['reconcileCatalog']>
  ): ReturnType<ClassTaskRegistryService['reconcileCatalog']> {
    return this.reconcileCatalogInternal(args[0], args[1], false);
  }

  reconcileCatalogForExecution(
    taskId: string,
    catalog: ClassMethodCatalog
  ): Promise<SelectionReconciliation> {
    return this.reconcileCatalogInternal(taskId, catalog, true);
  }

  private reconcileCatalogInternal(
    taskId: string,
    catalog: ClassMethodCatalog,
    allowExecutionOverlay: boolean
  ): Promise<SelectionReconciliation> {
    return this.enqueue(async () => {
      const state = this.snapshot(taskId).state;
      const overlay = this.overlays.get(taskId);
      // 暂停边界已把 overlay 同步到 registry；恢复所需的内部目录核对仍可读取该快照。
      // 用户修改选择仍走 allowExecutionOverlay=false，不因此解锁。
      const executionOverlay = overlay
        ?? (allowExecutionOverlay && state === 'PAUSED' ? this.snapshot(taskId) : undefined);
      if (CATALOG_RECONCILIATION_LOCKED_STATES.has(state)) {
        if (!allowExecutionOverlay || !executionOverlay) {
          throw new Error('Cannot reconcile method selection while ' + state + '.');
        }
        return this.reconcileOverlayCatalog(taskId, executionOverlay, catalog);
      }
      if (overlay) {
        return this.reconcileOverlayCatalog(taskId, overlay, catalog);
      }
      const result = await this.registry.reconcileCatalog(taskId, catalog);
      await this.restoreOverlays();
      return { task: detached(result.task), notices: detached(result.notices) };
    });
  }

  private async reconcileOverlayCatalog(
    taskId: string,
    overlay: ClassTaskSnapshot,
    catalog: ClassMethodCatalog
  ): Promise<SelectionReconciliation> {
    const result = reconcileSelectionWithCatalog(overlay, catalog);
    if (result.notices.length === 0) {
      return { task: detached(overlay), notices: [] };
    }
    const reconciled = {
      ...result.task,
      updatedAt: this.clock().toISOString()
    };
    const saved = await this.store.update((current) => {
      if (!(taskId in current.tasks)) throw new Error('Unknown class task: ' + taskId);
      return {
        ...current,
        tasks: { ...current.tasks, [taskId]: detached(reconciled) }
      };
    });
    const persisted = detached(saved.tasks[taskId]);
    this.overlays.set(taskId, persisted);
    this.publish(persisted);
    return { task: persisted, notices: detached(result.notices) };
  }

  private publish(snapshot: ClassTaskSnapshot): void {
    if (!this.broadcast) return;
    try {
      this.broadcast(detached(snapshot));
    } catch {
      // A renderer listener cannot roll back an already persisted mutation.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private mutateRegistry<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await operation();
      await this.restoreOverlays();
      return result;
    });
  }

  private async restoreOverlays(): Promise<void> {
    if (this.overlays.size === 0) return;
    await this.store.update((current) => {
      const tasks = { ...current.tasks };
      for (const [taskId, overlay] of this.overlays) {
        if (taskId in tasks) tasks[taskId] = detached(overlay);
      }
      return { ...current, tasks };
    });
  }
}

/**
 * Persists private method progress separately from the frozen public task DTO.
 * The injected task-state port lets the runtime commit public snapshots through
 * its canonical registry/store boundary without coupling this service to IPC.
 */
export class ClassTaskCheckpointService {
  private readonly store: AtomicJsonStore<CheckpointStoreFile>;
  private readonly taskState: ClassTaskStatePersistencePort;
  private readonly clock: () => Date;
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly backgroundBoundaryOperations = new Map<
    string,
    ClassTaskBackgroundBoundaryOperation[]
  >();
  private readonly backgroundBoundaryDrains = new Map<string, Promise<void>>();

  constructor(options: ClassTaskCheckpointServiceOptions) {
    if (!options.storagePath.trim()) throw new TypeError('Checkpoint storage path cannot be empty.');
    this.taskState = options.taskState;
    this.clock = options.clock ?? (() => new Date());
    this.store = new AtomicJsonStore(
      options.storagePath,
      validateCheckpointStoreFile,
      () => ({ version: 5, tasks: {} })
    );
  }

  snapshot(taskId: string): ClassTaskSnapshot {
    return this.taskState.snapshot(taskId);
  }

  async taskProgress(taskId: string): Promise<ClassTaskRunCheckpoint> {
    const file = await this.store.read();
    return detached(legacyTaskCheckpoint(file.tasks[taskId] ?? emptyTaskCheckpoint()));
  }

  async taskWaveProgress(taskId: string): Promise<ClassTaskWaveCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const file = await this.store.read();
    return detached((file.tasks[taskId] ?? emptyTaskCheckpoint()).waveState);
  }

  async hasResumableProgress(taskId: string): Promise<boolean> {
    requireIdentifier(taskId, 'taskId');
    const file = await this.store.read();
    const task = file.tasks[taskId];
    if (!task) return false;
    const wave = task.waveState;
    return task.completedMethodIds.length > 0
      || Object.keys(task.methods).length > 0
      || wave.activeMethodId !== null
      || wave.activeWave !== null
      || Object.keys(wave.candidates).length > 0
      || Object.values(wave.methods).some((method) => (
        method.completedScenarioIds.length > 0
        || method.skippedScenarioIds.length > 0
        || method.completedWaves.length > 0
      ));
  }

  async saveRagRun(
    taskId: string,
    input: ClassTaskRagRunCheckpoint
  ): Promise<ClassTaskRagRunCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const ragRun = validateRagRunCheckpoint(input);
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (task.ragRun && task.ragRun.taskRunId !== ragRun.taskRunId) {
          throw new Error('A different RAG task run is already authorized.');
        }
        task.ragRun = detached(ragRun);
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(file.tasks[taskId].ragRun as ClassTaskRagRunCheckpoint);
    });
  }

  async mergeRagRevocations(
    taskId: string,
    taskRunId: string,
    revokedFqns: readonly string[]
  ): Promise<ClassTaskRagRunCheckpoint | null> {
    requireIdentifier(taskId, 'taskId');
    const expectedTaskRunId = requireUuid(taskRunId, 'taskRunId');
    const additions = normalizeFqns(revokedFqns, 'revokedFqns');
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = current.tasks[taskId];
        if (!task?.ragRun || task.ragRun.taskRunId !== expectedTaskRunId) return current;
        const existingRevocations = [...task.ragRun.revokedFqns];
        const nextTask = detached(task);
        nextTask.ragRun = {
          taskRunId: expectedTaskRunId,
          revokedFqns: [...new Set([
            ...existingRevocations,
            ...additions
          ])].sort()
        };
        return { ...current, tasks: { ...current.tasks, [taskId]: nextTask } };
      });
      return detached(file.tasks[taskId]?.ragRun ?? null);
    });
  }

  async clearRagRun(taskId: string, taskRunId: string): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    const expectedTaskRunId = requireUuid(taskRunId, 'taskRunId');
    await this.enqueueTask(taskId, async () => {
      await this.store.update((current) => {
        const task = current.tasks[taskId];
        if (!task?.ragRun || task.ragRun.taskRunId !== expectedTaskRunId) return current;
        const nextTask = detached(task);
        nextTask.ragRun = null;
        return { ...current, tasks: { ...current.tasks, [taskId]: nextTask } };
      });
    });
  }

  async methodCheckpoint(taskId: string, methodId: string): Promise<MethodExecutionCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    requireIdentifier(methodId, 'methodId');
    const task = await this.taskProgress(taskId);
    return detached(task.methods[methodId] ?? emptyMethodCheckpoint());
  }

  async dequeueMethodWave(taskId: string): Promise<string | null> {
    requireIdentifier(taskId, 'taskId');
    return this.enqueueTask(taskId, async () => {
      let dequeued: string | null = null;
      await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (task.waveState.activeMethodId !== null || task.waveState.activeWave !== null) {
          throw new Error('Cannot dequeue a method while an active Wave exists.');
        }
        dequeued = task.waveState.methodQueue.shift() ?? null;
        task.waveState.activeMethodId = dequeued;
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return dequeued;
    });
  }

  async saveActiveMethodWave(
    taskId: string,
    input: ActiveMethodWaveCheckpoint
  ): Promise<ActiveMethodWaveCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const activeWave = validateActiveMethodWaveCheckpoint(input);
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (task.waveState.activeMethodId !== activeWave.methodId) {
          throw new Error('Active Wave method does not own the dequeued method.');
        }
        const method = task.waveState.methods[activeWave.methodId]
          ?? emptyMethodWaveProgress();
        if (activeWave.waveIndex !== method.nextWaveIndex) {
          throw new Error('Active Wave index does not match the method checkpoint.');
        }
        const owners = activeWave.wave && 'selectedMethodIds' in activeWave.wave
          ? classWaveScenarioOwners(activeWave.wave)
          : new Map(activeWave.selectedScenarioIds.map((scenarioId) => (
              [scenarioId, activeWave.methodId] as const
            )));
        for (const [scenarioId, ownerMethodId] of owners) {
          const ownerProgress = task.waveState.methods[ownerMethodId]
            ?? emptyMethodWaveProgress();
          if (ownerProgress.completedScenarioIds.includes(scenarioId)
            || ownerProgress.skippedScenarioIds.includes(scenarioId)) {
            throw new Error('Active Wave scenarios must not repeat processed scenarios.');
          }
        }
        if (task.waveState.activeWave) {
          const previous = task.waveState.activeWave;
          if (previous.waveId !== activeWave.waveId
            || previous.methodId !== activeWave.methodId
            || previous.waveIndex !== activeWave.waveIndex
            || !sameStrings(previous.selectedScenarioIds, activeWave.selectedScenarioIds)) {
            throw new Error('Active Wave identity cannot change during recovery.');
          }
          if (previous.initialUsageRecorded && !activeWave.initialUsageRecorded) {
            throw new Error('Active Wave usage accounting cannot move backwards.');
          }
        }
        task.waveState.methods[activeWave.methodId] = method;
        task.waveState.activeWave = detached(activeWave);
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(file.tasks[taskId].waveState.activeWave as ActiveMethodWaveCheckpoint);
    });
  }

  async saveWaveCandidate(
    taskId: string,
    input: WaveCandidateCheckpoint
  ): Promise<WaveCandidateCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const candidate = validateWaveCandidateCheckpoint(input);
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        const existing = task.waveState.candidates[candidate.candidateId];
        if (existing && (
          existing.methodId !== candidate.methodId
          || existing.waveId !== candidate.waveId
          || candidate.llmRepairAttemptsUsed < existing.llmRepairAttemptsUsed
          || candidate.stableRepair.iteration < existing.stableRepair.iteration
        )) {
          throw new Error('Wave candidate identity or monotonic progress changed.');
        }
        task.waveState.candidates[candidate.candidateId] = detached(candidate);
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(file.tasks[taskId].waveState.candidates[candidate.candidateId]);
    });
  }

  async beginWaveCandidateModelRepair(
    taskId: string,
    candidateId: string
  ): Promise<WaveCandidateCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const normalizedCandidateId = requireUuid(candidateId, 'candidateId');
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        const candidate = task.waveState.candidates[normalizedCandidateId];
        if (!candidate || candidate.status !== 'MODEL_REPAIR') {
          throw new Error('Wave candidate is not ready for a model repair request.');
        }
        if (!candidate.unlimitedRepair
          && candidate.llmRepairAttemptsUsed >= (candidate.repairAttemptLimit as number)) {
          throw new Error('Wave candidate model repair limit is exhausted.');
        }
        candidate.llmRepairAttemptsUsed += 1;
        task.waveState.candidates[normalizedCandidateId] = candidate;
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(
        file.tasks[taskId].waveState.candidates[normalizedCandidateId]
      );
    });
  }

  async rollbackWaveCandidateModelRepair(
    taskId: string,
    candidateId: string
  ): Promise<WaveCandidateCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const normalizedCandidateId = requireUuid(candidateId, 'candidateId');
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        const candidate = task.waveState.candidates[normalizedCandidateId];
        if (!candidate || candidate.status !== 'MODEL_REPAIR') {
          throw new Error('Wave candidate is not ready to rollback a model repair request.');
        }
        if (candidate.llmRepairAttemptsUsed > 0) {
          candidate.llmRepairAttemptsUsed -= 1;
        }
        task.waveState.candidates[normalizedCandidateId] = candidate;
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(
        file.tasks[taskId].waveState.candidates[normalizedCandidateId]
      );
    });
  }

  async commitActiveMethodWave(
    taskId: string,
    input: CommitActiveMethodWaveInput
  ): Promise<MethodWaveProgressCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    const waveId = requireSha256(input.waveId, 'Wave ID');
    const completedScenarioIds = validateUniqueStrings(
      input.completedScenarioIds,
      'completedScenarioIds'
    );
    const skippedScenarioIds = validateUniqueStrings(
      input.skippedScenarioIds,
      'skippedScenarioIds'
    );
    requireNonNegativeInteger(input.remainingScenarioCount, 'remainingScenarioCount');
    const candidateIds = validateUniqueStrings(input.candidateIds, 'candidateIds')
      .map((candidateId) => requireUuid(candidateId, 'candidateId'));
    if (input.replanSelectedMethodsAfterCoverageRefresh !== undefined
      && typeof input.replanSelectedMethodsAfterCoverageRefresh !== 'boolean') {
      throw new TypeError('replanSelectedMethodsAfterCoverageRefresh must be a boolean.');
    }
    const replanSelectedMethod = input.replanSelectedMethodsAfterCoverageRefresh === true;
    return this.enqueueTask(taskId, async () => {
      let methodId = '';
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        const activeWave = task.waveState.activeWave;
        methodId = task.waveState.activeMethodId ?? '';
        if (!activeWave || activeWave.methodId !== methodId || activeWave.waveId !== waveId) {
          throw new Error('No matching active Wave exists to commit.');
        }
        const terminalScenarioIds = [...completedScenarioIds, ...skippedScenarioIds];
        if (new Set(terminalScenarioIds).size !== terminalScenarioIds.length
          || terminalScenarioIds.length !== activeWave.selectedScenarioIds.length
          || terminalScenarioIds.some(
            (scenarioId) => !activeWave.selectedScenarioIds.includes(scenarioId)
          )) {
          throw new Error('Wave outcome must exactly partition selected scenarios.');
        }
        const method = detached(
          task.waveState.methods[methodId] ?? emptyMethodWaveProgress()
        );
        if (activeWave.waveIndex !== method.nextWaveIndex) {
          throw new Error('Active Wave index changed before commit.');
        }
        const processed = new Set([
          ...method.completedScenarioIds,
          ...method.skippedScenarioIds
        ]);
        if (!replanSelectedMethod
          && terminalScenarioIds.some((scenarioId) => processed.has(scenarioId))) {
          throw new Error('Wave outcome repeats a processed scenario.');
        }
        if (replanSelectedMethod) {
          clearUnfinishedScenarioLedgersAfterCoverageRefresh(task);
          method.completedScenarioIds = [];
          method.skippedScenarioIds = [];
        } else {
          method.completedScenarioIds.push(...completedScenarioIds);
          method.skippedScenarioIds.push(...skippedScenarioIds);
        }
        method.completedWaves.push({
          waveId,
          waveIndex: activeWave.waveIndex,
          selectedScenarioIds: [...activeWave.selectedScenarioIds],
          completedScenarioIds: [...completedScenarioIds],
          skippedScenarioIds: [...skippedScenarioIds],
          remainingScenarioCount: input.remainingScenarioCount,
          candidateIds
        });
        method.nextWaveIndex += 1;
        // 正式化后必须根据新 JaCoCo 重规划；否则保留 Analyzer 对当前报告的真实余量。
        method.remainingScenarioCount = replanSelectedMethod
          || (input.planningIncomplete && input.remainingScenarioCount === 0)
          ? null
          : input.remainingScenarioCount;
        task.waveState.methods[methodId] = method;
        task.waveState.activeWave = null;
        task.waveState.activeMethodId = null;
        if (replanSelectedMethod || input.remainingScenarioCount > 0 || input.planningIncomplete) {
          if (task.waveState.methodQueue.includes(methodId)) {
            throw new Error('Wave method queue cannot contain duplicate method IDs.');
          }
          task.waveState.methodQueue.push(methodId);
        }
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(file.tasks[taskId].waveState.methods[methodId]);
    });
  }

  async completeActiveMethodWithoutWave(
    taskId: string,
    methodId: string
  ): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    requireIdentifier(methodId, 'methodId');
    await this.enqueueTask(taskId, async () => {
      await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (task.waveState.activeMethodId !== methodId
          || task.waveState.activeWave !== null) {
          throw new Error('No matching dequeued method exists without an active Wave.');
        }
        const method = detached(
          task.waveState.methods[methodId] ?? emptyMethodWaveProgress()
        );
        method.remainingScenarioCount = 0;
        task.waveState.methods[methodId] = method;
        task.waveState.activeMethodId = null;
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
    });
  }

  /** Analyzer 挂起的是搜索位置，不是一个已完成 Wave，也不是方法已覆盖。 */
  async requeueActiveMethodSearch(taskId: string, methodId: string): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    requireIdentifier(methodId, 'methodId');
    await this.enqueueTask(taskId, async () => {
      await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (task.waveState.activeMethodId !== methodId || task.waveState.activeWave !== null
          || task.waveState.methodQueue.includes(methodId)) {
          throw new Error('Only the dequeued search-only method can be requeued.');
        }
        const method = detached(task.waveState.methods[methodId] ?? emptyMethodWaveProgress());
        method.remainingScenarioCount = 1; // 仅表示搜索尚未完成，不伪造剩余叶子的精确个数。
        task.waveState.methods[methodId] = method;
        task.waveState.activeMethodId = null;
        task.waveState.methodQueue.push(methodId);
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
    });
  }

  async commitActiveClassWave(
    taskId: string,
    input: CommitActiveMethodWaveInput
  ): Promise<Record<string, MethodWaveProgressCheckpoint>> {
    requireIdentifier(taskId, 'taskId');
    const waveId = requireSha256(input.waveId, 'Wave ID');
    const completedScenarioIds = validateUniqueStrings(
      input.completedScenarioIds,
      'completedScenarioIds'
    );
    const skippedScenarioIds = validateUniqueStrings(
      input.skippedScenarioIds,
      'skippedScenarioIds'
    );
    const candidateIds = validateUniqueStrings(input.candidateIds, 'candidateIds')
      .map((candidateId) => requireUuid(candidateId, 'candidateId'));
    if (input.replanSelectedMethodsAfterCoverageRefresh !== undefined
      && typeof input.replanSelectedMethodsAfterCoverageRefresh !== 'boolean') {
      throw new TypeError('replanSelectedMethodsAfterCoverageRefresh must be a boolean.');
    }
    const replanSelectedMethods = input.replanSelectedMethodsAfterCoverageRefresh === true;
    return this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        const active = task.waveState.activeWave;
        const wave = active?.wave;
        if (!active || active.waveId !== waveId || !wave || !('selectedMethodIds' in wave)) {
          throw new Error('No matching active class Wave exists to commit.');
        }
        const terminal = [...completedScenarioIds, ...skippedScenarioIds];
        if (new Set(terminal).size !== terminal.length
          || terminal.length !== wave.selectedScenarioIds.length
          || terminal.some((scenarioId) => !wave.selectedScenarioIds.includes(scenarioId))) {
          throw new Error('Class Wave outcome must exactly partition selected scenarios.');
        }
        const methodByScenario = new Map<string, string>();
        for (const part of wave.parts) {
          for (const slice of part.methodSlices) {
            for (const scenarioId of slice.batch.scenarioIds) {
              methodByScenario.set(scenarioId, slice.methodId);
            }
          }
        }
        const selectedMethods = new Set(wave.selectedMethodIds);
        const completedMethods = new Set(wave.completedMethodIds.filter(
          (methodId) => !replanSelectedMethods || !selectedMethods.has(methodId)
        ));
        if (replanSelectedMethods) {
          clearUnfinishedScenarioLedgersAfterCoverageRefresh(task, completedMethods);
        }
        for (const methodId of wave.selectedMethodIds) {
          const method = detached(task.waveState.methods[methodId] ?? emptyMethodWaveProgress());
          const selected = wave.selectedScenarioIds.filter(
            (scenarioId) => methodByScenario.get(scenarioId) === methodId
          );
          const completed = completedScenarioIds.filter(
            (scenarioId) => methodByScenario.get(scenarioId) === methodId
          );
          const skipped = skippedScenarioIds.filter(
            (scenarioId) => methodByScenario.get(scenarioId) === methodId
          );
          const processed = new Set([
            ...method.completedScenarioIds,
            ...method.skippedScenarioIds
          ]);
          if (!replanSelectedMethods
            && selected.some((scenarioId) => processed.has(scenarioId))) {
            throw new Error('Class Wave outcome repeats a processed scenario.');
          }
          if (replanSelectedMethods) {
            method.completedScenarioIds = [];
            method.skippedScenarioIds = [];
          } else {
            method.completedScenarioIds.push(...completed);
            method.skippedScenarioIds.push(...skipped);
          }
          method.completedWaves.push({
            waveId,
            waveIndex: method.nextWaveIndex,
            selectedScenarioIds: selected,
            completedScenarioIds: completed,
            skippedScenarioIds: skipped,
            remainingScenarioCount: wave.remainingScenarioCountByMethod[methodId] ?? 0,
            candidateIds
          });
          method.nextWaveIndex += 1;
          method.remainingScenarioCount = replanSelectedMethods
            ? null
            : wave.remainingScenarioCountByMethod[methodId] ?? 0;
          task.waveState.methods[methodId] = method;
        }
        for (const methodId of completedMethods) {
          const method = detached(task.waveState.methods[methodId] ?? emptyMethodWaveProgress());
          method.remainingScenarioCount = 0;
          task.waveState.methods[methodId] = method;
        }
        task.waveState.methodQueue = task.waveState.methodQueue.filter(
          (methodId) => !completedMethods.has(methodId)
        );
        const owner = task.waveState.activeMethodId;
        task.waveState.activeWave = null;
        task.waveState.activeMethodId = null;
        if (replanSelectedMethods) {
          for (const methodId of wave.selectedMethodIds) {
            if (!completedMethods.has(methodId)
              && !task.waveState.methodQueue.includes(methodId)) {
              task.waveState.methodQueue.push(methodId);
            }
          }
        } else if (owner && !completedMethods.has(owner)
          && !task.waveState.methodQueue.includes(owner)) {
          task.waveState.methodQueue.unshift(owner);
        }
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      return detached(file.tasks[taskId].waveState.methods);
    });
  }

  async completeClassMethodsWithoutWave(
    taskId: string,
    methodIds: readonly string[]
  ): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    const completed = new Set(validateUniqueStrings(methodIds, 'methodIds'));
    await this.enqueueTask(taskId, async () => {
      await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (task.waveState.activeWave !== null) {
          throw new Error('Cannot complete class methods while an active Wave exists.');
        }
        for (const methodId of completed) {
          const method = detached(task.waveState.methods[methodId] ?? emptyMethodWaveProgress());
          method.remainingScenarioCount = 0;
          task.waveState.methods[methodId] = method;
        }
        task.waveState.methodQueue = task.waveState.methodQueue.filter(
          (methodId) => !completed.has(methodId)
        );
        if (task.waveState.activeMethodId && completed.has(task.waveState.activeMethodId)) {
          task.waveState.activeMethodId = null;
        }
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
    });
  }

  async commitWaveMethod(
    taskId: string,
    methodId: string,
    expectedCatalogIdentity: ClassTaskCatalogIdentity
  ): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    requireIdentifier(methodId, 'methodId');
    const expectedIdentity = validateCatalogIdentity(expectedCatalogIdentity);
    await this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (!task.catalogIdentity || !sameCatalogIdentity(task.catalogIdentity, expectedIdentity)) {
          throw new Error('Method completion belongs to a stale catalog identity.');
        }
        if (!task.resolvedMethodOrder.includes(methodId)) {
          throw new Error(`Method ${methodId} is not in the resolved execution order.`);
        }
        if (task.waveState.activeMethodId === methodId
          || task.waveState.activeWave?.methodId === methodId
          || task.waveState.methodQueue.includes(methodId)) {
          throw new Error('Wave method cannot complete while more Wave work remains.');
        }
        const method = task.waveState.methods[methodId];
        if (method && method.remainingScenarioCount !== 0) {
          throw new Error('Wave method cannot complete with remaining scenarios.');
        }
        if (!task.completedMethodIds.includes(methodId)) {
          task.completedMethodIds.push(methodId);
        }
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      const snapshot = this.taskState.snapshot(taskId);
      const progress = file.tasks[taskId];
      await this.savePublicTask({
        ...snapshot,
        currentMethodIndex: completedMethodsInResolvedOrder(progress) - 1
      });
    });
  }

  async prepareRun(
    taskId: string,
    options: PrepareClassTaskRunOptions
  ): Promise<ClassTaskRunCheckpoint> {
    requireIdentifier(taskId, 'taskId');
    if ((options.catalogIdentity === undefined) !== (options.resolvedMethodOrder === undefined)) {
      throw new TypeError('Catalog identity and resolved method order must be supplied together.');
    }
    const catalogIdentity = options.catalogIdentity === undefined
      ? undefined
      : validateCatalogIdentity(options.catalogIdentity);
    const resolvedMethodOrder = options.resolvedMethodOrder === undefined
      ? undefined
      : validateUniqueStrings(options.resolvedMethodOrder, 'resolvedMethodOrder');
    return this.enqueueTask(taskId, async () => {
      const publicTask = this.taskState.snapshot(taskId);
      const file = await this.store.update((current) => {
        const existing = current.tasks[taskId];
        const progress = options.reset ? emptyTaskCheckpoint() : detached(existing ?? emptyTaskCheckpoint());
        if (catalogIdentity && resolvedMethodOrder) {
          const catalogChanged = progress.catalogIdentity !== null
            && progress.catalogIdentity.reportPairId !== catalogIdentity.reportPairId;
          const completedActiveWave = catalogChanged && !options.reset
            ? recoverableCompletedActiveWave(progress.waveState)
            : null;
          if (catalogChanged) {
            const completed = new Set(progress.completedMethodIds);
            progress.methods = Object.fromEntries(
              Object.entries(progress.methods).filter(([methodId, method]) => (
                completed.has(methodId) || method.inProgressBatch !== undefined
              ))
            );
            progress.waveState = reconcileChangedCatalogWaveProgress(
              progress.waveState,
              resolvedMethodOrder,
              progress.completedMethodIds,
              completedActiveWave
            );
          }
          progress.catalogIdentity = catalogIdentity;
          progress.resolvedMethodOrder = resolvedMethodOrder;
          prepareWaveQueueForRun(
            progress,
            resolvedMethodOrder,
            options.reset
          );
        }
        return {
          ...current,
          tasks: { ...current.tasks, [taskId]: detached(progress) }
        };
      });
      const progress = file.tasks[taskId];
      const completedMethodCount = completedMethodsInResolvedOrder(progress);
      await this.savePublicTask({
        ...publicTask,
        currentMethodIndex: completedMethodCount - 1,
        currentAtomicStep: 'IDLE',
        activeGenerationBatch: null,
        ...(options.reset && !options.preserveModelUsage ? {
          tokenUsage: null,
          modelCallCount: 0,
          usageReportedCallCount: 0
        } : {})
      });
      return detached(legacyTaskCheckpoint(progress));
    });
  }

  async commitBatch(input: MethodBatchCheckpoint): Promise<void> {
    const batch = validateMethodBatchCheckpoint(input);
    await this.store.update((current) => {
      const task = detached(current.tasks[batch.taskId] ?? emptyTaskCheckpoint());
      const method = detached(task.methods[batch.methodId] ?? emptyMethodCheckpoint());
      const byId = method.completedBatches.find((entry) => entry.batchId === batch.batchId);
      const byIndex = method.completedBatches.find((entry) => entry.batchIndex === batch.batchIndex);
      if (byId || byIndex) {
        if (byId && byIndex && sameBatch(byId, batch) && sameBatch(byIndex, batch)) return current;
        throw new Error(`Conflicting batch checkpoint for ${batch.methodId}:${batch.batchId}.`);
      }
      const expectedIndex = method.completedBatches.length + 1;
      if (batch.batchIndex !== expectedIndex) {
        throw new Error(`The next batch index must be ${expectedIndex}.`);
      }
      if (!isPrefix(method.completedTestMethodPlanIds, batch.completedTestMethodPlanIds)) {
        throw new Error('A batch checkpoint must preserve completed plan IDs.');
      }
      const inProgress = method.inProgressBatch;
      if (inProgress && (
        inProgress.batchId !== batch.batchId
        || inProgress.batchIndex !== batch.batchIndex
        || inProgress.candidate.candidateVersion !== batch.candidateVersion
        || inProgress.tmpFilePath !== batch.tmpFilePath
        || inProgress.tmpFileSha256 !== batch.tmpFileSha256
      )) {
        throw new Error('Completed batch does not match its in-progress candidate checkpoint.');
      }
      method.completedBatches.push(detached(batch));
      method.completedTestMethodPlanIds = [...batch.completedTestMethodPlanIds];
      delete method.inProgressBatch;
      task.methods[batch.methodId] = method;
      return { ...current, tasks: { ...current.tasks, [batch.taskId]: task } };
    });
  }

  async saveInProgressBatch(input: InProgressMethodBatchCheckpoint): Promise<void> {
    const batch = validateInProgressMethodBatchCheckpoint(input);
    await this.store.update((current) => {
      const task = detached(current.tasks[batch.taskId] ?? emptyTaskCheckpoint());
      const method = detached(task.methods[batch.methodId] ?? emptyMethodCheckpoint());
      const completedConflict = method.completedBatches.some((entry) => (
        entry.batchId === batch.batchId || entry.batchIndex === batch.batchIndex
      ));
      if (completedConflict) {
        throw new Error('In-progress batch conflicts with a completed checkpoint.');
      }
      const expectedIndex = method.completedBatches.length + 1;
      if (batch.batchIndex !== expectedIndex) {
        throw new Error(`The in-progress batch index must be ${expectedIndex}.`);
      }
      const existing = method.inProgressBatch;
      if (existing) {
        if (sameInProgressBatch(existing, batch)) return current;
        if (
          existing.batchId !== batch.batchId
          || existing.batchIndex !== batch.batchIndex
          || existing.startRequest.methodId !== batch.startRequest.methodId
          || existing.startRequest.batchId !== batch.startRequest.batchId
          || existing.tmpFilePath !== batch.tmpFilePath
          || batch.candidate.candidateVersion < existing.candidate.candidateVersion
        ) {
          throw new Error('Conflicting in-progress method batch checkpoint.');
        }
      }
      method.inProgressBatch = detached(batch);
      task.methods[batch.methodId] = method;
      return { ...current, tasks: { ...current.tasks, [batch.taskId]: task } };
    });
  }

  async clearInProgressBatch(
    taskId: string,
    methodId: string,
    batchId: string
  ): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    requireIdentifier(methodId, 'methodId');
    requireIdentifier(batchId, 'batchId');
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      const method = task?.methods[methodId];
      if (!method?.inProgressBatch) return current;
      if (method.inProgressBatch.batchId !== batchId) {
        throw new Error('In-progress batch identity changed before cleanup.');
      }
      const nextTask = detached(task);
      delete nextTask.methods[methodId].inProgressBatch;
      return { ...current, tasks: { ...current.tasks, [taskId]: nextTask } };
    });
  }

  async removeTask(taskId: string): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    await this.enqueueTask(taskId, async () => {
      await this.store.update((current) => {
        if (!(taskId in current.tasks)) return current;
        const tasks = { ...current.tasks };
        delete tasks[taskId];
        return { ...current, tasks };
      });
      await this.taskState.remove?.(taskId);
    });
  }

  async commitMethod(
    taskId: string,
    methodId: string,
    expectedCatalogIdentity: ClassTaskCatalogIdentity
  ): Promise<void> {
    await this.commitMethods(taskId, [methodId], expectedCatalogIdentity);
  }

  async commitMethods(
    taskId: string,
    methodIds: readonly string[],
    expectedCatalogIdentity: ClassTaskCatalogIdentity
  ): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    if (methodIds.length === 0 || new Set(methodIds).size !== methodIds.length) {
      throw new Error('Method completion batch must contain unique method IDs.');
    }
    methodIds.forEach((methodId) => requireIdentifier(methodId, 'methodId'));
    const expectedIdentity = validateCatalogIdentity(expectedCatalogIdentity);
    await this.enqueueTask(taskId, async () => {
      const file = await this.store.update((current) => {
        const task = detached(current.tasks[taskId] ?? emptyTaskCheckpoint());
        if (!task.catalogIdentity || !sameCatalogIdentity(task.catalogIdentity, expectedIdentity)) {
          throw new Error('Method completion belongs to a stale catalog identity.');
        }
        const completed = new Set(task.completedMethodIds);
        let changed = false;
        for (const methodId of methodIds) {
          if (!task.resolvedMethodOrder.includes(methodId)) {
            throw new Error(`Method ${methodId} is not in the resolved execution order.`);
          }
          if (completed.has(methodId)) continue;
          const nextMethodId = task.resolvedMethodOrder.find((candidate) => !completed.has(candidate));
          if (methodId !== nextMethodId) {
            throw new Error(`The next method checkpoint must be ${nextMethodId ?? 'none'}.`);
          }
          task.completedMethodIds.push(methodId);
          completed.add(methodId);
          changed = true;
        }
        if (!changed) return current;
        task.waveState.methodQueue = task.waveState.methodQueue.filter(
          (methodId) => !completed.has(methodId)
        );
        if (task.waveState.activeMethodId && completed.has(task.waveState.activeMethodId)) {
          task.waveState.activeMethodId = null;
          task.waveState.activeWave = null;
        }
        return { ...current, tasks: { ...current.tasks, [taskId]: task } };
      });
      const snapshot = this.taskState.snapshot(taskId);
      const progress = file.tasks[taskId];
      const completedMethodCount = completedMethodsInResolvedOrder(progress);
      await this.savePublicTask({
        ...snapshot,
        currentMethodIndex: completedMethodCount - 1
      });
    });
  }

  async addModelUsage(
    taskId: string,
    increment: ClassTaskModelUsageIncrement
  ): Promise<ClassTaskSnapshot> {
    requireIdentifier(taskId, 'taskId');
    const validated = validateModelUsageIncrement(increment);
    return this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.modelCallCount == null || current.usageReportedCallCount == null) {
        return current;
      }
      if (validated.modelCallCount === 0) return current;
      const modelCallCount = safeCountSum(
        current.modelCallCount,
        validated.modelCallCount,
        'modelCallCount'
      );
      const usageReportedCallCount = safeCountSum(
        current.usageReportedCallCount,
        validated.usageReportedCallCount,
        'usageReportedCallCount'
      );
      if (usageReportedCallCount > modelCallCount) {
        throw new Error('usageReportedCallCount cannot exceed modelCallCount.');
      }
      return this.savePublicTask({
        ...current,
        tokenUsage: mergeModelTokenUsage(current.tokenUsage, validated.tokenUsage),
        modelCallCount,
        usageReportedCallCount
      });
    });
  }

  async recordModelFailure(
    taskId: string,
    failure: MethodGenerationFailure
  ): Promise<ClassTaskSnapshot> {
    requireIdentifier(taskId, 'taskId');
    if (!/^MODEL_[A-Z0-9_]{1,121}$/.test(failure.code)) {
      throw new TypeError('Model failure code is invalid.');
    }
    const message = sanitizePublicText(failure.message)
      .replace(/[\u0000-\u0020\u007f]+/gu, ' ')
      .trim()
      .slice(0, 3_500)
      || failure.code;
    return this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.lastError && isPreferredModelFailure(current.lastError.code, failure.code)) {
        return current;
      }
      return this.savePublicTask({
        ...current,
        lastError: {
          code: failure.code,
          message,
          moduleName: current.qualifiedClassName,
          modulePath: current.moduleDisplayPath,
          command: null,
          occurredAt: this.now()
        }
      });
    });
  }

  async transitionState(
    taskId: string,
    nextState: ClassTaskState,
    error?: PublicTaskError | null
  ): Promise<ClassTaskSnapshot> {
    return this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      const next = transitionClassTask(current, nextState, {
        now: this.now(),
        ...(error === undefined ? {} : { error })
      });
      return this.savePublicTask(next);
    });
  }

  async requestPause(taskId: string): Promise<ClassTaskSnapshot> {
    return this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.state === 'PAUSE_REQUESTED') return current;
      if (current.state !== 'RUNNING') {
        throw new Error(`Class task cannot pause while ${current.state}.`);
      }
      return this.savePublicTask(transitionClassTask(current, 'PAUSE_REQUESTED', { now: this.now() }));
    });
  }

  async requestTermination(taskId: string): Promise<ClassTaskSnapshot> {
    return this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.state === 'STOPPING') return current;
      if (!['RUNNING', 'PAUSE_REQUESTED', 'PAUSED'].includes(current.state)) {
        throw new Error(`Class task cannot terminate while ${current.state}.`);
      }
      return this.savePublicTask(transitionClassTask(current, 'STOPPING', { now: this.now() }));
    });
  }

  async beginAtomicStep(
    taskId: string,
    step: Exclude<ClassTaskAtomicStep, 'IDLE'>,
    activeGenerationBatch: ClassTaskActiveGenerationBatch | null = null
  ): Promise<void> {
    const generationBatch = validateActiveGenerationBatch(activeGenerationBatch);
    await this.drainBackgroundOperationsAtBoundary(taskId);
    await this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      const drainingReturnedCandidate = current.state === 'PAUSE_REQUESTED'
        && PAUSE_DRAIN_STEPS.has(step);
      if (current.state === 'PAUSE_REQUESTED' && !drainingReturnedCandidate) {
        await this.savePublicTask(transitionClassTask(current, 'PAUSED', { now: this.now() }));
        throw new ClassTaskPausedAtBoundaryError();
      }
      if (current.state === 'PAUSED') throw new ClassTaskPausedAtBoundaryError();
      if (current.state === 'STOPPING' || current.state === 'TERMINATED') {
        throw new ClassTaskTerminationBoundaryError();
      }
      if (current.state !== 'RUNNING' && !drainingReturnedCandidate) {
        throw new Error(`Class task cannot start an atomic step while ${current.state}.`);
      }
      if (current.currentAtomicStep !== 'IDLE') {
        throw new Error(`Atomic step ${current.currentAtomicStep} is already in progress.`);
      }
      await this.savePublicTask({
        ...current,
        currentAtomicStep: step,
        activeGenerationBatch: generationBatch
      });
    });
  }

  async completeAtomicStep(
    taskId: string,
    step: Exclude<ClassTaskAtomicStep, 'IDLE'>
  ): Promise<void> {
    await this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.currentAtomicStep !== step) {
        throw new Error(`Cannot complete ${step} while ${current.currentAtomicStep} is active.`);
      }
      await this.savePublicTask({
        ...current,
        currentAtomicStep: 'IDLE',
        activeGenerationBatch: null
      });
    });
  }

  async waitIfPausedAtBoundary(taskId: string): Promise<void> {
    await this.drainBackgroundOperationsAtBoundary(taskId);
    await this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.state === 'PAUSE_REQUESTED') {
        await this.savePublicTask(transitionClassTask(current, 'PAUSED', { now: this.now() }));
        throw new ClassTaskPausedAtBoundaryError();
      }
      if (current.state === 'PAUSED') throw new ClassTaskPausedAtBoundaryError();
      if (current.state === 'STOPPING' || current.state === 'TERMINATED') {
        throw new ClassTaskTerminationBoundaryError();
      }
    });
  }

  async pauseAtBoundary(taskId: string): Promise<boolean> {
    await this.drainBackgroundOperationsAtBoundary(taskId);
    return this.enqueueTask(taskId, async () => {
      const current = this.taskState.snapshot(taskId);
      if (current.state === 'PAUSED') return true;
      if (current.state !== 'PAUSE_REQUESTED') return false;
      await this.savePublicTask(transitionClassTask(current, 'PAUSED', { now: this.now() }));
      return true;
    });
  }

  throwIfTerminating(taskId: string): void {
    const state = this.taskState.snapshot(taskId).state;
    if (state === 'STOPPING' || state === 'TERMINATED') {
      throw new ClassTaskTerminationBoundaryError();
    }
  }

  runBackgroundOperationAtBoundary<T>(
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    requireIdentifier(taskId, 'taskId');
    return new Promise<T>((resolve, reject) => {
      const pending = this.backgroundBoundaryOperations.get(taskId) ?? [];
      pending.push({
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        }
      });
      this.backgroundBoundaryOperations.set(taskId, pending);
    });
  }

  async drainBackgroundOperationsAtBoundary(taskId: string): Promise<void> {
    requireIdentifier(taskId, 'taskId');
    if (this.taskState.snapshot(taskId).currentAtomicStep !== 'IDLE') return;
    const currentDrain = this.backgroundBoundaryDrains.get(taskId);
    if (currentDrain) return currentDrain;
    let drain!: Promise<void>;
    drain = Promise.resolve().then(async () => {
      for (;;) {
        const pending = this.backgroundBoundaryOperations.get(taskId);
        const operation = pending?.shift();
        if (!operation) {
          this.backgroundBoundaryOperations.delete(taskId);
          return;
        }
        await operation.run();
      }
    }).finally(() => {
      if (this.backgroundBoundaryDrains.get(taskId) === drain) {
        this.backgroundBoundaryDrains.delete(taskId);
      }
    });
    this.backgroundBoundaryDrains.set(taskId, drain);
    return drain;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.taskQueues.values()]);
    await Promise.all([...this.backgroundBoundaryDrains.values()]);
    await this.store.read();
  }

  private async savePublicTask(snapshot: ClassTaskSnapshot): Promise<ClassTaskSnapshot> {
    return this.taskState.save({ ...snapshot, updatedAt: this.now() });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private enqueueTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const pending = previous.then(operation);
    const tail = pending.then(() => undefined, () => undefined);
    this.taskQueues.set(taskId, tail);
    void tail.finally(() => {
      if (this.taskQueues.get(taskId) === tail) this.taskQueues.delete(taskId);
    });
    return pending;
  }
}

function emptyTaskCheckpoint(): StoredClassTaskRunCheckpoint {
  return {
    catalogIdentity: null,
    resolvedMethodOrder: [],
    completedMethodIds: [],
    methods: {},
    ragRun: null,
    waveState: emptyWaveCheckpoint()
  };
}

function emptyWaveCheckpoint(
  migrationInterrupted = false
): ClassTaskWaveCheckpoint {
  return {
    methodQueue: [],
    activeMethodId: null,
    methods: {},
    activeWave: null,
    candidates: {},
    migrationInterrupted
  };
}

function clearUnfinishedScenarioLedgersAfterCoverageRefresh(
  task: StoredClassTaskRunCheckpoint,
  preservedMethodIds: ReadonlySet<string> = new Set()
): void {
  const completedMethodIds = new Set(task.completedMethodIds);
  for (const [methodId, method] of Object.entries(task.waveState.methods)) {
    if (completedMethodIds.has(methodId) || preservedMethodIds.has(methodId)) continue;
    method.completedScenarioIds = [];
    method.skippedScenarioIds = [];
    method.remainingScenarioCount = null;
  }
}

function emptyMethodWaveProgress(): MethodWaveProgressCheckpoint {
  return {
    completedScenarioIds: [],
    skippedScenarioIds: [],
    nextWaveIndex: 1,
    remainingScenarioCount: null,
    completedWaves: []
  };
}

function legacyTaskCheckpoint(
  checkpoint: StoredClassTaskRunCheckpoint
): ClassTaskRunCheckpoint {
  return {
    catalogIdentity: checkpoint.catalogIdentity,
    resolvedMethodOrder: [...checkpoint.resolvedMethodOrder],
    completedMethodIds: [...checkpoint.completedMethodIds],
    methods: detached(checkpoint.methods),
    ragRun: detached(checkpoint.ragRun)
  };
}

function prepareWaveQueueForRun(
  progress: StoredClassTaskRunCheckpoint,
  resolvedMethodOrder: readonly string[],
  forceReset: boolean
): void {
  const wave = progress.waveState;
  const hasNoWaveHistory = Object.keys(wave.methods).length === 0
    && Object.keys(wave.candidates).length === 0
    && wave.activeWave === null
    && wave.activeMethodId === null;
  if (!forceReset && !wave.migrationInterrupted
    && (!hasNoWaveHistory || wave.methodQueue.length > 0)) return;
  const completed = new Set(progress.completedMethodIds);
  progress.waveState = {
    ...emptyWaveCheckpoint(),
    methodQueue: resolvedMethodOrder.filter((methodId) => !completed.has(methodId))
  };
}

function reconcileChangedCatalogWaveProgress(
  previous: ClassTaskWaveCheckpoint,
  resolvedMethodOrder: readonly string[],
  completedMethodIds: readonly string[],
  completedActiveWave: ReturnType<typeof recoverableCompletedActiveWave>
): ClassTaskWaveCheckpoint {
  const available = new Set(resolvedMethodOrder);
  const completed = new Set(completedMethodIds);
  const methods = Object.fromEntries(
    Object.entries(previous.methods)
      .filter(([methodId]) => available.has(methodId))
      .map(([methodId, method]) => [
        methodId,
        completed.has(methodId) || completedActiveWave?.methodId === methodId
          ? detached(method)
          : {
              ...detached(method),
              completedScenarioIds: [],
              skippedScenarioIds: [],
              remainingScenarioCount: null
            }
      ])
  );
  const candidates = Object.fromEntries(
    Object.entries(previous.candidates).filter(([candidateId, candidate]) => (
      available.has(candidate.methodId)
      && (
        candidate.status === 'PASSED'
        || completedActiveWave?.candidateIds.includes(candidateId)
      )
    ))
  );
  const methodQueue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (methodId: string | null): void => {
    if (!methodId || !available.has(methodId) || completed.has(methodId)
      || completedActiveWave?.methodId === methodId || queued.has(methodId)) {
      return;
    }
    queued.add(methodId);
    methodQueue.push(methodId);
  };
  if (!completedActiveWave) enqueue(previous.activeMethodId);
  for (const methodId of previous.methodQueue) enqueue(methodId);
  for (const methodId of resolvedMethodOrder) enqueue(methodId);
  if (completedActiveWave) {
    methods[completedActiveWave.methodId] = completedActiveWave.method;
  }
  return {
    ...emptyWaveCheckpoint(),
    methodQueue,
    methods,
    candidates,
    activeMethodId: completedActiveWave?.methodId ?? null,
    activeWave: completedActiveWave?.activeWave ?? null
  };
}

function recoverableCompletedActiveWave(
  wave: ClassTaskWaveCheckpoint
): {
  methodId: string;
  activeWave: ActiveMethodWaveCheckpoint;
  method: MethodWaveProgressCheckpoint;
  candidateIds: string[];
} | null {
  const activeWave = wave.activeWave;
  const methodId = wave.activeMethodId;
  if (!activeWave || !methodId || activeWave.methodId !== methodId) return null;
  if (!activeWave.parts.some((part) => part.status === 'SUCCEEDED')
    || activeWave.parts.some((part) => (
      part.status === 'PENDING' || part.status === 'RUNNING'
    ))) {
    return null;
  }
  const completedCandidates = Object.values(wave.candidates).filter((candidate) => (
    candidate.methodId === methodId
    && candidate.waveId === activeWave.waveId
    && candidate.moveTransaction === null
    && (
      candidate.status === 'PASSED'
        ? candidate.managedFile === null || candidate.managedFile.location === 'PROJECT'
        : candidate.managedFile !== null || isRebuildableZeroAttemptCandidate(candidate)
    )
  ));
  if (completedCandidates.length !== 1) return null;
  return {
    methodId,
    activeWave: detached(activeWave),
    method: detached(wave.methods[methodId] ?? emptyMethodWaveProgress()),
    candidateIds: completedCandidates.map((candidate) => candidate.candidateId)
  };
}

function isRebuildableZeroAttemptCandidate(candidate: WaveCandidateCheckpoint): boolean {
  return candidate.status === 'MODEL_REPAIR'
    && candidate.llmRepairAttemptsUsed === 0
    && candidate.managedFile === null
    && candidate.stableRepair.phase === 'NOT_STARTED'
    && candidate.stableRepair.iteration === 0
    && candidate.stableRepair.annotatedMemberIds.length === 0;
}

function completedMethodsInResolvedOrder(progress: ClassTaskRunCheckpoint): number {
  const completed = new Set(progress.completedMethodIds);
  return progress.resolvedMethodOrder.filter((methodId) => completed.has(methodId)).length;
}

function emptyMethodCheckpoint(): MethodExecutionCheckpoint {
  return { completedBatches: [], completedTestMethodPlanIds: [] };
}

function validateCheckpointStoreFile(value: unknown): CheckpointStoreFile {
  const record = requireRecord(value, 'checkpoint store');
  requireExactFields(record, ['version', 'tasks'], 'checkpoint store');
  if (record.version === 1) return migrateEmptyV1CheckpointStore(record.tasks);
  if (record.version !== 2 && record.version !== 3
    && record.version !== 4 && record.version !== 5) {
    throw new TypeError('Checkpoint store version must be between 2 and 5.');
  }
  const rawTasks = requireRecord(record.tasks, 'checkpoint tasks');
  const taskEntries = Object.entries(rawTasks);
  const tasks: Record<string, StoredClassTaskRunCheckpoint> = {};
  for (const [taskId, rawTask] of taskEntries) {
    requireIdentifier(taskId, 'taskId');
    const task = requireRecord(rawTask, 'task checkpoint');
    requireExactFields(
      task,
      record.version === 5
        ? [
            'catalogIdentity', 'resolvedMethodOrder', 'completedMethodIds',
            'methods', 'ragRun', 'waveState'
          ]
        : record.version === 4
        ? ['catalogIdentity', 'resolvedMethodOrder', 'completedMethodIds', 'methods', 'ragRun']
        : ['catalogIdentity', 'resolvedMethodOrder', 'completedMethodIds', 'methods'],
      'task checkpoint'
    );
    const catalogIdentity = task.catalogIdentity === null
      ? null
      : validateCatalogIdentity(task.catalogIdentity);
    const resolvedMethodOrder = validateUniqueStrings(task.resolvedMethodOrder, 'resolvedMethodOrder');
    const completedMethodIds = validateUniqueStrings(task.completedMethodIds, 'completedMethodIds');
    const rawMethods = requireRecord(task.methods, 'method checkpoints');
    const methods: Record<string, MethodExecutionCheckpoint> = {};
    for (const [methodId, rawMethod] of Object.entries(rawMethods)) {
      requireIdentifier(methodId, 'methodId');
      const method = requireRecord(rawMethod, 'method checkpoint');
      requireFields(
        method,
        ['completedBatches', 'completedTestMethodPlanIds'],
        record.version === 3 || record.version === 4 || record.version === 5
          ? ['inProgressBatch']
          : [],
        'method checkpoint'
      );
      if (!Array.isArray(method.completedBatches) || !Array.isArray(method.completedTestMethodPlanIds)) {
        throw new TypeError('Method checkpoint arrays are invalid.');
      }
      const batches = method.completedBatches.map(validateMethodBatchCheckpoint);
      const planIds = validateUniqueStrings(method.completedTestMethodPlanIds, 'completedTestMethodPlanIds');
      if (batches.some((batch, index) => batch.taskId !== taskId
        || batch.methodId !== methodId || batch.batchIndex !== index + 1)) {
        throw new TypeError('Stored batch identity or order is invalid.');
      }
      const batchIds = new Set<string>();
      let previousPlanIds: string[] = [];
      for (const batch of batches) {
        if (batchIds.has(batch.batchId)) throw new TypeError('Stored batch IDs must be unique.');
        if (!isPrefix(previousPlanIds, batch.completedTestMethodPlanIds)) {
          throw new TypeError('Stored completed plan IDs cannot move backwards.');
        }
        batchIds.add(batch.batchId);
        previousPlanIds = batch.completedTestMethodPlanIds;
      }
      if (batches.length === 0 && planIds.length > 0) {
        throw new TypeError('Stored completed plan IDs require a batch checkpoint.');
      }
      if (batches.length > 0
        && !sameStrings(batches.at(-1)?.completedTestMethodPlanIds ?? [], planIds)) {
        throw new TypeError('Stored completed plan IDs do not match the latest batch.');
      }
      const inProgressBatch = method.inProgressBatch === undefined
        ? undefined
        : validateInProgressMethodBatchCheckpoint(method.inProgressBatch);
      if (inProgressBatch && (
        inProgressBatch.taskId !== taskId
        || inProgressBatch.methodId !== methodId
        || inProgressBatch.batchIndex !== batches.length + 1
        || batchIds.has(inProgressBatch.batchId)
      )) {
        throw new TypeError('Stored in-progress batch identity or order is invalid.');
      }
      methods[methodId] = {
        completedBatches: batches,
        completedTestMethodPlanIds: planIds,
        ...(record.version === 5 && inProgressBatch ? { inProgressBatch } : {})
      };
    }
    const ragRun = record.version === 4 || record.version === 5
      ? (task.ragRun === null ? null : validateRagRunCheckpoint(task.ragRun))
      : null;
    const waveState = record.version === 5
      ? containsNewerModelToolWaveField(task.waveState)
        ? emptyWaveCheckpoint(true)
        : validateClassTaskWaveCheckpoint(
            task.waveState,
            resolvedMethodOrder,
            completedMethodIds
          )
      : emptyWaveCheckpoint(
          resolvedMethodOrder.some((methodId) => !completedMethodIds.includes(methodId))
            || Object.values(rawMethods).some((rawMethod) => (
              requireRecord(rawMethod, 'method checkpoint').inProgressBatch !== undefined
            ))
        );
    tasks[taskId] = {
      catalogIdentity,
      resolvedMethodOrder,
      completedMethodIds,
      methods,
      ragRun,
      waveState
    };
  }
  return { version: 5, tasks };
}

function containsNewerModelToolWaveField(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (NEWER_MODEL_TOOL_WAVE_FIELDS.has(key)) return true;
      pending.push(nested);
    }
  }

  return false;
}

function migrateEmptyV1CheckpointStore(value: unknown): CheckpointStoreFile {
  const rawTasks = requireRecord(value, 'checkpoint tasks');
  const taskEntries = Object.entries(rawTasks);
  const tasks: Record<string, StoredClassTaskRunCheckpoint> = {};
  for (const [taskId, rawTask] of taskEntries) {
    requireIdentifier(taskId, 'taskId');
    const task = requireRecord(rawTask, 'task checkpoint');
    requireExactFields(task, ['currentMethodIndex', 'methods'], 'task checkpoint');
    requireNonNegativeInteger(task.currentMethodIndex, 'currentMethodIndex');
    const methods = requireRecord(task.methods, 'method checkpoints');
    if (task.currentMethodIndex !== 0 || Object.keys(methods).length > 0) {
      throw new TypeError('Cannot migrate progressed positional checkpoint without its historical method order.');
    }
    tasks[taskId] = emptyTaskCheckpoint();
  }
  return { version: 5, tasks };
}

function validateRagRunCheckpoint(value: unknown): ClassTaskRagRunCheckpoint {
  const record = requireRecord(value, 'RAG task run checkpoint');
  requireExactFields(record, ['taskRunId', 'revokedFqns'], 'RAG task run checkpoint');
  const taskRunId = requireUuid(record.taskRunId, 'taskRunId');
  const revokedFqns = normalizeFqns(record.revokedFqns, 'revokedFqns');
  if (!sameStrings(revokedFqns, record.revokedFqns as string[])) {
    throw new TypeError('revokedFqns must be sorted and unique.');
  }
  return { taskRunId, revokedFqns };
}

function validateCatalogIdentity(value: unknown): ClassTaskCatalogIdentity {
  const record = requireRecord(value, 'catalog identity');
  requireExactFields(record, ['analysisSessionId', 'reportPairId'], 'catalog identity');
  return {
    analysisSessionId: requireIdentifier(record.analysisSessionId, 'analysisSessionId'),
    reportPairId: requireIdentifier(record.reportPairId, 'reportPairId')
  };
}

function validateMethodBatchCheckpoint(value: unknown): MethodBatchCheckpoint {
  const record = requireRecord(value, 'method batch checkpoint');
  requireExactFields(record, [
    'taskId',
    'methodId',
    'batchId',
    'batchIndex',
    'completedTestMethodPlanIds',
    'outcome',
    'candidateVersion',
    'tmpFilePath',
    'tmpFileSha256',
    'ordinaryTestMethodCount'
  ], 'method batch checkpoint');
  const taskId = requireIdentifier(record.taskId, 'taskId');
  const methodId = requireIdentifier(record.methodId, 'methodId');
  const batchId = requireIdentifier(record.batchId, 'batchId');
  requirePositiveInteger(record.batchIndex, 'batchIndex');
  const completedTestMethodPlanIds = validateUniqueStrings(
    record.completedTestMethodPlanIds,
    'completedTestMethodPlanIds'
  );
  if (
    record.outcome !== 'PASSED'
    && record.outcome !== 'RETAINED'
    && record.outcome !== 'DROPPED'
  ) {
    throw new TypeError('Batch outcome is invalid.');
  }
  if (!Number.isSafeInteger(record.candidateVersion)
    || (record.candidateVersion as number) < 1) {
    throw new TypeError('Candidate version must be a positive safe integer.');
  }
  const tmpFilePath = requireNullableString(record.tmpFilePath, 'tmpFilePath');
  const tmpFileSha256 = requireNullableString(record.tmpFileSha256, 'tmpFileSha256');
  if ((tmpFilePath === null) !== (tmpFileSha256 === null)) {
    throw new TypeError('TMP path and SHA-256 must both be present or absent.');
  }
  if (tmpFileSha256 !== null && !/^[a-f0-9]{64}$/i.test(tmpFileSha256)) {
    throw new TypeError('TMP SHA-256 is invalid.');
  }
  requireNonNegativeInteger(record.ordinaryTestMethodCount, 'ordinaryTestMethodCount');
  return {
    taskId,
    methodId,
    batchId,
    batchIndex: record.batchIndex as number,
    completedTestMethodPlanIds,
    outcome: record.outcome,
    candidateVersion: record.candidateVersion as MethodBatchCheckpoint['candidateVersion'],
    tmpFilePath,
    tmpFileSha256,
    ordinaryTestMethodCount: record.ordinaryTestMethodCount as number
  };
}

function validateInProgressMethodBatchCheckpoint(
  value: unknown
): InProgressMethodBatchCheckpoint {
  const record = requireRecord(value, 'in-progress method batch checkpoint');
  requireExactFields(record, [
    'taskId',
    'methodId',
    'batchId',
    'batchIndex',
    'sourceSha256',
    'startRequest',
    'candidate',
    'tmpFilePath',
    'tmpFileSha256'
  ], 'in-progress method batch checkpoint');
  const taskId = requireIdentifier(record.taskId, 'taskId');
  const methodId = requireIdentifier(record.methodId, 'methodId');
  const batchId = requireIdentifier(record.batchId, 'batchId');
  requirePositiveInteger(record.batchIndex, 'batchIndex');
  const sourceSha256 = requireSha256(record.sourceSha256, 'sourceSha256');
  const startRequest = detached(record.startRequest) as StartMethodGenerationSessionRequest;
  const candidate = detached(record.candidate) as MethodCandidate;
  validateRecoverMethodGenerationRequest({ startRequest, candidate });
  const tmpFilePath = requireNullableString(record.tmpFilePath, 'tmpFilePath');
  const tmpFileSha256 = requireSha256(record.tmpFileSha256, 'tmpFileSha256');
  if (
    tmpFilePath === null
    || startRequest.classTaskId !== taskId
    || startRequest.methodId !== methodId
    || startRequest.batchId !== batchId
    || startRequest.batchIndex !== record.batchIndex
    || candidate.generatedCodeSha256 !== tmpFileSha256
  ) {
    throw new TypeError('In-progress method batch identity is invalid.');
  }
  return {
    taskId,
    methodId,
    batchId,
    batchIndex: record.batchIndex as number,
    sourceSha256,
    startRequest,
    candidate,
    tmpFilePath,
    tmpFileSha256
  };
}

function validateClassTaskWaveCheckpoint(
  value: unknown,
  resolvedMethodOrder: readonly string[],
  completedMethodIds: readonly string[]
): ClassTaskWaveCheckpoint {
  const record = requireRecord(value, 'class task Wave checkpoint');
  requireExactFields(record, [
    'methodQueue', 'activeMethodId', 'methods', 'activeWave',
    'candidates', 'migrationInterrupted'
  ], 'class task Wave checkpoint');
  const methodQueue = validateUniqueStrings(record.methodQueue, 'methodQueue');
  const activeMethodId = record.activeMethodId === null
    ? null
    : requireIdentifier(record.activeMethodId, 'activeMethodId');
  const resolved = new Set(resolvedMethodOrder);
  const completed = new Set(completedMethodIds);
  if (methodQueue.some((methodId) => !resolved.has(methodId) || completed.has(methodId))) {
    throw new TypeError('Wave queue membership is invalid.');
  }
  if (activeMethodId && (
    !resolved.has(activeMethodId)
    || completed.has(activeMethodId)
    || methodQueue.includes(activeMethodId)
  )) {
    throw new TypeError('Active Wave method membership is invalid.');
  }

  const rawMethods = requireRecord(record.methods, 'Wave method checkpoints');
  const methods: Record<string, MethodWaveProgressCheckpoint> = {};
  for (const [methodId, rawMethod] of Object.entries(rawMethods)) {
    requireIdentifier(methodId, 'Wave method ID');
    if (resolvedMethodOrder.length > 0 && !resolved.has(methodId)) {
      throw new TypeError('Wave method checkpoint is outside the resolved method order.');
    }
    methods[methodId] = validateMethodWaveProgressCheckpoint(rawMethod);
  }

  const activeWave = record.activeWave === null
    ? null
    : validateActiveMethodWaveCheckpoint(record.activeWave);
  if (activeWave && activeWave.methodId !== activeMethodId) {
    throw new TypeError('Active Wave does not match the active method.');
  }
  if (activeWave) {
    const method = methods[activeWave.methodId] ?? emptyMethodWaveProgress();
    if (activeWave.waveIndex !== method.nextWaveIndex) {
      throw new TypeError('Active Wave index is invalid.');
    }
    const owners = activeWave.wave && 'selectedMethodIds' in activeWave.wave
      ? classWaveScenarioOwners(activeWave.wave)
      : new Map(activeWave.selectedScenarioIds.map((scenarioId) => (
          [scenarioId, activeWave.methodId] as const
        )));
    for (const [scenarioId, methodId] of owners) {
      const progress = methods[methodId] ?? emptyMethodWaveProgress();
      if (progress.completedScenarioIds.includes(scenarioId)
        || progress.skippedScenarioIds.includes(scenarioId)) {
        throw new TypeError('Active Wave scenarios overlap processed scenarios.');
      }
    }
  }

  const rawCandidates = requireRecord(record.candidates, 'Wave candidate checkpoints');
  const candidates: Record<string, WaveCandidateCheckpoint> = {};
  for (const [candidateId, rawCandidate] of Object.entries(rawCandidates)) {
    const candidate = validateWaveCandidateCheckpoint(rawCandidate);
    if (candidate.candidateId !== candidateId) {
      throw new TypeError('Wave candidate map identity is invalid.');
    }
    candidates[candidateId] = candidate;
  }
  if (typeof record.migrationInterrupted !== 'boolean') {
    throw new TypeError('migrationInterrupted must be a boolean.');
  }
  if (record.migrationInterrupted && (activeMethodId !== null || activeWave !== null)) {
    throw new TypeError('Interrupted legacy migration cannot contain active Wave state.');
  }
  return {
    methodQueue,
    activeMethodId,
    methods,
    activeWave,
    candidates,
    migrationInterrupted: record.migrationInterrupted
  };
}

function validateMethodWaveProgressCheckpoint(
  value: unknown
): MethodWaveProgressCheckpoint {
  const record = requireRecord(value, 'method Wave progress');
  requireExactFields(record, [
    'completedScenarioIds', 'skippedScenarioIds', 'nextWaveIndex',
    'remainingScenarioCount', 'completedWaves'
  ], 'method Wave progress');
  const completedScenarioIds = validateUniqueStrings(
    record.completedScenarioIds,
    'completedScenarioIds'
  );
  const skippedScenarioIds = validateUniqueStrings(
    record.skippedScenarioIds,
    'skippedScenarioIds'
  );
  const completed = new Set(completedScenarioIds);
  if (skippedScenarioIds.some((scenarioId) => completed.has(scenarioId))) {
    throw new TypeError('Completed and skipped scenario IDs must be disjoint.');
  }
  requirePositiveInteger(record.nextWaveIndex, 'nextWaveIndex');
  if (record.remainingScenarioCount !== null) {
    requireNonNegativeInteger(record.remainingScenarioCount, 'remainingScenarioCount');
  }
  if (!Array.isArray(record.completedWaves) || record.completedWaves.length > 10_000) {
    throw new TypeError('completedWaves is invalid.');
  }
  const completedWaves = record.completedWaves.map(validateCompletedMethodWaveCheckpoint);
  if (completedWaves.some((wave, index) => wave.waveIndex !== index + 1)) {
    throw new TypeError('Completed Wave indices must be contiguous.');
  }
  return {
    completedScenarioIds,
    skippedScenarioIds,
    nextWaveIndex: record.nextWaveIndex as number,
    remainingScenarioCount: record.remainingScenarioCount as number | null,
    completedWaves
  };
}

function validateCompletedMethodWaveCheckpoint(
  value: unknown
): CompletedMethodWaveCheckpoint {
  const record = requireRecord(value, 'completed method Wave');
  requireExactFields(record, [
    'waveId', 'waveIndex', 'selectedScenarioIds', 'completedScenarioIds',
    'skippedScenarioIds', 'remainingScenarioCount', 'candidateIds'
  ], 'completed method Wave');
  const waveId = requireSha256(record.waveId, 'Wave ID');
  requirePositiveInteger(record.waveIndex, 'Wave index');
  const selectedScenarioIds = validateUniqueStrings(
    record.selectedScenarioIds,
    'selectedScenarioIds'
  );
  if (selectedScenarioIds.length < 1 || selectedScenarioIds.length > 25) {
    throw new TypeError('Completed Wave must contain between 1 and 25 scenarios.');
  }
  const completedScenarioIds = validateUniqueStrings(
    record.completedScenarioIds,
    'completedScenarioIds'
  );
  const skippedScenarioIds = validateUniqueStrings(
    record.skippedScenarioIds,
    'skippedScenarioIds'
  );
  const terminal = [...completedScenarioIds, ...skippedScenarioIds];
  if (new Set(terminal).size !== terminal.length
    || terminal.length !== selectedScenarioIds.length
    || terminal.some((scenarioId) => !selectedScenarioIds.includes(scenarioId))) {
    throw new TypeError('Completed Wave scenarios must exactly partition selected scenarios.');
  }
  requireNonNegativeInteger(record.remainingScenarioCount, 'remainingScenarioCount');
  const candidateIds = validateUniqueStrings(record.candidateIds, 'candidateIds')
    .map((candidateId) => requireUuid(candidateId, 'candidateId'));
  return {
    waveId,
    waveIndex: record.waveIndex as number,
    selectedScenarioIds,
    completedScenarioIds,
    skippedScenarioIds,
    remainingScenarioCount: record.remainingScenarioCount as number,
    candidateIds
  };
}

function validateActiveMethodWaveCheckpoint(
  value: unknown
): ActiveMethodWaveCheckpoint {
  const record = requireRecord(value, 'active method Wave');
  requireFields(record, [
    'waveId', 'waveSessionId', 'methodId', 'waveIndex',
    'selectedScenarioIds', 'remainingScenarioCount', 'parts'
  ], [
    'recoveryRequestId', 'eventSequence', 'startRequest', 'wave', 'initialUsageRecorded'
  ], 'active method Wave');
  const waveId = requireSha256(record.waveId, 'Wave ID');
  const waveSessionId = record.waveSessionId === null
    ? null
    : requireUuid(record.waveSessionId, 'waveSessionId');
  const recoveryRequestId = record.recoveryRequestId === undefined
    || record.recoveryRequestId === null
    ? null
    : requireUuid(record.recoveryRequestId, 'recoveryRequestId');
  const eventSequence = record.eventSequence === undefined ? 0 : record.eventSequence;
  requireNonNegativeInteger(eventSequence, 'Wave eventSequence');
  const methodId = requireIdentifier(record.methodId, 'methodId');
  requirePositiveInteger(record.waveIndex, 'waveIndex');
  const selectedScenarioIds = validateUniqueStrings(
    record.selectedScenarioIds,
    'selectedScenarioIds'
  );
  if (selectedScenarioIds.length < 1 || selectedScenarioIds.length > 25) {
    throw new TypeError('Active Wave must contain between 1 and 25 scenarios.');
  }
  requireNonNegativeInteger(record.remainingScenarioCount, 'remainingScenarioCount');
  if (!Array.isArray(record.parts) || record.parts.length < 1 || record.parts.length > 5) {
    throw new TypeError('Active Wave parts are invalid.');
  }
  const parts = record.parts.map(validateMethodWavePartCheckpoint);
  if (parts.some((part, index) => part.partIndex !== index + 1)) {
    throw new TypeError('Active Wave Part indices must be contiguous.');
  }
  const partBatchIds = parts.map((part) => part.partBatchId);
  if (new Set(partBatchIds).size !== partBatchIds.length) {
    throw new TypeError('Active Wave Part batch IDs must be unique.');
  }
  const partScenarios = parts.flatMap((part) => part.scenarioIds);
  if (!sameStrings(partScenarios, selectedScenarioIds)) {
    throw new TypeError('Active Wave Part scenarios must match selected scenarios exactly.');
  }
  const startRequest = record.startRequest === undefined || record.startRequest === null
    ? null
    : detached(record.startRequest) as StartMethodGenerationWaveRequest;
  if (startRequest) {
    validateStartMethodGenerationWaveRequest(startRequest);
    if (startRequest.waveId !== waveId
      || startRequest.methodId !== methodId
      || startRequest.waveIndex !== record.waveIndex
      || startRequest.parts.length !== parts.length
      || startRequest.parts.some((part, index) => (
        part.partIndex !== parts[index].partIndex
        || part.partBatchId !== parts[index].partBatchId
        || !sameStrings(part.scenarioIds, parts[index].scenarioIds)
      ))) {
      throw new TypeError('Active Wave start request identity is invalid.');
    }
  }
  if (recoveryRequestId && !startRequest) {
    throw new TypeError('Wave recovery identity requires its original start request.');
  }
  const wave = record.wave === undefined || record.wave === null
    ? null
    : validateCheckpointWorkWave(record.wave, {
        waveId,
        methodId,
        selectedScenarioIds,
        remainingScenarioCount: record.remainingScenarioCount as number,
        parts
      });
  const initialUsageRecorded = record.initialUsageRecorded === undefined
    ? false
    : record.initialUsageRecorded;
  if (typeof initialUsageRecorded !== 'boolean') {
    throw new TypeError('Active Wave initialUsageRecorded must be boolean.');
  }
  return {
    waveId,
    waveSessionId,
    recoveryRequestId,
    eventSequence: eventSequence as number,
    startRequest,
    methodId,
    waveIndex: record.waveIndex as number,
    selectedScenarioIds,
    remainingScenarioCount: record.remainingScenarioCount as number,
    wave,
    initialUsageRecorded,
    parts
  };
}

function validateMethodWavePartCheckpoint(value: unknown): MethodWavePartCheckpoint {
  const record = requireRecord(value, 'method Wave Part');
  requireFields(record, [
    'partIndex', 'partBatchId', 'scenarioIds', 'status', 'eventSequence',
    'candidateId', 'isolatedFilePath', 'fileSha256', 'failureReason'
  ], [
    'childSessionId', 'aggregateUsage', 'modelCallCount', 'usageReportedCallCount'
  ], 'method Wave Part');
  requirePositiveInteger(record.partIndex, 'partIndex');
  if ((record.partIndex as number) > 5) throw new TypeError('partIndex is invalid.');
  const partBatchId = requireSha256(record.partBatchId, 'Part batch ID');
  const scenarioIds = validateUniqueStrings(record.scenarioIds, 'Part scenarioIds');
  if (scenarioIds.length < 1 || scenarioIds.length > 5) {
    throw new TypeError('A Wave Part must contain between 1 and 5 scenarios.');
  }
  if (!['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
    record.status as string
  )) {
    throw new TypeError('Wave Part status is invalid.');
  }
  requireNonNegativeInteger(record.eventSequence, 'Part eventSequence');
  const childSessionId = record.childSessionId === undefined || record.childSessionId === null
    ? null
    : requireUuid(record.childSessionId, 'childSessionId');
  const candidateId = record.candidateId === null
    ? null
    : requireUuid(record.candidateId, 'candidateId');
  const isolatedFilePath = requireNullableString(
    record.isolatedFilePath,
    'isolatedFilePath'
  );
  const fileSha256 = record.fileSha256 === null
    ? null
    : requireSha256(record.fileSha256, 'Part file SHA-256');
  const failureReason = requireNullableString(record.failureReason, 'failureReason');
  const aggregateUsage = record.aggregateUsage === undefined || record.aggregateUsage === null
    ? null
    : validateModelTokenUsage(record.aggregateUsage);
  const modelCallCount = record.modelCallCount === undefined ? 0 : record.modelCallCount;
  const usageReportedCallCount = record.usageReportedCallCount === undefined
    ? 0
    : record.usageReportedCallCount;
  requireNonNegativeInteger(modelCallCount, 'Part modelCallCount');
  requireNonNegativeInteger(usageReportedCallCount, 'Part usageReportedCallCount');
  if ((usageReportedCallCount as number) > (modelCallCount as number)) {
    throw new TypeError('Part usageReportedCallCount cannot exceed modelCallCount.');
  }
  if (((usageReportedCallCount as number) === 0) !== (aggregateUsage === null)) {
    throw new TypeError('Part token usage must match usageReportedCallCount.');
  }
  const status = record.status as MethodWavePartCheckpoint['status'];
  if (status === 'SUCCEEDED') {
    if (!candidateId || !isolatedFilePath || !fileSha256 || failureReason !== null) {
      throw new TypeError('Succeeded Wave Part requires reusable candidate file identity.');
    }
  } else if (status === 'FAILED') {
    if (!failureReason || candidateId || isolatedFilePath || fileSha256) {
      throw new TypeError('Failed Wave Part requires only a failure reason.');
    }
  } else if (candidateId || isolatedFilePath || fileSha256 || failureReason) {
    throw new TypeError('Non-terminal Wave Part cannot contain terminal identity.');
  }
  return {
    partIndex: record.partIndex as number,
    partBatchId,
    scenarioIds,
    status,
    eventSequence: record.eventSequence as number,
    childSessionId,
    candidateId,
    isolatedFilePath,
    fileSha256,
    failureReason,
    aggregateUsage,
    modelCallCount: modelCallCount as number,
    usageReportedCallCount: usageReportedCallCount as number
  };
}

function validateCheckpointWorkWave(
  value: unknown,
  expected: {
    waveId: string;
    methodId: string;
    selectedScenarioIds: readonly string[];
    remainingScenarioCount: number;
    parts: readonly MethodWavePartCheckpoint[];
  }
): SingleMethodWorkWave | ClassScenarioWorkWave {
  const wave = requireRecord(value, 'checkpointed Analyzer Wave');
  if ('selectedMethodIds' in wave) {
    requireExactFields(wave, [
      'waveBatchId', 'reportPairId', 'methodId', 'remainingScenarioCount',
      'hasWork', 'selectedMethodIds', 'selectedScenarioIds',
      'remainingScenarioCountByMethod', 'completedMethodIds', 'parts', 'warnings'
    ], 'checkpointed class Analyzer Wave');
    const selectedMethodIds = validateUniqueStrings(
      wave.selectedMethodIds,
      'checkpointed selectedMethodIds'
    );
    if (selectedMethodIds.length < 1 || selectedMethodIds.length > 25) {
      throw new TypeError('Checkpointed class Wave selected methods are invalid.');
    }
    const completedMethodIds = validateUniqueStrings(
      wave.completedMethodIds,
      'checkpointed completedMethodIds'
    );
    const remaining = requireRecord(
      wave.remainingScenarioCountByMethod,
      'checkpointed remainingScenarioCountByMethod'
    );
    for (const [methodId, count] of Object.entries(remaining)) {
      requireIdentifier(methodId, 'checkpointed remaining methodId');
      requireNonNegativeInteger(count, 'checkpointed remaining scenario count');
    }
    if (wave.hasWork !== true
      || requireSha256(wave.waveBatchId, 'checkpointed Wave ID') !== expected.waveId
      || requireIdentifier(wave.methodId, 'checkpointed methodId') !== expected.methodId
      || wave.remainingScenarioCount !== expected.remainingScenarioCount
      || !sameStrings(
        validateUniqueStrings(wave.selectedScenarioIds, 'checkpointed selectedScenarioIds'),
        expected.selectedScenarioIds
      )
      || !Array.isArray(wave.parts)
      || wave.parts.length !== expected.parts.length
      || !Array.isArray(wave.warnings)) {
      throw new TypeError('Checkpointed class Analyzer Wave identity is invalid.');
    }
    const suppliedMethods = new Set<string>();
    wave.parts.forEach((rawPart, index) => {
      const part = requireRecord(rawPart, 'checkpointed class Analyzer Wave Part');
      if (part.partIndex !== expected.parts[index].partIndex
        || part.partBatchId !== expected.parts[index].partBatchId
        || !sameStrings(
          validateUniqueStrings(part.scenarioIds, 'checkpointed Part scenarioIds'),
          expected.parts[index].scenarioIds
        )
        || !Array.isArray(part.methodSlices)
        || part.methodSlices.length < 1
        || part.methodSlices.length > 5) {
        throw new TypeError('Checkpointed class Analyzer Wave Part identity is invalid.');
      }
      const suppliedScenarios: string[] = [];
      for (const rawSlice of part.methodSlices) {
        const slice = requireRecord(rawSlice, 'checkpointed class Wave method slice');
        requireExactFields(slice, ['methodId', 'testMethodNamePrefix', 'batch'], 'class Wave method slice');
        const methodId = requireIdentifier(slice.methodId, 'class Wave slice methodId');
        if (!selectedMethodIds.includes(methodId)
          || typeof slice.testMethodNamePrefix !== 'string'
          || !/^[A-Za-z_$][\w$]*_$/u.test(slice.testMethodNamePrefix)) {
          throw new TypeError('Checkpointed class Wave method slice identity is invalid.');
        }
        suppliedMethods.add(methodId);
        const batch = requireRecord(slice.batch, 'checkpointed class Wave slice batch');
        const batchMethod = requireRecord(
          batch.method,
          'checkpointed class Wave slice batch method'
        );
        if (batchMethod.methodId !== methodId || !Array.isArray(batch.scenarioIds)) {
          throw new TypeError('Checkpointed class Wave slice batch identity is invalid.');
        }
        suppliedScenarios.push(...validateUniqueStrings(
          batch.scenarioIds,
          'checkpointed class Wave slice scenarios'
        ));
      }
      if (!sameStrings(suppliedScenarios, expected.parts[index].scenarioIds)) {
        throw new TypeError('Checkpointed class Wave slices do not partition the Part.');
      }
    });
    if (!sameStrings([...suppliedMethods], selectedMethodIds)
      || completedMethodIds.some((methodId) => !(methodId in remaining))) {
      throw new TypeError('Checkpointed class Wave method membership is invalid.');
    }
    return detached(wave) as ClassScenarioWorkWave;
  }
  requireExactFields(wave, [
    'waveBatchId', 'reportPairId', 'methodId', 'hasWork',
    'selectedScenarioIds', 'remainingScenarioCount', 'parts', 'warnings'
  ], 'checkpointed Analyzer Wave');
  if (wave.hasWork !== true
    || requireSha256(wave.waveBatchId, 'checkpointed Wave ID') !== expected.waveId
    || requireIdentifier(wave.reportPairId, 'checkpointed reportPairId').length < 1
    || requireIdentifier(wave.methodId, 'checkpointed methodId') !== expected.methodId
    || wave.remainingScenarioCount !== expected.remainingScenarioCount
    || !sameStrings(
      validateUniqueStrings(wave.selectedScenarioIds, 'checkpointed selectedScenarioIds'),
      expected.selectedScenarioIds
    )
    || !Array.isArray(wave.parts)
    || wave.parts.length !== expected.parts.length) {
    throw new TypeError('Checkpointed Analyzer Wave identity is invalid.');
  }
  wave.parts.forEach((rawPart, index) => {
    const part = requireRecord(rawPart, 'checkpointed Analyzer Wave Part');
    if (part.partIndex !== expected.parts[index].partIndex
      || part.partBatchId !== expected.parts[index].partBatchId
      || !sameStrings(
        validateUniqueStrings(part.scenarioIds, 'checkpointed Part scenarioIds'),
        expected.parts[index].scenarioIds
      )) {
      throw new TypeError('Checkpointed Analyzer Wave Part identity is invalid.');
    }
  });
  if (!Array.isArray(wave.warnings)) {
    throw new TypeError('Checkpointed Analyzer Wave warnings are invalid.');
  }
  return detached(wave) as SingleMethodWorkWave;
}

function classWaveScenarioOwners(wave: ClassScenarioWorkWave): Map<string, string> {
  const owners = new Map<string, string>();
  for (const part of wave.parts) {
    for (const slice of part.methodSlices) {
      for (const scenarioId of slice.batch.scenarioIds) {
        if (owners.has(scenarioId)) {
          throw new TypeError('Class Wave scenario appears in more than one method slice.');
        }
        owners.set(scenarioId, slice.methodId);
      }
    }
  }
  if (!sameStrings([...owners.keys()], wave.selectedScenarioIds)) {
    throw new TypeError('Class Wave method slices do not partition selected scenarios.');
  }
  return owners;
}

function validateWaveCandidateCheckpoint(value: unknown): WaveCandidateCheckpoint {
  const record = requireRecord(value, 'Wave candidate checkpoint');
  requireExactFields(record, [
    'candidateId', 'methodId', 'waveId', 'status', 'llmRepairAttemptsUsed',
    'repairAttemptLimit', 'unlimitedRepair', 'lastMavenBatchId',
    'stableRepair', 'managedFile', 'moveTransaction'
  ], 'Wave candidate checkpoint');
  const candidateId = requireUuid(record.candidateId, 'candidateId');
  const methodId = requireIdentifier(record.methodId, 'methodId');
  const waveId = requireSha256(record.waveId, 'Wave ID');
  const allowedStatuses = new Set<WaveCandidateCheckpoint['status']>([
    'GENERATED', 'READY_FOR_MAVEN', 'MAVEN_RUNNING', 'MODEL_REPAIR',
    'STABLE_REPAIR', 'PASSED', 'BLOCKED'
  ]);
  if (!allowedStatuses.has(record.status as WaveCandidateCheckpoint['status'])) {
    throw new TypeError('Wave candidate status is invalid.');
  }
  requireNonNegativeInteger(record.llmRepairAttemptsUsed, 'llmRepairAttemptsUsed');
  if (typeof record.unlimitedRepair !== 'boolean') {
    throw new TypeError('unlimitedRepair must be a boolean.');
  }
  if (record.unlimitedRepair) {
    if (record.repairAttemptLimit !== null) {
      throw new TypeError('Unlimited repair cannot have a repair attempt limit.');
    }
  } else {
    requirePositiveInteger(record.repairAttemptLimit, 'repairAttemptLimit');
  }
  const lastMavenBatchId = record.lastMavenBatchId === null
    ? null
    : requireIdentifier(record.lastMavenBatchId, 'lastMavenBatchId');
  const stable = requireRecord(record.stableRepair, 'stable repair checkpoint');
  requireExactFields(stable, [
    'phase', 'iteration', 'annotatedMemberIds'
  ], 'stable repair checkpoint');
  const stablePhases = new Set<WaveCandidateCheckpoint['stableRepair']['phase']>([
    'NOT_STARTED', 'TEST_METHODS', 'SHARED_MEMBERS', 'PASSED', 'BLOCKED'
  ]);
  if (!stablePhases.has(stable.phase as WaveCandidateCheckpoint['stableRepair']['phase'])) {
    throw new TypeError('Stable repair phase is invalid.');
  }
  requireNonNegativeInteger(stable.iteration, 'stable repair iteration');
  const annotatedMemberIds = validateUniqueStrings(
    stable.annotatedMemberIds,
    'annotatedMemberIds'
  );
  const managedFile = record.managedFile === null
    ? null
    : validateManagedWaveFile(record.managedFile);
  const moveTransaction = record.moveTransaction === null
    ? null
    : validateWaveMoveTransaction(record.moveTransaction);
  if (moveTransaction && managedFile && moveTransaction.sha256 !== managedFile.sha256) {
    throw new TypeError('Move transaction SHA-256 must match the managed file.');
  }
  return {
    candidateId,
    methodId,
    waveId,
    status: record.status as WaveCandidateCheckpoint['status'],
    llmRepairAttemptsUsed: record.llmRepairAttemptsUsed as number,
    repairAttemptLimit: record.repairAttemptLimit as number | null,
    unlimitedRepair: record.unlimitedRepair,
    lastMavenBatchId,
    stableRepair: {
      phase: stable.phase as WaveCandidateCheckpoint['stableRepair']['phase'],
      iteration: stable.iteration as number,
      annotatedMemberIds
    },
    managedFile,
    moveTransaction
  };
}

function validateManagedWaveFile(
  value: unknown
): NonNullable<WaveCandidateCheckpoint['managedFile']> {
  const record = requireRecord(value, 'managed Wave file');
  requireExactFields(record, ['path', 'sha256', 'location'], 'managed Wave file');
  const path = requireNullableString(record.path, 'managed file path');
  if (!path) throw new TypeError('Managed file path is invalid.');
  const sha256 = requireSha256(record.sha256, 'managed file SHA-256');
  if (record.location !== 'ISOLATED' && record.location !== 'PROJECT') {
    throw new TypeError('Managed file location is invalid.');
  }
  return { path, sha256, location: record.location };
}

function validateWaveMoveTransaction(
  value: unknown
): NonNullable<WaveCandidateCheckpoint['moveTransaction']> {
  const record = requireRecord(value, 'Wave move transaction');
  requireExactFields(record, [
    'sourcePath', 'targetPath', 'sha256', 'phase'
  ], 'Wave move transaction');
  const sourcePath = requireNullableString(record.sourcePath, 'move sourcePath');
  const targetPath = requireNullableString(record.targetPath, 'move targetPath');
  if (!sourcePath || !targetPath || sourcePath === targetPath) {
    throw new TypeError('Wave move transaction paths are invalid.');
  }
  const sha256 = requireSha256(record.sha256, 'move transaction SHA-256');
  if (record.phase !== 'PREPARED' && record.phase !== 'MOVED') {
    throw new TypeError('Wave move transaction phase is invalid.');
  }
  return { sourcePath, targetPath, sha256, phase: record.phase };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`${label} contains an unknown field.`);
  const missing = fields.find((field) => !(field in record));
  if (missing) throw new TypeError(`${label} is missing a required field.`);
}

function requireFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`${label} contains an unknown field.`);
  const missing = required.find((field) => !(field in record));
  if (missing) throw new TypeError(`${label} is missing a required field.`);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.toLowerCase();
}

function normalizeFqns(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new TypeError(`${label} is invalid.`);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) throw new TypeError(`${label} is invalid.`);
    const item = value[index];
    if (
      typeof item !== 'string'
      || item.length > 8_192
      || !item.includes('.')
      || /\s/u.test(item)
      || item.split('.').some((segment) => !segment || /^\d/u.test(segment))
    ) {
      throw new TypeError(`${label} is invalid.`);
    }
    result.push(item);
  }
  return [...new Set(result)].sort();
}

function validateActiveGenerationBatch(
  value: ClassTaskActiveGenerationBatch | null
): ClassTaskActiveGenerationBatch | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value.methodCount)
    || value.methodCount <= 0
    || !Number.isSafeInteger(value.scenarioCount)
    || value.scenarioCount <= 0
  ) {
    throw new TypeError('Active generation batch counts must be positive integers.');
  }
  return {
    methodCount: value.methodCount,
    scenarioCount: value.scenarioCount
  };
}

function validateModelUsageIncrement(
  value: ClassTaskModelUsageIncrement
): ClassTaskModelUsageIncrement {
  const record = requireRecord(value, 'model usage increment');
  requireExactFields(
    record,
    ['tokenUsage', 'modelCallCount', 'usageReportedCallCount'],
    'model usage increment'
  );
  requireNonNegativeInteger(record.modelCallCount, 'modelCallCount');
  requireNonNegativeInteger(record.usageReportedCallCount, 'usageReportedCallCount');
  const modelCallCount = record.modelCallCount as number;
  const usageReportedCallCount = record.usageReportedCallCount as number;
  const tokenUsage = record.tokenUsage === null
    ? null
    : validateModelTokenUsage(record.tokenUsage);
  if (usageReportedCallCount > modelCallCount) {
    throw new TypeError('usageReportedCallCount cannot exceed modelCallCount.');
  }
  if ((usageReportedCallCount === 0) !== (tokenUsage === null)) {
    throw new TypeError('Token usage must match usageReportedCallCount.');
  }
  return { tokenUsage, modelCallCount, usageReportedCallCount };
}

function validateModelTokenUsage(value: unknown): ModelTokenUsage {
  const record = requireRecord(value, 'token usage');
  requireFields(
    record,
    ['inputTokens', 'outputTokens', 'totalTokens'],
    ['cachedInputTokens'],
    'token usage'
  );
  const result: ModelTokenUsage = {
    inputTokens: tokenCount(record.inputTokens, 'inputTokens'),
    outputTokens: tokenCount(record.outputTokens, 'outputTokens'),
    totalTokens: tokenCount(record.totalTokens, 'totalTokens')
  };
  if ('cachedInputTokens' in record) {
    result.cachedInputTokens = tokenCount(record.cachedInputTokens, 'cachedInputTokens');
  }
  return result;
}

function tokenCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  requireNonNegativeInteger(value, label);
  return value as number;
}

function mergeModelTokenUsage(
  current: ModelTokenUsage | null,
  increment: ModelTokenUsage | null
): ModelTokenUsage | null {
  if (increment === null) return current === null ? null : detached(current);
  const result: ModelTokenUsage = {
    inputTokens: sumTokenMetric(current?.inputTokens, increment.inputTokens, 'inputTokens'),
    outputTokens: sumTokenMetric(current?.outputTokens, increment.outputTokens, 'outputTokens'),
    totalTokens: sumTokenMetric(current?.totalTokens, increment.totalTokens, 'totalTokens')
  };
  if (current?.cachedInputTokens !== undefined || increment.cachedInputTokens !== undefined) {
    result.cachedInputTokens = sumTokenMetric(
      current?.cachedInputTokens,
      increment.cachedInputTokens,
      'cachedInputTokens'
    );
  }
  return result;
}

function sumTokenMetric(
  current: number | null | undefined,
  increment: number | null | undefined,
  label: string
): number {
  return safeCountSum(current ?? 0, increment ?? 0, label);
}

function safeCountSum(current: number, increment: number, label: string): number {
  const total = current + increment;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError(`${label} exceeds the safe integer range.`);
  }
  return total;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 32_768) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function requirePositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function validateUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new TypeError(`${label} is invalid.`);
  const result = value.map((entry) => requireIdentifier(entry, label));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must be unique.`);
  return result;
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((entry, index) => value[index] === entry);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameBatch(left: MethodBatchCheckpoint, right: MethodBatchCheckpoint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameInProgressBatch(
  left: InProgressMethodBatchCheckpoint,
  right: InProgressMethodBatchCheckpoint
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCatalogIdentity(
  left: ClassTaskCatalogIdentity,
  right: ClassTaskCatalogIdentity
): boolean {
  return left.analysisSessionId === right.analysisSessionId
    && left.reportPairId === right.reportPairId;
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

function isPreferredModelFailure(currentCode: string, nextCode: string): boolean {
  if (!currentCode.startsWith('MODEL_')) return false;
  return modelFailurePriority(currentCode) >= modelFailurePriority(nextCode);
}

function modelFailurePriority(code: string): number {
  switch (code) {
    case 'MODEL_NOT_FOUND': return 60;
    case 'MODEL_AUTHENTICATION_FAILED': return 50;
    case 'MODEL_PERMISSION_DENIED': return 40;
    case 'MODEL_CAPABILITY_UNSUPPORTED':
    case 'MODEL_TOOL_CALLING_UNSUPPORTED': return 30;
    case 'MODEL_RATE_LIMITED': return 20;
    case 'MODEL_TIMEOUT':
    case 'MODEL_UNAVAILABLE': return 10;
    default: return 0;
  }
}

function preserveSelection(
  execution: ClassTaskSnapshot,
  selection: ClassTaskSnapshot
): ClassTaskSnapshot {
  return {
    ...execution,
    selectionMode: selection.selectionMode,
    selectedMethodIds: [...selection.selectedMethodIds],
    methodOrder: [...selection.methodOrder],
    ragEnabled: selection.ragEnabled,
    repairAttemptLimit: selection.repairAttemptLimit,
    unlimitedRepair: selection.unlimitedRepair
  };
}
