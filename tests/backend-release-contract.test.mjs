import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseWindowsReleaseContract } from '../src/main/backend-runtime/release-contract.ts';

const contractUrl = new URL('../packaging/windows/release-contract.json', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const packageLockUrl = new URL('../package-lock.json', import.meta.url);
const nodeVersionUrl = new URL('../.node-version', import.meta.url);
const npmrcUrl = new URL('../.npmrc', import.meta.url);
const gitignoreUrl = new URL('../.gitignore', import.meta.url);
const builderUrl = new URL('../electron-builder.json', import.meta.url);
const buildInstallerUrl = new URL('../packaging/windows/build-installer.ps1', import.meta.url);

async function readContract() {
  return JSON.parse(await readFile(contractUrl, 'utf8'));
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

test('parses the canonical Windows x64 release contract', async () => {
  const contract = parseWindowsReleaseContract(await readContract());
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.product, {
    id: 'ai-unit-test-workstation',
    version: '0.1.3',
    appId: 'com.aiunittest.workstation',
    productName: 'AI Unit Test Workstation',
    platform: 'win32',
    arch: 'x64',
    minimumWindowsVersion: '10.0.17763'
  });
  assert.deepEqual(contract.toolchain, {
    node: '22.14.0',
    npm: '11.17.0',
    python: '3.11.9',
    pipTools: '7.5.2',
    pyinstaller: '6.16.0',
    maven: '3.9.9',
    buildJdk: '21.0.11+9',
    javaRuntimeVendor: 'Eclipse Temurin',
    javaRuntimeVersion: '21.0.11+10'
  });
});

test('defines exactly analyzer then agent with safe resource-relative paths', async () => {
  const contract = parseWindowsReleaseContract(await readContract());
  assert.deepEqual(contract.services.map((service) => service.id), ['java-analyzer', 'agent-service']);
  for (const service of contract.services) {
    assert.equal(service.host, '127.0.0.1');
    assert.equal(service.port, 0);
    assert.ok(!service.executableRelativePath.includes('..'));
    assert.ok(!/^[a-z]:[\\/]/i.test(service.executableRelativePath));
  }
  assert.equal(contract.services[0].startupTimeoutMs, 45_000);
  assert.equal(contract.services[1].startupTimeoutMs, 60_000);
});

test('uses one versioned runtime environment vocabulary without secret values', async () => {
  const contract = parseWindowsReleaseContract(await readContract());
  assert.equal(contract.runtime.protocol, 1);
  assert.deepEqual(contract.runtime.paths, {
    live: '/api/internal/live',
    ready: '/api/internal/ready'
  });
  assert.deepEqual(contract.runtime.environment, {
    protocol: 'AI_UNIT_TEST_RUNTIME_PROTOCOL',
    mode: 'AI_UNIT_TEST_RUNTIME_MODE',
    service: 'AI_UNIT_TEST_SERVICE',
    instanceId: 'AI_UNIT_TEST_INSTANCE_ID',
    parentPid: 'AI_UNIT_TEST_PARENT_PID',
    accessToken: 'AI_UNIT_TEST_ACCESS_TOKEN',
    analyzerBaseUrl: 'AGENT_JAVA_ANALYZER_BASE_URL',
    analyzerAccessToken: 'AGENT_JAVA_ANALYZER_ACCESS_TOKEN',
    serverHost: 'AGENT_SERVER_HOST',
    serverPort: 'AGENT_SERVER_PORT',
    serverReload: 'AGENT_SERVER_RELOAD'
  });
  for (const value of Object.values(contract.runtime.environment)) {
    assert.match(value, /^[A-Z][A-Z0-9_]+$/);
  }
  assert.doesNotMatch(JSON.stringify(contract), /sk-[a-z0-9]|dashscope.*key/i);
});

test('rejects missing or renamed runtime environment variables', async () => {
  const source = await readContract();
  const missing = structuredClone(source);
  delete missing.runtime.environment.serverHost;
  assert.throws(() => parseWindowsReleaseContract(missing), /runtime\.environment\.serverHost/);

  const renamed = structuredClone(source);
  renamed.runtime.environment.serverPort = 'AGENT_PORT';
  assert.throws(() => parseWindowsReleaseContract(renamed), /runtime\.environment\.serverPort/);
});

test('rejects path traversal and non-loopback runtime values', async () => {
  const source = await readContract();
  assert.throws(
    () => parseWindowsReleaseContract({ ...source, runtime: { ...source.runtime, host: '0.0.0.0' } }),
    /runtime.host/
  );
  const services = structuredClone(source.services);
  services[0].executableRelativePath = '../java.exe';
  assert.throws(() => parseWindowsReleaseContract({ ...source, services }), /relative path/);
});

test('rejects Windows drive-relative resource paths', async () => {
  const source = await readContract();
  for (const executableRelativePath of ['C:outside.exe', 'C:..\\outside.exe']) {
    const services = structuredClone(source.services);
    services[0].executableRelativePath = executableRelativePath;
    assert.throws(
      () => parseWindowsReleaseContract({ ...source, services }),
      /relative path/,
      executableRelativePath
    );
  }
});

test('pins the workstation Node toolchain and every direct dependency', async () => {
  const [contract, manifest, lock, nodeVersion] = await Promise.all([
    readContract(),
    readJson(packageUrl),
    readJson(packageLockUrl),
    readFile(nodeVersionUrl, 'utf8')
  ]);
  const exactDependencies = {
    '@xmldom/xmldom': '0.9.12',
    electron: '44.4.5',
    yauzl: '2.10.0'
  };
  const exactDevDependencies = {
    '@playwright/test': '1.55.0',
    '@types/node': '22.20.0',
    '@types/react': '18.3.31',
    '@types/react-dom': '18.3.7',
    '@types/yauzl': '2.10.3',
    '@codingame/monaco-vscode-api': '34.1.3',
    '@codingame/monaco-vscode-configuration-service-override': '34.1.3',
    '@codingame/monaco-vscode-files-service-override': '34.1.3',
    '@codingame/monaco-vscode-host-service-override': '34.1.3',
    '@codingame/monaco-vscode-quickaccess-service-override': '34.1.3',
    '@codingame/monaco-vscode-textmate-service-override': '34.1.3',
    '@codingame/monaco-vscode-theme-service-override': '34.1.3',
    '@vitejs/plugin-react': '4.7.0',
    'electron-builder': '26.0.12',
    'electron-vite': '2.3.0',
    'lucide-react': '1.22.0',
    'monaco-editor': 'npm:@codingame/monaco-vscode-editor-api@34.1.3',
    react: '18.3.1',
    'react-dom': '18.3.1',
    typescript: '5.9.3',
    vite: '5.4.21'
  };

  assert.deepEqual(manifest.engines, { node: '22.14.0', npm: '11.17.0' });
  assert.equal(manifest.packageManager, 'npm@11.17.0');
  assert.equal(nodeVersion.trim(), '22.14.0');
  assert.equal(manifest.version, contract.product.version);
  assert.equal(manifest.engines.node, contract.toolchain.node);
  assert.equal(manifest.engines.npm, contract.toolchain.npm);
  assert.deepEqual(manifest.dependencies, exactDependencies);
  assert.deepEqual(manifest.devDependencies, exactDevDependencies);

  assert.equal(lock.lockfileVersion, 3);
  const lockRoot = lock.packages[''];
  assert.equal(lockRoot.name, manifest.name);
  assert.equal(lockRoot.version, manifest.version);
  assert.deepEqual(lockRoot.engines, manifest.engines);
  assert.deepEqual(lockRoot.dependencies, manifest.dependencies);
  assert.deepEqual(lockRoot.devDependencies, manifest.devDependencies);

  for (const [kind, dependencies] of [
    ['dependencies', manifest.dependencies],
    ['devDependencies', manifest.devDependencies]
  ]) {
    for (const [name, spec] of Object.entries(dependencies)) {
      assert.equal(lockRoot[kind][name], spec, `${name} root lock spec`);
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `${name} package lock entry`);
      const alias = /^npm:(@codingame\/[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec);
      const expectedVersion = alias?.[2] ?? spec;
      assert.equal(entry.version, expectedVersion, `${name} resolved version`);
      if (alias) {
        assert.match(entry.resolved, new RegExp(`/${alias[1]}/-/[^/]+-${expectedVersion}\\.tgz$`));
      }
    }
  }
});

test('does not declare the Monaco React wrapper', async () => {
  const manifest = await readJson(packageUrl);
  assert.equal(Object.hasOwn(manifest.dependencies, '@monaco-editor/react'), false);
});

test('does not lock Monaco React wrapper transitives', async () => {
  const lock = await readJson(packageLockUrl);
  const lockRoot = lock.packages[''];

  assert.equal(Object.hasOwn(lockRoot.dependencies, '@monaco-editor/react'), false);
  assert.equal(Object.hasOwn(lock.packages, 'node_modules/@monaco-editor/react'), false);
  assert.equal(Object.hasOwn(lock.packages, 'node_modules/@monaco-editor/loader'), false);
  assert.equal(Object.hasOwn(lock.packages, 'node_modules/state-local'), false);
});

test('locks the complete electron-builder package', async () => {
  const lock = await readJson(packageLockUrl);

  const builderEntry = lock.packages['node_modules/electron-builder'];
  assert.ok(builderEntry, 'electron-builder package lock entry');
  assert.equal(builderEntry.version, '26.0.12');
  assert.match(builderEntry.resolved, /electron-builder-26\.0\.12\.tgz$/);
  assert.match(builderEntry.integrity, /^sha512-/);
  assert.ok(Object.keys(builderEntry.dependencies).length > 0);
});

test('defines an assisted per-user NSIS installer contract', async () => {
  const [contract, manifest, builder, npmrc, gitignore] = await Promise.all([
    readContract(),
    readJson(packageUrl),
    readJson(builderUrl),
    readFile(npmrcUrl, 'utf8'),
    readFile(gitignoreUrl, 'utf8')
  ]);
  const ignoredPaths = gitignore.split(/\r?\n/).filter(Boolean);

  assert.equal(npmrc.replace(/\r\n/g, '\n'), 'save-exact=true\nengine-strict=true\n');
  assert.doesNotMatch(npmrc, /mirror/i);
  assert.ok(ignoredPaths.includes('build-resources/'));
  assert.ok(ignoredPaths.includes('release/'));
  assert.equal(
    manifest.scripts['package:win'],
    'powershell -ExecutionPolicy Bypass -File packaging/windows/generate-branding-assets.ps1 && npm run build && electron-builder --config electron-builder.json --win nsis --x64'
  );
  assert.deepEqual(builder, {
    appId: 'com.aiunittest.workstation',
    productName: 'AI Unit Test Workstation',
    asar: true,
    publish: null,
    directories: { output: 'release' },
    files: ['out/**', 'package.json'],
    extraResources: [
      { from: 'build-resources', to: '.' },
      {
        from: 'assets/branding/ai-unit-test-workstation.ico',
        to: 'branding/ai-unit-test-workstation.ico'
      }
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'assets/branding/ai-unit-test-workstation.ico',
      artifactName: 'AI-Unit-Test-Workstation-Setup-${version}-${arch}.${ext}'
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      installerIcon: 'assets/branding/ai-unit-test-workstation.ico',
      uninstallerIcon: 'assets/branding/ai-unit-test-workstation.ico',
      include: 'packaging/windows/installer.nsh'
    }
  });
  assert.equal(builder.appId, contract.product.appId);
  assert.equal(builder.productName, contract.product.productName);
  assert.equal(builder.win.target[0].target, contract.installer.kind);
  assert.deepEqual(builder.win.target[0].arch, [contract.product.arch]);
  assert.equal(builder.win.artifactName, contract.installer.artifactName);
  for (const key of [
    'oneClick',
    'perMachine',
    'allowToChangeInstallationDirectory',
    'createDesktopShortcut',
    'createStartMenuShortcut'
  ]) {
    assert.equal(builder.nsis[key], contract.installer[key], key);
  }
  assert.equal(builder.publish, null, '未配置正式升级渠道时必须禁止 electron-builder 从 Git remote 推断发布地址');
});

test('removes unsafe update metadata and candidate artifacts before failing the installer build', async () => {
  const script = await readFile(buildInstallerUrl, 'utf8');

  assert.match(
    script,
    /\$preBuildCleanupTargets = @\(\$CandidateInstallerArtifacts\) \+ @\(\$ForbiddenImplicitUpdateMetadata\)[\s\S]*foreach \(\$path in \$preBuildCleanupTargets\)[\s\S]*Remove-Item -LiteralPath \$path -Force -ErrorAction Stop[\s\S]*& \$StageScript/,
    '正式构建前必须删除同版本旧候选产物，避免失败后误取旧安装器'
  );
  assert.match(
    script,
    /if \(\$detectedUpdateMetadata\.Count -gt 0\) \{[\s\S]*\$cleanupTargets = @\(\$CandidateInstallerArtifacts\) \+ @\(\$detectedUpdateMetadata\)[\s\S]*foreach \(\$path in \$cleanupTargets\) \{[\s\S]*try \{[\s\S]*Remove-Item -LiteralPath \$path -Force -ErrorAction Stop[\s\S]*catch \{[\s\S]*\$cleanupFailures \+=[\s\S]*\$remainingPaths = @\([\s\S]*throw \$failureMessage/,
    '隐式更新元数据必须触发元数据和候选安装器的失败关闭清理'
  );
  assert.match(
    script,
    /\$buildValidated = \$false[\s\S]*\$buildValidated = \$true[\s\S]*finally \{[\s\S]*if \(-not \$buildValidated\) \{[\s\S]*\$failedBuildCleanupTargets = @\(\$CandidateInstallerArtifacts\) \+ @\(\$ForbiddenImplicitUpdateMetadata\)[\s\S]*Remove-Item -LiteralPath \$path -Force -ErrorAction Stop[\s\S]*Write-Warning/,
    'electron-builder 在任意收尾阶段失败后都必须尽力删除部分候选产物并报告残留'
  );
});

test('pins exact electron-builder helper caches and forces the validated local cache path', async () => {
  const script = await readFile(buildInstallerUrl, 'utf8');

  for (const version of ['3.0.4.1', '3.4.1', '2.6.0']) {
    assert.match(script, new RegExp(version.replaceAll('.', '\\.')));
  }
  assert.match(script, /SetEnvironmentVariable\('ELECTRON_BUILDER_CACHE', \$builderCache, 'Process'\)/);
});
