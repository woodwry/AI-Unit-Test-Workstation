import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export class WorkstationModelInterfaceUpgradeService {
  private readonly paths: {
    legacySettings: string;
    legacyCredentials: string;
    legacyWorkspaceSettings?: string;
    legacyWorkspaceCredentials?: string;
  };
  constructor(paths: {
    legacySettings: string;
    legacyCredentials: string;
    legacyWorkspaceSettings?: string;
    legacyWorkspaceCredentials?: string;
  }) { this.paths = paths; }

  async clearLegacyModelConfiguration(): Promise<void> {
    await Promise.all([
      removeIfExists(this.paths.legacySettings),
      removeIfExists(this.paths.legacyCredentials),
      removeIfExists(`${this.paths.legacySettings}.bak`),
      removeIfExists(`${this.paths.legacyCredentials}.bak`),
      ...(this.paths.legacyWorkspaceSettings
        ? [removeIfExists(this.paths.legacyWorkspaceSettings), removeIfExists(`${this.paths.legacyWorkspaceSettings}.bak`)]
        : []),
      ...(this.paths.legacyWorkspaceCredentials
        ? [removeIfExists(this.paths.legacyWorkspaceCredentials), removeIfExists(`${this.paths.legacyWorkspaceCredentials}.bak`)]
        : [])
    ]);
    await fs.mkdir(dirname(this.paths.legacySettings), { recursive: true });
  }
}

async function removeIfExists(path: string): Promise<void> {
  try { await fs.rm(path, { force: true }); } catch { /* best effort cleanup */ }
}
