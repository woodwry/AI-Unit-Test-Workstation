import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { redactBackendLogText } from '../src/main/backend-runtime/backend-log-sink.ts';
import {
  ManagedBackendProcess,
  ManagedBackendProcessError
} from '../src/main/backend-runtime/managed-backend-process.ts';

const instanceId = '550e8400-e29b-41d4-a716-446655440000';
const accessToken = 'a'.repeat(43);

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killedWith = [];
  }

  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }

  exit(code = 0) {
    this.emit('exit', code, null);
    this.stdout.end();
    this.stderr.end();
  }
}

function command(overrides = {}) {
  return {
    id: 'java-analyzer',
    executablePath: 'D:\\runtime\\java.exe',
    arguments: ['-jar', 'D:\\runtime\\analyzer.jar'],
    workingDirectory: 'D:\\runtime',
    requiredFilePaths: ['D:\\runtime\\analyzer.jar'],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    ...overrides
  };
}

function handshake(service = 'java-analyzer', pid = 4321, port = 49152) {
  return {
    protocol: 1,
    service,
    instanceId,
    pid,
    host: '127.0.0.1',
    port
  };
}

function statusBody(status, service = 'java-analyzer') {
  return { protocol: 1, service, instanceId, status };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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

function createManaged({
  child = new FakeChild(4321),
  fetch = async () => jsonResponse(200, statusBody('ready')),
  sleep = async () => undefined,
  spawn,
  commandOverrides = {},
  logSink = memoryLogSink(),
  onUnexpectedExit
} = {}) {
  const spawnCalls = [];
  const spawnProcess = spawn ?? ((executablePath, arguments_, options) => {
    spawnCalls.push({ executablePath, arguments_, options });
    return child;
  });
  const managed = new ManagedBackendProcess({
    command: command(commandOverrides),
    instanceId,
    accessToken,
    environment: {
      SystemRoot: 'C:\\Windows',
      AI_UNIT_TEST_ACCESS_TOKEN: accessToken
    },
    readyPath: '/api/internal/ready',
    logSink,
    fetch,
    sleep,
    spawn: spawnProcess,
    platform: 'win32',
    taskkillExecutablePath: 'C:\\Windows\\System32\\taskkill.exe',
    onUnexpectedExit
  });
  return { managed, child, spawnCalls, logSink };
}

test('spawns without a shell, decodes stdout lines and validates handshake plus readiness', async () => {
  const fetchCalls = [];
  const delays = [];
  const responses = [
    jsonResponse(503, statusBody('not_ready')),
    jsonResponse(503, statusBody('not_ready')),
    jsonResponse(200, statusBody('ready'))
  ];
  const fixture = createManaged({
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return responses.shift();
    },
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    }
  });

  const starting = fixture.managed.start();
  const startupLog = Buffer.from('Spring 正在启动\r\n', 'utf8');
  fixture.child.stdout.write(startupLog.subarray(0, 9));
  fixture.child.stdout.write(startupLog.subarray(9));
  const line = Buffer.from(`${JSON.stringify(handshake())}\r\n`, 'utf8');
  fixture.child.stdout.write(line.subarray(0, 17));
  fixture.child.stdout.write(line.subarray(17));
  const ready = await starting;

  assert.deepEqual(ready, {
    service: 'java-analyzer',
    pid: 4321,
    port: 49152,
    baseUrl: 'http://127.0.0.1:49152'
  });
  assert.equal(Object.isFrozen(ready), true);
  assert.equal(fixture.spawnCalls.length, 1);
  assert.deepEqual(fixture.spawnCalls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(fixture.spawnCalls[0].options.shell, false);
  assert.equal(fixture.spawnCalls[0].options.windowsHide, true);
  assert.deepEqual(delays, [250, 500]);
  assert.deepEqual(fetchCalls.map((call) => call.url), [
    'http://127.0.0.1:49152/api/internal/ready',
    'http://127.0.0.1:49152/api/internal/ready',
    'http://127.0.0.1:49152/api/internal/ready'
  ]);
  for (const { init } of fetchCalls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${accessToken}`);
  }

  let controlInput = '';
  fixture.child.stdin.on('data', (chunk) => {
    controlInput += chunk.toString('utf8');
  });
  const stopping = fixture.managed.stop();
  fixture.child.exit(0);
  await stopping;
  assert.equal(controlInput, 'shutdown\n');
});

test('rejects an exact-looking but invalid JSON handshake without echoing its content', async () => {
  const marker = 'secret-handshake-marker';
  const fixture = createManaged();
  const starting = fixture.managed.start();
  fixture.child.stdout.write(`${JSON.stringify({ ...handshake(), extra: marker })}\n`);

  await assert.rejects(starting, (error) => {
    assert.ok(error instanceof ManagedBackendProcessError);
    assert.equal(error.reason, 'invalid-handshake');
    assert.match(error.message, /本地代码分析服务启动失败/);
    assert.doesNotMatch(error.message, new RegExp(marker));
    return true;
  });
  const stopping = fixture.managed.stop();
  fixture.child.exit(1);
  await stopping;
});

test('accepts only the fixed 200 ready and 503 not_ready response combinations', async () => {
  const fixture = createManaged({
    fetch: async () => jsonResponse(200, statusBody('not_ready'))
  });
  const starting = fixture.managed.start();
  fixture.child.stdout.write(`${JSON.stringify(handshake())}\n`);

  await assert.rejects(starting, (error) => {
    assert.ok(error instanceof ManagedBackendProcessError);
    assert.equal(error.reason, 'invalid-readiness');
    assert.doesNotMatch(error.message, /not_ready|49152|Bearer/);
    return true;
  });
  const stopping = fixture.managed.stop();
  fixture.child.exit(1);
  await stopping;
});

test('turns exit-before-ready and startup timeout into product errors', async () => {
  const exited = createManaged();
  const exitedStart = exited.managed.start();
  exited.child.exit(23);
  await assert.rejects(exitedStart, (error) => {
    assert.ok(error instanceof ManagedBackendProcessError);
    assert.equal(error.reason, 'exited-before-ready');
    assert.doesNotMatch(error.message, /23|4321/);
    return true;
  });

  const timedOut = createManaged({ commandOverrides: { startupTimeoutMs: 5 } });
  await assert.rejects(timedOut.managed.start(), (error) => {
    assert.ok(error instanceof ManagedBackendProcessError);
    assert.equal(error.reason, 'startup-timeout');
    assert.match(error.message, /启动超时/);
    return true;
  });
  const stopping = timedOut.managed.stop();
  timedOut.child.exit(1);
  await stopping;
});

test('publishes one unexpected-exit event only after the process was ready', async () => {
  const exits = [];
  const fixture = createManaged({ onUnexpectedExit: (event) => exits.push(event) });
  const starting = fixture.managed.start();
  fixture.child.stdout.write(`${JSON.stringify(handshake())}\n`);
  await starting;

  fixture.child.emit('error', new Error('process pipe failed'));
  fixture.child.emit('exit', 9, null);
  assert.deepEqual(exits, [{ service: 'java-analyzer', pid: 4321, exitCode: null }]);
});

test('uses taskkill with an argument array after the graceful deadline and never logs the token', async () => {
  const serviceChild = new FakeChild(4321);
  const killer = new EventEmitter();
  const spawnCalls = [];
  const logSink = memoryLogSink();
  const spawn = (executablePath, arguments_, options) => {
    spawnCalls.push({ executablePath, arguments_, options });
    if (spawnCalls.length === 1) return serviceChild;
    queueMicrotask(() => {
      killer.emit('exit', 0, null);
      serviceChild.exit(1);
    });
    return killer;
  };
  const fixture = createManaged({
    child: serviceChild,
    spawn,
    commandOverrides: { shutdownTimeoutMs: 5 },
    logSink
  });
  const starting = fixture.managed.start();
  serviceChild.stdout.write(`${JSON.stringify(handshake())}\n`);
  await starting;
  serviceChild.stderr.write(`Authorization: Bearer ${accessToken}\n`);
  await fixture.managed.stop();

  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[1].executablePath, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(spawnCalls[1].arguments_, ['/PID', '4321', '/T', '/F']);
  assert.equal(spawnCalls[1].options.shell, false);
  assert.equal(spawnCalls[1].options.windowsHide, true);
  assert.equal(spawnCalls[1].options.stdio, 'ignore');
  assert.doesNotMatch(JSON.stringify(spawnCalls.map((call) => call.arguments_)), new RegExp(accessToken));
  assert.doesNotMatch(JSON.stringify(logSink.records), new RegExp(accessToken));
});
