/**
 * History-view loader tests (bead rzo.4): parallel fetch fan-out, row
 * ordering, dwell mapping, and failure propagation.
 */

import { describe, expect, it } from 'vitest';
import type { BayTimelineResponse, DwellResponse, HistoryClient } from '../net/history-api';
import { loadHistoryRows } from './load';

const WINDOW = { from: '2026-09-06T06:00:00Z', to: '2026-09-06T18:00:00Z' };

function timeline(bayId: number, count: number): BayTimelineResponse {
  return {
    bayId,
    from: WINDOW.from,
    to: WINDOW.to,
    intervals: Array.from({ length: count }, (_, i) => ({
      id: bayId * 100 + i,
      bayId,
      mapVersion: 'feedface',
      since: WINDOW.from,
      until: WINDOW.to,
      open: false,
      durationSeconds: 600,
      confidence: 0.9,
      openFrameId: 1,
      closeFrameId: 2,
    })),
  };
}

function dwellResponse(bayIds: number[]): DwellResponse {
  return {
    from: WINDOW.from,
    to: WINDOW.to,
    bays: bayIds.map((bayId) => ({
      bayId,
      episodes: 1,
      totalSeconds: 600,
      meanSeconds: 600,
      maxSeconds: 600,
      open: null,
    })),
  };
}

/** Stub client recording every call; `failTimelineFor` makes one bay reject. */
function stubClient(
  opts: { failTimelineFor?: number; dwellFor?: number[] } = {},
): HistoryClient & {
  timelineCalls: number[];
  dwellCalls: number;
} {
  const timelineCalls: number[] = [];
  let dwellCalls = 0;
  return {
    timelineCalls,
    get dwellCalls() {
      return dwellCalls;
    },
    async fetchTimeline(bayId) {
      timelineCalls.push(bayId);
      if (bayId === opts.failTimelineFor) throw new Error(`history fetch failed: 503`);
      return timeline(bayId, bayId);
    },
    async fetchDwell() {
      dwellCalls += 1;
      return dwellResponse(opts.dwellFor ?? [0, 1, 2]);
    },
  };
}

describe('loadHistoryRows', () => {
  it('fetches one dwell query plus one timeline per bay, in parallel', async () => {
    const client = stubClient();
    const rows = await loadHistoryRows(client, [0, 1, 2], WINDOW);
    expect(client.timelineCalls).toEqual([0, 1, 2]);
    expect(client.dwellCalls).toBe(1);
    // Rows keep caller order and carry that bay's intervals.
    expect(rows.map((row) => row.bayId)).toEqual([0, 1, 2]);
    expect(rows[2].intervals).toHaveLength(2);
  });

  it('maps dwell summaries by bayId and defaults missing ones to null', async () => {
    // Dwell only knows bay 1 — bay 0 has no episodes in the window.
    const client = stubClient({ dwellFor: [1] });
    const rows = await loadHistoryRows(client, [0, 1], WINDOW);
    expect(rows[0].dwell).toBeNull();
    expect(rows[1].dwell).toEqual({ bayId: 1, episodes: 1, totalSeconds: 600, meanSeconds: 600, maxSeconds: 600, open: null });
  });

  it('rejects when any timeline fetch fails (one error banner, not half a yard)', async () => {
    const client = stubClient({ failTimelineFor: 1 });
    await expect(loadHistoryRows(client, [0, 1, 2], WINDOW)).rejects.toThrow(
      'history fetch failed: 503',
    );
  });

  it('works for an empty bay list (bay map not loaded yet)', async () => {
    const client = stubClient();
    const rows = await loadHistoryRows(client, [], WINDOW);
    expect(rows).toEqual([]);
    expect(client.timelineCalls).toEqual([]);
    expect(client.dwellCalls).toBe(1);
  });
});
