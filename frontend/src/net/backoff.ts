/** Reconnect-backoff constants. Tuned so a server restart recovers in ~1s. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 5000;

/**
 * Exponential backoff for reconnect attempts (0-indexed): base * 2^attempt,
 * capped at maxMs. Deterministic (no jitter) so tests and logs stay readable.
 */
export function reconnectDelayMs(
  attempt: number,
  baseMs: number = RECONNECT_BASE_MS,
  maxMs: number = RECONNECT_MAX_MS,
): number {
  if (attempt <= 0) return baseMs;
  // Cap the exponent so 2**attempt cannot overflow for absurd attempt counts.
  const exp = baseMs * 2 ** Math.min(attempt, 16);
  return Math.min(exp, maxMs);
}
