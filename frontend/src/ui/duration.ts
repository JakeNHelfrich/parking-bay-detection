/**
 * Duration formatting for the bay board (bead yp6.2): how long each bay has
 * been in its current state. Pure functions only — callers pass `now`
 * explicitly (taken at render from a store emit), so there are no timers
 * hidden in logic and the formatting is trivially unit-testable. The
 * future full-viewport board view (bead yp6.4) reuses these helpers for its
 * per-bay tiles; the sidebar bay cards are the first consumer.
 *
 * Coarse on purpose: a controller reads "6 min" or "1 h 12 m" at a glance;
 * seconds-level precision would imply a trust the stabilizer doesn't claim.
 */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats an elapsed duration as coarse human copy:
 * `< 1 min` → "under a min"; `< 1 h` → "6 min"; `< 1 d` → "1 h 12 m" or
 * "2 h"; longer → "3 d 4 h" or "3 d". Negative inputs (clock skew between
 * the `since` stamp and `now`) clamp to zero; non-finite inputs format as
 * "—" so a bad timestamp degrades to an honest blank, never a wrong number.
 */
export function formatDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return '—';
  if (elapsedMs < MIN_MS) return 'under a min';
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MIN_MS)} min`;
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    const minutes = Math.floor((elapsedMs % HOUR_MS) / MIN_MS);
    return minutes > 0 ? `${hours} h ${minutes} m` : `${hours} h`;
  }
  const days = Math.floor(elapsedMs / DAY_MS);
  const hours = Math.floor((elapsedMs % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
}

/** Formats elapsed time since a `sinceMs` state-transition timestamp. */
export function durationSince(sinceMs: number, nowMs: number): string {
  return formatDuration(nowMs - sinceMs);
}
