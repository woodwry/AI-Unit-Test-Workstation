import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  EXTERNAL_BACKEND_CLIENT_MARKER,
  isExternalBackendClientDeployment,
  isRemoteBackendDeployment,
  parseExternalBackendClientConfiguration,
  readExternalBackendClientConfiguration
} from '../src/main/deployment-mode.ts';

test('server authentication is enabled by default for deployed clients', () => {
  assert.equal(isRemoteBackendDeployment({}), true);
  assert.equal(isRemoteBackendDeployment({ AI_UNIT_TEST_REMOTE_BACKEND: 'true' }), true);
  assert.equal(isRemoteBackendDeployment({ AI_UNIT_TEST_REMOTE_BACKEND: ' TRUE ' }), true);
});

test('legacy local runtime requires an explicit opt-out', () => {
  assert.equal(isRemoteBackendDeployment({ AI_UNIT_TEST_REMOTE_BACKEND: 'false' }), false);
  assert.equal(isRemoteBackendDeployment({ AI_UNIT_TEST_REMOTE_BACKEND: ' FALSE ' }), false);
});

test('the isolated E2E backend runtime keeps its managed local contract', () => {
  assert.equal(isRemoteBackendDeployment({
    AI_UNIT_TEST_REMOTE_BACKEND: 'true',
    AI_UNIT_TEST_E2E_BACKEND_RUNTIME: 'enabled'
  }), false);
});

test('the standalone client distribution is selected by its packaged resource marker', () => {
  const checked = [];
  const active = isExternalBackendClientDeployment(
    { isPackaged: true, resourcesPath: 'C:\\application\\resources' },
    (path) => {
      checked.push(path);
      return path.endsWith(EXTERNAL_BACKEND_CLIENT_MARKER);
    }
  );
  assert.equal(active, true);
  assert.equal(checked.length, 1);
  assert.match(checked[0], /external-backend-client\.json$/);
  assert.equal(isExternalBackendClientDeployment(
    { isPackaged: false, resourcesPath: 'C:\\application\\resources' },
    () => true
  ), false);
});

test('the packaged client accepts only a strict HTTPS remote backend config', () => {
  const expected = {
    schemaVersion: 1,
    backendMode: 'remote-backend-services',
    agentServiceUrl: 'https://woodwry.cn',
    javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer'
  };
  assert.deepEqual(parseExternalBackendClientConfiguration(expected), expected);
  assert.deepEqual(readExternalBackendClientConfiguration(
    { isPackaged: true, resourcesPath: 'C:\\application\\resources' },
    () => JSON.stringify(expected)
  ), expected);
  for (const invalid of [
    { ...expected, agentServiceUrl: 'http://woodwry.cn' },
    { ...expected, javaAnalyzerUrl: 'http://woodwry.cn/java-analyzer' },
    { ...expected, javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer?debug=1' },
    { schemaVersion: 1, backendMode: expected.backendMode, agentServiceUrl: expected.agentServiceUrl },
    { ...expected, backendMode: 'external-local' }
  ]) {
    assert.throws(() => parseExternalBackendClientConfiguration(invalid));
  }
});

test('the standalone client requires authentication', async () => {
  const mainSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(
    mainSource,
    /authenticationEnabled:\s*\(\)\s*=>\s*isRemoteBackendMode\(\)\s*\|\|\s*isExternalBackendClientMode\(\)/
  );
});
