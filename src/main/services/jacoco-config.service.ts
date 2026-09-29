import { existsSync, promises as fs, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JacocoConfigCheckResult } from '../../shared/types';

const IGNORED_DIRECTORIES = new Set(['.git', '.idea', '.vscode', 'target', 'node_modules', 'dist', 'build']);

export class JacocoConfigService {
  async checkProject(workspaceRoot: string, targetFilePath?: string): Promise<JacocoConfigCheckResult> {
    const root = resolve(workspaceRoot);
    const projectRoot = targetFilePath ? await this.findProjectRoot(root, targetFilePath) : root;
    const pomFiles = await this.findPomFiles(projectRoot);
    const matchedFiles: string[] = [];

    for (const pomFile of pomFiles) {
      const content = await fs.readFile(pomFile, 'utf8');
      if (content.includes('jacoco-maven-plugin') || content.includes('org.jacoco')) {
        matchedFiles.push(relative(root, pomFile));
      }
    }

    const existingReportPath = this.findReport(projectRoot);
    if (existingReportPath) {
      matchedFiles.push(relative(root, existingReportPath));
    }

    const configured = matchedFiles.length > 0;

    return {
      configured,
      existingReportPath: existingReportPath ? relative(root, existingReportPath) : null,
      matchedFiles,
      message: configured
        ? `Detected JaCoCo capability in ${matchedFiles.length} file(s).`
        : `No JaCoCo plugin or report was detected under ${relative(root, projectRoot) || '.'}.`
    };
  }

  async findProjectRoot(workspaceRoot: string, targetFilePath: string): Promise<string> {
    let current = dirname(isAbsolute(targetFilePath) ? resolve(targetFilePath) : resolve(workspaceRoot, targetFilePath));

    while (this.isInsideWorkspace(workspaceRoot, current)) {
      if (existsSync(join(current, 'pom.xml'))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return workspaceRoot;
  }

  private async findPomFiles(projectRoot: string): Promise<string[]> {
    const files: string[] = [];
    await this.collectPomFiles(projectRoot, files);
    return files;
  }

  private async collectPomFiles(directoryPath: string, files: string[]): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = resolve(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await this.collectPomFiles(absolutePath, files);
        }
        continue;
      }

      if (entry.isFile() && entry.name === 'pom.xml') {
        files.push(absolutePath);
      }
    }
  }

  findReport(projectRoot: string, minimumModifiedTime = 0): string | null {
    const candidates = [
      join(projectRoot, 'target', 'site', 'jacoco', 'jacoco.xml'),
      join(projectRoot, 'target', 'site', 'jacoco-aggregate', 'jacoco.xml')
    ];

    return candidates.find((candidate) => {
      if (!existsSync(candidate)) {
        return false;
      }

      try {
        return statSync(candidate).mtimeMs >= minimumModifiedTime;
      } catch {
        return false;
      }
    }) ?? null;
  }

  private isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
    const relativePath = relative(workspaceRoot, targetPath);
    return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
  }
}
