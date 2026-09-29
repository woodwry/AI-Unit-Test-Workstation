import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  probeExternalBackendAvailability,
  probeManagedBackendAvailability,
  probeRemoteAgentServiceAvailability
} from '../src/main/services/backend-availability.service.ts';

const access = {
  agentServiceUrl: 'http://127.0.0.1:49151',
  agentServiceAuthorizationHeader: 'Bearer agent-secret',
  javaAnalyzerUrl: 'http://127.0.0.1:49152',
  javaAnalyzerAuthorizationHeader: 'Bearer analyzer-secret'
};

function readyResponse(service) {
  return new Response(JSON.stringify({ protocol: 1, service, status: 'ready' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('probes both authenticated managed backends without returning connection details', async () => {
  const calls = [];
  const available = await probeManagedBackendAvailability(access, async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), init });
    return readyResponse(url.port === '49151' ? 'agent-service' : 'java-analyzer');
  });

  assert.equal(available, true);
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:49151/api/internal/ready',
    'http://127.0.0.1:49152/api/internal/ready'
  ]);
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer agent-secret');
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), 'Bearer analyzer-secret');
  assert.equal(calls.every((call) => call.init.redirect === 'error'), true);
});

test('reports unavailable when either service rejects, times out or returns a mismatched identity', async () => {
  const mismatch = await probeManagedBackendAvailability(access, async (input) => {
    const url = new URL(input);
    return readyResponse(url.port === '49151' ? 'java-analyzer' : 'java-analyzer');
  });
  assert.equal(mismatch, false);

  const rejected = await probeManagedBackendAvailability(access, async (input) => {
    if (new URL(input).port === '49152') throw new Error('connection refused');
    return readyResponse('agent-service');
  });
  assert.equal(rejected, false);

  const timedOut = await probeManagedBackendAvailability(
    access,
    async (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    5
  );
  assert.equal(timedOut, false);
});

test('remote deployment probes the public agent health endpoint without a credential', async () => {
  let captured;
  const available = await probeRemoteAgentServiceAvailability(
    'https://agent.example/base',
    async (input, init) => {
      captured = { input: input.toString(), init };
      return new Response(JSON.stringify({ status: 'ok', service: 'agent-service' }), { status: 200 });
    }
  );
  assert.equal(available, true);
  assert.equal(captured.input, 'https://agent.example/base/api/health');
  assert.equal(new Headers(captured.init.headers).has('authorization'), false);
});

test('standalone client preserves reverse proxy path prefixes while probing both backends', async () => {
  const calls = [];
  const available = await probeExternalBackendAvailability({
    agentServiceUrl: 'https://woodwry.cn',
    javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer'
  }, async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), init });
    const service = url.pathname.startsWith('/java-analyzer/') ? 'java-analyzer' : 'agent-service';
    return new Response(JSON.stringify({ status: 'ok', service }), { status: 200 });
  });
  assert.equal(available, true);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://woodwry.cn/api/health',
    'https://woodwry.cn/java-analyzer/api/health'
  ]);
  assert.equal(calls.every((call) => !new Headers(call.init.headers).has('authorization')), true);
});

test('standalone client rejects a missing or mismatched local backend', async () => {
  const available = await probeExternalBackendAvailability({
    agentServiceUrl: 'http://127.0.0.1:18000',
    javaAnalyzerUrl: 'http://127.0.0.1:18080'
  }, async () => new Response(
    JSON.stringify({ status: 'ok', service: 'agent-service' }),
    { status: 200 }
  ));
  assert.equal(available, false);
});

test('renderer authenticates before probing backend availability and keeps a connected workbench mounted', async () => {
  const [gateSource, rendererSource, preloadSource, mainSource] = await Promise.all([
    readFile(new URL('../src/renderer/src/BackendAvailabilityGate.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  ]);

  const authGatePosition = rendererSource.indexOf('<AuthGate loading={<StartupLoadingView />}>');
  const backendGatePosition = rendererSource.indexOf('<BackendAvailabilityGate loading={<StartupLoadingView />}>');
  assert.notEqual(authGatePosition, -1);
  assert.notEqual(backendGatePosition, -1);
  assert.ok(authGatePosition < backendGatePosition, '登录 Gate 必须先于服务器可用性 Gate');
  assert.match(gateSource, /服务器连接失败/);
  assert.match(gateSource, /无法连接服务器，请稍后重试/);
  assert.match(gateSource, /SERVER_UNAVAILABLE/);
  assert.match(gateSource, /onManagedBackendRuntimeStatusChanged/);
  assert.match(gateSource, /setInterval\(\(\) => void probe\(\), BACKEND_PROBE_INTERVAL_MS\)/);
  assert.match(gateSource, /if \(retryingRef\.current\) \{\s*setPhase\('retrying'\)/);
  assert.match(gateSource, /hasConnected && \(/);
  assert.match(gateSource, /backend-workbench-suspended/);
  assert.match(preloadSource, /probeBackendAvailability:\s*\(\) => ipcRenderer\.invoke\('backend-runtime:probe'\)/);
  assert.match(mainSource, /registerModelHandler\('backend-runtime:probe'/);
  assert.match(mainSource, /isRemoteBackendDeployment\(process\.env\)/);
});
