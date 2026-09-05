import { describe, expect, it } from 'vitest';
import type { BayDef } from './bay-defs';
import {
  BAY_RECT_MARGIN,
  OCCUPANCY_IOU_THRESHOLD,
  countOccupied,
  computeBayStates,
  rectIoU,
} from './occupancy';

function bay(id: number, rect: [number, number, number, number]): BayDef {
  return { id, side: 'north', rect };
}

describe('rectIoU', () => {
  it('is 1 for identical rects', () => {
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expect(rectIoU(rect, rect)).toBeCloseTo(1);
  });

  it('is 0 for disjoint rects', () => {
    expect(rectIoU({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
  });

  it('computes the known overlap ratio', () => {
    // 0.2 × 0.2 = 0.04 intersection; union = 2 × 0.04 − 0.04 = 0.04… use 0.5² rects.
    const a = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const b = { x: 0.25, y: 0, w: 0.5, h: 0.5 };
    // intersection 0.25 × 0.5 = 0.125; union 0.5 − 0.125 = 0.375
    expect(rectIoU(a, b)).toBeCloseTo(0.125 / 0.375);
  });
});

describe('computeBayStates', () => {
  const bays = [bay(0, [0.1, 0.1, 0.2, 0.2]), bay(1, [0.5, 0.5, 0.2, 0.2])];

  it('marks all bays EMPTY with no detections', () => {
    expect(computeBayStates(bays, [])).toEqual([
      { bayId: 0, occupied: false },
      { bayId: 1, occupied: false },
    ]);
  });

  it('marks a bay FULL when a truck bbox overlaps it above the threshold', () => {
    const truck = { cls: 'truck', conf: 0.9, bbox: [0.12, 0.12, 0.16, 0.16] as const };
    const states = computeBayStates(bays, [truck]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(true);
    expect(states.find((s) => s.bayId === 1)?.occupied).toBe(false);
  });

  it('carries the matched truck confidence on occupied bays', () => {
    const truck = { cls: 'truck', conf: 0.98, bbox: [0.12, 0.12, 0.16, 0.16] as const };
    const states = computeBayStates(bays, [truck]);
    expect(states.find((s) => s.bayId === 0)).toEqual({
      bayId: 0,
      occupied: true,
      confidence: 0.98,
    });
  });

  it('reports no confidence on unmatched bays', () => {
    const truck = { cls: 'truck', conf: 0.98, bbox: [0.12, 0.12, 0.16, 0.16] as const };
    const states = computeBayStates(bays, [truck]);
    const empty = states.find((s) => s.bayId === 1);
    expect(empty?.confidence).toBeUndefined();
    expect(Object.hasOwn(empty ?? {}, 'confidence')).toBe(false);
  });

  it('carries each matched truck confidence in greedy matching', () => {
    // Two trucks overlapping both bays; greedy best-IoU assigns one each.
    const t0 = { cls: 'truck', conf: 0.81, bbox: [0.12, 0.12, 0.16, 0.16] as const };
    const t1 = { cls: 'truck', conf: 0.77, bbox: [0.52, 0.52, 0.16, 0.16] as const };
    const states = computeBayStates(bays, [t0, t1]);
    expect(states.find((s) => s.bayId === 0)?.confidence).toBe(0.81);
    expect(states.find((s) => s.bayId === 1)?.confidence).toBe(0.77);
  });

  it('ignores non-truck classes', () => {
    const car = { cls: 'car', conf: 0.99, bbox: [0.1, 0.1, 0.2, 0.2] as const };
    expect(computeBayStates(bays, [car])).toEqual([
      { bayId: 0, occupied: false },
      { bayId: 1, occupied: false },
    ]);
  });

  it('never lets one truck fill two bays (greedy best-IoU matching)', () => {
    // A wide truck overlapping two side-by-side bays above the 0.3 threshold:
    // only the best-overlap bay becomes FULL (IoU 0.353 vs 0.342).
    const sideBySide = [bay(0, [0.1, 0.1, 0.2, 0.2]), bay(1, [0.4, 0.1, 0.2, 0.2])];
    const wideTruck = { cls: 'truck', conf: 0.9, bbox: [0.1, 0.1, 0.5, 0.25] as const };
    const states = computeBayStates(sideBySide, [wideTruck]);
    expect(countOccupied(states)).toBe(1);
  });

  it('matches by bbox center falling inside the margin-grown bay rect', () => {
    // Tall, narrow truck overhanging the bay: IoU with bay 0 is ≈ 0.11
    // (below the 0.3 threshold), but the bbox center (0.205, 0.30) still
    // falls inside bay 0's margin-grown rect (y reaches 0.305) → FULL via
    // the center fallback.
    const tallTruck = { cls: 'truck', conf: 0.9, bbox: [0.19, 0.05, 0.02, 0.5] as const };
    const states = computeBayStates(bays, [tallTruck]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(true);
  });

  it('ignores trucks whose overlap stays below the IoU threshold', () => {
    // Truck overlapping bay 0's corner with IoU ≈ 0.1 and center outside
    // the grown rect → EMPTY.
    const truck = { cls: 'truck', conf: 0.9, bbox: [0.31, 0.29, 0.04, 0.04] as const };
    const states = computeBayStates(bays, [truck]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(false);
  });

  it('ignores a passing truck whose IoU lands between 0.2 and 0.3 (cfr.1 tuning)', () => {
    // Regression for the cfr.1 tuning: drive-through trucks used to trigger
    // FULL at IoU 0.2. This truck overlaps bay 0's grown rect with IoU ≈ 0.28
    // and its center (0.20, 0.315) sits below the grown rect (y ≤ 0.305), so
    // under the tuned 0.3 threshold it must NOT fill the bay.
    const truck = { cls: 'truck', conf: 0.9, bbox: [0.1, 0.21, 0.2, 0.21] as const };
    const grown = { x: 0.095, y: 0.095, w: 0.21, h: 0.21 };
    const iou = rectIoU(grown, { x: 0.1, y: 0.21, w: 0.2, h: 0.21 });
    expect(iou).toBeGreaterThanOrEqual(0.2);
    expect(iou).toBeLessThan(OCCUPANCY_IOU_THRESHOLD);
    const states = computeBayStates(bays, [truck]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(false);
  });

  it('still fills the bay when a parked truck reaches IoU ≥ OCCUPANCY_IOU_THRESHOLD', () => {
    // Same truck nudged deeper into the bay so IoU crosses 0.3 → FULL.
    const truck = { cls: 'truck', conf: 0.9, bbox: [0.12, 0.12, 0.16, 0.16] as const };
    const grown = { x: 0.095, y: 0.095, w: 0.21, h: 0.21 };
    expect(rectIoU(grown, { x: 0.12, y: 0.12, w: 0.16, h: 0.16 })).toBeGreaterThan(
      OCCUPANCY_IOU_THRESHOLD,
    );
    const states = computeBayStates(bays, [truck]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(true);
  });

  it('handles trucks smaller than the margin', () => {
    const tinyTruck = { cls: 'truck', conf: 0.9, bbox: [0.18, 0.18, 0.002, 0.002] as const };
    // Center (0.181, 0.181) is inside bay 0's grown rect → FULL.
    const states = computeBayStates(bays, [tinyTruck]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(true);
  });

  it('grows matching rects by BAY_RECT_MARGIN', () => {
    const margin = BAY_RECT_MARGIN;
    // Truck just outside bay 0 (bay x ends at 0.3; truck starts beyond +margin).
    const outside = { cls: 'truck', conf: 0.9, bbox: [0.31 + margin, 0.15, 0.05, 0.1] as const };
    const states = computeBayStates(bays, [outside]);
    expect(states.find((s) => s.bayId === 0)?.occupied).toBe(false);
  });
});

describe('countOccupied', () => {
  it('counts FULL bays', () => {
    expect(
      countOccupied([
        { bayId: 0, occupied: true },
        { bayId: 1, occupied: false },
        { bayId: 2, occupied: true },
      ]),
    ).toBe(2);
  });
});
