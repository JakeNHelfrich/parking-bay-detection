/**
 * Confirmed bay-state transitions — pure logic, no three.js/WS glue.
 *
 * Occupancy (`computeBayStates`) is re-derived on every accepted frame and
 * can flicker on noisy detections; the server record must only hear about
 * *confirmed* transitions. A transition is confirmed when the new state has
 * held for `TRANSITION_CONFIRMATION_FRAMES` consecutive accepted frames.
 * Emitted batches feed the `bayState` WS message (see `src/net/protocol.ts`).
 * Occupancy math stays frontend-only (invariant 5): this module only diffs
 * already-derived states, and the server never recomputes any of it.
 */

import type { BayState } from './occupancy';

/** Consecutive accepted frames a new state must hold before it confirms. */
export const TRANSITION_CONFIRMATION_FRAMES = 2;

/** One confirmed transition, in the wire shape of a `bayState` event. */
export interface BayTransition {
  readonly bayId: number;
  readonly occupied: boolean;
  /** Confidence of the matched truck; present only when occupying starts. */
  readonly confidence?: number;
}

interface PendingRun {
  readonly state: BayState;
  readonly runs: number;
}

/**
 * Diffs per-frame bay states against the last confirmed state per bay and
 * emits transitions once they hold long enough. Bays with no confirmed state
 * yet start implicitly EMPTY: "still empty" is never reported, so a fresh
 * session (or reconnect) does not spam the server with no-op events.
 */
export class BayStateTracker {
  private confirmed = new Map<number, BayState>();
  private pending = new Map<number, PendingRun>();

  /**
   * Feeds one frame's derived states and returns the transitions confirmed
   * by this frame (empty when none). Bays absent from `states` keep their
   * previous confirmed/pending state untouched.
   */
  update(states: readonly BayState[]): readonly BayTransition[] {
    const transitions: BayTransition[] = [];
    for (const state of states) {
      const current = this.confirmed.get(state.bayId);
      // Implicit baseline for bays never confirmed before: empty.
      const baseline: BayState = current ?? { bayId: state.bayId, occupied: false };
      if (sameOccupancy(baseline, state)) {
        this.pending.delete(state.bayId);
        continue;
      }
      const previous = this.pending.get(state.bayId);
      const runs = previous !== undefined && sameOccupancy(previous.state, state) ? previous.runs + 1 : 1;
      if (runs >= TRANSITION_CONFIRMATION_FRAMES) {
        this.confirmed.set(state.bayId, state);
        this.pending.delete(state.bayId);
        transitions.push(
          state.occupied
            ? { bayId: state.bayId, occupied: true, confidence: state.confidence }
            : { bayId: state.bayId, occupied: false },
        );
      } else {
        this.pending.set(state.bayId, { state, runs });
      }
    }
    return transitions;
  }

  /** Last confirmed state per bay (a bay is absent until first confirmed). */
  get confirmedStates(): readonly BayState[] {
    return [...this.confirmed.values()];
  }
}

/** Occupied/empty is the state; confidence is metadata, not a state change. */
function sameOccupancy(a: BayState, b: BayState): boolean {
  return a.occupied === b.occupied;
}
