import { AtomicJsonStore } from './atomic-json-store.ts';

export type StoredRagEmbeddingInterfaceCredentials = {
  schemaVersion: 1;
  values: Record<string, string>;
};

export class RagEmbeddingInterfaceCredentialsStore {
  private readonly store: AtomicJsonStore<StoredRagEmbeddingInterfaceCredentials>;

  constructor(storagePath: string) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateStoredRagEmbeddingInterfaceCredentials,
      () => ({ schemaVersion: 1, values: {} })
    );
  }

  read(): Promise<StoredRagEmbeddingInterfaceCredentials> {
    return this.store.read();
  }

  async get(interfaceId: string): Promise<string | undefined> {
    return (await this.read()).values[interfaceId];
  }

  async put(interfaceId: string, ciphertext: string): Promise<void> {
    await this.store.update((current) => ({
      schemaVersion: 1,
      values: { ...current.values, [interfaceId]: ciphertext }
    }));
  }

  async delete(interfaceId: string): Promise<void> {
    await this.store.update((current) => {
      const values = { ...current.values };
      delete values[interfaceId];
      return { schemaVersion: 1, values };
    });
  }
}

export function validateStoredRagEmbeddingInterfaceCredentials(
  value: unknown
): StoredRagEmbeddingInterfaceCredentials {
  if (
    !isPlainRecord(value)
    || value.schemaVersion !== 1
    || !isPlainRecord(value.values)
    || Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'values')
  ) {
    throw new TypeError('RAG Embedding 接口凭证文件格式无效。');
  }
  for (const [id, ciphertext] of Object.entries(value.values)) {
    if (!isUuid(id) || typeof ciphertext !== 'string' || !isBase64(ciphertext)) {
      throw new TypeError('RAG Embedding 接口凭证文件格式无效。');
    }
  }
  return value as StoredRagEmbeddingInterfaceCredentials;
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

function isBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
