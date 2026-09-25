import type {
  BackendProcessManagerStatus,
  BackendProcessManagerStatusListener
} from './backend-process-manager.ts';

export const E2E_BACKEND_RUNTIME_ENABLED_ENV = 'AI_UNIT_TEST_E2E_BACKEND_RUNTIME';
export const E2E_BACKEND_RUNTIME_AGENT_URL_ENV = 'AI_UNIT_TEST_E2E_AGENT_URL';
export const E2E_BACKEND_RUNTIME_ANALYZER_URL_ENV = 'AI_UNIT_TEST_E2E_ANALYZER_URL';

const E2E_AUTHORIZATION_HEADER = 'Bearer workstation-electron-e2e';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const IDLE_STATUS: BackendProcessManagerStatus = Object.freeze({
  state: 'idle',
  message: 'E2E backend is idle.',
  retryable: true
});
const READY_STATUS: BackendProcessManagerStatus = Object.freeze({
  state: 'ready',
  message: 'E2E backend is ready.',
  retryable: false
});
const STOPPED_STATUS: BackendProcessManagerStatus = Object.freeze({
  state: 'stopped',
  message: 'E2E backend is stopped.',
  retryable: true
});

export type ManagedBackendAccess = Readonly<{
  agentServiceUrl: string;
  agentServiceAuthorizationHeader: string;
  javaAnalyzerUrl: string;
  javaAnalyzerAuthorizationHeader: string;
}>;

export type ManagedBackendRuntime = Readonly<{
  start(): Promise<unknown>;
  retry(): Promise<unknown>;
  stop(): Promise<void>;
  getStatus(): BackendProcessManagerStatus;
  subscribe(listener: BackendProcessManagerStatusListener): () => void;
  getManagedAccess(): ManagedBackendAccess;
}>;

export type E2eBackendRuntimeOptions = Readonly<{
  isPackaged: boolean;
  environment?: NodeJS.ProcessEnv;
}>;

function exactLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('E2E backend URL is invalid.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('E2E backend URL is invalid.');
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    !url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new TypeError('E2E backend URL must be an exact loopback HTTP origin.');
  }
  return url.origin;
}

/**
 * Process-free runtime used only by explicit, unpackaged Electron E2E launches.
 * It is intentionally unreachable from an installed application.
 */
export class E2eBackendRuntime implements ManagedBackendRuntime {
  private readonly access: ManagedBackendAccess;
  private readonly listeners = new Set<BackendProcessManagerStatusListener>();
  private status: BackendProcessManagerStatus = IDLE_STATUS;

  constructor(agentServiceUrl: string, javaAnalyzerUrl: string) {
    this.access = Object.freeze({
      agentServiceUrl,
      agentServiceAuthorizationHeader: E2E_AUTHORIZATION_HEADER,
      javaAnalyzerUrl,
      javaAnalyzerAuthorizationHeader: E2E_AUTHORIZATION_HEADER
    });
  }

  async start(): Promise<ManagedBackendAccess> {
    this.publish(READY_STATUS);
    return this.access;
  }

  async retry(): Promise<ManagedBackendAccess> {
    return this.start();
  }

  async stop(): Promise<void> {
    this.publish(STOPPED_STATUS);
  }

  getStatus(): BackendProcessManagerStatus {
    return this.status;
  }

  subscribe(listener: BackendProcessManagerStatusListener): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('E2E backend status listener is invalid.');
    }
    this.listeners.add(listener);
    listener(this.status);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  getManagedAccess(): ManagedBackendAccess {
    if (this.status.state !== 'ready') {
      throw new Error('E2E backend is not ready.');
    }
    return this.access;
  }

  private publish(status: BackendProcessManagerStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

export function createE2eBackendRuntime(
  options: E2eBackendRuntimeOptions
): E2eBackendRuntime | null {
  if (options.isPackaged) return null;
  const environment = options.environment ?? process.env;
  if (environment[E2E_BACKEND_RUNTIME_ENABLED_ENV] !== 'enabled') return null;

  return new E2eBackendRuntime(
    exactLoopbackOrigin(environment[E2E_BACKEND_RUNTIME_AGENT_URL_ENV]),
    exactLoopbackOrigin(environment[E2E_BACKEND_RUNTIME_ANALYZER_URL_ENV])
  );
}
