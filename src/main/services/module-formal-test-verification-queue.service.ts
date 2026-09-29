import type { BuildToolchainSettings } from '../../shared/types.ts';
import type {
  MavenBatchCandidateExecutionFeedback,
  MavenCandidateExecutorService
} from './maven-candidate-executor.service.ts';
import type { MavenBatchCandidateIdentity } from './maven-batch-diagnostic-attribution.service.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';
import type { TestWriterService } from './test-writer.service.ts';

const DEFAULT_FORMAL_VERIFICATION_BATCH_SIZE = 50;

export class FormalTestVerificationError extends Error {
  constructor(status: string) {
    super(`Formal test verification failed: ${status}.`);
    this.name = 'FormalTestVerificationError';
  }
}

export type FormalTestVerificationCandidate = {
  moduleKey: string;
  environmentFingerprint: string;
  taskId: string;
  candidateId: string;
  workspaceRoot: string;
  moduleRoot: string;
  buildSettings: BuildToolchainSettings;
  filePath: string;
  expectedSha256: string;
  testClassName: string;
  qualifiedTestClassName: string;
  ordinaryTestMethodCount: number;
  excludedEnvironmentVariables?: readonly string[];
  signal?: AbortSignal;
};

export type FormalTestVerificationQueue = Pick<
  ModuleFormalTestVerificationQueueService,
  'enqueue'
>;

type QueueItem = {
  candidate: FormalTestVerificationCandidate;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ModuleQueue = {
  items: QueueItem[];
  processing: boolean;
  scheduled: ReturnType<typeof setTimeout> | null;
};

export type ModuleFormalTestVerificationQueueOptions = {
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  writer: Pick<TestWriterService, 'assertGeneratedTestUnchanged'>;
  maven: Pick<MavenCandidateExecutorService, 'executeBatch'>;
  idFactory: () => string;
  maxBatchSize?: number;
};

/**
 * Batches final generated test-file verification by Maven module. Unlike the
 * TMP READY queue, this queue intentionally allows many formal files from the
 * same task to run together, because formal files are already independent
 * generated test classes.
 */
export class ModuleFormalTestVerificationQueueService {
  private readonly queues = new Map<string, ModuleQueue>();
  private readonly maxBatchSize: number;
  private readonly options: ModuleFormalTestVerificationQueueOptions;

  constructor(options: ModuleFormalTestVerificationQueueOptions) {
    this.options = options;
    const maxBatchSize = options.maxBatchSize ?? DEFAULT_FORMAL_VERIFICATION_BATCH_SIZE;
    if (
      !Number.isInteger(maxBatchSize)
      || maxBatchSize < 1
      || maxBatchSize > DEFAULT_FORMAL_VERIFICATION_BATCH_SIZE
    ) {
      throw new TypeError(
        `Formal test verification batch size must be an integer between 1 and `
        + `${DEFAULT_FORMAL_VERIFICATION_BATCH_SIZE}.`
      );
    }
    this.maxBatchSize = maxBatchSize;
  }

  enqueue(candidate: FormalTestVerificationCandidate): Promise<void> {
    this.validateCandidate(candidate);
    if (candidate.ordinaryTestMethodCount === 0) return Promise.resolve();
    if (candidate.signal?.aborted) {
      return Promise.reject(abortReason(candidate.signal));
    }

    const queueKey = this.queueKey(candidate);
    const queue = this.queues.get(queueKey) ?? {
      items: [],
      processing: false,
      scheduled: null
    };
    this.queues.set(queueKey, queue);

    const result = new Promise<void>((resolve, reject) => {
      queue.items.push({ candidate, resolve, reject });
    });
    this.schedule(queueKey, queue);
    return result;
  }

  private schedule(queueKey: string, queue: ModuleQueue): void {
    if (queue.processing || queue.scheduled) return;
    queue.scheduled = setTimeout(() => {
      queue.scheduled = null;
      queue.processing = true;
      void this.drain(queueKey, queue);
    }, 0);
  }

  private async drain(queueKey: string, queue: ModuleQueue): Promise<void> {
    try {
      while (queue.items.length > 0) {
        const batch = queue.items.splice(0, this.maxBatchSize);
        const activeBatch: QueueItem[] = [];
        for (const item of batch) {
          if (item.candidate.signal?.aborted) {
            item.reject(abortReason(item.candidate.signal));
          } else {
            activeBatch.push(item);
          }
        }
        if (activeBatch.length === 0) continue;

        try {
          const results = await this.executeBatch(
            activeBatch.map((item) => item.candidate)
          );
          for (const item of activeBatch) {
            if (item.candidate.signal?.aborted) {
              item.reject(abortReason(item.candidate.signal));
              continue;
            }
            const result = results.get(item.candidate.candidateId);
            if (!result) {
              item.reject(new Error(
                `Formal test verification returned no result for `
                + `${item.candidate.candidateId}.`
              ));
              continue;
            }
            try {
              assertFormalVerificationPassed(item.candidate, result);
              item.resolve();
            } catch (error) {
              item.reject(error);
            }
          }
        } catch (error) {
          for (const item of activeBatch) item.reject(error);
        }
      }
    } finally {
      queue.processing = false;
      if (queue.items.length === 0 && this.queues.get(queueKey) === queue) {
        this.queues.delete(queueKey);
      } else {
        this.schedule(queueKey, queue);
      }
    }
  }

  private async executeBatch(
    candidates: readonly FormalTestVerificationCandidate[]
  ): Promise<ReadonlyMap<string, MavenBatchCandidateExecutionFeedback>> {
    requireCompatibleFormalVerificationBatch(candidates);
    const first = candidates[0];
    const byId = new Map(candidates.map((candidate) => [
      candidate.candidateId,
      candidate
    ]));
    return this.options.moduleLock.runExclusive(first.moduleKey, async () => {
      const results = await this.options.maven.executeBatch({
        moduleRoot: first.moduleRoot,
        buildSettings: first.buildSettings,
        attemptId: this.options.idFactory(),
        scope: 'method_candidate',
        candidates: candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          filePath: candidate.filePath,
          qualifiedTestClassName: candidate.qualifiedTestClassName
        })),
        placement: {
          activate: (identities) => this.assertUnchanged(identities, byId),
          isolate: (identities) => this.assertUnchanged(identities, byId)
        },
        ...(first.excludedEnvironmentVariables
          ? { excludedEnvironmentVariables: first.excludedEnvironmentVariables }
          : {})
      });
      await this.assertUnchanged(
        candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          filePath: candidate.filePath,
          qualifiedTestClassName: candidate.qualifiedTestClassName
        })),
        byId
      );
      return results;
    });
  }

  private async assertUnchanged(
    identities: readonly MavenBatchCandidateIdentity[],
    byId: ReadonlyMap<string, FormalTestVerificationCandidate>
  ): Promise<void> {
    for (const identity of identities) {
      const candidate = byId.get(identity.candidateId);
      if (!candidate) {
        throw new Error(
          `Formal verification candidate ${identity.candidateId} is unknown.`
        );
      }
      await this.options.writer.assertGeneratedTestUnchanged({
        workspaceRoot: candidate.workspaceRoot,
        filePath: candidate.filePath,
        expectedSha256: candidate.expectedSha256
      });
    }
  }

  private queueKey(candidate: FormalTestVerificationCandidate): string {
    return `${candidate.moduleKey}\u0000${candidate.environmentFingerprint}`;
  }

  private validateCandidate(candidate: FormalTestVerificationCandidate): void {
    for (const [name, value] of Object.entries({
      moduleKey: candidate.moduleKey,
      environmentFingerprint: candidate.environmentFingerprint,
      taskId: candidate.taskId,
      candidateId: candidate.candidateId,
      workspaceRoot: candidate.workspaceRoot,
      moduleRoot: candidate.moduleRoot,
      filePath: candidate.filePath,
      expectedSha256: candidate.expectedSha256,
      testClassName: candidate.testClassName,
      qualifiedTestClassName: candidate.qualifiedTestClassName
    })) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${name} must be a non-empty string.`);
      }
    }
    if (!Number.isInteger(candidate.ordinaryTestMethodCount)
      || candidate.ordinaryTestMethodCount < 0) {
      throw new TypeError('ordinaryTestMethodCount must be a non-negative integer.');
    }
  }
}

export function assertFormalVerificationPassed(
  candidate: Pick<FormalTestVerificationCandidate, 'ordinaryTestMethodCount'>,
  result: Pick<
    MavenBatchCandidateExecutionFeedback,
    'status' | 'testReport'
  >
): void {
  if (
    result.status !== 'passed'
    || !result.testReport
    || result.testReport.generatedTests < candidate.ordinaryTestMethodCount
    || result.testReport.generatedSkipped !== 0
  ) {
    throw new FormalTestVerificationError(result.status);
  }
}

function requireCompatibleFormalVerificationBatch(
  candidates: readonly FormalTestVerificationCandidate[]
): void {
  if (candidates.length < 1) {
    throw new TypeError('Formal test verification batch cannot be empty.');
  }
  const first = candidates[0];
  const buildSettings = stableJson(first.buildSettings);
  const excludedEnvironmentVariables = stableJson(
    first.excludedEnvironmentVariables ?? []
  );
  const candidateIds = new Set<string>();
  const qualifiedTestClassNames = new Set<string>();
  for (const candidate of candidates) {
    if (
      candidate.moduleKey !== first.moduleKey
      || candidate.environmentFingerprint !== first.environmentFingerprint
      || candidate.workspaceRoot !== first.workspaceRoot
      || candidate.moduleRoot !== first.moduleRoot
      || stableJson(candidate.buildSettings) !== buildSettings
      || stableJson(candidate.excludedEnvironmentVariables ?? [])
        !== excludedEnvironmentVariables
    ) {
      throw new Error('Formal test verification batch contains incompatible files.');
    }
    if (
      candidateIds.has(candidate.candidateId)
      || qualifiedTestClassNames.has(candidate.qualifiedTestClassName)
    ) {
      throw new Error('Formal test verification batch contains duplicate identities.');
    }
    candidateIds.add(candidate.candidateId);
    qualifiedTestClassNames.add(candidate.qualifiedTestClassName);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('操作已取消。');
}
