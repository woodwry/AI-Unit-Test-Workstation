import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AiClient } from '../src/main/services/ai-client.ts';
import { AuthSessionService } from '../src/main/services/auth-session.service.ts';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  loginName: 'admin',
  role: 'ADMIN',
  isAvailable: 1,
  lastLoginAt: '2026-09-19T01:00:00Z'
};

function session(access = 'a'.repeat(64), refresh = 'r'.repeat(64)) {
  return {
    user: USER,
    accessToken: access,
    refreshToken: refresh,
    accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString()
  };
}

function json(value, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
};

const DAY_MS = 24 * 60 * 60 * 1000;

test('remembered login keeps access token in memory and persists only encrypted refresh token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const client = new AiClient(async (input, init) => {
    calls.push({ url: new URL(input).pathname, init });
    if (new URL(input).pathname === '/api/auth/login') return json(session());
    if (new URL(input).pathname === '/api/admin/users') return json({ items: [] });
    throw new Error('unexpected request');
  });
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const storagePath = join(directory, 'auth-session.json');
  const service = new AuthSessionService({ client, storagePath, cipher });

  assert.equal((await service.initialize()).status, 'anonymous');
  assert.equal((await service.login({ loginName: 'admin', password: 'secret-password', rememberMe: true })).status, 'authenticated');
  await service.listUsers();

  const stored = await readFile(storagePath, 'utf8');
  assert.equal(stored.includes('r'.repeat(64)), false);
  assert.equal(stored.includes('a'.repeat(64)), false);
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), `Bearer ${'a'.repeat(64)}`);
  service.dispose();
});

test('a new process restores the session by rotating the persisted refresh token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth-session.json');

  const firstClient = new AiClient(async () => json(session()));
  firstClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const first = new AuthSessionService({ client: firstClient, storagePath, cipher });
  await first.initialize();
  await first.login({ loginName: 'admin', password: 'secret-password', rememberMe: true });
  first.dispose();

  let refreshBody;
  const secondClient = new AiClient(async (_input, init) => {
    refreshBody = JSON.parse(init.body);
    return json(session('b'.repeat(64), 's'.repeat(64)));
  });
  secondClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const second = new AuthSessionService({ client: secondClient, storagePath, cipher });
  const restored = await second.initialize();

  assert.equal(refreshBody.refreshToken, 'r'.repeat(64));
  assert.equal(restored.status, 'authenticated');
  assert.equal(restored.user.loginName, 'admin');
  second.dispose();
});

test('login without remember me keeps the session in memory only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-memory-only-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth-session.json');
  const client = new AiClient(async () => json(session()));
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const service = new AuthSessionService({ client, storagePath, cipher });

  const loggedIn = await service.login({
    loginName: 'admin',
    password: 'secret-password',
    rememberMe: false
  });

  assert.equal(loggedIn.status, 'authenticated');
  await assert.rejects(access(storagePath));
  service.dispose();

  let restoreCalls = 0;
  const nextClient = new AiClient(async () => {
    restoreCalls += 1;
    return json(session());
  });
  nextClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const next = new AuthSessionService({ client: nextClient, storagePath, cipher });

  assert.deepEqual(await next.initialize(), { status: 'anonymous', user: null });
  assert.equal(restoreCalls, 0);
  next.dispose();
});

test('remembered login expires after seven days without contacting the server', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-seven-days-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth-session.json');
  let now = Date.parse('2026-09-19T00:00:00.000Z');
  const firstClient = new AiClient(async () => json(session()));
  firstClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const first = new AuthSessionService({ client: firstClient, storagePath, cipher, now: () => now });
  await first.login({ loginName: 'admin', password: 'secret-password', rememberMe: true });
  first.dispose();

  now += 7 * DAY_MS + 1;
  let restoreCalls = 0;
  const secondClient = new AiClient(async () => {
    restoreCalls += 1;
    return json(session('b'.repeat(64), 's'.repeat(64)));
  });
  secondClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const second = new AuthSessionService({ client: secondClient, storagePath, cipher, now: () => now });

  assert.deepEqual(await second.initialize(), { status: 'anonymous', user: null });
  assert.equal(restoreCalls, 0);
  await assert.rejects(access(storagePath));
  second.dispose();
});

test('successful restore inside seven days starts a fresh seven-day window', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-sliding-window-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth-session.json');
  let now = Date.parse('2026-09-19T00:00:00.000Z');
  const firstClient = new AiClient(async () => json(session()));
  firstClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const first = new AuthSessionService({ client: firstClient, storagePath, cipher, now: () => now });
  await first.login({ loginName: 'admin', password: 'secret-password', rememberMe: true });
  first.dispose();

  now += 6 * DAY_MS;
  const secondClient = new AiClient(async () => json(session('b'.repeat(64), 's'.repeat(64))));
  secondClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const second = new AuthSessionService({ client: secondClient, storagePath, cipher, now: () => now });

  assert.equal((await second.initialize()).status, 'authenticated');
  const stored = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(stored.rememberedUntilEpochMs, now + 7 * DAY_MS);
  second.dispose();
});

test('remembered session shows server unavailable regardless of the last stored availability flag', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-remembered-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth-session.json');
  const firstClient = new AiClient(async () => json(session()));
  firstClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const first = new AuthSessionService({ client: firstClient, storagePath, cipher });
  await first.login({ loginName: 'admin', password: 'secret-password', rememberMe: true });
  first.dispose();
  const stored = JSON.parse(await readFile(storagePath, 'utf8'));
  stored.accountWasAvailable = false;
  await writeFile(storagePath, JSON.stringify(stored), 'utf8');

  let restoreCalls = 0;
  const offlineClient = new AiClient(async () => {
    restoreCalls += 1;
    throw new TypeError('fetch failed');
  });
  offlineClient.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const offline = new AuthSessionService({ client: offlineClient, storagePath, cipher });

  assert.deepEqual(await offline.initialize(), { status: 'server-unavailable', user: null });
  await access(storagePath);
  await offline.forget();
  assert.deepEqual(offline.getState(), { status: 'anonymous', user: null });
  assert.equal(restoreCalls, 1);
  await assert.rejects(access(storagePath));
  offline.dispose();
});

test('disabled account becomes an internal unavailable state without exposing quota wording', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-disabled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new AiClient(async () => json({
    code: 'ACCOUNT_UNAVAILABLE',
    message: '服务暂时不可用。',
    details: {}
  }, 403));
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const service = new AuthSessionService({ client, storagePath: join(directory, 'auth.json'), cipher });
  await service.initialize();
  const state = await service.login({ loginName: 'disabled-user', password: 'secret-password', rememberMe: false });

  assert.deepEqual(state, { status: 'account-unavailable', user: null });
  service.dispose();
});

test('successful authentication response with an unavailable user still opens the server failure state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-unavailable-payload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth.json');
  const client = new AiClient(async () => json({
    ...session(),
    user: { ...USER, isAvailable: 0 }
  }));
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const service = new AuthSessionService({ client, storagePath, cipher });

  const state = await service.login({
    loginName: 'disabled-user',
    password: 'secret-password',
    rememberMe: true
  });

  assert.deepEqual(state, { status: 'account-unavailable', user: null });
  await assert.rejects(access(storagePath));
  service.dispose();
});

test('concurrent refresh requests share one refresh-token rotation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-refresh-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let refreshCalls = 0;
  const client = new AiClient(async (input) => {
    const path = new URL(input).pathname;
    if (path === '/api/auth/login') return json(session());
    if (path === '/api/auth/refresh') {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json(session('b'.repeat(64), 's'.repeat(64)));
    }
    throw new Error('unexpected request');
  });
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const service = new AuthSessionService({
    client,
    storagePath: join(directory, 'auth.json'),
    cipher
  });

  await service.login({ loginName: 'admin', password: 'secret-password', rememberMe: false });
  const [first, second] = await Promise.all([service.retry(), service.retry()]);

  assert.equal(refreshCalls, 1);
  assert.equal(first.status, 'authenticated');
  assert.equal(second.status, 'authenticated');
  service.dispose();
});

test('invalid access-token expiration does not start an immediate refresh loop', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-invalid-expiry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let refreshCalls = 0;
  const client = new AiClient(async (input) => {
    const path = new URL(input).pathname;
    if (path === '/api/auth/login') {
      return json({ ...session(), accessTokenExpiresAt: 'invalid-date' });
    }
    if (path === '/api/auth/refresh') {
      refreshCalls += 1;
      return json(session());
    }
    throw new Error('unexpected request');
  });
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const service = new AuthSessionService({
    client,
    storagePath: join(directory, 'auth.json'),
    cipher
  });

  await service.login({ loginName: 'admin', password: 'secret-password', rememberMe: false });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(refreshCalls, 0);
  service.dispose();
});

test('resetting the current administrator password clears the revoked local session', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-self-password-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'auth.json');
  const client = new AiClient(async (input) => {
    const path = new URL(input).pathname;
    if (path === '/api/auth/login') return json(session());
    if (path === `/api/admin/users/${USER.id}`) {
      return json({
        ...USER,
        loginCount: 1,
        lastLoginIp: '127.0.0.1',
        createdAt: '2026-09-19T01:00:00Z',
        updatedAt: '2026-09-19T01:01:00Z'
      });
    }
    throw new Error('unexpected request');
  });
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });
  const service = new AuthSessionService({ client, storagePath, cipher });

  await service.login({ loginName: 'admin', password: 'secret-password', rememberMe: true });
  await service.updateUser({ id: USER.id, password: 'new-secret-password' });

  assert.deepEqual(service.getState(), { status: 'anonymous', user: null });
  await assert.rejects(access(storagePath));
  service.dispose();
});

test('logout sends the refresh token without requiring an access token', async () => {
  let authorization = 'not-called';
  const client = new AiClient(async (_input, init) => {
    authorization = new Headers(init.headers).get('authorization');
    return json(null, 204);
  });
  client.setBackendSettings({ agentServiceUrl: 'https://server.example', javaAnalyzerUrl: 'http://127.0.0.1:18080' });

  await client.logoutUser('r'.repeat(64));

  assert.equal(authorization, null);
});

test('renderer contract exposes login and administrator management without renderer token fields', async () => {
  const [contracts, preload, authGate, app, panel] = await Promise.all([
    readFile(new URL('../src/shared/auth-contracts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/AuthGate.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/UserManagementPanel.tsx', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(contracts, /accessToken|refreshToken/);
  assert.match(preload, /AUTH_CHANNELS\.login/);
  assert.match(preload, /AUTH_CHANNELS\.forget/);
  assert.match(authGate, /window\.workstation\.retryAuthentication\(\)/);
  assert.match(authGate, /retrying=\{retrying\}/);
  assert.match(authGate, /: '登录失败'\);/);
  assert.doesNotMatch(authGate, /登录失败，请稍后重试/);
  assert.match(app, /currentUser\?\.role === 'ADMIN'/);
  assert.match(app, /title="用户管理"/);
  assert.match(panel, /window\.workstation\.createUser/);
  assert.match(panel, /window\.workstation\.updateUser/);
  assert.match(panel, /window\.workstation\.deleteUser/);
  assert.match(panel, /taskExecutionCount/);
  assert.doesNotMatch(panel, /至少\s+\d+\s+个字符/);
  assert.doesNotMatch(panel, /password\.length\s*</);
});
