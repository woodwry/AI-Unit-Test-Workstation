import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export class AtomicJsonStoreCorruptError extends Error {
  readonly storagePath: string;

  constructor(storagePath: string, options?: ErrorOptions) {
    super(`JSON 存储文件及其备份均不可用：${storagePath}`, options);
    this.name = 'AtomicJsonStoreCorruptError';
    this.storagePath = storagePath;
  }
}

type StoreUpdater<T> = (value: T) => T | void | Promise<T | void>;
type ReadFileFunction = (path: string, encoding: 'utf8') => Promise<string>;

export class AtomicJsonStore<T> {
  private readonly storagePath: string;
  private readonly validate: (value: unknown) => T;
  private readonly emptyFactory: () => T;
  private readonly readFile: ReadFileFunction;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    storagePath: string,
    validate: (value: unknown) => T,
    emptyFactory: () => T,
    readFile: ReadFileFunction = fs.readFile
  ) {
    this.storagePath = storagePath;
    this.validate = validate;
    this.emptyFactory = emptyFactory;
    this.readFile = readFile;
  }

  async read(): Promise<T> {
    await this.operationQueue;
    return this.readNow();
  }

  async write(value: T): Promise<void> {
    return this.enqueue(() => this.writeNow(value));
  }

  /** 在同一队列中完成读、改、写，避免并发更新覆盖其他调用方刚写入的字段。 */
  async update(updater: StoreUpdater<T>): Promise<T> {
    let updated!: T;
    await this.enqueue(async () => {
      const current = await this.readNow();
      const result = await updater(current);
      updated = result === undefined ? current : result;
      await this.writeNow(updated);
    });
    return updated;
  }

  private async readNow(): Promise<T> {
    const main = await this.tryRead(this.storagePath);
    if (main.status === 'valid') {
      return main.value;
    }
    if (main.status === 'io_error') {
      throw main.error;
    }

    const backup = await this.tryRead(`${this.storagePath}.bak`);
    if (backup.status === 'valid') {
      return backup.value;
    }
    if (backup.status === 'io_error') {
      throw backup.error;
    }
    if (main.status === 'missing' && backup.status === 'missing') {
      return this.validate(this.emptyFactory());
    }

    throw new AtomicJsonStoreCorruptError(this.storagePath, {
      cause: main.status === 'corrupt' ? main.error : backup.status === 'corrupt' ? backup.error : undefined
    });
  }

  private async writeNow(value: T): Promise<void> {
    const validated = this.validate(value);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const directory = dirname(this.storagePath);
    const mainTemp = join(directory, `${basename(this.storagePath)}.${randomUUID()}.tmp`);
    let backupTemp: string | undefined;

    await fs.mkdir(directory, { recursive: true });
    try {
      await writeSyncedFile(mainTemp, serialized);

      const existing = await this.tryRead(this.storagePath);
      if (existing.status === 'io_error') {
        throw existing.error;
      }
      if (existing.status === 'corrupt') {
        throw new AtomicJsonStoreCorruptError(this.storagePath, { cause: existing.error });
      }
      if (existing.status === 'valid') {
        backupTemp = join(directory, `${basename(this.storagePath)}.bak.${randomUUID()}.tmp`);
        const backup = `${JSON.stringify(existing.value, null, 2)}\n`;
        await writeSyncedFile(backupTemp, backup);
        await fs.rename(backupTemp, `${this.storagePath}.bak`);
        backupTemp = undefined;
      }

      await fs.rename(mainTemp, this.storagePath);
    } finally {
      await Promise.all([
        fs.rm(mainTemp, { force: true }),
        backupTemp ? fs.rm(backupTemp, { force: true }) : Promise.resolve()
      ]);
    }
  }

  private async tryRead(path: string): Promise<ReadResult<T>> {
    let raw: string;
    try {
      raw = await this.readFile(path, 'utf8');
    } catch (error) {
      if (isMissingPathError(error)) {
        return { status: 'missing' };
      }
      return { status: 'io_error', error };
    }

    try {
      return { status: 'valid', value: this.validate(JSON.parse(raw)) };
    } catch (error) {
      return { status: 'corrupt', error };
    }
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.catch(() => undefined);
    return pending;
  }
}

type ReadResult<T> =
  | { status: 'valid'; value: T }
  | { status: 'missing' }
  | { status: 'corrupt'; error: unknown }
  | { status: 'io_error'; error: unknown };

async function writeSyncedFile(path: string, contents: string): Promise<void> {
  const handle = await fs.open(path, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
