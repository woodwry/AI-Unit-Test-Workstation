import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E2E_BACKEND_RUNTIME_ENABLED_ENV,
  E2E_BACKEND_RUNTIME_AGENT_URL_ENV,
  E2E_BACKEND_RUNTIME_ANALYZER_URL_ENV,
  createE2eBackendRuntime
} from '../src/main/backend-runtime/e2e-backend-runtime.ts';

function enabledEnvironment(overrides = {}) {
  return {
    [E2E_BACKEND_RUNTIME_ENABLED_ENV]: 'enabled',
    [E2E_BACKEND_RUNTIME_AGENT_URL_ENV]: 'http://127.0.0.1:39101',
    [E2E_BACKEND_RUNTIME_ANALYZER_URL_ENV]: 'http://localhost:39102',
    ...overrides
  };
}

test('ordinary development startup does not enable the E2E backend runtime', () => {
  assert.equal(createE2eBackendRuntime({
    isPackaged: false,
    environment: {
      [E2E_BACKEND_RUNTIME_AGENT_URL_ENV]: 'http://127.0.0.1:39101',
      [E2E_BACKEND_RUNTIME_ANALYZER_URL_ENV]: 'http://127.0.0.1:39102'
    }
  }), null);
});

test('packaged application never enables the E2E backend runtime', () => {
  assert.equal(createE2eBackendRuntime({
    isPackaged: true,
    environment: enabledEnvironment()
  }), null);
});

test('explicit development E2E runtime accepts only exact loopback HTTP origins', () => {
  for (const [agentServiceUrl, javaAnalyzerUrl] of [
    ['http://127.0.0.1:40101', 'http://localhost:40102'],
    ['http://localhost:40103', 'http://[::1]:40104']
  ]) {
    const runtime = createE2eBackendRuntime({
      isPackaged: false,
      environment: enabledEnvironment({
        [E2E_BACKEND_RUNTIME_AGENT_URL_ENV]: agentServiceUrl,
        [E2E_BACKEND_RUNTIME_ANALYZER_URL_ENV]: javaAnalyzerUrl
      })
    });
    assert.ok(runtime);
  }

  for (const invalidUrl of [
    'https://127.0.0.1:40101',
    'http://0.0.0.0:40101',
    'http://192.168.1.8:40101',
    'http://example.test:40101',
    'http://127.0.0.1:40101/api',
    'http://user:password@127.0.0.1:40101',
    'http://127.0.0.1:40101/?mode=e2e'
  ]) {
    assert.throws(() => createE2eBackendRuntime({
      isPackaged: false,
      environment: enabledEnvironment({
        [E2E_BACKEND_RUNTIME_AGENT_URL_ENV]: invalidUrl
      })
    }), /E2E backend URL/i, invalidUrl);
  }
});

test('E2E backend runtime exposes the managed lifecycle contract without starting processes', async () => {
  const runtime = createE2eBackendRuntime({
    isPackaged: false,
    environment: enabledEnvironment()
  });
  assert.ok(runtime);

  const states = [];
  const unsubscribe = runtime.subscribe((status) => states.push(status.state));
  assert.equal(runtime.getStatus().state, 'idle');
  assert.throws(() => runtime.getManagedAccess(), /not ready/i);

  await runtime.start();
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(runtime.getManagedAccess(), {
    agentServiceUrl: 'http://127.0.0.1:39101',
    agentServiceAuthorizationHeader: 'Bearer workstation-electron-e2e',
    javaAnalyzerUrl: 'http://localhost:39102',
    javaAnalyzerAuthorizationHeader: 'Bearer workstation-electron-e2e'
  });

  await runtime.retry();
  await runtime.stop();
  assert.equal(runtime.getStatus().state, 'stopped');
  assert.throws(() => runtime.getManagedAccess(), /not ready/i);
  unsubscribe();
  assert.deepEqual(states, ['idle', 'ready', 'ready', 'stopped']);
});
