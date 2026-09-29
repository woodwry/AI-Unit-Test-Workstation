import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';
import type { BackendLogSink } from './backend-log-sink.ts';
import {
  BackendResourceResolver,
  type DevelopmentBackendResourcesInput,
  type ResolvedBackendServiceCommand
} from './backend-resource-resolver.ts';
import {
  BackendRuntimeRegistry,
  type BackendRuntimeReadySnapshot
} from './backend-runtime-registry.ts';
import {
  ManagedBackendProcess,
  ManagedBackendProcessError,
  type ManagedBackendFetch,
  type ManagedBackendProcessOptions,
  type ManagedBackendProcessReady,
  type ManagedBackendSleep,
  type ManagedBackendSpawn,
  type ManagedBackendUnexpectedExit
} from './managed-backend-process.ts';
import type { RuntimeServiceId, WindowsReleaseContractV1 } from './release-contract.ts';

export type BackendProcessManagerState =
  | 'idle'
  | 'starting-analyzer'
  | 'starting-agent'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export type BackendProcessManagerStatus = Readonly<{
  state: BackendProcessManagerState;
  message: string;
  retryable: boolean;
}>;

export type BackendProcessManagerStatusListener = (status: BackendProcessManagerStatus) => void;

export type ManagedBackendProcessController = Readonly<{
  service: RuntimeServiceId;
  start(): Promise<ManagedBackendProcessReady>;
  stop(): Promise<void>;
}>;

export type ManagedBackendProcessFactory = (
  options: ManagedBackendProcessOptions
) => ManagedBackendProcessController;

type BackendProcessManagerBaseOptions = Readonly<{
  contract: WindowsReleaseContractV1;
  registry: BackendRuntimeRegistry;
  logSink: BackendLogSink;
  resourceResolver?: BackendResourceResolver;
  processFactory?: ManagedBackendProcessFactory;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  parentPid?: number;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Buffer;
  spawn?: ManagedBackendSpawn;
  fetch?: ManagedBackendFetch;
  sleep?: ManagedBackendSleep;
  platform?: NodeJS.Platform;
  taskkillExecutablePath?: string;
}>;

export type BackendProcessManagerOptions = BackendProcessManagerBaseOptions & Readonly<{
  /** 安装包态由 Electron 直接传入 app.resourcesPath。 */
  resourcesPath?: string;
  /** 开发态必须显式给出两条命令，绝不从 renderer 或环境变量拼接命令。 */
  developmentResources?: DevelopmentBackendResourcesInput;
}>;

export class BackendProcessManagerError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'BackendProcessManagerError';
    this.retryable = retryable;
  }
}

const STATUS: Readonly<Record<BackendProcessManagerState, BackendProcessManagerStatus>> = Object.freeze({
  idle: Object.freeze({
    state: 'idle',
    message: '本地服务尚未启动。',
    retryable: true
  }),
  'starting-analyzer': Object.freeze({
    state: 'starting-analyzer',
    message: '正在启动本地代码分析服务…',
    retryable: false
  }),
  'starting-agent': Object.freeze({
    state: 'starting-agent',
    message: '正在启动本地智能生成服务…',
    retryable: false
  }),
  ready: Object.freeze({
    state: 'ready',
    message: '本地服务已就绪。',
    retryable: false
  }),
  failed: Object.freeze({
    state: 'failed',
    message: '本地服务不可用，请重试。',
    retryable: true
  }),
  stopping: Object.freeze({
    state: 'stopping',
    message: '正在关闭本地服务…',
    retryable: false
  }),
  stopped: Object.freeze({
    state: 'stopped',
    message: '本地服务已关闭。',
    retryable: true
  })
});

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUNTIME_ENVIRONMENT_PREFIXES = ['AI_UNIT_TEST_', 'AGENT_'] as const;

// java-analyzer 不接收任意用户变量或模型凭证，只保留 JVM/Maven 执行所需的系统基础环境。
const ANALYZER_SYSTEM_ENVIRONMENT = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'JAVA_HOME',
  'LOCALAPPDATA',
  'M2_HOME',
  'MAVEN_HOME',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
]);

function createDefaultProcess(options: ManagedBackendProcessOptions): ManagedBackendProcess {
  return new ManagedBackendProcess(options);
}

function internalErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : '未知内部错误';
}

function copyEnvironment(
  inherited: NodeJS.ProcessEnv,
  allowName?: (upperCaseName: string) => boolean
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    const upperCaseName = name.toUpperCase();
    if (RUNTIME_ENVIRONMENT_PREFIXES.some((prefix) => upperCaseName.startsWith(prefix))) {
      continue;
    }
    if (allowName && !allowName(upperCaseName)) continue;
    result[name] = value;
  }
  return result;
}

function publicStartError(error: unknown): Error {
  if (error instanceof ManagedBackendProcessError || error instanceof BackendProcessManagerError) {
    return error;
  }
  return new BackendProcessManagerError('本地后端组件启动失败，请重试。');
}

/**
 * 按 java-analyzer → agent-service 顺序启动，并仅在两个服务均 ready 后原子发布注册表。
 * 类本身不负责自动重启；异常退出只撤销可用状态并关闭仍存活的兄弟进程。
 */
export class BackendProcessManager {
  private readonly contract: WindowsReleaseContractV1;
  private readonly registry: BackendRuntimeRegistry;
  private readonly logSink: BackendLogSink;
  private readonly resourceResolver: BackendResourceResolver;
  private readonly processFactory: ManagedBackendProcessFactory;
  private readonly resourcesPath?: string;
  private readonly developmentResources?: DevelopmentBackendResourcesInput;
  private readonly inheritedEnvironment: NodeJS.ProcessEnv;
  private readonly parentPid: number;
  private readonly randomUUID: () => string;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly processDependencies: Pick<
    ManagedBackendProcessOptions,
    'spawn' | 'fetch' | 'sleep' | 'platform' | 'taskkillExecutablePath'
  >;
  private readonly listeners = new Set<BackendProcessManagerStatusListener>();

  private status = STATUS.idle;
  private startPromise: Promise<BackendRuntimeReadySnapshot> | null = null;
  private stopPromise: Promise<void> | null = null;
  private failureCleanupPromise: Promise<void> | null = null;
  private instanceId: string | null = null;
  private analyzerToken: string | null = null;
  private agentToken: string | null = null;
  private analyzerProcess: ManagedBackendProcessController | null = null;
  private agentProcess: ManagedBackendProcessController | null = null;
  private stopRequested = false;
  private runFailed = false;

  constructor(options: BackendProcessManagerOptions) {
    const hasPackagedResources = typeof options.resourcesPath === 'string';
    const hasDevelopmentResources = options.developmentResources !== undefined;
    if (hasPackagedResources === hasDevelopmentResources) {
      throw new TypeError('本地后端资源配置必须且只能选择安装包态或开发态');
    }
    if (!Number.isSafeInteger(options.parentPid ?? process.pid) || Number(options.parentPid ?? process.pid) <= 0) {
      throw new TypeError('Electron 父进程 PID 无效');
    }

    this.contract = options.contract;
    this.registry = options.registry;
    this.logSink = options.logSink;
    this.resourceResolver = options.resourceResolver ?? new BackendResourceResolver();
    this.processFactory = options.processFactory ?? createDefaultProcess;
    this.resourcesPath = options.resourcesPath;
    this.developmentResources = options.developmentResources;
    this.inheritedEnvironment = { ...(options.inheritedEnvironment ?? process.env) };
    this.parentPid = Number(options.parentPid ?? process.pid);
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.processDependencies = {
      spawn: options.spawn,
      fetch: options.fetch,
      sleep: options.sleep,
      platform: options.platform,
      taskkillExecutablePath: options.taskkillExecutablePath
    };
  }

  getStatus(): BackendProcessManagerStatus {
    return this.status;
  }

  subscribe(listener: BackendProcessManagerStatusListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('本地服务状态监听器无效');
    this.listeners.add(listener);
    this.notifyListener(listener, this.status);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  start(): Promise<BackendRuntimeReadySnapshot> {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) {
      return Promise.reject(new BackendProcessManagerError('本地服务正在关闭，请稍后重试。'));
    }
    if (this.failureCleanupPromise) {
      let queued: Promise<BackendRuntimeReadySnapshot>;
      queued = this.failureCleanupPromise.then(() => {
        if (this.startPromise === queued) this.startPromise = null;
        return this.start();
      });
      this.startPromise = queued;
      return queued;
    }

    this.stopRequested = false;
    this.runFailed = false;
    this.setStatus('starting-analyzer');
    const pending = this.startInternal();
    this.startPromise = pending;
    void pending.catch(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    return pending;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    // 未创建本轮实例时不能无条件清空注册表，否则可能撤销其他新实例的快照。
    if (this.instanceId !== null) this.registry.clear(this.instanceId);
    this.setStatus('stopping');
    const pending = this.stopInternal();
    this.stopPromise = pending;
    void pending.finally(() => {
      if (this.stopPromise === pending) this.stopPromise = null;
    });
    return pending;
  }

  private async startInternal(): Promise<BackendRuntimeReadySnapshot> {
    let localInstanceId: string | null = null;
    try {
      const commands = await this.resolveCommands();
      this.assertStartMayContinue();

      localInstanceId = this.randomUUID();
      if (!UUID_V4_PATTERN.test(localInstanceId)) throw new Error('随机 instanceId 无效');
      const analyzerToken = this.randomBytes(32).toString('base64url');
      const agentToken = this.randomBytes(32).toString('base64url');
      if (
        !ACCESS_TOKEN_PATTERN.test(analyzerToken) ||
        !ACCESS_TOKEN_PATTERN.test(agentToken) ||
        analyzerToken === agentToken
      ) {
        throw new Error('随机访问令牌无效或重复');
      }
      this.instanceId = localInstanceId;
      this.analyzerToken = analyzerToken;
      this.agentToken = agentToken;

      const analyzerProcess = this.createProcess(
        commands.javaAnalyzer,
        localInstanceId,
        analyzerToken,
        this.createAnalyzerEnvironment(localInstanceId, analyzerToken)
      );
      this.analyzerProcess = analyzerProcess;
      const analyzerReady = await analyzerProcess.start();
      this.assertStartMayContinue();

      this.setStatus('starting-agent');
      const agentProcess = this.createProcess(
        commands.agentService,
        localInstanceId,
        agentToken,
        this.createAgentEnvironment(
          localInstanceId,
          agentToken,
          analyzerReady.baseUrl,
          analyzerToken
        )
      );
      this.agentProcess = agentProcess;
      const agentReady = await agentProcess.start();
      this.assertStartMayContinue();

      // publishReady 是唯一发布点，renderer 永远看不到只启动了一半的连接。
      const snapshot = this.registry.publishReady({
        protocol: 1,
        instanceId: localInstanceId,
        javaAnalyzer: {
          baseUrl: analyzerReady.baseUrl,
          pid: analyzerReady.pid,
          accessToken: analyzerToken
        },
        agentService: {
          baseUrl: agentReady.baseUrl,
          pid: agentReady.pid,
          accessToken: agentToken
        }
      });
      this.writeManagerEvent('runtime-ready', 'info');
      this.setStatus('ready');
      return snapshot;
    } catch (error) {
      if (localInstanceId !== null) this.registry.clear(localInstanceId);
      await this.stopProcessesReverseOrder();
      if (!this.stopRequested) {
        this.writeManagerEvent('runtime-start-failed', 'error', internalErrorMessage(error));
        this.setStatus('failed');
      }
      this.clearRuntimeReferences();
      throw this.stopRequested
        ? new BackendProcessManagerError('本地服务启动已取消。', false)
        : publicStartError(error);
    }
  }

  private async stopInternal(): Promise<void> {
    try {
      await this.failureCleanupPromise?.catch(() => undefined);
      await this.stopProcessesReverseOrder();
      await this.logSink.flush().catch(() => undefined);
    } finally {
      this.clearRuntimeReferences();
      this.startPromise = null;
      this.failureCleanupPromise = null;
      this.setStatus('stopped');
    }
  }

  private async resolveCommands(): Promise<Readonly<{
    javaAnalyzer: ResolvedBackendServiceCommand;
    agentService: ResolvedBackendServiceCommand;
  }>> {
    if (this.resourcesPath !== undefined) {
      return (await this.resourceResolver.resolvePackaged(this.resourcesPath, this.contract)).services;
    }
    if (this.developmentResources !== undefined) {
      return (await this.resourceResolver.resolveDevelopment(this.developmentResources)).services;
    }
    throw new Error('本地后端资源未配置');
  }

  private createProcess(
    command: ResolvedBackendServiceCommand,
    instanceId: string,
    accessToken: string,
    environment: NodeJS.ProcessEnv
  ): ManagedBackendProcessController {
    return this.processFactory({
      command,
      instanceId,
      accessToken,
      environment,
      readyPath: this.contract.runtime.paths.ready,
      logSink: this.logSink,
      ...this.processDependencies,
      onUnexpectedExit: (event) => this.handleUnexpectedExit(instanceId, event)
    });
  }

  private createCommonRuntimeEnvironment(
    service: RuntimeServiceId,
    instanceId: string,
    accessToken: string,
    baseEnvironment: NodeJS.ProcessEnv
  ): NodeJS.ProcessEnv {
    const names = this.contract.runtime.environment;
    return {
      ...baseEnvironment,
      [names.protocol]: String(this.contract.runtime.protocol),
      [names.mode]: this.contract.runtime.mode,
      [names.service]: service,
      [names.instanceId]: instanceId,
      [names.parentPid]: String(this.parentPid),
      [names.accessToken]: accessToken
    };
  }

  private createAnalyzerEnvironment(instanceId: string, accessToken: string): NodeJS.ProcessEnv {
    const minimumSystemEnvironment = copyEnvironment(
      this.inheritedEnvironment,
      (name) => ANALYZER_SYSTEM_ENVIRONMENT.has(name)
    );
    return this.createCommonRuntimeEnvironment(
      'java-analyzer',
      instanceId,
      accessToken,
      minimumSystemEnvironment
    );
  }

  private createAgentEnvironment(
    instanceId: string,
    accessToken: string,
    analyzerBaseUrl: string,
    analyzerAccessToken: string
  ): NodeJS.ProcessEnv {
    const names = this.contract.runtime.environment;
    const environment = this.createCommonRuntimeEnvironment(
      'agent-service',
      instanceId,
      accessToken,
      copyEnvironment(this.inheritedEnvironment)
    );
    return {
      ...environment,
      [names.analyzerBaseUrl]: analyzerBaseUrl,
      [names.analyzerAccessToken]: analyzerAccessToken,
      [names.serverHost]: this.contract.runtime.host,
      [names.serverPort]: String(this.contract.runtime.port),
      [names.serverReload]: 'false'
    };
  }

  private assertStartMayContinue(): void {
    if (this.stopRequested) throw new BackendProcessManagerError('本地服务启动已取消。', false);
    if (this.runFailed) throw new BackendProcessManagerError('本地服务启动期间已有子进程退出。');
  }

  private handleUnexpectedExit(instanceId: string, event: ManagedBackendUnexpectedExit): void {
    if (this.stopRequested || this.instanceId !== instanceId || this.runFailed) return;
    this.runFailed = true;
    const hadPublishedSnapshot = this.registry.clear(instanceId);
    // clear 完成后同步发布 failed，订阅者不会继续把旧快照视为可用。
    this.setStatus('failed');
    this.writeManagerEvent(
      'runtime-process-exited',
      'error',
      `service=${event.service}, pid=${event.pid}, exitCode=${String(event.exitCode)}`
    );

    let cleanup: Promise<void>;
    cleanup = this.stopProcessesReverseOrder().finally(() => {
      if (this.failureCleanupPromise === cleanup) this.failureCleanupPromise = null;
      if (this.instanceId === instanceId) this.clearRuntimeReferences();
    });
    this.failureCleanupPromise = cleanup;
    if (hadPublishedSnapshot) this.startPromise = null;
    void cleanup.catch(() => undefined);
  }

  private async stopProcessesReverseOrder(): Promise<void> {
    const agent = this.agentProcess;
    const analyzer = this.analyzerProcess;
    if (agent) await agent.stop().catch((error) => {
      this.writeManagerEvent('agent-stop-failed', 'warn', internalErrorMessage(error));
    });
    if (analyzer) await analyzer.stop().catch((error) => {
      this.writeManagerEvent('analyzer-stop-failed', 'warn', internalErrorMessage(error));
    });
  }

  private clearRuntimeReferences(): void {
    this.instanceId = null;
    this.analyzerToken = null;
    this.agentToken = null;
    this.analyzerProcess = null;
    this.agentProcess = null;
  }

  private setStatus(state: BackendProcessManagerState): void {
    const next = STATUS[state];
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.listeners]) this.notifyListener(listener, next);
  }

  private notifyListener(
    listener: BackendProcessManagerStatusListener,
    status: BackendProcessManagerStatus
  ): void {
    try {
      listener(status);
    } catch (error) {
      this.writeManagerEvent('status-listener-failed', 'warn', internalErrorMessage(error));
    }
  }

  private sensitiveValues(): readonly string[] {
    return [this.analyzerToken, this.agentToken].filter((value): value is string => Boolean(value));
  }

  private writeManagerEvent(
    event: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message?: string
  ): void {
    void this.logSink.writeEvent(
      'process-manager',
      {
        level,
        event,
        ...(message === undefined ? {} : { message }),
        ...(this.instanceId === null ? {} : { instanceId: this.instanceId })
      },
      this.sensitiveValues()
    ).catch(() => undefined);
  }
}
