import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { BackendRuntimeRegistry } from '../src/main/backend-runtime/backend-runtime-registry.ts';

const instanceId = '550e8400-e29b-41d4-a716-446655440000';
const analyzerToken = 'a'.repeat(43);
const agentToken = 'b'.repeat(43);

function readyInput(overrides = {}) {
  return {
    protocol: 1,
    instanceId,
    javaAnalyzer: {
      baseUrl: 'http://127.0.0.1:49152',
      pid: 1001,
      accessToken: analyzerToken
    },
    agentService: {
      baseUrl: 'http://127.0.0.1:49153',
      pid: 1002,
      accessToken: agentToken
    },
    ...overrides
  };
}

test('publishes one immutable snapshot only when both services are ready', () => {
  const registry = new BackendRuntimeRegistry(() => 123456);
  assert.equal(registry.isReady(), false);
  assert.equal(registry.getReadySnapshot(), null);

  const snapshot = registry.publishReady(readyInput());
  assert.equal(registry.getReadySnapshot(), snapshot);
  assert.equal(registry.isReady(), true);
  assert.equal(snapshot.readyAtMs, 123456);
  assert.equal(snapshot.javaAnalyzer.service, 'java-analyzer');
  assert.equal(snapshot.agentService.service, 'agent-service');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.javaAnalyzer), true);
});

test('keeps access tokens out of JSON, string and inspect representations', () => {
  const registry = new BackendRuntimeRegistry(() => 1);
  const snapshot = registry.publishReady(readyInput());
  const representations = [
    JSON.stringify(snapshot),
    JSON.stringify(registry),
    String(snapshot),
    inspect(snapshot),
    inspect(snapshot.javaAnalyzer),
    inspect(registry)
  ].join('\n');

  assert.doesNotMatch(representations, new RegExp(analyzerToken));
  assert.doesNotMatch(representations, new RegExp(agentToken));
  assert.equal(snapshot.javaAnalyzer.createAuthorizationHeader(), `Bearer ${analyzerToken}`);
  assert.equal(snapshot.agentService.createAuthorizationHeader(), `Bearer ${agentToken}`);
  assert.equal(Object.hasOwn(snapshot.javaAnalyzer, 'accessToken'), false);
});

test('does not replace a valid snapshot when a new complete snapshot fails validation', () => {
  const registry = new BackendRuntimeRegistry(() => 1);
  const original = registry.publishReady(readyInput());
  const invalidSecret = 'secret-that-must-not-appear';
  const invalid = readyInput({
    agentService: {
      ...readyInput().agentService,
      accessToken: invalidSecret
    }
  });

  assert.throws(
    () => registry.publishReady(invalid),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(invalidSecret));
      return true;
    }
  );
  assert.equal(registry.getReadySnapshot(), original);
});

test('rejects incomplete snapshots and token reuse', () => {
  const registry = new BackendRuntimeRegistry();
  const incomplete = readyInput();
  delete incomplete.agentService;
  assert.throws(() => registry.publishReady(incomplete), /服务组合/);
  assert.throws(() => registry.publishReady(readyInput({
    agentService: { ...readyInput().agentService, accessToken: analyzerToken }
  })), /不得复用/);
  assert.equal(registry.isReady(), false);
});

test('ignores stale clear events from an older instance', () => {
  const registry = new BackendRuntimeRegistry(() => 1);
  const snapshot = registry.publishReady(readyInput());
  assert.equal(registry.clear('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
  assert.equal(registry.getReadySnapshot(), snapshot);
  assert.equal(registry.clear(instanceId), true);
  assert.equal(registry.getReadySnapshot(), null);
  assert.throws(() => registry.requireReadySnapshot(), /尚未就绪/);
});
