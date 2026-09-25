import { basename, dirname, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import type {
  BackendLlmConfig,
  BuildToolchainContext,
  BuildToolchainSettings
} from '../../shared/types.ts';
import type {
  ClassMethodSummary,
  ClassTaskAtomicStep,
  ClassTaskSnapshot
} from '../../shared/class-task-contracts.ts';
import type {
  CandidateExecutionFeedback,
  MethodGenerationFailure,
  MethodGenerationCompletion,
  MethodGenerationWaveEvent,
  MethodGenerationWavePartResult,
  MethodGenerationRepairContext,
  RagRepairAttemptContext,
  StartMethodGenerationWaveRequest,
  ClassScenarioWorkBatch
} from './method-generation-contract.ts';
import {
  MAX_METHOD_GENERATION_SESSION_TEST_METHODS,
  MAX_METHOD_REPAIR_CONTEXT_METHODS,
  MethodGenerationRequestError,
  MethodGenerationWaveNotFoundError
} from './method-generation-contract.ts';
import {
  MAX_SINGLE_METHOD_BATCH_TEST_METHODS,
  type ClassScenarioWaveRequest,
  type ClassScenarioWaveResponse,
  type ClassScenarioWorkPart,
  type ClassScenarioWorkWave,
  type MethodRepairContextResponse,
  type RepairMethodSource,
  type SingleMethodWaveRequest,
  type SingleMethodWaveResponse,
  type SingleMethodWorkBatch,
  type SingleMethodWorkPart,
  type SingleMethodWorkWave
} from './method-analysis-contract.ts';
import type {
  MethodCandidate,
  MethodGenerationModelContext,
  MethodGenerationProgressHandler,
  RecoverMethodGenerationSessionRequest,
  ResumeMethodGenerationSessionRequest,
  StartMethodGenerationSessionRequest
} from './method-generation-contract.ts';
import {
  ClassTaskPausedAtBoundaryError,
  type ActiveMethodWaveCheckpoint,
  type ClassTaskCheckpointService,
  type InProgressMethodBatchCheckpoint,
  type MethodExecutionCheckpoint,
  type MethodWavePartCheckpoint,
  type WaveCandidateCheckpoint
} from './class-task-checkpoint.service.ts';
import type {
  MethodExecutionPort,
  MethodTestBundle,
  MethodWaveExecutionOutcome
} from './class-task-runner.service.ts';
import type { MavenCandidateExecutorService } from './maven-candidate-executor.service.ts';
import type { TestWriterService } from './test-writer.service.ts';
import type {
  MethodTestBundleMergerService,
  VerifiedMethodBatch
} from './method-test-bundle-merger.service.ts';
import type {
  MethodGenerationLogService,
  MethodRepairTelemetryRecord
} from './method-generation-log.service.ts';
import {
  FAILED_TEST_REPAIR_TODO_COMMENT,
  type GeneratedTestFailurePrunerService
} from './generated-test-failure-pruner.service.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';
import type {
  ClassTaskFileTransactionService,
  WaveCandidateMoveTransaction
} from './class-task-file-transaction.service.ts';
import type {
  ExecutableMavenReadyCandidate,
  ExecutableModuleMavenReadyQueue
} from './module-maven-ready-queue.service.ts';
import type { AiClient } from './ai-client.ts';
import type { RagRepairContext } from './rag-index-contract.ts';
import type {
  RagIndexCoordinator,
  RagIndexSubscription
} from './rag-index-coordinator.service.ts';
import { JavaTestStructureService, matchingBrace, sanitizeJava } from './java-test-structure.service.ts';
import {
  applyDeterministicUnreportedExceptionRepair,
  CandidateChangeValidator,
  preserveAcceptedWildcardImports,
  restoreReferencedAllowedTypeImports,
  type CandidateChangeValidationResult
} from './candidate-change-validator.service.ts';
import {
  MavenRepairDiagnosticService,
  type MavenRepairDiagnostic
} from './maven-repair-diagnostic.service.ts';
import { sanitizePublicText } from './maven-command.ts';
import {
  isClassTaskApplicationInterruptedError,
  isClassTaskPauseRequestedError
} from './class-task-interruption.ts';
import {
  MethodWavePartMergerService,
  type MethodWavePartMergeResult
} from './method-wave-part-merger.service.ts';
import {
  MethodWavePartStoreService,
  type StoredMethodWavePart
} from './method-wave-part-store.service.ts';
import {
  StableTestRepairService
} from './stable-test-repair.service.ts';

export type SingleMethodGenerationContext = {
  analysisSessionId: string;
  reportPairId: string;
  sourceSha256: string;
  packageName: string;
  plannedRelativeTestPath: string;
  moduleRoot: string;
  buildSettings: BuildToolchainSettings;
  buildToolchain: BuildToolchainContext;
  modelContext: MethodGenerationModelContext;
  captureModelCalls: boolean;
  mavenEnvironmentFingerprint?: string;
  methodCatalog?: readonly ClassMethodSummary[];
  ragContext?: RagRepairContext;
  ragSubscription?: RagIndexSubscription;
  ragEmbeddingConfig?: BackendLlmConfig;
  excludedEnvironmentVariables?: readonly string[];
};

type OwnedCandidateFile = {
  filePath: string;
  relativePath: string;
  testClassName: string;
  code: string;
  sha256: string;
};

type ExhaustedCandidateDisposition = {
  retained: OwnedCandidateFile;
  verified: VerifiedMethodBatch | null;
  formalizable: VerifiedMethodBatch | null;
};

export type SingleMethodGenerationOptions = {
  analyzer: Pick<
    AiClient,
    | 'heartbeatMethodAnalysisSession'
    | 'nextMethodBatch'
    | 'nextMethodWave'
    | 'nextClassScenarioWave'
    | 'getMethodRepairContext'
  >;
  agent: Pick<
    AiClient,
    | 'startMethodGenerationStream'
    | 'recoverMethodGenerationStream'
    | 'prepareRagRepair'
    | 'resumeMethodGenerationStream'
    | 'acknowledgeMethodGenerationEvents'
    | 'cancelMethodGeneration'
    | 'streamMethodGenerationWave'
    | 'resumeMethodGenerationWaveStream'
    | 'recoverMethodGenerationWaveStream'
    | 'acknowledgeMethodGenerationWaveEvents'
    | 'cancelMethodGenerationWave'
  >;
  contextProvider: {
    resolve(
      task: ClassTaskSnapshot,
      signal?: AbortSignal
    ): Promise<SingleMethodGenerationContext>;
  };
  checkpoints: Pick<
    ClassTaskCheckpointService,
    | 'beginAtomicStep'
    | 'completeAtomicStep'
    | 'saveInProgressBatch'
    | 'clearInProgressBatch'
    | 'commitBatch'
    | 'addModelUsage'
    | 'saveActiveMethodWave'
    | 'saveWaveCandidate'
    | 'beginWaveCandidateModelRepair'
    | 'rollbackWaveCandidateModelRepair'
    | 'taskWaveProgress'
  >;
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  mavenReadyQueue?: ExecutableModuleMavenReadyQueue;
  candidateFiles?: Pick<ClassTaskFileTransactionService, 'moveWaveCandidateFiles'>;
  writer: Pick<
    TestWriterService,
    | 'prepareMethodBatchTemporaryGeneratedTest'
    | 'writePreparedGeneratedTest'
    | 'prepareReplacement'
    | 'replacePreparedGeneratedTest'
    | 'loadOwnedGeneratedTest'
    | 'deleteGeneratedTest'
  > & Partial<Pick<
    TestWriterService,
    'inspectExistingMethodBatchTemporaryGeneratedTest'
  >>;
  maven: Pick<MavenCandidateExecutorService, 'execute'>;
  pruner: Pick<GeneratedTestFailurePrunerService, 'prune'>;
  merger: Pick<MethodTestBundleMergerService, 'merge'>;
  logs: Pick<
    MethodGenerationLogService,
    'record' | 'recordRepairTelemetry' | 'recordWaveSummary' | 'recordMavenBatch'
  >;
  ragIndexCoordinator?: Pick<RagIndexCoordinator, 'refresh'>;
  ragIndexRefreshWaitMilliseconds?: number;
  diagnostic?: Pick<MavenRepairDiagnosticService, 'normalize'>;
  candidateChanges?: Pick<
    CandidateChangeValidator,
    'validate' | 'validateTestIdentityChanges'
  >;
  partStore?: Pick<MethodWavePartStoreService, 'store' | 'load' | 'clearWave'>;
  partMerger?: Pick<MethodWavePartMergerService, 'merge'>;
  stableRepair?: Pick<StableTestRepairService, 'repair'>;
  publishedWaveRecovery?: {
    restore(input: {
      task: ClassTaskSnapshot;
      wave: SingleMethodWorkWave | ClassScenarioWorkWave;
      waveCheckpoint: ActiveMethodWaveCheckpoint;
      candidate: WaveCandidateCheckpoint;
      signal: AbortSignal;
    }): Promise<MethodTestBundle | MethodTestBundle[] | null>;
  };
  randomUUID?: () => string;
  structure?: JavaTestStructureService;
  analysisHeartbeatIntervalMs?: number;
};

export type SingleMethodGenerationExecutionOptions = {
  temporaryBatchIndexOffset?: number;
};

export type GeneratedMethodBatches = {
  methodId: string;
  methodName: string;
  displaySignature: string;
  jacocoOrder: number;
  batches: VerifiedMethodBatch[];
};

const DEFAULT_ANALYSIS_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RAG_INDEX_REFRESH_WAIT_MILLISECONDS = 600_000;
const STANDARD_TEST_REPAIR_IMPORTS = Object.freeze([
  'org.junit.jupiter.api.Assertions.*',
  'org.mockito.ArgumentMatchers.*',
  'org.mockito.Mockito.*'
]);

export class SingleMethodGenerationService implements MethodExecutionPort {
  private readonly options: SingleMethodGenerationOptions;
  private readonly randomUUID: () => string;
  private readonly structure: JavaTestStructureService;
  private readonly diagnostic: Pick<MavenRepairDiagnosticService, 'normalize'>;
  private readonly candidateChanges: Pick<
    CandidateChangeValidator,
    'validate' | 'validateTestIdentityChanges'
  >;
  private readonly partStore: Pick<
    MethodWavePartStoreService,
    'store' | 'load' | 'clearWave'
  >;
  private readonly partMerger: Pick<MethodWavePartMergerService, 'merge'>;
  private readonly stableRepair: Pick<StableTestRepairService, 'repair'>;
  private readonly analysisHeartbeatIntervalMs: number;
  private readonly ragIndexRefreshWaitMilliseconds: number;

  constructor(options: SingleMethodGenerationOptions) {
    this.options = options;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.structure = options.structure ?? new JavaTestStructureService();
    this.diagnostic = options.diagnostic ?? new MavenRepairDiagnosticService();
    this.candidateChanges = options.candidateChanges
      ?? new CandidateChangeValidator(this.structure);
    this.partStore = options.partStore ?? new MethodWavePartStoreService();
    this.partMerger = options.partMerger ?? new MethodWavePartMergerService(this.structure);
    this.stableRepair = options.stableRepair ?? new StableTestRepairService();
    this.analysisHeartbeatIntervalMs = options.analysisHeartbeatIntervalMs
      ?? DEFAULT_ANALYSIS_HEARTBEAT_INTERVAL_MS;
    this.ragIndexRefreshWaitMilliseconds = options.ragIndexRefreshWaitMilliseconds
      ?? DEFAULT_RAG_INDEX_REFRESH_WAIT_MILLISECONDS;
    if (!Number.isFinite(this.analysisHeartbeatIntervalMs)
      || this.analysisHeartbeatIntervalMs <= 0) {
      throw new Error('Analyzer heartbeat interval must be a positive number.');
    }
    if (
      !Number.isSafeInteger(this.ragIndexRefreshWaitMilliseconds)
      || this.ragIndexRefreshWaitMilliseconds < 1
      || this.ragIndexRefreshWaitMilliseconds > 600_000
    ) {
      throw new Error('RAG index refresh wait duration must be between 1 and 600000 ms.');
    }
  }

  async nextWave(
    task: ClassTaskSnapshot,
    methodId: string,
    request: SingleMethodWaveRequest,
    signal: AbortSignal
  ): Promise<SingleMethodWaveResponse> {
    throwIfAborted(signal);
    const context = await this.options.contextProvider.resolve(task, signal);
    const currentRequest = request.reportPairId === context.reportPairId
      ? request
      : { ...request, reportPairId: context.reportPairId };
    return this.atomic(task.id, 'ANALYZE_METHOD', () => (
      this.options.analyzer.nextMethodWave(
        context.analysisSessionId,
        methodId,
        currentRequest,
        signal
      )
    ));
  }

  async executeWave(
    task: ClassTaskSnapshot,
    wave: SingleMethodWorkWave | ClassScenarioWorkWave,
    checkpoint: MethodExecutionCheckpoint,
    waveCheckpoint: ActiveMethodWaveCheckpoint,
    signal: AbortSignal
  ): Promise<MethodWaveExecutionOutcome> {
    void checkpoint;
    throwIfAborted(signal);
    validateWaveExecutionIdentity(wave, waveCheckpoint);
    const waveState = await this.options.checkpoints.taskWaveProgress(task.id);
    const existingCandidates = Object.values(waveState.candidates).filter((candidate) => (
      candidate.waveId === wave.waveBatchId && candidate.methodId === wave.methodId
    ));
    if (existingCandidates.length > 1) {
      throw new Error('Active Wave has multiple persisted merged candidates.');
    }
    const existingCandidate = existingCandidates[0];
    if (existingCandidate?.status === 'BLOCKED') {
      throw new Error(
        'Stable repair is blocked by a Maven failure outside the generated test. '
        + 'The generated test source was preserved; resolve the project failure manually.'
      );
    }
    const rebuildableCandidateId = existingCandidate
      && existingCandidate.status === 'MODEL_REPAIR'
      && existingCandidate.llmRepairAttemptsUsed === 0
      && existingCandidate.stableRepair.phase === 'NOT_STARTED'
      && existingCandidate.managedFile === null
      && existingCandidate.moveTransaction === null
      ? existingCandidate.candidateId
      : null;
    const sourceClassName = basename(task.sourceFilePath, '.java');
    const completedClassWaveCount = new Set(
      Object.values(waveState.methods).flatMap((method) => (
        method.completedWaves.map((completed) => completed.waveId)
      ))
    ).size;
    const candidateFileIndex = 'selectedMethodIds' in wave
      ? Math.max(waveCheckpoint.waveIndex, completedClassWaveCount + 1)
      : waveCheckpoint.waveIndex;
    const outputTestClassName = `${sourceClassName}Tmp${candidateFileIndex}Test`;
    if (existingCandidate && rebuildableCandidateId === null && [
      'GENERATED',
      'READY_FOR_MAVEN',
      'MAVEN_RUNNING',
      'MODEL_REPAIR',
      'STABLE_REPAIR',
      'PASSED'
    ].includes(existingCandidate.status)) {
      const acceptedPartIndexes = new Set(
        waveCheckpoint.parts
          .filter((part) => part.status === 'SUCCEEDED')
          .map((part) => part.partIndex)
      );
      if (acceptedPartIndexes.size === 0) {
        throw new Error('Passing Wave candidate has no successful Part identity.');
      }
      if (existingCandidate.status === 'PASSED' && this.options.publishedWaveRecovery) {
        const publishedBundle = await this.options.publishedWaveRecovery.restore({
          task,
          wave,
          waveCheckpoint,
          candidate: existingCandidate,
          signal
        });
        if (publishedBundle) {
          if (Array.isArray(publishedBundle)) {
            if (!('selectedMethodIds' in wave)) {
              throw new Error('Single-method Wave recovery returned a class bundle group.');
            }
            await this.clearStoredWaveParts(task, wave, waveCheckpoint.waveIndex);
            return recoveredClassWaveOutcome(
              wave,
              acceptedPartIndexes,
              existingCandidate.candidateId,
              publishedBundle
            );
          }
          validatePublishedWaveRecoveryBundle(
            publishedBundle,
            wave,
            waveCheckpoint,
            existingCandidate.candidateId
          );
          await this.clearStoredWaveParts(task, wave, waveCheckpoint.waveIndex);
          return recoveredWaveOutcome(
            wave,
            acceptedPartIndexes,
            existingCandidate.candidateId,
            publishedBundle
          );
        }
      }
      const managed = existingCandidate.managedFile;
      if (!managed) throw new Error('Wave candidate has no managed TMP recovery identity.');
      const testClassName = basename(managed.path, '.java');
      const isolationFilePath = waveCandidateIsolationPath(
        task,
        existingCandidate.candidateId,
        testClassName
      );
      if (testClassName !== outputTestClassName) {
        throw new Error('Wave candidate path identity is inconsistent.');
      }
      const code = await this.options.writer.loadOwnedGeneratedTest({
        workspaceRoot: task.workspaceRoot,
        filePath: managed.path,
        expectedSha256: managed.sha256
      });
      let owned: OwnedCandidateFile = {
        filePath: managed.path,
        relativePath: relative(task.workspaceRoot, managed.path).split(sep).join('/'),
        testClassName,
        code,
        sha256: managed.sha256
      };
      let candidateCheckpoint = existingCandidate;
      if (
        existingCandidate.status !== 'PASSED'
        && this.options.mavenReadyQueue
        && managed.location === 'PROJECT'
      ) {
        const isolated = await this.options.moduleLock.runExclusive(
          task.moduleKey,
          () => this.moveQueuedWaveCandidate({
            task,
            candidateId: existingCandidate.candidateId,
            owned,
            checkpoint: candidateCheckpoint,
            targetPath: isolationFilePath,
            targetLocation: 'ISOLATED',
            status: 'READY_FOR_MAVEN'
          }),
          signal
        );
        owned = isolated.owned;
        candidateCheckpoint = isolated.checkpoint;
      }
      const context = await this.options.contextProvider.resolve(task, signal);
      // A durable merged candidate has already consumed this Wave's scenarios. A newer
      // coverage report changes the Maven context, but must not restart initial generation.
      const projectFilePath = waveCandidateProjectPath(task, context, testClassName);
      const currentManaged = candidateCheckpoint.managedFile;
      if (!currentManaged || !samePath(
        currentManaged.path,
        currentManaged.location === 'PROJECT' ? projectFilePath : isolationFilePath
      )) {
        throw new Error('Wave candidate path identity is inconsistent.');
      }
      let methods = validateEffectiveCode(
        owned.code,
        outputTestClassName,
        context.packageName,
        this.structure
      );
      await this.clearStoredWaveParts(task, wave, waveCheckpoint.waveIndex);
      if (existingCandidate.status !== 'PASSED') {
        let execution: CandidateExecutionFeedback;
        let retainedEmpty = false;
        if (this.options.mavenReadyQueue) {
          ({ owned, execution, checkpoint: candidateCheckpoint } = await this
            .executeReadyWaveCandidate({
              task,
              context,
              wave,
              waveIndex: waveCheckpoint.waveIndex,
              candidateId: existingCandidate.candidateId,
              owned,
              checkpoint: candidateCheckpoint,
              projectFilePath,
              scope: 'method_candidate',
              signal
            }));
        } else {
          if (candidateCheckpoint.managedFile?.location !== 'PROJECT') {
            throw new Error('Direct Maven recovery requires the Wave TMP in the project.');
          }
          const mavenCheckpointStatus = existingCandidate.stableRepair.phase !== 'NOT_STARTED'
            ? 'STABLE_REPAIR'
            : existingCandidate.status === 'MODEL_REPAIR'
              ? 'MODEL_REPAIR'
              : 'MAVEN_RUNNING';
          candidateCheckpoint = await this.options.checkpoints.saveWaveCandidate(
            task.id,
            updateWaveCandidateCheckpoint(
              candidateCheckpoint,
              owned,
              mavenCheckpointStatus
            )
          );
          execution = await this.options.moduleLock.runExclusive(
            task.moduleKey,
            () => this.executeMaven(task, context, owned, 'method_candidate', signal),
            signal
          );
        }
        if (execution.status !== 'passed' || !execution.testReport) {
          const recoveredRepairAttempt = candidateCheckpoint.llmRepairAttemptsUsed;
          const recoveredCandidateVersion = recoveredRepairAttempt + 1;
          const recoveredCandidate: MethodCandidate = {
            candidateId: existingCandidate.candidateId,
            candidateVersion: recoveredCandidateVersion,
            repairAttempt: recoveredRepairAttempt,
            methodId: wave.methodId,
            batchId: wave.waveBatchId,
            batchIndex: waveCheckpoint.waveIndex,
            testCode: owned.code,
            generatedCodeSha256: owned.sha256,
            outputTestClassName,
            ordinaryTestMethodCount: methods.length,
            usage: null
          };
          const resumeStableRepair = existingCandidate.status === 'STABLE_REPAIR'
            || existingCandidate.stableRepair.phase !== 'NOT_STARTED';
          if (resumeStableRepair) {
            const stabilized = await this.stabilizeMergedWaveCandidate({
              task,
              context,
              owned,
              execution,
              checkpoint: candidateCheckpoint,
              signal
            });
            ({ owned, execution, candidateCheckpoint, retainedEmpty } = stabilized);
          } else {
            candidateCheckpoint = await this.options.checkpoints.saveWaveCandidate(
              task.id,
              updateWaveCandidateCheckpoint(
                candidateCheckpoint,
                owned,
                'MODEL_REPAIR'
              )
            );
            const repaired = await this.repairMergedWaveCandidate({
              task,
              context,
              wave,
              waveIndex: waveCheckpoint.waveIndex,
              acceptedPartIndexes,
              candidate: recoveredCandidate,
              owned,
              execution,
              checkpoint: candidateCheckpoint,
              signal
            });
            ({ owned, execution, candidateCheckpoint, retainedEmpty } = repaired);
          }
          methods = this.structure.findTestMethods(owned.code);
          if (!execution.testReport) {
            if (!retainedEmpty || methods.length !== 0) {
              throw new Error('Recovered Wave candidate has no Surefire report.');
            }
          }
        }
        if (execution.testReport && (
          execution.testReport.generatedTests < methods.length
          || execution.testReport.generatedSkipped !== 0
        )) {
          throw new Error('Surefire did not execute every recovered Wave test method.');
        }
        candidateCheckpoint = await this.options.checkpoints.saveWaveCandidate(
          task.id,
          updateWaveCandidateCheckpoint(candidateCheckpoint, owned, 'PASSED')
        );
      } else if (candidateCheckpoint.managedFile?.location !== 'PROJECT') {
        throw new Error('Passing Wave candidate has no project TMP recovery identity.');
      }
      const methodIdentity = this.methodIdentityFromContext(context, wave.methodId);
      if ('selectedMethodIds' in wave) {
        return recoveredClassWaveOutcome(
          wave,
          acceptedPartIndexes,
          candidateCheckpoint.candidateId,
          this.classWaveBundles(
            wave,
            acceptedPartIndexes,
            owned.code,
            methods,
            context,
            [candidateCheckpoint.candidateId],
            waveState,
            waveCheckpoint.waveIndex
          )
        );
      }
      return recoveredWaveOutcome(
        wave,
        acceptedPartIndexes,
        candidateCheckpoint.candidateId,
        {
          methodId: wave.methodId,
          sourceMethodId: wave.methodId,
          waveIndex: waveCheckpoint.waveIndex,
          hasRemainingScenarios: wave.remainingScenarioCount > 0,
          ...methodIdentity,
          code: owned.code,
          ordinaryTestMethodCount: methods.length,
          passedTestMethods: methods.map((method) => method.name),
          sourceBatchIds: [candidateCheckpoint.candidateId]
        }
      );
    }
    const context = await this.options.contextProvider.resolve(task, signal);
    if (context.reportPairId !== wave.reportPairId) {
      throw new Error('Method Wave belongs to a stale coverage report.');
    }
    const generatedStartRequest = buildMethodGenerationWaveRequest({
      task,
      wave,
      waveIndex: waveCheckpoint.waveIndex,
      sourceClassName,
      context,
      randomUUID: this.randomUUID
    });
    let activeWave = structuredClone(waveCheckpoint);
    activeWave.eventSequence ??= 0;
    activeWave.recoveryRequestId ??= null;
    activeWave.startRequest ??= null;
    activeWave.wave ??= structuredClone(wave);
    activeWave.initialUsageRecorded ??= false;
    for (const part of activeWave.parts) {
      part.childSessionId ??= null;
      part.aggregateUsage ??= null;
      part.modelCallCount ??= 0;
      part.usageReportedCallCount ??= 0;
    }
    const startRequest = activeWave.startRequest ?? generatedStartRequest;
    assertWaveStartRequestIdentity(startRequest, task, wave, waveCheckpoint.waveIndex, context);
    if (!activeWave.startRequest) {
      activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
        ...activeWave,
        startRequest: structuredClone(startRequest)
      });
    }
    let waveSessionId = activeWave.waveSessionId;
    const persistTerminalPart = async (
      result: MethodGenerationWavePartResult
    ): Promise<void> => {
      const part = requireWavePart(wave, result.partIndex);
      const checkpointPart = requireWaveCheckpointPart(activeWave, part.partIndex);
      applyTerminalPartCheckpoint(checkpointPart, result);
      if (result.status !== 'succeeded') return;
      try {
        const candidate = requireSuccessfulWavePartCandidate(
          result,
          part,
          wave.methodId,
          outputPartTestClassName(sourceClassName, waveCheckpoint.waveIndex, part.partIndex)
        );
        const stored = await this.partStore.store({
          workspaceRoot: task.workspaceRoot,
          taskId: task.id,
          methodId: wave.methodId,
          sourceClassName,
          waveIndex: waveCheckpoint.waveIndex,
          partIndex: part.partIndex,
          partBatchId: part.partBatchId,
          scenarioIds: part.scenarioIds,
          candidateId: candidate.candidateId,
          code: candidate.testCode
        });
        Object.assign(checkpointPart, {
          status: 'SUCCEEDED',
          childSessionId: result.childSessionId,
          candidateId: stored.candidateId,
          isolatedFilePath: stored.filePath,
          fileSha256: stored.sha256,
          failureReason: null
        });
      } catch (error) {
        Object.assign(checkpointPart, {
          status: 'FAILED',
          childSessionId: result.childSessionId,
          candidateId: null,
          isolatedFilePath: null,
          fileSha256: null,
          failureReason: compactWaveFailure(error)
        });
      }
    };
    const onProgress = async (event: MethodGenerationWaveEvent): Promise<void> => {
      if (event.eventSequence <= activeWave.eventSequence) return;
      activeWave = applyMethodGenerationWaveEvent(activeWave, event);
      waveSessionId = activeWave.waveSessionId;
      const terminalParts = event.partResult
        ? [event.partResult]
        : event.completion?.parts ?? [];
      for (const terminalPart of terminalParts) {
        await persistTerminalPart(terminalPart);
      }
      activeWave = await this.options.checkpoints.saveActiveMethodWave(
        task.id,
        activeWave
      );
      if (event.childEvent?.modelCall && event.partIndex !== null) {
        const part = requireWavePart(wave, event.partIndex);
        const partRequest = startRequest.parts.find(
          (item) => item.partIndex === event.partIndex
        );
        if (!partRequest) {
          throw new Error(`Wave Part ${event.partIndex} has no generation request.`);
        }
        await this.options.logs.record({
          taskId: task.id,
          className: task.qualifiedClassName.split('.').at(-1)
            ?? task.qualifiedClassName,
          qualifiedClassName: task.qualifiedClassName,
          methodId: wave.methodId,
          methodName: part.method.methodName,
          descriptor: part.method.descriptor,
          displaySignature: displayGenerationBatchSignature(partRequest.request.batch),
          modifiers: part.method.modifiers,
          batchId: part.partBatchId,
          batchIndex: waveCheckpoint.waveIndex,
          waveIndex: waveCheckpoint.waveIndex,
          partIndex: part.partIndex,
          partBatchId: part.partBatchId,
          scenarioIds: [...part.scenarioIds],
          event: event.childEvent
        });
      }
    };
    const recoverMissingWaveSession = async (forceNewRequest = false) => {
      const recoveryRequestId = forceNewRequest
        ? this.randomUUID()
        : activeWave.recoveryRequestId ?? this.randomUUID();
      if (activeWave.recoveryRequestId !== recoveryRequestId
        || activeWave.waveSessionId !== null) {
        activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
          ...activeWave,
          waveSessionId: null,
          recoveryRequestId
        });
        waveSessionId = null;
      }
      const terminalParts: MethodGenerationWavePartResult[] = [];
      for (const checkpointPart of [...activeWave.parts].sort((left, right) => (
        left.partIndex - right.partIndex
      ))) {
        const part = requireWavePart(wave, checkpointPart.partIndex);
        if (checkpointPart.status === 'SUCCEEDED') {
          if (!checkpointPart.childSessionId
            || !checkpointPart.candidateId
            || !checkpointPart.isolatedFilePath
            || !checkpointPart.fileSha256) {
            throw new Error(
              `Succeeded Wave Part ${part.partIndex} has incomplete recovery identity.`
            );
          }
          const stored = await this.partStore.load({
            workspaceRoot: task.workspaceRoot,
            taskId: task.id,
            methodId: wave.methodId,
            sourceClassName,
            waveIndex: waveCheckpoint.waveIndex,
            partIndex: part.partIndex,
            partBatchId: part.partBatchId,
            scenarioIds: part.scenarioIds,
            candidateId: checkpointPart.candidateId,
            filePath: checkpointPart.isolatedFilePath,
            sha256: checkpointPart.fileSha256
          });
          terminalParts.push({
            partIndex: part.partIndex,
            partBatchId: part.partBatchId,
            scenarioIds: [...part.scenarioIds],
            status: 'succeeded',
            childSessionId: checkpointPart.childSessionId,
            candidate: {
              candidateId: stored.candidateId,
              candidateVersion: 1,
              repairAttempt: 0,
              methodId: wave.methodId,
              batchId: part.partBatchId,
              batchIndex: waveCheckpoint.waveIndex,
              testCode: stored.code,
              generatedCodeSha256: stored.sha256,
              outputTestClassName: stored.testClassName,
              ordinaryTestMethodCount: plannedTestMethodCount(part),
              usage: null
            },
            error: null,
            aggregateUsage: checkpointPart.aggregateUsage,
            modelCallCount: checkpointPart.modelCallCount,
            usageReportedCallCount: checkpointPart.usageReportedCallCount
          });
        } else if (checkpointPart.status === 'FAILED'
          && !/^MODEL_[A-Z0-9_]{1,121}:/.test(
            checkpointPart.failureReason ?? ''
          )) {
          terminalParts.push({
            partIndex: part.partIndex,
            partBatchId: part.partBatchId,
            scenarioIds: [...part.scenarioIds],
            status: 'failed',
            childSessionId: checkpointPart.childSessionId,
            candidate: null,
            error: {
              code: 'RECOVERED_PART_FAILED',
              message: checkpointPart.failureReason
                ?? 'The Wave Part failed before recovery.',
              stage: 'generation'
            },
            aggregateUsage: checkpointPart.aggregateUsage,
            modelCallCount: checkpointPart.modelCallCount,
            usageReportedCallCount: checkpointPart.usageReportedCallCount
          });
        }
      }
      return this.options.agent.recoverMethodGenerationWaveStream(
        {
          recoveryRequestId,
          startRequest,
          terminalParts,
          lastAcknowledgedEventSequence: activeWave.eventSequence
        },
        context.modelContext,
        onProgress,
        signal
      );
    };
    const recoverWaveSession = async (forceNewRequest = false) => {
      try {
        return await recoverMissingWaveSession(forceNewRequest);
      } catch (error) {
        if (!forceNewRequest
          && error instanceof MethodGenerationRequestError
          && error.code === 'METHOD_GENERATION_WAVE_IDEMPOTENCY_CONFLICT') {
          return recoverMissingWaveSession(true);
        }
        throw error;
      }
    };
    let turn;
    try {
      turn = await this.atomic(task.id, 'MODEL_GENERATION', async () => {
        if (activeWave.waveSessionId) {
          try {
            return await this.options.agent.resumeMethodGenerationWaveStream(
              activeWave.waveSessionId,
              startRequest,
              activeWave.eventSequence,
              onProgress,
              signal
            );
          } catch (error) {
            if (error instanceof MethodGenerationWaveNotFoundError) {
              return recoverWaveSession();
            }
            if (error instanceof MethodGenerationRequestError
              && error.code.startsWith('MODEL_')) {
              return recoverWaveSession(true);
            }
            throw error;
          }
        }
        if (activeWave.recoveryRequestId) return recoverWaveSession();
        return this.options.agent.streamMethodGenerationWave(
            startRequest,
            context.modelContext,
            onProgress,
            signal
          );
      });
    } catch (error) {
      if (signal.aborted && waveSessionId) {
        const cancelledWaveSessionId = waveSessionId;
        if (isClassTaskPauseRequestedError(signal.reason)) {
          activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
            ...activeWave,
            waveSessionId: null,
            recoveryRequestId: this.randomUUID(),
            parts: activeWave.parts.map((part) => (
              part.status === 'RUNNING' || part.status === 'CANCELLED'
                ? {
                    ...part,
                    status: 'PENDING' as const,
                    childSessionId: null,
                    candidateId: null,
                    isolatedFilePath: null,
                    fileSha256: null,
                    failureReason: null
                  }
                : part
            ))
          });
          waveSessionId = null;
          void this.options.agent.cancelMethodGenerationWave(cancelledWaveSessionId)
            .catch(() => undefined);
        } else {
          try {
            await this.options.agent.cancelMethodGenerationWave(cancelledWaveSessionId);
          } catch {
            // Preserve the original generation error; recovery will reconcile the session.
          }
        }
      }
      throw error;
    }
    waveSessionId = turn.waveSessionId;
    if (activeWave.waveSessionId !== waveSessionId) {
      activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
        ...activeWave,
        waveSessionId
      });
    }

    const terminalParts = [...turn.completion.parts].sort((left, right) => (
      left.partIndex - right.partIndex
    ));
    assertTerminalWavePartition(wave, terminalParts);
    for (const terminalPart of terminalParts) {
      const checkpointPart = requireWaveCheckpointPart(activeWave, terminalPart.partIndex);
      if (terminalPart.status !== 'succeeded' || checkpointPart.status !== 'SUCCEEDED') {
        await persistTerminalPart(terminalPart);
      }
    }
    activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, activeWave);
    if (!activeWave.initialUsageRecorded && turn.completion.modelCallCount > 0) {
      await this.recordCompletionUsage(task.id, turn.completion);
      activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
        ...activeWave,
        initialUsageRecorded: true
      });
    }
    const modelFailure = preferredPartModelFailure(terminalParts);
    if (modelFailure) {
      // A successful sibling Part is durable input for the next recovery attempt. Do not
      // merge, run Maven, or consume any scenarios until every model-dependent Part succeeds.
      // A fresh recovery identity also guarantees that resuming with a newly selected model
      // cannot replay the terminal result produced by the unavailable model.
      activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
        ...activeWave,
        waveSessionId: null,
        recoveryRequestId: this.randomUUID()
      });
      await this.options.agent.acknowledgeMethodGenerationWaveEvents(
        waveSessionId,
        turn.eventSequence,
        signal
      );
      await this.recordWaveSummary({
        task,
        wave,
        waveIndex: waveCheckpoint.waveIndex,
        activeWave,
        skippedScenarioIds: new Set<string>(),
        mergedCandidateId: null
      });
      return {
        completedScenarioIds: [],
        skippedScenarioIds: [],
        candidateIds: [],
        modelFailure
      };
    }
    const skippedScenarioIds = new Set<string>();
    const succeeded = terminalParts.filter((part) => {
      if (part.status === 'succeeded') return true;
      part.scenarioIds.forEach((scenarioId) => skippedScenarioIds.add(scenarioId));
      return false;
    });
    let storedParts: StoredMethodWavePart[] = [];
    const storageResults = await Promise.all(succeeded.map(async (result) => {
      const part = requireWavePart(wave, result.partIndex);
      const loadCheckpointedPart = async (): Promise<StoredMethodWavePart> => {
        const checkpointPart = requireWaveCheckpointPart(activeWave, part.partIndex);
        if (checkpointPart.status !== 'SUCCEEDED'
          || !checkpointPart.candidateId
          || !checkpointPart.isolatedFilePath
          || !checkpointPart.fileSha256) {
          throw new Error('Successful Wave Part has no durable checkpointed file.');
        }
        return this.partStore.load({
          workspaceRoot: task.workspaceRoot,
          taskId: task.id,
          methodId: wave.methodId,
          sourceClassName,
          waveIndex: waveCheckpoint.waveIndex,
          partIndex: part.partIndex,
          partBatchId: part.partBatchId,
          scenarioIds: part.scenarioIds,
          candidateId: checkpointPart.candidateId,
          filePath: checkpointPart.isolatedFilePath,
          sha256: checkpointPart.fileSha256
        });
      };
      try {
        return await loadCheckpointedPart();
      } catch (error) {
        let durableError = error;
        try {
          await persistTerminalPart(result);
          return await loadCheckpointedPart();
        } catch (restoreError) {
          durableError = restoreError;
        }
        part.scenarioIds.forEach((scenarioId) => skippedScenarioIds.add(scenarioId));
        const checkpointPart = requireWaveCheckpointPart(activeWave, part.partIndex);
        Object.assign(checkpointPart, {
          status: 'FAILED',
          candidateId: null,
          isolatedFilePath: null,
          fileSha256: null,
          failureReason: compactWaveFailure(durableError)
        });
        return null;
      }
    }));
    storedParts = storageResults.filter(
      (part): part is StoredMethodWavePart => part !== null
    );
    activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, activeWave);

    let merged: MethodWavePartMergeResult | null = null;
    if (storedParts.length > 0) {
      try {
        merged = this.partMerger.merge({
          methodId: wave.methodId,
          waveId: wave.waveBatchId,
          waveIndex: waveCheckpoint.waveIndex,
          outputTestClassName,
          parts: storedParts.map((part) => ({
            partIndex: part.partIndex,
            partBatchId: part.partBatchId,
            scenarioIds: [...part.scenarioIds],
            candidateId: part.candidateId,
            testClassName: part.testClassName,
            code: part.code
          }))
        });
      } catch (error) {
        for (const stored of storedParts) {
          stored.scenarioIds.forEach((scenarioId) => skippedScenarioIds.add(scenarioId));
          const checkpointPart = requireWaveCheckpointPart(activeWave, stored.partIndex);
          Object.assign(checkpointPart, {
            status: 'FAILED',
            candidateId: null,
            isolatedFilePath: null,
            fileSha256: null,
            failureReason: compactWaveFailure(error)
          });
        }
      }
    }
    if (merged) {
      for (const skippedPart of merged.skippedParts) {
        const stored = storedParts.find((part) => part.partIndex === skippedPart.partIndex);
        stored?.scenarioIds.forEach((scenarioId) => skippedScenarioIds.add(scenarioId));
        const checkpointPart = requireWaveCheckpointPart(activeWave, skippedPart.partIndex);
        Object.assign(checkpointPart, {
          status: 'FAILED',
          candidateId: null,
          isolatedFilePath: null,
          fileSha256: null,
          failureReason: skippedPart.reason
        });
      }
    }
    activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, activeWave);
    await this.options.agent.acknowledgeMethodGenerationWaveEvents(
      waveSessionId,
      turn.eventSequence,
      signal
    );

    if (!merged || merged.acceptedPartIndexes.length === 0) {
      const modelFailure: MethodGenerationFailure = {
        code: 'GENERATED_TEST_INVALID',
        message: '生成的测试代码无效，没有可用的测试候选。',
        stage: 'generation'
      };
      activeWave = await this.options.checkpoints.saveActiveMethodWave(task.id, {
        ...activeWave,
        waveSessionId: null,
        recoveryRequestId: this.randomUUID()
      });
      await this.recordWaveSummary({
        task,
        wave,
        waveIndex: waveCheckpoint.waveIndex,
        activeWave,
        skippedScenarioIds: new Set<string>(),
        mergedCandidateId: null
      });
      await this.clearStoredWaveParts(task, wave, waveCheckpoint.waveIndex);
      return {
        completedScenarioIds: [],
        skippedScenarioIds: [],
        candidateIds: [],
        modelFailure
      };
    }

    const acceptedPartIndexes = new Set(merged.acceptedPartIndexes);
    const completedScenarioIds = wave.parts.flatMap((part) => (
      acceptedPartIndexes.has(part.partIndex) ? part.scenarioIds : []
    ));
    const candidateId = rebuildableCandidateId ?? this.randomUUID();
    const candidate: MethodCandidate = {
      candidateId,
      candidateVersion: 1,
      repairAttempt: 0,
      methodId: wave.methodId,
      batchId: wave.waveBatchId,
      batchIndex: waveCheckpoint.waveIndex,
      testCode: merged.code,
      generatedCodeSha256: merged.sha256,
      outputTestClassName,
      ordinaryTestMethodCount: merged.ordinaryTestMethodCount,
      usage: null
    };
    await this.recordWaveSummary({
      task,
      wave,
      waveIndex: waveCheckpoint.waveIndex,
      activeWave,
      skippedScenarioIds,
      mergedCandidateId: candidateId
    });
    let owned: OwnedCandidateFile;
    let execution: CandidateExecutionFeedback;
    let candidateCheckpoint: WaveCandidateCheckpoint;
    let retainedEmpty = false;
    if (this.options.mavenReadyQueue) {
      let projectFilePath: string;
      ({ owned, candidateCheckpoint, projectFilePath } = await this.options.moduleLock
        .runExclusive(
          task.moduleKey,
          async () => {
            const written = await this.writeCandidate(task, context, candidate, null);
            let saved = await this.options.checkpoints.saveWaveCandidate(
              task.id,
              waveCandidateCheckpoint(task, wave, candidateId, written, 'READY_FOR_MAVEN')
            );
            const isolated = await this.moveQueuedWaveCandidate({
              task,
              candidateId,
              owned: written,
              checkpoint: saved,
              targetPath: waveCandidateIsolationPath(task, candidateId, written.testClassName),
              targetLocation: 'ISOLATED',
              status: 'READY_FOR_MAVEN'
            });
            saved = isolated.checkpoint;
            await this.clearStoredWaveParts(task, wave, waveCheckpoint.waveIndex);
            return {
              owned: isolated.owned,
              candidateCheckpoint: saved,
              projectFilePath: written.filePath
            };
          },
          signal
        ));
      ({ owned, execution, checkpoint: candidateCheckpoint } = await this
        .executeReadyWaveCandidate({
          task,
          context,
          wave,
          waveIndex: waveCheckpoint.waveIndex,
          candidateId,
          owned,
          checkpoint: candidateCheckpoint,
          projectFilePath,
          scope: 'method_candidate',
          signal
        }));
    } else {
      ({ owned, execution, candidateCheckpoint } = await this.options.moduleLock.runExclusive(
        task.moduleKey,
        async () => {
          const written = await this.writeCandidate(task, context, candidate, null);
          const saved = await this.options.checkpoints.saveWaveCandidate(
            task.id,
            waveCandidateCheckpoint(task, wave, candidateId, written, 'READY_FOR_MAVEN')
          );
          await this.clearStoredWaveParts(task, wave, waveCheckpoint.waveIndex);
          const result = await this.executeMaven(
            task,
            context,
            written,
            'method_candidate',
            signal
          );
          return { owned: written, execution: result, candidateCheckpoint: saved };
        },
        signal
      ));
    }
    if (execution.status !== 'passed' || !execution.testReport) {
      candidateCheckpoint = await this.options.checkpoints.saveWaveCandidate(
        task.id,
        updateWaveCandidateCheckpoint(
          candidateCheckpoint,
          owned,
          'MODEL_REPAIR'
        )
      );
      const repaired = await this.repairMergedWaveCandidate({
        task,
        context,
        wave,
        waveIndex: waveCheckpoint.waveIndex,
        acceptedPartIndexes,
        candidate,
        owned,
        execution,
        checkpoint: candidateCheckpoint,
        signal
      });
      ({ owned, execution, candidateCheckpoint, retainedEmpty } = repaired);
    }
    const methods = this.structure.findTestMethods(owned.code);
    if (!execution.testReport) {
      if (!retainedEmpty || methods.length !== 0) {
        throw new Error('Verified merged Wave candidate has no Surefire report.');
      }
    } else {
      if (execution.testReport.generatedTests < methods.length
        || execution.testReport.generatedSkipped !== 0) {
        throw new Error('Surefire did not execute every merged Wave test method.');
      }
    }
    candidateCheckpoint = await this.options.checkpoints.saveWaveCandidate(
      task.id,
      updateWaveCandidateCheckpoint(candidateCheckpoint, owned, 'PASSED')
    );
    const methodIdentity = this.methodIdentityFromContext(context, wave.methodId);
    const formalizedMethods = this.structure.findTestMethods(owned.code);
    if ('selectedMethodIds' in wave) {
      const bundles = this.classWaveBundles(
        wave,
        acceptedPartIndexes,
        owned.code,
        formalizedMethods,
        context,
        [candidateId],
        waveState,
        waveCheckpoint.waveIndex
      );
      return {
        completedScenarioIds,
        skippedScenarioIds: wave.selectedScenarioIds.filter((scenarioId) => (
          skippedScenarioIds.has(scenarioId)
        )),
        candidateIds: [candidateId],
        bundles
      };
    }
    return {
      completedScenarioIds,
      skippedScenarioIds: wave.selectedScenarioIds.filter((scenarioId) => (
        skippedScenarioIds.has(scenarioId)
      )),
      candidateIds: [candidateId],
      bundle: {
        methodId: wave.methodId,
        sourceMethodId: wave.methodId,
        waveIndex: waveCheckpoint.waveIndex,
        hasRemainingScenarios: wave.remainingScenarioCount > 0,
        ...methodIdentity,
        code: owned.code,
        ordinaryTestMethodCount: formalizedMethods.length,
        passedTestMethods: formalizedMethods.map((method) => method.name),
        sourceBatchIds: [candidateId]
      }
    };
  }

  private clearStoredWaveParts(
    task: ClassTaskSnapshot,
    wave: SingleMethodWorkWave,
    waveIndex: number
  ): Promise<void> {
    return this.partStore.clearWave(
      task.workspaceRoot,
      task.id,
      wave.methodId,
      waveIndex
    );
  }

  private async repairMergedWaveCandidate(input: {
    task: ClassTaskSnapshot;
    context: SingleMethodGenerationContext;
    wave: SingleMethodWorkWave;
    waveIndex: number;
    acceptedPartIndexes: ReadonlySet<number>;
    candidate: MethodCandidate;
    owned: OwnedCandidateFile;
    execution: CandidateExecutionFeedback;
    checkpoint: WaveCandidateCheckpoint;
    signal: AbortSignal;
  }): Promise<{
    owned: OwnedCandidateFile;
    execution: CandidateExecutionFeedback;
    candidateCheckpoint: WaveCandidateCheckpoint;
    retainedEmpty: boolean;
  }> {
    const plannedTestMethodNames = this.structure
      .findTestMethods(input.owned.code)
      .map((method) => method.name);
    if (plannedTestMethodNames.length !== input.candidate.ordinaryTestMethodCount) {
      throw new Error('Merged Wave repair candidate test count changed before repair.');
    }
    const page = mergedWaveRepairBatch(
      input.wave,
      input.acceptedPartIndexes,
      plannedTestMethodNames.length,
      plannedTestMethodNames
    );
    const startRequest: StartMethodGenerationSessionRequest = {
      clientRequestId: this.randomUUID(),
      classTaskId: input.task.id,
      methodId: input.wave.methodId,
      batchId: input.wave.waveBatchId,
      batchIndex: input.waveIndex,
      outputTestClassName: input.candidate.outputTestClassName,
      expectedPackageName: input.context.packageName,
      buildToolchain: input.context.buildToolchain,
      batch: page,
      captureModelCalls: input.context.captureModelCalls,
      repairAttemptLimit: input.task.unlimitedRepair
        ? null
        : input.task.repairAttemptLimit,
      unlimitedRepair: input.task.unlimitedRepair,
      ...(input.context.ragContext ? { ragContext: input.context.ragContext } : {})
    };
    const onProgress = this.progressLogger(input.task, page, input.waveIndex);
    const seeded = await this.atomic(input.task.id, 'MODEL_REPAIR', () => (
      this.options.agent.recoverMethodGenerationStream(
        {
          startRequest,
          candidate: input.candidate
        },
        input.context.modelContext,
        onProgress,
        input.signal
      )
    ));
    if (seeded.kind !== 'candidate_ready') {
      if (seeded.kind === 'completed') {
        await this.recordCompletionUsage(input.task.id, seeded.completion);
      }
      throw new Error('Merged Wave repair session did not expose its seeded candidate.');
    }
    if (
      seeded.candidate.candidateId !== input.candidate.candidateId
      || seeded.candidate.candidateVersion !== input.candidate.candidateVersion
      || seeded.candidate.generatedCodeSha256 !== input.candidate.generatedCodeSha256
    ) {
      throw new Error('Merged Wave repair session changed the seeded candidate identity.');
    }

    let sessionId = seeded.sessionId;
    let eventSequence = seeded.eventSequence;
    let candidate = seeded.candidate;
    let previousCandidateVersion = candidate.candidateVersion;
    let owned = input.owned;
    let execution = input.execution;
    let checkpoint = input.checkpoint;
    let sessionTerminal = false;

    try {
      while (execution.status !== 'passed') {
        throwIfAborted(input.signal);
        if (!checkpoint.unlimitedRepair
          && checkpoint.llmRepairAttemptsUsed >= (checkpoint.repairAttemptLimit as number)) {
          await this.cancelAgentSession(input.task.id, sessionId);
          sessionTerminal = true;
          return this.stabilizeMergedWaveCandidate({
            task: input.task,
            context: input.context,
            owned,
            execution,
            checkpoint,
            signal: input.signal
          });
        }

        let ragRepairAttempt: RagRepairAttemptContext | null = null;
        const diagnostic = this.diagnostic.normalize({
          execution,
          generatedTestFilePath: waveCandidateProjectPath(
            input.task,
            input.context,
            owned.testClassName
          ),
          generatedTestClassName: qualifiedName(
            input.context.packageName,
            owned.testClassName
          ),
          targetProductionClassName: input.task.qualifiedClassName,
          targetProductionFilePath: input.task.sourceFilePath
        });
        const analyzerStartedAt = performance.now();
        const repairContext = await this.resolveRepairContext(
          input.context,
          page,
          diagnostic,
          owned.code,
          input.signal
        );
        const analyzerDurationMs = elapsedMilliseconds(analyzerStartedAt);
        let mavenDurationMs: number | null = null;
        if (input.context.ragContext) {
          ragRepairAttempt = await this.prepareRagRepairAttempt(
            input.context,
            page,
            sessionId,
            eventSequence,
            candidate,
            owned,
            execution,
            repairContext,
            input.signal
          );
        }

        checkpoint = await this.options.checkpoints.saveWaveCandidate(
          input.task.id,
          updateWaveCandidateCheckpoint(checkpoint, owned, 'MODEL_REPAIR')
        );
        checkpoint = await this.options.checkpoints.beginWaveCandidateModelRepair(
          input.task.id,
          checkpoint.candidateId
        );
        let modelRepairAttemptOpen = true;
        const rollbackOpenModelRepairAttempt = async () => {
          if (!modelRepairAttemptOpen) return;
          checkpoint = await this.options.checkpoints.rollbackWaveCandidateModelRepair(
            input.task.id,
            checkpoint.candidateId
          );
          modelRepairAttemptOpen = false;
        };
        const request: ResumeMethodGenerationSessionRequest = {
          feedbackId: this.randomUUID(),
          expectedEventSequence: eventSequence,
          candidateId: candidate.candidateId,
          candidateVersion: candidate.candidateVersion,
          repairAttempt: candidate.repairAttempt,
          effectiveTestCode: owned.code,
          effectiveFileSha256: owned.sha256,
          feedbackKind: 'execution',
          execution,
          ...(!ragRepairAttempt && repairContext
            ? { repairContext }
            : {}),
          ...(ragRepairAttempt && input.context.ragEmbeddingConfig
            ? {
                ragRepairAttempt,
                ragEmbeddingConfig: input.context.ragEmbeddingConfig
              }
            : {})
        };
        let resumed: Awaited<ReturnType<AiClient['resumeMethodGenerationStream']>>;
        try {
          resumed = await this.atomic(input.task.id, 'MODEL_REPAIR', () => (
            this.options.agent.resumeMethodGenerationStream(
              sessionId,
              request,
              input.context.modelContext,
              onProgress,
              input.signal
            )
          ));
          modelRepairAttemptOpen = false;
        } catch (error) {
          if (!isRepairOutputRetryExhaustedError(error)) {
            await rollbackOpenModelRepairAttempt();
            throw error;
          }
          modelRepairAttemptOpen = false;
          await this.cancelAgentSession(input.task.id, sessionId);
          sessionTerminal = true;
          return this.stabilizeMergedWaveCandidate({
            task: input.task,
            context: input.context,
            owned,
            execution,
            checkpoint,
            signal: input.signal
          });
        }
        eventSequence = resumed.eventSequence;
        if (resumed.kind === 'completed') {
          sessionTerminal = true;
          await this.recordCompletionUsage(input.task.id, resumed.completion);
          if (resumed.completion.stopReason !== 'repair_exhausted') {
            await rollbackOpenModelRepairAttempt();
            throw new Error('Merged Wave repair session ended before Maven verification.');
          }
          await this.options.agent.acknowledgeMethodGenerationEvents(
            sessionId,
            eventSequence,
            input.signal
          );
          return this.stabilizeMergedWaveCandidate({
            task: input.task,
            context: input.context,
            owned,
            execution,
            checkpoint,
            signal: input.signal
          });
        }

        try {
          let nextCandidate = resumed.candidate;
        while (true) {
          validateCandidate(
            nextCandidate,
            page,
            input.candidate.outputTestClassName,
            input.waveIndex,
            previousCandidateVersion,
            input.task.unlimitedRepair ? null : input.task.repairAttemptLimit,
            input.context.packageName,
            this.structure
          );
          previousCandidateVersion = nextCandidate.candidateVersion;
          const codeWithAnalyzerImports = restoreReferencedAllowedTypeImports({
            candidateCode: nextCandidate.testCode,
            allowedImports: page.necessaryImports
          });
          if (codeWithAnalyzerImports !== nextCandidate.testCode) {
            nextCandidate = {
              ...nextCandidate,
              testCode: codeWithAnalyzerImports,
              generatedCodeSha256: sha256(codeWithAnalyzerImports)
            };
          }

          if (!ragRepairAttempt && diagnostic && repairContext) {
            const codeWithAcceptedWildcards = preserveAcceptedWildcardImports({
              acceptedCode: owned.code,
              candidateCode: nextCandidate.testCode,
              diagnostic
            });
            if (codeWithAcceptedWildcards !== nextCandidate.testCode) {
              nextCandidate = {
                ...nextCandidate,
                testCode: codeWithAcceptedWildcards,
                generatedCodeSha256: sha256(codeWithAcceptedWildcards)
              };
            }
          }

          const validation = this.candidateChanges.validateTestIdentityChanges({
            acceptedCode: owned.code,
            candidateCode: nextCandidate.testCode
          });
          if (!validation.accepted) {
            if (!ragRepairAttempt && repairContext) {
              await this.recordRepairTelemetry(
                input.task,
                page,
                nextCandidate,
                diagnostic,
                repairContext,
                validation.violationCodes,
                mavenDurationMs,
                analyzerDurationMs
              );
            }
            if (!this.canRepairAgain(input.task, nextCandidate)) {
              await this.cancelAgentSession(input.task.id, sessionId);
              sessionTerminal = true;
              return this.stabilizeMergedWaveCandidate({
                task: input.task,
                context: input.context,
                owned,
                execution,
                checkpoint,
                signal: input.signal
              });
            }

            checkpoint = await this.options.checkpoints.beginWaveCandidateModelRepair(
              input.task.id,
              checkpoint.candidateId
            );
            modelRepairAttemptOpen = true;
            let rejected: Awaited<ReturnType<AiClient['resumeMethodGenerationStream']>>;
            try {
              rejected = await this.resumeRejectedCandidate(
                input.task,
                input.context,
                page,
                sessionId,
                eventSequence,
                nextCandidate,
                owned.code,
                owned.sha256,
                execution,
                repairContext,
                validation,
                onProgress,
                input.signal
              );
              modelRepairAttemptOpen = false;
            } catch (error) {
              await rollbackOpenModelRepairAttempt();
              throw error;
            }
            eventSequence = rejected.eventSequence;
            if (rejected.kind === 'completed') {
              sessionTerminal = true;
              await this.recordCompletionUsage(input.task.id, rejected.completion);
              this.requireRepairExhausted(rejected);
              await this.options.agent.acknowledgeMethodGenerationEvents(
                sessionId,
                eventSequence,
                input.signal
              );
              return this.stabilizeMergedWaveCandidate({
                task: input.task,
                context: input.context,
                owned,
                execution,
                checkpoint,
                signal: input.signal
              });
            }
            nextCandidate = rejected.candidate;
            continue;
          }
          if (!ragRepairAttempt && repairContext) {
            await this.recordRepairTelemetry(
              input.task,
              page,
              nextCandidate,
              diagnostic,
              repairContext,
              [],
              mavenDurationMs,
              analyzerDurationMs
            );
          }
          break;
        }

        const mavenStartedAt = performance.now();
        if (this.options.mavenReadyQueue) {
          owned = await this.writeCandidate(
            input.task,
            input.context,
            nextCandidate,
            owned
          );
          checkpoint = await this.options.checkpoints.saveWaveCandidate(
            input.task.id,
            updateWaveCandidateCheckpoint(checkpoint, owned, 'READY_FOR_MAVEN')
          );
          modelRepairAttemptOpen = false;
          ({ owned, execution, checkpoint } = await this.executeReadyWaveCandidate({
            task: input.task,
            context: input.context,
            wave: input.wave,
            waveIndex: input.waveIndex,
            candidateId: checkpoint.candidateId,
            owned,
            checkpoint,
            projectFilePath: waveCandidateProjectPath(
              input.task,
              input.context,
              owned.testClassName
            ),
            scope: 'method_candidate',
            signal: input.signal
          }));
        } else {
          ({ owned, execution } = await this.options.moduleLock.runExclusive(
            input.task.moduleKey,
            async () => {
              const written = await this.writeCandidate(
                input.task,
                input.context,
                nextCandidate,
                owned
              );
              checkpoint = await this.options.checkpoints.saveWaveCandidate(
                input.task.id,
                updateWaveCandidateCheckpoint(checkpoint, written, 'MAVEN_RUNNING')
              );
              modelRepairAttemptOpen = false;
              const result = await this.executeMaven(
                input.task,
                input.context,
                written,
                'method_candidate',
                input.signal
              );
              return { owned: written, execution: result };
            },
            input.signal
          ));
        }
        mavenDurationMs = elapsedMilliseconds(mavenStartedAt);
        candidate = nextCandidate;
          checkpoint = await this.options.checkpoints.saveWaveCandidate(
            input.task.id,
            updateWaveCandidateCheckpoint(
              checkpoint,
              owned,
              execution.status === 'passed' ? 'MAVEN_RUNNING' : 'MODEL_REPAIR'
            )
          );
        } catch (error) {
          await rollbackOpenModelRepairAttempt();
          throw error;
        }
      }

      const verified = await this.atomic(input.task.id, 'CONFIRM_RESULT', () => (
        this.options.agent.resumeMethodGenerationStream(
          sessionId,
          {
            feedbackId: this.randomUUID(),
            expectedEventSequence: eventSequence,
            candidateId: candidate.candidateId,
            candidateVersion: candidate.candidateVersion,
            repairAttempt: candidate.repairAttempt,
            effectiveTestCode: owned.code,
            effectiveFileSha256: owned.sha256,
            feedbackKind: 'execution',
            execution
          },
          input.context.modelContext,
          onProgress,
          input.signal
        )
      ));
      if (verified.kind !== 'completed'
        || verified.completion.stopReason !== 'verified') {
        throw new Error('Agent did not acknowledge the verified merged Wave candidate.');
      }
      sessionTerminal = true;
      eventSequence = verified.eventSequence;
      await this.recordCompletionUsage(input.task.id, verified.completion);
      await this.options.agent.acknowledgeMethodGenerationEvents(
        sessionId,
        eventSequence,
        input.signal
      );
      return {
        owned,
        execution,
        candidateCheckpoint: checkpoint,
        retainedEmpty: false
      };
    } finally {
      if (!sessionTerminal) {
        if (isClassTaskPauseRequestedError(input.signal.reason)) {
          this.cancelAgentSessionInBackground(input.task.id, sessionId);
        } else {
          await this.cancelAgentSession(input.task.id, sessionId);
        }
      }
    }
  }

  private async stabilizeMergedWaveCandidate(input: {
    task: ClassTaskSnapshot;
    context: SingleMethodGenerationContext;
    owned: OwnedCandidateFile;
    execution: CandidateExecutionFeedback;
    checkpoint: WaveCandidateCheckpoint;
    signal: AbortSignal;
  }): Promise<{
    owned: OwnedCandidateFile;
    execution: CandidateExecutionFeedback;
    candidateCheckpoint: WaveCandidateCheckpoint;
    retainedEmpty: boolean;
  }> {
    return this.options.moduleLock.runExclusive(input.task.moduleKey, async () => {
      let owned = input.owned;
      let checkpoint = input.checkpoint;
      if (this.options.mavenReadyQueue
        && checkpoint.managedFile?.location === 'ISOLATED') {
        const activated = await this.moveQueuedWaveCandidate({
          task: input.task,
          candidateId: checkpoint.candidateId,
          owned,
          checkpoint,
          targetPath: waveCandidateProjectPath(
            input.task,
            input.context,
            owned.testClassName
          ),
          targetLocation: 'PROJECT',
          status: 'STABLE_REPAIR'
        });
        owned = activated.owned;
        checkpoint = activated.checkpoint;
      }
      checkpoint = await this.options.checkpoints.saveWaveCandidate(
        input.task.id,
        updateWaveCandidateCheckpoint(checkpoint, owned, 'STABLE_REPAIR')
      );
      const result = await this.stableRepair.repair({
        code: owned.code,
        candidateFilePath: owned.filePath,
        generatedTestClassName: qualifiedName(
          input.context.packageName,
          owned.testClassName
        ),
        initialExecution: input.execution,
        annotatedMemberIds: checkpoint.stableRepair.annotatedMemberIds,
        initialIteration: checkpoint.stableRepair.iteration,
        signal: input.signal,
        replaceCandidate: async (code) => {
          const replacement = this.options.writer.prepareReplacement({
            workspaceRoot: input.task.workspaceRoot,
            filePath: owned.filePath,
            content: code
          });
          const written = await this.options.writer.replacePreparedGeneratedTest({
            workspaceRoot: input.task.workspaceRoot,
            filePath: owned.filePath,
            expectedSha256: owned.sha256,
            prepared: replacement
          });
          owned = {
            ...owned,
            code: replacement.content,
            sha256: written.sha256
          };
          checkpoint = await this.options.checkpoints.saveWaveCandidate(
            input.task.id,
            updateWaveCandidateCheckpoint(checkpoint, owned, 'STABLE_REPAIR')
          );
        },
        executeMaven: () => this.executeMaven(
          input.task,
          input.context,
          owned,
          'pruned_method_candidate',
          input.signal
        ),
        saveCheckpoint: async (stableRepair) => {
          checkpoint = await this.options.checkpoints.saveWaveCandidate(
            input.task.id,
            {
              ...updateWaveCandidateCheckpoint(
                checkpoint,
                owned,
                stableRepair.phase === 'BLOCKED' ? 'BLOCKED' : 'STABLE_REPAIR'
              ),
              stableRepair: {
                phase: stableRepair.phase,
                iteration: stableRepair.iteration,
                annotatedMemberIds: [...stableRepair.annotatedMemberIds]
              }
            }
          );
        }
      });
      if (result.status === 'external_project_blocked') {
        throw new Error(
          'Stable repair stopped because Maven failure is outside the generated candidate.'
        );
      }
      return {
        owned,
        execution: result.execution,
        candidateCheckpoint: checkpoint,
        retainedEmpty: result.status === 'retained_empty'
      };
    }, input.signal);
  }

  async execute(
    task: ClassTaskSnapshot,
    methodId: string,
    checkpoint: MethodExecutionCheckpoint,
    signal: AbortSignal,
    executionOptions: SingleMethodGenerationExecutionOptions = {}
  ): Promise<MethodTestBundle | null> {
    const generated = await this.generateBatches(
      task,
      methodId,
      checkpoint,
      signal,
      executionOptions
    );
    if (!generated) return null;
    return {
      ...this.options.merger.merge(methodId, generated.batches),
      methodName: generated.methodName,
      displaySignature: generated.displaySignature,
      jacocoOrder: generated.jacocoOrder
    };
  }

  async generateBatches(
    task: ClassTaskSnapshot,
    methodId: string,
    checkpoint: MethodExecutionCheckpoint,
    signal: AbortSignal,
    executionOptions: SingleMethodGenerationExecutionOptions = {}
  ): Promise<GeneratedMethodBatches | null> {
    throwIfAborted(signal);
    const temporaryBatchIndexOffset = requireTemporaryBatchIndexOffset(
      executionOptions.temporaryBatchIndexOffset
    );
    const context = await this.options.contextProvider.resolve(task, signal);
    const analysisHeartbeat = this.startAnalysisHeartbeat(
      context.analysisSessionId,
      signal
    );
    try {
    const completedTestMethodPlanIds = [
      ...checkpoint.completedTestMethodPlanIds
    ];
    const completedBatchIds = new Set(
      checkpoint.completedBatches.map((batch) => batch.batchId)
    );
    const retainedBatches = await this.restorePassingBatches(
      task,
      methodId,
      context,
      checkpoint,
      signal,
      temporaryBatchIndexOffset
    );
    let unformalizableDropped = checkpoint.completedBatches.some(
      (batch) => batch.outcome === 'DROPPED'
    );
    let methodResultIdentity: Pick<
      Required<MethodTestBundle>,
      'methodName' | 'displaySignature' | 'jacocoOrder'
    > | null = null;
    let batchIndex = checkpoint.completedBatches.length + 1;
    let pendingRecovery = checkpoint.inProgressBatch
      ? structuredClone(checkpoint.inProgressBatch)
      : null;
    if (pendingRecovery && pendingRecovery.sourceSha256 !== context.sourceSha256) {
      await this.discardStaleInProgressBatch(task, pendingRecovery);
      pendingRecovery = null;
    }

    while (true) {
      throwIfAborted(signal);
      let recovery = pendingRecovery;
      const page = recovery
        ? recovery.startRequest.batch
        : await this.atomic(task.id, 'ANALYZE_METHOD', () => (
          this.options.analyzer.nextMethodBatch(
            context.analysisSessionId,
            methodId,
            {
              reportPairId: context.reportPairId,
              completedTestMethodPlanIds: [...completedTestMethodPlanIds],
              maxTestMethods: MAX_SINGLE_METHOD_BATCH_TEST_METHODS
            },
            signal
          )
        ));
      if (!page.hasWork) break;
      if ('methodSlices' in page) {
        throw new Error('Legacy single-method batch recovery cannot contain a class Part.');
      }
      validatePage(
        page,
        methodId,
        recovery ? page.reportPairId : context.reportPairId,
        completedTestMethodPlanIds,
        completedBatchIds
      );
      methodResultIdentity ??= {
        methodName: page.method.methodName,
        displaySignature: displayMethodSignature(page),
        jacocoOrder: this.methodJacocoOrder(context, methodId)
      };

      const outputTestClassName = `${basename(
        task.sourceFilePath,
        '.java'
      )}Tmp${temporaryBatchIndexOffset + batchIndex}Test`;
      const onProgress = this.progressLogger(task, page, batchIndex);
      const startRequest: StartMethodGenerationSessionRequest = recovery
        ? recovery.startRequest
        : {
            clientRequestId: this.randomUUID(),
            classTaskId: task.id,
            methodId,
            batchId: page.batchId,
            batchIndex,
            outputTestClassName,
            expectedPackageName: context.packageName,
            buildToolchain: context.buildToolchain,
            batch: page,
            captureModelCalls: context.captureModelCalls,
            repairAttemptLimit: task.repairAttemptLimit,
            unlimitedRepair: task.unlimitedRepair,
            ...(context.ragContext ? { ragContext: context.ragContext } : {})
          };
      if (!recovery) {
        recovery = await this.recoverLegacyInProgressBatch(
          task,
          methodId,
          context,
          startRequest,
          page,
          outputTestClassName
        );
      }
      if (recovery) {
        validateRecoveryCheckpoint(
          recovery,
          task,
          methodId,
          context,
          page,
          outputTestClassName,
          batchIndex
        );
      }
      const recoveredOwned = recovery
        ? await this.loadInProgressCandidate(task, context, recovery, outputTestClassName)
        : null;
      const started = await this.atomic(task.id, recovery ? 'MODEL_REPAIR' : 'MODEL_GENERATION', () => (
        recovery
          ? this.options.agent.recoverMethodGenerationStream(
              {
                startRequest,
                candidate: recovery.candidate
              } satisfies RecoverMethodGenerationSessionRequest,
              context.modelContext,
              onProgress,
              signal
            )
          : this.options.agent.startMethodGenerationStream(
              startRequest,
              context.modelContext,
              onProgress,
              signal
            )
      ));
      if (started.kind !== 'candidate_ready') {
        await this.recordCompletionUsage(task.id, started.completion);
        throw new Error('Method generation completed without a candidate.');
      }
      pendingRecovery = null;

      const sessionId = started.sessionId;
      let eventSequence = started.eventSequence;
      let candidate = started.candidate;
      let previousCandidateVersion: number | null = recovery
        ? recovery.candidate.candidateVersion - 1
        : null;
      let owned: OwnedCandidateFile | null = recoveredOwned;
      let checkpointCandidate: MethodCandidate | null = recovery?.candidate ?? null;
      let reuseRecoveredCandidate = recovery !== null;
      let acceptedCode: string | null = null;
      let acceptedHash: string | null = null;
      let latestExecution: CandidateExecutionFeedback | null = null;
      let latestDiagnostic: MavenRepairDiagnostic | null = null;
      let latestRepairContext: MethodGenerationRepairContext | null = null;
      let latestMavenDurationMs: number | null = null;
      let latestAnalyzerDurationMs: number | null = null;
      let verified: VerifiedMethodBatch | null = null;
      let formalizableDropped: VerifiedMethodBatch | null = null;
      let retainedDropped: OwnedCandidateFile | null = null;
      let finalExecution: CandidateExecutionFeedback | null = null;
      let sessionTerminal = false;
      let batchCommitted = false;

      try {
        while (true) {
          validateCandidate(
            candidate,
            page,
            outputTestClassName,
            batchIndex,
            previousCandidateVersion,
            task.unlimitedRepair ? null : task.repairAttemptLimit,
            context.packageName,
            this.structure
          );
          previousCandidateVersion = candidate.candidateVersion;

          let effectiveCandidate = candidate;
          const codeWithAnalyzerImports = restoreReferencedAllowedTypeImports({
            candidateCode: effectiveCandidate.testCode,
            allowedImports: page.necessaryImports
          });
          if (codeWithAnalyzerImports !== effectiveCandidate.testCode) {
            effectiveCandidate = {
              ...effectiveCandidate,
              testCode: codeWithAnalyzerImports,
              generatedCodeSha256: sha256(codeWithAnalyzerImports)
            };
          }

          if (!context.ragContext && acceptedCode !== null) {
            if (!acceptedHash || !latestExecution || !latestDiagnostic || !latestRepairContext) {
              throw new Error('No-RAG repair candidate has no accepted Maven repair baseline.');
            }
            const effectiveCode = preserveAcceptedWildcardImports({
              acceptedCode,
              candidateCode: candidate.testCode,
              diagnostic: latestDiagnostic
            });
            if (effectiveCode !== candidate.testCode) {
              effectiveCandidate = {
                ...candidate,
                testCode: effectiveCode,
                generatedCodeSha256: sha256(effectiveCode)
              };
            }
            const validation = this.candidateChanges.validate({
              acceptedCode,
              candidateCode: effectiveCandidate.testCode,
              diagnostic: latestDiagnostic,
              allowedImports: [
                ...page.necessaryImports,
                ...STANDARD_TEST_REPAIR_IMPORTS
              ]
            });
            if (!validation.accepted) {
              const rejected = await this.resumeRejectedCandidate(
                task,
                context,
                page,
                sessionId,
                eventSequence,
                effectiveCandidate,
                acceptedCode,
                acceptedHash,
                latestExecution,
                latestRepairContext,
                validation,
                onProgress,
                signal
              );
              await this.recordRepairTelemetry(
                task,
                page,
                candidate,
                latestDiagnostic,
                latestRepairContext,
                validation.violationCodes,
                latestMavenDurationMs,
                latestAnalyzerDurationMs
              );
              eventSequence = rejected.eventSequence;
              sessionTerminal = rejected.kind === 'completed';
              if (rejected.kind === 'completed') {
                await this.recordCompletionUsage(task.id, rejected.completion);
              }
              if (rejected.kind === 'candidate_ready') {
                if (!this.canRepairAgain(task, candidate)) {
                  throw new Error('Agent returned another repair after the configured limit.');
                }
                candidate = rejected.candidate;
                continue;
              }
              this.requireRepairExhausted(rejected);
              await this.options.agent.acknowledgeMethodGenerationEvents(
                sessionId,
                eventSequence,
                signal
              );
              if (!owned || !latestExecution) {
                throw new Error('Repair exhaustion has no accepted Maven candidate.');
              }
              const disposition = await this.options.moduleLock.runExclusive(
                task.moduleKey,
                () => this.commentFailedTestsAfterExhaustion(
                  task,
                  context,
                  page,
                  owned as OwnedCandidateFile,
                  latestExecution as CandidateExecutionFeedback,
                  async (retained) => {
                    owned = retained;
                    checkpointCandidate = await this.saveInProgressCandidate(
                      task,
                      methodId,
                      context,
                      startRequest,
                      checkpointCandidate ?? candidate,
                      retained
                    );
                  },
                  signal
                ),
                signal
              );
              owned = disposition.retained;
              verified = disposition.verified;
              formalizableDropped = disposition.formalizable;
              retainedDropped = verified ? null : disposition.retained;
              break;
            }
          }

          const attempt = await this.options.moduleLock.runExclusive(
            task.moduleKey,
            async () => {
              throwIfAborted(signal);
              if (
                !reuseRecoveredCandidate
                || !owned
                || owned.code !== effectiveCandidate.testCode
                || owned.sha256 !== effectiveCandidate.generatedCodeSha256
              ) {
                owned = await this.writeCandidate(
                  task,
                  context,
                  effectiveCandidate,
                  owned
                );
              }
              reuseRecoveredCandidate = false;
              checkpointCandidate = await this.saveInProgressCandidate(
                task,
                methodId,
                context,
                startRequest,
                effectiveCandidate,
                owned
              );
              let execution: CandidateExecutionFeedback;
              let mavenDurationMs = 0;
              const executedHashes = new Set<string>();
              while (true) {
                executedHashes.add(owned.sha256);
                const mavenStartedAt = performance.now();
                execution = await this.executeMaven(
                  task,
                  context,
                  owned,
                  'method_candidate',
                  signal
                );
                mavenDurationMs += elapsedMilliseconds(mavenStartedAt);
                if (execution.status === 'passed' || context.ragContext) break;

                const diagnostic = this.diagnostic.normalize({
                  execution,
                  generatedTestFilePath: owned.filePath,
                  generatedTestClassName: qualifiedName(
                    context.packageName,
                    owned.testClassName
                  ),
                  targetProductionClassName: task.qualifiedClassName,
                  targetProductionFilePath: task.sourceFilePath
                });
                const deterministic = applyDeterministicUnreportedExceptionRepair({
                  code: owned.code,
                  candidateFilePath: owned.filePath,
                  diagnostic,
                  structure: this.structure
                });
                if (!deterministic.applied) break;
                const deterministicHash = sha256(deterministic.code);
                if (executedHashes.has(deterministicHash)) break;
                effectiveCandidate = {
                  ...effectiveCandidate,
                  testCode: deterministic.code,
                  generatedCodeSha256: deterministicHash
                };
                owned = await this.writeCandidate(
                  task,
                  context,
                  effectiveCandidate,
                  owned
                );
                checkpointCandidate = await this.saveInProgressCandidate(
                  task,
                  methodId,
                  context,
                  startRequest,
                  effectiveCandidate,
                  owned
                );
              }
              return {
                owned,
                execution,
                mavenDurationMs
              };
            },
            signal
          );
          owned = attempt.owned;
          finalExecution = attempt.execution;
          acceptedCode = owned.code;
          acceptedHash = owned.sha256;

          let ragRepairAttempt: RagRepairAttemptContext | null = null;
          if (finalExecution.status !== 'passed') {
            latestMavenDurationMs = attempt.mavenDurationMs;
            latestExecution = finalExecution;
            latestDiagnostic = this.diagnostic.normalize({
              execution: finalExecution,
              generatedTestFilePath: owned.filePath,
              generatedTestClassName: qualifiedName(
                context.packageName,
                owned.testClassName
              ),
              targetProductionClassName: task.qualifiedClassName,
              targetProductionFilePath: task.sourceFilePath
            });
            const analyzerStartedAt = performance.now();
            latestRepairContext = await this.resolveRepairContext(
              context,
              page,
              latestDiagnostic,
              owned.code,
              signal
            );
            latestAnalyzerDurationMs = elapsedMilliseconds(analyzerStartedAt);
            if (context.ragContext) {
              ragRepairAttempt = await this.prepareRagRepairAttempt(
                context,
                page,
                sessionId,
                eventSequence,
                candidate,
                owned,
                finalExecution,
                latestRepairContext,
                signal
              );
            }
          }

          const resumeRequest: ResumeMethodGenerationSessionRequest = {
            feedbackId: this.randomUUID(),
            expectedEventSequence: eventSequence,
            candidateId: candidate.candidateId,
            candidateVersion: candidate.candidateVersion,
            repairAttempt: candidate.repairAttempt,
            effectiveTestCode: owned.code,
            effectiveFileSha256: owned.sha256,
            feedbackKind: 'execution',
            execution: finalExecution,
            ...(finalExecution.status !== 'passed'
              && !ragRepairAttempt
              && latestRepairContext
              ? { repairContext: latestRepairContext }
              : {}),
            ...(ragRepairAttempt && context.ragEmbeddingConfig
              ? {
                  ragRepairAttempt,
                  ragEmbeddingConfig: context.ragEmbeddingConfig
                }
              : {})
          };
          const resumed = await this.atomic(task.id, finalExecution.status === 'passed' ? 'CONFIRM_RESULT' : 'MODEL_REPAIR', () => (
            this.options.agent.resumeMethodGenerationStream(
              sessionId,
              resumeRequest,
              context.modelContext,
              onProgress,
              signal
            )
          ));
          if (finalExecution.status !== 'passed'
            && !ragRepairAttempt && latestDiagnostic && latestRepairContext) {
            await this.recordRepairTelemetry(
              task,
              page,
              candidate,
              latestDiagnostic,
              latestRepairContext,
              [],
              latestMavenDurationMs,
              latestAnalyzerDurationMs
            );
          }
          eventSequence = resumed.eventSequence;
          sessionTerminal = resumed.kind === 'completed';
          if (resumed.kind === 'completed') {
            await this.recordCompletionUsage(task.id, resumed.completion);
          }

          if (finalExecution.status === 'passed') {
            if (
              resumed.kind !== 'completed'
              || resumed.completion.stopReason !== 'verified'
            ) {
              throw new Error('Agent did not acknowledge the verified candidate.');
            }
            verified = this.toVerifiedBatch(page, owned, finalExecution);
            await this.options.agent.acknowledgeMethodGenerationEvents(
              sessionId,
              eventSequence,
              signal
            );
            break;
          }

          if (resumed.kind === 'candidate_ready') {
            if (!this.canRepairAgain(task, candidate)) {
              throw new Error('Agent returned another repair after the configured limit.');
            }
            candidate = resumed.candidate;
            continue;
          }

          this.requireRepairExhausted(resumed);
          await this.options.agent.acknowledgeMethodGenerationEvents(
            sessionId,
            eventSequence,
            signal
          );
          if (!owned || !finalExecution) {
            throw new Error('Repair exhaustion has no Maven candidate.');
          }
          const disposition = await this.options.moduleLock.runExclusive(
            task.moduleKey,
            () => this.commentFailedTestsAfterExhaustion(
              task,
              context,
              page,
              owned as OwnedCandidateFile,
              finalExecution as CandidateExecutionFeedback,
              async (retained) => {
                owned = retained;
                checkpointCandidate = await this.saveInProgressCandidate(
                  task,
                  methodId,
                  context,
                  startRequest,
                  checkpointCandidate ?? candidate,
                  retained
                );
              },
              signal
            ),
            signal
          );
          owned = disposition.retained;
          verified = disposition.verified;
          formalizableDropped = disposition.formalizable;
          retainedDropped = verified ? null : disposition.retained;
          break;
        }

        if (verified) retainedBatches.push(verified);
        else if (formalizableDropped) retainedBatches.push(formalizableDropped);
        else unformalizableDropped = true;
        const completedIds = page.methodTestPlan.testMethodPlans.map(
          (plan) => plan.testMethodPlanId
        );
        completedTestMethodPlanIds.push(...completedIds);
        const checkpointFile = verified ?? retainedDropped;
        if (checkpointFile) {
          checkpointCandidate = await this.saveInProgressCandidate(
            task,
            methodId,
            context,
            startRequest,
            checkpointCandidate ?? candidate,
            {
              filePath: checkpointFile.filePath,
              relativePath: relative(task.workspaceRoot, checkpointFile.filePath)
                .replaceAll('\\', '/'),
              testClassName: outputTestClassName,
              code: checkpointFile.code,
              sha256: checkpointFile.sha256
            }
          );
        } else {
          await this.options.checkpoints.clearInProgressBatch(
            task.id,
            methodId,
            page.batchId
          );
        }
        await this.options.checkpoints.commitBatch({
          taskId: task.id,
          methodId,
          batchId: page.batchId,
          batchIndex,
          completedTestMethodPlanIds: [...completedTestMethodPlanIds],
          outcome: verified
            ? 'PASSED'
            : formalizableDropped
              ? 'RETAINED'
              : 'DROPPED',
          candidateVersion: checkpointCandidate?.candidateVersion
            ?? candidate.candidateVersion,
          tmpFilePath: checkpointFile?.filePath ?? null,
          tmpFileSha256: checkpointFile?.sha256 ?? null,
          ordinaryTestMethodCount: verified?.ordinaryTestMethodCount ?? 0
        });
        batchCommitted = true;
        owned = null;
        if (unformalizableDropped) {
          throw new Error(
            'Method repair exhausted without a safely retained formal test result.'
          );
        }
      } catch (error) {
        if (
          isClassTaskApplicationInterruptedError(error)
          || isClassTaskApplicationInterruptedError(signal.reason)
        ) {
          throw error;
        }
        if (
          isClassTaskPauseRequestedError(error)
          || isClassTaskPauseRequestedError(signal.reason)
        ) {
          if (!sessionTerminal) {
            this.cancelAgentSessionInBackground(task.id, sessionId);
          }
          throw error;
        }
        if (error instanceof ClassTaskPausedAtBoundaryError) {
          if (!sessionTerminal) {
            this.cancelAgentSessionInBackground(task.id, sessionId);
          }
          throw error;
        }
        const rollbackError = !batchCommitted && owned
          ? await this.rollbackOwnedCandidate(task, owned)
          : null;
        let checkpointCleanupError: unknown | null = null;
        if (!batchCommitted && !rollbackError) {
          try {
            await this.options.checkpoints.clearInProgressBatch(
              task.id,
              methodId,
              page.batchId
            );
          } catch (cleanupError) {
            checkpointCleanupError = cleanupError;
          }
        }
        if (!sessionTerminal) {
          await this.cancelAgentSession(task.id, sessionId);
        }
        if (rollbackError || checkpointCleanupError) {
          throw new AggregateError(
            [error, rollbackError, checkpointCleanupError].filter(Boolean),
            'Single-method generation failed and its uncommitted TMP file could not be rolled back.'
          );
        }
        throw error;
      }
      completedBatchIds.add(page.batchId);
      batchIndex += 1;
    }

    if (unformalizableDropped) {
      throw new Error(
        'Method repair exhausted without a safely retained formal test result.'
      );
    }
    if (retainedBatches.length === 0) {
      if (completedBatchIds.size > 0) {
        throw new Error(
          'Method repair exhausted without a safely retained formal test result.'
        );
      }
      return null;
    }
    const identity = methodResultIdentity ?? this.methodIdentityFromContext(context, methodId);
    return {
      methodId,
      ...identity,
      batches: retainedBatches
    };
    } finally {
      await analysisHeartbeat.stop();
    }
  }

  async restoreGeneratedBatches(
    task: ClassTaskSnapshot,
    methodId: string,
    checkpoint: MethodExecutionCheckpoint,
    signal: AbortSignal,
    executionOptions: SingleMethodGenerationExecutionOptions = {}
  ): Promise<GeneratedMethodBatches | null> {
    throwIfAborted(signal);
    if (checkpoint.completedBatches.some((batch) => batch.outcome === 'DROPPED')) {
      throw new Error(
        'Method repair exhausted without a safely retained formal test result.'
      );
    }
    const temporaryBatchIndexOffset = requireTemporaryBatchIndexOffset(
      executionOptions.temporaryBatchIndexOffset
    );
    const context = await this.options.contextProvider.resolve(task, signal);
    const batches = await this.restorePassingBatches(
      task,
      methodId,
      context,
      checkpoint,
      signal,
      temporaryBatchIndexOffset
    );
    if (batches.length === 0) return null;
    return {
      methodId,
      ...this.methodIdentityFromContext(context, methodId),
      batches
    };
  }

  private startAnalysisHeartbeat(
    sessionId: string,
    signal: AbortSignal
  ): { stop(): Promise<void> } {
    let stopped = false;
    let inFlight: Promise<void> | null = null;
    const tick = (): void => {
      if (stopped || signal.aborted || inFlight) return;
      inFlight = this.options.analyzer
        .heartbeatMethodAnalysisSession(sessionId, signal)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
    };
    const timer = setInterval(tick, this.analysisHeartbeatIntervalMs);
    timer.unref();
    const stopTimer = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
    signal.addEventListener('abort', stopTimer, { once: true });
    return {
      stop: async () => {
        stopTimer();
        signal.removeEventListener('abort', stopTimer);
        await inFlight;
      }
    };
  }

  private methodJacocoOrder(
    context: SingleMethodGenerationContext,
    methodId: string
  ): number {
    return this.methodIdentityFromContext(context, methodId).jacocoOrder;
  }

  private methodIdentityFromContext(
    context: SingleMethodGenerationContext,
    methodId: string
  ): Pick<Required<MethodTestBundle>, 'methodName' | 'displaySignature' | 'jacocoOrder'> {
    const method = context.methodCatalog?.find((candidate) => candidate.methodId === methodId);
    if (!method) {
      return { methodName: '未知方法', displaySignature: '未知方法', jacocoOrder: 0 };
    }
    return {
      methodName: method.methodName,
      displaySignature: method.displaySignature,
      jacocoOrder: method.jacocoOrder
    };
  }

  private classWaveBundles(
    wave: ClassScenarioWorkWave,
    acceptedPartIndexes: ReadonlySet<number>,
    code: string,
    methods: ReturnType<JavaTestStructureService['findTestMethods']>,
    context: SingleMethodGenerationContext,
    sourceBatchIds: string[],
    waveState: Awaited<ReturnType<ClassTaskCheckpointService['taskWaveProgress']>>,
    fallbackWaveIndex: number
  ): MethodTestBundle[] {
    const prefixes = classWaveMethodPrefixes(wave);
    const acceptedMethodIds = new Set(
      wave.parts
        .filter((part) => acceptedPartIndexes.has(part.partIndex))
        .flatMap((part) => part.methodSlices.map((slice) => slice.methodId))
    );
    if (methods.some((method) => (
      ![...prefixes.values()].some((prefix) => method.name.startsWith(prefix))
    ))) {
      throw new Error('Class Wave candidate contains test methods without a source-method prefix.');
    }
    return wave.selectedMethodIds.flatMap((methodId) => {
      if (!acceptedMethodIds.has(methodId)) return [];
      const prefix = prefixes.get(methodId);
      if (!prefix) throw new Error('Class Wave selected method has no stable test prefix.');
      const methodsForSource = methods.filter((method) => method.name.startsWith(prefix));
      return [{
        methodId,
        sourceMethodId: methodId,
        waveIndex: waveState.methods[methodId]?.nextWaveIndex
          ?? (methodId === wave.methodId ? fallbackWaveIndex : 1),
        hasRemainingScenarios: (wave.remainingScenarioCountByMethod[methodId] ?? 0) > 0,
        ...this.methodIdentityFromContext(context, methodId),
        code,
        ordinaryTestMethodCount: methodsForSource.length,
        passedTestMethods: methodsForSource.map((method) => method.name),
        sourceBatchIds: [...sourceBatchIds]
      } satisfies MethodTestBundle];
    });
  }

  private async restorePassingBatches(
    task: ClassTaskSnapshot,
    methodId: string,
    context: SingleMethodGenerationContext,
    checkpoint: MethodExecutionCheckpoint,
    signal: AbortSignal,
    temporaryBatchIndexOffset = 0
  ): Promise<VerifiedMethodBatch[]> {
    const restored: VerifiedMethodBatch[] = [];
    for (let index = 0; index < checkpoint.completedBatches.length; index += 1) {
      const batch = checkpoint.completedBatches[index];
      throwIfAborted(signal);
      if (batch.outcome === 'DROPPED') continue;
      const expectedClassName = `${basename(
        task.sourceFilePath,
        '.java'
      )}Tmp${temporaryBatchIndexOffset + batch.batchIndex}Test`;
      const expectedFilePath = resolve(
        dirname(resolve(task.workspaceRoot, context.plannedRelativeTestPath)),
        `${expectedClassName}.java`
      );
      if (!batch.tmpFilePath || !batch.tmpFileSha256) {
        throw new Error('Completed method batch checkpoint has no owned TMP file.');
      }
      if (
        batch.taskId !== task.id
        || batch.methodId !== methodId
        || batch.batchIndex !== index + 1
        || (batch.outcome === 'PASSED' && batch.ordinaryTestMethodCount < 1)
        || (batch.outcome === 'RETAINED' && batch.ordinaryTestMethodCount !== 0)
        || !sameFilePath(batch.tmpFilePath, expectedFilePath)
      ) {
        throw new Error('Completed method batch checkpoint TMP identity is invalid.');
      }
      const code = await this.options.writer.loadOwnedGeneratedTest({
        workspaceRoot: task.workspaceRoot,
        filePath: batch.tmpFilePath,
        expectedSha256: batch.tmpFileSha256
      });
      const methods = validateEffectiveCode(
        code,
        expectedClassName,
        context.packageName,
        this.structure
      );
      if (batch.outcome === 'RETAINED' && (
        methods.length !== 0
        || !code.includes(FAILED_TEST_REPAIR_TODO_COMMENT)
      )) {
        continue;
      }
      if (methods.length !== batch.ordinaryTestMethodCount) {
        throw new Error('Completed method batch checkpoint test count changed.');
      }
      restored.push({
        batchId: batch.batchId,
        filePath: batch.tmpFilePath,
        sha256: batch.tmpFileSha256,
        code,
        ordinaryTestMethodCount: methods.length,
        passedTestMethods: methods.map((method) => method.name)
      });
    }
    return restored;
  }

  private canRepairAgain(
    task: ClassTaskSnapshot,
    candidate: MethodCandidate
  ): boolean {
    return task.unlimitedRepair
      || candidate.repairAttempt < (task.repairAttemptLimit as number);
  }

  private requireRepairExhausted(
    result: Awaited<ReturnType<AiClient['resumeMethodGenerationStream']>>
  ): void {
    if (
      result.kind !== 'completed'
      || result.completion.stopReason !== 'repair_exhausted'
    ) {
      throw new Error('Agent repair exhaustion response is invalid.');
    }
  }

  private async resumeRejectedCandidate(
    _task: ClassTaskSnapshot,
    context: SingleMethodGenerationContext,
    _page: SingleMethodWorkBatch | ClassScenarioWorkBatch,
    sessionId: string,
    eventSequence: number,
    candidate: MethodCandidate,
    acceptedCode: string,
    acceptedHash: string,
    execution: CandidateExecutionFeedback,
    repairContext: MethodGenerationRepairContext,
    rejection: Extract<CandidateChangeValidationResult, { accepted: false }>,
    onProgress: MethodGenerationProgressHandler,
    signal: AbortSignal
  ): ReturnType<AiClient['resumeMethodGenerationStream']> {
    const request: ResumeMethodGenerationSessionRequest = {
      feedbackId: this.randomUUID(),
      expectedEventSequence: eventSequence,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      repairAttempt: candidate.repairAttempt,
      effectiveTestCode: candidate.testCode,
      effectiveFileSha256: candidate.generatedCodeSha256,
      feedbackKind: 'candidate_rejected',
      execution,
      repairContext,
      candidateRejection: {
        acceptedTestCode: acceptedCode,
        acceptedFileSha256: acceptedHash,
        violationCodes: [...rejection.violationCodes],
        memberNames: [...rejection.memberNames],
        message: rejection.message
      }
    };
    return this.atomic(_task.id, 'MODEL_REPAIR', () => (
      this.options.agent.resumeMethodGenerationStream(
        sessionId,
        request,
        context.modelContext,
        onProgress,
        signal
      )
    ));
  }

  private async resolveRepairContext(
    context: SingleMethodGenerationContext,
    page: SingleMethodWorkBatch | ClassScenarioWorkBatch,
    diagnostic: MavenRepairDiagnostic,
    effectiveTestCode: string,
    signal: AbortSignal
  ): Promise<MethodGenerationRepairContext> {
    const sourcePages = repairSourceBatches(
      page,
      diagnostic,
      effectiveTestCode,
      this.structure
    );
    const resolved: Array<{
      sourcePage: SingleMethodWorkBatch;
      analyzer: MethodRepairContextResponse | null;
      error: unknown | null;
    }> = [];
    // Analyzer repair-context work is intentionally sequential. A class Part can
    // involve several production methods, and concurrent AST/type expansion for
    // all of them can amplify memory pressure in java-analyzer.
    for (const sourcePage of sourcePages) {
      try {
        const analyzer = await this.options.analyzer.getMethodRepairContext(
          context.analysisSessionId,
          {
            reportPairId: context.reportPairId,
            methodId: sourcePage.methodId,
            currentClassFrames: diagnostic.productionFrames.map((frame) => ({
              ownerFqn: frame.ownerFqn,
              methodName: frame.methodName,
              descriptor: null,
              sourceLine: frame.sourceLine
            })),
            relatedTypeFqns: [...diagnostic.relatedTypeFqns],
            missingSymbols: [...diagnostic.missingSymbols]
          },
          signal
        );
        resolved.push({ sourcePage, analyzer, error: null });
      } catch (error) {
        throwIfAborted(signal);
        resolved.push({ sourcePage, analyzer: null, error });
      }
    }
    return mergeRepairContexts(
      diagnostic,
      context.sourceSha256,
      resolved
    );
  }

  private async prepareRagRepairAttempt(
    context: SingleMethodGenerationContext,
    page: SingleMethodWorkBatch | ClassScenarioWorkBatch,
    sessionId: string,
    eventSequence: number,
    candidate: MethodCandidate,
    owned: OwnedCandidateFile,
    execution: CandidateExecutionFeedback,
    repairContext: MethodGenerationRepairContext | null,
    signal: AbortSignal
  ): Promise<RagRepairAttemptContext | null> {
    try {
      const prepared = await this.options.agent.prepareRagRepair(
        sessionId,
        {
          expectedEventSequence: eventSequence,
          candidateId: candidate.candidateId,
          candidateVersion: candidate.candidateVersion,
          repairAttempt: candidate.repairAttempt,
          // This field identifies the pending candidate session. The production
          // methods involved in the failure are carried by repairContext.
          methodId: candidate.methodId,
          batchId: page.batchId,
          batchIndex: candidate.batchIndex,
          effectiveTestCode: owned.code,
          effectiveFileSha256: owned.sha256,
          execution,
          ...(repairContext ? { repairContext } : {})
        },
        signal
      );
      if (prepared.status !== 'attributable') return null;
      const coordinator = this.options.ragIndexCoordinator;
      const subscription = context.ragSubscription;
      if (!coordinator || !subscription || !context.ragEmbeddingConfig) return null;
      const refreshed = await waitForRagIndexRefresh(
        (refreshSignal) => coordinator.refresh(
          subscription,
          prepared.requestedFqns,
          refreshSignal,
          prepared.requestedMethods ?? []
        ),
        this.ragIndexRefreshWaitMilliseconds,
        signal
      );
      const activeIndex = context.ragContext?.activeIndex;
      if (
        (refreshed.status !== 'published' && refreshed.status !== 'reused')
        || refreshed.vectorStatus !== 'ready'
        || !activeIndex
      ) return null;
      return {
        diagnosticFingerprint: prepared.diagnosticFingerprint,
        activeIndex: {
          ...activeIndex,
          allowedFqns: [...activeIndex.allowedFqns]
        }
      };
    } catch {
      throwIfAborted(signal);
      return null;
    }
  }

  async nextClassWave(
    task: ClassTaskSnapshot,
    request: ClassScenarioWaveRequest,
    signal: AbortSignal
  ): Promise<ClassScenarioWaveResponse> {
    throwIfAborted(signal);
    const context = await this.options.contextProvider.resolve(task, signal);
    const currentRequest = request.reportPairId === context.reportPairId
      ? request
      : { ...request, reportPairId: context.reportPairId };
    return this.atomic(task.id, 'ANALYZE_METHOD', () => (
      this.options.analyzer.nextClassScenarioWave(
        context.analysisSessionId,
        currentRequest,
        signal
      )
    ));
  }

  private recordRepairTelemetry(
    task: ClassTaskSnapshot,
    page: SingleMethodWorkBatch | ClassScenarioWorkBatch,
    candidate: MethodCandidate,
    diagnostic: MavenRepairDiagnostic,
    repairContext: MethodGenerationRepairContext,
    scopeRejectionCodes: readonly string[],
    mavenDurationMs: number | null,
    analyzerDurationMs: number | null
  ): Promise<void> {
    const sourcePage = repairSourceBatches(page, diagnostic)[0]
      ?? primaryGenerationBatch(page);
    const record: MethodRepairTelemetryRecord = {
      taskId: task.id,
      className: task.qualifiedClassName.split('.').at(-1) ?? task.qualifiedClassName,
      qualifiedClassName: task.qualifiedClassName,
      methodId: sourcePage.methodId,
      methodName: sourcePage.method.methodName,
      descriptor: sourcePage.method.descriptor,
      batchId: page.batchId,
      batchIndex: candidate.batchIndex,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      repairAttempt: candidate.repairAttempt,
      candidateSha256: candidate.generatedCodeSha256,
      feedbackKind: scopeRejectionCodes.length > 0
        ? 'candidate_rejected'
        : 'execution',
      executionStatus: diagnostic.status,
      compilerErrorCount: diagnostic.compilerErrors.length,
      compilerCategories: [...new Set(
        diagnostic.compilerErrors.map((error) => error.category)
      )],
      affectedTestCount: diagnostic.affectedTestNames.length,
      exceptionCount: diagnostic.exceptions.length,
      generatedTestFrameCount: diagnostic.generatedTestFrames.length,
      productionFrameCount: diagnostic.productionFrames.length,
      missingSymbolCount: diagnostic.missingSymbols.length,
      relatedTypeCount: diagnostic.relatedTypeFqns.length,
      diagnosticTruncated: diagnostic.truncated,
      droppedItemCount: diagnostic.droppedItemCount,
      analyzerStatus: repairContext.analyzerStatus,
      analyzerWarningCount: repairContext.analyzerWarnings.length,
      scopeRejectionCodes: [...scopeRejectionCodes],
      mavenDurationMs,
      analyzerDurationMs,
      occurredAt: new Date().toISOString()
    };
    return this.options.logs.recordRepairTelemetry(record);
  }

  private async recoverLegacyInProgressBatch(
    task: ClassTaskSnapshot,
    methodId: string,
    context: SingleMethodGenerationContext,
    startRequest: StartMethodGenerationSessionRequest,
    page: SingleMethodWorkBatch,
    outputTestClassName: string
  ): Promise<InProgressMethodBatchCheckpoint | null> {
    const inspect = this.options.writer.inspectExistingMethodBatchTemporaryGeneratedTest;
    if (!inspect) return null;
    const existing = await inspect.call(this.options.writer, {
      workspaceRoot: task.workspaceRoot,
      targetFilePath: task.sourceFilePath,
      plannedRelativeTestPath: context.plannedRelativeTestPath,
      outputTestClassName
    });
    if (!existing) return null;

    let ordinaryTestMethodCount: number;
    try {
      ordinaryTestMethodCount = validateEffectiveCode(
        existing.content,
        outputTestClassName,
        context.packageName,
        this.structure
      ).length;
    } catch {
      throw new Error(
        `Existing method-batch TMP test file ${outputTestClassName}.java cannot be recovered safely.`
      );
    }
    if (ordinaryTestMethodCount !== page.plannedTestMethods) {
      throw new Error(
        `Existing method-batch TMP test file ${outputTestClassName}.java does not match the current method batch.`
      );
    }

    const candidate: MethodCandidate = {
      candidateId: this.randomUUID(),
      candidateVersion: 1,
      repairAttempt: 0,
      methodId,
      batchId: page.batchId,
      batchIndex: startRequest.batchIndex,
      testCode: existing.content,
      generatedCodeSha256: existing.sha256,
      outputTestClassName,
      ordinaryTestMethodCount,
      usage: null
    };
    const persistedCandidate = await this.saveInProgressCandidate(
      task,
      methodId,
      context,
      startRequest,
      candidate,
      {
        filePath: existing.testFilePath,
        relativePath: existing.relativePath,
        testClassName: existing.testClassName,
        code: existing.content,
        sha256: existing.sha256
      }
    );
    return {
      taskId: task.id,
      methodId,
      batchId: page.batchId,
      batchIndex: startRequest.batchIndex,
      sourceSha256: context.sourceSha256,
      startRequest,
      candidate: persistedCandidate,
      tmpFilePath: existing.testFilePath,
      tmpFileSha256: existing.sha256
    };
  }

  private async discardStaleInProgressBatch(
    task: ClassTaskSnapshot,
    checkpoint: InProgressMethodBatchCheckpoint
  ): Promise<void> {
    const rollbackError = await this.rollbackOwnedCandidate(task, {
      filePath: checkpoint.tmpFilePath,
      sha256: checkpoint.tmpFileSha256
    });
    if (rollbackError) {
      throw new AggregateError(
        [rollbackError],
        'Stale in-progress method candidate could not be removed safely.'
      );
    }
    await this.options.checkpoints.clearInProgressBatch(
      task.id,
      checkpoint.methodId,
      checkpoint.batchId
    );
  }

  private async loadInProgressCandidate(
    task: ClassTaskSnapshot,
    context: SingleMethodGenerationContext,
    checkpoint: InProgressMethodBatchCheckpoint,
    outputTestClassName: string
  ): Promise<OwnedCandidateFile> {
    const code = await this.options.writer.loadOwnedGeneratedTest({
      workspaceRoot: task.workspaceRoot,
      filePath: checkpoint.tmpFilePath,
      expectedSha256: checkpoint.tmpFileSha256
    });
    if (
      code !== checkpoint.candidate.testCode
      || sha256(code) !== checkpoint.tmpFileSha256
    ) {
      throw new Error('In-progress TMP candidate no longer matches its durable checkpoint.');
    }
    validateEffectiveCode(
      code,
      outputTestClassName,
      context.packageName,
      this.structure
    );
    return {
      filePath: checkpoint.tmpFilePath,
      relativePath: relative(task.workspaceRoot, checkpoint.tmpFilePath).replaceAll('\\', '/'),
      testClassName: outputTestClassName,
      code,
      sha256: checkpoint.tmpFileSha256
    };
  }

  private async saveInProgressCandidate(
    task: ClassTaskSnapshot,
    methodId: string,
    context: SingleMethodGenerationContext,
    startRequest: StartMethodGenerationSessionRequest,
    candidate: MethodCandidate,
    owned: OwnedCandidateFile
  ): Promise<MethodCandidate> {
    const persistedCandidate = {
      ...candidate,
      testCode: owned.code,
      generatedCodeSha256: owned.sha256
    };
    await this.options.checkpoints.saveInProgressBatch({
      taskId: task.id,
      methodId,
      batchId: startRequest.batchId,
      batchIndex: startRequest.batchIndex,
      sourceSha256: context.sourceSha256,
      startRequest,
      candidate: persistedCandidate,
      tmpFilePath: owned.filePath,
      tmpFileSha256: owned.sha256
    });
    return persistedCandidate;
  }

  private async writeCandidate(
    task: ClassTaskSnapshot,
    context: SingleMethodGenerationContext,
    candidate: MethodCandidate,
    current: OwnedCandidateFile | null
  ): Promise<OwnedCandidateFile> {
    return this.atomic(task.id, 'WRITE_CANDIDATE', async () => {
      if (!current) {
        const prepared = await this.options.writer
          .prepareMethodBatchTemporaryGeneratedTest({
            workspaceRoot: task.workspaceRoot,
            targetFilePath: task.sourceFilePath,
            plannedRelativeTestPath: context.plannedRelativeTestPath,
            outputTestClassName: candidate.outputTestClassName,
            content: candidate.testCode
          });
        const written = await this.options.writer.writePreparedGeneratedTest(prepared);
        return {
          filePath: written.testFilePath,
          relativePath: written.relativePath,
          testClassName: written.testClassName,
          code: prepared.content,
          sha256: written.sha256
        };
      }
      const replacement = this.options.writer.prepareReplacement({
        workspaceRoot: task.workspaceRoot,
        filePath: current.filePath,
        content: candidate.testCode
      });
      const written = await this.options.writer.replacePreparedGeneratedTest({
        workspaceRoot: task.workspaceRoot,
        filePath: current.filePath,
        expectedSha256: current.sha256,
        prepared: replacement
      });
      return {
        ...current,
        code: replacement.content,
        sha256: written.sha256
      };
    });
  }

  private async executeReadyWaveCandidate(input: {
    task: ClassTaskSnapshot;
    context: SingleMethodGenerationContext;
    wave: SingleMethodWorkWave;
    waveIndex: number;
    candidateId: string;
    owned: OwnedCandidateFile;
    checkpoint: WaveCandidateCheckpoint;
    projectFilePath: string;
    scope: 'method_candidate';
    signal: AbortSignal;
  }): Promise<{
    owned: OwnedCandidateFile;
    execution: CandidateExecutionFeedback;
    checkpoint: WaveCandidateCheckpoint;
  }> {
    const readyQueue = this.options.mavenReadyQueue;
    if (!readyQueue || !this.options.candidateFiles) {
      throw new Error('Wave Maven READY queue file transactions are unavailable.');
    }
    const environmentFingerprint = input.context.mavenEnvironmentFingerprint?.trim();
    if (!environmentFingerprint) {
      throw new Error('Wave Maven execution environment fingerprint is unavailable.');
    }
    const projectFilePath = resolve(input.projectFilePath);
    const isolationFilePath = waveCandidateIsolationPath(
      input.task,
      input.candidateId,
      input.owned.testClassName
    );
    let owned = input.owned;
    let checkpoint = input.checkpoint;
    const moveTo = async (
      targetPath: string,
      targetLocation: 'ISOLATED' | 'PROJECT'
    ): Promise<void> => {
      if (samePath(owned.filePath, targetPath)) return;
      const moved = await this.moveQueuedWaveCandidate({
        task: input.task,
        candidateId: input.candidateId,
        owned,
        checkpoint,
        targetPath,
        targetLocation,
        status: 'MAVEN_RUNNING'
      });
      owned = moved.owned;
      checkpoint = moved.checkpoint;
    };
    const qualifiedTestClassName = qualifiedName(
      input.context.packageName,
      owned.testClassName
    );
    const submission: ExecutableMavenReadyCandidate = {
      moduleKey: input.task.moduleKey,
      environmentFingerprint,
      taskId: input.task.id,
      candidateId: input.candidateId,
      moduleRoot: input.context.moduleRoot,
      buildSettings: input.context.buildSettings,
      scope: input.scope,
      filePath: projectFilePath,
      projectFilePath,
      isolationFilePath,
      qualifiedTestClassName,
      ...(input.context.excludedEnvironmentVariables
        ? { excludedEnvironmentVariables: input.context.excludedEnvironmentVariables }
        : {}),
      onBatchStart: async (batchId) => {
        checkpoint = await this.options.checkpoints.saveWaveCandidate(
          input.task.id,
          {
            ...updateWaveCandidateCheckpoint(checkpoint, owned, 'MAVEN_RUNNING'),
            lastMavenBatchId: batchId
          }
        );
      },
      onPhaseStart: (phase) => this.options.checkpoints.beginAtomicStep(
        input.task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST'
      ),
      onPhaseComplete: (phase) => this.options.checkpoints.completeAtomicStep(
        input.task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST'
      ),
      activate: () => moveTo(projectFilePath, 'PROJECT'),
      isolate: () => moveTo(isolationFilePath, 'ISOLATED')
    };
    throwIfAborted(input.signal);
    const result = await readyQueue.enqueue(submission);
    if (result.candidateId !== input.candidateId) {
      throw new Error('Maven READY queue returned a different candidate identity.');
    }
    if (result.trace) {
      const part = input.wave.parts[0];
      if (!part) throw new Error('Wave Maven logging requires method identity.');
      await this.options.logs.recordMavenBatch({
        taskId: input.task.id,
        className: input.task.qualifiedClassName.split('.').at(-1)
          ?? input.task.qualifiedClassName,
        qualifiedClassName: input.task.qualifiedClassName,
        methodId: input.wave.methodId,
        methodName: part.method.methodName,
        descriptor: part.method.descriptor,
        waveIndex: input.waveIndex,
        candidateId: input.candidateId,
        trace: result.trace
      });
    }
    if (result.status === 'unproven') {
      if (!samePath(owned.filePath, isolationFilePath)) {
        await this.options.moduleLock.runExclusive(
          input.task.moduleKey,
          () => moveTo(isolationFilePath, 'ISOLATED'),
          input.signal
        );
      }
      checkpoint = await this.options.checkpoints.saveWaveCandidate(
        input.task.id,
        updateWaveCandidateCheckpoint(checkpoint, owned, 'READY_FOR_MAVEN')
      );
      throw new Error(
        `Maven could not prove candidate ${input.candidateId}; no model repair was submitted.`
      );
    }
    const execution: CandidateExecutionFeedback = {
      status: result.status,
      mavenExecutions: result.mavenExecutions,
      ...(result.testReport ? { testReport: result.testReport } : {})
    };
    return { owned, execution, checkpoint };
  }

  private async moveQueuedWaveCandidate(input: {
    task: ClassTaskSnapshot;
    candidateId: string;
    owned: OwnedCandidateFile;
    checkpoint: WaveCandidateCheckpoint;
    targetPath: string;
    targetLocation: 'ISOLATED' | 'PROJECT';
    status: WaveCandidateCheckpoint['status'];
  }): Promise<{
    owned: OwnedCandidateFile;
    checkpoint: WaveCandidateCheckpoint;
  }> {
    const candidateFiles = this.options.candidateFiles;
    if (!candidateFiles) {
      throw new Error('Wave candidate file transactions are unavailable.');
    }
    const targetPath = resolve(input.targetPath);
    if (samePath(input.owned.filePath, targetPath)) {
      return { owned: input.owned, checkpoint: input.checkpoint };
    }
    const sourceLocation = input.checkpoint.managedFile
      && samePath(input.checkpoint.managedFile.path, input.owned.filePath)
      ? input.checkpoint.managedFile.location
      : input.targetLocation === 'PROJECT' ? 'ISOLATED' : 'PROJECT';
    let checkpoint = input.checkpoint;
    const transactions = await candidateFiles.moveWaveCandidateFiles({
      moves: [{
        candidateId: input.candidateId,
        workspaceRoot: input.task.workspaceRoot,
        testClassName: input.owned.testClassName,
        sourcePath: input.owned.filePath,
        targetPath,
        sha256: input.owned.sha256
      }],
      saveMoveTransactions: async (values) => {
        const transaction = requireCandidateMoveTransaction(values, input.candidateId);
        const moved = transaction.phase === 'MOVED';
        checkpoint = await this.options.checkpoints.saveWaveCandidate(
          input.task.id,
          {
            ...checkpoint,
            status: input.status,
            managedFile: {
              path: moved ? transaction.targetPath : transaction.sourcePath,
              sha256: transaction.sha256,
              location: moved ? input.targetLocation : sourceLocation
            },
            moveTransaction: {
              sourcePath: transaction.sourcePath,
              targetPath: transaction.targetPath,
              sha256: transaction.sha256,
              phase: transaction.phase
            }
          }
        );
      }
    });
    requireCandidateMoveTransaction(transactions, input.candidateId);
    const owned: OwnedCandidateFile = {
      ...input.owned,
      filePath: targetPath,
      relativePath: relative(input.task.workspaceRoot, targetPath).split(sep).join('/')
    };
    checkpoint = await this.options.checkpoints.saveWaveCandidate(
      input.task.id,
      {
        ...updateWaveCandidateCheckpoint(checkpoint, owned, input.status),
        managedFile: {
          path: targetPath,
          sha256: owned.sha256,
          location: input.targetLocation
        },
        moveTransaction: null
      }
    );
    return { owned, checkpoint };
  }

  private executeMaven(
    task: ClassTaskSnapshot,
    context: SingleMethodGenerationContext,
    owned: OwnedCandidateFile,
    scope: 'method_candidate' | 'pruned_method_candidate',
    signal: AbortSignal
  ): Promise<CandidateExecutionFeedback> {
    const qualifiedTestClassName = context.packageName
      ? `${context.packageName}.${owned.testClassName}`
      : owned.testClassName;
    return this.options.maven.execute({
      moduleRoot: context.moduleRoot,
      buildSettings: context.buildSettings,
      attemptId: this.randomUUID(),
      qualifiedTestClassName,
      scope,
      signal,
      ...(context.excludedEnvironmentVariables
        ? {
            excludedEnvironmentVariables:
              context.excludedEnvironmentVariables
          }
        : {}),
      onPhaseStart: (phase) => this.options.checkpoints.beginAtomicStep(
        task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST'
      ),
      onPhaseComplete: (phase) => this.options.checkpoints.completeAtomicStep(
        task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST'
      )
    });
  }

  private async commentFailedTestsAfterExhaustion(
    task: ClassTaskSnapshot,
    context: SingleMethodGenerationContext,
    page: SingleMethodWorkBatch,
    owned: OwnedCandidateFile,
    execution: CandidateExecutionFeedback,
    onCandidateChanged: (retained: OwnedCandidateFile) => Promise<void>,
    signal: AbortSignal
  ): Promise<ExhaustedCandidateDisposition> {
    let retained = owned;
    let latestExecution = execution;
    while (true) {
      const commented = await this.atomic(
        task.id,
        'PRUNE_FAILED_TESTS',
        async (): Promise<{
          retained: OwnedCandidateFile;
          activeTestMethodCount: number;
        } | null> => {
          const code = await this.options.writer.loadOwnedGeneratedTest({
            workspaceRoot: task.workspaceRoot,
            filePath: retained.filePath,
            expectedSha256: retained.sha256
          });
          const priorMethodCount = this.structure.findTestMethods(code).length;
          const result = this.options.pruner.prune({
            code,
            candidateFilePath: retained.filePath,
            execution: latestExecution
          });
          if (result.code === code) return null;
          let methods: ReturnType<JavaTestStructureService['findTestMethods']>;
          try {
            methods = validateEffectiveCode(
              result.code,
              retained.testClassName,
              context.packageName,
              this.structure
            );
          } catch {
            return null;
          }
          if (methods.length > priorMethodCount) return null;
          const replacement = this.options.writer.prepareReplacement({
            workspaceRoot: task.workspaceRoot,
            filePath: retained.filePath,
            content: result.code
          });
          const written = await this.options.writer.replacePreparedGeneratedTest({
            workspaceRoot: task.workspaceRoot,
            filePath: retained.filePath,
            expectedSha256: retained.sha256,
            prepared: replacement
          });
          return {
            retained: {
              ...retained,
              code: replacement.content,
              sha256: written.sha256
            },
            activeTestMethodCount: methods.length
          };
        }
      );
      if (!commented) {
        return { retained, verified: null, formalizable: null };
      }
      retained = commented.retained;
      await onCandidateChanged(retained);
      const reverified = await this.executeMaven(
        task,
        context,
        retained,
        'pruned_method_candidate',
        signal
      );
      if (commented.activeTestMethodCount === 0) {
        const compilePassed = reverified.mavenExecutions.some(
          (item) => item.phase === 'test_compile' && item.exitCode === 0
        );
        return {
          retained,
          verified: null,
          formalizable: compilePassed
            ? this.toRetainedBatch(page, retained)
            : null
        };
      }
      if (reverified.status === 'passed') {
        return {
          retained,
          verified: this.toVerifiedBatch(page, retained, reverified),
          formalizable: null
        };
      }
      latestExecution = reverified;
    }
  }

  private deleteOwnedCandidate(
    task: ClassTaskSnapshot,
    owned: Pick<OwnedCandidateFile, 'filePath' | 'sha256'>
  ): Promise<void> {
    return this.options.writer.deleteGeneratedTest({
      workspaceRoot: task.workspaceRoot,
      filePath: owned.filePath,
      expectedSha256: owned.sha256
    });
  }

  private async rollbackOwnedCandidate(
    task: ClassTaskSnapshot,
    owned: Pick<OwnedCandidateFile, 'filePath' | 'sha256'>
  ): Promise<unknown | null> {
    try {
      await this.options.moduleLock.runExclusive(
        task.moduleKey,
        () => this.deleteOwnedCandidate(task, owned)
      );
      return null;
    } catch (error) {
      return isMissingFileError(error) ? null : error;
    }
  }

  private cancelAgentSessionInBackground(taskId: string, sessionId: string): void {
    void this.cancelAgentSession(taskId, sessionId).catch(() => undefined);
  }

  private async cancelAgentSession(taskId: string, sessionId: string): Promise<void> {
    let status: Awaited<ReturnType<AiClient['cancelMethodGeneration']>>;
    try {
      status = await this.options.agent.cancelMethodGeneration(sessionId);
    } catch {
      // The Agent may already have expired or terminally failed this session.
      return;
    }
    if (status.completion) await this.recordCompletionUsage(taskId, status.completion);
  }

  private async recordCompletionUsage(
    taskId: string,
    completion: Pick<
      MethodGenerationCompletion,
      'aggregateUsage' | 'modelCallCount' | 'usageReportedCallCount'
    >
  ): Promise<void> {
    await this.options.checkpoints.addModelUsage(taskId, {
      tokenUsage: completion.aggregateUsage,
      modelCallCount: completion.modelCallCount,
      usageReportedCallCount: completion.usageReportedCallCount
    });
  }

  private toVerifiedBatch(
    page: SingleMethodWorkBatch,
    owned: OwnedCandidateFile,
    execution: CandidateExecutionFeedback
  ): VerifiedMethodBatch {
    if (execution.status !== 'passed' || !execution.testReport) {
      throw new Error('A verified method batch requires a passing Surefire report.');
    }
    const methods = this.structure.findTestMethods(owned.code);
    if (
      execution.testReport.generatedTests < methods.length
      || execution.testReport.generatedSkipped !== 0
    ) {
      throw new Error('Surefire did not execute every generated ordinary test method.');
    }
    return {
      batchId: page.batchId,
      filePath: owned.filePath,
      sha256: owned.sha256,
      code: owned.code,
      ordinaryTestMethodCount: methods.length,
      passedTestMethods: methods.map((method) => method.name)
    };
  }

  private toRetainedBatch(
    page: SingleMethodWorkBatch,
    owned: OwnedCandidateFile
  ): VerifiedMethodBatch {
    const methods = this.structure.findTestMethods(owned.code);
    if (methods.length !== 0) {
      throw new Error('A fully retained failed batch must have no active test methods.');
    }
    return {
      batchId: page.batchId,
      filePath: owned.filePath,
      sha256: owned.sha256,
      code: owned.code,
      ordinaryTestMethodCount: 0,
      passedTestMethods: []
    };
  }

  private progressLogger(
    task: ClassTaskSnapshot,
    page: SingleMethodWorkBatch | ClassScenarioWorkBatch,
    batchIndex: number
  ): MethodGenerationProgressHandler {
    return (event) => this.options.logs.record({
      taskId: task.id,
      className: task.qualifiedClassName.split('.').at(-1)
        ?? task.qualifiedClassName,
      qualifiedClassName: task.qualifiedClassName,
      methodId: page.methodId,
      methodName: primaryGenerationBatch(page).method.methodName,
      descriptor: primaryGenerationBatch(page).method.descriptor,
      displaySignature: displayGenerationBatchSignature(page),
      modifiers: primaryGenerationBatch(page).method.modifiers,
      batchId: page.batchId,
      batchIndex,
      event
    });
  }

  private recordWaveSummary(input: {
    task: ClassTaskSnapshot;
    wave: SingleMethodWorkWave | ClassScenarioWorkWave;
    waveIndex: number;
    activeWave: ActiveMethodWaveCheckpoint;
    skippedScenarioIds: ReadonlySet<string>;
    mergedCandidateId: string | null;
  }): Promise<void> {
    const firstPart = input.wave.parts[0];
    if (!firstPart) throw new Error('Wave summary requires method identity.');
    return this.options.logs.recordWaveSummary({
      taskId: input.task.id,
      className: input.task.qualifiedClassName.split('.').at(-1)
        ?? input.task.qualifiedClassName,
      qualifiedClassName: input.task.qualifiedClassName,
      methodId: input.wave.methodId,
      methodName: firstPart.method.methodName,
      descriptor: firstPart.method.descriptor,
      waveId: input.wave.waveBatchId,
      waveIndex: input.waveIndex,
      selectedScenarioIds: [...input.wave.selectedScenarioIds],
      skippedScenarioIds: input.wave.selectedScenarioIds.filter(
        (scenarioId) => input.skippedScenarioIds.has(scenarioId)
      ),
      parts: [...input.activeWave.parts]
        .sort((left, right) => left.partIndex - right.partIndex)
        .map((part) => ({
          partIndex: part.partIndex,
          partBatchId: part.partBatchId,
          scenarioIds: [...part.scenarioIds],
          status: part.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
          candidateId: part.candidateId
        })),
      mergedCandidateId: input.mergedCandidateId,
      occurredAt: new Date().toISOString()
    });
  }

  private async atomic<T>(
    taskId: string,
    step: Exclude<ClassTaskAtomicStep, 'IDLE'>,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.options.checkpoints.beginAtomicStep(taskId, step);
    try {
      return await operation();
    } finally {
      await this.options.checkpoints.completeAtomicStep(taskId, step);
    }
  }
}

function validateWaveExecutionIdentity(
  wave: SingleMethodWorkWave,
  checkpoint: ActiveMethodWaveCheckpoint
): void {
  if (
    checkpoint.waveId !== wave.waveBatchId
    || checkpoint.methodId !== wave.methodId
    || checkpoint.selectedScenarioIds.length !== wave.selectedScenarioIds.length
    || checkpoint.selectedScenarioIds.some(
      (scenarioId, index) => wave.selectedScenarioIds[index] !== scenarioId
    )
    || checkpoint.parts.length !== wave.parts.length
    || checkpoint.parts.some((part, index) => {
      const current = wave.parts[index];
      return !current
        || part.partIndex !== current.partIndex
        || part.partBatchId !== current.partBatchId
        || part.scenarioIds.length !== current.scenarioIds.length
        || part.scenarioIds.some(
          (scenarioId, scenarioIndex) => current.scenarioIds[scenarioIndex] !== scenarioId
        );
    })
  ) {
    throw new Error('Persisted Wave identity does not match Analyzer output.');
  }
}

function validatePublishedWaveRecoveryBundle(
  bundle: MethodTestBundle,
  wave: SingleMethodWorkWave,
  checkpoint: ActiveMethodWaveCheckpoint,
  candidateId: string
): void {
  if (
    bundle.methodId !== wave.methodId
    || bundle.sourceMethodId !== wave.methodId
    || bundle.waveIndex !== checkpoint.waveIndex
    || bundle.hasRemainingScenarios !== (wave.remainingScenarioCount > 0)
    || bundle.sourceBatchIds.length !== 1
    || bundle.sourceBatchIds[0] !== candidateId
  ) {
    throw new Error('Published Wave recovery bundle identity is inconsistent.');
  }
}

function recoveredWaveOutcome(
  wave: SingleMethodWorkWave,
  acceptedPartIndexes: ReadonlySet<number>,
  candidateId: string,
  bundle: MethodTestBundle
): MethodWaveExecutionOutcome {
  const completedScenarioIds = wave.parts.flatMap((part) => (
    acceptedPartIndexes.has(part.partIndex) ? part.scenarioIds : []
  ));
  const completedSet = new Set(completedScenarioIds);
  return {
    completedScenarioIds,
    skippedScenarioIds: wave.selectedScenarioIds.filter((scenarioId) => (
      !completedSet.has(scenarioId)
    )),
    candidateIds: [candidateId],
    bundle
  };
}

function buildMethodGenerationWaveRequest(input: {
  task: ClassTaskSnapshot;
  wave: SingleMethodWorkWave | ClassScenarioWorkWave;
  waveIndex: number;
  sourceClassName: string;
  context: SingleMethodGenerationContext;
  randomUUID: () => string;
}): StartMethodGenerationWaveRequest {
  return {
    waveId: input.wave.waveBatchId,
    methodId: input.wave.methodId,
    waveIndex: input.waveIndex,
    parts: input.wave.parts.map((part) => {
      const methodSlices = 'methodSlices' in part ? part.methodSlices : null;
      const plannedTestMethods = methodSlices
        ? methodSlices.reduce(
            (sum, slice) => sum + slice.batch.methodTestPlan.testMethodPlans.length,
            0
          )
        : part.methodTestPlan.testMethodPlans.length;
      if (plannedTestMethods < 1 || plannedTestMethods > 25) {
        throw new Error('Wave Part must contain between 1 and 25 test plans.');
      }
      const outputTestClassName = outputPartTestClassName(
        input.sourceClassName,
        input.waveIndex,
        part.partIndex
      );
      const batch: SingleMethodWorkBatch | ClassScenarioWorkBatch = methodSlices
        ? {
            batchId: part.partBatchId,
            reportPairId: input.wave.reportPairId,
            methodId: input.wave.methodId,
            hasWork: true,
            methodSlices: methodSlices.map((slice) => ({
              methodId: slice.methodId,
              testMethodNamePrefix: slice.testMethodNamePrefix,
              batch: singleMethodBatchFromPart({
                part: slice.batch,
                batchId: slice.batch.partBatchId,
                reportPairId: input.wave.reportPairId,
                methodId: slice.methodId,
                remainingTestMethods: 'remainingScenarioCountByMethod' in input.wave
                  ? input.wave.remainingScenarioCountByMethod[slice.methodId] ?? 0
                  : input.wave.remainingScenarioCount,
                warnings: input.wave.warnings
              })
            })),
            necessaryImports: [...new Set(
              methodSlices.flatMap((slice) => slice.batch.necessaryImports)
            )],
            plannedTestMethods,
            remainingTestMethods: input.wave.remainingScenarioCount,
            warnings: structuredClone(input.wave.warnings)
          }
        : singleMethodBatchFromPart({
            part,
            batchId: part.partBatchId,
            reportPairId: input.wave.reportPairId,
            methodId: input.wave.methodId,
            remainingTestMethods: input.wave.remainingScenarioCount,
            warnings: input.wave.warnings
          });
      return {
        partIndex: part.partIndex,
        partBatchId: part.partBatchId,
        scenarioIds: [...part.scenarioIds],
        request: {
          clientRequestId: input.randomUUID(),
          classTaskId: input.task.id,
          methodId: input.wave.methodId,
          batchId: part.partBatchId,
          batchIndex: input.waveIndex,
          outputTestClassName,
          expectedPackageName: input.context.packageName,
          buildToolchain: input.context.buildToolchain,
          batch,
          captureModelCalls: input.context.captureModelCalls,
          repairAttemptLimit: input.task.unlimitedRepair
            ? null
            : input.task.repairAttemptLimit,
          unlimitedRepair: input.task.unlimitedRepair
        }
      };
    })
  };
}

function outputPartTestClassName(
  sourceClassName: string,
  waveIndex: number,
  partIndex: number
): string {
  return `${sourceClassName}Tmp${waveIndex}Part${partIndex}Test`;
}

function applyMethodGenerationWaveEvent(
  current: ActiveMethodWaveCheckpoint,
  event: MethodGenerationWaveEvent
): ActiveMethodWaveCheckpoint {
  if (
    event.waveId !== current.waveId
    || event.methodId !== current.methodId
    || event.waveIndex !== current.waveIndex
    || current.waveSessionId !== null
      && current.waveSessionId !== event.waveSessionId
  ) {
    throw new Error('Agent Wave event identity changed during execution.');
  }
  const next = structuredClone(current);
  next.waveSessionId = event.waveSessionId;
  next.eventSequence = event.eventSequence;
  if (event.eventType === 'error' && event.error) {
    throw new MethodGenerationRequestError(event.error.code, event.error.message);
  }
  if (event.partIndex !== null) {
    const part = requireWaveCheckpointPart(next, event.partIndex);
    part.eventSequence = event.childEvent?.eventSequence ?? event.eventSequence;
    if (event.eventType === 'part_started' || event.eventType === 'part_event') {
      part.status = 'RUNNING';
      part.failureReason = null;
    }
    if (event.partResult) applyTerminalPartCheckpoint(part, event.partResult);
  }
  if (event.completion) {
    for (const terminal of event.completion.parts) {
      applyTerminalPartCheckpoint(
        requireWaveCheckpointPart(next, terminal.partIndex),
        terminal
      );
    }
  }
  return next;
}

function applyTerminalPartCheckpoint(
  checkpoint: MethodWavePartCheckpoint,
  terminal: MethodGenerationWavePartResult
): void {
  if (checkpoint.partBatchId !== terminal.partBatchId
    || checkpoint.scenarioIds.length !== terminal.scenarioIds.length
    || checkpoint.scenarioIds.some(
      (scenarioId, index) => terminal.scenarioIds[index] !== scenarioId
    )) {
    throw new Error('Agent terminal Part identity changed.');
  }
  if (terminal.status === 'succeeded') {
    checkpoint.childSessionId = terminal.childSessionId;
    if (checkpoint.status !== 'SUCCEEDED') {
      checkpoint.status = 'RUNNING';
      checkpoint.candidateId = null;
      checkpoint.failureReason = null;
    }
  } else {
    checkpoint.status = terminal.status === 'failed' ? 'FAILED' : 'CANCELLED';
    checkpoint.childSessionId = terminal.childSessionId;
    checkpoint.candidateId = null;
    checkpoint.failureReason = terminal.status === 'failed'
      ? terminal.error
        ? `${terminal.error.code}: ${terminal.error.message}`
        : 'Wave Part failed.'
      : null;
  }
  checkpoint.aggregateUsage = terminal.aggregateUsage;
  checkpoint.modelCallCount = terminal.modelCallCount;
  checkpoint.usageReportedCallCount = terminal.usageReportedCallCount;
}

function assertWaveStartRequestIdentity(
  request: StartMethodGenerationWaveRequest,
  task: ClassTaskSnapshot,
  wave: SingleMethodWorkWave,
  waveIndex: number,
  context: SingleMethodGenerationContext
): void {
  if (request.waveId !== wave.waveBatchId
    || request.methodId !== wave.methodId
    || request.waveIndex !== waveIndex
    || request.parts.length !== wave.parts.length
    || request.parts.some((part, index) => {
      const expected = wave.parts[index];
      return !expected
        || part.partIndex !== expected.partIndex
        || part.partBatchId !== expected.partBatchId
        || part.scenarioIds.length !== expected.scenarioIds.length
        || part.scenarioIds.some(
          (scenarioId, scenarioIndex) => expected.scenarioIds[scenarioIndex] !== scenarioId
        )
        || part.request.classTaskId !== task.id
        || part.request.methodId !== wave.methodId
        || part.request.batchId !== expected.partBatchId
        || part.request.batchIndex !== waveIndex
        || part.request.expectedPackageName !== context.packageName;
    })) {
    throw new Error('Persisted Wave start request no longer matches the task and Analyzer Wave.');
  }
}

function requireWaveCheckpointPart(
  checkpoint: ActiveMethodWaveCheckpoint,
  partIndex: number
): MethodWavePartCheckpoint {
  const part = checkpoint.parts.find((item) => item.partIndex === partIndex);
  if (!part) throw new Error(`Wave Part ${partIndex} is not in the checkpoint.`);
  return part;
}

function requireWavePart(
  wave: SingleMethodWorkWave | ClassScenarioWorkWave,
  partIndex: number
): SingleMethodWorkPart | ClassScenarioWorkPart {
  const part = wave.parts.find((item) => item.partIndex === partIndex);
  if (!part) throw new Error(`Wave Part ${partIndex} is not in Analyzer output.`);
  return part;
}

function requireSuccessfulWavePartCandidate(
  result: MethodGenerationWavePartResult,
  part: SingleMethodWorkPart | ClassScenarioWorkPart,
  waveOwnerMethodId: string,
  expectedTestClassName: string
): MethodCandidate {
  const candidate = result.candidate;
  const plannedTestMethods = plannedTestMethodCount(part);
  if (
    result.status !== 'succeeded'
    || !result.childSessionId
    || !candidate
    || candidate.methodId !== waveOwnerMethodId
    || candidate.batchId !== part.partBatchId
    || candidate.outputTestClassName !== expectedTestClassName
    || candidate.candidateVersion !== 1
    || candidate.repairAttempt !== 0
    || candidate.ordinaryTestMethodCount !== plannedTestMethods
    || sha256(candidate.testCode) !== candidate.generatedCodeSha256
  ) {
    throw new Error('Successful Wave Part candidate identity is invalid.');
  }
  return candidate;
}

function assertTerminalWavePartition(
  wave: SingleMethodWorkWave,
  terminalParts: readonly MethodGenerationWavePartResult[]
): void {
  if (
    terminalParts.length !== wave.parts.length
    || terminalParts.some((terminal, index) => {
      const part = wave.parts[index];
      return !part
        || terminal.partIndex !== part.partIndex
        || terminal.partBatchId !== part.partBatchId
        || terminal.scenarioIds.length !== part.scenarioIds.length
        || terminal.scenarioIds.some(
          (scenarioId, scenarioIndex) => part.scenarioIds[scenarioIndex] !== scenarioId
        );
    })
  ) {
    throw new Error('Agent Wave completion does not partition every Analyzer Part.');
  }
}

function waveCandidateCheckpoint(
  task: ClassTaskSnapshot,
  wave: SingleMethodWorkWave,
  candidateId: string,
  owned: OwnedCandidateFile,
  status: WaveCandidateCheckpoint['status']
): WaveCandidateCheckpoint {
  return {
    candidateId,
    methodId: wave.methodId,
    waveId: wave.waveBatchId,
    status,
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: task.unlimitedRepair ? null : task.repairAttemptLimit,
    unlimitedRepair: task.unlimitedRepair,
    lastMavenBatchId: null,
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: owned.filePath,
      sha256: owned.sha256,
      location: 'PROJECT'
    },
    moveTransaction: null
  };
}

function updateWaveCandidateCheckpoint(
  checkpoint: WaveCandidateCheckpoint,
  owned: OwnedCandidateFile,
  status: WaveCandidateCheckpoint['status']
): WaveCandidateCheckpoint {
  const managedLocation = checkpoint.managedFile
    && samePath(checkpoint.managedFile.path, owned.filePath)
    ? checkpoint.managedFile.location
    : 'PROJECT';
  return {
    ...checkpoint,
    status,
    managedFile: {
      path: owned.filePath,
      sha256: owned.sha256,
      location: managedLocation
    }
  };
}

function requireCandidateMoveTransaction(
  transactions: readonly WaveCandidateMoveTransaction[],
  candidateId: string
): WaveCandidateMoveTransaction {
  const transaction = transactions.find((item) => item.candidateId === candidateId);
  if (!transaction || transactions.length !== 1) {
    throw new Error('Wave candidate move transaction identity is inconsistent.');
  }
  return transaction;
}

function waveCandidateProjectPath(
  task: ClassTaskSnapshot,
  context: SingleMethodGenerationContext,
  testClassName: string
): string {
  const plannedPath = resolve(task.workspaceRoot, context.plannedRelativeTestPath);
  return resolve(dirname(plannedPath), `${testClassName}.java`);
}

function waveCandidateIsolationPath(
  task: ClassTaskSnapshot,
  candidateId: string,
  testClassName: string
): string {
  return resolve(
    task.workspaceRoot,
    '.ai-unit-test',
    'method-wave-candidates',
    sha256(task.id).slice(0, 24),
    candidateId,
    `${testClassName}.java`
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/\\/gu, '/').toLowerCase();
  const normalizedRight = resolve(right).replace(/\\/gu, '/').toLowerCase();
  return normalizedLeft === normalizedRight;
}

function mergedWaveRepairBatch(
  wave: SingleMethodWorkWave | ClassScenarioWorkWave,
  acceptedPartIndexes: ReadonlySet<number>,
  plannedTestMethods: number,
  plannedTestMethodNames?: readonly string[]
): SingleMethodWorkBatch | ClassScenarioWorkBatch {
  if ('selectedMethodIds' in wave) {
    const slicesByMethod = new Map<string, {
      prefix: string;
      parts: SingleMethodWorkPart[];
    }>();
    for (const part of wave.parts) {
      if (!acceptedPartIndexes.has(part.partIndex)) continue;
      for (const slice of part.methodSlices) {
        const current = slicesByMethod.get(slice.methodId) ?? {
          prefix: slice.testMethodNamePrefix,
          parts: []
        };
        if (current.prefix !== slice.testMethodNamePrefix) {
          throw new Error('Class Wave method prefix changed between Parts.');
        }
        current.parts.push(slice.batch);
        slicesByMethod.set(slice.methodId, current);
      }
    }
    if (
      !plannedTestMethodNames
      || plannedTestMethodNames.length !== plannedTestMethods
      || plannedTestMethods < 1
      || plannedTestMethods > MAX_METHOD_GENERATION_SESSION_TEST_METHODS
    ) {
      throw new Error('Class Wave repair candidate identity is invalid.');
    }
    const methodEntries = [...slicesByMethod.entries()];
    const prefixes = methodEntries.map(([, item]) => item.prefix);
    if (new Set(prefixes).size !== prefixes.length) {
      throw new Error('Class Wave source methods share a test method prefix.');
    }
    const retainedTestCountByMethod = new Map<string, number>();
    for (const testMethodName of plannedTestMethodNames) {
      const matches = methodEntries.filter(([, item]) => (
        testMethodName.startsWith(item.prefix)
      ));
      if (matches.length !== 1) {
        throw new Error(
          'Class Wave repair candidate contains a test without a unique source-method prefix.'
        );
      }
      const methodId = matches[0][0];
      retainedTestCountByMethod.set(
        methodId,
        (retainedTestCountByMethod.get(methodId) ?? 0) + 1
      );
    }
    const methodSlices = methodEntries.flatMap(([methodId, item]) => {
      const retainedTestCount = retainedTestCountByMethod.get(methodId) ?? 0;
      if (retainedTestCount === 0) return [];
      const selectedScenarioIds = item.parts.flatMap((part) => part.scenarioIds);
      const methodWave: SingleMethodWorkWave = {
        waveBatchId: sha256(`${wave.waveBatchId}\nrepair\n${methodId}`),
        reportPairId: wave.reportPairId,
        methodId,
        hasWork: true,
        selectedScenarioIds,
        remainingScenarioCount: wave.remainingScenarioCountByMethod[methodId] ?? 0,
        parts: item.parts,
        warnings: wave.warnings
      };
      return [{
        methodId,
        testMethodNamePrefix: item.prefix,
        batch: mergedWaveRepairBatch(
          methodWave,
          new Set(item.parts.map((part) => part.partIndex)),
          retainedTestCount
        ) as SingleMethodWorkBatch
      }];
    });
    return {
      batchId: wave.waveBatchId,
      reportPairId: wave.reportPairId,
      methodId: wave.methodId,
      hasWork: true,
      methodSlices,
      necessaryImports: [...new Set(
        methodSlices.flatMap((slice) => slice.batch.necessaryImports)
      )],
      plannedTestMethods,
      remainingTestMethods: wave.remainingScenarioCount,
      warnings: structuredClone(wave.warnings)
    };
  }
  const parts = wave.parts.filter((part) => acceptedPartIndexes.has(part.partIndex));
  if (parts.length === 0
    || !Number.isSafeInteger(plannedTestMethods)
    || plannedTestMethods < 1
    || plannedTestMethods > MAX_METHOD_GENERATION_SESSION_TEST_METHODS) {
    throw new Error('Merged Wave repair batch identity is invalid.');
  }
  const first = parts[0];
  const scenarios = uniqueBy(
    parts.flatMap((part) => part.scenarios),
    (scenario) => scenario.scenarioId
  );
  const scenarioIds = scenarios.map((scenario) => scenario.scenarioId);
  const allPlans = uniqueBy(
    parts.flatMap((part) => part.methodTestPlan.testMethodPlans),
    (plan) => plan.testMethodPlanId
  );
  if (allPlans.length < plannedTestMethods) {
    throw new Error('Merged Wave code has more tests than its accepted Analyzer plans.');
  }
  const selectedPlans = allPlans.slice(0, plannedTestMethods);
  const selectedGroupIds = new Set(
    selectedPlans.flatMap((plan) => plan.pathGroupIds)
  );
  const selectedGroups = uniqueBy(
    parts.flatMap((part) => part.methodTestPlan.testPathGroups),
    (group) => group.groupId
  ).filter((group) => selectedGroupIds.has(group.groupId));
  if (selectedGroups.length !== selectedGroupIds.size) {
    throw new Error('Merged Wave repair plans reference an unavailable path group.');
  }
  const selectedTargetIds = new Set(
    selectedGroups.flatMap((group) => group.targetIds)
  );
  const remainingTargets = uniqueBy(
    parts.flatMap((part) => part.methodTestPlan.remainingTargets),
    (target) => target.targetId
  ).filter((target) => selectedTargetIds.has(target.targetId));
  if (remainingTargets.length !== selectedTargetIds.size) {
    throw new Error('Merged Wave repair path groups reference an unavailable target.');
  }
  const calls = uniqueBy(
    parts.flatMap((part) => part.methodStubInventory.calls),
    (call) => call.callSiteId
  );
  const requiredCallCount = Math.max(
    calls.filter((call) => call.required).length,
    ...parts.map((part) => part.methodStubInventory.requiredCallCount)
  );
  const unresolvedRequiredCallCount = Math.min(
    requiredCallCount,
    Math.max(...parts.map(
      (part) => part.methodStubInventory.unresolvedRequiredCallCount
    ))
  );
  const referencedTypes = mergeReferencedTypeFacts(
    parts.flatMap((part) => part.referencedTypes)
  );
  return {
    batchId: wave.waveBatchId,
    reportPairId: wave.reportPairId,
    methodId: wave.methodId,
    hasWork: true,
    method: {
      ...structuredClone(first.method),
      activeScenarioIds: scenarioIds
    },
    scenarios: structuredClone(scenarios),
    methodTestPlan: {
      methodId: wave.methodId,
      analysisStatus: parts.some(
        (part) => part.methodTestPlan.analysisStatus === 'ANALYSIS_FAILED'
      )
        ? 'ANALYSIS_FAILED'
        : parts.some((part) => part.methodTestPlan.analysisStatus === 'PARTIAL')
          ? 'PARTIAL'
          : first.methodTestPlan.analysisStatus,
      minimumTestCount: plannedTestMethods,
      remainingTargets: structuredClone(remainingTargets),
      testPathGroups: selectedGroups.map((group, index) => ({
        ...structuredClone(group),
        ordinal: index + 1
      })),
      testMethodPlans: selectedPlans.map((plan, index) => ({
        ...structuredClone(plan),
        ordinal: index + 1
      })),
      fallbackReason: parts.map((part) => part.methodTestPlan.fallbackReason)
        .find((reason) => reason.trim()) ?? ''
    },
    methodStubInventory: {
      methodId: wave.methodId,
      status: parts.some(
        (part) => part.methodStubInventory.status === 'ANALYSIS_FAILED'
      )
        ? 'ANALYSIS_FAILED'
        : parts.some((part) => part.methodStubInventory.status === 'PARTIAL')
          ? 'PARTIAL'
          : first.methodStubInventory.status,
      requiredCallCount,
      unresolvedRequiredCallCount,
      calls: structuredClone(calls)
    },
    activeStubPlans: structuredClone(uniqueBy(
      parts.flatMap((part) => part.activeStubPlans),
      (stub) => stub.stubId
    )),
    targetFixturePlan: structuredClone(first.targetFixturePlan),
    referencedTypes: structuredClone(referencedTypes),
    necessaryImports: [...new Set(parts.flatMap((part) => part.necessaryImports))],
    plannedTestMethods,
    remainingTestMethods: wave.remainingScenarioCount,
    warnings: structuredClone(wave.warnings)
  };
}

function mergeReferencedTypeFacts(
  values: readonly SingleMethodWorkBatch['referencedTypes'][number][]
): SingleMethodWorkBatch['referencedTypes'] {
  type TypeFacts = SingleMethodWorkBatch['referencedTypes'][number];
  type MethodContract = NonNullable<TypeFacts['methodContracts']>[number];
  const merged = new Map<string, {
    type: TypeFacts;
    constructors: Set<string>;
    methods: Set<string>;
    enumConstants: Set<string>;
    methodContracts: Map<string, MethodContract>;
    hasMethodContracts: boolean;
  }>();
  for (const value of values) {
    const hasMethodContracts = Object.prototype.hasOwnProperty.call(
      value,
      'methodContracts'
    );
    let entry = merged.get(value.qualifiedName);
    if (!entry) {
      entry = {
        type: {
          ...value,
          constructors: [],
          methods: [],
          enumConstants: [],
          ...(hasMethodContracts ? { methodContracts: [] } : {})
        },
        constructors: new Set<string>(),
        methods: new Set<string>(),
        enumConstants: new Set<string>(),
        methodContracts: new Map<string, MethodContract>(),
        hasMethodContracts
      };
      merged.set(value.qualifiedName, entry);
    } else if (hasMethodContracts) {
      entry.hasMethodContracts = true;
    }
    // 各 Part 的类型 API 已按场景裁剪，修复上下文按原顺序合并成员，不改写签名。
    for (const field of ['constructors', 'methods', 'enumConstants'] as const) {
      for (const member of value[field]) {
        if (entry[field].has(member)) continue;
        entry[field].add(member);
        entry.type[field].push(member);
      }
    }
    for (const contract of value.methodContracts ?? []) {
      if (!entry.methodContracts.has(contract.signature)) {
        entry.methodContracts.set(contract.signature, { ...contract });
      }
    }
  }
  return [...merged.values()].map((entry) => {
    if (!entry.hasMethodContracts) return entry.type;
    const methodContracts: MethodContract[] = [];
    let documentationLength = 0;
    for (const contract of entry.methodContracts.values()) {
      if (methodContracts.length >= 16 || documentationLength >= 8_000) break;
      if (!entry.methods.has(contract.signature)) continue;
      const documentation = contract.documentation.slice(
        0,
        Math.min(1_600, 8_000 - documentationLength)
      );
      if (!documentation) continue;
      methodContracts.push({ ...contract, documentation });
      documentationLength += documentation.length;
    }
    entry.type.methodContracts = methodContracts;
    return entry.type;
  });
}
function recoveredClassWaveOutcome(
  wave: ClassScenarioWorkWave,
  acceptedPartIndexes: ReadonlySet<number>,
  candidateId: string,
  bundles: MethodTestBundle[]
): MethodWaveExecutionOutcome {
  const completedScenarioIds = wave.parts.flatMap((part) => (
    acceptedPartIndexes.has(part.partIndex) ? part.scenarioIds : []
  ));
  const completed = new Set(completedScenarioIds);
  return {
    completedScenarioIds,
    skippedScenarioIds: wave.selectedScenarioIds.filter((scenarioId) => !completed.has(scenarioId)),
    candidateIds: [candidateId],
    bundles
  };
}

function singleMethodBatchFromPart(input: {
  part: SingleMethodWorkPart;
  batchId: string;
  reportPairId: string;
  methodId: string;
  remainingTestMethods: number;
  warnings: SingleMethodWorkWave['warnings'];
}): SingleMethodWorkBatch {
  const plannedTestMethods = input.part.methodTestPlan.testMethodPlans.length;
  return {
    batchId: input.batchId,
    reportPairId: input.reportPairId,
    methodId: input.methodId,
    hasWork: true,
    method: structuredClone(input.part.method),
    scenarios: structuredClone(input.part.scenarios),
    methodTestPlan: structuredClone(input.part.methodTestPlan),
    methodStubInventory: structuredClone(input.part.methodStubInventory),
    activeStubPlans: structuredClone(input.part.activeStubPlans),
    targetFixturePlan: structuredClone(input.part.targetFixturePlan),
    referencedTypes: structuredClone(input.part.referencedTypes),
    necessaryImports: [...input.part.necessaryImports],
    plannedTestMethods,
    remainingTestMethods: input.remainingTestMethods,
    warnings: structuredClone(input.warnings)
  };
}

function uniqueBy<T>(
  values: readonly T[],
  identity: (value: T) => string
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function compactWaveFailure(error: unknown): string {
  return sanitizePublicText(error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u0020\u007f]+/gu, ' ')
    .trim()
    .slice(0, 1_000) || 'Wave Part failed.';
}

function isRepairOutputRetryExhaustedError(error: unknown): boolean {
  return error instanceof MethodGenerationRequestError
    && error.code === 'GENERATED_TEST_INVALID';
}

function preferredPartModelFailure(
  parts: readonly MethodGenerationWavePartResult[]
): MethodGenerationFailure | undefined {
  const failures = parts.flatMap((part) => (
    part.status === 'failed' && part.error?.code.startsWith('MODEL_')
      ? [part.error]
      : []
  ));
  if (failures.length === 0) return undefined;
  return structuredClone(failures
    .sort((left, right) => (
      modelFailurePriority(right.code) - modelFailurePriority(left.code)
      || left.code.localeCompare(right.code)
    ))[0]);
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

function requireTemporaryBatchIndexOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Temporary method-batch index offset must be a non-negative integer.');
  }
  return offset;
}

function displayMethodSignature(page: SingleMethodWorkBatch): string {
  const method = page.method;
  const modifiers = method.modifiers.length > 0
    ? `${method.modifiers.join(' ')} `
    : '';
  const declaredExceptions = method.declaredExceptions.length > 0
    ? ` throws ${method.declaredExceptions.join(', ')}`
    : '';
  return `${modifiers}${method.returnType} ${method.methodName}(${method.parameterTypes.join(', ')})${declaredExceptions}`;
}

function displayGenerationBatchSignature(
  batch: SingleMethodWorkBatch | ClassScenarioWorkBatch
): string {
  if (!('methodSlices' in batch)) return displayMethodSignature(batch);
  return batch.methodSlices
    .map((slice) => displayMethodSignature(slice.batch))
    .join(' | ');
}

function primaryGenerationBatch(
  batch: SingleMethodWorkBatch | ClassScenarioWorkBatch
): SingleMethodWorkBatch {
  if (!('methodSlices' in batch)) return batch;
  const first = batch.methodSlices[0]?.batch;
  if (!first) throw new Error('Class scenario batch has no method slice.');
  return first;
}

function repairSourceBatches(
  batch: SingleMethodWorkBatch | ClassScenarioWorkBatch,
  diagnostic: Pick<
    MavenRepairDiagnostic,
    | 'affectedTestNames'
    | 'compilerErrors'
    | 'exceptions'
    | 'generatedTestFrames'
    | 'truncated'
  > | null,
  effectiveTestCode?: string,
  structure?: JavaTestStructureService
): SingleMethodWorkBatch[] {
  if (!('methodSlices' in batch)) return [batch];
  const all = batch.methodSlices.map((slice) => slice.batch);
  if (!diagnostic || diagnostic.truncated) return all;

  const testRanges = effectiveTestCode && structure
    ? structure.findTestMethods(effectiveTestCode)
    : null;
  const testMethodNames = testRanges === null
    ? null
    : new Set(testRanges.map((range) => range.name));
  const names = new Set<string>(diagnostic.affectedTestNames);
  for (const exception of diagnostic.exceptions) {
    const exceptionTestName = exception.testName
      ? normalizeRepairTestName(exception.testName)
      : '';
    if (
      exceptionTestName
      && (testMethodNames === null || testMethodNames.has(exceptionTestName))
    ) {
      names.add(exceptionTestName);
    }
    if (
      exception.testLocation
      && (
        testMethodNames === null
        || testMethodNames.has(exception.testLocation.methodName)
      )
    ) {
      names.add(exception.testLocation.methodName);
    }
  }
  for (const frame of diagnostic.generatedTestFrames) {
    // Generated-class stack frames can point at a shared helper rather than an
    // actual JUnit method. Only a method parsed from the current test source is
    // reliable evidence for selecting one production-method slice.
    if (testMethodNames?.has(frame.methodName)) names.add(frame.methodName);
  }

  if (diagnostic.compilerErrors.length > 0) {
    if (testRanges === null) return all;
    for (const error of diagnostic.compilerErrors) {
      const matches = testRanges.filter((range) => (
        range.startLine <= error.line && error.line <= range.endLine
      ));
      if (matches.length !== 1) {
        // Imports, fields and helpers can be shared by tests from every source
        // method, so an unattributed compiler error must retain all methods.
        return all;
      }
      names.add(matches[0].name);
    }
  }
  if (names.size === 0) return all;

  const selectedMethodIds = new Set<string>();
  for (const rawName of names) {
    const name = normalizeRepairTestName(rawName);
    if (!name) return all;
    const matches = batch.methodSlices.filter((slice) => (
      name.startsWith(slice.testMethodNamePrefix)
    ));
    if (matches.length !== 1) {
      // Unknown or overlapping prefixes are not safe evidence for dropping a
      // production method from this repair turn.
      return all;
    }
    selectedMethodIds.add(matches[0].methodId);
  }
  const selected = batch.methodSlices
    .filter((slice) => selectedMethodIds.has(slice.methodId))
    .map((slice) => slice.batch);
  return selected.length > 0 ? selected : all;
}

function normalizeRepairTestName(value: string): string {
  let normalized = value.trim().split(/[\[(]/u, 1)[0]?.trim() ?? '';
  for (const separator of ['#', '::']) {
    const index = normalized.lastIndexOf(separator);
    if (index >= 0) normalized = normalized.slice(index + separator.length).trim();
  }
  const dot = normalized.lastIndexOf('.');
  if (dot >= 0) normalized = normalized.slice(dot + 1).trim();
  return normalized;
}

function plannedTestMethodCount(
  part: SingleMethodWorkPart | ClassScenarioWorkPart
): number {
  return 'methodSlices' in part
    ? part.methodSlices.reduce(
        (sum, slice) => sum + slice.batch.methodTestPlan.testMethodPlans.length,
        0
      )
    : part.methodTestPlan.testMethodPlans.length;
}

function classWaveMethodPrefixes(wave: ClassScenarioWorkWave): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of wave.parts) {
    for (const slice of part.methodSlices) {
      const previous = result.get(slice.methodId);
      if (previous && previous !== slice.testMethodNamePrefix) {
        throw new Error('Class Wave method prefix changed between Parts.');
      }
      result.set(slice.methodId, slice.testMethodNamePrefix);
    }
  }
  return result;
}

function qualifiedName(packageName: string, className: string): string {
  return packageName ? `${packageName}.${className}` : className;
}

function mergeRepairContexts(
  diagnostic: MavenRepairDiagnostic,
  sourceSha256: string,
  resolved: readonly {
    sourcePage: SingleMethodWorkBatch;
    analyzer: MethodRepairContextResponse | null;
    error: unknown | null;
  }[]
): MethodGenerationRepairContext {
  if (resolved.length === 0) {
    throw new Error('Repair context requires at least one source method.');
  }
  const methods = new Map<string, RepairMethodSource>();
  const warnings: string[] = [];
  let analyzerStatus: 'available' | 'fallback' = 'available';

  // Keep every selected target ahead of stack-only helpers. One Part can carry
  // 25 source methods, so this order guarantees that all involved targets are
  // retained before the bounded context spends spare capacity on helpers.
  for (const item of resolved) {
    if (item.analyzer && item.analyzer.sourceSha256 === sourceSha256) {
      methods.set(item.analyzer.targetMethod.methodId, item.analyzer.targetMethod);
      continue;
    }
    analyzerStatus = 'fallback';
    methods.set(
      item.sourcePage.methodId,
      fallbackRepairMethod(item.sourcePage, diagnostic)
    );
    if (item.error !== null) {
      warnings.push(
        `Analyzer repair context unavailable for ${item.sourcePage.method.methodName}: `
        + boundedWarning(item.error)
      );
    } else {
      warnings.push(
        `Analyzer repair context source changed for ${item.sourcePage.method.methodName}; `
        + 'the generation batch source was retained.'
      );
    }
  }
  for (const item of resolved) {
    if (!item.analyzer || item.analyzer.sourceSha256 !== sourceSha256) continue;
    for (const warning of item.analyzer.warnings) {
      warnings.push(`${warning.code}: ${warning.message}`);
    }
    if (item.analyzer.truncated) {
      warnings.push(
        `Analyzer repair context was truncated for ${item.sourcePage.method.methodName}.`
      );
    }
    for (const method of item.analyzer.stackMethods) {
      if (!methods.has(method.methodId)) methods.set(method.methodId, method);
    }
  }

  const orderedMethods = [...methods.values()];
  const targetMethod = orderedMethods[0];
  if (!targetMethod) {
    throw new Error('Repair context requires at least one resolved source method.');
  }
  const stackMethods = orderedMethods.slice(1, MAX_METHOD_REPAIR_CONTEXT_METHODS);
  if (orderedMethods.length > MAX_METHOD_REPAIR_CONTEXT_METHODS) {
    warnings.push(
      'Analyzer repair method evidence was limited to '
      + `${MAX_METHOD_REPAIR_CONTEXT_METHODS} of ${orderedMethods.length} methods.`
    );
  }
  let referencedTypes = mergeReferencedTypeFacts(
    resolved.flatMap((item) => item.analyzer?.referencedTypes ?? [])
  );
  if (referencedTypes.length > 64) {
    warnings.push(
      `Analyzer repair type evidence was limited to 64 of ${referencedTypes.length} types.`
    );
    referencedTypes = referencedTypes.slice(0, 64);
  }

  return {
    ...diagnostic,
    analyzerStatus,
    analyzerWarnings: warnings.map(boundedWarning).slice(0, 64),
    sourceSha256,
    targetMethod,
    stackMethods,
    referencedTypes
  };
}

function fallbackRepairMethod(
  page: SingleMethodWorkBatch,
  diagnostic: MavenRepairDiagnostic
): RepairMethodSource {
  const method = page.method;
  const lines = method.completeMethodSource.split(/\r?\n/);
  const preferredLine = diagnostic.productionFrames.find((frame) => (
    frame.ownerFqn === method.declaringType
      && frame.methodName === method.methodName
      && frame.sourceLine >= method.firstLine
      && frame.sourceLine <= method.lastLine
  ))?.sourceLine ?? method.firstLine;
  const relativeAnchor = preferredLine - method.firstLine;
  const sourceComplete = lines.length <= 300;
  const firstIndex = sourceComplete
    ? 0
    : Math.max(0, Math.min(
        relativeAnchor - 149,
        lines.length - 300
      ));
  const selected = sourceComplete
    ? lines
    : lines.slice(firstIndex, firstIndex + 300);
  const sourceFirstLine = method.firstLine + firstIndex;
  return {
    methodId: method.methodId,
    declaringType: method.declaringType,
    methodName: method.methodName,
    descriptor: method.descriptor,
    modifiers: [...method.modifiers],
    firstLine: method.firstLine,
    lastLine: method.lastLine,
    sourceFirstLine,
    sourceLastLine: sourceFirstLine + selected.length - 1,
    sourceText: selected.join('\n'),
    sourceComplete,
    parameterTypes: [...method.parameterTypes],
    returnType: method.returnType,
    declaredExceptions: [...method.declaredExceptions]
  };
}

function boundedWarning(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  const sanitized = sanitizePublicText(message)
    .replace(/[\u0000-\u0020\u007f]+/g, ' ')
    .trim();
  return (sanitized || 'Analyzer repair context is unavailable.').slice(0, 2_000);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validatePage(
  page: SingleMethodWorkBatch,
  methodId: string,
  reportPairId: string,
  completedTestMethodPlanIds: readonly string[],
  completedBatchIds: ReadonlySet<string>
): void {
  if (
    page.methodId !== methodId
    || page.method.methodId !== methodId
    || page.reportPairId !== reportPairId
    || page.plannedTestMethods < 1
    || page.plannedTestMethods > MAX_SINGLE_METHOD_BATCH_TEST_METHODS
    || page.methodTestPlan.testMethodPlans.length !== page.plannedTestMethods
  ) {
    throw new Error('Analyzer returned an inconsistent single-method batch.');
  }
  const planIds = page.methodTestPlan.testMethodPlans.map(
    (plan) => plan.testMethodPlanId
  );
  if (new Set(planIds).size !== planIds.length || planIds.some((id) => !id)) {
    throw new Error('Analyzer returned duplicate or empty test-method plan IDs.');
  }
  const completed = new Set(completedTestMethodPlanIds);
  if (planIds.some((id) => completed.has(id))) {
    throw new Error('Analyzer repeated an already completed test-method plan ID.');
  }
  if (completedBatchIds.has(page.batchId)) {
    throw new Error('Analyzer repeated an already completed method batch ID.');
  }
}

function validateRecoveryCheckpoint(
  checkpoint: InProgressMethodBatchCheckpoint,
  task: ClassTaskSnapshot,
  methodId: string,
  context: SingleMethodGenerationContext,
  page: SingleMethodWorkBatch,
  outputTestClassName: string,
  batchIndex: number
): void {
  const expectedFilePath = resolve(
    dirname(resolve(task.workspaceRoot, context.plannedRelativeTestPath)),
    `${outputTestClassName}.java`
  );
  if (
    checkpoint.taskId !== task.id
    || checkpoint.methodId !== methodId
    || checkpoint.batchId !== page.batchId
    || checkpoint.batchIndex !== batchIndex
    || checkpoint.sourceSha256 !== context.sourceSha256
    || checkpoint.startRequest.classTaskId !== task.id
    || checkpoint.startRequest.methodId !== methodId
    || checkpoint.startRequest.batchId !== page.batchId
    || checkpoint.startRequest.batchIndex !== batchIndex
    || checkpoint.startRequest.outputTestClassName !== outputTestClassName
    || checkpoint.startRequest.expectedPackageName !== context.packageName
    || checkpoint.candidate.methodId !== methodId
    || checkpoint.candidate.batchId !== page.batchId
    || checkpoint.candidate.batchIndex !== batchIndex
    || checkpoint.candidate.outputTestClassName !== outputTestClassName
    || checkpoint.candidate.generatedCodeSha256 !== checkpoint.tmpFileSha256
    || !sameFilePath(checkpoint.tmpFilePath, expectedFilePath)
  ) {
    throw new Error('In-progress method candidate checkpoint identity is invalid.');
  }
}

function validateCandidate(
  candidate: MethodCandidate,
  page: SingleMethodWorkBatch | ClassScenarioWorkBatch,
  outputTestClassName: string,
  batchIndex: number,
  previousCandidateVersion: number | null,
  repairAttemptLimit: number | null,
  packageName: string,
  structure: JavaTestStructureService
): void {
  const digest = sha256(candidate.testCode);
  const versionIsValid = previousCandidateVersion === null
    ? candidate.candidateVersion === 1
    : candidate.candidateVersion > previousCandidateVersion;
  if (
    candidate.methodId !== page.methodId
    || candidate.batchId !== page.batchId
    || candidate.batchIndex !== batchIndex
    || !versionIsValid
    || candidate.candidateVersion !== candidate.repairAttempt + 1
    || candidate.repairAttempt < 0
    || repairAttemptLimit !== null
    && candidate.repairAttempt > repairAttemptLimit
    || candidate.outputTestClassName !== outputTestClassName
    || (candidate.repairAttempt === 0
      ? candidate.ordinaryTestMethodCount !== page.plannedTestMethods
      : candidate.ordinaryTestMethodCount > page.plannedTestMethods)
    || candidate.generatedCodeSha256 !== digest
  ) {
    throw new Error('Agent returned a candidate with inconsistent identity.');
  }
  const methods = validateEffectiveCode(
    candidate.testCode,
    outputTestClassName,
    packageName,
    structure
  );
  if (methods.length !== candidate.ordinaryTestMethodCount) {
    throw new Error('Agent candidate ordinary test method count is invalid.');
  }
  if ('methodSlices' in page) {
    const prefixes = page.methodSlices.map((slice) => slice.testMethodNamePrefix);
    if (methods.some((method) => !prefixes.some((prefix) => method.name.startsWith(prefix)))) {
      throw new Error('Agent class-Wave candidate contains a test without a source-method prefix.');
    }
  }
}

function validateEffectiveCode(
  code: string,
  outputTestClassName: string,
  packageName: string,
  structure: JavaTestStructureService
): ReturnType<JavaTestStructureService['findTestMethods']> {
  if (!code.trim() || Buffer.byteLength(code, 'utf8') > 1024 * 1024) {
    throw new Error('Agent candidate Java source is empty or oversized.');
  }
  const sanitized = sanitizeJava(code);
  const typePattern = new RegExp(
    `\\bclass\\s+${escapeRegExp(outputTestClassName)}\\b[^{};]*\\{`
  );
  const type = typePattern.exec(sanitized);
  if (!type) throw new Error('Agent candidate test class name is invalid.');
  const opening = type.index + type[0].lastIndexOf('{');
  const closing = matchingBrace(sanitized, opening);
  if (closing < 0 || sanitized.slice(closing + 1).trim()) {
    throw new Error('Agent candidate Java source is truncated or unparsable.');
  }
  const packageMatch = /^[\t ]*package[\t ]+([^;\r\n]+);/m.exec(sanitized);
  const actualPackage = packageMatch?.[1].trim() ?? '';
  if (actualPackage !== packageName) {
    throw new Error('Agent candidate package does not match the analyzed class.');
  }
  const importMatches = [...sanitized.matchAll(
    /^[\t ]*import[\t ]+(?:static[\t ]+)?(?:[A-Za-z_$][\w$]*\.)*(?:[A-Za-z_$][\w$]*|\*);[\t ]*$/gm
  )];
  const importKeywords = [...sanitized.matchAll(/\bimport\b/g)];
  if (importMatches.length !== importKeywords.length) {
    throw new Error('Agent candidate contains an invalid import declaration.');
  }
  return structure.findTestMethods(code);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Single-method generation was cancelled.');
}

async function waitForRagIndexRefresh<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  waitMilliseconds: number,
  signal: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal.reason instanceof Error
      ? signal.reason
      : new Error('Single-method generation was cancelled.'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const pending = Promise.resolve().then(() => operation(controller.signal));
  void pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('RAG index refresh was cancelled.'));
    }, { once: true });
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('RAG index refresh timed out.');
      controller.abort(error);
      reject(error);
    }, waitMilliseconds);
  });
  try {
    return await Promise.race([pending, interrupted, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/\\/g, '/');
  const normalizedRight = resolve(right).replace(/\\/g, '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
