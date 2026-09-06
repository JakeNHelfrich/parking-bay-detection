/**
 * Stabilized bay-state layer — pure logic, no three.js/WS glue.
 *
 * Raw per-frame occupancy (`computeBayStates`) flickers on noisy detections:
 * a near-miss maneuver brushes a bay for a frame or two, and a momentary
 * detection dropout clears an occupied bay. This module sits between
 * per-frame results and the store, publishing a state change only after it
 * has held for a configurable duration — time-based debounce in *seconds*,
 * not frames, because capture rate varies with load.
 *
 * Hysteresis: the hold depends on direction. Entering `occupied` requires
 * the truck to be seen for `ENTER_OCCUPIED_SECS`; leaving it requires
 * absence to hold `LEAVE_OCCUPIED_SECS` — deliberately longer, so a brief
 * dropout never evicts a parked truck. `update` emits confirmed transitions
 * (wire shape of a `bayState` event, see `src/net/protocol.ts`);
 * `confirmedStates` (each stamped with `sinceMs`, set only on confirmed
 * transitions) feed the store snapshot. Occupancy math stays frontend-only
 * (invariant 5): this module only diffs already-derived states, and the
 * server never recomputes any of it.
 */

import type { BayState } from './occupancy';

/** Seconds a truck must keep matching a bay before it confirms `occupied`. */
export const ENTER_OCCUPIED_SECS = 2;

/**
 * Seconds a bay must stay clear before a confirmed `occupied` state drops.
 * Longer than entering: a momentary detection dropout must not clear a bay.
 */
export const LEAVE_OCCUPIED_SECS = 4;

/** One confirmed transition, in the wire shape of a `bayState` event. */
export interface BayTransition {
  readonly bayId: number;
  readonly occupied: boolean;
  /** Confidence of the matched truck; present only when occupying starts. */
  readonly confidence?: number;
}

/** A confirmed, stable bay state — what the store snapshot publishes. */
export interface StableBayState extends BayState {
  /**
   * Epoch ms at which this confirmed state began: when the candidate state
   * was *first observed*, not when the hold elapsed, so "occupied for how
   * long" reflects reality. Implicit empty baselines are stamped at the
   * first frame that observed the bay ("watching since then").
   */
  readonly sinceMs: number;
}

/** Optional overrides for the debounce/hysteresis holds (seconds). */
export interface StabilizerOptions {
  readonly enterOccupiedSecs?: number;
  readonly leaveOccupiedSecs?: number;
}

/** A state change waiting out its hold; the original start time is the stamp. */
interface Candidate {
  readonly occupied: boolean;
  readonly sinceMs: number;
  readonly confidence?: number;
}

/**
 * Diffs per-frame bay states against the last confirmed state per bay and
 * emits transitions only once a candidate state has held its directional
 * hold time. Bays with no confirmed state yet start implicitly EMPTY:
 * "still empty" is never reported, so a fresh session (or reconnect) does
 * not spam the server with no-op events.
 */
export class BayStateStabilizer {
  private readonly enterHoldMs: number;
  private readonly leaveHoldMs: number;
  private readonly confirmed = new Map<number, StableBayState>();
  private readonly pending = new Map<number, Candidate>();

  constructor(options: StabilizerOptions = {}) {
    this.enterHoldMs = (options.enterOccupiedSecs ?? ENTER_OCCUPIED_SECS) * 1000;
    this.leaveHoldMs = (options.leaveOccupiedSecs ?? LEAVE_OCCUPIED_SECS) * 1000;
  }

  /**
   * Feeds one frame's derived states at caller-clock time `nowMs` (epoch ms)
   * and returns the transitions confirmed by this call (empty when none).
   * Bays absent from `states` keep their confirmed/pending state untouched.
   */
  update(states: readonly BayState[], nowMs: number): readonly BayTransition[] {
    const transitions: BayTransition[] = [];
    for (const state of states) {
      const current = this.confirmed.get(state.bayId);
      // Implicit baseline for bays never confirmed before: empty, stamped at
      // first observation. Same-occupancy frames confirm this baseline (so
      // `confirmedStates` covers every bay from the first frame onward).
      if (current === undefined && !state.occupied) {
        this.confirmed.set(state.bayId, { bayId: state.bayId, occupied: false, sinceMs: nowMs });
        this.pending.delete(state.bayId);
        continue;
      }
      // Baseline for the comparison below: the confirmed state, or the
      // implicit empty for a bay first seen while occupied.
      const baselineOccupied = current?.occupied ?? false;
      if (baselineOccupied === state.occupied) {
        this.pending.delete(state.bayId);
        continue;
      }
      // Hysteresis: the hold is chosen by the *candidate* direction.
      const holdMs = state.occupied ? this.enterHoldMs : this.leaveHoldMs;
      const previous = this.pending.get(state.bayId);
      const candidate: Candidate =
        previous !== undefined && previous.occupied === state.occupied
          ? previous // same candidate still running: keep its original stamp
          : { occupied: state.occupied, sinceMs: nowMs, confidence: state.confidence };
      // Guard against a non-monotonic caller clock: elapsed never negative.
      const elapsedMs = Math.max(0, nowMs - candidate.sinceMs);
      if (elapsedMs >= holdMs) {
        this.confirmed.set(state.bayId, {
          bayId: state.bayId,
          occupied: state.occupied,
          sinceMs: candidate.sinceMs,
          ...(state.occupied ? { confidence: state.confidence } : {}),
        });
        this.pending.delete(state.bayId);
        transitions.push(
          state.occupied
            ? { bayId: state.bayId, occupied: true, confidence: state.confidence }
            : { bayId: state.bayId, occupied: false },
        );
      } else {
        this.pending.set(state.bayId, candidate);
      }
    }
    return transitions;
  }

  /** Last confirmed state per bay — covers every bay observed so far. */
  get confirmedStates(): readonly StableBayState[] {
    return [...this.confirmed.values()];
  }
}
