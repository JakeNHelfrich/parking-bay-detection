/**
 * Timeline view-model tests (bead rzo.4): clipping, percentage geometry,
 * duration/dwell copy, and range formatting.
 */

import { describe, expect, it } from 'vitest';
import type { BayDwellSummary, HistoryInterval } from '../net/history-api';
import {
  dwellCopy,
  formatDuration,
  timelineSegments,
  windowRangeCopy,
  MIN_SEGMENT_PCT,
} from './timeline-model';

const FROM = new Date('2026-09-06T06:00:00Z');
const TO = new Date('2026-09-06T18:00:00Z'); // 12h window = 43_200s

function interval(overrides: Partial<HistoryInterval>): HistoryInterval {
  return {
    id: 1,
    bayId: 0,
    mapVersion: 'feedface',
    since: '2026-09-06T08:00:00Z',
    until: '2026-09-06T10:00:00Z',
    open: false,
    durationSeconds: 7200,
    confidence: 0.9,
    openFrameId: 10,
    closeFrameId: 20,
    ...overrides,
  };
}

describe('timelineSegments', () => {
  it('maps a mid-window episode to proportional percentages', () => {
    // 08:00→10:00 inside [06:00, 18:00): left = 2h/12h, width = 2h/12h.
    const [segment] = timelineSegments([interval({})], { from: FROM, to: TO });
    expect(segment.leftPct).toBeCloseTo(100 / 6, 6);
    expect(segment.widthPct).toBeCloseTo(100 / 6, 6);
    expect(segment.open).toBe(false);
  });

  it('extends an open episode to the window end and flags it', () => {
    const [segment] = timelineSegments(
      [interval({ since: '2026-09-06T09:00:00Z', until: null, open: true, closeFrameId: null })],
      { from: FROM, to: TO },
    );
    expect(segment.leftPct).toBeCloseTo(25, 6);
    expect(segment.widthPct).toBeCloseTo(75, 6);
    expect(segment.open).toBe(true);
  });

  it('clips episodes that started before the window', () => {
    const [segment] = timelineSegments(
      [interval({ since: '2026-09-05T20:00:00Z', until: '2026-09-06T09:00:00Z' })],
      { from: FROM, to: TO },
    );
    expect(segment.leftPct).toBe(0);
    expect(segment.widthPct).toBeCloseTo(25, 6); // 06:00→09:00 = 3h/12h
  });

  it('clips episodes that end after the window', () => {
    const [segment] = timelineSegments(
      [interval({ since: '2026-09-06T15:00:00Z', until: '2026-09-06T20:00:00Z' })],
      { from: FROM, to: TO },
    );
    expect(segment.leftPct).toBeCloseTo(75, 6);
    expect(segment.widthPct).toBeCloseTo(25, 6);
  });

  it('drops episodes entirely outside the window', () => {
    const segments = timelineSegments(
      [
        interval({ id: 1, since: '2026-09-06T02:00:00Z', until: '2026-09-06T04:00:00Z' }),
        interval({ id: 2, since: '2026-09-06T20:00:00Z', until: '2026-09-06T22:00:00Z' }),
      ],
      { from: FROM, to: TO },
    );
    expect(segments).toEqual([]);
  });

  it('keeps sub-second blips visible via the minimum-width floor', () => {
    const [segment] = timelineSegments(
      [interval({ since: '2026-09-06T08:00:00Z', until: '2026-09-06T08:00:00.500Z' })],
      { from: FROM, to: TO },
    );
    expect(segment.widthPct).toBe(MIN_SEGMENT_PCT);
    // Floor never overflows the track's right edge.
    expect(segment.leftPct + segment.widthPct).toBeLessThanOrEqual(100);
  });

  it('returns [] for an inverted or empty window', () => {
    expect(timelineSegments([interval({})], { from: TO, to: FROM })).toEqual([]);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [38.4, '38s'],
    [59, '59s'],
    [60, '1m'],
    [2520, '42m'],
    [10800, '3h'],
    [12300, '3h 25m'],
    [172800, '2d'],
    [190800, '2d 5h'],
  ])('formats %ss as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('dwellCopy', () => {
  const summary = (overrides: Partial<BayDwellSummary>): BayDwellSummary => ({
    bayId: 1,
    episodes: 2,
    totalSeconds: 12300,
    meanSeconds: 6150,
    maxSeconds: 7200,
    open: null,
    ...overrides,
  });

  it('returns No episodes for a missing or empty summary', () => {
    expect(dwellCopy(null)).toBe('No episodes');
    expect(dwellCopy(summary({ episodes: 0 }))).toBe('No episodes');
  });

  it('formats episode count with singular/plural and total dwell', () => {
    expect(dwellCopy(summary({ episodes: 1 }))).toBe('1 episode · 3h 25m');
    expect(dwellCopy(summary({}))).toBe('2 episodes · 3h 25m');
  });

  it('appends open-now when an episode is still open', () => {
    expect(
      dwellCopy(summary({ open: { since: '2026-09-06T09:00:00Z', durationSeconds: 3600, mapVersion: 'feedface', confidence: 0.9 } })),
    ).toBe('2 episodes · 3h 25m · open now');
  });
});

describe('windowRangeCopy', () => {
  it('formats the window in UTC', () => {
    expect(windowRangeCopy({ from: new Date('2026-09-05T18:00:00Z'), to: new Date('2026-09-06T06:00:00Z') })).toBe(
      'Sep 5, 18:00 → Sep 6, 06:00 UTC',
    );
  });
});
