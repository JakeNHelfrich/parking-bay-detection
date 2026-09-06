import { describe, expect, it } from 'vitest';

import type { BayState } from './occupancy';
import {
  BayStateStabilizer,
  ENTER_OCCUPIED_SECS,
  LEAVE_OCCUPIED_SECS,
  type StableBayState,
} from './stabilizer';

const T0 = 1_700_000_000_000; // arbitrary epoch ms; the module is clock-agnostic

const bay = (bayId: number, occupied: boolean, confidence?: number): BayState =>
  occupied ? { bayId, occupied, confidence } : { bayId, occupied };

/** Advances time by `secs` and feeds one frame of the given states. */
function feed(
  stabilizer: BayStateStabilizer,
  states: readonly BayState[],
  nowMs: number,
): readonly { bayId: number; occupied: boolean; confidence?: number }[] {
  return stabilizer.update(states, nowMs);
}

describe('ENTER_OCCUPIED_SECS / LEAVE_OCCUPIED_SECS defaults', () => {
  it('leaving occupied holds longer than entering (hysteresis direction)', () => {
    expect(LEAVE_OCCUPIED_SECS).toBeGreaterThan(ENTER_OCCUPIED_SECS);
  });

  it('holds are seconds, not frames', () => {
    expect(ENTER_OCCUPIED_SECS).toBeGreaterThan(0);
    expect(LEAVE_OCCUPIED_SECS).toBeGreaterThan(0);
  });
});

describe('time-based debounce (enter occupied)', () => {
  it('does not confirm before the hold elapses', () => {
    const s = new BayStateStabilizer();
    expect(feed(s, [bay(0, true, 0.9)], T0)).toEqual([]);
    expect(feed(s, [bay(0, true, 0.9)], T0 + 1999)).toEqual([]);
  });

  it('confirms exactly once when the hold elapses, with confidence', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, true, 0.9)], T0);
    const transitions = feed(s, [bay(0, true, 0.9)], T0 + 2000);
    expect(transitions).toEqual([{ bayId: 0, occupied: true, confidence: 0.9 }]);
    // Held state: no repeat emission on subsequent frames.
    expect(feed(s, [bay(0, true, 0.9)], T0 + 3000)).toEqual([]);
  });

  it('stamps sinceMs at first observation, not at confirmation', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, true, 0.8)], T0);
    feed(s, [bay(0, true, 0.8)], T0 + 2000);
    const states: readonly StableBayState[] = s.confirmedStates;
    expect(states).toEqual([{ bayId: 0, occupied: true, confidence: 0.8, sinceMs: T0 }]);
  });

  it('a flicker shorter than the hold never confirms (near-miss maneuver)', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false)], T0); // baseline empty confirmed
    // Truck brushes the bay for 1.5s, then leaves.
    feed(s, [bay(0, true, 0.7)], T0 + 1000);
    const transitions = feed(s, [bay(0, false)], T0 + 2500);
    expect(transitions).toEqual([]);
    expect(s.confirmedStates).toEqual([expect.objectContaining({ bayId: 0, occupied: false })]);
  });

  it('a candidate that flip-flops restarts its hold from each flip', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false)], T0);
    feed(s, [bay(0, true, 0.9)], T0); // pending since T0
    feed(s, [bay(0, false)], T0 + 500); // flip: pending cleared
    feed(s, [bay(0, true, 0.9)], T0 + 1000); // new candidate since T0+1000
    expect(feed(s, [bay(0, true, 0.9)], T0 + 2900)).toEqual([]); // 1.9s < 2s
    expect(feed(s, [bay(0, true, 0.9)], T0 + 3000)).toEqual([
      { bayId: 0, occupied: true, confidence: 0.9 },
    ]);
  });

  it('frames arriving faster than the hold do not confirm early (frames ≠ time)', () => {
    const s = new BayStateStabilizer();
    // 20 frames in 100ms — plenty of "frames", far under 2s of time.
    for (let i = 0; i < 20; i++) {
      expect(feed(s, [bay(0, true, 0.9)], T0 + i * 5)).toEqual([]);
    }
    expect(feed(s, [bay(0, true, 0.9)], T0 + 2000)).toEqual([
      { bayId: 0, occupied: true, confidence: 0.9 },
    ]);
  });
});

describe('hysteresis (leave occupied)', () => {
  it('holds the occupied state through a momentary detection dropout', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false)], T0);
    feed(s, [bay(0, true, 0.9)], T0);
    feed(s, [bay(0, true, 0.9)], T0 + 2000); // confirmed occupied
    // One frame of dropout (YOLO misses the truck), then it reappears.
    expect(feed(s, [bay(0, false)], T0 + 2100)).toEqual([]);
    const transitions = feed(s, [bay(0, true, 0.9)], T0 + 2200);
    expect(transitions).toEqual([]); // never dropped, never re-reported
    expect(s.confirmedStates).toEqual([
      expect.objectContaining({ bayId: 0, occupied: true, sinceMs: T0 }),
    ]);
  });

  it('requires the longer leave-hold before dropping the occupied state', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false)], T0);
    feed(s, [bay(0, true, 0.9)], T0);
    feed(s, [bay(0, true, 0.9)], T0 + 2000);
    feed(s, [bay(0, false)], T0 + 2100); // truck actually drives away
    expect(feed(s, [bay(0, false)], T0 + 2100 + LEAVE_OCCUPIED_SECS * 1000 - 1)).toEqual([]);
    const transitions = feed(s, [bay(0, false)], T0 + 2100 + LEAVE_OCCUPIED_SECS * 1000);
    expect(transitions).toEqual([{ bayId: 0, occupied: false }]);
  });

  it('uses the directional holds independently when both directions occur', () => {
    const s = new BayStateStabilizer({ enterOccupiedSecs: 1, leaveOccupiedSecs: 3 });
    feed(s, [bay(0, true, 0.9)], T0);
    expect(feed(s, [bay(0, true, 0.9)], T0 + 999)).toEqual([]);
    expect(feed(s, [bay(0, true, 0.9)], T0 + 1000)).toEqual([
      { bayId: 0, occupied: true, confidence: 0.9 },
    ]);
    feed(s, [bay(0, false)], T0 + 1100);
    expect(feed(s, [bay(0, false)], T0 + 1100 + 2999)).toEqual([]);
    expect(feed(s, [bay(0, false)], T0 + 1100 + 3000)).toEqual([{ bayId: 0, occupied: false }]);
  });
});

describe('implicit empty baseline', () => {
  it('confirms first-seen empty bays immediately without reporting them', () => {
    const s = new BayStateStabilizer();
    const transitions = feed(s, [bay(0, false), bay(1, false)], T0);
    expect(transitions).toEqual([]);
    expect(s.confirmedStates).toEqual([
      { bayId: 0, occupied: false, sinceMs: T0 },
      { bayId: 1, occupied: false, sinceMs: T0 },
    ]);
  });

  it('a bay first seen occupied reports only after its enter hold', () => {
    const s = new BayStateStabilizer();
    // Fresh session while a truck is already parked: one transition, later.
    expect(feed(s, [bay(2, true, 0.6)], T0)).toEqual([]);
    expect(feed(s, [bay(2, true, 0.6)], T0 + 1999)).toEqual([]);
    expect(feed(s, [bay(2, true, 0.6)], T0 + 2000)).toEqual([
      { bayId: 2, occupied: true, confidence: 0.6 },
    ]);
    expect(s.confirmedStates).toEqual([
      expect.objectContaining({ bayId: 2, occupied: true, sinceMs: T0 }),
    ]);
  });

  it('stamps the empty baseline at the first observing frame, not T0 of the session', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false)], T0);
    feed(s, [bay(1, false)], T0 + 5000); // bay 1 appears later
    expect(s.confirmedStates).toEqual([
      expect.objectContaining({ bayId: 0, sinceMs: T0 }),
      expect.objectContaining({ bayId: 1, sinceMs: T0 + 5000 }),
    ]);
  });
});

describe('stability across frames', () => {
  it('bays absent from a frame keep their confirmed and pending state', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false), bay(1, true, 0.9)], T0);
    feed(s, [bay(0, false)], T0 + 1000); // bay 1 missing (partial message)
    // Bay 1 still confirms on schedule despite the gap.
    expect(feed(s, [bay(0, false), bay(1, true, 0.9)], T0 + 2000)).toEqual([
      { bayId: 1, occupied: true, confidence: 0.9 },
    ]);
  });

  it('tracks multiple bays independently', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false), bay(1, false), bay(2, false), bay(3, false)], T0);
    // Only bay 2 fills; only bay 2 reports.
    expect(feed(s, [bay(0, false), bay(1, false), bay(2, true, 0.5), bay(3, false)], T0)).toEqual([]);
    expect(feed(s, [bay(0, false), bay(1, false), bay(2, true, 0.5), bay(3, false)], T0 + 2000)).toEqual([
      { bayId: 2, occupied: true, confidence: 0.5 },
    ]);
    expect(s.confirmedStates).toEqual([
      expect.objectContaining({ bayId: 0, occupied: false }),
      expect.objectContaining({ bayId: 1, occupied: false }),
      expect.objectContaining({ bayId: 2, occupied: true }),
      expect.objectContaining({ bayId: 3, occupied: false }),
    ]);
  });

  it('treats confidence changes as metadata, not state changes', () => {
    const s = new BayStateStabilizer();
    feed(s, [bay(0, false)], T0);
    feed(s, [bay(0, true, 0.9)], T0);
    feed(s, [bay(0, true, 0.9)], T0 + 2000);
    expect(feed(s, [bay(0, true, 0.42)], T0 + 3000)).toEqual([]);
  });
});
