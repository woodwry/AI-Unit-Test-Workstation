import { inspect } from 'node:util';
import type { RuntimeServiceId } from './release-contract.ts';

export type RuntimeServiceReadyInput = Readonly<{
  baseUrl: string;
  pid: number;
  accessToken: string;
}>;

export type BackendRuntimeReadyInput = Readonly<{
  protocol: 1;
  instanceId: string;
  javaAnalyzer: RuntimeServiceReadyInput;
  agentService: RuntimeServiceReadyInput;
}>;

export type BackendRuntimeSafeServiceView = Readonly<{
  service: RuntimeServiceId;
  baseUrl: string;
  pid: number;
  instanceId: string;
}>;

export type BackendRuntimeSafeSnapshotView = Readonly<{
  protocol: 1;
  instanceId: string;
  readyAtMs: number;
  javaAnalyzer: BackendRuntimeSafeServiceView;
  agentService: BackendRuntimeSafeServiceView;
}>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_BASE_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

function registryError(field: string): never {
  // 不把 URL 或令牌值拼入错误，避免诊断链路意外泄漏启动期秘密。
  throw new TypeError(`本地后端运行时快照无效：${field}`);
}

function validateInstanceId(instanceId: unknown): string {
  if (typeof instanceId !== 'string' || !UUID_V4_PATTERN.test(instanceId)) {
    registryError('instanceId');
  }
  return instanceId;
}

function validatePid(pid: unknown, service: RuntimeServiceId): number {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
    registryError(`${service} pid`);
  }
  return Number(pid);
}

function validateBaseUrl(baseUrl: unknown, service: RuntimeServiceId): string {
  if (typeof baseUrl !== 'string') registryError(`${service} baseUrl`);
  const match = LOOPBACK_BASE_URL_PATTERN.exec(baseUrl);
  if (!match || Number(match[1]) > 65535) registryError(`${service} baseUrl`);
  return baseUrl;
}

function validateAccessToken(accessToken: unknown, service: RuntimeServiceId): string {
  // 32 字节随机值使用 Base64URL 无填充编码后固定为 43 个字符。
  if (typeof accessToken !== 'string' || !ACCESS_TOKEN_PATTERN.test(accessToken)) {
    registryError(`${service} accessToken`);
  }
  return accessToken;
}

function validateReadyAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) registryError('readyAtMs');
  return value;
}

/**
 * 单个托管服务的只读连接。令牌保存在私有字段中，JSON、字符串和 Node inspect
 * 只输出非敏感元数据；调用方必须显式请求 Authorization Header 才能使用令牌。
 */
export class ManagedBackendConnection {
  readonly service: RuntimeServiceId;
  readonly baseUrl: string;
  readonly pid: number;
  readonly instanceId: string;
  #accessToken: string;

  constructor(
    service: RuntimeServiceId,
    instanceId: string,
    input: RuntimeServiceReadyInput
  ) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      registryError(`${service} 连接`);
    }
    this.service = service;
    this.instanceId = validateInstanceId(instanceId);
    this.baseUrl = validateBaseUrl(input.baseUrl, service);
    this.pid = validatePid(input.pid, service);
    this.#accessToken = validateAccessToken(input.accessToken, service);
    Object.freeze(this);
  }

  createAuthorizationHeader(): string {
    return `Bearer ${this.#accessToken}`;
  }

  toJSON(): BackendRuntimeSafeServiceView {
    return Object.freeze({
      service: this.service,
      baseUrl: this.baseUrl,
      pid: this.pid,
      instanceId: this.instanceId
    });
  }

  toString(): string {
    return `${this.service}(${this.baseUrl}, pid=${this.pid}, token=[已隐藏])`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** 两个服务完整 ready 后形成的不可变快照。不存在半成品状态。 */
export class BackendRuntimeReadySnapshot {
  readonly protocol = 1 as const;
  readonly instanceId: string;
  readonly readyAtMs: number;
  readonly javaAnalyzer: ManagedBackendConnection;
  readonly agentService: ManagedBackendConnection;

  constructor(
    instanceId: string,
    javaAnalyzer: ManagedBackendConnection,
    agentService: ManagedBackendConnection,
    readyAtMs: number
  ) {
    this.instanceId = validateInstanceId(instanceId);
    if (javaAnalyzer.service !== 'java-analyzer' || agentService.service !== 'agent-service') {
      registryError('服务组合');
    }
    if (javaAnalyzer.instanceId !== this.instanceId || agentService.instanceId !== this.instanceId) {
      registryError('服务 instanceId');
    }
    this.javaAnalyzer = javaAnalyzer;
    this.agentService = agentService;
    this.readyAtMs = validateReadyAt(readyAtMs);
    Object.freeze(this);
  }

  connection(service: RuntimeServiceId): ManagedBackendConnection {
    return service === 'java-analyzer' ? this.javaAnalyzer : this.agentService;
  }

  toJSON(): BackendRuntimeSafeSnapshotView {
    return Object.freeze({
      protocol: 1,
      instanceId: this.instanceId,
      readyAtMs: this.readyAtMs,
      javaAnalyzer: this.javaAnalyzer.toJSON(),
      agentService: this.agentService.toJSON()
    });
  }

  toString(): string {
    return `BackendRuntimeReadySnapshot(instanceId=${this.instanceId}, readyAtMs=${this.readyAtMs}, tokens=[已隐藏])`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * 运行时注册表只保存 null 或完整双服务快照。新快照会先在局部变量中完成全部
 * 校验和构造，最后一次赋值发布；校验失败不会破坏已经可用的旧快照。
 */
export class BackendRuntimeRegistry {
  #snapshot: BackendRuntimeReadySnapshot | null = null;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  publishReady(input: BackendRuntimeReadyInput): BackendRuntimeReadySnapshot {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.protocol !== 1) {
      registryError('结构');
    }
    const instanceId = validateInstanceId(input.instanceId);
    if (!input.javaAnalyzer || !input.agentService) registryError('服务组合');
    if (input.javaAnalyzer.accessToken === input.agentService.accessToken) {
      registryError('访问令牌不得复用');
    }

    const javaAnalyzer = new ManagedBackendConnection('java-analyzer', instanceId, input.javaAnalyzer);
    const agentService = new ManagedBackendConnection('agent-service', instanceId, input.agentService);
    const next = new BackendRuntimeReadySnapshot(
      instanceId,
      javaAnalyzer,
      agentService,
      validateReadyAt(this.clock())
    );
    this.#snapshot = next;
    return next;
  }

  getReadySnapshot(): BackendRuntimeReadySnapshot | null {
    return this.#snapshot;
  }

  requireReadySnapshot(): BackendRuntimeReadySnapshot {
    if (!this.#snapshot) throw new Error('本地服务尚未就绪');
    return this.#snapshot;
  }

  isReady(): boolean {
    return this.#snapshot !== null;
  }

  /** 带 instanceId 的清理不会让旧进程退出事件误删后来启动的新快照。 */
  clear(expectedInstanceId?: string): boolean {
    if (!this.#snapshot) return false;
    if (expectedInstanceId !== undefined && this.#snapshot.instanceId !== expectedInstanceId) {
      return false;
    }
    this.#snapshot = null;
    return true;
  }

  toJSON(): BackendRuntimeSafeSnapshotView | null {
    return this.#snapshot?.toJSON() ?? null;
  }

  [inspect.custom](): string {
    return this.#snapshot ? this.#snapshot.toString() : 'BackendRuntimeRegistry(empty)';
  }
}
