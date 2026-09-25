import { randomUUID } from 'node:crypto';

import type {
  MavenHomeDefaults,
  ResolvedRagEmbeddingRuntime,
  ResolvedWorkstationModelRuntime,
  WorkstationBuildSettings
} from '../../shared/types.ts';
import type { MavenAnalysisContext } from './maven-analysis-context.service.ts';
import {
  type ModelToolCallingProbeResponse,
  validateRagRepairContext,
  type RagIndexPreparationResult,
  type RagRepairContext
} from './rag-index-contract.ts';
import type { AiClient } from './ai-client.ts';
import type { ClassTaskCheckpointService } from './class-task-checkpoint.service.ts';
import { MethodGenerationRequestError } from './method-generation-contract.ts';
import type {
  RagIndexCoordinator,
  RagIndexSubscription
} from './rag-index-coordinator.service.ts';

export type ClassTaskRagTaskRun = {
  taskRunId: string;
  revokedFqns: string[];
};

export type ClassTaskRagRunResources = {
  taskId: string;
  ragSubscription: RagIndexSubscription | null;
  ragRunContext: RagRepairContext | null | undefined;
  ragTaskRun: ClassTaskRagTaskRun | null | undefined;
  ragPreflightEnabled: boolean | undefined;
  ragToolCallingProbe: ModelToolCallingProbeResponse | null;
  resolvedModelRuntime: ResolvedWorkstationModelRuntime | null;
  resolvedRagEmbeddingRuntime: ResolvedRagEmbeddingRuntime | null;
};

export type PreflightClassTaskRagRunInput = {
  taskId: string;
  ragEnabled: boolean;
  captureModelCalls: boolean;
  recordToolCallingProbe?: (
    probe: ModelToolCallingProbeResponse,
    modelName: string
  ) => Promise<void>;
  signal?: AbortSignal;
};

export type PrepareClassTaskRagRunInput = {
  taskId: string;
  ragEnabled: boolean;
  analysisSessionId: string;
  reportPairId: string;
  methodIds: string[];
  analysisInput: Pick<
    MavenAnalysisContext,
    | 'workspaceRoot'
    | 'moduleRoot'
    | 'targetSourcePath'
    | 'targetClass'
    | 'sourceRoots'
    | 'classpathEntries'
    | 'jdkMajorVersion'
    | 'buildContextFingerprint'
  >;
  buildSettings: WorkstationBuildSettings;
  signal?: AbortSignal;
};

type RagRunTelemetryFields = Readonly<Record<string, string | number | null>>;

export type ClassTaskRagRunServiceOptions = {
  indexCoordinator: Pick<RagIndexCoordinator, 'subscribeInitial' | 'releaseAll'>;
  modelInterfaces: {
    resolveForGeneration(): Promise<ResolvedWorkstationModelRuntime>;
  };
  modelCapabilities: Pick<AiClient, 'probeModelToolCalling'>;
  taskRuns: Pick<AiClient, 'releaseRagTaskRun'>;
  checkpoints: Pick<
    ClassTaskCheckpointService,
    'taskProgress' | 'saveRagRun' | 'clearRagRun'
  >;
  knowledge: {
    ensureTaskKnowledge(input: {
      workspaceRoot: string;
      moduleRoot: string;
      targetSourcePath: string;
      targetClass: string;
      embeddingConfig: ResolvedRagEmbeddingRuntime['embeddingConfig'];
      signal?: AbortSignal;
    }): Promise<{ status: string; addedMethodCount: number; reusedMethodCount: number }>;
  };
  embeddingInterfaces: {
    resolveRuntime(): Promise<ResolvedRagEmbeddingRuntime | null>;
  };
  resolveMavenHomeDefaults(mavenHome: string): Promise<MavenHomeDefaults>;
  waitMilliseconds?: number;
  telemetry?: (event: string, fields: RagRunTelemetryFields) => void;
  clock?: () => number;
  idFactory?: () => string;
};

type ReadinessOutcome =
  | { kind: 'ready'; result: RagIndexPreparationResult }
  | { kind: 'failed' }
  | { kind: 'timed_out' };

export class ClassTaskRagRunService {
  private readonly options: ClassTaskRagRunServiceOptions;
  private readonly waitMilliseconds: number;
  private readonly telemetry: NonNullable<ClassTaskRagRunServiceOptions['telemetry']>;
  private readonly clock: () => number;
  private readonly idFactory: () => string;

  constructor(options: ClassTaskRagRunServiceOptions) {
    this.options = options;
    this.waitMilliseconds = normalizeWaitMilliseconds(options.waitMilliseconds);
    this.telemetry = options.telemetry ?? (() => undefined);
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async preflightRun(
    resources: ClassTaskRagRunResources,
    input: PreflightClassTaskRagRunInput
  ): Promise<void> {
    if (resources.ragPreflightEnabled !== undefined) return;
    if (resources.taskId !== input.taskId) {
      throw new Error('Class task RAG resource identity does not match the requested task.');
    }
    throwIfAborted(input.signal);

    const modelRuntime = await this.options.modelInterfaces.resolveForGeneration();
    resources.resolvedModelRuntime = modelRuntime;
    if (!input.ragEnabled) {
      resources.ragPreflightEnabled = false;
      resources.ragRunContext = null;
      resources.ragTaskRun = null;
      resources.ragToolCallingProbe = null;
      resources.resolvedRagEmbeddingRuntime = null;
      return;
    }

    const embeddingRuntime = await this.options.embeddingInterfaces.resolveRuntime();
    if (!embeddingRuntime) {
      throw new Error('请先在设置中完成 Embedding 配置。');
    }
    throwIfAborted(input.signal);
    resources.ragToolCallingProbe = null;
    const checkpoint = await this.options.checkpoints.taskProgress(input.taskId);
    const durableRun = checkpoint.ragRun ?? await this.options.checkpoints.saveRagRun(
      input.taskId,
      { taskRunId: this.idFactory(), revokedFqns: [] }
    );
    resources.ragPreflightEnabled = true;
    resources.ragTaskRun = {
      taskRunId: durableRun.taskRunId,
      revokedFqns: [...durableRun.revokedFqns],
    };
    resources.ragToolCallingProbe = null;
    resources.resolvedRagEmbeddingRuntime = embeddingRuntime;
  }

  async refreshModelRuntime(resources: ClassTaskRagRunResources): Promise<void> {
    resources.resolvedModelRuntime = await this.options.modelInterfaces.resolveForGeneration();
    resources.ragToolCallingProbe = null;
  }

  async prepareIndex(
    resources: ClassTaskRagRunResources,
    input: PrepareClassTaskRagRunInput
  ): Promise<void> {
    if (resources.ragPreflightEnabled === undefined) {
      throw new Error('Class task RAG preflight has not completed.');
    }
    if (resources.ragRunContext !== undefined) return;
    if (resources.ragPreflightEnabled === false) {
      resources.ragRunContext = null;
      return;
    }
    const taskRun = resources.ragTaskRun;
    if (!taskRun) {
      throw new Error('Class task RAG authorization was not captured during preflight.');
    }
    throwIfAborted(input.signal);

    const startedAt = this.clock();
    // 生成前只补齐当前任务类缺失的方法，不扫描 classpath，也不比较源码指纹。
    let context: RagRepairContext;
    try {
      const embeddingRuntime = resources.resolvedRagEmbeddingRuntime;
      if (!embeddingRuntime) {
        throw new Error('Class task RAG Embedding runtime was not captured during preflight.');
      }
      const localRepository = input.buildSettings.localRepository
        ?? (await this.options.resolveMavenHomeDefaults(
          input.buildSettings.mavenHome
        )).localRepository;
      context = validateRagRepairContext({
        enabled: true,
        scope: {
          workspaceRoot: input.analysisInput.workspaceRoot,
          moduleRoot: input.analysisInput.moduleRoot,
          productionSourceRoots: input.analysisInput.sourceRoots,
          classpathEntries: input.analysisInput.classpathEntries,
          localRepository,
          jdkMajorVersion: input.analysisInput.jdkMajorVersion,
          buildFingerprint: input.analysisInput.buildContextFingerprint
        },
        activeIndex: null,
        taskRunId: taskRun.taskRunId,
        revokedFqns: [...taskRun.revokedFqns]
      });
      const ensured = await this.options.knowledge.ensureTaskKnowledge({
        workspaceRoot: input.analysisInput.workspaceRoot,
        moduleRoot: input.analysisInput.moduleRoot,
        targetSourcePath: input.analysisInput.targetSourcePath,
        targetClass: input.analysisInput.targetClass,
        embeddingConfig: embeddingRuntime.embeddingConfig,
        ...(input.signal ? { signal: input.signal } : {})
      });
      this.telemetry('rag_run_knowledge', {
        status: ensured.status,
        taskId: input.taskId.slice(0, 12),
        addedMethodCount: ensured.addedMethodCount,
        reusedMethodCount: ensured.reusedMethodCount
      });
      resources.ragRunContext = context;
    } catch (error) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      resources.ragRunContext = null;
      resources.resolvedRagEmbeddingRuntime = null;
      this.record(input, 'failed', this.clock() - startedAt);
      throw ragPreparationError(error);
    }

    let subscription: RagIndexSubscription;
    try {
      const embeddingRuntime = resources.resolvedRagEmbeddingRuntime;
      if (!embeddingRuntime) {
        await this.degradeWithoutSubscription(resources);
        this.record(input, 'failed', this.clock() - startedAt);
        return;
      }
      subscription = await this.options.indexCoordinator.subscribeInitial({
        context,
        embeddingContext: { embeddingConfig: embeddingRuntime.embeddingConfig },
        analysisSessionId: input.analysisSessionId,
        reportPairId: input.reportPairId,
        methodIds: input.methodIds,
        ...(input.signal ? { signal: input.signal } : {})
      });
      resources.ragSubscription = subscription;
      resources.ragRunContext = subscription.context;
    } catch (error) {
      resources.ragRunContext = null;
      resources.resolvedRagEmbeddingRuntime = null;
      this.record(input, 'failed', this.clock() - startedAt);
      throw ragPreparationError(error);
    }

    const outcome = await waitForRagReadiness(
      subscription.ready,
      this.waitMilliseconds,
      input.signal
    );
    if (outcome.kind === 'ready') {
      if (isUsableRagIndex(outcome.result, subscription.context)) {
        this.record(input, outcome.result.status, this.clock() - startedAt);
        return;
      }
      await this.degradeToNonRag(resources, subscription);
      this.record(input, 'failed', this.clock() - startedAt);
      return;
    }
    if (outcome.kind === 'failed') {
      await this.degradeToNonRag(resources, subscription);
      this.record(input, 'failed', this.clock() - startedAt);
      return;
    }

    this.record(input, 'timed_out', this.clock() - startedAt);
    void subscription.ready.then(
      async (result) => {
        if (resources.ragSubscription !== subscription) return;
        if (isUsableRagIndex(result, subscription.context)) {
          this.record(input, result.status, this.clock() - startedAt);
          return;
        }
        if (await this.degradeToNonRag(resources, subscription)) {
          this.record(input, 'failed', this.clock() - startedAt);
        }
      },
      async () => {
        if (await this.degradeToNonRag(resources, subscription)) {
          this.record(input, 'failed', this.clock() - startedAt);
        }
      }
    );
  }

  async releaseRun(resources: ClassTaskRagRunResources): Promise<void> {
    const subscription = resources.ragSubscription;
    const taskRun = resources.ragTaskRun;
    this.clearLocalResources(resources);
    const operations: Promise<unknown>[] = [];
    if (subscription) operations.push(subscription.release());
    if (taskRun) {
      operations.push(this.options.taskRuns.releaseRagTaskRun(taskRun.taskRunId));
      operations.push(this.options.checkpoints.clearRagRun(
        resources.taskId,
        taskRun.taskRunId
      ));
    }
    const settled = await Promise.allSettled(operations);
    const failures = settled.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Class task RAG release did not complete cleanly.');
    }
  }

  async releaseAll(resources: Iterable<ClassTaskRagRunResources>): Promise<void> {
    await Promise.allSettled([...resources].map((item) => this.releaseRun(item)));
    await this.options.indexCoordinator.releaseAll();
  }

  async suspendRun(resources: ClassTaskRagRunResources): Promise<void> {
    const subscription = resources.ragSubscription;
    this.clearLocalResources(resources);
    await subscription?.release();
  }

  async suspendAll(resources: Iterable<ClassTaskRagRunResources>): Promise<void> {
    await Promise.allSettled([...resources].map((item) => this.suspendRun(item)));
    await this.options.indexCoordinator.releaseAll();
  }

  private async degradeToNonRag(
    resources: ClassTaskRagRunResources,
    subscription: RagIndexSubscription
  ): Promise<boolean> {
    if (resources.ragSubscription !== subscription) return false;
    resources.ragSubscription = null;
    resources.ragRunContext = null;
    resources.resolvedRagEmbeddingRuntime = null;
    await subscription.release().catch(() => undefined);
    return true;
  }

  private async degradeWithoutSubscription(
    resources: ClassTaskRagRunResources
  ): Promise<void> {
    resources.ragSubscription = null;
    resources.ragRunContext = null;
    resources.resolvedRagEmbeddingRuntime = null;
  }

  private clearLocalResources(resources: ClassTaskRagRunResources): void {
    resources.ragSubscription = null;
    resources.ragRunContext = undefined;
    resources.ragTaskRun = undefined;
    resources.ragPreflightEnabled = undefined;
    resources.ragToolCallingProbe = null;
    resources.resolvedModelRuntime = null;
    resources.resolvedRagEmbeddingRuntime = null;
  }

  private record(
    input: PrepareClassTaskRagRunInput,
    status: string,
    elapsedMilliseconds: number
  ): void {
    this.telemetry('rag_run_index', {
      status,
      taskId: input.taskId.slice(0, 12),
      buildFingerprint: input.analysisInput.buildContextFingerprint.slice(0, 12),
      elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds))
    });
  }


}

async function waitForRagReadiness(
  ready: Promise<RagIndexPreparationResult>,
  waitMilliseconds: number,
  signal?: AbortSignal
): Promise<ReadinessOutcome> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeout = new Promise<ReadinessOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed_out' }), waitMilliseconds);
  });
  const completion = ready.then<ReadinessOutcome, ReadinessOutcome>(
    (result) => ({ kind: 'ready', result }),
    () => ({ kind: 'failed' })
  );
  const aborted = signal
    ? new Promise<ReadinessOutcome>((_resolve, reject) => {
        const onAbort = (): void => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      })
    : new Promise<ReadinessOutcome>(() => undefined);
  try {
    return await Promise.race([completion, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

function normalizeWaitMilliseconds(value: number | undefined): number {
  if (value === undefined) return 600_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) {
    throw new TypeError('RAG index wait duration is invalid.');
  }
  return value;
}

function isUsableRagIndex(
  result: RagIndexPreparationResult,
  context: RagRepairContext
): boolean {
  return (result.status === 'reused' || result.status === 'published')
    && result.vectorStatus === 'ready'
    && context.activeIndex !== null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function ragPreparationError(error: unknown): MethodGenerationRequestError {
  if (error instanceof MethodGenerationRequestError) return error;
  const detail = error instanceof Error && error.message.trim()
    ? `：${error.message.trim()}`
    : '';
  return new MethodGenerationRequestError(
    'RAG_KNOWLEDGE_PREPARATION_FAILED',
    `RAG 知识库构建失败，已停止本次生成${detail}`
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Class task RAG preparation was cancelled.');
}
