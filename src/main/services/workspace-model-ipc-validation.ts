import { isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BackendSettings,
  BuildSettingsPathKind,
  SaveModelCallLogSettingsRequest,
  SaveWorkstationBuildSettingsRequest,
  CreateModelInterfaceRequest,
  UpdateModelInterfaceRequest,
  DeleteModelInterfaceRequest,
  SelectModelInterfaceRequest,
  ModelInterfaceConnectionTestRequest,
  CreateRagEmbeddingInterfaceRequest,
  UpdateRagEmbeddingInterfaceRequest,
  DeleteRagEmbeddingInterfaceRequest,
  SelectRagEmbeddingInterfaceRequest,
  RagEmbeddingInterfaceConnectionTestRequest
} from '../../shared/types.ts';
import { normalizeOptionalModelRequestParameters } from '../../shared/model-request-parameters.ts';

const MODEL_INTERFACE_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateCreateModelInterfaceRequest(value: unknown): CreateModelInterfaceRequest {
  const request = validateModelInterfaceRequest(value, false) as CreateModelInterfaceRequest;
  if (request.credentialMode === 'direct' && !request.apiKey?.trim()) throw new Error('请输入 API Key。');
  return request;
}

export function validateUpdateModelInterfaceRequest(value: unknown): UpdateModelInterfaceRequest {
  const request = requirePlainObject(value, '大模型接口更新请求无效');
  if (typeof request.id !== 'string' || !request.id.trim()) throw new Error('大模型接口 ID 无效');
  return { id: request.id, ...validateModelInterfaceRequest(request, true) } as UpdateModelInterfaceRequest;
}

export function validateDeleteModelInterfaceRequest(value: unknown): DeleteModelInterfaceRequest {
  const request = requirePlainObject(value, '大模型接口删除请求无效');
  requireOnlyKeys(request, ['id']);
  if (typeof request.id !== 'string' || !request.id.trim()) throw new Error('大模型接口 ID 无效');
  return { id: request.id };
}

export function validateSelectModelInterfaceRequest(value: unknown): SelectModelInterfaceRequest {
  const request = requirePlainObject(value, '大模型接口选择请求无效');
  requireOnlyKeys(request, ['id']);
  if (request.id !== null && typeof request.id !== 'string') throw new Error('大模型接口 ID 无效');
  return { id: request.id as string | null };
}

export function validateModelInterfaceConnectionTestRequest(value: unknown): ModelInterfaceConnectionTestRequest {
  const request = requirePlainObject(value, '大模型连接测试请求无效');
  requireOnlyKeys(request, ['interfaceId', 'baseUrl', 'model', 'credentialMode', 'environmentVariableName', 'apiKey']);
  if (request.interfaceId !== undefined && (typeof request.interfaceId !== 'string' || !request.interfaceId.trim())) {
    throw new Error('大模型接口 ID 无效');
  }
  const baseUrl = validateModelBaseUrl(request.baseUrl);
  if (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256) throw new Error('模型名无效');
  if (request.credentialMode !== 'direct' && request.credentialMode !== 'environment') throw new Error('凭证方式无效');
  if (request.credentialMode === 'environment' && !MODEL_INTERFACE_ENV_PATTERN.test(String(request.environmentVariableName ?? '').trim())) throw new Error('环境变量名无效');
  if (request.credentialMode === 'direct' && request.apiKey !== undefined && typeof request.apiKey !== 'string') throw new Error('API Key 无效');
  return {
    ...(typeof request.interfaceId === 'string' ? { interfaceId: request.interfaceId.trim() } : {}),
    baseUrl, model: request.model.trim(), credentialMode: request.credentialMode,
    ...(request.environmentVariableName !== undefined ? { environmentVariableName: String(request.environmentVariableName).trim() } : {}),
    ...(typeof request.apiKey === 'string' ? { apiKey: request.apiKey } : {})
  };
}

function validateModelInterfaceRequest(value: unknown, update: boolean): CreateModelInterfaceRequest {
  const request = requirePlainObject(value, '大模型接口请求无效');
  const keys = ['name', 'baseUrl', 'model', 'credentialMode', 'environmentVariableName', 'apiKey', 'requestParameters'];
  requireOnlyKeys(request, update ? [...keys, 'id'] : keys);
  if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 128) throw new Error('接口名称无效');
  const baseUrl = validateModelBaseUrl(request.baseUrl);
  if (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256) throw new Error('模型名无效');
  if (request.credentialMode !== 'direct' && request.credentialMode !== 'environment') throw new Error('凭证方式无效');
  if (request.environmentVariableName !== undefined && (typeof request.environmentVariableName !== 'string' || request.environmentVariableName.length > 256)) throw new Error('环境变量名无效');
  if (request.apiKey !== undefined && (typeof request.apiKey !== 'string' || request.apiKey.length > 16384)) throw new Error('API Key 无效');
  if (request.credentialMode === 'environment' && !MODEL_INTERFACE_ENV_PATTERN.test(String(request.environmentVariableName ?? '').trim())) throw new Error('环境变量名无效');
  if (request.credentialMode === 'direct' && request.environmentVariableName !== undefined) throw new Error('直接 API Key 模式不能填写环境变量名');
  const requestParameters = normalizeOptionalModelRequestParameters(request.requestParameters);
  return {
    name: request.name.trim(), baseUrl, model: request.model.trim(),
    credentialMode: request.credentialMode,
    ...(request.environmentVariableName !== undefined ? { environmentVariableName: request.environmentVariableName.trim() } : {}),
    ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
    ...(requestParameters ? { requestParameters } : {})
  };
}

export function validateCreateRagEmbeddingInterfaceRequest(
  value: unknown
): CreateRagEmbeddingInterfaceRequest {
  const request = validateRagEmbeddingInterfaceRequest(value, false);
  if (request.credentialMode === 'direct' && !request.apiKey?.trim()) {
    throw new Error('请输入 API Key。');
  }
  return request;
}

export function validateUpdateRagEmbeddingInterfaceRequest(
  value: unknown
): UpdateRagEmbeddingInterfaceRequest {
  const record = requirePlainObject(value, 'RAG Embedding 接口更新请求无效');
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('RAG Embedding 接口 ID 无效');
  }
  return {
    id: record.id.trim(),
    ...validateRagEmbeddingInterfaceRequest(record, true)
  };
}

export function validateDeleteRagEmbeddingInterfaceRequest(
  value: unknown
): DeleteRagEmbeddingInterfaceRequest {
  const record = requirePlainObject(value, 'RAG Embedding 接口删除请求无效');
  requireOnlyKeys(record, ['id']);
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('RAG Embedding 接口 ID 无效');
  }
  return { id: record.id.trim() };
}

export function validateSelectRagEmbeddingInterfaceRequest(
  value: unknown
): SelectRagEmbeddingInterfaceRequest {
  const record = requirePlainObject(value, 'RAG Embedding 接口选择请求无效');
  requireOnlyKeys(record, ['id']);
  if (record.id !== null && (typeof record.id !== 'string' || !record.id.trim())) {
    throw new Error('RAG Embedding 接口 ID 无效');
  }
  return { id: typeof record.id === 'string' ? record.id.trim() : null };
}

export function validateRagEmbeddingInterfaceConnectionTestRequest(
  value: unknown
): RagEmbeddingInterfaceConnectionTestRequest {
  const record = requirePlainObject(value, 'RAG Embedding 连接测试请求无效');
  requireOnlyKeys(record, [
    'interfaceId', 'baseUrl', 'embeddingModel', 'credentialMode',
    'environmentVariableName', 'apiKey'
  ]);
  if (
    record.interfaceId !== undefined
    && (typeof record.interfaceId !== 'string' || !record.interfaceId.trim())
  ) {
    throw new Error('RAG Embedding 接口 ID 无效');
  }
  return {
    ...(typeof record.interfaceId === 'string'
      ? { interfaceId: record.interfaceId.trim() }
      : {}),
    ...validateRagEmbeddingInterfaceFields(record, true)
  };
}

function validateRagEmbeddingInterfaceRequest(
  value: unknown,
  update: boolean
): CreateRagEmbeddingInterfaceRequest {
  const record = requirePlainObject(value, 'RAG Embedding 接口请求无效');
  const keys = [
    'name', 'baseUrl', 'embeddingModel', 'credentialMode',
    'environmentVariableName', 'apiKey'
  ];
  requireOnlyKeys(record, update ? [...keys, 'id'] : keys);
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 128) {
    throw new Error('RAG Embedding 接口名称无效');
  }
  return {
    name: record.name.trim(),
    ...validateRagEmbeddingInterfaceFields(record, update)
  };
}

function validateRagEmbeddingInterfaceFields(
  record: Record<string, unknown>,
  allowMissingDirectApiKey: boolean
): Omit<CreateRagEmbeddingInterfaceRequest, 'name'> {
  const baseUrl = validateModelBaseUrl(record.baseUrl);
  if (
    typeof record.embeddingModel !== 'string'
    || !record.embeddingModel.trim()
    || record.embeddingModel.length > 256
  ) {
    throw new Error('RAG Embedding 模型名称无效');
  }
  if (record.credentialMode !== 'direct' && record.credentialMode !== 'environment') {
    throw new Error('RAG Embedding 凭证方式无效');
  }
  if (record.apiKey !== undefined && (typeof record.apiKey !== 'string' || record.apiKey.length > 16_384)) {
    throw new Error('API Key 无效');
  }
  if (record.credentialMode === 'environment') {
    const environmentVariableName = typeof record.environmentVariableName === 'string'
      ? record.environmentVariableName.trim()
      : '';
    if (!MODEL_INTERFACE_ENV_PATTERN.test(environmentVariableName) || record.apiKey !== undefined) {
      throw new Error('RAG Embedding 环境变量名无效');
    }
    return {
      baseUrl,
      embeddingModel: record.embeddingModel.trim(),
      credentialMode: 'environment',
      environmentVariableName
    };
  }
  if (record.environmentVariableName !== undefined) {
    throw new Error('直接 API Key 模式不能填写环境变量名');
  }
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : undefined;
  if (!allowMissingDirectApiKey && !apiKey?.trim()) throw new Error('请输入 API Key。');
  return {
    baseUrl,
    embeddingModel: record.embeddingModel.trim(),
    credentialMode: 'direct',
    ...(apiKey !== undefined ? { apiKey } : {})
  };
}


export type IpcSenderTrustInput = {
  senderUrl: string;
  isTopFrame: boolean;
  isPackaged: boolean;
  developmentRendererUrl?: string;
  packagedRendererFile: string;
};


export function isTrustedWorkspaceModelIpcSender(
  input: IpcSenderTrustInput
): boolean {
  if (!input.isTopFrame) return false;

  let sender: URL;
  try {
    sender = new URL(input.senderUrl);
  } catch {
    return false;
  }

  if (!input.isPackaged && input.developmentRendererUrl) {
    let trusted: URL;
    try {
      trusted = new URL(input.developmentRendererUrl);
    } catch {
      return false;
    }
    if (
      !['http:', 'https:'].includes(trusted.protocol) ||
      sender.protocol !== trusted.protocol
    ) {
      return false;
    }
    return sender.origin === trusted.origin;
  }

  if (sender.protocol !== 'file:') return false;
  try {
    return (
      normalizeFilePath(fileURLToPath(sender)) ===
      normalizeFilePath(input.packagedRendererFile)
    );
  } catch {
    return false;
  }
}


export function isTrustedWorkspaceNavigation(
  input: Omit<IpcSenderTrustInput, 'isTopFrame'>
): boolean {
  return isTrustedWorkspaceModelIpcSender({
    ...input,
    isTopFrame: true
  });
}


export function denyNewWorkspaceWindow(): { action: 'deny' } {
  return { action: 'deny' };
}


export function validateBackendSettingsSaveRequest(
  value: unknown
): {
  agentServiceUrl: string;
  javaAnalyzerUrl: string;
} {
  const settings = requirePlainObject(value, '后端设置无效');
  requireOnlyKeys(
    settings,
    ['agentServiceUrl', 'javaAnalyzerUrl']
  );
  return {
    agentServiceUrl: validateBackendServiceUrl(
      settings.agentServiceUrl,
      'Agent Service'
    ),
    javaAnalyzerUrl: validateBackendServiceUrl(
      settings.javaAnalyzerUrl,
      'Java Analyzer'
    )
  };
}


export function resolvePersistedBackendSettings(
  value: unknown,
  defaults: BackendSettings
): BackendSettings {
  try {
    return validateBackendSettingsSaveRequest(value);
  } catch {
    return { ...defaults };
  }
}


export async function runTrustedBackendSettingsAction<TResult>(
  input: {
    senderTrusted: boolean;
    run: () => Promise<TResult>;
  }
): Promise<TResult> {
  if (!input.senderTrusted) throw new Error('请求来源无效');
  return input.run();
}


export function validateSaveWorkstationBuildSettingsRequest(
  value: unknown
): SaveWorkstationBuildSettingsRequest {
  const request = requirePlainObject(
    value,
    '工作站构建环境设置请求无效'
  );
  requireOnlyKeys(
    request,
    ['mavenHome', 'javaHome', 'settingsPath', 'localRepository']
  );
  return {
    mavenHome: validateAbsoluteSettingsPath(
      request.mavenHome,
      'Maven Home'
    ),
    javaHome: validateAbsoluteSettingsPath(
      request.javaHome,
      'Java Home'
    ),
    ...(request.settingsPath === undefined
      ? {}
      : {
          settingsPath: validateAbsoluteSettingsPath(
            request.settingsPath,
            'Maven settings'
          )
        }),
    ...(request.localRepository === undefined
      ? {}
      : {
          localRepository: validateAbsoluteSettingsPath(
            request.localRepository,
            'Maven 本地仓库'
          )
        })
  };
}


export function validateWorkstationBuildSettingsPathKind(
  value: unknown
): BuildSettingsPathKind {
  if (
    ![
      'mavenHome',
      'javaHome',
      'settingsPath',
      'localRepository'
    ].includes(String(value))
  ) {
    throw new Error('构建环境路径类型无效');
  }
  return value as BuildSettingsPathKind;
}


export function validateWorkstationMavenHome(
  value: unknown
): string {
  return validateAbsoluteSettingsPath(value, 'Maven Home');
}

export function validateSaveModelCallLogSettingsRequest(
  value: unknown
): SaveModelCallLogSettingsRequest {
  const request = requirePlainObject(
    value,
    '模型调用记录设置请求无效'
  );
  requireOnlyKeys(request, ['enabled', 'directory']);
  if (typeof request.enabled !== 'boolean') {
    throw new Error('模型调用记录启用状态无效');
  }
  const directory = request.directory === undefined
    ? undefined
    : validateAbsoluteSettingsPath(
        request.directory,
        '模型调用记录目录'
      );
  if (request.enabled && !directory) {
    throw new Error('启用模型调用记录前必须选择存储目录');
  }
  return {
    enabled: request.enabled,
    ...(directory ? { directory } : {})
  };
}

export function validateWorkspaceRoot(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    !isAbsolute(value)
  ) {
    throw new Error('工作区路径无效');
  }
  return value;
}


function requirePlainObject(
  value: unknown,
  message: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}


function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key))
  ) {
    throw new Error('请求包含不允许的字段');
  }
}


function validateAbsoluteSettingsPath(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    !isAbsolute(value.trim())
  ) {
    throw new Error(`${label} 路径无效`);
  }
  return normalize(value.trim());
}

function requireTrimmedText(
  value: unknown,
  message: string,
  maximumLength: number
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength
  ) {
    throw new Error(message);
  }
  return value.trim();
}


function validateModelBaseUrl(value: unknown): string {
  const raw = requireTrimmedText(
    value,
    'Base URL 格式无效',
    2048
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Base URL 格式无效');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Base URL 不允许包含用户信息、query 或 fragment'
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      isLoopbackHost(url.hostname)
    )
  ) {
    throw new Error('非本机 Base URL 必须使用 HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}


function validateBackendServiceUrl(
  value: unknown,
  serviceName: string
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2048 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error(`${serviceName} 地址无效`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${serviceName} 地址无效`);
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${serviceName} 地址无效`);
  }
  if (
    url.protocol === 'http:' &&
    !isLoopbackHost(url.hostname)
  ) {
    throw new Error(
      `${serviceName} 地址必须使用 HTTPS 或本机回环地址`
    );
  }
  return url.toString().replace(/\/$/, '');
}


function isLoopbackHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalizedHostname)
  );
}


function normalizeFilePath(value: string): string {
  return resolve(normalize(value))
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}
