import { constants, promises as fs } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import type {
  ModelCallLogSettings,
  SaveModelCallLogSettingsRequest
} from '../../shared/types';
import { AtomicJsonStore } from './atomic-json-store.ts';

type StoredModelCallLogSettings = {
  version: 1;
  enabled: boolean;
  directory?: string;
};

export class ModelCallLogSettingsService {
  private readonly store: AtomicJsonStore<StoredModelCallLogSettings>;

  constructor(storagePath: string) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateStoredSettings,
      () => ({ version: 1, enabled: false })
    );
  }

  async get(): Promise<ModelCallLogSettings> {
    const stored = await this.store.read();
    return {
      enabled: stored.enabled,
      ...(stored.directory
        ? { directory: stored.directory }
        : {})
    };
  }

  async save(
    request: SaveModelCallLogSettingsRequest
  ): Promise<ModelCallLogSettings> {
    const directory = request.directory?.trim()
      ? normalize(resolve(request.directory.trim()))
      : undefined;
    if (request.enabled && !directory) {
      throw new Error('启用模型调用记录前必须选择存储目录。');
    }
    if (request.enabled && directory) {
      await this.assertWritableDirectory(directory);
    }
    const stored: StoredModelCallLogSettings = {
      version: 1,
      enabled: request.enabled,
      ...(directory ? { directory } : {})
    };
    await this.store.write(stored);
    return {
      enabled: stored.enabled,
      ...(stored.directory
        ? { directory: stored.directory }
        : {})
    };
  }

  async assertWritableDirectory(directory: string): Promise<void> {
    if (!isSafeDirectory(directory) || !isAbsolute(directory)) {
      throw new Error('模型调用记录目录格式无效。');
    }
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) {
        throw new Error('所选模型调用记录路径不是目录。');
      }
      await fs.access(directory, constants.W_OK);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === '所选模型调用记录路径不是目录。'
      ) {
        throw error;
      }
      throw new Error('模型调用记录目录不存在或不可写。');
    }
  }
}

function validateStoredSettings(
  value: unknown
): StoredModelCallLogSettings {
  if (!isPlainRecord(value)) {
    throw invalidSettings();
  }
  const allowed = new Set(['version', 'enabled', 'directory']);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || value.version !== 1
    || typeof value.enabled !== 'boolean'
    || (
      value.directory !== undefined
      && !isSafeDirectory(value.directory)
    )
  ) {
    throw invalidSettings();
  }
  if (value.enabled && value.directory === undefined) {
    throw invalidSettings();
  }
  return value as StoredModelCallLogSettings;
}

function isSafeDirectory(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
    && value.length <= 4_096
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function invalidSettings(): TypeError {
  return new TypeError('模型调用记录设置文件格式无效。');
}
