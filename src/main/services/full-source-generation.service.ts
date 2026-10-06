import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { ClassTaskSnapshot } from '../../shared/class-task-contracts.ts';
import type { AiClient } from './ai-client.ts';
import type { ClassTaskCheckpointService } from './class-task-checkpoint.service.ts';
import type { FullSourceRunCheckpoint } from './full-source-checkpoint.ts';
import { sourceSha256, FULL_SOURCE_SKILL_PROFILE, validateFullSourceFacts, validateStartFullSourceRequest,
  decodeFullSourceCandidate, decodeFullSourceOutputFailure,
  type FullSourceGenerationEvent, type FullSourceGenerationTurn, type FullSourceExecutionOutcome,
  type FullSourceClassFacts } from './full-source-generation-contract.ts';
import { MethodGenerationSessionNotFoundError, MethodGenerationRequestError,
  type CandidateExecutionFeedback } from './method-generation-contract.ts';
import type { SingleMethodGenerationContext } from './single-method-generation.service.ts';
import type { TestWriterService } from './test-writer.service.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';
import type { ClassTaskFileTransactionService } from './class-task-file-transaction.service.ts';
import type { MavenCandidateExecutorService } from './maven-candidate-executor.service.ts';
import type { ExecutableModuleMavenReadyQueue } from './module-maven-ready-queue.service.ts';
import { StableTestRepairService } from './stable-test-repair.service.ts';
import { attributeFullSourceResults, nonValidatingFullSourceTestNames, passedFullSourceTestNames } from './full-source-result-attribution.ts';
import { recoverFullSourceReplacement } from './full-source-file-recovery.ts';
import { resolveFullSourceRepairContext } from './full-source-repair-context.ts';

export type FullSourceGenerationOptions = {
  contextProvider: { resolve(task: ClassTaskSnapshot, signal?: AbortSignal): Promise<SingleMethodGenerationContext> };
  analyzer: Pick<AiClient, 'fullSourceGenerationFacts'> & Partial<Pick<AiClient, 'getMethodRepairContext'>>;
  agent: Pick<AiClient, 'startFullSourceGenerationStream' | 'resumeFullSourceGenerationStream'
    | 'waitFullSourceGenerationTurn' | 'recoverFullSourceGenerationStream'>;
  checkpoints: Pick<ClassTaskCheckpointService, 'saveFullSourceProgress' | 'fullSourceProgress'
    | 'beginAtomicStep' | 'completeAtomicStep' | 'waitIfPausedAtBoundary' | 'throwIfTerminating' | 'recordFullSourceModelCall'>;
  writer: TestWriterService; moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  candidateFiles: Pick<ClassTaskFileTransactionService, 'moveWaveCandidateFiles' | 'recoverWaveCandidateMove'>;
  maven: Pick<MavenCandidateExecutorService, 'execute'>; mavenReadyQueue?: ExecutableModuleMavenReadyQueue;
  stableRepair?: Pick<StableTestRepairService, 'repair'>; skillRulesSha256: string;
  onEvent?: (task: ClassTaskSnapshot, facts: FullSourceClassFacts, event: FullSourceGenerationEvent) => Promise<void>;
};

/** One frozen full-class request; only actual feedback causes another model call. */
export class FullSourceGenerationService {
  private readonly options: FullSourceGenerationOptions;
  constructor(options: FullSourceGenerationOptions) { this.options = options; }

  async execute(task: ClassTaskSnapshot, methodIds: readonly string[], checkpoint: FullSourceRunCheckpoint,
    signal: AbortSignal): Promise<FullSourceExecutionOutcome> {
    const o = this.options;
    let cp = structuredClone(checkpoint);
    if (JSON.stringify(methodIds) !== JSON.stringify(cp.identity.methodIds)) throw new Error('完整源码选择已冻结。');
    if (cp.initialCallState === 'ISSUED' && !cp.sessionId && !cp.candidate && !cp.outputFailure) {
      throw new MethodGenerationRequestError('INITIAL_GENERATION_RECOVERY_UNAVAILABLE', '首次请求已发出，但没有可恢复的会话或候选。');
    }
    const context = await o.contextProvider.resolve(task, signal);
    if (cp.batch && cp.batch.facts.sourceSha256 !== context.sourceSha256) {
      throw new Error('冻结的完整源码已变化，不能继续同一次生成请求。');
    }
    const save = async (next: FullSourceRunCheckpoint): Promise<void> => {
      cp = await o.checkpoints.saveFullSourceProgress(task.id, next);
    };
    const boundary = async (): Promise<void> => {
      if (signal.aborted) throw signal.reason;
      o.checkpoints.throwIfTerminating(task.id);
      await o.checkpoints.waitIfPausedAtBoundary(task.id);
    };
    if (!cp.batch) {
      await boundary();
      await o.checkpoints.beginAtomicStep(task.id, 'ANALYZE_METHOD');
      let facts: FullSourceClassFacts;
      try {
        facts = validateFullSourceFacts(await o.analyzer.fullSourceGenerationFacts(context.analysisSessionId, {
          reportPairId: cp.identity.reportPairId, selectedMethodIds: [...methodIds]
        }, signal), { reportPairId: cp.identity.reportPairId, methodIds });
        if (facts.sourceSha256 !== context.sourceSha256 || facts.declaringType !== task.qualifiedClassName) {
          throw new Error('完整源码分析源身份已变化。');
        }
        await save({ ...cp, batch: { kind: 'full_source', contractVersion: 1, batchId: facts.factsId,
          methodId: facts.methods[0].methodId, facts, skillProfileId: FULL_SOURCE_SKILL_PROFILE,
          skillRulesSha256: o.skillRulesSha256 } });
      } finally { await o.checkpoints.completeAtomicStep(task.id, 'ANALYZE_METHOD'); }
    }
    const facts = cp.batch!.facts;
    if (!cp.startRequest) {
      const className = `${basename(task.sourceFilePath, '.java')}TmpFull${cp.clientRequestId.replaceAll('-', '')}Test`;
      const request = validateStartFullSourceRequest({ clientRequestId: cp.clientRequestId, classTaskId: task.id,
        methodId: cp.batch!.methodId, batchId: cp.batch!.batchId, batchIndex: 1,
        outputTestClassName: className, expectedPackageName: context.packageName,
        buildToolchain: context.buildToolchain, batch: cp.batch, captureModelCalls: context.captureModelCalls,
        repairAttemptLimit: cp.identity.repairAttemptLimit, unlimitedRepair: cp.identity.unlimitedRepair });
      await save({ ...cp, startRequest: request });
    }
    const request = cp.startRequest!;
    const className = request.outputTestClassName;
    const qualifiedName = request.expectedPackageName ? `${request.expectedPackageName}.${className}` : className;
    const taskHash = sourceSha256(task.id).slice(0, 24);
    const isolatedPath = (candidateId: string): string => join(task.workspaceRoot, '.ai-unit-test', 'full-source-candidates',
      taskHash, candidateId, `${className}.java`);
    const projectPath = join(task.workspaceRoot, dirname(context.plannedRelativeTestPath), `${className}.java`);
    const onEvent = async (event: FullSourceGenerationEvent): Promise<void> => {
      if (event.sessionId === cp.sessionId && event.eventSequence <= cp.eventSequence) return;
      if (event.modelCall && ['completed','failed','stopped'].includes(event.modelCall.phase)) {
        cp = await o.checkpoints.recordFullSourceModelCall(task.id, event.modelCall);
      }
      const update = { ...cp, sessionId: event.sessionId, eventSequence: event.eventSequence };
      if (event.candidate) {
        const candidate = decodeFullSourceCandidate(event.candidate);
        update.candidate = candidate; update.lastValidCandidate = candidate; update.outputFailure = null;
        update.repairAttemptsUsed = candidate.repairAttempt; update.initialCallState = 'RESULT_RECEIVED';
        update.pendingFeedback = null; update.execution = null;
      } else if (event.outputInvalid) {
        const failure = decodeFullSourceOutputFailure(event.outputInvalid);
        update.outputFailure = failure; update.candidate = null; update.pendingFeedback = null;
        update.repairAttemptsUsed = failure.repairAttempt; update.initialCallState = 'RESULT_RECEIVED';
      } else if (event.completion) { update.completion = event.completion; update.pendingFeedback = null; }
      if (event.modelCall?.phase === 'started') update.repairAttemptsUsed = event.modelCall.repairAttempt;
      await save(update);
      await o.onEvent?.(task, facts, event);
    };
    const acceptTurn = async (turn: FullSourceGenerationTurn): Promise<void> => {
      if (turn.sessionId === cp.sessionId && turn.eventSequence <= cp.eventSequence) return;
      await onEvent({ sessionId: turn.sessionId, eventSequence: turn.eventSequence,
        eventType: turn.kind, occurredAt: new Date().toISOString(), progress: null,
        candidate: turn.kind === 'candidate_ready' ? turn.candidate : null,
        outputInvalid: turn.kind === 'output_invalid' ? turn.outputInvalid : null,
        completion: turn.kind === 'completed' ? turn.completion : null, error: null, modelCall: null });
    };
    const modelTurn = async (kind: 'start' | 'resume' | 'wait'): Promise<void> => {
      await boundary();
      const stage = kind === 'start' ? 'MODEL_GENERATION' : 'MODEL_REPAIR';
      await o.checkpoints.beginAtomicStep(task.id, stage);
      try {
        if (kind === 'start') await save({ ...cp, initialCallState: 'ISSUED' });
        const turn = kind === 'start' ? await o.agent.startFullSourceGenerationStream(request, context.modelContext, onEvent, signal)
          : kind === 'resume' ? await o.agent.resumeFullSourceGenerationStream(cp.sessionId!, cp.pendingFeedback!,
            request, context.modelContext, onEvent, signal)
          : await o.agent.waitFullSourceGenerationTurn(cp.sessionId!, cp.eventSequence, request, onEvent, signal);
        await acceptTurn(turn);
      } catch (error) {
        if (!(error instanceof MethodGenerationSessionNotFoundError) || !cp.candidate || cp.outputFailure) throw error;
        const recovered = await o.agent.recoverFullSourceGenerationStream(request, cp.candidate,
          context.modelContext, onEvent, signal);
        await acceptTurn(recovered);
      } finally { await o.checkpoints.completeAtomicStep(task.id, stage); }
    };
    const loadSource = async (): Promise<string> => {
      if (!cp.managedFile) throw new Error('候选源文件未登记。');
      return o.writer.loadOwnedGeneratedTest({ workspaceRoot: task.workspaceRoot,
        filePath: cp.managedFile.path, expectedSha256: cp.managedFile.sha256 });
    };
    const replace = async (code: string): Promise<void> => {
      if (!cp.managedFile) throw new Error('候选源文件未登记。');
      if (cp.publication?.phase === 'VERIFIED') throw new Error('已验证发布不能修改候选源。');
      const prepared = o.writer.prepareReplacement({ workspaceRoot: task.workspaceRoot, filePath: cp.managedFile.path, content: code });
      await save({ ...cp, pendingReplacement: { originalSha256: cp.managedFile.sha256,
        replacementSha256: prepared.sha256, code: prepared.content }, moveTransaction: null, execution: null,
        publication: null });
      const written = await o.writer.replacePreparedGeneratedTest({ workspaceRoot: task.workspaceRoot,
        filePath: cp.managedFile.path, expectedSha256: cp.managedFile.sha256, prepared });
      await save({ ...cp, managedFile: { ...cp.managedFile, sha256: written.sha256 }, pendingReplacement: null });
    };
    const move = async (location: 'PROJECT' | 'ISOLATED'): Promise<void> => {
      const current = cp.managedFile; if (!current || current.location === location) return;
      const candidateId = (cp.candidate ?? cp.lastValidCandidate)!.candidateId;
      const path = location === 'PROJECT' ? projectPath : isolatedPath(candidateId);
      await o.candidateFiles.moveWaveCandidateFiles({ moves: [{ candidateId,
        workspaceRoot: task.workspaceRoot, testClassName: className, sourcePath: current.path,
        targetPath: path, sha256: current.sha256 }], saveMoveTransactions: async transactions => {
          const t = transactions[0];
          await save({ ...cp, moveTransaction: { sourcePath: t.sourcePath, targetPath: t.targetPath, sha256: t.sha256, phase: t.phase },
            ...(t.phase === 'MOVED' ? { managedFile: { path, sha256: t.sha256, location } } : {}) });
        } });
    };
    const executeMaven = async (direct = false): Promise<CandidateExecutionFeedback> => {
      if (!direct) await boundary();
      const candidate = cp.candidate!;
      const phaseStart = (phase: 'test_compile' | 'test') => o.checkpoints.beginAtomicStep(task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST');
      const phaseComplete = (phase: 'test_compile' | 'test') => o.checkpoints.completeAtomicStep(task.id,
        phase === 'test_compile' ? 'MAVEN_COMPILE' : 'MAVEN_TEST');
      let execution: CandidateExecutionFeedback;
      if (o.mavenReadyQueue && !direct) {
        const queued = await o.mavenReadyQueue.enqueue({ taskId: task.id, moduleKey: task.moduleKey,
          moduleRoot: context.moduleRoot, buildSettings: context.buildSettings,
          environmentFingerprint: context.mavenEnvironmentFingerprint ?? sourceSha256(JSON.stringify(context.buildSettings)),
          candidateId: candidate.candidateId, filePath: projectPath, projectFilePath: projectPath,
          isolationFilePath: isolatedPath(candidate.candidateId), qualifiedTestClassName: qualifiedName, scope: 'method_candidate',
          excludedEnvironmentVariables: context.excludedEnvironmentVariables, onBatchStart: () => {},
          onPhaseStart: phaseStart, onPhaseComplete: phaseComplete, activate: () => move('PROJECT'), isolate: () => move('ISOLATED') });
        if (queued.status === 'unproven') throw new Error('Maven 错误无法归属，已保留候选并停止。');
        execution = { status: queued.status, mavenExecutions: queued.mavenExecutions,
          ...(queued.testReport ? { testReport: queued.testReport } : {}) };
      } else {
        const run = async () => {
          await move('PROJECT');
          return o.maven.execute({ moduleRoot: context.moduleRoot, buildSettings: context.buildSettings,
            attemptId: randomUUID(), qualifiedTestClassName: qualifiedName, scope: direct ? 'pruned_method_candidate' : 'method_candidate',
            signal, excludedEnvironmentVariables: context.excludedEnvironmentVariables,
            onPhaseStart: phaseStart, onPhaseComplete: phaseComplete });
        };
        execution = direct ? await run() : await o.moduleLock.runExclusive(task.moduleKey, run, signal);
      }
      await save({ ...cp, execution });
      return execution;
    };
    if (cp.pendingReplacement && cp.managedFile) {
      await o.moduleLock.runExclusive(task.moduleKey, async () => {
        cp = await recoverFullSourceReplacement(task.workspaceRoot, cp, o.writer,
          next => o.checkpoints.saveFullSourceProgress(task.id, next));
      }, signal);
    }
    if (cp.moveTransaction && cp.managedFile && cp.candidate) {
      const m = cp.moveTransaction;
      const recovered = await o.candidateFiles.recoverWaveCandidateMove({ ...m, candidateId: cp.candidate.candidateId,
        workspaceRoot: task.workspaceRoot, testClassName: className });
      await save({ ...cp, managedFile: { path: recovered.filePath, sha256: recovered.sha256, location: recovered.location }, moveTransaction: null });
    }
    for (;;) {
      await boundary();
      if (cp.completion) break;
      if (cp.initialCallState === 'NOT_ISSUED') {
        await modelTurn('start'); continue;
      }
      if (cp.pendingFeedback) {
        const pending = cp.pendingFeedback;
        if (pending.feedbackKind === 'maven' && pending.execution.status !== 'passed' && !pending.repairContext) {
          const repairContext = await resolveFullSourceRepairContext({ facts, analysisSessionId: context.analysisSessionId,
            sourceFilePath: task.sourceFilePath, generatedTestFilePath: projectPath,
            generatedTestClassName: qualifiedName, effectiveTestCode: pending.effectiveTestCode,
            execution: pending.execution, analyzer: o.analyzer, signal });
          await save({ ...cp, pendingFeedback: { ...pending, repairContext } });
        }
        await modelTurn('resume'); continue;
      }
      if (cp.outputFailure) {
        const f = cp.outputFailure;
        await save({ ...cp, pendingFeedback: { feedbackId: randomUUID(), expectedEventSequence: cp.eventSequence,
          candidateId: f.candidateId, candidateVersion: f.candidateVersion, repairAttempt: f.repairAttempt,
          feedbackKind: 'output_validation', invalidOutput: f.invalidOutput, invalidOutputSha256: f.invalidOutputSha256,
          validationErrors: f.validationErrors } }); continue;
      }
      if (!cp.candidate) { await modelTurn('wait'); continue; }
      const candidate = cp.candidate;
      await o.moduleLock.runExclusive(task.moduleKey, async () => {
        if (!cp.managedFile) {
          const path = isolatedPath(candidate.candidateId);
          const prepared = await o.writer.prepareGeneratedTestAtPlannedLocation({ workspaceRoot: task.workspaceRoot,
            plannedTestClassName: className, plannedRelativeTestPath: relative(task.workspaceRoot, path), content: candidate.testCode });
          try { await o.writer.writePreparedGeneratedTest(prepared); }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
            await o.writer.loadOwnedGeneratedTest({ workspaceRoot: task.workspaceRoot, filePath: path, expectedSha256: prepared.sha256 });
          }
          await save({ ...cp, managedFile: { path, sha256: prepared.sha256, location: 'ISOLATED' } });
        } else if (!cp.execution && cp.managedFile.sha256 !== candidate.generatedCodeSha256
          && cp.stableRepair.phase === 'NOT_STARTED') await replace(candidate.testCode);
        else await loadSource();
      }, signal);
      const execution = cp.execution ?? await executeMaven();
      const code = await loadSource();
      await save({ ...cp, pendingFeedback: { feedbackId: randomUUID(), expectedEventSequence: cp.eventSequence,
        candidateId: candidate.candidateId, candidateVersion: candidate.candidateVersion, repairAttempt: candidate.repairAttempt,
        feedbackKind: 'maven', effectiveTestCode: code, effectiveFileSha256: sourceSha256(code), execution } });
    }
    if (cp.completion!.stopReason === 'repair_exhausted' && !cp.candidate && cp.lastValidCandidate
      && cp.completion!.bestCandidateId === cp.lastValidCandidate.candidateId && cp.managedFile) {
      // An invalid last response does not erase the last accepted Maven base.
      // Retain that response before switching back; the model budget stays spent.
      const directory = dirname(isolatedPath(cp.lastValidCandidate.candidateId));
      await mkdir(directory, { recursive: true });
      if (cp.outputFailure) {
        const path = join(directory, `final-invalid-output-v${cp.outputFailure.candidateVersion}.json`);
        const bytes = JSON.stringify({ taskId: task.id, sessionId: cp.sessionId,
          candidateId: cp.lastValidCandidate.candidateId, repairAttemptsUsed: cp.repairAttemptsUsed,
          outputFailure: cp.outputFailure }, null, 2) + '\n';
        try { await writeFile(path, bytes, { flag: 'wx' }); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
          if (await readFile(path, 'utf8') !== bytes) throw new Error('既有末轮输出审计与当前记录不符。');
        }
      }
      await loadSource();
      if (cp.managedFile.sha256 !== cp.lastValidCandidate.generatedCodeSha256) {
        throw new Error('最后有效候选与保留源 hash 不符，不能自动收尾。');
      }
      await save({ ...cp, candidate: cp.lastValidCandidate, outputFailure: null });
    }
    if (cp.completion!.stopReason !== 'verified' && cp.candidate && cp.managedFile && !cp.execution) {
      await executeMaven();
    }
    if (cp.completion!.stopReason !== 'verified' && cp.candidate && cp.execution && cp.managedFile) {
      await o.moduleLock.runExclusive(task.moduleKey, async () => {
        await move('PROJECT');
        const initialCode = await loadSource();
        const directory = dirname(isolatedPath(cp.candidate!.candidateId));
        const audit = async (record: unknown, suffix: string): Promise<string> => {
          await mkdir(directory, { recursive: true }); const path = join(directory, suffix);
          const bytes = JSON.stringify(record, null, 2) + '\n';
          try { await writeFile(path, bytes, { flag: 'wx' }); }
          catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
            if (await readFile(path, 'utf8') !== bytes) throw new Error('既有失败审计与本次变更冲突。'); }
          return path;
        };
        const result = await (o.stableRepair ?? new StableTestRepairService()).repair({ code: initialCode,
          candidateFilePath: cp.managedFile!.path, generatedTestClassName: qualifiedName, initialExecution: cp.execution!,
          annotatedMemberIds: cp.stableRepair.annotatedMemberIds, initialIteration: cp.stableRepair.iteration, signal,
          findNonValidatingTests: code => nonValidatingFullSourceTestNames(facts, code),
          onBeforeRepairChange: async change => {
            if (sourceSha256(change.code) !== cp.managedFile!.sha256) throw new Error('稳定修复原源 hash 不符。');
            await audit({ taskId: task.id, candidateId: cp.candidate!.candidateId, factsId: facts.factsId,
              sourceCode: change.code, sourceSha256: sourceSha256(change.code), replacementSha256: sourceSha256(change.nextCode),
              execution: change.execution, phase: change.phase, iteration: change.iteration,
              ...(change.reason ? { reason: change.reason } : {}),
              newMemberIds: change.newMemberIds, annotatedMemberIds: change.annotatedMemberIds,
              repairAttemptsUsed: cp.repairAttemptsUsed, repairAttemptLimit: cp.identity.repairAttemptLimit },
            `${sourceSha256(change.code)}.${change.iteration}.stable-repair.json`);
            await save({ ...cp, stableRepair: { phase: change.phase, iteration: change.iteration,
              annotatedMemberIds: [...change.annotatedMemberIds] } });
          },
          onDiscardAbnormalTests: async (methods, execution) => {
            const code = await loadSource(); const evidencePath = await audit({ sourceCode: code, sourceSha256: sourceSha256(code),
              methods, execution, repairAttemptsUsed: cp.repairAttemptsUsed }, `${sourceSha256(code)}.removed-tests.json`);
            await save({ ...cp, deletedTests: [...cp.deletedTests, ...methods.map(m => ({ testName: m.name,
              reason: 'NAMED_120_SECOND_TIMEOUT', evidencePath }))] });
          }, replaceCandidate: replace, executeMaven: () => executeMaven(true),
          saveCheckpoint: async stable => { await save({ ...cp, stableRepair: stable }); } });
        await save({ ...cp, execution: result.execution });
        if (result.status === 'external_project_blocked' && result.blockedScope === 'project') {
          throw new MethodGenerationRequestError('METHOD_GENERATION_PROJECT_BLOCKED', '外部项目错误阻止验证，已保留源和诊断。');
        }
        if (result.status !== 'passed') await move('ISOLATED');
      }, signal);
    }
    if (!cp.candidate || !cp.managedFile || cp.execution?.status !== 'passed') {
      if (cp.managedFile && cp.lastValidCandidate) await o.moduleLock.runExclusive(task.moduleKey, () => move('ISOLATED'), signal);
      const methodOutcomes = facts.methods.map(m => ({ methodId: m.methodId, passedTestNames: [],
        retainedFailureMembers: cp.stableRepair.annotatedMemberIds.filter(id => id.startsWith(`test:${m.testMethodNamePrefix}`)),
        deletedTests: cp.deletedTests.filter(d => d.testName.startsWith(m.testMethodNamePrefix)), status: 'NO_VALID_TEST' as const }));
      await save({ ...cp, methodOutcomes });
      return { candidateIds: cp.lastValidCandidate ? [cp.lastValidCandidate.candidateId] : [], bundles: [], methodOutcomes,
      terminalStatus: cp.lastValidCandidate ? 'RETAINED_FAILURE' : 'FAILED' };
    }
    const code = await loadSource();
    const methodOutcomes = attributeFullSourceResults(facts, code, cp.execution, cp.execution, {
      retainedFailureMembers: cp.stableRepair.annotatedMemberIds, deletedTests: cp.deletedTests });
    await save({ ...cp, methodOutcomes });
    // Packing uses the exact physical JUnit identities. Method outcomes keep
    // the stricter count of real target executions with active assertions.
    const physicalNames = passedFullSourceTestNames(cp.execution);
    const bundles = methodOutcomes.flatMap(outcome => {
      const m = facts.methods.find(m => m.methodId === outcome.methodId)!;
      const passedTestMethods = physicalNames.filter(name => name.startsWith(m.testMethodNamePrefix));
      if (!passedTestMethods.length) return [];
      const catalog = context.methodCatalog?.find(c => c.methodId === m.methodId);
      return [{ methodId: m.methodId, methodName: m.methodName,
        displaySignature: catalog?.displaySignature ?? `${m.methodName}${m.descriptor}`,
        jacocoOrder: catalog?.jacocoOrder ?? facts.methods.indexOf(m), code,
        ordinaryTestMethodCount: passedTestMethods.length, passedTestMethods,
        sourceBatchIds: [cp.candidate!.candidateId], fullSource: { factsId: facts.factsId, candidateId: cp.candidate!.candidateId } }];
    });
    return { candidateIds: [cp.candidate.candidateId], bundles, methodOutcomes,
      terminalStatus: methodOutcomes.every(m => m.status === 'PASSED') ? 'PASSED' : 'RETAINED_FAILURE' };
  }
}
