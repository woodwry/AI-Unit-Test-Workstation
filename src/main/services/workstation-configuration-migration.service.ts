import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { WorkstationBuildSettings } from '../../shared/types.ts';
import { AtomicJsonStore } from './atomic-json-store.ts';
import type { WorkspaceBuildSettingsService } from './workspace-build-settings.service.ts';
import type { WorkspaceStateService } from './workspace-state.service.ts';
import { validateWorkstationBuildSettingsFile } from './workstation-build-settings.service.ts';

export type WorkstationConfigurationPaths = {
  buildSettings: string;
  completionMarker: string;
};

type MigrationDependencies = {
  isPackaged: boolean;
  userDataDirectory: string;
  paths: WorkstationConfigurationPaths;
  workspaceStateService: WorkspaceStateService;
  legacyBuildSettingsService: WorkspaceBuildSettingsService;
  reportFailure?: (message: string) => void;
};

type MigrationMarker = {
  version: 1;
  completedAt: string;
};

const MIGRATION_FAILURE_MESSAGE = '旧配置迁移失败，已保留旧数据，可在设置中重新配置';

/**
 * 只在安装版生产 userData 内迁移最后一个工作区的旧配置。
 * 迁移过程中不修改旧文件，也不会读取开发态 userData 目录。
 */
export class WorkstationConfigurationMigrationService {
  private readonly dependencies: MigrationDependencies;

  constructor(dependencies: MigrationDependencies) {
    this.dependencies = dependencies;
  }

  async migrateIfNeeded(): Promise<void> {
    if (!this.dependencies.isPackaged) return;

    const movedPaths: string[] = [];
    const stagingDirectory = join(
      this.dependencies.userDataDirectory,
      `.workstation-migration-${randomUUID()}`
    );
    try {
      if (await anyPathExists([
        this.dependencies.paths.buildSettings,
        `${this.dependencies.paths.buildSettings}.bak`
      ])) {
        return;
      }

      const workspaceRoot = await this.dependencies.workspaceStateService.getPersistedLastWorkspaceRoot();
      if (!workspaceRoot) return;
      const legacyBuild = await this.dependencies.legacyBuildSettingsService.get(workspaceRoot);
      if (!legacyBuild) return;
      const migratedBuild = migrateBuildSettings(legacyBuild);

      await fs.mkdir(stagingDirectory, { recursive: false });
      const stagingPaths = {
        buildSettings: join(stagingDirectory, 'workstation-build-settings.json')
      };
      const stagingBuildStore = new AtomicJsonStore(
        stagingPaths.buildSettings,
        validateWorkstationBuildSettingsFile,
        () => null
      );
      await stagingBuildStore.write(migratedBuild);

      // 回读 staging，确认三个文件均满足新 schema 后才进入正式目录。
      await stagingBuildStore.read();

      for (const [source, destination] of [
        [stagingPaths.buildSettings, this.dependencies.paths.buildSettings]
      ] as const) {
        await fs.rename(source, destination);
        movedPaths.push(destination);
      }

      const formalBuildStore = new AtomicJsonStore(
        this.dependencies.paths.buildSettings,
        validateWorkstationBuildSettingsFile,
        () => null
      );
      await formalBuildStore.read();

      const markerStore = new AtomicJsonStore<MigrationMarker>(
        this.dependencies.paths.completionMarker,
        validateMigrationMarker,
        () => ({ version: 1, completedAt: new Date(0).toISOString() })
      );
      await markerStore.write({ version: 1, completedAt: new Date().toISOString() });
      movedPaths.length = 0;
    } catch {
      // 只回滚本次刚从 staging 移入的固定全局文件，绝不触碰旧配置或用户项目。
      await Promise.allSettled(movedPaths.map((path) => fs.rm(path, { force: true })));
      await fs.rm(this.dependencies.paths.completionMarker, { force: true }).catch(() => undefined);
      this.dependencies.reportFailure?.(MIGRATION_FAILURE_MESSAGE);
    } finally {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function migrateBuildSettings(
  legacy: Awaited<ReturnType<WorkspaceBuildSettingsService['get']>>
): WorkstationBuildSettings | null {
  if (!legacy) return null;
  const candidate: WorkstationBuildSettings = {
    mavenHome: legacy.mavenHome,
    javaHome: legacy.javaHome,
    ...(legacy.settingsPath ? { settingsPath: legacy.settingsPath } : {}),
    ...(legacy.localRepository ? { localRepository: legacy.localRepository } : {}),
    ...(legacy.validation ? { validation: legacy.validation } : {})
  };
  try {
    return validateWorkstationBuildSettingsFile(candidate);
  } catch {
    // 旧校验快照若已过时，仅丢弃快照；工具链路径仍可迁移后由用户重新校验。
    const { validation: _discarded, ...withoutValidation } = candidate;
    return validateWorkstationBuildSettingsFile(withoutValidation);
  }
}

async function anyPathExists(paths: readonly string[]): Promise<boolean> {
  const results = await Promise.all(paths.map(async (path) => {
    try {
      await fs.access(path);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }));
  return results.some(Boolean);
}

function validateMigrationMarker(value: unknown): MigrationMarker {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !['version', 'completedAt'].includes(key)) ||
    (value as Partial<MigrationMarker>).version !== 1 ||
    typeof (value as Partial<MigrationMarker>).completedAt !== 'string'
  ) {
    throw new TypeError('工作站配置迁移标记格式无效');
  }
  return value as MigrationMarker;
}
