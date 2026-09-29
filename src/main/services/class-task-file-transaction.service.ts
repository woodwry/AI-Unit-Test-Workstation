import type {
  GeneratedClassTaskArtifact,
  GeneratedSourceMethodResult
} from '../../shared/class-task-contracts.ts';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';
import {
  isGeneratedTestExternallyModifiedError,
  type TestWriterService
} from './test-writer.service.ts';
import {
  generatedTestContentSha256
} from './generated-test-transaction.service.ts';

const MAX_GENERATED_TEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

type TrackedArtifact = {
  taskId: string;
  workspaceRoot: string;
  artifact: GeneratedClassTaskArtifact;
  existedBefore: boolean;
  originalContent: Buffer | null;
  originalSha256: string | null;
  rollbackAvailable: boolean;
  revoked: boolean;
};

export type TrackClassTaskFileInput = {
  taskId: string;
  workspaceRoot: string;
  filePath: string;
  testClassName: string;
  sha256: string;
  ordinaryTestMethodCount: number;
  methodIds: string[];
  methodResults?: GeneratedSourceMethodResult[];
  sealed: boolean;
  existedBefore: boolean;
  originalContent?: string | Buffer;
};

export type UpdateClassTaskFileInput = {
  taskId: string;
  artifactId: string;
  previousSha256: string;
  sha256: string;
  ordinaryTestMethodCount: number;
  methodIds: string[];
  methodResults?: GeneratedSourceMethodResult[];
  sealed: boolean;
};

export type SealClassTaskFileInput = {
  taskId: string;
  artifactId: string;
  expectedSha256: string;
};

export type ClassTaskFileRevocationResult = {
  revokedArtifactIds: string[];
  conflictingFilePaths: string[];
};

export type RevokeClassTaskFilesOptions = {
  /** 已接受产物可能仍引用这些路径；撤回未接受结果时绝不能删除它们。 */
  protectedFilePaths?: readonly string[];
};

export type RestoreClassTaskFilesInput = {
  taskId: string;
  workspaceRoot: string;
  artifacts: readonly GeneratedClassTaskArtifact[];
};

export type RestoreClassTaskFileSnapshotInput = {
  taskId: string;
  artifacts: readonly GeneratedClassTaskArtifact[];
};

export type WaveCandidateFileMove = {
  candidateId: string;
  workspaceRoot: string;
  testClassName: string;
  sourcePath: string;
  targetPath: string;
  sha256: string;
};

export type WaveCandidateMoveTransaction = {
  candidateId: string;
  sourcePath: string;
  targetPath: string;
  sha256: string;
  phase: 'PREPARED' | 'MOVED';
};

export type MoveWaveCandidateFilesInput = {
  moves: readonly WaveCandidateFileMove[];
  saveMoveTransactions: (
    transactions: readonly WaveCandidateMoveTransaction[]
  ) => Promise<void>;
};

export type RecoverWaveCandidateMoveInput = WaveCandidateFileMove & {
  phase: WaveCandidateMoveTransaction['phase'];
};

export type RecoveredWaveCandidateMove = {
  candidateId: string;
  filePath: string;
  sha256: string;
  location: 'ISOLATED' | 'PROJECT';
  outcome: 'ROLLED_BACK' | 'COMPLETED';
};

export class ClassTaskFileRevocationConflictError extends Error {
  readonly code = 'CLASS_TASK_FILE_REVOCATION_CONFLICT';
  readonly conflictingFilePaths: string[];
  readonly revokedArtifactIds: string[];

  constructor(result: ClassTaskFileRevocationResult) {
    super(
      'One or more generated test files were modified by the user; '
      + 'those files were preserved.'
    );
    this.name = 'ClassTaskFileRevocationConflictError';
    this.conflictingFilePaths = [...result.conflictingFilePaths];
    this.revokedArtifactIds = [...result.revokedArtifactIds];
  }
}

export type ClassTaskFileTransactionOptions = {
  writer: Pick<
    TestWriterService,
    | 'assertGeneratedTestUnchanged'
    | 'deleteGeneratedTestIfPresent'
    | 'replaceOwnedArtifact'
  >;
  idFactory?: () => string;
  now?: () => Date;
};

export class ClassTaskFileTransactionService {
  private readonly writer: ClassTaskFileTransactionOptions['writer'];
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly recordsByTask = new Map<string, Map<string, TrackedArtifact>>();
  private readonly artifactIdByPath = new Map<string, string>();
  private readonly artifactIds = new Set<string>();
  private readonly acceptedTaskIds = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: ClassTaskFileTransactionOptions) {
    this.writer = options.writer;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  track(input: TrackClassTaskFileInput): Promise<GeneratedClassTaskArtifact> {
    return this.enqueue(() => this.trackNow(input));
  }

  moveWaveCandidateFiles(
    input: MoveWaveCandidateFilesInput
  ): Promise<WaveCandidateMoveTransaction[]> {
    return this.enqueue(() => this.moveWaveCandidateFilesNow(input));
  }

  recoverWaveCandidateMove(
    input: RecoverWaveCandidateMoveInput
  ): Promise<RecoveredWaveCandidateMove> {
    return this.enqueue(() => this.recoverWaveCandidateMoveNow(input));
  }

  private async recoverWaveCandidateMoveNow(
    input: RecoverWaveCandidateMoveInput
  ): Promise<RecoveredWaveCandidateMove> {
    if (input.phase !== 'PREPARED' && input.phase !== 'MOVED') {
      throw new TypeError('Wave candidate recovery phase is invalid.');
    }
    const move = validateWaveCandidateMoves([input])[0];
    const [source, target] = await Promise.all([
      inspectWaveCandidateMovePath(move.sourcePath, move.sha256),
      inspectWaveCandidateMovePath(move.targetPath, move.sha256)
    ]);
    if (!source.exists && !target.exists) {
      throw new Error('Wave candidate move recovery cannot find either managed file.');
    }
    if (source.exists && target.exists) {
      const keepTarget = input.phase === 'MOVED';
      await rm(keepTarget ? move.sourcePath : move.targetPath, { force: false });
      return recoveredWaveMove(move, keepTarget);
    }
    return recoveredWaveMove(move, target.exists);
  }

  private async moveWaveCandidateFilesNow(
    input: MoveWaveCandidateFilesInput
  ): Promise<WaveCandidateMoveTransaction[]> {
    const moves = validateWaveCandidateMoves(input.moves);
    await Promise.all(moves.map((move) => requireWaveCandidateMoveSource(move)));
    const prepared = moves.map((move): WaveCandidateMoveTransaction => ({
      candidateId: move.candidateId,
      sourcePath: move.sourcePath,
      targetPath: move.targetPath,
      sha256: move.sha256,
      phase: 'PREPARED'
    }));
    await input.saveMoveTransactions(cloneMoveTransactions(prepared));

    const moved: WaveCandidateFileMove[] = [];
    try {
      for (const move of moves) {
        await mkdir(dirname(move.targetPath), { recursive: true });
        await rename(move.sourcePath, move.targetPath);
        moved.push(move);
        const content = await readFile(move.targetPath);
        if (generatedTestContentSha256(content) !== move.sha256) {
          throw new Error('Wave candidate digest changed during the file move.');
        }
      }
      const committed = prepared.map((transaction) => ({
        ...transaction,
        phase: 'MOVED' as const
      }));
      await input.saveMoveTransactions(cloneMoveTransactions(committed));
      return committed;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const move of moved.reverse()) {
        try {
          await mkdir(dirname(move.sourcePath), { recursive: true });
          await rename(move.targetPath, move.sourcePath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Wave candidate move failed and could not be rolled back completely.'
        );
      }
      throw error;
    }
  }

  private async trackNow(
    input: TrackClassTaskFileInput
  ): Promise<GeneratedClassTaskArtifact> {
    validateMetadata(input);
    assertGeneratedTestPath(
      input.workspaceRoot,
      input.filePath,
      input.testClassName
    );
    if (this.acceptedTaskIds.has(input.taskId)) {
      throw new Error('The class task was accepted and its file transaction is finished.');
    }
    const pathKey = normalizePath(input.filePath);
    if (this.artifactIdByPath.has(pathKey)) {
      throw new Error('The generated test file is already owned by a class task.');
    }
    const records = this.recordsFor(input.taskId);
    const id = this.idFactory();
    if (!id || this.artifactIds.has(id)) {
      throw new Error('The generated test artifact identifier is invalid or duplicated.');
    }
    await this.writer.assertGeneratedTestUnchanged({
      workspaceRoot: input.workspaceRoot,
      filePath: input.filePath,
      expectedSha256: input.sha256
    });
    const originalContent = input.existedBefore
      ? toOriginalBuffer(input.originalContent)
      : null;
    if (originalContent && originalContent.length > MAX_GENERATED_TEST_BYTES) {
      throw new Error('The original generated-test file exceeds the rollback limit.');
    }
    const timestamp = this.now().toISOString();
    const artifact: GeneratedClassTaskArtifact = {
      id,
      filePath: input.filePath,
      testClassName: input.testClassName,
      ordinaryTestMethodCount: input.ordinaryTestMethodCount,
      methodIds: [...input.methodIds],
      methodResults: cloneMethodResults(input.methodResults ?? []),
      sha256: input.sha256.toLowerCase(),
      sealed: input.sealed,
      accepted: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    records.set(id, {
      taskId: input.taskId,
      workspaceRoot: input.workspaceRoot,
      artifact,
      existedBefore: input.existedBefore,
      originalContent,
      originalSha256: originalContent
        ? generatedTestContentSha256(originalContent)
        : null,
      rollbackAvailable: true,
      revoked: false
    });
    this.artifactIdByPath.set(pathKey, id);
    this.artifactIds.add(id);
    return cloneArtifact(artifact);
  }

  restoreTask(input: RestoreClassTaskFilesInput): Promise<void> {
    return this.enqueue(() => this.restoreTaskNow(input));
  }

  private async restoreTaskNow(input: RestoreClassTaskFilesInput): Promise<void> {
    if (this.recordsByTask.has(input.taskId) || this.acceptedTaskIds.has(input.taskId)) {
      throw new Error('The class-task file transaction is already initialized.');
    }
    const acceptedStates = new Set(input.artifacts.map((artifact) => artifact.accepted));
    if (acceptedStates.size > 1) {
      throw new Error('Persisted artifacts contain a mixed accepted state.');
    }
    const restoredIds = new Set<string>();
    const restoredPaths = new Set<string>();
    for (const artifact of input.artifacts) {
      validateRestoredArtifact(artifact);
      assertGeneratedTestPath(
        input.workspaceRoot,
        artifact.filePath,
        artifact.testClassName
      );
      const pathKey = normalizePath(artifact.filePath);
      if (
        restoredIds.has(artifact.id)
        || this.artifactIds.has(artifact.id)
        || restoredPaths.has(pathKey)
        || this.artifactIdByPath.has(pathKey)
      ) {
        throw new Error('Persisted generated test ownership is duplicated.');
      }
      restoredIds.add(artifact.id);
      restoredPaths.add(pathKey);
    }

    const records = new Map<string, TrackedArtifact>();
    for (const artifactValue of input.artifacts) {
      const artifact = cloneArtifact(artifactValue);
      records.set(artifact.id, {
        taskId: input.taskId,
        workspaceRoot: input.workspaceRoot,
        artifact,
        existedBefore: false,
        originalContent: null,
        originalSha256: null,
        rollbackAvailable: !artifact.accepted,
        revoked: false
      });
      this.artifactIds.add(artifact.id);
      this.artifactIdByPath.set(normalizePath(artifact.filePath), artifact.id);
    }
    this.recordsByTask.set(input.taskId, records);
    if (input.artifacts[0]?.accepted) this.acceptedTaskIds.add(input.taskId);
  }

  update(input: UpdateClassTaskFileInput): Promise<GeneratedClassTaskArtifact> {
    return this.enqueue(() => this.updateNow(input));
  }

  seal(input: SealClassTaskFileInput): Promise<GeneratedClassTaskArtifact> {
    return this.enqueue(() => this.sealNow(input));
  }

  restoreSnapshot(input: RestoreClassTaskFileSnapshotInput): Promise<void> {
    return this.enqueue(() => this.restoreSnapshotNow(input));
  }

  private async updateNow(
    input: UpdateClassTaskFileInput
  ): Promise<GeneratedClassTaskArtifact> {
    validateUpdate(input);
    const record = this.requireMutableRecord(input.taskId, input.artifactId);
    if (record.artifact.sealed) {
      throw new Error('A sealed formal test artifact cannot be updated.');
    }
    if (record.artifact.sha256 !== input.previousSha256.toLowerCase()) {
      throw new Error('The formal test artifact version is stale.');
    }
    if (
      input.ordinaryTestMethodCount <= record.artifact.ordinaryTestMethodCount
      || input.methodIds.length <= record.artifact.methodIds.length
      || record.artifact.methodIds.some((methodId, index) => (
        input.methodIds[index] !== methodId
      ))
    ) {
      throw new Error('A formal test artifact update must append whole source methods.');
    }
    await this.writer.assertGeneratedTestUnchanged({
      workspaceRoot: record.workspaceRoot,
      filePath: record.artifact.filePath,
      expectedSha256: input.sha256
    });
    record.artifact = {
      ...record.artifact,
      sha256: input.sha256.toLowerCase(),
      ordinaryTestMethodCount: input.ordinaryTestMethodCount,
      methodIds: [...input.methodIds],
      methodResults: cloneMethodResults(input.methodResults ?? []),
      sealed: input.sealed,
      updatedAt: this.now().toISOString()
    };
    return cloneArtifact(record.artifact);
  }

  private async sealNow(
    input: SealClassTaskFileInput
  ): Promise<GeneratedClassTaskArtifact> {
    validateSeal(input);
    const record = this.requireMutableRecord(input.taskId, input.artifactId);
    if (record.artifact.sha256 !== input.expectedSha256.toLowerCase()) {
      throw new Error('The formal test artifact version is stale.');
    }
    if (record.artifact.sealed) return cloneArtifact(record.artifact);
    await this.writer.assertGeneratedTestUnchanged({
      workspaceRoot: record.workspaceRoot,
      filePath: record.artifact.filePath,
      expectedSha256: record.artifact.sha256
    });
    record.artifact = {
      ...record.artifact,
      sealed: true,
      updatedAt: this.now().toISOString()
    };
    return cloneArtifact(record.artifact);
  }

  private async restoreSnapshotNow(
    input: RestoreClassTaskFileSnapshotInput
  ): Promise<void> {
    if (!input.taskId || this.acceptedTaskIds.has(input.taskId)) {
      throw new Error('The formal test artifact snapshot cannot be restored.');
    }
    const records = this.recordsByTask.get(input.taskId);
    if (!records) {
      throw new Error('The class-task file transaction is not initialized.');
    }
    const snapshotIds = new Set<string>();
    for (const artifact of input.artifacts) {
      validateRestoredArtifact(artifact);
      const record = records.get(artifact.id);
      if (
        snapshotIds.has(artifact.id)
        || !record
        || record.revoked
        || artifact.accepted
        || record.artifact.accepted
        || normalizePath(record.artifact.filePath) !== normalizePath(artifact.filePath)
        || record.artifact.testClassName !== artifact.testClassName
        || record.artifact.createdAt !== artifact.createdAt
      ) {
        throw new Error('The formal test artifact snapshot identity is invalid.');
      }
      snapshotIds.add(artifact.id);
      await this.writer.assertGeneratedTestUnchanged({
        workspaceRoot: record.workspaceRoot,
        filePath: artifact.filePath,
        expectedSha256: artifact.sha256
      });
    }

    for (const [artifactId, record] of records) {
      if (snapshotIds.has(artifactId)) continue;
      this.artifactIdByPath.delete(normalizePath(record.artifact.filePath));
      this.artifactIds.delete(artifactId);
      records.delete(artifactId);
    }
    for (const artifact of input.artifacts) {
      const record = records.get(artifact.id)!;
      record.artifact = cloneArtifact(artifact);
    }
  }

  accept(taskId: string): Promise<GeneratedClassTaskArtifact[]> {
    return this.enqueue(() => this.acceptNow(taskId));
  }

  private async acceptNow(taskId: string): Promise<GeneratedClassTaskArtifact[]> {
    if (this.acceptedTaskIds.has(taskId)) return this.artifacts(taskId);
    const records = this.activeRecords(taskId);
    for (const record of records) {
      record.rollbackAvailable = false;
      record.artifact = {
        ...record.artifact,
        accepted: true,
        updatedAt: this.now().toISOString()
      };
    }
    this.acceptedTaskIds.add(taskId);
    return records.map((record) => cloneArtifact(record.artifact));
  }

  revoke(
    taskId: string,
    options: RevokeClassTaskFilesOptions = {}
  ): Promise<ClassTaskFileRevocationResult> {
    return this.enqueue(() => this.revokeNow(taskId, options));
  }

  private async revokeNow(
    taskId: string,
    options: RevokeClassTaskFilesOptions
  ): Promise<ClassTaskFileRevocationResult> {
    if (this.acceptedTaskIds.has(taskId)) {
      throw new Error('The task result was accepted and no longer has rollback capability.');
    }
    const records = this.activeRecords(taskId);
    if (records.some((record) => !record.rollbackAvailable)) {
      throw new Error('The task result was accepted and no longer has rollback capability.');
    }
    const result: ClassTaskFileRevocationResult = {
      revokedArtifactIds: [],
      conflictingFilePaths: []
    };
    const protectedFilePaths = new Set(
      (options.protectedFilePaths ?? []).map(normalizePath)
    );
    for (const record of records) {
      const filePathKey = normalizePath(record.artifact.filePath);
      if (protectedFilePaths.has(filePathKey)) {
        result.conflictingFilePaths.push(record.artifact.filePath);
      } else if (record.existedBefore) {
        if (!record.originalContent || !record.originalSha256) {
          throw new Error('The pre-existing file rollback snapshot is missing.');
        }
        try {
          await this.writer.replaceOwnedArtifact({
            workspaceRoot: record.workspaceRoot,
            filePath: record.artifact.filePath,
            expectedSha256: record.artifact.sha256,
            content: record.originalContent,
            maxBytes: MAX_GENERATED_TEST_BYTES,
            conflictMessage: 'The generated test file was modified by the user.'
          });
        } catch (error) {
          if (!isOwnershipConflict(error) && !isMissingPath(error)) throw error;
          if (!isMissingPath(error)) {
            result.conflictingFilePaths.push(record.artifact.filePath);
          }
        }
      } else {
        await this.writer.deleteGeneratedTestIfPresent({
          workspaceRoot: record.workspaceRoot,
          filePath: record.artifact.filePath
        });
      }
      record.revoked = true;
      this.artifactIdByPath.delete(filePathKey);
      result.revokedArtifactIds.push(record.artifact.id);
    }
    return result;
  }

  artifacts(taskId: string): GeneratedClassTaskArtifact[] {
    return this.activeRecords(taskId).map((record) => (
      cloneArtifact(record.artifact)
    ));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private recordsFor(taskId: string): Map<string, TrackedArtifact> {
    let records = this.recordsByTask.get(taskId);
    if (!records) {
      records = new Map();
      this.recordsByTask.set(taskId, records);
    }
    return records;
  }

  private activeRecords(taskId: string): TrackedArtifact[] {
    return [...(this.recordsByTask.get(taskId)?.values() ?? [])]
      .filter((record) => !record.revoked);
  }

  private requireMutableRecord(taskId: string, artifactId: string): TrackedArtifact {
    const record = this.recordsByTask.get(taskId)?.get(artifactId);
    if (!record || record.revoked) {
      throw new Error('The formal test artifact is not owned by this class task.');
    }
    if (!record.rollbackAvailable || record.artifact.accepted) {
      throw new Error('An accepted formal test artifact cannot be changed.');
    }
    return record;
  }
}

function validateWaveCandidateMoves(
  values: readonly WaveCandidateFileMove[]
): WaveCandidateFileMove[] {
  if (values.length < 1 || values.length > 5) {
    throw new TypeError('A Wave candidate move batch must contain between one and five files.');
  }
  const candidateIds = new Set<string>();
  const paths = new Set<string>();
  return values.map((value) => {
    if (!value.candidateId.trim()
      || !value.workspaceRoot.trim()
      || !value.testClassName.trim()
      || !value.sourcePath.trim()
      || !value.targetPath.trim()
      || !SHA256_PATTERN.test(value.sha256)) {
      throw new TypeError('Wave candidate move identity is incomplete.');
    }
    const workspaceRoot = resolve(value.workspaceRoot);
    const sourcePath = resolve(value.sourcePath);
    const targetPath = resolve(value.targetPath);
    if (sourcePath === targetPath) {
      throw new TypeError('Wave candidate move source and target must differ.');
    }
    assertInsideWorkspace(workspaceRoot, sourcePath, 'Wave candidate source');
    assertInsideWorkspace(workspaceRoot, targetPath, 'Wave candidate target');
    if (basename(sourcePath) !== `${value.testClassName}.java`
      || basename(targetPath) !== `${value.testClassName}.java`) {
      throw new TypeError('Wave candidate move paths must preserve the test class file name.');
    }
    const sourceInProject = isTestSourcePath(workspaceRoot, sourcePath);
    const targetInProject = isTestSourcePath(workspaceRoot, targetPath);
    if (sourceInProject === targetInProject) {
      throw new TypeError(
        'Wave candidates may move only between isolation and module src/test/java.'
      );
    }
    const normalizedSource = normalizePath(sourcePath);
    const normalizedTarget = normalizePath(targetPath);
    if (candidateIds.has(value.candidateId)
      || paths.has(normalizedSource)
      || paths.has(normalizedTarget)) {
      throw new TypeError('Wave candidate move identities and paths must be unique.');
    }
    candidateIds.add(value.candidateId);
    paths.add(normalizedSource);
    paths.add(normalizedTarget);
    return {
      ...value,
      workspaceRoot,
      sourcePath,
      targetPath,
      sha256: value.sha256.toLowerCase()
    };
  });
}

async function requireWaveCandidateMoveSource(
  move: WaveCandidateFileMove
): Promise<void> {
  const source = await lstat(move.sourcePath);
  if (!source.isFile() || source.isSymbolicLink()
    || source.size < 1 || source.size > MAX_GENERATED_TEST_BYTES) {
    throw new Error('Wave candidate move source must be a bounded regular file.');
  }
  try {
    await lstat(move.targetPath);
    throw new Error('Wave candidate move target is already occupied.');
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  const content = await readFile(move.sourcePath);
  if (content.length !== source.size
    || generatedTestContentSha256(content) !== move.sha256) {
    throw new Error('Wave candidate move source digest does not match its checkpoint.');
  }
}

async function inspectWaveCandidateMovePath(
  path: string,
  expectedSha256: string
): Promise<{ exists: boolean }> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.size < 1 || stat.size > MAX_GENERATED_TEST_BYTES) {
      throw new Error('Recovered Wave candidate must be a bounded regular file.');
    }
    const content = await readFile(path);
    if (content.length !== stat.size
      || generatedTestContentSha256(content) !== expectedSha256) {
      throw new Error('Recovered Wave candidate digest does not match its checkpoint.');
    }
    return { exists: true };
  } catch (error) {
    if (isMissingPath(error)) return { exists: false };
    throw error;
  }
}

function recoveredWaveMove(
  move: WaveCandidateFileMove,
  targetExists: boolean
): RecoveredWaveCandidateMove {
  const filePath = targetExists ? move.targetPath : move.sourcePath;
  return {
    candidateId: move.candidateId,
    filePath,
    sha256: move.sha256,
    location: isTestSourcePath(move.workspaceRoot, filePath) ? 'PROJECT' : 'ISOLATED',
    outcome: targetExists ? 'COMPLETED' : 'ROLLED_BACK'
  };
}

function cloneMoveTransactions(
  transactions: readonly WaveCandidateMoveTransaction[]
): WaveCandidateMoveTransaction[] {
  return transactions.map((transaction) => ({ ...transaction }));
}

function assertInsideWorkspace(
  workspaceRoot: string,
  target: string,
  label: string
): void {
  const relativePath = relative(workspaceRoot, target);
  if (relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
}

function isTestSourcePath(workspaceRoot: string, target: string): boolean {
  const segments = relative(workspaceRoot, target)
    .split(/[\\/]+/u)
    .map((segment) => segment.toLocaleLowerCase('en-US'));
  const sourceIndex = segments.findIndex((segment, index) => (
    segment === 'src'
    && segments[index + 1] === 'test'
    && segments[index + 2] === 'java'
  ));
  return sourceIndex >= 0 && sourceIndex + 3 < segments.length;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function validateMetadata(input: TrackClassTaskFileInput): void {
  if (!input.taskId || !input.workspaceRoot || !input.filePath || !input.testClassName) {
    throw new Error('The class-task file ownership metadata is incomplete.');
  }
  validateArtifactValues(
    input.sha256,
    input.ordinaryTestMethodCount,
    input.methodIds,
    input.methodResults
  );
  if (input.existedBefore && input.originalContent === undefined) {
    throw new Error('A pre-existing file requires an original-content snapshot.');
  }
}

function validateUpdate(input: UpdateClassTaskFileInput): void {
  if (!input.taskId || !input.artifactId || !SHA256_PATTERN.test(input.previousSha256)) {
    throw new Error('The formal test artifact update identity is invalid.');
  }
  validateArtifactValues(
    input.sha256,
    input.ordinaryTestMethodCount,
    input.methodIds,
    input.methodResults
  );
}

function validateSeal(input: SealClassTaskFileInput): void {
  if (
    !input.taskId
    || !input.artifactId
    || !SHA256_PATTERN.test(input.expectedSha256)
  ) {
    throw new Error('The formal test artifact seal identity is invalid.');
  }
}

function validateRestoredArtifact(artifact: GeneratedClassTaskArtifact): void {
  if (
    !artifact.id
    || !artifact.filePath
    || !artifact.testClassName
    || typeof artifact.sealed !== 'boolean'
    || typeof artifact.accepted !== 'boolean'
    || !Number.isFinite(Date.parse(artifact.createdAt))
    || !Number.isFinite(Date.parse(artifact.updatedAt))
    || Date.parse(artifact.updatedAt) < Date.parse(artifact.createdAt)
  ) {
    throw new Error('Persisted formal test artifact metadata is invalid.');
  }
  validateArtifactValues(
    artifact.sha256,
    artifact.ordinaryTestMethodCount,
    artifact.methodIds,
    artifact.methodResults,
    true
  );
}

function validateArtifactValues(
  sha256: string,
  ordinaryTestMethodCount: number,
  methodIds: readonly string[],
  methodResults: readonly GeneratedSourceMethodResult[] | undefined,
  allowLegacyMissingResults = false
): void {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error('The formal test artifact digest is invalid.');
  }
  if (!Number.isInteger(ordinaryTestMethodCount) || ordinaryTestMethodCount < 0) {
    throw new Error('A formal test artifact test-method count cannot be negative.');
  }
  if (
    methodIds.length === 0
    || methodIds.some((methodId) => !methodId)
    || new Set(methodIds).size !== methodIds.length
  ) {
    throw new Error('The formal test artifact method identities are invalid.');
  }
  if (allowLegacyMissingResults && (methodResults?.length ?? 0) === 0) return;
  if (
    !methodResults
    || methodResults.length !== methodIds.length
    || methodResults.some((method, index) => (
      method.methodId !== methodIds[index]
      || !method.methodName
      || !method.displaySignature
      || !Number.isInteger(method.jacocoOrder)
      || method.jacocoOrder < 0
      || !Number.isInteger(method.ordinaryTestMethodCount)
      || method.ordinaryTestMethodCount < 0
    ))
    || methodResults.reduce((sum, method) => sum + method.ordinaryTestMethodCount, 0)
      !== ordinaryTestMethodCount
  ) {
    throw new Error('The formal test artifact per-method results are invalid.');
  }
}

function toOriginalBuffer(value: string | Buffer | undefined): Buffer {
  if (value === undefined) {
    throw new Error('The original file content is required.');
  }
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
}

function cloneArtifact(artifact: GeneratedClassTaskArtifact): GeneratedClassTaskArtifact {
  return {
    ...artifact,
    methodIds: [...artifact.methodIds],
    ...(artifact.methodResults
      ? { methodResults: cloneMethodResults(artifact.methodResults) }
      : {})
  };
}

function cloneMethodResults(
  methodResults: readonly GeneratedSourceMethodResult[]
): GeneratedSourceMethodResult[] {
  return methodResults.map((method) => ({ ...method }));
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function isOwnershipConflict(error: unknown): boolean {
  return isGeneratedTestExternallyModifiedError(error)
    || (
      error instanceof Error
      && /modified by the user|ownership/i.test(error.message)
    );
}

function assertGeneratedTestPath(
  workspaceRootValue: string,
  filePathValue: string,
  testClassName: string
): void {
  const workspaceRoot = resolve(workspaceRootValue);
  const filePath = resolve(filePathValue);
  const relativePath = relative(workspaceRoot, filePath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || basename(filePath) !== `${testClassName}.java`
  ) {
    throw new Error('Generated formal tests must stay inside the workspace.');
  }
  const segments = relativePath.split(/[\\/]+/).map((segment) => (
    segment.toLocaleLowerCase('en-US')
  ));
  const testSourceIndex = segments.findIndex((segment, index) => (
    segment === 'src'
    && segments[index + 1] === 'test'
    && segments[index + 2] === 'java'
  ));
  if (testSourceIndex < 0 || testSourceIndex + 3 >= segments.length) {
    throw new Error('Generated formal tests must be below module src/test/java.');
  }
}
