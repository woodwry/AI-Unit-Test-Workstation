import { AtomicJsonStore } from './atomic-json-store.ts';
import type { ModelRequestParameters } from '../../shared/types.ts';
import { normalizeOptionalModelRequestParameters } from '../../shared/model-request-parameters.ts';

export type StoredModelInterface = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  credentialMode: 'direct' | 'environment';
  environmentVariableName?: string;
  requestParameters?: ModelRequestParameters;
  createdAt: string;
  updatedAt: string;
};

export type StoredWorkstationModelInterfaces = {
  schemaVersion: 2;
  activeInterfaceId: string | null;
  interfaces: Record<string, StoredModelInterface>;
};

export class WorkstationModelInterfacesStore {
  private readonly store: AtomicJsonStore<StoredWorkstationModelInterfaces>;

  constructor(storagePath: string) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateStoredWorkstationModelInterfaces,
      () => ({ schemaVersion: 2, activeInterfaceId: null, interfaces: {} })
    );
  }

  read(): Promise<StoredWorkstationModelInterfaces> { return this.store.read(); }
  write(value: StoredWorkstationModelInterfaces): Promise<void> { return this.store.write(value); }
  update(
    updater: (value: StoredWorkstationModelInterfaces) =>
      StoredWorkstationModelInterfaces | Promise<StoredWorkstationModelInterfaces>
  ): Promise<StoredWorkstationModelInterfaces> {
    return this.store.update(updater);
  }
}

export function validateStoredWorkstationModelInterfaces(value: unknown): StoredWorkstationModelInterfaces {
  if (!isPlainRecord(value) || value.schemaVersion !== 2 || !isPlainRecord(value.interfaces)) {
    throw new TypeError('Invalid model interface settings');
  }
  if (Object.keys(value).some((key) => !['schemaVersion', 'activeInterfaceId', 'interfaces'].includes(key))) {
    throw new TypeError('Invalid model interface settings');
  }
  if (value.activeInterfaceId !== undefined && value.activeInterfaceId !== null && !isUuid(value.activeInterfaceId)) {
    throw new TypeError('Invalid model interface settings');
  }
  const interfaces: Record<string, StoredModelInterface> = {};
  for (const [id, item] of Object.entries(value.interfaces)) {
    if (!isUuid(id) || !isPlainRecord(item)) throw new TypeError('Invalid model interface settings');
    if (
      item.id !== id ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128 ||
      typeof item.baseUrl !== 'string' || !item.baseUrl.trim() || item.baseUrl.length > 2048 ||
      typeof item.model !== 'string' || !item.model.trim() || item.model.length > 256 ||
      (item.credentialMode !== 'direct' && item.credentialMode !== 'environment') ||
      typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string'
    ) throw new TypeError('Invalid model interface settings');
    if (item.credentialMode === 'environment' && (
      typeof item.environmentVariableName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.environmentVariableName.trim())
    )) throw new TypeError('Invalid model interface settings');
    if (item.credentialMode === 'direct' && item.environmentVariableName !== undefined) {
      throw new TypeError('Invalid model interface settings');
    }
    let requestParameters: ModelRequestParameters | undefined;
    try {
      requestParameters = normalizeOptionalModelRequestParameters(item.requestParameters);
    } catch {
      throw new TypeError('Invalid model interface settings');
    }
    const { requestParameters: _ignored, ...storedItem } = item;
    interfaces[id] = {
      ...(storedItem as unknown as StoredModelInterface),
      ...(requestParameters ? { requestParameters } : {})
    };
  }
  if (value.activeInterfaceId !== undefined && value.activeInterfaceId !== null && !interfaces[value.activeInterfaceId]) {
    throw new TypeError('Invalid model interface settings');
  }
  return {
    schemaVersion: 2,
    activeInterfaceId: value.activeInterfaceId ?? null,
    interfaces
  };
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
