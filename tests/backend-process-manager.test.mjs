import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { redactBackendLogText } from '../src/main/backend-runtime/backend-log-sink.ts';
import { BackendProcessManager } from '../src/main/backend-runtime/backend-process-manager.ts';
import { BackendRuntimeRegistry } from '../src/main/backend-runtime/backend-runtime-registry.ts';
import { parseWindowsReleaseContract } from '../src/main/backend-runtime/release-contract.ts';

const contractUrl = new URL('../packaging/windows/release-contract.json', import.meta.url);
const instanceId = '550e8400-e29b-41d4-a716-446655440000';
let parsedContract;

async function contract() {
  parsedContract ??= parseWindowsReleaseContract(JSON.parse(await readFile(contractUrl, 'utf8')));
  return parsedContract;
}

function resolvedCommand(id) {
  return {
    id,
    executablePath: `D:\\resources\\${id}.exe`,
    arguments: [],
    workingDirectory: 'D:\\resources',
    requiredFilePaths: [],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  };
}

function fakeResourceResolver() {
  return {
    async resolvePackaged() {
      return {
        mode: 'packaged',
        resourcesRoot: 'D:\\resources',
        backendManifestPath: 'D:\\resources\\backend-manifest.json',
        licensesPath: 'D:\\resources\\licenses',
        services: {
          javaAnalyzer: resolvedCommand('java-analyzer'),
          agentService: resolvedCommand('agent-service')
        }
      };
    }
  };
}

function memoryLogSink() {
  const records = [];
  return {
    records,
    writeLine(channel, message, sensitiveValues = []) {
      records.push({ channel, message: redactBackendLogText(message, sensitiveValues) });
      return Promise.resolve();
    },
    writeEvent(channel, event, sensitiveValues = []) {
      records.push({
        channel,
        event: JSON.parse(redactBackendLogText(JSON.stringify(event), sensitiveValues))
      });
      return Promise.resolve();
    },
    flush() {
      return Promise.resolve();
    }
  };
}

function deterministicRandomBytes() {
  let value = 0;
  return () => Buffer.alloc(32, ++value);
}

async function createFixture(overrides = {}) {
  const registry = overrides.registry ?? new BackendRuntimeRegistry(() => 123456);
  const logSink = overrides.logSink ?? memoryLogSink();
  const processOptions = [];
  const stopOrder = [];
  const starts = [];
  const controllers = new Map();
  const processFactory = overrides.processFactory ?? ((options) => {
    processOptions.push(options);
    const service = options.command.id;
    const controller = {
      service,
      start: async () => {
        starts.push(service);
        if (service === 'java-analyzer') {
          return {
            service,
            pid: 4101,
            port: 49151,
            baseUrl: 'http://127.0.0.1:49151'
          };
        }
        return {
          service,
          pid: 4102,
          port: 49152,
          baseUrl: 'http://127.0.0.1:49152'
        };
      },
      stop: async () => {
        stopOrder.push(service);
      }
    };
    controllers.set(service, { controller, options });
    return controller;
  });
  const manager = new BackendProcessManager({
    contract: await contract(),
    registry,
    logSink,
    resourcesPath: 'D:\\resources',
    resourceResolver: overrides.resourceResolver ?? fakeResourceResolver(),
    processFactory,
    inheritedEnvironment: overrides.inheritedEnvironment ?? {
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
      MODEL_API_KEY: 'model-key-marker',
      AI_UNIT_TEST_ACCESS_TOKEN: 'stale-runtime-token',
      AI_UNIT_TEST_INSTANCE_ID: 'stale-instance',
      AGENT_SERVER_HOST: '0.0.0.0',
      agent_java_analyzer_access_token: 'stale-analyzer-token'
    },
    parentPid: 9000,
    randomUUID: () => instanceId,
    randomBytes: overrides.randomBytes ?? deterministicRandomBytes()
  });
  return {
    manager,
    registry,
    logSink,
    processOptions,
    stopOrder,
    starts,
    controllers
  };
}

test('reuses concurrent start, starts analyzer first and atomically publishes both services', async () => {
  const fixture = await createFixture();
  const statuses = [];
  fixture.manager.subscribe((status) => statuses.push(status));

  const first = fixture.manager.start();
  const second = fixture.manager.start();
  assert.equal(first, second);
  const snapshot = await first;

  assert.deepEqual(fixture.starts, ['java-analyzer', 'agent-service']);
  assert.equal(fixture.registry.getReadySnapshot(), snapshot);
  assert.equal(snapshot.instanceId, instanceId);
  assert.equal(snapshot.javaAnalyzer.baseUrl, 'http://127.0.0.1:49151');
  assert.equal(snapshot.agentService.baseUrl, 'http://127.0.0.1:49152');
  assert.deepEqual(statuses.map((status) => status.state), [
    'idle',
    'starting-analyzer',
    'starting-agent',
    'ready'
  ]);
  assert.equal(fixture.manager.getStatus().message, '本地服务已就绪。');

  const serializedStatuses = JSON.stringify(statuses);
  assert.doesNotMatch(serializedStatuses, /127\.0\.0\.1|4915[12]|410[12]/);
  assert.doesNotMatch(serializedStatuses, new RegExp(instanceId));
  assert.equal(Object.isFrozen(fixture.manager.getStatus()), true);
});

test('uses one instance, independent tokens and service-specific sanitized environments', async () => {
  const fixture = await createFixture();
  await fixture.manager.start();
  assert.equal(fixture.processOptions.length, 2);
  const analyzer = fixture.processOptions[0];
  const agent = fixture.processOptions[1];
  const names = (await contract()).runtime.environment;

  assert.equal(analyzer.instanceId, instanceId);
  assert.equal(agent.instanceId, instanceId);
  assert.equal(analyzer.accessToken.length, 43);
  assert.equal(agent.accessToken.length, 43);
  assert.notEqual(analyzer.accessToken, agent.accessToken);

  assert.equal(analyzer.environment.SystemRoot, 'C:\\Windows');
  assert.equal(analyzer.environment.Path, 'C:\\Windows\\System32');
  assert.equal(analyzer.environment.MODEL_API_KEY, undefined);
  assert.equal(analyzer.environment[names.service], 'java-analyzer');
  assert.equal(analyzer.environment[names.instanceId], instanceId);
  assert.equal(analyzer.environment[names.parentPid], '9000');
  assert.equal(analyzer.environment[names.accessToken], analyzer.accessToken);
  assert.equal(analyzer.environment[names.analyzerBaseUrl], undefined);

  assert.equal(agent.environment.MODEL_API_KEY, 'model-key-marker');
  assert.equal(agent.environment[names.service], 'agent-service');
  assert.equal(agent.environment[names.accessToken], agent.accessToken);
  assert.equal(agent.environment[names.analyzerBaseUrl], 'http://127.0.0.1:49151');
  assert.equal(agent.environment[names.analyzerAccessToken], analyzer.accessToken);
  assert.equal(agent.environment[names.serverHost], '127.0.0.1');
  assert.equal(agent.environment[names.serverPort], '0');
  assert.equal(agent.environment[names.serverReload], 'false');
  assert.equal(agent.environment.agent_java_analyzer_access_token, undefined);
  assert.doesNotMatch(JSON.stringify(fixture.logSink.records), new RegExp(analyzer.accessToken));
  assert.doesNotMatch(JSON.stringify(fixture.logSink.records), new RegExp(agent.accessToken));
});

test('stops in agent-to-analyzer order and synchronously publishes safe lifecycle states', async () => {
  const fixture = await createFixture();
  const statuses = [];
  const unsubscribe = fixture.manager.subscribe((status) => statuses.push(status));
  await fixture.manager.start();

  const stopping = fixture.manager.stop();
  assert.equal(fixture.manager.getStatus().state, 'stopping');
  assert.equal(fixture.registry.getReadySnapshot(), null);
  await stopping;
  assert.deepEqual(fixture.stopOrder, ['agent-service', 'java-analyzer']);
  assert.equal(fixture.manager.getStatus().state, 'stopped');
  assert.deepEqual(statuses.slice(-2).map((status) => status.state), ['stopping', 'stopped']);

  unsubscribe();
  await fixture.manager.stop();
  assert.equal(statuses.at(-1).state, 'stopped');
});

test('rolls back both processes and exposes only a product error when agent start fails', async () => {
  const stopOrder = [];
  const optionsSeen = [];
  const processFactory = (options) => {
    optionsSeen.push(options);
    const service = options.command.id;
    return {
      service,
      start: async () => {
        if (service === 'agent-service') {
          throw new Error('internal-marker D:\\private\\agent.exe');
        }
        return {
          service,
          pid: 5101,
          port: 50101,
          baseUrl: 'http://127.0.0.1:50101'
        };
      },
      stop: async () => {
        stopOrder.push(service);
      }
    };
  };
  const fixture = await createFixture({ processFactory });

  await assert.rejects(fixture.manager.start(), (error) => {
    assert.equal(error.message, '本地后端组件启动失败，请重试。');
    assert.doesNotMatch(error.message, /internal-marker|private|agent\.exe/);
    return true;
  });
  assert.equal(optionsSeen.length, 2);
  assert.deepEqual(stopOrder, ['agent-service', 'java-analyzer']);
  assert.equal(fixture.registry.getReadySnapshot(), null);
  assert.deepEqual(fixture.manager.getStatus(), {
    state: 'failed',
    message: '本地服务不可用，请重试。',
    retryable: true
  });
});

test('clears the registry, publishes failed once and stops the sibling on unexpected exit', async () => {
  const fixture = await createFixture();
  const states = [];
  fixture.manager.subscribe((status) => states.push(status.state));
  await fixture.manager.start();
  const agentOptions = fixture.controllers.get('agent-service').options;

  agentOptions.onUnexpectedExit({
    service: 'agent-service',
    pid: 4102,
    exitCode: 7
  });
  assert.equal(fixture.registry.getReadySnapshot(), null);
  assert.equal(fixture.manager.getStatus().state, 'failed');
  agentOptions.onUnexpectedExit({
    service: 'agent-service',
    pid: 4102,
    exitCode: 7
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(states.filter((state) => state === 'failed').length, 1);
  assert.deepEqual(fixture.stopOrder, ['agent-service', 'java-analyzer']);
  assert.equal(fixture.processOptions.length, 2, '异常退出后不得自动重启');
});

test('rejects reused random tokens before spawning a process', async () => {
  const sameRandomBytes = () => Buffer.alloc(32, 9);
  const fixture = await createFixture({ randomBytes: sameRandomBytes });

  await assert.rejects(fixture.manager.start(), /本地后端组件启动失败/);
  assert.equal(fixture.processOptions.length, 0);
  assert.equal(fixture.registry.getReadySnapshot(), null);
  assert.equal(fixture.manager.getStatus().state, 'failed');
});
