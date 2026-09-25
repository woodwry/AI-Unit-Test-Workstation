import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type {
  BuildSettingsValidationResult,
  MavenHomeDefaults,
  SaveWorkstationBuildSettingsRequest,
  WorkstationBuildSettings
} from '../../shared/types.ts';
import { AtomicJsonStore } from './atomic-json-store.ts';

export class WorkstationBuildSettingsService {
  private readonly store: AtomicJsonStore<WorkstationBuildSettings | null>;
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;

  constructor(
    storagePath: string,
    platform: NodeJS.Platform = process.platform,
    homeDirectory: string = homedir()
  ) {
    this.store = new AtomicJsonStore(storagePath, validateWorkstationBuildSettingsFile, () => null);
    this.platform = platform;
    this.homeDirectory = homeDirectory;
  }

  get(): Promise<WorkstationBuildSettings | null> {
    return this.store.read();
  }

  async save(
    request: SaveWorkstationBuildSettingsRequest,
    validation: BuildSettingsValidationResult
  ): Promise<WorkstationBuildSettings> {
    const settings = validateWorkstationBuildSettingsFile({
      ...this.normalize(request),
      validation
    });
    if (!settings) throw new TypeError('工作站构建环境设置格式无效');
    await this.store.write(settings);
    return settings;
  }

  normalize(request: SaveWorkstationBuildSettingsRequest): SaveWorkstationBuildSettingsRequest {
    const path = this.platform === 'win32' ? win32 : posix;
    const normalizeRequired = (value: string): string => path.resolve(value.trim());
    const normalizeOptional = (value?: string): string | undefined => {
      const trimmed = value?.trim();
      return trimmed ? path.resolve(trimmed) : undefined;
    };

    return {
      mavenHome: normalizeRequired(request.mavenHome),
      javaHome: normalizeRequired(request.javaHome),
      ...(normalizeOptional(request.settingsPath) ? { settingsPath: normalizeOptional(request.settingsPath) } : {}),
      ...(normalizeOptional(request.localRepository) ? { localRepository: normalizeOptional(request.localRepository) } : {})
    };
  }

  async resolveMavenHomeDefaults(mavenHome: string): Promise<MavenHomeDefaults> {
    const path = this.pathFor(mavenHome, this.homeDirectory);
    const normalizedMavenHome = path.resolve(mavenHome.trim());
    const settingsPath = path.join(normalizedMavenHome, 'conf', 'settings.xml');
    const fallbackRepository = path.join(path.resolve(this.homeDirectory), '.m2', 'repository');

    try {
      const settingsXml = await fs.readFile(settingsPath, 'utf8');
      const withoutComments = settingsXml.replace(/<!--[\s\S]*?-->/g, '');
      const configuredRepository = withoutComments.match(
        /<localRepository\b[^>]*>([\s\S]*?)<\/localRepository>/i
      )?.[1]?.trim();
      return {
        settingsPath,
        localRepository: configuredRepository
          ? this.resolveRepositoryPath(configuredRepository)
          : fallbackRepository
      };
    } catch {
      return { settingsPath, localRepository: fallbackRepository };
    }
  }

  async flush(): Promise<void> {
    await this.store.read();
  }

  private resolveRepositoryPath(value: string): string {
    const path = this.pathFor(value, this.homeDirectory);
    const expandedHome = value.replace(
      /\$\{(?:user\.home|env\.HOME|env\.USERPROFILE)\}/gi,
      () => this.homeDirectory
    );
    const expandedTilde = /^~[\\/]/.test(expandedHome)
      ? path.join(this.homeDirectory, expandedHome.slice(2))
      : expandedHome;
    return path.isAbsolute(expandedTilde)
      ? path.normalize(expandedTilde)
      : path.resolve(this.homeDirectory, expandedTilde);
  }

  private pathFor(...values: string[]): typeof win32 | typeof posix {
    // 支持迁移自另一平台的绝对路径，避免把 Windows 盘符拼进当前进程目录。
    return this.platform === 'win32' || values.some((value) => win32.isAbsolute(value.trim())) ? win32 : posix;
  }
}

export function validateWorkstationBuildSettingsFile(value: unknown): WorkstationBuildSettings | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new TypeError('工作站构建环境设置格式无效');
  requireExactKeys(value, ['mavenHome', 'javaHome', 'settingsPath', 'localRepository', 'validation']);

  const settings: WorkstationBuildSettings = {
    mavenHome: requirePath(value.mavenHome),
    javaHome: requirePath(value.javaHome),
    ...(value.settingsPath === undefined ? {} : { settingsPath: requirePath(value.settingsPath) }),
    ...(value.localRepository === undefined ? {} : { localRepository: requirePath(value.localRepository) }),
    ...(value.validation === undefined ? {} : { validation: validateBuildValidation(value.validation) })
  };
  return settings;
}

function validateBuildValidation(value: unknown): BuildSettingsValidationResult {
  if (!isPlainRecord(value)) throw new TypeError('工作站构建环境校验结果格式无效');
  requireExactKeys(value, [
    'valid', 'command', 'mavenVersion', 'javaVersion', 'javaRuntime', 'checkedAt',
    'error', 'stdoutTail', 'stderrTail'
  ]);
  if (typeof value.valid !== 'boolean' || !isString(value.command) || !isString(value.checkedAt)) {
    throw new TypeError('工作站构建环境校验结果格式无效');
  }
  for (const key of ['mavenVersion', 'javaVersion', 'javaRuntime', 'error', 'stdoutTail', 'stderrTail'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new TypeError('工作站构建环境校验结果格式无效');
    }
  }
  return value as BuildSettingsValidationResult;
}

function requirePath(value: unknown): string {
  if (!isString(value) || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new TypeError('工作站构建环境路径格式无效');
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 4096;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new TypeError('工作站构建环境设置格式无效');
  }
}
