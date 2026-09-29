import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import releaseContractSource from '../../../packaging/windows/release-contract.json' with { type: 'json' };
import {
  parseBackendManifest,
  type BackendManifestEntrypoint,
  type BackendManifestV1
} from './backend-manifest.ts';
import { BackendLogSink } from './backend-log-sink.ts';
import {
  BackendProcessManager,
  type BackendProcessManagerStatus,
  type BackendProcessManagerStatusListener
} from './backend-process-manager.ts';
import {
  BackendRuntimeRegistry,
  type BackendRuntimeReadySnapshot
} from './backend-runtime-registry.ts';
import {
  parseWindowsReleaseContract,
  type WindowsReleaseContractV1
} from './release-contract.ts';

export type PackagedBackendRuntimeOptions = Readonly<{
  resourcesPath: string;
  userDataPath: string;
}>;

export type PackagedBackendManagedAccess = Readonly<{
  agentServiceUrl: string;
  agentServiceAuthorizationHeader: string;
  javaAnalyzerUrl: string;
  javaAnalyzerAuthorizationHeader: string;
}>;

export class PackagedBackendRuntimeError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'PackagedBackendRuntimeError';
    this.retryable = retryable;
  }
}

class PackagedBackendRuntimeAttemptCancelledError extends Error {
  constructor() {
    super('packaged backend runtime attempt cancelled');
    this.name = 'PackagedBackendRuntimeAttemptCancelledError';
  }
}

const RELEASE_CONTRACT: WindowsReleaseContractV1 = parseWindowsReleaseContract(
  releaseContractSource as unknown
);
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const VERIFYING_STATUS: BackendProcessManagerStatus = Object.freeze({
  state: 'starting-analyzer',
  message: '正在校验并启动本地服务…',
  retryable: false
});
const INTEGRITY_FAILED_STATUS: BackendProcessManagerStatus = Object.freeze({
  state: 'failed',
  message: '本地后端组件校验失败，请重新安装工作站。',
  retryable: false
});

function configurationPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} 无效`);
  }
  return resolve(value);
}

function internalErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : '未知内部错误';
}

function integrityError(field: string): never {
  // 产品层只返回统一中文提示；字段级原因只进入受控本地日志。
  throw new Error(`后端安装资源校验失败：${field}`);
}

function assertStrictlyInside(root: string, candidate: string, field: string): void {
  const child = relative(root, candidate);
  if (
    !child ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    win32.isAbsolute(child)
  ) {
    integrityError(field);
  }
}

function sameOpenedFile(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

function normalizeContractPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Electron 安装包态唯一入口。renderer 不接触该对象；只有主进程能显式取得带
 * Authorization Header 的连接，普通状态订阅永远不包含 URL、PID、实例号或令牌。
 */
export class PackagedBackendRuntime {
  private readonly resourcesPath: string;
  private readonly registry: BackendRuntimeRegistry;
  private readonly logSink: BackendLogSink;
  private readonly manager: BackendProcessManager;
  private readonly statusListeners = new Set<BackendProcessManagerStatusListener>();
  private status: BackendProcessManagerStatus;
  private startPromise: Promise<BackendRuntimeReadySnapshot> | null = null;
  private retryPromise: Promise<BackendRuntimeReadySnapshot> | null = null;
  private lifecycleRevision = 0;
  readonly logDirectory: string;

  constructor(options: PackagedBackendRuntimeOptions) {
    this.resourcesPath = configurationPath(options.resourcesPath, 'resourcesPath');
    const userDataPath = configurationPath(options.userDataPath, 'userDataPath');
    this.logDirectory = join(userDataPath, 'logs', 'backend');
    this.registry = new BackendRuntimeRegistry();
    this.logSink = new BackendLogSink(this.logDirectory);
    this.manager = new BackendProcessManager({
      resourcesPath: this.resourcesPath,
      contract: RELEASE_CONTRACT,
      registry: this.registry,
      logSink: this.logSink
    });
    this.status = this.manager.getStatus();
    this.manager.subscribe((status) => {
      if (status.state === 'failed' || status.state === 'stopped') this.startPromise = null;
      this.publishStatus(status);
    });
  }

  start(): Promise<BackendRuntimeReadySnapshot> {
    if (this.retryPromise) return this.retryPromise;
    if (this.startPromise) return this.startPromise;
    const revision = ++this.lifecycleRevision;
    return this.startAttempt(revision);
  }

  private startAttempt(revision: number): Promise<BackendRuntimeReadySnapshot> {
    this.assertAttemptCurrent(revision);
    this.publishStatus(VERIFYING_STATUS);
    const pending = this.startInternal(revision);
    this.startPromise = pending;
    void pending.catch(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    return pending;
  }

  stop(): Promise<void> {
    ++this.lifecycleRevision;
    this.startPromise = null;
    return this.manager.stop();
  }

  retry(): Promise<BackendRuntimeReadySnapshot> {
    if (this.retryPromise) return this.retryPromise;
    // retry 自己持有一个代次；其间再次 stop 会使该代次失效，不能在 stop 完成后反向启动旧任务。
    const revision = ++this.lifecycleRevision;
    this.startPromise = null;
    const pending = this.manager.stop()
      .then(() => {
        this.assertAttemptCurrent(revision);
        return this.startAttempt(revision);
      })
      .catch((error: unknown) => {
        if (
          error instanceof PackagedBackendRuntimeAttemptCancelledError ||
          revision !== this.lifecycleRevision
        ) {
          throw this.publicCancellationError();
        }
        throw error;
      });
    this.retryPromise = pending;
    void pending.then(
      () => {
        if (this.retryPromise === pending) this.retryPromise = null;
      },
      () => {
        if (this.retryPromise === pending) this.retryPromise = null;
      }
    );
    return pending;
  }

  getStatus(): BackendProcessManagerStatus {
    return this.status;
  }

  subscribe(listener: BackendProcessManagerStatusListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('本地服务状态监听器无效');
    this.statusListeners.add(listener);
    this.notifyListener(listener, this.status);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.statusListeners.delete(listener);
    };
  }

  getManagedAccess(): PackagedBackendManagedAccess {
    // 每个请求都重新读取当前快照，异常退出后不会继续复用已经撤销的旧连接。
    const snapshot = this.registry.requireReadySnapshot();
    return Object.freeze({
      agentServiceUrl: snapshot.agentService.baseUrl,
      agentServiceAuthorizationHeader: snapshot.agentService.createAuthorizationHeader(),
      javaAnalyzerUrl: snapshot.javaAnalyzer.baseUrl,
      javaAnalyzerAuthorizationHeader: snapshot.javaAnalyzer.createAuthorizationHeader()
    });
  }

  private async startInternal(revision: number): Promise<BackendRuntimeReadySnapshot> {
    let integrityVerified = false;
    try {
      this.assertAttemptCurrent(revision);
      const manifest = await this.readAndValidateManifest(revision);
      this.assertAttemptCurrent(revision);
      await this.verifyEntrypoints(manifest, revision);
      this.assertAttemptCurrent(revision);
      integrityVerified = true;
      // assert 与 manager.start 之间没有异步让出点，旧代次无法在 stop 后进入进程管理器。
      return await this.manager.start();
    } catch (error) {
      if (
        error instanceof PackagedBackendRuntimeAttemptCancelledError ||
        revision !== this.lifecycleRevision
      ) {
        throw this.publicCancellationError();
      }
      if (!integrityVerified) {
        this.writeIntegrityFailure(error);
        this.publishStatus(INTEGRITY_FAILED_STATUS);
        throw new PackagedBackendRuntimeError(
          '本地后端组件校验失败，请重新安装工作站。',
          false
        );
      }
      throw new PackagedBackendRuntimeError('本地服务启动失败，请重试。', true);
    }
  }

  private async readAndValidateManifest(revision: number): Promise<BackendManifestV1> {
    this.assertAttemptCurrent(revision);
    const resourcesRoot = await fs.realpath(this.resourcesPath);
    this.assertAttemptCurrent(revision);
    const resourcesStats = await fs.stat(resourcesRoot);
    this.assertAttemptCurrent(revision);
    if (!resourcesStats.isDirectory()) integrityError('resourcesPath');

    const manifestCandidate = resolve(
      resourcesRoot,
      ...RELEASE_CONTRACT.resources.backendManifestRelativePath.replaceAll('\\', '/').split('/')
    );
    assertStrictlyInside(resourcesRoot, manifestCandidate, 'backend manifest 路径');
    const manifestPath = await fs.realpath(manifestCandidate);
    this.assertAttemptCurrent(revision);
    assertStrictlyInside(resourcesRoot, manifestPath, 'backend manifest realpath');
    const manifestStats = await fs.stat(manifestPath);
    this.assertAttemptCurrent(revision);
    if (!manifestStats.isFile() || manifestStats.size <= 0 || manifestStats.size > MAX_MANIFEST_BYTES) {
      integrityError('backend manifest 文件');
    }

    let manifestSource: string;
    try {
      manifestSource = await fs.readFile(manifestPath, 'utf8');
    } catch {
      return integrityError('backend manifest JSON');
    }
    this.assertAttemptCurrent(revision);
    let source: unknown;
    try {
      source = JSON.parse(manifestSource) as unknown;
    } catch {
      return integrityError('backend manifest JSON');
    }
    const manifest = parseBackendManifest(source);
    this.validateManifestContract(manifest);
    this.assertAttemptCurrent(revision);
    return manifest;
  }

  private validateManifestContract(manifest: BackendManifestV1): void {
    const analyzer = RELEASE_CONTRACT.services[0];
    const agent = RELEASE_CONTRACT.services[1];
    if (
      manifest.product.version !== RELEASE_CONTRACT.product.version ||
      manifest.product.platform !== RELEASE_CONTRACT.product.platform ||
      manifest.product.arch !== RELEASE_CONTRACT.product.arch
    ) {
      integrityError('product 版本或平台');
    }
    if (
      manifest.components.javaAnalyzer.version !== analyzer.version ||
      manifest.components.agentService.version !== agent.version
    ) {
      integrityError('component 版本');
    }
    if (
      manifest.javaRuntime.distribution !== RELEASE_CONTRACT.toolchain.javaRuntimeVendor ||
      manifest.javaRuntime.version !== RELEASE_CONTRACT.toolchain.javaRuntimeVersion ||
      manifest.javaRuntime.architecture !== 'x86_64'
    ) {
      integrityError('JRE 身份或版本');
    }

    const jarIndex = analyzer.arguments.indexOf('-jar');
    if (
      normalizeContractPath(agent.executableRelativePath) !== manifest.entrypoints.agentService.path ||
      normalizeContractPath(analyzer.executableRelativePath) !== manifest.entrypoints.javaRuntime.path ||
      jarIndex < 0 ||
      jarIndex >= analyzer.arguments.length - 1 ||
      normalizeContractPath(analyzer.arguments[jarIndex + 1]) !== manifest.entrypoints.javaAnalyzer.path
    ) {
      integrityError('入口与发布契约');
    }
  }

  private async verifyEntrypoints(manifest: BackendManifestV1, revision: number): Promise<void> {
    this.assertAttemptCurrent(revision);
    const resourcesRoot = await fs.realpath(this.resourcesPath);
    this.assertAttemptCurrent(revision);
    for (const [name, entrypoint] of Object.entries(manifest.entrypoints)) {
      this.assertAttemptCurrent(revision);
      await this.verifyEntrypoint(resourcesRoot, entrypoint, name, revision);
      this.assertAttemptCurrent(revision);
    }
  }

  private async verifyEntrypoint(
    resourcesRoot: string,
    entrypoint: BackendManifestEntrypoint,
    name: string,
    revision: number
  ): Promise<void> {
    this.assertAttemptCurrent(revision);
    const candidate = resolve(resourcesRoot, ...entrypoint.path.split('/'));
    assertStrictlyInside(resourcesRoot, candidate, `${name} 路径`);
    const realPath = await fs.realpath(candidate);
    this.assertAttemptCurrent(revision);
    assertStrictlyInside(resourcesRoot, realPath, `${name} realpath`);

    const handle = await fs.open(realPath, 'r');
    try {
      this.assertAttemptCurrent(revision);
      const before = await handle.stat();
      this.assertAttemptCurrent(revision);
      if (!before.isFile() || before.size !== entrypoint.size) integrityError(`${name} size`);
      const digest = createHash('sha256');
      let streamedSize = 0;
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        this.assertAttemptCurrent(revision);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        streamedSize += bytes.byteLength;
        if (!Number.isSafeInteger(streamedSize) || streamedSize > entrypoint.size) {
          integrityError(`${name} streamed size`);
        }
        digest.update(bytes);
      }
      this.assertAttemptCurrent(revision);
      const after = await handle.stat();
      this.assertAttemptCurrent(revision);
      if (
        streamedSize !== entrypoint.size ||
        digest.digest('hex') !== entrypoint.sha256 ||
        !sameOpenedFile(before, after)
      ) {
        integrityError(`${name} hash`);
      }
    } finally {
      await handle.close();
    }

    // 哈希完成后再确认路径仍指向同一实体，缩小校验与启动之间的替换窗口。
    this.assertAttemptCurrent(revision);
    const finalRealPath = await fs.realpath(candidate);
    this.assertAttemptCurrent(revision);
    if (finalRealPath !== realPath) integrityError(`${name} 校验后路径`);
  }

  private assertAttemptCurrent(revision: number): void {
    if (revision !== this.lifecycleRevision) {
      throw new PackagedBackendRuntimeAttemptCancelledError();
    }
  }

  private publicCancellationError(): PackagedBackendRuntimeError {
    return new PackagedBackendRuntimeError('本地服务启动已取消。', false);
  }

  private publishStatus(status: BackendProcessManagerStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) this.notifyListener(listener, status);
  }

  private notifyListener(
    listener: BackendProcessManagerStatusListener,
    status: BackendProcessManagerStatus
  ): void {
    try {
      listener(status);
    } catch (error) {
      void this.logSink.writeEvent('process-manager', {
        level: 'warn',
        event: 'packaged-status-listener-failed',
        message: internalErrorMessage(error)
      }).catch(() => undefined);
    }
  }

  private writeIntegrityFailure(error: unknown): void {
    void this.logSink.writeEvent('process-manager', {
      level: 'error',
      event: 'packaged-runtime-integrity-failed',
      message: internalErrorMessage(error)
    }).catch(() => undefined);
  }
}
