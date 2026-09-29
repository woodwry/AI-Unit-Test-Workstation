import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRuntimeHandshake,
  parseRuntimeHandshakeLine,
  parseRuntimeStatusResponse
} from '../src/main/backend-runtime/runtime-protocol.ts';

const instanceId = '550e8400-e29b-41d4-a716-446655440000';
const expectation = { service: 'java-analyzer', instanceId, pid: 4321 };
const handshake = {
  protocol: 1,
  service: 'java-analyzer',
  instanceId,
  pid: 4321,
  host: '127.0.0.1',
  port: 49152
};

test('parses the exact six-field runtime handshake', () => {
  const parsed = parseRuntimeHandshake(structuredClone(handshake), expectation);
  assert.deepEqual(parsed, handshake);
  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(parseRuntimeHandshakeLine(JSON.stringify(handshake), expectation), handshake);
});

test('rejects handshake field additions, mismatches and invalid ports', () => {
  for (const invalid of [
    { ...handshake, extra: true },
    { ...handshake, protocol: 2 },
    { ...handshake, service: 'agent-service' },
    { ...handshake, instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { ...handshake, pid: 4322 },
    { ...handshake, host: 'localhost' },
    { ...handshake, port: 0 },
    { ...handshake, port: 65536 },
    { ...handshake, port: 1.5 }
  ]) {
    assert.throws(() => parseRuntimeHandshake(invalid, expectation), /运行时握手无效/);
  }
});

test('does not echo malformed stdout into handshake errors', () => {
  const malformed = '{not-json-with-secret-sk-should-not-leak';
  assert.throws(
    () => parseRuntimeHandshakeLine(malformed, expectation),
    (error) => {
      assert.match(error.message, /运行时握手无效/);
      assert.doesNotMatch(error.message, /not-json|sk-should-not-leak/);
      return true;
    }
  );
  assert.throws(() => parseRuntimeHandshakeLine(` ${JSON.stringify(handshake)}`, expectation));
});

test('parses only endpoint-appropriate live and readiness statuses', () => {
  const base = { protocol: 1, service: 'java-analyzer', instanceId };
  assert.deepEqual(
    parseRuntimeStatusResponse({ ...base, status: 'live' }, { ...expectation, endpoint: 'live' }),
    { ...base, status: 'live' }
  );
  assert.deepEqual(
    parseRuntimeStatusResponse({ ...base, status: 'ready' }, { ...expectation, endpoint: 'ready' }),
    { ...base, status: 'ready' }
  );
  assert.deepEqual(
    parseRuntimeStatusResponse({ ...base, status: 'not_ready' }, { ...expectation, endpoint: 'ready' }),
    { ...base, status: 'not_ready' }
  );
  assert.throws(() => parseRuntimeStatusResponse({ ...base, status: 'ready' }, { ...expectation, endpoint: 'live' }));
  assert.throws(() => parseRuntimeStatusResponse({ ...base, status: 'live' }, { ...expectation, endpoint: 'ready' }));
});

test('rejects status responses with extra fields or the wrong instance', () => {
  const base = { protocol: 1, service: 'agent-service', instanceId, status: 'ready' };
  const statusExpectation = { service: 'agent-service', instanceId, endpoint: 'ready' };
  assert.throws(() => parseRuntimeStatusResponse({ ...base, port: 18000 }, statusExpectation));
  assert.throws(() => parseRuntimeStatusResponse({ ...base, instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, statusExpectation));
});
