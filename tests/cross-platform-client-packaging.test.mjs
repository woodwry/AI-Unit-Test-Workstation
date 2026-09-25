import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workstationRoot = new URL('../', import.meta.url);
const [packageJson, builderConfig, marker, workflow, legacyBuilderConfig] = await Promise.all([
  readFile(new URL('package.json', workstationRoot), 'utf8').then(JSON.parse),
  readFile(new URL('electron-builder.client.json', workstationRoot), 'utf8').then(JSON.parse),
  readFile(new URL('packaging/client/external-backend-client.json', workstationRoot), 'utf8').then(JSON.parse),
  readFile(new URL('.github/workflows/build-clients.yml', workstationRoot), 'utf8'),
  readFile(new URL('electron-builder.json', workstationRoot), 'utf8').then(JSON.parse)
]);

test('standalone client packaging keeps both backend services outside every client artifact', () => {
  assert.equal(builderConfig.publish, null);
  assert.deepEqual(builderConfig.files, ['out/**', 'package.json']);
  const commonSources = builderConfig.extraResources.map((entry) => entry.from);
  assert.ok(commonSources.includes('packaging/client/external-backend-client.json'));
  assert.equal(commonSources.includes('build-resources'), false);
  assert.equal('extraResources' in builderConfig.win, false);
  assert.equal(JSON.stringify(builderConfig).includes('agent-service.exe'), false);
  assert.equal(JSON.stringify(builderConfig).includes('backend/agent-service'), false);
  assert.equal(JSON.stringify(builderConfig).includes('java-analyzer'), false);
  assert.equal(JSON.stringify(builderConfig).includes('runtimes/java-21'), false);

  assert.equal(marker.backendMode, 'remote-backend-services');
  assert.equal(marker.agentServiceUrl, 'https://woodwry.cn');
  assert.equal(marker.javaAnalyzerUrl, 'https://woodwry.cn/java-analyzer');

  assert.ok(legacyBuilderConfig.extraResources.some((entry) => entry.from === 'build-resources'));
});

test('client packaging declares one native artifact format for each supported system', () => {
  assert.deepEqual(builderConfig.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.deepEqual(builderConfig.mac.target, [{ target: 'dmg', arch: ['universal'] }]);
  assert.deepEqual(builderConfig.linux.target, [{ target: 'tar.gz', arch: ['x64'] }]);
  assert.equal(
    builderConfig.win.artifactName,
    'AI-Unit-Test-Workstation-Setup-${version}-${arch}.${ext}'
  );
  assert.equal(
    builderConfig.mac.artifactName,
    'AI-Unit-Test-Workstation-${version}-macOS-${arch}.${ext}'
  );
  assert.equal(
    builderConfig.linux.artifactName,
    'AI-Unit-Test-Workstation-${version}-Linux-${arch}.${ext}'
  );
});

test('package scripts and native CI runners build all three client artifacts', () => {
  assert.match(packageJson.scripts['package:client:win'], /--win nsis --x64/);
  assert.match(packageJson.scripts['package:client:mac'], /--mac dmg --universal/);
  assert.match(packageJson.scripts['package:client:linux'], /--linux tar\.gz --x64/);
  assert.match(workflow, /os: windows-latest/);
  assert.match(workflow, /os: macos-latest/);
  assert.match(workflow, /os: ubuntu-latest/);
  assert.match(workflow, /output: release\/client\/\*-Setup-\*-x64\.exe/);
  assert.match(workflow, /output: release\/client\/\*-macOS-universal\.dmg/);
  assert.match(workflow, /output: release\/client\/\*-Linux-x64\.tar\.gz/);
  assert.match(workflow, /path: \$\{\{ matrix\.output \}\}/);
  assert.match(workflow, /npm install --global npm@11\.17\.0/);
  assert.match(workflow, /if-no-files-found: error/);
});
