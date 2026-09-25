import type {
  BuildToolchainSettings,
  CommandResult
} from '../../shared/types.ts';
import type {
  CandidateExecutionFeedback,
  MavenCommandEvidence
} from './method-generation-contract.ts';
import type {
  CommandExecutionOptions
} from './maven-command.ts';
import type {
  ShellService
} from './shell.service.ts';
import {
  MavenBatchDiagnosticAttributionService,
  type MavenBatchAttributionResult,
  type MavenBatchCandidateIdentity
} from './maven-batch-diagnostic-attribution.service.ts';
import type {
  SurefireExecutionReport,
  SurefireReportArtifact,
  SurefireReportService
} from './surefire-report.service.ts';

type MavenEvidenceScope = MavenCommandEvidence['scope'];
export type MavenCandidatePhase = MavenCommandEvidence['phase'];

export type MavenCandidateExecutionInput = {
  moduleRoot: string;
  buildSettings: BuildToolchainSettings;
  attemptId: string;
  qualifiedTestClassName: string;
  scope: MavenEvidenceScope;
  signal?: AbortSignal;
  excludedEnvironmentVariables?: readonly string[];
  onPhaseStart?: (phase: MavenCandidatePhase) => void | Promise<void>;
  onPhaseComplete?: (phase: MavenCandidatePhase) => void | Promise<void>;
};

export type MavenBatchCandidatePlacement = {
  activate: (candidates: readonly MavenBatchCandidateIdentity[]) => Promise<void>;
  isolate: (candidates: readonly MavenBatchCandidateIdentity[]) => Promise<void>;
};

export type MavenBatchCandidateExecutionInput = Omit<
  MavenCandidateExecutionInput,
  'qualifiedTestClassName'
> & {
  candidates: readonly MavenBatchCandidateIdentity[];
  placement: MavenBatchCandidatePlacement;
};

export type MavenBatchCandidateExecutionFeedback = {
  candidateId: string;
  status: CandidateExecutionFeedback['status'] | 'unproven';
  mavenExecutions: MavenCommandEvidence[];
  testReport?: SurefireExecutionReport;
  trace: MavenBatchExecutionTrace;
};

export type MavenBatchExecutionTraceStep = {
  sequence: number;
  candidateIds: string[];
  phase: MavenCandidatePhase;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  surefireReports: Array<{ fileName: string; content: string }>;
  attribution: MavenBatchAttributionResult | null;
  fallback: 'NONE' | 'ISOLATE_ATTRIBUTED_AND_RETRY' | 'INDIVIDUAL';
};

export type MavenBatchExecutionTrace = {
  mavenBatchId: string;
  moduleRoot: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  candidates: MavenBatchCandidateIdentity[];
  steps: MavenBatchExecutionTraceStep[];
  results: Array<{
    candidateId: string;
    status: CandidateExecutionFeedback['status'] | 'unproven';
  }>;
};

type MavenBatchCandidateExecutionResult = Omit<
  MavenBatchCandidateExecutionFeedback,
  'trace'
>;

type MavenBatchExecutionTraceBuilder = Omit<
  MavenBatchExecutionTrace,
  'completedAt' | 'durationMs' | 'results'
>;

/**
 * 对一个已经写入用户项目的候选执行确定性的两阶段 Maven 验证。
 *
 * 该服务不分析 Java 错误，也不决定如何修复；它只返回实际执行的完整
 * 命令、stdout、stderr、Surefire XML 和结构化 Surefire 计数。
 */
export class MavenCandidateExecutorService {
  private readonly shellService: Pick<
    ShellService,
    'runMavenGeneratedTestCompile' | 'runMavenGeneratedSurefireTest'
  >;
  private readonly surefireReportService: Pick<
    SurefireReportService,
    'prepareAttempt' | 'readAttemptArtifacts' | 'parseAttempt'
  >;
  private readonly batchAttribution: MavenBatchDiagnosticAttributionService;

  constructor(
    shellService: Pick<
      ShellService,
      'runMavenGeneratedTestCompile' | 'runMavenGeneratedSurefireTest'
    >,
    surefireReportService: Pick<
      SurefireReportService,
      'prepareAttempt' | 'readAttemptArtifacts' | 'parseAttempt'
    >,
    batchAttribution = new MavenBatchDiagnosticAttributionService()
  ) {
    this.shellService = shellService;
    this.surefireReportService = surefireReportService;
    this.batchAttribution = batchAttribution;
  }

  async executeBatch(
    input: MavenBatchCandidateExecutionInput
  ): Promise<ReadonlyMap<string, MavenBatchCandidateExecutionFeedback>> {
    validateBatchCandidates(input.candidates);
    const startedClock = performance.now();
    const traceBuilder: MavenBatchExecutionTraceBuilder = {
      mavenBatchId: input.attemptId,
      moduleRoot: input.moduleRoot,
      startedAt: new Date().toISOString(),
      candidates: input.candidates.map((candidate) => ({ ...candidate })),
      steps: []
    };
    await input.placement.activate(input.candidates);
    const results = await this.executeBatchCandidates(
      input,
      input.candidates,
      [],
      traceBuilder
    );
    const trace: MavenBatchExecutionTrace = {
      ...traceBuilder,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedClock)),
      results: input.candidates.map((candidate) => {
        const result = results.get(candidate.candidateId);
        if (!result) {
          throw new Error(
            `Maven batch trace has no result for candidate ${candidate.candidateId}.`
          );
        }
        return { candidateId: candidate.candidateId, status: result.status };
      })
    };
    return new Map([...results].map(([candidateId, result]) => [candidateId, {
      ...result,
      trace
    }]));
  }

  private async executeBatchCandidates(
    input: MavenBatchCandidateExecutionInput,
    candidates: readonly MavenBatchCandidateIdentity[],
    priorEvidence: readonly MavenCommandEvidence[],
    trace: MavenBatchExecutionTraceBuilder
  ): Promise<ReadonlyMap<string, MavenBatchCandidateExecutionResult>> {
    const options: CommandExecutionOptions = {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.excludedEnvironmentVariables
        ? { excludedEnvironmentVariables: input.excludedEnvironmentVariables }
        : {})
    };
    const classNames = candidates.map(
      (candidate) => candidate.qualifiedTestClassName
    );

    await input.onPhaseStart?.('test_compile');
    let compile: CommandResult;
    try {
      compile = await this.shellService.runMavenGeneratedTestCompile(
        input.moduleRoot,
        input.buildSettings,
        classNames,
        options
      );
    } finally {
      await input.onPhaseComplete?.('test_compile');
    }
    const compileEvidence = this.evidence(
      input.scope,
      'test_compile',
      compile,
      []
    );
    if (compile.exitCode !== 0) {
      const attribution = this.batchAttribution.attributeCompile({
        candidates,
        stdout: compile.stdout,
        stderr: compile.stderr
      });
      const results = new Map<string, MavenBatchCandidateExecutionResult>();
      const failedCandidates = candidates.filter((candidate) => (
        attribution.results[candidate.candidateId]?.status === 'COMPILE_FAILED'
      ));
      const fallback = failedCandidates.length === 0 && candidates.length > 1
        ? 'INDIVIDUAL'
        : failedCandidates.length > 0 && failedCandidates.length < candidates.length
          ? 'ISOLATE_ATTRIBUTED_AND_RETRY'
          : 'NONE';
      this.appendTraceStep(
        trace,
        candidates,
        compileEvidence,
        attribution,
        fallback
      );
      if (failedCandidates.length === 0) {
        await input.placement.isolate(candidates);
        if (candidates.length > 1) {
          for (const candidate of candidates) {
            await input.placement.activate([candidate]);
            const individual = await this.executeBatchCandidates(
              input,
              [candidate],
              [...priorEvidence, compileEvidence],
              trace
            );
            const result = individual.get(candidate.candidateId);
            if (!result) {
              throw new Error(
                `Individual Maven fallback returned no result for ${candidate.candidateId}.`
              );
            }
            results.set(candidate.candidateId, result);
          }
          return results;
        }
        for (const candidate of candidates) {
          results.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            status: 'unproven',
            mavenExecutions: [...priorEvidence, compileEvidence]
          });
        }
        return results;
      }
      await input.placement.isolate(failedCandidates);
      for (const candidate of failedCandidates) {
        results.set(candidate.candidateId, {
          candidateId: candidate.candidateId,
          status: 'compile_failed',
          mavenExecutions: [...priorEvidence, compileEvidence]
        });
      }
      const failedIds = new Set(failedCandidates.map((candidate) => candidate.candidateId));
      const remaining = candidates.filter((candidate) => !failedIds.has(candidate.candidateId));
      if (remaining.length > 0) {
        const remainingResults = await this.executeBatchCandidates(
          input,
          remaining,
          [...priorEvidence, compileEvidence],
          trace
        );
        for (const [candidateId, result] of remainingResults) {
          results.set(candidateId, result);
        }
      }
      return results;
    }
    this.appendTraceStep(trace, candidates, compileEvidence, null, 'NONE');

    await input.onPhaseStart?.('test');
    try {
      const reportDirectory = await this.surefireReportService.prepareAttempt(
        input.moduleRoot,
        input.attemptId
      );
      const test = await this.shellService.runMavenGeneratedSurefireTest(
        input.moduleRoot,
        input.buildSettings,
        classNames,
        reportDirectory,
        options
      );
      const artifacts = await this.surefireReportService
        .readAttemptArtifacts(reportDirectory);
      const testEvidence = this.evidence(
        input.scope,
        'test',
        test,
        artifacts
      );
      const attribution = this.batchAttribution.attributeSurefire({
        candidates,
        artifacts,
        stdout: test.exitCode === 0 ? '' : test.stdout,
        stderr: test.exitCode === 0 ? '' : test.stderr
      });
      const results = new Map<string, MavenBatchCandidateExecutionResult>();
      const failedCandidates: MavenBatchCandidateIdentity[] = [];
      for (const candidate of candidates) {
        const candidateAttribution = attribution.results[candidate.candidateId];
        if (!candidateAttribution || candidateAttribution.status === 'UNPROVEN') {
          results.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            status: 'unproven',
            mavenExecutions: [...priorEvidence, compileEvidence, testEvidence]
          });
          continue;
        }
        try {
          const parsed = await this.surefireReportService.parseAttempt(
            reportDirectory,
            candidate.qualifiedTestClassName
          );
          const status = candidateAttribution.status === 'PASSED'
            ? 'passed'
            : 'test_failed';
          results.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            status,
            mavenExecutions: [...priorEvidence, compileEvidence, testEvidence],
            testReport: projectCandidateReport(
              parsed,
              candidate,
              status,
              candidateAttribution.diagnostic
            )
          });
          if (status !== 'passed') failedCandidates.push(candidate);
        } catch {
          const status = candidateAttribution.status === 'TEST_FAILED'
            ? 'test_failed'
            : 'unproven';
          results.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            status,
            mavenExecutions: [...priorEvidence, compileEvidence, testEvidence]
          });
          if (status === 'test_failed') failedCandidates.push(candidate);
        }
      }
      const unprovenCandidates = candidates.filter((candidate) => (
        results.get(candidate.candidateId)?.status === 'unproven'
      ));
      const retryUnproven = failedCandidates.length > 0
        && unprovenCandidates.length > 0;
      this.appendTraceStep(
        trace,
        candidates,
        testEvidence,
        attribution,
        retryUnproven ? 'ISOLATE_ATTRIBUTED_AND_RETRY' : 'NONE'
      );
      if (failedCandidates.length > 0) {
        await input.placement.isolate(failedCandidates);
      }
      if (retryUnproven) {
        const remainingResults = await this.executeBatchCandidates(
          input,
          unprovenCandidates,
          [...priorEvidence, compileEvidence, testEvidence],
          trace
        );
        for (const [candidateId, result] of remainingResults) {
          results.set(candidateId, result);
        }
      } else if (unprovenCandidates.length > 0) {
        await input.placement.isolate(unprovenCandidates);
      }
      return results;
    } finally {
      await input.onPhaseComplete?.('test');
    }
  }

  private appendTraceStep(
    trace: MavenBatchExecutionTraceBuilder,
    candidates: readonly MavenBatchCandidateIdentity[],
    evidence: MavenCommandEvidence,
    attribution: MavenBatchAttributionResult | null,
    fallback: MavenBatchExecutionTraceStep['fallback']
  ): void {
    trace.steps.push({
      sequence: trace.steps.length + 1,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      phase: evidence.phase,
      command: evidence.command,
      exitCode: evidence.exitCode,
      stdout: evidence.stdout,
      stderr: evidence.stderr,
      surefireReports: evidence.surefireReports.map((report) => ({ ...report })),
      attribution: attribution === null ? null : structuredClone(attribution),
      fallback
    });
  }

  async execute(
    input: MavenCandidateExecutionInput
  ): Promise<CandidateExecutionFeedback> {
    const options: CommandExecutionOptions = {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.excludedEnvironmentVariables
        ? {
            excludedEnvironmentVariables:
              input.excludedEnvironmentVariables
          }
        : {})
    };
    await input.onPhaseStart?.('test_compile');
    let compile: CommandResult;
    try {
      compile = await this.shellService.runMavenGeneratedTestCompile(
        input.moduleRoot,
        input.buildSettings,
        input.qualifiedTestClassName,
        options
      );
    } finally {
      await input.onPhaseComplete?.('test_compile');
    }
    const compileEvidence = this.evidence(
      input.scope,
      'test_compile',
      compile,
      []
    );
    if (compile.exitCode !== 0) {
      return {
        status: 'compile_failed',
        mavenExecutions: [compileEvidence]
      };
    }

    await input.onPhaseStart?.('test');
    try {
    const reportDirectory = await this.surefireReportService.prepareAttempt(
      input.moduleRoot,
      input.attemptId
    );
    const test = await this.shellService.runMavenGeneratedSurefireTest(
      input.moduleRoot,
      input.buildSettings,
      input.qualifiedTestClassName,
      reportDirectory,
      options
    );
    const artifacts = await this.surefireReportService
      .readAttemptArtifacts(reportDirectory);
    const testEvidence = this.evidence(
      input.scope,
      'test',
      test,
      artifacts
    );
    let testReport: SurefireExecutionReport | undefined;
    try {
      testReport = await this.surefireReportService.parseAttempt(
        reportDirectory,
        input.qualifiedTestClassName
      );
    } catch (error) {
      if (test.exitCode === 0) {
        if (input.scope === 'pruned_method_candidate') {
          return {
            status: 'test_failed',
            mavenExecutions: [compileEvidence, testEvidence]
          };
        }
        throw error;
      }
    }

    if (
      test.exitCode !== 0
      || (testReport?.failures ?? 0) > 0
      || (testReport?.errors ?? 0) > 0
    ) {
      const usableFailureReport = testReport
        && testReport.failures + testReport.errors > 0
        ? testReport
        : undefined;
      return {
        status: 'test_failed',
        mavenExecutions: [compileEvidence, testEvidence],
        ...(usableFailureReport
          ? { testReport: usableFailureReport }
          : {})
      };
    }
    if (!testReport) {
      throw new Error('Maven 测试通过，但缺少可验证的 Surefire XML 报告。');
    }
    return {
      status: 'passed',
      mavenExecutions: [compileEvidence, testEvidence],
      testReport
    };
    } finally {
      await input.onPhaseComplete?.('test');
    }
  }

  private evidence(
    scope: MavenEvidenceScope,
    phase: MavenCommandEvidence['phase'],
    result: CommandResult,
    surefireReports: SurefireReportArtifact[]
  ): MavenCommandEvidence {
    return {
      scope,
      phase,
      command: result.command,
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      surefireReports: surefireReports.map((artifact) => ({
        fileName: artifact.fileName,
        content: artifact.content
      }))
    };
  }
}

function validateBatchCandidates(
  candidates: readonly MavenBatchCandidateIdentity[]
): void {
  if (candidates.length < 1 || candidates.length > 5) {
    throw new TypeError('A Maven batch must contain between one and five candidates.');
  }
  const ids = new Set<string>();
  const classes = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.candidateId.trim()
      || !candidate.filePath.trim()
      || !candidate.qualifiedTestClassName.trim()) {
      throw new TypeError('Maven batch candidate identity is incomplete.');
    }
    if (ids.has(candidate.candidateId) || classes.has(candidate.qualifiedTestClassName)) {
      throw new TypeError('Maven batch candidates must have unique identities and test classes.');
    }
    ids.add(candidate.candidateId);
    classes.add(candidate.qualifiedTestClassName);
  }
}

function projectCandidateReport(
  report: SurefireExecutionReport,
  candidate: MavenBatchCandidateIdentity,
  status: 'passed' | 'test_failed',
  diagnostic: string
): SurefireExecutionReport {
  const failureDetails = report.failureDetails.filter((detail) => (
    detail.testClassName === candidate.qualifiedTestClassName
  ));
  if (status === 'test_failed' && failureDetails.length === 0) {
    failureDetails.push({
      suiteName: candidate.qualifiedTestClassName,
      testClassName: candidate.qualifiedTestClassName,
      testName: 'unknown',
      kind: 'failure',
      ...(diagnostic ? { detail: diagnostic.slice(0, 2_000) } : {})
    });
  }
  const failures = status === 'test_failed'
    ? failureDetails.filter((detail) => detail.kind === 'failure').length
    : 0;
  const errors = status === 'test_failed'
    ? failureDetails.filter((detail) => detail.kind === 'error').length
    : 0;
  const generatedTests = Math.max(1, report.generatedTests);
  const generatedSkipped = status === 'passed' ? 0 : report.generatedSkipped;
  return {
    reportCount: Math.max(1, report.reportCount),
    tests: Math.max(generatedTests, failures + errors + generatedSkipped),
    failures,
    errors,
    skipped: generatedSkipped,
    generatedTestClassName: candidate.qualifiedTestClassName,
    generatedTests,
    generatedSkipped,
    failureDetails
  };
}
