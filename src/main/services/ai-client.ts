import { Buffer } from 'node:buffer';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import type {
  BackendSettings,
  BackendLlmConfig,
  GenerateTargetJacocoReportRequest,
  GenerateTargetJacocoReportResponse
} from '../../shared/types';
import {
  ANALYSIS_SESSION_ID_PATTERN,
  METHOD_ID_PATTERN,
  METHOD_ANALYSIS_RESPONSE_INVALID,
  MethodAnalysisRequestError,
  REPORT_PAIR_ID_PATTERN,
  decodeCreateMethodAnalysisSessionResponse,
  decodeClassScenarioWaveResponse,
  decodeMethodCatalogResponse,
  decodeMethodRepairContextResponse,
  decodeRefreshMethodAnalysisCoverageResponse,
  decodeSingleMethodBatchResponse,
  decodeSingleMethodWaveResponse,
  validateSingleMethodBatchRequest,
  validateSingleMethodWaveRequest,
  validateClassScenarioWaveRequest,
  validateMethodRepairContextRequest,
  type CreateMethodAnalysisSessionRequest,
  type CreateMethodAnalysisSessionResponse,
  type ClassScenarioWaveRequest,
  type ClassScenarioWaveResponse,
  type MethodCatalogResponse,
  type MethodRepairContextRequest,
  type MethodRepairContextResponse,
  type RefreshMethodAnalysisCoverageRequest,
  type RefreshMethodAnalysisCoverageResponse,
  type SingleMethodBatchRequest,
  type SingleMethodBatchResponse,
  type SingleMethodWaveRequest,
  type SingleMethodWaveResponse
} from './method-analysis-contract.ts';
import {
  METHOD_GENERATION_RESPONSE_INVALID,
  MethodGenerationSessionNotFoundError,
  MethodGenerationStreamInterruptedError,
  MethodGenerationWaveNotFoundError,
  MethodGenerationWaveStreamInterruptedError,
  decodeMethodGenerationAcknowledgement,
  decodeMethodGenerationEvent,
  decodeMethodGenerationStatus,
  decodeMethodGenerationWaveAcknowledgement,
  decodeMethodGenerationWaveEvent,
  decodeMethodGenerationWaveStatus,
  validateRecoverMethodGenerationRequest,
  validateRecoverMethodGenerationWaveRequest,
  validatePrepareRagRepairRequest,
  validateResumeMethodGenerationRequest,
  validateStartMethodGenerationRequest,
  validateStartMethodGenerationWaveRequest,
  type MethodGenerationEventsAcknowledgement,
  type MethodGenerationIdentity,
  type MethodGenerationModelContext,
  type MethodGenerationProgressHandler,
  MethodGenerationRequestError,
  type PrepareRagRepairRequest,
  type RecoverMethodGenerationSessionRequest,
  type MethodGenerationSessionEvent,
  type MethodGenerationSessionStatus,
  type MethodGenerationTurnResult,
  type MethodGenerationWaveEventsAcknowledgement,
  type MethodGenerationWaveIdentity,
  type MethodGenerationWaveProgressHandler,
  type MethodGenerationWaveStatus,
  type MethodGenerationWaveTurnResult,
  type RecoverMethodGenerationWaveRequest,
  type ResumeMethodGenerationSessionRequest,
  type StartMethodGenerationSessionRequest,
  type StartMethodGenerationWaveRequest
} from './method-generation-contract.ts';
import {
  decodeCreateRagSourceSnapshotSessionResponse,
  decodeModelToolCallingProbeResponse,
  decodePrepareRagRepairResponse,
  decodeResolveRagSourceSetResponse,
  decodeRagSourceSnapshotPageResponse,
  validateCreateRagSourceSnapshotSessionRequest,
  validateResolveRagSourceSetRequest,
  type CreateRagSourceSnapshotSessionRequest,
  type CreateRagSourceSnapshotSessionResponse,
  type ModelToolCallingProbeResponse,
  type PrepareRagRepairResponse,
  type ResolveRagSourceSetRequest,
  type ResolveRagSourceSetResponse,
  type RagSourceSnapshotPage
} from './rag-index-contract.ts';
import { sanitizePublicText } from './maven-command.ts';
import { ModuleOperationLock } from './module-operation-lock.service.ts';

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  agentServiceUrl: 'http://127.0.0.1:18000',
  javaAnalyzerUrl: 'http://127.0.0.1:18080'
};

const METHOD_GENERATION_RECOVERY_POLL_INITIAL_MS = 1_000;
const METHOD_GENERATION_RECOVERY_POLL_MAX_MS = 10_000;
const METHOD_GENERATION_RECOVERY_FETCH_FAILURE_LIMIT = 3;
const METHOD_GENERATION_STREAM_HEARTBEAT_RECOVERY_LIMIT = 3;
const MAX_BACKEND_ERROR_TEXT_LENGTH = 4_096;
const DEFAULT_METHOD_ANALYSIS_RESPONSE_TIMEOUT_MS = 120_000;

export function methodGenerationRecoveryPollDelayMilliseconds(
  idlePollIndex: number,
  initialDelayMilliseconds = METHOD_GENERATION_RECOVERY_POLL_INITIAL_MS,
  maxDelayMilliseconds = METHOD_GENERATION_RECOVERY_POLL_MAX_MS
): number {
  if (!Number.isSafeInteger(idlePollIndex) || idlePollIndex < 0) {
    throw new TypeError('Generation recovery idle poll index must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(initialDelayMilliseconds) || initialDelayMilliseconds <= 0) {
    throw new TypeError('Generation recovery initial poll delay must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxDelayMilliseconds)
    || maxDelayMilliseconds < initialDelayMilliseconds) {
    throw new TypeError('Generation recovery maximum poll delay must cover the initial delay.');
  }
  return Math.min(
    maxDelayMilliseconds,
    initialDelayMilliseconds * (2 ** Math.min(idlePollIndex, 30))
  );
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RemoteAuthUser = Readonly<{
  id: string;
  tenantId: string;
  loginName: string;
  role: 'ADMIN' | 'USER';
  isAvailable: 0 | 1;
  lastLoginAt: string | null;
}>;

export type RemoteAdminUser = RemoteAuthUser & Readonly<{
  loginCount: number;
  taskExecutionCount: number;
  lastLoginIp: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type RemoteAuthSession = Readonly<{
  user: RemoteAuthUser;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}>;

export type RemoteCreateUserRequest = Readonly<{
  loginName: string;
  password: string;
  role: 'ADMIN' | 'USER';
  isAvailable: 0 | 1;
}>;

export type RemoteUpdateUserRequest = Readonly<{
  loginName?: string;
  password?: string;
  role?: 'ADMIN' | 'USER';
  isAvailable?: 0 | 1;
}>;

export class RemoteAuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(
    code: string,
    message: string,
    statusCode: number
  ) {
    super(message);
    this.name = 'RemoteAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type AiClientOptions = Readonly<{
  javaAnalyzerResponseTimeoutMilliseconds?: number;
}>;
type SensitiveLlmConfigs = BackendLlmConfig | readonly BackendLlmConfig[];

type JacocoArtifactEntry = {
  path: string;
  data: Buffer;
};

const REMOTE_JACOCO_MAX_FILE_BYTES = 32 * 1024 * 1024;
const REMOTE_JACOCO_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const REMOTE_ANALYSIS_MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const ZIP_CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < ZIP_CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  ZIP_CRC32_TABLE[index] = value >>> 0;
}

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = ZIP_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeZipStoreEntry(
  entry: JacocoArtifactEntry,
  localOffset: number
): { localParts: Buffer[]; centralPart: Buffer; written: number } {
  const name = Buffer.from(entry.path, 'utf8');
  const checksum = crc32(entry.data);
  const localHeader = Buffer.alloc(30 + name.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(entry.data.length, 18);
  localHeader.writeUInt32LE(entry.data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);
  name.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + name.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(entry.data.length, 20);
  centralHeader.writeUInt32LE(entry.data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(localOffset, 42);
  name.copy(centralHeader, 46);

  return {
    localParts: [localHeader, entry.data],
    centralPart: centralHeader,
    written: localHeader.length + entry.data.length
  };
}

function createStoredZip(entries: JacocoArtifactEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const item = writeZipStoreEntry(entry, offset);
    localParts.push(...item.localParts);
    centralParts.push(item.centralPart);
    offset += item.written;
  }
  const centralStart = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralSize, 12);
  endOfCentralDirectory.writeUInt32LE(centralStart, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory]);
}

function projectRelativePath(projectPath: string, absolutePath: string, label: string): string {
  const root = resolve(projectPath);
  const target = resolve(absolutePath);
  const relativePath = relative(root, target);
  if (
    !relativePath
    || relativePath.startsWith('..')
    || relativePath.includes(`..${sep}`)
    || /^[A-Za-z]:/.test(relativePath)
    || relativePath.startsWith(sep)
  ) {
    throw new Error(`${label} 必须位于项目目录内。`);
  }
  return relativePath.split(sep).join('/');
}

async function maybeReadArtifactFile(absolutePath: string, relativePath: string): Promise<JacocoArtifactEntry | null> {
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!metadata.isFile()) {
    return null;
  }
  if (metadata.size > REMOTE_JACOCO_MAX_FILE_BYTES) {
    throw new Error(`上传到 java-analyzer 的文件过大：${relativePath}`);
  }
  return { path: relativePath, data: await readFile(absolutePath) };
}

async function maybeStatArtifactPath(absolutePath: string): Promise<{
  isFile(): boolean;
  isDirectory(): boolean;
} | null> {
  try {
    return await stat(absolutePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
/**
 * 仅供 Electron 主进程使用的托管后端连接。Authorization 字段保存完整 Header，
 * 避免调用方重复拼接 Bearer，并确保 URL 与令牌始终来自同一次运行时快照。
 */
export type ManagedBackendAccess = Readonly<{
  agentServiceUrl: string;
  agentServiceAuthorizationHeader: string;
  javaAnalyzerUrl: string;
  javaAnalyzerAuthorizationHeader: string;
}>;

export type ManagedBackendAccessProvider = () => ManagedBackendAccess | null;
export type UserAccessTokenProvider = () => string | null;
export type UserAuthFailureHandler = (code: string) => void;

type ResolvedBackendRequest = Readonly<{
  baseUrl: string;
  authorizationHeader?: string;
  managedAccess?: ManagedBackendAccess;
}>;

type MethodGenerationStreamRecoveryCursor = Readonly<{
  sessionId: string;
  lastEventSequence: number;
}>;

type MethodGenerationWaveStreamRecoveryCursor = Readonly<{
  waveSessionId: string;
  lastEventSequence: number;
}>;

function isSseHeartbeatBlock(block: string): boolean {
  return block.split(/\r?\n/).some((line) => line.trim() === ': heartbeat');
}

export type UnitTestTargetClassification = Readonly<{
  targetClass: string;
  packageName: string;
  className: string;
  classKind: string;
  features: Readonly<{
    lombokAnnotations: string[];
    hasServiceAnnotation: boolean;
    hasDependencyInjectionAnnotations: boolean;
    dataClassName: boolean;
  }>;
}>;

export type DirectModelGenerationResult = Readonly<{
  result: string;
  provider: string;
  model: string;
  generationMode: 'deterministic_prompt' | null;
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }> | null;
}>;

type DirectModelGenerationStreamEvent =
  | Readonly<{
      phase: 'completed';
      response: DirectModelGenerationResult;
    }>
  | Readonly<{
      phase: 'failed';
      error: Readonly<{
        code: string;
        message: string;
        statusCode: number;
      }>;
    }>;

export const MANAGED_BACKEND_NOT_READY_ERROR = '本地服务尚未就绪，请稍候重试。';

export class BackendResponseTimeoutError extends Error {
  readonly code = 'BACKEND_RESPONSE_TIMEOUT';
  readonly backendName: 'Agent Service' | 'Java Analyzer';

  constructor(
    backendName: 'Agent Service' | 'Java Analyzer',
    options?: ErrorOptions
  ) {
    super(`${backendName} 响应等待时间过长，请稍后重试。`, options);
    this.name = 'BackendResponseTimeoutError';
    this.backendName = backendName;
  }
}

export function isJavaAnalyzerResponseTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; backendName?: unknown };
  return candidate.code === 'BACKEND_RESPONSE_TIMEOUT'
    && candidate.backendName === 'Java Analyzer';
}

function backendEndpoint(baseUrl: string, apiPath: string): URL {
  if (!apiPath.startsWith('/')) {
    throw new TypeError('Backend API path must start with /.');
  }
  const base = new URL(baseUrl);
  base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return new URL(apiPath.slice(1), base);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  const firstOctet = Number(normalized.split('.')[0]);
  return firstOctet === 127;
}

function assertRagUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('RAG 会话标识无效。');
  }
}

// 明文凭证仅允许发往 HTTPS 或本机回环地址，避免在局域网或公网中明文传输。
export function assertCredentialTransportSafe(finalBackendUrl: string, llmConfig: BackendLlmConfig): void {
  const hasCredential = Object.values(llmConfig.credentials).some((value) => value.trim().length > 0);
  if (!hasCredential) {
    return;
  }
  const url = new URL(finalBackendUrl);
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol !== 'http:') {
    throw new Error(`agent-service 仅允许 HTTP 或 HTTPS：${url.host}`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`远程 agent-service 必须使用 HTTPS：${url.host}`);
  }
}

function modelInvocationKey(config: BackendLlmConfig): string {
  const endpoint = config.baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  return [config.provider, endpoint, config.model.trim()].join('\u0000');
}

export class AiClient {
  private settings: BackendSettings = { ...DEFAULT_BACKEND_SETTINGS };
  private readonly fetchImpl: FetchLike;
  private readonly javaAnalyzerResponseTimeoutMilliseconds: number;
  private readonly modelInvocationLock = new ModuleOperationLock();
  private managedBackendAccessProvider: ManagedBackendAccessProvider | null = null;
  private userAccessTokenProvider: UserAccessTokenProvider | null = null;
  private userAuthFailureHandler: UserAuthFailureHandler | null = null;
  private readonly methodGenerationIdentities = new Map<
    string,
    MethodGenerationIdentity
  >();
  private readonly methodGenerationWaveIdentities = new Map<
    string,
    MethodGenerationWaveIdentity
  >();
  private readonly remoteAnalysisWorkspaces = new Map<string, string>();

  constructor(
    fetchImpl: FetchLike = globalThis.fetch,
    options: AiClientOptions = {}
  ) {
    this.fetchImpl = fetchImpl;
    const timeout = options.javaAnalyzerResponseTimeoutMilliseconds
      ?? DEFAULT_METHOD_ANALYSIS_RESPONSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new TypeError('Java Analyzer response timeout must be a positive integer.');
    }
    this.javaAnalyzerResponseTimeoutMilliseconds = timeout;
  }

  private runModelInvocation<T>(
    modelContext: MethodGenerationModelContext,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.modelInvocationLock.runExclusive(
      modelInvocationKey(modelContext.llmConfig),
      operation,
      signal
    );
  }

  setBackendSettings(settings: BackendSettings): void {
    this.settings = {
      agentServiceUrl: settings.agentServiceUrl.trim() || DEFAULT_BACKEND_SETTINGS.agentServiceUrl,
      javaAnalyzerUrl: settings.javaAnalyzerUrl.trim() || DEFAULT_BACKEND_SETTINGS.javaAnalyzerUrl
    };
  }

  setManagedBackendAccessProvider(provider: ManagedBackendAccessProvider): void {
    if (typeof provider !== 'function') {
      throw new TypeError('托管后端访问提供器必须是函数。');
    }
    this.managedBackendAccessProvider = provider;
  }

  getBackendSettings(): BackendSettings {
    return { ...this.settings };
  }

  getUserAuthenticationEndpoint(): string {
    return process.env.AI_BACKEND_URL || this.settings.agentServiceUrl;
  }

  setUserAccessTokenProvider(provider: UserAccessTokenProvider): void {
    if (typeof provider !== 'function') {
      throw new TypeError('用户访问令牌提供器必须是函数。');
    }
    this.userAccessTokenProvider = provider;
  }

  setUserAuthFailureHandler(handler: UserAuthFailureHandler): void {
    if (typeof handler !== 'function') throw new TypeError('用户认证失败处理器必须是函数。');
    this.userAuthFailureHandler = handler;
  }

  async loginUser(loginName: string, password: string): Promise<RemoteAuthSession> {
    return this.authRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginName, password })
    }, false);
  }

  async refreshUserSession(refreshToken: string): Promise<RemoteAuthSession> {
    return this.authRequest('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    }, false);
  }

  async logoutUser(refreshToken: string): Promise<void> {
    await this.authRequest('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    }, false, true);
  }

  async currentUser(): Promise<RemoteAuthUser> {
    return this.authRequest('/api/auth/session', { method: 'GET' }, true);
  }

  async recordTaskExecution(): Promise<number> {
    const result = await this.authRequest<{ taskExecutionCount: number }>(
      '/api/auth/task-executions', { method: 'POST' }, true
    );
    return result.taskExecutionCount;
  }

  async listUsers(): Promise<RemoteAdminUser[]> {
    const page = await this.authRequest<{ items: RemoteAdminUser[] }>(
      '/api/admin/users', { method: 'GET' }, true
    );
    return page.items;
  }

  async createUser(request: RemoteCreateUserRequest): Promise<RemoteAdminUser> {
    return this.authRequest('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(request)
    }, true);
  }

  async updateUser(id: string, request: RemoteUpdateUserRequest): Promise<RemoteAdminUser> {
    return this.authRequest(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(request)
    }, true);
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.authRequest<{ deleted: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      true
    );
    return result.deleted === true;
  }

  async isJavaAnalyzerHealthy(signal?: AbortSignal): Promise<boolean> {
    const backend = this.resolveBackendRequest('java-analyzer');
    const authorizationHeader = backend.managedAccess ? backend.authorizationHeader : undefined;
    if (authorizationHeader) {
      this.assertBackendAuthorizationTransportSafe(backend);
    }
    try {
      const response = await this.fetchWithRedaction(
        backendEndpoint(backend.baseUrl, '/api/health'),
        {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: authorizationHeader
            ? { Authorization: authorizationHeader }
            : {}
        },
        undefined,
        backend.managedAccess
      );
      await response.text();
      return response.ok;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
  }

  async classifyUnitTestTarget(
    projectPath: string,
    targetClass: string,
    signal?: AbortSignal
  ): Promise<UnitTestTargetClassification> {
    if (!projectPath.trim() || !targetClass.trim()) {
      throw new TypeError('目标类分类参数无效。');
    }
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const response = await this.fetchWithRedaction(
      backendEndpoint(backend.baseUrl, '/api/analyze/classify-target'),
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(backend.authorizationHeader
            ? { Authorization: backend.authorizationHeader }
            : {})
        },
        body: JSON.stringify({
          projectPath,
          targetClass,
          targetMethod: null
        })
      },
      undefined,
      backend.managedAccess
    );
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(response, backend.managedAccess);
    }
    return decodeUnitTestTargetClassification(await this.readJsonResponse(
      response,
      undefined,
      backend.managedAccess
    ), targetClass);
  }

  async generateUnitTestPrompt(
    prompt: string,
    modelContext: MethodGenerationModelContext,
    signal?: AbortSignal
  ): Promise<DirectModelGenerationResult> {
    return this.runModelInvocation(modelContext, signal, async () => {
      if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 4 * 1024 * 1024) {
        throw new TypeError('批量测试生成提示词为空或过大。');
      }
      const backend = this.resolveBackendRequest('agent-service');
      this.assertBackendAuthorizationTransportSafe(backend);
      assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
      const response = await this.fetchWithRedaction(
        backendEndpoint(backend.baseUrl, '/api/unit-tests/generate/stream'),
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(backend.authorizationHeader
              ? { Authorization: backend.authorizationHeader }
              : {})
          },
          body: JSON.stringify({
            prompt,
            llmConfig: modelContext.llmConfig
          })
        },
        modelContext.llmConfig,
        backend.managedAccess
      );
      if (!response.ok) {
        throw await this.directGenerationHttpError(
          response,
          modelContext.llmConfig,
          backend.managedAccess
        );
      }
      return this.consumeDirectModelGenerationStream(
        response,
        modelContext.llmConfig,
        backend.managedAccess,
        signal
      );
    });
  }

  async probeModelToolCalling(
    modelContext: MethodGenerationModelContext,
    captureModelCalls: boolean,
    signal?: AbortSignal
  ): Promise<ModelToolCallingProbeResponse> {
    return this.runModelInvocation(modelContext, signal, async () => {
      if (typeof captureModelCalls !== 'boolean') {
        throw new TypeError('模型工具调用能力检测参数无效。');
      }
      const backend = this.resolveBackendRequest('agent-service');
      this.assertBackendAuthorizationTransportSafe(backend);
      assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
      const response = await this.fetchWithRedaction(
        backendEndpoint(backend.baseUrl, '/api/model-capabilities/tool-calling/probe'),
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(backend.authorizationHeader
              ? { Authorization: backend.authorizationHeader }
              : {})
          },
          body: JSON.stringify({
            llmConfig: modelContext.llmConfig,
            captureModelCalls
          })
        },
        modelContext.llmConfig,
        backend.managedAccess
      );
      if (!response.ok) {
        throw await this.modelToolCapabilityHttpError(
          response,
          modelContext.llmConfig,
          backend.managedAccess
        );
      }
      return decodeModelToolCallingProbeResponse(
        await this.readJsonResponse(
          response,
          modelContext.llmConfig,
          backend.managedAccess
        ),
        captureModelCalls
      );
    });
  }

  async globalKnowledge(request: Record<string, unknown>, embeddingConfig?: BackendLlmConfig, signal?: AbortSignal): Promise<unknown> {
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    if (embeddingConfig) assertCredentialTransportSafe(backend.baseUrl, embeddingConfig);
    const response = await this.fetchWithRedaction(backendEndpoint(backend.baseUrl, '/api/rag/global/knowledge'), {
      method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json',
        ...(backend.authorizationHeader ? { Authorization: backend.authorizationHeader } : {}) },
      body: JSON.stringify({ ...request, ...(embeddingConfig ? { ragEmbeddingConfig: embeddingConfig } : {}) })
    }, embeddingConfig, backend.managedAccess);
    if (!response.ok) throw new Error(`全局知识库操作失败：${response.status}`);
    return this.readJsonResponse(response, undefined, backend.managedAccess);
  }
  async releaseRagTaskRun(
    taskRunId: string,
    signal?: AbortSignal
  ): Promise<void> {
    assertRagUuid(taskRunId);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const response = await this.fetchWithRedaction(
      backendEndpoint(backend.baseUrl, `/api/rag/task-runs/${encodeURIComponent(taskRunId)}/release`),
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          ...(backend.authorizationHeader
            ? { Authorization: backend.authorizationHeader }
            : {})
        },
      },
      undefined,
      backend.managedAccess
    );
    if (!response.ok) {
      throw new Error(`RAG 任务授权释放失败：${response.status}`);
    }
    await response.text();
  }

  async createRagSourceSnapshotSession(
    request: CreateRagSourceSnapshotSessionRequest,
    signal?: AbortSignal
  ): Promise<CreateRagSourceSnapshotSessionResponse> {
    const validated = validateCreateRagSourceSnapshotSessionRequest(request);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const response = await this.fetchWithRedaction(
      backendEndpoint(backend.baseUrl, '/api/rag/source-snapshot-sessions'),
      {
        method: 'POST', redirect: 'error', signal,
        headers: {
          ...(backend.authorizationHeader ? { Authorization: backend.authorizationHeader } : {})
        },
      },
      undefined,
      backend.managedAccess
    );
    if (!response.ok) throw new Error(`RAG 源码快照创建失败：${response.status}`);
    return decodeCreateRagSourceSnapshotSessionResponse(
      await this.readJsonResponse(response, undefined, backend.managedAccess),
      { requestedSourceSetFingerprint: validated.requestedSourceSetFingerprint }
    );
  }

  async resolveRagSourceSet(
    analysisSessionId: string,
    request: ResolveRagSourceSetRequest,
    signal?: AbortSignal
  ): Promise<ResolveRagSourceSetResponse> {
    this.assertAnalysisSessionId(analysisSessionId);
    const validated = validateResolveRagSourceSetRequest(request);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(analysisSessionId)}/rag-source-set`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(validated)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(response, backend.managedAccess);
    }
    return decodeResolveRagSourceSetResponse(
      await this.readJsonResponse(response, undefined, backend.managedAccess)
    );
  }

  async getRagSourceSnapshotPage(
    sessionId: string,
    pageIndex: number,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<RagSourceSnapshotPage> {
    assertRagUuid(sessionId);
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new TypeError('RAG 源码快照页参数无效。');
    }
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/rag/source-snapshot-sessions/${encodeURIComponent(sessionId)}/pages/${pageIndex}`);
    endpoint.searchParams.set('pageSize', String(pageSize));
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'GET', redirect: 'error', signal,
      headers: backend.authorizationHeader ? { Authorization: backend.authorizationHeader } : {}
    }, undefined, backend.managedAccess);
    if (!response.ok) throw new Error(`RAG 源码快照页读取失败：${response.status}`);
    return decodeRagSourceSnapshotPageResponse(
      await this.readJsonResponse(response, undefined, backend.managedAccess),
      { sessionId, pageIndex, pageSize }
    );
  }

  async cancelRagSourceSnapshotSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    assertRagUuid(sessionId);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const response = await this.fetchWithRedaction(
      backendEndpoint(backend.baseUrl, `/api/rag/source-snapshot-sessions/${encodeURIComponent(sessionId)}`),
      {
        method: 'DELETE', redirect: 'error', signal,
        headers: backend.authorizationHeader ? { Authorization: backend.authorizationHeader } : {}
      },
      undefined,
      backend.managedAccess
    );
    if (!response.ok) throw new Error(`RAG 源码快照取消失败：${response.status}`);
  }

  async createMethodAnalysisSession(
    request: CreateMethodAnalysisSessionRequest,
    signal?: AbortSignal
  ): Promise<CreateMethodAnalysisSessionResponse> {
    if (
      !ANALYSIS_SESSION_ID_PATTERN.test(request.analysisSessionId)
      || !REPORT_PAIR_ID_PATTERN.test(request.reportPairId)
    ) {
      throw new Error(METHOD_ANALYSIS_RESPONSE_INVALID);
    }
    const payload: CreateMethodAnalysisSessionRequest = {
      analysisSessionId: request.analysisSessionId,
      workspaceRoot: request.workspaceRoot,
      moduleRoot: request.moduleRoot,
      targetSourcePath: request.targetSourcePath,
      targetClass: request.targetClass,
      plannedTestClassName: request.plannedTestClassName,
      plannedRelativeTestPath: request.plannedRelativeTestPath,
      reportPath: request.reportPath,
      branchSnapshotPath: request.branchSnapshotPath,
      reportPairId: request.reportPairId,
      sourceRoots: request.sourceRoots,
      classpathEntries: request.classpathEntries,
      javaHome: request.javaHome,
      jdkMajorVersion: request.jdkMajorVersion,
      buildContextFingerprint: request.buildContextFingerprint
    };
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);

    const analyzerUrl = new URL(backend.baseUrl);
    if (!isLoopbackHostname(analyzerUrl.hostname)) {
      return this.createMethodAnalysisSessionFromArtifacts(payload, backend, signal);
    }

    return this.createMethodAnalysisSessionFromLocalPaths(payload, backend, signal);
  }

  private async createMethodAnalysisSessionFromLocalPaths(
    payload: CreateMethodAnalysisSessionRequest,
    backend: ResolvedBackendRequest,
    signal?: AbortSignal
  ): Promise<CreateMethodAnalysisSessionResponse> {
    const endpoint = backendEndpoint(backend.baseUrl, '/api/generation-analysis/sessions');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(payload)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(response, backend.managedAccess);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeCreateMethodAnalysisSessionResponse(value, payload);
  }

  private async createMethodAnalysisSessionFromArtifacts(
    payload: CreateMethodAnalysisSessionRequest,
    backend: ResolvedBackendRequest,
    signal?: AbortSignal
  ): Promise<CreateMethodAnalysisSessionResponse> {
    const manifest = await this.createMethodAnalysisArtifactManifest(payload);
    const bundle = await this.createMethodAnalysisArtifactBundle(payload, manifest);
    const formData = new FormData();
    formData.append(
      'request',
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
      'request.json'
    );
    formData.append(
      'bundle',
      new Blob([new Uint8Array(bundle)], { type: 'application/zip' }),
      'method-analysis-artifacts.zip'
    );

    const endpoint = backendEndpoint(backend.baseUrl, '/api/generation-analysis/sessions/artifacts');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: formData
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(response, backend.managedAccess);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    const result = decodeCreateMethodAnalysisSessionResponse(value, payload);
    this.remoteAnalysisWorkspaces.set(result.analysisSessionId, payload.workspaceRoot);
    return result;
  }

  private async createMethodAnalysisArtifactManifest(
    payload: CreateMethodAnalysisSessionRequest
  ): Promise<{
    analysisSessionId: string;
    moduleRelativePath: string;
    targetSourceRelativePath: string;
    targetClass: string;
    plannedTestClassName: string;
    plannedRelativeTestPath: string;
    reportRelativePath: string;
    branchSnapshotRelativePath: string;
    reportPairId: string;
    sourceRootRelativePaths: string[];
    classpathEntryRelativePaths: string[];
    jdkMajorVersion: number;
    buildContextFingerprint: string;
  }> {
    const classpathEntryRelativePaths: string[] = [];
    for (const entry of payload.classpathEntries) {
      const relativePath = this.optionalProjectRelativePath(payload.workspaceRoot, entry);
      if (!relativePath) continue;
      const metadata = await maybeStatArtifactPath(entry);
      if (!metadata || !metadata.isDirectory() && !metadata.isFile()) continue;
      classpathEntryRelativePaths.push(relativePath);
    }
    if (classpathEntryRelativePaths.length < 1) {
      throw new Error('远程 Java Analyzer 分析缺少可上传的项目 classpath 目录。');
    }
    const sourceRootRelativePaths: string[] = [];
    const seenSourceRoots = new Set<string>();
    for (const sourceRoot of payload.sourceRoots) {
      const relativePath = this.optionalProjectRelativePath(payload.workspaceRoot, sourceRoot);
      if (!relativePath || seenSourceRoots.has(relativePath)) continue;
      if (!await this.directoryContainsJavaSource(sourceRoot)) continue;
      sourceRootRelativePaths.push(relativePath);
      seenSourceRoots.add(relativePath);
    }
    if (sourceRootRelativePaths.length < 1) {
      throw new Error('远程 Java Analyzer 分析缺少可上传的源码根目录。');
    }
    return {
      analysisSessionId: payload.analysisSessionId,
      moduleRelativePath: projectRelativePath(
        payload.workspaceRoot,
        payload.moduleRoot,
        '目标模块'
      ),
      targetSourceRelativePath: projectRelativePath(
        payload.workspaceRoot,
        payload.targetSourcePath,
        '目标源码文件'
      ),
      targetClass: payload.targetClass,
      plannedTestClassName: payload.plannedTestClassName,
      plannedRelativeTestPath: payload.plannedRelativeTestPath,
      reportRelativePath: projectRelativePath(
        payload.workspaceRoot,
        payload.reportPath,
        'JaCoCo XML 报告'
      ),
      branchSnapshotRelativePath: projectRelativePath(
        payload.workspaceRoot,
        payload.branchSnapshotPath,
        'JaCoCo 分支快照'
      ),
      reportPairId: payload.reportPairId,
      sourceRootRelativePaths,
      classpathEntryRelativePaths,
      jdkMajorVersion: payload.jdkMajorVersion,
      buildContextFingerprint: payload.buildContextFingerprint
    };
  }

  private optionalProjectRelativePath(projectPath: string, absolutePath: string): string | null {
    try {
      return projectRelativePath(projectPath, absolutePath, 'classpath 条目');
    } catch {
      return null;
    }
  }

  private async directoryContainsJavaSource(absoluteDirectory: string): Promise<boolean> {
    const metadata = await maybeStatArtifactPath(absoluteDirectory);
    if (!metadata?.isDirectory()) return false;

    const pending = [absoluteDirectory];
    while (pending.length > 0) {
      const current = pending.pop()!;
      let children: { isDirectory(): boolean; isFile(): boolean; name: string }[];
      try {
        children = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      for (const child of children) {
        if (child.isFile() && child.name.endsWith('.java')) {
          return true;
        }
        if (child.isDirectory()) {
          pending.push(resolve(current, child.name));
        }
      }
    }
    return false;
  }

  private async createMethodAnalysisArtifactBundle(
    payload: CreateMethodAnalysisSessionRequest,
    manifest: {
      targetSourceRelativePath: string;
      reportRelativePath: string;
      branchSnapshotRelativePath: string;
      sourceRootRelativePaths: string[];
      classpathEntryRelativePaths: string[];
    }
  ): Promise<Buffer> {
    const entries: JacocoArtifactEntry[] = [];
    const seen = new Set<string>();
    const addEntry = async (
      absolutePath: string,
      relativePath: string,
      required: boolean
    ): Promise<void> => {
      const normalizedRelativePath = relativePath.replace(/\\/g, '/');
      if (seen.has(normalizedRelativePath)) return;
      const entry = await maybeReadArtifactFile(absolutePath, normalizedRelativePath);
      if (!entry) {
        if (required) throw new Error(`远程 Java Analyzer 分析缺少必要文件：${normalizedRelativePath}`);
        return;
      }
      entries.push(entry);
      seen.add(normalizedRelativePath);
    };
    const addDirectory = async (
      absoluteDirectory: string,
      relativeDirectory: string,
      filter: (absolutePath: string, name: string) => boolean = () => true
    ): Promise<void> => {
      const pending: Array<{ absolute: string; relative: string }> = [{
        absolute: absoluteDirectory,
        relative: relativeDirectory.replace(/\\/g, '/')
      }];
      while (pending.length > 0) {
        const current = pending.pop()!;
        let children: { isDirectory(): boolean; isFile(): boolean; name: string }[];
        try {
          children = await readdir(current.absolute, { withFileTypes: true });
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            continue;
          }
          throw error;
        }
        for (const child of children) {
          const absolute = resolve(current.absolute, child.name);
          const relativePath = `${current.relative}/${child.name}`.replace(/\\/g, '/');
          if (child.isDirectory()) {
            pending.push({ absolute, relative: relativePath });
          } else if (child.isFile() && filter(absolute, child.name)) {
            await addEntry(absolute, relativePath, false);
          }
        }
      }
    };

    await addEntry(payload.targetSourcePath, manifest.targetSourceRelativePath, true);
    await addEntry(payload.reportPath, manifest.reportRelativePath, true);
    await addEntry(payload.branchSnapshotPath, manifest.branchSnapshotRelativePath, true);

    for (const relativeSourceRoot of manifest.sourceRootRelativePaths) {
      const sourceRoot = resolve(payload.workspaceRoot, ...relativeSourceRoot.split('/'));
      const metadata = await maybeStatArtifactPath(sourceRoot);
      if (metadata?.isDirectory()) {
        await addDirectory(sourceRoot, relativeSourceRoot, (_absolute, name) => name.endsWith('.java'));
      }
    }

    for (let index = 0; index < manifest.classpathEntryRelativePaths.length; index += 1) {
      const relativeClasspath = manifest.classpathEntryRelativePaths[index];
      const absoluteClasspath = resolve(payload.workspaceRoot, ...relativeClasspath.split('/'));
      const metadata = await maybeStatArtifactPath(absoluteClasspath);
      if (metadata?.isDirectory()) {
        await addDirectory(absoluteClasspath, relativeClasspath);
      } else if (metadata?.isFile()) {
        await addEntry(absoluteClasspath, relativeClasspath, false);
      }
    }

    const bundle = createStoredZip(entries);
    if (bundle.length > REMOTE_ANALYSIS_MAX_BUNDLE_BYTES) {
      throw new Error('上传到 java-analyzer 的方法分析文件包超过 128MB。');
    }
    return bundle;
  }

  async getMethodCatalog(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<MethodCatalogResponse> {
    this.assertAnalysisSessionId(sessionId);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}/methods`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: backend.authorizationHeader
        ? { Authorization: backend.authorizationHeader }
        : {}
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw new Error(`读取单方法目录失败：${response.status}`);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeMethodCatalogResponse(value, sessionId);
  }

  async heartbeatMethodAnalysisSession(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.assertAnalysisSessionId(sessionId);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}/heartbeat`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: backend.authorizationHeader
        ? { Authorization: backend.authorizationHeader }
        : {}
    }, undefined, backend.managedAccess);
    if (response.status === 404) {
      await response.text();
      return false;
    }
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(
        response,
        backend.managedAccess,
        '检查单方法分析会话失败'
      );
    }
    await response.text();
    return true;
  }

  async deleteMethodAnalysisSession(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertAnalysisSessionId(sessionId);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'DELETE',
      redirect: 'error',
      signal,
      headers: backend.authorizationHeader
        ? { Authorization: backend.authorizationHeader }
        : {}
    }, undefined, backend.managedAccess);
    await response.text();
    this.remoteAnalysisWorkspaces.delete(sessionId);
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`释放单方法分析会话失败：${response.status}`);
    }
  }

  async nextMethodBatch(
    sessionId: string,
    methodId: string,
    request: SingleMethodBatchRequest,
    signal?: AbortSignal
  ): Promise<SingleMethodBatchResponse> {
    this.assertAnalysisSessionId(sessionId);
    if (!METHOD_ID_PATTERN.test(methodId)) {
      throw new Error(METHOD_ANALYSIS_RESPONSE_INVALID);
    }
    validateSingleMethodBatchRequest(request);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(
      backend.baseUrl,
      `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}`
        + `/methods/${encodeURIComponent(methodId)}/next-batch`
    );
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(request)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw new Error(`读取单方法测试计划失败：${response.status}`);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeSingleMethodBatchResponse(value, {
      sessionId,
      methodId,
      reportPairId: request.reportPairId,
      maxTestMethods: request.maxTestMethods
    });
  }

  async nextMethodWave(
    sessionId: string,
    methodId: string,
    request: SingleMethodWaveRequest,
    signal?: AbortSignal
  ): Promise<SingleMethodWaveResponse> {
    this.assertAnalysisSessionId(sessionId);
    if (!METHOD_ID_PATTERN.test(methodId)) {
      throw new Error(METHOD_ANALYSIS_RESPONSE_INVALID);
    }
    validateSingleMethodWaveRequest(request);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(
      backend.baseUrl,
      `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}`
        + `/methods/${encodeURIComponent(methodId)}/next-wave`
    );
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(request)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw new Error(`读取单方法场景 Wave 失败：${response.status}`);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeSingleMethodWaveResponse(value, {
      sessionId,
      methodId,
      reportPairId: request.reportPairId
    });
  }

  async nextClassScenarioWave(
    sessionId: string,
    request: ClassScenarioWaveRequest,
    signal?: AbortSignal
  ): Promise<ClassScenarioWaveResponse> {
    this.assertAnalysisSessionId(sessionId);
    validateClassScenarioWaveRequest(request);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}/next-class-wave`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(request)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(
        response,
        backend.managedAccess,
        '读取类级场景 Wave 失败'
      );
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeClassScenarioWaveResponse(value, {
      sessionId,
      reportPairId: request.reportPairId,
      methodIds: request.methods.map((method) => method.methodId)
    });
  }

  async refreshMethodAnalysisCoverage(
    sessionId: string,
    request: RefreshMethodAnalysisCoverageRequest,
    signal?: AbortSignal
  ): Promise<RefreshMethodAnalysisCoverageResponse> {
    this.assertAnalysisSessionId(sessionId);
    if (
      !request.reportPath
      || !request.branchSnapshotPath
      || !REPORT_PAIR_ID_PATTERN.test(request.reportPairId)
    ) {
      throw new Error(METHOD_ANALYSIS_RESPONSE_INVALID);
    }
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const analyzerUrl = new URL(backend.baseUrl);
    if (!isLoopbackHostname(analyzerUrl.hostname)) {
      return this.refreshMethodAnalysisCoverageFromArtifacts(
        sessionId,
        request,
        backend,
        signal
      );
    }

    return this.refreshMethodAnalysisCoverageFromLocalPaths(
      sessionId,
      request,
      backend,
      signal
    );
  }

  private async refreshMethodAnalysisCoverageFromLocalPaths(
    sessionId: string,
    request: RefreshMethodAnalysisCoverageRequest,
    backend: ResolvedBackendRequest,
    signal?: AbortSignal
  ): Promise<RefreshMethodAnalysisCoverageResponse> {
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}/refresh-coverage`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(request)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(
        response,
        backend.managedAccess,
        '刷新单方法覆盖率失败'
      );
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeRefreshMethodAnalysisCoverageResponse(
      value,
      sessionId,
      request.reportPairId
    );
  }

  private async refreshMethodAnalysisCoverageFromArtifacts(
    sessionId: string,
    request: RefreshMethodAnalysisCoverageRequest,
    backend: ResolvedBackendRequest,
    signal?: AbortSignal
  ): Promise<RefreshMethodAnalysisCoverageResponse> {
    const workspaceRoot = this.remoteAnalysisWorkspaces.get(sessionId);
    if (!workspaceRoot) {
      throw new Error('远程 Java Analyzer 覆盖率刷新缺少本地工作区映射。');
    }
    const manifest = {
      reportRelativePath: projectRelativePath(
        workspaceRoot,
        request.reportPath,
        'JaCoCo XML 报告'
      ),
      branchSnapshotRelativePath: projectRelativePath(
        workspaceRoot,
        request.branchSnapshotPath,
        'JaCoCo 分支快照'
      ),
      reportPairId: request.reportPairId
    };
    const bundle = await this.createRefreshCoverageArtifactBundle(request, manifest);
    const formData = new FormData();
    formData.append(
      'request',
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
      'request.json'
    );
    formData.append(
      'bundle',
      new Blob([new Uint8Array(bundle)], { type: 'application/zip' }),
      'coverage-artifacts.zip'
    );

    const endpoint = backendEndpoint(
      backend.baseUrl,
      `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}/refresh-coverage/artifacts`
    );
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: formData
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(
        response,
        backend.managedAccess,
        '刷新单方法覆盖率失败'
      );
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeRefreshMethodAnalysisCoverageResponse(
      value,
      sessionId,
      request.reportPairId
    );
  }

  private async createRefreshCoverageArtifactBundle(
    request: RefreshMethodAnalysisCoverageRequest,
    manifest: {
      reportRelativePath: string;
      branchSnapshotRelativePath: string;
    }
  ): Promise<Buffer> {
    const entries: JacocoArtifactEntry[] = [];
    const addEntry = async (
      absolutePath: string,
      relativePath: string
    ): Promise<void> => {
      const entry = await maybeReadArtifactFile(absolutePath, relativePath);
      if (!entry) {
        throw new Error(`刷新远程覆盖率缺少必要文件：${relativePath}`);
      }
      entries.push(entry);
    };
    await addEntry(request.reportPath, manifest.reportRelativePath);
    await addEntry(request.branchSnapshotPath, manifest.branchSnapshotRelativePath);
    const bundle = createStoredZip(entries);
    if (bundle.length > REMOTE_ANALYSIS_MAX_BUNDLE_BYTES) {
      throw new Error('上传到 java-analyzer 的覆盖率文件包超过 128MB。');
    }
    return bundle;
  }

  async getMethodRepairContext(
    sessionId: string,
    request: MethodRepairContextRequest,
    signal?: AbortSignal
  ): Promise<MethodRepairContextResponse> {
    this.assertAnalysisSessionId(sessionId);
    const payload = validateMethodRepairContextRequest(request);
    const backend = this.resolveBackendRequest('java-analyzer');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/generation-analysis/sessions/${encodeURIComponent(sessionId)}/repair-context`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(payload)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodAnalysisHttpError(response, backend.managedAccess);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeMethodRepairContextResponse(value, {
      reportPairId: payload.reportPairId
    });
  }

  async startMethodGenerationStream(
    request: StartMethodGenerationSessionRequest,
    modelContext: MethodGenerationModelContext,
    onProgress: MethodGenerationProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationTurnResult> {
    const identity = validateStartMethodGenerationRequest(request);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
    const endpoint = backendEndpoint(backend.baseUrl, '/api/unit-tests/method-generation-sessions/start/stream');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify({ ...request, llmConfig: modelContext.llmConfig })
    }, modelContext.llmConfig, backend.managedAccess);
    try {
      return await this.consumeMethodGenerationStream(
        response,
        modelContext,
        backend,
        onProgress,
        signal,
        undefined,
        identity
      );
    } catch (error) {
      return this.recoverInterruptedMethodGeneration(error, onProgress, signal);
    }
  }

  async recoverMethodGenerationStream(
    request: RecoverMethodGenerationSessionRequest,
    modelContext: MethodGenerationModelContext,
    onProgress: MethodGenerationProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationTurnResult> {
    const identity = validateRecoverMethodGenerationRequest(request);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
    const endpoint = backendEndpoint(backend.baseUrl, '/api/unit-tests/method-generation-sessions/recover/stream');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify({
        recoveryRequestId: request.startRequest.clientRequestId,
        startRequest: {
          ...request.startRequest,
          llmConfig: modelContext.llmConfig
        },
        candidate: request.candidate
      })
    }, modelContext.llmConfig, backend.managedAccess);
    try {
      return await this.consumeMethodGenerationStream(
        response,
        modelContext,
        backend,
        onProgress,
        signal,
        undefined,
        identity
      );
    } catch (error) {
      return this.recoverInterruptedMethodGeneration(error, onProgress, signal);
    }
  }

  async prepareRagRepair(
    sessionId: string,
    request: PrepareRagRepairRequest,
    signal?: AbortSignal
  ): Promise<PrepareRagRepairResponse> {
    this.assertMethodGenerationSessionId(sessionId);
    const identity = this.methodGenerationIdentities.get(sessionId);
    const validated = validatePrepareRagRepairRequest(request);
    if (
      identity?.ragEnabled !== true
      || identity.methodId !== validated.methodId
      || identity.batchId !== validated.batchId
      || identity.batchIndex !== undefined
        && identity.batchIndex !== validated.batchIndex
    ) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(
      backend.baseUrl,
      `/api/unit-tests/method-generation-sessions/${encodeURIComponent(sessionId)}`
        + '/rag-repair/prepare'
    );
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify(validated)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      throw await this.methodGenerationHttpError(
        response,
        undefined,
        backend.managedAccess,
        `准备 RAG 修复诊断失败：${response.status}`
      );
    }
    return decodePrepareRagRepairResponse(await this.readJsonResponse(
      response,
      undefined,
      backend.managedAccess
    ));
  }

  async resumeMethodGenerationStream(
    sessionId: string,
    request: ResumeMethodGenerationSessionRequest,
    modelContext: MethodGenerationModelContext,
    onProgress: MethodGenerationProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationTurnResult> {
    this.assertMethodGenerationSessionId(sessionId);
    validateResumeMethodGenerationRequest(
      request,
      this.methodGenerationIdentities.get(sessionId)
    );
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
    if (request.ragEmbeddingConfig) {
      assertCredentialTransportSafe(backend.baseUrl, request.ragEmbeddingConfig);
    }
    const sensitiveConfigs: readonly BackendLlmConfig[] = request.ragEmbeddingConfig
      ? [modelContext.llmConfig, request.ragEmbeddingConfig]
      : [modelContext.llmConfig];
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-sessions/${encodeURIComponent(sessionId)}/resume/stream`);
    let response: Response;
    try {
      response = await this.fetchWithRedaction(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(backend.authorizationHeader
            ? { Authorization: backend.authorizationHeader }
            : {})
        },
        body: JSON.stringify({ ...request, llmConfig: modelContext.llmConfig })
      }, sensitiveConfigs, backend.managedAccess);
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.recoverInterruptedMethodGeneration(
        new MethodGenerationStreamInterruptedError(
          sessionId,
          request.expectedEventSequence
        ),
        onProgress,
        signal
      );
    }
    try {
      return await this.consumeMethodGenerationStream(
        response,
        modelContext,
        backend,
        onProgress,
        signal,
        { sessionId, lastEventSequence: request.expectedEventSequence },
        this.methodGenerationIdentities.get(sessionId),
        request.ragEmbeddingConfig
      );
    } catch (error) {
      return this.recoverInterruptedMethodGeneration(error, onProgress, signal);
    }
  }

  async getMethodGenerationStatus(
    sessionId: string,
    afterEventSequence: number,
    signal?: AbortSignal
  ): Promise<MethodGenerationSessionStatus> {
    this.assertMethodGenerationSessionId(sessionId);
    if (!Number.isSafeInteger(afterEventSequence) || afterEventSequence < 0) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-sessions/${encodeURIComponent(sessionId)}`);
    endpoint.searchParams.set('afterEventSequence', String(afterEventSequence));
    return this.withIsolatedRequestAbortSignal(signal, async (requestSignal) => {
      const response = await this.fetchWithRedaction(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: requestSignal,
        headers: backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {}
      }, undefined, backend.managedAccess);
      if (response.status === 404 || response.status === 410) {
        this.methodGenerationIdentities.delete(sessionId);
        throw new MethodGenerationSessionNotFoundError(sessionId);
      }
      if (!response.ok) {
        throw new Error(`读取单方法生成状态失败：${response.status}`);
      }
      const value = await this.readJsonResponse<unknown>(
        response,
        undefined,
        backend.managedAccess
      );
      const status = decodeMethodGenerationStatus(
        value,
        sessionId,
        afterEventSequence,
        this.methodGenerationIdentities.get(sessionId)
      );
      this.rememberMethodGenerationIdentityFromStatus(status);
      if (status.phase === 'completed' || status.phase === 'failed'
        || status.phase === 'cancelled') {
        this.methodGenerationIdentities.delete(sessionId);
      }
      return status;
    });
  }

  async acknowledgeMethodGenerationEvents(
    sessionId: string,
    throughEventSequence: number,
    signal?: AbortSignal
  ): Promise<MethodGenerationEventsAcknowledgement> {
    this.assertMethodGenerationSessionId(sessionId);
    if (!Number.isSafeInteger(throughEventSequence) || throughEventSequence < 0) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-sessions/${encodeURIComponent(sessionId)}/ack`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify({ throughEventSequence })
    }, undefined, backend.managedAccess);
    if (response.status === 404 || response.status === 410) {
      this.methodGenerationIdentities.delete(sessionId);
      throw new MethodGenerationSessionNotFoundError(sessionId);
    }
    if (!response.ok) {
      throw new Error(`确认单方法生成事件失败：${response.status}`);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    return decodeMethodGenerationAcknowledgement(
      value,
      sessionId,
      throughEventSequence
    );
  }

  async cancelMethodGeneration(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<MethodGenerationSessionStatus> {
    this.assertMethodGenerationSessionId(sessionId);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-sessions/${encodeURIComponent(sessionId)}`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'DELETE',
      redirect: 'error',
      signal,
      headers: backend.authorizationHeader
        ? { Authorization: backend.authorizationHeader }
        : {}
    }, undefined, backend.managedAccess);
    if (response.status === 404 || response.status === 410) {
      this.methodGenerationIdentities.delete(sessionId);
      throw new MethodGenerationSessionNotFoundError(sessionId);
    }
    if (!response.ok) {
      throw new Error(`终止单方法生成失败：${response.status}`);
    }
    const value = await this.readJsonResponse<unknown>(
      response,
      undefined,
      backend.managedAccess
    );
    const status = decodeMethodGenerationStatus(
      value,
      sessionId,
      0,
      this.methodGenerationIdentities.get(sessionId)
    );
    this.methodGenerationIdentities.delete(sessionId);
    return status;
  }

  async streamMethodGenerationWave(
    request: StartMethodGenerationWaveRequest,
    modelContext: MethodGenerationModelContext,
    onProgress: MethodGenerationWaveProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveTurnResult> {
    const identity = validateStartMethodGenerationWaveRequest(request);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
    const endpoint = backendEndpoint(backend.baseUrl, '/api/unit-tests/method-generation-waves/start/stream');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify({
        ...request,
        parts: request.parts.map((part) => ({
          ...part,
          request: {
            ...part.request,
            llmConfig: modelContext.llmConfig
          }
        }))
      })
    }, modelContext.llmConfig, backend.managedAccess);
    try {
      return await this.consumeMethodGenerationWaveStream(
        response,
        modelContext,
        backend,
        onProgress,
        signal,
        undefined,
        identity
      );
    } catch (error) {
      return this.recoverInterruptedMethodGenerationWave(
        error,
        onProgress,
        signal
      );
    }
  }

  async resumeMethodGenerationWaveStream(
    waveSessionId: string,
    startRequest: StartMethodGenerationWaveRequest,
    afterEventSequence: number,
    onProgress: MethodGenerationWaveProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveTurnResult> {
    this.assertMethodGenerationSessionId(waveSessionId);
    if (!Number.isSafeInteger(afterEventSequence) || afterEventSequence < 0) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const identity = validateStartMethodGenerationWaveRequest(startRequest);
    this.methodGenerationWaveIdentities.set(waveSessionId, identity);
    return this.recoverInterruptedMethodGenerationWave(
      new MethodGenerationWaveStreamInterruptedError(
        waveSessionId,
        afterEventSequence
      ),
      onProgress,
      signal
    );
  }

  async recoverMethodGenerationWaveStream(
    request: RecoverMethodGenerationWaveRequest,
    modelContext: MethodGenerationModelContext,
    onProgress: MethodGenerationWaveProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveTurnResult> {
    const identity = validateRecoverMethodGenerationWaveRequest(request);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    assertCredentialTransportSafe(backend.baseUrl, modelContext.llmConfig);
    const endpoint = backendEndpoint(backend.baseUrl, '/api/unit-tests/method-generation-waves/recover/stream');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify({
        ...request,
        startRequest: {
          ...request.startRequest,
          parts: request.startRequest.parts.map((part) => ({
            ...part,
            request: {
              ...part.request,
              llmConfig: modelContext.llmConfig
            }
          }))
        }
      })
    }, modelContext.llmConfig, backend.managedAccess);
    try {
      return await this.consumeMethodGenerationWaveStream(
        response,
        modelContext,
        backend,
        onProgress,
        signal,
        {
          waveSessionId: '',
          lastEventSequence: request.lastAcknowledgedEventSequence
        },
        identity
      );
    } catch (error) {
      return this.recoverInterruptedMethodGenerationWave(
        error,
        onProgress,
        signal
      );
    }
  }

  async getMethodGenerationWaveStatus(
    waveSessionId: string,
    afterEventSequence: number,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveStatus> {
    this.assertMethodGenerationSessionId(waveSessionId);
    if (!Number.isSafeInteger(afterEventSequence) || afterEventSequence < 0) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-waves/${encodeURIComponent(waveSessionId)}`);
    endpoint.searchParams.set('afterEventSequence', String(afterEventSequence));
    return this.withIsolatedRequestAbortSignal(signal, async (requestSignal) => {
      const response = await this.fetchWithRedaction(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: requestSignal,
        headers: backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {}
      }, undefined, backend.managedAccess);
      if (response.status === 404 || response.status === 410) {
        this.methodGenerationWaveIdentities.delete(waveSessionId);
        throw new MethodGenerationWaveNotFoundError(waveSessionId);
      }
      if (!response.ok) {
        throw new Error(`读取单方法 Wave 状态失败：${response.status}`);
      }
      const status = decodeMethodGenerationWaveStatus(
        await this.readJsonResponse<unknown>(response, undefined, backend.managedAccess),
        waveSessionId,
        afterEventSequence,
        this.methodGenerationWaveIdentities.get(waveSessionId)
      );
      if (status.phase === 'completed' || status.phase === 'failed'
        || status.phase === 'cancelled') {
        this.methodGenerationWaveIdentities.delete(waveSessionId);
      }
      return status;
    });
  }

  async acknowledgeMethodGenerationWaveEvents(
    waveSessionId: string,
    throughEventSequence: number,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveEventsAcknowledgement> {
    this.assertMethodGenerationSessionId(waveSessionId);
    if (!Number.isSafeInteger(throughEventSequence) || throughEventSequence < 0) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-waves/${encodeURIComponent(waveSessionId)}/ack`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader
          ? { Authorization: backend.authorizationHeader }
          : {})
      },
      body: JSON.stringify({ throughEventSequence })
    }, undefined, backend.managedAccess);
    if (response.status === 404 || response.status === 410) {
      this.methodGenerationWaveIdentities.delete(waveSessionId);
      throw new MethodGenerationWaveNotFoundError(waveSessionId);
    }
    if (!response.ok) {
      throw new Error(`确认单方法 Wave 事件失败：${response.status}`);
    }
    return decodeMethodGenerationWaveAcknowledgement(
      await this.readJsonResponse<unknown>(response, undefined, backend.managedAccess),
      waveSessionId,
      throughEventSequence
    );
  }

  async cancelMethodGenerationWave(
    waveSessionId: string,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveStatus> {
    this.assertMethodGenerationSessionId(waveSessionId);
    const backend = this.resolveBackendRequest('agent-service');
    this.assertBackendAuthorizationTransportSafe(backend);
    const endpoint = backendEndpoint(backend.baseUrl, `/api/unit-tests/method-generation-waves/${encodeURIComponent(waveSessionId)}`);
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'DELETE',
      redirect: 'error',
      signal,
      headers: backend.authorizationHeader
        ? { Authorization: backend.authorizationHeader }
        : {}
    }, undefined, backend.managedAccess);
    if (response.status === 404 || response.status === 410) {
      this.methodGenerationWaveIdentities.delete(waveSessionId);
      throw new MethodGenerationWaveNotFoundError(waveSessionId);
    }
    if (!response.ok) {
      throw new Error(`终止单方法 Wave 失败：${response.status}`);
    }
    const status = decodeMethodGenerationWaveStatus(
      await this.readJsonResponse<unknown>(response, undefined, backend.managedAccess),
      waveSessionId,
      0,
      this.methodGenerationWaveIdentities.get(waveSessionId)
    );
    this.methodGenerationWaveIdentities.delete(waveSessionId);
    return status;
  }

  private async recoverInterruptedMethodGenerationWave(
    error: unknown,
    onProgress: MethodGenerationWaveProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationWaveTurnResult> {
    if (!(error instanceof MethodGenerationWaveStreamInterruptedError)) {
      throw error;
    }
    let eventSequence = error.lastEventSequence;
    let consecutiveFetchFailures = 0;
    let idlePollIndex = 0;
    for (;;) {
      this.throwIfMethodGenerationAborted(signal);
      const priorEventSequence = eventSequence;
      let status: MethodGenerationWaveStatus;
      try {
        status = await this.getMethodGenerationWaveStatus(
          error.waveSessionId,
          eventSequence,
          signal
        );
        consecutiveFetchFailures = 0;
      } catch (statusError) {
        if (statusError instanceof MethodGenerationWaveNotFoundError
          || signal?.aborted) throw statusError;
        consecutiveFetchFailures += 1;
        if (consecutiveFetchFailures >= METHOD_GENERATION_RECOVERY_FETCH_FAILURE_LIMIT) {
          throw error;
        }
        await this.waitForMethodGenerationRecovery(
          methodGenerationRecoveryPollDelayMilliseconds(idlePollIndex),
          signal
        );
        idlePollIndex += 1;
        continue;
      }
      for (const event of status.events) {
        if (event.eventSequence <= eventSequence) continue;
        await onProgress(event);
        eventSequence = event.eventSequence;
        if ((event.eventType === 'wave_completed'
          || event.eventType === 'wave_cancelled') && event.completion) {
          return {
            waveSessionId: status.waveSessionId,
            eventSequence,
            completion: event.completion
          };
        }
        if (event.eventType === 'error' && event.error) {
          throw new MethodGenerationRequestError(
            event.error.code,
            `单方法 Wave 失败：${event.error.message}`
          );
        }
      }
      if (status.completion) {
        return {
          waveSessionId: status.waveSessionId,
          eventSequence: status.lastEventSequence,
          completion: status.completion
        };
      }
      if (status.terminalError) {
        throw new MethodGenerationRequestError(
          status.terminalError.code,
          `单方法 Wave 失败：${status.terminalError.message}`
        );
      }
      if (status.phase === 'failed') {
        throw new Error('单方法 Wave 失败，但未返回错误详情。');
      }
      eventSequence = Math.max(eventSequence, status.lastEventSequence);
      if (eventSequence > priorEventSequence) idlePollIndex = 0;
      await this.waitForMethodGenerationRecovery(
        methodGenerationRecoveryPollDelayMilliseconds(idlePollIndex),
        signal
      );
      if (eventSequence === priorEventSequence) idlePollIndex += 1;
    }
  }

  private async recoverInterruptedMethodGeneration(
    error: unknown,
    onProgress: MethodGenerationProgressHandler,
    signal?: AbortSignal
  ): Promise<MethodGenerationTurnResult> {
    if (!(error instanceof MethodGenerationStreamInterruptedError)) {
      throw error;
    }
    let eventSequence = error.lastEventSequence;
    let consecutiveFetchFailures = 0;
    let idlePollIndex = 0;
    for (;;) {
      this.throwIfMethodGenerationAborted(signal);
      const priorEventSequence = eventSequence;
      let status: MethodGenerationSessionStatus;
      try {
        status = await this.getMethodGenerationStatus(
          error.sessionId,
          eventSequence,
          signal
        );
        consecutiveFetchFailures = 0;
      } catch (statusError) {
        if (
          statusError instanceof MethodGenerationSessionNotFoundError
          || signal?.aborted
        ) {
          throw statusError;
        }
        consecutiveFetchFailures += 1;
        if (consecutiveFetchFailures >= METHOD_GENERATION_RECOVERY_FETCH_FAILURE_LIMIT) {
          throw error;
        }
        await this.waitForMethodGenerationRecovery(
          methodGenerationRecoveryPollDelayMilliseconds(idlePollIndex),
          signal
        );
        idlePollIndex += 1;
        continue;
      }

      for (const event of status.events) {
        if (event.eventSequence <= eventSequence) continue;
        await onProgress(event);
        eventSequence = event.eventSequence;
        if (event.eventType === 'candidate_ready' && event.candidate) {
          return {
            kind: 'candidate_ready',
            sessionId: status.sessionId,
            eventSequence,
            candidate: event.candidate
          };
        }
        if (event.eventType === 'completed' && event.completion) {
          return {
            kind: 'completed',
            sessionId: status.sessionId,
            eventSequence,
            completion: event.completion
          };
        }
        if (event.eventType === 'error' && event.error) {
          throw new MethodGenerationRequestError(
            event.error.code,
            `单方法生成失败：${event.error.message}`
          );
        }
      }

      if (status.pendingCandidate) {
        return {
          kind: 'candidate_ready',
          sessionId: status.sessionId,
          eventSequence: status.lastEventSequence,
          candidate: status.pendingCandidate
        };
      }
      if (status.completion) {
        return {
          kind: 'completed',
          sessionId: status.sessionId,
          eventSequence: status.lastEventSequence,
          completion: status.completion
        };
      }
      if (status.terminalError) {
        throw new MethodGenerationRequestError(
          status.terminalError.code,
          `单方法生成失败：${status.terminalError.message}`
        );
      }
      if (status.phase === 'failed' || status.phase === 'cancelled') {
        throw new Error(
          status.phase === 'cancelled'
            ? '单方法生成已取消。'
            : '单方法生成失败，但未返回错误详情。'
        );
      }
      eventSequence = Math.max(eventSequence, status.lastEventSequence);
      if (eventSequence > priorEventSequence) idlePollIndex = 0;
      await this.waitForMethodGenerationRecovery(
        methodGenerationRecoveryPollDelayMilliseconds(idlePollIndex),
        signal
      );
      if (eventSequence === priorEventSequence) idlePollIndex += 1;
    }
  }

  private waitForMethodGenerationRecovery(
    delayMilliseconds: number,
    signal?: AbortSignal
  ): Promise<void> {
    this.throwIfMethodGenerationAborted(signal);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.reason instanceof Error
          ? signal.reason
          : new Error('单方法生成已取消。'));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMilliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async withIsolatedRequestAbortSignal<T>(
    signal: AbortSignal | undefined,
    operation: (requestSignal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    if (!signal) return operation(undefined);
    this.throwIfMethodGenerationAborted(signal);
    const requestController = new AbortController();
    const forwardAbort = (): void => {
      requestController.abort(signal.reason);
    };
    signal.addEventListener('abort', forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    try {
      return await operation(requestController.signal);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  private throwIfMethodGenerationAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('单方法生成已取消。');
  }

  async generateTargetJacocoReport(
    request: GenerateTargetJacocoReportRequest,
    signal?: AbortSignal
  ): Promise<GenerateTargetJacocoReportResponse> {
    const backend = this.resolveBackendRequest('java-analyzer');
    if (!backend.baseUrl) {
      throw new Error('生成目标覆盖率前必须配置 Java 分析服务地址。');
    }

    const analyzerUrl = new URL(backend.baseUrl);
    if (!isLoopbackHostname(analyzerUrl.hostname)) {
      return this.generateTargetJacocoReportFromArtifacts(request, backend, signal);
    }

    return this.generateTargetJacocoReportFromLocalPaths(request, backend, signal);
  }

  private async generateTargetJacocoReportFromLocalPaths(
    request: GenerateTargetJacocoReportRequest,
    backend: ResolvedBackendRequest,
    signal?: AbortSignal
  ): Promise<GenerateTargetJacocoReportResponse> {
    const endpoint = backendEndpoint(backend.baseUrl, '/api/reports/jacoco/target-report');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(backend.authorizationHeader ? { Authorization: backend.authorizationHeader } : {})
      },
      body: JSON.stringify(request)
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      const message = this.redactSensitive(await response.text(), undefined, backend.managedAccess);
      throw new Error(`目标类 JaCoCo 报告生成失败：${response.status} ${message}`);
    }

    const data = await this.readJsonResponse<Record<string, unknown>>(
      response,
      undefined,
      backend.managedAccess
    );
    return this.decodeTargetJacocoReportResponse(data, request);
  }

  private async generateTargetJacocoReportFromArtifacts(
    request: GenerateTargetJacocoReportRequest,
    backend: ResolvedBackendRequest,
    signal?: AbortSignal
  ): Promise<GenerateTargetJacocoReportResponse> {
    const manifest = {
      targetSourceRelativePath: projectRelativePath(
        request.projectPath,
        request.targetFilePath,
        '目标源码文件'
      ),
      targetClass: request.targetClass,
      executionDataRelativePath: projectRelativePath(
        request.projectPath,
        request.executionDataPath,
        'JaCoCo 执行数据'
      ),
      outputRelativePath: projectRelativePath(
        request.projectPath,
        request.outputPath,
        'JaCoCo XML 输出文件'
      ),
      branchSnapshotOutputRelativePath: projectRelativePath(
        request.projectPath,
        request.branchSnapshotOutputPath,
        'JaCoCo 分支快照输出文件'
      )
    };
    const bundle = await this.createTargetJacocoArtifactBundle(request, manifest);
    const formData = new FormData();
    formData.append(
      'request',
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
      'request.json'
    );
    formData.append(
      'bundle',
      new Blob([new Uint8Array(bundle)], { type: 'application/zip' }),
      'jacoco-artifacts.zip'
    );

    const endpoint = backendEndpoint(backend.baseUrl, '/api/reports/jacoco/target-report/artifacts');
    const response = await this.fetchWithRedaction(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...(backend.authorizationHeader ? { Authorization: backend.authorizationHeader } : {})
      },
      body: formData
    }, undefined, backend.managedAccess);
    if (!response.ok) {
      const message = this.redactSensitive(await response.text(), undefined, backend.managedAccess);
      throw new Error(`目标类 JaCoCo 报告生成失败：${response.status} ${message}`);
    }

    const data = await this.readJsonResponse<Record<string, unknown>>(
      response,
      undefined,
      backend.managedAccess
    );
    const decoded = this.decodeTargetJacocoReportResponse(data, request);
    const reportXmlBase64 = this.readString(data.reportXmlBase64 ?? data.report_xml_base64);
    const branchSnapshotJsonBase64 = this.readString(
      data.branchSnapshotJsonBase64 ?? data.branch_snapshot_json_base64
    );
    if (!reportXmlBase64 || !branchSnapshotJsonBase64) {
      throw new Error('java-analyzer 未返回可写回本地的 JaCoCo XML/分支快照内容。');
    }
    await mkdir(dirname(request.outputPath), { recursive: true });
    await mkdir(dirname(request.branchSnapshotOutputPath), { recursive: true });
    await writeFile(request.outputPath, Buffer.from(reportXmlBase64, 'base64'));
    await writeFile(request.branchSnapshotOutputPath, Buffer.from(branchSnapshotJsonBase64, 'base64'));

    return {
      ...decoded,
      reportPath: request.outputPath,
      branchSnapshotPath: request.branchSnapshotOutputPath
    };
  }

  private async createTargetJacocoArtifactBundle(
    request: GenerateTargetJacocoReportRequest,
    manifest: {
      targetSourceRelativePath: string;
      executionDataRelativePath: string;
    }
  ): Promise<Buffer> {
    const entries: JacocoArtifactEntry[] = [];
    const seen = new Set<string>();
    const addEntry = async (absolutePath: string, relativePath: string, required: boolean): Promise<void> => {
      if (seen.has(relativePath)) return;
      const entry = await maybeReadArtifactFile(absolutePath, relativePath);
      if (!entry) {
        if (required) throw new Error(`生成远程 JaCoCo 报告缺少必要文件：${relativePath}`);
        return;
      }
      entries.push(entry);
      seen.add(relativePath);
    };

    await addEntry(
      request.targetFilePath,
      manifest.targetSourceRelativePath,
      true
    );

    const classRelativePath = `target/classes/${request.targetClass.replace(/\./g, '/')}.class`;
    const classAbsolutePath = resolve(request.projectPath, ...classRelativePath.split('/'));
    await addEntry(classAbsolutePath, classRelativePath, true);
    const classDirectory = dirname(classAbsolutePath);
    const classBaseName = basename(classAbsolutePath, '.class');
    let classDirectoryEntries: { isFile(): boolean; name: string }[] = [];
    try {
      classDirectoryEntries = await readdir(classDirectory, { withFileTypes: true });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    for (const directoryEntry of classDirectoryEntries) {
      if (
        !directoryEntry.isFile()
        || !directoryEntry.name.startsWith(`${classBaseName}$`)
        || !directoryEntry.name.endsWith('.class')
      ) {
        continue;
      }
      const relativePath = `${dirname(classRelativePath).replace(/\\/g, '/')}/${directoryEntry.name}`;
      await addEntry(resolve(classDirectory, directoryEntry.name), relativePath, false);
    }

    await addEntry(
      request.executionDataPath,
      manifest.executionDataRelativePath,
      false
    );

    const bundle = createStoredZip(entries);
    if (bundle.length > REMOTE_JACOCO_MAX_BUNDLE_BYTES) {
      throw new Error('上传到 java-analyzer 的 JaCoCo 文件包超过 64MB。');
    }
    return bundle;
  }

  private decodeTargetJacocoReportResponse(
    data: Record<string, unknown>,
    request: GenerateTargetJacocoReportRequest
  ): GenerateTargetJacocoReportResponse {
    const generated = data.generated === true;
    const reportPath = this.readString(data.reportPath ?? data.report_path);
    const branchSnapshotPath = this.readString(
      data.branchSnapshotPath ?? data.branch_snapshot_path
    );
    const pairId = this.readString(data.pairId ?? data.pair_id);
    if (
      !generated
      || !reportPath
      || !branchSnapshotPath
      || !pairId
      || !/^[0-9a-f]{64}$/i.test(pairId)
    ) {
      throw new Error('java-analyzer 未返回有效的 JaCoCo XML/分支快照文件对及 pairId');
    }
    return {
      generated,
      reportPath,
      branchSnapshotPath,
      pairId: pairId.toLowerCase(),
      targetClass: this.readString(data.targetClass ?? data.target_class) ?? request.targetClass,
      generatedAt: this.readString(data.generatedAt ?? data.generated_at) ?? '',
      message: this.readString(data.message) ?? ''
    };
  }

  private resolveBackendRequest(service: 'agent-service' | 'java-analyzer'): ResolvedBackendRequest {
    const managedAccess = this.readManagedBackendAccess();
    if (managedAccess) {
      return service === 'agent-service'
        ? {
            baseUrl: managedAccess.agentServiceUrl,
            authorizationHeader: managedAccess.agentServiceAuthorizationHeader,
            managedAccess
          }
        : {
            baseUrl: managedAccess.javaAnalyzerUrl,
            authorizationHeader: managedAccess.javaAnalyzerAuthorizationHeader,
            managedAccess
          };
    }

    const userToken = this.readUserAccessToken();
    return {
      baseUrl: service === 'agent-service'
        ? this.getUserAuthenticationEndpoint()
        : process.env.JAVA_ANALYZER_URL ?? process.env.AI_JAVA_ANALYZER_URL ?? this.settings.javaAnalyzerUrl,
      ...(userToken ? { authorizationHeader: `Bearer ${userToken}` } : {})
    };
  }

  private readUserAccessToken(): string | null {
    try {
      const token = this.userAccessTokenProvider?.() ?? null;
      return typeof token === 'string' && token.length >= 43 ? token : null;
    } catch {
      return null;
    }
  }

  private async authRequest<T>(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    allowEmpty = false
  ): Promise<T> {
    if (this.readManagedBackendAccess()) {
      throw new RemoteAuthError('AUTH_REMOTE_ONLY', '用户登录仅用于服务器连接模式。', 409);
    }
    const baseUrl = this.getUserAuthenticationEndpoint();
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname))) {
      throw new RemoteAuthError(
        'AUTH_TRANSPORT_UNSAFE',
        '远程账号服务必须使用 HTTPS。',
        400
      );
    }
    const accessToken = authenticated ? this.readUserAccessToken() : null;
    const response = await this.fetchImpl(backendEndpoint(baseUrl, path), {
      ...init,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      let payload: unknown;
      try { payload = await response.json(); } catch { payload = null; }
      const record = payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
      throw new RemoteAuthError(
        typeof record.code === 'string' ? record.code : 'AUTH_REQUEST_FAILED',
        typeof record.message === 'string' ? record.message : '账号服务请求失败。',
        response.status
      );
    }
    if (allowEmpty && response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private assertAnalysisSessionId(sessionId: string): void {
    if (!ANALYSIS_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(METHOD_ANALYSIS_RESPONSE_INVALID);
    }
  }

  private assertMethodGenerationSessionId(sessionId: string): void {
    if (!ANALYSIS_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
  }

  private assertBackendAuthorizationTransportSafe(
    backend: ResolvedBackendRequest
  ): void {
    if (!backend.authorizationHeader) {
      return;
    }
    const url = new URL(backend.baseUrl);
    if (url.protocol === 'https:') {
      return;
    }
    if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) {
      throw new Error('本地服务凭证只能发送到 HTTPS 或本机回环地址。');
    }
  }

  private readManagedBackendAccess(): ManagedBackendAccess | null {
    const provider = this.managedBackendAccessProvider;
    if (!provider) {
      return null;
    }

    try {
      const access = provider();
      if (
        !access ||
        typeof access.agentServiceUrl !== 'string' ||
        typeof access.agentServiceAuthorizationHeader !== 'string' ||
        typeof access.javaAnalyzerUrl !== 'string' ||
        typeof access.javaAnalyzerAuthorizationHeader !== 'string' ||
        !access.agentServiceUrl ||
        !access.agentServiceAuthorizationHeader ||
        !access.javaAnalyzerUrl ||
        !access.javaAnalyzerAuthorizationHeader
      ) {
        throw new Error(MANAGED_BACKEND_NOT_READY_ERROR);
      }
      return access;
    } catch {
      // provider 的内部异常可能包含端口或令牌，产品层统一转换为固定中文错误。
      throw new Error(MANAGED_BACKEND_NOT_READY_ERROR);
    }
  }

  private async fetchWithRedaction(
    input: string | URL | Request,
    init: RequestInit,
    llmConfig?: SensitiveLlmConfigs,
    managedAccess?: ManagedBackendAccess
  ): Promise<Response> {
    const backendName = this.connectionBackendName(input, managedAccess);
    try {
      const response = await this.fetchWithMethodAnalysisTimeout(
        input,
        init,
        backendName
      );
      if (
        backendName === 'Agent Service'
        && !managedAccess
        && (response.status === 401 || response.status === 403)
      ) {
        try {
          const payload = await response.clone().json() as { code?: unknown };
          if (typeof payload.code === 'string') this.userAuthFailureHandler?.(payload.code);
        } catch {
          // Non-JSON failures remain the responsibility of the endpoint decoder.
        }
      }
      return response;
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      if (backendName && error instanceof TypeError) {
        const causeCode = error.cause && typeof error.cause === 'object' && 'code' in error.cause
          ? error.cause.code
          : undefined;
        if (causeCode === 'UND_ERR_HEADERS_TIMEOUT') {
          throw new BackendResponseTimeoutError(backendName, { cause: error });
        }
        throw new Error(`${backendName} 无法连接，请确认服务已启动后重试。`);
      }
      const safeMessage = this.redactSensitive(originalMessage, llmConfig, managedAccess);
      if (safeMessage === originalMessage) {
        throw error;
      }
      const safeError = new Error(safeMessage);
      if (error instanceof Error) {
        safeError.name = error.name;
      }
      throw safeError;
    }
  }

  private async fetchWithMethodAnalysisTimeout(
    input: string | URL | Request,
    init: RequestInit,
    backendName: 'Agent Service' | 'Java Analyzer' | null
  ): Promise<Response> {
    if (
      backendName !== 'Java Analyzer'
      || !this.isMethodAnalysisEndpoint(input)
    ) {
      return this.fetchImpl(input, init);
    }

    const callerSignal = init.signal ?? undefined;
    if (callerSignal?.aborted) throw callerSignal.reason;
    const requestController = new AbortController();
    const timeoutError = new BackendResponseTimeoutError('Java Analyzer');
    let timedOut = false;
    const forwardCallerAbort = (): void => {
      requestController.abort(callerSignal?.reason);
    };
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(timeoutError);
    }, this.javaAnalyzerResponseTimeoutMilliseconds);
    timeout.unref();

    try {
      const response = await this.fetchImpl(input, {
        ...init,
        signal: requestController.signal
      });
      if (timedOut) throw timeoutError;
      return response;
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (timedOut) {
        if (error === timeoutError) throw error;
        throw new BackendResponseTimeoutError('Java Analyzer', {
          cause: error
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', forwardCallerAbort);
    }
  }

  private isMethodAnalysisEndpoint(
    input: string | URL | Request
  ): boolean {
    try {
      const requestUrl = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
      return requestUrl.pathname === '/api/generation-analysis/sessions'
        || requestUrl.pathname.startsWith(
          '/api/generation-analysis/sessions/'
        );
    } catch {
      return false;
    }
  }

  private connectionBackendName(
    input: string | URL | Request,
    managedAccess?: ManagedBackendAccess
  ): 'Agent Service' | 'Java Analyzer' | null {
    let requestOrigin: string;
    try {
      const requestUrl = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
      requestOrigin = requestUrl.origin;
    } catch {
      return null;
    }
    const endpoints: Array<[
      'Agent Service' | 'Java Analyzer',
      string | undefined
    ]> = managedAccess
      ? [
          ['Agent Service', managedAccess.agentServiceUrl],
          ['Java Analyzer', managedAccess.javaAnalyzerUrl]
        ]
      : [
          ['Agent Service', process.env.AI_BACKEND_URL || this.settings.agentServiceUrl],
          [
            'Java Analyzer',
            process.env.JAVA_ANALYZER_URL
              ?? process.env.AI_JAVA_ANALYZER_URL
              ?? this.settings.javaAnalyzerUrl
          ]
        ];
    for (const [name, endpoint] of endpoints) {
      if (!endpoint) continue;
      try {
        if (new URL(endpoint).origin === requestOrigin) return name;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async readJsonResponse<T>(
    response: Response,
    llmConfig?: SensitiveLlmConfigs,
    managedAccess?: ManagedBackendAccess
  ): Promise<T> {
    const source = await response.text();
    try {
      return this.redactSensitive(JSON.parse(source) as T, llmConfig, managedAccess);
    } catch {
      // JSON.parse 在部分 Node 版本中会在异常中引用正文片段，固定错误避免秘密回显。
      throw new Error('后端返回了无效的 JSON 响应。');
    }
  }

  private async consumeDirectModelGenerationStream(
    response: Response,
    llmConfig: BackendLlmConfig,
    managedAccess?: ManagedBackendAccess,
    signal?: AbortSignal
  ): Promise<DirectModelGenerationResult> {
    if (!response.body) {
      throw new Error('批量测试生成响应无效。');
    }
    const reader = response.body.getReader();
    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelReader, { once: true });
    if (signal?.aborted) cancelReader();

    const decoder = new TextDecoder();
    let buffer = '';
    let terminal: DirectModelGenerationStreamEvent | null = null;

    const consumeBlock = (block: string): void => {
      const lines = block.split(/\r?\n/);
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      const eventName = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      if (eventName !== 'direct_generation' || terminal !== null) {
        throw new Error('批量测试生成响应无效。');
      }
      let raw: unknown;
      try {
        raw = this.redactSensitive(
          JSON.parse(dataLines.join('\n')) as unknown,
          llmConfig,
          managedAccess
        );
      } catch {
        throw new Error('批量测试生成响应无效。');
      }
      terminal = decodeDirectModelGenerationStreamEvent(raw);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) consumeBlock(block);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeBlock(buffer);
    } finally {
      signal?.removeEventListener('abort', cancelReader);
    }

    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('批量测试生成已取消。');
    }
    if (terminal === null) {
      throw new Error('批量测试生成响应无效。');
    }
    const completed = terminal as DirectModelGenerationStreamEvent;
    if (completed.phase === 'failed') {
      throw new MethodGenerationRequestError(
        completed.error.code,
        `批量测试生成失败：${completed.error.message}`
      );
    }
    return completed.response;
  }

  private async consumeMethodGenerationStream(
    response: Response,
    modelContext: MethodGenerationModelContext,
    backend: ResolvedBackendRequest,
    onProgress: MethodGenerationProgressHandler,
    signal?: AbortSignal,
    recoveryCursor?: MethodGenerationStreamRecoveryCursor,
    initialIdentity?: MethodGenerationIdentity,
    additionalSensitiveConfig?: BackendLlmConfig
  ): Promise<MethodGenerationTurnResult> {
    if (response.status === 404 || response.status === 410) {
      if (recoveryCursor?.sessionId) {
        const notFound = await this.methodGenerationHttpError(
          response,
          modelContext.llmConfig,
          backend.managedAccess
        );
        if (notFound instanceof MethodGenerationRequestError && notFound.code !== 'NOT_FOUND') {
          throw notFound;
        }
        this.methodGenerationIdentities.delete(recoveryCursor.sessionId);
        throw new MethodGenerationSessionNotFoundError(recoveryCursor.sessionId);
      }
      if (response.status === 410) {
        throw new Error('当前 agent-service 不支持单方法生成接口。');
      }
      throw await this.methodGenerationHttpError(
        response,
        modelContext.llmConfig,
        backend.managedAccess,
        '当前 agent-service 不支持单方法生成接口。'
      );
    }
    if (!response.ok) {
      throw await this.methodGenerationHttpError(
        response,
        modelContext.llmConfig,
        backend.managedAccess
      );
    }
    if (!response.body) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }
    const reader = response.body.getReader();
    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelReader, { once: true });
    if (signal?.aborted) cancelReader();

    const decoder = new TextDecoder();
    let buffer = '';
    let sessionId = recoveryCursor?.sessionId ?? '';
    let lastSequence = recoveryCursor?.lastEventSequence ?? 0;
    let lastHandledSequence = recoveryCursor?.lastEventSequence ?? 0;
    let consecutiveHeartbeats = 0;
    let identity = initialIdentity;
    let terminal: MethodGenerationTurnResult | null = null;

    const consumeBlock = async (block: string): Promise<void> => {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) {
        if (isSseHeartbeatBlock(block)) {
          consecutiveHeartbeats += 1;
          if (
            consecutiveHeartbeats >= METHOD_GENERATION_STREAM_HEARTBEAT_RECOVERY_LIMIT
            && sessionId
            && lastHandledSequence > 0
          ) {
            throw new MethodGenerationStreamInterruptedError(
              sessionId,
              lastHandledSequence
            );
          }
        }
        return;
      }
      consecutiveHeartbeats = 0;
      let raw: unknown;
      try {
        raw = this.redactSensitive(
          JSON.parse(dataLines.join('\n')) as unknown,
          additionalSensitiveConfig
            ? [modelContext.llmConfig, additionalSensitiveConfig]
            : modelContext.llmConfig,
          backend.managedAccess
        );
      } catch {
        throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
      }
      const event = decodeMethodGenerationEvent(raw, {
        expectedSessionId: sessionId || undefined,
        previousEventSequence: lastSequence,
        identity
      });
      sessionId = event.sessionId;
      lastSequence = event.eventSequence;
      identity = this.methodGenerationIdentityFromEvent(event, identity);
      if (identity) {
        this.methodGenerationIdentities.set(sessionId, identity);
      }
      await onProgress(event);
      lastHandledSequence = event.eventSequence;
      if (event.eventType === 'candidate_ready' && event.candidate) {
        terminal = {
          kind: 'candidate_ready',
          sessionId,
          eventSequence: event.eventSequence,
          candidate: event.candidate
        };
      } else if (event.eventType === 'completed' && event.completion) {
        terminal = {
          kind: 'completed',
          sessionId,
          eventSequence: event.eventSequence,
          completion: event.completion
        };
      } else if (event.eventType === 'error' && event.error) {
        this.methodGenerationIdentities.delete(sessionId);
        throw new MethodGenerationRequestError(
          event.error.code,
          `单方法生成失败：${event.error.message}`
        );
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          await consumeBlock(block);
          if (terminal) {
            const result = terminal as MethodGenerationTurnResult;
            if (result.kind === 'completed') {
              this.methodGenerationIdentities.delete(result.sessionId);
            }
            return result;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) await consumeBlock(buffer);
      if (terminal) {
        const result = terminal as MethodGenerationTurnResult;
        if (result.kind === 'completed') {
          this.methodGenerationIdentities.delete(result.sessionId);
        }
        return result;
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('单方法生成已取消。');
      }
      if (sessionId && lastHandledSequence > 0) {
        throw new MethodGenerationStreamInterruptedError(
          sessionId,
          lastHandledSequence
        );
      }
      throw new Error('单方法生成连接在返回结果前中断。');
    } catch (error) {
      if (error instanceof MethodGenerationStreamInterruptedError) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      if (
        error instanceof MethodGenerationSessionNotFoundError
        || error instanceof Error
          && (
            error.message === METHOD_GENERATION_RESPONSE_INVALID
            || error.message.startsWith('单方法生成失败：')
            || signal?.aborted
          )
      ) {
        throw error;
      }
      if (sessionId && lastHandledSequence > 0) {
        throw new MethodGenerationStreamInterruptedError(
          sessionId,
          lastHandledSequence
        );
      }
      throw new Error('单方法生成连接在返回结果前中断。');
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      try {
        reader.releaseLock();
      } catch {
        // AbortSignal may have already cancelled and released the reader.
      }
    }
  }

  private async consumeMethodGenerationWaveStream(
    response: Response,
    modelContext: MethodGenerationModelContext,
    backend: ResolvedBackendRequest,
    onProgress: MethodGenerationWaveProgressHandler,
    signal?: AbortSignal,
    recoveryCursor?: MethodGenerationWaveStreamRecoveryCursor,
    initialIdentity?: MethodGenerationWaveIdentity
  ): Promise<MethodGenerationWaveTurnResult> {
    if (response.status === 404 || response.status === 410) {
      if (recoveryCursor?.waveSessionId) {
        const notFound = await this.methodGenerationHttpError(
          response,
          modelContext.llmConfig,
          backend.managedAccess
        );
        if (notFound instanceof MethodGenerationRequestError && notFound.code !== 'NOT_FOUND') {
          throw notFound;
        }
        this.methodGenerationWaveIdentities.delete(recoveryCursor.waveSessionId);
        throw new MethodGenerationWaveNotFoundError(recoveryCursor.waveSessionId);
      }
      if (response.status === 410) {
        throw new Error('当前 agent-service 不支持单方法 Wave 接口。');
      }
      throw await this.methodGenerationHttpError(
        response,
        modelContext.llmConfig,
        backend.managedAccess,
        '当前 agent-service 不支持单方法 Wave 接口。'
      );
    }
    if (!response.ok) {
      throw await this.methodGenerationHttpError(
        response,
        modelContext.llmConfig,
        backend.managedAccess
      );
    }
    if (!response.body) {
      throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
    }

    const reader = response.body.getReader();
    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelReader, { once: true });
    if (signal?.aborted) cancelReader();

    const decoder = new TextDecoder();
    let buffer = '';
    let waveSessionId = recoveryCursor?.waveSessionId ?? '';
    let lastSequence = recoveryCursor?.lastEventSequence ?? 0;
    let lastHandledSequence = recoveryCursor?.lastEventSequence ?? 0;
    let consecutiveHeartbeats = 0;
    let terminal: MethodGenerationWaveTurnResult | null = null;

    const consumeBlock = async (block: string): Promise<void> => {
      const lines = block.split(/\r?\n/);
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) {
        if (isSseHeartbeatBlock(block)) {
          consecutiveHeartbeats += 1;
          if (
            consecutiveHeartbeats >= METHOD_GENERATION_STREAM_HEARTBEAT_RECOVERY_LIMIT
            && waveSessionId
            && lastHandledSequence > 0
          ) {
            throw new MethodGenerationWaveStreamInterruptedError(
              waveSessionId,
              lastHandledSequence
            );
          }
        }
        return;
      }
      consecutiveHeartbeats = 0;
      const eventNames = lines
        .filter((line) => line.startsWith('event:'))
        .map((line) => line.slice(6).trim());
      if (eventNames.length !== 1 || eventNames[0] !== 'method_generation_wave') {
        throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
      }
      let raw: unknown;
      try {
        raw = this.redactSensitive(
          JSON.parse(dataLines.join('\n')) as unknown,
          modelContext.llmConfig,
          backend.managedAccess
        );
      } catch {
        throw new Error(METHOD_GENERATION_RESPONSE_INVALID);
      }
      const event = decodeMethodGenerationWaveEvent(raw, {
        expectedWaveSessionId: waveSessionId || undefined,
        previousEventSequence: lastSequence,
        identity: initialIdentity
      });
      waveSessionId = event.waveSessionId;
      lastSequence = event.eventSequence;
      if (initialIdentity) {
        this.methodGenerationWaveIdentities.set(waveSessionId, initialIdentity);
      }
      await onProgress(event);
      lastHandledSequence = event.eventSequence;
      if ((event.eventType === 'wave_completed'
        || event.eventType === 'wave_cancelled') && event.completion) {
        terminal = {
          waveSessionId,
          eventSequence: event.eventSequence,
          completion: event.completion
        };
      } else if (event.eventType === 'error' && event.error) {
        this.methodGenerationWaveIdentities.delete(waveSessionId);
        throw new MethodGenerationRequestError(
          event.error.code,
          `单方法 Wave 失败：${event.error.message}`
        );
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          await consumeBlock(block);
          if (terminal) {
            const result = terminal as MethodGenerationWaveTurnResult;
            this.methodGenerationWaveIdentities.delete(result.waveSessionId);
            return result;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) await consumeBlock(buffer);
      if (terminal) {
        const result = terminal as MethodGenerationWaveTurnResult;
        this.methodGenerationWaveIdentities.delete(result.waveSessionId);
        return result;
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('单方法 Wave 已取消。');
      }
      if (waveSessionId && lastHandledSequence > 0) {
        throw new MethodGenerationWaveStreamInterruptedError(
          waveSessionId,
          lastHandledSequence
        );
      }
      throw new Error('单方法 Wave 连接在返回结果前中断。');
    } catch (error) {
      if (error instanceof MethodGenerationWaveStreamInterruptedError) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      if (
        error instanceof MethodGenerationWaveNotFoundError
        || error instanceof MethodGenerationRequestError
        || error instanceof Error
          && (error.message === METHOD_GENERATION_RESPONSE_INVALID || signal?.aborted)
      ) {
        throw error;
      }
      if (waveSessionId && lastHandledSequence > 0) {
        throw new MethodGenerationWaveStreamInterruptedError(
          waveSessionId,
          lastHandledSequence
        );
      }
      throw new Error('单方法 Wave 连接在返回结果前中断。');
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      try {
        reader.releaseLock();
      } catch {
        // AbortSignal may have already cancelled and released the reader.
      }
    }
  }

  private methodGenerationIdentityFromEvent(
    event: MethodGenerationSessionEvent,
    current?: MethodGenerationIdentity
  ): MethodGenerationIdentity | undefined {
    const candidate = event.candidate;
    const modelCall = event.modelCall;
    const completion = event.completion;
    const next = candidate
      ? {
          methodId: candidate.methodId,
          batchId: candidate.batchId,
          batchIndex: candidate.batchIndex,
          outputTestClassName: candidate.outputTestClassName,
          plannedTestMethods: candidate.ordinaryTestMethodCount
        }
      : modelCall
        ? {
            methodId: modelCall.methodId,
            batchId: modelCall.batchId,
            batchIndex: modelCall.batchIndex
          }
        : completion
          ? { methodId: completion.methodId, batchId: completion.batchId }
          : undefined;
    if (!next) return current;
    return {
      methodId: next.methodId,
      batchId: next.batchId,
      batchIndex: next.batchIndex ?? current?.batchIndex,
      outputTestClassName:
        ('outputTestClassName' in next ? next.outputTestClassName : undefined)
          ?? current?.outputTestClassName,
      plannedTestMethods:
        current?.plannedTestMethods
          ?? ('plannedTestMethods' in next ? next.plannedTestMethods : undefined),
      ragEnabled: current?.ragEnabled
    };
  }

  private rememberMethodGenerationIdentityFromStatus(
    status: MethodGenerationSessionStatus
  ): void {
    let identity = this.methodGenerationIdentities.get(status.sessionId);
    for (const event of status.events) {
      identity = this.methodGenerationIdentityFromEvent(event, identity);
    }
    if (status.pendingCandidate) {
      identity = {
        methodId: status.pendingCandidate.methodId,
        batchId: status.pendingCandidate.batchId,
        batchIndex: status.pendingCandidate.batchIndex,
        outputTestClassName: status.pendingCandidate.outputTestClassName,
        plannedTestMethods:
          identity?.plannedTestMethods
            ?? status.pendingCandidate.ordinaryTestMethodCount,
        ragEnabled: identity?.ragEnabled
      };
    }
    if (identity) {
      this.methodGenerationIdentities.set(status.sessionId, identity);
    }
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private async modelToolCapabilityHttpError(
    response: Response,
    llmConfig: BackendLlmConfig,
    managedAccess?: ManagedBackendAccess
  ): Promise<Error> {
    const fallback = `检测模型工具调用能力失败：${response.status}`;
    let value: unknown;
    try {
      value = await this.readJsonResponse<unknown>(response, llmConfig, managedAccess);
    } catch {
      return new Error(fallback);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return new Error(fallback);
    }
    const item = value as Record<string, unknown>;
    const code = this.readString(item.code)?.trim();
    const message = this.readString(item.message)?.trim();
    if (!code || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code) || !message) {
      return new Error(fallback);
    }
    const safeMessage = sanitizePublicText(message)
      .replace(/[\u0000-\u0020\u007f]+/g, ' ')
      .trim()
      .slice(0, MAX_BACKEND_ERROR_TEXT_LENGTH);
    return safeMessage
      ? new MethodGenerationRequestError(code, safeMessage)
      : new Error(fallback);
  }

  private async methodAnalysisHttpError(
    response: Response,
    managedAccess?: ManagedBackendAccess,
    operation = '单方法分析请求失败'
  ): Promise<Error> {
    const fallback = `${operation}：${response.status}`;
    let value: unknown;
    try {
      value = await this.readJsonResponse<unknown>(response, undefined, managedAccess);
    } catch {
      return new Error(fallback);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return new Error(fallback);
    }
    const item = value as Record<string, unknown>;
    const code = this.readString(item.code)?.trim();
    const message = this.readString(item.message)?.trim();
    if (!code || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code) || !message) {
      return new Error(fallback);
    }
    const safeMessage = sanitizePublicText(message)
      .replace(/[\u0000-\u0020\u007f]+/g, ' ')
      .trim();
    if (!safeMessage) return new Error(fallback);
    return new MethodAnalysisRequestError(
      code,
      `${operation}（${code}）：${safeMessage}`
        .slice(0, MAX_BACKEND_ERROR_TEXT_LENGTH)
    );
  }

  private async methodGenerationHttpError(
    response: Response,
    llmConfig: BackendLlmConfig | undefined,
    managedAccess?: ManagedBackendAccess,
    fallback = `单方法生成请求失败：${response.status}`
  ): Promise<Error> {
    const protocolError = () => new MethodGenerationRequestError(
      'METHOD_GENERATION_REQUEST_FAILED', fallback
    );
    let value: unknown;
    try {
      value = await this.readJsonResponse<unknown>(response, llmConfig, managedAccess);
    } catch {
      return protocolError();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return protocolError();
    const item = value as Record<string, unknown>;
    const code = this.readString(item.code);
    const message = this.readString(item.message);
    if (!code || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code) || !message?.trim()) {
      return protocolError();
    }
    return new MethodGenerationRequestError(code, `单方法生成失败：${message.trim()}`);
  }

  private async directGenerationHttpError(
    response: Response,
    llmConfig: BackendLlmConfig,
    managedAccess?: ManagedBackendAccess
  ): Promise<Error> {
    const fallback = `批量测试生成请求失败：${response.status}`;
    let value: unknown;
    try {
      value = await this.readJsonResponse<unknown>(response, llmConfig, managedAccess);
    } catch {
      return new Error(fallback);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return new Error(fallback);
    }
    const item = value as Record<string, unknown>;
    const code = this.readString(item.code)?.trim();
    const message = this.readString(item.message)?.trim();
    if (!code || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code) || !message) {
      return new Error(fallback);
    }
    const safeMessage = sanitizePublicText(message)
      .replace(/[\u0000-\u0020\u007f]+/g, ' ')
      .trim()
      .slice(0, MAX_BACKEND_ERROR_TEXT_LENGTH);
    return safeMessage
      ? new MethodGenerationRequestError(code, `批量测试生成失败：${safeMessage}`)
      : new Error(fallback);
  }

  private redactSensitive<T>(
    value: T,
    llmConfig?: SensitiveLlmConfigs,
    managedAccess?: ManagedBackendAccess
  ): T {
    const secrets = this.collectSensitiveValues(llmConfig, managedAccess);
    if (value === null || value === undefined || secrets.length === 0) {
      return value;
    }

    // 递归替换字符串值和对象字段名，不重新拼接 JSON，避免特殊字符破坏响应结构。
    const redactString = (current: string): string =>
      secrets.reduce((result, secret) => result.split(secret).join('[已隐藏]'), current);
    const redact = (current: unknown): unknown => {
      if (typeof current === 'string') {
        return redactString(current);
      }
      if (Array.isArray(current)) {
        return current.map(redact);
      }
      if (current && typeof current === 'object') {
        return Object.fromEntries(
          Object.entries(current).map(([key, item]) => [redactString(key), redact(item)])
        );
      }
      return current;
    };

    return redact(value) as T;
  }

  private collectSensitiveValues(
    llmConfig?: SensitiveLlmConfigs,
    managedAccess?: ManagedBackendAccess
  ): string[] {
    const secrets = new Set<string>();
    const configs: readonly BackendLlmConfig[] = llmConfig === undefined
      ? []
      : Array.isArray(llmConfig)
        ? llmConfig as readonly BackendLlmConfig[]
        : [llmConfig as BackendLlmConfig];
    for (const config of configs) {
      for (const credential of Object.values(config.credentials)) {
        if (credential.trim()) {
          secrets.add(credential);
        }
      }
    }

    const authorizationHeaders = managedAccess
      ? [
          managedAccess.agentServiceAuthorizationHeader,
          managedAccess.javaAnalyzerAuthorizationHeader
        ]
      : [];
    for (const header of authorizationHeaders) {
      if (!header.trim()) {
        continue;
      }
      secrets.add(header);
      const bearer = /^Bearer[\t ]+(.+)$/i.exec(header.trim());
      if (bearer?.[1]) {
        // 同时屏蔽完整 Authorization Header 与去掉 Bearer 前缀后的裸令牌。
        secrets.add(bearer[1]);
      }
    }

    // 先替换长字符串，避免短令牌先替换后留下 Header 前缀。
    return [...secrets].sort((left, right) => right.length - left.length);
  }

}

function decodeUnitTestTargetClassification(
  value: unknown,
  expectedTargetClass: string
): UnitTestTargetClassification {
  const record = strictRecord(value, [
    'targetClass', 'packageName', 'className', 'classKind', 'features'
  ], '目标类分类响应无效。');
  const features = strictRecord(record.features, [
    'lombokAnnotations', 'hasServiceAnnotation',
    'hasDependencyInjectionAnnotations', 'dataClassName'
  ], '目标类分类响应无效。');
  const targetClass = boundedText(record.targetClass, 2_000);
  const packageName = boundedText(record.packageName, 512, true);
  const className = boundedText(record.className, 512);
  const classKind = boundedText(record.classKind, 128);
  if (targetClass !== expectedTargetClass) {
    throw new Error('目标类分类响应无效。');
  }
  if (!Array.isArray(features.lombokAnnotations)
    || features.lombokAnnotations.length > 64
    || features.lombokAnnotations.some((item) => (
      typeof item !== 'string' || !item || item.length > 512
    ))
    || typeof features.hasServiceAnnotation !== 'boolean'
    || typeof features.hasDependencyInjectionAnnotations !== 'boolean'
    || typeof features.dataClassName !== 'boolean') {
    throw new Error('目标类分类响应无效。');
  }
  return {
    targetClass,
    packageName,
    className,
    classKind,
    features: {
      lombokAnnotations: [...features.lombokAnnotations] as string[],
      hasServiceAnnotation: features.hasServiceAnnotation,
      hasDependencyInjectionAnnotations: features.hasDependencyInjectionAnnotations,
      dataClassName: features.dataClassName
    }
  };
}

function decodeDirectModelGenerationResult(value: unknown): DirectModelGenerationResult {
  const record = strictRecord(value, [
    'result', 'provider', 'model', 'generationMode', 'usage'
  ], '批量测试生成响应无效。');
  const generationMode = record.generationMode === null
    ? null
    : boundedText(record.generationMode, 64);
  if (generationMode !== null && generationMode !== 'deterministic_prompt') {
    throw new Error('批量测试生成响应无效。');
  }
  let usage: DirectModelGenerationResult['usage'] = null;
  if (record.usage !== null) {
    const usageRecord = strictRecord(record.usage, [
      'inputTokens', 'outputTokens', 'totalTokens'
    ], '批量测试生成响应无效。');
    usage = {
      inputTokens: nullableNonNegativeInteger(usageRecord.inputTokens),
      outputTokens: nullableNonNegativeInteger(usageRecord.outputTokens),
      totalTokens: nullableNonNegativeInteger(usageRecord.totalTokens)
    };
  }
  return {
    result: boundedText(record.result, 1_000_000),
    provider: boundedText(record.provider, 256),
    model: boundedText(record.model, 1_024),
    generationMode,
    usage
  };
}

function decodeDirectModelGenerationStreamEvent(
  value: unknown
): DirectModelGenerationStreamEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('批量测试生成响应无效。');
  }
  const phase = (value as Record<string, unknown>).phase;
  if (phase === 'completed') {
    const record = strictRecord(
      value,
      ['phase', 'response'],
      '批量测试生成响应无效。'
    );
    return {
      phase,
      response: decodeDirectModelGenerationResult(record.response)
    };
  }
  if (phase === 'failed') {
    const record = strictRecord(
      value,
      ['phase', 'error'],
      '批量测试生成响应无效。'
    );
    const error = strictRecord(
      record.error,
      ['code', 'message', 'statusCode'],
      '批量测试生成响应无效。'
    );
    const code = boundedText(error.code, 128);
    const message = sanitizePublicText(boundedText(error.message, MAX_BACKEND_ERROR_TEXT_LENGTH))
      .replace(/[\u0000-\u0020\u007f]+/g, ' ')
      .trim();
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)
      || !message
      || !Number.isInteger(error.statusCode)
      || (error.statusCode as number) < 400
      || (error.statusCode as number) > 599
    ) {
      throw new Error('批量测试生成响应无效。');
    }
    return {
      phase,
      error: {
        code,
        message,
        statusCode: error.statusCode as number
      }
    };
  }
  throw new Error('批量测试生成响应无效。');
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  message: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(message);
  }
  return record;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value)) {
    throw new Error('后端响应字段无效。');
  }
  return value;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('批量测试生成响应无效。');
  }
  return value as number;
}
