import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';
import type { ExactCoverageCounts } from '../../shared/class-task-contracts.ts';
import type { CoverageIdentitySnapshot } from './coverage-contribution.service.ts';

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_EXECUTION_DATA_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ARTIFACT_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type JacocoArtifactPairPaths = {
  reportPath: string;
  branchSnapshotPath: string;
};

export type JacocoArtifactPair = JacocoArtifactPairPaths & {
  pairId: string;
};

export type JacocoArtifactPaths = {
  targetDirectory: string;
  executionDataPath: string;
  standardReportDirectory: string;
  standardAggregateReportDirectory: string;
  transactionDirectory: string;
  iterationsDirectory: string;
  standard: JacocoArtifactPairPaths;
  baseline: JacocoArtifactPairPaths;
  best: JacocoArtifactPairPaths;
  after: JacocoArtifactPairPaths;
};

export type ModulePreloadArtifactPaths = {
  versionDirectory: string;
  executionDataPath: string;
  surefireReportsDirectory: string;
};

export type TaskJacocoSessionPaths = {
  targetDirectory: string;
  taskDirectory: string;
  versionsDirectory: string;
  baselineExecutionDataPath: string;
  currentExecutionDataPath: string;
  baseline: JacocoArtifactPairPaths;
  current: JacocoArtifactPairPaths;
};

export type TaskJacocoVersionPaths = {
  versionId: string;
  versionDirectory: string;
  executionDataPath: string;
  surefireReportsDirectory: string;
  pair: JacocoArtifactPairPaths;
};

type JacocoFileSystem = Pick<typeof fs,
  | 'access'
  | 'copyFile'
  | 'mkdir'
  | 'readFile'
  | 'realpath'
  | 'rename'
  | 'rm'
  | 'stat'
  | 'writeFile'
>;

type SnapshotIdentity = {
  pairId: string;
  reportSha256: string;
  executionDataSha256: string | null;
};

type ExactCoverageIdentities = Pick<CoverageIdentitySnapshot,
  | 'lineIds'
  | 'coveredLineIds'
  | 'branchIds'
  | 'coveredBranchIds'
>;

export class JacocoArtifactsService {
  private readonly fileSystem: JacocoFileSystem;
  private readonly artifactNamespace: string | null;

  constructor(
    fileSystem: JacocoFileSystem = fs,
    artifactNamespace?: string
  ) {
    if (artifactNamespace !== undefined
      && !ARTIFACT_NAMESPACE_PATTERN.test(artifactNamespace)) {
      throw new TypeError('JaCoCo artifact namespace is invalid.');
    }
    this.fileSystem = fileSystem;
    this.artifactNamespace = artifactNamespace ?? null;
  }

  paths(moduleRoot: string): JacocoArtifactPaths {
    const root = resolve(moduleRoot);
    const targetDirectory = resolve(root, 'target');
    const standardReportDirectory = join(targetDirectory, 'site', 'jacoco');
    const standardAggregateReportDirectory = join(targetDirectory, 'site', 'jacoco-aggregate');
    const transactionDirectory = this.managedPath(targetDirectory, 'jacoco', 'current');
    const iterationsDirectory = join(transactionDirectory, 'iterations');
    return {
      targetDirectory,
      executionDataPath: join(targetDirectory, 'jacoco.exec'),
      standardReportDirectory,
      standardAggregateReportDirectory,
      transactionDirectory,
      iterationsDirectory,
      standard: this.pairPaths(standardReportDirectory, 'jacoco'),
      baseline: this.pairPaths(transactionDirectory, 'baseline'),
      best: this.pairPaths(transactionDirectory, 'best'),
      after: this.pairPaths(transactionDirectory, 'after')
    };
  }

  modulePreloadPaths(moduleRoot: string, fingerprint: string): ModulePreloadArtifactPaths {
    this.requireFingerprint(fingerprint);
    const targetDirectory = resolve(moduleRoot, 'target');
    const versionDirectory = this.managedPath(
      targetDirectory,
      'jacoco',
      'preload',
      fingerprint
    );
    return {
      versionDirectory,
      executionDataPath: join(versionDirectory, 'jacoco.exec'),
      surefireReportsDirectory: this.managedPath(
        targetDirectory,
        'surefire',
        'preload',
        fingerprint
      )
    };
  }

  taskSessionPaths(moduleRoot: string, taskId: string): TaskJacocoSessionPaths {
    this.requireUuid(taskId, 'class task');
    const targetDirectory = resolve(moduleRoot, 'target');
    const taskDirectory = this.managedPath(
      targetDirectory,
      'jacoco',
      'tasks',
      taskId.toLowerCase()
    );
    return {
      targetDirectory,
      taskDirectory,
      versionsDirectory: join(taskDirectory, 'versions'),
      baselineExecutionDataPath: join(taskDirectory, 'baseline.exec'),
      currentExecutionDataPath: join(taskDirectory, 'current.exec'),
      baseline: this.pairPaths(taskDirectory, 'baseline'),
      current: this.pairPaths(taskDirectory, 'current')
    };
  }

  async prepareTaskSession(
    moduleRoot: string,
    taskId: string,
    sourceExecutionDataPath: string,
    sourceBaselinePair: JacocoArtifactPair
  ): Promise<TaskJacocoSessionPaths> {
    const paths = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    const sourceExecutionData = await this.validateModuleExecutionData(
      moduleRoot,
      sourceExecutionDataPath
    );
    const sourcePair = await this.readValidatedPair(
      paths.targetDirectory,
      sourceBaselinePair,
      sourceBaselinePair.pairId
    );
    await this.requirePairExecutionData(sourcePair, sourceExecutionData);
    await this.removePath(paths.targetDirectory, paths.taskDirectory, true);
    try {
      await this.fileSystem.mkdir(paths.versionsDirectory, { recursive: true });
      await this.requireRealPathInside(paths.targetDirectory, paths.versionsDirectory);
      await this.fileSystem.copyFile(
        sourceExecutionData,
        paths.baselineExecutionDataPath,
        constants.COPYFILE_EXCL
      );
      await this.validateExecutionDataPath(
        paths.targetDirectory,
        paths.baselineExecutionDataPath
      );
      await this.publishPair(paths.targetDirectory, sourcePair, paths.baseline);
      await this.publishTaskState(
        paths,
        paths.baselineExecutionDataPath,
        await this.readValidatedPair(paths.targetDirectory, paths.baseline)
      );
      return paths;
    } catch (error) {
      await this.removePath(paths.targetDirectory, paths.taskDirectory, true);
      throw error;
    }
  }

  async prepareTaskVersion(
    moduleRoot: string,
    taskId: string,
    versionId: string,
    sourceExecutionDataPath?: string
  ): Promise<TaskJacocoVersionPaths> {
    this.requireUuid(versionId, 'JaCoCo task version');
    const session = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    await this.readValidatedPair(session.targetDirectory, session.current);
    const source = sourceExecutionDataPath
      ? resolve(sourceExecutionDataPath)
      : session.currentExecutionDataPath;
    this.requireInside(session.taskDirectory, source);
    await this.validateExecutionDataPath(session.targetDirectory, source);
    const versionDirectory = join(
      session.versionsDirectory,
      versionId.toLowerCase()
    );
    const version: TaskJacocoVersionPaths = {
      versionId: versionId.toLowerCase(),
      versionDirectory,
      executionDataPath: join(versionDirectory, 'jacoco.exec'),
      surefireReportsDirectory: join(versionDirectory, 'surefire'),
      pair: this.pairPaths(versionDirectory, 'coverage')
    };
    this.requireInside(session.versionsDirectory, versionDirectory);
    try {
      await this.fileSystem.mkdir(versionDirectory, { recursive: false });
      await this.fileSystem.mkdir(version.surefireReportsDirectory, { recursive: false });
      await this.requireRealPathInside(session.targetDirectory, versionDirectory);
      await this.fileSystem.copyFile(
        source,
        version.executionDataPath,
        constants.COPYFILE_EXCL
      );
      await this.validateExecutionDataPath(
        session.targetDirectory,
        version.executionDataPath
      );
      return version;
    } catch (error) {
      await this.removePath(session.targetDirectory, versionDirectory, true);
      throw error;
    }
  }

  async promoteTaskVersion(
    moduleRoot: string,
    taskId: string,
    version: TaskJacocoVersionPaths,
    sourcePair: JacocoArtifactPair
  ): Promise<JacocoArtifactPair> {
    const session = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    const expectedVersionDirectory = join(
      session.versionsDirectory,
      this.requireUuid(version.versionId, 'JaCoCo task version').toLowerCase()
    );
    if (
      this.normalizePath(version.versionDirectory)
        !== this.normalizePath(expectedVersionDirectory)
      || this.normalizePath(version.executionDataPath)
        !== this.normalizePath(join(expectedVersionDirectory, 'jacoco.exec'))
      || this.normalizePath(version.pair.reportPath)
        !== this.normalizePath(join(expectedVersionDirectory, 'coverage.xml'))
      || this.normalizePath(version.pair.branchSnapshotPath)
        !== this.normalizePath(join(expectedVersionDirectory, 'coverage.branches.json'))
    ) {
      throw new Error('JaCoCo task version paths do not match their identity.');
    }
    const validatedPair = await this.readValidatedPair(
      session.targetDirectory,
      sourcePair,
      sourcePair.pairId
    );
    if (
      this.normalizePath(validatedPair.reportPath)
        !== this.normalizePath(version.pair.reportPath)
      || this.normalizePath(validatedPair.branchSnapshotPath)
        !== this.normalizePath(version.pair.branchSnapshotPath)
    ) {
      throw new Error('JaCoCo task version pair paths do not match the generated pair.');
    }
    await this.validateExecutionDataPath(
      session.targetDirectory,
      version.executionDataPath
    );
    await this.requirePairExecutionData(validatedPair, version.executionDataPath);
    return this.publishTaskState(
      session,
      version.executionDataPath,
      validatedPair
    );
  }

  async promoteTaskBaseline(
    moduleRoot: string,
    taskId: string
  ): Promise<JacocoArtifactPair> {
    const session = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    const baseline = await this.readValidatedPair(
      session.targetDirectory,
      session.baseline
    );
    await this.requirePairExecutionData(
      baseline,
      session.baselineExecutionDataPath
    );
    return this.publishTaskState(
      session,
      session.baselineExecutionDataPath,
      baseline
    );
  }

  async currentTaskPair(
    moduleRoot: string,
    taskId: string
  ): Promise<JacocoArtifactPair> {
    const session = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    return this.readValidatedPair(session.targetDirectory, session.current);
  }

  /** Persists the current verified task state as the rollback baseline for later files. */
  async checkpointTaskBaseline(
    moduleRoot: string,
    taskId: string
  ): Promise<JacocoArtifactPair> {
    const session = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    const current = await this.readValidatedPair(
      session.targetDirectory,
      session.current
    );
    await this.validateExecutionDataPath(
      session.targetDirectory,
      session.currentExecutionDataPath
    );
    await this.requirePairExecutionData(current, session.currentExecutionDataPath);
    return this.publishTaskState(
      session,
      session.currentExecutionDataPath,
      current,
      {
        executionDataPath: session.baselineExecutionDataPath,
        pair: session.baseline
      }
    );
  }

  async removeTaskVersion(
    moduleRoot: string,
    taskId: string,
    versionId: string
  ): Promise<void> {
    const session = this.taskSessionPaths(moduleRoot, taskId);
    const versionDirectory = join(
      session.versionsDirectory,
      this.requireUuid(versionId, 'JaCoCo task version').toLowerCase()
    );
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    await this.removePath(session.targetDirectory, versionDirectory, true);
  }

  async removeTaskSession(moduleRoot: string, taskId: string): Promise<void> {
    const session = this.taskSessionPaths(moduleRoot, taskId);
    await this.validateTargetDirectory(moduleRoot, session.targetDirectory);
    await this.removePath(session.targetDirectory, session.taskDirectory, true);
  }

  classPreloadPairPaths(
    moduleRoot: string,
    fingerprint: string,
    qualifiedClassName: string
  ): JacocoArtifactPairPaths {
    this.requireFingerprint(fingerprint);
    if (!qualifiedClassName.trim() || qualifiedClassName.length > 4_096) {
      throw new TypeError('限定类名无效。');
    }
    const key = sha256(Buffer.from(qualifiedClassName, 'utf8'));
    return this.pairPaths(
      join(this.modulePreloadPaths(moduleRoot, fingerprint).versionDirectory, 'classes'),
      key
    );
  }

  async prepareModulePreload(
    moduleRoot: string,
    fingerprint: string
  ): Promise<ModulePreloadArtifactPaths> {
    const paths = this.modulePreloadPaths(moduleRoot, fingerprint);
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    await this.removePath(targetDirectory, paths.versionDirectory, true);
    await this.removePath(targetDirectory, paths.surefireReportsDirectory, true);
    await Promise.all([
      this.fileSystem.mkdir(paths.versionDirectory, { recursive: true }),
      this.fileSystem.mkdir(paths.surefireReportsDirectory, { recursive: true })
    ]);
    await Promise.all([
      this.requireRealPathInside(targetDirectory, paths.versionDirectory),
      this.requireRealPathInside(targetDirectory, paths.surefireReportsDirectory)
    ]);
    return paths;
  }

  async validateModuleExecutionData(
    moduleRoot: string,
    executionDataPath: string
  ): Promise<string> {
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    this.requireInside(targetDirectory, executionDataPath);
    await this.requireRealPathInside(targetDirectory, executionDataPath);
    const stat = await this.fileSystem.stat(executionDataPath);
    if (!stat.isFile() || stat.size > MAX_EXECUTION_DATA_BYTES) {
      throw new Error('JaCoCo exec 不是文件或超过 512 MiB 上限。');
    }
    return resolve(executionDataPath);
  }

  async initializeEmptyExecutionData(
    moduleRoot: string,
    executionDataPath: string
  ): Promise<string> {
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    this.requireInside(targetDirectory, executionDataPath);
    await this.fileSystem.mkdir(dirname(executionDataPath), { recursive: true });
    await this.requireRealPathInside(targetDirectory, dirname(executionDataPath));
    await this.fileSystem.writeFile(executionDataPath, Buffer.alloc(0), { flag: 'wx' });
    return this.validateModuleExecutionData(moduleRoot, executionDataPath);
  }

  async removeModulePreload(moduleRoot: string, fingerprint: string): Promise<void> {
    const paths = this.modulePreloadPaths(moduleRoot, fingerprint);
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    await Promise.all([
      this.removePath(targetDirectory, paths.versionDirectory, true),
      this.removePath(targetDirectory, paths.surefireReportsDirectory, true)
    ]);
  }

  async prepareClassPreloadPair(
    moduleRoot: string,
    fingerprint: string,
    qualifiedClassName: string
  ): Promise<JacocoArtifactPairPaths> {
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    const pair = this.classPreloadPairPaths(moduleRoot, fingerprint, qualifiedClassName);
    await this.removePair(targetDirectory, pair);
    await this.fileSystem.mkdir(dirname(pair.reportPath), { recursive: true });
    await this.requireRealPathInside(targetDirectory, dirname(pair.reportPath));
    return pair;
  }

  async removeClassPreloadPair(
    moduleRoot: string,
    fingerprint: string,
    qualifiedClassName: string
  ): Promise<void> {
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    await this.removePair(
      targetDirectory,
      this.classPreloadPairPaths(moduleRoot, fingerprint, qualifiedClassName)
    );
  }

  /** 为一次多轮生成建立只属于本次会话的 JaCoCo 目录。 */
  async prepareSession(moduleRoot: string): Promise<JacocoArtifactPaths> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    await this.removePath(paths.targetDirectory, paths.executionDataPath, false);
    // 标准报告可能正被 IDEA 的编辑器、索引器或内置 Web 服务读取。
    // 本轮先在独立事务目录生成并校验新文件，成功后再尝试发布，
    // 不应为了开始新会话而删除上一轮仍然有效的标准报告。
    await this.removePath(paths.targetDirectory, paths.transactionDirectory, true);
    await this.fileSystem.mkdir(paths.iterationsDirectory, { recursive: true });
    await this.requireRealPathInside(paths.targetDirectory, paths.iterationsDirectory);
    return paths;
  }

  async prepareBaseline(moduleRoot: string): Promise<JacocoArtifactPaths> {
    return this.prepareSession(moduleRoot);
  }

  async prepareIteration(
    moduleRoot: string,
    localArtifactId: string
  ): Promise<JacocoArtifactPaths & { iteration: JacocoArtifactPairPaths }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localArtifactId)) {
      throw new Error('JaCoCo 迭代标识无效。');
    }
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    await this.removePath(paths.targetDirectory, paths.executionDataPath, false);
    await this.fileSystem.mkdir(paths.iterationsDirectory, { recursive: true });
    await this.requireRealPathInside(paths.targetDirectory, paths.iterationsDirectory);
    const iteration = this.pairPaths(paths.iterationsDirectory, localArtifactId);
    this.requireInside(paths.iterationsDirectory, iteration.reportPath);
    this.requireInside(paths.iterationsDirectory, iteration.branchSnapshotPath);
    if (await this.exists(iteration.reportPath) || await this.exists(iteration.branchSnapshotPath)) {
      throw new Error('JaCoCo 迭代报告文件对路径已存在。');
    }
    return { ...paths, iteration };
  }

  async prepareAfter(moduleRoot: string): Promise<JacocoArtifactPaths> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    await this.removePath(paths.targetDirectory, paths.executionDataPath, false);
    await this.removePair(paths.targetDirectory, paths.after);
    return paths;
  }

  async publishBaseline(
    moduleRoot: string,
    source: JacocoArtifactPair
  ): Promise<JacocoArtifactPair> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    this.requireExpectedPair(paths.baseline, source, '基线');
    try {
      return await this.publishPair(paths.targetDirectory, source, paths.standard);
    } catch (error) {
      if (!isBusyFileError(error)) throw error;
      // Windows 不允许替换被 IDEA 长时间占用的文件。此时继续使用已经
      // 完整校验过的本轮事务文件对，避免在调用模型之前终止整个生成任务。
      return this.readValidatedPair(
        paths.targetDirectory,
        source,
        source.pairId
      );
    }
  }

  async publishAfter(
    moduleRoot: string,
    source: JacocoArtifactPair
  ): Promise<JacocoArtifactPair> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    this.requireExpectedPair(paths.after, source, 'after');
    return this.publishPair(paths.targetDirectory, source, paths.standard);
  }

  async promoteIteration(
    moduleRoot: string,
    source: JacocoArtifactPair
  ): Promise<JacocoArtifactPair> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    this.requireInside(paths.iterationsDirectory, source.reportPath);
    this.requireInside(paths.iterationsDirectory, source.branchSnapshotPath);
    const best = await this.publishPair(paths.targetDirectory, source, paths.best);
    await this.publishPair(paths.targetDirectory, best, paths.standard);
    return best;
  }

  async publishBest(moduleRoot: string): Promise<JacocoArtifactPair> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    const best = await this.readValidatedPair(paths.targetDirectory, paths.best);
    return this.publishPair(paths.targetDirectory, best, paths.standard);
  }

  async accept(moduleRoot: string): Promise<void> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    try {
      await this.publishBest(moduleRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.removePath(paths.targetDirectory, paths.executionDataPath, false);
    await this.removePath(paths.targetDirectory, paths.transactionDirectory, true);
  }

  async revoke(moduleRoot: string): Promise<void> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    const baseline = await this.readValidatedPair(paths.targetDirectory, paths.baseline);
    await this.publishPair(paths.targetDirectory, baseline, paths.standard);
    await this.removePath(paths.targetDirectory, paths.executionDataPath, false);
    await this.removePath(paths.targetDirectory, paths.transactionDirectory, true);
  }

  /** 内存事务已自行发布或恢复标准文件对，这里只清理本轮临时产物。 */
  async finishSession(moduleRoot: string): Promise<void> {
    const paths = this.paths(moduleRoot);
    await this.validateTargetDirectory(moduleRoot, paths.targetDirectory);
    await this.removePath(paths.targetDirectory, paths.executionDataPath, false);
    await this.removePath(paths.targetDirectory, paths.transactionDirectory, true);
  }

  async readValidatedPair(
    targetDirectory: string,
    paths: JacocoArtifactPairPaths,
    expectedPairId?: string
  ): Promise<JacocoArtifactPair> {
    this.requireInside(targetDirectory, paths.reportPath);
    this.requireInside(targetDirectory, paths.branchSnapshotPath);
    await Promise.all([
      this.requireRealPathInside(targetDirectory, paths.reportPath),
      this.requireRealPathInside(targetDirectory, paths.branchSnapshotPath)
    ]);
    const [reportStat, snapshotStat] = await Promise.all([
      this.fileSystem.stat(paths.reportPath),
      this.fileSystem.stat(paths.branchSnapshotPath)
    ]);
    if (!reportStat.isFile() || reportStat.size <= 0 || reportStat.size > MAX_REPORT_BYTES) {
      throw new Error('JaCoCo XML 报告为空、不是文件或超过 16 MiB 上限。');
    }
    if (!snapshotStat.isFile() || snapshotStat.size <= 0 || snapshotStat.size > MAX_SNAPSHOT_BYTES) {
      throw new Error('JaCoCo 分支快照为空、不是文件或超过 32 MiB 上限。');
    }
    const [report, snapshotBytes] = await Promise.all([
      this.fileSystem.readFile(paths.reportPath),
      this.fileSystem.readFile(paths.branchSnapshotPath)
    ]);
    if (report.length !== reportStat.size || snapshotBytes.length !== snapshotStat.size) {
      throw new Error('JaCoCo 文件对在读取期间发生变化。');
    }
    const identity = this.snapshotIdentity(snapshotBytes);
    if (expectedPairId && identity.pairId !== expectedPairId) {
      throw new Error('JaCoCo 文件对 pairId 与生成响应不一致。');
    }
    if (sha256(report) !== identity.reportSha256) {
      throw new Error('JaCoCo XML 与分支快照的报告摘要不匹配。');
    }
    return {
      reportPath: resolve(paths.reportPath),
      branchSnapshotPath: resolve(paths.branchSnapshotPath),
      pairId: identity.pairId
    };
  }

  async readExactCoverageSnapshot(
    moduleRoot: string,
    pair: JacocoArtifactPair,
    countsValue: ExactCoverageCounts,
    expectedTargetClass?: string
  ): Promise<CoverageIdentitySnapshot> {
    const targetDirectory = resolve(moduleRoot, 'target');
    await this.validateTargetDirectory(moduleRoot, targetDirectory);
    const validatedPair = await this.readValidatedPair(
      targetDirectory,
      pair,
      pair.pairId
    );
    const [reportBytes, snapshotBytes] = await Promise.all([
      this.fileSystem.readFile(validatedPair.reportPath),
      this.fileSystem.readFile(validatedPair.branchSnapshotPath)
    ]);
    const snapshot = parseRecord(snapshotBytes, 'JaCoCo branch snapshot');
    if (
      expectedTargetClass !== undefined
      && snapshot.targetClass !== expectedTargetClass
    ) {
      throw new Error('JaCoCo branch snapshot target class does not match the class task.');
    }
    const counts = validateExactCounts(countsValue);
    const reportIdentities = exactCoverageIdentitiesFromReport(
      reportBytes,
      expectedTargetClass
    );
    if (reportIdentities) {
      const result: CoverageIdentitySnapshot = {
        pair: validatedPair,
        counts,
        ...reportIdentities
      };
      requireCoverageIdentityCounts(result, counts);
      await this.readValidatedPair(
        targetDirectory,
        validatedPair,
        validatedPair.pairId
      );
      return result;
    }
    const methods = requireArray(snapshot.methods, 'JaCoCo branch snapshot methods');
    const lines = new Map<number, boolean>();
    const branches = new Map<string, boolean>();
    for (const methodValue of methods) {
      const method = requireRecord(methodValue, 'JaCoCo branch snapshot method');
      const targets = requireArray(
        method.targets,
        'JaCoCo branch snapshot method targets'
      );
      for (const targetValue of targets) {
        const target = requireRecord(targetValue, 'JaCoCo coverage target');
        const kind = requireText(target.kind, 'JaCoCo coverage target kind');
        const covered = requireBoolean(
          target.covered,
          'JaCoCo coverage target covered flag'
        );
        if (kind === 'LINE_EXECUTE') {
          const sourceLine = requirePositiveSafeInteger(
            target.sourceLine,
            'JaCoCo line target source line'
          );
          lines.set(sourceLine, (lines.get(sourceLine) ?? false) || covered);
          continue;
        }
        if (kind !== 'BRANCH') continue;
        const targetId = requireText(
          target.targetId,
          'JaCoCo branch target identity'
        );
        if (branches.has(targetId)) {
          throw new Error('JaCoCo branch snapshot contains a duplicate branch identity.');
        }
        branches.set(targetId, covered);
      }
    }
    const orderedLines = [...lines.entries()].sort((left, right) => left[0] - right[0]);
    const orderedBranches = [...branches.entries()]
      .sort((left, right) => left[0].localeCompare(right[0], 'en-US'));
    const result: CoverageIdentitySnapshot = {
      pair: validatedPair,
      counts,
      lineIds: orderedLines.map(([line]) => `L${line}`),
      coveredLineIds: orderedLines
        .filter(([, covered]) => covered)
        .map(([line]) => `L${line}`),
      branchIds: orderedBranches.map(([identity]) => identity),
      coveredBranchIds: orderedBranches
        .filter(([, covered]) => covered)
        .map(([identity]) => identity)
    };
    requireCoverageIdentityCounts(result, counts);
    await this.readValidatedPair(
      targetDirectory,
      validatedPair,
      validatedPair.pairId
    );
    return result;
  }

  private async publishTaskState(
    session: TaskJacocoSessionPaths,
    sourceExecutionDataPath: string,
    sourcePair: JacocoArtifactPair,
    destination: {
      executionDataPath: string;
      pair: JacocoArtifactPairPaths;
    } = {
      executionDataPath: session.currentExecutionDataPath,
      pair: session.current
    }
  ): Promise<JacocoArtifactPair> {
    const validatedPair = await this.readValidatedPair(
      session.targetDirectory,
      sourcePair,
      sourcePair.pairId
    );
    await this.validateExecutionDataPath(
      session.targetDirectory,
      sourceExecutionDataPath
    );
    await this.requirePairExecutionData(validatedPair, sourceExecutionDataPath);
    await this.fileSystem.mkdir(session.taskDirectory, { recursive: true });
    await this.requireRealPathInside(session.targetDirectory, session.taskDirectory);
    const transactionId = randomUUID();
    const temporary = {
      executionDataPath: join(
        session.taskDirectory,
        `.task-${transactionId}.exec.tmp`
      ),
      reportPath: join(
        session.taskDirectory,
        `.task-${transactionId}.report.tmp`
      ),
      branchSnapshotPath: join(
        session.taskDirectory,
        `.task-${transactionId}.snapshot.tmp`
      )
    };
    const backup = {
      executionDataPath: join(
        session.taskDirectory,
        `.task-${transactionId}.exec.bak`
      ),
      reportPath: join(
        session.taskDirectory,
        `.task-${transactionId}.report.bak`
      ),
      branchSnapshotPath: join(
        session.taskDirectory,
        `.task-${transactionId}.snapshot.bak`
      )
    };
    for (const path of [
      ...Object.values(temporary),
      ...Object.values(backup),
      destination.executionDataPath,
      destination.pair.reportPath,
      destination.pair.branchSnapshotPath
    ]) {
      this.requireInside(session.taskDirectory, path);
    }

    let executionBackedUp = false;
    let reportBackedUp = false;
    let snapshotBackedUp = false;
    let executionCommitted = false;
    let reportCommitted = false;
    let snapshotCommitted = false;
    let preserveBackups = false;
    try {
      await this.fileSystem.copyFile(
        sourceExecutionDataPath,
        temporary.executionDataPath,
        constants.COPYFILE_EXCL
      );
      await this.fileSystem.copyFile(
        validatedPair.reportPath,
        temporary.reportPath,
        constants.COPYFILE_EXCL
      );
      await this.fileSystem.copyFile(
        validatedPair.branchSnapshotPath,
        temporary.branchSnapshotPath,
        constants.COPYFILE_EXCL
      );
      const temporaryPair = await this.readValidatedPair(
        session.targetDirectory,
        temporary,
        validatedPair.pairId
      );
      await this.validateExecutionDataPath(
        session.targetDirectory,
        temporary.executionDataPath
      );
      await this.requirePairExecutionData(
        temporaryPair,
        temporary.executionDataPath
      );

      if (await this.exists(destination.executionDataPath)) {
        await this.fileSystem.rename(
          destination.executionDataPath,
          backup.executionDataPath
        );
        executionBackedUp = true;
      }
      if (await this.exists(destination.pair.reportPath)) {
        await this.fileSystem.rename(destination.pair.reportPath, backup.reportPath);
        reportBackedUp = true;
      }
      if (await this.exists(destination.pair.branchSnapshotPath)) {
        await this.fileSystem.rename(
          destination.pair.branchSnapshotPath,
          backup.branchSnapshotPath
        );
        snapshotBackedUp = true;
      }
      await this.fileSystem.rename(
        temporary.executionDataPath,
        destination.executionDataPath
      );
      executionCommitted = true;
      await this.fileSystem.rename(temporary.reportPath, destination.pair.reportPath);
      reportCommitted = true;
      await this.fileSystem.rename(
        temporary.branchSnapshotPath,
        destination.pair.branchSnapshotPath
      );
      snapshotCommitted = true;
      const published = await this.readValidatedPair(
        session.targetDirectory,
        destination.pair,
        validatedPair.pairId
      );
      await this.requirePairExecutionData(
        published,
        destination.executionDataPath
      );
      return published;
    } catch (error) {
      try {
        if (executionCommitted) {
          await this.fileSystem.rm(destination.executionDataPath, { force: true });
        }
        if (reportCommitted) {
          await this.fileSystem.rm(destination.pair.reportPath, { force: true });
        }
        if (snapshotCommitted) {
          await this.fileSystem.rm(
            destination.pair.branchSnapshotPath,
            { force: true }
          );
        }
        if (executionBackedUp) {
          await this.fileSystem.rename(
            backup.executionDataPath,
            destination.executionDataPath
          );
          executionBackedUp = false;
        }
        if (reportBackedUp) {
          await this.fileSystem.rename(backup.reportPath, destination.pair.reportPath);
          reportBackedUp = false;
        }
        if (snapshotBackedUp) {
          await this.fileSystem.rename(
            backup.branchSnapshotPath,
            destination.pair.branchSnapshotPath
          );
          snapshotBackedUp = false;
        }
      } catch (rollbackError) {
        preserveBackups = true;
        throw new AggregateError(
          [error, rollbackError],
          'Task JaCoCo state promotion failed and rollback was incomplete.'
        );
      }
      throw error;
    } finally {
      const cleanupPaths = [
        this.fileSystem.rm(temporary.executionDataPath, { force: true }),
        this.fileSystem.rm(temporary.reportPath, { force: true }),
        this.fileSystem.rm(temporary.branchSnapshotPath, { force: true })
      ];
      if (!preserveBackups) {
        cleanupPaths.push(
          this.fileSystem.rm(backup.executionDataPath, { force: true }),
          this.fileSystem.rm(backup.reportPath, { force: true }),
          this.fileSystem.rm(backup.branchSnapshotPath, { force: true })
        );
      }
      await Promise.allSettled(cleanupPaths);
    }
  }

  private async publishPair(
    targetDirectory: string,
    source: JacocoArtifactPair,
    destination: JacocoArtifactPairPaths
  ): Promise<JacocoArtifactPair> {
    const validatedSource = await this.readValidatedPair(
      targetDirectory,
      source,
      source.pairId
    );
    this.requireInside(targetDirectory, destination.reportPath);
    this.requireInside(targetDirectory, destination.branchSnapshotPath);
    await Promise.all([
      this.fileSystem.mkdir(dirname(destination.reportPath), { recursive: true }),
      this.fileSystem.mkdir(dirname(destination.branchSnapshotPath), { recursive: true })
    ]);
    await Promise.all([
      this.requireRealPathInside(targetDirectory, dirname(destination.reportPath)),
      this.requireRealPathInside(targetDirectory, dirname(destination.branchSnapshotPath))
    ]);

    const transactionId = randomUUID();
    const temporary: JacocoArtifactPairPaths = {
      reportPath: join(dirname(destination.reportPath), `.jacoco-${transactionId}.report.tmp`),
      branchSnapshotPath: join(dirname(destination.branchSnapshotPath), `.jacoco-${transactionId}.snapshot.tmp`)
    };
    const backup: JacocoArtifactPairPaths = {
      reportPath: join(dirname(destination.reportPath), `.jacoco-${transactionId}.report.bak`),
      branchSnapshotPath: join(dirname(destination.branchSnapshotPath), `.jacoco-${transactionId}.snapshot.bak`)
    };
    for (const path of [
      temporary.reportPath,
      temporary.branchSnapshotPath,
      backup.reportPath,
      backup.branchSnapshotPath
    ]) {
      this.requireInside(targetDirectory, path);
    }

    let reportBackedUp = false;
    let snapshotBackedUp = false;
    let reportCommitted = false;
    let snapshotCommitted = false;
    try {
      await this.fileSystem.copyFile(
        validatedSource.reportPath,
        temporary.reportPath,
        constants.COPYFILE_EXCL
      );
      await this.fileSystem.copyFile(
        validatedSource.branchSnapshotPath,
        temporary.branchSnapshotPath,
        constants.COPYFILE_EXCL
      );
      await this.readValidatedPair(
        targetDirectory,
        temporary,
        validatedSource.pairId
      );

      if (await this.exists(destination.reportPath)) {
        await this.fileSystem.rename(destination.reportPath, backup.reportPath);
        reportBackedUp = true;
      }
      if (await this.exists(destination.branchSnapshotPath)) {
        await this.fileSystem.rename(destination.branchSnapshotPath, backup.branchSnapshotPath);
        snapshotBackedUp = true;
      }
      await this.fileSystem.rename(temporary.reportPath, destination.reportPath);
      reportCommitted = true;
      await this.fileSystem.rename(temporary.branchSnapshotPath, destination.branchSnapshotPath);
      snapshotCommitted = true;
      return await this.readValidatedPair(
        targetDirectory,
        destination,
        validatedSource.pairId
      );
    } catch (error) {
      try {
        if (reportCommitted) {
          await this.fileSystem.rm(destination.reportPath, { force: true });
        }
        if (snapshotCommitted) {
          await this.fileSystem.rm(destination.branchSnapshotPath, { force: true });
        }
        if (reportBackedUp) {
          await this.fileSystem.rename(backup.reportPath, destination.reportPath);
          reportBackedUp = false;
        }
        if (snapshotBackedUp) {
          await this.fileSystem.rename(backup.branchSnapshotPath, destination.branchSnapshotPath);
          snapshotBackedUp = false;
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'JaCoCo 文件对发布失败且回滚未完整完成。'
        );
      }
      throw error;
    } finally {
      await Promise.all([
        this.fileSystem.rm(temporary.reportPath, { force: true }),
        this.fileSystem.rm(temporary.branchSnapshotPath, { force: true }),
        this.fileSystem.rm(backup.reportPath, { force: true }),
        this.fileSystem.rm(backup.branchSnapshotPath, { force: true })
      ]);
    }
  }

  private snapshotIdentity(content: Buffer): SnapshotIdentity {
    let value: unknown;
    try {
      value = JSON.parse(content.toString('utf8'));
    } catch {
      throw new Error('JaCoCo 分支快照不是有效 JSON。');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('JaCoCo 分支快照结构无效。');
    }
    const snapshot = value as Record<string, unknown>;
    if (snapshot.schemaVersion !== 1) {
      throw new Error('JaCoCo 分支快照版本不受支持。');
    }
    if (
      typeof snapshot.pairId !== 'string'
      || !SHA256_PATTERN.test(snapshot.pairId)
      || typeof snapshot.reportSha256 !== 'string'
      || !SHA256_PATTERN.test(snapshot.reportSha256)
    ) {
      throw new Error('JaCoCo 分支快照缺少有效配对标识或报告摘要。');
    }
    const executionDataSha256 = snapshot.executionDataSha256 === undefined
      ? null
      : snapshot.executionDataSha256;
    if (
      executionDataSha256 !== null
      && (
        typeof executionDataSha256 !== 'string'
        || !SHA256_PATTERN.test(executionDataSha256)
      )
    ) {
      throw new Error('JaCoCo 分支快照中的执行数据摘要无效。');
    }
    return {
      pairId: snapshot.pairId.toLowerCase(),
      reportSha256: snapshot.reportSha256.toLowerCase(),
      executionDataSha256: typeof executionDataSha256 === 'string'
        ? executionDataSha256.toLowerCase()
        : null
    };
  }

  private async requirePairExecutionData(
    pair: JacocoArtifactPair,
    executionDataPath: string
  ): Promise<void> {
    const snapshotBytes = await this.fileSystem.readFile(pair.branchSnapshotPath);
    const identity = this.snapshotIdentity(snapshotBytes);
    if (!identity.executionDataSha256) {
      throw new Error('JaCoCo 分支快照缺少执行数据摘要。');
    }
    const stat = await this.fileSystem.stat(executionDataPath);
    const executionData = await this.fileSystem.readFile(executionDataPath);
    if (executionData.length !== stat.size) {
      throw new Error('JaCoCo 执行数据在读取期间发生变化。');
    }
    if (sha256(executionData) !== identity.executionDataSha256) {
      throw new Error('JaCoCo 分支快照与执行数据不匹配。');
    }
  }

  private requireExpectedPair(
    expected: JacocoArtifactPairPaths,
    actual: JacocoArtifactPair,
    label: string
  ): void {
    if (
      this.normalizePath(expected.reportPath) !== this.normalizePath(actual.reportPath)
      || this.normalizePath(expected.branchSnapshotPath)
        !== this.normalizePath(actual.branchSnapshotPath)
    ) {
      throw new Error(`java-analyzer 返回的 ${label} JaCoCo 文件对路径不匹配。`);
    }
  }

  private managedPath(targetDirectory: string, ...segments: string[]): string {
    return join(
      targetDirectory,
      'ai-unit-test',
      ...(this.artifactNamespace ? ['scopes', this.artifactNamespace] : []),
      ...segments
    );
  }

  private pairPaths(directory: string, baseName: string): JacocoArtifactPairPaths {
    return {
      reportPath: join(directory, `${baseName}.xml`),
      branchSnapshotPath: join(directory, `${baseName}.branches.json`)
    };
  }

  private requireFingerprint(fingerprint: string): void {
    if (!SHA256_PATTERN.test(fingerprint)) throw new TypeError('模块指纹无效。');
  }

  private requireUuid(value: string, label: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new TypeError(`${label} identity is invalid.`);
    }
    return value;
  }

  private async validateExecutionDataPath(
    targetDirectory: string,
    executionDataPath: string
  ): Promise<string> {
    this.requireInside(targetDirectory, executionDataPath);
    await this.requireRealPathInside(targetDirectory, executionDataPath);
    const stat = await this.fileSystem.stat(executionDataPath);
    if (!stat.isFile() || stat.size > MAX_EXECUTION_DATA_BYTES) {
      throw new Error(
        'JaCoCo execution data is not a file or exceeds 512 MiB.'
      );
    }
    return resolve(executionDataPath);
  }

  private async removePair(
    targetDirectory: string,
    pair: JacocoArtifactPairPaths
  ): Promise<void> {
    await this.removePath(targetDirectory, pair.reportPath, false);
    await this.removePath(targetDirectory, pair.branchSnapshotPath, false);
  }

  private async removePath(
    targetDirectory: string,
    candidatePath: string,
    recursive: boolean
  ): Promise<void> {
    this.requireInside(targetDirectory, candidatePath);
    try {
      await this.requireRealPathInside(targetDirectory, candidatePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return;
    }
    await this.fileSystem.rm(candidatePath, { recursive, force: true });
  }

  private async validateTargetDirectory(
    moduleRoot: string,
    targetDirectory: string
  ): Promise<void> {
    this.requireInside(moduleRoot, targetDirectory);
    const rootRealPath = await this.fileSystem.realpath(resolve(moduleRoot));
    const existingTargetAncestor = await nearestExisting(
      this.fileSystem,
      targetDirectory
    );
    const ancestorRealPath = await this.fileSystem.realpath(existingTargetAncestor);
    if (!this.isInside(rootRealPath, ancestorRealPath)) {
      throw new Error('Maven target 目录通过链接指向当前模块之外');
    }
  }

  private async requireRealPathInside(
    targetDirectory: string,
    candidatePath: string
  ): Promise<void> {
    const existingTargetAncestor = await nearestExisting(
      this.fileSystem,
      targetDirectory
    );
    const existingCandidateAncestor = await nearestExisting(
      this.fileSystem,
      candidatePath
    );
    const [targetRealPath, candidateRealPath] = await Promise.all([
      this.fileSystem.realpath(existingTargetAncestor),
      this.fileSystem.realpath(existingCandidateAncestor)
    ]);
    if (!this.isInside(targetRealPath, candidateRealPath)) {
      throw new Error(`拒绝访问 Maven target 目录之外的覆盖率产物：${candidatePath}`);
    }
  }

  private requireInside(parentPath: string, childPath: string): void {
    if (!this.isInside(resolve(parentPath), resolve(childPath))) {
      throw new Error(`拒绝访问 Maven target 目录之外的覆盖率产物：${childPath}`);
    }
  }

  private isInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(parentPath, childPath);
    return relativePath === ''
      || (!relativePath.startsWith(`..${sep}`)
        && relativePath !== '..'
        && !isAbsolute(relativePath));
  }

  private normalizePath(value: string): string {
    const normalized = resolve(value);
    return process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fileSystem.access(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

function parseRecord(value: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return requireRecord(parsed, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_000_000) {
    throw new TypeError(`${label} must be a bounded array.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} is invalid.`);
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function exactCoverageIdentitiesFromReport(
  reportBytes: Buffer,
  expectedTargetClass?: string
): ExactCoverageIdentities | null {
  const parseErrors: string[] = [];
  const document = new DOMParser({
    onError: (_level, message) => parseErrors.push(String(message))
  }).parseFromString(reportBytes.toString('utf8'), 'application/xml');
  if (parseErrors.length > 0 || !document.documentElement) {
    throw new Error('JaCoCo XML report is not valid XML.');
  }

  const classElements = document.getElementsByTagName('class');
  if (classElements.length === 0) return null;
  const expectedInternalName = expectedTargetClass?.replaceAll('.', '/');
  let targetClass: XmlElement | null = null;
  for (let index = 0; index < classElements.length; index += 1) {
    const candidate = classElements.item(index) as XmlElement | null;
    if (!candidate) continue;
    if (!expectedInternalName || candidate.getAttribute('name') === expectedInternalName) {
      targetClass = candidate;
      break;
    }
  }
  if (!targetClass) {
    throw new Error('JaCoCo XML report does not contain the expected target class.');
  }

  const sourceFileName = targetClass.getAttribute('sourcefilename');
  const packageElement = targetClass.parentNode as XmlElement | null;
  if (!sourceFileName || !packageElement) return null;
  const sourceFileElements = packageElement.getElementsByTagName('sourcefile');
  let sourceFile: XmlElement | null = null;
  for (let index = 0; index < sourceFileElements.length; index += 1) {
    const candidate = sourceFileElements.item(index) as XmlElement | null;
    if (candidate?.getAttribute('name') === sourceFileName) {
      sourceFile = candidate;
      break;
    }
  }
  if (!sourceFile) return null;

  const lines = new Map<number, {
    covered: boolean;
    branchCovered: number;
    branchTotal: number;
  }>();
  const lineElements = sourceFile.getElementsByTagName('line');
  for (let index = 0; index < lineElements.length; index += 1) {
    const line = lineElements.item(index) as XmlElement | null;
    if (!line) continue;
    const sourceLine = requireXmlCount(line, 'nr', true);
    const coveredInstructions = requireXmlCount(line, 'ci');
    requireXmlCount(line, 'mi');
    const missedBranches = requireXmlCount(line, 'mb');
    const coveredBranches = requireXmlCount(line, 'cb');
    if (lines.has(sourceLine)) {
      throw new Error('JaCoCo XML report contains a duplicate source line.');
    }
    lines.set(sourceLine, {
      covered: coveredInstructions > 0,
      branchCovered: coveredBranches,
      branchTotal: missedBranches + coveredBranches
    });
  }

  const lineIds: string[] = [];
  const coveredLineIds: string[] = [];
  const branchIds: string[] = [];
  const coveredBranchIds: string[] = [];
  for (const [sourceLine, coverage] of [...lines.entries()]
    .sort((left, right) => left[0] - right[0])) {
    const lineId = `L${sourceLine}`;
    lineIds.push(lineId);
    if (coverage.covered) coveredLineIds.push(lineId);
    for (let ordinal = 0; ordinal < coverage.branchTotal; ordinal += 1) {
      const branchId = `${lineId}:B${ordinal}`;
      branchIds.push(branchId);
      if (ordinal < coverage.branchCovered) coveredBranchIds.push(branchId);
    }
  }
  return { lineIds, coveredLineIds, branchIds, coveredBranchIds };
}

function requireXmlCount(
  element: XmlElement,
  attribute: string,
  positive = false
): number {
  const text = element.getAttribute(attribute);
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw new Error(`JaCoCo XML ${attribute} counter is invalid.`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || (positive ? value < 1 : value < 0)) {
    throw new Error(`JaCoCo XML ${attribute} counter is invalid.`);
  }
  return value;
}

function requireCoverageIdentityCounts(
  value: ExactCoverageIdentities,
  counts: ExactCoverageCounts
): void {
  if (
    value.lineIds.length !== counts.lineTotal
    || value.coveredLineIds.length !== counts.lineCovered
    || value.branchIds.length !== counts.branchTotal
    || value.coveredBranchIds.length !== counts.branchCovered
  ) {
    throw new Error(
      'JaCoCo exact counters do not match the paired report coverage identities.'
    );
  }
}

function validateExactCounts(value: ExactCoverageCounts): ExactCoverageCounts {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Exact coverage counters are invalid.');
  }
  const count = (candidate: number, label: string): number => {
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer.`);
    }
    return candidate;
  };
  const result: ExactCoverageCounts = {
    lineCovered: count(value.lineCovered, 'lineCovered'),
    lineMissed: count(value.lineMissed, 'lineMissed'),
    lineTotal: count(value.lineTotal, 'lineTotal'),
    branchCovered: count(value.branchCovered, 'branchCovered'),
    branchMissed: count(value.branchMissed, 'branchMissed'),
    branchTotal: count(value.branchTotal, 'branchTotal')
  };
  if (
    result.lineCovered + result.lineMissed !== result.lineTotal
    || result.branchCovered + result.branchMissed !== result.branchTotal
  ) {
    throw new Error('Exact coverage counters do not sum to their totals.');
  }
  return result;
}

async function nearestExisting(
  fileSystem: JacocoFileSystem,
  candidatePath: string
): Promise<string> {
  let candidate = resolve(candidatePath);
  for (;;) {
    try {
      await fileSystem.access(candidate);
      return candidate;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isBusyFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'EBUSY' || error.code === 'EPERM');
}
