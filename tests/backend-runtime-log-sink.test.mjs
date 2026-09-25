import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BackendLogSink,
  redactBackendLogText
} from '../src/main/backend-runtime/backend-log-sink.ts';

const runtimeToken = 'runtime-token-value-that-must-never-reach-a-log';

async function makeLogDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-backend-logs-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('redacts explicit secrets, Bearer values and common API key forms', () => {
  const raw = [
    `Authorization: Bearer ${runtimeToken}`,
    'DASHSCOPE_API_KEY=environment-secret',
    '{"apiKey":"json-secret","credentials":{"api_key":"nested-secret"}}',
    'https://example.invalid/path?api_key=query-secret',
    'sk-abcdefghijklmnopqrstuvwxyz012345'
  ].join(' ');
  const redacted = redactBackendLogText(raw, [runtimeToken]);

  for (const secret of [
    runtimeToken,
    'environment-secret',
    'json-secret',
    'nested-secret',
    'query-secret',
    'sk-abcdefghijklmnopqrstuvwxyz012345'
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret));
  }
  assert.match(redacted, /Bearer \[已隐藏\]/);
});

test('writes serialized redacted lines without allowing newline injection', async (context) => {
  const directory = await makeLogDirectory(context);
  const sink = new BackendLogSink(directory, {
    clock: () => 0,
    sensitiveValues: () => [runtimeToken]
  });
  await Promise.all([
    sink.writeLine('agent-service', `first ${runtimeToken}\nforged-line`),
    sink.writeEvent('agent-service', {
      level: 'info',
      event: 'ready',
      service: 'agent-service',
      instanceId: '550e8400-e29b-41d4-a716-446655440000',
      pid: 1002,
      port: 49153
    })
  ]);
  await sink.flush();

  const content = await readFile(sink.logFilePath('agent-service'), 'utf8');
  assert.doesNotMatch(content, new RegExp(runtimeToken));
  assert.match(content, /first \[已隐藏\]\\nforged-line/);
  assert.match(content, /"event":"ready"/);
  assert.equal(content.split('\n').filter(Boolean).length, 2);
});

test('rejects arbitrary environment or header objects in structured events', async (context) => {
  const directory = await makeLogDirectory(context);
  const sink = new BackendLogSink(directory);
  await assert.rejects(
    sink.writeEvent('process-manager', {
      level: 'info',
      event: 'unsafe',
      environment: { AI_UNIT_TEST_ACCESS_TOKEN: runtimeToken }
    }),
    /event fields/
  );
  await assert.rejects(
    sink.writeEvent('process-manager', {
      level: 'info',
      event: 'unsafe',
      headers: { authorization: `Bearer ${runtimeToken}` }
    }),
    /event fields/
  );
});

test('rotates in one queue and retains current file plus four backups', async (context) => {
  const directory = await makeLogDirectory(context);
  const sink = new BackendLogSink(directory, {
    maxBytes: 180,
    retainedFiles: 5,
    clock: () => 0
  });
  await Promise.all(Array.from({ length: 9 }, (_, index) =>
    sink.writeLine('java-analyzer', `entry-${index}-${'x'.repeat(100)}`)
  ));
  await sink.flush();

  const names = (await readdir(directory)).filter((name) => name.startsWith('java-analyzer.log')).sort();
  assert.deepEqual(names, [
    'java-analyzer.log',
    'java-analyzer.log.1',
    'java-analyzer.log.2',
    'java-analyzer.log.3',
    'java-analyzer.log.4'
  ]);
  for (const name of names) {
    assert.ok((await stat(join(directory, name))).size <= 180, name);
  }
  assert.match(await readFile(join(directory, 'java-analyzer.log'), 'utf8'), /entry-8-/);
});

test('continues the serialized queue after one append operation fails', async (context) => {
  const directory = await makeLogDirectory(context);
  let shouldFail = true;
  const sink = new BackendLogSink(directory, {
    sensitiveValues: () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error(`provider leaked ${runtimeToken}`);
      }
      return [runtimeToken];
    }
  });

  await assert.rejects(sink.writeLine('process-manager', runtimeToken), /脱敏配置/);
  await sink.writeLine('process-manager', `recovered ${runtimeToken}`);
  const content = await readFile(sink.logFilePath('process-manager'), 'utf8');
  assert.match(content, /recovered \[已隐藏\]/);
  assert.doesNotMatch(content, new RegExp(runtimeToken));
});
