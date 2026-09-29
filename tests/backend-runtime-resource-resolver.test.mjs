import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { BackendResourceResolver } from '../src/main/backend-runtime/backend-resource-resolver.ts';
import { parseWindowsReleaseContract } from '../src/main/backend-runtime/release-contract.ts';

const contractUrl = new URL('../packaging/windows/release-contract.json', import.meta.url);

async function readContract() {
  return parseWindowsReleaseContract(JSON.parse(await readFile(contractUrl, 'utf8')));
}

async function writeResource(path, content = 'fixture') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function makePackagedResources(context) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'workstation-backend-resources-'));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const paths = {
    java: join(temporaryRoot, 'runtimes', 'java-21', 'bin', 'javaw.exe'),
    jar: join(temporaryRoot, 'backend', 'java-analyzer', 'java-analyzer.jar'),
    agent: join(temporaryRoot, 'backend', 'agent-service', 'agent-service.exe'),
    manifest: join(temporaryRoot, 'backend-manifest.json'),
    licenses: join(temporaryRoot, 'licenses')
  };
  await Promise.all([
    writeResource(paths.java),
    writeResource(paths.jar),
    writeResource(paths.agent),
    writeResource(paths.manifest, '{}'),
    mkdir(paths.licenses, { recursive: true })
  ]);
  return { root: await realpath(temporaryRoot), paths };
}

test('resolves every packaged resource below resourcesPath and verifies its type', async (context) => {
  const { root } = await makePackagedResources(context);
  const resolver = new BackendResourceResolver();
  const resources = await resolver.resolvePackaged(root, await readContract());

  assert.equal(resources.mode, 'packaged');
  assert.equal(resources.resourcesRoot, root);
  assert.equal(isAbsolute(resources.backendManifestPath), true);
  assert.equal(isAbsolute(resources.licensesPath), true);
  assert.equal(resources.services.javaAnalyzer.id, 'java-analyzer');
  assert.equal(resources.services.agentService.id, 'agent-service');
  assert.equal(resources.services.javaAnalyzer.arguments[0], '-jar');
  assert.equal(isAbsolute(resources.services.javaAnalyzer.arguments[1]), true);
  assert.deepEqual(
    resources.services.javaAnalyzer.requiredFilePaths,
    [resources.services.javaAnalyzer.arguments[1]]
  );
  assert.equal(Object.isFrozen(resources.services), true);
  assert.equal(Object.isFrozen(resources.services.javaAnalyzer.arguments), true);
});

test('rejects traversal before a packaged executable can escape resourcesPath', async (context) => {
  const { root } = await makePackagedResources(context);
  const contract = structuredClone(await readContract());
  contract.services[1].executableRelativePath = '../outside.exe';
  await assert.rejects(
    () => new BackendResourceResolver().resolvePackaged(root, contract),
    /agent-service executable/
  );
});

test('rejects missing packaged manifest and does not fall back to another directory', async (context) => {
  const { root, paths } = await makePackagedResources(context);
  const contract = await readContract();
  await rm(paths.manifest);
  await assert.rejects(
    () => new BackendResourceResolver().resolvePackaged(root, contract),
    /backend manifest/
  );
});

test('requires complete explicit development commands and verifies their paths', async (context) => {
  const { root, paths } = await makePackagedResources(context);
  const input = {
    javaAnalyzer: {
      executablePath: paths.java,
      arguments: ['-jar', paths.jar, '--server.address=127.0.0.1', '--server.port=0'],
      workingDirectory: root,
      requiredFilePaths: [paths.jar],
      startupTimeoutMs: 45_000,
      shutdownTimeoutMs: 10_000
    },
    agentService: {
      executablePath: paths.agent,
      arguments: [],
      workingDirectory: dirname(paths.agent),
      requiredFilePaths: [],
      startupTimeoutMs: 60_000,
      shutdownTimeoutMs: 10_000
    }
  };

  const resources = await new BackendResourceResolver().resolveDevelopment(input);
  assert.equal(resources.mode, 'development');
  assert.equal(resources.services.javaAnalyzer.executablePath, await realpath(paths.java));
  assert.equal(resources.services.agentService.workingDirectory, await realpath(dirname(paths.agent)));
  await assert.rejects(
    () => new BackendResourceResolver().resolveDevelopment(undefined),
    /开发态显式配置/
  );
});

test('development mode rejects implicit relative executable paths', async (context) => {
  const { root, paths } = await makePackagedResources(context);
  const service = {
    executablePath: 'agent-service.exe',
    arguments: [],
    workingDirectory: root,
    requiredFilePaths: [],
    startupTimeoutMs: 1,
    shutdownTimeoutMs: 1
  };
  await assert.rejects(
    () => new BackendResourceResolver().resolveDevelopment({
      javaAnalyzer: { ...service, executablePath: paths.java },
      agentService: service
    }),
    /agent-service executable/
  );
});
