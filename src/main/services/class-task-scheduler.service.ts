import type {
  ClassMethodCatalog,
  ClassTaskSnapshot,
  ClassTaskState,
  PublicTaskError
} from '../../shared/class-task-contracts.ts';
import { resolveExecutionOrder } from './class-task-state-machine.ts';
import { ClassTaskCheckpointService } from './class-task-checkpoint.service.ts';
import {
  ClassTaskApplicationInterruptedError,
  ClassTaskPauseRequestedError,
  isClassTaskApplicationInterruptedError,
  isClassTaskPauseRequestedError
} from './class-task-interruption.ts';
import { ClassTaskRunnerService } from './class-task-runner.service.ts';
import { MethodGenerationRequestError } from './method-generation-contract.ts';
import { sanitizePublicText } from './maven-command.ts';

const RUN_ALL_ELIGIBLE_STATES = new Set<ClassTaskState>([
  'READY', 'COMPLETED', 'TERMINATED', 'INTERRUPTED'
]);
const RUN_TASK_ELIGIBLE_STATES = new Set<ClassTaskState>([
  ...RUN_ALL_ELIGIBLE_STATES, 'FAILED'
]);
const ACTIVE_STATES = new Set<ClassTaskState>([
  'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'
]);

export type ClassTaskRegistryReadPort = {
  list(workspaceRoot?: string): ClassTaskSnapshot[];
  snapshot(taskId: string): ClassTaskSnapshot;
};

export type ClassMethodCatalogProvider = {
  get(taskId: string, signal?: AbortSignal): Promise<ClassMethodCatalog>;
};

export type ClassTaskSchedulerOptions = {
  registry: ClassTaskRegistryReadPort;
  checkpoints: ClassTaskCheckpointService;
  runner: ClassTaskRunnerService;
  catalogProvider: ClassMethodCatalogProvider;
  validateTask: (task: ClassTaskSnapshot, signal: AbortSignal) => Promise<void>;
  clock?: () => Date;
};

export type TerminateAllClassTasksResult = {
  terminatedTaskCount: number;
  snapshots: ClassTaskSnapshot[];
};

export type RunClassTaskSchedulerOptions = {
  preserveCheckpoint?: boolean;
};

type ActiveTask = {
  controller: AbortController;
  promise: Promise<ClassTaskSnapshot>;
};

export class ClassTaskTerminationRequestedError extends Error {
  constructor() {
    super('Class task termination requested.');
    this.name = 'ClassTaskTerminationRequestedError';
  }
}

export class ClassTaskSchedulerService {
  private readonly registry: ClassTaskRegistryReadPort;
  private readonly checkpoints: ClassTaskCheckpointService;
  private readonly runner: ClassTaskRunnerService;
  private readonly catalogProvider: ClassMethodCatalogProvider;
  private readonly validateTask: ClassTaskSchedulerOptions['validateTask'];
  private readonly clock: () => Date;
  private readonly active = new Map<string, ActiveTask>();
  private readonly terminationRequests = new Set<string>();
  private readonly interruptionRequests = new Set<string>();

  constructor(options: ClassTaskSchedulerOptions) {
    this.registry = options.registry;
    this.checkpoints = options.checkpoints;
    this.runner = options.runner;
    this.catalogProvider = options.catalogProvider;
    this.validateTask = options.validateTask;
    this.clock = options.clock ?? (() => new Date());
  }

  runTask(
    taskId: string,
    options: RunClassTaskSchedulerOptions = {}
  ): Promise<ClassTaskSnapshot> {
    const existing = this.active.get(taskId);
    if (existing) return existing.promise;
    const task = this.registry.snapshot(taskId);
    if (!RUN_TASK_ELIGIBLE_STATES.has(task.state)) {
      throw new Error(`Class task cannot run while ${task.state}.`);
    }
    return this.start(task, false, options.preserveCheckpoint === true);
  }

  async runAll(): Promise<ClassTaskSnapshot[]> {
    const taskIds = this.registry.list()
      .filter((task) => RUN_ALL_ELIGIBLE_STATES.has(task.state))
      .map((task) => task.id);
    const settled = await Promise.allSettled(taskIds.map((taskId) =>
      Promise.resolve().then(() => this.runTask(taskId))
    ));
    return settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  }

  async requestPause(taskId: string): Promise<ClassTaskSnapshot> {
    const running = this.active.get(taskId);
    if (!running) {
      throw new Error('Only a running class task can be paused.');
    }
    const requested = await this.checkpoints.requestPause(taskId);
    if (!running.controller.signal.aborted) {
      running.controller.abort(new ClassTaskPauseRequestedError());
    }
    return requested;
  }

  async pauseAtBoundaryAndWait(taskId: string): Promise<ClassTaskSnapshot> {
    const running = this.active.get(taskId);
    const current = this.registry.snapshot(taskId);
    if (!running) {
      if (current.state === 'PAUSED') return current;
      throw new Error('Only a running class task can pause at a result boundary.');
    }
    if (current.state === 'RUNNING') {
      await this.checkpoints.requestPause(taskId);
    }
    return running.promise;
  }

  runBackgroundOperationAtBoundary<T>(
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const running = this.active.get(taskId);
    if (!running) return Promise.resolve().then(operation);
    const pending = this.checkpoints.runBackgroundOperationAtBoundary(taskId, operation);
    const drainAfterRun = (): Promise<void> => (
      this.checkpoints.drainBackgroundOperationsAtBoundary(taskId)
    );
    void running.promise.then(drainAfterRun, drainAfterRun);
    return pending;
  }

  async resumeTask(taskId: string): Promise<ClassTaskSnapshot> {
    const previous = this.active.get(taskId);
    if (previous) {
      const previousResult = await previous.promise;
      const replacement = this.active.get(taskId);
      if (replacement) return replacement.promise;
      if (previousResult.state !== 'PAUSED') return previousResult;
    }
    const raced = this.active.get(taskId);
    if (raced) return raced.promise;
    const task = this.registry.snapshot(taskId);
    if (task.state !== 'PAUSED') throw new Error(`Class task cannot resume while ${task.state}.`);
    return this.start(task, true);
  }

  async terminateTask(taskId: string): Promise<ClassTaskSnapshot> {
    const task = this.registry.snapshot(taskId);
    const running = this.active.get(taskId);
    if (!running && !ACTIVE_STATES.has(task.state)) {
      throw new Error(`Class task cannot terminate while ${task.state}.`);
    }
    if (running) this.terminationRequests.add(taskId);
    if (ACTIVE_STATES.has(task.state)) await this.checkpoints.requestTermination(taskId);
    if (running) {
      if (!running.controller.signal.aborted) {
        running.controller.abort(new ClassTaskTerminationRequestedError());
      }
      await running.promise;
      return this.checkpoints.snapshot(taskId);
    }
    return this.finalizeTermination(taskId);
  }

  async terminateAll(): Promise<TerminateAllClassTasksResult> {
    const taskIds = new Set(this.registry.list()
      .filter((task) => ACTIVE_STATES.has(task.state))
      .map((task) => task.id));
    for (const taskId of this.active.keys()) taskIds.add(taskId);
    const settled = await Promise.allSettled(
      [...taskIds].map((taskId) => this.terminateTask(taskId))
    );
    const snapshots = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    return { terminatedTaskCount: snapshots.length, snapshots };
  }

  async interruptAll(): Promise<ClassTaskSnapshot[]> {
    const active = [...this.active.entries()];
    for (const [taskId, running] of active) {
      this.interruptionRequests.add(taskId);
      if (!running.controller.signal.aborted) {
        running.controller.abort(new ClassTaskApplicationInterruptedError());
      }
    }
    const settled = await Promise.allSettled(active.map(([, running]) => running.promise));
    return settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  }

  private start(
    task: ClassTaskSnapshot,
    resume: boolean,
    preserveCheckpoint = false
  ): Promise<ClassTaskSnapshot> {
    const controller = new AbortController();
    const active = {} as ActiveTask;
    active.controller = controller;
    active.promise = this.execute(
      task,
      resume,
      controller.signal,
      preserveCheckpoint
    ).finally(() => {
      if (this.active.get(task.id) === active) this.active.delete(task.id);
      this.terminationRequests.delete(task.id);
      this.interruptionRequests.delete(task.id);
    });
    this.active.set(task.id, active);
    return active.promise;
  }

  private async execute(
    initialTask: ClassTaskSnapshot,
    resume: boolean,
    signal: AbortSignal,
    preserveCheckpoint: boolean
  ): Promise<ClassTaskSnapshot> {
    let enteredRunning = false;
    try {
      const current = this.registry.snapshot(initialTask.id);
      if (resume ? current.state !== 'PAUSED' : !RUN_TASK_ELIGIBLE_STATES.has(current.state)) {
        throw new Error(`Class task state changed before execution: ${current.state}.`);
      }
      const preserveRecoveredReadyCheckpoint = !resume
        && !preserveCheckpoint
        && current.state === 'READY'
        && (await this.checkpoints.hasResumableProgress?.(current.id) ?? false);
      const reset = !resume
        && !preserveCheckpoint
        && !preserveRecoveredReadyCheckpoint
        && (
        current.state === 'READY'
        || current.state === 'COMPLETED'
        || current.state === 'TERMINATED'
      );
      const preserveModelUsage = reset
        && current.state === 'READY'
        && (
          current.tokenUsage !== null
          || (current.modelCallCount ?? 0) > 0
          || (current.usageReportedCallCount ?? 0) > 0
        );
      const running = await this.checkpoints.transitionState(current.id, 'RUNNING');
      enteredRunning = true;
      if (this.terminationRequests.has(current.id)) {
        return this.finalizeTermination(current.id);
      }
      if (signal.aborted) throw signal.reason;
      await this.checkpoints.prepareRun(current.id, { reset, preserveModelUsage });
      if (this.terminationRequests.has(current.id)) {
        return this.finalizeTermination(current.id);
      }
      if (signal.aborted) throw signal.reason;
      if (resume && await this.checkpoints.pauseAtBoundary(current.id)) {
        return this.checkpoints.snapshot(current.id);
      }
      if (!resume) await this.validateTask(running, signal);
      if (this.terminationRequests.has(current.id)) {
        return this.finalizeTermination(current.id);
      }
      if (signal.aborted) throw signal.reason;
      if (await this.checkpoints.pauseAtBoundary(current.id)) {
        return this.checkpoints.snapshot(current.id);
      }
      const catalog = await this.catalogProvider.get(current.id, signal);
      if (this.terminationRequests.has(current.id)) {
        return this.finalizeTermination(current.id);
      }
      if (signal.aborted) throw signal.reason;
      if (await this.checkpoints.pauseAtBoundary(current.id)) {
        return this.checkpoints.snapshot(current.id);
      }
      const executionTask = this.checkpoints.snapshot(current.id);
      const methodOrder = resolveExecutionOrder(executionTask, catalog);
      const outcome = await this.runner.run(executionTask, methodOrder, {
        analysisSessionId: catalog.analysisSessionId,
        reportPairId: catalog.reportPairId
      }, signal);
      if (this.terminationRequests.has(current.id)) {
        return this.finalizeTermination(current.id);
      }
      if (signal.aborted) throw signal.reason;
      const latest = this.checkpoints.snapshot(current.id);
      if (latest.state === 'STOPPING') {
        return this.checkpoints.transitionState(current.id, 'TERMINATED');
      }
      if (outcome === 'PAUSED' || latest.state === 'PAUSED') return this.checkpoints.snapshot(current.id);
      if (outcome === 'NO_FORMAL_TEST_FILE') {
        return this.checkpoints.transitionState(
          current.id,
          'FAILED',
          this.noFormalTestFileError(latest)
        );
      }
      return this.checkpoints.transitionState(current.id, 'COMPLETED', null);
    } catch (error) {
      if (this.terminationRequests.has(initialTask.id)) {
        return this.finalizeTermination(initialTask.id);
      }
      if (
        this.interruptionRequests.has(initialTask.id)
        || isClassTaskApplicationInterruptedError(error)
        || isClassTaskApplicationInterruptedError(signal.reason)
      ) {
        return this.finalizeInterruption(initialTask.id);
      }
      if (
        isClassTaskPauseRequestedError(error)
        || isClassTaskPauseRequestedError(signal.reason)
      ) {
        return this.finalizePause(initialTask.id);
      }
      if (!enteredRunning) throw error;
      const latest = this.checkpoints.snapshot(initialTask.id);
      if (latest.state === 'STOPPING') {
        return this.checkpoints.transitionState(initialTask.id, 'TERMINATED');
      }
      if (latest.state === 'PAUSED') return latest;
      if (latest.state === 'RUNNING' || latest.state === 'PAUSE_REQUESTED') {
        if (error instanceof MethodGenerationRequestError
          && (error.code.startsWith('METHOD_GENERATION_')
            || error.code.startsWith('MODEL_'))
          && await this.checkpoints.hasResumableProgress(initialTask.id)) {
          await this.checkpoints.requestPause(initialTask.id);
          return this.checkpoints.transitionState(
            initialTask.id, 'PAUSED', this.publicError(initialTask, error)
          );
        }
        return this.checkpoints.transitionState(
          initialTask.id,
          'FAILED',
          this.publicError(initialTask, error)
        );
      }
      throw error;
    }
  }

  private async finalizeTermination(taskId: string): Promise<ClassTaskSnapshot> {
    let current = this.checkpoints.snapshot(taskId);
    if (current.state === 'TERMINATED') return current;
    if (RUN_TASK_ELIGIBLE_STATES.has(current.state)) {
      current = await this.checkpoints.transitionState(taskId, 'RUNNING');
    }
    if (current.state === 'RUNNING'
      || current.state === 'PAUSE_REQUESTED'
      || current.state === 'PAUSED') {
      current = await this.checkpoints.requestTermination(taskId);
    }
    if (current.state !== 'STOPPING') {
      throw new Error(`Class task cannot finish termination while ${current.state}.`);
    }
    return this.checkpoints.transitionState(taskId, 'TERMINATED');
  }

  private async finalizeInterruption(taskId: string): Promise<ClassTaskSnapshot> {
    const current = this.checkpoints.snapshot(taskId);
    if (current.state === 'INTERRUPTED' || current.state === 'PAUSED') return current;
    if (current.state === 'RUNNING' || current.state === 'PAUSE_REQUESTED') {
      return this.checkpoints.transitionState(taskId, 'INTERRUPTED');
    }
    if (current.state === 'STOPPING') return this.finalizeTermination(taskId);
    return current;
  }

  private async finalizePause(taskId: string): Promise<ClassTaskSnapshot> {
    const current = this.checkpoints.snapshot(taskId);
    if (current.state === 'PAUSED') return current;
    if (current.state === 'PAUSE_REQUESTED') {
      return this.checkpoints.transitionState(taskId, 'PAUSED');
    }
    if (current.state === 'STOPPING') return this.finalizeTermination(taskId);
    return current;
  }

  private publicError(task: ClassTaskSnapshot, error: unknown): PublicTaskError {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string'
      && /^(?:MODEL|ANALYSIS|METHOD_GENERATION|RAG|REPORT|BRANCH_SNAPSHOT)_[A-Z0-9_]{1,121}$/.test(error.code)
      ? error.code
      : 'CLASS_TASK_EXECUTION_FAILED';
    return {
      code: errorCode,
      message: sanitizePublicText(message),
      moduleName: task.qualifiedClassName,
      modulePath: task.moduleDisplayPath,
      command: null,
      occurredAt: this.clock().toISOString()
    };
  }

  private noFormalTestFileError(task: ClassTaskSnapshot): PublicTaskError {
    const modelFailure = task.lastError?.code.startsWith('MODEL_')
      ? task.lastError
      : null;
    return {
      code: modelFailure
        ? 'MODEL_NO_FORMAL_TEST_FILE_GENERATED'
        : 'NO_FORMAL_TEST_FILE_GENERATED',
      message: modelFailure
        ? `未生成任何正式测试文件。${modelFailure.code}: ${modelFailure.message}`
        : '未生成任何正式测试文件。请查看生成日志中的失败详情。',
      moduleName: task.qualifiedClassName,
      modulePath: task.moduleDisplayPath,
      command: null,
      occurredAt: this.clock().toISOString()
    };
  }
}
