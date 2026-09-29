import { randomUUID } from 'node:crypto';
import type {
  BackendLlmConfig,
  CreateModelInterfaceRequest,
  DeleteModelInterfaceRequest,
  ModelInterfaceConnectionTestRequest,
  ModelInterfaceView,
  ResolvedWorkstationModelRuntime,
  SelectModelInterfaceRequest,
  UpdateModelInterfaceRequest,
  WorkstationModelInterfacesView
} from '../../shared/types.ts';
import type { CredentialCipher } from './credential-cipher.ts';
import {
  WorkstationModelInterfacesStore,
  type StoredModelInterface,
  type StoredWorkstationModelInterfaces
} from './workstation-model-interfaces.store.ts';
import { WorkstationModelInterfaceCredentialsStore } from './workstation-model-interface-credentials.store.ts';
import { resolveSystemEnvironmentVariable } from './system-environment-variable-resolver.ts';
import { normalizeOptionalModelRequestParameters } from '../../shared/model-request-parameters.ts';

const NAME_MAX_LENGTH = 128;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class WorkstationModelInterfacesService {
  private queue: Promise<void> = Promise.resolve();
  private readonly settingsStore: WorkstationModelInterfacesStore;
  private readonly credentialsStore: WorkstationModelInterfaceCredentialsStore;
  private readonly cipher: CredentialCipher;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    settingsStore: WorkstationModelInterfacesStore,
    credentialsStore: WorkstationModelInterfaceCredentialsStore,
    cipher: CredentialCipher,
    environment: NodeJS.ProcessEnv = process.env
  ) {
    this.settingsStore = settingsStore;
    this.credentialsStore = credentialsStore;
    this.cipher = cipher;
    this.environment = environment;
  }

  async getView(): Promise<WorkstationModelInterfacesView> {
    const settings = await this.settingsStore.read();
    return toView(settings, this.cipher.isEncryptionAvailable());
  }

  async create(request: CreateModelInterfaceRequest): Promise<WorkstationModelInterfacesView> {
    return this.enqueue(async () => {
      const normalized = validateRequest(request);
      const id = randomUUID();
      const now = new Date().toISOString();
      const item: StoredModelInterface = { id, ...normalized, createdAt: now, updatedAt: now };
      const current = await this.settingsStore.read();
      assertUniqueName(current.interfaces, item.name);
      await this.saveCredentialIfNeeded(id, normalized.credentialMode, request.apiKey);
      await this.settingsStore.update((value) => ({ ...value, interfaces: { ...value.interfaces, [id]: item } }));
      return toView(await this.settingsStore.read(), this.cipher.isEncryptionAvailable());
    });
  }

  async update(request: UpdateModelInterfaceRequest): Promise<WorkstationModelInterfacesView> {
    return this.enqueue(async () => {
      const current = await this.settingsStore.read();
      const existing = current.interfaces[request.id];
      if (!existing) throw new Error('大模型接口不存在。');
      const normalized = validateRequest(request);
      assertUniqueName(current.interfaces, normalized.name, request.id);
      const { requestParameters: _previousRequestParameters, ...existingWithoutRequestParameters } = existing;
      const next: StoredModelInterface = {
        ...existingWithoutRequestParameters,
        ...normalized,
        updatedAt: new Date().toISOString()
      };
      if (normalized.credentialMode === 'direct') {
        if (request.apiKey?.trim()) await this.saveCredentialIfNeeded(request.id, 'direct', request.apiKey);
        else if (existing.credentialMode === 'environment') throw new Error('API key is required');
      } else {
        await this.credentialsStore.delete(request.id);
      }
      await this.settingsStore.update((value) => ({ ...value, interfaces: { ...value.interfaces, [request.id]: next } }));
      return toView(await this.settingsStore.read(), this.cipher.isEncryptionAvailable());
    });
  }

  async delete(request: DeleteModelInterfaceRequest): Promise<WorkstationModelInterfacesView> {
    return this.enqueue(async () => {
      const current = await this.settingsStore.read();
      if (!current.interfaces[request.id]) throw new Error('大模型接口不存在。');
      const interfaces = { ...current.interfaces };
      delete interfaces[request.id];
      await this.credentialsStore.delete(request.id);
      const next: StoredWorkstationModelInterfaces = {
        schemaVersion: 2,
        interfaces,
        activeInterfaceId: current.activeInterfaceId === request.id
          ? null
          : current.activeInterfaceId
      };
      await this.settingsStore.write(next);
      return toView(next, this.cipher.isEncryptionAvailable());
    });
  }

  async select(request: SelectModelInterfaceRequest): Promise<WorkstationModelInterfacesView> {
    return this.enqueue(async () => {
      const current = await this.settingsStore.read();
      if (request.id !== null && request.id !== undefined && !current.interfaces[request.id]) {
        throw new Error('大模型接口不存在。');
      }
      const next = { ...current };
      next.activeInterfaceId = request.id ?? null;
      await this.settingsStore.write(next);
      return toView(next, this.cipher.isEncryptionAvailable());
    });
  }

  async resolveForGeneration(): Promise<ResolvedWorkstationModelRuntime> {
    const settings = await this.settingsStore.read();
    if (!settings.activeInterfaceId) throw new Error('请先选择一个大模型接口。');
    const item = settings.interfaces[settings.activeInterfaceId];
    if (!item) throw new Error('当前大模型接口不存在。');
    let apiKey: string;
    let credentialEnvironmentVariable: string | undefined;
    if (item.credentialMode === 'environment') {
      credentialEnvironmentVariable = item.environmentVariableName;
      apiKey = await resolveSystemEnvironmentVariable(item.environmentVariableName ?? '', { environment: this.environment }) ?? '';
      if (!apiKey) throw new Error(`环境变量 ${item.environmentVariableName} 未设置或为空。`);
    } else {
      const ciphertext = await this.credentialsStore.get(item.id);
      if (!ciphertext) throw new Error('当前接口尚未配置 API Key。');
      try { apiKey = this.cipher.decryptString(Buffer.from(ciphertext, 'base64')); }
      catch { throw new Error('当前接口的 API Key 无法解密，请重新配置。'); }
    }
    const llmConfig: BackendLlmConfig = {
      provider: 'custom_openai', model: item.model, baseUrl: item.baseUrl, credentials: { apiKey },
      ...(item.requestParameters ? { requestParameters: item.requestParameters } : {})
    };
    return { interfaceId: item.id, interfaceName: item.name, credentialEnvironmentVariable, llmConfig };
  }

  /** Resolve an already stored direct credential for a connection probe. */
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

  async flush(): Promise<void> { await this.queue; }

  private async saveCredentialIfNeeded(id: string, mode: 'direct' | 'environment', apiKey?: string): Promise<void> {
    if (mode === 'environment') return;
    if (!apiKey?.trim()) throw new Error('请输入 API Key。');
    if (!this.cipher.isEncryptionAvailable()) throw new Error('当前系统安全存储不可用，无法安全保存 API Key。');
    const ciphertext = this.cipher.encryptString(apiKey.trim()).toString('base64');
    await this.credentialsStore.put(id, ciphertext);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function validateRequest(request: CreateModelInterfaceRequest): Omit<StoredModelInterface, 'id' | 'createdAt' | 'updatedAt'> {
  const name = request.name.trim();
  const model = request.model.trim();
  const baseUrl = normalizeBaseUrl(request.baseUrl);
  const requestParameters = normalizeOptionalModelRequestParameters(request.requestParameters);
  if (!name || name.length > NAME_MAX_LENGTH) throw new Error('接口名称不能为空且不能超过 128 个字符。');
  if (!model || model.length > 256) throw new Error('模型名不能为空且不能超过 256 个字符。');
  if (!isValidBaseUrl(baseUrl)) throw new Error('Base URL 无效。');
  if (request.credentialMode === 'environment') {
    const variable = request.environmentVariableName?.trim() ?? '';
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(variable)) throw new Error('环境变量名格式无效。');
    return {
      name, model, baseUrl, credentialMode: 'environment', environmentVariableName: variable,
      ...(requestParameters ? { requestParameters } : {})
    };
  }
  return {
    name, model, baseUrl, credentialMode: 'direct',
    ...(requestParameters ? { requestParameters } : {})
  };
}

function assertUniqueName(items: Record<string, StoredModelInterface>, name: string, excludeId?: string): void {
  const normalized = name.trim().toLocaleLowerCase();
  if (Object.values(items).some((item) => item.id !== excludeId && item.name.trim().toLocaleLowerCase() === normalized)) {
    throw new Error('接口名称不能重复。');
  }
}
function normalizeBaseUrl(value: string): string { return value.trim().replace(/\/+$/, ''); }
function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'http:' && (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host));
  } catch { return false; }
}
function toView(settings: StoredWorkstationModelInterfaces, secureStorageAvailable: boolean): WorkstationModelInterfacesView {
  return {
    schemaVersion: 2,
    activeInterfaceId: settings.activeInterfaceId ?? null,
    interfaces: Object.values(settings.interfaces).sort((a, b) => a.name.localeCompare(b.name)).map((item) => ({
      id: item.id, name: item.name, baseUrl: item.baseUrl, model: item.model,
      credentialMode: item.credentialMode, ...(item.environmentVariableName ? { environmentVariableName: item.environmentVariableName } : {}),
      ...(item.requestParameters ? { requestParameters: item.requestParameters } : {}),
      hasStoredApiKey: item.credentialMode === 'direct', createdAt: item.createdAt, updatedAt: item.updatedAt
    })),
    secureStorageAvailable
  };
}
