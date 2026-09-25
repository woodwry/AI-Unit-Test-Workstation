import type { ClassTaskSnapshot } from '../../shared/class-task-contracts.ts';
import {
  ClassTaskCheckpointService,
  ClassTaskPausedAtBoundaryError,
  type ActiveMethodWaveCheckpoint,
  type ClassTaskCatalogIdentity,
  type ClassTaskWaveCheckpoint,
  type MethodExecutionCheckpoint,
  type MethodWaveProgressCheckpoint
} from './class-task-checkpoint.service.ts';
import type {
  ClassScenarioWaveRequest,
  ClassScenarioWaveResponse,
  ClassScenarioWorkWave,
  SingleMethodWaveRequest,
  SingleMethodWaveResponse,
  SingleMethodWorkWave
} from './method-analysis-contract.ts';
import {
  MethodGenerationRequestError,
  type MethodGenerationFailure
} from './method-generation-contract.ts';

export type MethodTestBundle = {
  methodId: string;
  sourceMethodId?: string;
  waveIndex?: number;
  hasRemainingScenarios?: boolean;
  methodName?: string;
  displaySignature?: string;
  jacocoOrder?: number;
  code: string;
  ordinaryTestMethodCount: number;
  passedTestMethods: string[];
  sourceBatchIds: string[];
};

export type MethodWaveExecutionOutcome = {
  completedScenarioIds: string[];
  skippedScenarioIds: string[];
  candidateIds: string[];
  bundle?: MethodTestBundle | null;
  bundles?: MethodTestBundle[];
  modelFailure?: MethodGenerationFailure;
};

export interface MethodExecutionPort {
  nextClassWave?(
    task: ClassTaskSnapshot,
    request: ClassScenarioWaveRequest,
    signal: AbortSignal
  ): Promise<ClassScenarioWaveResponse>;
  nextWave?(
    task: ClassTaskSnapshot,
    methodId: string,
    request: SingleMethodWaveRequest,
    signal: AbortSignal
  ): Promise<SingleMethodWaveResponse>;
  executeWave?(
    task: ClassTaskSnapshot,
    wave: SingleMethodWorkWave | ClassScenarioWorkWave,
    checkpoint: MethodExecutionCheckpoint,
    waveCheckpoint: ActiveMethodWaveCheckpoint,
    signal: AbortSignal
  ): Promise<MethodWaveExecutionOutcome>;
  formalizeWave?(
    task: ClassTaskSnapshot,
    bundle: MethodTestBundle,
    signal: AbortSignal
  ): Promise<void>;
  formalizeWaveGroup?(
    task: ClassTaskSnapshot,
    bundles: readonly MethodTestBundle[],
    candidateIds: readonly string[],
    signal: AbortSignal
  ): Promise<void>;
  planExecutionGroups?(
    task: ClassTaskSnapshot,
    pendingMethodIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly (readonly string[])[]>;
  executeGroup?(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    checkpoints: Readonly<Record<string, MethodExecutionCheckpoint>>,
    signal: AbortSignal
  ): Promise<boolean>;
  execute(
    task: ClassTaskSnapshot,
    methodId: string,
    checkpoint: MethodExecutionCheckpoint,
    signal: AbortSignal
  ): Promise<MethodTestBundle | null>;
  cleanupCompletedMethod?(
    task: ClassTaskSnapshot,
    methodId: string,
    signal: AbortSignal
  ): Promise<void>;
  formalizeCompletedMethods?(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    signal: AbortSignal
  ): Promise<void>;
  finalizeRun?(
    task: ClassTaskSnapshot,
    methodOrder: readonly string[],
    signal: AbortSignal
  ): Promise<void>;
}

export type ClassTaskRunnerOptions = {
  checkpoints: ClassTaskCheckpointService;
  methodExecution: MethodExecutionPort;
};

export type ClassTaskRunOutcome = 'COMPLETED' | 'PAUSED' | 'NO_FORMAL_TEST_FILE';

export class ClassTaskRunnerService {
  private readonly checkpoints: ClassTaskCheckpointService;
  private readonly methodExecution: MethodExecutionPort;

  constructor(options: ClassTaskRunnerOptions) {
    this.checkpoints = options.checkpoints;
    this.methodExecution = options.methodExecution;
  }

  async run(
    task: ClassTaskSnapshot,
    methodOrder: readonly string[],
    catalogIdentity: ClassTaskCatalogIdentity,
    signal: AbortSignal
  ): Promise<ClassTaskRunOutcome> {
    const progress = await this.checkpoints.prepareRun(task.id, {
      reset: false,
      catalogIdentity,
      resolvedMethodOrder: methodOrder
    });
    if (this.methodExecution.nextClassWave) {
      if (!this.methodExecution.executeWave) {
        throw new Error('Class Wave execution requires executeWave.');
      }
    } else if ((this.methodExecution.nextWave === undefined)
      !== (this.methodExecution.executeWave === undefined)) {
      throw new Error('Wave execution requires both nextWave and executeWave ports.');
    }
    const completedMethodIds = new Set(progress.completedMethodIds);
    const pendingMethodIds = methodOrder.filter((methodId) => !completedMethodIds.has(methodId));
    if (this.methodExecution.nextClassWave && this.methodExecution.executeWave) {
      return this.runClassWaves(task.id, methodOrder, catalogIdentity, signal);
    }
    let executionGroups: readonly (readonly string[])[] | null = null;
    if (this.methodExecution.nextWave && this.methodExecution.executeWave) {
      const waveProgress = await this.checkpoints.taskWaveProgress(task.id);
      if (
        !hasPersistedWaveExecution(waveProgress)
        && this.methodExecution.planExecutionGroups
        && this.methodExecution.executeGroup
      ) {
        const planned = await this.executionGroups(
          this.checkpoints.snapshot(task.id),
          pendingMethodIds,
          signal
        );
        if (
          planned.some((group) => group.length > 1)
          || (planned.length === 1 && planned[0].length === 1)
        ) {
          executionGroups = planned;
        }
      }
      if (executionGroups === null) {
        return this.runWaves(task.id, methodOrder, catalogIdentity, signal);
      }
    }
    executionGroups ??= await this.executionGroups(
      this.checkpoints.snapshot(task.id),
      pendingMethodIds,
      signal
    );
    for (const methodIds of executionGroups) {
      try {
        await this.checkpoints.waitIfPausedAtBoundary(task.id);
        this.checkpoints.throwIfTerminating(task.id);
        if (signal.aborted) throw signal.reason;
        this.checkpoints.throwIfTerminating(task.id);
        const grouped = this.methodExecution.executeGroup
          && (
            methodIds.length > 1
            || Boolean(this.methodExecution.nextWave && this.methodExecution.executeWave)
          )
          ? await this.executeGroup(task.id, methodIds, signal)
          : false;
        if (grouped) {
          this.checkpoints.throwIfTerminating(task.id);
          if (signal.aborted) throw signal.reason;
          await this.checkpoints.commitMethods(task.id, methodIds, catalogIdentity);
          methodIds.forEach((methodId) => completedMethodIds.add(methodId));
          if (signal.aborted) throw signal.reason;
          this.checkpoints.throwIfTerminating(task.id);
          await this.methodExecution.formalizeCompletedMethods?.(
            this.checkpoints.snapshot(task.id),
            methodIds,
            signal
          );
          if (await this.checkpoints.pauseAtBoundary(task.id)) return 'PAUSED';
          continue;
        }
        if (this.methodExecution.nextWave && this.methodExecution.executeWave) {
          return this.runWaves(task.id, methodOrder, catalogIdentity, signal);
        }
        for (const methodId of methodIds) {
          const currentTask = this.checkpoints.snapshot(task.id);
          const checkpoint = await this.checkpoints.methodCheckpoint(task.id, methodId);
          if (signal.aborted) throw signal.reason;
          this.checkpoints.throwIfTerminating(task.id);
          await this.methodExecution.execute(currentTask, methodId, checkpoint, signal);
          this.checkpoints.throwIfTerminating(task.id);
          await this.checkpoints.commitMethod(task.id, methodId, catalogIdentity);
          completedMethodIds.add(methodId);
          if (signal.aborted) throw signal.reason;
          this.checkpoints.throwIfTerminating(task.id);
          await this.methodExecution.formalizeCompletedMethods?.(
            this.checkpoints.snapshot(task.id),
            [methodId],
            signal
          );
          if (await this.checkpoints.pauseAtBoundary(task.id)) return 'PAUSED';
        }
      } catch (error) {
        if (error instanceof ClassTaskPausedAtBoundaryError) return 'PAUSED';
        throw error;
      }
    }
    if (await this.checkpoints.pauseAtBoundary(task.id)) return 'PAUSED';
    if (signal.aborted) throw signal.reason;
    this.checkpoints.throwIfTerminating(task.id);
    const finalizeRun = this.methodExecution.finalizeRun?.bind(this.methodExecution);
    await finalizeRun?.(this.checkpoints.snapshot(task.id), methodOrder, signal);
    if (signal.aborted) throw signal.reason;
    this.checkpoints.throwIfTerminating(task.id);
    if (finalizeRun && this.checkpoints.snapshot(task.id).generatedArtifacts.length === 0) {
      return 'NO_FORMAL_TEST_FILE';
    }
    return 'COMPLETED';
  }

  private async runClassWaves(
    taskId: string,
    methodOrder: readonly string[],
    catalogIdentity: ClassTaskCatalogIdentity,
    signal: AbortSignal
  ): Promise<ClassTaskRunOutcome> {
    const nextClassWave = this.methodExecution.nextClassWave?.bind(this.methodExecution);
    const executeWave = this.methodExecution.executeWave?.bind(this.methodExecution);
    if (!nextClassWave || !executeWave) {
      throw new Error('Class Wave execution ports are unavailable.');
    }
    for (;;) {
      try {
        await this.checkpoints.waitIfPausedAtBoundary(taskId);
        this.throwIfStopped(taskId, signal);
        let waveState = await this.checkpoints.taskWaveProgress(taskId);
        let ownerMethodId = waveState.activeMethodId;
        if (ownerMethodId === null) {
          ownerMethodId = await this.checkpoints.dequeueMethodWave(taskId);
          if (ownerMethodId === null) break;
          waveState = await this.checkpoints.taskWaveProgress(taskId);
        }
        const pendingMethodIds = [ownerMethodId, ...waveState.methodQueue];
        const request: ClassScenarioWaveRequest = {
          reportPairId: catalogIdentity.reportPairId,
          methods: pendingMethodIds.map((methodId) => {
            const progress = waveState.methods[methodId] ?? emptyWaveProgress();
            return {
              methodId,
              ...processedScenarioLedger(progress)
            };
          }),
          maxScenarios: 25,
          partSize: 5
        };
        const wave = waveState.activeWave?.wave
          ? structuredClone(waveState.activeWave.wave)
          : await nextClassWave(this.checkpoints.snapshot(taskId), request, signal);
        if (!('selectedMethodIds' in wave)) {
          throw new Error('Persisted single-method Wave cannot resume as a class Wave.');
        }
        const classWave = wave as ClassScenarioWaveResponse;
        this.throwIfStopped(taskId, signal);
        const planningIncomplete = classWave.warnings.some(
          (warning) => warning.code === 'SCENARIO_PLANNING_INCOMPLETE'
        );
        const searchPending = classWave.warnings.some(
          (warning) => warning.code === 'SCENARIO_SEARCH_PENDING'
        );
        if (!classWave.hasWork) {
          if (waveState.activeWave !== null) {
            throw new Error('Analyzer returned no work for a persisted active class Wave.');
          }
          await this.checkpoints.completeClassMethodsWithoutWave(
            taskId,
            classWave.completedMethodIds
          );
          for (const methodId of classWave.completedMethodIds) {
            await this.checkpoints.commitWaveMethod(taskId, methodId, catalogIdentity);
          }
          if (planningIncomplete) {
            await this.checkpoints.requestPause(taskId);
            await this.checkpoints.pauseAtBoundary(taskId);
            return 'PAUSED';
          }
          if (searchPending) {
            await this.checkpoints.requeueActiveMethodSearch(taskId, ownerMethodId);
            if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
            continue;
          }
          if (!classWave.completedMethodIds.includes(ownerMethodId)) {
            throw new Error('Analyzer returned no class work without completing or deferring the owner method.');
          }
          if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
          continue;
        }
        if (classWave.methodId !== ownerMethodId) {
          throw new Error('Analyzer class Wave owner does not match the dequeued method.');
        }
        const ownerProgress = waveState.methods[ownerMethodId] ?? emptyWaveProgress();
        const activeWave = this.activeWaveCheckpoint(classWave, ownerProgress.nextWaveIndex);
        if (waveState.activeWave) {
          this.assertRecoveredWaveIdentity(waveState.activeWave, activeWave);
          if (!waveState.activeWave.wave) {
            await this.checkpoints.saveActiveMethodWave(taskId, {
              ...waveState.activeWave,
              wave: structuredClone(classWave)
            });
          }
        } else {
          await this.checkpoints.saveActiveMethodWave(taskId, activeWave);
        }
        const persisted = (await this.checkpoints.taskWaveProgress(taskId)).activeWave;
        if (!persisted) throw new Error('Active class Wave checkpoint disappeared before execution.');
        const outcome = await executeWave(
          this.checkpoints.snapshot(taskId),
          classWave,
          await this.checkpoints.methodCheckpoint(taskId, ownerMethodId),
          persisted,
          signal
        );
        this.throwIfStopped(taskId, signal);
        if (outcome.modelFailure) {
          await this.checkpoints.recordModelFailure(taskId, outcome.modelFailure);
          throw new MethodGenerationRequestError(
            outcome.modelFailure.code,
            outcome.modelFailure.message
          );
        }
        const bundles = outcome.bundles ?? (outcome.bundle ? [outcome.bundle] : []);
        if (outcome.candidateIds.length > 0 && bundles.length === 0) {
          throw new Error('Passing class Wave candidates must provide formalization bundles.');
        }
        if (outcome.bundles) {
          if (!this.methodExecution.formalizeWaveGroup) {
            throw new Error('Passing class Wave candidate group cannot be formalized.');
          }
          await this.methodExecution.formalizeWaveGroup(
            this.checkpoints.snapshot(taskId),
            bundles,
            outcome.candidateIds,
            signal
          );
        } else for (const bundle of bundles) {
          if (!this.methodExecution.formalizeWave) {
            throw new Error('Passing class Wave candidate cannot be formalized.');
          }
          await this.methodExecution.formalizeWave(
            this.checkpoints.snapshot(taskId),
            bundle,
            signal
          );
        }
        await this.checkpoints.commitActiveClassWave(taskId, {
          waveId: classWave.waveBatchId,
          completedScenarioIds: outcome.completedScenarioIds,
          skippedScenarioIds: outcome.skippedScenarioIds,
          remainingScenarioCount: classWave.remainingScenarioCount,
          candidateIds: outcome.candidateIds,
          planningIncomplete
        });
        if (planningIncomplete && classWave.remainingScenarioCount === 0) {
          await this.checkpoints.requestPause(taskId);
          await this.checkpoints.pauseAtBoundary(taskId);
          return 'PAUSED';
        }
        for (const methodId of classWave.completedMethodIds) {
          await this.checkpoints.commitWaveMethod(taskId, methodId, catalogIdentity);
        }
        if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
      } catch (error) {
        if (error instanceof ClassTaskPausedAtBoundaryError) return 'PAUSED';
        throw error;
      }
    }
    if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
    this.throwIfStopped(taskId, signal);
    const finalizeRun = this.methodExecution.finalizeRun?.bind(this.methodExecution);
    await finalizeRun?.(this.checkpoints.snapshot(taskId), methodOrder, signal);
    this.throwIfStopped(taskId, signal);
    if (finalizeRun && this.checkpoints.snapshot(taskId).generatedArtifacts.length === 0) {
      return 'NO_FORMAL_TEST_FILE';
    }
    return 'COMPLETED';
  }

  private async runWaves(
    taskId: string,
    methodOrder: readonly string[],
    catalogIdentity: ClassTaskCatalogIdentity,
    signal: AbortSignal
  ): Promise<ClassTaskRunOutcome> {
    const nextWave = this.methodExecution.nextWave?.bind(this.methodExecution);
    const executeWave = this.methodExecution.executeWave?.bind(this.methodExecution);
    if (!nextWave || !executeWave) {
      throw new Error('Wave execution ports are unavailable.');
    }
    for (;;) {
      try {
        await this.checkpoints.waitIfPausedAtBoundary(taskId);
        this.throwIfStopped(taskId, signal);
        let waveState = await this.checkpoints.taskWaveProgress(taskId);
        let methodId = waveState.activeMethodId;
        if (methodId === null) {
          methodId = await this.checkpoints.dequeueMethodWave(taskId);
          if (methodId === null) break;
          waveState = await this.checkpoints.taskWaveProgress(taskId);
        }
        this.throwIfStopped(taskId, signal);
        const methodProgress = waveState.methods[methodId] ?? {
          completedScenarioIds: [],
          skippedScenarioIds: [],
          nextWaveIndex: 1,
          remainingScenarioCount: null,
          completedWaves: []
        };
        const wave = waveState.activeWave?.wave
          ? structuredClone(waveState.activeWave.wave)
          : await nextWave(
              this.checkpoints.snapshot(taskId),
              methodId,
              {
                reportPairId: catalogIdentity.reportPairId,
                ...processedScenarioLedger(methodProgress),
                maxScenarios: 25,
                partSize: 5
              },
              signal
            );
        this.throwIfStopped(taskId, signal);
        const planningIncomplete = wave.warnings.some(
          (warning) => warning.code === 'SCENARIO_PLANNING_INCOMPLETE'
        );
        if (!wave.hasWork) {
          if (waveState.activeWave !== null) {
            throw new Error('Analyzer returned no work for a persisted active Wave.');
          }
          if (planningIncomplete) {
            // 没有可恢复DFS时不能无限重排空缓存，也不能把未规划目标当成方法完成。
            await this.checkpoints.requestPause(taskId);
            await this.checkpoints.pauseAtBoundary(taskId);
            return 'PAUSED';
          }
          if (wave.warnings.some((warning) => warning.code === 'SCENARIO_SEARCH_PENDING')) {
            await this.checkpoints.requeueActiveMethodSearch(taskId, methodId);
            if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
            continue;
          }
          await this.checkpoints.completeActiveMethodWithoutWave(taskId, methodId);
          await this.checkpoints.commitWaveMethod(taskId, methodId, catalogIdentity);
          if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
          continue;
        }
        if (wave.methodId !== methodId) {
          throw new Error('Analyzer Wave identity does not match the dequeued method.');
        }
        const activeWave = this.activeWaveCheckpoint(
          wave,
          methodProgress.nextWaveIndex
        );
        if (waveState.activeWave) {
          this.assertRecoveredWaveIdentity(waveState.activeWave, activeWave);
          if (!waveState.activeWave.wave) {
            await this.checkpoints.saveActiveMethodWave(taskId, {
              ...waveState.activeWave,
              wave: structuredClone(wave)
            });
          }
        } else {
          await this.checkpoints.saveActiveMethodWave(taskId, activeWave);
        }
        const persistedActiveWave = (await this.checkpoints.taskWaveProgress(taskId)).activeWave;
        if (!persistedActiveWave) {
          throw new Error('Active Wave checkpoint disappeared before execution.');
        }
        const outcome = await executeWave(
          this.checkpoints.snapshot(taskId),
          wave,
          await this.checkpoints.methodCheckpoint(taskId, methodId),
          persistedActiveWave,
          signal
        );
        this.throwIfStopped(taskId, signal);
        if (outcome.modelFailure) {
          await this.checkpoints.recordModelFailure(taskId, outcome.modelFailure);
          this.throwIfStopped(taskId, signal);
          throw new MethodGenerationRequestError(
            outcome.modelFailure.code,
            outcome.modelFailure.message
          );
        }
        if (outcome.bundle) {
          assertWaveBundleIdentity(outcome.bundle, persistedActiveWave, outcome.candidateIds);
          if (!this.methodExecution.formalizeWave) {
            throw new Error('Passing Wave candidate cannot be formalized.');
          }
          await this.methodExecution.formalizeWave(
            this.checkpoints.snapshot(taskId),
            outcome.bundle,
            signal
          );
          this.throwIfStopped(taskId, signal);
        } else if (outcome.candidateIds.length > 0) {
          throw new Error('Passing Wave candidates must provide a formalization bundle.');
        }
        const pauseForPlanning = planningIncomplete && wave.remainingScenarioCount === 0;
        await this.checkpoints.commitActiveMethodWave(taskId, {
          waveId: wave.waveBatchId,
          completedScenarioIds: outcome.completedScenarioIds,
          skippedScenarioIds: outcome.skippedScenarioIds,
          remainingScenarioCount: wave.remainingScenarioCount,
          candidateIds: outcome.candidateIds,
          planningIncomplete: pauseForPlanning
        });
        if (pauseForPlanning) {
          // 已有成稿都执行并提交后再暂停；方法保持未完成，恢复时不会重跑已提交Wave。
          await this.checkpoints.requestPause(taskId);
          await this.checkpoints.pauseAtBoundary(taskId);
          return 'PAUSED';
        }
        if (wave.remainingScenarioCount === 0) {
          await this.checkpoints.commitWaveMethod(taskId, methodId, catalogIdentity);
        }
        if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
      } catch (error) {
        if (error instanceof ClassTaskPausedAtBoundaryError) return 'PAUSED';
        throw error;
      }
    }
    if (await this.checkpoints.pauseAtBoundary(taskId)) return 'PAUSED';
    this.throwIfStopped(taskId, signal);
    const finalizeRun = this.methodExecution.finalizeRun?.bind(this.methodExecution);
    await finalizeRun?.(this.checkpoints.snapshot(taskId), methodOrder, signal);
    this.throwIfStopped(taskId, signal);
    if (finalizeRun && this.checkpoints.snapshot(taskId).generatedArtifacts.length === 0) {
      return 'NO_FORMAL_TEST_FILE';
    }
    return 'COMPLETED';
  }

  private activeWaveCheckpoint(
    wave: SingleMethodWorkWave | ClassScenarioWorkWave,
    waveIndex: number
  ): ActiveMethodWaveCheckpoint {
    return {
      waveId: wave.waveBatchId,
      waveSessionId: null,
      recoveryRequestId: null,
      eventSequence: 0,
      startRequest: null,
      methodId: wave.methodId,
      waveIndex,
      selectedScenarioIds: [...wave.selectedScenarioIds],
      remainingScenarioCount: wave.remainingScenarioCount,
      wave: structuredClone(wave),
      initialUsageRecorded: false,
      parts: wave.parts.map((part) => ({
        partIndex: part.partIndex,
        partBatchId: part.partBatchId,
        scenarioIds: [...part.scenarioIds],
        status: 'PENDING',
        eventSequence: 0,
        childSessionId: null,
        candidateId: null,
        isolatedFilePath: null,
        fileSha256: null,
        failureReason: null,
        aggregateUsage: null,
        modelCallCount: 0,
        usageReportedCallCount: 0
      }))
    };
  }

  private assertRecoveredWaveIdentity(
    persisted: ActiveMethodWaveCheckpoint,
    current: ActiveMethodWaveCheckpoint
  ): void {
    if (
      persisted.waveId !== current.waveId
      || persisted.methodId !== current.methodId
      || persisted.waveIndex !== current.waveIndex
      || JSON.stringify(persisted.selectedScenarioIds)
        !== JSON.stringify(current.selectedScenarioIds)
      || persisted.parts.length !== current.parts.length
      || persisted.parts.some((part, index) => (
        part.partIndex !== current.parts[index].partIndex
        || part.partBatchId !== current.parts[index].partBatchId
        || JSON.stringify(part.scenarioIds) !== JSON.stringify(current.parts[index].scenarioIds)
      ))
    ) {
      throw new Error('Recovered Analyzer Wave identity changed.');
    }
  }

  private throwIfStopped(taskId: string, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.checkpoints.throwIfTerminating(taskId);
  }

  private async executionGroups(
    task: ClassTaskSnapshot,
    pendingMethodIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly (readonly string[])[]> {
    if (pendingMethodIds.length === 0) return [];
    const planned = this.methodExecution.planExecutionGroups
      ? await this.methodExecution.planExecutionGroups(task, pendingMethodIds, signal)
      : pendingMethodIds.map((methodId) => [methodId]);
    const flattened = planned.flatMap((group) => [...group]);
    if (
      planned.some((group) => group.length === 0)
      || flattened.length !== pendingMethodIds.length
      || flattened.some((methodId, index) => methodId !== pendingMethodIds[index])
      || new Set(flattened).size !== flattened.length
    ) {
      throw new Error('Method execution groups must partition the pending method order exactly.');
    }
    return planned.map((group) => [...group]);
  }

  private async executeGroup(
    taskId: string,
    methodIds: readonly string[],
    signal: AbortSignal
  ): Promise<boolean> {
    const checkpoints = Object.fromEntries(await Promise.all(methodIds.map(async (methodId) => (
      [methodId, await this.checkpoints.methodCheckpoint(taskId, methodId)] as const
    ))));
    if (signal.aborted) throw signal.reason;
    this.checkpoints.throwIfTerminating(taskId);
    return this.methodExecution.executeGroup?.(
      this.checkpoints.snapshot(taskId),
      methodIds,
      checkpoints,
      signal
    ) ?? false;
  }
}

function hasPersistedWaveExecution(wave: ClassTaskWaveCheckpoint): boolean {
  return wave.activeMethodId !== null
    || wave.activeWave !== null
    || Object.keys(wave.methods).length > 0
    || Object.keys(wave.candidates).length > 0
    || wave.migrationInterrupted;
}

function processedScenarioLedger(
  progress: MethodWaveProgressCheckpoint
): Pick<MethodWaveProgressCheckpoint, 'completedScenarioIds' | 'skippedScenarioIds'> {
  const completedScenarioIds = [...progress.completedScenarioIds];
  const completed = new Set(completedScenarioIds);
  for (const wave of progress.completedWaves) {
    for (const scenarioId of wave.completedScenarioIds) {
      if (!completed.has(scenarioId)) {
        completed.add(scenarioId);
        completedScenarioIds.push(scenarioId);
      }
    }
  }

  const skippedScenarioIds: string[] = [];
  const skipped = new Set<string>();
  const historicalSkipped = progress.completedWaves.flatMap(
    (wave) => wave.skippedScenarioIds
  );
  for (const scenarioId of [...progress.skippedScenarioIds, ...historicalSkipped]) {
    if (!completed.has(scenarioId) && !skipped.has(scenarioId)) {
      skipped.add(scenarioId);
      skippedScenarioIds.push(scenarioId);
    }
  }
  return { completedScenarioIds, skippedScenarioIds };
}

function emptyWaveProgress() {
  return {
    completedScenarioIds: [] as string[],
    skippedScenarioIds: [] as string[],
    nextWaveIndex: 1,
    remainingScenarioCount: null as number | null,
    completedWaves: []
  };
}

function assertWaveBundleIdentity(
  bundle: MethodTestBundle,
  wave: ActiveMethodWaveCheckpoint,
  candidateIds: readonly string[]
): void {
  if (
    bundle.sourceMethodId !== wave.methodId
    || bundle.waveIndex !== wave.waveIndex
    || bundle.hasRemainingScenarios !== (wave.remainingScenarioCount > 0)
    || bundle.sourceBatchIds.length !== candidateIds.length
    || bundle.sourceBatchIds.some((candidateId, index) => candidateId !== candidateIds[index])
  ) {
    throw new Error('Passing Wave formalization bundle identity is inconsistent.');
  }
}
