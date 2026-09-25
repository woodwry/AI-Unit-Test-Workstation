import { randomUUID } from 'node:crypto';
import type {
  CreateRagEmbeddingInterfaceRequest,
  DeleteRagEmbeddingInterfaceRequest,
  RagEmbeddingInterfaceCredentialMode,
  RagEmbeddingInterfaceConnectionTestRequest,
  RagEmbeddingInterfacesView,
  ResolvedRagEmbeddingRuntime,
  SelectRagEmbeddingInterfaceRequest,
  UpdateRagEmbeddingInterfaceRequest
} from '../../shared/types.ts';
import type { CredentialCipher } from './credential-cipher.ts';
import { RagEmbeddingInterfaceCredentialsStore } from './rag-embedding-interface-credentials.store.ts';
import {
  RagEmbeddingInterfacesStore,
  type StoredRagEmbeddingInterface,
  type StoredRagEmbeddingInterfaces
} from './rag-embedding-interfaces.store.ts';
import { resolveSystemEnvironmentVariable } from './system-environment-variable-resolver.ts';

const NAME_MAX_LENGTH = 128;
const MODEL_MAX_LENGTH = 256;
const BASE_URL_MAX_LENGTH = 2048;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type {
  CreateRagEmbeddingInterfaceRequest,
  DeleteRagEmbeddingInterfaceRequest,
  RagEmbeddingInterfaceCredentialMode,
  RagEmbeddingInterfaceView,
  RagEmbeddingInterfacesView,
  ResolvedRagEmbeddingRuntime,
  SelectRagEmbeddingInterfaceRequest,
  UpdateRagEmbeddingInterfaceRequest
} from '../../shared/types.ts';

export class RagEmbeddingInterfacesService {
  private queue: Promise<void> = Promise.resolve();
  private readonly settingsStore: RagEmbeddingInterfacesStore;
  private readonly credentialsStore: RagEmbeddingInterfaceCredentialsStore;
  private readonly cipher: CredentialCipher;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    settingsStore: RagEmbeddingInterfacesStore,
    credentialsStore: RagEmbeddingInterfaceCredentialsStore,
    cipher: CredentialCipher,
    environment: NodeJS.ProcessEnv = process.env
  ) {
    this.settingsStore = settingsStore;
    this.credentialsStore = credentialsStore;
    this.cipher = cipher;
    this.environment = environment;
  }

  async getView(): Promise<RagEmbeddingInterfacesView> {
    const [settings, credentials] = await Promise.all([
      this.settingsStore.read(),
      this.credentialsStore.read()
    ]);
    const activeInterfaceConfigured = await this.resolveRuntimeFrom(settings)
      .then((runtime) => runtime !== null, () => false);
    return toView(
      settings,
      credentials.values,
      this.cipher.isEncryptionAvailable(),
      activeInterfaceConfigured
    );
  }

  /** Semantic alias used by callers that treat the service as a catalog. */
  list(): Promise<RagEmbeddingInterfacesView> {
    return this.getView();
  }

  async create(request: CreateRagEmbeddingInterfaceRequest): Promise<RagEmbeddingInterfacesView> {
    return this.enqueue(async () => {
      const normalized = validateRequest(request);
      const current = await this.settingsStore.read();
      assertUniqueName(current.interfaces, normalized.name);

      const id = randomUUID();
      const now = new Date().toISOString();
      const item: StoredRagEmbeddingInterface = {
        id,
        ...normalized,
        createdAt: now,
        updatedAt: now
      };
      await this.saveCredentialIfNeeded(id, normalized.credentialMode, request.apiKey);
      try {
        await this.settingsStore.update((value) => ({
          ...value,
          interfaces: { ...value.interfaces, [id]: item }
        }));
      } catch (error) {
        await this.credentialsStore.delete(id).catch(() => undefined);
        throw error;
      }
      return this.getView();
    });
  }

  async update(request: UpdateRagEmbeddingInterfaceRequest): Promise<RagEmbeddingInterfacesView> {
    return this.enqueue(async () => {
      const current = await this.settingsStore.read();
      const existing = current.interfaces[request.id];
      if (!existing) throw new Error('RAG Embedding 接口不存在。');

      const normalized = validateRequest(request);
      assertUniqueName(current.interfaces, normalized.name, request.id);
      const providedApiKey = normalizeApiKey(request.apiKey);
      const storedCredential = await this.credentialsStore.get(request.id);
      if (
        normalized.credentialMode === 'direct'
        && !providedApiKey
        && (existing.credentialMode !== 'direct' || !storedCredential)
      ) {
        throw new Error('切换到 API Key 模式时必须输入 API Key。');
      }

      if (normalized.credentialMode === 'direct' && providedApiKey) {
        await this.saveEncryptedCredential(request.id, providedApiKey);
      } else if (normalized.credentialMode === 'environment') {
        await this.credentialsStore.delete(request.id);
      }

      const next: StoredRagEmbeddingInterface = {
        ...existing,
        ...normalized,
        updatedAt: new Date().toISOString()
      };
      await this.settingsStore.update((value) => ({
        ...value,
        interfaces: { ...value.interfaces, [request.id]: next }
      }));
      return this.getView();
    });
  }

  async delete(request: DeleteRagEmbeddingInterfaceRequest): Promise<RagEmbeddingInterfacesView> {
    return this.enqueue(async () => {
      const current = await this.settingsStore.read();
      if (!current.interfaces[request.id]) throw new Error('RAG Embedding 接口不存在。');

      const interfaces = { ...current.interfaces };
      delete interfaces[request.id];
      await this.credentialsStore.delete(request.id);
      const next: StoredRagEmbeddingInterfaces = {
        schemaVersion: 1,
        activeInterfaceId: current.activeInterfaceId === request.id
          ? null
          : current.activeInterfaceId,
        interfaces
      };
      await this.settingsStore.write(next);
      return this.getView();
    });
  }

  async select(request: SelectRagEmbeddingInterfaceRequest): Promise<RagEmbeddingInterfacesView> {
    return this.enqueue(async () => {
      const current = await this.settingsStore.read();
      if (request.id !== null && !current.interfaces[request.id]) {
        throw new Error('RAG Embedding 接口不存在。');
      }
      const next: StoredRagEmbeddingInterfaces = {
        ...current,
        activeInterfaceId: request.id
      };
      await this.settingsStore.write(next);
      return this.getView();
    });
  }

  async resolveRuntime(): Promise<ResolvedRagEmbeddingRuntime | null> {
    const settings = await this.settingsStore.read();
    return this.resolveRuntimeFrom(settings);
  }

  private async resolveRuntimeFrom(
    settings: StoredRagEmbeddingInterfaces
  ): Promise<ResolvedRagEmbeddingRuntime | null> {
    if (!settings.activeInterfaceId) return null;
    const item = settings.interfaces[settings.activeInterfaceId];
    if (!item) throw new Error('当前 RAG Embedding 接口不存在。');

    let apiKey: string;
    let credentialEnvironmentVariable: string | undefined;
    if (item.credentialMode === 'environment') {
      credentialEnvironmentVariable = item.environmentVariableName;
      apiKey = await resolveSystemEnvironmentVariable(
        item.environmentVariableName ?? '',
        { environment: this.environment }
      ) ?? '';
      if (!apiKey) {
        throw new Error(`环境变量 ${item.environmentVariableName} 未设置或为空。`);
      }
    } else {
      const stored = await this.resolveStoredApiKey(item.id);
      if (!stored) throw new Error('当前 RAG Embedding 接口尚未配置 API Key。');
      apiKey = stored;
    }

    return {
      interfaceId: item.id,
      interfaceName: item.name,
      ...(credentialEnvironmentVariable ? { credentialEnvironmentVariable } : {}),
      embeddingModel: item.embeddingModel,
      embeddingConfig: {
        provider: 'custom_openai',
        model: item.embeddingModel,
        baseUrl: item.baseUrl,
        credentials: { apiKey }
      }
    };
  }

  async resolveStoredApiKey(interfaceId: string): Promise<string | undefined> {
    const settings = await this.settingsStore.read();
    const item = settings.interfaces[interfaceId];
    if (!item || item.credentialMode !== 'direct') return undefined;
    const ciphertext = await this.credentialsStore.get(interfaceId);
    if (!ciphertext) return undefined;
    try {
      return this.cipher.decryptString(Buffer.from(ciphertext, 'base64')).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async resolveStoredApiKeyForConnectionTest(
    request: RagEmbeddingInterfaceConnectionTestRequest
  ): Promise<string | undefined> {
    if (!request.interfaceId || request.credentialMode !== 'direct') return undefined;
    return this.enqueue(async () => {
      const settings = await this.settingsStore.read();
      const item = settings.interfaces[request.interfaceId ?? ''];
      if (
        !item
        || item.credentialMode !== 'direct'
        || item.baseUrl !== normalizeBaseUrl(request.baseUrl)
        || item.embeddingModel !== normalizeText(request.embeddingModel)
      ) {
        return undefined;
      }
      const ciphertext = await this.credentialsStore.get(item.id);
      if (!ciphertext) return undefined;
      try {
        return this.cipher.decryptString(Buffer.from(ciphertext, 'base64')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async saveCredentialIfNeeded(
    id: string,
    credentialMode: RagEmbeddingInterfaceCredentialMode,
    apiKey?: string
  ): Promise<void> {
    if (credentialMode === 'environment') return;
    const normalized = normalizeApiKey(apiKey);
    if (!normalized) throw new Error('请输入 API Key。');
    await this.saveEncryptedCredential(id, normalized);
  }

  private async saveEncryptedCredential(id: string, apiKey: string): Promise<void> {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('当前系统安全存储不可用，无法安全保存 API Key。');
    }
    let ciphertext: string;
    try {
      ciphertext = this.cipher.encryptString(apiKey).toString('base64');
    } catch {
      throw new Error('API Key 安全加密失败，请重试。');
    }
    await this.credentialsStore.put(id, ciphertext);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function validateRequest(
  request: CreateRagEmbeddingInterfaceRequest
): Omit<StoredRagEmbeddingInterface, 'id' | 'createdAt' | 'updatedAt'> {
  const name = normalizeText(request.name);
  const embeddingModel = normalizeText(request.embeddingModel);
  const baseUrl = normalizeBaseUrl(request.baseUrl);
  if (!name || name.length > NAME_MAX_LENGTH || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new Error('接口名称不能为空且不能超过 128 个字符。');
  }
  if (
    !embeddingModel
    || embeddingModel.length > MODEL_MAX_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(embeddingModel)
  ) {
    throw new Error('Embedding 模型不能为空且不能超过 256 个字符。');
  }
  if (
    baseUrl.length > BASE_URL_MAX_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(baseUrl)
    || !isValidBaseUrl(baseUrl)
  ) {
    throw new Error('Base URL 无效。');
  }
  if (request.credentialMode === 'environment') {
    const environmentVariableName = normalizeText(request.environmentVariableName);
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(environmentVariableName)) {
      throw new Error('环境变量名格式无效。');
    }
    return {
      name,
      baseUrl,
      embeddingModel,
      credentialMode: 'environment',
      environmentVariableName
    };
  }
  if (request.credentialMode !== 'direct') {
    throw new Error('凭证模式无效。');
  }
  return { name, baseUrl, embeddingModel, credentialMode: 'direct' };
}

function assertUniqueName(
  items: Record<string, StoredRagEmbeddingInterface>,
  name: string,
  excludeId?: string
): void {
  const normalized = name.toLocaleLowerCase();
  if (Object.values(items).some((item) => (
    item.id !== excludeId
    && item.name.trim().toLocaleLowerCase() === normalized
  ))) {
    throw new Error('RAG Embedding 接口名称不能重复。');
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeApiKey(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeBaseUrl(value: unknown): string {
  return normalizeText(value).replace(/\/+$/, '');
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'http:'
      && (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host));
  } catch {
    return false;
  }
}

function toView(
  settings: StoredRagEmbeddingInterfaces,
  credentials: Record<string, string>,
  secureStorageAvailable: boolean,
  activeInterfaceConfigured: boolean
): RagEmbeddingInterfacesView {
  return {
    schemaVersion: 1,
    activeInterfaceId: settings.activeInterfaceId,
    activeInterfaceConfigured,
    interfaces: Object.values(settings.interfaces)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((item) => ({
        id: item.id,
        name: item.name,
        baseUrl: item.baseUrl,
        embeddingModel: item.embeddingModel,
        credentialMode: item.credentialMode,
        ...(item.environmentVariableName
          ? { environmentVariableName: item.environmentVariableName }
          : {}),
        hasStoredApiKey: item.credentialMode === 'direct' && Boolean(credentials[item.id]),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
    secureStorageAvailable
  };
}
