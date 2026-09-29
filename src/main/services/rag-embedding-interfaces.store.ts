import { AtomicJsonStore } from './atomic-json-store.ts';

export type StoredRagEmbeddingInterface = {
  id: string;
  name: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: 'direct' | 'environment';
  environmentVariableName?: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredRagEmbeddingInterfaces = {
  schemaVersion: 1;
  activeInterfaceId: string | null;
  interfaces: Record<string, StoredRagEmbeddingInterface>;
};

const ALLOWED_ROOT_KEYS = ['schemaVersion', 'activeInterfaceId', 'interfaces'];
const ALLOWED_INTERFACE_KEYS = [
  'id',
  'name',
  'baseUrl',
  'embeddingModel',
  'credentialMode',
  'environmentVariableName',
  'createdAt',
  'updatedAt'
];
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class RagEmbeddingInterfacesStore {
  private readonly store: AtomicJsonStore<StoredRagEmbeddingInterfaces>;

  constructor(storagePath: string) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateStoredRagEmbeddingInterfaces,
      () => ({ schemaVersion: 1, activeInterfaceId: null, interfaces: {} })
    );
  }

  read(): Promise<StoredRagEmbeddingInterfaces> {
    return this.store.read();
  }

  write(value: StoredRagEmbeddingInterfaces): Promise<void> {
    return this.store.write(value);
  }

  update(
    updater: (
      value: StoredRagEmbeddingInterfaces
    ) => StoredRagEmbeddingInterfaces | Promise<StoredRagEmbeddingInterfaces>
  ): Promise<StoredRagEmbeddingInterfaces> {
    return this.store.update(updater);
  }
}

export function validateStoredRagEmbeddingInterfaces(
  value: unknown
): StoredRagEmbeddingInterfaces {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !isPlainRecord(value.interfaces)) {
    throw new TypeError('RAG Embedding 接口配置文件格式无效。');
  }
  if (Object.keys(value).some((key) => !ALLOWED_ROOT_KEYS.includes(key))) {
    throw new TypeError('RAG Embedding 接口配置文件格式无效。');
  }
  if (value.activeInterfaceId !== null && !isUuid(value.activeInterfaceId)) {
    throw new TypeError('RAG Embedding 接口配置文件格式无效。');
  }

  const interfaces: Record<string, StoredRagEmbeddingInterface> = {};
  for (const [id, rawItem] of Object.entries(value.interfaces)) {
    if (!isUuid(id) || !isPlainRecord(rawItem)) {
      throw new TypeError('RAG Embedding 接口配置文件格式无效。');
    }
    if (Object.keys(rawItem).some((key) => !ALLOWED_INTERFACE_KEYS.includes(key))) {
      throw new TypeError('RAG Embedding 接口配置文件格式无效。');
    }
    if (
      rawItem.id !== id
      || !isBoundedText(rawItem.name, 128)
      || !isBoundedText(rawItem.baseUrl, 2048)
      || !isBoundedText(rawItem.embeddingModel, 256)
      || (rawItem.credentialMode !== 'direct' && rawItem.credentialMode !== 'environment')
      || typeof rawItem.createdAt !== 'string'
      || typeof rawItem.updatedAt !== 'string'
    ) {
      throw new TypeError('RAG Embedding 接口配置文件格式无效。');
    }
    if (
      rawItem.credentialMode === 'environment'
      && (
        typeof rawItem.environmentVariableName !== 'string'
        || !ENVIRONMENT_VARIABLE_PATTERN.test(rawItem.environmentVariableName)
      )
    ) {
      throw new TypeError('RAG Embedding 接口配置文件格式无效。');
    }
    if (rawItem.credentialMode === 'direct' && rawItem.environmentVariableName !== undefined) {
      throw new TypeError('RAG Embedding 接口配置文件格式无效。');
    }
    interfaces[id] = rawItem as StoredRagEmbeddingInterface;
  }

  if (value.activeInterfaceId !== null && !interfaces[value.activeInterfaceId]) {
    throw new TypeError('RAG Embedding 接口配置文件格式无效。');
  }
  return {
    schemaVersion: 1,
    activeInterfaceId: value.activeInterfaceId,
    interfaces
  };
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001F\u007F]/.test(value);
}
