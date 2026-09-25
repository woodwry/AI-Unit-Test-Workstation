export class ModuleOperationCancelledError extends Error {
  constructor(message = '操作已取消。') {
    super(message);
    this.name = 'ModuleOperationCancelledError';
  }
}

/** A FIFO lock whose ownership is isolated by canonical Maven module key. */
export class ModuleOperationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(
    moduleKey: string,
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (!moduleKey.trim()) throw new TypeError('模块键不能为空。');
    const previous = this.tails.get(moduleKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(moduleKey, tail);
    void tail.then(() => {
      if (this.tails.get(moduleKey) === tail) this.tails.delete(moduleKey);
    });

    try {
      await abortable(previous, signal);
      if (signal?.aborted) throw cancellationReason(signal);
      return await operation();
    } finally {
      release();
    }
  }
}

function abortable(value: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return value;
  if (signal.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void value.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function cancellationReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  return new ModuleOperationCancelledError();
}
