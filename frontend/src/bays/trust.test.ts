import { describe, expect, it } from 'vitest';
import {
  BAY_TRUST_MIN_CONFIDENCE,
  DETECTIONS_STALE_AFTER_MS,
  bayIsUnconfirmed,
  trustIssue,
  unconfirmedBayIds,
} from './trust';

const NOW = 1_000_000_000_000;

/** Baseline: sim running, online, detections just arrived → confirmable. */
function inputs(overrides: Partial<Parameters<typeof trustIssue>[0]> = {}) {
  return {
    simRunning: true,
    connectionStatus: 'online' as const,
    detectionsAtMs: NOW,
    nowMs: NOW,
    ...overrides,
  };
}

describe('trustIssue', () => {
  it('returns null while the evidence stream is live and fresh', () => {
    expect(trustIssue(inputs())).toBeNull();
  });

  it('returns idle before the sim starts, regardless of the stream', () => {
    expect(trustIssue(inputs({ simRunning: false }))).toBe('idle');
    expect(trustIssue(inputs({ simRunning: false, connectionStatus: 'offline' }))).toBe('idle');
  });

  it('ranks a dead feed over a stale one (offline dominates)', () => {
    expect(
      trustIssue(inputs({ connectionStatus: 'offline', detectionsAtMs: NOW - 60_000 })),
    ).toBe('feed-offline');
  });

  it('flags no-data while running but no detections frame has ever arrived', () => {
    expect(trustIssue(inputs({ detectionsAtMs: null }))).toBe('no-data');
    expect(trustIssue(inputs({ detectionsAtMs: null, connectionStatus: 'connecting' }))).toBe(
      'no-data',
    );
  });

  it('flags the feed stale past the configurable window (and not before)', () => {
    expect(trustIssue(inputs({ detectionsAtMs: NOW - DETECTIONS_STALE_AFTER_MS }))).toBeNull();
    expect(
      trustIssue(inputs({ detectionsAtMs: NOW - DETECTIONS_STALE_AFTER_MS - 1 })),
    ).toBe('feed-stale');
  });
});

describe('bayIsUnconfirmed', () => {
  const occupied = { bayId: 0, occupied: true, confidence: 0.9 };

  it('confirms a strong occupied match on a live stream', () => {
    expect(bayIsUnconfirmed(occupied, null)).toBe(false);
  });

  it('unconfirms every bay while the stream has a problem, including idle', () => {
    for (const issue of ['idle', 'no-data', 'feed-stale', 'feed-offline'] as const) {
      expect(bayIsUnconfirmed(occupied, issue)).toBe(true);
    }
  });

  it('unconfirms a bay never observed (no state) — no guess, no baseline', () => {
    expect(bayIsUnconfirmed(undefined, null)).toBe(true);
  });

  it('unconfirms an occupied match below the trust threshold, at the boundary', () => {
    expect(bayIsUnconfirmed({ bayId: 0, occupied: true, confidence: BAY_TRUST_MIN_CONFIDENCE }, null)).toBe(false);
    expect(
      bayIsUnconfirmed({ bayId: 0, occupied: true, confidence: BAY_TRUST_MIN_CONFIDENCE - 0.01 }, null),
    ).toBe(true);
  });

  it('trusts clear bays — absence of a match is the baseline, not a weak claim', () => {
    expect(bayIsUnconfirmed({ bayId: 1, occupied: false, confidence: 0.98 }, null)).toBe(false);
    expect(bayIsUnconfirmed({ bayId: 1, occupied: false }, null)).toBe(false);
  });
});

describe('unconfirmedBayIds', () => {
  const bayIds = [0, 1, 7];

  it('grays every bay while the stream has a global problem (except idle)', () => {
    expect(unconfirmedBayIds([], 'feed-stale', bayIds)).toEqual(bayIds);
    expect(unconfirmedBayIds([], 'feed-offline', bayIds)).toEqual(bayIds);
    expect(unconfirmedBayIds([], 'no-data', bayIds)).toEqual(bayIds);
  });

  it('grays every bay at idle too — a stopped sim asserts nothing on canvas', () => {
    expect(unconfirmedBayIds([], 'idle', bayIds)).toEqual(bayIds);
  });

  it('grays only untrusted bays on a live stream (unobserved bays included)', () => {
    const states = [
      { bayId: 0, occupied: true, confidence: 0.9 },
      { bayId: 1, occupied: true, confidence: 0.2 }, // weak match
      { bayId: 7, occupied: false, confidence: 0.95 },
    ];
    // bayIds list drives coverage: id 7 trusted, 0 trusted, 1 weak; a bay in
    // bayIds with no state (none here) would also gray.
    expect(unconfirmedBayIds(states, null, [0, 1, 7])).toEqual([1]);
  });
});
