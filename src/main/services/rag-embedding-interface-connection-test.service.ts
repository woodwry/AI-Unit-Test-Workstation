import type {
  RagEmbeddingInterfaceConnectionTestRequest,
  RagEmbeddingInterfaceConnectionTestResult
} from '../../shared/types.ts';
import { resolveSystemEnvironmentVariable } from './system-environment-variable-resolver.ts';

const TIMEOUT_MS = 10_000;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class RagEmbeddingInterfaceConnectionTestService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch
  ) {
    this.environment = environment;
    this.fetchImpl = fetchImpl;
  }

  async test(
    request: RagEmbeddingInterfaceConnectionTestRequest
  ): Promise<RagEmbeddingInterfaceConnectionTestResult> {
    const baseUrl = normalizeBaseUrl(request.baseUrl);
    const embeddingModel = request.embeddingModel.trim();
    if (!isValidBaseUrl(baseUrl) || !embeddingModel) {
      return failure('invalid_configuration', '接口配置无效。');
    }

    const apiKey = await this.resolveApiKey(request);
    if (!apiKey) {
      return failure('invalid_configuration', 'API Key 或环境变量未配置。');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: embeddingModel, input: 'connection-test' }),
        redirect: 'error',
        signal: controller.signal
      });
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        return failure('unsupported', '平台不支持 Embedding 连接测试。');
      }
      if (response.status === 401 || response.status === 403) {
        return failure('authentication_failed', 'API Key 无效或无权访问。');
      }
      if (!response.ok) {
        return failure('network_error', `平台返回 HTTP ${response.status}。`);
      }
      const body = await safeJson(response);
      if (!hasUsableEmbedding(body)) {
        return failure('invalid_response', '接口未返回有效的 Embedding 向量。');
      }
      return { ok: true, code: 'success', message: '连接测试成功。' };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return failure('timeout', '连接测试超时。');
      }
      return failure('network_error', '无法连接到平台。');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveApiKey(
    request: RagEmbeddingInterfaceConnectionTestRequest
  ): Promise<string | undefined> {
    if (request.credentialMode === 'direct') {
      return request.apiKey?.trim() || undefined;
    }
    const name = request.environmentVariableName?.trim() ?? '';
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(name)) return undefined;
    return (await resolveSystemEnvironmentVariable(name, {
      environment: this.environment
    }))?.trim() || undefined;
  }
}

function failure(
  code: RagEmbeddingInterfaceConnectionTestResult['code'],
  message: string
): RagEmbeddingInterfaceConnectionTestResult {
  return { ok: false, code, message };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function hasUsableEmbedding(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0])) {
    return false;
  }
  const embedding = value.data[0].embedding;
  return Array.isArray(embedding)
    && embedding.length > 0
    && embedding.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'http:'
      && (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
