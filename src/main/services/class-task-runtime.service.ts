import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, lstat, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  AcceptClassTaskRequest,
  AddClassTasksRequest,
  AddClassTasksResult,
  CheckClassTaskMethodsRequest,
  ClassMethodCatalog,
  CoverageTotals,
  ClassTaskMethodsFreshness,
  ClassTaskResultSnapshot,
  ClassTaskSnapshot,
  ExactCoverageCounts,
  GeneratedClassTaskArtifact,
  GetClassTaskMethodsRequest,
  GetClassTaskResultRequest,
  ListClassTasksRequest,
  PauseClassTaskRequest,
  RemoveClassTaskRequest,
  ReorderClassTasksRequest,
  ResumeClassTaskRequest,
  RetryModulePreloadRequest,
  RevokeClassTaskRequest,
  RunAllClassTasksRequest,
  RunClassTaskRequest,
  SaveMethodSelectionRequest,
  StopModulePreloadRequest,
  TerminateAllClassTasksRequest,
  TerminateClassTaskRequest,
  PublicTaskError
} from '../../shared/class-task-contracts.ts';
import { hasPendingClassTaskResult } from '../../shared/class-task-contracts.ts';
import { generatedResultMethodsFromArtifacts } from '../../shared/class-task-result-methods.ts';
import { modelCredentialEnvironmentVariables } from '../../shared/model-runtime-security.ts';
import type {
  BuildToolchainContext,
  MavenHomeDefaults,
  ModelCallLogSettings,
  ResolvedRagEmbeddingRuntime,
  ResolvedWorkstationModelRuntime,
  WorkstationBuildSettings,
  WorkstationModelInterfacesView
} from '../../shared/types.ts';
import {
  isJavaAnalyzerResponseTimeoutError,
  type AiClient
} from './ai-client.ts';
import { ClassCoverageLedgerService } from './class-coverage-ledger.service.ts';
import {
  ClassTaskCheckpointService,
  ClassTaskRegistryStateAdapter,
  type ActiveMethodWaveCheckpoint,
  type ClassTaskWaveCheckpoint,
  type ClassTaskRunCheckpoint,
  type MethodBatchCheckpoint,
  type MethodExecutionCheckpoint,
  type WaveCandidateCheckpoint
} from './class-task-checkpoint.service.ts';
import { ClassTaskFileTransactionService } from './class-task-file-transaction.service.ts';
import {
  ClassTaskRegistryService,
  type ClassTaskRegistryAddResult
} from './class-task-registry.service.ts';
import {
  ClassTaskRunnerService,
  type MethodExecutionPort,
  type MethodTestBundle,
  type MethodWaveExecutionOutcome
} from './class-task-runner.service.ts';
import {
  ClassTaskSchedulerService,
  type RunClassTaskSchedulerOptions,
  type TerminateAllClassTasksResult
} from './class-task-scheduler.service.ts';
import { ClassTaskStore } from './class-task.store.ts';
import { transitionClassTask } from './class-task-state-machine.ts';
import { FormalTestFilePackerService } from './formal-test-file-packer.service.ts';
import { DirectTestLocatorService } from './direct-test-locator.service.ts';
import { GeneratedTestFailurePrunerService } from './generated-test-failure-pruner.service.ts';
import { GeneratedTestNameReservationService } from './generated-test-name-reservation.service.ts';
import type { JacocoArtifactPair, JacocoArtifactsService } from './jacoco-artifacts.service.ts';
import type { MavenAnalysisContext, MavenAnalysisContextService } from './maven-analysis-context.service.ts';
import { MavenCandidateExecutorService } from './maven-candidate-executor.service.ts';
import {
  isMethodAnalysisResponseInvalidError,
  MethodAnalysisRequestError,
  type ClassScenarioWaveRequest,
  type ClassScenarioWaveResponse,
  type ClassScenarioWorkWave,
  type CreateMethodAnalysisSessionResponse,
  type MethodCatalogResponse,
  type SingleMethodWaveRequest,
  type SingleMethodWaveResponse,
  type SingleMethodWorkWave
} from './method-analysis-contract.ts';
import { MethodGenerationLogService } from './method-generation-log.service.ts';
import { MethodTestBundleMergerService } from './method-test-bundle-merger.service.ts';
import { MethodWavePartStoreService } from './method-wave-part-store.service.ts';
import { ModuleFingerprintService } from './module-fingerprint.service.ts';
import { ModuleIdentityService } from './module-identity.service.ts';
import { ModuleOperationLock } from './module-operation-lock.service.ts';
import {
  createExecutableModuleMavenReadyQueue,
  type ExecutableModuleMavenReadyQueue
} from './module-maven-ready-queue.service.ts';
import {
  type ModulePreloadSnapshot,
  ModulePreloadCacheStore
} from './module-preload-cache.store.ts';
import {
  ClassPreloadMavenFailureError,
  ModulePreloadCoordinator,
  ModulePreloadFailureError,
  ModulePreloadStoppedError
} from './module-preload-coordinator.service.ts';
import { sanitizePublicText } from './maven-command.ts';
import { SingleMethodGenerationService } from './single-method-generation.service.ts';
import type { ShellService } from './shell.service.ts';
import type { SurefireReportService } from './surefire-report.service.ts';
import { TaskJacocoSessionService, type TaskJacocoSessionContext } from './task-jacoco-session.service.ts';
import {
  isGeneratedTestExternallyModifiedError,
  type TestWriterService
} from './test-writer.service.ts';
import { extractBuildToolchainContext } from './build-toolchain-context.ts';
import {
  ClassTaskRagRunService,
  type ClassTaskRagRunResources,
  type ClassTaskRagRunServiceOptions
} from './class-task-rag-runtime.service.ts';
import type { RagIndexCoordinator } from './rag-index-coordinator.service.ts';
import { DataClassGenerationBatchService } from './data-class-generation-batch.service.ts';
import {
  ModuleJacocoReportTotalsService,
  type ModuleJacocoReportTotalsPort
} from './module-jacoco-report-totals.service.ts';

const RUN_ALL_ELIGIBLE_STATES = new Set<ClassTaskSnapshot['state']>([
  'READY', 'COMPLETED', 'TERMINATED', 'INTERRUPTED', 'FAILED', 'PAUSED'
]);
const ACTIVE_STATES = new Set<ClassTaskSnapshot['state']>([
  'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'
]);
const RELEASE_RUN_STATES = new Set<ClassTaskSnapshot['state']>([
  'COMPLETED', 'FAILED', 'TERMINATED'
]);
const DEFAULT_ANALYSIS_SESSION_HEARTBEAT_INTERVAL_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_ANALYSIS_RESPONSE_TIMEOUT_RETRY_INITIAL_DELAY_MILLISECONDS = 1_000;
const DEFAULT_ANALYSIS_RESPONSE_TIMEOUT_RETRY_MAX_DELAY_MILLISECONDS = 30_000;
const MAX_COVERAGE_ARTIFACT_REFRESH_RETRIES = 5;
const MAX_PUBLIC_TASK_ERROR_TEXT_LENGTH = 4_096;
const MAX_MANAGED_WAVE_CANDIDATE_BYTES = 1024 * 1024;
const PENDING_RESULT_MUST_BE_HANDLED_MESSAGE = '请先接受或撤回本次生成结果，再重新执行。';
const QUIESCE_ON_QUIT_STATES = new Set<ClassTaskSnapshot['state']>([
  'PRELOADING', ...ACTIVE_STATES
]);

export type ClassTaskRuntimeRegistryPort = {
  initialize(): Promise<ClassTaskSnapshot[]>;
  add(request: AddClassTasksRequest): Promise<ClassTaskRegistryAddResult>;
  remove(taskId: string): Promise<void>;
  reorder(workspaceRoot: string, taskIds: readonly string[]): Promise<ClassTaskSnapshot[]>;
  list(workspaceRoot?: string): ClassTaskSnapshot[];
  snapshot(taskId: string): ClassTaskSnapshot;
  save(snapshot: ClassTaskSnapshot): Promise<ClassTaskSnapshot>;
  saveSelection(
    taskId: string,
    selectionMode: SaveMethodSelectionRequest['selectionMode'],
    selectedMethodIds: readonly string[],
    methodOrder: readonly string[],
    ragEnabled: boolean,
    repairAttemptLimit: number | null,
    unlimitedRepair: boolean
  ): Promise<ClassTaskSnapshot>;
};

export type ClassTaskRuntimeSchedulerPort = {
  runTask(
    taskId: string,
    options?: RunClassTaskSchedulerOptions
  ): Promise<ClassTaskSnapshot>;
  requestPause(taskId: string): Promise<ClassTaskSnapshot>;
  pauseAtBoundaryAndWait(taskId: string): Promise<ClassTaskSnapshot>;
  runBackgroundOperationAtBoundary<T>(
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T>;
  resumeTask(taskId: string): Promise<ClassTaskSnapshot>;
  terminateTask(taskId: string): Promise<ClassTaskSnapshot>;
  interruptAll(): Promise<ClassTaskSnapshot[]>;
  terminateAll(): Promise<TerminateAllClassTasksResult>;
};

export type FailedRunRefreshResult = {
  refreshed: boolean;
  preserveCheckpoint: boolean;
};

type RestartClassTaskOptions = {
  discardPendingArtifacts?: boolean;
  resetGenerationCheckpoint?: boolean;
};

type RevokeClassTaskResultOptions = {
  preserveRun?: boolean;
};

export type ClassTaskRuntimeCoordinatorPort = {
  restore(snapshots: readonly ClassTaskSnapshot[]): Promise<void>;
  prepare(
    taskId: string,
    signal?: AbortSignal,
    options?: { forceReload?: boolean }
  ): Promise<ClassMethodCatalog>;
  isMethodCatalogCurrent(taskId: string, fingerprint: string): Promise<boolean>;
  peekPreparedMethodCatalog(taskId: string): ClassMethodCatalog | null;
  peekPreparedCoverageReport(taskId: string): {
    reportPath: string;
    reportPairId: string;
  } | null;
  refreshFailedRunIfStale?(taskId: string): Promise<FailedRunRefreshResult>;
  restart(
    taskId: string,
    signal?: AbortSignal,
    options?: RestartClassTaskOptions
  ): Promise<void>;
  finish(taskId: string, signal?: AbortSignal): Promise<void>;
  remove(taskId: string): Promise<void>;
  getResult(taskId: string): Promise<ClassTaskResultSnapshot | null>;
  accept(taskId: string): Promise<ClassTaskResultSnapshot>;
  revoke(
    taskId: string,
    options?: RevokeClassTaskResultOptions
  ): Promise<ClassTaskResultSnapshot>;
  retryClassPreload(taskId: string): Promise<void>;
  stopClassPreload(taskId: string): Promise<void>;
  refreshGenerationModel(taskId: string): Promise<void>;
  releaseRun(taskId: string): Promise<void>;
  abort(): Promise<void>;
};

export type ClassTaskRuntimeOptions = {
  registry: ClassTaskRuntimeRegistryPort;
  scheduler: ClassTaskRuntimeSchedulerPort;
  coordinator: ClassTaskRuntimeCoordinatorPort;
  reportTotals?: ModuleJacocoReportTotalsPort;
  recordTaskExecution?: () => Promise<void>;
  flushTaskState(): Promise<void>;
  flushPreloadCache(): Promise<void>;
  clock?: () => Date;
};

export type ProductionClassTaskRuntimeOptions = {
  storageDirectory: string;
  aiClient: Pick<
    AiClient,
    | 'createMethodAnalysisSession'
    | 'isJavaAnalyzerHealthy'
    | 'probeModelToolCalling'
    | 'heartbeatMethodAnalysisSession'
    | 'deleteMethodAnalysisSession'
    | 'classifyUnitTestTarget'
    | 'nextMethodBatch'
    | 'nextMethodWave'
    | 'nextClassScenarioWave'
    | 'getMethodRepairContext'
    | 'refreshMethodAnalysisCoverage'
    | 'startMethodGenerationStream'
    | 'recoverMethodGenerationStream'
    | 'prepareRagRepair'
    | 'releaseRagTaskRun'
    | 'resumeMethodGenerationStream'
    | 'acknowledgeMethodGenerationEvents'
    | 'cancelMethodGeneration'
    | 'streamMethodGenerationWave'
    | 'resumeMethodGenerationWaveStream'
    | 'recoverMethodGenerationWaveStream'
    | 'acknowledgeMethodGenerationWaveEvents'
    | 'cancelMethodGenerationWave'
    | 'generateUnitTestPrompt'
    | 'generateTargetJacocoReport'
  >;
  shellService: Pick<
    ShellService,
    | 'validateBuildSettings'
    | 'runMavenCompile'
    | 'runMavenModuleTestsWithJacoco'
    | 'runMavenDirectTestsWithJacoco'
    | 'runMavenGeneratedTestCompile'
    | 'runMavenGeneratedSurefireTest'
    | 'runMavenDirectTestsWithJacocoAppend'
  >;
  mavenAnalysisContextService: Pick<MavenAnalysisContextService, 'collect'>;
  testWriterService: TestWriterService;
  jacocoArtifactsService: JacocoArtifactsService;
  surefireReportService: SurefireReportService;
  buildSettingsService: {
    get(): Promise<WorkstationBuildSettings | null>;
    resolveMavenHomeDefaults?(mavenHome: string): Promise<MavenHomeDefaults>;
  };
  modelInterfacesService: {
    getView(): Promise<WorkstationModelInterfacesView>;
    resolveForGeneration(): Promise<ResolvedWorkstationModelRuntime>;
  };
  ragEmbeddingInterfacesService?: {
    resolveRuntime(): Promise<ResolvedRagEmbeddingRuntime | null>;
  };
  modelCallLogSettingsService: { get(): Promise<ModelCallLogSettings> };
  ragIndexCoordinator?: Pick<
    RagIndexCoordinator,
    'subscribeInitial' | 'refresh' | 'releaseAll'
  >;
  ensureRagTaskKnowledge?: ClassTaskRagRunServiceOptions['knowledge']['ensureTaskKnowledge'];
  ragIndexWaitMilliseconds?: number;
  analysisSessionHeartbeatIntervalMilliseconds?: number;
  analysisResponseTimeoutRetryInitialDelayMilliseconds?: number;
  analysisResponseTimeoutRetryMaxDelayMilliseconds?: number;
  ragTelemetry?: (
    event: string,
    fields: Readonly<Record<string, string | number | null>>
  ) => void;
  broadcast(snapshot: ClassTaskSnapshot): void;
  recordTaskExecution?: () => Promise<void>;
  assertBackendReady?(): void;
  watcherVersion?(moduleKey: string): number;
  clock?: () => Date;
  idFactory?: () => string;
};

type PreparedTaskContext = {
  fingerprint: string;
  pair: JacocoArtifactPair;
  analysis: CreateMethodAnalysisSessionResponse;
  analysisInput: MavenAnalysisContext;
  catalog: ClassMethodCatalog;
  buildSettings: WorkstationBuildSettings;
  buildToolchain: BuildToolchainContext;
  jacoco: TaskJacocoSessionContext;
  excludedEnvironmentVariables: string[];
};

type TaskPreparation = {
  controller: AbortController;
  promise: Promise<ClassMethodCatalog>;
};

type ProductionTaskResources = ClassTaskRagRunResources & {
  taskId: string;
  acceptedArtifacts: GeneratedClassTaskArtifact[];
  transaction: ClassTaskFileTransactionService;
  restored: boolean;
  prepared: PreparedTaskContext | null;
  preparation: TaskPreparation | null;
  ownedAnalysisSessionIds: Set<string>;
  packer: FormalTestFilePackerService | null;
  generator: SingleMethodGenerationService | null;
  batchGenerator: DataClassGenerationBatchService | null;
  logs: MethodGenerationLogService;
  loggingPromise: Promise<ModelCallLogSettings> | null;
  jacocoInitialized: boolean;
  coverageArtifactSha256ById: Map<string, string>;
};

type ProductionCoordinatorDependencies = {
  options: ProductionClassTaskRuntimeOptions;
  registry: ClassTaskRegistryStateAdapter;
  checkpoints: ClassTaskCheckpointService;
  identity: ModuleIdentityService;
  fingerprint: ModuleFingerprintService;
  preloadCache: ModulePreloadCacheStore;
  preload: ModulePreloadCoordinator;
  moduleLock: ModuleOperationLock;
  mavenReadyQueue: ExecutableModuleMavenReadyQueue;
  fileReservations: GeneratedTestNameReservationService;
  maven: MavenCandidateExecutorService;
  pruner: GeneratedTestFailurePrunerService;
  bundleMerger: MethodTestBundleMergerService;
  ragRuns: ClassTaskRagRunService;
  coverageLedger: ClassCoverageLedgerService;
  jacoco: TaskJacocoSessionService;
  clock: () => Date;
  idFactory: () => string;
};

/** Narrow main-process facade used by the secure class-task IPC module. */
export class ClassTaskRuntimeService {
  private readonly registry: ClassTaskRuntimeRegistryPort;
  private readonly scheduler: ClassTaskRuntimeSchedulerPort;
  private readonly coordinator: ClassTaskRuntimeCoordinatorPort;
  private readonly reportTotals: ModuleJacocoReportTotalsPort;
  private readonly recordTaskExecution: () => Promise<void>;
  private readonly flushTaskState: () => Promise<void>;
  private readonly flushPreloadCache: () => Promise<void>;
  private readonly clock: () => Date;
  private readonly preparations = new Set<Promise<unknown>>();
  private startupPromise: Promise<ClassTaskSnapshot[]> | null = null;
  private quitPromise: Promise<void> | null = null;

  constructor(options: ClassTaskRuntimeOptions) {
    this.registry = options.registry;
    this.scheduler = options.scheduler;
    this.coordinator = options.coordinator;
    this.reportTotals = options.reportTotals ?? new ModuleJacocoReportTotalsService();
    this.recordTaskExecution = options.recordTaskExecution ?? (async () => undefined);
    this.flushTaskState = options.flushTaskState;
    this.flushPreloadCache = options.flushPreloadCache;
    this.clock = options.clock ?? (() => new Date());
  }

  startup(): Promise<ClassTaskSnapshot[]> {
    if (!this.startupPromise) {
      this.startupPromise = this.initialize();
    }
    return this.startupPromise.then(detached);
  }

  async addClassTasks(request: AddClassTasksRequest): Promise<AddClassTasksResult> {
    this.assertRunning();
    const result = await this.registry.add(request);
    for (const taskId of result.addedTaskIds) {
      this.trackPreparation(this.coordinator.prepare(taskId));
    }
    return result.snapshots.map(detached);
  }

  async removeClassTask(request: RemoveClassTaskRequest): Promise<void> {
    this.assertRunning();
    const task = this.findTask(request.workspaceRoot, request.taskId);
    if (!task) return;
    if (ACTIVE_STATES.has(task.state)) await this.scheduler.terminateTask(task.id);
    await this.coordinator.remove(task.id);
    await this.registry.remove(task.id);
  }

  async reorderClassTasks(request: ReorderClassTasksRequest): Promise<ClassTaskSnapshot[]> {
    this.assertRunning();
    return (await this.registry.reorder(request.workspaceRoot, request.taskIds)).map(detached);
  }

  listClassTasks(request: ListClassTasksRequest): Promise<ClassTaskSnapshot[]> {
    this.assertRunning();
    return Promise.resolve(this.registry.list(request.workspaceRoot).map(detached));
  }

  async getClassTaskMethods(request: GetClassTaskMethodsRequest): Promise<ClassMethodCatalog> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    if (task.state === 'PRELOAD_FAILED') {
      await this.coordinator.retryClassPreload(request.taskId);
      const retried = this.requireTask(request.workspaceRoot, request.taskId);
      if (retried.state === 'PRELOAD_FAILED') {
        throw new Error(retried.lastError?.message || '当前类重新检测失败。');
      }
    }
    const catalog = await this.coordinator.prepare(
      request.taskId,
      undefined,
      request.forceReload ? { forceReload: true } : undefined
    );
    return this.withModuleReportTotals(task, catalog);
  }

  async checkClassTaskMethods(
    request: CheckClassTaskMethodsRequest
  ): Promise<ClassTaskMethodsFreshness> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    const preparedCatalog = ACTIVE_STATES.has(task.state)
      ? this.coordinator.peekPreparedMethodCatalog(request.taskId)
      : null;
    if (preparedCatalog?.fingerprint === request.fingerprint) {
      return {
        current: true,
        catalog: await this.withModuleReportTotals(task, preparedCatalog)
      };
    }
    const current = await this.coordinator.isMethodCatalogCurrent(
      request.taskId,
      request.fingerprint
    );
    const catalog = current
      ? preparedCatalog ?? this.coordinator.peekPreparedMethodCatalog(request.taskId)
      : null;
    return catalog
      ? { current, catalog: await this.withModuleReportTotals(task, catalog) }
      : { current };
  }

  async saveMethodSelection(request: SaveMethodSelectionRequest): Promise<ClassTaskSnapshot> {
    this.assertRunning();
    this.requireTask(request.workspaceRoot, request.taskId);
    const catalog = await this.coordinator.prepare(request.taskId);
    validateSelection(request, catalog);
    return this.registry.saveSelection(
      request.taskId,
      request.selectionMode,
      request.selectedMethodIds,
      request.methodOrder,
      request.ragEnabled,
      request.repairAttemptLimit,
      request.unlimitedRepair
    );
  }

  private async withModuleReportTotals(
    task: ClassTaskSnapshot,
    catalog: ClassMethodCatalog
  ): Promise<ClassMethodCatalog> {
    const preparedReport = this.coordinator.peekPreparedCoverageReport(task.id);
    const reportCoverageTotals = preparedReport
      ? preparedReport.reportPairId === catalog.reportPairId
        ? await this.reportTotals.readReport(
            preparedReport.reportPath,
            task.qualifiedClassName
          )
        : null
      : await this.reportTotals.read(
          task.moduleDisplayPath,
          task.qualifiedClassName
        );
    return detached({
      ...catalog,
      ...(reportCoverageTotals
        ? { reportCoverageTotals: detached(reportCoverageTotals) as CoverageTotals }
        : {})
    });
  }

  async runTask(request: RunClassTaskRequest): Promise<ClassTaskSnapshot> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    if (hasPendingClassTaskResult(task)) {
      throw new Error(PENDING_RESULT_MUST_BE_HANDLED_MESSAGE);
    }
    requireSelectedMethods(task);
    try {
      let currentTask = task;
      let preserveCheckpoint = false;
      if (task.state === 'FAILED') {
        const refresh = await this.coordinator.refreshFailedRunIfStale?.(task.id) ?? {
          refreshed: false,
          preserveCheckpoint: false
        };
        currentTask = this.registry.snapshot(task.id);
        if (refresh.refreshed) {
          if (currentTask.state === 'PRELOAD_FAILED') return detached(currentTask);
        } else if (requiresFreshGenerationAfterFailure(currentTask.lastError?.code)) {
          await this.coordinator.restart(task.id, undefined, {
            resetGenerationCheckpoint: true
          });
          currentTask = this.registry.snapshot(task.id);
        }
        preserveCheckpoint = refresh.preserveCheckpoint;
      }
      if (currentTask.state === 'TERMINATED' || currentTask.state === 'COMPLETED') {
        await this.coordinator.restart(task.id);
      }
      await this.recordTaskExecutionSafely();
      const snapshot = await this.scheduler.runTask(
        request.taskId,
        preserveCheckpoint ? { preserveCheckpoint: true } : undefined
      );
      if (snapshot.state === 'COMPLETED') await this.coordinator.finish(request.taskId);
      if (RELEASE_RUN_STATES.has(snapshot.state)) {
        await this.coordinator.releaseRun(request.taskId);
      }
      return detached(this.registry.snapshot(request.taskId));
    } catch (error) {
      await this.coordinator.releaseRun(request.taskId);
      throw error;
    }
  }

  private async recordTaskExecutionSafely(): Promise<void> {
    try {
      await this.recordTaskExecution();
    } catch {
      console.error('[auth] 用户任务执行次数记录失败');
    }
  }

  async pauseTask(request: PauseClassTaskRequest): Promise<ClassTaskSnapshot> {
    this.assertRunning();
    this.requireTask(request.workspaceRoot, request.taskId);
    return detached(await this.scheduler.requestPause(request.taskId));
  }

  async resumeTask(request: ResumeClassTaskRequest): Promise<ClassTaskSnapshot> {
    this.assertRunning();
    this.requireTask(request.workspaceRoot, request.taskId);
    try {
      await this.coordinator.refreshGenerationModel(request.taskId);
      await this.recordTaskExecutionSafely();
      const snapshot = await this.scheduler.resumeTask(request.taskId);
      if (snapshot.state === 'COMPLETED') await this.coordinator.finish(request.taskId);
      if (RELEASE_RUN_STATES.has(snapshot.state)) {
        await this.coordinator.releaseRun(request.taskId);
      }
      return detached(this.registry.snapshot(request.taskId));
    } catch (error) {
      await this.coordinator.releaseRun(request.taskId);
      throw error;
    }
  }

  async terminateTask(request: TerminateClassTaskRequest): Promise<ClassTaskSnapshot> {
    this.assertRunning();
    this.requireTask(request.workspaceRoot, request.taskId);
    const snapshot = await this.scheduler.terminateTask(request.taskId);
    await this.coordinator.releaseRun(request.taskId);
    return detached(snapshot);
  }

  async runAll(request: RunAllClassTasksRequest): Promise<ClassTaskSnapshot[]> {
    this.assertRunning();
    const eligible = this.registry.list(request.workspaceRoot)
      .filter((task) => (
        RUN_ALL_ELIGIBLE_STATES.has(task.state)
        && hasSelectedMethods(task)
        && !hasPendingClassTaskResult(task)
      ));
    const settled = await Promise.allSettled(eligible.map((task) => {
      const command = {
        workspaceRoot: request.workspaceRoot,
        taskId: task.id
      };
      return task.state === 'PAUSED'
        ? this.resumeTask(command)
        : this.runTask(command);
    }));
    const currentById = new Map(
      this.registry.list(request.workspaceRoot).map((task) => [task.id, task])
    );
    return settled.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      const current = currentById.get(result.value.id);
      return current ? [detached(current)] : [];
    });
  }

  async terminateAll(request: TerminateAllClassTasksRequest): Promise<ClassTaskSnapshot[]> {
    this.assertRunning();
    const active = this.registry.list(request.workspaceRoot)
      .filter((task) => ACTIVE_STATES.has(task.state));
    const settled = await Promise.allSettled(active.map(async (task) => {
      const snapshot = await this.scheduler.terminateTask(task.id);
      await this.coordinator.releaseRun(task.id);
      return snapshot;
    }));
    return settled.flatMap((result) => result.status === 'fulfilled' ? [detached(result.value)] : []);
  }

  async getTaskResult(request: GetClassTaskResultRequest): Promise<ClassTaskResultSnapshot | null> {
    this.assertRunning();
    this.requireTask(request.workspaceRoot, request.taskId);
    const result = await this.coordinator.getResult(request.taskId);
    if (!result) return null;
    return detached(result);
  }

  async acceptTaskResult(request: AcceptClassTaskRequest): Promise<ClassTaskResultSnapshot> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    if (task.state === 'RUNNING' || task.state === 'PAUSE_REQUESTED') {
      return detached(await this.scheduler.runBackgroundOperationAtBoundary(
        task.id,
        () => this.coordinator.accept(request.taskId)
      ));
    }
    if (task.state !== 'PAUSED') await this.stopTaskForResultTransaction(task);
    return detached(await this.coordinator.accept(request.taskId));
  }

  async revokeTaskResult(request: RevokeClassTaskRequest): Promise<ClassTaskResultSnapshot> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    if (task.state === 'RUNNING' || task.state === 'PAUSE_REQUESTED') {
      return detached(await this.scheduler.runBackgroundOperationAtBoundary(
        task.id,
        () => this.coordinator.revoke(request.taskId, { preserveRun: true })
      ));
    }
    const preserveRun = task.state === 'PAUSED';
    if (!preserveRun) await this.stopTaskForResultTransaction(task);
    return detached(await this.coordinator.revoke(request.taskId, { preserveRun }));
  }

  async retryModulePreload(request: RetryModulePreloadRequest): Promise<void> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    await this.coordinator.retryClassPreload(task.id);
  }

  async stopModulePreload(request: StopModulePreloadRequest): Promise<void> {
    this.assertRunning();
    const task = this.requireTask(request.workspaceRoot, request.taskId);
    await this.coordinator.stopClassPreload(task.id);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.preparations]);
    await this.flushTaskState();
    await this.flushPreloadCache();
  }

  beforeQuit(): Promise<void> {
    if (!this.quitPromise) this.quitPromise = this.shutdown();
    return this.quitPromise;
  }

  private async initialize(): Promise<ClassTaskSnapshot[]> {
    const snapshots = await this.registry.initialize();
    await this.coordinator.restore(snapshots);
    const restoredSnapshots = this.registry.list();
    for (const snapshot of restoredSnapshots) {
      if (snapshot.state === 'PRELOADING') {
        this.trackPreparation(this.coordinator.prepare(snapshot.id));
      } else if (snapshot.state === 'PRELOAD_FAILED') {
        this.trackPreparation(this.coordinator.retryClassPreload(snapshot.id));
      }
    }
    return restoredSnapshots.map(detached);
  }

  private async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    let shutdownTargets: Array<{
      taskId: string;
      kind: 'PRELOAD' | 'GENERATION';
    }> = [];
    try {
      shutdownTargets = this.registry.list()
        .filter((task) => QUIESCE_ON_QUIT_STATES.has(task.state))
        .map((task) => ({
          taskId: task.id,
          kind: task.state === 'PRELOADING' ? 'PRELOAD' : 'GENERATION'
        }));
    } catch (error) {
      failures.push(error);
    }
    const cancellation = await Promise.allSettled([
      this.scheduler.interruptAll(),
      this.coordinator.abort()
    ]);
    for (const result of cancellation) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    const now = this.clock().toISOString();
    for (const target of shutdownTargets) {
      let current: ClassTaskSnapshot;
      try {
        current = this.registry.snapshot(target.taskId);
      } catch {
        continue;
      }
      try {
        if (target.kind === 'PRELOAD') {
          if (current.state !== 'PRELOADING') continue;
          await this.registry.save({
            ...current,
            preloadState: 'IDLE',
            currentAtomicStep: 'IDLE',
            activeGenerationBatch: null,
            startedAt: null,
            finishedAt: null,
            lastError: null,
            completionAttentionPending: false,
            updatedAt: now
          });
          continue;
        }
        await this.registry.save({
          ...current,
          state: 'INTERRUPTED',
          currentAtomicStep: 'IDLE',
          activeGenerationBatch: null,
          completionAttentionPending: false,
          finishedAt: now,
          updatedAt: now
        });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.flushTaskState();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.flushPreloadCache();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Class-task shutdown did not complete cleanly.');
    }
  }

  private requireTask(workspaceRoot: string, taskId: string): ClassTaskSnapshot {
    const task = this.registry.snapshot(taskId);
    if (pathKey(task.workspaceRoot) !== pathKey(workspaceRoot)) {
      throw new Error('Class task does not belong to the requested workspace.');
    }
    return task;
  }

  private findTask(workspaceRoot: string, taskId: string): ClassTaskSnapshot | null {
    const task = this.registry.list().find((candidate) => candidate.id === taskId) ?? null;
    if (task && pathKey(task.workspaceRoot) !== pathKey(workspaceRoot)) {
      throw new Error('Class task does not belong to the requested workspace.');
    }
    return task;
  }

  private trackPreparation(preparation: Promise<unknown>): void {
    const tracked = Promise.resolve(preparation).catch(() => undefined).finally(() => {
      this.preparations.delete(tracked);
    });
    this.preparations.add(tracked);
  }

  private assertRunning(): void {
    if (this.quitPromise) throw new Error('Class-task runtime is shutting down.');
  }

  private assertResultTransactionIdle(task: ClassTaskSnapshot): void {
    if (!this.isResultTransactionIdle(task)) {
      throw new Error(
        'The class task must be stopped before its result can be accepted or revoked.'
      );
    }
  }

  private async stopTaskForResultTransaction(task: ClassTaskSnapshot): Promise<void> {
    if (ACTIVE_STATES.has(task.state)) {
      await this.scheduler.terminateTask(task.id);
      await this.coordinator.releaseRun(task.id);
    }
    this.assertResultTransactionIdle(this.registry.snapshot(task.id));
  }

  private isResultTransactionIdle(task: ClassTaskSnapshot): boolean {
    return task.state !== 'PRELOADING' && !ACTIVE_STATES.has(task.state);
  }
}

class ClassTaskPreparationFailure extends Error {
  readonly publicError: PublicTaskError;

  constructor(publicError: PublicTaskError) {
    super(publicError.message);
    this.name = 'ClassTaskPreparationFailure';
    this.publicError = publicError;
  }
}

type PreparedBuildContext = {
  settings: WorkstationBuildSettings;
  toolchain: BuildToolchainContext;
  excludedEnvironmentVariables: string[];
};

export async function recoverPersistedWaveCandidateMoves(input: {
  taskId: string;
  workspaceRoot: string;
  candidates: Readonly<Record<string, WaveCandidateCheckpoint>>;
  transaction: Pick<ClassTaskFileTransactionService, 'recoverWaveCandidateMove'>;
  saveCandidate(
    candidate: WaveCandidateCheckpoint
  ): Promise<WaveCandidateCheckpoint>;
}): Promise<void> {
  for (const candidate of Object.values(input.candidates).sort((left, right) => (
    left.candidateId.localeCompare(right.candidateId)
  ))) {
    const move = candidate.moveTransaction;
    if (!move) continue;
    if (!candidate.managedFile || candidate.managedFile.sha256 !== move.sha256) {
      throw new Error('Wave candidate move journal has no matching managed file.');
    }
    const testClassName = basename(move.sourcePath, '.java');
    let recovered: Awaited<ReturnType<
      ClassTaskFileTransactionService['recoverWaveCandidateMove']
    >>;
    try {
      recovered = await input.transaction.recoverWaveCandidateMove({
        candidateId: candidate.candidateId,
        workspaceRoot: input.workspaceRoot,
        testClassName,
        sourcePath: move.sourcePath,
        targetPath: move.targetPath,
        sha256: move.sha256,
        phase: move.phase
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Wave candidate ${candidate.candidateId} move recovery failed: ${detail}`
      );
    }
    await input.saveCandidate({
      ...candidate,
      managedFile: {
        path: recovered.filePath,
        sha256: recovered.sha256,
        location: recovered.location
      },
      moveTransaction: null
    });
  }
}

async function isolatePersistedProjectWaveCandidates(input: {
  taskId: string;
  workspaceRoot: string;
  candidates: Readonly<Record<string, WaveCandidateCheckpoint>>;
  transaction: Pick<ClassTaskFileTransactionService, 'moveWaveCandidateFiles'>;
  saveCandidate(
    candidate: WaveCandidateCheckpoint
  ): Promise<WaveCandidateCheckpoint>;
}): Promise<void> {
  const pending = Object.values(input.candidates)
    .filter((candidate) => (
      candidate.status !== 'PASSED'
      && candidate.managedFile?.location === 'PROJECT'
    ))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  if (pending.length === 0) return;

  const reconciledPending: WaveCandidateCheckpoint[] = [];
  for (const candidate of pending) {
    const managed = candidate.managedFile as NonNullable<
      WaveCandidateCheckpoint['managedFile']
    >;
    const currentSha256 = await currentManagedWaveCandidateSha256(managed.path);
    if (currentSha256 === managed.sha256) {
      reconciledPending.push(candidate);
      continue;
    }
    reconciledPending.push(await input.saveCandidate({
      ...candidate,
      managedFile: {
        ...managed,
        sha256: currentSha256
      }
    }));
  }

  const currentById = new Map(
    reconciledPending.map((candidate) => [candidate.candidateId, candidate])
  );
  const transactions = await input.transaction.moveWaveCandidateFiles({
    moves: reconciledPending.map((candidate) => {
      const managed = candidate.managedFile as NonNullable<
        WaveCandidateCheckpoint['managedFile']
      >;
      const testClassName = basename(managed.path, '.java');
      return {
        candidateId: candidate.candidateId,
        workspaceRoot: input.workspaceRoot,
        testClassName,
        sourcePath: managed.path,
        targetPath: join(
          resolve(input.workspaceRoot),
          '.ai-unit-test',
          'method-wave-candidates',
          createHash('sha256').update(input.taskId, 'utf8').digest('hex').slice(0, 24),
          candidate.candidateId,
          `${testClassName}.java`
        ),
        sha256: managed.sha256
      };
    }),
    saveMoveTransactions: async (values) => {
      for (const value of values) {
        const current = currentById.get(value.candidateId);
        if (!current) {
          throw new Error('Wave candidate move transaction has no matching checkpoint.');
        }
        const moved = value.phase === 'MOVED';
        const saved = await input.saveCandidate({
          ...current,
          status: current.status === 'MAVEN_RUNNING'
            ? 'READY_FOR_MAVEN'
            : current.status,
          managedFile: {
            path: moved ? value.targetPath : value.sourcePath,
            sha256: value.sha256,
            location: moved ? 'ISOLATED' : 'PROJECT'
          },
          moveTransaction: {
            sourcePath: value.sourcePath,
            targetPath: value.targetPath,
            sha256: value.sha256,
            phase: value.phase
          }
        });
        currentById.set(value.candidateId, saved);
      }
    }
  });

  for (const transaction of transactions) {
    const current = currentById.get(transaction.candidateId);
    if (!current || transaction.phase !== 'MOVED') {
      throw new Error('Wave candidate isolation did not commit every managed file.');
    }
    const saved = await input.saveCandidate({
      ...current,
      managedFile: {
        path: transaction.targetPath,
        sha256: transaction.sha256,
        location: 'ISOLATED'
      },
      moveTransaction: null
    });
    currentById.set(transaction.candidateId, saved);
  }
}

async function isolateOrphanProjectWaveCandidates(input: {
  taskId: string;
  workspaceRoot: string;
  sourceFilePath: string;
  candidates: Readonly<Record<string, WaveCandidateCheckpoint>>;
  transaction: Pick<ClassTaskFileTransactionService, 'moveWaveCandidateFiles'>;
}): Promise<void> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const sourceFilePath = resolve(input.sourceFilePath);
  const sourceRelativePath = relative(workspaceRoot, sourceFilePath);
  if (
    sourceRelativePath === '..'
    || sourceRelativePath.startsWith(`..${sep}`)
    || isAbsolute(sourceRelativePath)
  ) {
    throw new Error('The class source file is outside its workspace.');
  }

  const sourceSegments = sourceRelativePath.split(/[\\/]+/);
  const sourceRootIndex = sourceSegments.findIndex((segment, index) => (
    segment.toLocaleLowerCase('en-US') === 'src'
    && sourceSegments[index + 1]?.toLocaleLowerCase('en-US') === 'main'
    && sourceSegments[index + 2]?.toLocaleLowerCase('en-US') === 'java'
  ));
  if (sourceRootIndex < 0 || sourceRootIndex + 3 >= sourceSegments.length) return;

  const packageSegments = sourceSegments.slice(sourceRootIndex + 3, -1);
  const testDirectory = resolve(
    workspaceRoot,
    ...sourceSegments.slice(0, sourceRootIndex),
    'src',
    'test',
    'java',
    ...packageSegments
  );
  const testRelativePath = relative(workspaceRoot, testDirectory);
  if (
    testRelativePath === '..'
    || testRelativePath.startsWith(`..${sep}`)
    || isAbsolute(testRelativePath)
  ) {
    throw new Error('The class test directory is outside its workspace.');
  }

  let entries: Dirent[];
  try {
    entries = await readdir(testDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }

  const sourceClassName = basename(sourceFilePath, '.java');
  const escapedSourceClassName = sourceClassName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const orphanNamePattern = new RegExp(
    `^${escapedSourceClassName}Tmp[1-9]\\d*Test\\.java$`
  );
  const checkpointOwnedProjectPaths = new Set(
    Object.values(input.candidates).flatMap((candidate) => (
      candidate.managedFile?.location === 'PROJECT'
        ? [pathKey(candidate.managedFile.path)]
        : []
    ))
  );
  const moves = [];
  const taskDirectory = createHash('sha256')
    .update(input.taskId, 'utf8')
    .digest('hex')
    .slice(0, 24);

  for (const entry of entries) {
    if (!entry.isFile() || !orphanNamePattern.test(entry.name)) continue;
    const sourcePath = resolve(testDirectory, entry.name);
    if (checkpointOwnedProjectPaths.has(pathKey(sourcePath))) continue;
    let sha256: string;
    try {
      sha256 = await currentManagedWaveCandidateSha256(sourcePath);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    const candidateId = randomUUID();
    moves.push({
      candidateId,
      workspaceRoot,
      testClassName: basename(entry.name, '.java'),
      sourcePath,
      targetPath: join(
        workspaceRoot,
        '.ai-unit-test',
        'orphan-wave-candidates',
        taskDirectory,
        candidateId,
        entry.name
      ),
      sha256
    });
  }

  for (let offset = 0; offset < moves.length; offset += 5) {
    await input.transaction.moveWaveCandidateFiles({
      moves: moves.slice(offset, offset + 5),
      async saveMoveTransactions() {
        // Orphans have no checkpoint owner. The atomic rename itself is durable:
        // a crash leaves each file either discoverable in src/test/java on the
        // next preload or preserved below orphan-wave-candidates.
      }
    });
  }
}

async function currentManagedWaveCandidateSha256(filePath: string): Promise<string> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.size < 1 || stat.size > MAX_MANAGED_WAVE_CANDIDATE_BYTES) {
    throw new Error('Managed Wave candidate must be a bounded regular file.');
  }
  const content = await readFile(filePath);
  if (content.length !== stat.size) {
    throw new Error('Managed Wave candidate changed while its identity was refreshed.');
  }
  return createHash('sha256').update(content).digest('hex');
}

class ProductionClassTaskCoordinator
implements ClassTaskRuntimeCoordinatorPort, MethodExecutionPort {
  private readonly dependencies: ProductionCoordinatorDependencies;
  private readonly resources = new Map<string, ProductionTaskResources>();
  private readonly partStore = new MethodWavePartStoreService();

  constructor(dependencies: ProductionCoordinatorDependencies) {
    this.dependencies = dependencies;
  }

  async restore(snapshots: readonly ClassTaskSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      const resources = this.resourceFor(snapshot.id);
      try {
        const progress = await this.dependencies.checkpoints.taskProgress(snapshot.id);
        if (progress.catalogIdentity?.analysisSessionId) {
          resources.ownedAnalysisSessionIds.add(
            progress.catalogIdentity.analysisSessionId
          );
        }
      } catch {
        // Restoring task ownership must not fail only because stale session cleanup is unavailable.
      }
      resources.acceptedArtifacts = snapshot.generatedArtifacts
        .filter((artifact) => artifact.accepted)
        .map(detached);
      const pendingArtifacts = snapshot.generatedArtifacts
        .filter((artifact) => !artifact.accepted)
        .map(detached);
      await resources.transaction.restoreTask({
        taskId: snapshot.id,
        workspaceRoot: snapshot.workspaceRoot,
        artifacts: pendingArtifacts
      });
      const waveState = await this.dependencies.checkpoints.taskWaveProgress(snapshot.id);
      try {
        await recoverPersistedWaveCandidateMoves({
          taskId: snapshot.id,
          workspaceRoot: snapshot.workspaceRoot,
          candidates: waveState.candidates,
          transaction: resources.transaction,
          saveCandidate: (candidate) => (
            this.dependencies.checkpoints.saveWaveCandidate(snapshot.id, candidate)
          )
        });
        const recoveredWaveState = await this.dependencies.checkpoints
          .taskWaveProgress(snapshot.id);
        await this.dependencies.moduleLock.runExclusive(
          snapshot.moduleKey,
          () => isolatePersistedProjectWaveCandidates({
            taskId: snapshot.id,
            workspaceRoot: snapshot.workspaceRoot,
            candidates: recoveredWaveState.candidates,
            transaction: resources.transaction,
            saveCandidate: (candidate) => (
              this.dependencies.checkpoints.saveWaveCandidate(snapshot.id, candidate)
            )
          })
        );
      } catch (error) {
        const current = this.dependencies.registry.snapshot(snapshot.id);
        const message = error instanceof Error ? error.message : String(error);
        const now = this.now();
        await this.dependencies.registry.save({
          ...current,
          state: 'INTERRUPTED',
          currentAtomicStep: 'IDLE',
          activeGenerationBatch: null,
          completionAttentionPending: false,
          finishedAt: now,
          lastError: this.publicError(
            current,
            'WAVE_CANDIDATE_MOVE_RECOVERY_FAILED',
            message
          ),
          updatedAt: now
        });
      }
      resources.restored = true;
    }
    await Promise.allSettled(
      [...this.resources.values()].map((resources) => (
        this.releaseOwnedAnalysisSessions(resources)
      ))
    );
  }

  async prepare(
    taskId: string,
    signal?: AbortSignal,
    options?: { forceReload?: boolean }
  ): Promise<ClassMethodCatalog> {
    if (signal?.aborted) throw signal.reason;
    const resources = this.resourceFor(taskId);
    if (options?.forceReload) {
      const task = this.dependencies.registry.snapshot(taskId);
      if (task.state === 'PRELOADING' || ACTIVE_STATES.has(task.state)) {
        throw new Error('当前类任务正在运行，暂时无法刷新方法与覆盖率信息。');
      }
      await this.resetPrepared(resources);
    }
    if (resources.prepared) return Promise.resolve(detached(resources.prepared.catalog));
    if (resources.preparation) {
      return waitForSharedPreparation(resources.preparation.promise, signal).then(detached);
    }

    const controller = new AbortController();
    const preparation = {} as TaskPreparation;
    preparation.controller = controller;
    resources.preparation = preparation;
    preparation.promise = Promise.resolve()
      .then(() => this.prepareTask(taskId, resources, preparation))
      .catch(async (error) => {
        if (!controller.signal.aborted || error instanceof ModulePreloadFailureError) {
          await this.recordPreparationFailure(taskId, error);
        }
        throw error;
      })
      .finally(() => {
        if (resources.preparation === preparation) resources.preparation = null;
      });
    return waitForSharedPreparation(preparation.promise, signal).then(detached);
  }

  async isMethodCatalogCurrent(taskId: string, fingerprint: string): Promise<boolean> {
    const resources = this.resourceFor(taskId);
    let task = this.dependencies.registry.snapshot(taskId);
    if (
      task.state !== 'PRELOADING'
      && !ACTIVE_STATES.has(task.state)
      && await this.reconcileUnavailableGeneratedArtifacts(task, resources)
    ) {
      return false;
    }
    task = this.dependencies.registry.snapshot(taskId);
    const controller = new AbortController();
    const build = await this.resolveBuildContext(task, controller.signal);
    const pendingArtifacts = resources.transaction.artifacts(taskId);
    const includeTaskOwnedArtifacts = shouldIncludeTaskOwnedArtifactsInFingerprint(task.state);
    const current = await this.dependencies.preload.calculateClassReportFingerprint({
      workspaceRoot: task.workspaceRoot,
      sourceFilePath: task.sourceFilePath,
      qualifiedClassName: task.qualifiedClassName,
      targetFilePath: task.sourceFilePath,
      buildSettings: build.settings,
      toolchain: build.toolchain,
      watcherVersion: this.watcherVersion(task.moduleKey),
      ownedArtifacts: includeTaskOwnedArtifacts
        ? []
        : pendingArtifacts.map((artifact) => ({
            path: artifact.filePath,
            sha256: artifact.sha256
          })),
      excludedDirectTestArtifacts: pendingArtifacts.map((artifact) => ({
        path: artifact.filePath,
        sha256: artifact.sha256
      }))
    }, controller.signal);
    if (
      resources.prepared &&
      resources.prepared.fingerprint !== current.sha256 &&
      !ACTIVE_STATES.has(task.state)
    ) {
      await this.resetPrepared(resources);
    }
    return current.sha256 === fingerprint;
  }

  peekPreparedMethodCatalog(taskId: string): ClassMethodCatalog | null {
    const prepared = this.resources.get(taskId)?.prepared;
    return prepared ? detached(prepared.catalog) : null;
  }

  peekPreparedCoverageReport(taskId: string): {
    reportPath: string;
    reportPairId: string;
  } | null {
    const prepared = this.resources.get(taskId)?.prepared;
    return prepared
      ? {
          reportPath: prepared.pair.reportPath,
          reportPairId: prepared.pair.pairId
        }
      : null;
  }

  async restart(
    taskId: string,
    _signal?: AbortSignal,
    options: RestartClassTaskOptions = {}
  ): Promise<void> {
    const resources = this.resourceFor(taskId);
    let task = this.dependencies.registry.snapshot(taskId);
    const failedRunModelUsage = task.state === 'FAILED'
      ? {
          tokenUsage: task.tokenUsage ? detached(task.tokenUsage) : null,
          modelCallCount: task.modelCallCount,
          usageReportedCallCount: task.usageReportedCallCount
        }
      : null;
    await this.reconcileUnavailableGeneratedArtifacts(task, resources);
    task = this.dependencies.registry.snapshot(taskId);
    const pendingArtifacts = resources.transaction.artifacts(taskId);
    const preservePendingFormalArtifacts = !options.discardPendingArtifacts
      && task.state === 'FAILED'
      && pendingArtifacts.length > 0;
    const resetGenerationCheckpoint = options.resetGenerationCheckpoint
      ?? !preservePendingFormalArtifacts;
    await this.resetPrepared(resources);
    await this.cleanupRestartTemporaryFiles(task);
    if (!preservePendingFormalArtifacts && pendingArtifacts.length > 0) {
      await resources.transaction.revoke(taskId, {
        protectedFilePaths: resources.acceptedArtifacts.map((artifact) => artifact.filePath)
      });
    }
    if (resetGenerationCheckpoint) {
      await this.partStore.clearTask(task.workspaceRoot, task.id);
    }
    await this.dependencies.checkpoints.prepareRun(taskId, {
      reset: resetGenerationCheckpoint,
      preserveModelUsage: failedRunModelUsage !== null
    });
    if (!preservePendingFormalArtifacts) {
      resources.transaction = this.createTransaction();
    }
    resources.restored = true;
    const current = this.dependencies.registry.snapshot(taskId);
    await this.dependencies.registry.save({
      ...current,
      currentMethodIndex: -1,
      currentAtomicStep: 'IDLE',
      activeGenerationBatch: null,
      generatedArtifacts: uniqueArtifacts([
        ...resources.acceptedArtifacts,
        ...(preservePendingFormalArtifacts ? pendingArtifacts : [])
      ]),
      coveredMethodIds: [],
      coverageBaseline: null,
      coverageCurrent: null,
      coverageContributions: [],
      completionAttentionPending: false,
      ...(failedRunModelUsage ?? {}),
      updatedAt: this.now()
    });
  }

  async refreshFailedRunIfStale(taskId: string): Promise<FailedRunRefreshResult> {
    const task = this.dependencies.registry.snapshot(taskId);
    if (task.state !== 'FAILED') {
      return { refreshed: false, preserveCheckpoint: false };
    }
    const progress = await this.dependencies.checkpoints.taskProgress(taskId);
    const methodOrderChanged = task.methodOrder.length !== progress.resolvedMethodOrder.length
      || task.methodOrder.some((methodId, index) => (
        progress.resolvedMethodOrder[index] !== methodId
      ));
    const coverageArtifactsStale = isRetryableCoverageArtifactTaskError(task.lastError);
    if (
      !methodOrderChanged
      && !coverageArtifactsStale
      && await this.failedRunRecoveryFilesExist(task)
    ) {
      const waveProgress = await this.dependencies.checkpoints.taskWaveProgress(taskId);
      return {
        refreshed: false,
        preserveCheckpoint: shouldPreserveFailedRunWaveCheckpoint(
          waveProgress,
          new Set(progress.completedMethodIds)
        )
      };
    }
    const waveProgress = await this.dependencies.checkpoints.taskWaveProgress(taskId);
    const completedMethodIds = new Set(progress.completedMethodIds);
    const resetGenerationCheckpoint = methodOrderChanged
      || shouldCleanupWaveScratchOnRelease(task);
    const preserveCheckpoint = !resetGenerationCheckpoint
      && shouldPreserveFailedRunWaveCheckpoint(waveProgress, completedMethodIds);
    await this.restart(
      taskId,
      undefined,
      {
        ...(methodOrderChanged ? { discardPendingArtifacts: true } : {}),
        resetGenerationCheckpoint
      }
    );
    await this.retryClassPreload(taskId);
    return { refreshed: true, preserveCheckpoint };
  }

  async prepareRun(task: ClassTaskSnapshot, signal?: AbortSignal): Promise<void> {
    const resources = this.resourceFor(task.id);
    const hadPreparedSession = resources.prepared !== null;
    await this.prepare(task.id, signal);
    if (hadPreparedSession) {
      const prepared = this.requirePrepared(resources);
      try {
        const sessionAvailable = resources.ownedAnalysisSessionIds.has(
          prepared.analysis.analysisSessionId
        ) && await this.retryHealthyAnalyzerTransientResponseFailure(
          () => this.dependencies.options.aiClient.heartbeatMethodAnalysisSession(
            prepared.analysis.analysisSessionId,
            signal
          ),
          signal
        );
        if (!sessionAvailable) {
          await this.rebuildPreparedAnalysisSession(task, resources, signal);
        }
      } catch (error) {
        if (!isRecoverableAnalysisSessionError(error)) throw error;
        await this.rebuildPreparedAnalysisSession(task, resources, signal);
      }
    }
    const logging = task.ragEnabled
      ? await this.beginLogging(resources)
      : null;
    await this.dependencies.ragRuns.preflightRun(resources, {
      taskId: task.id,
      ragEnabled: task.ragEnabled,
      captureModelCalls: logging?.enabled ?? false,
      ...(logging?.enabled
        ? {
            recordToolCallingProbe: (
              probe: NonNullable<ProductionTaskResources['ragToolCallingProbe']>,
              modelName: string
            ) => resources.logs.recordRagToolCallingProbe({
              taskId: task.id,
              className: task.qualifiedClassName.split('.').at(-1)
                ?? task.qualifiedClassName,
              qualifiedClassName: task.qualifiedClassName,
              modelName,
              occurredAt: this.now(),
              probe
            })
          }
        : {}),
      ...(signal ? { signal } : {})
    });
    const prepared = this.requirePrepared(resources);
    await this.dependencies.ragRuns.prepareIndex(resources, {
      taskId: task.id,
      ragEnabled: task.ragEnabled,
      analysisSessionId: prepared.analysis.analysisSessionId,
      reportPairId: prepared.catalog.reportPairId,
      methodIds: [...task.methodOrder],
      analysisInput: prepared.analysisInput,
      buildSettings: prepared.buildSettings,
      ...(signal ? { signal } : {})
    });
  }

  async execute(
    task: ClassTaskSnapshot,
    methodId: string,
    checkpoint: MethodExecutionCheckpoint,
    signal: AbortSignal
  ): Promise<MethodTestBundle | null> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    const generator = await this.ensureGenerator(task, resources, signal);
    const progress = await this.dependencies.checkpoints.taskProgress(task.id);
    await this.runWithAnalysisSessionHeartbeat(task, resources, signal, async (heartbeatSignal) => (
      generator.generateBatches(
        this.dependencies.registry.snapshot(task.id),
        methodId,
        await this.dependencies.checkpoints.methodCheckpoint(task.id, methodId),
        heartbeatSignal,
        {
          temporaryBatchIndexOffset: temporaryBatchIndexOffset(progress, methodId)
        }
      )
    ));
    return null;
  }

  async nextWave(
    task: ClassTaskSnapshot,
    methodId: string,
    request: SingleMethodWaveRequest,
    signal: AbortSignal
  ): Promise<SingleMethodWaveResponse> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    const generator = await this.ensureGenerator(task, resources, signal);
    return this.runWithAnalysisSessionHeartbeat(
      task,
      resources,
      signal,
      (heartbeatSignal) => generator.nextWave(
        this.dependencies.registry.snapshot(task.id),
        methodId,
        request,
        heartbeatSignal
      )
    );
  }

  async nextClassWave(
    task: ClassTaskSnapshot,
    request: ClassScenarioWaveRequest,
    signal: AbortSignal
  ): Promise<ClassScenarioWaveResponse> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    const generator = await this.ensureGenerator(task, resources, signal);
    return this.runWithAnalysisSessionHeartbeat(
      task,
      resources,
      signal,
      (heartbeatSignal) => generator.nextClassWave(
        this.dependencies.registry.snapshot(task.id),
        request,
        heartbeatSignal
      )
    );
  }

  async executeWave(
    task: ClassTaskSnapshot,
    wave: SingleMethodWorkWave | ClassScenarioWorkWave,
    checkpoint: MethodExecutionCheckpoint,
    waveCheckpoint: ActiveMethodWaveCheckpoint,
    signal: AbortSignal
  ): Promise<MethodWaveExecutionOutcome> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    // A prior run can leave an unowned TMP file after preparation has already been
    // cached (for example, in the crash window between publishing a formal class
    // Wave and clearing its old candidate). Quarantine such files immediately
    // before this Wave chooses and writes its deterministic TMP class name.
    const waveState = await this.dependencies.checkpoints.taskWaveProgress(task.id);
    await this.dependencies.moduleLock.runExclusive(
      task.moduleKey,
      () => isolateOrphanProjectWaveCandidates({
        taskId: task.id,
        workspaceRoot: task.workspaceRoot,
        sourceFilePath: task.sourceFilePath,
        candidates: waveState.candidates,
        transaction: resources.transaction
      }),
      signal
    );
    const generator = await this.ensureGenerator(task, resources, signal);
    return this.runWithAnalysisSessionHeartbeat(
      task,
      resources,
      signal,
      async (heartbeatSignal) => {
        const currentWaveState = await this.dependencies.checkpoints.taskWaveProgress(task.id);
        const currentWaveCheckpoint = currentWaveState.activeWave;
        if (
          !currentWaveCheckpoint
          || currentWaveCheckpoint.waveId !== waveCheckpoint.waveId
          || currentWaveCheckpoint.methodId !== waveCheckpoint.methodId
        ) {
          throw new Error('Active Wave checkpoint changed during Analyzer session recovery.');
        }
        return generator.executeWave(
          this.dependencies.registry.snapshot(task.id),
          currentWaveCheckpoint.wave
            ? structuredClone(currentWaveCheckpoint.wave)
            : wave,
          await this.dependencies.checkpoints.methodCheckpoint(
            task.id,
            currentWaveCheckpoint.methodId
          ),
          currentWaveCheckpoint,
          heartbeatSignal
        );
      }
    );
  }

  async planExecutionGroups(
    task: ClassTaskSnapshot,
    pendingMethodIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly (readonly string[])[]> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    const generator = await this.ensureBatchGenerator(task, resources, signal);
    return this.runWithAnalysisSessionHeartbeat(task, resources, signal, (heartbeatSignal) => (
      generator.plan(task, pendingMethodIds, heartbeatSignal)
    ));
  }

  async executeGroup(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    checkpoints: Readonly<Record<string, MethodExecutionCheckpoint>>,
    signal: AbortSignal
  ): Promise<boolean> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    const generator = await this.ensureBatchGenerator(task, resources, signal);
    return this.runWithAnalysisSessionHeartbeat(task, resources, signal, (heartbeatSignal) => (
      generator.execute(task, methodIds, checkpoints, heartbeatSignal)
    ));
  }

  private async runWithAnalysisSessionHeartbeat<T>(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    try {
      return await this.runWithAnalysisSessionHeartbeatAttempt(
        resources,
        signal,
        operation
      );
    } catch (error) {
      if (signal.aborted || !isRecoverableAnalysisSessionError(error)) throw error;
      await this.rebuildPreparedAnalysisSession(task, resources, signal);
      return this.runWithAnalysisSessionHeartbeatAttempt(
        resources,
        signal,
        operation
      );
    }
  }

  private async runWithAnalysisSessionHeartbeatAttempt<T>(
    resources: ProductionTaskResources,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const intervalMilliseconds = this.dependencies.options
      .analysisSessionHeartbeatIntervalMilliseconds
      ?? DEFAULT_ANALYSIS_SESSION_HEARTBEAT_INTERVAL_MILLISECONDS;
    if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
      throw new Error('Analysis-session heartbeat interval must be a positive integer.');
    }
    const sessionId = this.requirePrepared(resources).analysis.analysisSessionId;
    let heartbeatFailure: unknown = null;
    let heartbeatInFlight: Promise<void> | null = null;
    const heartbeat = () => {
      if (heartbeatInFlight || heartbeatFailure || signal.aborted) return;
      heartbeatInFlight = (async () => {
        const available = resources.ownedAnalysisSessionIds.has(sessionId)
          && await this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.heartbeatMethodAnalysisSession(
              sessionId,
              signal
            ),
            signal
          );
        if (!available) {
          throw new MethodAnalysisRequestError(
            'ANALYSIS_SESSION_NOT_FOUND',
            'Java Analyzer session expired while the class task was running.'
          );
        }
      })().catch((error) => {
        heartbeatFailure = error;
      }).finally(() => {
        heartbeatInFlight = null;
      });
    };
    const timer = setInterval(heartbeat, intervalMilliseconds);
    timer.unref();
    try {
      const result = await operation(signal);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async rebuildPreparedAnalysisSession(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal) throwIfAborted(signal);
    const prepared = this.requirePrepared(resources);
    const previousSessionId = prepared.analysis.analysisSessionId;
    const currentPair = { ...prepared.pair };
    const analysisInput: MavenAnalysisContext = {
      ...prepared.analysisInput,
      reportPath: currentPair.reportPath,
      branchSnapshotPath: currentPair.branchSnapshotPath,
      reportPairId: currentPair.pairId
    };
    resources.ownedAnalysisSessionIds.delete(previousSessionId);
    let replacementSessionId: string | null = null;
    try {
      let analysis;
      try {
        analysis = await this.createOwnedAnalysisSession(resources, analysisInput, signal);
      } catch (error) {
        if (!isAnalysisCapacityError(error)) throw error;
        await this.releaseInactiveAnalysisSessionsForCapacity(task.id);
        analysis = await this.createOwnedAnalysisSession(resources, analysisInput, signal);
      }
      replacementSessionId = analysis.analysisSessionId;
      const refreshed = await this.retryHealthyAnalyzerTransientResponseFailure(
        () => this.dependencies.options.aiClient.refreshMethodAnalysisCoverage(
          analysis.analysisSessionId,
          {
            reportPath: currentPair.reportPath,
            branchSnapshotPath: currentPair.branchSnapshotPath,
            reportPairId: currentPair.pairId
          },
          signal
        ),
        signal
      );
      if (
        refreshed.reportPairId !== currentPair.pairId
        || refreshed.catalog.reportPairId !== currentPair.pairId
        || refreshed.catalog.analysisSessionId !== replacementSessionId
      ) {
        throw new Error('Replacement Analyzer session returned a mismatched identity.');
      }
      this.dependencies.jacoco.rebindAnalysisSession(task.id, replacementSessionId);
      prepared.analysis = {
        ...analysis,
        reportPairId: currentPair.pairId
      };
      prepared.analysisInput = analysisInput;
      prepared.catalog = toClassMethodCatalog(
        task.id,
        refreshed.catalog,
        this.now(),
        prepared.fingerprint
      );
      prepared.jacoco = {
        ...prepared.jacoco,
        analysisSessionId: replacementSessionId
      };
    } catch (error) {
      if (replacementSessionId) {
        await this.releaseOwnedAnalysisSession(resources, replacementSessionId);
      }
      throw error;
    }
  }

  async formalizeCompletedMethods(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    const resources = this.resourceFor(task.id);
    await this.packCompletedMethods(task, methodIds, resources, signal);
    await this.refreshCompletedMethodCoverage(task, methodIds, resources, signal);
  }

  async formalizeWave(
    task: ClassTaskSnapshot,
    bundle: MethodTestBundle,
    signal: AbortSignal
  ): Promise<void> {
    const resources = this.resourceFor(task.id);
    const packer = this.ensurePacker(task, resources);
    const waveState = await this.dependencies.checkpoints.taskWaveProgress(task.id);
    const ownedCandidates = bundle.sourceBatchIds.map((candidateId) => {
      const candidate = waveState.candidates[candidateId];
      if (
        !candidate
        || candidate.status !== 'PASSED'
        || candidate.methodId !== bundle.sourceMethodId
        || candidate.waveId !== waveState.activeWave?.waveId
      ) {
        throw new Error('Passing Wave TMP ownership is inconsistent before formalization.');
      }
      return candidate;
    });
    const published = findPublishedWaveArtifact(
      resources.transaction.artifacts(task.id),
      bundle.sourceMethodId ?? bundle.methodId,
      bundle.waveIndex ?? 0
    );
    if (published) {
      if (
        published.methodResult.methodName !== bundle.methodName
        || published.methodResult.displaySignature !== bundle.displaySignature
      ) {
        throw new Error('Published Wave formalization identity is inconsistent.');
      }
      await this.dependencies.options.testWriterService.loadOwnedGeneratedTest({
        workspaceRoot: task.workspaceRoot,
        filePath: published.artifact.filePath,
        expectedSha256: published.artifact.sha256
      });
      await this.refreshCompletedMethodCoverage(
        task,
        [bundle.sourceMethodId ?? bundle.methodId],
        resources,
        signal
      );
      await this.cleanupFormalizedWaveCandidates(task, ownedCandidates, signal);
      return;
    }
    const expectedBundleSha256 = createHash('sha256')
      .update(bundle.code, 'utf8')
      .digest('hex');
    if (ownedCandidates.some((candidate) => (
      candidate.managedFile?.location !== 'PROJECT'
      || candidate.managedFile.sha256 !== expectedBundleSha256
    ))) {
      throw new Error('Passing Wave TMP ownership is inconsistent before formalization.');
    }
    await this.atomic(task.id, 'PACK_FORMAL_FILE', () => (
      packer.append(bundle, signal)
    ));
    await this.persistArtifacts(resources);
    await this.refreshCompletedMethodCoverage(
      task,
      [bundle.sourceMethodId ?? bundle.methodId],
      resources,
      signal
    );
    await this.cleanupFormalizedWaveCandidates(task, ownedCandidates, signal);
  }

  async formalizeWaveGroup(
    task: ClassTaskSnapshot,
    bundles: readonly MethodTestBundle[],
    candidateIds: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    if (bundles.length < 1) throw new Error('Class Wave has no method bundles to formalize.');
    const resources = this.resourceFor(task.id);
    const packer = this.ensurePacker(task, resources);
    const waveState = await this.dependencies.checkpoints.taskWaveProgress(task.id);
    const activeWave = waveState.activeWave;
    if (!activeWave?.wave || !('selectedMethodIds' in activeWave.wave)) {
      throw new Error('Class Wave formalization requires an active class Wave checkpoint.');
    }
    const code = bundles[0].code;
    const codeSha256 = createHash('sha256').update(code, 'utf8').digest('hex');
    if (bundles.some((bundle) => (
      bundle.code !== code
      || !bundle.waveIndex
      || bundle.sourceBatchIds.length !== candidateIds.length
      || bundle.sourceBatchIds.some((id, index) => id !== candidateIds[index])
    ))) {
      throw new Error('Class Wave method bundles do not share one verified candidate.');
    }
    const published = bundles.map((bundle) => findPublishedWaveArtifact(
      resources.transaction.artifacts(task.id),
      bundle.sourceMethodId ?? bundle.methodId,
      bundle.waveIndex ?? 0
    ));
    if (published.every((item) => item !== null)) {
      const artifactIds = new Set(published.map((item) => item?.artifact.id));
      if (artifactIds.size !== 1) {
        throw new Error('Published class Wave bundles do not belong to one artifact.');
      }
      const artifact = published[0]?.artifact;
      if (!artifact) throw new Error('Published class Wave artifact disappeared.');
      await this.dependencies.options.testWriterService.loadOwnedGeneratedTest({
        workspaceRoot: task.workspaceRoot,
        filePath: artifact.filePath,
        expectedSha256: artifact.sha256
      });
      await this.refreshCompletedMethodCoverage(
        task,
        bundles.map((bundle) => bundle.sourceMethodId ?? bundle.methodId),
        resources,
        signal
      );
      return;
    }
    if (published.some((item) => item !== null)) {
      throw new Error('Published class Wave result is incomplete.');
    }
    const candidates = candidateIds.map((candidateId) => {
      const candidate = waveState.candidates[candidateId];
      if (!candidate
        || candidate.status !== 'PASSED'
        || candidate.methodId !== activeWave.methodId
        || candidate.waveId !== activeWave.waveId
        || candidate.managedFile?.location !== 'PROJECT'
        || candidate.managedFile.sha256 !== codeSha256) {
        throw new Error('Passing class Wave TMP ownership is inconsistent.');
      }
      return candidate;
    });
    await this.atomic(task.id, 'PACK_FORMAL_FILE', () => (
      packer.appendSharedTemporaryGroup({ code, bundles: [...bundles] }, signal)
    ));
    await this.persistArtifacts(resources);
    await this.refreshCompletedMethodCoverage(
      task,
      bundles.map((bundle) => bundle.sourceMethodId ?? bundle.methodId),
      resources,
      signal
    );
    await this.cleanupFormalizedWaveCandidates(task, candidates, signal);
  }

  private async cleanupFormalizedWaveCandidates(
    task: ClassTaskSnapshot,
    candidates: readonly WaveCandidateCheckpoint[],
    signal: AbortSignal
  ): Promise<void> {
    for (const candidate of candidates) {
      await this.dependencies.moduleLock.runExclusive(task.moduleKey, async () => {
        for (const file of waveCandidateOwnedFiles(candidate)) {
          await this.deleteOwnedWaveScratchFile(task, file.path, file.sha256);
        }
        await rm(waveCandidateDirectory(task, candidate.candidateId), {
          recursive: true,
          force: true
        });
      }, signal);
      if (!candidate.managedFile && !candidate.moveTransaction) continue;
      await this.dependencies.checkpoints.saveWaveCandidate(task.id, {
        ...candidate,
        managedFile: null,
        moveTransaction: null
      });
    }
    await removeDirectoryIfEmpty(waveCandidateTaskDirectory(task));
  }

  private async restorePublishedWaveBundle(
    resources: ProductionTaskResources,
    input: {
      task: ClassTaskSnapshot;
      wave: SingleMethodWorkWave | ClassScenarioWorkWave;
      waveCheckpoint: ActiveMethodWaveCheckpoint;
      candidate: WaveCandidateCheckpoint;
      signal: AbortSignal;
    }
  ): Promise<MethodTestBundle | MethodTestBundle[] | null> {
    throwIfAborted(input.signal);
    if ('selectedMethodIds' in input.wave) {
      const classWave = input.wave;
      const progress = await this.dependencies.checkpoints.taskWaveProgress(input.task.id);
      const published = input.wave.selectedMethodIds.flatMap((methodId) => {
        const waveIndex = progress.methods[methodId]?.nextWaveIndex
          ?? input.waveCheckpoint.waveIndex;
        const item = findPublishedWaveArtifact(
          resources.transaction.artifacts(input.task.id),
          methodId,
          waveIndex
        );
        return item ? [{ methodId, waveIndex, ...item }] : [];
      });
      if (published.length === 0) return null;
      const artifact = published[0].artifact;
      if (published.some((item) => item.artifact.id !== artifact.id)) {
        throw new Error('Published class Wave methods do not belong to one artifact.');
      }
      const code = await this.dependencies.options.testWriterService.loadOwnedGeneratedTest({
        workspaceRoot: input.task.workspaceRoot,
        filePath: artifact.filePath,
        expectedSha256: artifact.sha256
      });
      throwIfAborted(input.signal);
      return published.map((item) => ({
        methodId: item.methodId,
        sourceMethodId: item.methodId,
        waveIndex: item.waveIndex,
        hasRemainingScenarios: (
          classWave.remainingScenarioCountByMethod[item.methodId] ?? 0
        ) > 0,
        methodName: item.methodResult.methodName,
        displaySignature: item.methodResult.displaySignature,
        jacocoOrder: item.methodResult.jacocoOrder,
        code,
        ordinaryTestMethodCount: item.methodResult.ordinaryTestMethodCount,
        passedTestMethods: [],
        sourceBatchIds: [input.candidate.candidateId]
      }));
    }
    const published = findPublishedWaveArtifact(
      resources.transaction.artifacts(input.task.id),
      input.wave.methodId,
      input.waveCheckpoint.waveIndex
    );
    if (!published) return null;
    const code = await this.dependencies.options.testWriterService.loadOwnedGeneratedTest({
      workspaceRoot: input.task.workspaceRoot,
      filePath: published.artifact.filePath,
      expectedSha256: published.artifact.sha256
    });
    throwIfAborted(input.signal);
    return {
      methodId: input.wave.methodId,
      sourceMethodId: input.wave.methodId,
      waveIndex: input.waveCheckpoint.waveIndex,
      hasRemainingScenarios: input.wave.remainingScenarioCount > 0,
      methodName: published.methodResult.methodName,
      displaySignature: published.methodResult.displaySignature,
      jacocoOrder: published.methodResult.jacocoOrder,
      code,
      ordinaryTestMethodCount: published.methodResult.ordinaryTestMethodCount,
      passedTestMethods: [],
      sourceBatchIds: [input.candidate.candidateId]
    };
  }

  async finalizeRun(
    task: ClassTaskSnapshot,
    methodOrder: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    await this.prepareRun(task, signal);
    const resources = this.resourceFor(task.id);
    await this.packCompletedMethods(task, methodOrder, resources, signal);
    const packer = this.requirePacker(resources);

    await packer.finish(signal);
    await this.persistArtifacts(resources);
    await this.recalculateCoverageIfArtifactsChanged(task, resources, signal);
    await this.cleanupTemporaryFiles(task);
  }

  private async refreshCompletedMethodCoverage(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    resources: ProductionTaskResources,
    signal: AbortSignal
  ): Promise<void> {
    const completedMethodIds = new Set(methodIds);
    const changedArtifacts = resources.transaction.artifacts(task.id).filter((artifact) => (
      shouldRefreshCoverageForArtifact(artifact)
      && artifact.methodIds.some((methodId) => completedMethodIds.has(methodId))
      && resources.coverageArtifactSha256ById.get(artifact.id) !== artifact.sha256
    ));
    for (const artifact of changedArtifacts) {
      const prepared = this.requirePrepared(resources);
      const refreshed = await this.atomic(task.id, 'JACOCO_REFRESH', () => (
        this.dependencies.jacoco.refreshArtifact(prepared.jacoco, artifact, signal)
      ));
      this.updatePreparedCoverage(resources, refreshed.pair, refreshed.catalog);
      resources.coverageArtifactSha256ById.set(artifact.id, artifact.sha256);
      await this.persistCoverage(
        resources,
        refreshed.coverage.counts,
        refreshed.contributions
      );
    }
  }

  private async recalculateCoverageIfArtifactsChanged(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources,
    signal: AbortSignal
  ): Promise<void> {
    const coverageArtifacts = resources.transaction.artifacts(task.id)
      .filter(shouldRefreshCoverageForArtifact);
    if (sameCoverageArtifactVersions(
      coverageArtifacts,
      resources.coverageArtifactSha256ById
    )) return;
    const prepared = this.requirePrepared(resources);
    const refreshed = await this.atomic(task.id, 'JACOCO_REFRESH', () => (
      this.dependencies.jacoco.recalculate(
        prepared.jacoco,
        coverageArtifacts,
        signal
      )
    ));
    this.updatePreparedCoverage(resources, refreshed.pair, refreshed.catalog);
    replaceCoverageArtifactVersions(resources, coverageArtifacts);
    await this.persistCoverage(
      resources,
      refreshed.coverage.counts,
      refreshed.contributions
    );
  }

  private async packCompletedMethods(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    resources: ProductionTaskResources,
    signal: AbortSignal
  ): Promise<void> {
    const generator = await this.ensureGenerator(task, resources, signal);
    const batchGenerator = await this.ensureBatchGenerator(task, resources, signal);
    const packer = this.requirePacker(resources);
    const progress = await this.dependencies.checkpoints.taskProgress(task.id);
    const packedMethodIds = new Set(
      resources.transaction.artifacts(task.id).flatMap((artifact) => artifact.methodIds)
    );
    const handledMethodIds = new Set<string>();
    const catalogByMethodId = new Map(
      this.requirePrepared(resources).catalog.methods.map((method) => [method.methodId, method])
    );

    for (const methodId of methodIds) {
      throwIfAborted(signal);
      if (handledMethodIds.has(methodId)) continue;
      const checkpoint = progress.methods[methodId] ?? {
        completedBatches: [],
        completedTestMethodPlanIds: []
      };
      if (!progress.completedMethodIds.includes(methodId)) {
        throw new Error(`Cannot formalize incomplete source method ${methodId}.`);
      }
      const sharedGroupMethodIds = sharedPassedTemporaryGroupMethodIds(
        methodIds,
        progress,
        methodId
      );
      if (sharedGroupMethodIds.length > 1) {
        sharedGroupMethodIds.forEach((id) => handledMethodIds.add(id));
        const alreadyPacked = sharedGroupMethodIds.filter((id) => packedMethodIds.has(id));
        if (alreadyPacked.length === sharedGroupMethodIds.length) {
          await this.cleanupTemporaryFiles(task, sharedGroupMethodIds);
          continue;
        }
        if (alreadyPacked.length > 0) {
          throw new Error('Persisted data-class group is only partially formalized.');
        }
        const groupCheckpoints = Object.fromEntries(sharedGroupMethodIds.map((id) => [
          id,
          progress.methods[id] ?? {
            completedBatches: [],
            completedTestMethodPlanIds: []
          }
        ]));
        const restoredGroup = await this.atomic(
          task.id,
          'MERGE_METHOD_BATCHES',
          () => batchGenerator.restoreCommittedGroup(
            task,
            sharedGroupMethodIds,
            groupCheckpoints,
            signal
          )
        );
        if (!restoredGroup) {
          throw new Error('Persisted data-class group cannot be restored safely.');
        }
        const bundles = restoredGroup.methodBundles.map((restored) => {
          const method = catalogByMethodId.get(restored.methodId);
          if (!method) {
            throw new Error(`Source method ${restored.methodId} is missing from the catalog.`);
          }
          return {
            methodId: restored.methodId,
            methodName: method.methodName,
            displaySignature: method.displaySignature,
            jacocoOrder: method.jacocoOrder,
            code: restored.code,
            ordinaryTestMethodCount: restored.ordinaryTestMethodCount,
            passedTestMethods: [...restored.passedTestMethods],
            sourceBatchIds: [restored.batchId]
          };
        });
        await this.atomic(task.id, 'PACK_FORMAL_FILE', () => (
          packer.appendSharedTemporaryGroup({
            code: restoredGroup.code,
            bundles
          }, signal)
        ));
        sharedGroupMethodIds.forEach((id) => packedMethodIds.add(id));
        await this.persistArtifacts(resources);
        await this.cleanupTemporaryFiles(task, sharedGroupMethodIds);
        continue;
      }
      handledMethodIds.add(methodId);
      if (!packedMethodIds.has(methodId)) {
        const generated = await generator.restoreGeneratedBatches(
          task,
          methodId,
          checkpoint,
          signal,
          { temporaryBatchIndexOffset: temporaryBatchIndexOffset(progress, methodId) }
        );
        if (generated) {
          const bundle = await this.atomic(
            task.id,
            'MERGE_METHOD_BATCHES',
            async () => ({
              ...this.dependencies.bundleMerger.merge(methodId, generated.batches),
              methodName: generated.methodName,
              displaySignature: generated.displaySignature,
              jacocoOrder: generated.jacocoOrder
            })
          );
          await this.atomic(task.id, 'PACK_FORMAL_FILE', () => (
            packer.append(bundle, signal)
          ));
          packedMethodIds.add(methodId);
          await this.persistArtifacts(resources);
        }
      }
      await this.cleanupTemporaryFiles(task, [methodId]);
    }
  }

  async finish(taskId: string, signal?: AbortSignal): Promise<void> {
    const resources = this.resourceFor(taskId);
    try {
      if (resources.packer) {
        await resources.packer.finish(signal);
        await this.persistArtifacts(resources);
      }
      const task = this.dependencies.registry.snapshot(taskId);
      await this.cleanupTemporaryFiles(task);
      await resources.logs.finish();
      resources.loggingPromise = null;
      resources.generator = null;
      resources.batchGenerator = null;
      resources.packer = null;
    } finally {
      await this.releaseRun(taskId);
    }
  }

  async releaseRun(taskId: string): Promise<void> {
    const resources = this.resources.get(taskId);
    if (!resources) return;
    const task = this.dependencies.registry.snapshot(taskId);
    const operations: Promise<unknown>[] = [
      this.dependencies.ragRuns.releaseRun(resources),
      resources.logs.finish()
    ];
    if (shouldCleanupWaveScratchOnRelease(task)) {
      operations.push(this.cleanupTerminalWaveScratch(task));
    }
    await Promise.allSettled(operations);
    resources.loggingPromise = null;
    if (RELEASE_RUN_STATES.has(task.state)) {
      resources.generator = null;
      resources.batchGenerator = null;
      await this.releaseOwnedAnalysisSessions(resources);
    }
  }

  async refreshGenerationModel(taskId: string): Promise<void> {
    const resources = this.resourceFor(taskId);
    await this.dependencies.ragRuns.refreshModelRuntime(resources);
    resources.generator = null;
    resources.batchGenerator = null;
  }

  private async cleanupTerminalWaveScratch(task: ClassTaskSnapshot): Promise<void> {
    const failures: unknown[] = [];
    let candidates: WaveCandidateCheckpoint[] = [];
    try {
      const waveState = await this.dependencies.checkpoints.taskWaveProgress(task.id);
      candidates = Object.values(waveState.candidates).sort((left, right) => (
        left.candidateId.localeCompare(right.candidateId)
      ));
    } catch (error) {
      failures.push(error);
    }
    const candidateTaskDirectory = waveCandidateTaskDirectory(task);
    const ownedFiles = candidates.flatMap((candidate) => waveCandidateOwnedFiles(candidate));
    let candidateTaskDirectoryExists = false;
    try {
      await access(candidateTaskDirectory);
      candidateTaskDirectoryExists = true;
    } catch (error) {
      if (!isMissingPath(error)) failures.push(error);
    }
    const scratchCleanupOperations: Promise<unknown>[] = [
      this.partStore.clearTask(task.workspaceRoot, task.id)
    ];
    if (ownedFiles.length > 0) {
      scratchCleanupOperations.push(this.dependencies.moduleLock.runExclusive(task.moduleKey, async () => {
        for (const candidate of candidates) {
          for (const file of waveCandidateOwnedFiles(candidate)) {
            try {
              await this.deleteOwnedWaveScratchFile(task, file.path, file.sha256);
            } catch (error) {
              failures.push(error);
            }
          }
        }
        try {
          await rm(candidateTaskDirectory, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }));
    } else if (candidateTaskDirectoryExists) {
      // The directory is task-scoped and has no tracked candidate files. Removing it must not
      // wait for an unrelated class Maven command that currently owns the shared module lock.
      scratchCleanupOperations.push(rm(candidateTaskDirectory, { recursive: true, force: true }));
    }
    const scratchCleanup = await Promise.allSettled(scratchCleanupOperations);
    for (const result of scratchCleanup) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    for (const candidate of candidates) {
      if (!candidate.managedFile && !candidate.moveTransaction) continue;
      try {
        await this.dependencies.checkpoints.saveWaveCandidate(task.id, {
          ...candidate,
          managedFile: null,
          moveTransaction: null
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Wave scratch cleanup did not complete cleanly.');
    }
  }

  private async deleteOwnedWaveScratchFile(
    task: ClassTaskSnapshot,
    filePath: string,
    expectedSha256: string
  ): Promise<void> {
    try {
      await this.dependencies.options.testWriterService.deleteGeneratedTest({
        workspaceRoot: task.workspaceRoot,
        filePath,
        expectedSha256
      });
    } catch (error) {
      if (isMissingPath(error)) return;
      if (!isGeneratedTestExternallyModifiedError(error)) throw error;
      await rm(resolve(filePath), { force: true });
    }
  }

  async remove(taskId: string): Promise<void> {
    const resources = this.resources.get(taskId);
    if (!resources) return;
    const task = this.dependencies.registry.snapshot(taskId);
    resources.preparation?.controller.abort(new Error('Class task was removed.'));
    await Promise.allSettled([
      resources.preparation?.promise ?? Promise.resolve(),
      resources.logs.finish()
    ]);
    try {
      await this.cleanupTerminalWaveScratch(task);
      await this.dependencies.ragRuns.releaseRun(resources);
      if (resources.transaction.artifacts(taskId).length > 0) {
        await resources.transaction.revoke(taskId, {
          protectedFilePaths: resources.acceptedArtifacts.map((artifact) => artifact.filePath)
        });
      }
      if (resources.jacocoInitialized && resources.prepared) {
        await this.dependencies.jacoco.remove(resources.prepared.jacoco);
      }
    } finally {
      await this.releaseOwnedAnalysisSessions(resources);
    }
    this.dependencies.coverageLedger.remove(taskId);
    this.resources.delete(taskId);
  }

  async getResult(taskId: string): Promise<ClassTaskResultSnapshot | null> {
    const task = this.dependencies.registry.snapshot(taskId);
    const hasRevokedCompletedResult = (
      task.state === 'COMPLETED' || task.state === 'TERMINATED'
    )
      && task.coverageBaseline !== null
      && task.coverageCurrent !== null;
    if (
      (task.generatedArtifacts.length === 0 && !hasRevokedCompletedResult)
      || !task.coverageBaseline
      || !task.coverageCurrent
    ) return null;
    const resources = this.resourceFor(taskId);
    await this.restorePendingResultArtifacts(task, resources);
    return this.resultSnapshot(task, resources);
  }

  async accept(taskId: string): Promise<ClassTaskResultSnapshot> {
    const resources = this.resourceFor(taskId);
    const current = resources.transaction.artifacts(taskId);
    if (current.length === 0) throw new Error('The class task has no result to accept.');
    const task = this.dependencies.registry.snapshot(taskId);
    if (!task.coverageCurrent) {
      throw new Error('The class task has no exact current coverage to accept.');
    }
    let acceptedCoverage = detached(task.coverageCurrent);
    if (resources.jacocoInitialized && resources.prepared) {
      const checkpoint = await this.dependencies.jacoco.checkpointAcceptedBaseline(
        resources.prepared.jacoco
      );
      resources.prepared.jacoco = checkpoint.context;
      acceptedCoverage = detached(checkpoint.coverage.counts);
    }
    const accepted = await resources.transaction.accept(taskId);
    resources.acceptedArtifacts = uniqueArtifacts([
      ...resources.acceptedArtifacts,
      ...accepted
    ]);
    resources.transaction = this.createTransaction();
    resources.restored = true;
    resources.packer = null;
    resources.generator = null;
    resources.batchGenerator = null;
    resources.coverageArtifactSha256ById.clear();
    const latest = this.dependencies.registry.snapshot(taskId);
    await this.dependencies.registry.save({
      ...latest,
      generatedArtifacts: uniqueArtifacts(resources.acceptedArtifacts),
      coverageBaseline: detached(acceptedCoverage),
      coverageCurrent: detached(acceptedCoverage),
      coverageContributions: [],
      updatedAt: this.now()
    });
    return this.requireResult(taskId, resources);
  }

  async revoke(
    taskId: string,
    options: RevokeClassTaskResultOptions = {}
  ): Promise<ClassTaskResultSnapshot> {
    const resources = this.resourceFor(taskId);
    const current = resources.transaction.artifacts(taskId);
    if (current.length === 0) throw new Error('The class task has no result to revoke.');
    const task = this.dependencies.registry.snapshot(taskId);
    if (!task.coverageBaseline) {
      throw new Error('The class task has no exact coverage baseline to restore.');
    }
    if (options.preserveRun) {
      return this.revokePendingRunArtifacts(task, resources);
    }
    await resources.transaction.revoke(taskId, {
      protectedFilePaths: resources.acceptedArtifacts.map((artifact) => artifact.filePath)
    });
    this.releaseOwnedAnalysisSessionsInBackground(resources);
    if (resources.jacocoInitialized && resources.prepared) {
      await this.dependencies.jacoco.remove(resources.prepared.jacoco);
    } else {
      this.dependencies.coverageLedger.remove(taskId);
    }
    resources.transaction = this.createTransaction();
    resources.restored = true;
    resources.prepared = null;
    resources.preparation = null;
    resources.jacocoInitialized = false;
    resources.packer = null;
    resources.generator = null;
    resources.batchGenerator = null;
    resources.loggingPromise = null;
    resources.coverageArtifactSha256ById.clear();
    const latest = this.dependencies.registry.snapshot(taskId);
    await this.dependencies.registry.save({
      ...latest,
      generatedArtifacts: uniqueArtifacts(resources.acceptedArtifacts),
      coveredMethodIds: [],
      coverageCurrent: detached(task.coverageBaseline),
      coverageContributions: [],
      updatedAt: this.now()
    });
    return this.requireResult(taskId, resources);
  }

  private async revokePendingRunArtifacts(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources
  ): Promise<ClassTaskResultSnapshot> {
    let recalculated: Awaited<ReturnType<TaskJacocoSessionService['recalculate']>> | null = null;
    if (resources.jacocoInitialized && resources.prepared) {
      recalculated = await this.dependencies.jacoco.recalculate(
        resources.prepared.jacoco,
        [],
        new AbortController().signal
      );
    }
    await resources.transaction.revoke(task.id, {
      protectedFilePaths: resources.acceptedArtifacts.map((artifact) => artifact.filePath)
    });
    resources.transaction = this.createTransaction();
    resources.restored = true;
    resources.packer = null;
    resources.generator = null;
    resources.batchGenerator = null;
    resources.coverageArtifactSha256ById.clear();
    if (recalculated) {
      this.updatePreparedCoverage(resources, recalculated.pair, recalculated.catalog);
      await this.persistCoverage(
        resources,
        recalculated.coverage.counts,
        recalculated.contributions
      );
    } else {
      const latest = this.dependencies.registry.snapshot(task.id);
      await this.dependencies.registry.save({
        ...latest,
        generatedArtifacts: uniqueArtifacts(resources.acceptedArtifacts),
        coveredMethodIds: [],
        coverageCurrent: detached(task.coverageBaseline!),
        coverageContributions: [],
        completionAttentionPending: false,
        updatedAt: this.now()
      });
    }
    return this.requireResult(task.id, resources);
  }

  async retryClassPreload(taskId: string): Promise<void> {
    const resources = this.resourceFor(taskId);
    await this.resetPrepared(resources);
    await this.reconcilePendingArtifactsForRetry(taskId, resources);
    const latest = this.dependencies.registry.snapshot(taskId);
    if (latest.state !== 'PRELOADING') {
      await this.dependencies.registry.save(
        transitionClassTask(latest, 'PRELOADING', { now: this.now() })
      );
    }
    await Promise.allSettled([this.prepare(taskId)]);
  }

  private async reconcilePendingArtifactsForRetry(
    taskId: string,
    resources: ProductionTaskResources
  ): Promise<void> {
    const pendingArtifacts = resources.transaction.artifacts(taskId);
    if (pendingArtifacts.length === 0) return;
    try {
      await resources.transaction.restoreSnapshot({
        taskId,
        artifacts: pendingArtifacts
      });
    } catch (error) {
      if (!isUnavailableRestoredArtifact(error)) throw error;
      const task = this.dependencies.registry.snapshot(taskId);
      resources.transaction = this.createTransaction();
      await resources.transaction.restoreTask({
        taskId,
        workspaceRoot: task.workspaceRoot,
        artifacts: []
      });
      await this.dependencies.registry.save({
        ...task,
        generatedArtifacts: uniqueArtifacts(resources.acceptedArtifacts),
        coveredMethodIds: [],
        coverageCurrent: task.coverageBaseline
          ? detached(task.coverageBaseline)
          : null,
        coverageContributions: [],
        updatedAt: this.now()
      });
    }
  }

  async stopClassPreload(taskId: string): Promise<void> {
    const preparation = this.resources.get(taskId)?.preparation;
    preparation?.controller.abort(new ModulePreloadStoppedError());
    await Promise.allSettled([preparation?.promise ?? Promise.resolve()]);
    const latest = this.dependencies.registry.snapshot(taskId);
    if (latest.state !== 'PRELOADING') return;
    await this.dependencies.registry.save({
      ...latest,
      preloadState: 'IDLE',
      currentAtomicStep: 'IDLE',
      activeGenerationBatch: null,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      completionAttentionPending: false,
      updatedAt: this.now()
    });
  }

  async abort(): Promise<void> {
    const preparations: Promise<unknown>[] = [];
    for (const resources of this.resources.values()) {
      if (resources.preparation) {
        resources.preparation.controller.abort(new Error('Application is shutting down.'));
        preparations.push(resources.preparation.promise);
      }
    }
    await Promise.allSettled(preparations);
    await Promise.allSettled(
      [...this.resources.values()].map((resources) => resources.logs.finish())
    );
    try {
      await this.dependencies.ragRuns.suspendAll(this.resources.values());
    } finally {
      await Promise.allSettled(
        [...this.resources.values()].map((resources) => (
          this.releaseOwnedAnalysisSessions(resources)
        ))
      );
    }
  }

  private async prepareTask(
    taskId: string,
    resources: ProductionTaskResources,
    preparation: TaskPreparation
  ): Promise<ClassMethodCatalog> {
    const signal = preparation.controller.signal;
    throwIfAborted(signal);
    await this.releaseOwnedAnalysisSessions(resources);
    throwIfAborted(signal);
    const initialTask = this.dependencies.registry.snapshot(taskId);
    const waveState = await this.dependencies.checkpoints.taskWaveProgress(taskId);
    await this.dependencies.moduleLock.runExclusive(
      initialTask.moduleKey,
      () => isolateOrphanProjectWaveCandidates({
        taskId,
        workspaceRoot: initialTask.workspaceRoot,
        sourceFilePath: initialTask.sourceFilePath,
        candidates: waveState.candidates,
        transaction: resources.transaction
      }),
      signal
    );
    throwIfAborted(signal);
    const build = await this.resolveBuildContext(initialTask, signal);
    await this.markPreloadRunning(initialTask);
    const pendingArtifacts = resources.transaction.artifacts(taskId);
    const includeTaskOwnedArtifacts = shouldIncludeTaskOwnedArtifactsInFingerprint(
      initialTask.state
    );
    const preloadRequest = {
      workspaceRoot: initialTask.workspaceRoot,
      sourceFilePath: initialTask.sourceFilePath,
      buildSettings: build.settings,
      toolchain: build.toolchain,
      watcherVersion: this.watcherVersion(initialTask.moduleKey),
      ownedArtifacts: includeTaskOwnedArtifacts
        ? []
        : pendingArtifacts.map((artifact) => ({
            path: artifact.filePath,
            sha256: artifact.sha256
          })),
      excludedDirectTestArtifacts: pendingArtifacts.map((artifact) => ({
        path: artifact.filePath,
        sha256: artifact.sha256
      }))
    };
    const classReportRequest = {
      ...preloadRequest,
      qualifiedClassName: initialTask.qualifiedClassName,
      targetFilePath: initialTask.sourceFilePath
    };
    let classPair = await this.dependencies.preload.prepareClassReport(
      classReportRequest,
      signal
    );
    throwIfAborted(signal);

    const planned = await this.dependencies.options.testWriterService
      .planGeneratedTestLocation({
        workspaceRoot: initialTask.workspaceRoot,
        targetFilePath: initialTask.sourceFilePath
      });
    const createAnalysisSession = (analysisInput: MavenAnalysisContext) => (
      this.createOwnedAnalysisSession(resources, analysisInput, signal)
    );
    // Same-module Maven commands replace target/classes. Keep dependency collection,
    // Analyzer session creation and its first coverage refresh inside one lock boundary.
    const analyzeClassPair = async (candidate: typeof classPair) => (
      this.dependencies.moduleLock.runExclusive(initialTask.moduleKey, async () => {
        const pair: JacocoArtifactPair = {
          reportPath: candidate.reportPath,
          branchSnapshotPath: candidate.branchSnapshotPath,
          pairId: candidate.reportPairId
        };
        const analysisInput = await this.dependencies.options.mavenAnalysisContextService.collect({
          workspaceRoot: initialTask.workspaceRoot,
          moduleRoot: initialTask.moduleDisplayPath,
          targetSourcePath: initialTask.sourceFilePath,
          targetClass: initialTask.qualifiedClassName,
          plannedTestClassName: planned.testClassName,
          plannedRelativeTestPath: planned.relativeTestPath,
          reportPath: pair.reportPath,
          branchSnapshotPath: pair.branchSnapshotPath,
          reportPairId: pair.pairId,
          buildSettings: build.settings,
          buildToolchain: build.toolchain,
          signal,
          customModelEnvironmentVariable: build.excludedEnvironmentVariables[0]
        });
        let analysis;
        try {
          analysis = await createAnalysisSession(analysisInput);
        } catch (error) {
          if (!isAnalysisCapacityError(error)) throw error;
          await this.releaseInactiveAnalysisSessionsForCapacity(taskId);
          analysis = await createAnalysisSession(analysisInput);
        }
        try {
          const refreshed = await this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.refreshMethodAnalysisCoverage(
              analysis.analysisSessionId,
              {
                reportPath: pair.reportPath,
                branchSnapshotPath: pair.branchSnapshotPath,
                reportPairId: pair.pairId
              },
              signal
            ),
            signal
          );
          return { pair, analysisInput, analysis, refreshed };
        } catch (error) {
          await this.releaseOwnedAnalysisSession(resources, analysis.analysisSessionId);
          throw error;
        }
      }, signal)
    );
    let analyzed;
    let coverageArtifactRetryIndex = 0;
    while (true) {
      try {
        analyzed = await analyzeClassPair(classPair);
        break;
      } catch (error) {
        if (
          !isRetryableCoverageArtifactError(error)
          || coverageArtifactRetryIndex >= MAX_COVERAGE_ARTIFACT_REFRESH_RETRIES
        ) throw error;
        if (signal) throwIfAborted(signal);
        await waitForAnalysisResponseTimeoutRetry(
          coverageArtifactRetryIndex,
          this.dependencies.options,
          signal
        );
        coverageArtifactRetryIndex += 1;
        classPair = await this.dependencies.preload.refreshClassReport(
          classReportRequest,
          signal
        );
        throwIfAborted(signal);
      }
    }
    const { pair, analysisInput, analysis, refreshed } = analyzed;
    try {
      let catalog = toClassMethodCatalog(
        taskId,
        refreshed.catalog,
        this.now(),
        classPair.fingerprint
      );
      const reconciliation = await this.dependencies.registry
        .reconcileCatalogForExecution(taskId, catalog);
      catalog = {
        ...catalog,
        warnings: [...catalog.warnings, ...reconciliation.notices]
      };
      const jacocoContext: TaskJacocoSessionContext = {
        taskId,
        moduleKey: initialTask.moduleKey,
        moduleRoot: initialTask.moduleDisplayPath,
        targetFilePath: initialTask.sourceFilePath,
        qualifiedClassName: initialTask.qualifiedClassName,
        analysisSessionId: analysis.analysisSessionId,
        buildSettings: build.settings,
        baselineExecutionDataPath: classPair.executionDataPath,
        baselinePair: pair,
        baselineCoverage: refreshed.coverage,
        excludedEnvironmentVariables: build.excludedEnvironmentVariables
      };

      let initializedHere = false;
      try {
        const baseline = await this.dependencies.jacoco.initialize(jacocoContext, signal);
        resources.jacocoInitialized = true;
        initializedHere = true;
        let currentCounts = baseline.counts;
        let contributions = this.dependencies.coverageLedger.contributions(taskId);
        let currentPair = pair;
        if (pendingArtifacts.length > 0) {
          const recalculated = await this.dependencies.jacoco.recalculate(
            jacocoContext,
            pendingArtifacts,
            signal
          );
          currentCounts = recalculated.coverage.counts;
          contributions = recalculated.contributions;
          currentPair = recalculated.pair;
          catalog = toClassMethodCatalog(
            taskId,
            recalculated.catalog,
            this.now(),
            classPair.fingerprint
          );
        }
        replaceCoverageArtifactVersions(
          resources,
          pendingArtifacts.filter(shouldRefreshCoverageForArtifact)
        );
        resources.prepared = {
          fingerprint: classPair.fingerprint,
          pair: currentPair,
          analysis: { ...analysis, reportPairId: currentPair.pairId },
          analysisInput: {
            ...analysisInput,
            reportPath: currentPair.reportPath,
            branchSnapshotPath: currentPair.branchSnapshotPath,
            reportPairId: currentPair.pairId
          },
          catalog,
          buildSettings: build.settings,
          buildToolchain: build.toolchain,
          jacoco: jacocoContext,
          excludedEnvironmentVariables: build.excludedEnvironmentVariables
        };
        await this.persistCoverage(resources, currentCounts, contributions);
        throwIfAborted(signal);
        await this.markPreloadReady(initialTask.id, resources, preparation);
        return detached(catalog);
      } catch (error) {
        if (initializedHere) {
          try {
            await this.dependencies.jacoco.remove(jacocoContext);
          } catch {
            // The original preparation failure remains the actionable error.
          }
          resources.jacocoInitialized = false;
        }
        throw error;
      }
    } catch (error) {
      if (resources.prepared?.analysis.analysisSessionId === analysis.analysisSessionId) {
        resources.prepared = null;
      }
      await this.releaseOwnedAnalysisSession(resources, analysis.analysisSessionId);
      throw error;
    }
  }

  private async resolveBuildContext(
    task: ClassTaskSnapshot,
    signal: AbortSignal
  ): Promise<PreparedBuildContext> {
    const settings = await this.dependencies.options.buildSettingsService.get();
    if (!settings) {
      throw new ClassTaskPreparationFailure(this.publicError(
        task,
        'BUILD_SETTINGS_UNAVAILABLE',
        'Build settings are not configured for this workstation.'
      ));
    }
    const view = await this.dependencies.options.modelInterfacesService.getView();
    const activeInterface = view.interfaces.find((item) => item.id === view.activeInterfaceId);
    const excludedEnvironmentVariables = modelCredentialEnvironmentVariables(
      activeInterface?.credentialMode === 'environment'
        ? activeInterface.environmentVariableName
        : undefined
    );
    let validation = settings.validation;
    let toolchain = validation ? extractBuildToolchainContext(validation) : null;
    if (!toolchain) {
      validation = await this.dependencies.options.shellService.validateBuildSettings(
        settings,
        task.moduleDisplayPath,
        { signal, excludedEnvironmentVariables }
      );
      toolchain = extractBuildToolchainContext(validation);
    }
    if (!toolchain) {
      throw new ClassTaskPreparationFailure(this.publicError(
        task,
        'BUILD_SETTINGS_INVALID',
        validation?.error ?? 'Build settings validation failed.',
        validation?.command ?? null
      ));
    }
    return {
      settings: detached(settings),
      toolchain,
      excludedEnvironmentVariables
    };
  }

  private async ensureGenerator(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources,
    signal: AbortSignal
  ): Promise<SingleMethodGenerationService> {
    if (resources.generator) {
      this.ensurePacker(task, resources);
      return resources.generator;
    }
    throwIfAborted(signal);
    this.dependencies.options.assertBackendReady?.();
    const modelRuntime = resources.resolvedModelRuntime;
    if (!modelRuntime) {
      throw new Error('Class task model runtime was not captured for this run.');
    }
    const logging = await this.beginLogging(resources);
    this.ensurePacker(task, resources);
    resources.generator = new SingleMethodGenerationService({
      analyzer: {
        heartbeatMethodAnalysisSession: (sessionId, operationSignal) => (
          this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.heartbeatMethodAnalysisSession(
              sessionId,
              operationSignal
            ),
            operationSignal
          )
        ),
        nextMethodBatch: (sessionId, methodId, request, operationSignal) => (
          this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.nextMethodBatch(
              sessionId, methodId, request, operationSignal
            ),
            operationSignal
          )
        ),
        nextMethodWave: (sessionId, methodId, request, operationSignal) => (
          this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.nextMethodWave(
              sessionId, methodId, request, operationSignal
            ),
            operationSignal
          )
        ),
        nextClassScenarioWave: (sessionId, request, operationSignal) => (
          this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.nextClassScenarioWave(
              sessionId, request, operationSignal
            ),
            operationSignal
          )
        ),
        getMethodRepairContext: (sessionId, request, operationSignal) => (
          this.retryHealthyAnalyzerTransientResponseFailure(
            () => this.dependencies.options.aiClient.getMethodRepairContext(
              sessionId, request, operationSignal
            ),
            operationSignal
          )
        )
      },
      agent: this.dependencies.options.aiClient,
      contextProvider: {
        resolve: async () => {
          const current = this.requirePrepared(resources);
          return {
            analysisSessionId: current.analysis.analysisSessionId,
            reportPairId: current.catalog.reportPairId,
            sourceSha256: current.analysis.sourceSha256,
            packageName: current.analysis.packageName,
            plannedRelativeTestPath: current.analysis.suggestedRelativeTestPath,
            moduleRoot: task.moduleDisplayPath,
            buildSettings: current.buildSettings,
            buildToolchain: current.buildToolchain,
            modelContext: { llmConfig: modelRuntime.llmConfig },
            captureModelCalls: logging.enabled,
            mavenEnvironmentFingerprint: mavenExecutionEnvironmentFingerprint(
              task,
              current
            ),
            methodCatalog: current.catalog.methods,
            ...(resources.ragRunContext
              ? { ragContext: resources.ragRunContext }
              : {}),
            ...(resources.ragRunContext && resources.ragSubscription
              ? { ragSubscription: resources.ragSubscription }
              : {}),
            ...(resources.ragRunContext && resources.resolvedRagEmbeddingRuntime
              ? { ragEmbeddingConfig: resources.resolvedRagEmbeddingRuntime.embeddingConfig }
              : {}),
            excludedEnvironmentVariables: current.excludedEnvironmentVariables
          };
        }
      },
      checkpoints: this.dependencies.checkpoints,
      partStore: this.partStore,
      moduleLock: this.dependencies.moduleLock,
      mavenReadyQueue: this.dependencies.mavenReadyQueue,
      candidateFiles: resources.transaction,
      writer: this.dependencies.options.testWriterService,
      maven: this.dependencies.maven,
      pruner: this.dependencies.pruner,
      merger: this.dependencies.bundleMerger,
      logs: resources.logs,
      ragIndexCoordinator: this.dependencies.options.ragIndexCoordinator,
      ragIndexRefreshWaitMilliseconds: this.dependencies.options.ragIndexWaitMilliseconds,
      publishedWaveRecovery: {
        restore: (input) => this.restorePublishedWaveBundle(resources, input)
      },
      randomUUID: this.dependencies.idFactory
    });
    return resources.generator;
  }

  private ensurePacker(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources
  ): FormalTestFilePackerService {
    if (resources.packer) return resources.packer;
    const prepared = this.requirePrepared(resources);
    prepared.excludedEnvironmentVariables = [...new Set([
      ...prepared.excludedEnvironmentVariables,
      ...modelCredentialEnvironmentVariables(
        resources.resolvedModelRuntime?.credentialEnvironmentVariable
      ),
      ...modelCredentialEnvironmentVariables(
        resources.resolvedRagEmbeddingRuntime?.credentialEnvironmentVariable
      )
    ])];
    resources.packer = new FormalTestFilePackerService({
      taskId: task.id,
      workspaceRoot: task.workspaceRoot,
      moduleRoot: task.moduleDisplayPath,
      moduleKey: task.moduleKey,
      targetFilePath: task.sourceFilePath,
      qualifiedClassName: task.qualifiedClassName,
      buildSettings: prepared.buildSettings,
      writer: this.dependencies.options.testWriterService,
      reservations: this.dependencies.fileReservations,
      transaction: resources.transaction,
      moduleLock: this.dependencies.moduleLock,
      maven: this.dependencies.maven,
      merger: this.dependencies.bundleMerger,
      excludedEnvironmentVariables: prepared.excludedEnvironmentVariables,
      idFactory: this.dependencies.idFactory
    });
    return resources.packer;
  }

  private async ensureBatchGenerator(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources,
    signal: AbortSignal
  ): Promise<DataClassGenerationBatchService> {
    if (resources.batchGenerator) return resources.batchGenerator;
    throwIfAborted(signal);
    this.dependencies.options.assertBackendReady?.();
    const modelRuntime = resources.resolvedModelRuntime;
    if (!modelRuntime) {
      throw new Error('Class task model runtime was not captured for this run.');
    }
    const logging = await this.beginLogging(resources);
    const prepared = this.requirePrepared(resources);
    prepared.excludedEnvironmentVariables = [...new Set([
      ...prepared.excludedEnvironmentVariables,
      ...modelCredentialEnvironmentVariables(modelRuntime.credentialEnvironmentVariable),
      ...modelCredentialEnvironmentVariables(
        resources.resolvedRagEmbeddingRuntime?.credentialEnvironmentVariable
      )
    ])];
    resources.batchGenerator = new DataClassGenerationBatchService({
      analyzer: this.dependencies.options.aiClient,
      agent: this.dependencies.options.aiClient,
      contextProvider: {
        resolve: async () => {
          const current = this.requirePrepared(resources);
          return {
            analysisSessionId: current.analysis.analysisSessionId,
            reportPairId: current.catalog.reportPairId,
            packageName: current.analysis.packageName,
            plannedRelativeTestPath: current.analysis.suggestedRelativeTestPath,
            moduleRoot: task.moduleDisplayPath,
            buildSettings: current.buildSettings,
            modelContext: { llmConfig: modelRuntime.llmConfig },
            captureModelCalls: logging.enabled,
            excludedEnvironmentVariables: current.excludedEnvironmentVariables
          };
        }
      },
      checkpoints: this.dependencies.checkpoints,
      moduleLock: this.dependencies.moduleLock,
      writer: this.dependencies.options.testWriterService,
      candidateFiles: resources.transaction,
      maven: this.dependencies.maven,
      logs: resources.logs,
      randomUUID: this.dependencies.idFactory
    });
    return resources.batchGenerator;
  }

  private async cleanupTemporaryFiles(
    task: ClassTaskSnapshot,
    onlyMethodIds?: readonly string[]
  ): Promise<void> {
    const progress = await this.dependencies.checkpoints.taskProgress(task.id);
    const methodIds = onlyMethodIds ?? progress.completedMethodIds;
    const ownedFiles = new Map<string, { filePath: string; sha256: string }>();
    for (const methodId of methodIds) {
      const method = progress.methods[methodId];
      if (!method) continue;
      for (const batch of method.completedBatches) {
        if (!shouldCleanupCompletedBatchTemporaryFile(batch)) continue;
        const filePath = batch.tmpFilePath as string;
        const sha256 = batch.tmpFileSha256 as string;
        ownedFiles.set(`${filePath}\0${sha256}`, { filePath, sha256 });
      }
    }
    for (const owned of ownedFiles.values()) {
      await this.dependencies.moduleLock.runExclusive(task.moduleKey, async () => {
        try {
          await this.dependencies.options.testWriterService.deleteGeneratedTest({
            workspaceRoot: task.workspaceRoot,
            filePath: owned.filePath,
            expectedSha256: owned.sha256
          });
        } catch (error) {
          if (!isMissingPath(error)) throw error;
        }
      });
    }
  }

  private async cleanupRestartTemporaryFiles(
    task: ClassTaskSnapshot
  ): Promise<void> {
    const progress = await this.dependencies.checkpoints.taskProgress(task.id);
    for (const method of Object.values(progress.methods)) {
      for (const batch of method.completedBatches) {
        if (!shouldDiscardBatchTemporaryFileOnRestart(batch)) continue;
        await this.dependencies.moduleLock.runExclusive(task.moduleKey, async () => {
          try {
            await this.dependencies.options.testWriterService.deleteGeneratedTest({
              workspaceRoot: task.workspaceRoot,
              filePath: batch.tmpFilePath as string,
              expectedSha256: batch.tmpFileSha256 as string
            });
          } catch (error) {
            if (!isMissingPath(error)) throw error;
          }
        });
      }
    }
  }

  private async failedRunRecoveryFilesExist(task: ClassTaskSnapshot): Promise<boolean> {
    const pendingArtifacts = task.generatedArtifacts.filter((artifact) => !artifact.accepted);
    const formalizedMethodIds = new Set(
      pendingArtifacts.flatMap((artifact) => artifact.methodIds)
    );
    const requiredFiles = new Map<string, { filePath: string; sha256: string }>();
    const requireFile = (filePath: string, sha256: string) => {
      requiredFiles.set(`${pathKey(filePath)}\0${sha256.toLowerCase()}`, {
        filePath,
        sha256
      });
    };
    for (const artifact of pendingArtifacts) {
      requireFile(artifact.filePath, artifact.sha256);
    }

    const progress = await this.dependencies.checkpoints.taskProgress(task.id);
    for (const methodId of task.methodOrder) {
      if (formalizedMethodIds.has(methodId)) continue;
      const method = progress.methods[methodId];
      if (!method) continue;
      for (const batch of method.completedBatches) {
        if (!shouldCleanupCompletedBatchTemporaryFile(batch)) continue;
        requireFile(batch.tmpFilePath as string, batch.tmpFileSha256 as string);
      }
      if (method.inProgressBatch) {
        requireFile(
          method.inProgressBatch.tmpFilePath,
          method.inProgressBatch.tmpFileSha256
        );
      }
    }

    const waveProgress = await this.dependencies.checkpoints.taskWaveProgress(task.id);
    const publishedActiveWave = waveProgress.activeWave
      ? findPublishedWaveArtifact(
          pendingArtifacts,
          waveProgress.activeWave.methodId,
          waveProgress.activeWave.waveIndex
        )
      : null;
    const managedActiveWaveCandidate = waveProgress.activeWave
      ? Object.values(waveProgress.candidates).find((candidate) => (
          candidate.methodId === waveProgress.activeWave?.methodId
          && candidate.waveId === waveProgress.activeWave.waveId
          && (candidate.managedFile !== null || candidate.moveTransaction !== null)
        )) ?? null
      : null;
    for (const candidate of Object.values(waveProgress.candidates)) {
      if (
        publishedActiveWave
        && candidate.methodId === waveProgress.activeWave?.methodId
        && candidate.waveId === waveProgress.activeWave.waveId
      ) {
        continue;
      }
      if (candidate.managedFile) {
        requireFile(candidate.managedFile.path, candidate.managedFile.sha256);
      }
    }
    if (!publishedActiveWave && !managedActiveWaveCandidate) {
      for (const part of waveProgress.activeWave?.parts ?? []) {
        if (part.status === 'SUCCEEDED' && part.isolatedFilePath && part.fileSha256) {
          requireFile(part.isolatedFilePath, part.fileSha256);
        }
      }
    }

    for (const required of requiredFiles.values()) {
      try {
        await this.dependencies.options.testWriterService.assertGeneratedTestUnchanged({
          workspaceRoot: task.workspaceRoot,
          filePath: required.filePath,
          expectedSha256: required.sha256
        });
      } catch (error) {
        if (isMissingPath(error)) return false;
        if (isGeneratedTestExternallyModifiedError(error)) continue;
        throw error;
      }
    }
    return true;
  }

  private async recordPreparationFailure(taskId: string, error: unknown): Promise<void> {
    let task: ClassTaskSnapshot;
    try {
      task = this.dependencies.registry.snapshot(taskId);
    } catch {
      return;
    }
    if (error instanceof ClassPreloadMavenFailureError) {
      await this.dependencies.registry.applyClassPreloadFailure(
        taskId,
        this.publicError(
          task,
          'CLASS_PRELOAD_MAVEN_FAILED',
          `${error.diagnostic.summary} ${error.diagnostic.repairInstruction}`,
          error.diagnostic.command
        )
      );
      return;
    }
    let moduleSnapshot: ModulePreloadSnapshot | null = null;
    try {
      moduleSnapshot = await this.dependencies.preloadCache.get(task.moduleKey);
    } catch {
      // The class task must still leave RUNNING when its disposable preload cache is unreadable.
    }
    if (error instanceof ModulePreloadFailureError) {
      if (moduleSnapshot) {
        await this.dependencies.registry.applyModulePreloadSnapshot(
          task.moduleKey,
          moduleSnapshot
        );
        return;
      }
    }
    if (
      moduleSnapshot?.state === 'READY'
      && moduleSnapshot.classPreloadFailures[task.qualifiedClassName]
    ) {
      await this.dependencies.registry.applyModulePreloadSnapshot(
        task.moduleKey,
        moduleSnapshot
      );
      return;
    }
    const publicError = error instanceof ClassTaskPreparationFailure
      ? error.publicError
      : this.publicError(
          task,
          error instanceof ModulePreloadStoppedError
            ? 'MODULE_PRELOAD_STOPPED'
            : 'CLASS_PRELOAD_FAILED',
          error instanceof Error ? error.message : String(error)
        );
    await this.dependencies.registry.applyClassPreloadFailure(taskId, publicError);
  }

  private async markPreloadRunning(task: ClassTaskSnapshot): Promise<void> {
    const current = this.dependencies.registry.snapshot(task.id);
    if (current.state === 'PRELOADING' && current.preloadState !== 'RUNNING') {
      await this.dependencies.registry.save({
        ...current,
        preloadState: 'RUNNING',
        lastError: null,
        updatedAt: this.now()
      });
    }
  }

  private async markPreloadReady(
    taskId: string,
    resources: ProductionTaskResources,
    preparation: TaskPreparation
  ): Promise<void> {
    const current = this.dependencies.registry.snapshot(taskId);
    if (current.state !== 'PRELOADING') return;
    const ready = transitionClassTask(current, 'READY', { now: this.now() });
    this.assertCurrentPreparation(resources, preparation);
    // save() synchronously enters the adapter queue before yielding. Keeping the
    // token check and enqueue contiguous makes this the preparation commit point.
    await this.dependencies.registry.save(ready);
  }

  private assertCurrentPreparation(
    resources: ProductionTaskResources,
    preparation: TaskPreparation
  ): void {
    if (preparation.controller.signal.aborted) {
      throw preparation.controller.signal.reason;
    }
    if (resources.preparation !== preparation) {
      throw new Error('Class task preparation was superseded before READY commit.');
    }
  }

  private async persistArtifacts(resources: ProductionTaskResources): Promise<void> {
    const task = this.dependencies.registry.snapshot(resources.taskId);
    await this.dependencies.registry.save({
      ...task,
      generatedArtifacts: uniqueArtifacts([
        ...resources.acceptedArtifacts,
        ...resources.transaction.artifacts(resources.taskId)
      ]),
      updatedAt: this.now()
    });
  }

  private async persistCoverage(
    resources: ProductionTaskResources,
    current: ExactCoverageCounts,
    contributions: ClassTaskSnapshot['coverageContributions']
  ): Promise<void> {
    const baseline = this.dependencies.coverageLedger.baseline(resources.taskId).counts;
    const task = this.dependencies.registry.snapshot(resources.taskId);
    await this.dependencies.registry.save({
      ...task,
      generatedArtifacts: uniqueArtifacts([
        ...resources.acceptedArtifacts,
        ...resources.transaction.artifacts(resources.taskId)
      ]),
      coveredMethodIds: this.requirePrepared(resources).catalog.methods
        .filter((method) => !method.coverageGap)
        .map((method) => method.methodId),
      coverageBaseline: detached(baseline),
      coverageCurrent: detached(current),
      coverageContributions: detached(contributions),
      updatedAt: this.now()
    });
  }

  private updatePreparedCoverage(
    resources: ProductionTaskResources,
    pair: JacocoArtifactPair,
    catalog: MethodCatalogResponse
  ): void {
    const prepared = this.requirePrepared(resources);
    prepared.pair = { ...pair };
    prepared.analysis = { ...prepared.analysis, reportPairId: pair.pairId };
    prepared.analysisInput = {
      ...prepared.analysisInput,
      reportPath: pair.reportPath,
      branchSnapshotPath: pair.branchSnapshotPath,
      reportPairId: pair.pairId
    };
    prepared.catalog = toClassMethodCatalog(
      resources.taskId,
      catalog,
      this.now(),
      prepared.fingerprint
    );
  }

  private async createOwnedAnalysisSession(
    resources: ProductionTaskResources,
    analysisInput: MavenAnalysisContext,
    signal?: AbortSignal
  ): Promise<CreateMethodAnalysisSessionResponse> {
    let recoverableSessionRetryIndex = 0;
    while (true) {
      try {
        return await this.retryHealthyAnalyzerTransientResponseFailure(async () => {
          const analysisSessionId = this.dependencies.idFactory();
          resources.ownedAnalysisSessionIds.add(analysisSessionId);
          try {
            return await this.dependencies.options.aiClient.createMethodAnalysisSession({
              ...analysisInput,
              analysisSessionId
            }, signal);
          } catch (error) {
            await this.releaseOwnedAnalysisSession(resources, analysisSessionId);
            throw error;
          }
        }, signal);
      } catch (error) {
        if (!isRecoverableAnalysisSessionError(error)) throw error;
        if (signal) throwIfAborted(signal);
        await waitForAnalysisResponseTimeoutRetry(
          recoverableSessionRetryIndex,
          this.dependencies.options,
          signal
        );
        recoverableSessionRetryIndex += 1;
      }
    }
  }

  private async retryHealthyAnalyzerTransientResponseFailure<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    let timeoutRetryIndex = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (
          !isJavaAnalyzerResponseTimeoutError(error)
          && !isMethodAnalysisResponseInvalidError(error)
          && !(
            error instanceof MethodAnalysisRequestError
            && error.code === 'ANALYSIS_SESSION_BUSY'
          )
        ) {
          throw error;
        }
        if (signal) throwIfAborted(signal);
        if (!await this.dependencies.options.aiClient.isJavaAnalyzerHealthy(signal)) {
          throw error;
        }
        await waitForAnalysisResponseTimeoutRetry(
          timeoutRetryIndex,
          this.dependencies.options,
          signal
        );
        timeoutRetryIndex += 1;
      }
    }
  }

  private async releaseOwnedAnalysisSession(
    resources: ProductionTaskResources,
    sessionId: string
  ): Promise<boolean> {
    if (!resources.ownedAnalysisSessionIds.has(sessionId)) return false;
    try {
      await this.dependencies.options.aiClient.deleteMethodAnalysisSession(sessionId);
      resources.ownedAnalysisSessionIds.delete(sessionId);
      return true;
    } catch {
      // A failed best-effort release remains owned so a later lifecycle boundary can retry it.
      return false;
    }
  }

  private async releaseOwnedAnalysisSessions(
    resources: ProductionTaskResources
  ): Promise<number> {
    const released = await Promise.all(
      [...resources.ownedAnalysisSessionIds].map((sessionId) => (
        this.releaseOwnedAnalysisSession(resources, sessionId)
      ))
    );
    return released.filter(Boolean).length;
  }

  private releaseOwnedAnalysisSessionsInBackground(
    resources: ProductionTaskResources
  ): void {
    const sessionIds = [...resources.ownedAnalysisSessionIds];
    for (const sessionId of sessionIds) {
      resources.ownedAnalysisSessionIds.delete(sessionId);
    }
    void Promise.allSettled(
      sessionIds.map((sessionId) => (
        this.dependencies.options.aiClient.deleteMethodAnalysisSession(sessionId)
      ))
    );
  }

  private async releaseInactiveAnalysisSessionsForCapacity(
    currentTaskId: string
  ): Promise<number> {
    const releases: Promise<number>[] = [];
    for (const resources of this.resources.values()) {
      if (resources.taskId === currentTaskId) continue;
      let state: ClassTaskSnapshot['state'];
      try {
        state = this.dependencies.registry.snapshot(resources.taskId).state;
      } catch {
        continue;
      }
      if (state === 'PRELOADING' || ACTIVE_STATES.has(state)) continue;
      releases.push(this.releaseOwnedAnalysisSessions(resources));
    }
    return (await Promise.all(releases)).reduce((total, released) => total + released, 0);
  }

  private async resetPrepared(resources: ProductionTaskResources): Promise<void> {
    resources.preparation?.controller.abort(new Error('Module preload is being retried.'));
    await Promise.allSettled([
      resources.preparation?.promise ?? Promise.resolve(),
      resources.logs.finish()
    ]);
    const cleanup = await Promise.allSettled([
      this.dependencies.ragRuns.suspendRun(resources),
      resources.jacocoInitialized && resources.prepared
        ? this.dependencies.jacoco.remove(resources.prepared.jacoco)
        : Promise.resolve(),
      this.releaseOwnedAnalysisSessions(resources)
    ]);
    resources.prepared = null;
    resources.preparation = null;
    resources.jacocoInitialized = false;
    resources.packer = null;
    resources.generator = null;
    resources.batchGenerator = null;
    resources.loggingPromise = null;
    resources.coverageArtifactSha256ById.clear();
    const failure = cleanup.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async resultSnapshot(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources
  ): Promise<ClassTaskResultSnapshot> {
    if (!task.coverageBaseline || !task.coverageCurrent) {
      throw new Error('The class task has no exact coverage result.');
    }
    const currentArtifacts = resources.transaction.artifacts(task.id);
    const waveProgress = await this.dependencies.checkpoints.taskWaveProgress(task.id);
    const methodProgress = Object.values(waveProgress.methods);
    const allScenariosSkipped = task.state === 'COMPLETED'
      && task.generatedArtifacts.length === 0
      && methodProgress.some((method) => method.skippedScenarioIds.length > 0)
      && methodProgress.every((method) => method.completedScenarioIds.length === 0);
    return {
      taskId: task.id,
      state: task.state,
      artifacts: task.generatedArtifacts.map(detached),
      generatedMethods: generatedResultMethodsFromArtifacts(task.generatedArtifacts),
      allScenariosSkipped,
      tokenUsage: task.tokenUsage ? detached(task.tokenUsage) : null,
      modelCallCount: task.modelCallCount,
      usageReportedCallCount: task.usageReportedCallCount,
      coverageBaseline: detached(task.coverageBaseline),
      coverageCurrent: detached(task.coverageCurrent),
      coverageContributions: detached(task.coverageContributions),
      canAccept: currentArtifacts.length > 0,
      canRevoke: currentArtifacts.length > 0
    };
  }

  private async requireResult(
    taskId: string,
    resources: ProductionTaskResources
  ): Promise<ClassTaskResultSnapshot> {
    const task = this.dependencies.registry.snapshot(taskId);
    return this.resultSnapshot(task, resources);
  }

  private async reconcileUnavailableGeneratedArtifacts(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources
  ): Promise<boolean> {
    const retainedAccepted: GeneratedClassTaskArtifact[] = [];
    let changed = false;
    for (const artifact of resources.acceptedArtifacts) {
      try {
        await this.dependencies.options.testWriterService.assertGeneratedTestUnchanged({
          workspaceRoot: task.workspaceRoot,
          filePath: artifact.filePath,
          expectedSha256: artifact.sha256
        });
        retainedAccepted.push(artifact);
      } catch (error) {
        if (isMissingPath(error)) {
          changed = true;
          continue;
        }
        if (isGeneratedTestExternallyModifiedError(error)) {
          retainedAccepted.push(artifact);
          continue;
        }
        throw error;
      }
    }

    const retainedPending: GeneratedClassTaskArtifact[] = [];
    for (const artifact of task.generatedArtifacts.filter((candidate) => !candidate.accepted)) {
      try {
        await this.dependencies.options.testWriterService.assertGeneratedTestUnchanged({
          workspaceRoot: task.workspaceRoot,
          filePath: artifact.filePath,
          expectedSha256: artifact.sha256
        });
        retainedPending.push(artifact);
      } catch (error) {
        if (isUnavailableRestoredArtifact(error)) {
          changed = true;
          continue;
        }
        throw error;
      }
    }
    if (!changed) return false;

    const reconciledTransaction = this.createTransaction();
    await reconciledTransaction.restoreTask({
      taskId: task.id,
      workspaceRoot: task.workspaceRoot,
      artifacts: retainedPending
    });
    await this.resetPrepared(resources);
    resources.acceptedArtifacts = retainedAccepted.map(detached);
    resources.transaction = reconciledTransaction;
    const latest = this.dependencies.registry.snapshot(task.id);
    await this.dependencies.registry.save({
      ...latest,
      generatedArtifacts: uniqueArtifacts([
        ...resources.acceptedArtifacts,
        ...retainedPending
      ]),
      coveredMethodIds: [],
      coverageBaseline: null,
      coverageCurrent: null,
      coverageContributions: [],
      completionAttentionPending: retainedPending.length > 0
        ? latest.completionAttentionPending
        : false,
      updatedAt: this.now()
    });
    return true;
  }

  private async restorePendingResultArtifacts(
    task: ClassTaskSnapshot,
    resources: ProductionTaskResources
  ): Promise<void> {
    const pending = task.generatedArtifacts.filter((artifact) => !artifact.accepted);
    if (pending.length === 0) return;
    const current = resources.transaction.artifacts(task.id);
    const ownershipMatches = current.length === pending.length
      && pending.every((artifact) => current.some((tracked) => (
        tracked.id === artifact.id
        && tracked.sha256 === artifact.sha256
        && pathKey(tracked.filePath) === pathKey(artifact.filePath)
      )));
    if (ownershipMatches) return;
    if (current.length > 0) {
      throw new Error('The class-task result ownership is inconsistent.');
    }
    const restored = this.createTransaction();
    await restored.restoreTask({
      taskId: task.id,
      workspaceRoot: task.workspaceRoot,
      artifacts: pending
    });
    resources.transaction = restored;
  }

  private moduleTasks(workspaceRoot: string, modulePath: string): ClassTaskSnapshot[] {
    return this.dependencies.registry.list(workspaceRoot).filter((task) => (
      pathKey(task.moduleDisplayPath) === pathKey(modulePath)
    ));
  }

  private resourceFor(taskId: string): ProductionTaskResources {
    let resources = this.resources.get(taskId);
    if (resources) return resources;
    resources = {
      taskId,
      acceptedArtifacts: [],
      transaction: this.createTransaction(),
      restored: false,
      prepared: null,
      preparation: null,
      ownedAnalysisSessionIds: new Set(),
      packer: null,
      generator: null,
      batchGenerator: null,
      logs: new MethodGenerationLogService(),
      loggingPromise: null,
      jacocoInitialized: false,
      coverageArtifactSha256ById: new Map(),
      ragSubscription: null,
      ragRunContext: undefined,
      ragTaskRun: undefined,
      ragPreflightEnabled: undefined,
      ragToolCallingProbe: null,
      resolvedModelRuntime: null,
      resolvedRagEmbeddingRuntime: null
    };
    this.resources.set(taskId, resources);
    return resources;
  }

  private createTransaction(): ClassTaskFileTransactionService {
    return new ClassTaskFileTransactionService({
      writer: this.dependencies.options.testWriterService,
      idFactory: this.dependencies.idFactory,
      now: this.dependencies.clock
    });
  }

  private beginLogging(
    resources: ProductionTaskResources
  ): Promise<ModelCallLogSettings> {
    resources.loggingPromise ??= (async () => {
      const settings = await this.dependencies.options.modelCallLogSettingsService.get();
      await resources.logs.begin(settings);
      return settings;
    })();
    return resources.loggingPromise;
  }

  private requirePrepared(resources: ProductionTaskResources): PreparedTaskContext {
    if (!resources.prepared) {
      throw new Error(`Class task ${resources.taskId} is not prepared.`);
    }
    return resources.prepared;
  }

  private requirePacker(resources: ProductionTaskResources): FormalTestFilePackerService {
    if (!resources.packer) {
      throw new Error(`Class task ${resources.taskId} has no formal-file packer.`);
    }
    return resources.packer;
  }

  private publicError(
    task: ClassTaskSnapshot,
    code: string,
    message: string,
    command: string | null = null
  ): PublicTaskError {
    return {
      code: sanitizePublicText(code),
      message: compactPublicTaskErrorText(message) || 'Class task preparation failed.',
      moduleName: basename(task.moduleDisplayPath),
      modulePath: task.moduleDisplayPath,
      command: command ? compactPublicTaskErrorText(command) : null,
      occurredAt: this.now()
    };
  }

  private watcherVersion(moduleKey: string): number {
    const value = this.dependencies.options.watcherVersion?.(moduleKey) ?? 0;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private now(): string {
    return this.dependencies.clock().toISOString();
  }

  private async atomic<T>(
    taskId: string,
    step: Parameters<ClassTaskCheckpointService['beginAtomicStep']>[1],
    operation: () => Promise<T>
  ): Promise<T> {
    await this.dependencies.checkpoints.beginAtomicStep(taskId, step);
    try {
      return await operation();
    } finally {
      await this.dependencies.checkpoints.completeAtomicStep(taskId, step);
    }
  }
}

export function shouldPreserveFailedRunWaveCheckpoint(
  wave: ClassTaskWaveCheckpoint,
  completedMethodIds: ReadonlySet<string>
): boolean {
  const activeWave = wave.activeWave;
  if (activeWave && !completedMethodIds.has(activeWave.methodId)) {
    const hasTerminalPart = activeWave.parts.some((part) => (
      part.status === 'SUCCEEDED'
        || part.status === 'FAILED'
        || part.status === 'CANCELLED'
    ));
    if (hasTerminalPart) return true;
  }
  if (Object.values(wave.candidates).some((candidate) => (
    !completedMethodIds.has(candidate.methodId)
      && candidate.status !== 'BLOCKED'
  ))) {
    return true;
  }
  return Object.entries(wave.methods).some(([methodId, method]) => (
    !completedMethodIds.has(methodId) && method.completedWaves.length > 0
  ));
}

export function shouldCleanupCompletedBatchTemporaryFile(
  batch: Pick<
    MethodBatchCheckpoint,
    'outcome' | 'tmpFilePath' | 'tmpFileSha256'
  >
): boolean {
  return (batch.outcome === 'PASSED' || batch.outcome === 'RETAINED')
    && batch.tmpFilePath !== null
    && batch.tmpFileSha256 !== null;
}

export function shouldRefreshCoverageForArtifact(
  artifact: Pick<GeneratedClassTaskArtifact, 'ordinaryTestMethodCount'>
): boolean {
  return artifact.ordinaryTestMethodCount > 0;
}

/** Terminal results are stable project inputs, so their generated tests must affect freshness. */
export function shouldIncludeTaskOwnedArtifactsInFingerprint(
  state: ClassTaskSnapshot['state']
): boolean {
  return state === 'COMPLETED' || state === 'TERMINATED';
}

function sameCoverageArtifactVersions(
  artifacts: readonly GeneratedClassTaskArtifact[],
  versions: ReadonlyMap<string, string>
): boolean {
  return artifacts.length === versions.size && artifacts.every((artifact) => (
    versions.get(artifact.id) === artifact.sha256
  ));
}

function replaceCoverageArtifactVersions(
  resources: ProductionTaskResources,
  artifacts: readonly GeneratedClassTaskArtifact[]
): void {
  resources.coverageArtifactSha256ById.clear();
  for (const artifact of artifacts) {
    resources.coverageArtifactSha256ById.set(artifact.id, artifact.sha256);
  }
}

export function shouldDiscardBatchTemporaryFileOnRestart(
  batch: Pick<
    MethodBatchCheckpoint,
    'outcome' | 'tmpFilePath' | 'tmpFileSha256'
  >
): boolean {
  return batch.tmpFilePath !== null && batch.tmpFileSha256 !== null;
}

function compactPublicTaskErrorText(value: string): string {
  return sanitizePublicText(value)
    .replace(/[\u0000-\u0020\u007f]+/g, ' ')
    .trim()
    .slice(0, MAX_PUBLIC_TASK_ERROR_TEXT_LENGTH);
}

function mavenExecutionEnvironmentFingerprint(
  task: ClassTaskSnapshot,
  prepared: PreparedTaskContext
): string {
  const normalizePath = (value: string | undefined): string | null => (
    value ? resolve(value).replace(/\\/gu, '/').toLowerCase() : null
  );
  return createHash('sha256').update(JSON.stringify({
    workspaceRoot: normalizePath(task.workspaceRoot),
    moduleKey: task.moduleKey,
    moduleRoot: normalizePath(task.moduleDisplayPath),
    buildSettings: {
      mavenHome: normalizePath(prepared.buildSettings.mavenHome),
      javaHome: normalizePath(prepared.buildSettings.javaHome),
      settingsPath: normalizePath(prepared.buildSettings.settingsPath),
      localRepository: normalizePath(prepared.buildSettings.localRepository)
    },
    buildToolchain: prepared.buildToolchain,
    excludedEnvironmentVariables: [...prepared.excludedEnvironmentVariables].sort()
  }), 'utf8').digest('hex');
}

/** Builds the single production ownership graph used by Electron main. */
export function createProductionClassTaskRuntime(
  options: ProductionClassTaskRuntimeOptions
): ClassTaskRuntimeService {
  if (!options.storageDirectory?.trim()) {
    throw new TypeError('Class-task storage directory cannot be empty.');
  }
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const identity = new ModuleIdentityService();
  const fingerprint = new ModuleFingerprintService(identity, clock);
  const store = new ClassTaskStore(
    join(options.storageDirectory, 'class-tasks-v2.json'),
    clock
  );
  const registryService = new ClassTaskRegistryService({
    store,
    identityService: identity,
    clock,
    idFactory,
    broadcast: options.broadcast
  });
  const registry = new ClassTaskRegistryStateAdapter({
    registry: registryService,
    store,
    broadcast: options.broadcast,
    clock
  });
  const checkpoints = new ClassTaskCheckpointService({
    storagePath: join(options.storageDirectory, 'class-task-checkpoints-v2.json'),
    taskState: registry,
    clock
  });
  const preloadCache = new ModulePreloadCacheStore(
    join(options.storageDirectory, 'module-preload-cache-v1.json')
  );
  const moduleLock = new ModuleOperationLock();
  const preload = new ModulePreloadCoordinator({
    identityService: identity,
    fingerprintService: fingerprint,
    cache: preloadCache,
    lock: moduleLock,
    shellService: options.shellService,
    directTestLocator: new DirectTestLocatorService(),
    jacocoArtifactsService: options.jacocoArtifactsService,
    targetReport: options.aiClient,
    clock
  });
  const fileReservations = new GeneratedTestNameReservationService();
  const maven = new MavenCandidateExecutorService(
    options.shellService,
    options.surefireReportService
  );
  const mavenReadyQueue = createExecutableModuleMavenReadyQueue({
    moduleLock,
    maven,
    idFactory
  });
  const pruner = new GeneratedTestFailurePrunerService();
  const bundleMerger = new MethodTestBundleMergerService();
  const coverageLedger = new ClassCoverageLedgerService();
  const ragRuns = new ClassTaskRagRunService({
    indexCoordinator: options.ragIndexCoordinator ?? {
      async subscribeInitial(): Promise<never> {
        throw new Error('RAG index coordinator is unavailable.');
      },
      async releaseAll() {}
    },
    modelInterfaces: options.modelInterfacesService,
    modelCapabilities: options.aiClient,
    taskRuns: options.aiClient,
    checkpoints,
    knowledge: {
      ensureTaskKnowledge: options.ensureRagTaskKnowledge ?? (async () => {
        throw new Error('RAG task knowledge service is unavailable.');
      })
    },
    embeddingInterfaces: options.ragEmbeddingInterfacesService ?? {
      async resolveRuntime() { return null; }
    },
    resolveMavenHomeDefaults: async (mavenHome) => {
      const resolver = options.buildSettingsService.resolveMavenHomeDefaults;
      if (!resolver) throw new Error('Maven local repository is unavailable.');
      return resolver.call(options.buildSettingsService, mavenHome);
    },
    waitMilliseconds: options.ragIndexWaitMilliseconds,
    telemetry: options.ragTelemetry,
    idFactory
  });
  const jacoco = new TaskJacocoSessionService({
    artifacts: options.jacocoArtifactsService,
    ledger: coverageLedger,
    moduleLock,
    maven: options.shellService,
    targetReport: options.aiClient,
    analyzer: options.aiClient,
    idFactory
  });
  const coordinator = new ProductionClassTaskCoordinator({
    options,
    registry,
    checkpoints,
    identity,
    fingerprint,
    preloadCache,
    preload,
    moduleLock,
    mavenReadyQueue,
    fileReservations,
    maven,
    pruner,
    bundleMerger,
    ragRuns,
    coverageLedger,
    jacoco,
    clock,
    idFactory
  });
  const runner = new ClassTaskRunnerService({
    checkpoints,
    methodExecution: coordinator
  });
  const scheduler = new ClassTaskSchedulerService({
    registry,
    checkpoints,
    runner,
    catalogProvider: { get: (taskId, signal) => coordinator.prepare(taskId, signal) },
    validateTask: async (task, signal) => {
      options.assertBackendReady?.();
      await coordinator.prepareRun(task, signal);
    },
    clock
  });
  const runtimeRegistry: ClassTaskRuntimeRegistryPort = {
    initialize: () => registryService.initialize(),
    add: (request) => registry.add(request),
    remove: (taskId) => checkpoints.removeTask(taskId),
    reorder: (workspaceRoot, taskIds) => registry.reorder(workspaceRoot, taskIds),
    list: (workspaceRoot) => registry.list(workspaceRoot),
    snapshot: (taskId) => registry.snapshot(taskId),
    save: (snapshot) => registry.save(snapshot),
    saveSelection: (
      taskId, selectionMode, selectedMethodIds, methodOrder, ragEnabled,
      repairAttemptLimit, unlimitedRepair
    ) => (
      registry.saveSelection(
        taskId, selectionMode, selectedMethodIds, methodOrder, ragEnabled,
        repairAttemptLimit, unlimitedRepair
      )
    )
  };
  return new ClassTaskRuntimeService({
    registry: runtimeRegistry,
    scheduler,
    coordinator,
    recordTaskExecution: options.recordTaskExecution,
    flushTaskState: async () => {
      await checkpoints.flush();
      await store.flush();
    },
    flushPreloadCache: () => preloadCache.flush(),
    clock
  });
}

function toClassMethodCatalog(
  taskId: string,
  catalog: MethodCatalogResponse,
  refreshedAt: string,
  fingerprint: string
): ClassMethodCatalog {
  return {
    taskId,
    analysisSessionId: catalog.analysisSessionId,
    reportPairId: catalog.reportPairId,
    fingerprint,
    reportCoverageTotals: detached(catalog.reportCoverageTotals),
    methods: catalog.methods.map(detached),
    warnings: catalog.warnings.map(detached),
    refreshedAt
  };
}

function uniqueArtifacts(
  artifacts: readonly GeneratedClassTaskArtifact[]
): GeneratedClassTaskArtifact[] {
  const byId = new Map<string, GeneratedClassTaskArtifact>();
  const idByPath = new Map<string, string>();
  for (const artifact of artifacts) {
    const normalizedPath = pathKey(artifact.filePath);
    const previousWithId = byId.get(artifact.id);
    if (previousWithId) idByPath.delete(pathKey(previousWithId.filePath));

    const previousIdForPath = idByPath.get(normalizedPath);
    if (previousIdForPath && previousIdForPath !== artifact.id) {
      byId.delete(previousIdForPath);
    }

    byId.set(artifact.id, detached(artifact));
    idByPath.set(normalizedPath, artifact.id);
  }
  return [...byId.values()];
}

function findPublishedWaveArtifact(
  artifacts: readonly GeneratedClassTaskArtifact[],
  methodId: string,
  waveIndex: number
): {
  artifact: GeneratedClassTaskArtifact;
  methodResult: NonNullable<GeneratedClassTaskArtifact['methodResults']>[number];
} | null {
  if (!methodId.trim() || !Number.isSafeInteger(waveIndex) || waveIndex < 1) return null;
  let occurrence = 0;
  for (const artifact of artifacts) {
    for (const methodResult of artifact.methodResults ?? []) {
      if (methodResult.methodId !== methodId) continue;
      occurrence += 1;
      if (occurrence === waveIndex) return { artifact, methodResult };
    }
  }
  return null;
}

function waitForSharedPreparation<T>(
  preparation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return preparation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      rejectPromise(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    preparation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        rejectPromise(error);
      }
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

export function analysisResponseTimeoutRetryDelayMilliseconds(
  retryIndex: number,
  initialDelayMilliseconds = DEFAULT_ANALYSIS_RESPONSE_TIMEOUT_RETRY_INITIAL_DELAY_MILLISECONDS,
  maxDelayMilliseconds = DEFAULT_ANALYSIS_RESPONSE_TIMEOUT_RETRY_MAX_DELAY_MILLISECONDS
): number {
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 0) {
    throw new TypeError('Analysis response timeout retry index must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(initialDelayMilliseconds) || initialDelayMilliseconds <= 0) {
    throw new TypeError('Analysis response timeout retry delay must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxDelayMilliseconds) || maxDelayMilliseconds <= 0) {
    throw new TypeError('Analysis response timeout retry maximum delay must be a positive integer.');
  }
  return Math.min(maxDelayMilliseconds, initialDelayMilliseconds * (2 ** retryIndex));
}

async function waitForAnalysisResponseTimeoutRetry(
  retryIndex: number,
  options: Pick<
    ProductionClassTaskRuntimeOptions,
    | 'analysisResponseTimeoutRetryInitialDelayMilliseconds'
    | 'analysisResponseTimeoutRetryMaxDelayMilliseconds'
  >,
  signal?: AbortSignal
): Promise<void> {
  if (signal) throwIfAborted(signal);
  const delayMilliseconds = analysisResponseTimeoutRetryDelayMilliseconds(
    retryIndex,
    options.analysisResponseTimeoutRetryInitialDelayMilliseconds,
    options.analysisResponseTimeoutRetryMaxDelayMilliseconds
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, delayMilliseconds);
    const abort = () => finish(signal?.reason);
    function finish(error?: unknown): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) rejectPromise(error);
      else resolvePromise();
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function temporaryBatchIndexOffset(
  progress: ClassTaskRunCheckpoint,
  methodId: string
): number {
  const methodIndex = progress.resolvedMethodOrder.indexOf(methodId);
  if (methodIndex < 0) {
    throw new Error(`Source method ${methodId} is outside the resolved execution order.`);
  }
  return progress.resolvedMethodOrder
    .slice(0, methodIndex)
    .reduce((sum, completedMethodId) => (
      sum + (progress.methods[completedMethodId]?.completedBatches.length ?? 0)
    ), 0);
}

function sharedPassedTemporaryGroupMethodIds(
  methodIds: readonly string[],
  progress: ClassTaskRunCheckpoint,
  methodId: string
): string[] {
  const checkpoint = progress.methods[methodId];
  if (!checkpoint || checkpoint.completedBatches.length !== 1) return [];
  const batch = checkpoint.completedBatches[0];
  if (
    batch.outcome !== 'PASSED'
    || batch.tmpFilePath === null
    || batch.tmpFileSha256 === null
  ) {
    return [];
  }
  const sharedMethodIds = methodIds.filter((candidateMethodId) => {
    const candidate = progress.methods[candidateMethodId];
    if (!candidate || candidate.completedBatches.length !== 1) return false;
    const candidateBatch = candidate.completedBatches[0];
    return candidateBatch.outcome === 'PASSED'
      && candidateBatch.tmpFilePath === batch.tmpFilePath
      && candidateBatch.tmpFileSha256 === batch.tmpFileSha256;
  });
  return sharedMethodIds.length > 1 ? sharedMethodIds : [];
}

function waveCandidateTaskDirectory(task: ClassTaskSnapshot): string {
  return join(
    resolve(task.workspaceRoot),
    '.ai-unit-test',
    'method-wave-candidates',
    createHash('sha256').update(task.id, 'utf8').digest('hex').slice(0, 24)
  );
}

function waveCandidateDirectory(task: ClassTaskSnapshot, candidateId: string): string {
  return join(waveCandidateTaskDirectory(task), candidateId);
}

function waveCandidateOwnedFiles(
  candidate: WaveCandidateCheckpoint
): Array<{ path: string; sha256: string }> {
  const files = new Map<string, { path: string; sha256: string }>();
  const add = (path: string, sha256: string) => {
    files.set(`${pathKey(path)}\0${sha256.toLowerCase()}`, { path, sha256 });
  };
  if (candidate.managedFile) {
    add(candidate.managedFile.path, candidate.managedFile.sha256);
  }
  if (candidate.moveTransaction) {
    add(candidate.moveTransaction.sourcePath, candidate.moveTransaction.sha256);
    add(candidate.moveTransaction.targetPath, candidate.moveTransaction.sha256);
  }
  return [...files.values()];
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const RETRYABLE_COVERAGE_ARTIFACT_ERROR_CODES = new Set([
  'BRANCH_SNAPSHOT_INVALID',
  'BRANCH_SNAPSHOT_MISSING',
  'REPORT_PATH_MISSING',
  // Compatibility with Analyzer versions that classified a missing report as outside the workspace.
  'REPORT_PATH_OUTSIDE_WORKSPACE'
]);

function isRetryableCoverageArtifactCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && RETRYABLE_COVERAGE_ARTIFACT_ERROR_CODES.has(code);
}

function isRetryableCoverageArtifactError(error: unknown): boolean {
  return error instanceof MethodAnalysisRequestError
    && isRetryableCoverageArtifactCode(error.code);
}

function isRetryableCoverageArtifactTaskError(
  error: PublicTaskError | null
): boolean {
  if (isRetryableCoverageArtifactCode(error?.code)) return true;
  return error?.code === 'CLASS_TASK_EXECUTION_FAILED'
    && /\b(?:BRANCH_SNAPSHOT_INVALID|BRANCH_SNAPSHOT_MISSING|REPORT_PATH_MISSING|REPORT_PATH_OUTSIDE_WORKSPACE)\b/u
      .test(error.message);
}

function isRecoverableAnalysisSessionError(error: unknown): boolean {
  return error instanceof MethodAnalysisRequestError
    && (
      error.code === 'ANALYSIS_SESSION_CANCELLED'
      || error.code === 'ANALYSIS_SESSION_NOT_FOUND'
    );
}

function shouldCleanupWaveScratchOnRelease(task: ClassTaskSnapshot): boolean {
  if (task.state === 'COMPLETED' || task.state === 'TERMINATED') return true;
  if (task.state !== 'FAILED') return false;
  const code = task.lastError?.code ?? '';
  if (code === 'MODEL_NO_FORMAL_TEST_FILE_GENERATED') return true;
  if (code.startsWith('MODEL_') || isRetryableCoverageArtifactTaskError(task.lastError)) {
    return false;
  }
  return code !== 'ANALYSIS_SESSION_CANCELLED'
    && code !== 'ANALYSIS_SESSION_NOT_FOUND';
}

function isAnalysisCapacityError(error: unknown): boolean {
  return error instanceof MethodAnalysisRequestError
    && error.code === 'ANALYSIS_CAPACITY_REACHED';
}

function isUnavailableRestoredArtifact(error: unknown): boolean {
  return isMissingPath(error) || isGeneratedTestExternallyModifiedError(error);
}

function validateSelection(request: SaveMethodSelectionRequest, catalog: ClassMethodCatalog): void {
  if (request.selectionMode === 'ALL_BY_DEFAULT') {
    if (request.selectedMethodIds.length > 0 || request.methodOrder.length > 0) {
      throw new Error('ALL_BY_DEFAULT selection cannot contain explicit method IDs.');
    }
    return;
  }
  const generatable = new Set(
    catalog.methods.filter((method) => method.generatable).map((method) => method.methodId)
  );
  if (request.methodOrder.some((methodId) => !generatable.has(methodId))) {
    throw new Error('Method selection contains an unavailable or unknown method.');
  }
}

function hasSelectedMethods(
  task: Pick<
    ClassTaskSnapshot,
    'selectionMode' | 'selectedMethodIds' | 'methodOrder' | 'repairAttemptLimit' | 'unlimitedRepair'
  >
): boolean {
  return task.selectionMode === 'EXPLICIT'
    && task.selectedMethodIds.length > 0
    && task.methodOrder.length > 0
    && (task.unlimitedRepair || task.repairAttemptLimit !== null);
}

function requireSelectedMethods(
  task: Pick<
    ClassTaskSnapshot,
    'selectionMode' | 'selectedMethodIds' | 'methodOrder' | 'repairAttemptLimit' | 'unlimitedRepair'
  >
): void {
  if (!hasSelectedMethods(task)) {
    if (!task.unlimitedRepair && task.repairAttemptLimit === null) {
      throw new Error('请填写修复轮次或勾选无限制');
    }
    throw new Error('请先选择至少一个方法。');
  }
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

function requiresFreshGenerationAfterFailure(code: string | undefined): boolean {
  return code === 'MODEL_NO_FORMAL_TEST_FILE_GENERATED'
    || code === 'NO_FORMAL_TEST_FILE_GENERATED';
}
