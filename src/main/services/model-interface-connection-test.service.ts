import type {
  ModelInterfaceConnectionTestRequest,
  ModelInterfaceConnectionTestResult
} from '../../shared/types.ts';
import { resolveSystemEnvironmentVariable } from './system-environment-variable-resolver.ts';

const TIMEOUT_MS = 10_000;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ModelInterfaceConnectionTestService {
  private readonly environment: NodeJS.ProcessEnv;
  constructor(environment: NodeJS.ProcessEnv = process.env) { this.environment = environment; }

  async test(request: ModelInterfaceConnectionTestRequest): Promise<ModelInterfaceConnectionTestResult> {
    const baseUrl = normalizeBaseUrl(request.baseUrl);
    if (!isValidBaseUrl(baseUrl) || !request.model.trim()) return failure('invalid_configuration', '接口配置无效。');
    let apiKey: string | undefined;
    if (request.credentialMode === 'environment') {
      const environmentVariableName = request.environmentVariableName?.trim() ?? '';
      if (!ENVIRONMENT_VARIABLE_PATTERN.test(environmentVariableName)) {
        return failure('invalid_configuration', '环境变量名格式无效。');
      }
      apiKey = await resolveSystemEnvironmentVariable(environmentVariableName, { environment: this.environment });
    } else {
      apiKey = request.apiKey?.trim();
    }
    if (!apiKey) return failure('invalid_configuration', 'API Key 或环境变量未配置。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal
      });
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        return failure('unsupported', '平台不支持测试连接。');
      }
      if (response.status === 401 || response.status === 403) return failure('authentication_failed', 'API Key 无效或无权访问。');
      if (!response.ok) return failure('network_error', `平台返回 HTTP ${response.status}。`);
      return { ok: true, code: 'success', message: '连接测试成功。' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return failure('timeout', '连接测试超时。');
      if (error instanceof Error && error.name === 'AbortError') return failure('timeout', '连接测试超时。');
      return failure('network_error', '无法连接到平台。');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function failure(code: ModelInterfaceConnectionTestResult['code'], message: string): ModelInterfaceConnectionTestResult {
  return { ok: false, code, message };
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
