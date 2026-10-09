import assert from 'node:assert/strict';
import test from 'node:test';
import { jitteredRetryDelayMilliseconds } from '../src/main/retry-delay.ts';

test('equal jitter stays within half of each capped delay and its full ceiling', () => {
  for (const ceiling of [1, 2, 50, 250, 1_000, 30_000]) {
    const draws = [0, 0.25, 0.5, 0.75, 1 - Number.EPSILON];
    const delays = draws.map(draw => jitteredRetryDelayMilliseconds(ceiling, () => draw));
    assert.equal(delays[0], Math.ceil(ceiling / 2));
    assert.equal(delays.at(-1), ceiling);
    assert.ok(delays.every(delay => Number.isSafeInteger(delay)
      && delay >= Math.ceil(ceiling / 2) && delay <= ceiling));
    if (ceiling > 2) assert.ok(new Set(delays).size > 1);
  }
});

test('each retry draws again, including after the exponential window reaches its cap', t => {
  const samples = [0, 0.5, 1 - Number.EPSILON];
  const random = t.mock.method(Math, 'random', () => samples.shift());
  assert.deepEqual([0, 1, 2].map(() => jitteredRetryDelayMilliseconds(30_000)),
    [15_000, 22_500, 30_000]);
  assert.equal(random.mock.callCount(), 3);
});

test('zero-delay configuration stays immediate without drawing randomness', () => {
  assert.equal(jitteredRetryDelayMilliseconds(0, () => { throw new Error('unused'); }), 0);
});

test('invalid delays and random values are rejected rather than creating busy retries', () => {
  for (const invalid of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => jitteredRetryDelayMilliseconds(invalid), TypeError);
  }
  for (const invalid of [-0.1, 1, NaN, Infinity]) {
    assert.throws(() => jitteredRetryDelayMilliseconds(1_000, () => invalid), TypeError);
  }
});
