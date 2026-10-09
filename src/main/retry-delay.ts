/** Equal jitter keeps a positive wait while spreading retries across the capped window. */
export function jitteredRetryDelayMilliseconds(
  delayMilliseconds: number,
  random: () => number = Math.random
): number {
  if (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0) {
    throw new TypeError('Retry delay must be a non-negative safe integer.');
  }
  if (delayMilliseconds === 0) return 0;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new TypeError('Retry jitter random sample must be within [0, 1).');
  }
  const minimum = Math.ceil(delayMilliseconds / 2);
  return minimum + Math.floor(sample * (delayMilliseconds - minimum + 1));
}
