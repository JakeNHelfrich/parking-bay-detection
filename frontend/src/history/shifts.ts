/**
 * Shift windows for the history view (bead rzo.4).
 *
 * Shifts are UTC windows aligned to the server's rollup defaults (see
 * `server/app/api_history.py`: `shiftStartHour=6`, `shiftHours=12`) — the
 * constants below MUST mirror those defaults so "this shift" in the UI means
 * the same bucket the server's shift rollup would use. Day shift =
 * 06:00–18:00 UTC; night shift = 18:00–06:00 UTC (midnight wrap).
 *
 * Pure module: `now` is always injected, so window math is deterministically
 * testable and knows nothing about React, fetch, or the store.
 */

export type ShiftKey = 'current' | 'lastNight';

export interface ShiftWindow {
  readonly key: ShiftKey;
  /** Picker copy: "Current shift" / "Last night". */
  readonly label: string;
  /** Window start (inclusive), as a UTC instant. */
  readonly from: Date;
  /** Window end (exclusive). `now` for the still-running current shift. */
  readonly to: Date;
}

/** Must mirror the server's shift-rollup defaults (`api_history.py`). */
export const SHIFT_START_HOUR = 6;
export const SHIFT_HOURS = 12;

const DAY_END_HOUR = SHIFT_START_HOUR + SHIFT_HOURS; // 18:00 UTC

function atHourUtc(day: Date, hour: number): Date {
  const d = new Date(day);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

function addDaysUtc(day: Date, days: number): Date {
  const d = new Date(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Resolves the window for a picker key.
 *
 * - `current`: the shift containing `now` (day if `now` ∈ [06:00, 18:00) UTC,
 *   night otherwise). The window is still running, so `to` is `now` — the
 *   record is queried up to the present and the open episode shows up.
 * - `lastNight`: the most recently *completed* night shift (18:00 → 06:00
 *   UTC). At exactly 06:00 the night that ends then counts as completed.
 */
export function shiftWindow(now: Date, key: ShiftKey): ShiftWindow {
  if (key === 'lastNight') {
    // Most recent 06:00 UTC boundary at or before `now` is the night's end.
    const todaySix = atHourUtc(now, SHIFT_START_HOUR);
    const end = now.getTime() >= todaySix.getTime() ? todaySix : atHourUtc(addDaysUtc(now, -1), SHIFT_START_HOUR);
    const start = new Date(end.getTime() - SHIFT_HOURS * 3_600_000);
    return { key, label: 'Last night', from: start, to: end };
  }

  const dayStart = atHourUtc(now, SHIFT_START_HOUR);
  const dayEnd = atHourUtc(now, DAY_END_HOUR);
  const inDayShift = now >= dayStart && now < dayEnd;
  const nightStart = now >= dayEnd ? dayEnd : atHourUtc(addDaysUtc(now, -1), DAY_END_HOUR);
  const from = inDayShift ? dayStart : nightStart;
  return { key, label: 'Current shift', from, to: new Date(now) };
}
