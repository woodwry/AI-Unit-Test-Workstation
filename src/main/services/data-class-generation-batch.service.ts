import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { BuildToolchainSettings } from '../../shared/types.ts';
import type {
  ClassTaskActiveGenerationBatch,
  ClassTaskSnapshot
} from '../../shared/class-task-contracts.ts';
import type {
  MethodExecutionCheckpoint,
  ClassTaskCheckpointService,
  ClassTaskRunCheckpoint
} from './class-task-checkpoint.service.ts';
import {
  MAX_SINGLE_METHOD_BATCH_TEST_METHODS,
  type SingleMethodWorkBatch
} from './method-analysis-contract.ts';
import type {
  CandidateExecutionFeedback,
  MethodGenerationModelContext
} from './method-generation-contract.ts';
import type { AiClient } from './ai-client.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';
import type { TestWriterService } from './test-writer.service.ts';
import type { MavenCandidateExecutorService } from './maven-candidate-executor.service.ts';
import type { MethodGenerationLogService } from './method-generation-log.service.ts';
import type { ClassTaskFileTransactionService } from './class-task-file-transaction.service.ts';
import { sanitizePublicText } from './maven-command.ts';
import {
  MavenRepairDiagnosticService,
  type MavenRepairDiagnostic
} from './maven-repair-diagnostic.service.ts';
import { StableTestRepairService } from './stable-test-repair.service.ts';
import {
  JavaTestStructureService,
  matchingBrace,
  sanitizeJava
} from './java-test-structure.service.ts';

const DATA_CLASS_KINDS = new Set([
  'DATA_LOMBOK',
  'DATA_EXPLICIT_ACCESSORS',
  'DATA_SETTER_ONLY'
]);

export type DataClassMethodGenerationFact = {
  methodId: string;
  methodName: string;
  descriptor: string;
  parameterCount: number;
  modifiers: readonly string[];
  scenarioCount: number;
  plannedTestMethods: number;
  remainingTestMethods: number;
  requiredCallCount: number;
  activeStubCount: number;
  sourceCharacterCount: number;
  lombokGenerated: boolean;
};

export type DataClassGenerationBatch = {
  methodIds: string[];
  scenarioCount: number;
  plannedTestMethods: number;
  fastPath: boolean;
};

export type PlanDataClassGenerationBatchesInput = {
  classKind: string;
  methodOrder: readonly string[];
  facts: readonly DataClassMethodGenerationFact[];
};

export type DataClassGenerationBatchContext = {
  analysisSessionId: string;
  reportPairId: string;
  packageName: string;
  plannedRelativeTestPath: string;
  moduleRoot: string;
  buildSettings: BuildToolchainSettings;
  modelContext: MethodGenerationModelContext;
  captureModelCalls: boolean;
  excludedEnvironmentVariables?: readonly string[];
};

export type DataClassGenerationBatchServiceOptions = {
  analyzer: Pick<AiClient, 'classifyUnitTestTarget' | 'nextMethodBatch'>;
  agent: Pick<AiClient, 'generateUnitTestPrompt'>;
  contextProvider: {
    resolve(
      task: ClassTaskSnapshot,
      signal?: AbortSignal
    ): Promise<DataClassGenerationBatchContext>;
  };
  checkpoints: Pick<
    ClassTaskCheckpointService,
    | 'methodCheckpoint'
    | 'taskProgress'
    | 'beginAtomicStep'
    | 'completeAtomicStep'
    | 'commitBatch'
    | 'addModelUsage'
  >;
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  writer: Pick<
    TestWriterService,
    | 'prepareMethodBatchTemporaryGeneratedTest'
    | 'writePreparedGeneratedTest'
    | 'loadOwnedGeneratedTest'
    | 'prepareReplacement'
    | 'replacePreparedGeneratedTest'
    | 'deleteGeneratedTest'
  >;
  candidateFiles: Pick<ClassTaskFileTransactionService, 'moveWaveCandidateFiles'>;
  maven: Pick<MavenCandidateExecutorService, 'execute'>;
  logs: Pick<MethodGenerationLogService, 'record'>;
  randomUUID?: () => string;
  structure?: JavaTestStructureService;
  diagnostic?: MavenRepairDiagnosticService;
  stableRepair?: Pick<StableTestRepairService, 'repair'>;
};

type CachedGenerationGroup = {
  reportPairId: string;
  classKind: string;
  pages: SingleMethodWorkBatch[];
};

export type DataClassGroupMethodBundle = {
  methodId: string;
  batchId: string;
  code: string;
  ordinaryTestMethodCount: number;
  passedTestMethods: string[];
};

export type RestoredDataClassGenerationGroup = {
  filePath: string;
  sha256: string;
  code: string;
  methodBundles: DataClassGroupMethodBundle[];
};

type WrittenGroupCandidate = {
  filePath: string;
  sha256: string;
  candidateVersion: number;
  methods: Array<{
    methodId: string;
    page: SingleMethodWorkBatch;
    ordinaryTestMethodCount: number;
  }>;
};

type ManagedGroupCandidate = {
  candidateId: string;
  testClassName: string;
  projectFilePath: string;
  isolationFilePath: string;
  filePath: string;
  location: 'PROJECT' | 'ISOLATED';
  code: string;
  sha256: string;
};

/**
 * One-shot generation path for the selected methods of a data/VO class.
 * Once a group is planned, it must either complete as that group or fail as
 * that group; it must never restart as independent per-method generations.
 */
export class DataClassGenerationBatchService {
  private readonly options: DataClassGenerationBatchServiceOptions;
  private readonly randomUUID: () => string;
  private readonly structure: JavaTestStructureService;
  private readonly diagnostic: MavenRepairDiagnosticService;
  private readonly stableRepair: Pick<StableTestRepairService, 'repair'>;
  private readonly plannedGroups = new Map<string, CachedGenerationGroup>();

  constructor(options: DataClassGenerationBatchServiceOptions) {
    this.options = options;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.structure = options.structure ?? new JavaTestStructureService();
    this.diagnostic = options.diagnostic ?? new MavenRepairDiagnosticService();
    this.stableRepair = options.stableRepair ?? new StableTestRepairService();
  }

  async plan(
    task: ClassTaskSnapshot,
    pendingMethodIds: readonly string[],
    signal: AbortSignal
  ): Promise<string[][]> {
    this.plannedGroups.clear();
    if (pendingMethodIds.length === 0) return [];
    throwIfAborted(signal);
    const context = await this.options.contextProvider.resolve(task, signal);
    let classKind: string;
    try {
      classKind = (await this.options.analyzer.classifyUnitTestTarget(
        task.moduleDisplayPath,
        task.qualifiedClassName,
        signal
      )).classKind;
    } catch (error) {
      throwIfAborted(signal);
      return pendingMethodIds.map((methodId) => [methodId]);
    }
    if (!DATA_CLASS_KINDS.has(classKind)) {
      return pendingMethodIds.map((methodId) => [methodId]);
    }

    const pages = new Map<string, SingleMethodWorkBatch>();
    const facts: DataClassMethodGenerationFact[] = [];
    await this.atomic(task.id, 'ANALYZE_METHOD', async () => {
      for (const methodId of pendingMethodIds) {
        throwIfAborted(signal);
        const checkpoint = await this.options.checkpoints.methodCheckpoint(task.id, methodId);
        if (checkpoint.completedBatches.length > 0 || checkpoint.inProgressBatch) continue;
        try {
          const response = await this.options.analyzer.nextMethodBatch(
            context.analysisSessionId,
            methodId,
            {
              reportPairId: context.reportPairId,
              completedTestMethodPlanIds: [],
              maxTestMethods: MAX_SINGLE_METHOD_BATCH_TEST_METHODS
            },
            signal
          );
          if (!response.hasWork) continue;
          pages.set(methodId, response);
          facts.push(factFromPage(response));
        } catch (error) {
          throwIfAborted(signal);
          // One Analyzer failure only disqualifies that method from the fast path.
        }
      }
    });

    const batches = planDataClassGenerationBatches({
      classKind,
      methodOrder: pendingMethodIds,
      facts
    });
    for (const batch of batches) {
      if (!batch.fastPath) continue;
      const batchPages = batch.methodIds.flatMap((methodId) => {
        const page = pages.get(methodId);
        return page ? [page] : [];
      });
      if (batchPages.length !== batch.methodIds.length) continue;
      this.plannedGroups.set(groupKey(batch.methodIds), {
        reportPairId: context.reportPairId,
        classKind,
        pages: batchPages
      });
    }
    return batches.map((batch) => [...batch.methodIds]);
  }

  async execute(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    checkpoints: Readonly<Record<string, MethodExecutionCheckpoint>>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (methodIds.length === 0) return false;
    const planned = this.plannedGroups.get(groupKey(methodIds));
    if (!planned) return false;
    if (methodIds.some((methodId) => {
      const checkpoint = checkpoints[methodId];
      return !checkpoint
        || checkpoint.completedBatches.length > 0
        || checkpoint.inProgressBatch !== undefined;
    })) {
      throw new Error('Data-class batch checkpoints changed after one-shot planning.');
    }
    throwIfAborted(signal);
    const context = await this.options.contextProvider.resolve(task, signal);
    if (context.reportPairId !== planned.reportPairId) {
      throw new Error('Data-class batch coverage changed after one-shot planning.');
    }
    const progress = await this.options.checkpoints.taskProgress(task.id);
    const activeGenerationBatch: ClassTaskActiveGenerationBatch = {
      methodCount: methodIds.length,
      scenarioCount: planned.pages.reduce(
        (sum, page) => sum + Math.max(1, page.scenarios.length, page.plannedTestMethods),
        0
      )
    };
    const firstOutputIndex = temporaryBatchIndexOffset(progress, methodIds[0]) + 1;
    const targetSimpleName = basename(task.sourceFilePath, '.java');
    const outputTestClassName = `${targetSimpleName}Tmp${firstOutputIndex}Test`;
    const groupMethodId = sha256(`methods\0${methodIds.join('\0')}`);
    const groupBatchId = sha256(`batches\0${planned.pages.map((page) => page.batchId).join('\0')}`);
    const prompt = renderBatchPrompt({
      task,
      context,
      classKind: planned.classKind,
      pages: planned.pages,
      outputTestClassName
    });
    const sessionId = this.randomUUID();
    const callId = this.randomUUID();
    const startedAt = new Date().toISOString();
    if (context.captureModelCalls) {
      await this.recordModelCall({
        task,
        pages: planned.pages,
        groupMethodId,
        groupBatchId,
        sessionId,
        callId,
        phase: 'started',
        startedAt,
        modelName: context.modelContext.llmConfig.model,
        prompt,
        rawOutput: null,
        processedOutput: null,
        usage: null,
        processingValid: null
      });
    }

    let rawOutput: string;
    let modelName = context.modelContext.llmConfig.model;
    let usage: Awaited<ReturnType<AiClient['generateUnitTestPrompt']>>['usage'] = null;
    let modelRequestStarted = false;
    try {
      const generated = await this.atomic(task.id, 'MODEL_GENERATION', () => {
        modelRequestStarted = true;
        return this.options.agent.generateUnitTestPrompt(prompt, context.modelContext, signal);
      }, activeGenerationBatch);
      rawOutput = generated.result;
      modelName = generated.model;
      usage = generated.usage;
    } catch (error) {
      if (modelRequestStarted) {
        await this.options.checkpoints.addModelUsage(task.id, {
          tokenUsage: null,
          modelCallCount: 1,
          usageReportedCallCount: 0
        });
      }
      if (context.captureModelCalls) {
        const stopped = signal.aborted;
        await this.recordModelCall({
          task,
          pages: planned.pages,
          groupMethodId,
          groupBatchId,
          sessionId,
          callId,
          phase: stopped ? 'stopped' : 'failed',
          startedAt,
          modelName,
          prompt: null,
          rawOutput: null,
          processedOutput: null,
          usage: null,
          processingValid: false,
          errorCode: modelFailureCode(error, stopped),
          errorType: modelFailureType(error)
        });
      }
      throwIfAborted(signal);
      // A one-shot VO batch must never restart as N independent initial generations.
      // Propagate the original provider failure so the task keeps one clear failure cause.
      throw error;
    }
    await this.options.checkpoints.addModelUsage(task.id, {
      tokenUsage: usage,
      modelCallCount: 1,
      usageReportedCallCount: usage === null ? 0 : 1
    });

    let code: string;
    let methodsByPage: Map<string, string[]>;
    try {
      code = stripJavaCodeFence(rawOutput);
      methodsByPage = validateBatchCandidate(
        code,
        outputTestClassName,
        context.packageName,
        planned.pages,
        this.structure
      );
    } catch (error) {
      if (context.captureModelCalls) {
        await this.recordModelCall({
          task,
          pages: planned.pages,
          groupMethodId,
          groupBatchId,
          sessionId,
          callId,
          phase: 'completed',
          startedAt,
          modelName,
          prompt: null,
          rawOutput,
          processedOutput: null,
          usage,
          processingValid: false
        });
      }
      throw error;
    }

    if (context.captureModelCalls) {
      await this.recordModelCall({
        task,
        pages: planned.pages,
        groupMethodId,
        groupBatchId,
        sessionId,
        callId,
        phase: 'completed',
        startedAt,
        modelName,
        prompt: null,
        rawOutput,
        processedOutput: code,
        usage,
        processingValid: true
      });
    }

    const written = await this.verifyGroup({
      task,
      context,
      pages: planned.pages,
      methodsByPage,
      code,
      outputTestClassName,
      activeGenerationBatch,
      generationPrompt: prompt,
      groupMethodId,
      groupBatchId,
      sessionId,
      initialCallId: callId,
      signal
    });

    for (const candidate of written.methods) {
      const checkpoint = checkpoints[candidate.methodId];
      if (!checkpoint) throw new Error('Batch method checkpoint disappeared before commit.');
      const completedPlanIds = candidate.page.methodTestPlan.testMethodPlans.map(
        (plan) => plan.testMethodPlanId
      );
      await this.options.checkpoints.commitBatch({
        taskId: task.id,
        methodId: candidate.methodId,
        batchId: candidate.page.batchId,
        batchIndex: checkpoint.completedBatches.length + 1,
        completedTestMethodPlanIds: completedPlanIds,
        outcome: 'PASSED',
        candidateVersion: written.candidateVersion,
        tmpFilePath: written.filePath,
        tmpFileSha256: written.sha256,
        ordinaryTestMethodCount: candidate.ordinaryTestMethodCount
      });
    }
    return true;
  }

  async restoreCommittedGroup(
    task: ClassTaskSnapshot,
    methodIds: readonly string[],
    checkpoints: Readonly<Record<string, MethodExecutionCheckpoint>>,
    signal: AbortSignal
  ): Promise<RestoredDataClassGenerationGroup | null> {
    if (methodIds.length === 0) return null;
    throwIfAborted(signal);
    const batches = methodIds.map((methodId) => {
      const checkpoint = checkpoints[methodId];
      if (!checkpoint || checkpoint.completedBatches.length !== 1) return null;
      const batch = checkpoint.completedBatches[0];
      return batch.outcome === 'PASSED'
        && batch.tmpFilePath
        && batch.tmpFileSha256
        ? batch
        : null;
    });
    if (batches.some((batch) => batch === null)) return null;
    const first = batches[0]!;
    if (batches.some((batch) => (
      batch!.tmpFilePath !== first.tmpFilePath
      || batch!.tmpFileSha256 !== first.tmpFileSha256
    ))) return null;
    const code = await this.options.writer.loadOwnedGeneratedTest({
      workspaceRoot: task.workspaceRoot,
      filePath: first.tmpFilePath as string,
      expectedSha256: first.tmpFileSha256 as string
    });
    throwIfAborted(signal);
    const methods = this.structure.findTestMethods(code);
    const allowedPrefixes = methodIds.map((_, index) => `${methodKey(index)}_`);
    const methodBundles = methodIds.map((methodId, index) => {
      const batch = batches[index]!;
      const prefix = allowedPrefixes[index];
      const passedTestMethods = methods
        .filter((method) => method.name.startsWith(prefix))
        .map((method) => method.name);
      if (passedTestMethods.length !== batch.ordinaryTestMethodCount) {
        throw new Error(`Persisted data-class group prefix ${prefix} is inconsistent.`);
      }
      return {
        methodId,
        batchId: batch.batchId,
        code: selectTestMethods(code, new Set(passedTestMethods), this.structure),
        ordinaryTestMethodCount: batch.ordinaryTestMethodCount,
        passedTestMethods
      };
    });
    if (methods.some((method) => (
      !allowedPrefixes.some((prefix) => method.name.startsWith(prefix))
    ))) {
      throw new Error('Persisted data-class group contains an unmapped test method.');
    }
    return {
      filePath: first.tmpFilePath as string,
      sha256: first.tmpFileSha256 as string,
      code,
      methodBundles
    };
  }

  private async verifyGroup(input: {
    task: ClassTaskSnapshot;
    context: DataClassGenerationBatchContext;
    pages: SingleMethodWorkBatch[];
    methodsByPage: Map<string, string[]>;
    code: string;
    outputTestClassName: string;
    activeGenerationBatch: ClassTaskActiveGenerationBatch;
    generationPrompt: string;
    groupMethodId: string;
    groupBatchId: string;
    sessionId: string;
    initialCallId: string;
    signal: AbortSignal;
  }): Promise<WrittenGroupCandidate> {
    const prepared = await this.options.writer.prepareMethodBatchTemporaryGeneratedTest({
      workspaceRoot: input.task.workspaceRoot,
      targetFilePath: input.task.sourceFilePath,
      plannedRelativeTestPath: input.context.plannedRelativeTestPath,
      outputTestClassName: input.outputTestClassName,
      content: input.code
    });
    let candidate: ManagedGroupCandidate | null = null;
    try {
      const verified = await this.options.moduleLock.runExclusive(
        input.task.moduleKey,
        async () => {
          const groupFile = await this.atomic(input.task.id, 'WRITE_CANDIDATE', () => (
            this.options.writer.writePreparedGeneratedTest(prepared)
          ), input.activeGenerationBatch);
          const managed: ManagedGroupCandidate = {
            candidateId: input.sessionId,
            testClassName: groupFile.testClassName,
            projectFilePath: groupFile.testFilePath,
            isolationFilePath: dataClassCandidateIsolationPath(
              input.task,
              input.sessionId,
              groupFile.testClassName
            ),
            filePath: groupFile.testFilePath,
            location: 'PROJECT',
            code: prepared.content,
            sha256: groupFile.sha256
          };
          const execution = await this.executeGroupMaven(input, managed);
          if (!groupExecutionPassed(execution, countMappedTests(input.methodsByPage))) {
            await this.moveManagedCandidate(input.task, managed, 'ISOLATED');
          }
          return { candidate: managed, execution };
        },
        input.signal
      );
      candidate = verified.candidate;

      if (groupExecutionPassed(verified.execution, countMappedTests(input.methodsByPage))) {
        return writtenGroupCandidate(candidate, input.pages, input.methodsByPage, 1);
      }

      return await this.repairGroup({
        ...input,
        candidate,
        execution: verified.execution,
        methodsByPage: input.methodsByPage
      });
    } catch (error) {
      const failedCandidate = candidate;
      if (failedCandidate) {
        await this.deleteCandidate(
          input.task,
          failedCandidate.filePath,
          failedCandidate.sha256
        );
      }
      throw error;
    }
  }

  private async repairGroup(input: {
    task: ClassTaskSnapshot;
    context: DataClassGenerationBatchContext;
    pages: SingleMethodWorkBatch[];
    methodsByPage: Map<string, string[]>;
    outputTestClassName: string;
    activeGenerationBatch: ClassTaskActiveGenerationBatch;
    generationPrompt: string;
    groupMethodId: string;
    groupBatchId: string;
    sessionId: string;
    initialCallId: string;
    candidate: ManagedGroupCandidate;
    execution: CandidateExecutionFeedback;
    signal: AbortSignal;
  }): Promise<WrittenGroupCandidate> {
    let execution = input.execution;
    let methodsByPage = input.methodsByPage;
    let candidateVersion = 1;
    let repairAttempt = 0;
    let validationFailure: string | null = null;
    const finiteLimit = input.task.repairAttemptLimit ?? 0;

    while (
      !groupExecutionPassed(execution, countMappedTests(methodsByPage))
      && (input.task.unlimitedRepair || repairAttempt < finiteLimit)
    ) {
      throwIfAborted(input.signal);
      repairAttempt += 1;
      const diagnostic = this.diagnostic.normalize({
        execution,
        generatedTestFilePath: input.candidate.projectFilePath,
        generatedTestClassName: qualifiedName(
          input.context.packageName,
          input.outputTestClassName
        ),
        targetProductionClassName: input.task.qualifiedClassName,
        targetProductionFilePath: input.task.sourceFilePath
      });
      const prompt = renderDataClassRepairPrompt({
        generationPrompt: input.generationPrompt,
        code: input.candidate.code,
        diagnostic,
        structure: this.structure,
        outputTestClassName: input.outputTestClassName,
        repairAttempt,
        validationFailure
      });
      const callId = this.randomUUID();
      const startedAt = new Date().toISOString();
      if (input.context.captureModelCalls) {
        await this.recordModelCall({
          task: input.task,
          pages: input.pages,
          groupMethodId: input.groupMethodId,
          groupBatchId: input.groupBatchId,
          sessionId: input.sessionId,
          callId,
          parentCallId: input.initialCallId,
          phase: 'started',
          startedAt,
          modelName: input.context.modelContext.llmConfig.model,
          prompt,
          rawOutput: null,
          processedOutput: null,
          usage: null,
          processingValid: null,
          callKind: 'repair',
          repairAttempt,
          candidateVersion: candidateVersion + 1
        });
      }

      let rawOutput: string;
      let modelName = input.context.modelContext.llmConfig.model;
      let usage: Awaited<ReturnType<AiClient['generateUnitTestPrompt']>>['usage'] = null;
      try {
        const generated = await this.atomic(input.task.id, 'MODEL_REPAIR', () => (
          this.options.agent.generateUnitTestPrompt(
            prompt,
            input.context.modelContext,
            input.signal
          )
        ), input.activeGenerationBatch);
        rawOutput = generated.result;
        modelName = generated.model;
        usage = generated.usage;
      } catch (error) {
        await this.options.checkpoints.addModelUsage(input.task.id, {
          tokenUsage: null,
          modelCallCount: 1,
          usageReportedCallCount: 0
        });
        if (input.context.captureModelCalls) {
          await this.recordModelCall({
            task: input.task,
            pages: input.pages,
            groupMethodId: input.groupMethodId,
            groupBatchId: input.groupBatchId,
            sessionId: input.sessionId,
            callId,
            parentCallId: input.initialCallId,
            phase: input.signal.aborted ? 'stopped' : 'failed',
            startedAt,
            modelName,
            prompt: null,
            rawOutput: null,
            processedOutput: null,
            usage: null,
            processingValid: false,
            errorCode: modelFailureCode(error, input.signal.aborted),
            errorType: modelFailureType(error),
            callKind: 'repair',
            repairAttempt,
            candidateVersion: candidateVersion + 1
          });
        }
        throwIfAborted(input.signal);
        throw error;
      }
      await this.options.checkpoints.addModelUsage(input.task.id, {
        tokenUsage: usage,
        modelCallCount: 1,
        usageReportedCallCount: usage === null ? 0 : 1
      });

      let repairedCode: string | null = null;
      let repairedMethods: Map<string, string[]> | null = null;
      try {
        repairedCode = stripJavaCodeFence(rawOutput);
        repairedMethods = validateBatchCandidate(
          repairedCode,
          input.outputTestClassName,
          input.context.packageName,
          input.pages,
          this.structure
        );
        requireSameRepairTestIdentities(
          input.candidate.code,
          repairedCode,
          this.structure
        );
        validationFailure = null;
      } catch (error) {
        validationFailure = error instanceof Error
          ? error.message
          : '修复候选源码校验失败。';
      }
      if (input.context.captureModelCalls) {
        await this.recordModelCall({
          task: input.task,
          pages: input.pages,
          groupMethodId: input.groupMethodId,
          groupBatchId: input.groupBatchId,
          sessionId: input.sessionId,
          callId,
          parentCallId: input.initialCallId,
          phase: 'completed',
          startedAt,
          modelName,
          prompt: null,
          rawOutput,
          processedOutput: repairedCode,
          usage,
          processingValid: repairedCode !== null && repairedMethods !== null,
          callKind: 'repair',
          repairAttempt,
          candidateVersion: candidateVersion + 1
        });
      }
      if (!repairedCode || !repairedMethods) continue;

      await this.replaceManagedCandidate(input, input.candidate, repairedCode);
      candidateVersion += 1;
      methodsByPage = repairedMethods;
      execution = await this.executeManagedGroupMaven(
        input,
        input.candidate,
        countMappedTests(methodsByPage)
      );
    }

    if (groupExecutionPassed(execution, countMappedTests(methodsByPage))) {
      return writtenGroupCandidate(
        input.candidate,
        input.pages,
        methodsByPage,
        candidateVersion
      );
    }

    const stable = await this.stableRepair.repair({
      code: input.candidate.code,
      candidateFilePath: input.candidate.projectFilePath,
      generatedTestClassName: qualifiedName(
        input.context.packageName,
        input.outputTestClassName
      ),
      initialExecution: execution,
      annotatedMemberIds: [],
      replaceCandidate: async (code) => {
        await this.replaceManagedCandidate(input, input.candidate, code);
      },
      executeMaven: () => this.executeManagedGroupMaven(
        input,
        input.candidate,
        this.structure.findTestMethods(input.candidate.code).length
      ),
      saveCheckpoint: async () => undefined,
      signal: input.signal
    });
    execution = stable.execution;
    if (stable.status === 'external_project_blocked') {
      throw new Error(dataClassMavenFailureMessage(execution));
    }
    const stableMethods = mapBatchCandidateMethods(
      input.candidate.code,
      input.pages,
      this.structure,
      false
    );
    const activeTestCount = countMappedTests(stableMethods);
    if (activeTestCount === 0 || !groupExecutionPassed(execution, activeTestCount)) {
      throw new Error(dataClassMavenFailureMessage(execution));
    }
    return writtenGroupCandidate(
      input.candidate,
      input.pages,
      stableMethods,
      candidateVersion
    );
  }

  private executeGroupMaven(
    input: {
      task: ClassTaskSnapshot;
      context: DataClassGenerationBatchContext;
      outputTestClassName: string;
      activeGenerationBatch: ClassTaskActiveGenerationBatch;
      signal: AbortSignal;
    },
    candidate: ManagedGroupCandidate
  ): Promise<CandidateExecutionFeedback> {
    return this.options.maven.execute({
      moduleRoot: input.context.moduleRoot,
      buildSettings: input.context.buildSettings,
      attemptId: this.randomUUID(),
      qualifiedTestClassName: qualifiedName(
        input.context.packageName,
        input.outputTestClassName
      ),
      scope: 'method_candidate',
      signal: input.signal,
      ...(input.context.excludedEnvironmentVariables
        ? { excludedEnvironmentVariables: input.context.excludedEnvironmentVariables }
        : {}),
      onPhaseStart: (phase) => this.options.checkpoints.beginAtomicStep(
        input.task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST',
        input.activeGenerationBatch
      ),
      onPhaseComplete: (phase) => this.options.checkpoints.completeAtomicStep(
        input.task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST'
      )
    });
  }

  private executeManagedGroupMaven(
    input: {
      task: ClassTaskSnapshot;
      context: DataClassGenerationBatchContext;
      outputTestClassName: string;
      activeGenerationBatch: ClassTaskActiveGenerationBatch;
      signal: AbortSignal;
    },
    candidate: ManagedGroupCandidate,
    expectedTests: number
  ): Promise<CandidateExecutionFeedback> {
    return this.options.moduleLock.runExclusive(input.task.moduleKey, async () => {
      if (candidate.location !== 'PROJECT') {
        await this.moveManagedCandidate(input.task, candidate, 'PROJECT');
      }
      try {
        const execution = await this.executeGroupMaven(input, candidate);
        if (!groupExecutionPassed(execution, expectedTests)) {
          await this.moveManagedCandidate(input.task, candidate, 'ISOLATED');
        }
        return execution;
      } catch (error) {
        if (candidate.location === 'PROJECT') {
          await this.moveManagedCandidate(input.task, candidate, 'ISOLATED');
        }
        throw error;
      }
    }, input.signal);
  }

  private async replaceManagedCandidate(
    input: {
      task: ClassTaskSnapshot;
      activeGenerationBatch: ClassTaskActiveGenerationBatch;
    },
    candidate: ManagedGroupCandidate,
    code: string
  ): Promise<void> {
    const prepared = this.options.writer.prepareReplacement({
      workspaceRoot: input.task.workspaceRoot,
      filePath: candidate.filePath,
      content: code
    });
    const written = await this.atomic(input.task.id, 'WRITE_CANDIDATE', () => (
      this.options.writer.replacePreparedGeneratedTest({
        workspaceRoot: input.task.workspaceRoot,
        filePath: candidate.filePath,
        expectedSha256: candidate.sha256,
        prepared
      })
    ), input.activeGenerationBatch);
    candidate.code = prepared.content;
    candidate.sha256 = written.sha256;
  }

  private async moveManagedCandidate(
    task: ClassTaskSnapshot,
    candidate: ManagedGroupCandidate,
    targetLocation: 'PROJECT' | 'ISOLATED'
  ): Promise<void> {
    if (candidate.location === targetLocation) return;
    const targetPath = targetLocation === 'PROJECT'
      ? candidate.projectFilePath
      : candidate.isolationFilePath;
    await this.options.candidateFiles.moveWaveCandidateFiles({
      moves: [{
        candidateId: candidate.candidateId,
        workspaceRoot: task.workspaceRoot,
        testClassName: candidate.testClassName,
        sourcePath: candidate.filePath,
        targetPath,
        sha256: candidate.sha256
      }],
      saveMoveTransactions: async () => undefined
    });
    candidate.filePath = targetPath;
    candidate.location = targetLocation;
  }

  private deleteCandidate(
    task: ClassTaskSnapshot,
    filePath: string,
    sha256: string
  ): Promise<void> {
    return this.options.writer.deleteGeneratedTest({
      workspaceRoot: task.workspaceRoot,
      filePath,
      expectedSha256: sha256
    });
  }

  private atomic<T>(
    taskId: string,
    step: Parameters<ClassTaskCheckpointService['beginAtomicStep']>[1],
    operation: () => Promise<T>,
    activeGenerationBatch: ClassTaskActiveGenerationBatch | null = null
  ): Promise<T> {
    return (async () => {
      await this.options.checkpoints.beginAtomicStep(taskId, step, activeGenerationBatch);
      try {
        return await operation();
      } finally {
        await this.options.checkpoints.completeAtomicStep(taskId, step);
      }
    })();
  }

  private recordModelCall(input: {
    task: ClassTaskSnapshot;
    pages: readonly SingleMethodWorkBatch[];
    groupMethodId: string;
    groupBatchId: string;
    sessionId: string;
    callId: string;
    phase: 'started' | 'completed' | 'failed' | 'stopped';
    startedAt: string;
    modelName: string;
    prompt: string | null;
    rawOutput: string | null;
    processedOutput: string | null;
    usage: Awaited<ReturnType<AiClient['generateUnitTestPrompt']>>['usage'];
    processingValid: boolean | null;
    errorCode?: string | null;
    errorType?: string | null;
    parentCallId?: string | null;
    callKind?: 'generation' | 'repair';
    repairAttempt?: number;
    candidateVersion?: number;
  }): Promise<void> {
    const occurredAt = new Date().toISOString();
    return this.options.logs.record({
      taskId: input.task.id,
      className: basename(input.task.sourceFilePath, '.java'),
      qualifiedClassName: input.task.qualifiedClassName,
      methodId: input.groupMethodId,
      methodName: `批量方法(${input.pages.length})`,
      descriptor: input.pages.map((page) => page.method.descriptor).join(', '),
      displaySignature: input.pages.map((page) => page.method.methodName).join(', '),
      modifiers: ['public'],
      batchId: input.groupBatchId,
      batchIndex: 1,
      event: {
        sessionId: input.sessionId,
        eventSequence: input.phase === 'started' ? 1 : 2,
        eventType: 'model_call',
        occurredAt,
        progress: null,
        candidate: null,
        completion: null,
        error: null,
        modelCall: {
          sessionId: input.sessionId,
          callId: input.callId,
          parentCallId: input.parentCallId ?? null,
          phase: input.phase,
          callKind: input.callKind ?? 'generation',
          methodId: input.groupMethodId,
          batchId: input.groupBatchId,
          batchIndex: 1,
          repairAttempt: input.repairAttempt ?? 0,
          candidateVersion: input.candidateVersion ?? 1,
          modelName: input.modelName,
          startedAt: input.startedAt,
          occurredAt,
          systemPrompt: null,
          userPrompt: input.prompt,
          rawOutput: input.rawOutput,
          processedOutput: input.processedOutput,
          processingValid: input.processingValid,
          usage: input.usage,
          errorCode: input.errorCode ?? null,
          statusCode: null,
          errorType: input.errorType ?? null,
          providerCode: null,
          truncated: false
        }
      }
    });
  }
}

function modelFailureCode(error: unknown, stopped: boolean): string {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
    return code;
  }
  return stopped ? 'MODEL_CALL_STOPPED' : 'MODEL_CALL_FAILED';
}

function modelFailureType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim().slice(0, 128);
  }
  return typeof error;
}

function dataClassCandidateIsolationPath(
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

function groupExecutionPassed(
  execution: CandidateExecutionFeedback,
  expectedTests: number
): boolean {
  const report = execution.testReport;
  return execution.status === 'passed'
    && report !== undefined
    && report.failures === 0
    && report.errors === 0
    && report.generatedTests >= expectedTests
    && report.generatedSkipped === 0;
}

function countMappedTests(methodsByPage: ReadonlyMap<string, readonly string[]>): number {
  let count = 0;
  for (const names of methodsByPage.values()) count += names.length;
  return count;
}

function writtenGroupCandidate(
  candidate: ManagedGroupCandidate,
  pages: readonly SingleMethodWorkBatch[],
  methodsByPage: ReadonlyMap<string, readonly string[]>,
  candidateVersion: number
): WrittenGroupCandidate {
  return {
    filePath: candidate.filePath,
    sha256: candidate.sha256,
    candidateVersion,
    methods: pages.map((page) => ({
      methodId: page.methodId,
      page,
      ordinaryTestMethodCount: methodsByPage.get(page.methodId)?.length ?? 0
    }))
  };
}

function qualifiedName(packageName: string, testClassName: string): string {
  return packageName ? `${packageName}.${testClassName}` : testClassName;
}

function renderDataClassRepairPrompt(input: {
  generationPrompt: string;
  code: string;
  diagnostic: MavenRepairDiagnostic;
  structure: JavaTestStructureService;
  outputTestClassName: string;
  repairAttempt: number;
  validationFailure: string | null;
}): string {
  const annotatedCode = annotateDataClassRepairCode(
    input.code,
    input.diagnostic,
    input.structure
  );
  return [
    input.generationPrompt.trimEnd(),
    '',
    '## 修复要求',
    '',
    `- 当前是第 ${input.repairAttempt} 轮修复，只修复当前测试源码中的 Maven/Surefire 错误，不重新生成测试。`,
    `- 输出类必须仍为 \`${input.outputTestClassName}\`，package 不变。`,
    '- 保留全部测试方法及其原有名称和顺序；不得删除、重命名、合并、拆分、注释或禁用测试方法。',
    '- `[本轮错误]` 后的文本直接来自最新 Maven/Surefire 诊断。只修复这些错误，输出时删除全部 `[本轮错误]` 注释。',
    '- 只输出修复后的完整 Java 测试文件。',
    ...(input.validationFailure
      ? [
          '',
          '上一轮模型输出未通过候选校验：',
          input.validationFailure
        ]
      : []),
    '',
    '## 当前完整测试源码（含本轮错误注释）',
    '',
    '~~~java',
    annotatedCode.trimEnd(),
    '~~~'
  ].join('\n');
}

function annotateDataClassRepairCode(
  code: string,
  diagnostic: MavenRepairDiagnostic,
  structure: JavaTestStructureService
): string {
  const methods = structure.findTestMethods(code);
  const annotations = new Map<number, string[]>();
  const add = (line: number, message: string): void => {
    const normalized = sanitizePublicText(message).replace(/\s+/gu, ' ').trim();
    if (!Number.isSafeInteger(line) || line < 1 || !normalized) return;
    const values = annotations.get(line) ?? [];
    if (!values.includes(normalized)) values.push(normalized);
    annotations.set(line, values);
  };
  for (const error of diagnostic.compilerErrors) {
    add(error.line, error.message);
  }
  for (const exception of diagnostic.exceptions) {
    const method = testMethodByDiagnosticName(methods, exception.testName);
    const line = exception.testLocation?.sourceLine ?? method?.startLine;
    if (!line) continue;
    const message = [exception.type, exception.message]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(': ');
    add(line, message);
  }

  const lines = code.split(/\r\n|\r|\n/u);
  for (const [line, messages] of [...annotations.entries()].sort((left, right) => (
    right[0] - left[0]
  ))) {
    const sourceLine = lines[line - 1] ?? '';
    const indentation = /^[\t ]*/u.exec(sourceLine)?.[0] ?? '';
    lines.splice(
      Math.min(line - 1, lines.length),
      0,
      ...messages.map((message) => `${indentation}// [本轮错误] ${message}`)
    );
  }
  return lines.join('\n');
}

function testMethodByDiagnosticName(
  methods: readonly { name: string; startLine: number }[],
  diagnosticName: string | null
): { name: string; startLine: number } | null {
  if (!diagnosticName) return null;
  const exact = methods.find((method) => method.name === diagnosticName);
  if (exact) return exact;
  return methods.find((method) => (
    diagnosticName.startsWith(`${method.name}(`)
    || diagnosticName.startsWith(`${method.name}[`)
  )) ?? null;
}

function requireSameRepairTestIdentities(
  previousCode: string,
  repairedCode: string,
  structure: JavaTestStructureService
): void {
  const previous = structure.findTestMethods(previousCode).map((method) => method.name);
  const repaired = structure.findTestMethods(repairedCode).map((method) => method.name);
  if (
    previous.length !== repaired.length
    || previous.some((name, index) => repaired[index] !== name)
  ) {
    throw new Error(
      '修复候选必须保留全部测试方法及其原有名称和顺序。'
    );
  }
}

function mapBatchCandidateMethods(
  code: string,
  pages: readonly SingleMethodWorkBatch[],
  structure: JavaTestStructureService,
  requireEveryPage: boolean
): Map<string, string[]> {
  const methods = structure.findTestMethods(code);
  const prefixes = pages.map((page, index) => batchTestMethodPrefix(page, index));
  if (methods.some((method) => !prefixes.some((prefix) => method.name.startsWith(prefix)))) {
    throw new Error('Batch candidate contains an unmapped test method.');
  }
  const result = new Map<string, string[]>();
  for (let index = 0; index < pages.length; index += 1) {
    const names = methods
      .filter((method) => method.name.startsWith(prefixes[index]))
      .map((method) => method.name);
    if (requireEveryPage && names.length === 0) {
      throw new Error(`Batch candidate prefix ${prefixes[index]} has an invalid test count.`);
    }
    result.set(pages[index].methodId, names);
  }
  return result;
}

function dataClassMavenFailureMessage(execution: CandidateExecutionFeedback): string {
  const failureDetails = execution.testReport?.failureDetails.flatMap((failure) => {
    const headline = [failure.type, failure.message]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(': ');
    return [headline, failure.detail ?? ''].filter(Boolean);
  }) ?? [];
  const latest = execution.mavenExecutions.at(-1);
  const values = [
    ...failureDetails,
    latest?.stderr ?? '',
    latest?.stdout ?? ''
  ].map((value) => sanitizePublicText(value).trim()).filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length > 0) return unique.join('\n').slice(0, 16_384);
  return `Maven execution failed with status ${execution.status}.`;
}

/**
 * Packs selected data-class methods without splitting by scenario volume.
 *
 * A source method stays atomic. Methods that cannot safely use the batch fast
 * path are represented as singleton batches so callers can preserve the
 * existing single-method workflow without reordering anything.
 */
export function planDataClassGenerationBatches(
  input: PlanDataClassGenerationBatchesInput
): DataClassGenerationBatch[] {
  requireUniqueNonEmpty(input.methodOrder, 'method order');
  const facts = new Map(input.facts.map((fact) => [fact.methodId, fact]));
  if (facts.size !== input.facts.length) {
    throw new Error('Data-class generation facts contain duplicate method IDs.');
  }

  if (!DATA_CLASS_KINDS.has(input.classKind)) {
    return input.methodOrder.map((methodId) => singletonBatch(methodId));
  }

  const result: DataClassGenerationBatch[] = [];
  let pending: DataClassMethodGenerationFact[] = [];
  let pendingScenarios = 0;
  let pendingTests = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    result.push({
      methodIds: pending.map((fact) => fact.methodId),
      scenarioCount: pendingScenarios,
      plannedTestMethods: pendingTests,
      fastPath: pending.length > 1 || input.methodOrder.length === 1
    });
    pending = [];
    pendingScenarios = 0;
    pendingTests = 0;
  };

  for (const methodId of input.methodOrder) {
    const fact = facts.get(methodId);
    if (!fact || !isBatchEligible(fact, input.classKind)) {
      flush();
      result.push(singletonBatch(methodId, fact));
      continue;
    }
    const scenarioCount = scenarioWeight(fact);
    pending.push(fact);
    pendingScenarios += scenarioCount;
    pendingTests += fact.plannedTestMethods;
  }
  flush();
  return result;
}

function isBatchEligible(
  fact: DataClassMethodGenerationFact,
  classKind: string
): boolean {
  const lombokContract = isLombokGeneratedContract(fact, classKind);
  return Boolean(fact.methodId)
    && isDataClassMethod(fact, classKind)
    && (
      fact.modifiers.includes('public')
      || (
        lombokContract
        && fact.methodName === 'canEqual'
        && fact.modifiers.includes('protected')
      )
    )
    && !fact.modifiers.some((modifier) => (
      modifier === 'static'
      || modifier === 'abstract'
      || modifier === 'native'
      || modifier === 'synchronized'
    ))
    && nonNegativeInteger(fact.scenarioCount)
    && positiveIntegerOrFalse(fact.plannedTestMethods)
    && fact.remainingTestMethods === 0
    && (
      fact.requiredCallCount === 0
      || lombokContract
    )
    && fact.activeStubCount === 0
    && positiveIntegerOrFalse(fact.sourceCharacterCount);
}

function isDataClassMethod(
  fact: DataClassMethodGenerationFact,
  classKind: string
): boolean {
  const descriptor = fact.descriptor;
  const parameterDescriptor = descriptor.startsWith('(')
    ? descriptor.slice(1, descriptor.indexOf(')'))
    : '';
  const returnDescriptor = descriptor.includes(')')
    ? descriptor.slice(descriptor.indexOf(')') + 1)
    : '';
  if (fact.methodName === '<init>') return returnDescriptor === 'V';
  if (isLombokGeneratedContract(fact, classKind)) return true;
  if (
    fact.methodName.startsWith('get')
    && fact.methodName.length > 3
  ) {
    return fact.parameterCount === 0
      && parameterDescriptor === ''
      && returnDescriptor !== ''
      && returnDescriptor !== 'V';
  }
  if (
    fact.methodName.startsWith('is')
    && fact.methodName.length > 2
  ) {
    return fact.parameterCount === 0
      && parameterDescriptor === ''
      && (returnDescriptor === 'Z' || returnDescriptor === 'Ljava/lang/Boolean;');
  }
  if (
    fact.methodName.startsWith('set')
    && fact.methodName.length > 3
  ) {
    return fact.parameterCount === 1
      && parameterDescriptor !== ''
      && returnDescriptor === 'V';
  }
  return false;
}

function isLombokGeneratedContract(
  fact: Pick<
    DataClassMethodGenerationFact,
    'methodName' | 'descriptor' | 'parameterCount' | 'lombokGenerated'
  >,
  classKind: string
): boolean {
  if (classKind !== 'DATA_LOMBOK' || !fact.lombokGenerated) return false;
  return (
    fact.methodName === 'equals'
    && fact.descriptor === '(Ljava/lang/Object;)Z'
    && fact.parameterCount === 1
  ) || (
    fact.methodName === 'hashCode'
    && fact.descriptor === '()I'
    && fact.parameterCount === 0
  ) || (
    fact.methodName === 'toString'
    && fact.descriptor === '()Ljava/lang/String;'
    && fact.parameterCount === 0
  ) || (
    fact.methodName === 'canEqual'
    && fact.descriptor === '(Ljava/lang/Object;)Z'
    && fact.parameterCount === 1
  );
}

function singletonBatch(
  methodId: string,
  fact?: DataClassMethodGenerationFact
): DataClassGenerationBatch {
  return {
    methodIds: [methodId],
    scenarioCount: fact ? scenarioWeight(fact) : 0,
    plannedTestMethods: fact?.plannedTestMethods ?? 0,
    fastPath: false
  };
}

function scenarioWeight(fact: DataClassMethodGenerationFact): number {
  return Math.max(1, fact.scenarioCount, fact.plannedTestMethods);
}

function positiveIntegerOrFalse(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireUniqueNonEmpty(values: readonly string[], name: string): void {
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    throw new Error(`Data-class generation ${name} is invalid.`);
  }
}

function factFromPage(page: SingleMethodWorkBatch): DataClassMethodGenerationFact {
  return {
    methodId: page.methodId,
    methodName: page.method.methodName,
    descriptor: page.method.descriptor,
    parameterCount: page.method.parameterTypes.length,
    modifiers: [...page.method.modifiers],
    scenarioCount: Math.max(1, page.scenarios.length),
    plannedTestMethods: page.plannedTestMethods,
    remainingTestMethods: page.remainingTestMethods,
    requiredCallCount: page.methodStubInventory.requiredCallCount,
    activeStubCount: page.activeStubPlans.length,
    sourceCharacterCount: page.method.completeMethodSource.length,
    lombokGenerated: isLombokGeneratedSource(page.method.completeMethodSource)
  };
}

function isLombokGeneratedSource(source: string): boolean {
  return /Lombok(?:\/注解处理器)?生成的方法|Lombok generated/i.test(source);
}

function groupKey(methodIds: readonly string[]): string {
  return methodIds.join('\0');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function renderBatchPrompt(input: {
  task: ClassTaskSnapshot;
  context: DataClassGenerationBatchContext;
  classKind: string;
  pages: readonly SingleMethodWorkBatch[];
  outputTestClassName: string;
}): string {
  const classStructure = (
    input.pages[0]?.targetFixturePlan.targetClassDeclaration ?? ''
  ).trim();
  const methodLines = input.pages.flatMap((page, index) => {
    const lines = [
      `${index + 1}. 测试名以 \`${batchTestMethodPrefix(page, index)}\` 开头｜\`${dataClassMethodSignature(page)}\``
    ];
    if (input.classKind !== 'DATA_LOMBOK') {
      lines.push(`   源码：\`${inlineMethodSource(page.method.completeMethodSource)}\``);
    }
    lines.push('');
    return lines;
  });
  const enumLines = dataClassEnumLines(input.pages);
  const realObjectLines = dataClassRealObjectLines(input.pages, input.classKind);
  const sourceHeading = input.classKind === 'DATA_LOMBOK'
    ? '## 生产源码（完整）'
    : '## 生产类声明';
  const lines = [
    '## 生成目标',
    '',
    `- 生产类：${input.task.qualifiedClassName}`,
    `- 输出 package：${input.context.packageName || '(default package)'}`,
    `- 输出测试类：${input.outputTestClassName}`,
    `- 只为下列 ${input.pages.length} 个已选方法生成测试并保持所选顺序；每个已选方法至少生成 1 个普通 \`@Test\`。`,
    '- 覆盖矩阵包含多个独立情况时，应使用同一方法前缀生成多个 `@Test`；不得为了匹配固定数量而合并或省略情况。',
    '- 不得为未列出的方法生成独立 `@Test`，包括未选中的 Getter、Setter、equals、hashCode、toString 和 canEqual。',
    '- 使用 JUnit 5 和真实生产对象；不得 Mock、Spy、Stub、复制或修改生产类。',
    '- 每个测试名称必须使用所属方法前缀；其他真实方法只能准备或观察状态。',
    '- 断言可观察结果；不得只验证不抛异常、非空或对象自反性，不得猜测新 API。',
    '- 只输出完整 Java 测试文件。',
    '',
    sourceHeading,
    '',
    '~~~java',
    classStructure,
    '~~~',
    '',
    ...(input.classKind === 'DATA_LOMBOK'
      ? ['Lombok 生成的方法没有生产源码方法体，以上源码结构是唯一依据。', '']
      : []),
    '## 本次选中的方法',
    '',
    ...methodLines,
    '## 非 Getter/Setter 覆盖矩阵',
    '',
    ...dataClassNonAccessorCoverageLines(input.pages),
    '',
    '## Getter/Setter 快速规则',
    '',
    ...dataClassAccessorCoverageLines(input.pages, input.classKind),
    '',
    '## 三、枚举',
    '',
    ...(enumLines.length > 0 ? enumLines : ['- 无额外枚举信息。']),
    '',
    '## 四、真实对象',
    '',
    ...realObjectLines,
    '',
    '## 五、调用信息',
    '',
    '### 外部对象',
    '',
    '- 无外部对象调用。'
  ];
  return lines.join('\n');
}

function dataClassMethodSignature(page: SingleMethodWorkBatch): string {
  const modifiers = page.method.modifiers.join(' ');
  const parameters = page.method.parameterTypes.join(', ');
  const throwsClause = page.method.declaredExceptions.length > 0
    ? ` throws ${page.method.declaredExceptions.join(', ')}`
    : '';
  const name = page.method.methodName === '<init>'
    ? page.method.declaringType.split('.').at(-1) ?? page.method.methodName
    : page.method.methodName;
  const returnType = page.method.methodName === '<init>'
    ? ''
    : `${page.method.returnType} `;
  return `${modifiers ? `${modifiers} ` : ''}${returnType}${name}(${parameters})${throwsClause}`;
}

function dataClassNonAccessorCoverageLines(
  pages: readonly SingleMethodWorkBatch[]
): string[] {
  const names = new Set(
    pages
      .filter((page) => !isDataClassAccessor(page))
      .map((page) => page.method.methodName)
  );
  const lines: string[] = [];
  if (names.has('equals')) {
    lines.push(
      '- `equals`：JaCoCo 指令覆盖率和分支覆盖率均达到 100%。使用最小对象矩阵覆盖 self、null、不同类型、全字段非 null 且相等、全字段为 null 且相等；每个字段分别作为第一个不相等字段，只补左 null、右非 null，以及两个不同的非 null 值。若存在 canEqual 协议，再用测试类内最小子类让 equals 内部的 canEqual 返回 false。禁止展开字段组合的笛卡尔积。'
    );
  }
  if (names.has('hashCode')) {
    lines.push(
      '- `hashCode`：JaCoCo 指令覆盖率和分支覆盖率均达到 100%。覆盖全字段为 null、全字段为非 null，并验证字段状态相同的两个真实对象产生相同哈希值。'
    );
  }
  if (names.has('toString')) {
    lines.push(
      '- `toString`：只准备一组代表值，断言结果包含可观察的字段名和字段值。'
    );
  }
  if (names.has('canEqual')) {
    lines.push(
      '- `canEqual`：同类型对象为 true，不同类型对象和 null 为 false。'
    );
  }
  if (names.has('<init>')) {
    lines.push(
      '- 构造器：按参数构造真实对象，通过现有可观察访问器验证字段状态。'
    );
  }
  for (const name of names) {
    if (['equals', 'hashCode', 'toString', 'canEqual', '<init>'].includes(name)) continue;
    lines.push(`- \`${name}\`：调用该方法并断言其可观察结果。`);
  }
  return lines.length > 0 ? lines : ['- 本批次没有非 Getter/Setter 方法。'];
}

function dataClassAccessorCoverageLines(
  pages: readonly SingleMethodWorkBatch[],
  classKind: string
): string[] {
  const setters = pages.filter(isDataClassSetter);
  const getters = pages.filter(isDataClassGetter);
  const lines: string[] = [];
  if (setters.length > 0) {
    lines.push(
      '- setter：新建对象，调用 setter 写入一个代表值；存在对应 getter 时只断言该 getter 的返回值。所有 setter 共用本规则，不逐字段展开。'
    );
    if (classKind === 'DATA_SETTER_ONLY') {
      lines.push(
        '- 不存在可观察读取接口时不得猜测 getter；只验证生产源码实际支持的可观察结果。'
      );
    }
  }
  if (getters.length > 0) {
    lines.push(
      '- getter：通过已有 setter 或构造器准备一个代表值；仅使用生产源码明确支持的 setter 或构造器准备字段状态，再断言返回值。所有 getter 共用本规则，不逐字段展开。'
    );
  }
  return lines.length > 0 ? lines : ['- 本批次没有 Getter/Setter 方法。'];
}

function isDataClassSetter(page: SingleMethodWorkBatch): boolean {
  return page.method.methodName.startsWith('set')
    && page.method.parameterTypes.length === 1;
}

function isDataClassGetter(page: SingleMethodWorkBatch): boolean {
  return (
    page.method.methodName.startsWith('get')
    || page.method.methodName.startsWith('is')
  ) && page.method.parameterTypes.length === 0;
}

function isDataClassAccessor(page: SingleMethodWorkBatch): boolean {
  return isDataClassSetter(page) || isDataClassGetter(page);
}

function dataClassEnumLines(pages: readonly SingleMethodWorkBatch[]): string[] {
  const signatureTypes = new Set(pages.flatMap((page) => [
    ...page.method.parameterTypes,
    page.method.returnType
  ]));
  const byName = new Map<string, SingleMethodWorkBatch['referencedTypes'][number]>();
  for (const page of pages) {
    for (const type of page.referencedTypes) {
      if (
        type.qualifiedName.startsWith('java.')
        || ![...signatureTypes].some((value) => value.includes(type.qualifiedName))
      ) continue;
      if (!byName.has(type.qualifiedName)) byName.set(type.qualifiedName, type);
    }
  }
  return [...byName.values()].flatMap((type) => {
    const simpleName = type.qualifiedName.replaceAll('$', '.').split('.').at(-1)
      ?? type.qualifiedName;
    if (type.kind === 'ENUM' && type.enumConstants.length > 0) {
      return [`- ${simpleName}：${type.enumConstants.join('、')}`];
    }
    return [];
  });
}

function dataClassRealObjectLines(
  pages: readonly SingleMethodWorkBatch[],
  classKind: string
): string[] {
  const first = pages[0];
  if (!first) return ['- 无。'];
  const targetClass = first.targetFixturePlan.targetClass;
  const simpleName = targetClass.replaceAll('$', '.').split('.').at(-1) ?? targetClass;
  const constructorTypes = first.targetFixturePlan.constructorParameterTypes ?? [];
  const construction = constructorTypes.length === 0
    ? `new ${simpleName}()`
    : `${simpleName}(${constructorTypes.map(simpleJavaType).join(', ')})`;
  const setters = new Set<string>();
  const calls = new Set<string>();
  for (const page of pages) {
    const method = compactMethodSignature(page);
    if (page.method.methodName.startsWith('set')) {
      setters.add(method);
      if (classKind === 'DATA_LOMBOK') {
        const suffix = page.method.methodName.slice(3);
        calls.add(`get${suffix}()`);
      }
      continue;
    }
    calls.add(method);
  }
  const details = [
    setters.size > 0 ? `可设置：${[...setters].join('、')}` : '',
    calls.size > 0 ? `可调用：${[...calls].join('、')}` : ''
  ].filter(Boolean).join('；');
  return [`- ${simpleName}：${construction}${details ? `；${details}` : ''}`];
}

function compactMethodSignature(page: SingleMethodWorkBatch): string {
  return `${page.method.methodName}(`
    + `${page.method.parameterTypes.map(simpleJavaType).join(', ')})`;
}

function simpleJavaType(value: string): string {
  const arraySuffix = value.endsWith('[]') ? '[]' : '';
  const base = arraySuffix ? value.slice(0, -2) : value;
  return `${base.replaceAll('$', '.').split('.').at(-1) ?? base}${arraySuffix}`;
}

function inlineMethodSource(source: string): string {
  return source.trim().replace(/\r?\n[\t ]*/g, ' ').replaceAll('`', '\\`');
}

function methodKey(index: number): string {
  return `m${String(index + 1).padStart(2, '0')}`;
}

function batchTestMethodPrefix(page: SingleMethodWorkBatch, index: number): string {
  const methodName = page.method.methodName === '<init>'
    ? 'constructor'
    : page.method.methodName.replace(/[^A-Za-z0-9_$]/g, '_');
  return `${methodKey(index)}_${methodName}`;
}

function stripJavaCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:java)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim() + '\n';
}

function validateBatchCandidate(
  code: string,
  outputTestClassName: string,
  packageName: string,
  pages: readonly SingleMethodWorkBatch[],
  structure: JavaTestStructureService
): Map<string, string[]> {
  if (!code.trim() || Buffer.byteLength(code, 'utf8') > 1024 * 1024) {
    throw new Error('Batch candidate Java source is empty or oversized.');
  }
  const sanitized = sanitizeJava(code);
  const type = new RegExp(
    `\\bclass\\s+${escapeRegExp(outputTestClassName)}\\b[^{};]*\\{`
  ).exec(sanitized);
  if (!type) throw new Error('Batch candidate test class name is invalid.');
  const opening = type.index + type[0].lastIndexOf('{');
  const closing = matchingBrace(sanitized, opening);
  if (closing < 0 || sanitized.slice(closing + 1).trim()) {
    throw new Error('Batch candidate Java source is truncated.');
  }
  const packageMatch = /^[\t ]*package[\t ]+([^;\r\n]+);/m.exec(sanitized);
  if ((packageMatch?.[1].trim() ?? '') !== packageName) {
    throw new Error('Batch candidate package does not match the target class.');
  }
  const methods = structure.findTestMethods(code);
  const byMethodId = new Map<string, string[]>();
  const allowedPrefixes = pages.map((page, index) => batchTestMethodPrefix(page, index));
  for (let index = 0; index < pages.length; index += 1) {
    const prefix = allowedPrefixes[index];
    const names = methods.filter((method) => method.name.startsWith(prefix))
      .map((method) => method.name);
    if (names.length === 0) {
      throw new Error(`Batch candidate prefix ${prefix} has an invalid test count.`);
    }
    byMethodId.set(pages[index].methodId, names);
  }
  if (methods.some((method) => !allowedPrefixes.some((prefix) => method.name.startsWith(prefix)))) {
    throw new Error('Batch candidate contains an unmapped test method.');
  }
  return byMethodId;
}

function selectTestMethods(
  code: string,
  selectedNames: ReadonlySet<string>,
  structure: JavaTestStructureService
): string {
  const methods = structure.findTestMethods(code);
  if (
    methods.filter((method) => selectedNames.has(method.name)).length !== selectedNames.size
  ) {
    throw new Error('Batch candidate cannot be split by source method.');
  }
  let selected = code;
  for (const method of [...methods].reverse()) {
    if (selectedNames.has(method.name)) continue;
    selected = selected.slice(0, method.startOffset) + selected.slice(method.endOffset);
  }
  const retained = structure.findTestMethods(selected);
  if (
    retained.length !== selectedNames.size
    || retained.some((method) => !selectedNames.has(method.name))
  ) {
    throw new Error('Split batch candidate test identities are inconsistent.');
  }
  return selected;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Data-class batch generation was cancelled.');
}
