import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ModuleIdentityFileSystem = Pick<typeof fs, 'realpath' | 'stat'>;

export type ModuleIdentity = {
  moduleKey: string;
  moduleDisplayPath: string;
  pomPath: string;
  workspaceRoot: string;
  sourceFilePath: string;
};

/** Resolves a Java source file to the nearest Maven module inside one workspace. */
export class ModuleIdentityService {
  private readonly platform: NodeJS.Platform;
  private readonly fileSystem: ModuleIdentityFileSystem;

  constructor(
    platform: NodeJS.Platform = process.platform,
    fileSystem: ModuleIdentityFileSystem = fs
  ) {
    this.platform = platform;
    this.fileSystem = fileSystem;
  }

  async resolve(workspaceRoot: string, sourceFilePath: string): Promise<ModuleIdentity> {
    const workspace = await this.requireDirectory(workspaceRoot, '工作区目录');
    const source = await this.requireFile(sourceFilePath, 'Java 源文件');
    this.requireInside(workspace, source, 'Java 源文件必须位于当前工作区内。');

    let current = dirname(source);
    while (this.isInsideOrEqual(workspace, current)) {
      const pomPath = join(current, 'pom.xml');
      const canonicalPom = await this.canonicalPomInsideWorkspace(workspace, pomPath);
      if (canonicalPom) {
        return {
          moduleKey: this.comparisonKey(canonicalPom),
          moduleDisplayPath: current,
          pomPath: canonicalPom,
          workspaceRoot: workspace,
          sourceFilePath: source
        };
      }
      if (this.samePath(current, workspace)) break;
      const parent = dirname(current);
      if (this.samePath(parent, current)) break;
      current = parent;
    }
    throw new Error('当前工作区内未找到 Java 源文件所属的 Maven pom.xml。');
  }

  comparisonKey(value: string): string {
    const normalized = (isAbsolute(value) ? resolve(value) : value)
      .split(/[\\/]/)
      .join('/');
    return this.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  }

  private async requireDirectory(value: string, label: string): Promise<string> {
    try {
      const canonical = await this.fileSystem.realpath(resolve(value));
      if (!(await this.fileSystem.stat(canonical)).isDirectory()) throw new Error();
      return canonical;
    } catch {
      throw new Error(`${label}不是可读取目录。`);
    }
  }

  private async requireFile(value: string, label: string): Promise<string> {
    try {
      const canonical = await this.fileSystem.realpath(resolve(value));
      if (!(await this.fileSystem.stat(canonical)).isFile()) throw new Error();
      return canonical;
    } catch {
      throw new Error(`${label}不是可读取文件。`);
    }
  }

  private async canonicalPomInsideWorkspace(
    workspaceRoot: string,
    pomPath: string
  ): Promise<string | null> {
    let canonicalPom: string;
    try {
      canonicalPom = await this.fileSystem.realpath(pomPath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    this.requireInside(
      workspaceRoot,
      canonicalPom,
      'Maven pom.xml 的规范路径必须位于当前工作区内。'
    );
    return (await this.fileSystem.stat(canonicalPom)).isFile()
      ? canonicalPom
      : null;
  }

  private isInsideOrEqual(parent: string, child: string): boolean {
    if (this.samePath(parent, child)) return true;
    const value = relative(parent, child);
    return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  }

  private requireInside(parent: string, child: string, message: string): void {
    if (!this.isInsideOrEqual(parent, child)) throw new Error(message);
  }

  private samePath(left: string, right: string): boolean {
    return this.comparisonKey(left) === this.comparisonKey(right);
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
