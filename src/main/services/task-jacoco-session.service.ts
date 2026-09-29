import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  BuildToolchainSettings,
  CommandResult,
  GenerateTargetJacocoReportRequest,
  GenerateTargetJacocoReportResponse
} from '../../shared/types.ts';
import type {
  ExactCoverageCounts,
  GeneratedClassTaskArtifact
} from '../../shared/class-task-contracts.ts';
import type {
  RefreshMethodAnalysisCoverageRequest,
  RefreshMethodAnalysisCoverageResponse
} from './method-analysis-contract.ts';
import type { ClassCoverageLedgerService } from './class-coverage-ledger.service.ts';
import type { CoverageIdentitySnapshot } from './coverage-contribution.service.ts';
import type {
  JacocoArtifactPair,
  JacocoArtifactsService,
  TaskJacocoVersionPaths
} from './jacoco-artifacts.service.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';
import type { ShellService } from './shell.service.ts';

export type TaskJacocoSessionContext = {
  taskId: string;
  moduleKey: string;
  moduleRoot: string;
  targetFilePath: string;
  qualifiedClassName: string;
  analysisSessionId: string;
  buildSettings: BuildToolchainSettings;
  baselineExecutionDataPath: string;
  baselinePair: JacocoArtifactPair;
  baselineCoverage: ExactCoverageCounts;
  excludedEnvironmentVariables?: readonly string[];
};

type TaskJacocoMavenPort = Pick<
  ShellService,
  'runMavenDirectTestsWithJacocoAppend'
>;

type TargetReportPort = {
  generateTargetJacocoReport(
    request: GenerateTargetJacocoReportRequest,
    signal?: AbortSignal
  ): Promise<GenerateTargetJacocoReportResponse>;
};

type CoverageRefreshPort = {
  refreshMethodAnalysisCoverage(
    sessionId: string,
    request: RefreshMethodAnalysisCoverageRequest,
    signal?: AbortSignal
  ): Promise<RefreshMethodAnalysisCoverageResponse>;
};

export type TaskJacocoSessionOptions = {
  artifacts: JacocoArtifactsService;
  ledger: ClassCoverageLedgerService;
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  maven: TaskJacocoMavenPort;
  targetReport: TargetReportPort;
  analyzer: CoverageRefreshPort;
  idFactory?: () => string;
};

export type TaskJacocoRefreshResult = {
  pair: JacocoArtifactPair;
  coverage: CoverageIdentitySnapshot;
  catalog: RefreshMethodAnalysisCoverageResponse['catalog'];
  contributions: ReturnType<ClassCoverageLedgerService['contributions']>;
};

export type TaskJacocoAcceptedBaseline = {
  context: TaskJacocoSessionContext;
  coverage: CoverageIdentitySnapshot;
};

type ActiveTaskSession = {
  context: TaskJacocoSessionContext;
  currentPair: JacocoArtifactPair;
};

type BuiltCoverageVersion = {
  version: TaskJacocoVersionPaths;
  pair: JacocoArtifactPair;
  coverage: CoverageIdentitySnapshot;
  catalog: RefreshMethodAnalysisCoverageResponse['catalog'];
};

export class TaskJacocoSessionService {
  private readonly artifacts: JacocoArtifactsService;
  private readonly ledger: ClassCoverageLedgerService;
  private readonly moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  private readonly maven: TaskJacocoMavenPort;
  private readonly targetReport: TargetReportPort;
  private readonly analyzer: CoverageRefreshPort;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, ActiveTaskSession>();

  constructor(options: TaskJacocoSessionOptions) {
    this.artifacts = options.artifacts;
    this.ledger = options.ledger;
    this.moduleLock = options.moduleLock;
    this.maven = options.maven;
    this.targetReport = options.targetReport;
    this.analyzer = options.analyzer;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async initialize(
    contextValue: TaskJacocoSessionContext,
    signal?: AbortSignal
  ): Promise<CoverageIdentitySnapshot> {
    const context = validateContext(contextValue);
    const existing = this.sessions.get(context.taskId);
    if (existing) {
      requireSameContext(existing.context, context);
      return this.ledger.baseline(context.taskId);
    }
    return this.moduleLock.runExclusive(
      context.moduleKey,
      async () => {
        throwIfAborted(signal);
        const raced = this.sessions.get(context.taskId);
        if (raced) {
          requireSameContext(raced.context, context);
          return this.ledger.baseline(context.taskId);
        }
        const taskPaths = await this.artifacts.prepareTaskSession(
          context.moduleRoot,
          context.taskId,
          context.baselineExecutionDataPath,
          context.baselinePair
        );
        throwIfAborted(signal);
        const taskBaselinePair = await this.artifacts.readValidatedPair(
          taskPaths.targetDirectory,
          taskPaths.baseline,
          context.baselinePair.pairId
        );
        const baseline = await this.artifacts.readExactCoverageSnapshot(
          context.moduleRoot,
          taskBaselinePair,
          context.baselineCoverage,
          context.qualifiedClassName
        );
        this.ledger.initialize(context.taskId, baseline);
        const currentPair = await this.artifacts.currentTaskPair(
          context.moduleRoot,
          context.taskId
        );
        this.sessions.set(context.taskId, {
          context,
          currentPair
        });
        return this.ledger.baseline(context.taskId);
      },
      signal
    );
  }

  async refreshArtifact(
    contextValue: TaskJacocoSessionContext,
    artifactValue: GeneratedClassTaskArtifact,
    signal: AbortSignal
  ): Promise<TaskJacocoRefreshResult> {
    const context = this.requireContext(contextValue);
    const artifact = validateArtifact(artifactValue);
    return this.moduleLock.runExclusive(
      context.moduleKey,
      async () => {
        throwIfAborted(signal);
        const session = this.requireSession(context.taskId);
        const previousLedger = this.ledger.snapshot(context.taskId);
        const built = await this.buildCoverageVersion(
          context,
          artifact,
          undefined,
          signal
        );
        let ledgerCommitted = false;
        try {
          this.ledger.commit(context.taskId, artifact, built.coverage);
          ledgerCommitted = true;
          const currentPair = await this.artifacts.promoteTaskVersion(
            context.moduleRoot,
            context.taskId,
            built.version,
            built.pair
          );
          session.currentPair = currentPair;
          return {
            pair: { ...currentPair },
            coverage: this.ledger.current(context.taskId),
            catalog: structuredClone(built.catalog),
            contributions: this.ledger.contributions(context.taskId)
          };
        } catch (error) {
          if (ledgerCommitted) {
            this.ledger.replace(
              context.taskId,
              previousLedger.artifacts,
              previousLedger.artifactSnapshots
            );
          }
          await this.removeVersionQuietly(context, built.version.versionId);
          await this.restoreAnalyzerQuietly(context, session.currentPair);
          throw error;
        }
      },
      signal
    );
  }

  async recalculate(
    contextValue: TaskJacocoSessionContext,
    artifactValues: readonly GeneratedClassTaskArtifact[],
    signal: AbortSignal
  ): Promise<TaskJacocoRefreshResult> {
    const context = this.requireContext(contextValue);
    const artifacts = artifactValues.map(validateArtifact);
    return this.moduleLock.runExclusive(
      context.moduleKey,
      async () => {
        throwIfAborted(signal);
        const session = this.requireSession(context.taskId);
        const previousLedger = this.ledger.snapshot(context.taskId);
        const staged: BuiltCoverageVersion[] = [];
        let sourceExecutionDataPath = this.artifacts.taskSessionPaths(
          context.moduleRoot,
          context.taskId
        ).baselineExecutionDataPath;
        try {
          for (const artifact of artifacts) {
            const built = await this.buildCoverageVersion(
              context,
              artifact,
              sourceExecutionDataPath,
              signal
            );
            staged.push(built);
            sourceExecutionDataPath = built.version.executionDataPath;
          }
          let baselineCatalog: RefreshMethodAnalysisCoverageResponse['catalog'] | null = null;
          if (staged.length === 0) {
            const taskPaths = this.artifacts.taskSessionPaths(
              context.moduleRoot,
              context.taskId
            );
            const baselinePair = await this.artifacts.readValidatedPair(
              taskPaths.targetDirectory,
              taskPaths.baseline,
              context.baselinePair.pairId
            );
            const refreshed = await this.analyzer.refreshMethodAnalysisCoverage(
              context.analysisSessionId,
              {
                reportPath: baselinePair.reportPath,
                branchSnapshotPath: baselinePair.branchSnapshotPath,
                reportPairId: baselinePair.pairId
              },
              signal
            );
            throwIfAborted(signal);
            if (
              refreshed.reportPairId !== baselinePair.pairId
              || refreshed.catalog.reportPairId !== baselinePair.pairId
              || refreshed.catalog.analysisSessionId !== context.analysisSessionId
            ) {
              throw new Error('Analyzer baseline refresh returned a mismatched identity.');
            }
            const refreshedBaseline = await this.artifacts.readExactCoverageSnapshot(
              context.moduleRoot,
              baselinePair,
              refreshed.coverage,
              context.qualifiedClassName
            );
            if (
              JSON.stringify(refreshedBaseline.lineIds)
                !== JSON.stringify(previousLedger.baseline.lineIds)
              || JSON.stringify(refreshedBaseline.coveredLineIds)
                !== JSON.stringify(previousLedger.baseline.coveredLineIds)
              || JSON.stringify(refreshedBaseline.branchIds)
                !== JSON.stringify(previousLedger.baseline.branchIds)
              || JSON.stringify(refreshedBaseline.coveredBranchIds)
                !== JSON.stringify(previousLedger.baseline.coveredBranchIds)
            ) {
              throw new Error('Recalculated baseline coverage differs from the task baseline.');
            }
            baselineCatalog = refreshed.catalog;
          }
          const snapshots = staged.map((item) => item.coverage);
          this.ledger.replace(context.taskId, artifacts, snapshots);
          let currentPair: JacocoArtifactPair;
          if (staged.length === 0) {
            currentPair = await this.artifacts.promoteTaskBaseline(
              context.moduleRoot,
              context.taskId
            );
          } else {
            const last = staged.at(-1)!;
            currentPair = await this.artifacts.promoteTaskVersion(
              context.moduleRoot,
              context.taskId,
              last.version,
              last.pair
            );
          }
          session.currentPair = currentPair;
          const catalog = staged.at(-1)?.catalog ?? baselineCatalog!;
          return {
            pair: { ...currentPair },
            coverage: this.ledger.current(context.taskId),
            catalog: structuredClone(catalog),
            contributions: this.ledger.contributions(context.taskId)
          };
        } catch (error) {
          this.ledger.replace(
            context.taskId,
            previousLedger.artifacts,
            previousLedger.artifactSnapshots
          );
          await Promise.all(staged.map((item) =>
            this.removeVersionQuietly(context, item.version.versionId)
          ));
          await this.restoreAnalyzerQuietly(context, session.currentPair);
          throw error;
        }
      },
      signal
    );
  }

  /**
   * Checkpoints all coverage produced by accepted formal files. Later files are
   * measured from this point, and revoking them returns to this exact snapshot.
   */
  async checkpointAcceptedBaseline(
    contextValue: TaskJacocoSessionContext,
    signal?: AbortSignal
  ): Promise<TaskJacocoAcceptedBaseline> {
    const context = this.requireContext(contextValue);
    return this.moduleLock.runExclusive(
      context.moduleKey,
      async () => {
        throwIfAborted(signal);
        const session = this.requireSession(context.taskId);
        const current = this.ledger.current(context.taskId);
        const baselinePair = await this.artifacts.checkpointTaskBaseline(
          context.moduleRoot,
          context.taskId
        );
        const baseline = await this.artifacts.readExactCoverageSnapshot(
          context.moduleRoot,
          baselinePair,
          current.counts,
          context.qualifiedClassName
        );
        this.ledger.rebase(context.taskId, baseline);
        const nextContext = validateContext({
          ...context,
          baselineExecutionDataPath: this.artifacts.taskSessionPaths(
            context.moduleRoot,
            context.taskId
          ).baselineExecutionDataPath,
          baselinePair,
          baselineCoverage: baseline.counts
        });
        session.context = nextContext;
        return {
          context: validateContext(nextContext),
          coverage: this.ledger.current(context.taskId)
        };
      },
      signal
    );
  }

  currentPair(taskIdValue: string): JacocoArtifactPair {
    const session = this.requireSession(requireIdentity(taskIdValue, 'taskId'));
    return { ...session.currentPair };
  }

  rebindAnalysisSession(
    taskIdValue: string,
    analysisSessionIdValue: string
  ): void {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const analysisSessionId = requireIdentity(
      analysisSessionIdValue,
      'analysisSessionId'
    );
    const session = this.requireSession(taskId);
    session.context = {
      ...session.context,
      analysisSessionId
    };
  }

  terminate(taskId: string): JacocoArtifactPair {
    return this.currentPair(taskId);
  }

  async remove(contextValue: TaskJacocoSessionContext): Promise<void> {
    const context = this.requireContext(contextValue);
    // The coordinator has already stopped and awaited work owned by this task.
    // Its private session directory can therefore be removed without waiting
    // for an unrelated class refresh holding the shared module Maven lock.
    await this.artifacts.removeTaskSession(context.moduleRoot, context.taskId);
    this.ledger.remove(context.taskId);
    this.sessions.delete(context.taskId);
  }

  private async buildCoverageVersion(
    context: TaskJacocoSessionContext,
    artifact: GeneratedClassTaskArtifact,
    sourceExecutionDataPath: string | undefined,
    signal: AbortSignal
  ): Promise<BuiltCoverageVersion> {
    throwIfAborted(signal);
    const version = await this.artifacts.prepareTaskVersion(
      context.moduleRoot,
      context.taskId,
      this.idFactory(),
      sourceExecutionDataPath
    );
    let analyzerRefreshAttempted = false;
    try {
      const maven = await this.maven.runMavenDirectTestsWithJacocoAppend(
        context.moduleRoot,
        context.buildSettings,
        [qualifiedTestClassName(context.qualifiedClassName, artifact.testClassName)],
        version.executionDataPath,
        version.surefireReportsDirectory,
        {
          signal,
          ...(context.excludedEnvironmentVariables
            ? {
                excludedEnvironmentVariables:
                  context.excludedEnvironmentVariables
              }
            : {})
        }
      );
      throwIfAborted(signal);
      requireMavenSuccess(maven);
      const generated = await this.targetReport.generateTargetJacocoReport({
        projectPath: context.moduleRoot,
        targetFilePath: context.targetFilePath,
        targetClass: context.qualifiedClassName,
        executionDataPath: version.executionDataPath,
        outputPath: version.pair.reportPath,
        branchSnapshotOutputPath: version.pair.branchSnapshotPath
      }, signal);
      throwIfAborted(signal);
      if (
        !generated.generated
        || resolve(generated.reportPath) !== resolve(version.pair.reportPath)
        || resolve(generated.branchSnapshotPath)
          !== resolve(version.pair.branchSnapshotPath)
      ) {
        throw new Error('java-analyzer returned an invalid task JaCoCo pair.');
      }
      const pair: JacocoArtifactPair = {
        reportPath: generated.reportPath,
        branchSnapshotPath: generated.branchSnapshotPath,
        pairId: generated.pairId
      };
      analyzerRefreshAttempted = true;
      const refreshed = await this.analyzer.refreshMethodAnalysisCoverage(
        context.analysisSessionId,
        {
          reportPath: pair.reportPath,
          branchSnapshotPath: pair.branchSnapshotPath,
          reportPairId: pair.pairId
        },
        signal
      );
      throwIfAborted(signal);
      if (
        refreshed.reportPairId !== pair.pairId
        || refreshed.catalog.reportPairId !== pair.pairId
        || refreshed.catalog.analysisSessionId !== context.analysisSessionId
      ) {
        throw new Error('Analyzer coverage refresh returned a mismatched identity.');
      }
      const coverage = await this.artifacts.readExactCoverageSnapshot(
        context.moduleRoot,
        pair,
        refreshed.coverage,
        context.qualifiedClassName
      );
      return {
        version,
        pair: coverage.pair,
        coverage,
        catalog: refreshed.catalog
      };
    } catch (error) {
      await this.removeVersionQuietly(context, version.versionId);
      if (analyzerRefreshAttempted) {
        await this.restoreAnalyzerQuietly(
          context,
          this.requireSession(context.taskId).currentPair
        );
      }
      throw error;
    }
  }

  private async restoreAnalyzerQuietly(
    context: TaskJacocoSessionContext,
    pair: JacocoArtifactPair
  ): Promise<void> {
    try {
      await this.analyzer.refreshMethodAnalysisCoverage(
        context.analysisSessionId,
        {
          reportPath: pair.reportPath,
          branchSnapshotPath: pair.branchSnapshotPath,
          reportPairId: pair.pairId
        }
      );
    } catch {
      // The durable current pair remains available for the next explicit refresh.
    }
  }

  private async removeVersionQuietly(
    context: TaskJacocoSessionContext,
    versionId: string
  ): Promise<void> {
    try {
      await this.artifacts.removeTaskVersion(
        context.moduleRoot,
        context.taskId,
        versionId
      );
    } catch {
      // A failed staging cleanup cannot replace the last promoted task state.
    }
  }

  private requireContext(
    contextValue: TaskJacocoSessionContext
  ): TaskJacocoSessionContext {
    const context = validateContext(contextValue);
    const session = this.requireSession(context.taskId);
    requireSameContext(session.context, context);
    return context;
  }

  private requireSession(taskId: string): ActiveTaskSession {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`Task JaCoCo session is not initialized for ${taskId}.`);
    return session;
  }
}

function validateContext(
  value: TaskJacocoSessionContext
): TaskJacocoSessionContext {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Task JaCoCo context is invalid.');
  }
  return {
    taskId: requireIdentity(value.taskId, 'taskId'),
    moduleKey: requireIdentity(value.moduleKey, 'moduleKey'),
    moduleRoot: requireIdentity(value.moduleRoot, 'moduleRoot'),
    targetFilePath: requireIdentity(value.targetFilePath, 'targetFilePath'),
    qualifiedClassName: requireIdentity(
      value.qualifiedClassName,
      'qualifiedClassName'
    ),
    analysisSessionId: requireIdentity(
      value.analysisSessionId,
      'analysisSessionId'
    ),
    buildSettings: structuredClone(value.buildSettings),
    baselineExecutionDataPath: requireIdentity(
      value.baselineExecutionDataPath,
      'baselineExecutionDataPath'
    ),
    baselinePair: { ...value.baselinePair },
    baselineCoverage: { ...value.baselineCoverage },
    ...(value.excludedEnvironmentVariables
      ? {
          excludedEnvironmentVariables:
            [...value.excludedEnvironmentVariables]
        }
      : {})
  };
}

function validateArtifact(
  value: GeneratedClassTaskArtifact
): GeneratedClassTaskArtifact {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Generated formal artifact is invalid.');
  }
  requireIdentity(value.id, 'artifactId');
  requireIdentity(value.filePath, 'artifact file path');
  requireIdentity(value.testClassName, 'test class name');
  return structuredClone(value);
}

function requireMavenSuccess(result: CommandResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `Task JaCoCo Maven failed with exit code ${result.exitCode ?? 'unknown'}.`
    );
  }
}

function qualifiedTestClassName(
  qualifiedTargetClassName: string,
  testClassName: string
): string {
  const separator = qualifiedTargetClassName.lastIndexOf('.');
  return separator < 0
    ? testClassName
    : `${qualifiedTargetClassName.slice(0, separator)}.${testClassName}`;
}

function requireIdentity(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 32_768
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireSameContext(
  left: TaskJacocoSessionContext,
  right: TaskJacocoSessionContext
): void {
  if (
    left.taskId !== right.taskId
    || left.moduleKey !== right.moduleKey
    || resolve(left.moduleRoot) !== resolve(right.moduleRoot)
    || resolve(left.targetFilePath) !== resolve(right.targetFilePath)
    || left.qualifiedClassName !== right.qualifiedClassName
    || left.analysisSessionId !== right.analysisSessionId
    || left.baselinePair.pairId !== right.baselinePair.pairId
  ) {
    throw new Error('Task JaCoCo context changed after session initialization.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}
