/**
 * Bay trust — decides when the board may claim a bay state at all (yp6.3).
 *
 * The stabilized layer (yp6.1) makes states *stable*; this module makes them
 * *honest*: when the evidence stream degrades — detections stop arriving,
 * inference goes offline, or a truck match is too weak — the board must show
 * an explicit "can't confirm" state instead of silently freezing on
 * last-known data (VISION rule: Trustworthy). "We don't know" is a
 * first-class display state.
 *
 * Pure logic only (no three.js/WS glue): callers pass timestamps and the
 * connection status explicitly. Trust is a *display* projection — it never
 * feeds back into the stabilizer or the server record, which keep reporting
 * the last confirmed state (invariant 5; one truth for all consumers).
 */

import type { ConnectionStatus } from '../net/detect-client';
import type { BayState } from './occupancy';

/**
 * Detections older than this are stale: the board stops asserting bay
 * states. Captures are paced at ~10 fps, so this tolerates ~50 missed
 * frames — far beyond normal backpressure jitter — before giving up.
 */
export const DETECTIONS_STALE_AFTER_MS = 5_000;

/**
 * A matched truck below this confidence cannot honestly claim the bay:
 * the card shows "can't confirm · weak truck match" (gray) instead of
 * "Occupied". Matches at or above the occupancy IoU threshold but below
 * this are plausible-but-not-trusted.
 */
export const BAY_TRUST_MIN_CONFIDENCE = 0.35;

/**
 * Why the board currently cannot (or can) confirm bay states. `null` means
 * the evidence stream is live and per-bay confidence decides trust.
 * `idle` is the pre-start state ("Waiting to start"), kept in the taxonomy
 * so consumers handle one enum instead of simRunning + issue pairs.
 */
export type TrustIssue = 'idle' | 'no-data' | 'feed-stale' | 'feed-offline';

export interface TrustInputs {
  readonly simRunning: boolean;
  readonly connectionStatus: ConnectionStatus;
  /** Wall-clock ms (Date.now()) at which the last detections frame arrived. */
  readonly detectionsAtMs: number | null;
  readonly nowMs: number;
}

/**
 * The current evidence-stream problem, or null when detections are fresh
 * and the connection is up. Note the precedence: a dead feed dominates a
 * stale one, and nothing is confirmable before the sim starts.
 */
export function trustIssue(inputs: TrustInputs): TrustIssue | null {
  if (!inputs.simRunning) return 'idle';
  if (inputs.connectionStatus === 'offline') return 'feed-offline';
  if (inputs.detectionsAtMs === null) return 'no-data';
  if (inputs.nowMs - inputs.detectionsAtMs > DETECTIONS_STALE_AFTER_MS) return 'feed-stale';
  return null;
}

/**
 * True when this bay's state may not be asserted right now: the evidence
 * stream has a problem (`issue` — applies to every bay), the bay has no
 * state at all (never observed), or its occupied claim rests on a weaker
 * match than the trust threshold. Clear bays with no confidence bead are
 * trusted: absence of a matched truck is the baseline, not a weak claim.
 */
export function bayIsUnconfirmed(state: BayState | undefined, issue: TrustIssue | null): boolean {
  if (issue !== null) return true;
  if (state === undefined) return true;
  return state.occupied && state.confidence !== undefined && state.confidence < BAY_TRUST_MIN_CONFIDENCE;
}

/**
 * Bay ids the overlay must draw gray: every bay whenever the stream has a
 * problem — including `idle`, so a stopped sim never keeps asserting its
 * last-known states on canvas — otherwise only bays whose own match is
 * untrusted. Pure so the canvas glue in bootstrap stays a one-liner.
 */
export function unconfirmedBayIds(
  states: readonly BayState[],
  issue: TrustIssue | null,
  bayIds: readonly number[],
): readonly number[] {
  if (issue !== null) return [...bayIds];
  const stateById = new Map(states.map((state) => [state.bayId, state]));
  return bayIds.filter((bayId) => bayIsUnconfirmed(stateById.get(bayId), null));
}
