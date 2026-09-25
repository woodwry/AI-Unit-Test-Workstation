import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import type {
  CommandResult,
  GenerateTargetJacocoReportRequest,
  GenerateTargetJacocoReportResponse
} from '../../shared/types.ts';
import {
  extractPublicMavenDiagnostic,
  sanitizePublicText,
  type CommandExecutionOptions
} from './maven-command.ts';
import type {
  ClassReportFingerprintInput,
  ModuleFingerprint,
  ModuleFingerprintInput
} from './module-fingerprint.service.ts';
import type { DirectTestClass } from './direct-test-locator.service.ts';
import type { ModuleIdentity } from './module-identity.service.ts';
import {
  type ClassReportPair,
  type ModulePreloadSnapshot,
  type PublicMavenFailureDiagnostic,
  ModulePreloadCacheStore
} from './module-preload-cache.store.ts';
import { ModuleOperationLock } from './module-operation-lock.service.ts';
import { JacocoArtifactsService } from './jacoco-artifacts.service.ts';

const REPAIR_INSTRUCTION = '请修复该模块后重新检测。';
const MAX_PUBLIC_ERROR_LENGTH = 4_096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export type ModulePreloadRequest = ModuleFingerprintInput;

export type ModuleClassReportRequest = ModulePreloadRequest & {
  qualifiedClassName: string;
  targetFilePath: string;
  /** Exact pending task files omitted from Maven until the user accepts them. */
  excludedDirectTestArtifacts?: ModuleFingerprintInput['ownedArtifacts'];
};

type ModuleIdentityPort = {
  resolve(workspaceRoot: string, sourceFilePath: string): Promise<ModuleIdentity>;
};

type ModuleFingerprintPort = {
  calculate(input: ModuleFingerprintInput): Promise<ModuleFingerprint>;
  calculateClass(input: ClassReportFingerprintInput): Promise<ModuleFingerprint>;
};

type ModuleMavenPort = {
  runMavenCompile(
    moduleRoot: string,
    settings: ModulePreloadRequest['buildSettings'],
    options?: CommandExecutionOptions
  ): Promise<CommandResult>;
  runMavenModuleTestsWithJacoco(
    moduleRoot: string,
    settings: ModulePreloadRequest['buildSettings'],
    executionDataPath: string,
    surefireReportsDirectory: string,
    options?: CommandExecutionOptions
  ): Promise<CommandResult>;
  runMavenDirectTestsWithJacoco(
    moduleRoot: string,
    settings: ModulePreloadRequest['buildSettings'],
    testClassNames: string[],
    executionDataPath: string,
    surefireReportsDirectory: string | undefined,
    options?: CommandExecutionOptions
  ): Promise<CommandResult>;
};

type DirectTestLocatorPort = {
  find(
    moduleRoot: string,
    targetFilePath: string,
    targetClassName: string
  ): Promise<DirectTestClass[]>;
};

type TargetReportPort = {
  generateTargetJacocoReport(
    request: GenerateTargetJacocoReportRequest,
    signal?: AbortSignal
  ): Promise<GenerateTargetJacocoReportResponse>;
};

export type ModulePreloadCoordinatorDependencies = {
  identityService: ModuleIdentityPort;
  fingerprintService: ModuleFingerprintPort;
  cache: ModulePreloadCacheStore;
  lock: ModuleOperationLock;
  shellService: ModuleMavenPort;
  directTestLocator: DirectTestLocatorPort;
  jacocoArtifactsService: JacocoArtifactsService;
  targetReport: TargetReportPort;
  clock?: () => Date;
};

type InFlightPreload = {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<ModulePreloadSnapshot>;
};

class MavenResultFailure extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(`Maven exited with code ${result.exitCode ?? 'unknown'}`);
    this.name = 'MavenResultFailure';
    this.result = result;
  }
}

export class ModulePreloadStoppedError extends Error {
  constructor() {
    super('模块预加载已停止。');
    this.name = 'ModulePreloadStoppedError';
  }
}

export class ModulePreloadFailureError extends Error {
  readonly diagnostic: PublicMavenFailureDiagnostic;

  constructor(snapshot: ModulePreloadSnapshot) {
    const diagnostic = snapshot.diagnostic;
    if (!diagnostic) throw new TypeError('FAILED 模块缺少公开 Maven 诊断。');
    super([
      `模块：${snapshot.moduleName}`,
      `路径：${snapshot.modulePath}`,
      `命令：${diagnostic.command}`,
      `错误：${diagnostic.summary}`,
      diagnostic.repairInstruction
    ].join('\n'));
    this.name = 'ModulePreloadFailureError';
    this.diagnostic = diagnostic;
  }
}

export class ClassPreloadMavenFailureError extends Error {
  readonly diagnostic: PublicMavenFailureDiagnostic;

  constructor(identity: ModuleIdentity, diagnostic: PublicMavenFailureDiagnostic) {
    super([
      `模块：${basename(identity.moduleDisplayPath)}`,
      `路径：${identity.moduleDisplayPath}`,
      `命令：${diagnostic.command}`,
      `错误：${diagnostic.summary}`,
      diagnostic.repairInstruction
    ].join('\n'));
    this.name = 'ClassPreloadMavenFailureError';
    this.diagnostic = diagnostic;
  }
}

/** Owns the single shared Maven preload for each canonical module. */
export class ModulePreloadCoordinator {
  private readonly identityService: ModuleIdentityPort;
  private readonly fingerprintService: ModuleFingerprintPort;
  private readonly cache: ModulePreloadCacheStore;
  private readonly lock: ModuleOperationLock;
  private readonly shellService: ModuleMavenPort;
  private readonly directTestLocator: DirectTestLocatorPort;
  private readonly jacocoArtifactsService: JacocoArtifactsService;
  private readonly targetReport: TargetReportPort;
  private readonly clock: () => Date;
  private readonly inFlight = new Map<string, InFlightPreload>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly stopGenerations = new Map<string, number>();

  constructor(dependencies: ModulePreloadCoordinatorDependencies) {
    this.identityService = dependencies.identityService;
    this.fingerprintService = dependencies.fingerprintService;
    this.cache = dependencies.cache;
    this.lock = dependencies.lock;
    this.shellService = dependencies.shellService;
    this.directTestLocator = dependencies.directTestLocator;
    this.jacocoArtifactsService = dependencies.jacocoArtifactsService;
    this.targetReport = dependencies.targetReport;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async ensureReady(
    request: ModulePreloadRequest,
    signal?: AbortSignal
  ): Promise<ModulePreloadSnapshot> {
    throwIfAborted(signal);
    const identity = await waitForAbort(
      this.identityService.resolve(request.workspaceRoot, request.sourceFilePath),
      signal
    );
    const stopGeneration = this.stopGeneration(identity.moduleKey);
    const stop = this.stopping.get(identity.moduleKey);
    if (stop) await waitForAbort(stop, signal);
    const fingerprint = await waitForAbort(
      this.fingerprintService.calculate(request),
      signal
    );
    if (this.stopGeneration(identity.moduleKey) !== stopGeneration) {
      return this.cancelPendingWaiter(identity, fingerprint.sha256);
    }
    throwIfAborted(signal);
    return this.ensureFingerprint(
      request,
      identity,
      fingerprint.sha256,
      stopGeneration,
      signal
    );
  }

  async prepareClassReport(
    request: ModuleClassReportRequest,
    signal?: AbortSignal
  ): Promise<ClassReportPair> {
    return this.prepareClassReportInternal(request, false, signal);
  }

  /** Rebuilds only the requested class report even when its persisted fingerprint still matches. */
  async refreshClassReport(
    request: ModuleClassReportRequest,
    signal?: AbortSignal
  ): Promise<ClassReportPair> {
    return this.prepareClassReportInternal(request, true, signal);
  }

  private async prepareClassReportInternal(
    request: ModuleClassReportRequest,
    forceRefresh: boolean,
    signal?: AbortSignal
  ): Promise<ClassReportPair> {
    this.requireClassRequest(request);
    for (;;) {
      throwIfAborted(signal);
      const identity = await waitForAbort(
        this.identityService.resolve(request.workspaceRoot, request.sourceFilePath),
        signal
      );
      const prepared = await this.lock.runExclusive(identity.moduleKey, async () => {
        throwIfAborted(signal);
        const discoveredDirectTests = await this.directTests(request, identity, signal);
        const directTests = await this.executableDirectTests(
          request,
          discoveredDirectTests,
          signal
        );
        const currentFingerprint = withDirectTestExecutionIdentity(
          await waitForAbort(
            this.fingerprintService.calculateClass({
              ...request,
              qualifiedClassName: request.qualifiedClassName,
              directTestFilePaths: discoveredDirectTests.map((testClass) => testClass.filePath)
            }),
            signal
          ),
          request.excludedDirectTestArtifacts
        );
        const snapshot = await this.cache.get(identity.moduleKey);
        const cached = snapshot?.classReportPairs[request.qualifiedClassName];
        if (!forceRefresh && cached && cached.fingerprint === currentFingerprint.sha256) {
          try {
            await this.validateCompiledTargetClass(identity, request);
            await this.jacocoArtifactsService.validateModuleExecutionData(
              identity.moduleDisplayPath,
              cached.executionDataPath
            );
            await this.jacocoArtifactsService.readValidatedPair(
              this.jacocoArtifactsService.paths(identity.moduleDisplayPath).targetDirectory,
              cached,
              cached.reportPairId
            );
            return cached;
          } catch {
            // A broken class-local cache is replaced below without invalidating siblings.
          }
        }

        const paths = await this.jacocoArtifactsService.prepareModulePreload(
          identity.moduleDisplayPath,
          currentFingerprint.sha256
        );
        let commandResult: CommandResult | null = null;
        try {
          if (directTests.length > 0) {
            commandResult = await this.shellService.runMavenDirectTestsWithJacoco(
              identity.moduleDisplayPath,
              request.buildSettings,
              directTests.map((testClass) => testClass.qualifiedName),
              paths.executionDataPath,
              paths.surefireReportsDirectory,
              { signal }
            );
            if (commandResult.exitCode !== 0) throw new MavenResultFailure(commandResult);
          } else {
            commandResult = await this.shellService.runMavenCompile(
              identity.moduleDisplayPath,
              request.buildSettings,
              { signal }
            );
            if (commandResult.exitCode !== 0) throw new MavenResultFailure(commandResult);
            await this.jacocoArtifactsService.initializeEmptyExecutionData(
              identity.moduleDisplayPath,
              paths.executionDataPath
            );
          }
          const executionDataPath = await this.jacocoArtifactsService
            .validateModuleExecutionData(
              identity.moduleDisplayPath,
              paths.executionDataPath
            );
          const pair = await this.generateClassReport(
            request,
            identity,
            currentFingerprint.sha256,
            executionDataPath,
            signal
          );
          const verifiedTests = await this.directTests(request, identity, signal);
          const verifiedFingerprint = withDirectTestExecutionIdentity(
            await this.fingerprintService.calculateClass({
              ...request,
              qualifiedClassName: request.qualifiedClassName,
              directTestFilePaths: verifiedTests.map((testClass) => testClass.filePath)
            }),
            request.excludedDirectTestArtifacts
          );
          if (verifiedFingerprint.sha256 !== currentFingerprint.sha256) {
            await this.removePreloadQuietly(
              identity.moduleDisplayPath,
              currentFingerprint.sha256
            );
            return null;
          }
          await this.storeClassPair(identity, pair);
          return pair;
        } catch (error) {
          await this.removePreloadQuietly(
            identity.moduleDisplayPath,
            currentFingerprint.sha256
          );
          if (error instanceof MavenResultFailure) {
            const diagnostic = this.failureDiagnostic(error, commandResult);
            throw new ClassPreloadMavenFailureError(identity, diagnostic);
          }
          throw error;
        }
      }, signal);
      if (prepared) return prepared;
    }
  }

  private async validateCompiledTargetClass(
    identity: ModuleIdentity,
    request: ModuleClassReportRequest
  ): Promise<void> {
    const qualifiedParts = request.qualifiedClassName.split('.');
    const sourceTypeName = basename(request.targetFilePath, '.java');
    const declaredTypeIndex = qualifiedParts.findIndex((part) => (
      part === sourceTypeName || part.startsWith(`${sourceTypeName}$`)
    ));
    const typeIndex = declaredTypeIndex >= 0
      ? declaredTypeIndex
      : Math.max(0, qualifiedParts.length - 1);
    const packageParts = qualifiedParts.slice(0, typeIndex);
    const binaryTypeName = qualifiedParts.slice(typeIndex).join('$');
    const classFilePath = resolve(
      identity.moduleDisplayPath,
      'target',
      'classes',
      ...packageParts,
      `${binaryTypeName}.class`
    );
    const stat = await fs.stat(classFilePath);
    if (!stat.isFile()) {
      throw new Error('目标类编译产物不是普通文件。');
    }
  }

  /** Computes the same class-local fingerprint as prepareClassReport without Maven or report generation. */
  async calculateClassReportFingerprint(
    request: ModuleClassReportRequest,
    signal?: AbortSignal
  ): Promise<ModuleFingerprint> {
    this.requireClassRequest(request);
    throwIfAborted(signal);
    const identity = await waitForAbort(
      this.identityService.resolve(request.workspaceRoot, request.sourceFilePath),
      signal
    );
    const directTests = await this.directTests(request, identity, signal);
    return withDirectTestExecutionIdentity(
      await waitForAbort(
        this.fingerprintService.calculateClass({
          ...request,
          qualifiedClassName: request.qualifiedClassName,
          directTestFilePaths: directTests.map((testClass) => testClass.filePath)
        }),
        signal
      ),
      request.excludedDirectTestArtifacts
    );
  }

  async retry(moduleKey: string): Promise<void> {
    const stop = this.stopping.get(moduleKey);
    if (stop) await stop;
    if (this.inFlight.has(moduleKey)) {
      throw new Error('模块预加载仍在运行，无法手动重试。');
    }
    const snapshot = await this.cache.get(moduleKey);
    if (
      !snapshot
      || (snapshot.state !== 'FAILED'
        && !(snapshot.state === 'IDLE' && snapshot.fingerprint))
    ) return;
    await this.cache.set(this.retrySnapshot(snapshot));
  }

  async stop(moduleKey: string): Promise<void> {
    const existing = this.stopping.get(moduleKey);
    if (existing) return existing;
    this.stopGenerations.set(moduleKey, this.stopGeneration(moduleKey) + 1);
    const operation = this.performStop(moduleKey);
    this.stopping.set(moduleKey, operation);
    try {
      await operation;
    } finally {
      if (this.stopping.get(moduleKey) === operation) this.stopping.delete(moduleKey);
    }
  }

  async markInterruptedForRetry(moduleKey: string): Promise<void> {
    const stop = this.stopping.get(moduleKey);
    if (stop) await stop;
    await this.lock.runExclusive(moduleKey, async () => {
      const snapshot = await this.cache.get(moduleKey);
      if (snapshot?.state === 'IDLE' && snapshot.fingerprint) {
        await this.cache.set(this.retrySnapshot(snapshot));
      }
    });
  }

  private async ensureFingerprint(
    request: ModulePreloadRequest,
    identity: ModuleIdentity,
    fingerprint: string,
    stopGeneration: number,
    signal?: AbortSignal
  ): Promise<ModulePreloadSnapshot> {
    throwIfAborted(signal);
    const current = this.inFlight.get(identity.moduleKey);
    if (current) {
      if (current.fingerprint === fingerprint) {
        return waitForAbort(current.promise, signal);
      }
      try {
        await waitForAbort(current.promise, signal);
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        // A changed fingerprint is independently eligible after the owner settles.
      }
      if (this.stopGeneration(identity.moduleKey) !== stopGeneration) {
        return this.cancelPendingWaiter(identity, fingerprint);
      }
      return this.ensureReady(request, signal);
    }

    const snapshot = await waitForAbort(this.cache.get(identity.moduleKey), signal);
    if (this.stopGeneration(identity.moduleKey) !== stopGeneration) {
      return this.cancelPendingWaiter(identity, fingerprint);
    }
    throwIfAborted(signal);
    const raced = this.inFlight.get(identity.moduleKey);
    if (raced) {
      return this.ensureFingerprint(request, identity, fingerprint, stopGeneration, signal);
    }
    if (
      snapshot?.state === 'READY'
      && snapshot.fingerprint === fingerprint
      && snapshot.executionDataPath
    ) {
      try {
        await waitForAbort(
          this.jacocoArtifactsService.validateModuleExecutionData(
            identity.moduleDisplayPath,
            snapshot.executionDataPath
          ),
          signal
        );
        if (this.stopGeneration(identity.moduleKey) !== stopGeneration) {
          return this.cancelPendingWaiter(identity, fingerprint);
        }
        throwIfAborted(signal);
        return snapshot;
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        // Invalid cached exec is never reusable; the replacement is serialized below.
      }
    }
    if (snapshot?.state === 'FAILED' && snapshot.fingerprint === fingerprint) {
      throw new ModulePreloadFailureError(snapshot);
    }
    if (snapshot?.state === 'IDLE' && snapshot.fingerprint === fingerprint) {
      throw new ModulePreloadStoppedError();
    }
    throwIfAborted(signal);
    return this.startPreload(request, identity, fingerprint, signal);
  }

  private startPreload(
    request: ModulePreloadRequest,
    identity: ModuleIdentity,
    fingerprint: string,
    signal?: AbortSignal
  ): Promise<ModulePreloadSnapshot> {
    throwIfAborted(signal);
    const current = this.inFlight.get(identity.moduleKey);
    if (current) {
      const pending = current.fingerprint === fingerprint
        ? current.promise
        : current.promise.then(
            () => this.ensureReady(request, signal),
            () => this.ensureReady(request, signal)
          );
      return waitForAbort(pending, signal);
    }
    const controller = new AbortController();
    const entry = {} as InFlightPreload;
    entry.fingerprint = fingerprint;
    entry.controller = controller;
    entry.promise = this.runPreload(request, identity, fingerprint, controller);
    this.inFlight.set(identity.moduleKey, entry);
    void entry.promise.then(
      () => this.removeInFlight(identity.moduleKey, entry),
      () => this.removeInFlight(identity.moduleKey, entry)
    );
    return waitForAbort(entry.promise, signal);
  }

  private async runPreload(
    request: ModulePreloadRequest,
    identity: ModuleIdentity,
    fingerprint: string,
    controller: AbortController
  ): Promise<ModulePreloadSnapshot> {
    try {
      return await this.lock.runExclusive(identity.moduleKey, async () => {
        let commandResult: CommandResult | null = null;
        try {
          if (controller.signal.aborted) throw new ModulePreloadStoppedError();
          const paths = await this.jacocoArtifactsService.prepareModulePreload(
            identity.moduleDisplayPath,
            fingerprint
          );
          await this.cache.set(this.runningSnapshot(identity, fingerprint));
          commandResult = await this.shellService.runMavenModuleTestsWithJacoco(
            identity.moduleDisplayPath,
            request.buildSettings,
            paths.executionDataPath,
            paths.surefireReportsDirectory,
            { signal: controller.signal }
          );
          if (commandResult.exitCode !== 0) throw new MavenResultFailure(commandResult);
          const executionDataPath = await this.jacocoArtifactsService.validateModuleExecutionData(
            identity.moduleDisplayPath,
            paths.executionDataPath
          );
          const ready: ModulePreloadSnapshot = {
            ...this.runningSnapshot(identity, fingerprint),
            state: 'READY',
            executionDataPath,
            updatedAt: this.now()
          };
          await this.cache.set(ready);
          return ready;
        } catch (error) {
          if (controller.signal.aborted || error instanceof ModulePreloadStoppedError) {
            throw controller.signal.reason instanceof ModulePreloadStoppedError
              ? controller.signal.reason
              : new ModulePreloadStoppedError();
          }
          const diagnostic = this.failureDiagnostic(error, commandResult);
          await this.removePreloadQuietly(identity.moduleDisplayPath, fingerprint);
          const failed: ModulePreloadSnapshot = {
            ...this.runningSnapshot(identity, fingerprint),
            state: 'FAILED',
            diagnostic,
            updatedAt: this.now()
          };
          await this.cache.set(failed);
          throw new ModulePreloadFailureError(failed);
        }
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof ModulePreloadStoppedError)) {
        throw error;
      }
      await this.removePreloadQuietly(identity.moduleDisplayPath, fingerprint);
      const previous = await this.cache.get(identity.moduleKey);
      await this.cache.set(
        this.stoppedSnapshot(previous ?? this.runningSnapshot(identity, fingerprint))
      );
      throw controller.signal.reason instanceof ModulePreloadStoppedError
        ? controller.signal.reason
        : new ModulePreloadStoppedError();
    }
  }

  private async generateClassReport(
    request: ModuleClassReportRequest,
    identity: ModuleIdentity,
    fingerprint: string,
    executionDataPath: string,
    signal?: AbortSignal
  ): Promise<ClassReportPair> {
    const paths = await this.jacocoArtifactsService.prepareClassPreloadPair(
      identity.moduleDisplayPath,
      fingerprint,
      request.qualifiedClassName
    );
    try {
      const generated = await this.targetReport.generateTargetJacocoReport({
        projectPath: identity.moduleDisplayPath,
        targetFilePath: request.targetFilePath,
        targetClass: request.qualifiedClassName,
        executionDataPath,
        outputPath: paths.reportPath,
        branchSnapshotOutputPath: paths.branchSnapshotPath
      }, signal);
      if (
        !generated.generated
        || resolve(generated.reportPath) !== resolve(paths.reportPath)
        || resolve(generated.branchSnapshotPath) !== resolve(paths.branchSnapshotPath)
      ) {
        throw new Error('java-analyzer 返回了无效的类报告文件对。');
      }
      const validated = await this.jacocoArtifactsService.readValidatedPair(
        this.jacocoArtifactsService.paths(identity.moduleDisplayPath).targetDirectory,
        paths,
        generated.pairId
      );
      const pair: ClassReportPair = {
        qualifiedClassName: request.qualifiedClassName,
        fingerprint,
        executionDataPath,
        reportPairId: validated.pairId,
        reportPath: validated.reportPath,
        branchSnapshotPath: validated.branchSnapshotPath,
        generatedAt: Number.isFinite(Date.parse(generated.generatedAt))
          ? generated.generatedAt
          : this.now()
      };
      return pair;
    } catch (error) {
      await this.jacocoArtifactsService.removeClassPreloadPair(
        identity.moduleDisplayPath,
        fingerprint,
        request.qualifiedClassName
      );
      throw error;
    }
  }

  private async directTests(
    request: ModuleClassReportRequest,
    identity: ModuleIdentity,
    signal?: AbortSignal
  ): Promise<DirectTestClass[]> {
    const separator = request.qualifiedClassName.lastIndexOf('.');
    const targetClassName = separator < 0
      ? request.qualifiedClassName
      : request.qualifiedClassName.slice(separator + 1);
    return waitForAbort(
      this.directTestLocator.find(
        identity.moduleDisplayPath,
        request.targetFilePath,
        targetClassName
      ),
      signal
    );
  }

  private async executableDirectTests(
    request: ModuleClassReportRequest,
    located: readonly DirectTestClass[],
    signal?: AbortSignal
  ): Promise<DirectTestClass[]> {
    const excludedArtifacts = request.excludedDirectTestArtifacts ?? [];
    if (excludedArtifacts.length === 0 || located.length === 0) return [...located];

    const excludedSha256ByPath = new Map<string, string>();
    for (const artifact of excludedArtifacts) {
      if (!artifact || !SHA256_PATTERN.test(artifact.sha256)) continue;
      try {
        const canonical = await waitForAbort(
          fs.realpath(resolve(artifact.path)),
          signal
        );
        excludedSha256ByPath.set(comparisonPath(canonical), artifact.sha256.toLowerCase());
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }
    if (excludedSha256ByPath.size === 0) return [...located];

    const filtered: DirectTestClass[] = [];
    for (const testClass of located) {
      throwIfAborted(signal);
      const canonical = await waitForAbort(fs.realpath(testClass.filePath), signal);
      const expectedSha256 = excludedSha256ByPath.get(comparisonPath(canonical));
      if (!expectedSha256) {
        filtered.push(testClass);
        continue;
      }
      const content = await waitForAbort(fs.readFile(canonical), signal);
      const actualSha256 = createHash('sha256').update(content).digest('hex');
      if (actualSha256 !== expectedSha256) filtered.push(testClass);
    }
    return filtered;
  }

  private async storeClassPair(
    identity: ModuleIdentity,
    pair: ClassReportPair
  ): Promise<void> {
    const current = await this.cache.get(identity.moduleKey);
    const classPreloadFailures = { ...(current?.classPreloadFailures ?? {}) };
    delete classPreloadFailures[pair.qualifiedClassName];
    await this.cache.set({
      moduleKey: identity.moduleKey,
      moduleName: basename(identity.moduleDisplayPath),
      modulePath: identity.moduleDisplayPath,
      state: 'READY',
      fingerprint: pair.fingerprint,
      executionDataPath: pair.executionDataPath,
      classReportPairs: {
        ...(current?.classReportPairs ?? {}),
        [pair.qualifiedClassName]: pair
      },
      classPreloadFailures,
      diagnostic: null,
      updatedAt: this.now()
    });
  }

  private async performStop(moduleKey: string): Promise<void> {
    const entry = this.inFlight.get(moduleKey);
    if (entry) {
      entry.controller.abort(new ModulePreloadStoppedError());
      try {
        await entry.promise;
      } catch {
        // All waiters receive the shared rejection; stop only waits for cleanup.
      }
    }
    await this.lock.runExclusive(moduleKey, async () => {
      const snapshot = await this.cache.get(moduleKey);
      if (snapshot?.state === 'RUNNING') {
        await this.cache.set(this.stoppedSnapshot(snapshot));
      }
    });
  }

  private async cancelPendingWaiter(
    identity: ModuleIdentity,
    fingerprint: string
  ): Promise<never> {
    await this.lock.runExclusive(identity.moduleKey, async () => {
      const current = await this.cache.get(identity.moduleKey);
      if (!current) {
        await this.cache.set(
          this.stoppedSnapshot(this.runningSnapshot(identity, fingerprint))
        );
      }
    });
    throw new ModulePreloadStoppedError();
  }

  private stopGeneration(moduleKey: string): number {
    return this.stopGenerations.get(moduleKey) ?? 0;
  }

  private runningSnapshot(
    identity: ModuleIdentity,
    fingerprint: string
  ): ModulePreloadSnapshot {
    return {
      moduleKey: identity.moduleKey,
      moduleName: basename(identity.moduleDisplayPath),
      modulePath: identity.moduleDisplayPath,
      state: 'RUNNING',
      fingerprint,
      executionDataPath: null,
      classReportPairs: {},
      classPreloadFailures: {},
      diagnostic: null,
      updatedAt: this.now()
    };
  }

  private stoppedSnapshot(snapshot: ModulePreloadSnapshot): ModulePreloadSnapshot {
    return {
      ...snapshot,
      state: 'IDLE',
      executionDataPath: null,
      classReportPairs: {},
      classPreloadFailures: {},
      diagnostic: null,
      updatedAt: this.now()
    };
  }

  private retrySnapshot(snapshot: ModulePreloadSnapshot): ModulePreloadSnapshot {
    return {
      ...this.stoppedSnapshot(snapshot),
      fingerprint: null
    };
  }

  private async requireReadySnapshot(
    moduleKey: string,
    fingerprint: string
  ): Promise<ModulePreloadSnapshot> {
    const snapshot = await this.cache.get(moduleKey);
    if (snapshot?.state !== 'READY' || snapshot.fingerprint !== fingerprint) {
      throw new Error('模块预加载缓存已失效。');
    }
    return snapshot;
  }

  private failureDiagnostic(
    error: unknown,
    result: CommandResult | null
  ): PublicMavenFailureDiagnostic {
    const source = error instanceof MavenResultFailure ? error.result : result;
    const extracted = source ? extractPublicMavenDiagnostic(source) : null;
    if (!extracted) {
      return {
        command: 'Maven command unavailable',
        exitCode: null,
        summary: this.publicError(error),
        repairInstruction: REPAIR_INSTRUCTION
      };
    }
    if (!(error instanceof MavenResultFailure)) {
      extracted.summary = `${this.publicError(error)}\n${extracted.summary}`
        .slice(0, MAX_PUBLIC_ERROR_LENGTH);
    }
    return { ...extracted, repairInstruction: REPAIR_INSTRUCTION };
  }

  private publicError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return sanitizePublicText(message).slice(0, MAX_PUBLIC_ERROR_LENGTH) || '未知错误';
  }

  private removeInFlight(moduleKey: string, entry: InFlightPreload): void {
    if (this.inFlight.get(moduleKey) === entry) this.inFlight.delete(moduleKey);
  }

  private async removePreloadQuietly(moduleRoot: string, fingerprint: string): Promise<void> {
    try {
      await this.jacocoArtifactsService.removeModulePreload(moduleRoot, fingerprint);
    } catch {
      // The cache is still cleared so stale output can never be selected.
    }
  }

  private requireClassRequest(request: ModuleClassReportRequest): void {
    if (!request.qualifiedClassName?.trim() || request.qualifiedClassName.length > 4_096) {
      throw new TypeError('限定类名无效。');
    }
    if (!request.targetFilePath?.trim() || request.targetFilePath.length > 4_096) {
      throw new TypeError('目标 Java 文件路径无效。');
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const rejectOnce = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(reason);
    };
    const onAbort = (): void => rejectOnce(abortReason(signal));
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      rejectOnce
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Operation was aborted.');
}

function comparisonPath(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function withDirectTestExecutionIdentity(
  fingerprint: ModuleFingerprint,
  artifacts: ModuleClassReportRequest['excludedDirectTestArtifacts']
): ModuleFingerprint {
  if (!artifacts || artifacts.length === 0) return fingerprint;
  const excluded = artifacts.map((artifact) => {
    if (!artifact || typeof artifact.path !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) {
      throw new TypeError('待接受测试文件记录无效。');
    }
    return {
      path: comparisonPath(artifact.path),
      sha256: artifact.sha256.toLowerCase()
    };
  }).sort((left, right) => (
    left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256)
  ));
  return {
    ...fingerprint,
    sha256: createHash('sha256').update(JSON.stringify({
      baseFingerprint: fingerprint.sha256,
      excludedDirectTestArtifacts: excluded
    })).digest('hex')
  };
}

function isMissingPath(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
