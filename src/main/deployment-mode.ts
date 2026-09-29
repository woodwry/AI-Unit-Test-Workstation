import { E2E_BACKEND_RUNTIME_ENABLED_ENV } from './backend-runtime/e2e-backend-runtime.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Environment = Readonly<Record<string, string | undefined>>;

export const EXTERNAL_BACKEND_CLIENT_MARKER = 'external-backend-client.json';

export type ExternalBackendClientConfiguration = Readonly<{
  schemaVersion: 1;
  backendMode: 'remote-backend-services';
  agentServiceUrl: string;
  javaAnalyzerUrl: string;
}>;

export type PackagedDeployment = Readonly<{
  isPackaged: boolean;
  resourcesPath: string;
}>;

/**
 * The download client carries no backend runtime. A small trusted resource
 * marker selects the server-backed distribution without machine settings.
 */
export function isExternalBackendClientDeployment(
  deployment: PackagedDeployment,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  return deployment.isPackaged
    && fileExists(join(deployment.resourcesPath, EXTERNAL_BACKEND_CLIENT_MARKER));
}

function exactHttpsBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new TypeError('客户端服务器地址无效');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError('客户端服务器地址无效');
  }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.search
    || endpoint.hash
    || endpoint.username
    || endpoint.password
    || endpoint.port
  ) {
    throw new TypeError('客户端服务器地址必须是标准 HTTPS 域名');
  }
  return endpoint.toString().replace(/\/$/, '');
}

export function parseExternalBackendClientConfiguration(
  value: unknown
): ExternalBackendClientConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('客户端部署配置无效');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['agentServiceUrl', 'backendMode', 'javaAnalyzerUrl', 'schemaVersion'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('客户端部署配置字段无效');
  }
  if (record.schemaVersion !== 1 || record.backendMode !== 'remote-backend-services') {
    throw new TypeError('客户端部署模式无效');
  }
  return Object.freeze({
    schemaVersion: 1,
    backendMode: 'remote-backend-services',
    agentServiceUrl: exactHttpsBaseUrl(record.agentServiceUrl),
    javaAnalyzerUrl: exactHttpsBaseUrl(record.javaAnalyzerUrl)
  });
}

export function readExternalBackendClientConfiguration(
  deployment: PackagedDeployment,
  readTextFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): ExternalBackendClientConfiguration {
  if (!deployment.isPackaged) {
    throw new TypeError('客户端部署配置只能在安装包中读取');
  }
  const path = join(deployment.resourcesPath, EXTERNAL_BACKEND_CLIENT_MARKER);
  let source: unknown;
  try {
    source = JSON.parse(readTextFile(path)) as unknown;
  } catch {
    throw new TypeError('客户端部署配置无法读取');
  }
  return parseExternalBackendClientConfiguration(source);
}

/**
 * Production clients use the server deployment by default. The legacy local
 * managed runtime remains available only through an explicit opt-out, while
 * the isolated E2E runtime keeps its existing local test contract.
 */
export function isRemoteBackendDeployment(environment: Environment): boolean {
  if (environment[E2E_BACKEND_RUNTIME_ENABLED_ENV] === 'enabled') return false;
  return environment.AI_UNIT_TEST_REMOTE_BACKEND?.trim().toLowerCase() !== 'false';
}
