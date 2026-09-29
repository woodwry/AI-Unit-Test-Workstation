import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const BACKEND_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const BACKEND_LOG_RETAINED_FILES = 5;

export type BackendLogChannel = 'process-manager' | 'java-analyzer' | 'agent-service';
export type BackendLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type BackendLogEvent = Readonly<{
  level: BackendLogLevel;
  event: string;
  message?: string;
  service?: 'java-analyzer' | 'agent-service';
  instanceId?: string;
  pid?: number;
  port?: number;
  exitCode?: number | null;
}>;

export type BackendLogSinkOptions = Readonly<{
  maxBytes?: number;
  retainedFiles?: number;
  clock?: () => number;
  sensitiveValues?: () => readonly string[];
}>;

const CHANNELS: readonly BackendLogChannel[] = ['process-manager', 'java-analyzer', 'agent-service'];
const EVENT_KEYS = new Set([
  'level',
  'event',
  'message',
  'service',
  'instanceId',
  'pid',
  'port',
  'exitCode'
]);
const LEVELS: readonly BackendLogLevel[] = ['debug', 'info', 'warn', 'error'];
const MAX_INPUT_CHARACTERS = 1_000_000;
const MAX_EVENT_TEXT_CHARACTERS = 65_536;

function logConfigurationError(field: string): never {
  throw new TypeError(`后端日志配置无效：${field}`);
}

function replaceExactSecrets(text: string, sensitiveValues: readonly string[]): string {
  const uniqueSecrets = [...new Set(sensitiveValues.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  return uniqueSecrets.reduce((result, secret) => result.split(secret).join('[已隐藏]'), text);
}

/**
 * 对子进程输出做统一脱敏。显式启动令牌优先精确替换，随后覆盖 Bearer、常见
 * API Key/Token 字段和 sk-* 形式；返回值不会包含调用方提供的秘密。
 */
export function redactBackendLogText(text: string, sensitiveValues: readonly string[] = []): string {
  let redacted = replaceExactSecrets(text.slice(0, MAX_INPUT_CHARACTERS), sensitiveValues);
  redacted = redacted.replace(
    /("(?:apiKey|api_key|accessToken|access_token|authorization|password|secret|token)"\s*:\s*")([^"]*)(")/gi,
    '$1[已隐藏]$3'
  );
  redacted = redacted.replace(
    /(\b[A-Z][A-Z0-9_]*(?:API_?KEY|ACCESS_?TOKEN|SECRET|PASSWORD|TOKEN)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
    '$1[已隐藏]'
  );
  redacted = redacted.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi,
    '$1[已隐藏]'
  );
  redacted = redacted.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]');
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]');
  // 后端不应输出完整环境或凭证对象；对单行浅层对象再做一层兜底。
  redacted = redacted.replace(
    /("(?:credentials|environment|env)"\s*:\s*)\{[^{}\r\n]*\}/gi,
    '$1"[已隐藏]"'
  );
  return redacted;
}

function escapeLogLine(text: string): string {
  return text
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
}

function fitUtf8Entry(entry: string, maxBytes: number): string {
  const bytes = Buffer.from(entry, 'utf8');
  if (bytes.byteLength <= maxBytes) return entry;
  const suffix = Buffer.from(' …[已截断]\n', 'utf8');
  let end = Math.max(0, maxBytes - suffix.byteLength);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${suffix.toString('utf8')}`;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function validateEvent(event: BackendLogEvent): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) logConfigurationError('event');
  if (Object.keys(event).some((key) => !EVENT_KEYS.has(key))) {
    // 特意拒绝 environment/env/headers/request body 等任意大对象，防止完整环境落盘。
    logConfigurationError('event fields');
  }
  if (!LEVELS.includes(event.level)) logConfigurationError('event level');
  if (
    typeof event.event !== 'string' ||
    !event.event ||
    event.event.length > 256 ||
    /[\u0000\r\n]/.test(event.event)
  ) {
    logConfigurationError('event name');
  }
  for (const [field, value] of [['message', event.message], ['instanceId', event.instanceId]] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length > MAX_EVENT_TEXT_CHARACTERS)) {
      logConfigurationError(field);
    }
  }
  if (event.service !== undefined && !['java-analyzer', 'agent-service'].includes(event.service)) {
    logConfigurationError('event service');
  }
  for (const [field, value] of [['pid', event.pid], ['port', event.port]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) <= 0)) {
      logConfigurationError(field);
    }
  }
  if (
    event.exitCode !== undefined &&
    event.exitCode !== null &&
    (!Number.isSafeInteger(event.exitCode) || event.exitCode < 0)
  ) {
    logConfigurationError('exitCode');
  }
}

/**
 * 三个后端日志文件共用同一串行队列，避免并发 append/rotate 相互覆盖。
 * 默认每个文件最多 5MB，并保留当前文件在内共 5 份。
 */
export class BackendLogSink {
  private readonly directoryPath: string;
  private readonly maxBytes: number;
  private readonly retainedFiles: number;
  private readonly clock: () => number;
  private readonly sensitiveValues: () => readonly string[];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(directoryPath: string, options: BackendLogSinkOptions = {}) {
    if (typeof directoryPath !== 'string' || !directoryPath || /[\u0000\r\n]/.test(directoryPath)) {
      logConfigurationError('directoryPath');
    }
    const maxBytes = options.maxBytes ?? BACKEND_LOG_MAX_BYTES;
    const retainedFiles = options.retainedFiles ?? BACKEND_LOG_RETAINED_FILES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) logConfigurationError('maxBytes');
    if (!Number.isSafeInteger(retainedFiles) || retainedFiles < 1 || retainedFiles > 20) {
      logConfigurationError('retainedFiles');
    }
    this.directoryPath = directoryPath;
    this.maxBytes = maxBytes;
    this.retainedFiles = retainedFiles;
    this.clock = options.clock ?? Date.now;
    this.sensitiveValues = options.sensitiveValues ?? (() => []);
  }

  writeLine(
    channel: BackendLogChannel,
    message: string,
    additionalSensitiveValues: readonly string[] = []
  ): Promise<void> {
    if (!CHANNELS.includes(channel)) return Promise.reject(new TypeError('后端日志通道无效'));
    if (typeof message !== 'string') return Promise.reject(new TypeError('后端日志消息无效'));
    return this.enqueue(() => this.appendNow(channel, message, additionalSensitiveValues));
  }

  writeEvent(
    channel: BackendLogChannel,
    event: BackendLogEvent,
    additionalSensitiveValues: readonly string[] = []
  ): Promise<void> {
    try {
      validateEvent(event);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.writeLine(channel, JSON.stringify(event), additionalSensitiveValues);
  }

  flush(): Promise<void> {
    return this.operationQueue;
  }

  logFilePath(channel: BackendLogChannel): string {
    if (!CHANNELS.includes(channel)) throw new TypeError('后端日志通道无效');
    return join(this.directoryPath, `${channel}.log`);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.catch(() => undefined);
    return pending;
  }

  private async appendNow(
    channel: BackendLogChannel,
    message: string,
    additionalSensitiveValues: readonly string[]
  ): Promise<void> {
    let configuredSecrets: readonly string[];
    try {
      configuredSecrets = this.sensitiveValues();
    } catch {
      throw new Error('无法读取后端日志脱敏配置');
    }
    const now = this.clock();
    if (!Number.isFinite(now)) throw new Error('后端日志时间无效');
    const timestamp = new Date(now).toISOString();
    const redacted = redactBackendLogText(message, [...configuredSecrets, ...additionalSensitiveValues]);
    const escaped = escapeLogLine(redacted).slice(0, MAX_EVENT_TEXT_CHARACTERS);
    const entry = fitUtf8Entry(`[${timestamp}] ${escaped}\n`, this.maxBytes);
    const logPath = this.logFilePath(channel);

    await fs.mkdir(this.directoryPath, { recursive: true });
    await this.rotateIfRequired(logPath, Buffer.byteLength(entry, 'utf8'));
    await fs.appendFile(logPath, entry, 'utf8');
  }

  private async rotateIfRequired(logPath: string, incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      currentBytes = (await fs.stat(logPath)).size;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    if (currentBytes === 0 || currentBytes + incomingBytes <= this.maxBytes) return;

    if (this.retainedFiles === 1) {
      await fs.rm(logPath, { force: true });
      return;
    }

    await fs.rm(`${logPath}.${this.retainedFiles - 1}`, { force: true });
    for (let index = this.retainedFiles - 2; index >= 1; index -= 1) {
      await this.renameIfPresent(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    }
    await this.renameIfPresent(logPath, `${logPath}.1`);
  }

  private async renameIfPresent(source: string, destination: string): Promise<void> {
    try {
      await fs.rename(source, destination);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}
