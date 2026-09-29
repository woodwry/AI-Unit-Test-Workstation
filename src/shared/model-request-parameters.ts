import type { JsonValue, ModelRequestParameters } from './types.ts';

export const MAX_MODEL_REQUEST_PARAMETER_COUNT = 32;
export const MAX_MODEL_REQUEST_PARAMETERS_BYTES = 32 * 1024;

const MODEL_REQUEST_PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DANGEROUS_PARAMETER_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype'
]);
const SYSTEM_MANAGED_PARAMETER_NAMES = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'credentials',
  'credential',
  'api_key',
  'apikey',
  'api-key',
  'base_url',
  'baseurl',
  'base-url',
  'authorization'
]);

export function isValidModelRequestParameterName(name: string): boolean {
  return MODEL_REQUEST_PARAMETER_NAME_PATTERN.test(name);
}

export function isProtectedModelRequestParameterName(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  return DANGEROUS_PARAMETER_NAMES.has(normalized)
    || SYSTEM_MANAGED_PARAMETER_NAMES.has(normalized);
}

export function measureModelRequestParametersBytes(value: ModelRequestParameters): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function normalizeOptionalModelRequestParameters(
  value: unknown
): ModelRequestParameters | undefined {
  if (value === undefined) return undefined;
  const normalized = validateModelRequestParameters(value);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function validateModelRequestParameters(value: unknown): ModelRequestParameters {
  if (!isPlainRecord(value)) throw new TypeError('高级请求参数无效。');
  const entries = Object.entries(value);
  if (entries.length > MAX_MODEL_REQUEST_PARAMETER_COUNT) {
    throw new TypeError('高级请求参数最多配置 32 项。');
  }

  const normalized: ModelRequestParameters = {};
  const names = new Set<string>();
  for (const [name, parameterValue] of entries) {
    const comparisonName = name.toLocaleLowerCase();
    if (
      !isValidModelRequestParameterName(name)
      || isProtectedModelRequestParameterName(name)
      || names.has(comparisonName)
    ) {
      throw new TypeError('高级请求参数名称无效。');
    }
    names.add(comparisonName);
    normalized[name] = cloneJsonValue(parameterValue, 0);
  }

  if (measureModelRequestParametersBytes(normalized) > MAX_MODEL_REQUEST_PARAMETERS_BYTES) {
    throw new TypeError('高级请求参数总大小不能超过 32 KiB。');
  }
  return normalized;
}

function cloneJsonValue(value: unknown, depth: number): JsonValue {
  if (depth > 32) throw new TypeError('高级请求参数无效。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('高级请求参数无效。');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item, depth + 1));
  }
  if (!isPlainRecord(value)) throw new TypeError('高级请求参数无效。');
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item, depth + 1)])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
