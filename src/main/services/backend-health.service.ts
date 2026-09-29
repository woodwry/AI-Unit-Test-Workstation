import type { BackendHealthStatus, BackendSettings } from '../../shared/types.ts';
import { validateBackendSettingsSaveRequest } from './workspace-model-ipc-validation.ts';

type HealthFetch = (input: URL, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

function backendEndpoint(baseUrl: string, apiPath: string): URL {
  if (!apiPath.startsWith('/')) {
    throw new TypeError('Backend API path must start with /.');
  }
  const base = new URL(baseUrl);
  base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return new URL(apiPath.slice(1), base);
}

/**
 * 健康检查在网络请求前再次复用后端地址校验，防止被篡改的落盘配置绕过 IPC 校验后触发 SSRF。
 */
export async function checkHealthEndpoint(baseUrl: string, fetchImpl: HealthFetch = fetch): Promise<BackendHealthStatus> {
  try {
    // 两个字段使用同一候选地址，只借用统一的 URL 安全策略，不信任调用方传入的字符串。
    const safeBaseUrl = validateBackendSettingsSaveRequest({
      agentServiceUrl: baseUrl,
      javaAnalyzerUrl: baseUrl
    }).agentServiceUrl;
    const endpoint = backendEndpoint(safeBaseUrl, '/api/health');
    const response = await fetchImpl(endpoint, { method: 'GET' });
    return {
      url: safeBaseUrl,
      ok: response.ok,
      message: response.ok ? '服务正常' : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      url: baseUrl,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 以当前内存中的受控设置并行探测两个后端。 */
export async function checkBackendHealth(settings: BackendSettings): Promise<{ agentService: BackendHealthStatus; javaAnalyzer: BackendHealthStatus }> {
  const [agentService, javaAnalyzer] = await Promise.all([
    checkHealthEndpoint(settings.agentServiceUrl),
    checkHealthEndpoint(settings.javaAnalyzerUrl)
  ]);
  return { agentService, javaAnalyzer };
}
