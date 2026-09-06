/**
 * History-view data loader (bead rzo.4) — fetch glue between the REST client
 * and the panel, kept out of React so it is testable with a stub client.
 *
 * One load = N per-bay timelines (for the horizontal tracks) + one dwell
 * query (for the per-bay dwell column), all in parallel. Any failure fails
 * the whole load: the view renders one error banner rather than half a yard.
 * Rows come back in `bayIds` order; bays with no dwell row (nothing recorded
 * in the window) get `dwell: null`.
 */

import type { BayDwellSummary, HistoryClient, HistoryInterval } from '../net/history-api';

export interface HistoryRow {
  readonly bayId: number;
  readonly intervals: readonly HistoryInterval[];
  readonly dwell: BayDwellSummary | null;
}

/** Wire-facing window: ISO 8601 instants (caller formats via toISOString). */
export interface HistoryWindowIso {
  readonly from: string;
  readonly to: string;
}

export async function loadHistoryRows(
  client: HistoryClient,
  bayIds: readonly number[],
  window: HistoryWindowIso,
): Promise<HistoryRow[]> {
  // Kick the dwell query off alongside the timelines (not awaited first) so
  // the whole load takes one round-trip latency, not two.
  const dwellPromise = client.fetchDwell(window.from, window.to);
  const timelines = await Promise.all(
    bayIds.map((bayId) => client.fetchTimeline(bayId, window.from, window.to)),
  );
  const dwell = await dwellPromise;
  const dwellByBay = new Map(dwell.bays.map((summary) => [summary.bayId, summary]));
  return bayIds.map((bayId, index) => ({
    bayId,
    intervals: timelines[index].intervals,
    dwell: dwellByBay.get(bayId) ?? null,
  }));
}
