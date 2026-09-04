import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from './backoff';

describe('reconnectDelayMs', () => {
  it('starts at the base delay', () => {
    expect(reconnectDelayMs(0)).toBe(500);
  });

  it('doubles exponentially', () => {
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(3)).toBe(4000);
  });

  it('caps at the maximum delay', () => {
    expect(reconnectDelayMs(4)).toBe(5000);
    expect(reconnectDelayMs(10)).toBe(5000);
    expect(reconnectDelayMs(100)).toBe(5000);
  });

  it('handles negative attempts like 0', () => {
    expect(reconnectDelayMs(-3)).toBe(500);
  });
});
