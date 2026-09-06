import { describe, expect, it } from 'vitest';
import { BayStateTracker, TRANSITION_CONFIRMATION_FRAMES } from './transitions';
import type { BayState } from './occupancy';

function state(bayId: number, occupied: boolean, confidence?: number): BayState {
  return confidence === undefined ? { bayId, occupied } : { bayId, occupied, confidence };
}

describe('BayStateTracker', () => {
  it('requires TRANSITION_CONFIRMATION_FRAMES consecutive frames to confirm', () => {
    const tracker = new BayStateTracker();
    expect(tracker.update([state(0, true)])).toEqual([]); // run 1
    expect(tracker.update([state(0, true)])).toEqual([{ bayId: 0, occupied: true, confidence: undefined }]);
  });

  it('never reports the implicit empty baseline', () => {
    const tracker = new BayStateTracker();
    expect(tracker.update([state(0, false), state(1, false)])).toEqual([]);
    expect(tracker.update([state(0, false), state(1, false)])).toEqual([]);
    expect(tracker.confirmedStates).toEqual([]); // empty is never "confirmed"
  });

  it('flapping between frames never confirms a transition', () => {
    const tracker = new BayStateTracker();
    for (let i = 0; i < 10; i += 1) {
      expect(tracker.update([state(0, i % 2 === 0)])).toEqual([]);
    }
  });

  it('emits an occupied→empty transition after the state holds', () => {
    const tracker = new BayStateTracker();
    tracker.update([state(2, true)]);
    const confirmed = tracker.update([state(2, true)]);
    expect(confirmed).toEqual([{ bayId: 2, occupied: true, confidence: undefined }]);
    expect(tracker.update([state(2, false)])).toEqual([]); // run 1 of empty
    expect(tracker.update([state(2, false)])).toEqual([{ bayId: 2, occupied: false }]);
  });

  it('batches multiple transitions from one frame in bay order', () => {
    const tracker = new BayStateTracker();
    tracker.update([state(0, false), state(1, false), state(3, false)]);
    tracker.update([state(0, true), state(1, true), state(3, true)]);
    const transitions = tracker.update([state(0, true), state(1, true), state(3, true)]);
    expect(transitions).toEqual([
      { bayId: 0, occupied: true, confidence: undefined },
      { bayId: 1, occupied: true, confidence: undefined },
      { bayId: 3, occupied: true, confidence: undefined },
    ]);
  });

  it('confirms bays independently and tracks per-bay pending runs', () => {
    const tracker = new BayStateTracker();
    tracker.update([state(0, true), state(1, true)]); // both run 1
    expect(tracker.update([state(0, true), state(1, false)])).toEqual([
      { bayId: 0, occupied: true, confidence: undefined },
    ]);
    // Bay 1 flapped (true→false), so its run restarted; one more frame confirms.
    expect(tracker.update([state(0, true), state(1, true)])).toEqual([]);
    expect(tracker.update([state(0, true), state(1, true)])).toEqual([
      { bayId: 1, occupied: true, confidence: undefined },
    ]);
  });

  it('carries the matched-truck confidence on occupy transitions', () => {
    const tracker = new BayStateTracker();
    tracker.update([state(5, true, 0.42)]);
    expect(tracker.update([state(5, true, 0.87)])).toEqual([
      { bayId: 5, occupied: true, confidence: 0.87 },
    ]);
    // Confidence changes are metadata, not state changes: no new transition.
    expect(tracker.update([state(5, true, 0.11)])).toEqual([]);
  });

  it('keeps confirmed state for bays missing from a frame', () => {
    const tracker = new BayStateTracker();
    tracker.update([state(0, true)]);
    tracker.update([state(0, true)]);
    // Bay 0 disappears from the next frame; nothing resets or re-reports.
    expect(tracker.update([])).toEqual([]);
    expect(tracker.confirmedStates).toEqual([{ bayId: 0, occupied: true, confidence: undefined }]);
  });

  it('restarts a pending run when the candidate state flips', () => {
    const tracker = new BayStateTracker();
    tracker.update([state(0, true)]); // run 1 occupied
    tracker.update([state(0, false)]); // different candidate: run 1 empty
    tracker.update([state(0, true)]); // different candidate again: run 1 occupied
    expect(tracker.update([state(0, true)])).toEqual([
      { bayId: 0, occupied: true, confidence: undefined },
    ]);
  });

  it('uses the configured confirmation window', () => {
    expect(TRANSITION_CONFIRMATION_FRAMES).toBeGreaterThanOrEqual(2);
  });
});
