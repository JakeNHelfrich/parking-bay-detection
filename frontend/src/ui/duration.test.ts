import { describe, expect, it } from 'vitest';
import { durationSince, formatDuration } from './duration';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatDuration', () => {
  it('reads "under a min" below one minute', () => {
    expect(formatDuration(0)).toBe('under a min');
    expect(formatDuration(5_000)).toBe('under a min');
    expect(formatDuration(MIN - 1)).toBe('under a min');
  });

  it('formats whole minutes below an hour', () => {
    expect(formatDuration(MIN)).toBe('1 min');
    expect(formatDuration(6 * MIN)).toBe('6 min');
    expect(formatDuration(59 * MIN + 59_999)).toBe('59 min'); // floors, never rounds up
  });

  it('formats hours with leftover minutes as "1 h 12 m"', () => {
    expect(formatDuration(HOUR + 12 * MIN)).toBe('1 h 12 m');
    expect(formatDuration(5 * HOUR + 3 * MIN)).toBe('5 h 3 m');
  });

  it('drops zero minutes from hour copy ("2 h", not "2 h 0 m")', () => {
    expect(formatDuration(2 * HOUR)).toBe('2 h');
    expect(formatDuration(23 * HOUR + 59 * MIN)).toBe('23 h 59 m');
  });

  it('formats day-plus durations as "3 d 4 h"', () => {
    expect(formatDuration(DAY + 4 * HOUR)).toBe('1 d 4 h');
    expect(formatDuration(3 * DAY)).toBe('3 d');
  });

  it('clamps negative elapsed (clock skew) to zero, not a negative copy', () => {
    expect(formatDuration(-1)).toBe('under a min');
    expect(formatDuration(-30 * MIN)).toBe('under a min');
  });

  it('formats non-finite input as an em dash, never a wrong number', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('durationSince', () => {
  it('formats now - since in coarse units', () => {
    const now = 1_000_000_000_000;
    expect(durationSince(now - 6 * MIN, now)).toBe('6 min');
    expect(durationSince(now - (HOUR + 12 * MIN), now)).toBe('1 h 12 m');
  });

  it('degrades to "—" when sinceMs is not a finite timestamp', () => {
    expect(durationSince(Number.NaN, 1_000)).toBe('—');
  });

  it('reads "under a min" when since is in the future (skewed clock)', () => {
    expect(durationSince(2_000, 1_000)).toBe('under a min');
  });
});
