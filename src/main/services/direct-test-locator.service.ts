import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export type DirectTestClass = {
  className: string;
  qualifiedName: string;
  filePath: string;
};

type MatchedTest = DirectTestClass & {
  sequence: number;
};

export class DirectTestLocatorService {
  async find(moduleRoot: string, targetFilePath: string, targetClassName: string): Promise<DirectTestClass[]> {
    const root = resolve(moduleRoot);
    const targetPath = isAbsolute(targetFilePath) ? resolve(targetFilePath) : resolve(root, targetFilePath);
    this.requireInside(root, targetPath, '目标源码不在当前 Maven 模块内');

    const normalizedRelativePath = relative(root, targetPath).split(sep).join('/');
    const sourceMarker = 'src/main/java/';
    const markerIndex = normalizedRelativePath.indexOf(sourceMarker);
    if (markerIndex < 0) {
      throw new Error('目标源码不在 Maven src/main/java 目录内');
    }

    const modulePrefix = normalizedRelativePath.slice(0, markerIndex);
    const sourceRelativePath = normalizedRelativePath.slice(markerIndex + sourceMarker.length);
    const packageParts = sourceRelativePath.split('/').slice(0, -1);
    const expectedPackage = packageParts.join('.');
    const testDirectory = resolve(root, modulePrefix, 'src/test/java', ...packageParts);
    this.requireInside(root, testDirectory, '目标测试目录不在当前 Maven 模块内');

    let entries: Dirent[];
    try {
      entries = await fs.readdir(testDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }

    const escapedName = escapeRegExp(targetClassName);
    const basePattern = new RegExp(`^${escapedName}Test\\.java$`);
    const numberedPattern = new RegExp(`^${escapedName}([1-9]\\d*)Test\\.java$`);
    const namedPattern = new RegExp(`^${escapedName}([A-Za-z_$][\\w$]*)Test\\.java$`);
    const targetReferencePattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapedName}([^A-Za-z0-9_$]|$)`);
    const matches: MatchedTest[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !/Tests?\.java$/.test(entry.name)) {
        continue;
      }
      const baseMatch = entry.name.match(basePattern);
      const numberedMatch = entry.name.match(numberedPattern);
      const namedMatch = entry.name.match(namedPattern);

      const filePath = resolve(testDirectory, entry.name);
      const content = await fs.readFile(filePath, 'utf8');
      const referencesTarget = targetReferencePattern.test(content);
      if (!baseMatch && !numberedMatch && !namedMatch && !referencesTarget) {
        continue;
      }
      // Additional/Coverage 等具名后缀只有在正文真正引用目标类时才算直接测试。
      if (namedMatch && !referencesTarget) {
        continue;
      }
      const declaredPackage = content.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1] ?? '';
      if (declaredPackage !== expectedPackage) {
        continue;
      }

      const className = basename(entry.name, '.java');
      matches.push({
        className,
        qualifiedName: declaredPackage ? `${declaredPackage}.${className}` : className,
        filePath,
        sequence: baseMatch
          ? 0
          : numberedMatch
            ? Number.parseInt(numberedMatch[1], 10)
            : namedMatch
              ? Number.MAX_SAFE_INTEGER
              : Number.MAX_SAFE_INTEGER - 1
      });
    }

    return matches
      .sort((left, right) => left.sequence - right.sequence || left.className.localeCompare(right.className))
      .map(({ sequence: _sequence, ...testClass }) => testClass);
  }

  private requireInside(parentPath: string, childPath: string, message: string): void {
    const relativePath = relative(resolve(parentPath), resolve(childPath));
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(message);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
