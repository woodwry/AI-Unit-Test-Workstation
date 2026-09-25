import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_FORMAL_TEST_FILES = 10_000;
const JAVA_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export type GeneratedTestNameReservation = {
  moduleRoot: string;
  filePath: string;
  relativePath: string;
  testClassName: string;
  sha256: string;
  createdAt: string;
};

export type GeneratedTestNameReservationOptions = {
  relativeTestDirectory?: string;
};

export class GeneratedTestNameReservationService {
  async reserve(
    moduleRootValue: string,
    targetClassName: string,
    options: GeneratedTestNameReservationOptions = {}
  ): Promise<GeneratedTestNameReservation> {
    if (!JAVA_IDENTIFIER.test(targetClassName)) {
      throw new Error('The target Java class name is invalid.');
    }
    const moduleRoot = await fs.realpath(resolve(moduleRootValue));
    const relativeTestDirectory = options.relativeTestDirectory
      ?? 'src/test/java';
    if (isAbsolute(relativeTestDirectory)) {
      throw new Error('The formal test directory must be module-relative.');
    }
    const testSourceRoot = resolve(moduleRoot, 'src', 'test', 'java');
    const testDirectory = resolve(moduleRoot, relativeTestDirectory);
    if (!isInside(testSourceRoot, testDirectory)) {
      throw new Error('Formal tests must be reserved below module src/test/java.');
    }
    await ensureExistingAncestorInside(moduleRoot, testDirectory);
    await fs.mkdir(testDirectory, { recursive: true });
    const [realTestSourceRoot, realTestDirectory] = await Promise.all([
      fs.realpath(testSourceRoot),
      fs.realpath(testDirectory)
    ]);
    ensureInside(moduleRoot, realTestSourceRoot);
    ensureInside(realTestSourceRoot, realTestDirectory);

    for (let index = 1; index <= MAX_FORMAL_TEST_FILES; index += 1) {
      const testClassName = `${targetClassName}${index}Test`;
      const filePath = join(realTestDirectory, `${testClassName}.java`);
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await fs.open(filePath, 'wx');
        await handle.writeFile('', 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        return {
          moduleRoot,
          filePath,
          relativePath: portableRelative(moduleRoot, filePath),
          testClassName,
          sha256: EMPTY_SHA256,
          createdAt: new Date().toISOString()
        };
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
    throw new Error('No available numbered formal test file name was found.');
  }

  async release(reservation: GeneratedTestNameReservation): Promise<void> {
    const moduleRoot = await fs.realpath(resolve(reservation.moduleRoot));
    const testSourceRoot = await fs.realpath(
      resolve(moduleRoot, 'src', 'test', 'java')
    );
    const filePath = await fs.realpath(resolve(reservation.filePath));
    ensureInside(moduleRoot, testSourceRoot);
    if (
      !isInside(testSourceRoot, filePath)
      || basename(filePath) !== `${reservation.testClassName}.java`
      || portableRelative(moduleRoot, filePath) !== reservation.relativePath
    ) {
      throw new Error('The formal test reservation identity is invalid.');
    }
    const content = await fs.readFile(filePath);
    const actualSha256 = createHash('sha256').update(content).digest('hex');
    if (actualSha256 !== reservation.sha256.toLowerCase()) {
      throw new Error(
        'The reserved formal test file was modified; ownership has changed.'
      );
    }
    await fs.unlink(filePath);
  }
}

async function ensureExistingAncestorInside(
  moduleRoot: string,
  directoryPath: string
): Promise<void> {
  let candidate = directoryPath;
  for (;;) {
    try {
      const existing = await fs.realpath(candidate);
      ensureInside(moduleRoot, existing);
      return;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = resolve(candidate, '..');
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function ensureInside(root: string, candidate: string): void {
  if (!isInside(root, candidate)) {
    throw new Error('The formal test path is outside the selected module.');
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  );
}

function portableRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'EEXIST';
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
