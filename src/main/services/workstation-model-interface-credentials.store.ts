import { AtomicJsonStore } from './atomic-json-store.ts';

export type StoredWorkstationModelInterfaceCredentials = {
  schemaVersion: 2;
  values: Record<string, string>;
};

export class WorkstationModelInterfaceCredentialsStore {
  private readonly store: AtomicJsonStore<StoredWorkstationModelInterfaceCredentials>;

  constructor(storagePath: string) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateStoredWorkstationModelInterfaceCredentials,
      () => ({ schemaVersion: 2, values: {} })
    );
  }

  read(): Promise<StoredWorkstationModelInterfaceCredentials> { return this.store.read(); }
  async get(interfaceId: string): Promise<string | undefined> { return (await this.read()).values[interfaceId]; }
  async put(interfaceId: string, ciphertext: string): Promise<void> {
    await this.store.update((current) => ({ schemaVersion: 2, values: { ...current.values, [interfaceId]: ciphertext } }));
  }
  async delete(interfaceId: string): Promise<void> {
    await this.store.update((current) => {
      const values = { ...current.values };
      delete values[interfaceId];
      return { schemaVersion: 2, values };
    });
  }
}

export function validateStoredWorkstationModelInterfaceCredentials(value: unknown): StoredWorkstationModelInterfaceCredentials {
  if (!isPlainRecord(value) || value.schemaVersion !== 2 || !isPlainRecord(value.values)) {
    throw new TypeError('大模型接口凭证存储文件格式无效');
  }
  if (Object.keys(value).some((key) => !['schemaVersion', 'values'].includes(key))) {
    throw new TypeError('Invalid model interface credentials');
  }
  for (const [id, ciphertext] of Object.entries(value.values)) {
    if (!isUuid(id) || typeof ciphertext !== 'string' || !isBase64(ciphertext)) {
      throw new TypeError('大模型接口凭证存储文件格式无效');
    }
  }
  return value as StoredWorkstationModelInterfaceCredentials;
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
