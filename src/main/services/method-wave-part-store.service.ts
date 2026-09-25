import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';

const MAX_PART_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type StoreMethodWavePartInput = {
  workspaceRoot: string;
  taskId: string;
  methodId: string;
  sourceClassName: string;
  waveIndex: number;
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  candidateId: string;
  code: string;
};

export type LoadMethodWavePartInput = Omit<StoreMethodWavePartInput, 'code'> & {
  filePath: string;
  sha256: string;
};

export type StoredMethodWavePart = {
  taskId: string;
  methodId: string;
  waveIndex: number;
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  candidateId: string;
  testClassName: string;
  filePath: string;
  sidecarPath: string;
  relativePath: string;
  sha256: string;
  code: string;
};

export type MethodWavePartStoreOptions = {
  storageDirectory?: string;
};

type PartSidecar = Omit<StoredMethodWavePart, 'filePath' | 'sidecarPath' | 'code'> & {
  version: 1;
};

export class MethodWavePartStoreService {
  private readonly storageDirectory?: string;

  constructor(options: MethodWavePartStoreOptions = {}) {
    this.storageDirectory = options.storageDirectory;
  }

  async clearTask(workspaceRootInput: string, taskIdInput: string): Promise<void> {
    if (!workspaceRootInput.trim() || !taskIdInput.trim()) {
      throw new TypeError('Wave Part workspace and task identity are required.');
    }
    const workspaceRoot = resolve(workspaceRootInput);
    const storageRoot = resolve(
      this.storageDirectory
        ?? join(workspaceRoot, '.ai-unit-test', 'method-wave-parts')
    );
    assertInsideWorkspace(workspaceRoot, storageRoot);
    assertMavenExcluded(workspaceRoot, storageRoot);
    const taskDirectory = resolve(storageRoot, digest(taskIdInput.trim()).slice(0, 24));
    assertInsideWorkspace(workspaceRoot, taskDirectory);
    assertMavenExcluded(workspaceRoot, taskDirectory);
    await rm(taskDirectory, { recursive: true, force: true });
  }

  async clearWave(
    workspaceRootInput: string,
    taskIdInput: string,
    methodIdInput: string,
    waveIndex: number
  ): Promise<void> {
    if (!workspaceRootInput.trim() || !taskIdInput.trim() || !methodIdInput.trim()) {
      throw new TypeError('Wave Part workspace and identities are required.');
    }
    if (!Number.isSafeInteger(waveIndex) || waveIndex < 1) {
      throw new TypeError('Wave index must be a positive integer.');
    }
    const workspaceRoot = resolve(workspaceRootInput);
    const storageRoot = resolve(
      this.storageDirectory
        ?? join(workspaceRoot, '.ai-unit-test', 'method-wave-parts')
    );
    assertInsideWorkspace(workspaceRoot, storageRoot);
    assertMavenExcluded(workspaceRoot, storageRoot);
    const taskDirectory = resolve(
      storageRoot,
      digest(taskIdInput.trim()).slice(0, 24)
    );
    const methodDirectory = resolve(
      taskDirectory,
      digest(methodIdInput.trim()).slice(0, 24)
    );
    const waveDirectory = resolve(methodDirectory, `wave-${waveIndex}`);
    for (const target of [taskDirectory, methodDirectory, waveDirectory]) {
      assertInsideWorkspace(workspaceRoot, target);
      assertMavenExcluded(workspaceRoot, target);
    }
    await rm(waveDirectory, { recursive: true, force: true });
    await removeDirectoryIfEmpty(methodDirectory);
    await removeDirectoryIfEmpty(taskDirectory);
  }

  async store(input: StoreMethodWavePartInput): Promise<StoredMethodWavePart> {
    const validated = validateInput(input);
    const workspaceRoot = resolve(validated.workspaceRoot);
    const storageRoot = resolve(
      this.storageDirectory
        ?? join(workspaceRoot, '.ai-unit-test', 'method-wave-parts')
    );
    assertInsideWorkspace(workspaceRoot, storageRoot);
    assertMavenExcluded(workspaceRoot, storageRoot);
    const taskKey = digest(validated.taskId).slice(0, 24);
    const methodKey = digest(validated.methodId).slice(0, 24);
    const directory = join(
      storageRoot,
      taskKey,
      methodKey,
      `wave-${validated.waveIndex}`
    );
    const testClassName = `${validated.sourceClassName}Tmp${validated.waveIndex}`
      + `Part${validated.partIndex}Test`;
    const filePath = join(directory, `${testClassName}.java`);
    const sidecarPath = `${filePath}.meta.json`;
    assertInsideWorkspace(workspaceRoot, filePath);
    assertMavenExcluded(workspaceRoot, filePath);
    const sha256 = digest(validated.code);
    const relativePath = relative(workspaceRoot, filePath).split(sep).join('/');
    const sidecar: PartSidecar = {
      version: 1,
      taskId: validated.taskId,
      methodId: validated.methodId,
      waveIndex: validated.waveIndex,
      partIndex: validated.partIndex,
      partBatchId: validated.partBatchId,
      scenarioIds: [...validated.scenarioIds],
      candidateId: validated.candidateId,
      testClassName,
      relativePath,
      sha256
    };
    const existing = await this.loadExisting(filePath, sidecarPath, sidecar);
    if (existing) return { ...existing, code: validated.code };

    await mkdir(directory, { recursive: true });
    const suffix = randomUUID();
    const temporaryFile = `${filePath}.${suffix}.tmp`;
    const temporarySidecar = `${sidecarPath}.${suffix}.tmp`;
    let sourceCommitted = false;
    try {
      await writeFile(temporaryFile, validated.code, { encoding: 'utf8', flag: 'wx' });
      await writeFile(temporarySidecar, `${JSON.stringify(sidecar, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      });
      await rename(temporaryFile, filePath);
      sourceCommitted = true;
      await rename(temporarySidecar, sidecarPath);
    } catch (error) {
      if (sourceCommitted) await rm(filePath, { force: true });
      throw error;
    } finally {
      await Promise.all([
        rm(temporaryFile, { force: true }),
        rm(temporarySidecar, { force: true })
      ]);
    }
    return {
      ...sidecar,
      filePath,
      sidecarPath,
      code: validated.code
    };
  }

  async load(input: LoadMethodWavePartInput): Promise<StoredMethodWavePart> {
    const validated = validateLoadInput(input);
    const workspaceRoot = resolve(validated.workspaceRoot);
    const storageRoot = resolve(
      this.storageDirectory
        ?? join(workspaceRoot, '.ai-unit-test', 'method-wave-parts')
    );
    assertInsideWorkspace(workspaceRoot, storageRoot);
    assertMavenExcluded(workspaceRoot, storageRoot);
    const taskKey = digest(validated.taskId).slice(0, 24);
    const methodKey = digest(validated.methodId).slice(0, 24);
    const directory = join(
      storageRoot,
      taskKey,
      methodKey,
      `wave-${validated.waveIndex}`
    );
    const testClassName = `${validated.sourceClassName}Tmp${validated.waveIndex}`
      + `Part${validated.partIndex}Test`;
    const filePath = join(directory, `${testClassName}.java`);
    const sidecarPath = `${filePath}.meta.json`;
    if (resolve(validated.filePath) !== resolve(filePath)) {
      throw new Error('Stored Wave Part identity path does not match its checkpoint.');
    }
    const relativePath = relative(workspaceRoot, filePath).split(sep).join('/');
    const expected: PartSidecar = {
      version: 1,
      taskId: validated.taskId,
      methodId: validated.methodId,
      waveIndex: validated.waveIndex,
      partIndex: validated.partIndex,
      partBatchId: validated.partBatchId,
      scenarioIds: [...validated.scenarioIds],
      candidateId: validated.candidateId,
      testClassName,
      relativePath,
      sha256: validated.sha256
    };
    const existing = await this.loadExisting(filePath, sidecarPath, expected);
    if (!existing) throw new Error('Stored Wave Part identity is missing.');
    const code = await readFile(filePath, 'utf8');
    if (digest(code) !== validated.sha256) {
      throw new Error('Stored Wave Part digest does not match its checkpoint.');
    }
    return { ...existing, code };
  }

  private async loadExisting(
    filePath: string,
    sidecarPath: string,
    expected: PartSidecar
  ): Promise<Omit<StoredMethodWavePart, 'code'> | null> {
    const [sourceExists, sidecarExists] = await Promise.all([
      exists(filePath),
      exists(sidecarPath)
    ]);
    if (!sourceExists && !sidecarExists) return null;
    if (!sourceExists || !sidecarExists) {
      throw new Error('Stored Wave Part identity is incomplete.');
    }
    const [source, rawSidecar] = await Promise.all([
      readFile(filePath, 'utf8'),
      readFile(sidecarPath, 'utf8')
    ]);
    let actual: unknown;
    try {
      actual = JSON.parse(rawSidecar);
    } catch {
      throw new Error('Stored Wave Part identity sidecar is invalid.');
    }
    if (digest(source) !== expected.sha256
      || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Stored Wave Part identity has different content or digest.');
    }
    return { ...expected, filePath, sidecarPath };
  }
}

function validateInput(input: StoreMethodWavePartInput): StoreMethodWavePartInput {
  if (!input.workspaceRoot.trim() || !input.taskId.trim() || !input.methodId.trim()) {
    throw new TypeError('Wave Part workspace and identities are required.');
  }
  if (!/^[A-Za-z_$][\w$]*$/u.test(input.sourceClassName)) {
    throw new TypeError('Wave Part source class name is invalid.');
  }
  if (!Number.isSafeInteger(input.waveIndex) || input.waveIndex < 1) {
    throw new TypeError('Wave index must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.partIndex)
    || input.partIndex < 1 || input.partIndex > 5) {
    throw new TypeError('Part index must be between 1 and 5.');
  }
  if (!SHA256.test(input.partBatchId)) {
    throw new TypeError('Wave Part batch identity is invalid.');
  }
  if (!UUID.test(input.candidateId)) {
    throw new TypeError('Wave Part candidate identity is invalid.');
  }
  if (!Array.isArray(input.scenarioIds)
    || input.scenarioIds.length < 1
    || input.scenarioIds.length > 5
    || input.scenarioIds.some((scenarioId) => (
      typeof scenarioId !== 'string' || !scenarioId.trim()
    ))
    || new Set(input.scenarioIds).size !== input.scenarioIds.length) {
    throw new TypeError('Wave Part scenario identities are invalid.');
  }
  const bytes = Buffer.byteLength(input.code, 'utf8');
  if (bytes < 1 || bytes > MAX_PART_BYTES) {
    throw new TypeError('Wave Part source size is invalid.');
  }
  return {
    ...input,
    workspaceRoot: resolve(input.workspaceRoot),
    partBatchId: input.partBatchId.toLowerCase(),
    candidateId: input.candidateId.toLowerCase(),
    scenarioIds: [...input.scenarioIds]
  };
}

function validateLoadInput(input: LoadMethodWavePartInput): LoadMethodWavePartInput {
  const validated = validateInput({ ...input, code: 'checkpoint-load' });
  if (!input.filePath.trim() || !SHA256.test(input.sha256)) {
    throw new TypeError('Wave Part checkpoint path and digest are invalid.');
  }
  return {
    ...validated,
    filePath: resolve(input.filePath),
    sha256: input.sha256.toLowerCase()
  };
}

function assertInsideWorkspace(workspaceRoot: string, target: string): void {
  const relativePath = relative(workspaceRoot, target);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)) {
    throw new Error('Wave Part storage must stay inside the workspace.');
  }
}

function assertMavenExcluded(workspaceRoot: string, target: string): void {
  const segments = relative(workspaceRoot, target)
    .split(/[\\/]+/u)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment, index) => (
    segment === 'src'
    && segments[index + 1] === 'test'
    && segments[index + 2] === 'java'
  ))) {
    throw new Error('Wave Parts must remain Maven-excluded and outside src/test/java.');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}
