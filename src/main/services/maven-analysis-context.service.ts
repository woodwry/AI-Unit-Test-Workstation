import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';
import type {
  BuildToolchainContext,
  BuildToolchainSettings,
  GenerationAnalysisInput
} from '../../shared/types';
import { modelCredentialEnvironmentVariables } from '../../shared/model-runtime-security.ts';
import type { ShellService } from './shell.service';

const MAX_POM_BYTES = 2 * 1024 * 1024;
const MAX_CLASSPATH_OUTPUT_BYTES = 4 * 1024 * 1024;

export type MavenAnalysisContext = GenerationAnalysisInput;

export type CollectMavenAnalysisContextInput = {
  workspaceRoot: string;
  moduleRoot: string;
  targetSourcePath: string;
  targetClass: string;
  plannedTestClassName: string;
  plannedRelativeTestPath: string;
  reportPath: string;
  branchSnapshotPath: string;
  reportPairId: string;
  buildSettings: BuildToolchainSettings;
  buildToolchain: BuildToolchainContext;
  signal?: AbortSignal;
  /** 只传变量名，不传凭证值；用于阻止自定义模型凭证进入 Maven 子进程。 */
  customModelEnvironmentVariable?: string;
};

/**
 * 为 java-analyzer 收集本机源码根、字节码和依赖 classpath。
 *
 * Maven classpath 收集是可降级步骤；路径越界、JDK 版本无效或目标源码变化则直接停止。
 */
export class MavenAnalysisContextService {
  private readonly shellService: ShellService;

  constructor(shellService: ShellService) {
    this.shellService = shellService;
  }

  async collect(input: CollectMavenAnalysisContextInput): Promise<MavenAnalysisContext> {
    this.throwIfAborted(input.signal);
    const workspaceRoot = await this.requireRealDirectory(input.workspaceRoot, '工作区目录');
    const moduleRoot = await this.requireRealDirectory(input.moduleRoot, 'Maven 模块目录');
    this.requireInside(workspaceRoot, moduleRoot, 'Maven 模块必须位于当前工作区内。');

    const targetSourcePath = await this.requireRealFile(input.targetSourcePath, '目标源码');
    const reportPath = await this.requireRealFile(input.reportPath, 'JaCoCo 报告');
    const branchSnapshotPath = await this.requireRealFile(
      input.branchSnapshotPath,
      'JaCoCo 分支快照'
    );
    const javaHome = await this.requireRealDirectory(input.buildSettings.javaHome, 'Java Home');
    this.requireInside(workspaceRoot, targetSourcePath, '目标源码必须位于当前工作区内。');
    this.requireInside(workspaceRoot, reportPath, 'JaCoCo 报告必须位于当前工作区内。');
    this.requireInside(
      workspaceRoot,
      branchSnapshotPath,
      'JaCoCo 分支快照必须位于当前工作区内。'
    );
    if (!/^[0-9a-f]{64}$/i.test(input.reportPairId)) {
      throw new Error('JaCoCo 文件对 pairId 无效。');
    }

    const jdkMajorVersion = parseJdkMajorVersion(input.buildToolchain.javaVersion);
    const moduleRoots = await this.discoverDeclaredModuleRoots(workspaceRoot, moduleRoot);
    const sourceRoots = await this.collectSourceRoots(workspaceRoot, moduleRoots);
    const moduleClassDirectories = await this.collectModuleClassDirectories(workspaceRoot, moduleRoots);
    const warnings: GenerationAnalysisInput['warnings'] = [];
    const dependencyEntries = await this.collectDependencyClasspath(input, moduleRoot, warnings);
    const classpathEntries = this.sortedUnique([
      ...moduleClassDirectories,
      ...dependencyEntries
    ]);
    const buildContextFingerprint = await this.fingerprint({
      workspaceRoot,
      moduleRoot,
      sourceRoots,
      classpathEntries,
      javaHome,
      jdkMajorVersion,
      javaVersion: input.buildToolchain.javaVersion,
      mavenVersion: input.buildToolchain.mavenVersion
    });

    this.throwIfAborted(input.signal);
    return {
      workspaceRoot,
      moduleRoot,
      targetSourcePath,
      targetClass: input.targetClass,
      plannedTestClassName: input.plannedTestClassName,
      plannedRelativeTestPath: input.plannedRelativeTestPath.split(/[\\/]/).join('/'),
      reportPath,
      branchSnapshotPath,
      reportPairId: input.reportPairId.toLowerCase(),
      sourceRoots,
      classpathEntries,
      javaHome,
      jdkMajorVersion,
      buildContextFingerprint,
      warnings
    };
  }

  private async collectDependencyClasspath(
    input: CollectMavenAnalysisContextInput,
    moduleRoot: string,
    warnings: GenerationAnalysisInput['warnings']
  ): Promise<string[]> {
    const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'ai-unit-test-classpath-'));
    const outputFile = join(temporaryDirectory, 'classpath.txt');
    try {
      const result = await this.shellService.collectMavenClasspath(
        moduleRoot,
        input.buildSettings,
        outputFile,
        {
          signal: input.signal,
          excludedEnvironmentVariables: modelCredentialEnvironmentVariables(
            input.customModelEnvironmentVariable
          )
        }
      );
      this.throwIfAborted(input.signal);
      if (result.exitCode !== 0) {
        warnings.push({
          code: 'CLASSPATH_COLLECTION_FAILED',
          message: '未能收集 Maven 依赖 classpath，将使用当前项目中可读取的源码和已编译类继续分析。'
        });
        return [];
      }

      const stat = await fs.stat(outputFile);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CLASSPATH_OUTPUT_BYTES) {
        throw new Error('Maven classpath 输出文件无效。');
      }
      const raw = await fs.readFile(outputFile, 'utf8');
      const entries: string[] = [];
      for (const value of raw.split(delimiter)) {
        const candidate = value.trim();
        if (!candidate) continue;
        try {
          const canonical = await fs.realpath(resolve(candidate));
          const candidateStat = await fs.stat(canonical);
          // java-analyzer 的二进制索引只接受类目录和 JAR。Maven 依赖
          // classpath 可能同时包含 POM、ZIP 等非字节码制品，不能直接透传。
          if (
            candidateStat.isDirectory()
            || (candidateStat.isFile() && canonical.toLowerCase().endsWith('.jar'))
          ) {
            entries.push(canonical);
          }
        } catch {
          // Maven 可能返回已经失效的可选依赖；只保留当前确实存在的条目。
        }
      }
      return this.sortedUnique(entries);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      warnings.push({
        code: 'CLASSPATH_COLLECTION_FAILED',
        message: '未能收集 Maven 依赖 classpath，将使用当前项目中可读取的源码和已编译类继续分析。'
      });
      return [];
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async discoverDeclaredModuleRoots(
    workspaceRoot: string,
    startingModuleRoot: string
  ): Promise<string[]> {
    const workspacePom = join(workspaceRoot, 'pom.xml');
    const startRoot = await this.isFile(workspacePom) ? workspaceRoot : startingModuleRoot;
    const discovered = new Set<string>();
    await this.visitMavenModule(workspaceRoot, startRoot, discovered);
    if (!discovered.has(startingModuleRoot)) {
      await this.visitMavenModule(workspaceRoot, startingModuleRoot, discovered);
    }
    return [...discovered].sort((left, right) => left.localeCompare(right));
  }

  private async visitMavenModule(
    workspaceRoot: string,
    moduleRoot: string,
    discovered: Set<string>
  ): Promise<void> {
    const canonicalRoot = await this.requireRealDirectory(moduleRoot, 'Maven 模块目录');
    this.requireInside(workspaceRoot, canonicalRoot, 'Maven 模块不能通过链接指向工作区之外。');
    if (discovered.has(canonicalRoot)) return;
    discovered.add(canonicalRoot);

    const pomPath = join(canonicalRoot, 'pom.xml');
    if (!(await this.isFile(pomPath))) return;
    const modulePaths = await this.readDeclaredModulePaths(pomPath);
    for (const modulePath of modulePaths) {
      if (isAbsolute(modulePath)) {
        throw new Error('Maven modules 不能声明工作区外的绝对路径。');
      }
      const candidate = resolve(canonicalRoot, modulePath);
      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(candidate);
      } catch {
        // Maven profile 中未启用的模块可能不存在，不把它当成当前分析输入。
        continue;
      }
      this.requireInside(workspaceRoot, realCandidate, 'Maven 模块不能通过链接指向工作区之外。');
      if (await this.isFile(join(realCandidate, 'pom.xml'))) {
        await this.visitMavenModule(workspaceRoot, realCandidate, discovered);
      }
    }
  }

  private async readDeclaredModulePaths(pomPath: string): Promise<string[]> {
    const stat = await fs.stat(pomPath);
    if (!stat.isFile() || stat.size > MAX_POM_BYTES) {
      throw new Error('Maven POM 文件无效或超过允许大小。');
    }
    const xml = await fs.readFile(pomPath, 'utf8');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
      throw new Error('Maven POM 禁止包含 DTD 或实体声明。');
    }
    const parseErrors: string[] = [];
    const document = new DOMParser({
      onError: (_level, message) => parseErrors.push(String(message))
    }).parseFromString(xml, 'application/xml');
    if (parseErrors.length > 0 || !document.documentElement) {
      throw new Error('无法安全解析 Maven POM。');
    }
    const result: string[] = [];
    const modulesElements = document.getElementsByTagName('modules');
    for (let index = 0; index < modulesElements.length; index += 1) {
      const modules = modulesElements.item(index);
      if (!modules) continue;
      for (let child = modules.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        const element = child as unknown as XmlElement;
        if ((element.localName || element.nodeName) !== 'module') continue;
        const value = (element.textContent ?? '').trim();
        if (value && value.length <= 4_096) result.push(value);
      }
    }
    return this.sortedUnique(result);
  }

  private async collectSourceRoots(workspaceRoot: string, modules: string[]): Promise<string[]> {
    const roots: string[] = [];
    for (const moduleRoot of modules) {
      await this.addExistingDirectory(workspaceRoot, join(moduleRoot, 'src', 'main', 'java'), roots);
      const generatedSources = join(moduleRoot, 'target', 'generated-sources');
      let entries: Dirent[];
      try {
        entries = await fs.readdir(generatedSources, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        await this.addExistingDirectory(workspaceRoot, join(generatedSources, entry.name), roots);
      }
    }
    return this.sortedUnique(roots);
  }

  private async collectModuleClassDirectories(
    workspaceRoot: string,
    modules: string[]
  ): Promise<string[]> {
    const entries: string[] = [];
    for (const moduleRoot of modules) {
      await this.addExistingDirectory(workspaceRoot, join(moduleRoot, 'target', 'classes'), entries);
    }
    return this.sortedUnique(entries);
  }

  private async addExistingDirectory(
    workspaceRoot: string,
    candidate: string,
    target: string[]
  ): Promise<void> {
    try {
      const canonical = await fs.realpath(candidate);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) return;
      this.requireInside(workspaceRoot, canonical, '分析目录不能通过链接指向工作区之外。');
      target.push(canonical);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async fingerprint(input: {
    workspaceRoot: string;
    moduleRoot: string;
    sourceRoots: string[];
    classpathEntries: string[];
    javaHome: string;
    jdkMajorVersion: number;
    javaVersion: string;
    mavenVersion: string;
  }): Promise<string> {
    const classpathEntries: Array<{
      path: string;
      size: number;
      mtimeMs: number;
    }> = [];
    for (const entry of input.classpathEntries) {
      const stat = await fs.stat(entry);
      classpathEntries.push({
        path: entry,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs)
      });
    }
    const canonical = JSON.stringify({
      workspaceRootRealPath: input.workspaceRoot,
      moduleRootRealPath: input.moduleRoot,
      sourceRoots: [...input.sourceRoots].sort(),
      classpathEntries,
      javaHomeRealPath: input.javaHome,
      jdkMajorVersion: input.jdkMajorVersion,
      javaVersion: input.javaVersion,
      mavenVersion: input.mavenVersion
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  private sortedUnique(values: string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
  }

  private async requireRealDirectory(value: string, label: string): Promise<string> {
    const canonical = await fs.realpath(resolve(value));
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error(`${label}不是可读取目录。`);
    return canonical;
  }

  private async requireRealFile(value: string, label: string): Promise<string> {
    try {
      const canonical = await fs.realpath(resolve(value));
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) throw new Error(`${label}不是可读取文件。`);
      return canonical;
    } catch (error) {
      if (error instanceof Error && error.message === `${label}不是可读取文件。`) {
        throw error;
      }
      throw new Error(`${label}不是可读取文件。`);
    }
  }

  private async isFile(value: string): Promise<boolean> {
    try {
      return (await fs.stat(value)).isFile();
    } catch {
      return false;
    }
  }

  private requireInside(parent: string, child: string, message: string): void {
    const relativePath = relative(parent, child);
    if (
      relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(message);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('生成已停止。');
    }
  }
}

export function parseJdkMajorVersion(javaVersion: string): number {
  const normalized = javaVersion.trim();
  const legacy = normalized.match(/^1\.(\d+)(?:[._+\-]|$)/);
  const modern = normalized.match(/^(\d+)(?:[._+\-]|$)/);
  const value = Number(legacy?.[1] ?? modern?.[1]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('无法识别当前配置的 JDK 主版本。');
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
