export type BackendAvailabilityFetch = (
  input: string | URL,
  init: RequestInit
) => Promise<Response>;

export type ManagedBackendAvailabilityAccess = Readonly<{
  agentServiceUrl: string;
  agentServiceAuthorizationHeader: string;
  javaAnalyzerUrl: string;
  javaAnalyzerAuthorizationHeader: string;
}>;

export type ExternalBackendAvailabilityAccess = Readonly<{
  agentServiceUrl: string;
  javaAnalyzerUrl: string;
}>;

function isAllowedPublicHealthEndpoint(endpoint: URL): boolean {
  return endpoint.protocol === 'https:'
    || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === 'localhost';
}

function backendEndpoint(baseUrl: string, apiPath: string): URL {
  if (!apiPath.startsWith('/')) {
    throw new TypeError('Backend API path must start with /.');
  }
  const base = new URL(baseUrl);
  base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return new URL(apiPath.slice(1), base);
}

async function probePublicBackendEndpoint(
  baseUrl: string,
  expectedService: 'agent-service' | 'java-analyzer',
  fetchImpl: BackendAvailabilityFetch,
  timeoutMs: number
): Promise<boolean> {
  const endpoint = backendEndpoint(baseUrl, '/api/health');
  if (!isAllowedPublicHealthEndpoint(endpoint)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal
    });
    if (response.status !== 200) return false;
    const body = await response.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    return record.status === 'ok' && record.service === expectedService;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeManagedBackendEndpoint(
  baseUrl: string,
  authorizationHeader: string,
  expectedService: 'agent-service' | 'java-analyzer',
  fetchImpl: BackendAvailabilityFetch,
  timeoutMs: number
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(backendEndpoint(baseUrl, '/api/internal/ready'), {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: authorizationHeader },
      signal: controller.signal
    });
    if (response.status !== 200) return false;
    const body = await response.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    return record.protocol === 1
      && record.service === expectedService
      && record.status === 'ready';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeManagedBackendAvailability(
  access: ManagedBackendAvailabilityAccess,
  fetchImpl: BackendAvailabilityFetch = fetch,
  timeoutMs = 3_000
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('后端健康检查超时时间无效');
  }
  const [agentReady, analyzerReady] = await Promise.all([
    probeManagedBackendEndpoint(
      access.agentServiceUrl,
      access.agentServiceAuthorizationHeader,
      'agent-service',
      fetchImpl,
      timeoutMs
    ),
    probeManagedBackendEndpoint(
      access.javaAnalyzerUrl,
      access.javaAnalyzerAuthorizationHeader,
      'java-analyzer',
      fetchImpl,
      timeoutMs
    )
  ]);
  return agentReady && analyzerReady;
}

export async function probeRemoteAgentServiceAvailability(
  baseUrl: string,
  fetchImpl: BackendAvailabilityFetch = fetch,
  timeoutMs = 3_000
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('后端健康检查超时时间无效');
  }
  return probePublicBackendEndpoint(baseUrl, 'agent-service', fetchImpl, timeoutMs);
}

export async function probeExternalBackendAvailability(
  access: ExternalBackendAvailabilityAccess,
  fetchImpl: BackendAvailabilityFetch = fetch,
  timeoutMs = 3_000
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('后端健康检查超时时间无效');
  }
  const [agentReady, analyzerReady] = await Promise.all([
    probePublicBackendEndpoint(access.agentServiceUrl, 'agent-service', fetchImpl, timeoutMs),
    probePublicBackendEndpoint(access.javaAnalyzerUrl, 'java-analyzer', fetchImpl, timeoutMs)
  ]);
  return agentReady && analyzerReady;
}
