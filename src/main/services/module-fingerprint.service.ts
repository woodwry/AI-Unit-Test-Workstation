import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkstationBuildSettings } from '../../shared/types.ts';
import { ModuleIdentityService, type ModuleIdentity } from './module-identity.service.ts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_FINGERPRINT_ENTRIES = 50_000;
const CLASS_REPORT_SCHEMA_VERSION = 2;

export type NormalizedToolchainVersions = {
  mavenVersion: string;
  javaVersion: string;
};

export type OwnedModuleArtifact = {
  path: string;
  sha256: string;
};

export type ModuleFingerprintInput = {
  workspaceRoot: string;
  sourceFilePath: string;
  buildSettings: WorkstationBuildSettings;
  toolchain: NormalizedToolchainVersions;
  watcherVersion: number;
  /** Additional normalized launcher identity, when the caller has one. */
  toolchainIdentity?: string;
  /** Exact task-owned artifacts to exclude while generation or repair is still mutable. */
  ownedArtifacts?: readonly OwnedModuleArtifact[];
};

export type ClassReportFingerprintInput = ModuleFingerprintInput & {
  qualifiedClassName: string;
  directTestFilePaths: readonly string[];
};

export type ModuleFingerprint = {
  sha256: string;
  watcherVersion: number;
  fileCount: number;
  calculatedAt: string;
};

type FingerprintEntry = {
  path: string;
  size: number;
  mtimeMs: number;
};

export type ModuleFingerprintFileSystem = Pick<
  typeof fs,
  'realpath' | 'stat' | 'readdir' | 'readFile'
>;

/** Calculates a metadata-only, deterministic representation of Maven module state. */
export class ModuleFingerprintService {
  private readonly identityService: ModuleIdentityService;
  private readonly clock: () => Date;
  private readonly fileSystem: ModuleFingerprintFileSystem;

  constructor(
    identityService: ModuleIdentityService = new ModuleIdentityService(),
    clock: () => Date = () => new Date(),
    fileSystem: ModuleFingerprintFileSystem = fs
  ) {
    this.identityService = identityService;
    this.clock = clock;
    this.fileSystem = fileSystem;
  }

  async calculate(input: ModuleFingerprintInput): Promise<ModuleFingerprint> {
    this.requireInput(input);
    const identity = await this.identityService.resolve(input.workspaceRoot, input.sourceFilePath);
    const ownedArtifacts = await this.ownedArtifactHashes(input.ownedArtifacts ?? []);
    const entries = await this.collectSortedEntries(identity, ownedArtifacts);
    const canonical = entries
      .map(({ path, size, mtimeMs }) => `${path}\0${size}\0${mtimeMs}`)
      .join('\n');
    const toolchainIdentity = await this.calculateToolchainIdentity(input);
    const digest = createHash('sha256')
      .update(
        `${canonical}\nwatcher=${input.watcherVersion}\ntoolchain=${toolchainIdentity}`,
        'utf8'
      )
      .digest('hex');
    return {
      sha256: digest,
      watcherVersion: input.watcherVersion,
      fileCount: entries.length,
      calculatedAt: this.clock().toISOString()
    };
  }

  async calculateClass(
    input: ClassReportFingerprintInput
  ): Promise<ModuleFingerprint> {
    this.requireInput(input);
    if (!isBoundedText(input.qualifiedClassName)
      || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(input.qualifiedClassName)) {
      throw new TypeError('目标类全限定名无效。');
    }
    if (!Array.isArray(input.directTestFilePaths)
      || input.directTestFilePaths.length > MAX_FINGERPRINT_ENTRIES) {
      throw new TypeError('目标类直接测试文件列表无效。');
    }

    const identity = await this.identityService.resolve(
      input.workspaceRoot,
      input.sourceFilePath
    );
    const ownedArtifacts = await this.ownedArtifactHashes(
      input.ownedArtifacts ?? []
    );
    const paths = new Set<string>([identity.sourceFilePath]);
    for (const testFilePath of input.directTestFilePaths) {
      if (!isBoundedText(testFilePath)) {
        throw new TypeError('目标类直接测试文件路径无效。');
      }
      const canonical = await this.fileSystem.realpath(resolve(testFilePath));
      if (!this.isInsideOrEqual(identity.moduleDisplayPath, canonical)) {
        throw new Error('目标类直接测试文件必须位于当前 Maven 模块内。');
      }
      const stat = await this.fileSystem.stat(canonical);
      if (!stat.isFile()) throw new Error('目标类直接测试路径不是普通文件。');
      if (!await this.isMatchingOwnedArtifact(canonical, ownedArtifacts)) {
        paths.add(canonical);
      }
    }

    let current = identity.moduleDisplayPath;
    while (this.isInsideOrEqual(identity.workspaceRoot, current)) {
      const canonicalPom = await this.canonicalPomInsideWorkspace(
        identity.workspaceRoot,
        join(current, 'pom.xml')
      );
      if (canonicalPom) paths.add(canonicalPom);
      if (this.samePath(current, identity.workspaceRoot)) break;
      const parent = dirname(current);
      if (this.samePath(parent, current)) break;
      current = parent;
    }

    const entries = await Promise.all([...paths].map(async (filePath) => ({
      path: this.relativeComparisonPath(identity.workspaceRoot, filePath),
      sha256: createHash('sha256')
        .update(await this.fileSystem.readFile(filePath))
        .digest('hex')
    })));
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const toolchainIdentity = await this.calculateToolchainIdentity(input);
    const digest = createHash('sha256').update(JSON.stringify({
      classReportSchemaVersion: CLASS_REPORT_SCHEMA_VERSION,
      qualifiedClassName: input.qualifiedClassName,
      files: entries,
      toolchainIdentity
    }), 'utf8').digest('hex');
    return {
      sha256: digest,
      watcherVersion: input.watcherVersion,
      fileCount: entries.length,
      calculatedAt: this.clock().toISOString()
    };
  }

  private async collectSortedEntries(
    identity: ModuleIdentity,
    ownedArtifactHashes: ReadonlyMap<string, string>
  ): Promise<FingerprintEntry[]> {
    const paths = new Set<string>();
    let current = identity.moduleDisplayPath;
    while (this.isInsideOrEqual(identity.workspaceRoot, current)) {
      const pomPath = join(current, 'pom.xml');
      const canonicalPom = await this.canonicalPomInsideWorkspace(
        identity.workspaceRoot,
        pomPath
      );
      if (canonicalPom) paths.add(canonicalPom);
      if (this.samePath(current, identity.workspaceRoot)) break;
      const parent = dirname(current);
      if (this.samePath(parent, current)) break;
      current = parent;
    }
    for (const directory of [
      join(identity.moduleDisplayPath, 'src', 'main', 'java'),
      join(identity.moduleDisplayPath, 'src', 'test', 'java'),
      join(identity.moduleDisplayPath, 'src', 'test', 'resources')
    ]) {
      await this.collectFiles(directory, paths);
    }

    const entries: FingerprintEntry[] = [];
    for (const filePath of paths) {
      if (await this.isMatchingOwnedArtifact(filePath, ownedArtifactHashes)) continue;
      const stat = await this.fileSystem.stat(filePath);
      entries.push({
        path: this.relativeComparisonPath(identity.workspaceRoot, filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
    return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  private async collectFiles(directory: string, target: Set<string>): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await this.fileSystem.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.collectFiles(entryPath, target);
      } else if (entry.isFile()) {
        target.add(await this.fileSystem.realpath(entryPath));
        if (target.size > MAX_FINGERPRINT_ENTRIES) {
          throw new Error('模块状态文件数量超过允许上限。');
        }
      }
    }
  }

  private async ownedArtifactHashes(
    artifacts: readonly OwnedModuleArtifact[]
  ): Promise<Map<string, string>> {
    if (artifacts.length > MAX_FINGERPRINT_ENTRIES) {
      throw new TypeError('受管文件数量超过允许上限。');
    }
    const result = new Map<string, string>();
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) {
        throw new TypeError('受管文件账本记录无效。');
      }
      try {
        result.set(
          this.identityService.comparisonKey(await this.fileSystem.realpath(resolve(artifact.path))),
          artifact.sha256.toLowerCase()
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return result;
  }

  private async isMatchingOwnedArtifact(
    filePath: string,
    ownedArtifactHashes: ReadonlyMap<string, string>
  ): Promise<boolean> {
    const expected = ownedArtifactHashes.get(this.identityService.comparisonKey(filePath));
    if (!expected) return false;
    const current = createHash('sha256')
      .update(await this.fileSystem.readFile(filePath))
      .digest('hex');
    return current === expected;
  }

  private async calculateToolchainIdentity(input: ModuleFingerprintInput): Promise<string> {
    const configuration = await Promise.all([
      this.configurationIdentity('mavenHome', input.buildSettings.mavenHome),
      this.configurationIdentity('javaHome', input.buildSettings.javaHome),
      this.configurationIdentity('settingsPath', input.buildSettings.settingsPath),
      this.configurationIdentity('localRepository', input.buildSettings.localRepository)
    ]);
    const extraIdentity = input.toolchainIdentity?.trim() ?? '';
    return createHash('sha256').update(JSON.stringify({
      configuration,
      javaVersion: input.toolchain.javaVersion,
      mavenVersion: input.toolchain.mavenVersion,
      extraIdentity
    }), 'utf8').digest('hex');
  }

  private async configurationIdentity(label: string, value: string | undefined): Promise<unknown> {
    if (!value) return { label, path: null, size: null, mtimeMs: null };
    const resolved = resolve(value);
    try {
      const canonical = await this.fileSystem.realpath(resolved);
      const stat = await this.fileSystem.stat(canonical);
      return {
        label,
        path: this.identityService.comparisonKey(canonical),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        label,
        path: this.identityService.comparisonKey(resolved),
        size: null,
        mtimeMs: null
      };
    }
  }

  private requireInput(input: ModuleFingerprintInput): void {
    if (!input || !Number.isSafeInteger(input.watcherVersion) || input.watcherVersion < 0) {
      throw new TypeError('观察器版本必须是非负安全整数。');
    }
    if (!input.buildSettings || !input.toolchain || !isBoundedText(input.toolchain.mavenVersion) || !isBoundedText(input.toolchain.javaVersion)) {
      throw new TypeError('构建工具链身份无效。');
    }
    if (input.toolchainIdentity !== undefined && !isBoundedText(input.toolchainIdentity)) {
      throw new TypeError('附加工具链身份无效。');
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
    if (!this.isInsideOrEqual(workspaceRoot, canonicalPom)) {
      throw new Error('Maven pom.xml 的规范路径必须位于当前工作区内。');
    }
    return (await this.fileSystem.stat(canonicalPom)).isFile()
      ? canonicalPom
      : null;
  }

  private relativeComparisonPath(workspaceRoot: string, filePath: string): string {
    return this.identityService.comparisonKey(relative(workspaceRoot, filePath));
  }

  private isInsideOrEqual(parent: string, child: string): boolean {
    if (this.samePath(parent, child)) return true;
    const value = relative(parent, child);
    return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  }

  private samePath(left: string, right: string): boolean {
    return this.identityService.comparisonKey(left) === this.identityService.comparisonKey(right);
  }
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 4_096;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
