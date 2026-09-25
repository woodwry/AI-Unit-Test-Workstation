import { Dirent, promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceFile } from '../../shared/types';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.vscode',
  'target',
  'node_modules',
  'dist',
  'build'
]);

const SUPPORTED_CODE_EXTENSIONS = new Set([
  '.bat',
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.lua',
  '.md',
  '.php',
  '.properties',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.vue',
  '.xml',
  '.yaml',
  '.yml'
]);

const SUPPORTED_CODE_FILENAMES = new Set(['dockerfile', 'makefile', 'pom.xml']);

export class FileSystemService {
  async listWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceFile[]> {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    return this.listDirectoryChildren(root, root);
  }

  async listWorkspaceChildren(workspaceRoot: string, directoryPath?: string): Promise<WorkspaceFile[]> {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    const targetDirectory = directoryPath ? this.resolveInsideWorkspace(root, directoryPath) : root;
    const stats = await fs.stat(targetDirectory);

    if (!stats.isDirectory()) {
      throw new Error('所选路径不是目录。');
    }

    return this.listDirectoryChildren(root, targetDirectory);
  }

  async listWorkspaceSearchFiles(workspaceRoot: string): Promise<WorkspaceFile[]> {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    const directories = [root];
    const files: WorkspaceFile[] = [];

    for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
      const children = await this.listDirectoryChildren(root, directories[directoryIndex]);
      for (const child of children) {
        if (child.type === 'directory') {
          directories.push(child.path);
        } else {
          files.push(child);
        }
      }
    }

    return files;
  }

  async readTextFile(workspaceRoot: string, filePath: string): Promise<string> {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    const resolvedFile = this.resolveInsideWorkspace(root, filePath);
    const stats = await fs.stat(resolvedFile);

    if (!stats.isFile()) {
      throw new Error('所选路径不是文件。');
    }

    return fs.readFile(resolvedFile, 'utf8');
  }

  async writeTextFile(workspaceRoot: string, filePath: string, content: string): Promise<number> {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    const resolvedFile = this.resolveInsideWorkspace(root, filePath);

    await fs.mkdir(dirname(resolvedFile), { recursive: true });
    await fs.writeFile(resolvedFile, content, 'utf8');

    return Buffer.byteLength(content, 'utf8');
  }

  toRelativePath(workspaceRoot: string, filePath: string): string {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    const resolvedFile = this.resolveInsideWorkspace(root, filePath);
    return relative(root, resolvedFile);
  }

  resolveWorkspacePath(workspaceRoot: string, filePath: string): string {
    const root = this.validateWorkspaceRoot(workspaceRoot);
    return this.resolveInsideWorkspace(root, filePath);
  }

  private async listDirectoryChildren(root: string, directoryPath: string): Promise<WorkspaceFile[]> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => this.shouldInclude(entry))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });

    const files: WorkspaceFile[] = [];

    for (const entry of visibleEntries) {
      const absolutePath = resolve(directoryPath, entry.name);
      const isDirectory = entry.isDirectory();

      files.push({
        name: entry.name,
        path: absolutePath,
        relativePath: relative(root, absolutePath),
        type: isDirectory ? 'directory' : 'file',
        hasChildren: isDirectory
      });
    }

    return files;
  }

  private shouldInclude(entry: Dirent): boolean {
    if (entry.isDirectory()) {
      return !IGNORED_DIRECTORIES.has(entry.name);
    }

    const normalizedName = entry.name.toLowerCase();
    const extension = normalizedName.includes('.') ? normalizedName.slice(normalizedName.lastIndexOf('.')) : '';
    return SUPPORTED_CODE_FILENAMES.has(normalizedName) || SUPPORTED_CODE_EXTENSIONS.has(extension);
  }

  private validateWorkspaceRoot(workspaceRoot: string): string {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      throw new Error('需要提供工作区根目录。');
    }

    return resolve(workspaceRoot);
  }

  private resolveInsideWorkspace(root: string, targetPath: string): string {
    const resolvedTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
    const relativePath = relative(root, resolvedTarget);
    const isOutside = relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

    if (isOutside) {
      throw new Error('文件访问超出了所选工作区。');
    }

    return resolvedTarget;
  }
}
