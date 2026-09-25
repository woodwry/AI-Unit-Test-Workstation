import { promises as fs } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { MavenHomeDefaults, WorkspaceBuildSettings } from '../../shared/types';

type WorkspaceBuildSettingsStore = {
  version: 1;
  workspaces: Record<string, WorkspaceBuildSettings>;
};

const EMPTY_STORE: WorkspaceBuildSettingsStore = { version: 1, workspaces: {} };

export class WorkspaceBuildSettingsService {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly storagePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;

  constructor(
    storagePath: string,
    platform: NodeJS.Platform = process.platform,
    homeDirectory: string = homedir()
  ) {
    // 避免使用参数属性，保证 Node 22 的 strip-only 测试运行时可直接加载此文件。
    this.storagePath = storagePath;
    this.platform = platform;
    this.homeDirectory = homeDirectory;
  }

  async resolveMavenHomeDefaults(mavenHome: string): Promise<MavenHomeDefaults> {
    const path = this.pathFor(mavenHome, this.homeDirectory);
    const normalizedMavenHome = path.resolve(mavenHome.trim());
    const settingsPath = path.join(normalizedMavenHome, 'conf', 'settings.xml');
    const fallbackRepository = path.join(path.resolve(this.homeDirectory), '.m2', 'repository');

    try {
      const settingsXml = await fs.readFile(settingsPath, 'utf8');
      const withoutComments = settingsXml.replace(/<!--[\s\S]*?-->/g, '');
      const configuredRepository = withoutComments.match(/<localRepository\b[^>]*>([\s\S]*?)<\/localRepository>/i)?.[1]?.trim();
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

  async get(workspaceRoot: string): Promise<WorkspaceBuildSettings | null> {
    await this.writeQueue;
    const store = await this.readStore();
    return store.workspaces[this.workspaceKey(workspaceRoot)] ?? null;
  }

  async save(settings: WorkspaceBuildSettings): Promise<WorkspaceBuildSettings> {
    const normalized = this.normalize(settings);
    const pending = this.writeQueue.then(async () => {
      const store = await this.readStore();
      store.workspaces[this.workspaceKey(normalized.workspaceRoot)] = normalized;
      await this.writeStore(store);
    });
    this.writeQueue = pending.catch(() => undefined);
    await pending;
    return normalized;
  }

  async remove(workspaceRoot: string): Promise<void> {
    const pending = this.writeQueue.then(async () => {
      const store = await this.readStore();
      delete store.workspaces[this.workspaceKey(workspaceRoot)];
      await this.writeStore(store);
    });
    this.writeQueue = pending.catch(() => undefined);
    await pending;
  }

  normalize(settings: WorkspaceBuildSettings): WorkspaceBuildSettings {
    const path = this.platform === 'win32' ? win32 : posix;
    const normalizeRequired = (value: string): string => path.resolve(value.trim());
    const normalizeOptional = (value?: string): string | undefined => {
      const trimmed = value?.trim();
      return trimmed ? path.resolve(trimmed) : undefined;
    };

    return {
      workspaceRoot: normalizeRequired(settings.workspaceRoot),
      mavenHome: normalizeRequired(settings.mavenHome),
      javaHome: normalizeRequired(settings.javaHome),
      settingsPath: normalizeOptional(settings.settingsPath),
      localRepository: normalizeOptional(settings.localRepository),
      validation: settings.validation
    };
  }

  private workspaceKey(workspaceRoot: string): string {
    const path = this.platform === 'win32' ? win32 : posix;
    const normalized = path.resolve(workspaceRoot.trim());
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

  private async readStore(): Promise<WorkspaceBuildSettingsStore> {
    try {
      const raw = await fs.readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WorkspaceBuildSettingsStore>;
      return {
        version: 1,
        workspaces: parsed.workspaces && typeof parsed.workspaces === 'object' ? parsed.workspaces : {}
      };
    } catch {
      return { ...EMPTY_STORE, workspaces: {} };
    }
  }

  private async writeStore(store: WorkspaceBuildSettingsStore): Promise<void> {
    await fs.mkdir(dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(store, null, 2), 'utf8');
  }

  private pathFor(...values: string[]): typeof win32 | typeof posix {
    // 配置可能在另一台系统创建后被导入；遇到盘符绝对路径时按 Windows 规则解析，避免拼入当前目录。
    return this.platform === 'win32' || values.some((value) => win32.isAbsolute(value.trim())) ? win32 : posix;
  }
}
