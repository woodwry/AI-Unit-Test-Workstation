import test from 'node:test';
import assert from 'node:assert/strict';

const environmentResolver = await import('../src/main/services/system-environment-variable-resolver.ts').catch(() => ({}));

test('Windows reads a persisted environment variable when the running process snapshot is missing it', async () => {
  assert.equal(
    typeof environmentResolver.resolveSystemEnvironmentVariable,
    'function',
    'system environment resolver must support persisted Windows variables'
  );
  const queriedNames = [];
  const value = await environmentResolver.resolveSystemEnvironmentVariable('HUNYUAN_API_KEY', {
    environment: {},
    platform: 'win32',
    readWindowsPersistedEnvironmentVariable: async (name) => {
      queriedNames.push(name);
      return ' persisted-secret ';
    }
  });
  assert.equal(value, 'persisted-secret');
  assert.deepEqual(queriedNames, ['HUNYUAN_API_KEY']);
});

test('Windows persisted environment refresh overrides a stale process snapshot', async () => {
  assert.equal(
    typeof environmentResolver.resolveSystemEnvironmentVariable,
    'function',
    'system environment resolver must refresh persisted Windows values'
  );
  let persistedRead = false;
  const value = await environmentResolver.resolveSystemEnvironmentVariable('HUNYUAN_API_KEY', {
    environment: { HUNYUAN_API_KEY: 'stale-process-secret' },
    platform: 'win32',
    readWindowsPersistedEnvironmentVariable: async () => {
      persistedRead = true;
      return 'current-persisted-secret';
    }
  });
  assert.equal(value, 'current-persisted-secret');
  assert.equal(persistedRead, true);
});

test('process environment remains the fallback when Windows has no persisted value', async () => {
  const value = await environmentResolver.resolveSystemEnvironmentVariable('HUNYUAN_API_KEY', {
    environment: { HUNYUAN_API_KEY: 'process-secret' },
    platform: 'win32',
    readWindowsPersistedEnvironmentVariable: async () => undefined
  });
  assert.equal(value, 'process-secret');
});
