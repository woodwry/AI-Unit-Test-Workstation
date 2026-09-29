import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  CoverageSnapshot,
  GeneratedTestFileRecord
} from '../../shared/types';
import type { JacocoArtifactPair } from './jacoco-artifacts.service.ts';
import type {
  TestWriterService,
  PreparedGeneratedTest
} from './test-writer.service.ts';
import {
  isGeneratedTestExternallyModifiedError
} from './test-writer.service.ts';

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_BRANCH_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

type InternalGeneratedFile = GeneratedTestFileRecord & {
  candidateId: string;
  content: string;
};

type InMemoryArtifactSnapshot = {
  filePath: string;
  content: Buffer;
  sha256: string;
};

type InMemoryCoveragePairSnapshot = {
  report: InMemoryArtifactSnapshot;
  branchSnapshot: InMemoryArtifactSnapshot;
  pairId: string;
};

type TransactionInput = {
  workspaceRoot: string;
  baselineCoverage: CoverageSnapshot;
};

export type GeneratedTestRevocationResult = {
  files: GeneratedTestFileRecord[];
  preservedExternallyModifiedFilePaths: string[];
};

type TransactionState = {
  input: TransactionInput;
  bestCoverage: CoverageSnapshot;
  bestFiles: InternalGeneratedFile[];
  currentCandidate: InternalGeneratedFile | null;
  baselineArtifactsSnapshot: InMemoryCoveragePairSnapshot | null;
  bestArtifactsSnapshot: InMemoryCoveragePairSnapshot | null;
  finished: boolean;
};

/**
 * 单次闭环生成的内存事务。
 *
 * 每轮正式候选使用独立的递增编号文件；全部已通过文件与最新 JaCoCo
 * XML/分支快照文件对共同晋升和恢复。摘要与内容只保存在主进程内存中。
 */
export class GeneratedTestTransactionService {
  private state: TransactionState | null = null;
  private readonly writer: TestWriterService;

  constructor(writer: TestWriterService) {
    this.writer = writer;
  }

  begin(input: TransactionInput): void {
    if (this.state) throw new Error('当前生成事务已经开始。');
    this.state = {
      input,
      bestCoverage: input.baselineCoverage,
      bestFiles: [],
      currentCandidate: null,
      baselineArtifactsSnapshot: null,
      bestArtifactsSnapshot: null,
      finished: false
    };
  }

  async initializeBaselineArtifacts(artifacts: JacocoArtifactPair): Promise<void> {
    const state = this.requireMutableState();
    if (state.baselineArtifactsSnapshot) {
      throw new Error('生成事务的基线 JaCoCo 文件对已经初始化。');
    }
    const snapshot = await this.readCoveragePair(artifacts);
    state.baselineArtifactsSnapshot = this.cloneCoveragePair(snapshot);
    state.bestArtifactsSnapshot = this.cloneCoveragePair(snapshot);
  }

  async stageCandidate(input: {
    candidateId: string;
    prepared: PreparedGeneratedTest;
  }): Promise<GeneratedTestFileRecord> {
    const state = this.requireMutableState();
    this.requireArtifactsInitialized(state);
    const previous = state.currentCandidate;
    if (
      previous
      && this.normalizePath(previous.filePath)
        !== this.normalizePath(input.prepared.testFilePath)
    ) {
      throw new Error('当前轮次只能替换同一个候选测试文件。');
    }

    let written: {
      testFilePath: string;
      relativePath: string;
      testClassName: string;
      sha256: string;
    };
    if (!previous) {
      if (state.bestFiles.some(
        (file) => this.normalizePath(file.filePath)
          === this.normalizePath(input.prepared.testFilePath)
      )) {
        throw new Error('规划的测试文件位置已被当前会话的前序轮次占用。');
      }
      try {
        written = await this.writer.writePreparedGeneratedTest(input.prepared);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error('计划的测试文件位置已被占用，请重新开始生成。');
        }
        throw error;
      }
    } else {
      const replacement = this.writer.prepareReplacement({
        workspaceRoot: state.input.workspaceRoot,
        filePath: previous.filePath,
        content: input.prepared.content
      });
      const replaced = await this.writer.replacePreparedGeneratedTest({
        workspaceRoot: state.input.workspaceRoot,
        filePath: previous.filePath,
        expectedSha256: previous.sha256,
        prepared: replacement
      });
      written = {
        testFilePath: previous.filePath,
        relativePath: previous.relativePath,
        testClassName: replacement.testClassName,
        sha256: replaced.sha256
      };
    }

    const candidate: InternalGeneratedFile = {
      candidateId: input.candidateId,
      filePath: written.testFilePath,
      relativePath: written.relativePath,
      testClassName: written.testClassName,
      sha256: written.sha256,
      state: 'candidate',
      content: input.prepared.content
    };
    state.currentCandidate = candidate;
    return this.publicFile(candidate);
  }

  async promoteCandidate(
    candidateId: string,
    coverage: CoverageSnapshot,
    artifacts: JacocoArtifactPair
  ): Promise<void> {
    const state = this.requireMutableState();
    const candidate = this.requireCurrentCandidate(state, candidateId);
    const bestArtifacts = this.requireBestArtifacts(state);
    await this.writer.assertGeneratedTestUnchanged({
      workspaceRoot: state.input.workspaceRoot,
      filePath: candidate.filePath,
      expectedSha256: candidate.sha256
    });
    const candidateArtifacts = await this.readCoveragePair(artifacts);
    if (
      this.normalizePath(candidateArtifacts.report.filePath)
        === this.normalizePath(bestArtifacts.report.filePath)
      || this.normalizePath(candidateArtifacts.branchSnapshot.filePath)
        === this.normalizePath(bestArtifacts.branchSnapshot.filePath)
    ) {
      throw new Error('候选 JaCoCo 文件对必须使用独立路径生成。');
    }
    await this.replaceCoveragePairContents(
      state,
      bestArtifacts,
      candidateArtifacts
    );

    const promoted: InternalGeneratedFile = { ...candidate, state: 'best' };
    state.bestFiles.push(promoted);
    state.currentCandidate = null;
    state.bestCoverage = coverage;
    state.bestArtifactsSnapshot = {
      report: {
        filePath: bestArtifacts.report.filePath,
        content: Buffer.from(candidateArtifacts.report.content),
        sha256: candidateArtifacts.report.sha256
      },
      branchSnapshot: {
        filePath: bestArtifacts.branchSnapshot.filePath,
        content: Buffer.from(candidateArtifacts.branchSnapshot.content),
        sha256: candidateArtifacts.branchSnapshot.sha256
      },
      pairId: candidateArtifacts.pairId
    };
  }

  /** 恢复当前最佳代码；可选地把本轮临时覆盖文件对也恢复成最佳内容。 */
  async rollbackCandidate(
    candidateId: string,
    currentArtifacts?: JacocoArtifactPair
  ): Promise<void> {
    const state = this.requireMutableState();
    const candidate = state.currentCandidate;
    if (!candidate || candidate.candidateId !== candidateId) return;

    if (currentArtifacts) {
      const current = await this.readCoveragePair(currentArtifacts);
      const best = this.requireBestArtifacts(state);
      await this.replaceCoveragePairContents(state, current, best);
    }

    await this.writer.deleteGeneratedTest({
      workspaceRoot: state.input.workspaceRoot,
      filePath: candidate.filePath,
      expectedSha256: candidate.sha256
    });
    state.currentCandidate = null;
  }

  hasBestFiles(): boolean {
    return Boolean(this.state?.bestFiles.length);
  }

  getBestCoverage(): CoverageSnapshot {
    return this.requireState().bestCoverage;
  }

  getBestArtifacts(): JacocoArtifactPair {
    const best = this.requireBestArtifacts(this.requireState());
    return {
      reportPath: best.report.filePath,
      branchSnapshotPath: best.branchSnapshot.filePath,
      pairId: best.pairId
    };
  }

  getBestReportPath(): string {
    return this.getBestArtifacts().reportPath;
  }

  getCurrentCandidateId(): string | null {
    return this.requireState().currentCandidate?.candidateId ?? null;
  }

  getCurrentCandidate(): GeneratedTestFileRecord | null {
    const candidate = this.requireState().currentCandidate;
    return candidate ? this.publicFile(candidate) : null;
  }

  async accept(): Promise<GeneratedTestFileRecord[]> {
    const state = this.requireMutableState();
    if (state.currentCandidate) {
      await this.rollbackCandidate(state.currentCandidate.candidateId);
    }
    await this.requireCoveragePairHash(this.requireBestArtifacts(state));
    for (const file of state.bestFiles) {
      await this.writer.assertGeneratedTestUnchanged({
        workspaceRoot: state.input.workspaceRoot,
        filePath: file.filePath,
        expectedSha256: file.sha256
      });
    }
    state.bestFiles = state.bestFiles.map((file) => ({
      ...file,
      state: 'accepted'
    }));
    const files = state.bestFiles.map((file) => this.publicFile(file));
    return files;
  }

  async revoke(): Promise<GeneratedTestRevocationResult> {
    const state = this.requireMutableState();
    if (state.currentCandidate) {
      try {
        await this.rollbackCandidate(state.currentCandidate.candidateId);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        state.currentCandidate = null;
      }
    }
    const baseline = state.baselineArtifactsSnapshot;
    const best = this.requireBestArtifacts(state);
    if (!baseline) throw new Error('生成事务缺少基线 JaCoCo 文件对。');

    await this.replaceCoveragePairContents(state, best, baseline);
    const preservedExternallyModifiedFilePaths: string[] = [];
    for (const file of state.bestFiles) {
      try {
        await this.writer.deleteGeneratedTest({
          workspaceRoot: state.input.workspaceRoot,
          filePath: file.filePath,
          expectedSha256: file.sha256
        });
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        if (!isGeneratedTestExternallyModifiedError(error)) {
          throw error;
        }
        preservedExternallyModifiedFilePaths.push(file.filePath);
      }
    }
    state.bestFiles = state.bestFiles.map((file) => ({
      ...file,
      state: 'revoked'
    }));
    state.currentCandidate = null;
    state.baselineArtifactsSnapshot = null;
    state.bestArtifactsSnapshot = null;
    state.finished = true;
    return {
      files: state.bestFiles.map((file) => this.publicFile(file)),
      preservedExternallyModifiedFilePaths
    };
  }

  snapshot(): GeneratedTestFileRecord[] {
    const state = this.requireState();
    return [
      ...state.bestFiles.map((file) => this.publicFile(file)),
      ...(state.currentCandidate ? [this.publicFile(state.currentCandidate)] : [])
    ];
  }

  private async readCoveragePair(
    artifacts: JacocoArtifactPair
  ): Promise<InMemoryCoveragePairSnapshot> {
    if (!artifacts || !SHA256_PATTERN.test(artifacts.pairId)) {
      throw new Error('JaCoCo 文件对缺少有效 pairId。');
    }
    const [report, branchSnapshot] = await Promise.all([
      this.readArtifactSnapshot(
        artifacts.reportPath,
        MAX_REPORT_BYTES,
        'JaCoCo XML 报告'
      ),
      this.readArtifactSnapshot(
        artifacts.branchSnapshotPath,
        MAX_BRANCH_SNAPSHOT_BYTES,
        'JaCoCo 分支快照'
      )
    ]);
    const identity = this.readSnapshotIdentity(branchSnapshot.content);
    if (identity.pairId !== artifacts.pairId.toLowerCase()) {
      throw new Error('JaCoCo 文件对 pairId 与分支快照不一致。');
    }
    if (identity.reportSha256 !== report.sha256) {
      throw new Error('JaCoCo XML 与分支快照的报告摘要不匹配。');
    }
    return {
      report,
      branchSnapshot,
      pairId: identity.pairId
    };
  }

  private async readArtifactSnapshot(
    filePath: string,
    maxBytes: number,
    label: string
  ): Promise<InMemoryArtifactSnapshot> {
    const workspaceRoot = await fs.realpath(
      resolve(this.requireState().input.workspaceRoot)
    );
    const canonicalPath = await fs.realpath(resolve(filePath));
    const relativePath = relative(workspaceRoot, canonicalPath);
    if (
      relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(`拒绝读取当前工作区之外的 ${label}。`);
    }
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`${label}为空、不是文件或超过体积上限。`);
    }
    const content = await fs.readFile(canonicalPath);
    if (content.length !== stat.size || content.length > maxBytes) {
      throw new Error(`${label}在读取期间发生变化，请重新开始生成。`);
    }
    return {
      filePath: canonicalPath,
      content,
      sha256: generatedTestContentSha256(content)
    };
  }

  private readSnapshotIdentity(content: Buffer): {
    pairId: string;
    reportSha256: string;
  } {
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
    if (
      snapshot.schemaVersion !== 1
      || typeof snapshot.pairId !== 'string'
      || !SHA256_PATTERN.test(snapshot.pairId)
      || typeof snapshot.reportSha256 !== 'string'
      || !SHA256_PATTERN.test(snapshot.reportSha256)
    ) {
      throw new Error('JaCoCo 分支快照缺少有效配对标识或报告摘要。');
    }
    return {
      pairId: snapshot.pairId.toLowerCase(),
      reportSha256: snapshot.reportSha256.toLowerCase()
    };
  }

  private async replaceCoveragePairContents(
    state: TransactionState,
    current: InMemoryCoveragePairSnapshot,
    replacement: InMemoryCoveragePairSnapshot
  ): Promise<void> {
    await this.requireCoveragePairHash(current);
    let reportReplaced = false;
    let branchSnapshotReplaced = false;
    try {
      if (current.report.sha256 !== replacement.report.sha256) {
        await this.writer.replaceOwnedArtifact({
          workspaceRoot: state.input.workspaceRoot,
          filePath: current.report.filePath,
          expectedSha256: current.report.sha256,
          content: replacement.report.content,
          maxBytes: MAX_REPORT_BYTES,
          conflictMessage: 'JaCoCo XML 报告已被其他进程修改，请重新开始生成。'
        });
        reportReplaced = true;
      }
      if (current.branchSnapshot.sha256 !== replacement.branchSnapshot.sha256) {
        await this.writer.replaceOwnedArtifact({
          workspaceRoot: state.input.workspaceRoot,
          filePath: current.branchSnapshot.filePath,
          expectedSha256: current.branchSnapshot.sha256,
          content: replacement.branchSnapshot.content,
          maxBytes: MAX_BRANCH_SNAPSHOT_BYTES,
          conflictMessage: 'JaCoCo 分支快照已被其他进程修改，请重新开始生成。'
        });
        branchSnapshotReplaced = true;
      }
      await this.requireArtifactHash(
        current.report.filePath,
        replacement.report.sha256,
        'JaCoCo XML 报告发布后摘要不一致。'
      );
      await this.requireArtifactHash(
        current.branchSnapshot.filePath,
        replacement.branchSnapshot.sha256,
        'JaCoCo 分支快照发布后摘要不一致。'
      );
    } catch (error) {
      try {
        if (branchSnapshotReplaced) {
          await this.writer.replaceOwnedArtifact({
            workspaceRoot: state.input.workspaceRoot,
            filePath: current.branchSnapshot.filePath,
            expectedSha256: replacement.branchSnapshot.sha256,
            content: current.branchSnapshot.content,
            maxBytes: MAX_BRANCH_SNAPSHOT_BYTES,
            conflictMessage: 'JaCoCo 分支快照发布失败且无法回滚。'
          });
        }
        if (reportReplaced) {
          await this.writer.replaceOwnedArtifact({
            workspaceRoot: state.input.workspaceRoot,
            filePath: current.report.filePath,
            expectedSha256: replacement.report.sha256,
            content: current.report.content,
            maxBytes: MAX_REPORT_BYTES,
            conflictMessage: 'JaCoCo XML 报告发布失败且无法回滚。'
          });
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'JaCoCo 文件对替换失败且回滚未完整完成。'
        );
      }
      throw error;
    }
  }

  private async requireCoveragePairHash(
    pair: InMemoryCoveragePairSnapshot
  ): Promise<void> {
    await this.requireArtifactHash(
      pair.report.filePath,
      pair.report.sha256,
      'JaCoCo XML 报告已被其他进程修改，请重新开始生成。'
    );
    await this.requireArtifactHash(
      pair.branchSnapshot.filePath,
      pair.branchSnapshot.sha256,
      'JaCoCo 分支快照已被其他进程修改，请重新开始生成。'
    );
  }

  private async requireArtifactHash(
    filePath: string,
    expectedSha256: string,
    message: string
  ): Promise<void> {
    let content: Buffer;
    try {
      content = await fs.readFile(filePath);
    } catch {
      throw new Error(message);
    }
    if (generatedTestContentSha256(content) !== expectedSha256) {
      throw new Error(message);
    }
  }

  private requireCurrentCandidate(
    state: TransactionState,
    candidateId: string
  ): InternalGeneratedFile {
    const candidate = state.currentCandidate;
    if (!candidate || candidate.candidateId !== candidateId) {
      throw new Error('当前候选文件不存在或身份不匹配。');
    }
    return candidate;
  }

  private requireArtifactsInitialized(state: TransactionState): void {
    if (!state.baselineArtifactsSnapshot || !state.bestArtifactsSnapshot) {
      throw new Error('生成事务尚未初始化基线 JaCoCo 文件对。');
    }
  }

  private requireBestArtifacts(
    state: TransactionState
  ): InMemoryCoveragePairSnapshot {
    this.requireArtifactsInitialized(state);
    return state.bestArtifactsSnapshot!;
  }

  private publicFile(file: InternalGeneratedFile): GeneratedTestFileRecord {
    const { candidateId: _candidateId, content: _content, ...publicRecord } = file;
    return publicRecord;
  }

  private cloneCoveragePair(
    snapshot: InMemoryCoveragePairSnapshot
  ): InMemoryCoveragePairSnapshot {
    return {
      report: this.cloneArtifact(snapshot.report),
      branchSnapshot: this.cloneArtifact(snapshot.branchSnapshot),
      pairId: snapshot.pairId
    };
  }

  private cloneArtifact(
    snapshot: InMemoryArtifactSnapshot
  ): InMemoryArtifactSnapshot {
    return {
      filePath: snapshot.filePath,
      content: Buffer.from(snapshot.content),
      sha256: snapshot.sha256
    };
  }

  private normalizePath(value: string): string {
    const normalized = resolve(value);
    return process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  }

  private requireMutableState(): TransactionState {
    const state = this.requireState();
    if (state.finished) throw new Error('生成事务已经结束。');
    return state;
  }

  private requireState(): TransactionState {
    if (!this.state) throw new Error('生成事务尚未开始。');
    return this.state;
  }
}

export function generatedTestContentSha256(
  value: string | Buffer
): string {
  return createHash('sha256').update(value).digest('hex');
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'EEXIST' || error.code === 'EPERM');
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
