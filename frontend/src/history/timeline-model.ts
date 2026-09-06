/**
 * Pure view-model for the history timeline (bead rzo.4).
 *
 * Turns wire data (occupancy intervals + dwell summaries from `/api/history`)
 * into presentation-ready values: clipped percentage geometry for the
 * horizontal per-bay timeline, duration copy, and window-range copy.
 *
 * These are PERCENTAGES of the queried window — UI layout math only, not
 * detection coordinates; the normalized-coordinate invariant is untouched.
 * No DOM, no React: everything here is unit-testable in isolation.
 */

import type { BayDwellSummary, HistoryInterval } from '../net/history-api';

export interface TimelineWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface TimelineSegment {
  /** Left edge within the track, 0..100 (% of window). */
  readonly leftPct: number;
  /** Width within the track, ≥ MIN_SEGMENT_PCT and ≤ 100 - leftPct (%). */
  readonly widthPct: number;
  /** True when the episode is still open (extends to the window end). */
  readonly open: boolean;
  readonly confidence: number | null;
}

/** Floor for segment width: a 2-second blip stays visible on a 12h track. */
export const MIN_SEGMENT_PCT = 0.5;

/**
 * Clips each occupancy interval to the window and maps it to percentage
 * geometry. Intervals entirely outside the window are dropped (the server
 * already clips durations, but `since`/`until` are raw instants — clipping
 * here is the single place the visual viewport is defined).
 */
export function timelineSegments(
  intervals: readonly HistoryInterval[],
  window: TimelineWindow,
): TimelineSegment[] {
  const span = window.to.getTime() - window.from.getTime();
  if (!(span > 0)) return [];
  const segments: TimelineSegment[] = [];
  for (const interval of intervals) {
    const since = new Date(interval.since).getTime();
    const until = interval.until !== null ? new Date(interval.until).getTime() : window.to.getTime();
    const clippedFrom = Math.max(since, window.from.getTime());
    const clippedTo = Math.min(until, window.to.getTime());
    if (clippedTo <= clippedFrom) continue; // empty inside this window
    const leftPct = Math.max(0, Math.min(100, ((clippedFrom - window.from.getTime()) / span) * 100));
    const widthPct = ((clippedTo - clippedFrom) / span) * 100;
    segments.push({
      leftPct,
      widthPct: Math.min(Math.max(widthPct, MIN_SEGMENT_PCT), 100 - leftPct),
      open: interval.open,
      confidence: interval.confidence,
    });
  }
  return segments;
}

/** Human duration copy: "38s", "42m", "3h 25m", "2d 4h". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 48) return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/** Dwell column copy for one bay: "2 episodes · 3h 25m · open now". */
export function dwellCopy(summary: BayDwellSummary | null): string {
  if (summary === null || summary.episodes === 0) return 'No episodes';
  const noun = summary.episodes === 1 ? 'episode' : 'episodes';
  const open = summary.open !== null ? ' · open now' : '';
  return `${summary.episodes} ${noun} · ${formatDuration(summary.totalSeconds)}${open}`;
}

const rangeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Window range copy under the picker: "Sep 5, 18:00 → Sep 6, 06:00 UTC". */
export function windowRangeCopy(window: TimelineWindow): string {
  return `${rangeFormat.format(window.from)} → ${rangeFormat.format(window.to)} UTC`;
}
