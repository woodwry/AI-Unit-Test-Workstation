import { promises as fs } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import type { JavaFileInfo, JavaMethodInfo, JavaProjectScanResult } from '../../shared/types';

const IGNORED_DIRECTORIES = new Set(['.git', '.idea', '.vscode', 'target', 'node_modules', 'dist', 'build']);

export class JavaProjectAnalyzer {
  async scanProject(workspaceRoot: string): Promise<JavaProjectScanResult> {
    const root = resolve(workspaceRoot);
    const javaFiles = await this.findJavaFiles(root, root);
    const files = await Promise.all(javaFiles.map((filePath) => this.analyzeJavaFile(root, filePath)));

    return {
      workspaceRoot: root,
      files: files
        .filter((file) => file.methods.length > 0)
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    };
  }

  async analyzeJavaFile(workspaceRoot: string, filePath: string): Promise<JavaFileInfo> {
    const root = resolve(workspaceRoot);
    const absolutePath = resolve(filePath);
    const content = await fs.readFile(absolutePath, 'utf8');
    const packageName = this.extractPackageName(content);
    const className = this.extractPrimaryTypeName(content) || basename(absolutePath, '.java');

    return {
      path: absolutePath,
      relativePath: relative(root, absolutePath),
      packageName,
      className,
      methods: this.extractMethods(content, className)
    };
  }

  private async findJavaFiles(root: string, directoryPath: string): Promise<string[]> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const absolutePath = resolve(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          files.push(...(await this.findJavaFiles(root, absolutePath)));
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.java') && this.isSourceJavaFile(root, absolutePath)) {
        files.push(absolutePath);
      }
    }

    return files;
  }

  private isSourceJavaFile(root: string, filePath: string): boolean {
    const normalized = relative(root, filePath).split(sep).join('/');
    return normalized.includes('/src/main/java/') || normalized.startsWith('src/main/java/');
  }

  private extractPackageName(content: string): string {
    const match = content.match(/^\s*package\s+([a-zA-Z_][\w.]*);/m);
    return match?.[1] ?? '';
  }

  private extractPrimaryTypeName(content: string): string | null {
    const match = content.match(/\b(?:public\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/);
    return match?.[1] ?? null;
  }

  private extractMethods(content: string, className: string): JavaMethodInfo[] {
    const sanitized = this.maskCommentsAndStrings(content);
    const methods: JavaMethodInfo[] = [];
    const methodPattern =
      /((?:@\w+(?:\([^)]*\))?\s*)*)(?:(public|protected|private)\s+)?(?:(?:static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>{};=]+>\s*)?([A-Za-z_$][\w$<>\[\].?,\s]*?)\s+([A-Za-z_$][\w$]*)\s*\(([^(){};]*)\)\s*(?:throws\s+[^{;]+)?\{/g;

    let match: RegExpExecArray | null;

    while ((match = methodPattern.exec(sanitized)) !== null) {
      const returnType = match[3].replace(/\s+/g, ' ').trim();
      const name = match[4];
      const parameters = match[5].replace(/\s+/g, ' ').trim();

      if (this.shouldSkipMethod(name, returnType, className)) {
        continue;
      }

      const bodyStartIndex = sanitized.indexOf('{', match.index);
      const bodyEndIndex = this.findMatchingBrace(sanitized, bodyStartIndex);

      if (bodyEndIndex === -1) {
        continue;
      }

      methods.push({
        name,
        signature: `${name}(${parameters})`,
        returnType,
        parameters,
        visibility: (match[2] as JavaMethodInfo['visibility']) ?? 'package',
        startLine: this.lineNumberAt(content, match.index),
        endLine: this.lineNumberAt(content, bodyEndIndex)
      });
    }

    return this.dedupeMethods(methods);
  }

  private shouldSkipMethod(name: string, returnType: string, className: string): boolean {
    if (name === className) {
      return true;
    }

    return ['if', 'for', 'while', 'switch', 'catch', 'try', 'new', 'return'].includes(returnType);
  }

  private dedupeMethods(methods: JavaMethodInfo[]): JavaMethodInfo[] {
    const seen = new Set<string>();
    const result: JavaMethodInfo[] = [];

    for (const method of methods) {
      const key = `${method.name}:${method.startLine}:${method.endLine}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(method);
      }
    }

    return result;
  }

  private findMatchingBrace(content: string, openBraceIndex: number): number {
    let depth = 0;

    for (let index = openBraceIndex; index < content.length; index += 1) {
      const char = content[index];

      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  private lineNumberAt(content: string, index: number): number {
    let line = 1;

    for (let position = 0; position < index; position += 1) {
      if (content[position] === '\n') {
        line += 1;
      }
    }

    return line;
  }

  private maskCommentsAndStrings(content: string): string {
    let result = '';
    let index = 0;

    while (index < content.length) {
      const current = content[index];
      const next = content[index + 1];

      if (current === '/' && next === '/') {
        const end = content.indexOf('\n', index);
        const stop = end === -1 ? content.length : end;
        result += ' '.repeat(stop - index);
        index = stop;
        continue;
      }

      if (current === '/' && next === '*') {
        const end = content.indexOf('*/', index + 2);
        const stop = end === -1 ? content.length : end + 2;
        result += content.slice(index, stop).replace(/[^\n]/g, ' ');
        index = stop;
        continue;
      }

      if (current === '"' || current === "'") {
        const quote = current;
        result += ' ';
        index += 1;

        while (index < content.length) {
          const char = content[index];
          result += char === '\n' ? '\n' : ' ';

          if (char === '\\') {
            index += 2;
            result += ' ';
            continue;
          }

          index += 1;

          if (char === quote) {
            break;
          }
        }

        continue;
      }

      result += current;
      index += 1;
    }

    return result;
  }
}
