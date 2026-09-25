import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type {
  BuildToolchainSettings
} from '../../shared/types.ts';
import type {
  GeneratedClassTaskArtifact,
  GeneratedSourceMethodResult
} from '../../shared/class-task-contracts.ts';
import type { MethodTestBundle } from './class-task-runner.service.ts';
import type {
  ClassTaskFileTransactionService
} from './class-task-file-transaction.service.ts';
import type { MavenCandidateExecutorService } from './maven-candidate-executor.service.ts';
import {
  JavaTestStructureService,
  sanitizeJava
} from './java-test-structure.service.ts';
import {
  countRetainedFailureTestMethods,
  MethodTestBundleCompatibilityError,
  MethodTestBundleMergerService,
  type VerifiedMethodBatch
} from './method-test-bundle-merger.service.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';
import type {
  GeneratedTestNameReservationService
} from './generated-test-name-reservation.service.ts';
import type {
  PreparedGeneratedReplacement,
  TestWriterService
} from './test-writer.service.ts';

const FORMAL_FILE_ACCEPTANCE_TARGET = 20;

type CurrentFormalFile = {
  artifact: GeneratedClassTaskArtifact;
  code: string;
};

class FormalTestVerificationError extends Error {
  constructor(status: string) {
    super(`Formal test verification failed: ${status}.`);
    this.name = 'FormalTestVerificationError';
  }
}

export type FormalTestFilePackerOptions = {
  taskId: string;
  workspaceRoot: string;
  moduleRoot: string;
  moduleKey: string;
  targetFilePath: string;
  qualifiedClassName: string;
  buildSettings: BuildToolchainSettings;
  writer: Pick<
    TestWriterService,
    | 'resolveTestPath'
    | 'prepareReplacement'
    | 'replacePreparedGeneratedTest'
    | 'deleteGeneratedTest'
    | 'assertGeneratedTestUnchanged'
    | 'loadOwnedGeneratedTest'
  >;
  reservations: Pick<
    GeneratedTestNameReservationService,
    'reserve' | 'release'
  >;
  transaction: Pick<
    ClassTaskFileTransactionService,
    'track' | 'update' | 'seal' | 'restoreSnapshot' | 'artifacts'
  >;
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  maven: Pick<MavenCandidateExecutorService, 'execute'>;
  merger?: MethodTestBundleMergerService;
  structure?: JavaTestStructureService;
  excludedEnvironmentVariables?: readonly string[];
  idFactory?: () => string;
};

export class FormalTestFilePackerService {
  private readonly options: FormalTestFilePackerOptions;
  private readonly merger: MethodTestBundleMergerService;
  private readonly structure: JavaTestStructureService;
  private readonly idFactory: () => string;
  private readonly completedBundleKeys = new Set<string>();
  private current: CurrentFormalFile | null = null;
  private initialized = false;
  private readOnly = false;
  private finished = false;

  constructor(options: FormalTestFilePackerOptions) {
    this.options = options;
    this.merger = options.merger ?? new MethodTestBundleMergerService();
    this.structure = options.structure ?? new JavaTestStructureService();
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async append(
    bundle: MethodTestBundle,
    signal?: AbortSignal
  ): Promise<GeneratedClassTaskArtifact> {
    this.throwIfFinished();
    throwIfAborted(signal);
    await this.initializeFromTransaction();
    if (this.readOnly) {
      throw new Error('Accepted formal test artifacts cannot receive new methods.');
    }
    validateMethodBundleIdentity(bundle, this.completedBundleKeys);
    const artifactSnapshot = this.artifacts();
    const currentSnapshot = cloneCurrentFormalFile(this.current);
    try {
      const result = await this.appendPart(bundle, signal);
      this.completedBundleKeys.add(methodBundleKey(bundle));
      return cloneArtifact(result.artifact);
    } catch (error) {
      return this.rollbackAppend(artifactSnapshot, currentSnapshot, error);
    }
  }

  async appendMany(
    bundles: readonly MethodTestBundle[],
    signal?: AbortSignal
  ): Promise<GeneratedClassTaskArtifact[]> {
    this.throwIfFinished();
    throwIfAborted(signal);
    if (bundles.length === 0) {
      throw new Error('At least one source method bundle is required.');
    }
    await this.initializeFromTransaction();
    if (this.readOnly) {
      throw new Error('Accepted formal test artifacts cannot receive new methods.');
    }
    const pendingBundleKeys = new Set(this.completedBundleKeys);
    for (const bundle of bundles) {
      validateMethodBundleIdentity(bundle, pendingBundleKeys);
      pendingBundleKeys.add(methodBundleKey(bundle));
    }
    const artifactSnapshot = this.artifacts();
    const currentSnapshot = cloneCurrentFormalFile(this.current);
    try {
      for (const bundle of bundles) {
        await this.appendPart(bundle, signal, false);
      }
      const priorDigests = new Map(artifactSnapshot.map((artifact) => (
        [artifact.id, artifact.sha256]
      )));
      const changedArtifacts = this.artifacts().filter((artifact) => (
        priorDigests.get(artifact.id) !== artifact.sha256
      ));
      for (const artifact of changedArtifacts) {
        await this.options.moduleLock.runExclusive(
          this.options.moduleKey,
          async () => {
            throwIfAborted(signal);
            await this.options.writer.assertGeneratedTestUnchanged({
              workspaceRoot: this.options.workspaceRoot,
              filePath: artifact.filePath,
              expectedSha256: artifact.sha256
            });
            await this.verifyFormalFile(artifact, signal);
            await this.options.writer.assertGeneratedTestUnchanged({
              workspaceRoot: this.options.workspaceRoot,
              filePath: artifact.filePath,
              expectedSha256: artifact.sha256
            });
          },
          signal
        );
      }
      bundles.forEach((bundle) => this.completedBundleKeys.add(methodBundleKey(bundle)));
      return this.artifacts();
    } catch (error) {
      const recoverable = isRecoverableFormalMergeFailure(error, signal);
      await this.restoreAppendSnapshot(artifactSnapshot, currentSnapshot, error);
      if (!recoverable) throw error;
      for (const bundle of bundles) {
        await this.append(bundle, signal);
      }
      return this.artifacts();
    }
  }

  async appendSharedTemporaryGroup(
    input: {
      code: string;
      bundles: readonly MethodTestBundle[];
    },
    signal?: AbortSignal
  ): Promise<GeneratedClassTaskArtifact> {
    this.throwIfFinished();
    throwIfAborted(signal);
    if (input.bundles.length === 0) {
      throw new Error('At least one shared TMP source method bundle is required.');
    }
    await this.initializeFromTransaction();
    if (this.readOnly) {
      throw new Error('Accepted formal test artifacts cannot receive new methods.');
    }
    const pendingBundleKeys = new Set(this.completedBundleKeys);
    for (const bundle of input.bundles) {
      validateMethodBundleIdentity(bundle, pendingBundleKeys);
      pendingBundleKeys.add(methodBundleKey(bundle));
    }
    validateSharedTemporaryGroup(input.code, input.bundles, this.structure);
    const artifactSnapshot = this.artifacts();
    const currentSnapshot = cloneCurrentFormalFile(this.current);
    try {
      await this.sealCurrent(signal);
      const result = await this.createSharedFormalFile(
        input.code,
        input.bundles,
        signal
      );
      input.bundles.forEach((bundle) => (
        this.completedBundleKeys.add(methodBundleKey(bundle))
      ));
      this.current = null;
      return cloneArtifact(result.artifact);
    } catch (error) {
      return this.rollbackAppend(artifactSnapshot, currentSnapshot, error);
    }
  }

  private async appendPart(
    bundle: MethodTestBundle,
    signal?: AbortSignal,
    verify = true
  ): Promise<CurrentFormalFile> {
    const bundleTestMethodCount = this.formalFileTestMethodCount(bundle.code);
    const independent = mustPublishIndependently(bundle, bundleTestMethodCount);
    if (this.current && (
      independent
      || this.formalFileTestMethodCount(this.current.code) + bundleTestMethodCount
        > FORMAL_FILE_ACCEPTANCE_TARGET
    )) {
      await this.sealCurrent(signal);
    }
    let result: CurrentFormalFile;
    if (this.current) {
      try {
        result = await this.appendToCurrent(bundle, signal, verify);
      } catch (error) {
        if (!isRecoverableFormalMergeFailure(error, signal)) throw error;
        await this.sealCurrent(signal);
        result = await this.createFormalFile(bundle, signal, verify);
      }
    } else {
      result = await this.createFormalFile(bundle, signal, verify);
    }
    this.current = result.artifact.sealed ? null : result;
    return result;
  }

  async finish(signal?: AbortSignal): Promise<GeneratedClassTaskArtifact[]> {
    if (this.finished) return this.artifacts();
    throwIfAborted(signal);
    await this.initializeFromTransaction();
    if (this.current) {
      const current = this.current;
      await this.options.moduleLock.runExclusive(
        this.options.moduleKey,
        async () => {
          throwIfAborted(signal);
          await this.options.writer.assertGeneratedTestUnchanged({
            workspaceRoot: this.options.workspaceRoot,
            filePath: current.artifact.filePath,
            expectedSha256: current.artifact.sha256
          });
          await this.verifyFormalFile(current.artifact, signal);
          await this.options.writer.assertGeneratedTestUnchanged({
            workspaceRoot: this.options.workspaceRoot,
            filePath: current.artifact.filePath,
            expectedSha256: current.artifact.sha256
          });
        },
        signal
      );
    }
    this.finished = true;
    return this.artifacts();
  }

  artifacts(): GeneratedClassTaskArtifact[] {
    return this.options.transaction.artifacts(this.options.taskId);
  }

  private async createFormalFile(
    bundle: MethodTestBundle,
    signal?: AbortSignal,
    verify = true
  ): Promise<CurrentFormalFile> {
    return this.options.moduleLock.runExclusive(
      this.options.moduleKey,
      async () => {
        throwIfAborted(signal);
        const relativeTestDirectory = this.relativeTestDirectory();
        const reservation = await this.options.reservations.reserve(
          this.options.moduleRoot,
          targetClassName(this.options.qualifiedClassName),
          { relativeTestDirectory }
        );
        let generatedSha256: string | null = null;
        try {
          const mergedCode = this.mergeBundles([bundle]);
          const replacement = this.options.writer.prepareReplacement({
            workspaceRoot: this.options.workspaceRoot,
            filePath: reservation.filePath,
            content: mergedCode
          });
          const written = await this.options.writer.replacePreparedGeneratedTest({
            workspaceRoot: this.options.workspaceRoot,
            filePath: reservation.filePath,
            expectedSha256: reservation.sha256,
            prepared: replacement
          });
          generatedSha256 = written.sha256;
          const formalTestMethodCount = this.formalFileTestMethodCount(mergedCode);
          const sealed = mustPublishIndependently(bundle, formalTestMethodCount)
            || formalTestMethodCount >= FORMAL_FILE_ACCEPTANCE_TARGET;
          const draft = artifactDraft(
            reservation.filePath,
            reservation.testClassName,
            written.sha256,
            bundle.ordinaryTestMethodCount,
            [sourceMethodIdOf(bundle)],
            [methodResultFromBundle(bundle)],
            sealed
          );
          if (verify) await this.verifyFormalFile(draft, signal);
          const artifact = await this.options.transaction.track({
            taskId: this.options.taskId,
            workspaceRoot: this.options.workspaceRoot,
            filePath: draft.filePath,
            testClassName: draft.testClassName,
            sha256: draft.sha256,
            ordinaryTestMethodCount: draft.ordinaryTestMethodCount,
            methodIds: draft.methodIds,
            methodResults: draft.methodResults,
            sealed: draft.sealed,
            existedBefore: false
          });
          return {
            artifact,
            code: replacement.content
          };
        } catch (error) {
          await this.rollbackNewReservation(reservation, generatedSha256, error);
          throw error;
        }
      },
      signal
    );
  }

  private async createSharedFormalFile(
    code: string,
    bundles: readonly MethodTestBundle[],
    signal?: AbortSignal
  ): Promise<CurrentFormalFile> {
    return this.options.moduleLock.runExclusive(
      this.options.moduleKey,
      async () => {
        throwIfAborted(signal);
        const relativeTestDirectory = this.relativeTestDirectory();
        const reservation = await this.options.reservations.reserve(
          this.options.moduleRoot,
          targetClassName(this.options.qualifiedClassName),
          { relativeTestDirectory }
        );
        let generatedSha256: string | null = null;
        try {
          const replacement = this.options.writer.prepareReplacement({
            workspaceRoot: this.options.workspaceRoot,
            filePath: reservation.filePath,
            content: code
          });
          const written = await this.options.writer.replacePreparedGeneratedTest({
            workspaceRoot: this.options.workspaceRoot,
            filePath: reservation.filePath,
            expectedSha256: reservation.sha256,
            prepared: replacement
          });
          generatedSha256 = written.sha256;
          const ordinaryTestMethodCount = inputTestMethodCount(bundles);
          const draft = artifactDraft(
            reservation.filePath,
            reservation.testClassName,
            written.sha256,
            ordinaryTestMethodCount,
            bundles.map(sourceMethodIdOf),
            bundles.map(methodResultFromBundle),
            true
          );
          await this.verifyFormalFile(draft, signal);
          const artifact = await this.options.transaction.track({
            taskId: this.options.taskId,
            workspaceRoot: this.options.workspaceRoot,
            filePath: draft.filePath,
            testClassName: draft.testClassName,
            sha256: draft.sha256,
            ordinaryTestMethodCount: draft.ordinaryTestMethodCount,
            methodIds: draft.methodIds,
            methodResults: draft.methodResults,
            sealed: true,
            existedBefore: false
          });
          return { artifact, code: replacement.content };
        } catch (error) {
          return this.rollbackNewReservation(reservation, generatedSha256, error);
        }
      },
      signal
    );
  }

  private async appendToCurrent(
    bundle: MethodTestBundle,
    signal?: AbortSignal,
    verify = true
  ): Promise<CurrentFormalFile> {
    const current = this.current!;
    return this.options.moduleLock.runExclusive(
      this.options.moduleKey,
      async () => {
        throwIfAborted(signal);
        const mergedCode = this.mergeCurrentAndBundle(current, bundle);
        const replacement = this.options.writer.prepareReplacement({
          workspaceRoot: this.options.workspaceRoot,
          filePath: current.artifact.filePath,
          content: mergedCode
        });
        const written = await this.options.writer.replacePreparedGeneratedTest({
          workspaceRoot: this.options.workspaceRoot,
          filePath: current.artifact.filePath,
          expectedSha256: current.artifact.sha256,
          prepared: replacement
        });
        const ordinaryTestMethodCount = (
          current.artifact.ordinaryTestMethodCount
          + bundle.ordinaryTestMethodCount
        );
        const methodIds = [...current.artifact.methodIds, sourceMethodIdOf(bundle)];
        const methodResults = [
          ...(current.artifact.methodResults ?? []),
          methodResultFromBundle(bundle)
        ];
        const sealed = this.formalFileTestMethodCount(mergedCode)
          >= FORMAL_FILE_ACCEPTANCE_TARGET;
        const draft = artifactDraft(
          current.artifact.filePath,
          current.artifact.testClassName,
          written.sha256,
          ordinaryTestMethodCount,
          methodIds,
          methodResults,
          sealed
        );
        try {
          if (verify) await this.verifyFormalFile(draft, signal);
          const artifact = await this.options.transaction.update({
            taskId: this.options.taskId,
            artifactId: current.artifact.id,
            previousSha256: current.artifact.sha256,
            sha256: draft.sha256,
            ordinaryTestMethodCount,
            methodIds,
            methodResults,
            sealed
          });
          return {
            artifact,
            code: replacement.content
          };
        } catch (error) {
          await this.rollbackReplacement(current, replacement, error);
          throw error;
        }
      },
      signal
    );
  }

  private async sealCurrent(signal?: AbortSignal): Promise<void> {
    const current = this.current;
    if (!current) return;
    await this.options.moduleLock.runExclusive(
      this.options.moduleKey,
      async () => {
        throwIfAborted(signal);
        await this.options.transaction.seal({
          taskId: this.options.taskId,
          artifactId: current.artifact.id,
          expectedSha256: current.artifact.sha256
        });
      },
      signal
    );
    this.current = null;
  }

  private mergeBundles(bundles: readonly MethodTestBundle[]): string {
    const verified = bundles.map(bundleAsVerifiedBatch);
    return this.merger.merge('formal-file', verified).code;
  }

  private mergeCurrentAndBundle(
    current: CurrentFormalFile,
    bundle: MethodTestBundle
  ): string {
    const currentTestMethods = this.structure.findTestMethods(current.code);
    const verified: VerifiedMethodBatch[] = [
      {
        batchId: `formal:${current.artifact.id}`,
        filePath: current.artifact.filePath,
        sha256: current.artifact.sha256,
        code: current.code,
        ordinaryTestMethodCount: current.artifact.ordinaryTestMethodCount,
        passedTestMethods: currentTestMethods.map((method) => method.name)
      },
      bundleAsVerifiedBatch(bundle)
    ];
    return this.merger.merge('formal-file', verified).code;
  }

  private formalFileTestMethodCount(code: string): number {
    return this.structure.findTestMethods(code).length
      + countRetainedFailureTestMethods(code, this.structure);
  }

  private async initializeFromTransaction(): Promise<void> {
    if (this.initialized) return;
    const artifacts = this.options.transaction.artifacts(this.options.taskId);
    const unsealed = artifacts.filter((artifact) => (
      !artifact.sealed
      && artifact.methodResults?.length === artifact.methodIds.length
    ));
    if (
      unsealed.length > 1
      || (unsealed.length === 1 && artifacts.at(-1)?.id !== unsealed[0].id)
    ) {
      throw new Error('Persisted formal artifacts contain an invalid unsealed tail.');
    }
    const restoredWaveCountByMethodId = new Map<string, number>();
    const restoredMethodIdentity = new Map<
      string,
      Pick<GeneratedSourceMethodResult, 'methodName' | 'displaySignature'>
    >();
    for (const artifact of artifacts) {
      for (let index = 0; index < artifact.methodIds.length; index += 1) {
        const methodId = artifact.methodIds[index];
        const methodResult = artifact.methodResults?.[index];
        const existingIdentity = restoredMethodIdentity.get(methodId);
        if (methodResult && existingIdentity && (
          methodResult.methodName !== existingIdentity.methodName
          || methodResult.displaySignature !== existingIdentity.displaySignature
        )) {
          throw new Error('Persisted formal artifacts contain inconsistent method identity.');
        }
        if (methodResult && !existingIdentity) {
          restoredMethodIdentity.set(methodId, {
            methodName: methodResult.methodName,
            displaySignature: methodResult.displaySignature
          });
        }
        const waveIndex = (restoredWaveCountByMethodId.get(methodId) ?? 0) + 1;
        restoredWaveCountByMethodId.set(methodId, waveIndex);
        this.completedBundleKeys.add(legacyMethodBundleKey(methodId));
        this.completedBundleKeys.add(waveMethodBundleKey(methodId, waveIndex));
      }
    }
    const readOnly = artifacts.some((artifact) => artifact.accepted);
    if (readOnly) {
      this.readOnly = true;
      this.initialized = true;
      return;
    }
    let restoredCurrent: CurrentFormalFile | null = null;
    if (unsealed[0]) {
      const artifact = unsealed[0];
      const code = await this.options.writer.loadOwnedGeneratedTest({
        workspaceRoot: this.options.workspaceRoot,
        filePath: artifact.filePath,
        expectedSha256: artifact.sha256
      });
      const testMethods = this.structure.findTestMethods(code);
      const classPattern = new RegExp(
        `\\b(?:class|record|interface|enum)\\s+${escapeRegExp(artifact.testClassName)}\\b`
      );
      if (
        testMethods.length !== artifact.ordinaryTestMethodCount
        || !classPattern.test(sanitizeJava(code))
      ) {
        throw new Error('The persisted unsealed formal test file is inconsistent.');
      }
      restoredCurrent = { artifact: cloneArtifact(artifact), code };
    }
    this.current = restoredCurrent;
    this.initialized = true;
  }

  private async verifyFormalFile(
    artifact: Pick<
      GeneratedClassTaskArtifact,
      'testClassName' | 'ordinaryTestMethodCount'
    >,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    if (artifact.ordinaryTestMethodCount === 0) return;
    const packageName = packageNameOf(this.options.qualifiedClassName);
    const qualifiedTestClassName = packageName
      ? `${packageName}.${artifact.testClassName}`
      : artifact.testClassName;
    const execution = await this.options.maven.execute({
      moduleRoot: this.options.moduleRoot,
      buildSettings: this.options.buildSettings,
      attemptId: this.idFactory(),
      qualifiedTestClassName,
      scope: 'method_candidate',
      ...(signal ? { signal } : {}),
      ...(this.options.excludedEnvironmentVariables
        ? {
            excludedEnvironmentVariables:
              this.options.excludedEnvironmentVariables
          }
        : {})
    });
    throwIfAborted(signal);
    if (
      execution.status !== 'passed'
      || !execution.testReport
      || execution.testReport.generatedTests < artifact.ordinaryTestMethodCount
      || execution.testReport.generatedSkipped !== 0
    ) {
      throw new FormalTestVerificationError(execution.status);
    }
  }

  private async rollbackNewReservation(
    reservation: Awaited<ReturnType<GeneratedTestNameReservationService['reserve']>>,
    generatedSha256: string | null,
    originalError: unknown
  ): Promise<never> {
    try {
      if (generatedSha256) {
        await this.options.writer.deleteGeneratedTest({
          workspaceRoot: this.options.workspaceRoot,
          filePath: reservation.filePath,
          expectedSha256: generatedSha256
        });
      } else {
        await this.options.reservations.release(reservation);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Formal test creation failed and its reservation could not be rolled back.'
      );
    }
    throw originalError;
  }

  private async rollbackReplacement(
    current: CurrentFormalFile,
    replacement: PreparedGeneratedReplacement,
    originalError: unknown
  ): Promise<never> {
    try {
      const rollback = this.options.writer.prepareReplacement({
        workspaceRoot: this.options.workspaceRoot,
        filePath: current.artifact.filePath,
        content: current.code
      });
      await this.options.writer.replacePreparedGeneratedTest({
        workspaceRoot: this.options.workspaceRoot,
        filePath: current.artifact.filePath,
        expectedSha256: replacement.sha256,
        prepared: rollback
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Formal test update failed and the prior file could not be restored.'
      );
    }
    throw originalError;
  }

  private async rollbackAppend(
    artifactSnapshot: readonly GeneratedClassTaskArtifact[],
    currentSnapshot: CurrentFormalFile | null,
    originalError: unknown
  ): Promise<never> {
    await this.restoreAppendSnapshot(artifactSnapshot, currentSnapshot, originalError);
    throw originalError;
  }

  private async restoreAppendSnapshot(
    artifactSnapshot: readonly GeneratedClassTaskArtifact[],
    currentSnapshot: CurrentFormalFile | null,
    originalError: unknown
  ): Promise<void> {
    try {
      await this.options.moduleLock.runExclusive(
        this.options.moduleKey,
        async () => {
          const snapshotById = new Map(artifactSnapshot.map((artifact) => (
            [artifact.id, artifact]
          )));
          const currentArtifacts = this.artifacts();
          for (const artifact of [...currentArtifacts].reverse()) {
            const snapshot = snapshotById.get(artifact.id);
            if (!snapshot) {
              await this.options.writer.deleteGeneratedTest({
                workspaceRoot: this.options.workspaceRoot,
                filePath: artifact.filePath,
                expectedSha256: artifact.sha256
              });
              continue;
            }
            if (artifact.sha256 === snapshot.sha256) continue;
            if (!currentSnapshot || currentSnapshot.artifact.id !== artifact.id) {
              throw new Error('Cannot restore a modified formal test artifact.');
            }
            const replacement = this.options.writer.prepareReplacement({
              workspaceRoot: this.options.workspaceRoot,
              filePath: artifact.filePath,
              content: currentSnapshot.code
            });
            const restored = await this.options.writer.replacePreparedGeneratedTest({
              workspaceRoot: this.options.workspaceRoot,
              filePath: artifact.filePath,
              expectedSha256: artifact.sha256,
              prepared: replacement
            });
            if (restored.sha256 !== snapshot.sha256) {
              throw new Error('The restored formal test artifact digest is inconsistent.');
            }
          }
          await this.options.transaction.restoreSnapshot({
            taskId: this.options.taskId,
            artifacts: artifactSnapshot
          });
        }
      );
      this.current = cloneCurrentFormalFile(currentSnapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Formal source-method packing failed and could not be rolled back.'
      );
    }
  }

  private relativeTestDirectory(): string {
    const preferredTestPath = this.options.writer.resolveTestPath(
      this.options.workspaceRoot,
      this.options.targetFilePath
    );
    const testDirectory = dirname(preferredTestPath);
    const relativePath = relative(this.options.moduleRoot, testDirectory);
    if (
      relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error('The formal test directory is outside the target module.');
    }
    return relativePath;
  }

  private throwIfFinished(): void {
    if (this.finished) {
      throw new Error('The formal test file packer is already finished.');
    }
  }
}

function artifactDraft(
  filePath: string,
  testClassName: string,
  sha256: string,
  ordinaryTestMethodCount: number,
  methodIds: string[],
  methodResults: GeneratedSourceMethodResult[],
  sealed: boolean
): Pick<
  GeneratedClassTaskArtifact,
  | 'filePath'
  | 'testClassName'
  | 'sha256'
  | 'ordinaryTestMethodCount'
  | 'methodIds'
  | 'methodResults'
  | 'sealed'
> {
  return {
    filePath,
    testClassName,
    sha256,
    ordinaryTestMethodCount,
    methodIds,
    methodResults,
    sealed
  };
}

function validateMethodBundleIdentity(
  bundle: MethodTestBundle,
  completedBundleKeys: ReadonlySet<string>
): void {
  if (!bundle.methodId || completedBundleKeys.has(methodBundleKey(bundle))) {
    throw new Error('The source method bundle identity is missing or duplicated.');
  }
  const waveMetadata = [
    bundle.sourceMethodId !== undefined,
    bundle.waveIndex !== undefined,
    bundle.hasRemainingScenarios !== undefined
  ];
  if (waveMetadata.some(Boolean) && !waveMetadata.every(Boolean)) {
    throw new Error('The source method Wave bundle metadata is incomplete.');
  }
  if (waveMetadata.every(Boolean) && (
    !bundle.sourceMethodId?.trim()
    || !Number.isSafeInteger(bundle.waveIndex)
    || (bundle.waveIndex as number) < 1
    || typeof bundle.hasRemainingScenarios !== 'boolean'
  )) {
    throw new Error('The source method Wave bundle metadata is invalid.');
  }
  if (
    !bundle.methodName
    || !bundle.displaySignature
    || !Number.isInteger(bundle.jacocoOrder)
    || (bundle.jacocoOrder ?? -1) < 0
  ) {
    throw new Error('The source method bundle display identity is missing.');
  }
  if (bundle.sourceBatchIds.length === 0) {
    throw new Error('The source method bundle has no verified TMP batch identity.');
  }
}

function targetClassName(qualifiedClassName: string): string {
  const name = qualifiedClassName.split('.').at(-1) ?? '';
  if (!name) throw new Error('The target qualified class name is invalid.');
  return name;
}

function packageNameOf(qualifiedClassName: string): string {
  const separator = qualifiedClassName.lastIndexOf('.');
  return separator < 0 ? '' : qualifiedClassName.slice(0, separator);
}

function cloneArtifact(
  artifact: GeneratedClassTaskArtifact
): GeneratedClassTaskArtifact {
  return {
    ...artifact,
    methodIds: [...artifact.methodIds],
    ...(artifact.methodResults
      ? { methodResults: artifact.methodResults.map((method) => ({ ...method })) }
      : {})
  };
}

function cloneCurrentFormalFile(
  current: CurrentFormalFile | null
): CurrentFormalFile | null {
  return current
    ? { artifact: cloneArtifact(current.artifact), code: current.code }
    : null;
}

function methodResultFromBundle(bundle: MethodTestBundle): GeneratedSourceMethodResult {
  if (!bundle.methodName || !bundle.displaySignature || bundle.jacocoOrder === undefined) {
    throw new Error('The source method bundle display identity is missing.');
  }
  return {
    methodId: sourceMethodIdOf(bundle),
    methodName: bundle.methodName,
    displaySignature: bundle.displaySignature,
    jacocoOrder: bundle.jacocoOrder,
    ordinaryTestMethodCount: bundle.ordinaryTestMethodCount
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function bundleAsVerifiedBatch(bundle: MethodTestBundle): VerifiedMethodBatch {
  return {
    batchId: bundle.sourceBatchIds.join(','),
    filePath: `method-bundle:${methodBundleKey(bundle)}`,
    sha256: createHash('sha256').update(bundle.code, 'utf8').digest('hex'),
    code: bundle.code,
    ordinaryTestMethodCount: bundle.ordinaryTestMethodCount,
    passedTestMethods: [...bundle.passedTestMethods]
  };
}

function inputTestMethodCount(bundles: readonly MethodTestBundle[]): number {
  return bundles.reduce((sum, bundle) => sum + bundle.ordinaryTestMethodCount, 0);
}

function validateSharedTemporaryGroup(
  code: string,
  bundles: readonly MethodTestBundle[],
  structure: JavaTestStructureService
): void {
  const actualNames = structure.findTestMethods(code).map((method) => method.name);
  const expectedNames = bundles.flatMap((bundle) => bundle.passedTestMethods);
  if (
    actualNames.length !== inputTestMethodCount(bundles)
    || expectedNames.length !== actualNames.length
    || new Set(expectedNames).size !== expectedNames.length
    || actualNames.some((name) => !expectedNames.includes(name))
  ) {
    throw new Error('Shared TMP test method identities are inconsistent.');
  }
}

function sourceMethodIdOf(bundle: MethodTestBundle): string {
  return bundle.sourceMethodId ?? bundle.methodId;
}

function methodBundleKey(bundle: MethodTestBundle): string {
  return bundle.waveIndex === undefined
    ? legacyMethodBundleKey(bundle.methodId)
    : waveMethodBundleKey(sourceMethodIdOf(bundle), bundle.waveIndex);
}

function legacyMethodBundleKey(methodId: string): string {
  return `legacy:${methodId}`;
}

function waveMethodBundleKey(sourceMethodId: string, waveIndex: number): string {
  return `wave:${sourceMethodId}:${waveIndex}`;
}

function mustPublishIndependently(
  bundle: MethodTestBundle,
  formalTestMethodCount: number
): boolean {
  return formalTestMethodCount >= FORMAL_FILE_ACCEPTANCE_TARGET
    || bundle.waveIndex !== undefined && (
      bundle.waveIndex > 1 || bundle.hasRemainingScenarios === true
    );
}

function isRecoverableFormalMergeFailure(
  error: unknown,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted) return false;
  return error instanceof MethodTestBundleCompatibilityError
    || error instanceof FormalTestVerificationError;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
