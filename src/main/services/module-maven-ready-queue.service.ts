import type { BuildToolchainSettings } from '../../shared/types.ts';
import type { MavenCommandEvidence } from './method-generation-contract.ts';
import type {
  MavenBatchCandidateExecutionFeedback,
  MavenBatchCandidateExecutionInput,
  MavenCandidateExecutorService,
  MavenCandidatePhase
} from './maven-candidate-executor.service.ts';
import type { MavenBatchCandidateIdentity } from './maven-batch-diagnostic-attribution.service.ts';
import type { ModuleOperationLock } from './module-operation-lock.service.ts';

export type MavenReadyCandidate = {
  moduleKey: string;
  environmentFingerprint: string;
  taskId: string;
  candidateId: string;
};

export type MavenReadyCandidateResult = {
  candidateId: string;
  status: string;
};

type QueueItem<
  TCandidate extends MavenReadyCandidate,
  TResult extends MavenReadyCandidateResult
> = {
  candidate: TCandidate;
  resolve: (result: TResult) => void;
  reject: (error: unknown) => void;
};

type ModuleQueue<
  TCandidate extends MavenReadyCandidate,
  TResult extends MavenReadyCandidateResult
> = {
  items: QueueItem<TCandidate, TResult>[];
  processing: boolean;
};

export type ModuleMavenReadyQueueOptions<
  TCandidate extends MavenReadyCandidate = MavenReadyCandidate,
  TResult extends MavenReadyCandidateResult = MavenReadyCandidateResult
> = {
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  executeBatch: (
    candidates: readonly TCandidate[]
  ) => Promise<ReadonlyMap<string, TResult>>;
  maxBatchSize?: number;
};

export type ExecutableMavenReadyCandidate = MavenReadyCandidate
& MavenBatchCandidateIdentity
& {
  moduleRoot: string;
  buildSettings: BuildToolchainSettings;
  scope: MavenCommandEvidence['scope'];
  projectFilePath: string;
  isolationFilePath: string;
  excludedEnvironmentVariables?: readonly string[];
  onBatchStart: (batchId: string) => void | Promise<void>;
  onPhaseStart?: (phase: MavenCandidatePhase) => void | Promise<void>;
  onPhaseComplete?: (phase: MavenCandidatePhase) => void | Promise<void>;
  activate: () => Promise<void>;
  isolate: () => Promise<void>;
};

export type ExecutableModuleMavenReadyQueue = Pick<
  ModuleMavenReadyQueueService<
    ExecutableMavenReadyCandidate,
    MavenBatchCandidateExecutionFeedback
  >,
  'enqueue'
>;

export type ExecutableModuleMavenReadyQueueOptions = {
  moduleLock: Pick<ModuleOperationLock, 'runExclusive'>;
  maven: Pick<MavenCandidateExecutorService, 'executeBatch'>;
  idFactory: () => string;
};

/**
 * Collects Maven-ready candidates into FIFO batches without ever running two
 * Maven processes against the same module at once.
 */
export class ModuleMavenReadyQueueService<
  TCandidate extends MavenReadyCandidate = MavenReadyCandidate,
  TResult extends MavenReadyCandidateResult = MavenReadyCandidateResult
> {
  private readonly queues = new Map<string, ModuleQueue<TCandidate, TResult>>();
  private readonly maxBatchSize: number;
  private readonly options: ModuleMavenReadyQueueOptions<TCandidate, TResult>;

  constructor(options: ModuleMavenReadyQueueOptions<TCandidate, TResult>) {
    this.options = options;
    const maxBatchSize = options.maxBatchSize ?? 5;
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 5) {
      throw new TypeError('Maven batch size must be an integer between 1 and 5.');
    }
    this.maxBatchSize = maxBatchSize;
  }

  enqueue(candidate: TCandidate): Promise<TResult> {
    this.validateCandidate(candidate);
    const queueKey = this.queueKey(candidate);
    const queue = this.queues.get(queueKey) ?? { items: [], processing: false };
    this.queues.set(queueKey, queue);

    const result = new Promise<TResult>((resolve, reject) => {
      queue.items.push({ candidate, resolve, reject });
    });
    if (!queue.processing) {
      queue.processing = true;
      queueMicrotask(() => { void this.drain(queueKey, queue); });
    }
    return result;
  }

  private async drain(
    queueKey: string,
    queue: ModuleQueue<TCandidate, TResult>
  ): Promise<void> {
    while (queue.items.length > 0) {
      const batch = this.takeBatch(queue);
      try {
        const results = await this.options.moduleLock.runExclusive(
          batch[0].candidate.moduleKey,
          () => this.options.executeBatch(batch.map((item) => item.candidate))
        );
        for (const item of batch) {
          const result = results.get(item.candidate.candidateId);
          if (result) {
            item.resolve(result);
          } else {
            item.reject(new Error(
              `Maven batch returned no result for candidate ${item.candidate.candidateId}.`
            ));
          }
        }
      } catch (error) {
        for (const item of batch) item.reject(error);
      }
    }

    queue.processing = false;
    if (queue.items.length === 0 && this.queues.get(queueKey) === queue) {
      this.queues.delete(queueKey);
    }
  }

  private takeBatch(
    queue: ModuleQueue<TCandidate, TResult>
  ): QueueItem<TCandidate, TResult>[] {
    const selected: QueueItem<TCandidate, TResult>[] = [];
    const deferred: QueueItem<TCandidate, TResult>[] = [];
    const selectedTaskIds = new Set<string>();

    for (const item of queue.items) {
      if (
        selected.length < this.maxBatchSize
        && !selectedTaskIds.has(item.candidate.taskId)
      ) {
        selected.push(item);
        selectedTaskIds.add(item.candidate.taskId);
      } else {
        deferred.push(item);
      }
    }
    queue.items = deferred;
    return selected;
  }

  private queueKey(candidate: MavenReadyCandidate): string {
    return `${candidate.moduleKey}\u0000${candidate.environmentFingerprint}`;
  }

  private validateCandidate(candidate: MavenReadyCandidate): void {
    for (const [name, value] of Object.entries({
      moduleKey: candidate.moduleKey,
      environmentFingerprint: candidate.environmentFingerprint,
      taskId: candidate.taskId,
      candidateId: candidate.candidateId
    })) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${name} must be a non-empty string.`);
      }
    }
  }
}

/**
 * Connects the generic READY queue to the real batch Maven executor. Candidate
 * file callbacks are invoked only while the queue owns the module lock.
 */
export function createExecutableModuleMavenReadyQueue(
  options: ExecutableModuleMavenReadyQueueOptions
): ModuleMavenReadyQueueService<
  ExecutableMavenReadyCandidate,
  MavenBatchCandidateExecutionFeedback
> {
  return new ModuleMavenReadyQueueService({
    moduleLock: options.moduleLock,
    async executeBatch(candidates) {
      requireCompatibleExecutionBatch(candidates);
      const batchId = options.idFactory();
      await Promise.all(candidates.map((candidate) => candidate.onBatchStart(batchId)));
      const first = candidates[0];
      const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
      const input: MavenBatchCandidateExecutionInput = {
        moduleRoot: first.moduleRoot,
        buildSettings: first.buildSettings,
        attemptId: batchId,
        scope: first.scope,
        candidates: candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          filePath: candidate.filePath,
          qualifiedTestClassName: candidate.qualifiedTestClassName
        })),
        placement: {
          activate: (identities) => activateCandidates(identities, byId),
          isolate: (identities) => isolateCandidates(identities, byId)
        },
        ...(first.excludedEnvironmentVariables
          ? { excludedEnvironmentVariables: first.excludedEnvironmentVariables }
          : {}),
        onPhaseStart: async (phase) => {
          await Promise.all(candidates.map((candidate) => candidate.onPhaseStart?.(phase)));
        },
        onPhaseComplete: async (phase) => {
          await Promise.all(candidates.map((candidate) => candidate.onPhaseComplete?.(phase)));
        }
      };
      return options.maven.executeBatch(input);
    }
  });
}

async function activateCandidates(
  identities: readonly MavenBatchCandidateIdentity[],
  byId: ReadonlyMap<string, ExecutableMavenReadyCandidate>
): Promise<void> {
  const activated: ExecutableMavenReadyCandidate[] = [];
  try {
    for (const identity of identities) {
      const candidate = requireExecutableCandidate(byId, identity.candidateId);
      await candidate.activate();
      activated.push(candidate);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const candidate of activated.reverse()) {
      try {
        await candidate.isolate();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Maven candidate activation failed and could not be rolled back completely.'
      );
    }
    throw error;
  }
}

async function isolateCandidates(
  identities: readonly MavenBatchCandidateIdentity[],
  byId: ReadonlyMap<string, ExecutableMavenReadyCandidate>
): Promise<void> {
  const errors: unknown[] = [];
  for (const identity of identities) {
    try {
      await requireExecutableCandidate(byId, identity.candidateId).isolate();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more Maven candidates could not be isolated.');
  }
}

function requireExecutableCandidate(
  byId: ReadonlyMap<string, ExecutableMavenReadyCandidate>,
  candidateId: string
): ExecutableMavenReadyCandidate {
  const candidate = byId.get(candidateId);
  if (!candidate) {
    throw new Error(`Maven placement referenced an unknown candidate ${candidateId}.`);
  }
  return candidate;
}

function requireCompatibleExecutionBatch(
  candidates: readonly ExecutableMavenReadyCandidate[]
): void {
  if (candidates.length === 0) {
    throw new TypeError('Executable Maven batch cannot be empty.');
  }
  const first = candidates[0];
  const settings = JSON.stringify(first.buildSettings);
  const excluded = JSON.stringify([...(first.excludedEnvironmentVariables ?? [])]);
  for (const candidate of candidates) {
    if (candidate.moduleRoot !== first.moduleRoot
      || candidate.scope !== first.scope
      || JSON.stringify(candidate.buildSettings) !== settings
      || JSON.stringify([...(candidate.excludedEnvironmentVariables ?? [])]) !== excluded) {
      throw new Error('READY candidates do not share one Maven execution environment.');
    }
  }
}
