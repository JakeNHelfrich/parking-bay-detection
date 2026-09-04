import { describe, expect, it } from 'vitest';
import { isStaleFrame } from './stale-frame';

describe('isStaleFrame', () => {
  it('drops results older than the latest captured frame', () => {
    expect(isStaleFrame(99, 100)).toBe(true);
  });

  it('keeps results for the latest captured frame', () => {
    expect(isStaleFrame(100, 100)).toBe(false);
  });

  it('keeps future frame ids (clock skew safety)', () => {
    expect(isStaleFrame(101, 100)).toBe(false);
  });
});
