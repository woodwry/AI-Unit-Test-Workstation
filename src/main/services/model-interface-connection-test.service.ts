import type {
  ModelInterfaceConnectionTestRequest,
  ModelInterfaceConnectionTestResult
} from '../../shared/types.ts';
import { resolveSystemEnvironmentVariable } from './system-environment-variable-resolver.ts';
import { normalizeOptionalModelRequestParameters } from '../../shared/model-request-parameters.ts';

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ModelInterfaceConnectionTestService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  constructor(environment: NodeJS.ProcessEnv = process.env, timeoutMs = TIMEOUT_MS) {
    this.environment = environment;
    this.timeoutMs = timeoutMs;
  }

  async test(request: ModelInterfaceConnectionTestRequest): Promise<ModelInterfaceConnectionTestResult> {
    const baseUrl = normalizeBaseUrl(request.baseUrl);
    if (!isValidBaseUrl(baseUrl) || !request.model.trim()) return failure('invalid_configuration', '接口配置无效。');
    let requestParameters;
    try {
      requestParameters = normalizeOptionalModelRequestParameters(request.requestParameters);
    } catch {
      return failure('invalid_configuration', '高级请求参数无效，请检查参数名称和值。');
    }
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json'
        },
        body: JSON.stringify({
          model: request.model.trim(),
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          // 用户配置优先；不要改写参数后再报告测试成功。
          ...(requestParameters?.max_completion_tokens === undefined ? { max_tokens: 16 } : {}),
          ...requestParameters,
          stream: true
        }),
        redirect: 'error',
        signal: controller.signal
      });
      return await inspectModelResponse(response);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return failure('timeout', '连接测试超时，模型未在 30 秒内返回有效内容。');
      }
      return failure('network_error', '无法连接到平台。');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

async function inspectModelResponse(response: Response): Promise<ModelInterfaceConnectionTestResult> {
  const fallback = (): ModelInterfaceConnectionTestResult => response.ok
    ? failure('invalid_response', '平台未返回有效模型内容，请检查 Base URL、模型名和请求参数。')
    : classifyPlatformError(response.status);
  if (!response.body) return fallback();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let streaming = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_RESPONSE_BYTES) return fallback();
      buffer += decoder.decode(value, { stream: !done });
      // 兼容部分平台未声明 SSE Content-Type 的错误响应。
      streaming ||= /^\s*(?:data:|event:|:)/.test(buffer);
      if (streaming) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const result = inspectSseFrame(frame, response.status);
          if (result) return result;
        }
      }
      if (done) {
        return (streaming
          ? inspectSseFrame(buffer, response.status)
          : inspectPayload(parseJson(buffer), response.status)) ?? fallback();
      }
    }
  } finally {
    // 探测到有效输出就停止，避免继续生成并消耗用户额度。
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function inspectSseFrame(frame: string, status: number): ModelInterfaceConnectionTestResult | undefined {
  const lines = frame.split(/\r?\n/);
  const errorEvent = lines.some(line => /^event:\s*error\s*$/.test(line));
  const data = lines.filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart()).join('\n').trim();
  if (!data && !errorEvent) return undefined;
  if (data === '[DONE]') {
    return status >= 400 ? classifyPlatformError(status)
      : failure('invalid_response', '模型响应已结束，但没有返回有效内容。');
  }
  return inspectPayload(parseJson(data), status, errorEvent);
}

function inspectPayload(
  value: unknown,
  status: number,
  errorEvent = false
): ModelInterfaceConnectionTestResult | undefined {
  const record = asRecord(value);
  if (errorEvent || record?.error != null || record?.type === 'error') {
    return classifyPlatformError(status, record?.error ?? record);
  }
  if (status >= 400) return classifyPlatformError(status, record);
  if (!Array.isArray(record?.choices)) return undefined;
  const hasContent = record.choices.some(choice => {
    const item = asRecord(choice);
    const output = asRecord(item?.delta) ?? asRecord(item?.message);
    return output && [output.content, output.reasoning_content, output.reasoning]
      .some(text => typeof text === 'string' && text.trim().length > 0);
  });
  return hasContent ? { ok: true, code: 'success', message: '连接测试成功。' } : undefined;
}

function classifyPlatformError(status: number, value?: unknown): ModelInterfaceConnectionTestResult {
  const record = asRecord(value);
  const description = [record?.code, record?.type, record?.message,
    typeof value === 'string' ? value : undefined]
    .filter(item => typeof item === 'string').join(' ').toLowerCase();
  if (status === 402 || /insufficient[_ .-]?(?:quota|balance|credit)|quota[_ .-]?(?:exhausted|exceeded)|billing|payment|required.*balance/.test(description)) {
    return failure('quota_exhausted', '模型额度不足或账户计费不可用，请检查平台账户。');
  }
  if (status === 401 || status === 403 || /invalid_api_key|authentication|unauthorized|permission_denied/.test(description)) {
    return failure('authentication_failed', 'API Key 无效或无权调用所选模型。');
  }
  if (status === 429 || /rate[_ .-]?limit|too_many_requests/.test(description)) {
    return failure('rate_limited', '平台请求过于频繁或并发超限，请稍后重试。');
  }
  if (status === 404 || /model_not_found|model_not_exist/.test(description)) {
    return failure('not_found', '模型或接口不存在，请检查模型名和 Base URL。');
  }
  if (status === 405 || status === 501) {
    return failure('unsupported', '平台不支持当前模型调用接口。');
  }
  if (status === 400 || status === 422 || /invalid[_ .-]?(?:request|parameter)|context_length_exceeded|unsupported_parameter/.test(description)) {
    // 只转换已知参数错误，不直接回显可能包含凭证的上游正文。
    if (/thinking.*must be json_object/.test(description)) {
      return failure('invalid_request', 'thinking 参数必须是 JSON 对象，例如 {"type":"enabled"}。');
    }
    if (/max_tokens.*must be integer/.test(description)) {
      return failure('invalid_request', 'max_tokens 参数必须填写整数。');
    }
    if (/reasoning_effort/.test(description)) {
      return failure('invalid_request', 'reasoning_effort 参数无效，请按模型平台文档填写支持的值。');
    }
    return failure('invalid_request', '模型拒绝当前请求，请检查高级参数的名称、类型、取值及模型限制。');
  }
  return failure('network_error', status >= 400
    ? `模型平台返回 HTTP ${status}，请稍后重试。`
    : '模型平台返回调用错误，请检查平台状态后重试。');
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
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
