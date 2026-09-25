import { createHash } from 'node:crypto';
import { normalize, resolve } from 'node:path';

import {
  decodeResolveRagSourceSetResponse,
  validateRagRepairContext,
  validateResolveRagSourceSetRequest,
  type CreateRagSourceSnapshotSessionRequest,
  type CreateRagSourceSnapshotSessionResponse,
  type RagActiveIndexIdentity,
  type RagEmbeddingModelContext,
  type RagIndexPreparationResult,
  type RagMethodSelector,
  type RagRepairContext,
  type RagSourceSnapshotPage,
  type ResolveRagSourceSetRequest,
  type ResolveRagSourceSetResponse
} from './rag-index-contract.ts';

export type RagIndexAnalyzerPort = {
  resolveRagSourceSet(
    analysisSessionId: string,
    request: ResolveRagSourceSetRequest,
    signal?: AbortSignal
  ): Promise<ResolveRagSourceSetResponse>;
  createRagSourceSnapshotSession(
    request: CreateRagSourceSnapshotSessionRequest,
    signal?: AbortSignal
  ): Promise<CreateRagSourceSnapshotSessionResponse>;
  getRagSourceSnapshotPage(
    sessionId: string,
    pageIndex: number,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<RagSourceSnapshotPage>;
  cancelRagSourceSnapshotSession(sessionId: string, signal?: AbortSignal): Promise<void>;
};

export type RagIndexInitialSubscriptionInput = {
  context: RagRepairContext;
  embeddingContext: RagEmbeddingModelContext;
  analysisSessionId: string;
  reportPairId: string;
  methodIds: string[];
  signal?: AbortSignal;
};

export type RagIndexSubscription = {
  context: RagRepairContext;
  ready: Promise<RagIndexPreparationResult>;
  release(): Promise<void>;
};

export type RagIndexCoordinatorOptions = {
  globalKnowledge: (
    context: RagRepairContext,
    embeddingContext: RagEmbeddingModelContext,
    signal?: AbortSignal
  ) => Promise<RagActiveIndexIdentity>;
  globalKnowledgeRefresh: (input: {
    context: RagRepairContext;
    page: RagSourceSnapshotPage;
    embeddingContext: RagEmbeddingModelContext;
    signal?: AbortSignal;
  }) => Promise<{ status: 'published' | 'reused'; addedMethodCount: number; reusedMethodCount: number }>;
  analyzer: RagIndexAnalyzerPort;
  telemetry?: (event: string, fields: Readonly<Record<string, string | number | null>>) => void;
  clock?: () => number;
};

type SubscriptionState = {
  requestedMethods: RagMethodSelector[];
  context: RagRepairContext;
  embeddingContext: RagEmbeddingModelContext;
  analysisSessionId: string;
  reportPairId: string;
  methodIds: string[];
  requestedFqns: string[];
  signal?: AbortSignal;
  released: boolean;
};

export class RagIndexCoordinator {
  private readonly globalKnowledge: RagIndexCoordinatorOptions['globalKnowledge'];
  private readonly globalKnowledgeRefresh: RagIndexCoordinatorOptions['globalKnowledgeRefresh'];
  private readonly analyzer: RagIndexAnalyzerPort;
  private readonly telemetry: NonNullable<RagIndexCoordinatorOptions['telemetry']>;
  private readonly clock: () => number;
  private readonly resolutions = new Map<string, Promise<ResolveRagSourceSetResponse>>();
  private readonly subscriptionStates = new WeakMap<RagIndexSubscription, SubscriptionState>();
  private readonly activeStates = new Set<SubscriptionState>();

  constructor(options: RagIndexCoordinatorOptions) {
    this.globalKnowledge = options.globalKnowledge;
    this.globalKnowledgeRefresh = options.globalKnowledgeRefresh;
    this.analyzer = options.analyzer;
    this.telemetry = options.telemetry ?? (() => undefined);
    this.clock = options.clock ?? (() => Date.now());
  }

  async subscribeInitial(input: RagIndexInitialSubscriptionInput): Promise<RagIndexSubscription> {
    if (!input.embeddingContext?.embeddingConfig) {
      throw new TypeError('RAG index build requires an Embedding model configuration.');
    }
    throwIfAborted(input.signal);
    const context = validateRagRepairContext(input.context);
    context.activeIndex = await this.globalKnowledge(context, input.embeddingContext, input.signal);
    const state: SubscriptionState = {
      requestedMethods: [],
      context,
      embeddingContext: input.embeddingContext,
      analysisSessionId: input.analysisSessionId,
      reportPairId: input.reportPairId,
      methodIds: [...input.methodIds],
      requestedFqns: [],
      ...(input.signal ? { signal: input.signal } : {}),
      released: false
    };
    const subscription: RagIndexSubscription = {
      context,
      ready: Promise.resolve(globalResult(context)),
      release: async () => {
        state.released = true;
        this.activeStates.delete(state);
      }
    };
    this.subscriptionStates.set(subscription, state);
    this.activeStates.add(state);
    return subscription;
  }

  async refresh(
    subscription: RagIndexSubscription,
    diagnosticFqns: readonly string[],
    signal?: AbortSignal,
    diagnosticMethods: readonly RagMethodSelector[] = []
  ): Promise<RagIndexPreparationResult> {
    const state = this.subscriptionStates.get(subscription);
    if (!state || state.released) {
      throw new TypeError('RAG index subscription is no longer active.');
    }
    const activeSignal = signal ?? state.signal;
    const startedAt = this.clock();
    let snapshotSessionId: string | null = null;
    let pageCount = 0;
    let addedCount = 0;
    try {
      const requestedMethods = uniqueMethods([...state.requestedMethods, ...diagnosticMethods]);
      const requestedFqns = [...new Set([...state.requestedFqns, ...diagnosticFqns])].sort();
      const request = validateResolveRagSourceSetRequest({
        reportPairId: state.reportPairId,
        methodIds: state.methodIds,
        requestedMethods,
        requestedFqns,
        ...state.context.scope
      });
      throwIfAborted(activeSignal);
      const sourceSet = await this.resolveSourceSet(state.analysisSessionId, request, activeSignal);
      throwIfAborted(activeSignal);
      const snapshot = await this.analyzer.createRagSourceSnapshotSession({
        analysisSessionId: state.analysisSessionId,
        reportPairId: state.reportPairId,
        methodIds: state.methodIds,
        requestedFqns: request.requestedFqns,
        requestedMethods,
        requestedSourceSetFingerprint: sourceSet.requestedSourceSetFingerprint,
        ...state.context.scope,
        knownFiles: [],
        priorScopeFileIds: []
      }, activeSignal);
      snapshotSessionId = snapshot.sessionId;
      for (let pageIndex = 0; ; pageIndex += 1) {
        throwIfAborted(activeSignal);
        const page = await this.analyzer.getRagSourceSnapshotPage(
          snapshot.sessionId,
          pageIndex,
          50,
          activeSignal
        );
        const ensured = await this.globalKnowledgeRefresh({
          context: state.context,
          page,
          embeddingContext: state.embeddingContext,
          ...(activeSignal ? { signal: activeSignal } : {})
        });
        pageCount += 1;
        addedCount += ensured.addedMethodCount;
        if (!page.hasMore) break;
      }
      await this.closeSnapshot(snapshotSessionId);
      snapshotSessionId = null;
      state.context.activeIndex = await this.globalKnowledge(
        state.context,
        state.embeddingContext,
        activeSignal
      );
      state.requestedFqns = request.requestedFqns;
      state.requestedMethods = requestedMethods;
      const result: RagIndexPreparationResult = {
        ...globalResult(state.context),
        status: addedCount > 0 ? 'published' : 'reused',
        pageCount,
        addedCount
      };
      this.record(result, startedAt);
      return result;
    } catch (error) {
      if (snapshotSessionId) await this.closeSnapshot(snapshotSessionId);
      if (activeSignal?.aborted || isAbortError(error)) {
        if (activeSignal) throw abortReason(activeSignal, error);
        throw error;
      }
      const result = degradedRefreshResult(state.context);
      this.record(result, startedAt);
      return result;
    }
  }

  async releaseAll(): Promise<void> {
    for (const state of this.activeStates) state.released = true;
    this.activeStates.clear();
    this.resolutions.clear();
  }

  private async resolveSourceSet(
    analysisSessionId: string,
    request: ResolveRagSourceSetRequest,
    signal?: AbortSignal
  ): Promise<ResolveRagSourceSetResponse> {
    const key = sourceResolutionKey(analysisSessionId, request);
    let resolution = this.resolutions.get(key);
    if (!resolution) {
      const pending = Promise.resolve().then(async () => decodeResolveRagSourceSetResponse(
        await this.analyzer.resolveRagSourceSet(analysisSessionId, request, signal)
      ));
      const tracked = pending.finally(() => {
        if (this.resolutions.get(key) === tracked) this.resolutions.delete(key);
      });
      resolution = tracked;
      void resolution.catch(() => undefined);
      this.resolutions.set(key, resolution);
    }
    return resolution;
  }

  private async closeSnapshot(sessionId: string): Promise<void> {
    await this.analyzer.cancelRagSourceSnapshotSession(sessionId).catch(() => undefined);
  }

  private record(result: RagIndexPreparationResult, startedAt: number): void {
    this.telemetry('rag_index_preparation', {
      status: result.status,
      vectorStatus: result.vectorStatus,
      workspaceId: result.workspaceId?.slice(0, 12) ?? null,
      scopeId: result.scopeId?.slice(0, 12) ?? null,
      buildFingerprint: result.buildFingerprint.slice(0, 12),
      pageCount: result.pageCount,
      addedCount: result.addedCount,
      updatedCount: result.updatedCount,
      deletedCount: result.deletedCount,
      skippedDependencyCount: result.skippedDependencyCount,
      elapsedMilliseconds: Math.max(0, this.clock() - startedAt),
      degradationCode: result.degradationCode
    });
  }
}

function globalResult(context: RagRepairContext): RagIndexPreparationResult {
  if (!context.activeIndex) throw new TypeError('RAG global knowledge identity is missing.');
  return {
    status: 'reused',
    vectorStatus: 'ready',
    workspaceId: context.activeIndex.workspaceId,
    scopeId: context.activeIndex.scopeId,
    buildFingerprint: context.scope.buildFingerprint,
    pageCount: 0,
    addedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    skippedDependencyCount: 0,
    degradationCode: null
  };
}

function uniqueMethods(methods: readonly RagMethodSelector[]): RagMethodSelector[] {
  return [...new Map(methods.map((method) => [JSON.stringify(method), method])).values()];
}

function degradedRefreshResult(context: RagRepairContext): RagIndexPreparationResult {
  return {
    status: 'degraded',
    vectorStatus: 'degraded',
    workspaceId: context.activeIndex?.workspaceId ?? null,
    scopeId: context.activeIndex?.scopeId ?? null,
    buildFingerprint: context.scope.buildFingerprint,
    pageCount: 0,
    addedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    skippedDependencyCount: 0,
    degradationCode: 'RAG_INDEX_PREPARATION_FAILED'
  };
}

function sourceResolutionKey(
  analysisSessionId: string,
  request: ResolveRagSourceSetRequest
): string {
  return hashLengthPrefixed([
    analysisSessionId,
    request.reportPairId,
    String(request.methodIds.length),
    ...request.methodIds,
    JSON.stringify(request.requestedMethods ?? []),
    String(request.requestedFqns.length),
    ...request.requestedFqns,
    canonicalPath(request.workspaceRoot),
    canonicalPath(request.moduleRoot),
    String(request.productionSourceRoots.length),
    ...request.productionSourceRoots.map(canonicalPath),
    String(request.classpathEntries.length),
    ...request.classpathEntries.map(canonicalPath),
    canonicalPath(request.localRepository),
    String(request.jdkMajorVersion),
    request.buildFingerprint
  ]);
}

function canonicalPath(value: string): string {
  return normalize(resolve(value)).replace(/\\/g, '/').toLowerCase();
}

function hashLengthPrefixed(values: readonly string[]): string {
  const digest = createHash('sha256');
  for (const value of values) {
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(encoded.byteLength));
    digest.update(length);
    digest.update(encoded);
  }
  return digest.digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal, new Error('RAG index build aborted.'));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (fallback instanceof Error) return fallback;
  return new Error('RAG index build aborted.');
}
