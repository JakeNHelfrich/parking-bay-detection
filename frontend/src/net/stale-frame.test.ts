import { describe, expect, it } from 'vitest';
import { isStaleFrame } from './stale-frame';

describe('isStaleFrame', () => {
  it('drops results older than the latest shown result', () => {
    expect(isStaleFrame(99, 100)).toBe(true);
  });

  it('drops duplicates of the shown frame (strictly-newer rule)', () => {
    // A result equal to the displayed frame adds nothing; treating it as
    // stale keeps the overlay monotonic without depending on server skips.
    expect(isStaleFrame(100, 100)).toBe(true);
  });

  it('keeps results newer than the shown frame', () => {
    expect(isStaleFrame(101, 100)).toBe(false);
  });

  it('accepts everything when nothing has been shown yet', () => {
    expect(isStaleFrame(1, 0)).toBe(false);
  });
});
