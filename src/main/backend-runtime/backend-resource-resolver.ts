import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type {
  RuntimeServiceId,
  RuntimeServiceReleaseDefinition,
  WindowsReleaseContractV1
} from './release-contract.ts';

type ResourceEntryType = 'file' | 'directory';

type ResourceStats = {
  isFile(): boolean;
  isDirectory(): boolean;
};

export type BackendResourceFileSystem = Readonly<{
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<ResourceStats>;
}>;

export type ResolvedBackendServiceCommand = Readonly<{
  id: RuntimeServiceId;
  executablePath: string;
  arguments: readonly string[];
  workingDirectory: string;
  requiredFilePaths: readonly string[];
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
}>;

export type ResolvedPackagedBackendResources = Readonly<{
  mode: 'packaged';
  resourcesRoot: string;
  backendManifestPath: string;
  licensesPath: string;
  services: Readonly<{
    javaAnalyzer: ResolvedBackendServiceCommand;
    agentService: ResolvedBackendServiceCommand;
  }>;
}>;

export type DevelopmentBackendServiceInput = Readonly<{
  executablePath: string;
  arguments: readonly string[];
  workingDirectory: string;
  requiredFilePaths: readonly string[];
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
}>;

export type DevelopmentBackendResourcesInput = Readonly<{
  javaAnalyzer: DevelopmentBackendServiceInput;
  agentService: DevelopmentBackendServiceInput;
}>;

export type ResolvedDevelopmentBackendResources = Readonly<{
  mode: 'development';
  services: Readonly<{
    javaAnalyzer: ResolvedBackendServiceCommand;
    agentService: ResolvedBackendServiceCommand;
  }>;
}>;

const DEFAULT_FILE_SYSTEM: BackendResourceFileSystem = {
  realpath: (path) => fs.realpath(path),
  stat: (path) => fs.stat(path)
};

function resourceError(label: string): never {
  // 产品错误只暴露资源角色，绝对安装路径留给后续受控诊断日志。
  throw new Error(`本地后端资源不可用：${label}`);
}

function validateTimeout(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) resourceError(label);
  return Number(value);
}

function validateArgument(argument: unknown, label: string): string {
  if (typeof argument !== 'string' || /[\u0000\r\n]/.test(argument)) resourceError(label);
  return argument;
}

function safeRelativeSegments(value: unknown, label: string): string[] {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    resourceError(label);
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    /^[a-z]:/i.test(normalized)
  ) {
    resourceError(label);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) resourceError(label);
  return segments;
}

function assertInsideRoot(root: string, candidate: string, label: string): void {
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || win32.isAbsolute(child)) {
    resourceError(label);
  }
}

function validateEntryType(stats: ResourceStats, expectedType: ResourceEntryType, label: string): void {
  if (expectedType === 'file' ? !stats.isFile() : !stats.isDirectory()) resourceError(label);
}

function freezeCommand(command: ResolvedBackendServiceCommand): ResolvedBackendServiceCommand {
  return Object.freeze({
    ...command,
    arguments: Object.freeze([...command.arguments]),
    requiredFilePaths: Object.freeze([...command.requiredFilePaths])
  });
}

/**
 * 解析后端资源时不读取环境变量、持久化设置或 renderer 输入。安装包态只有
 * resourcesPath 一个信任根；开发态则要求调用方显式给出两条完整命令。
 */
export class BackendResourceResolver {
  private readonly fileSystem: BackendResourceFileSystem;

  constructor(fileSystem: BackendResourceFileSystem = DEFAULT_FILE_SYSTEM) {
    this.fileSystem = fileSystem;
  }

  async resolvePackaged(
    resourcesPath: string,
    contract: WindowsReleaseContractV1
  ): Promise<ResolvedPackagedBackendResources> {
    const resourcesRoot = await this.resolveExplicitEntry(resourcesPath, 'resourcesPath', 'directory');
    if (!contract || !Array.isArray(contract.services) || contract.services.length !== 2) {
      resourceError('发布契约服务');
    }
    const analyzerDefinition = contract.services[0];
    const agentDefinition = contract.services[1];
    if (analyzerDefinition?.id !== 'java-analyzer' || agentDefinition?.id !== 'agent-service') {
      resourceError('发布契约服务顺序');
    }

    const backendManifestPath = await this.resolvePackagedEntry(
      resourcesRoot,
      contract.resources?.backendManifestRelativePath,
      'backend manifest',
      'file'
    );
    const licensesPath = await this.resolvePackagedEntry(
      resourcesRoot,
      contract.resources?.licensesRelativePath,
      'licenses',
      'directory'
    );
    const javaAnalyzer = await this.resolvePackagedService(resourcesRoot, analyzerDefinition);
    const agentService = await this.resolvePackagedService(resourcesRoot, agentDefinition);

    return Object.freeze({
      mode: 'packaged',
      resourcesRoot,
      backendManifestPath,
      licensesPath,
      services: Object.freeze({ javaAnalyzer, agentService })
    });
  }

  async resolveDevelopment(
    input: DevelopmentBackendResourcesInput
  ): Promise<ResolvedDevelopmentBackendResources> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !input.javaAnalyzer || !input.agentService) {
      resourceError('开发态显式配置');
    }
    const javaAnalyzer = await this.resolveDevelopmentService('java-analyzer', input.javaAnalyzer);
    const agentService = await this.resolveDevelopmentService('agent-service', input.agentService);
    return Object.freeze({
      mode: 'development',
      services: Object.freeze({ javaAnalyzer, agentService })
    });
  }

  private async resolvePackagedService(
    resourcesRoot: string,
    definition: RuntimeServiceReleaseDefinition
  ): Promise<ResolvedBackendServiceCommand> {
    const executablePath = await this.resolvePackagedEntry(
      resourcesRoot,
      definition.executableRelativePath,
      `${definition.id} executable`,
      'file'
    );
    if (!Array.isArray(definition.arguments)) resourceError(`${definition.id} arguments`);
    const argumentsCopy = definition.arguments.map((argument, index) =>
      validateArgument(argument, `${definition.id} argument ${index}`)
    );
    const requiredFilePaths: string[] = [];

    if (definition.id === 'java-analyzer') {
      const jarIndexes = argumentsCopy.flatMap((argument, index) => argument === '-jar' ? [index] : []);
      if (jarIndexes.length !== 1 || jarIndexes[0] >= argumentsCopy.length - 1) {
        resourceError('java-analyzer jar argument');
      }
      const jarArgumentIndex = jarIndexes[0] + 1;
      const jarPath = await this.resolvePackagedEntry(
        resourcesRoot,
        argumentsCopy[jarArgumentIndex],
        'java-analyzer jar',
        'file'
      );
      argumentsCopy[jarArgumentIndex] = jarPath;
      requiredFilePaths.push(jarPath);
    }

    for (const [index, argument] of argumentsCopy.entries()) {
      if (requiredFilePaths.includes(argument)) continue;
      const normalized = argument.replaceAll('\\', '/');
      if (
        isAbsolute(normalized) ||
        win32.isAbsolute(normalized) ||
        /^[a-z]:/i.test(normalized) ||
        normalized.split('/').includes('..')
      ) {
        resourceError(`${definition.id} argument ${index}`);
      }
    }

    return freezeCommand({
      id: definition.id,
      executablePath,
      arguments: argumentsCopy,
      workingDirectory: resourcesRoot,
      requiredFilePaths,
      startupTimeoutMs: validateTimeout(definition.startupTimeoutMs, `${definition.id} startupTimeoutMs`),
      shutdownTimeoutMs: validateTimeout(definition.shutdownTimeoutMs, `${definition.id} shutdownTimeoutMs`)
    });
  }

  private async resolveDevelopmentService(
    id: RuntimeServiceId,
    input: DevelopmentBackendServiceInput
  ): Promise<ResolvedBackendServiceCommand> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) resourceError(`${id} 开发态配置`);
    if (!Array.isArray(input.arguments) || !Array.isArray(input.requiredFilePaths)) {
      resourceError(`${id} 开发态参数`);
    }
    const executablePath = await this.resolveExplicitEntry(input.executablePath, `${id} executable`, 'file');
    const workingDirectory = await this.resolveExplicitEntry(input.workingDirectory, `${id} cwd`, 'directory');
    const requiredFilePaths = await Promise.all(input.requiredFilePaths.map((path, index) =>
      this.resolveExplicitEntry(path, `${id} required file ${index}`, 'file')
    ));

    return freezeCommand({
      id,
      executablePath,
      arguments: input.arguments.map((argument, index) => validateArgument(argument, `${id} argument ${index}`)),
      workingDirectory,
      requiredFilePaths,
      startupTimeoutMs: validateTimeout(input.startupTimeoutMs, `${id} startupTimeoutMs`),
      shutdownTimeoutMs: validateTimeout(input.shutdownTimeoutMs, `${id} shutdownTimeoutMs`)
    });
  }

  private async resolvePackagedEntry(
    resourcesRoot: string,
    relativePath: unknown,
    label: string,
    expectedType: ResourceEntryType
  ): Promise<string> {
    const candidate = resolve(resourcesRoot, ...safeRelativeSegments(relativePath, label));
    assertInsideRoot(resourcesRoot, candidate, label);
    let realCandidate: string;
    let stats: ResourceStats;
    try {
      realCandidate = await this.fileSystem.realpath(candidate);
      assertInsideRoot(resourcesRoot, realCandidate, label);
      stats = await this.fileSystem.stat(realCandidate);
    } catch {
      return resourceError(label);
    }
    validateEntryType(stats, expectedType, label);
    return realCandidate;
  }

  private async resolveExplicitEntry(
    path: unknown,
    label: string,
    expectedType: ResourceEntryType
  ): Promise<string> {
    if (
      typeof path !== 'string' ||
      !path ||
      path.trim() !== path ||
      !isAbsolute(path) ||
      /[\u0000-\u001f\u007f]/.test(path)
    ) {
      resourceError(label);
    }
    try {
      const realPath = await this.fileSystem.realpath(path);
      const stats = await this.fileSystem.stat(realPath);
      validateEntryType(stats, expectedType, label);
      return realPath;
    } catch {
      return resourceError(label);
    }
  }
}
